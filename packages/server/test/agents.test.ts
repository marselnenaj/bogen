import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { BogenDoc, exportDocument, Y } from '@bogen/core';
import { packBogenFile } from '../src/bogen-file.ts';
import { BogenServer } from '../src/http/server.ts';
import { call, callRaw, connectAgent, pngStats, startServer, until, type Harness } from './helpers.ts';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = async (client: Client, uri: string) => String(((await client.readResource({ uri })).contents[0] as { text: string }).text);

/** A real y-websocket client, as the editor uses. With a user it also appears in awareness as a person. */
function person(base: string, fileId: string, name = 'Mara') {
  const y = new Y.Doc();
  const provider = new WebsocketProvider(`${base.replace('http', 'ws')}/sync`, fileId, y, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  provider.awareness.setLocalState({ user: { name, color: '#123456' }, cursor: null, selection: [], pageId: null });
  return {
    y, provider, doc: new BogenDoc(y), awareness: provider.awareness,
    synced: () => until(() => provider.synced),
    set: (values: Record<string, unknown>) => provider.awareness.setLocalState({ ...provider.awareness.getLocalState(), ...values }),
    close: () => {
      provider.destroy();
      y.destroy();
    },
  };
}

describe('hearing about things', () => {
  let h: Harness;
  let agent: Client;
  let file: string;
  let page: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'watcher');
    const created = await call(agent, 'file_create', { name: 'Events' });
    file = created.id;
    page = created.pages[0].id;
  });

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('declares only what it does', () => {
    const caps = agent.getServerCapabilities()!;
    expect(caps.tools).toEqual({ listChanged: false });
    expect(caps.prompts).toEqual({ listChanged: false });
    expect(caps.resources).toEqual({ subscribe: true, listChanged: true });
  });

  it('returns empty at the timeout, with a cursor that still works', async () => {
    const start = await call(agent, 'wait_for_event', { timeout_seconds: 0 });
    const before = Date.now();
    const empty = await call(agent, 'wait_for_event', { cursor: start.cursor, timeout_seconds: 0.2 });
    expect(Date.now() - before).toBeGreaterThanOrEqual(190);
    expect(empty).toMatchObject({ events: [], timed_out: true, cursor: start.cursor });
  });

  it('refuses a timeout past what clients allow', async () => {
    expect((await callRaw(agent, 'wait_for_event', { timeout_seconds: 90 })).isError).toBe(true);
  });

  it('wakes at once when a comment arrives, and resumes from a cursor without losing anything', async () => {
    const other = await connectAgent(h.base, 'other');
    await call(other, 'file_open', { file_id: file });
    const start = (await call(agent, 'wait_for_event', { timeout_seconds: 0 })).cursor;

    const before = Date.now();
    const waiting = call(agent, 'wait_for_event', { cursor: start, timeout_seconds: 20 });
    await sleep(100);
    const thread = (await call(other, 'comment_add', { text: 'One', page_id: page })).id;
    const first = await waiting;
    expect(Date.now() - before).toBeLessThan(5000);
    expect(first.timed_out).toBe(false);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ kind: 'comment_added', thread_id: thread, text: 'One', author: 'other', source: 'agent', actor: 'other' });

    // These happen while nobody is waiting.
    await call(other, 'comment_reply', { thread_id: thread, text: 'Two' });
    // Only a person resolves; their editor's change reaches agents as an event.
    (await h.server.rooms.get(file)).doc.setThreadResolved(thread, true, 'person:Mara');
    const second = await call(agent, 'wait_for_event', { cursor: first.cursor, timeout_seconds: 0 });
    expect(second.events.map((e: any) => e.kind)).toEqual(['comment_replied', 'comment_resolved']);
    expect(second.events[0].text).toBe('Two');

    // An older cursor reads the same again, and the newest has nothing.
    expect((await call(agent, 'wait_for_event', { cursor: first.cursor, timeout_seconds: 0 })).events).toHaveLength(2);
    expect((await call(agent, 'wait_for_event', { cursor: second.cursor, timeout_seconds: 0 })).events).toEqual([]);
    await other.close();
  });

  it('leaves out an agent\'s own changes, filters by kind, and pages with limit', async () => {
    const start = (await call(agent, 'wait_for_event', { timeout_seconds: 0 })).cursor;
    const own = (await call(agent, 'comment_add', { text: 'Mine', page_id: page })).id;
    await call(agent, 'comment_reply', { thread_id: own, text: 'Also mine' });
    expect((await call(agent, 'wait_for_event', { cursor: start, timeout_seconds: 0 })).events).toEqual([]);
    const included = await call(agent, 'wait_for_event', { cursor: start, timeout_seconds: 0, include_own: true, limit: 1 });
    expect(included.events.map((e: any) => e.kind)).toEqual(['comment_added']);
    const rest = await call(agent, 'wait_for_event', { cursor: included.cursor, timeout_seconds: 0, include_own: true });
    expect(rest.events.map((e: any) => e.kind)).toEqual(['comment_replied']);
    const filtered = await call(agent, 'wait_for_event', { cursor: start, timeout_seconds: 0, include_own: true, kinds: ['comment_replied'] });
    expect(filtered.events.map((e: any) => e.kind)).toEqual(['comment_replied']);
  });

  it('says so when a cursor is from before a restart', async () => {
    const out = await call(agent, 'wait_for_event', { cursor: `gone.${file}.7`, timeout_seconds: 0 });
    expect(out.reset).toBe(true);
    expect(out.cursor).toContain(file);
  });

  it('does not make a waiting agent look busy', async () => {
    const quiet = await connectAgent(h.base, 'quiet');
    await call(quiet, 'file_open', { file_id: file });
    const started = Date.now();
    const waiting = callRaw(quiet, 'wait_for_event', { timeout_seconds: 0.5 });
    await sleep(100);
    const status = await (await fetch(`${h.base}/api/status`)).json() as { agents: { name: string; lastTool: string }[] };
    expect(status.agents.find((a) => a.name === 'quiet')?.lastTool).toBe('file_open');
    await waiting;
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    await quiet.close();
  });

  it('reports a person selecting, changing page and editing layers, once it settles', async () => {
    const start = (await call(agent, 'wait_for_event', { timeout_seconds: 0 })).cursor;
    const board = (await call(agent, 'artboard_create', { name: 'Seen', width: 400, height: 300 })).id;
    const editor = person(h.base, file);
    await editor.synced();
    editor.set({ pageId: page, selection: [board] });
    await until(() => editor.doc.getNode(board) !== undefined);
    // A drag: many small changes.
    for (let i = 0; i < 5; i++) editor.doc.updateStyle(board, { left: `${i}px` });
    let cursor = start;
    const seen: any[] = [];
    await until(async () => {
      const out = await call(agent, 'wait_for_event', { cursor, timeout_seconds: 0 });
      cursor = out.cursor;
      seen.push(...out.events);
      return seen.some((e) => e.kind === 'layer_changed_by_person');
    });
    expect(seen.find((e) => e.kind === 'page_changed')).toMatchObject({ page_id: page, source: 'person', actor: 'Mara' });
    expect(seen.find((e) => e.kind === 'selection_changed')).toMatchObject({ source: 'person', selection: [{ id: board, name: 'Seen' }] });
    const edits = seen.filter((e) => e.kind === 'layer_changed_by_person');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ node_ids: [board], source: 'person', actor: 'Mara' });
    editor.close();
  });

  it('delivers notifications/resources/updated to a subscriber, for each resource', async () => {
    const sub = await connectAgent(h.base, 'subscriber');
    // The client opens its notification stream right after the handshake.
    await sleep(150);
    const updates: string[] = [];
    sub.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });
    const uri = (kind: string) => `bogen://file/${file}/${kind}`;
    for (const kind of ['selection', 'tokens', 'tree', 'comments']) await sub.subscribeResource({ uri: uri(kind) });

    await call(agent, 'tokens_set', { tokens: [{ name: 'accent', kind: 'color', value: '#ff5500' }] });
    await until(() => updates.includes(uri('tokens')));
    expect(JSON.parse(await textOf(sub, uri('tokens'))).tokens[0].name).toBe('accent');

    await call(agent, 'comment_add', { text: 'Look', page_id: page });
    await until(() => updates.includes(uri('comments')));

    const board = (await call(agent, 'artboard_create', { name: 'Tree', width: 100, height: 100 })).id;
    await until(() => updates.includes(uri('tree')));
    expect(await textOf(sub, uri('tree'))).toContain(board);

    const editor = person(h.base, file);
    await editor.synced();
    editor.set({ pageId: page, selection: [board] });
    await until(() => updates.includes(uri('selection')));
    const selection = JSON.parse(await textOf(sub, uri('selection')));
    expect(selection.people[0].selection[0].id).toBe(board);
    editor.close();

    // After unsubscribing it stops.
    await sub.unsubscribeResource({ uri: uri('tokens') });
    await sleep(250);
    updates.length = 0;
    await call(agent, 'tokens_set', { tokens: [{ name: 'accent', kind: 'color', value: '#000000' }] });
    await sleep(300);
    expect(updates).not.toContain(uri('tokens'));
    await sub.close();
  }, 20_000);

  it('lists resources, refuses unknown ones, and announces new files', async () => {
    const watcher = await connectAgent(h.base, 'lister');
    await sleep(150);
    let changed = 0;
    watcher.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      changed++;
    });
    const { resources } = await watcher.listResources();
    expect(resources.map((r) => r.uri)).toContain(`bogen://file/${file}/comments`);
    await expect(watcher.subscribeResource({ uri: 'bogen://file/nothere/comments' })).rejects.toThrow();
    await expect(watcher.subscribeResource({ uri: 'file:///etc/passwd' })).rejects.toThrow();
    await expect(watcher.readResource({ uri: 'bogen://file/nothere/comments' })).rejects.toThrow();
    await call(agent, 'file_create', { name: 'Another' });
    await call(agent, 'file_open', { file_id: file });
    await until(() => changed > 0);
    await watcher.close();
  });

  it('offers prompts that teach the tools', async () => {
    const { prompts } = await agent.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['build_from_repo_tokens', 'implement_selection', 'review_design', 'use_brand']);
    const review = await agent.getPrompt({ name: 'review_design', arguments: { focus: 'the mobile layout' } });
    expect((review.messages[0]!.content as { text: string }).text).toMatch(/the mobile layout[\s\S]*Do not change anything/);
    const implement = await agent.getPrompt({ name: 'implement_selection', arguments: { target: 'src/Hero.tsx' } });
    expect((implement.messages[0]!.content as { text: string }).text).toMatch(/code_get[\s\S]*src\/Hero\.tsx/);
    const tokens = await agent.getPrompt({ name: 'build_from_repo_tokens', arguments: {} });
    expect((tokens.messages[0]!.content as { text: string }).text).toContain('tokens_from_css');
  });

  it('teaches all this in the instructions and guides', async () => {
    const instructions = agent.getInstructions()!;
    for (const word of ['wait_for_event', 'agent_undo', 'batch', 'view_focus', 'responsive_check', 'visual_diff']) expect(instructions).toContain(word);
    expect(await call(agent, 'guide_get', { topic: 'live' })).toContain('cursor');
    expect(await call(agent, 'guide_get', { topic: 'checks' })).toContain('dry_run');
  });
});

