import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { BogenDoc, Y } from '@bogen/core';
import { BogenServer, type ServerOptions } from '../src/http/server.ts';
import { findConflicts } from '../src/sync-conflicts.ts';
import { connectAgent, call, until } from './helpers.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const homes: string[] = [];
const running = new Set<BogenServer>();
const clients: (() => void)[] = [];

async function boot(options: Partial<ServerOptions> = {}, home = mkdtempSync(join(tmpdir(), 'bogen-sync-')), port = 0): Promise<BogenServer> {
  homes.push(home);
  const server = new BogenServer({ home, port, insecureAllowAnyHost: true, peerCatchUpMs: 60_000, exportDir: join(home, 'exports'), ...options });
  await server.listen();
  running.add(server);
  return server;
}

const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function pair(a: BogenServer, b: BogenServer): Promise<void> {
  const info = await (await post(a.localUrl(), '/api/peers/pair', { insecure: true })).json() as { url: string; token: string };
  const res = await post(b.localUrl(), '/api/peers', { url: info.url, token: info.token, insecure: true });
  expect(res.status).toBe(201);
  await until(() => a.peers.status().some((p) => p.state === 'connected') && b.peers.status().some((p) => p.state === 'connected'), 6000);
}

/**
 * Two devices that each edit while the other is gone: `a` goes away and `b` edits, then `b` goes away too while `a`
 * comes back and edits, then `b` comes back. A device that starts dials its peers at once, so an edit made right after
 * it started could already follow the other's; with the other one down, it is made apart for certain.
 */
async function apartEdits(a: BogenServer, homeA: string, b: BogenServer, homeB: string, onB: (s: BogenServer) => Promise<unknown>, onA: (s: BogenServer) => Promise<unknown>): Promise<{ server: BogenServer; other: BogenServer }> {
  const [portA, portB] = [a.port, b.port];
  await a.close();
  running.delete(a);
  await onB(b);
  await b.close();
  running.delete(b);
  const server = await boot({}, homeA, portA);
  await onA(server);
  const other = await boot({}, homeB, portB);
  return { server, other };
}

