import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { BogenDoc, Y } from '@bogen/core';
import { BogenServer, type ServerOptions } from '../src/http/server.ts';
import { assertWellFormed } from '../src/bogen-file.ts';
import { beyond, rescueStranded } from '../src/peers.ts';
import { parseMacFonts } from '../src/fonts.ts';
import { platformTheme } from '../src/platform.ts';
import { isTailnetAddress, normalizePeerUrl, tailscaleCommands, tailscaleIp } from '../src/tailnet.ts';
import { call, connectAgent, until } from './helpers.ts';

const homes: string[] = [];
const running = new Set<BogenServer>();
const clients: (() => void)[] = [];

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'bogen-peers-'));
  homes.push(home);
  return home;
}

/** A real server. `insecureAllowAnyHost` is the explicit test permission that lets loopback peers pair. */
async function boot(options: Partial<ServerOptions> = {}, home = newHome(), port = 0): Promise<BogenServer> {
  const server = new BogenServer({ home, port, insecureAllowAnyHost: true, peerCatchUpMs: 60_000, exportDir: join(home, 'exports'), ...options });
  await server.listen();
  running.add(server);
  return server;
}

async function stop(server: BogenServer): Promise<void> {
  running.delete(server);
  await server.close();
}

const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function pairInfo(server: BogenServer): Promise<{ url: string; token: string; name: string; command: string }> {
  const res = await post(server.localUrl(), '/api/peers/pair', { insecure: true });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ url: string; token: string; name: string; command: string }>;
}

/** The real pairing flow, driven from b: `bogen peer add` calls this same route. */
async function pair(a: BogenServer, b: BogenServer): Promise<void> {
  const info = await pairInfo(a);
  const res = await post(b.localUrl(), '/api/peers', { url: info.url, token: info.token, insecure: true });
  expect(res.status).toBe(201);
  await until(() => connected(a, b) && connected(b, a), 6000);
}

const connected = (a: BogenServer, b: BogenServer) => a.peers.status().some((p) => p.id === b.peers.deviceId && p.state === 'connected');

const createFile = async (server: BogenServer, name: string): Promise<string> => {
  const res = await post(server.localUrl(), '/api/files', { name });
  return ((await res.json()) as { id: string }).id;
};

function liveClient(server: BogenServer, fileId: string) {
  const y = new Y.Doc();
  const provider = new WebsocketProvider(`${server.localUrl().replace('http', 'ws')}/sync`, fileId, y, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  const doc = new BogenDoc(y);
  const close = () => {
    provider.destroy();
    y.destroy();
  };
  clients.push(close);
  return { y, doc, provider, close, synced: () => until(() => provider.synced, 4000) };
}

async function roomOf(server: BogenServer, id: string) {
  return server.rooms.get(id);
}

/** Adds a layer named `name` on a server, as an agent would. */
async function draw(server: BogenServer, id: string, name: string, origin = 'agent:test'): Promise<string> {
  const room = await roomOf(server, id);
  const page = room.doc.getPages()[0]!.id;
  return room.doc.insert(page, { type: 'frame', name, style: { position: 'absolute', left: '0px', top: '0px', width: '10px', height: '10px' } }, undefined, origin);
}

async function layerNames(server: BogenServer, id: string): Promise<string[]> {
  const room = await roomOf(server, id);
  return room.doc.getPages().flatMap((p) => room.doc.getChildren(p.id)).map((n) => n.name).sort();
}

function hasFile(server: BogenServer, id: string): boolean {
  return Boolean(server.storage.get(id));
}

afterEach(async () => {
  for (const close of clients.splice(0)) close();
  for (const server of [...running]) await stop(server);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('peer addresses', () => {
  it('accepts tailnet addresses and refuses everything else', () => {
    for (const ok of ['http://100.64.0.1:29990', 'http://100.127.255.254', 'http://[fd7a:115c:a1e0::1]:29990', 'https://mac.tail1234.ts.net', 'http://mac.tail1234.ts.net:29990/']) {
      expect(() => normalizePeerUrl(ok)).not.toThrow();
    }
    for (const bad of [
      'http://127.0.0.1:29990', 'http://localhost:29990', 'http://192.168.1.2', 'http://100.63.255.255', 'http://100.128.0.0', 'http://[fd7a:115c:a1e1::1]',
      'http://[::1]', 'http://evil.com', 'http://ts.net', 'http://100.64.0.1.evil.com', 'http://mac.ts.net.evil.com', 'http://evilts.net',
      'ftp://100.64.0.1', 'http://user:pw@100.64.0.1', 'http://100.64.0.1/path', 'http://100.64.0.1/?a=1', 'not a url',
    ]) {
      expect(() => normalizePeerUrl(bad), bad).toThrow();
    }
    expect(() => normalizePeerUrl('http://127.0.0.1:1', true)).not.toThrow();
    expect(normalizePeerUrl('http://mac.tail1234.ts.net:29990/')).toBe('http://mac.tail1234.ts.net:29990');
  });

  it('finds the Tailscale CLI inside the Mac app, and only trusts a real tailnet address', async () => {
    expect(tailscaleCommands('darwin', '/Users/x')).toContain('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    expect(tailscaleCommands('darwin', '/Users/x')).toContain('tailscale');
    expect(tailscaleCommands('linux')).not.toContain('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    const tried: string[] = [];
    const exec = async (command: string) => {
      tried.push(command);
      if (command === 'tailscale') throw new Error('ENOENT');
      return '100.100.1.2\n';
    };
    expect(await tailscaleIp(['tailscale', '/app/Tailscale'], exec)).toBe('100.100.1.2');
    expect(tried).toEqual(['tailscale', '/app/Tailscale']);
    expect(await tailscaleIp(['x'], async () => '192.168.1.1\n')).toBeNull();
    expect(await tailscaleIp(['x'], async () => '0.0.0.0\n')).toBeNull();
    expect(await tailscaleIp(['x'], async () => { throw new Error('logged out'); })).toBeNull();
    expect(isTailnetAddress('100.64.0.10')).toBe(true);
    expect(isTailnetAddress('8.8.8.8')).toBe(false);
  });

  it('has a default for a Mac where Linux reads the Omarchy theme, and parses Mac fonts', () => {
    expect(platformTheme('linux')).toBeNull();
    expect(platformTheme('darwin')?.vars['--ui-accent']).toBeTruthy();
    expect(parseMacFonts(JSON.stringify({ SPFontsDataType: [{ typefaces: [{ family: 'Helvetica' }, { family: '.Hidden' }] }, { typefaces: [{ family: 'Avenir' }] }] }))).toEqual(['Avenir', 'Helvetica']);
    expect(parseMacFonts('nonsense')).toEqual([]);
  });
});

describe('device config', () => {
  it('creates an identity in a private config.json and keeps what was there', async () => {
    const home = newHome();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ openaiApiKey: 'keep-me' }), { mode: 0o644 });
    const a = await boot({}, home);
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(config.openaiApiKey).toBe('keep-me');
    expect(config.deviceId).toBeTruthy();
    expect(config.deviceName).toBeTruthy();
    expect(config.peerToken.length).toBeGreaterThan(30);
    expect(config.peers).toEqual([]);
    expect(statSync(join(home, 'config.json')).mode & 0o777).toBe(0o600);
    const { deviceId } = a.peers;
    await stop(a);
    const again = await boot({}, home);
    expect(again.peers.deviceId).toBe(deviceId);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).peerToken).toBe(config.peerToken);
  });

  it('moves a broken config.json aside instead of writing over it', async () => {
    const home = newHome();
    writeFileSync(join(home, 'config.json'), '{ "openaiApiKey": "sk-', { mode: 0o600 });
    await boot({}, home);
    const { readdirSync } = await import('node:fs');
    const aside = readdirSync(home).find((f) => f.startsWith('config.json.corrupt-'))!;
    expect(readFileSync(join(home, aside), 'utf8')).toContain('sk-');
  });

  it('never reports tokens in status, and survives a restart paired', async () => {
    const homeA = newHome();
    const a = await boot({}, homeA);
    const b = await boot();
    await pair(a, b);
    const info = await pairInfo(a);
    const status = await (await fetch(`${a.localUrl()}/api/status`)).text();
    expect(status).not.toContain(info.token);
    const peers = await (await fetch(`${a.localUrl()}/api/peers`)).text();
    expect(peers).not.toContain(info.token);
    expect(JSON.parse(status).peers[0]).toMatchObject({ id: b.peers.deviceId, state: 'connected' });
    expect(statSync(join(homeA, 'config.json')).mode & 0o777).toBe(0o600);
  });
});

