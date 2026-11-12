import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebsocketProvider } from 'y-websocket';
import { WebSocket } from 'ws';
import { BogenDoc, Y } from '@bogen/core';
import { BogenServer, type ServerOptions } from '../src/http/server.ts';
import { thinAuto, type CommitInfo } from '../src/history.ts';
import { call, callRaw, connectAgent, until } from './helpers.ts';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../../..');

const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = async (base: string, path: string) => (await (await fetch(`${base}${path}`)).json()) as any;

describe('timeline, commits and revert, with a person and two agents on two servers', () => {
  let homeA: string;
  let homeB: string;
  let a: BogenServer;
  let b: BogenServer;
  let fileId: string;
  let claude: Awaited<ReturnType<typeof connectAgent>>;
  let codexRun: Awaited<ReturnType<typeof connectAgent>>;
  let person: { y: Y.Doc; doc: BogenDoc; provider: WebsocketProvider };
  let cardId: string;
  let titleId: string;
  let badgeId: string;
  const options: Partial<ServerOptions> = { insecureAllowAnyHost: true, peerCatchUpMs: 60_000, timeline: { coalesceMs: 200 } };

  const boot = async (home: string, extra: Partial<ServerOptions> = {}) => {
    const server = new BogenServer({ home, port: 0, exportDir: join(home, 'exports'), ...options, ...extra });
    await server.listen();
    return server;
  };
  const connect = (server: BogenServer, name: string, runId?: string) => connectAgent(server.localUrl(), name, { 'X-Bogen-Agent': name, 'X-Bogen-File': fileId, ...(runId ? { 'X-Bogen-Run': runId } : {}) });
  const roomA = async () => (await a.rooms.get(fileId)).doc;
  const roomB = async () => (await b.rooms.get(fileId)).doc;
  const list = (client: Awaited<ReturnType<typeof connectAgent>>, args: Record<string, unknown> = {}) => call<any[]>(client, 'change_list', args);
  const changes = async (client: Awaited<ReturnType<typeof connectAgent>>, args: Record<string, unknown> = {}) => (await list(client, args)).filter((r) => r.row === 'change');

  beforeAll(async () => {
    homeA = mkdtempSync(join(tmpdir(), 'bogen-hist-a-'));
    homeB = mkdtempSync(join(tmpdir(), 'bogen-hist-b-'));
    a = await boot(homeA);
    b = await boot(homeB);
    const info = await (await post(a.localUrl(), '/api/peers/pair', { insecure: true, name: 'Desk' })).json() as { url: string; token: string };
    await post(b.localUrl(), '/api/peers/pair', { insecure: true, name: 'Laptop' });
    const added = await post(b.localUrl(), '/api/peers', { url: info.url, token: info.token, insecure: true });
    expect(added.status).toBe(201);
    await until(() => a.peers.status().some((p) => p.state === 'connected') && b.peers.status().some((p) => p.state === 'connected'), 8000);
    fileId = ((await (await post(a.localUrl(), '/api/files', { name: 'Shared' })).json()) as { id: string }).id;
    await until(() => Boolean(b.storage.get(fileId)), 8000);
    claude = await connect(a, 'claude');
    const board = await call(claude, 'artboard_create', { name: 'Board', width: 600, height: 400 });
    const written = await call(claude, 'html_write', { target_id: board.id, html: '<div style="padding:20px;background-color:#222222" data-name="Card"><h1 style="color:#ffffff">Title</h1><span style="color:#00ff00">Badge</span></div>' });
    const doc = await roomA();
    const nodes = doc.descendants(board.id);
    cardId = nodes.find((n) => n.tag === 'div')!.id;
    titleId = nodes.find((n) => n.tag === 'h1')!.id;
    badgeId = nodes.find((n) => n.tag === 'span')!.id;
    expect(written).toBeTruthy();
    await until(async () => (await roomB()).nodes.has(titleId), 8000);
    const y = new Y.Doc();
    const provider = new WebsocketProvider(`${a.localUrl().replace('http', 'ws')}/sync`, fileId, y, { WebSocketPolyfill: WebSocket as never, disableBc: true });
    provider.awareness.setLocalStateField('user', { name: 'Mara', color: '#fff' });
    person = { y, doc: new BogenDoc(y), provider };
    await until(() => provider.synced, 5000);
    await until(() => [...(a.rooms.peek(fileId)?.conns.values() ?? [])].some((ids) => ids.size > 0), 5000);
  }, 60_000);

  afterAll(async () => {
    person.provider.destroy();
    await claude.close().catch(() => {});
    await a.close();
    await b.close();
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
  });

  it('records who, when, which tool and which layers', async () => {
    await call(claude, 'layer_style', { node_ids: [titleId], style: { color: '#ff0000' } });
    const [latest] = await changes(claude);
    expect(latest).toMatchObject({ source: 'agent', actor: 'claude', tool: 'layer_style', layers: [titleId], fields: ['style.color'], deviceName: expect.any(String) });
    expect(latest.summary).toContain('style.color');
    expect(Date.parse(latest.at)).toBeGreaterThan(Date.now() - 60_000);
    expect(latest.ops).toBeUndefined();
  });

  it('records a person by name, and a person\'s quick edits as one entry', async () => {
    for (let i = 0; i < 12; i++) {
      person.doc.updateStyle(cardId, { paddingTop: `${20 + i}px` }, 'local');
      await new Promise((r) => setTimeout(r, 15));
    }
    await until(async () => (await changes(claude)).some((c) => c.source === 'person' && c.layers.includes(cardId) && c.fields?.includes('style.paddingTop')), 4000);
    const mine = (await changes(claude)).filter((c) => c.source === 'person' && c.fields?.includes('style.paddingTop'));
    expect(mine.length).toBe(1);
    expect(mine[0].actor).toBe('Mara');
  });

  it('reverts a change in the middle, and leaves what came before and after', async () => {
    await call(claude, 'layer_style', { node_ids: [badgeId], style: { color: '#111111' } });
    const middle = (await changes(claude))[0];
    await call(claude, 'layer_text', { node_id: titleId, text: 'After the middle' });
    await call(claude, 'layer_style', { node_ids: [badgeId], style: { fontSize: '40px' } });
    const out = await call(claude, 'change_revert', { change_ids: [middle.id] });
    expect(out).toMatchObject({ clean: true, reverted_fields: 1 });
    const doc = await roomA();
    expect(doc.getNode(badgeId)!.style.color).toBe('#00ff00');
    expect(doc.getNode(badgeId)!.style.fontSize).toBe('40px');
    expect(doc.getNode(titleId)!.text).toBe('After the middle');
    const row = (await changes(claude)).find((c) => c.id === middle.id);
    expect(row.revertedBy).toBeTruthy();
  });

  it('can revert a revert', async () => {
    await call(claude, 'layer_style', { node_ids: [cardId], style: { opacity: '0.5' } });
    const change = (await changes(claude))[0];
    await call(claude, 'change_revert', { change_ids: [change.id] });
    expect((await roomA()).getNode(cardId)!.style.opacity).toBeUndefined();
    const revert = (await changes(claude))[0];
    expect(revert.revertOf).toEqual([change.id]);
    expect(revert.tool).toContain('Revert');
    const again = await call(claude, 'change_revert', { change_ids: [revert.id] });
    expect(again.clean).toBe(true);
    expect((await roomA()).getNode(cardId)!.style.opacity).toBe('0.5');
    await call(claude, 'layer_style', { node_ids: [cardId], style: { opacity: null } });
  });

  it('reports a conflict plainly, keeps the later edit, and still turns back the rest', async () => {
    await call(claude, 'layer_style', { node_ids: [titleId], style: { color: '#aa0000', letterSpacing: '2px' } });
    const change = (await changes(claude))[0];
    person.doc.updateStyle(titleId, { color: '#0000aa' }, 'local');
    await until(async () => (await roomA()).getNode(titleId)!.style.color === '#0000aa');
    const look = await call(claude, 'change_revert', { change_ids: [change.id], dry_run: true });
    expect(look).toMatchObject({ dry_run: true, clean: false, reverted_fields: 1 });
    expect((await roomA()).getNode(titleId)!.style.letterSpacing).toBe('2px');
    const out = await call(claude, 'change_revert', { change_ids: [change.id] });
    expect(out.clean).toBe(false);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({ field: 'style.color', reason: 'It was changed again later.', wanted: '#ff0000', now: '#0000aa' });
    expect(out.conflicts[0].what).toContain('Title');
    const doc = await roomA();
    expect(doc.getNode(titleId)!.style.color).toBe('#0000aa');
    expect(doc.getNode(titleId)!.style.letterSpacing).toBeUndefined();
  });

  it('reverts a deleted layer back, children included, and refuses to take away a layer others built on', async () => {
    const made = await call(claude, 'html_write', { target_id: cardId, html: '<section><p>Inner</p></section>' });
    expect(made).toBeTruthy();
    const creating = (await changes(claude))[0];
    const doc = await roomA();
    const section = doc.getChildren(cardId).find((n) => n.tag === 'section')!;
    const inner = doc.getChildren(section.id)[0]!;
    await call(claude, 'layer_delete', { node_ids: [section.id] });
    const deleting = (await changes(claude))[0];
    expect(doc.nodes.has(inner.id)).toBe(false);
    const back = await call(claude, 'change_revert', { change_ids: [deleting.id] });
    expect(back.clean).toBe(true);
    expect(doc.getNode(inner.id)?.text).toBe('Inner');
    expect(doc.getNode(section.id)?.parent).toBe(cardId);
    // Someone adds a layer inside it. Taking the section away would take that too.
    await call(claude, 'html_write', { target_id: section.id, html: '<p>Added later</p>' });
    const out = await call(claude, 'change_revert', { change_ids: [creating.id] });
    expect(out.clean).toBe(false);
    expect(out.conflicts.some((c: { reason: string }) => /added inside it later/.test(c.reason))).toBe(true);
    expect(doc.nodes.has(section.id)).toBe(true);
  });

  it('covers tokens and comments too', async () => {
    await call(claude, 'tokens_set', { tokens: [{ name: 'brand', kind: 'color', value: '#123456' }] });
    const set = (await changes(claude))[0];
    expect(set.summary).toContain('tokens');
    await call(claude, 'tokens_set', { tokens: [{ name: 'brand', kind: 'color', value: '#654321' }] });
    const update = (await changes(claude))[0];
    await call(claude, 'change_revert', { change_ids: [update.id] });
    expect((await roomA()).getTokens().find((t) => t.name === 'brand')!.value).toBe('#123456');
    const added = await call(claude, 'comment_add', { text: 'A note', node_id: titleId });
    const comment = (await changes(claude))[0];
    expect(comment.summary).toContain('comments');
    await call(claude, 'change_revert', { change_ids: [comment.id] });
    expect((await roomA()).comments.has(added.id)).toBe(false);
  });

  it('covers brand documents too, and they reach the other device', async () => {
    const brand = await call(claude, 'brand_create', { name: 'Acme' });
    await call(claude, 'brand_update', { brand_id: brand.id, items: [{ section: 'colors', name: 'Ink', value: '#111111', role: 'text' }], confirmed: true });
    const rows = await call<any[]>(claude, 'change_list', { file_id: brand.id });
    const change = rows.find((r) => r.row === 'change' && r.summary.includes('brandItems'));
    expect(change).toBeTruthy();
    expect(change.actor).toBe('claude');
    const colors = async () => (await call(claude, 'brand_get', { brand_id: brand.id, section: 'colors' })) as unknown;
    expect(JSON.stringify(await colors())).toContain('Ink');
    const out = await call(claude, 'change_revert', { change_ids: [change.id], file_id: brand.id });
    expect(out.clean).toBe(true);
    expect(JSON.stringify(await colors())).not.toContain('Ink');
    await until(async () => Boolean(b.storage.get(brand.id)) && (await b.timeline.cursors(brand.id))[a.peers.deviceId]! >= 1, 8000);
    await call(claude, 'file_open', { file_id: fileId });
  }, 30_000);

  describe('across devices', () => {
    let codex: Awaited<ReturnType<typeof connectAgent>>;

    beforeAll(async () => {
      codex = await connect(b, 'codex');
    });

    afterAll(async () => {
      await codex.close();
    });

    it('gives each device the same timeline, with device names, and no doubles', async () => {
      await call(codex, 'layer_style', { node_ids: [badgeId], style: { color: '#abcabc' } });
      await until(async () => (await changes(claude)).some((c) => c.actor === 'codex'), 8000);
      const onA = (await changes(claude)).find((c) => c.actor === 'codex');
      expect(onA).toMatchObject({ source: 'agent', tool: 'layer_style', deviceName: b.peers.device().name, device: b.peers.deviceId });
      // What arrived from the other device is not listed a second time as coming from it.
      expect((await changes(claude)).filter((c) => c.source === 'peer' && c.fields?.includes('style.color') && Date.parse(c.at) >= Date.parse(onA.at) - 1000)).toEqual([]);
      await until(async () => (await changes(codex)).some((c) => c.actor === 'claude'), 8000);
      const onB = await changes(codex);
      expect(onB.find((c) => c.actor === 'claude').deviceName).toBe(a.peers.device().name);
      expect(onB.find((c) => c.source === 'person')?.actor).toBe('Mara');
    });

    it('reverts on one device what happened on the other, and that travels back', async () => {
      await until(async () => (await roomA()).getNode(badgeId)!.style.color === '#abcabc', 8000);
      const change = (await changes(claude)).find((c) => c.actor === 'codex');
      const out = await call(claude, 'change_revert', { change_ids: [change.id] });
      expect(out.clean).toBe(true);
      await until(async () => (await roomB()).getNode(badgeId)!.style.color === '#00ff00', 8000);
      await until(async () => (await changes(codex)).some((c) => c.revertOf?.includes(change.id)), 8000);
    });

    it('reverts a whole agent run as one unit, on the device it did not run on', async () => {
      // The run goes on b while it writes: a session that names a run needs one going.
      vi.spyOn(b.runs, 'bindingOf').mockImplementation((id) => (id === 'run42' ? { fileId, agent: 'codex' } : undefined));
      codexRun = await connect(b, 'codex', 'run42');
      await call(codexRun, 'layer_style', { node_ids: [cardId], style: { backgroundColor: '#333333' } });
      await call(codexRun, 'layer_style', { node_ids: [cardId], style: { backgroundColor: '#444444' } });
      await call(codexRun, 'layer_text', { node_id: titleId, text: 'From the run' });
      const made = await call(codexRun, 'html_write', { target_id: cardId, html: '<em>Run made this</em>' });
      expect(made).toBeTruthy();
      await codexRun.close();
      await until(async () => (await changes(claude, { run: 'run42' })).length === 4, 8000);
      await until(async () => (await roomA()).getNode(titleId)!.text === 'From the run', 8000);
      const out = await call(claude, 'change_revert', { run: 'run42' });
      expect(out.clean).toBe(true);
      const doc = await roomA();
      expect(doc.getNode(cardId)!.style.backgroundColor).toBe('#222222');
      expect(doc.getNode(titleId)!.text).toBe('After the middle');
      expect(doc.descendants(cardId).some((n) => n.text === 'Run made this')).toBe(false);
      await until(async () => (await roomB()).getNode(titleId)!.text === 'After the middle', 8000);
    });

    it('replicates commits, with who and where', async () => {
      const made = await call(claude, 'commit_create', { message: 'Good state' });
      expect(made).toMatchObject({ message: 'Good state', author: 'claude' });
      await until(async () => (await call<any[]>(codex, 'commit_list')).some((c) => c.id === made.id), 8000);
      const there = (await call<any[]>(codex, 'commit_list')).find((c) => c.id === made.id);
      expect(there).toMatchObject({ kind: 'commit', author: 'claude', device: a.peers.device().name });
      // Its content came along and restores there.
      const diff = await call(codex, 'commit_diff', { from: made.id });
      expect(diff.same).toBe(true);
    });
  });

  it('gives a correct diff, in words and in pixels', async () => {
    const first = await call(claude, 'commit_create', { message: 'Before the diff' });
    await call(claude, 'layer_style', { node_ids: [cardId], style: { backgroundColor: '#ff00ff', paddingTop: '10px' } });
    await call(claude, 'html_write', { target_id: cardId, html: '<b data-name="New one">New</b>' });
    await call(claude, 'tokens_set', { tokens: [{ name: 'added-token', kind: 'color', value: '#000000' }] });
    const doc = await roomA();
    const page = doc.pageOf(cardId)!;
    const removed = doc.getChildren(cardId).find((n) => n.tag === 'span')!;
    await call(claude, 'layer_delete', { node_ids: [removed.id] });
    const second = await call(claude, 'commit_create', { message: 'After the diff' });
    const diff = await call(claude, 'commit_diff', { from: first.id, to: second.id, render_page: page });
    expect(diff.counts).toMatchObject({ added: 1, removed: 1, changed: 1 });
    const layers = diff.layers[0];
    expect(layers.added.join()).toMatch(/New/);
    expect(layers.removed).toEqual([removed.name]);
    expect(layers.changed).toHaveLength(1);
    expect(layers.changed[0].fields).toEqual(['style.backgroundColor', 'style.paddingTop']);
    expect(diff.tokens.added).toEqual(['added-token']);
    expect(diff.changedPages.map((p: { id: string }) => p.id)).toContain(page);
    expect(diff.visual.percent_different).toBeGreaterThan(1);
    expect(diff.visual.percent_different).toBeLessThan(100);
    const rendered = await get(a.localUrl(), `/api/files/${fileId}/compare/render?from=${first.id}&to=${second.id}&page=${page}`);
    for (const key of ['before', 'after', 'diff']) expect(Buffer.from(rendered[key], 'base64').subarray(1, 4).toString()).toMatch(/PNG|WEB|RIF/);
    const noChange = await call(claude, 'commit_diff', { from: second.id, to: 'now' });
    expect(noChange.same).toBe(true);
  }, 60_000);

  it('survives a restart: revert, and restore a commit, which commits first and can itself be reverted', async () => {
    const saved = await call(claude, 'commit_create', { message: 'Keep this' });
    const keptColor = (await roomA()).getNode(cardId)!.style.backgroundColor;
    await call(claude, 'layer_style', { node_ids: [cardId], style: { backgroundColor: '#010101' } });
    const change = (await changes(claude))[0];
    await claude.close();
    person.provider.destroy();
    await a.close();
    a = await boot(homeA);
    await until(() => a.peers.status().some((p) => p.state === 'connected'), 8000);
    claude = await connect(a, 'claude');
    const again = await changes(claude);
    expect(again.find((c) => c.id === change.id)).toMatchObject({ actor: 'claude', revertable: true });
    const out = await call(claude, 'change_revert', { change_ids: [change.id] });
    expect(out.clean).toBe(true);
    expect((await roomA()).getNode(cardId)!.style.backgroundColor).toBe(keptColor);
    await call(claude, 'layer_style', { node_ids: [cardId], style: { backgroundColor: '#020202' } });
    await call(claude, 'html_write', { target_id: cardId, html: '<u>After the commit</u>' });
    const restored = await call(claude, 'commit_restore', { commit_id: saved.id });
    expect(restored.savedAs).toBeTruthy();
    const doc = await roomA();
    expect(doc.getNode(cardId)!.style.backgroundColor).toBe(keptColor);
    expect(doc.descendants(cardId).some((n) => n.text === 'After the commit')).toBe(false);
    const safety = (await call<any[]>(claude, 'commit_list')).find((c) => c.id === restored.savedAs);
    expect(safety.kind).toBe('restore');
    expect(safety.message).toContain(saved.id);
    const row = (await changes(claude))[0];
    expect(row.restoreOf).toBe(saved.id);
    expect(row.tool).toContain('Restored');
    const undo = await call(claude, 'change_revert', { change_ids: [row.id] });
    expect(undo.clean).toBe(true);
    expect(doc.getNode(cardId)!.style.backgroundColor).toBe('#020202');
    expect(doc.descendants(cardId).some((n) => n.text === 'After the commit')).toBe(true);
    const y = new Y.Doc();
    const provider = new WebsocketProvider(`${a.localUrl().replace('http', 'ws')}/sync`, fileId, y, { WebSocketPolyfill: WebSocket as never, disableBc: true });
    person = { y, doc: new BogenDoc(y), provider };
    await until(() => provider.synced, 5000);
  }, 60_000);

  it('makes a commit when an agent run ends, with the prompt as its message', async () => {
    const internals = a as unknown as { commitRun: (end: object) => Promise<void> };
    const binding = vi.spyOn(a.runs, 'bindingOf').mockImplementation((id) => (id === 'runPrompted' ? { fileId, agent: 'claude' } : undefined));
    const runAgent = await connect(a, 'claude', 'runPrompted');
    await call(runAgent, 'layer_style', { node_ids: [titleId], style: { fontSize: '50px' } });
    await runAgent.close();
    a.history.started('runPrompted', { fileId, runner: 'claude', prompt: 'Make the title bigger', nodeIds: [], pageId: undefined } as never);
    await internals.commitRun({ runId: 'runPrompted', fileId, runner: 'claude', status: 'done' });
    // The run is over, as the server's own end of a run would say: its sessions go, and with them its branch.
    binding.mockRestore();
    a.runs.revoke?.('runPrompted');
    const commits = await call<any[]>(claude, 'commit_list');
    expect(commits[0]).toMatchObject({ kind: 'run', message: 'Make the title bigger', author: 'claude' });
  });

  // Branches are made inside the file now, never as a file of their own, and only the person merges or discards
  // one (design-branches.ts). This used to test copy-branches; it was out of date before the runner work, and the
  // stale branch-busy entry of an ended run session hid that.
  it('branches: inside the file, worked on by an agent, merged and discarded only by the person', async () => {
    const files = a.storage.list().length;
    const made = await call(claude, 'branch_create', { name: 'bigger title' });
    expect(made.file_id).toBe(fileId);
    const branchId: string = made.branch.id;
    expect(a.storage.list()).toHaveLength(files);
    const branches = (path: string, body: unknown = {}) => post(a.localUrl(), `/api/files/${fileId}/design-branches${path}`, { by: 'Mara', ...(body as object) });
    // The branch is checked out, so the agent's edit goes into it.
    await call(claude, 'layer_style', { node_ids: [titleId], style: { fontSize: '99px' } });
    const main = await roomA();
    expect(main.getNode(titleId)!.style.fontSize).toBe('99px');

    // Back on main the title is as it was, and a concurrent edit there is kept through the merge.
    expect((await branches(`/main/switch`)).status).toBe(200);
    expect(main.getNode(titleId)!.style.fontSize).toBe('50px');
    main.updateStyle(cardId, { marginTop: '13px' });

    // An agent cannot merge a branch inside a file; the person can.
    expect((await callRaw(claude, 'branch_merge', { branch_id: branchId })).isError).toBe(true);
    expect(main.getNode(titleId)!.style.fontSize).toBe('50px');
    const merged = await branches(`/${branchId}/merge`);
    expect(merged.status).toBe(200);
    expect(main.getNode(titleId)!.style.fontSize).toBe('99px');
    expect(main.getNode(cardId)!.style.marginTop).toBe('13px');
    // And can take the merge back.
    expect((await branches(`/${branchId}/undo-merge`)).status).toBe(200);
    expect(main.getNode(titleId)!.style.fontSize).toBe('50px');
    expect(main.getNode(cardId)!.style.marginTop).toBe('13px');

    // Discarding keeps what the branch had in a History commit.
    const other = await (await branches('', { name: 'try a tint' })).json() as { branch: { id: string } };
    const gone = await branches(`/${other.branch.id}/discard`);
    expect(gone.status).toBe(200);
    expect(a.storage.list()).toHaveLength(files);
    // The agent continues on what is checked out now.
    await call(claude, 'file_open', { file_id: fileId });
  }, 30_000);

  it('keeps the design in a real Git repository, from the command line, without pushing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bogen-git-'));
    const env = { ...process.env, BOGEN_URL: a.localUrl(), BOGEN_HOME: homeA };
    const cli = async (...args: string[]) => (await run('npx', ['tsx', 'packages/server/src/cli.ts', ...args], { cwd: ROOT, env })).stdout;
    expect(await cli('git', 'init', fileId, dir)).toContain('commit');
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(existsSync(join(dir, 'design.json'))).toBe(true);
    const color = (await roomA()).getNode(cardId)!.style.backgroundColor;
    await call(claude, 'layer_style', { node_ids: [cardId], style: { backgroundColor: '#0a0b0c' } });
    const mirrored = await call(claude, 'commit_create', { message: 'Mirrored by an agent' });
    expect(mirrored.git).toMatch(/^[0-9a-f]{40}$/);
    const log = await cli('git', 'log', fileId, dir);
    expect(log).toContain('Mirrored by an agent');
    expect(log).toContain('claude');
    const shown = (await run('git', ['log', '-1', '--format=%an %s'], { cwd: dir })).stdout.trim();
    expect(shown).toBe('claude Mirrored by an agent');
    const diffText = (await run('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: dir })).stdout;
    expect(diffText).toContain('pages/');
    // Nothing configured a remote, and nothing here makes one.
    expect((await run('git', ['remote'], { cwd: dir })).stdout.trim()).toBe('');
    const first = (await run('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: dir })).stdout.trim();
    const restored = await cli('git', 'restore', fileId, dir, '--rev', first);
    expect(restored).toContain('Restored');
    expect((await roomA()).getNode(cardId)!.style.backgroundColor).toBe(color);
    expect((await run('git', ['status', '--porcelain'], { cwd: dir })).stdout.trim()).toBe('');
    expect(JSON.parse(readFileSync(join(homeA, 'git-bindings.json'), 'utf8'))[fileId]).toBe(dir);
    rmSync(dir, { recursive: true, force: true });
  }, 90_000);

  it('thins old entries: the record stays, and it says it cannot be reverted', async () => {
    const entries = await a.timeline.all(fileId);
    const before = entries.filter((e) => e.device === a.peers.deviceId).length;
    const thinning = new (a.timeline.constructor as new (...args: unknown[]) => typeof a.timeline)(a.storage, { deviceId: () => a.peers.deviceId, deviceName: () => 'x', maxAgeMs: 0 });
    await a.timeline.flush(fileId);
    await new Promise((r) => setTimeout(r, 5));
    await thinning.thinIfNeeded(fileId);
    const after = await a.timeline.all(fileId);
    const mine = after.filter((e) => e.device === a.peers.deviceId);
    expect(mine.length).toBe(before);
    expect(mine.every((e) => e.thinned && !e.ops)).toBe(true);
    const out = await callRaw(claude, 'change_revert', { change_ids: [mine.at(-1)!.id] });
    const parsed = JSON.parse(out.content[0]!.text!);
    expect(parsed.clean).toBe(false);
    expect(parsed.conflicts[0].reason).toContain('too old');
  });

  it('thins automatic commits by age', () => {
    const now = Date.now();
    const make = (age: number, i: number): CommitInfo => ({ id: `x${i}`, at: now - age, kind: 'auto', bytes: 1, pages: 1, layers: 1, hash: '' });
    const HOUR = 3_600_000;
    const commits = [...Array.from({ length: 30 }, (_, i) => make(i * 60_000, i)), ...Array.from({ length: 60 }, (_, i) => make(2 * HOUR + i * 60_000, 100 + i)), make(40 * 24 * HOUR, 999)];
    const kept = thinAuto(commits, now, 10);
    expect(kept.length).toBeLessThan(20);
    expect(kept.slice(0, 10).map((c) => c.id)).toEqual(commits.slice(0, 10).map((c) => c.id));
    expect(kept.some((c) => c.id === 'x999')).toBe(false);
  });
});