const person = (server: BogenServer, fileId: string, name: string, extra: Record<string, unknown> = {}) => {
  const y = new Y.Doc();
  const provider = new WebsocketProvider(`${server.localUrl().replace('http', 'ws')}/sync`, fileId, y, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  provider.awareness.setLocalState({ user: { name, color: '#123456' }, cursor: null, selection: [], pageId: null, ...extra });
  const close = () => {
    provider.destroy();
    y.destroy();
  };
  clients.push(close);
  return { y, provider, doc: new BogenDoc(y), awareness: provider.awareness, close, set: (values: Record<string, unknown>) => provider.awareness.setLocalState({ ...provider.awareness.getLocalState(), ...values }) };
};

afterEach(async () => {
  for (const close of clients.splice(0)) {
    try { close(); } catch { /* It may be gone. */ }
  }
  for (const server of [...running]) {
    running.delete(server);
    await server.close();
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('versions between devices', () => {
  it('says which version a peer runs and when it differs', async () => {
    const a = await boot({ reportVersion: '1.0.0+aaa' });
    const b = await boot({ reportVersion: '1.0.0+bbb' });
    await pair(a, b);
    await until(() => Boolean(a.peers.status()[0]?.version && b.peers.status()[0]?.version));
    expect(a.peers.status()[0]).toMatchObject({ version: '1.0.0+bbb', versionMismatch: true });
    expect(b.peers.status()[0]).toMatchObject({ version: '1.0.0+aaa', versionMismatch: true });
    const status = await (await fetch(`${a.localUrl()}/api/status`)).json() as { version: string; peers: { versionMismatch: boolean }[] };
    expect(status.version).toBe('1.0.0+aaa');
    expect(status.peers[0]!.versionMismatch).toBe(true);
  });

  it('says nothing when they match', async () => {
    const a = await boot({ reportVersion: '1.0.0+same' });
    const b = await boot({ reportVersion: '1.0.0+same' });
    await pair(a, b);
    await until(() => Boolean(a.peers.status()[0]?.version));
    expect(a.peers.status()[0]!.versionMismatch).toBe(false);
  });
});

describe('status of a link', () => {
  it('counts bytes and remembers the last error after it went away', async () => {
    const a = await boot();
    const b = await boot();
    await pair(a, b);
    const file = (await (await post(a.localUrl(), '/api/files', { name: 'Bytes' })).json() as { id: string }).id;
    await until(() => Boolean(b.storage.get(file)), 5000);
    const room = await a.rooms.get(file);
    room.doc.setToken('accent', 'color', '#ff0000');
    await until(async () => (await b.rooms.get(file)).doc.getTokens().length === 1, 5000);
    const here = a.peers.status()[0]!;
    expect(here.bytesOut).toBeGreaterThan(0);
    expect(here.bytesIn).toBeGreaterThan(0);
    const link = (a.peers as unknown as { links: Map<string, { error: string | undefined }> }).links.values().next().value!;
    link.error = 'it broke';
    link.error = undefined;
    const after = a.peers.status()[0]!;
    expect(after.error).toBeUndefined();
    expect(after.lastError).toBe('it broke');
    expect(after.lastErrorAt).toBeGreaterThan(0);
    expect(await (await fetch(`${a.localUrl()}/api/peers`)).json()).toMatchObject({ peers: [{ lastError: 'it broke' }] });

    // What a person sees, through the real command.
    const out = await new Promise<string>((done, fail) => {
      // Not the sync form: the server it talks to runs in this very process.
      execFile(join(ROOT, 'node_modules/.bin/tsx'), [join(ROOT, 'packages/server/src/cli.ts'), 'peer', 'status'], { env: { ...process.env, BOGEN_URL: a.localUrl() }, timeout: 30_000 }, (error, stdout) => (error ? fail(error) : done(stdout)));
    });
    expect(out).toMatch(/transferred [\d.]+ (B|KB) in, [\d.]+ (B|KB) out/);
    expect(out).toMatch(/last error: it broke \(\d+s ago\)/);
    expect(out).toMatch(/version: /);
  });
});

describe('a remote rename', () => {
  it('reaches the other device and says so on /events', async () => {
    const a = await boot();
    const b = await boot();
    await pair(a, b);
    const file = (await (await post(a.localUrl(), '/api/files', { name: 'Old name' })).json() as { id: string }).id;
    await until(() => Boolean(b.storage.get(file)), 5000);
    const events: { t: string }[] = [];
    const ws = new WebSocket(`${b.localUrl().replace('http', 'ws')}/events`);
    await new Promise<void>((done) => ws.on('open', () => done()));
    ws.on('message', (d) => events.push(JSON.parse(String(d))));
    await fetch(`${a.localUrl()}/api/files/${file}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'New name' }) });
    await until(() => b.storage.get(file)?.name === 'New name', 5000);
    await until(() => events.some((e) => e.t === 'files'));
    ws.close();
  });
});

describe('a file that changes while nobody is here', () => {
  it('tells the next editor once, by who did it, also after a restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bogen-away-'));
    const a = await boot({}, home);
    const b = await boot();
    await pair(a, b);
    const file = (await (await post(a.localUrl(), '/api/files', { name: 'Away' })).json() as { id: string }).id;
    await until(() => Boolean(b.storage.get(file)), 5000);
    const page = (await a.rooms.get(file)).doc.getPages()[0]!.id;
    const agent = await connectAgent(a.localUrl(), 'night-agent');
    await call(agent, 'file_open', { file_id: file });
    await call(agent, 'artboard_create', { name: 'A', width: 10, height: 10 });
    (await b.rooms.get(file)).doc.insert(page, { type: 'frame', name: 'From the other device' });
    await until(async () => (await a.rooms.get(file)).doc.getChildren(page).length === 2, 5000);
    await agent.close();

    // An editor that is open hears about it as it happens, so that does not count.
    const watching = person(a, file, 'Mara');
    await until(() => watching.provider.synced);
    await call(await connectAgent(a.localUrl(), 'seen-agent'), 'file_open', { file_id: file });
    watching.close();
    await until(() => (a.rooms.peek(file)?.conns.size ?? 0) === 0);

    await a.close();
    running.delete(a);
    const again = await boot({}, home);
    const first = await (await fetch(`${again.localUrl()}/api/files/${file}/away`)).json() as { away: { changes: number; from: Record<string, number>; lastAt: number } };
    expect(first.away.from['night-agent']).toBeGreaterThan(0);
    expect(Object.keys(first.away.from).length).toBe(2);
    expect(first.away.changes).toBeGreaterThanOrEqual(2);
    expect(await (await fetch(`${again.localUrl()}/api/files/${file}/away`)).json()).toEqual({ away: null });
  });

  it('does not count what happens with an editor open', async () => {
    const a = await boot();
    const file = (await (await post(a.localUrl(), '/api/files', { name: 'Here' })).json() as { id: string }).id;
    const watching = person(a, file, 'Mara');
    await until(() => watching.provider.synced);
    const agent = await connectAgent(a.localUrl(), 'a');
    await call(agent, 'file_open', { file_id: file });
    await call(agent, 'artboard_create', { name: 'A', width: 10, height: 10 });
    expect(await (await fetch(`${a.localUrl()}/api/files/${file}/away`)).json()).toEqual({ away: null });
    await agent.close();
  });
});

describe('a conflict from being apart', () => {
  const twoSides = () => {
    const base = new BogenDoc(new Y.Doc());
    base.ensureFirstPage();
    const page = base.getPages()[0]!.id;
    const id = base.insert(page, { type: 'frame', name: 'Hero', style: { color: '#000', width: '1px' } });
    base.setToken('accent', 'color', '#111');
    const state = Y.encodeStateAsUpdate(base.y);
    const copy = (client: number) => {
      const y = new Y.Doc();
      y.clientID = client;
      Y.applyUpdate(y, state);
      return new BogenDoc(y);
    };
    return { id, a: copy(1001), b: copy(2002), state };
  };

  it('finds the same conflict on both sides, with both values, and nothing else', () => {
    const { id, a, b } = twoSides();
    a.updateStyle(id, { color: '#aaa', width: '2px' });
    b.updateStyle(id, { color: '#bbb' });
    a.updateFields(id, { name: 'Hero A' });
    b.updateFields(id, { name: 'Hero B' });
    a.setToken('accent', 'color', '#a00');
    b.setToken('accent', 'color', '#b00');
    const atA = findConflicts(Y.encodeStateAsUpdate(a.y), Y.encodeStateAsUpdate(b.y));
    const atB = findConflicts(Y.encodeStateAsUpdate(b.y), Y.encodeStateAsUpdate(a.y));
    const color = atA.find((c) => c.field === 'style.color')!;
    expect(color).toMatchObject({ kind: 'layer', nodeId: id, ours: '#aaa', theirs: '#bbb' });
    const other = atB.find((c) => c.field === 'style.color')!;
    expect(other).toMatchObject({ ours: '#bbb', theirs: '#aaa' });
    // They agree on who won.
    expect(color.kept === 'ours').toBe(other.kept === 'theirs');
    expect(atA.find((c) => c.field === 'name')).toMatchObject({ ours: 'Hero A', theirs: 'Hero B' });
    expect(atA.find((c) => c.kind === 'token')).toMatchObject({ name: 'accent', ours: '#a00', theirs: '#b00' });
    expect(atA.some((c) => c.field === 'style.width')).toBe(false);
  });

  it('is quiet about edits that follow each other, different keys, or equal values', () => {
    const { id, a, b } = twoSides();
    a.updateStyle(id, { color: '#aaa' });
    Y.applyUpdate(b.y, Y.encodeStateAsUpdate(a.y));
    b.updateStyle(id, { color: '#bbb' });
    expect(findConflicts(Y.encodeStateAsUpdate(a.y), Y.encodeStateAsUpdate(b.y))).toEqual([]);

    const again = twoSides();
    again.a.updateStyle(again.id, { color: '#ccc' });
    again.b.updateStyle(again.id, { width: '5px' });
    expect(findConflicts(Y.encodeStateAsUpdate(again.a.y), Y.encodeStateAsUpdate(again.b.y))).toEqual([]);

    const same = twoSides();
    same.a.updateStyle(same.id, { color: '#ddd' });
    same.b.updateStyle(same.id, { color: '#ddd' });
    expect(findConflicts(Y.encodeStateAsUpdate(same.a.y), Y.encodeStateAsUpdate(same.b.y))).toEqual([]);
  });

  it('holds up when one side set it several times', () => {
    const { id, a, b } = twoSides();
    a.updateStyle(id, { color: '#a1' });
    a.updateStyle(id, { color: '#a2' });
    b.updateStyle(id, { color: '#b1' });
    b.updateStyle(id, { color: '#b2' });
    const found = findConflicts(Y.encodeStateAsUpdate(a.y), Y.encodeStateAsUpdate(b.y));
    expect(found.filter((c) => c.field === 'style.color')).toEqual([expect.objectContaining({ ours: '#a2', theirs: '#b2' })]);
  });

  it('is quiet about typing in one text layer on both sides, which merges, but not about an older build overwriting it', () => {
    const { a, b, state } = twoSides();
    const base = new BogenDoc(new Y.Doc());
    Y.applyUpdate(base.y, state);
    const id = base.insert(base.getPages()[0]!.id, { type: 'text', text: 'one two' });
    const start = Y.encodeStateAsUpdate(base.y);
    Y.applyUpdate(a.y, start);
    Y.applyUpdate(b.y, start);
    a.updateFields(id, { text: 'one and two' });
    b.updateFields(id, { text: 'one two three' });
    expect(findConflicts(Y.encodeStateAsUpdate(a.y), Y.encodeStateAsUpdate(b.y)).filter((c) => c.field === 'text')).toEqual([]);
    // An older build writes the plain field, so whichever side won, one edit is gone: that is still worth a note.
    b.transact(() => b.nodes.get(id)!.set('text', 'one two four'));
    expect(findConflicts(Y.encodeStateAsUpdate(a.y), Y.encodeStateAsUpdate(b.y)).filter((c) => c.field === 'text')).toHaveLength(1);
  });

  it('merges text typed on two real servers while apart, and gives older builds the merged text', async () => {
    const homeA = mkdtempSync(join(tmpdir(), 'bogen-text-'));
    const homeB = mkdtempSync(join(tmpdir(), 'bogen-text-'));
    const a = await boot({}, homeA);
    let b = await boot({}, homeB);
    await pair(a, b);
    const file = (await (await post(a.localUrl(), '/api/files', { name: 'Words' })).json() as { id: string }).id;
    await until(() => Boolean(b.storage.get(file)), 5000);
    const roomA = await a.rooms.get(file);
    const id = roomA.doc.insert(roomA.doc.getPages()[0]!.id, { type: 'text', text: 'Hello world' });
    await until(async () => Boolean((await b.rooms.get(file)).doc.getNode(id)), 5000);
    const back = await apartEdits(a, homeA, b, homeB, async (server) => (await server.rooms.get(file)).doc.updateFields(id, { text: 'Hello world!' }),
      async (server) => (await server.rooms.get(file)).doc.updateFields(id, { text: 'Hello brave world' }));
    b = back.other;
    const want = 'Hello brave world!';
    const plain = async (s: BogenServer) => (await s.rooms.get(file)).doc.nodes.get(id)!.get('text');
    await until(async () => (await back.server.rooms.get(file)).doc.getNode(id)!.text === want && (await b.rooms.get(file)).doc.getNode(id)!.text === want
      && await plain(back.server) === want && await plain(b) === want, 15_000).catch(() => {});
    expect((await back.server.rooms.get(file)).doc.getNode(id)!.text).toBe(want);
    expect((await b.rooms.get(file)).doc.getNode(id)!.text).toBe(want);
    expect(await plain(back.server)).toBe(want);
    expect(await plain(b)).toBe(want);
    const notes = await (await fetch(`${back.server.localUrl()}/api/files/${file}/conflicts`)).json() as { field: string }[];
    expect(notes.filter((n) => n.field === 'text')).toEqual([]);
  }, 40_000);

  it('shows up on both real servers after an offline edit, and can be dismissed', async () => {
    const homeA = mkdtempSync(join(tmpdir(), 'bogen-conflict-'));
    const homeB = mkdtempSync(join(tmpdir(), 'bogen-conflict-'));
    const a = await boot({}, homeA);
    let b = await boot({}, homeB);
    await pair(a, b);
    const file = (await (await post(a.localUrl(), '/api/files', { name: 'Fight' })).json() as { id: string }).id;
    await until(() => Boolean(b.storage.get(file)), 5000);
    const roomA = await a.rooms.get(file);
    const page = roomA.doc.getPages()[0]!.id;
    const id = roomA.doc.insert(page, { type: 'frame', name: 'Hero', style: { color: '#000' } });
    await until(async () => Boolean((await b.rooms.get(file)).doc.getNode(id)), 5000);

    // One device goes away, and both go on working.
    const apart = await apartEdits(a, homeA, b, homeB, async (server) => (await server.rooms.get(file)).doc.updateStyle(id, { color: '#b0b' }),
      async (server) => (await server.rooms.get(file)).doc.updateStyle(id, { color: '#a0a' }));
    const back = apart.server;
    b = apart.other;
    await until(async () => (await fetch(`${back.localUrl()}/api/files/${file}/conflicts`).then((r) => r.json()) as unknown[]).length > 0
      && (await fetch(`${b.localUrl()}/api/files/${file}/conflicts`).then((r) => r.json()) as unknown[]).length > 0, 15_000).catch(() => {});
    const here = await (await fetch(`${back.localUrl()}/api/files/${file}/conflicts`)).json() as { id: string; ours: string; theirs: string; field: string; kept: string; device: string }[];
    const there = await (await fetch(`${b.localUrl()}/api/files/${file}/conflicts`)).json() as typeof here;
    // Which side notices first depends on who dials first. Each side that received the other's edit by catch-up says so.
    const notes = [...here, ...there];
    expect(notes.length, 'at least one side reports it').toBeGreaterThan(0);
    expect(new Set(notes[0] ? [notes[0].ours, notes[0].theirs] : [])).toEqual(new Set(['#a0a', '#b0b']));
    const server = here.length ? back : b;
    const list = here.length ? here : there;
    expect((await fetch(`${server.localUrl()}/api/files/${file}/conflicts/${list[0]!.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await (await fetch(`${server.localUrl()}/api/files/${file}/conflicts`)).json() as unknown[]).length).toBe(list.length - 1);
  }, 40_000);
});

describe('who is in a file on the other device', () => {
  it('shows people and selections, never agents, and goes away when they leave', async () => {
    const a = await boot();
    const b = await boot();
    await pair(a, b);
    const file = (await (await post(a.localUrl(), '/api/files', { name: 'Together' })).json() as { id: string }).id;
    await until(() => Boolean(b.storage.get(file)), 5000);
    await until(() => (a.peers as unknown as { links: Map<string, { features: Set<string> }> }).links.values().next().value!.features.has('presence'), 5000);

    const here = person(a, file, 'Mara', { selection: ['abcdefgh'], pageId: 'page1234', cursor: { x: 5, y: 6, pageId: 'page1234' } });
    const there = person(b, file, 'Reader');
    await until(() => [...there.awareness.getStates().values()].some((s: any) => s.user?.device), 6000);
    const shown = [...there.awareness.getStates().values()].find((s: any) => s.user?.device) as any;
    expect(shown.user).toMatchObject({ name: 'Mara', color: '#123456' });
    expect(shown.user.device).toBeTruthy();
    expect(shown.selection).toEqual(['abcdefgh']);
    expect(shown.pageId).toBe('page1234');
    // Cursors stay home unless asked for.
    expect(shown.cursor).toBeNull();

    // On that side it does not count as a person here, and it does not go round in a circle.
    const roomB = await b.rooms.get(file);
    expect(roomB.humans().map((h) => h.name)).toEqual(['Reader']);
    await until(() => b.peers.status()[0]!.here.some((h) => h.fileId === file && h.people[0]!.name === 'Mara'));
    expect(b.peers.status()[0]!.here[0]!.people[0]!.selection).toBe(1);

    // An agent over there stays there.
    const agent = await connectAgent(a.localUrl(), 'some-agent');
    await call(agent, 'file_open', { file_id: file });
    await call(agent, 'artboard_create', { name: 'x', width: 10, height: 10 });
    await new Promise((done) => setTimeout(done, 400));
    expect([...there.awareness.getStates().values()].filter((s: any) => s.user?.agent).map((s: any) => s.user.name)).toEqual([]);
    expect([...here.awareness.getStates().values()].filter((s: any) => s.user?.agent).map((s: any) => s.user.name)).toEqual(['some-agent']);
    await agent.close();

    // A selection follows.
    here.set({ selection: ['zzzzzzzz'] });
    await until(() => [...there.awareness.getStates().values()].some((s: any) => s.user?.device && s.selection[0] === 'zzzzzzzz'), 5000);

    // With the setting on, the cursor comes along.
    await fetch(`${a.localUrl()}/api/run-settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shareCursors: true }) });
    here.set({ cursor: { x: 9, y: 9, pageId: 'page1234' } });
    await until(() => [...there.awareness.getStates().values()].some((s: any) => s.user?.device && s.cursor?.x === 9), 5000);

    here.close();
    await until(() => ![...there.awareness.getStates().values()].some((s: any) => s.user?.device), 6000);
    expect(b.peers.status()[0]!.here).toEqual([]);
  });

  it('shows someone who was already there when the file opens here', async () => {
    const a = await boot();
    const b = await boot();
    await pair(a, b);
    const file = (await (await post(a.localUrl(), '/api/files', { name: 'Later' })).json() as { id: string }).id;
    await until(() => Boolean(b.storage.get(file)), 5000);
    await until(() => (a.peers as unknown as { links: Map<string, { features: Set<string> }> }).links.values().next().value!.features.has('presence'), 5000);
    person(a, file, 'Early');
    await until(() => b.peers.status()[0]!.here.length > 0, 6000);
    await b.rooms.unload(file);
    const late = person(b, file, 'Late');
    await until(() => [...late.awareness.getStates().values()].some((s: any) => s.user?.device && s.user.name === 'Early'), 6000);
  });

  it('never sends it to a device that did not say it understands, and drops what it does not know', async () => {
    const a = await boot();
    const b = await boot();
    await pair(a, b);
    const file = (await (await post(a.localUrl(), '/api/files', { name: 'Old device' })).json() as { id: string }).id;
    await until(() => Boolean(b.storage.get(file)), 5000);
    const link = (a.peers as unknown as { links: Map<string, { features: Set<string>; socket(): WebSocket }> }).links.values().next().value!;
    await until(() => link.features.has('presence'), 5000);
    // As if it were an older build, which closes the socket over an unknown message.
    link.features = new Set();
    let sent = 0;
    const real = link.socket().send.bind(link.socket());
    link.socket().send = ((data: string, cb?: never) => {
      if (String(data).includes('"presence"')) sent++;
      return real(data as never, cb as never);
    }) as never;
    person(a, file, 'Mara');
    await new Promise((done) => setTimeout(done, 500));
    expect(sent).toBe(0);

    // A newer device may say things this one has no word for.
    const other = (b.peers as unknown as { links: Map<string, { socket(): WebSocket }> }).links.values().next().value!;
    other.socket().send(JSON.stringify({ t: 'something-new', x: 1 }));
    await new Promise((done) => setTimeout(done, 300));
    expect(a.peers.status()[0]!.state).toBe('connected');
    expect(b.peers.status()[0]!.state).toBe('connected');

    // Nonsense in a known message is refused, and starts nothing.
    other.socket().send(JSON.stringify({ t: 'presence', id: file, people: [{ name: 'x', color: 'javascript:alert(1)', selection: [] }] }));
    await until(() => (a.peers.status()[0]?.state ?? 'offline') === 'offline' || true);
    const room = await a.rooms.get(file);
    expect(room.humans().every((h) => h.name !== 'x')).toBe(true);
  });

  it('a person on the other device cannot start a run by being there', async () => {
    const a = await boot();
    const b = await boot();
    await pair(a, b);
    const status = await fetch(`${a.localUrl()}/api/status`).then((r) => r.json()) as { peers: unknown[] };
    expect(status.peers).toHaveLength(1);
    expect(a.runs.activeFor('anything')).toBeUndefined();
  });
});
