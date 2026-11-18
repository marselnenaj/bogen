import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BogenServer, type ServerOptions } from '../src/http/server.ts';
import { pathRefusal } from '../src/http/security.ts';
import { until } from './helpers.ts';

/**
 * The tailnet and phone listeners refuse some routes by matching the path as written, and routing splits the path
 * into segments. Any second spelling of a refused route must therefore be refused before either looks at it.
 */

const running: { server: BogenServer; home: string }[] = [];
afterEach(async () => {
  for (const { server, home } of running.splice(0)) {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

async function boot(options: Partial<ServerOptions> = {}): Promise<BogenServer> {
  const home = mkdtempSync(join(tmpdir(), 'bogen-path-'));
  const server = new BogenServer({ home, port: 0, insecureAllowAnyHost: true, peerCatchUpMs: 60_000, exportDir: join(home, 'exports'), ...options });
  await server.listen();
  running.push({ server, home });
  return server;
}

/** Raw HTTP, since fetch and URL tidy `//`, `./` and `../` away before they are sent. */
function raw(base: string, path: string, method = 'GET', headers: Record<string, string> = {}): Promise<number> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, path, method, headers: { Host: `${hostname}:${port}`, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : '{}');
  });
}

/** A WebSocket upgrade with a path of our choosing; answers the status line's code. */
function rawUpgrade(base: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname);
    socket.on('error', reject);
    socket.once('connect', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`);
    });
    socket.once('data', (chunk) => {
      socket.destroy();
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(chunk.toString('latin1'))?.[1] ?? 0));
    });
  });
}

/** Other spellings of `route`: each would reach the same handler if it got past the block lists. */
function spellings(route: string): string[] {
  const [, first, ...rest] = route.split('/');
  const tail = rest.join('/');
  return [
    `/${first}//${tail}`,
    `//${first}/${tail}`,
    `/${first}/./${tail}`,
    `/${first}/x/../${tail}`,
    `/${first}/%2e/${tail}`,
    `/${first}/x/%2e%2e/${tail}`,
    `/${first}/X/%2E%2E/${tail}`,
    `/${first}%2f${tail}`,
    `/${first}%2F${tail}`,
    `/${first}\\${tail}`,
    `/${first}%5c${tail}`,
    `/${first}/${tail}%00`,
    `/${first}/${tail}/.`,
    `${route}//`,
  ];
}

describe('pathRefusal', () => {
  it.each([
    ['/', null], ['/api/files', null], ['/api/files/', null], ['/api/files?x=//..', null], ['/assets/ab12.png', null], ['/api/files/a%20b', null],
    ['/api//files', 'refused'], ['//api/files', 'refused'], ['/api/./files', 'refused'], ['/api/../files', 'refused'], ['/api/%2e%2e/files', 'refused'],
    ['/api%2ffiles', 'refused'], ['/api\\files', 'refused'], ['/api/files%00', 'refused'], ['api/files', 'refused'], ['http://x/api/files', 'refused'],
    ['/api/files//', 'refused'], [`/${'a'.repeat(5000)}`, 'refused'],
  ])('%s', (path, expected) => {
    expect(pathRefusal(path) === null ? null : 'refused').toBe(expected);
  });
});

describe('every listener refuses other spellings of a route', () => {
  it('the tailnet listener, with a valid device token', async () => {
    const a = await boot({ tailnet: true, tailscaleIp: async () => '127.0.0.2', tailnetRetryMs: 50 });
    await until(() => a.peers.device().tailnetUrl !== null, 3000);
    const remote = a.peers.device().tailnetUrl!;
    const pair = await fetch(`${a.localUrl()}/api/peers/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ insecure: true }) });
    const { token } = await pair.json() as { token: string };
    const auth = { Authorization: `Bearer ${token}` };
    expect(await raw(remote, '/api/status', 'GET', auth)).toBe(200);

    const blocked: [string, string][] = [
      ['GET', '/api/peers'], ['POST', '/api/peers/pair'], ['POST', '/api/peers/tailnet'], ['POST', '/api/brands'], ['PUT', '/api/brands/default'],
      ['POST', '/api/runs'], ['POST', '/api/comments'], ['POST', '/api/omarchy/reload'], ['GET', '/api/inbox'], ['POST', '/api/phone/code'],
      ['POST', '/api/publish'], ['GET', '/api/shares'], ['POST', '/mcp'], ['GET', '/api/notifications'],
    ];
    for (const [method, route] of blocked) {
      expect(await raw(remote, route, method, auth), `${method} ${route}`).toBe(403);
      for (const path of spellings(route)) expect(await raw(remote, path, method, auth), `${method} ${path}`).toBe(400);
    }
    for (const path of ['/events', '/peer']) {
      for (const variant of spellings(`/api${path}`).map((p) => p.replace('/api', '')).filter((p) => p !== path)) {
        expect(await rawUpgrade(remote, variant, auth), `upgrade ${variant}`).toBe(400);
      }
    }
    // Nothing above changed this machine.
    expect(a.peers.status()).toEqual([]);
    expect((await (await fetch(`${a.localUrl()}/api/brands`)).json() as unknown[]).length).toBe(0);
  });

  it('the main listener, on loopback', async () => {
    const a = await boot();
    expect(await raw(a.localUrl(), '/api/status')).toBe(200);
    for (const path of spellings('/api/status')) expect(await raw(a.localUrl(), path), path).toBe(400);
    for (const path of ['/events//', '//events', '/./events', '/sync/../events', '/%2e/events']) expect(await rawUpgrade(a.localUrl(), path), path).toBe(400);
  });

  it('a token server behind a proxy keeps peer pairing to the machine itself', async () => {
    const a = await boot({ token: 't'.repeat(40) });
    const auth = { Authorization: `Bearer ${'t'.repeat(40)}` };
    expect(await raw(a.localUrl(), '/api/status', 'GET', auth)).toBe(200);
    // A proxy in front adds X-Forwarded-For, so the request is not from this machine.
    const proxied = { ...auth, 'X-Forwarded-For': '203.0.113.5' };
    expect(await raw(a.localUrl(), '/api/peers', 'GET', proxied)).toBe(403);
    expect(await raw(a.localUrl(), '/api/peers/pair', 'POST', proxied)).toBe(403);
    expect(await raw(a.localUrl(), '/api/peers/tailnet', 'POST', proxied)).toBe(403);
    expect(await raw(a.localUrl(), '/api/peers', 'GET', auth)).toBe(200);
  });
});

describe('the editor page', () => {
  it('scripts only from itself, talks only to this server, and never navigates a form', async () => {
    const a = await boot();
    const res = await fetch(`${a.localUrl()}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
    expect(directives).toMatchObject({
      'default-src': "'self'", 'script-src': "'self'", 'connect-src': "'self'", 'object-src': "'none'", 'base-uri': "'none'",
      'form-action': "'none'", 'frame-ancestors': "'none'",
    });
    expect(directives['script-src']).not.toMatch(/unsafe|https?:|\*/);
  });
});

describe('logs', () => {
  it('leave out the secret in a run\'s MCP address', async () => {
    const { loggedPath } = await import('../src/http/server.ts');
    expect(loggedPath('/live-mcp/abcdefghijklmnopqrstuvwxyz0123')).toBe('/live-mcp/<hidden>');
    expect(loggedPath('/api/files')).toBe('/api/files');
  });
});
