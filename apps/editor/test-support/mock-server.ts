/**
 * A tiny stand-in for packages/server, dev and test only. It speaks the same contract from docs/SPEC.md:
 * REST, y-websocket sync and awareness, and /events, and it serves the built editor.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { BogenDoc } from '@bogen/core';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

const DIST = process.env.BOGEN_EDITOR_DIR ?? resolve(import.meta.dirname, '../dist');

interface FileRec { id: string; name: string; updatedAt: number; thumbnail?: string; doc: Y.Doc; aw: awarenessProtocol.Awareness; conns: Set<WebSocket> }

export interface MockServer {
  port: number;
  close: () => Promise<void>;
  /** Pushes something on /events, as the real server would. */
  broadcast: (msg: unknown) => void;
  files: Map<string, FileRec>;
  setTheme: (theme: unknown) => void;
  /** Drops all sync sockets and refuses new ones until `resumeSync`. */
  dropSync: () => void;
  resumeSync: () => void;
  exportRequests: unknown[];
  runs: { prompt: string; runner: string; nodeIds: string[] }[];
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.map': 'application/json' };

// 1x1 transparent PNG, for export calls in tests.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export async function startMockServer(port = 0): Promise<MockServer> {
  const files = new Map<string, FileRec>();
  const assets = new Map<string, { type: string; data: Buffer }>();
  const events = new Set<WebSocket>();
  let theme: unknown = null;
  let refuseSync = false;
  const exportRequests: unknown[] = [];
  const runs: MockServer['runs'] = [];
  let counter = 0;

  // The real server keeps agent steps per file; the mock remembers what tests announce.
  const steps: { id: string; agent: string; tool: string; at: number; changes: { nodeId: string; name: string; kind: 'changed'; fields: never[] }[]; undone: boolean; fileId: string }[] = [];
  const broadcast = (msg: unknown) => {
    const m = msg as { t?: string; fileId?: string; agent?: string; tool?: string; nodeIds?: string[]; at?: number };
    if (m.t === 'activity' && m.fileId) steps.unshift({ id: `s${steps.length + 1}`, agent: m.agent ?? 'agent', tool: m.tool ?? '', at: m.at ?? Date.now(), changes: (m.nodeIds ?? []).map((nodeId) => ({ nodeId, name: nodeId, kind: 'changed' as const, fields: [] })), undone: false, fileId: m.fileId });
    const text = JSON.stringify(msg);
    for (const s of events) s.send(text);
  };

  const newFile = (name?: string): FileRec => {
    const id = `f${Date.now().toString(36)}${counter++}`;
    const doc = new Y.Doc();
    new BogenDoc(doc).ensureFirstPage();
    const aw = new awarenessProtocol.Awareness(doc);
    aw.setLocalState(null);
    const rec: FileRec = { id, name: name || 'Untitled', updatedAt: Date.now(), doc, aw, conns: new Set() };
    wireFile(rec);
    files.set(id, rec);
    return rec;
  };

  const wireFile = (rec: FileRec) => {
    rec.doc.on('update', (update: Uint8Array, origin: unknown) => {
      rec.updatedAt = Date.now();
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const data = encoding.toUint8Array(enc);
      for (const c of rec.conns) if (c !== origin && c.readyState === c.OPEN) c.send(data);
    });
    rec.aw.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(rec.aw, changed));
      const data = encoding.toUint8Array(enc);
      for (const c of rec.conns) if (c !== origin && c.readyState === c.OPEN) c.send(data);
    });
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> => new Promise((ok) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
  });

  const json = (res: ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (p === '/api/status') return json(res, { version: 'mock', port, files: files.size, agents: [] });
    if (p === '/api/theme') return json(res, theme);
    if (p === '/api/agents/steps') return json(res, steps.filter((x) => x.fileId === url.searchParams.get('fileId')));
    if (p === '/api/runners') return json(res, [{ id: 'claude', available: true, version: 'mock' }, { id: 'codex', available: false }]);
    if (p === '/api/files' && req.method === 'GET') return json(res, [...files.values()].map(({ id, name, updatedAt, thumbnail }) => ({ id, name, updatedAt, ...(thumbnail ? { thumbnail } : {}) })));
    if (p === '/api/files' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}') as { name?: string };
      const f = newFile(body.name);
      broadcast({ t: 'files' });
      return json(res, { id: f.id, name: f.name });
    }
    const fm = /^\/api\/files\/([\w-]+)(\/duplicate)?$/.exec(p);
    if (fm) {
      const rec = files.get(fm[1]!);
      if (!rec) return json(res, { error: 'not found' }, 404);
      if (fm[2] && req.method === 'POST') {
        const copy = newFile(`${rec.name} copy`);
        Y.applyUpdate(copy.doc, Y.encodeStateAsUpdate(rec.doc));
        broadcast({ t: 'files' });
        return json(res, { id: copy.id, name: copy.name });
      }
      if (req.method === 'PATCH') {
        const body = JSON.parse((await readBody(req)).toString() || '{}') as { name?: string };
        if (body.name) rec.name = body.name;
        broadcast({ t: 'files' });
        return json(res, { id: rec.id, name: rec.name });
      }
      if (req.method === 'DELETE') {
        files.delete(rec.id);
        broadcast({ t: 'files' });
        return json(res, { ok: true });
      }
    }
    if (p === '/api/assets' && req.method === 'POST') {
      const data = await readBody(req);
      const type = req.headers['content-type'] ?? 'application/octet-stream';
      const ext = type.split('/')[1]?.split('+')[0] ?? 'bin';
      const name = `${createHash('sha256').update(data).digest('hex').slice(0, 32)}.${ext}`;
      assets.set(name, { type, data });
      return json(res, { name, src: `bogen-asset:${name}`, url: `/assets/${name}` });
    }
    const am = /^\/assets\/(.+)$/.exec(p);
    if (am) {
      const a = assets.get(am[1]!);
      if (!a) return json(res, { error: 'not found' }, 404);
      res.writeHead(200, { 'Content-Type': a.type });
      return res.end(a.data);
    }
    if (p === '/api/export') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      exportRequests.push(body);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PNG);
    }
    if (p === '/api/agents/undo') {
      await readBody(req);
      return json(res, { ok: true });
    }
    if (p === '/api/runs' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}') as { fileId: string; prompt: string; runner: string; nodeIds: string[] };
      runs.push(body);
      const runId = `r${counter++}`;
      json(res, { runId });
      const words = ['Looking ', 'at ', 'the ', 'layer. ', 'Done.'];
      words.forEach((text, i) => setTimeout(() => broadcast({ t: 'agent', runId, fileId: body.fileId, kind: 'text', text }), 40 * (i + 1)));
      setTimeout(() => broadcast({ t: 'agent', runId, fileId: body.fileId, kind: 'tool', tool: 'bogen_set_style' }), 120);
      setTimeout(() => broadcast({ t: 'agent', runId, fileId: body.fileId, kind: 'done' }), 400);
      return undefined;
    }
    const rm = /^\/api\/runs\/([\w-]+)\/stop$/.exec(p);
    if (rm) {
      await readBody(req);
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/')) return json(res, { error: 'not found' }, 404);

    // Static editor.
    const file = join(DIST, p === '/' ? 'index.html' : p);
    if (file.startsWith(DIST) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      return res.end(readFileSync(file));
    }
    const index = join(DIST, 'index.html');
    if (existsSync(index)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(readFileSync(index));
    }
    res.writeHead(404);
    return res.end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/events') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        events.add(ws);
        ws.on('close', () => events.delete(ws));
      });
      return;
    }
    const m = /^\/sync\/([\w-]+)/.exec(url.pathname);
    if (!m || refuseSync) {
      socket.destroy();
      return;
    }
    const rec = files.get(m[1]!);
    if (!rec) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleSync(rec, ws));
  });

  const handleSync = (rec: FileRec, ws: WebSocket) => {
    rec.conns.add(ws);
    const clients = new Set<number>();
    ws.binaryType = 'arraybuffer';
    ws.on('message', (raw: ArrayBuffer | Buffer) => {
      const data = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const dec = decoding.createDecoder(data);
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, rec.doc, ws);
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        const update = decoding.readVarUint8Array(dec);
        const d2 = decoding.createDecoder(update);
        const len = decoding.readVarUint(d2);
        for (let i = 0; i < len; i++) {
          const id = decoding.readVarUint(d2);
          decoding.readVarUint(d2);
          decoding.readVarString(d2);
          clients.add(id);
        }
        awarenessProtocol.applyAwarenessUpdate(rec.aw, update, ws);
      }
    });
    ws.on('close', () => {
      rec.conns.delete(ws);
      awarenessProtocol.removeAwarenessStates(rec.aw, [...clients], ws);
    });
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, rec.doc);
    ws.send(encoding.toUint8Array(enc));
    const states = [...rec.aw.getStates().keys()];
    if (states.length) {
      const e2 = encoding.createEncoder();
      encoding.writeVarUint(e2, MSG_AWARENESS);
      encoding.writeVarUint8Array(e2, awarenessProtocol.encodeAwarenessUpdate(rec.aw, states));
      ws.send(encoding.toUint8Array(e2));
    }
  };

  await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok));
  const actual = (server.address() as { port: number }).port;
  return {
    port: actual,
    broadcast,
    files,
    exportRequests,
    runs,
    setTheme: (t) => { theme = t; broadcast({ t: 'theme', theme: t }); },
    dropSync: () => {
      refuseSync = true;
      for (const rec of files.values()) for (const c of rec.conns) c.terminate();
    },
    resumeSync: () => { refuseSync = false; },
    close: () => new Promise<void>((ok) => {
      for (const s of events) s.terminate();
      for (const rec of files.values()) for (const c of rec.conns) c.terminate();
      wss.close();
      server.close(() => ok());
      server.closeAllConnections();
    }),
  };
}

if (process.argv[1] && process.argv[1].endsWith('mock-server.ts')) {
  const port = Number(process.env.PORT ?? 29990);
  void startMockServer(port).then((s) => {
    console.log(`mock bogen server on http://127.0.0.1:${s.port}`);
  });
}