describe('a comment that asks for an agent', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-fake-cli-'));
  const log = join(bin, 'runs.jsonl');
  const savedPath = process.env.PATH;
  let h: Harness;
  let file: string;
  let page: string;

  const lines = (): any[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const runs = (): any[] => lines().filter((l) => !l.kind);
  const staleCalls = (): { thread: string; refused: boolean }[] => lines().filter((l) => l.kind === 'stale-resolve');
  const threadOf = async (id: string) => (await h.server.rooms.get(file)).doc.getComments().find((t) => t.id === id)!;
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const res = await fetch(`${h.base}/api/comments`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ fileId: file, author: 'Mara', ...body }) });
    expect(res.status).toBe(201);
    return res.json() as Promise<{ threadId: string; messageId: string; started: string[]; refused?: string }>;
  };
  const idle = () => until(() => !h.server.runs.activeFor(file) && !h.server.commentRuns.list(file).length, 8000);
  /** Until an agent has answered in the thread. */
  const answered = (threadId: string) => until(async () => (await threadOf(threadId)).messages.slice(1).some((m) => m.author === 'claude' || m.author === 'codex'), 8000);

  beforeAll(async () => {
    // A CLI that does what a real one does: it reads the prompt, and uses the MCP server it was given.
    for (const name of ['claude', 'codex']) {
      writeFileSync(join(bin, name), `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('1.0.0 (Fake)'); process.exit(0); }
if (process.argv[2] === '--help' || process.argv[2] === 'debug') process.exit(0);
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
const system = process.argv[process.argv.indexOf('--append-system-prompt') + 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ runner: ${JSON.stringify(name)}, stdin, system, startedAt: Date.now() }) + '\\n');
// Codex takes its server through -c options, with the headers as a TOML inline table.
const option = (key) => { const a = process.argv.find((x) => x.startsWith(key + '=')); return a && a.slice(key.length + 1); };
const config = process.argv.includes('--mcp-config')
  ? JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.bogen
  : { url: JSON.parse(option('mcp_servers.bogen.url')), headers: JSON.parse(option('mcp_servers.bogen.http_headers').replace(/"=/g, '":')) };
const mode = (/fake:(\\w+)/.exec(stdin) || [])[1];
const thread = /Comment thread (\\w+):/.exec(stdin)[1];
async function rpc(session, id, method, params) {
  const res = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
  return res;
}
(async () => {
  if (mode === 'fail') { console.error('It went wrong.'); process.exit(3); }
  if (mode === 'hang') await new Promise((resolve) => setTimeout(resolve, 60000));
  if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 400));
  if (mode === 'silent') process.exit(0);
  const init = await rpc(null, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  const session = init.headers.get('mcp-session-id');
  await rpc(session, null, 'notifications/initialized', {});
  // It does the work, unless it is one that only talks; a second go after the nudge does the work.
  if (mode !== 'talk' || stdin.includes('You replied without changing anything')) await rpc(session, 4, 'tools/call', { name: 'tokens_set', arguments: { tokens: [{ name: 'fake-done', kind: 'color', value: '#123456' }] } });
  // It even mentions itself, which must not start anything.
  await rpc(session, 2, 'tools/call', { name: 'comment_reply', arguments: { thread_id: thread, text: mode === 'talk' && !stdin.includes('You replied without changing anything') ? "You're right, that should be bigger." : 'Done, @claude and @codex can check.' } });
  // As agents used to: a stale comment_resolve, which the server refuses without touching the thread.
  const raw = await (await rpc(session, 3, 'tools/call', { name: 'comment_resolve', arguments: { thread_id: thread } })).text();
  const stale = JSON.parse((/^data: (.*)$/m.exec(raw) || [null, raw])[1]);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: 'stale-resolve', thread, refused: Boolean(stale.error || (stale.result && stale.result.isError)) }) + '\\n');
})();
`);
      chmodSync(join(bin, name), 0o755);
    }
    process.env.PATH = `${bin}:${savedPath}`;
    h = await startServer();
    const created = await (await fetch(`${h.base}/api/files`, json({ name: 'Comments' }))).json() as { id: string };
    file = created.id;
    page = (await h.server.rooms.get(file)).doc.getPages()[0]!.id;
  });

  afterAll(async () => {
    process.env.PATH = savedPath;
    await h.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  it('starts that runner with the thread and layer as context; the answer lands in the thread, which stays open', async () => {
    const room = await h.server.rooms.get(file);
    const layer = room.doc.insert(page, { type: 'frame', name: 'Hero', style: { position: 'absolute', left: '0px', top: '0px', width: '100px', height: '50px' } });
    const before = runs().length;
    const statuses: any[] = [];
    const ws = new WebSocket(`${h.base.replace('http', 'ws')}/events`);
    ws.on('message', (d) => {
      const e = JSON.parse(String(d));
      if (e.t === 'comment-run') statuses.push(e);
    });
    await new Promise((resolve) => ws.once('open', resolve));

    const { threadId, started } = await post({ text: '@claude tighten this. fake:ok', nodeId: layer });
    expect(started).toEqual(['claude']);
    await answered(threadId);
    await idle();
    // The agent tried to resolve it after answering; refused, and the thread stays open after the run.
    expect(staleCalls().some((c) => c.thread === threadId && c.refused)).toBe(true);
    expect((await threadOf(threadId)).resolved).toBe(false);

    const thread = await threadOf(threadId);
    expect(thread.messages.map((m) => m.author)).toEqual(['Mara', 'claude']);
    expect(thread.nodeId).toBe(layer);
    const run = runs().slice(before)[0]!;
    expect(run.runner).toBe('claude');
    expect(run.stdin).toContain(`Comment thread ${threadId}:`);
    expect(run.stdin).toContain('Mara: @claude tighten this');
    expect(run.stdin).toContain(`pinned to layer ${layer}, a frame named "Hero"`);
    expect(run.system).toContain(`comment thread ${threadId}`);
    expect(run.system).toContain('comment_reply');
    await until(() => statuses.some((s) => s.status === 'done'));
    expect(statuses.map((s) => s.status)).toEqual(expect.arrayContaining(['queued', 'working', 'done']));
    expect(statuses[0]).toMatchObject({ fileId: file, threadId, runner: 'claude' });
    ws.close();

    // The agent's reply mentioned both runners, and nothing followed.
    await sleep(300);
    expect(runs().length).toBe(before + 1);
  }, 15_000);

  it('asks once more when a request phrased as a question got only agreement, and records it', async () => {
    const before = runs().length;
    const { threadId } = await post({ text: '@codex kannst du das größer machen? fake:talk', pageId: page });
    await answered(threadId);
    await idle();
    const [first, second, ...more] = runs().slice(before);
    expect(more).toEqual([]);
    expect(first.runner).toBe('codex');
    expect(first.stdin).not.toContain('You replied without changing anything');
    // The continuation has the request, what it answered in the thread, and the nudge.
    expect(second.runner).toBe('codex');
    expect(second.stdin).toContain('kannst du das größer machen?');
    expect(second.stdin).toContain("Your reply was:\nYou're right, that should be bigger.");
    expect(second.stdin).toContain('You replied without changing anything. If the person asked for a change, make it now; if it truly was only a question, say so in one sentence.');
    expect((await threadOf(threadId)).messages.map((m) => m.author)).toEqual(['Mara', 'codex', 'codex']);
    const record = (await h.server.history.list(file)).find((r) => r.threadId === threadId)!;
    expect(record).toMatchObject({ status: 'done', nudged: true, firstReply: "You're right, that should be bigger." });

    // Asked again in that thread, the run hears what the one before changed.
    await post({ text: '@codex und jetzt noch etwas dunkler fake:ok', threadId });
    await until(() => runs().length === before + 3, 8000);
    await idle();
    expect(runs().at(-1).stdin).toMatch(/What agents did on this thread before[^\n]*\n- codex, [^\n]*done after being asked again to make the change: changed no layers\./);
  }, 20_000);

  it('does not ask again after a question that wants to know something', async () => {
    const before = runs().length;
    const { threadId } = await post({ text: '@claude which font is this, fake:talk?', pageId: page });
    await answered(threadId);
    await idle();
    expect(runs().length).toBe(before + 1);
    expect((await h.server.history.list(file)).find((r) => r.threadId === threadId)?.nudged).toBeUndefined();
  }, 15_000);

  it('asks the right runner, and only for real mentions', async () => {
    const before = runs().length;
    const codex = await post({ text: 'hey @Codex, a look? fake:ok', pageId: page });
    expect(codex.started).toEqual(['codex']);
    await idle();
    expect(runs().at(-1).runner).toBe('codex');
    expect(runs().length).toBe(before + 1);

    for (const text of ['no mention here', 'write to me@claude.ai', 'see @claude.md', '@claudette hi', 'mail@codex']) {
      expect((await post({ text, pageId: page })).started).toEqual([]);
    }
    await sleep(200);
    expect(runs().length).toBe(before + 1);
  }, 15_000);

  it('does not start a run for a comment from an agent', async () => {
    const before = runs().length;
    const agent = await connectAgent(h.base, 'loopy');
    await call(agent, 'file_open', { file_id: file });
    const id = (await call(agent, 'comment_add', { text: '@claude please do this', page_id: page })).id;
    await call(agent, 'comment_reply', { thread_id: id, text: '@codex and you too' });
    await sleep(300);
    expect(runs().length).toBe(before);
    expect(h.server.commentRuns.list(file)).toEqual([]);
    await agent.close();
  });

  it('does not start a run for a comment written into the document by any client', async () => {
    const before = runs().length;
    const client = person(h.base, file);
    await client.synced();
    const id = client.doc.addThread({ pageId: page, x: 0, y: 0, author: 'Mara', text: '@claude run this' });
    client.doc.replyThread(id, 'Mara', '@codex and this');
    await until(async () => (await h.server.rooms.get(file)).doc.comments.has(id));
    await sleep(300);
    expect(runs().length).toBe(before);
    client.close();
  });

  it('does not start a run for an imported file full of mentions', async () => {
    const before = runs().length;
    const source = new BogenDoc();
    const pageId = source.createPage('Page 1');
    source.addThread({ pageId, x: 0, y: 0, author: 'Stranger', text: '@claude run this for me' });
    const bytes = await packBogenFile(Y.encodeStateAsUpdate(source.y), async () => null);
    const imported = await (await fetch(`${h.base}/api/files/import`, { method: 'POST', body: Buffer.from(bytes) as never })).json() as { id: string };
    const room = await h.server.rooms.get(imported.id);
    expect(room.doc.getComments()).toHaveLength(1);
    await sleep(200);
    expect(runs().length).toBe(before);
  });

  it('does not start a run for a comment arriving from a sync peer', async () => {
    const before = runs().length;
    const home = mkdtempSync(join(tmpdir(), 'bogen-peer-'));
    const a = new BogenServer({ home: mkdtempSync(join(tmpdir(), 'bogen-peer-a-')), port: 0, insecureAllowAnyHost: true, peerCatchUpMs: 60_000 });
    const b = new BogenServer({ home, port: 0, insecureAllowAnyHost: true, peerCatchUpMs: 60_000 });
    await a.listen();
    await b.listen();
    try {
      const info = await (await fetch(`${a.localUrl()}/api/peers/pair`, json({ insecure: true }))).json() as { url: string; token: string };
      expect((await fetch(`${b.localUrl()}/api/peers`, json({ url: info.url, token: info.token, insecure: true }))).status).toBe(201);
      const id = (await (await fetch(`${a.localUrl()}/api/files`, json({ name: 'Shared' }))).json() as { id: string }).id;
      await until(() => Boolean(b.storage.get(id)), 8000);
      const roomB = await b.rooms.get(id);
      const pageB = roomB.doc.getPages()[0]!.id;
      roomB.doc.addThread({ pageId: pageB, x: 0, y: 0, author: 'Other device', text: '@claude run this over there' }, 'agent:remote');
      await until(async () => (await a.rooms.get(id)).doc.getComments().length === 1, 8000);
      const cursor = a.fileEvents.wait(id, { cursor: `${a.fileEvents.epoch}.${id}.0`, kinds: ['comment_added'], timeoutMs: 2000, limit: 5 });
      expect((await cursor).events[0]).toMatchObject({ source: 'peer', text: '@claude run this over there' });
      await sleep(200);
      expect(runs().length).toBe(before);
      expect(a.commentRuns.list(id)).toEqual([]);
    } finally {
      await a.close();
      await b.close();
    }
  }, 20_000);

  it('writes the comment but starts nothing for a request that is not from this device', async () => {
    const before = runs().length;
    const out = await post({ text: '@claude from elsewhere', pageId: page }, { 'x-forwarded-for': '203.0.113.9' });
    expect(out.started).toEqual([]);
    expect(out.refused).toMatch(/this device|device that runs/);
    expect((await threadOf(out.threadId)).messages).toHaveLength(1);
    await sleep(150);
    expect(runs().length).toBe(before);
  });

  it('runs one at a time per file, and the rest wait their turn', async () => {
    const before = runs().length;
    const first = await post({ text: '@claude first fake:slow', pageId: page });
    const second = await post({ text: '@claude second fake:ok', pageId: page });
    expect(first.started).toEqual(['claude']);
    expect(second.started).toEqual(['claude']);
    const listed = h.server.commentRuns.list(file);
    expect(listed.filter((r) => r.status === 'working')).toHaveLength(1);
    expect(listed.find((r) => r.threadId === second.threadId)?.status).toBe('queued');
    await idle();
    const done = runs().slice(before);
    expect(done).toHaveLength(2);
    expect(done[0].stdin).toContain('first');
    expect(done[1].stdin).toContain('second');
    // The second started only after the first had finished its 400 ms.
    expect(done[1].startedAt - done[0].startedAt).toBeGreaterThanOrEqual(400);
  }, 15_000);

  it('blocks a prompt run while a comment run is going, and the other way round', async () => {
    const hanging = await post({ text: '@claude wait fake:hang', pageId: page });
    await until(() => Boolean(h.server.runs.activeFor(file)));
    const refused = await fetch(`${h.base}/api/runs`, json({ fileId: file, prompt: 'x', runner: 'claude' }));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/already going on this file/);
    const runId = h.server.runs.activeFor(file)!;
    expect((await fetch(`${h.base}/api/runs/${runId}/stop`, { method: 'POST' })).status).toBe(200);
    await idle();
    await until(async () => (await threadOf(hanging.threadId)).messages.length === 2, 6000);
    expect((await threadOf(hanging.threadId)).messages.at(-1)).toMatchObject({ author: 'Bogen', text: 'claude was stopped before it did anything.' });
  }, 15_000);

  it('says plainly in the thread when a run fails or stays silent', async () => {
    const failed = await post({ text: '@claude fake:fail', pageId: page });
    await until(async () => (await threadOf(failed.threadId)).messages.length === 2, 6000);
    const failure = (await threadOf(failed.threadId)).messages.at(-1)!;
    expect(failure.author).toBe('Bogen');
    expect(failure.text).toContain('It went wrong.');

    const silent = await post({ text: '@claude fake:silent', pageId: page });
    await until(async () => (await threadOf(silent.threadId)).messages.length === 2, 6000);
    expect((await threadOf(silent.threadId)).messages.at(-1)).toMatchObject({ author: 'Bogen', text: 'claude finished without answering here.' });
  }, 15_000);

  it('reopens a finished thread when asked again', async () => {
    const first = await post({ text: 'fine as it is', pageId: page });
    (await h.server.rooms.get(file)).doc.setThreadResolved(first.threadId, true);
    // Without a mention it stays as it is.
    await post({ text: 'still fine', threadId: first.threadId });
    expect((await threadOf(first.threadId)).resolved).toBe(true);
    const again = await post({ text: '@claude one more thing fake:ok', threadId: first.threadId });
    expect(again.threadId).toBe(first.threadId);
    expect(again.started).toEqual(['claude']);
    await until(async () => (await threadOf(first.threadId)).messages.at(-1)!.author === 'claude', 6000);
    await idle();
    // Reopened by the person's new request, and the agent's answer does not close it again.
    expect((await threadOf(first.threadId)).resolved).toBe(false);
  }, 15_000);

  it('caps the queue and the rate, in the thread', async () => {
    const hanging = await post({ text: '@claude hold fake:hang', pageId: page });
    await until(() => Boolean(h.server.runs.activeFor(file)));
    const replies = [];
    for (let i = 0; i < 6; i++) replies.push(await post({ text: `@claude number ${i} fake:ok`, pageId: page }));
    expect(replies.slice(0, 5).every((r) => r.started[0] === 'claude')).toBe(true);
    expect(replies[5]!.refused).toMatch(/already waiting/);
    expect((await threadOf(replies[5]!.threadId)).messages.at(-1)!.author).toBe('Bogen');
    await fetch(`${h.base}/api/runs/${h.server.runs.activeFor(file)}/stop`, { method: 'POST' });
    await idle();
    expect((await threadOf(hanging.threadId)).messages.at(-1)!.text).toBe('claude was stopped before it did anything.');
  }, 30_000);

  it('validates a posted comment', async () => {
    expect((await fetch(`${h.base}/api/comments`, json({ fileId: file, text: '' }))).status).toBe(400);
    expect((await fetch(`${h.base}/api/comments`, json({ fileId: 'missing1', text: 'x' }))).status).toBe(404);
    expect((await fetch(`${h.base}/api/comments`, json({ fileId: file, text: 'x', threadId: 'nothread' }))).status).toBe(404);
    const foreign = await fetch(`${h.base}/api/comments`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ fileId: file, text: '@claude x' }) });
    expect(foreign.status).toBe(403);
  });
});

