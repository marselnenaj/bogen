import { BogenDoc, branchContent, createDesignBranch, currentBranchId, docToContent, getDesignBranch, listDesignBranches, MAIN_BRANCH, switchDesignBranch, Y } from '@bogen/core';
import { afterEach, describe, expect, it } from 'vitest';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** A file with a palette and a theme record, as a theme project has them. */
async function themeFile(harness: Harness) {
  const entry = harness.server.createFile('Tokyo Night Custom · Omarchy theme');
  const room = await harness.server.rooms.get(entry.id);
  room.doc.transact(() => {
    room.doc.setToken('omarchy-accent', 'color', '#7aa2f7');
    room.doc.meta.set('omarchyTheme', { name: 'Tokyo Night Custom', format: 2, target: 'desktop', from: 'tokyo-night' });
  });
  return { id: entry.id, room };
}
const accent = (doc: BogenDoc) => doc.getTokens().find((t) => t.name === 'omarchy-accent')?.value;
const json = async (res: Response) => ({ status: res.status, body: await res.json() as any });

describe('agents keep to their own branch', () => {
  it('a session that started on main cannot write into a branch another session checked out', async () => {
    h = await startServer();
    const { id, room } = await themeFile(h);
    const a = await connectAgent(h.base, 'claude');
    const b = await connectAgent(h.base, 'codex');
    await call(a, 'file_open', { file_id: id });
    await call(a, 'tokens_set', { tokens: [{ name: 'omarchy-accent', kind: 'color', value: '#111111' }] });
    // Codex is told to try an alternative once Claude has gone quiet; the activity window is the guard, so age it.
    await call(b, 'file_open', { file_id: id });
    const busy = await callRaw(b, 'design_branch_create', { name: 'Warmer night' });
    expect(busy.isError).toBe(true);
    expect(busy.content[0]!.text).toMatch(/claude is working on the checked-out version/);
    expect(listDesignBranches(room.doc)).toHaveLength(1);

    // The person checks out a branch in the editor while Claude is still on main.
    const made = await json(await fetch(`${h.base}/api/files/${id}/design-branches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Warmer night' }) }));
    expect(made.status).toBe(201);
    expect(currentBranchId(room.doc)).toBe(made.body.branch.id);
    const stale = await callRaw(a, 'tokens_set', { tokens: [{ name: 'omarchy-accent', kind: 'color', value: '#222222' }] });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toMatch(/Nothing was changed/);
    expect(accent(room.doc)).toBe('#111111');
    expect(branchContent(room.doc, MAIN_BRANCH).tokens.find((t) => t.name === 'omarchy-accent')?.value).toBe('#111111');

    // Opening the file again on purpose continues on what is checked out.
    await call(a, 'file_open', { file_id: id });
    await call(a, 'tokens_set', { tokens: [{ name: 'omarchy-accent', kind: 'color', value: '#ff9e64' }] });
    expect(accent(room.doc)).toBe('#ff9e64');
    expect(branchContent(room.doc, MAIN_BRANCH).tokens.find((t) => t.name === 'omarchy-accent')?.value).toBe('#111111');
    // No file was made for the branch.
    expect(h.server.storage.list().filter((f) => f.name.includes('branch'))).toHaveLength(0);
  });

  it('a branch an agent starts is the one its later writes land in, and asking again reuses it', async () => {
    h = await startServer();
    const { id, room } = await themeFile(h);
    const a = await connectAgent(h.base, 'claude');
    const files = h.server.storage.list().length;
    const first = await call(a, 'design_branch_create', { file_id: id, name: 'Ember' });
    expect(first.reused).toBe(false);
    await call(a, 'tokens_set', { tokens: [{ name: 'omarchy-accent', kind: 'color', value: '#ff9e64' }] });
    const again = await call(a, 'design_branch_create', { file_id: id, name: 'ember' });
    expect(again.reused).toBe(true);
    expect(again.branch.id).toBe(first.branch.id);
    expect(h.server.storage.list().length).toBe(files);
    expect(branchContent(room.doc, MAIN_BRANCH).tokens.find((t) => t.name === 'omarchy-accent')?.value).toBe('#7aa2f7');
    const listed = await call(a, 'design_branch_list', { file_id: id });
    expect(listed.current).toBe(first.branch.id);
    expect(listed.branches.map((x: { name: string }) => x.name)).toEqual(['Main', 'Ember']);
  });

  it('an agent undo after a checkout cannot write the old branch into the new one', async () => {
    h = await startServer();
    const { id, room } = await themeFile(h);
    const a = await connectAgent(h.base, 'claude');
    await call(a, 'file_open', { file_id: id });
    await call(a, 'tokens_set', { tokens: [{ name: 'omarchy-accent', kind: 'color', value: '#111111' }] });
    const branch = createDesignBranch(room.doc, { name: 'B', by: 'person', checkout: true }, 'branch:person').branch;
    room.clearUndo();
    await call(a, 'file_open', { file_id: id });
    const undo = await call(a, 'agent_undo', {});
    expect(JSON.stringify(undo)).not.toMatch(/"undone":true/);
    expect(currentBranchId(room.doc)).toBe(branch.id);
    expect(accent(room.doc)).toBe('#111111');
    expect(branchContent(room.doc, MAIN_BRANCH).tokens.find((t) => t.name === 'omarchy-accent')?.value).toBe('#111111');
  });
});

describe('the person decides, and nothing is lost', () => {
  it('merge with a conflict answers with it, then merges the chosen side; discard keeps a History commit', async () => {
    h = await startServer();
    const { id, room } = await themeFile(h);
    const post = (path: string, body: unknown = {}) => fetch(`${h!.base}/api/files/${id}/design-branches${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
    const made = await post('', { name: 'Ember' });
    room.doc.setToken('omarchy-accent', 'color', '#ff9e64');
    await post(`/${MAIN_BRANCH}/switch`);
    room.doc.setToken('omarchy-accent', 'color', '#00ff00');
    const conflict = await post(`/${made.body.branch.id}/merge`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.conflicts[0].key).toBe('token:omarchy-accent');
    expect(accent(room.doc)).toBe('#00ff00');
    const merged = await post(`/${made.body.branch.id}/merge`, { resolve: 'branch' });
    expect(merged.status).toBe(200);
    expect(accent(room.doc)).toBe('#ff9e64');
    expect(getDesignBranch(room.doc, made.body.branch.id).archivedAs).toBeTruthy();

    const other = await post('', { name: 'Try' });
    room.doc.setToken('omarchy-accent', 'color', '#123456');
    const gone = await post(`/${other.body.branch.id}/discard`);
    expect(gone.status).toBe(200);
    const commit = await h.server.commits.read(id, gone.body.commit);
    expect(commit?.tokens.find((t) => t.name === 'omarchy-accent')?.value).toBe('#123456');
    expect(accent(room.doc)).toBe('#ff9e64');
  });

  it('a .bogen download carries every branch and the pictures only an inactive branch uses', async () => {
    h = await startServer();
    const { id, room } = await themeFile(h);
    const asset = await h.server.storage.putAsset(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), 'image/png');
    const branch = createDesignBranch(room.doc, { name: 'Picture', by: 'person', checkout: true }).branch;
    const page = room.doc.getPages()[0]!.id;
    room.doc.insert(page, { type: 'image', tag: 'img', name: 'Moon', src: asset.src, style: {} });
    switchDesignBranch(room.doc, MAIN_BRANCH);
    expect(JSON.stringify(docToContent(room.doc))).not.toContain(asset.name);
    await h.server.storage.flushDoc(id);
    const file = new Uint8Array(await (await fetch(`${h.base}/api/files/${id}/download`)).arrayBuffer());
    expect(Buffer.from(file).includes(Buffer.from(asset.name))).toBe(true);
    // Into a fresh server, as on another computer.
    const other = await startServer();
    try {
      const res = await json(await fetch(`${other.base}/api/files/import`, { method: 'POST', headers: { 'x-bogen-filename': 'Copy.bogen' }, body: file }));
      expect(res.status).toBe(201);
      expect(await other.server.storage.readAsset(asset.name)).toBeTruthy();
      const copy = await other.server.rooms.get(res.body.id);
      expect(listDesignBranches(copy.doc).map((b) => b.name)).toEqual(['Main', 'Picture']);
      switchDesignBranch(copy.doc, branch.id);
      expect(copy.doc.getChildren(page).some((n) => n.src === asset.src)).toBe(true);
    } finally {
      await other.cleanup();
    }
  });
});

describe('a phone that edited while away', () => {
  it('its edits to main go to main, the checked-out branch stays as it was, and the raw update is kept', async () => {
    h = await startServer();
    const { id, room } = await themeFile(h);
    const phone = new BogenDoc(new Y.Doc());
    Y.applyUpdate(phone.y, Y.encodeStateAsUpdate(room.doc.y));
    const made = await (await fetch(`${h.base}/api/files/${id}/design-branches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ember' }) })).json() as { branch: { id: string } };
    room.doc.setToken('omarchy-accent', 'color', '#ff9e64');
    const ember = docToContent(room.doc);
    phone.setToken('omarchy-accent', 'color', '#00ff00');
    phone.setToken('omarchy-shell', 'color', '#101010');
    const update = Y.encodeStateAsUpdate(phone.y);
    const res = await fetch(`${h.base}/api/files/${id}/catch-up`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ update: Buffer.from(update).toString('base64'), sv: Buffer.from(Y.encodeStateVector(phone.y)).toString('base64') }) });
    expect(res.status).toBe(200);
    expect(currentBranchId(room.doc)).toBe(made.branch.id);
    expect(docToContent(room.doc).tokens).toEqual(ember.tokens);
    const main = branchContent(room.doc, MAIN_BRANCH);
    expect(main.tokens.find((t) => t.name === 'omarchy-accent')?.value).toBe('#00ff00');
    expect(main.tokens.find((t) => t.name === 'omarchy-shell')?.value).toBe('#101010');
    const { readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(readdirSync(join(h.home, 'history', id, 'stale')).length).toBe(1);
    expect(listDesignBranches(room.doc)).toHaveLength(2);
  });
});

describe('identity and durability of what is held back', () => {
  it('two sessions that both call themselves codex-mcp-client are two agents', async () => {
    h = await startServer();
    const { id, room } = await themeFile(h);
    const one = await connectAgent(h.base, 'codex-mcp-client');
    const two = await connectAgent(h.base, 'codex-mcp-client');
    await call(one, 'file_open', { file_id: id });
    await call(one, 'tokens_set', { tokens: [{ name: 'omarchy-accent', kind: 'color', value: '#111111' }] });
    await call(two, 'file_open', { file_id: id });
    const refused = await callRaw(two, 'design_branch_create', { name: 'Elsewhere' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/codex-mcp-client is working on the checked-out version/);
    expect(listDesignBranches(room.doc)).toHaveLength(1);
    // The first session itself may start one: it is its own work it switches.
    const own = await call(one, 'design_branch_create', { name: 'Mine' });
    expect(own.reused).toBe(false);
    const stale = await callRaw(two, 'tokens_set', { tokens: [{ name: 'omarchy-accent', kind: 'color', value: '#333333' }] });
    expect(stale.isError).toBe(true);
  });

  /** A phone synced with the file, then a branch checked out while it is away. */
  async function phoneAway(harness: Harness) {
    const { id, room } = await themeFile(harness);
    const page = room.doc.getPages()[0]!.id;
    const text = room.doc.insert(page, { type: 'text', tag: 'p', name: 'Title', text: 'Night', style: {} });
    const phone = new BogenDoc(new Y.Doc());
    Y.applyUpdate(phone.y, Y.encodeStateAsUpdate(room.doc.y));
    const made = await (await fetch(`${harness.base}/api/files/${id}/design-branches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ember' }) })).json() as { branch: { id: string } };
    room.doc.editText(text, 'Night', 'Ember night');
    const catchUp = (body: Uint8Array) => fetch(`${harness.base}/api/files/${id}/catch-up`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ update: Buffer.from(body).toString('base64'), sv: Buffer.from(Y.encodeStateVector(phone.y)).toString('base64') }) });
    return { id, room, phone, text, branch: made.branch.id, catchUp };
  }

  it('text typed on the phone while away never lands in the checked-out branch, and is held in the file', async () => {
    h = await startServer();
    const { id, room, phone, text, branch, catchUp } = await phoneAway(h);
    phone.editText(text, 'Night', 'Night shift');
    const res = await catchUp(Y.encodeStateAsUpdate(phone.y));
    expect(res.status).toBe(200);
    expect(currentBranchId(room.doc)).toBe(branch);
    expect(room.doc.getNode(text)?.text).toBe('Ember night');
    const main = getDesignBranch(room.doc, MAIN_BRANCH);
    expect(main.held?.length).toBe(1);
    expect(main.held![0]!.layers).toContain(text);
    expect(main.held![0]!.asset).toMatch(/^bogen-asset:[0-9a-f]{64}\.json$/);
    // It goes with the file.
    await h.server.storage.flushDoc(id);
    const file = new Uint8Array(await (await fetch(`${h.base}/api/files/${id}/download`)).arrayBuffer());
    const copy = new BogenDoc(new Y.Doc());
    const { unpackBogenFile } = await import('../src/bogen-file.ts');
    Y.applyUpdate(copy.y, unpackBogenFile(file).state);
    expect(getDesignBranch(copy, MAIN_BRANCH).held?.[0]?.asset).toBe(main.held![0]!.asset);
    expect(Buffer.from(file).includes(Buffer.from(main.held![0]!.asset.slice('bogen-asset:'.length)))).toBe(true);
  });

  it('refuses a stale update it cannot keep on disk first, and leaves the file as it was', async () => {
    h = await startServer();
    const { id, room, phone, catchUp } = await phoneAway(h);
    const { chmodSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(h.home, 'history', id, 'stale');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      phone.setToken('omarchy-accent', 'color', '#00ff00');
      const before = JSON.stringify(docToContent(room.doc));
      const branches = JSON.stringify(listDesignBranches(room.doc));
      const res = await catchUp(Y.encodeStateAsUpdate(phone.y));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(docToContent(room.doc))).toBe(before);
      expect(JSON.stringify(listDesignBranches(room.doc))).toBe(branches);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('two different stale updates in the same moment are two files; the same one sent again is one', async () => {
    h = await startServer();
    const { id, room, phone } = await phoneAway(h);
    const { applyRemoteUpdate } = await import('../src/design-branches.ts');
    phone.setToken('omarchy-accent', 'color', '#00ff00');
    const first = Y.encodeStateAsUpdate(phone.y);
    phone.setToken('omarchy-shell', 'color', '#111111');
    const a = applyRemoteUpdate({ storage: h.server.storage }, room, first, Y.encodeStateVector(phone.y), { name: 'Phone', id: 'phone:1' }, 'test');
    const b = applyRemoteUpdate({ storage: h.server.storage }, room, Y.encodeStateAsUpdate(phone.y), Y.encodeStateVector(phone.y), { name: 'Phone', id: 'phone:1' }, 'test');
    const c = applyRemoteUpdate({ storage: h.server.storage }, room, first, Y.encodeStateVector(phone.y), { name: 'Phone', id: 'phone:1' }, 'test');
    expect(a.kept).toBeTruthy();
    expect(b.kept).not.toBe(a.kept);
    expect(c.kept).toBe(a.kept);
    const { readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(readdirSync(join(h.home, 'history', id, 'stale')).filter((f) => f.endsWith('.json'))).toHaveLength(2);
    expect(listDesignBranches(room.doc)).toHaveLength(2);
  });

  it('a held update of several megabytes travels as an asset, not in the document', async () => {
    h = await startServer();
    const { id, room, phone, text, catchUp } = await phoneAway(h);
    phone.editText(text, 'Night', `Night ${'x'.repeat(3 * 1024 * 1024)}`);
    const res = await catchUp(Y.encodeStateAsUpdate(phone.y));
    expect(res.status).toBe(200);
    const held = getDesignBranch(room.doc, MAIN_BRANCH).held!;
    expect(held).toHaveLength(1);
    expect(held[0]!.bytes).toBeGreaterThan(3 * 1024 * 1024);
    expect(JSON.stringify(held).length).toBeLessThan(4096);
    await h.server.storage.flushDoc(id);
    const file = new Uint8Array(await (await fetch(`${h.base}/api/files/${id}/download`)).arrayBuffer());
    const other = await startServer();
    try {
      await fetch(`${other.base}/api/files/import`, { method: 'POST', headers: { 'x-bogen-filename': 'Copy.bogen' }, body: file });
      const raw = await other.server.storage.readAsset(held[0]!.asset.slice('bogen-asset:'.length));
      expect(raw && JSON.parse(Buffer.from(raw.bytes).toString('utf8')).format).toBe('bogen-held-update');
    } finally {
      await other.cleanup();
    }
  });

  it('past the cap a further held update is refused before anything changes, its copy on disk', async () => {
    h = await startServer();
    const { id, room, phone, text } = await phoneAway(h);
    const { applyRemoteUpdate } = await import('../src/design-branches.ts');
    const { MAX_HELD } = await import('@bogen/core');
    const send = () => applyRemoteUpdate({ storage: h!.server.storage }, room, Y.encodeStateAsUpdate(phone.y), Y.encodeStateVector(phone.y), { name: 'Phone', id: 'phone:1' }, 'test');
    let typed = 'Night';
    for (let i = 0; i < MAX_HELD; i++) {
      phone.editText(text, typed, `${typed}${i % 10}`);
      typed = `${typed}${i % 10}`;
      send();
    }
    expect(getDesignBranch(room.doc, MAIN_BRANCH).held).toHaveLength(MAX_HELD);
    phone.editText(text, typed, `${typed}!`);
    const before = JSON.stringify([docToContent(room.doc), listDesignBranches(room.doc)]);
    expect(() => send()).toThrow(/Nothing was applied/);
    expect(JSON.stringify([docToContent(room.doc), listDesignBranches(room.doc)])).toBe(before);
    const { readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(readdirSync(join(h.home, 'history', id, 'stale')).filter((f) => f.endsWith('.json'))).toHaveLength(MAX_HELD + 1);
  });
});

describe('no way out into another file', () => {
  it('a redo of a theme runs in a branch of the same file, continued by the next message', async () => {
    h = await startServer();
    const { id, room } = await themeFile(h);
    const { prepareRunIntent } = await import('../src/run-intent.ts');
    const files = h.server.storage.list().length;
    const req = await prepareRunIntent(h.server, { fileId: id, runner: 'claude', prompt: 'Make it again, I do not like it', conversationId: 'c1' } as never);
    expect(req.intent).toBe('revise');
    expect(req.branch?.reused).toBe(false);
    expect(req.revision).toBeUndefined();
    expect(currentBranchId(room.doc)).toBe(req.branch!.id);
    const next = await prepareRunIntent(h.server, { fileId: id, runner: 'claude', prompt: 'Redo it with more contrast', conversationId: 'c1' } as never);
    expect(next.branch).toEqual({ ...req.branch, reused: true });
    expect(h.server.storage.list().length).toBe(files);
  });

  it('file_create is refused for theme names and inside a branch, and works for new designs', async () => {
    h = await startServer();
    const { id } = await themeFile(h);
    const a = await connectAgent(h.base, 'claude');
    const named = await callRaw(a, 'file_create', { name: 'Tokyo Night Custom · Omarchy theme' });
    expect(named.isError).toBe(true);
    expect(named.content[0]!.text).toMatch(/omarchy_theme_create/);
    const fresh = await call(a, 'file_create', { name: 'Logo ideas' });
    expect(fresh.id).toBeTruthy();
    await call(a, 'branch_create', { file_id: id, name: 'Warmer' });
    const inside = await callRaw(a, 'file_create', { name: 'Tokyo copy' });
    expect(inside.isError).toBe(true);
    expect(h.server.storage.list().filter((f) => f.name.includes('branch'))).toHaveLength(0);
    const merge = await callRaw(a, 'branch_merge', { file_id: id, branch_id: listDesignBranches((await h.server.rooms.get(id)).doc).at(-1)!.id });
    expect(merge.isError).toBe(true);
  });
});

describe('pictures only a comment or a held update names', () => {
  it('go with a .bogen download and arrive on another server', async () => {
    h = await startServer();
    const { id, room } = await themeFile(h);
    const page = room.doc.getPages()[0]!.id;
    const text = room.doc.insert(page, { type: 'text', tag: 'p', name: 'Title', text: 'Night', style: {} });
    const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n]);
    const attached = await h.server.storage.putAsset(png(1), 'image/png');
    const heldOnly = await h.server.storage.putAsset(png(2), 'image/png');
    room.doc.addThread({ pageId: page, nodeId: text, x: 0, y: 0, author: 'Mara', text: 'Like this?', attachments: [{ src: attached.src, kind: 'image' }] });
    // A phone, away while a branch is checked out, types into the title and gives it a picture: held as it came.
    const phone = new BogenDoc(new Y.Doc());
    Y.applyUpdate(phone.y, Y.encodeStateAsUpdate(room.doc.y));
    await fetch(`${h.base}/api/files/${id}/design-branches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ember' }) });
    room.doc.editText(text, 'Night', 'Ember night');
    phone.editText(text, 'Night', 'Night sky');
    phone.updateStyle(text, { backgroundImage: `url(${heldOnly.src})` });
    const res = await fetch(`${h.base}/api/files/${id}/catch-up`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ update: Buffer.from(Y.encodeStateAsUpdate(phone.y)).toString('base64'), sv: Buffer.from(Y.encodeStateVector(phone.y)).toString('base64') }) });
    expect(res.status).toBe(200);
    expect(getDesignBranch(room.doc, MAIN_BRANCH).held?.length).toBe(1);
    expect(JSON.stringify(branchContent(room.doc, MAIN_BRANCH))).not.toContain(heldOnly.name);
    expect(JSON.stringify(docToContent(room.doc))).not.toContain(heldOnly.name);
    await h.server.storage.flushDoc(id);
    const file = new Uint8Array(await (await fetch(`${h.base}/api/files/${id}/download`)).arrayBuffer());
    const other = await startServer();
    try {
      const imported = await (await fetch(`${other.base}/api/files/import`, { method: 'POST', headers: { 'x-bogen-filename': 'Copy.bogen' }, body: file })).json() as { id: string };
      expect(await other.server.storage.readAsset(attached.name)).toBeTruthy();
      expect(await other.server.storage.readAsset(heldOnly.name)).toBeTruthy();
      expect(getDesignBranch((await other.server.rooms.get(imported.id)).doc, MAIN_BRANCH).held?.length).toBe(1);
    } finally {
      await other.cleanup();
    }
  });
});

describe('writing what must not be lost', () => {
  it('continues a short write and fails rather than keep part of one', async () => {
    const { writeAllSync } = await import('../src/util.ts');
    const got: number[] = [];
    writeAllSync(7, new Uint8Array([1, 2, 3, 4, 5]), (_fd, b, offset, length) => {
      const n = Math.min(2, length);
      got.push(...b.slice(offset, offset + n));
      return n;
    });
    expect(got).toEqual([1, 2, 3, 4, 5]);
    expect(() => writeAllSync(7, new Uint8Array([1, 2, 3]), () => 0)).toThrow(/took no more bytes/);
  });

  it('a held update keeps every picture it names reachable, hundreds of them', async () => {
    h = await startServer();
    const { id, room } = await themeFile(h);
    const page = room.doc.getPages()[0]!.id;
    const text = room.doc.insert(page, { type: 'text', tag: 'p', name: 'Title', text: 'Night', style: {} });
    const phone = new BogenDoc(new Y.Doc());
    Y.applyUpdate(phone.y, Y.encodeStateAsUpdate(room.doc.y));
    await fetch(`${h.base}/api/files/${id}/design-branches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ember' }) });
    const names = Array.from({ length: 300 }, (_, i) => `${i.toString(16).padStart(64, '0')}.png`);
    phone.editText(text, 'Night', `Night ${names.map((n) => `bogen-asset:${n}`).join(' ')}`);
    const { applyRemoteUpdate } = await import('../src/design-branches.ts');
    applyRemoteUpdate({ storage: h.server.storage }, room, Y.encodeStateAsUpdate(phone.y), Y.encodeStateVector(phone.y), { name: 'Phone', id: 'phone:1' }, 'test');
    const held = getDesignBranch(room.doc, MAIN_BRANCH).held![0]!;
    expect(held.assets).toHaveLength(300);
    const { branchAssetNames } = await import('@bogen/core');
    expect(branchAssetNames(room.doc)).toEqual(expect.arrayContaining(names));
  });
});