describe('document sync', () => {
  it('carries an edit to a real y-websocket client on the other server right away', async () => {
    const [a, b] = [await boot(), await boot()];
    await pair(a, b);
    const id = await createFile(a, 'Live');
    await until(() => hasFile(b, id), 5000);
    const editor = liveClient(b, id);
    await editor.synced();
    expect(editor.doc.getPages()).toHaveLength(1);
    const started = Date.now();
    await draw(a, id, 'from-a');
    await until(() => [...editor.doc.nodes.keys()].some((k) => editor.doc.getNode(k)?.name === 'from-a'));
    expect(Date.now() - started).toBeLessThan(1000);

    // And back, from an editor on b to an editor on a.
    const other = liveClient(a, id);
    await other.synced();
    editor.doc.insert(editor.doc.getPages()[0]!.id, { type: 'frame', name: 'from-editor-b' }, undefined, 'local');
    await until(() => [...other.doc.nodes.keys()].some((k) => other.doc.getNode(k)?.name === 'from-editor-b'));
  });

  it('gives a new file exactly one first page on both sides', async () => {
    const [a, b] = [await boot(), await boot()];
    await pair(a, b);
    const id = await createFile(a, 'Pages');
    await until(() => hasFile(b, id), 5000);
    const roomB = await roomOf(b, id);
    const roomA = await roomOf(a, id);
    await until(() => roomA.doc.pages.size === roomB.doc.pages.size);
    expect(roomB.doc.getPages().map((p) => p.id)).toEqual(roomA.doc.getPages().map((p) => p.id));
    expect(roomB.doc.getPages()).toHaveLength(1);
  });

  it('merges edits made on both sides while they were apart', async () => {
    const homeB = newHome();
    const a = await boot();
    let b = await boot({}, homeB);
    await pair(a, b);
    const id = await createFile(a, 'Offline');
    await until(() => hasFile(b, id), 5000);
    await draw(a, id, 'before');
    await until(async () => (await layerNames(b, id)).includes('before'));

    const port = b.port;
    await stop(b);
    await until(() => !a.peers.status()[0]!.state.startsWith('connected'));
    for (let i = 0; i < 5; i++) await draw(a, id, `a-${i}`);
    expect(a.peers.status()[0]!.pending).toBeGreaterThan(0);

    // b edits offline too: started with no way to reach a.
    const aDown = a.port;
    b = await boot({}, homeB, port);
    await a.peers.close(); // a stops talking, but stays up for reading afterwards.
    await until(() => !b.peers.status()[0]!.state.startsWith('connected'), 8000);
    for (let i = 0; i < 5; i++) await draw(b, id, `b-${i}`);
    await stop(a);
    await stop(b);

    // Both come back.
    const a2 = await boot({}, a.options.home, aDown);
    const b2 = await boot({}, homeB, port);
    const expected = ['before', 'a-0', 'a-1', 'a-2', 'a-3', 'a-4', 'b-0', 'b-1', 'b-2', 'b-3', 'b-4'].sort();
    await until(async () => JSON.stringify(await layerNames(a2, id)) === JSON.stringify(expected), 12_000);
    await until(async () => JSON.stringify(await layerNames(b2, id)) === JSON.stringify(expected), 12_000);
    await until(() => a2.peers.status()[0]!.pending === 0 && b2.peers.status()[0]!.pending === 0, 8000);
    expect(a2.peers.status()[0]!.lastSyncAt).toBeTruthy();
  }, 40_000);

  it('keeps a chain of three in step', async () => {
    const [a, b, c] = [await boot(), await boot(), await boot()];
    await pair(a, b);
    await pair(b, c);
    const id = await createFile(a, 'Chain');
    await until(() => hasFile(c, id), 6000);
    await draw(a, id, 'from-a');
    await until(async () => (await layerNames(c, id)).includes('from-a'));
    await draw(c, id, 'from-c');
    await until(async () => (await layerNames(a, id)).includes('from-c'));
    a.renameFile(id, 'Chain renamed');
    await until(() => c.storage.get(id)?.name === 'Chain renamed', 6000);
  });

  it('does not echo: one edit is one message, and nothing comes back', async () => {
    const [a, b] = [await boot(), await boot()];
    await pair(a, b);
    const id = await createFile(a, 'Echo');
    await until(() => hasFile(b, id), 5000);
    await draw(a, id, 'settle');
    await until(async () => (await layerNames(b, id)).includes('settle'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const sentA = a.peers.stats.updatesSent;
    const sentB = b.peers.stats.updatesSent;
    const receivedB = b.peers.stats.updatesReceived;
    const hintsA = a.peers.stats.hintsSent;
    const hintsB = b.peers.stats.hintsSent;
    for (let i = 0; i < 20; i++) await draw(a, id, `n-${i}`);
    await until(async () => (await layerNames(b, id)).includes('n-19'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(a.peers.stats.updatesSent - sentA).toBe(20);
    expect(b.peers.stats.updatesReceived - receivedB).toBe(20);
    expect(b.peers.stats.updatesSent - sentB).toBe(0);
    expect(a.peers.stats.hintsSent - hintsA).toBe(0);
    expect(b.peers.stats.hintsSent - hintsB).toBe(0);
  });

  it('undo after a peer update only takes back the local edit', async () => {
    const [a, b] = [await boot(), await boot()];
    await pair(a, b);
    const id = await createFile(a, 'Undo');
    await until(() => hasFile(b, id), 5000);

    // The per-agent undo on the server.
    const agent = await connectAgent(a.localUrl(), 'painter');
    const room = await roomOf(a, id);
    room.undoManagerFor('painter');
    await draw(a, id, 'agent-layer', 'agent:painter');
    await until(async () => (await layerNames(b, id)).includes('agent-layer'));
    await draw(b, id, 'peer-layer', 'agent:other');
    await until(async () => (await layerNames(a, id)).includes('peer-layer'));
    expect(room.undoAgent('painter')).toBe(true);
    expect(await layerNames(a, id)).toEqual(['peer-layer']);
    await until(async () => (await layerNames(b, id)).join() === 'peer-layer');
    // Only the peer's layer is left, and it is not this agent's to undo.
    expect(room.undoAgent('painter')).toBe(false);
    expect(await layerNames(a, id)).toEqual(['peer-layer']);
    await agent.close();

    // The per-user undo in an editor, tracked the way apps/editor does it.
    const editor = liveClient(a, id);
    await editor.synced();
    const undo = new Y.UndoManager([editor.doc.nodes, editor.doc.pages, editor.doc.tokens], { trackedOrigins: new Set(['bogen-editor']), captureTimeout: 0 });
    editor.doc.insert(editor.doc.getPages()[0]!.id, { type: 'frame', name: 'mine' }, undefined, 'bogen-editor');
    await until(async () => (await layerNames(b, id)).includes('mine'));
    await draw(b, id, 'theirs');
    await until(() => [...editor.doc.nodes.keys()].some((k) => editor.doc.getNode(k)?.name === 'theirs'));
    undo.undo();
    const names = () => [...editor.doc.nodes.keys()].map((k) => editor.doc.getNode(k)?.name).sort();
    expect(names()).toEqual(['peer-layer', 'theirs']);
    expect(undo.canUndo()).toBe(false);
    await until(async () => (await layerNames(b, id)).join() === 'peer-layer,theirs');
    undo.destroy();
  });

  it('brings back layers drawn into a frame the other side deleted', async () => {
    const homeB = newHome();
    const a = await boot();
    let b = await boot({}, homeB);
    await pair(a, b);
    const id = await createFile(a, 'Stranded');
    await until(() => hasFile(b, id), 5000);
    const frame = await draw(a, id, 'frame');
    await until(async () => (await layerNames(b, id)).includes('frame'));
    const port = b.port;
    await until(() => existsSync(join(homeB, 'files', `${id}.ydoc`)));
    await stop(b);
    (await roomOf(a, id)).doc.delete([frame], 'agent:x');
    // b, offline, draws into that frame. Its saved doc still has it; a has it deleted.
    const roomBefore = new BogenDoc(new Y.Doc());
    const saved = readFileSync(join(homeB, 'files', `${id}.ydoc`));
    Y.applyUpdate(roomBefore.y, saved);
    const child = roomBefore.insert(frame, { type: 'text', name: 'offline-child', text: 'hello' }, undefined, 'x');
    writeFileSync(join(homeB, 'files', `${id}.ydoc`), Y.encodeStateAsUpdate(roomBefore.y));
    b = await boot({}, homeB, port);
    await until(async () => (await roomOf(a, id)).doc.pageOf(child) !== undefined, 8000);
    await until(async () => (await roomOf(b, id)).doc.pageOf(child) !== undefined, 8000);
    expect((await roomOf(a, id)).doc.getNode(child)?.style.position).toBe('absolute');
  });

  it('an artboard moved to another page arrives there on the other device with its id, and an open editor follows', async () => {
    const [a, b] = [await boot(), await boot()];
    await pair(a, b);
    const id = await createFile(a, 'Pages');
    await until(() => hasFile(b, id), 5000);
    const agent = await connectAgent(a.localUrl(), 'mover');
    const board = (await call(agent, 'artboard_create', { file_id: id, name: 'Board', width: 320 })).id;
    const text = (await call(agent, 'html_write', { file_id: id, target_id: board, html: '<p>Kept</p>' })).ids[0];
    const first = (await roomOf(a, id)).doc.pageOf(board)!;
    const to = (await call(agent, 'page_create', { file_id: id, name: 'Second' })).id;
    const editor = liveClient(b, id);
    await editor.synced();
    await until(() => editor.doc.getNode(text)?.text === 'Kept' && editor.doc.pages.has(to));

    await call(agent, 'layer_move', { file_id: id, node_ids: [board], page_id: to });
    const roomB = await roomOf(b, id);
    await until(() => roomB.doc.pageOf(board) === to && editor.doc.pageOf(board) === to);
    for (const doc of [roomB.doc, editor.doc]) {
      expect(doc.getChildren(to).map((n) => n.id)).toEqual([board]);
      expect(doc.getChildren(first)).toEqual([]);
      expect(doc.getNode(text)).toMatchObject({ parent: board, text: 'Kept' });
    }
    // Undone on one side, it is back on the first page on the other.
    await call(agent, 'agent_undo', { file_id: id });
    await until(() => editor.doc.pageOf(board) === first && roomB.doc.pageOf(board) === first);
    await agent.close();
  });

  it('breaks a parent cycle made by two moves, and leaves a parent that is only late alone', () => {
    const one = new BogenDoc();
    one.ensureFirstPage();
    const page = one.getPages()[0]!.id;
    const x = one.insert(page, { type: 'frame', name: 'x' });
    const y = one.insert(page, { type: 'frame', name: 'y' });
    const two = new BogenDoc();
    Y.applyUpdate(two.y, Y.encodeStateAsUpdate(one.y));
    one.move([x], y);
    two.move([y], x);
    Y.applyUpdate(one.y, Y.encodeStateAsUpdate(two.y));
    Y.applyUpdate(two.y, Y.encodeStateAsUpdate(one.y));
    expect(one.pageOf(x)).toBeUndefined();
    expect(rescueStranded(one, 'test')).toHaveLength(1);
    expect(one.pageOf(x)).toBe(page);
    expect(one.pageOf(y)).toBe(page);

    const three = new BogenDoc();
    three.ensureFirstPage();
    three.insert(three.getPages()[0]!.id, { type: 'frame', name: 'kid' });
    three.nodes.forEach((m) => m.set('parent', 'not-arrived-yet'));
    expect(rescueStranded(three, 'test')).toEqual([]);
  });
});

describe('restarts', () => {
  it('catches up after either side restarts, and reconnects by itself', async () => {
    const homeA = newHome();
    const homeB = newHome();
    let a = await boot({}, homeA);
    let b = await boot({}, homeB);
    await pair(a, b);
    const id = await createFile(a, 'Restart');
    await until(() => hasFile(b, id), 5000);

    const portB = b.port;
    await stop(b);
    await draw(a, id, 'while-b-down');
    b = await boot({}, homeB, portB);
    await until(async () => hasFile(b, id) && (await layerNames(b, id)).includes('while-b-down'), 8000);
    await until(() => connected(a, b), 8000);

    const portA = a.port;
    await stop(a);
    await draw(b, id, 'while-a-down');
    a = await boot({}, homeA, portA);
    await until(async () => (await layerNames(a, id)).includes('while-a-down'), 8000);
    await until(() => connected(a, b) && connected(b, a), 8000);
    // Live again, without anyone asking.
    await draw(a, id, 'after');
    await until(async () => (await layerNames(b, id)).includes('after'));
  }, 30_000);
});

describe('a laptop going to sleep', () => {
  /** A TCP path that can freeze: sockets stay open and nothing moves, as when the far side sleeps. */
  function freezable(target: () => number) {
    const sockets = new Set<Socket>();
    let frozen = false;
    const server = createNetServer((inbound) => {
      if (frozen) return void inbound.destroy();
      const outbound = connect(target(), '127.0.0.1');
      for (const [from, to] of [[inbound, outbound], [outbound, inbound]] as const) {
        sockets.add(from);
        from.on('data', (data) => {
          if (!frozen) to.write(data);
        });
        from.on('error', () => to.destroy());
        from.on('close', () => {
          to.destroy();
          sockets.delete(from);
        });
      }
    });
    return {
      listen: () => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))),
      freeze: () => { frozen = true; },
      thaw: () => {
        frozen = false;
        // What a real sleep does to connections in the end.
        for (const s of sockets) s.destroy();
      },
      close: () => new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(resolve);
      }),
    };
  }

  it('notices a silent connection, keeps edits on both sides, and recovers without help', async () => {
    const options = { peerHeartbeatMs: 100 };
    const a = await boot(options);
    const b = await boot(options);
    const toA = freezable(() => a.port);
    const toB = freezable(() => b.port);
    const [portA, portB] = [await toA.listen(), await toB.listen()];
    const tokenA = (await pairInfo(a)).token;
    const tokenB = (await pairInfo(b)).token;
    // Paired through the freezable paths, so that every byte between them goes through those.
    const register = (on: BogenServer, token: string, other: BogenServer, url: string, otherToken: string) => fetch(`${on.localUrl()}/api/peer/register`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: other.peers.deviceId, name: other.peers.deviceName, url, token: otherToken }),
    });
    expect((await register(a, tokenA, b, `http://127.0.0.1:${portB}`, tokenB)).status).toBe(200);
    expect((await register(b, tokenB, a, `http://127.0.0.1:${portA}`, tokenA)).status).toBe(200);
    await until(() => connected(a, b) && connected(b, a), 6000);
    const id = await createFile(a, 'Sleepy');
    await draw(a, id, 'awake');
    await until(async () => hasFile(b, id) && (await layerNames(b, id)).includes('awake'), 6000);

    toA.freeze();
    toB.freeze();
    await draw(a, id, 'a-asleep');
    await draw(b, id, 'b-asleep');
    await until(() => !connected(a, b) && !connected(b, a), 3000);
    expect(await layerNames(b, id)).not.toContain('a-asleep');
    await draw(a, id, 'a-still-asleep');
    expect(a.peers.status()[0]!.pending).toBeGreaterThan(0);

    toA.thaw();
    toB.thaw();
    const all = ['a-asleep', 'a-still-asleep', 'awake', 'b-asleep'];
    await until(async () => (await layerNames(a, id)).join() === all.join(), 12_000);
    await until(async () => (await layerNames(b, id)).join() === all.join(), 12_000);
    await until(() => a.peers.status()[0]!.pending === 0, 4000);
    await stop(a);
    await stop(b);
    await toA.close();
    await toB.close();
  }, 30_000);
});