describe('write tools', () => {
  let h: Harness;
  let agent: Client;
  let file: string;
  let board: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'writer');
    file = (await call(agent, 'file_create', { name: 'Writes' })).id;
    board = (await call(agent, 'artboard_create', { name: 'Board', width: 800, height: 600 })).id;
  });

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  const box = (left: number, top: number, name: string, extra = '') => `<div data-name="${name}" style="position:absolute;left:${left}px;top:${top}px;width:50px;height:40px;background:#123456;${extra}"></div>`;
  const place = async (html: string) => (await call(agent, 'html_write', { target_id: board, html })).ids as string[];
  const style = async (id: string) => (await call(agent, 'layer_get', { node_id: id })).style;

  describe('agent_undo', () => {
    it('undoes and redoes only this agent\'s last change', async () => {
      const [mine, theirs, personal] = await place(box(0, 0, 'Mine') + box(60, 0, 'Theirs') + box(120, 0, 'Personal'));
      const other = await connectAgent(h.base, 'other-agent');
      await call(other, 'file_open', { file_id: file });
      const editor = person(h.base, file);
      await editor.synced();

      await call(agent, 'layer_style', { node_ids: [mine], style: { opacity: '0.5' } });
      await call(other, 'layer_style', { node_ids: [theirs], style: { opacity: '0.4' } });
      await until(() => editor.doc.getNode(personal!) !== undefined);
      editor.doc.updateStyle(personal!, { opacity: '0.3' });
      await until(async () => (await style(personal!)).opacity === '0.3');

      const undone = await call(agent, 'agent_undo');
      expect(undone.undone).toBe(true);
      expect(undone.can_redo).toBe(1);
      expect((await style(mine!)).opacity).toBeUndefined();
      expect((await style(theirs!)).opacity).toBe('0.4');
      expect((await style(personal!)).opacity).toBe('0.3');

      const redone = await call(agent, 'agent_undo', { redo: true });
      expect(redone.redone).toBe(true);
      expect((await style(mine!)).opacity).toBe('0.5');

      // The other agent's undo is its own.
      await call(other, 'agent_undo');
      expect((await style(theirs!)).opacity).toBeUndefined();
      expect((await style(mine!)).opacity).toBe('0.5');
      await other.close();
      editor.close();
    });

    it('takes back what the agent drew, not its reply in a thread', async () => {
      const [id] = await place(box(0, 200, 'Answered'));
      const thread = (await call(agent, 'comment_add', { node_id: id, text: 'Asked here.' })).id as string;
      await call(agent, 'layer_style', { node_ids: [id], style: { opacity: '0.6' } });
      await call(agent, 'comment_reply', { thread_id: thread, text: 'Done.' });

      const undone = await call(agent, 'agent_undo');
      expect(undone.undone).toBe(true);
      expect((await style(id!)).opacity).toBeUndefined();
      const threads = await call(agent, 'comments_list', { status: 'all' }) as { id: string; resolved: boolean; messages: unknown[] }[];
      const kept = threads.find((t) => t.id === thread)!;
      expect(kept.resolved).toBe(false);
      expect(kept.messages).toHaveLength(2);
    });

    it('leaves a value that someone changed afterwards, and says when it went further back', async () => {
      const [id] = await place(box(0, 100, 'Contested'));
      await call(agent, 'layer_style', { node_ids: [id], style: { opacity: '0.7' } });
      await call(agent, 'layer_style', { node_ids: [id], style: { color: 'red' } });
      const editor = person(h.base, file);
      await editor.synced();
      await until(() => editor.doc.getNode(id!) !== undefined);
      editor.doc.updateStyle(id!, { color: 'blue' });
      await until(async () => (await style(id!)).color === 'blue');
      // Nothing is left of the colour change to undo, so the step before it goes instead.
      const out = await call(agent, 'agent_undo');
      expect(out).toMatchObject({ undone: true, steps: 2 });
      expect(out.note).toContain('overwritten');
      expect((await style(id!)).color).toBe('blue');
      expect((await style(id!)).opacity).toBeUndefined();
      editor.close();
    });

    it('says so when there is nothing left', async () => {
      const fresh = await connectAgent(h.base, 'fresh-agent');
      await call(fresh, 'file_open', { file_id: file });
      expect(await call(fresh, 'agent_undo')).toMatchObject({ undone: false, can_undo: 0 });
      expect(await call(fresh, 'agent_undo', { redo: true })).toMatchObject({ redone: false });
      await fresh.close();
    });
  });

  describe('batch', () => {
    it('applies nothing when a step fails', async () => {
      const [id] = await place(box(0, 200, 'Atomic'));
      const layersBefore = (await call(agent, 'layer_tree', { node_id: board, depth: 4 }));
      const tokensBefore = await call(agent, 'tokens_get');
      const raw = await callRaw(agent, 'batch', {
        steps: [
          { tool: 'layer_style', args: { node_ids: [id], style: { opacity: '0.1' } } },
          { tool: 'tokens_set', args: { tokens: [{ name: 'batchy', kind: 'color', value: '#111' }] } },
          { tool: 'html_write', args: { target_id: board, html: '<p>Added</p>' } },
          { tool: 'layer_delete', args: { node_ids: ['doesnotexist'] } },
          { tool: 'layer_text', args: { node_id: 'neverreached', text: 'x' } },
        ],
      });
      expect(raw.isError).toBe(true);
      expect(raw.content[0]!.text).toMatch(/Step 3 \(layer_delete\) failed, so nothing was applied/);
      expect((await style(id!)).opacity).toBeUndefined();
      expect(await call(agent, 'tokens_get')).toEqual(tokensBefore);
      expect(await call(agent, 'layer_tree', { node_id: board, depth: 4 })).toBe(layersBefore);
    });

    it('reports without applying in a dry run, including a failing step', async () => {
      const [id] = await place(box(0, 250, 'Dry'));
      const version = await call(agent, 'layer_tree', { node_id: board, depth: 4 });
      const ok = await call(agent, 'batch', {
        dry_run: true,
        steps: [
          { tool: 'html_write', args: { target_id: board, html: '<section><h2>New</h2></section>' }, as: 'made' },
          { tool: 'layer_rename', args: { node_id: '$made.ids.0', name: 'Renamed' } },
          { tool: 'layer_style', args: { node_ids: [id], style: { opacity: '0.2' } } },
        ],
      });
      expect(ok).toMatchObject({ ok: true, dry_run: true, applied: false });
      expect(ok.steps[1].result.name).toBe('Renamed');
      expect(await call(agent, 'layer_tree', { node_id: board, depth: 4 })).toBe(version);

      const bad = await call(agent, 'batch', { dry_run: true, steps: [{ tool: 'layer_text', args: { node_id: 'nope', text: 'x' } }] });
      expect(bad).toMatchObject({ ok: false, applied: false, failed_step: 0 });
      expect(bad.error).toContain('nope');
    });

    it('is one undo step, sees earlier steps, and keeps text that merely looks like a reference', async () => {
      const before = await call(agent, 'layer_tree', { node_id: board, depth: 4 });
      const out = await call(agent, 'batch', {
        steps: [
          { tool: 'tokens_set', args: { tokens: [{ name: 'one-step', kind: 'color', value: '#222' }] } },
          { tool: 'html_write', args: { target_id: board, html: '<section data-name="Made" style="position:absolute;left:300px;top:300px;display:flex"><p style="color:var(--one-step)">Text</p><p>Other</p></section>' }, as: 'made' },
          { tool: 'layer_rename', args: { node_id: '$made.ids.0', name: 'Made and named' } },
          { tool: 'layer_text', args: { node_id: '$1.ids.0', text: 'x' } },
        ],
      }).catch((e: Error) => e.message);
      // A frame has no text, which fails the batch and proves the reference was followed.
      expect(String(out)).toMatch(/Step 3 .*is a frame, not text/);

      const applied = await call(agent, 'batch', {
        steps: [
          { tool: 'tokens_set', args: { tokens: [{ name: 'one-step', kind: 'color', value: '#222' }] } },
          { tool: 'html_write', args: { target_id: board, html: '<p data-name="Price" style="position:absolute;left:300px;top:300px">Text</p>' }, as: 'price' },
          { tool: 'layer_text', args: { node_id: '$price.ids.0', text: '$9.99' } },
          { tool: 'layer_rename', args: { node_id: '$1.ids.0', name: 'Price tag' } },
        ],
      });
      expect(applied).toMatchObject({ ok: true, applied: true });
      const id = applied.steps[1].result.ids[0];
      const layer = await call(agent, 'layer_get', { node_id: id });
      expect(layer.text).toBe('$9.99');
      expect(layer.name).toBe('Price tag');
      expect((await call(agent, 'tokens_get')).map((t: any) => t.name)).toContain('one-step');

      expect((await call(agent, 'agent_undo')).undone).toBe(true);
      expect((await call(agent, 'tokens_get')).map((t: any) => t.name)).not.toContain('one-step');
      expect(await call(agent, 'layer_tree', { node_id: board, depth: 4 })).toBe(before);
      await call(agent, 'agent_undo', { redo: true });
      expect((await call(agent, 'layer_get', { node_id: id })).text).toBe('$9.99');
      await call(agent, 'agent_undo');
    });

    it('reaches a live peer as one update, and refuses tools that do not belong', async () => {
      const editor = person(h.base, file);
      await editor.synced();
      let updates = 0;
      editor.y.on('update', () => updates++);
      const made = await call(agent, 'batch', { steps: [
        { tool: 'html_write', args: { target_id: board, html: '<p>A</p>' } },
        { tool: 'html_write', args: { target_id: board, html: '<p>B</p>' } },
        { tool: 'layer_delete', args: { node_ids: ['$0.ids'] } },
      ] });
      await until(() => updates > 0 && editor.doc.getNode(made.steps[1].result.ids[0]) !== undefined);
      await sleep(100);
      expect(updates).toBe(1);
      expect(editor.doc.getNode(made.steps[0].result.ids[0])).toBeUndefined();
      await call(agent, 'agent_undo');
      editor.close();

      for (const tool of ['agent_undo', 'file_create', 'batch', 'page_capture', 'wait_for_event']) {
        const raw = await callRaw(agent, 'batch', { steps: [{ tool, args: {} }] });
        expect(raw.isError, tool).toBe(true);
        expect(raw.content[0]!.text).toContain('cannot be part of a batch');
      }
      expect((await callRaw(agent, 'batch', { steps: [{ tool: 'layer_rename', args: { node_id: board, name: 'x', file_id: 'otherfile' } }] })).isError).toBe(true);
    });

    it('respects locks inside a batch', async () => {
      const [id] = await place(box(0, 400, 'Locked'));
      await call(agent, 'layer_set_flags', { node_ids: [id], locked: true });
      const raw = await callRaw(agent, 'batch', { steps: [{ tool: 'layer_style', args: { node_ids: [id], style: { opacity: '0' } } }] });
      expect(raw.isError).toBe(true);
      expect(raw.content[0]!.text).toContain('locked');
      await call(agent, 'layer_set_flags', { node_ids: [id], locked: false });
    });
  });

  describe('layer_attrs and keyframes', () => {
    it('sets safe attributes and refuses handlers and script URLs, changing nothing', async () => {
      const [link, image] = await place('<a href="https://example.com" style="display:block">Link</a><img src="https://example.invalid/x.png" alt="old" style="width:10px;height:10px">');
      const before = await call(agent, 'layer_get', { node_id: link });

      for (const [attrs, pattern] of [
        [{ onclick: 'alert(1)' }, /onclick: Event handlers/],
        [{ OnMouseOver: 'alert(1)' }, /Event handlers/],
        [{ href: 'javascript:alert(1)' }, /could run code/],
        [{ href: ' java\tscript:alert(1)' }, /not allowed/],
        [{ href: 'data:text/html,<script>alert(1)</script>' }, /not allowed/],
        [{ href: 'https://fine.example', onclick: 'alert(1)' }, /onclick/],
        [{ srcdoc: '<script>alert(1)</script>' }, /Only these attributes/],
        [{ style: 'color:red' }, /Only these attributes/],
      ] as const) {
        const raw = await callRaw(agent, 'layer_attrs', { node_id: link, attrs });
        expect(raw.isError, JSON.stringify(attrs)).toBe(true);
        expect(raw.content[0]!.text).toMatch(pattern);
      }
      expect(await call(agent, 'layer_get', { node_id: link })).toEqual(before);

      expect((await call(agent, 'layer_attrs', { node_id: link, attrs: { href: 'https://fine.example', target: '_blank', 'aria-label': 'Go' } })).attrs.href).toBe('https://fine.example');
      expect((await callRaw(agent, 'layer_attrs', { node_id: image, attrs: { src: 'javascript:alert(1)' } })).isError).toBe(true);
      expect((await callRaw(agent, 'layer_attrs', { node_id: link, attrs: { src: 'https://x.example/a.png' } })).isError).toBe(true);
      expect((await call(agent, 'layer_attrs', { node_id: image, attrs: { alt: 'A portrait', src: 'https://x.example/a.png' } })).src).toBe('https://x.example/a.png');

      const room = await h.server.rooms.get(file);
      const html = exportDocument(room.doc, [link!, image!]);
      expect(html).toContain('href="https://fine.example"');
      expect(html).toContain('alt="A portrait"');
      expect(html).not.toMatch(/onclick|javascript:|srcdoc/);

      // Removing.
      const cleared = await call(agent, 'layer_attrs', { node_id: link, attrs: { target: null } });
      expect(cleared.attrs.target).toBeUndefined();
      expect(cleared.attrs.href).toBe('https://fine.example');
    });

    it('takes shader parameters under the same rules', async () => {
      const [id] = await place('<x-shader type="mesh-gradient" colors="#000,#f50" style="width:100px;height:100px"></x-shader>');
      expect((await call(agent, 'layer_attrs', { node_id: id, attrs: { colors: '#111,#222', speed: '0.5', image: 'bogen-asset:abc.png' } })).attrs).toMatchObject({ colors: '#111,#222', speed: '0.5', type: 'mesh-gradient' });
      for (const attrs of [{ onLoad: 'x' }, { image: 'javascript:alert(1)' }, { dangerouslySetInnerHTML: 'x' }, { style: 'x' }, { 'a b': 'x' }, { distortion: 'javascript:x' }]) {
        expect((await callRaw(agent, 'layer_attrs', { node_id: id, attrs })).isError, JSON.stringify(attrs)).toBe(true);
      }
    });

    it('reads, replaces and deletes keyframes, and refuses what could escape a style element', async () => {
      const set = await call(agent, 'keyframes_set', { name: 'rise', css: 'from{opacity:0}to{opacity:1}' });
      expect(set.css).toBe('@keyframes rise{from{opacity:0}to{opacity:1}}');
      await call(agent, 'keyframes_set', { name: 'fall', css: '@keyframes other{to{opacity:0}}' });
      await call(agent, 'keyframes_set', { name: 'rise', css: 'to{opacity:0.5}' });
      const list = await call(agent, 'keyframes_get');
      expect(list.map((k: any) => k.name).sort()).toEqual(['fall', 'rise']);
      expect(list.find((k: any) => k.name === 'rise').css).toContain('opacity:0.5');

      for (const css of ['to{opacity:0}}</style><script>alert(1)</script>', 'to{background:url(javascript:alert(1))}', '@import url(x);to{opacity:0}', 'not frames', 'to{opacity:0}}body{display:none', 'to{a{b{c:d}}}']) {
        expect((await callRaw(agent, 'keyframes_set', { name: 'bad', css })).isError, css).toBe(true);
      }
      expect((await callRaw(agent, 'keyframes_set', { name: 'a b', css: 'to{opacity:0}' })).isError).toBe(true);
      await call(agent, 'keyframes_set', { name: 'fall', css: null });
      expect((await call(agent, 'keyframes_get')).map((k: any) => k.name)).toEqual(['rise']);
    });

    it('drops bad keyframes that arrive in a stored document', async () => {
      const doc = new BogenDoc();
      const page = doc.createPage('P');
      const id = doc.insert(page, { type: 'frame', name: 'F' });
      doc.meta.set('keyframes', ['@keyframes ok{to{opacity:0}}', '@keyframes x{to{opacity:0}}</style><script>alert(1)</script>', 7]);
      const html = exportDocument(doc, [id]);
      expect(html).toContain('@keyframes ok');
      expect(html).not.toContain('alert(1)');
    });
  });

  describe('showing a person', () => {
    it('reaches a real y-websocket peer through awareness, with the layers and the note', async () => {
      const [id] = await place(box(0, 500, 'Focus'));
      const editor = person(h.base, file);
      await editor.synced();
      await until(() => editor.doc.getNode(id!) !== undefined);
      const focusOf = () => [...editor.awareness.getStates().values()].find((s) => s.user?.agent && s.user?.name === 'writer')?.focus;

      const shown = await call(agent, 'view_focus', { node_ids: [id], note: 'Look at this' });
      expect(shown.shown_to).toEqual(['Mara']);
      await until(() => focusOf()?.note === 'Look at this');
      const first = focusOf();
      expect(first).toMatchObject({ nodeIds: [id], view: true, select: false });

      await call(agent, 'selection_set', { node_ids: [id] });
      await until(() => focusOf()?.id !== first.id);
      expect(focusOf()).toMatchObject({ nodeIds: [id], select: true, view: false });

      // A later tool call republishes presence, and the same focus keeps its id, so it is not shown twice.
      const current = focusOf().id;
      await call(agent, 'layer_tree', { node_id: board });
      await sleep(100);
      expect(focusOf().id).toBe(current);

      editor.close();
    });

    it('says so when nobody is there, and checks what it is given', async () => {
      const alone = await startServer();
      const solo = await connectAgent(alone.base, 'solo');
      await call(solo, 'file_create', { name: 'Alone' });
      const lone = await call(solo, 'artboard_create', { name: 'L', width: 100, height: 100 });
      const out = await call(solo, 'view_focus', { node_ids: [lone.id] });
      expect(out.shown_to).toEqual([]);
      expect(out.note).toContain('Nobody');
      expect((await callRaw(solo, 'view_focus', { node_ids: ['nope'] })).isError).toBe(true);
      expect((await callRaw(solo, 'view_focus', {})).isError).toBe(true);
      expect((await callRaw(solo, 'selection_set', { node_ids: [] })).isError).toBe(true);
      await solo.close();
      await alone.cleanup();
    });
  });

  describe('structure', () => {
    let frame: string;
    beforeAll(async () => {
      frame = (await call(agent, 'artboard_create', { name: 'Structure', width: 600, height: 400, x: 2000 })).id;
    });
    const boxesIn = async (parent: string, html: string) => (await call(agent, 'html_write', { target_id: parent, html })).ids as string[];
    const measured = async (ids: string[]) => call(agent, 'layer_styles_computed', { node_ids: ids, properties: ['position'] });

    it('groups absolute layers without moving them on screen, and ungroups them back', async () => {
      const [a, b] = await boxesIn(frame, box(100, 50, 'A') + box(200, 150, 'B'));
      const before = await measured([a!, b!]);
      const group = await call(agent, 'layers_group', { node_ids: [a, b] });
      expect((await call(agent, 'layer_get', { node_id: a })).parent).toBe(group.id);
      expect(await style(group.id)).toMatchObject({ position: 'absolute', left: '100px', top: '50px', width: '150px', height: '140px' });
      expect(await style(a!)).toMatchObject({ left: '0px', top: '0px' });
      const during = await measured([a!, b!]);
      expect(during[a!].box.x).toBeCloseTo(before[a!].box.x, 1);
      expect(during[b!].box.y).toBeCloseTo(before[b!].box.y, 1);

      const out = await call(agent, 'layers_ungroup', { node_ids: [group.id] });
      expect(out.released.sort()).toEqual([a, b].sort());
      expect((await call(agent, 'layer_get', { node_id: a })).parent).toBe(frame);
      expect((await callRaw(agent, 'layer_get', { node_id: group.id })).isError).toBe(true);
      const after = await measured([a!, b!]);
      expect(after[b!].box.x).toBeCloseTo(before[b!].box.x, 1);
      expect(after[b!].box.y).toBeCloseTo(before[b!].box.y, 1);
    });

    it('wraps in flex, also for flow children; refuses mixed parents', async () => {
      const row = (await boxesIn(frame, '<div data-name="Row" style="position:absolute;left:0;top:300px;display:flex;gap:10px;width:600px"><div data-name="X" style="width:30px;height:30px;background:#111"></div><div data-name="Y" style="width:30px;height:30px;background:#222"></div><div data-name="Z" style="width:30px;height:30px;background:#333"></div></div>'))[0]!;
      const kids = (await call(agent, 'layer_get', { node_id: row })).children.map((c: any) => c.id);
      const wrapped = await call(agent, 'layer_wrap', { node_ids: [kids[0], kids[1]], name: 'Pair', tag: 'section', direction: 'column', gap: '4px', style: { 'background-color': '#fff' } });
      const layer = await call(agent, 'layer_get', { node_id: wrapped.id });
      expect(layer).toMatchObject({ name: 'Pair', tag: 'section', parent: row });
      expect(layer.style).toMatchObject({ display: 'flex', flexDirection: 'column', gap: '4px', backgroundColor: '#fff' });
      expect((await call(agent, 'layer_get', { node_id: row })).children.map((c: any) => c.id)).toEqual([wrapped.id, kids[2]]);

      // A plain group in a flex row keeps arranging its children the same way.
      const plain = await call(agent, 'layers_group', { node_ids: [kids[2]] });
      expect(await style(plain.id)).toMatchObject({ display: 'flex', gap: '10px' });

      expect((await callRaw(agent, 'layers_group', { node_ids: [kids[0], kids[2]] })).content[0]!.text).toContain('different parents');
      expect((await callRaw(agent, 'layer_wrap', { node_ids: [row], style: { background: 'url(javascript:alert(1))' } })).isError).toBe(true);
      expect((await callRaw(agent, 'layers_ungroup', { node_ids: [kids[0]] })).isError).toBe(true);
    });

    it('wraps absolute layers in flex, which gives up their positions', async () => {
      const [a, b] = await boxesIn(frame, box(10, 10, 'P') + box(100, 10, 'Q'));
      const wrapped = await call(agent, 'layer_wrap', { node_ids: [a, b], direction: 'row', gap: '8px' });
      expect(await style(wrapped.id)).toMatchObject({ position: 'absolute', left: '10px', top: '10px', display: 'flex', width: 'fit-content' });
      expect((await style(a!)).position).toBeUndefined();
      expect((await style(a!)).left).toBeUndefined();
    });

    it('aligns and distributes by measured boxes, and refuses layers in flow', async () => {
      const area = (await boxesIn(frame, '<div data-name="Area" style="position:absolute;left:0;top:0;width:500px;height:200px"></div>'))[0]!;
      const [a, b, c] = await boxesIn(area, box(0, 0, 'A') + box(100, 30, 'B') + box(300, 70, 'C'));
      await call(agent, 'layers_align', { node_ids: [a, b, c], edge: 'top' });
      expect((await style(c!)).top).toBe('0px');
      await call(agent, 'layers_align', { node_ids: [a, b], edge: 'right' });
      expect((await style(a!)).left).toBe('100px');
      await call(agent, 'layers_align', { node_ids: [c], edge: 'center' });
      expect((await style(c!)).left).toBe('225px');
      await call(agent, 'layers_align', { node_ids: [c], edge: 'bottom', to: 'parent' });
      expect((await style(c!)).top).toBe('160px');

      await call(agent, 'layer_style', { node_ids: [a], style: { left: '0px', top: '0px' } });
      await call(agent, 'layer_style', { node_ids: [b], style: { left: '70px', top: '0px' } });
      await call(agent, 'layer_style', { node_ids: [c], style: { left: '400px', top: '0px' } });
      const out = await call(agent, 'layers_distribute', { node_ids: [a, b, c], axis: 'x' });
      expect(out.gap).toBe(150);
      expect((await style(b!)).left).toBe('200px');
      await call(agent, 'layers_distribute', { node_ids: [a, b], axis: 'x', gap: 8 });
      expect((await style(b!)).left).toBe('58px');
      expect((await callRaw(agent, 'layers_distribute', { node_ids: [a, b], axis: 'x' })).isError).toBe(true);

      const row = (await boxesIn(frame, '<div style="display:flex"><div style="width:9px;height:9px"></div><div style="width:9px;height:9px"></div></div>'))[0]!;
      const flow = (await call(agent, 'layer_get', { node_id: row })).children.map((k: any) => k.id);
      const refused = await callRaw(agent, 'layers_align', { node_ids: flow, edge: 'left' });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toContain('alignItems');
    });

    it('works as batch steps, measuring what earlier steps did', async () => {
      const [a, b] = await boxesIn(frame, box(5, 5, 'M') + box(50, 80, 'N'));
      const out = await call(agent, 'batch', { steps: [
        { tool: 'layer_style', args: { node_ids: [a], style: { left: '300px' } } },
        { tool: 'layers_align', args: { node_ids: [a, b], edge: 'left' } },
        { tool: 'layers_group', args: { node_ids: [a, b], name: 'Pair' }, as: 'g' },
        { tool: 'layer_rename', args: { node_id: '$g.id', name: 'Named pair' } },
      ] });
      expect(out.ok).toBe(true);
      const group = out.steps[2].result.id;
      expect((await call(agent, 'layer_get', { node_id: group })).name).toBe('Named pair');
      expect(await style(group)).toMatchObject({ left: '50px' });
      expect((await style(a!)).left).toBe('0px');
      await call(agent, 'agent_undo');
      expect((await style(a!)).left).toBe('5px');
    });
  });

  describe('asset_upload', () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

    it('stores an image and returns a src that a layer can use', async () => {
      const out = await call(agent, 'asset_upload', { data_base64: PNG, mime_type: 'image/png' });
      expect(out.src).toMatch(/^bogen-asset:[a-f0-9]{64}\.png$/);
      const res = await fetch(`${h.base}/assets/${out.src.slice('bogen-asset:'.length)}`);
      expect(res.headers.get('content-type')).toBe('image/png');
      const again = await call(agent, 'asset_upload', { data_base64: `data:image/png;base64,${PNG}`, mime_type: 'image/png' });
      expect(again.src).toBe(out.src);
    });

    it('checks the bytes against the type, the size and the encoding', async () => {
      const refuse = async (args: Record<string, unknown>, pattern: RegExp) => {
        const raw = await callRaw(agent, 'asset_upload', args);
        expect(raw.isError).toBe(true);
        expect(raw.content[0]!.text).toMatch(pattern);
      };
      await refuse({ data_base64: PNG, mime_type: 'image/jpeg' }, /are image\/png, not image\/jpeg/);
      await refuse({ data_base64: Buffer.from('<html><script>alert(1)</script></html>').toString('base64'), mime_type: 'image/png' }, /not a known image type/);
      await refuse({ data_base64: '!!!', mime_type: 'image/png' }, /valid base64/);
      await refuse({ data_base64: 'A'.repeat(7_100_000), mime_type: 'image/png' }, /over the limit/);
      await refuse({ data_base64: Buffer.from('not svg').toString('base64'), mime_type: 'image/svg+xml' }, /not an SVG/);
      expect((await callRaw(agent, 'asset_upload', { data_base64: PNG, mime_type: 'text/html' })).isError).toBe(true);
    });

    it('reads a file an image tool saved, by path, and only images under home or temp', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bogen-upload-'));
      try {
        writeFileSync(join(dir, 'made.png'), Buffer.from(PNG, 'base64'));
        const out = await call(agent, 'asset_upload', { path: join(dir, 'made.png') });
        expect(out).toMatchObject({ mime_type: 'image/png', bytes: Buffer.from(PNG, 'base64').length });
        expect(out.src).toBe((await call(agent, 'asset_upload', { data_base64: PNG, mime_type: 'image/png' })).src);
        writeFileSync(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="9" height="9"/></svg>');
        expect((await call(agent, 'asset_upload', { path: join(dir, 'icon.svg') })).mime_type).toBe('image/svg+xml');
        writeFileSync(join(dir, 'secret.png'), 'OPENAI_API_KEY=sk-not-an-image');
        const refuse = async (args: Record<string, unknown>, pattern: RegExp) => {
          const raw = await callRaw(agent, 'asset_upload', args);
          expect(raw.isError).toBe(true);
          expect(raw.content[0]!.text).toMatch(pattern);
          expect(raw.content[0]!.text).not.toContain('sk-not');
        };
        await refuse({ path: join(dir, 'secret.png') }, /not a known image type/);
        await refuse({ path: join(dir, 'made.png'), mime_type: 'image/webp' }, /are image\/png, not image\/webp/);
        await refuse({ path: 'made.png' }, /absolute/);
        await refuse({ path: join(dir, 'missing.png') }, /no file/);
        await refuse({ path: dir }, /not a file/);
        await refuse({ path: '/etc/passwd' }, /outside the home and temp folders/);
        await refuse({ path: join(dir, 'made.png'), data_base64: PNG, mime_type: 'image/png' }, /either path or data_base64/);
        await refuse({ data_base64: PNG }, /needs mime_type/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('sanitizes SVG', async () => {
      const out = await call(agent, 'asset_upload', { data_base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="9" height="9"/></svg>').toString('base64'), mime_type: 'image/svg+xml' });
      const body = await (await fetch(`${h.base}/assets/${out.src.slice('bogen-asset:'.length)}`)).text();
      expect(body).toContain('<rect');
      expect(body).not.toMatch(/alert|onload|script/);
    });
  });
});

describe('design checking', () => {
  let h: Harness;
  let agent: Client;
  let board: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'checker');
    await call(agent, 'file_create', { name: 'Checks' });
    board = (await call(agent, 'artboard_create', { name: 'Check', width: 400, height: 300, x: 0 })).id;
  });

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  const square = (color: string, extra = '') => `<div style="width:100px;height:100px;background:${color};flex:none;${extra}"></div>`;
  const diff = async (args: Record<string, unknown>) => {
    const raw = await callRaw(agent, 'visual_diff', args);
    expect(raw.isError, raw.content[0]?.text).toBe(false);
    const image = raw.content.find((c) => c.type === 'image')!;
    return { report: JSON.parse(raw.content[0]!.text!), image: Buffer.from(image.data!, 'base64'), mime: image.mimeType };
  };

  it('measures nothing for identical layers, and the changed share for different ones', async () => {
    const [a] = (await call(agent, 'html_write', { target_id: board, html: square('#102030') })).ids;
    const [same] = (await call(agent, 'html_write', { target_id: board, html: square('#102030') })).ids;
    const [half] = (await call(agent, 'html_write', { target_id: board, html: `<div style="width:100px;height:100px;background:linear-gradient(90deg,#102030 50%,#ff0000 50%);flex:none"></div>` })).ids;

    const clean = await diff({ node_id: a, other_node_id: same });
    expect(clean.report).toMatchObject({ different_percent: 0, different_pixels: 0, same_size: true, bounds: null });

    const changed = await diff({ node_id: a, other_node_id: half });
    expect(changed.report.different_percent).toBeGreaterThan(45);
    expect(changed.report.different_percent).toBeLessThan(55);
    expect(changed.report.bounds.x).toBeGreaterThanOrEqual(45);
    expect(changed.mime).toBe('image/png');
    const stats = await pngStats(changed.image);
    expect(stats.width).toBe(100);
    expect(stats.distinctColors).toBeGreaterThan(1);
  }, 30_000);

  it('compares against an image asset, counts size differences, and keeps the picture bounded', async () => {
    const [a] = (await call(agent, 'html_write', { target_id: board, html: square('#102030') })).ids;
    const shot = await callRaw(agent, 'canvas_screenshot', { node_id: a });
    const uploaded = await call(agent, 'asset_upload', { data_base64: shot.content[0]!.data, mime_type: 'image/png' });
    expect((await diff({ node_id: a, asset: uploaded.src })).report).toMatchObject({ different_percent: 0, same_size: true });

    const [big] = (await call(agent, 'html_write', { target_id: board, html: square('#102030', 'width:200px') })).ids;
    const wider = await diff({ node_id: big, asset: uploaded.src });
    expect(wider.report.same_size).toBe(false);
    expect(wider.report.different_percent).toBeGreaterThan(45);
    expect((await diff({ node_id: big, asset: uploaded.src, fit: true })).report.different_percent).toBe(0);

    const [huge] = (await call(agent, 'html_write', { target_id: board, html: square('#102030', 'width:1800px;height:1800px') })).ids;
    const large = await diff({ node_id: huge, asset: uploaded.src });
    const stats = await pngStats(large.image);
    expect(Math.max(stats.width, stats.height)).toBeLessThanOrEqual(1000);
    expect(large.image.length).toBeLessThanOrEqual(1_500_000);

    for (const args of [{ node_id: a }, { node_id: a, other_node_id: big, asset: uploaded.src }, { node_id: a, asset: 'bogen-asset:nope.png' }, { node_id: 'nope', other_node_id: a }]) {
      expect((await callRaw(agent, 'visual_diff', args)).isError, JSON.stringify(args)).toBe(true);
    }
  }, 30_000);

  it('finds overflow and clipped text at narrow widths only', async () => {
    const page = await call(agent, 'artboard_create', { name: 'Responsive', width: 1000, x: 2000 });
    await call(agent, 'html_write', { target_id: page.id, html: `
      <section data-name="Wide row" style="display:flex;width:800px;gap:8px"><p style="flex:1">A column</p></section>
      <p data-name="Cut" style="width:100%;height:20px;overflow:hidden">Short text.</p>
      <p data-name="Long" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:50%">This is a long line of text that runs a good deal further than a phone is wide, on purpose.</p>
      <div data-name="Fluid" style="width:100%;max-width:300px;height:20px"></div>` });

    const raw = await callRaw(agent, 'responsive_check', { node_id: page.id, widths: [1000, 390], screenshots: true });
    expect(raw.isError).toBe(false);
    const report = JSON.parse(raw.content[0]!.text!);
    const [wide, narrow] = report.widths;
    expect(report.ok).toBe(false);
    expect(wide.overflow).toEqual([]);
    expect(wide.width).toBe(1000);
    expect(narrow.ok).toBe(false);
    expect(narrow.overflow[0]).toMatchObject({ name: 'Wide row', side: 'right', fixed_width: '800px' });
    expect(narrow.overflow[0].by).toBe(410);
    expect(narrow.clipped_text.map((c: any) => c.name)).toContain('Long');
    const shots = raw.content.filter((c) => c.type === 'image');
    expect(shots).toHaveLength(2);
    const stats = await pngStats(Buffer.from(shots[1]!.data!, 'base64'));
    expect(stats.width).toBeLessThanOrEqual(800);

    const fine = await call(agent, 'artboard_create', { name: 'Fine', width: 600, x: 4000 });
    await call(agent, 'html_write', { target_id: fine.id, html: '<p style="width:100%">Short.</p>' });
    const good = JSON.parse((await callRaw(agent, 'responsive_check', { node_id: fine.id, widths: [600, 320] })).content[0]!.text!);
    expect(good.ok).toBe(true);
    expect((await callRaw(agent, 'responsive_check', { node_id: 'nope' })).isError).toBe(true);
  }, 30_000);

  it('measures height-only WebView changes without condemning or removing sticky effects', async () => {
    const board = await call(agent, 'artboard_create', { name: 'Mobile viewport', width: 390 });
    const [card] = (await call(agent, 'html_write', { target_id: board.id, html: '<section data-name="Sticky card" style="position:sticky;top:0;min-height:100svh"><p>Card</p></section>' })).ids;
    await call(agent, 'layer_style', { node_ids: [card], when: '@media (max-width: 500px) and (max-height: 620px)', style: { position: 'relative' } });
    const args = { node_id: board.id, widths: [390, 800], viewport_heights: [664, 760, 600] };
    const before = await call(agent, 'responsive_check', args);
    expect(before.viewport_stability.stable).toBe(false);
    const [baseline, expanded, collapsed] = before.viewport_stability.widths[0].samples;
    expect(baseline.stable).toBe(true);
    expect(expanded.changed_layers.find((c: any) => c.id === card)).toMatchObject({ height_changed_by: 96, position_before: 'sticky', position_after: 'sticky' });
    expect(collapsed.changed_layers.find((c: any) => c.id === card)).toMatchObject({ height_changed_by: -64, position_before: 'sticky', position_after: 'relative' });
    expect(before.viewport_stability.widths[1].samples[2].changed_layers.find((c: any) => c.id === card)).toMatchObject({ height_changed_by: -64, position_before: 'sticky', position_after: 'sticky' });
    // Pinning geometry fixes the measured risk while the effect stays enabled.
    await call(agent, 'layer_style', { node_ids: [card], style: { minHeight: '664px' } });
    await call(agent, 'layer_style', { node_ids: [card], when: '@media (max-width: 500px) and (max-height: 620px)', clear_block: true });
    const after = await call(agent, 'responsive_check', args);
    expect(after.viewport_stability.stable).toBe(true);
    expect((await call(agent, 'layer_get', { node_id: card })).style.position).toBe('sticky');
    expect((await call(agent, 'responsive_check', { node_id: board.id, widths: [390] })).viewport_stability).toBeUndefined();
  }, 30_000);

  it('lints alt text, small text and small targets', async () => {
    const id = (await call(agent, 'artboard_create', { name: 'Lint', width: 400, height: 200, x: 6000 })).id;
    await call(agent, 'html_write', { target_id: id, html: '<img src="https://example.invalid/a.png" style="width:40px;height:40px"><img src="https://example.invalid/b.png" alt="" style="width:40px;height:40px"><p style="font-size:9px;color:#000">Tiny</p><a href="https://x.example" style="width:10px;height:10px;display:block;color:#000;font-size:14px">x</a><button style="width:80px;height:40px;color:#000;font-size:14px">Fine</button>' });
    const lint = await call(agent, 'design_lint', { node_id: id });
    expect(lint.counts.alt).toBe(1);
    expect(lint.counts['small-text']).toBe(1);
    expect(lint.counts.target).toBe(1);
    expect(lint.issues.find((i: any) => i.rule === 'target').message).toContain('10x10px');
  }, 30_000);

  it('finds generated-sounding copy in text layers, with the phrase and what to write instead', async () => {
    const id = (await call(agent, 'artboard_create', { name: 'Copy', width: 600, height: 400, x: 7000 })).id;
    await call(agent, 'html_write', { target_id: id, html: '<h1 style="font-size:40px;color:#000">Ready to elevate your workflow?</h1><p style="font-size:16px;color:#000">Seamless invoicing for teams. Whether you\'re a freelancer or an agency, we\'ve got you covered!</p><p style="font-size:16px;color:#000">Nahtlose Abrechnung, nicht nur ein Tool, sondern ein Partner.</p><p style="font-size:16px;color:#000">Send invoices in two clicks. Copyright 2026.</p>' });
    const lint = await call(agent, 'design_lint', { node_id: id });
    const copy = lint.issues.filter((i: any) => i.rule === 'copy');
    expect(lint.counts.copy).toBe(copy.length);
    const said = copy.map((i: any) => i.message).join('\n');
    for (const phrase of ['"elevate"', '"Seamless"', 'rhetorical question', 'exclamation mark', '"Nahtlose"', '"nicht nur ein Tool, sondern"', "we've got you covered"]) expect(said).toContain(phrase);
    expect(said).toMatch(/Whether you're a freelancer or/);
    // The plain sentence passes.
    expect(copy.some((i: any) => i.message.includes('two clicks'))).toBe(false);
  }, 30_000);

  it('exports tokens as CSS or a Tailwind block, and writes nothing itself', async () => {
    expect(await call(agent, 'tokens_export')).toContain('no tokens yet');
    await call(agent, 'tokens_set', { tokens: [
      { name: 'accent', kind: 'color', value: '#ff5500' },
      { name: 'radius-md', kind: 'radius', value: '8px' },
      { name: 'font-display', kind: 'font-family', value: '"Instrument Serif", serif' },
      { name: 'text-sm', kind: 'font-size', value: '14px' },
      { name: 'space-4', kind: 'spacing', value: '16px' },
    ] });
    const css = await call(agent, 'tokens_export', { format: 'css' });
    expect(css).toMatch(/^:root \{\n/);
    expect(css).toContain('--accent: #ff5500;');
    expect(await call(agent, 'tokens_export', { format: 'css', selector: '.dark' })).toMatch(/^\.dark \{/);
    expect((await callRaw(agent, 'tokens_export', { format: 'css', selector: 'a{}</style>' })).isError).toBe(true);

    const tailwind = await call(agent, 'tokens_export', { format: 'tailwind' });
    expect(tailwind).toContain('--accent: #ff5500;');
    expect(tailwind).toContain('@theme inline {');
    for (const line of ['--color-accent: var(--accent);', '--radius-md: var(--radius-md);', '--font-display: var(--font-display);', '--text-sm: var(--text-sm);', '--spacing-4: var(--space-4);']) expect(tailwind).toContain(line);

    const v3 = await call(agent, 'tokens_export', { format: 'tailwind3' });
    expect(v3).toContain('"colors"');
    expect(v3).toContain('"accent": "var(--accent)"');

    // What it produces can be read back, for the trip through a repo.
    const parsed = await call(agent, 'tokens_from_css', { css, dry_run: true });
    expect(parsed.tokens.map((t: any) => t.name).sort()).toEqual(['accent', 'font-display', 'radius-md', 'space-4', 'text-sm']);
  });
});

describe('the stdio relay', () => {
  it('passes updates on, and keeps a subscription across a server restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bogen-relay-'));
    let server = new BogenServer({ home, port: 0 });
    await server.listen();
    const port = server.port;
    const fileId = (await (await fetch(`${server.localUrl()}/api/files`, json({ name: 'Relay' }))).json() as { id: string }).id;
    const client = new Client({ name: 'stdio-agent', version: '1' });
    const root = join(import.meta.dirname, '..', '..', '..');
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', join(root, 'packages/server/src/cli.ts'), 'mcp'], cwd: root,
      env: { ...process.env as Record<string, string>, BOGEN_HOME: home, BOGEN_URL: `http://127.0.0.1:${port}` }, stderr: 'ignore',
    });
    await client.connect(transport);
    try {
      const updates: string[] = [];
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        updates.push(n.params.uri);
      });
      const uri = `bogen://file/${fileId}/tokens`;
      await sleep(300);
      await client.subscribeResource({ uri });
      const set = (value: string) => client.callTool({ name: 'tokens_set', arguments: { file_id: fileId, tokens: [{ name: 'a', kind: 'color', value }] } });
      await set('#111');
      await until(() => updates.includes(uri), 6000);

      await server.close();
      server = new BogenServer({ home, port });
      await server.listen();
      updates.length = 0;
      // The first call finds the session gone, makes a new one and subscribes again.
      await client.listTools();
      await sleep(400);
      await set('#222');
      await until(() => updates.includes(uri), 8000);
    } finally {
      await client.close();
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);
});
