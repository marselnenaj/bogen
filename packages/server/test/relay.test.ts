import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BogenServer } from '../src/http/server.ts';
import { startServer } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for the server's /mcp: slow to initialize, one slow tool, and one session that ends under a call. */
function fakeServer() {
  let sessions = 0;
  let goneOnce = false;
  const live = new Set<string>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/status') return reply(200, { version: 'test' });
    if (req.method === 'GET') return reply(405, {});
    if (req.method === 'DELETE') return reply(200, {});
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const m = JSON.parse(raw);
      const sid = req.headers['mcp-session-id'] as string | undefined;
      if (m.method === 'initialize') {
        await sleep(300);
        const id = `s${++sessions}`;
        live.add(id);
        return reply(200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }, { 'mcp-session-id': id });
      }
      if (!sid || !live.has(sid)) return reply(sid ? 404 : 400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: sid ? 'This session has ended.' : 'Send initialize first.' } });
      if (m.id === undefined) { res.writeHead(202); return res.end(); }
      if (m.params?.name === 'slow') await sleep(1500);
      if (m.params?.name === 'gone' && !goneOnce) {
        // The session ends while the slow call on it is still running, as an evicted one would.
        goneOnce = true;
        return reply(404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'This session has ended.' } });
      }
      return reply(200, { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `${m.method}:${m.params?.name ?? ''}:${sid}` }] } });
    });
  });
  return server;
}

describe('the stdio relay', () => {
  it('holds messages written before the session exists, finishes slow calls across a reconnect, and answers before exiting', async () => {
    const server = fakeServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const root = join(import.meta.dirname, '..', '..', '..');
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'packages/server/src/cli.ts'), 'mcp'], {
      cwd: root, env: { ...process.env, BOGEN_URL: `http://127.0.0.1:${port}` },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    const exited = new Promise<number | null>((r) => child.on('exit', r));
    try {
      const write = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
      // All at once, without waiting for the answer to initialize, as some clients do.
      write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      write({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow', arguments: {} } });
      await sleep(900);
      write({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gone', arguments: {} } });
      // The client closes its input while calls are still running; their answers still arrive.
      child.stdin.end();
      expect(await exited).toBe(0);
      const answers = new Map(out.trim().split('\n').map((l) => JSON.parse(l)).map((m) => [m.id, m]));
      expect([...answers.keys()].sort()).toEqual([1, 2, 3, 4]);
      for (const m of answers.values()) expect(m.error).toBeUndefined();
      expect(answers.get(3).result.content[0].text).toBe('tools/call:slow:s1');
      expect(answers.get(4).result.content[0].text).toBe('tools/call:gone:s2');
      expect(err).toBe('');
    } finally {
      child.kill();
      server.close();
    }
  }, 20_000);

  it('goes on quietly across a restart of the real server, with nothing on stderr', async () => {
    const h = await startServer();
    const port = Number(new URL(h.base).port);
    const root = join(import.meta.dirname, '..', '..', '..');
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'packages/server/src/cli.ts'), 'mcp'], {
      cwd: root, env: { ...process.env, BOGEN_URL: h.base, BOGEN_HOME: h.home },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    const exited = new Promise<number | null>((r) => child.on('exit', r));
    let next: BogenServer | null = null;
    try {
      const write = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
      write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'file_create', arguments: { name: 'Before' } } });
      // Its event stream is open by now; the restart ends it and the session with it.
      await sleep(1500);
      await h.server.close();
      next = new BogenServer({ home: h.home, port, exportDir: join(h.home, 'exports') });
      await next.listen();
      await sleep(800);
      write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'file_list', arguments: {} } });
      await sleep(1500);
      child.stdin.end();
      expect(await exited).toBe(0);
      const answers = new Map(out.trim().split('\n').map((l) => JSON.parse(l)).map((m) => [m.id, m]));
      expect([...answers.keys()].sort()).toEqual([1, 2, 3]);
      for (const m of answers.values()) expect(m.error).toBeUndefined();
      expect(answers.get(3).result.content[0].text).toContain('Before');
      expect(err).toBe('');
    } finally {
      child.kill();
      await next?.close();
      await h.cleanup();
    }
  }, 30_000);
});