describe('file lifecycle', () => {
  it('replicates new files, duplicates, imports and renames, last rename winning', async () => {
    const [a, b] = [await boot(), await boot()];
    await pair(a, b);
    const id = await createFile(a, 'Original');
    await draw(a, id, 'content');
    await until(async () => hasFile(b, id) && (await layerNames(b, id)).includes('content'), 6000);
    const copy = (await (await fetch(`${a.localUrl()}/api/files/${id}/duplicate`, { method: 'POST' })).json()) as { id: string };
    await until(() => hasFile(b, copy.id), 6000);
    expect(await layerNames(b, copy.id)).toEqual(['content']);
    expect(b.storage.get(copy.id)?.name).toBe('Original copy');

    a.renameFile(id, 'From A');
    await until(() => b.storage.get(id)?.name === 'From A');
    b.renameFile(id, 'From B');
    await until(() => a.storage.get(id)?.name === 'From B');
    // A content edit does not count as a rename: a's later edit must not bring its old name back.
    await draw(a, id, 'edit');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(b.storage.get(id)?.name).toBe('From B');
    expect(a.storage.get(id)?.name).toBe('From B');
  });

  it('merges a rename made on each side while apart by time, and both sides agree', async () => {
    const homeB = newHome();
    const a = await boot();
    let b = await boot({}, homeB);
    await pair(a, b);
    const id = await createFile(a, 'Name');
    await until(() => hasFile(b, id), 5000);
    const port = b.port;
    await stop(b);
    a.renameFile(id, 'Older');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const index = JSON.parse(readFileSync(join(homeB, 'index.json'), 'utf8'));
    index.files.find((f: { id: string }) => f.id === id).name = 'Newer';
    index.files.find((f: { id: string }) => f.id === id).nameAt = Date.now();
    writeFileSync(join(homeB, 'index.json'), JSON.stringify(index));
    b = await boot({}, homeB, port);
    await until(() => a.storage.get(id)?.name === 'Newer', 8000);
    expect(b.storage.get(id)?.name).toBe('Newer');
  });

  it('replicates a delete, and the tombstone survives restarts of both sides', async () => {
    const homeA = newHome();
    const homeB = newHome();
    let a = await boot({}, homeA);
    let b = await boot({}, homeB);
    await pair(a, b);
    const id = await createFile(a, 'Doomed');
    await draw(a, id, 'content');
    await until(async () => hasFile(b, id) && (await layerNames(b, id)).includes('content'), 6000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await fetch(`${a.localUrl()}/api/files/${id}`, { method: 'DELETE' })).status).toBe(200);
    await until(() => !hasFile(b, id), 6000);
    expect(existsSync(join(homeB, 'files', `${id}.ydoc`))).toBe(false);

    const [portA, portB] = [a.port, b.port];
    await stop(a);
    await stop(b);
    a = await boot({}, homeA, portA);
    b = await boot({}, homeB, portB);
    await until(() => connected(a, b) && connected(b, a), 8000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(hasFile(a, id)).toBe(false);
    expect(hasFile(b, id)).toBe(false);

    // A third device that still holds the file gets the delete too, even though neither side remembers it live.
    const manifest = await fetch(`${a.localUrl()}/api/peer/manifest`, { headers: { Authorization: `Bearer ${(await pairInfo(a)).token}`, 'X-Bogen-Device': b.peers.deviceId } });
    const listed = ((await manifest.json()) as { files: { id: string; deleted?: boolean }[] }).files.find((f) => f.id === id);
    expect(listed?.deleted).toBe(true);
  }, 30_000);

  it('a crash between the tombstone and the index does not bring a file back', async () => {
    const home = newHome();
    let a = await boot({}, home);
    const b = await boot();
    await pair(a, b);
    const id = await createFile(a, 'Crash');
    await until(() => hasFile(b, id), 5000);
    const port = a.port;
    await stop(a);
    const stale = readFileSync(join(home, 'index.json'), 'utf8');
    a = await boot({}, home, port);
    await until(() => connected(a, b), 8000);
    await fetch(`${a.localUrl()}/api/files/${id}`, { method: 'DELETE' });
    await until(() => !hasFile(b, id), 6000);
    await stop(a);
    writeFileSync(join(home, 'index.json'), stale);
    expect(JSON.parse(stale).files.some((f: { id: string }) => f.id === id)).toBe(true);
    a = await boot({}, home, port);
    expect(hasFile(a, id)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hasFile(a, id)).toBe(false);
  }, 20_000);

  it('delete against a concurrent edit: the edit is kept and the file comes back on both sides', async () => {
    const homeA = newHome();
    const homeB = newHome();
    let a = await boot({}, homeA);
    let b = await boot({}, homeB);
    await pair(a, b);
    const id = await createFile(a, 'Contested');
    await draw(a, id, 'common');
    await until(async () => hasFile(b, id) && (await layerNames(b, id)).includes('common'), 6000);

    // Apart: a draws, then deletes. b edits.
    const [portA, portB] = [a.port, b.port];
    await stop(b);
    await draw(a, id, 'a-before-delete');
    await fetch(`${a.localUrl()}/api/files/${id}`, { method: 'DELETE' });
    expect(hasFile(a, id)).toBe(false);
    await stop(a);

    b = await boot({}, homeB, portB);
    await until(() => !connected(b, a));
    await draw(b, id, 'b-offline');
    await stop(b);

    a = await boot({}, homeA, portA);
    b = await boot({}, homeB, portB);
    // The file is back on a, with b's edit and what a drew before deleting. Nothing is lost on either side.
    const all = ['a-before-delete', 'b-offline', 'common'];
    await until(() => hasFile(a, id), 10_000);
    await until(async () => (await layerNames(a, id)).join() === all.join(), 10_000);
    await until(async () => (await layerNames(b, id)).join() === all.join(), 10_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hasFile(b, id)).toBe(true);
    expect(hasFile(a, id)).toBe(true);
  }, 30_000);

  it('a concurrent edit that only deletes a layer also counts', async () => {
    const homeB = newHome();
    let a = await boot();
    let b = await boot({}, homeB);
    await pair(a, b);
    const id = await createFile(a, 'Delete only');
    const one = await draw(a, id, 'one');
    await draw(a, id, 'two');
    await until(async () => hasFile(b, id) && (await layerNames(b, id)).includes('two'), 6000);
    const [portA, portB] = [a.port, b.port];
    await stop(b);
    await fetch(`${a.localUrl()}/api/files/${id}`, { method: 'DELETE' });
    const homeA = a.options.home;
    await stop(a);
    b = await boot({}, homeB, portB);
    (await roomOf(b, id)).doc.delete([one], 'agent:x');
    await stop(b);
    a = await boot({}, homeA, portA);
    b = await boot({}, homeB, portB);
    await until(() => hasFile(a, id), 10_000);
    await until(async () => (await layerNames(a, id)).join() === 'two', 10_000);
  }, 30_000);

  it('does not delete a file out from under an open editor; it goes when the editor closes', async () => {
    const a = await boot({ peerCatchUpMs: 300 });
    const b = await boot({ peerCatchUpMs: 300 });
    await pair(a, b);
    const id = await createFile(a, 'Open');
    await draw(a, id, 'content');
    await until(async () => hasFile(b, id) && (await layerNames(b, id)).includes('content'), 6000);
    const editor = liveClient(b, id);
    await editor.synced();
    await fetch(`${a.localUrl()}/api/files/${id}`, { method: 'DELETE' });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(hasFile(b, id)).toBe(true);
    editor.close();
    await until(() => (b.rooms.peek(id)?.conns.size ?? 0) === 0);
    await until(() => !hasFile(b, id), 6000);
  });

  it('an edit in an open editor brings a deleted file back everywhere', async () => {
    const a = await boot({ peerCatchUpMs: 300 });
    const b = await boot({ peerCatchUpMs: 300 });
    await pair(a, b);
    const id = await createFile(a, 'Open edit');
    await draw(a, id, 'content');
    await until(async () => hasFile(b, id) && (await layerNames(b, id)).includes('content'), 6000);
    const editor = liveClient(b, id);
    await editor.synced();
    await fetch(`${a.localUrl()}/api/files/${id}`, { method: 'DELETE' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    editor.doc.insert(editor.doc.getPages()[0]!.id, { type: 'frame', name: 'still-typing' }, undefined, 'local');
    await until(() => hasFile(a, id), 6000);
    await until(async () => (await layerNames(a, id)).includes('still-typing'), 6000);
  });
});

describe('assets', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(2000)]);

  it('replicates an asset through the manifest and on announcement, checking its hash', async () => {
    const [a, b] = [await boot(), await boot()];
    const early = await a.storage.putAsset(png, 'image/png');
    await pair(a, b);
    await until(() => b.storage.hasAsset(early.name), 6000);
    expect(Buffer.from((await b.storage.readAsset(early.name))!.bytes).equals(png)).toBe(true);
    const later = Buffer.concat([png, randomBytes(10)]);
    const res = await fetch(`${a.localUrl()}/api/assets`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: later });
    const { name } = (await res.json()) as { name: string };
    await until(() => b.storage.hasAsset(name), 3000);
  });

  it('pulls a missing asset on demand when something asks for it', async () => {
    const [a, b] = [await boot(), await boot()];
    await pair(a, b);
    // Written straight to a's disk, so a announces nothing and b has not heard of it.
    const bytes = Buffer.concat([png, randomBytes(4)]);
    const hash = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(a.options.home, 'assets', `${hash}.png`), bytes);
    const res = await fetch(`${b.localUrl()}/assets/${hash}.png`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('refuses a forged asset from a broken peer, and does not ask back in a loop', async () => {
    const bytes = randomBytes(100);
    const claimed = `${createHash('sha256').update(bytes).digest('hex')}.png`;
    const hits: string[] = [];
    let token = '';
    const fake: Server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/api/peer/register') {
        return res.writeHead(200).end(JSON.stringify({ id: 'fakepeer', name: 'Fake', version: '0' }));
      }
      if (req.url === '/api/peer/manifest') return res.writeHead(200).end(JSON.stringify({ files: [], assets: [claimed] }));
      if (req.url?.startsWith('/api/peer/assets/')) return res.writeHead(200).end(randomBytes(100));
      res.writeHead(404).end();
    });
    fake.on('upgrade', (_req, socket) => {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const port = (fake.address() as { port: number }).port;
    const a = await boot();
    token = 'x'.repeat(32);
    const added = await post(a.localUrl(), '/api/peers', { url: `http://127.0.0.1:${port}`, token, insecure: true });
    expect(added.status).toBe(201);
    // No live link with a fake peer, so the on-demand path needs one. A sweep is what fetches here.
    (a.peers as unknown as { requestCatchUp: (l: unknown, k: string) => void }).requestCatchUp((a.peers as unknown as { links: Map<string, unknown> }).links.get('fakepeer'), 'full');
    await until(() => a.peers.stats.assetsRefused === 1, 4000);
    expect(await a.storage.hasAsset(claimed)).toBe(false);
    expect(existsSync(join(a.options.home, 'assets', claimed))).toBe(false);
    await stop(a);
    await new Promise((resolve) => fake.close(resolve));
  });

  it('refuses an asset over the size limit without taking it all in', async () => {
    const claimed = `${'a'.repeat(64)}.png`;
    let served = 0;
    const fake = createServer((req, res) => {
      if (req.url === '/api/peer/register') return res.writeHead(200).end(JSON.stringify({ id: 'fakepeer2', name: 'Fake' }));
      if (req.url === '/api/peer/manifest') return res.writeHead(200).end(JSON.stringify({ files: [], assets: [claimed] }));
      if (req.url?.startsWith('/api/peer/assets/')) {
        res.writeHead(200);
        const chunk = Buffer.alloc(1024 * 1024);
        const pump = () => {
          while (served < 200 && !res.destroyed) {
            served++;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          res.end();
        };
        res.on('close', () => { served = Math.max(served, 0); });
        return pump();
      }
      res.writeHead(404).end();
    });
    fake.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const a = await boot({ peerMaxAssetBytes: 64 * 1024 * 1024 });
    await post(a.localUrl(), '/api/peers', { url: `http://127.0.0.1:${(fake.address() as { port: number }).port}`, token: 'y'.repeat(32), insecure: true });
    const link = (a.peers as unknown as { links: Map<string, { missingAssets: number }> }).links.get('fakepeer2')!;
    let done = false;
    (a.peers as unknown as { catchUp: (l: unknown, f: boolean) => Promise<void> }).catchUp(link, true).then(() => { done = true; }, () => { done = true; });
    await until(() => done, 15_000);
    expect(await a.storage.hasAsset(claimed)).toBe(false);
    expect(served).toBeLessThan(200);
    await stop(a);
    fake.closeAllConnections();
    await new Promise((resolve) => fake.close(resolve));
  }, 25_000);
});

describe('auth', () => {
  const rawUpgrade = (url: string, headers: Record<string, string> = {}) => new Promise<number>((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => {
      ws.terminate();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.destroy();
    });
    ws.on('error', () => {});
  });

  it('refuses a wrong or missing token on every peer route and on the peer socket, on loopback too', async () => {
    const [a, b] = [await boot(), await boot()];
    await pair(a, b);
    const id = await createFile(a, 'Secret');
    const name = `${'b'.repeat(64)}.png`;
    const routes: [string, string][] = [
      ['GET', '/api/peer/manifest'], ['POST', `/api/peer/files/${id}/sync`], ['GET', `/api/peer/assets/${name}`], ['POST', '/api/peer/register'], ['GET', '/api/peer/nothing'], ['GET', '/api/peer'],
    ];
    const device = { 'X-Bogen-Device': b.peers.deviceId };
    for (const [method, path] of routes) {
      for (const headers of [device, { ...device, Authorization: 'Bearer wrong-wrong-wrong-wrong' }, { ...device, Authorization: 'Basic abc' }, { ...device, Cookie: `bogen_token=${(await pairInfo(a)).token}` }]) {
        const res = await fetch(`${a.localUrl()}${path}`, { method, headers, body: method === 'POST' ? '{}' : undefined });
        expect(res.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(401);
      }
    }
    expect(await rawUpgrade(`${a.localUrl().replace('http', 'ws')}/peer`, device)).toBe(401);
    expect(await rawUpgrade(`${a.localUrl().replace('http', 'ws')}/peer?token=${(await pairInfo(a)).token}`, device)).toBe(401);
    expect(await rawUpgrade(`${a.localUrl().replace('http', 'ws')}/peer`, { ...device, Authorization: 'Bearer nope' })).toBe(401);
    const token = (await pairInfo(a)).token;
    // The right token from an unpaired device gets no further than pairing, and browsers none at all.
    expect((await fetch(`${a.localUrl()}/api/peer/manifest`, { headers: { Authorization: `Bearer ${token}`, 'X-Bogen-Device': 'stranger' } })).status).toBe(403);
    expect((await fetch(`${a.localUrl()}/api/peer/manifest`, { headers: { Authorization: `Bearer ${token}`, ...device, Origin: 'http://evil.example' } })).status).toBe(403);
    expect(await rawUpgrade(`${a.localUrl().replace('http', 'ws')}/peer`, { Authorization: `Bearer ${token}`, 'X-Bogen-Device': 'stranger' })).toBe(403);
    expect((await fetch(`${a.localUrl()}/api/peer/manifest`, { headers: { Authorization: `Bearer ${token}`, ...device } })).status).toBe(200);
  });

  it('the tailnet listener serves nothing without the bearer, and comes up late', async () => {
    let address: string | null = null;
    const a = await boot({ tailnet: true, tailscaleIp: async () => address, tailnetRetryMs: 50 });
    const b = await boot();
    await pair(a, b);
    expect(a.peers.device().tailnetUrl).toBeNull();
    address = '127.0.0.2';
    await until(() => a.peers.device().tailnetUrl !== null, 3000);
    const remote = a.peers.device().tailnetUrl!;
    expect(remote).toBe(`http://127.0.0.2:${a.port}`);
    const token = (await pairInfo(a)).token;
    const id = await createFile(a, 'Listener');
    const asset = await a.storage.putAsset(randomBytes(20), 'image/png');

    for (const [method, path] of [
      ['GET', '/'], ['GET', '/index.html'], ['GET', '/api/status'], ['GET', '/api/files'], ['POST', '/api/files'], ['DELETE', `/api/files/${id}`], ['PATCH', `/api/files/${id}`],
      ['GET', `/assets/${asset.name}`], ['POST', '/api/assets'], ['POST', '/mcp'], ['GET', '/mcp'], ['GET', '/api/peers'], ['POST', '/api/peers'], ['POST', '/api/peers/pair'],
      ['GET', '/api/peer/manifest'], ['GET', '/api/theme'], ['GET', '/api/fonts'], ['GET', '/api/runners'], ['POST', '/api/runs'], ['POST', '/api/omarchy/reload'], ['GET', `/?token=${token}`],
      ['GET', `/api/status?token=${token}`], ['GET', '/does-not-exist'],
    ] as const) {
      const res = await fetch(`${remote}${path}`, { method, redirect: 'manual', body: method === 'POST' || method === 'PATCH' ? '{}' : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
      const withCookie = await fetch(`${remote}${path}`, { method, redirect: 'manual', headers: { Cookie: `bogen_token=${token}` }, body: method === 'POST' || method === 'PATCH' ? '{}' : undefined });
      expect(withCookie.status, `cookie ${method} ${path}`).toBe(401);
      const wrong = await fetch(`${remote}${path}`, { method, redirect: 'manual', headers: { Authorization: 'Bearer nope' }, body: method === 'POST' || method === 'PATCH' ? '{}' : undefined });
      expect(wrong.status, `wrong ${method} ${path}`).toBe(401);
    }
    const ws = remote.replace('http', 'ws');
    for (const path of ['/events', `/sync/${id}`, '/peer', '/anything', `/events?token=${token}`, `/sync/${id}?token=${token}`]) {
      expect(await rawUpgrade(`${ws}${path}`), path).toBe(401);
    }
    expect(hasFile(a, id)).toBe(true);

    const auth = { Authorization: `Bearer ${token}` };
    expect((await fetch(`${remote}/api/status`, { headers: auth })).status).toBe(200);
    expect(await rawUpgrade(`${ws}/events`, auth)).toBe(101);
    // These stay on this machine, token or not.
    for (const [method, path] of [['GET', '/api/peers'], ['POST', '/api/peers/pair'], ['POST', '/api/runs'], ['POST', '/api/comments'], ['POST', '/api/omarchy/reload']] as const) {
      expect((await fetch(`${remote}${path}`, { method, headers: auth })).status, path).toBe(403);
    }
    // The loopback listener is unchanged.
    expect((await fetch(`${a.localUrl()}/api/status`)).status).toBe(200);

    // Turned off by hand, it stops now, although this run was started with --tailnet.
    const off = await fetch(`${a.localUrl()}/api/peers/tailnet`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) });
    expect(await off.json()).toEqual({ on: false, url: null, onAtStart: true });
    await expect(fetch(`${remote}/api/status`, { headers: auth })).rejects.toThrow();
    expect((await (await fetch(`${a.localUrl()}/api/peers`)).json()).tailnet).toBe(false);
  });

  it('refuses to pair with a host off the tailnet without test permission', async () => {
    const a = await boot({ insecureAllowAnyHost: false });
    const b = await boot();
    const bInfo = await pairInfo(b);
    let res = await post(a.localUrl(), '/api/peers', { url: bInfo.url, token: bInfo.token });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/not on a tailnet/);
    // Asking for the test permission does not grant it: only the server's own start can.
    res = await post(a.localUrl(), '/api/peers', { url: bInfo.url, token: bInfo.token, insecure: true });
    expect(res.status).toBe(403);
    // And a device registering itself from off the tailnet is refused too.
    const aInfo = await fetch(`${a.localUrl()}/api/peer/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${JSON.parse(readFileSync(join(a.options.home, 'config.json'), 'utf8')).peerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'someone', name: 'Someone', url: 'http://192.168.1.5:1', token: 'z'.repeat(32) }),
    });
    expect(aInfo.status).toBe(400);
    expect(a.peers.status()).toEqual([]);
    expect(b.peers.status()).toEqual([]);
  });

  it('removes a peer on request, and the last removal retires the token', async () => {
    const [a, b] = [await boot(), await boot()];
    await pair(a, b);
    const old = (await pairInfo(a)).token;
    const res = await fetch(`${a.localUrl()}/api/peers/${b.peers.deviceId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(a.peers.status()).toEqual([]);
    expect((await pairInfo(a)).token).not.toBe(old);
    await until(() => b.peers.status()[0]!.state === 'offline');
    expect((await fetch(`${a.localUrl()}/api/peer/manifest`, { headers: { Authorization: `Bearer ${old}`, 'X-Bogen-Device': b.peers.deviceId } })).status).toBe(401);
  });
});

describe('a broken peer', () => {
  it('survives malformed updates and bad messages, and refuses documents of the wrong shape', async () => {
    const [a, b] = [await boot(), await boot()];
    await pair(a, b);
    const id = await createFile(a, 'Robust');
    await draw(a, id, 'good');
    await until(async () => hasFile(b, id) && (await layerNames(b, id)).includes('good'), 6000);
    const token = (await pairInfo(a)).token;
    const send = (update: Uint8Array) => fetch(`${a.localUrl()}/api/peer/files/${id}/sync`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Bogen-Device': b.peers.deviceId, 'content-type': 'application/json' },
      body: JSON.stringify({ sv: Buffer.from([0]).toString('base64'), update: Buffer.from(update).toString('base64') }),
    });

    // Garbage.
    expect((await send(randomBytes(200))).status).toBe(422);
    // Valid Yjs, wrong shape: a layer that is not a map.
    const bad = new Y.Doc();
    bad.getMap('nodes').set('evil', 'just a string');
    expect((await send(Y.encodeStateAsUpdate(bad))).status).toBe(422);
    // Valid Yjs, a layer without a style.
    const noStyle = new Y.Doc();
    const m = new Y.Map();
    m.set('type', 'frame');
    noStyle.getMap('nodes').set('evil2', m);
    expect((await send(Y.encodeStateAsUpdate(noStyle))).status).toBe(422);
    expect((await roomOf(a, id)).doc.nodes.has('evil')).toBe(false);

    // Bad JSON bodies, a bad state vector.
    const raw = (body: string) => fetch(`${a.localUrl()}/api/peer/files/${id}/sync`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Bogen-Device': b.peers.deviceId }, body });
    expect((await raw('{nope')).status).toBe(400);
    expect((await raw('{"sv": 12}')).status).toBe(400);
    expect((await raw(JSON.stringify({ sv: Buffer.from(randomBytes(30)).toString('base64') }))).status).toBeGreaterThanOrEqual(200);

    // Over the live link: garbage JSON closes the socket, a bad update is only refused.
    const dial = () => new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`${a.localUrl().replace('http', 'ws')}/peer`, { headers: { Authorization: `Bearer ${token}`, 'X-Bogen-Device': b.peers.deviceId } });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
    const socket = await dial();
    const refusedBefore = a.peers.stats.updatesRefused;
    socket.send(JSON.stringify({ t: 'update', id, u: Buffer.from(randomBytes(64)).toString('base64') }));
    socket.send(JSON.stringify({ t: 'update', id: '../../etc', u: 'AAAA' }));
    await until(() => socket.readyState === WebSocket.CLOSED || a.peers.stats.updatesRefused > refusedBefore);
    const second = await dial();
    const closed = new Promise<number>((resolve) => second.once('close', resolve));
    second.send('this is not json');
    expect(await closed).toBe(1007);
    const third = await dial();
    third.send(JSON.stringify({ t: 'asset', name: '../../../etc/passwd' }));
    third.send(JSON.stringify({ t: 'whatever' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    third.terminate();

    // A message over the limit ends that socket and nothing else.
    const big = await dial();
    const bigClosed = new Promise<void>((resolve) => big.once('close', () => resolve()));
    big.on('error', () => {});
    big.send(Buffer.alloc(40 * 1024 * 1024, 0x20));
    await bigClosed;

    // Still up, still syncing.
    await until(() => connected(a, b) && connected(b, a), 8000);
    await draw(a, id, 'after-abuse');
    await until(async () => (await layerNames(b, id)).includes('after-abuse'), 8000);
    expect((await roomOf(a, id)).doc.getPages().length).toBe(1);
    assertWellFormed((await roomOf(a, id)).doc);
  }, 30_000);

  it('refuses a new file with a bad state from a peer, and stays up on a bad manifest', async () => {
    const bad = new Y.Doc();
    bad.getMap('nodes').set('evil', 'string');
    const noPages = new Y.Doc();
    noPages.getMap('meta').set('x', 1);
    let manifestBody = JSON.stringify({
      files: [
        { id: 'badshape1', name: 'Bad', updatedAt: 1 }, { id: 'nopages01', name: 'No pages', updatedAt: 1 }, { id: 'garbage01', name: 'Garbage', updatedAt: 1 },
      ],
      assets: [],
    });
    const fake = createServer((req, res) => {
      if (req.url === '/api/peer/register') return res.writeHead(200).end(JSON.stringify({ id: 'fakepeer3', name: 'Fake' }));
      if (req.url === '/api/peer/manifest') return res.writeHead(200).end(manifestBody);
      const pick = (y: Y.Doc) => JSON.stringify({ update: Buffer.from(Y.encodeStateAsUpdate(y)).toString('base64'), sv: 'AA==' });
      if (req.url?.includes('/badshape1/')) return res.writeHead(200).end(pick(bad));
      if (req.url?.includes('/nopages01/')) return res.writeHead(200).end(pick(noPages));
      if (req.url?.includes('/garbage01/')) return res.writeHead(200).end(JSON.stringify({ update: randomBytes(80).toString('base64'), sv: 'AA==' }));
      res.writeHead(404).end();
    });
    fake.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const a = await boot();
    await post(a.localUrl(), '/api/peers', { url: `http://127.0.0.1:${(fake.address() as { port: number }).port}`, token: 'w'.repeat(32), insecure: true });
    const manager = a.peers as unknown as { catchUp: (l: unknown, f: boolean) => Promise<void>; links: Map<string, unknown> };
    const link = manager.links.get('fakepeer3');
    await manager.catchUp(link, true);
    expect(a.storage.list()).toEqual([]);
    for (const body of ['not json', JSON.stringify({ files: 'nope' }), JSON.stringify({ files: [{ id: '../../x', name: 'x', updatedAt: 1 }], assets: [] })]) {
      manifestBody = body;
      await expect(manager.catchUp(link, true)).rejects.toThrow();
    }
    expect((await fetch(`${a.localUrl()}/api/status`)).status).toBe(200);
    await stop(a);
    await new Promise((resolve) => fake.close(resolve));
  });
});

describe('beyond', () => {
  it('tells new structs and new deletions from nothing new', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const page = doc.getPages()[0]!.id;
    const id = doc.insert(page, { type: 'frame', name: 'x' });
    const snap = () => Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.y))).toString('base64');
    const first = snap();
    expect(beyond(first, first)).toBe(false);
    doc.delete([id]);
    const second = snap();
    expect(beyond(second, first)).toBe(true);
    expect(beyond(first, second)).toBe(false);
    doc.insert(page, { type: 'frame', name: 'y' });
    expect(beyond(snap(), second)).toBe(true);
  });
});
