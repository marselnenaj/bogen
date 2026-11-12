import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { formatCode, newPairingCode, normalizeCode, Phone, phoneOpenPath, phonePolicy, phoneRefusedPath } from '../src/phone.ts';
import { isLocalOnlyPath } from '../src/peers.ts';
import { filterAllows, parsePacketFilter, parseTailscaleStatus, type ServeStatus, type TailscaleCli } from '../src/tailnet.ts';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

const NAME = 'omarchy.tail123456.ts.net';
const HOST = `${NAME}:29443`;
const OWNER = 'owner@example.com';
const SHARED_IN = 'marselnenaj@github';

/** A stand-in for the Tailscale CLI, with a serve config that another app already uses. */
function fakeTailscale(): TailscaleCli & { calls: string[]; config: ServeStatus } {
  const config: ServeStatus = {
    TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
    Web: { [`${NAME}:443`]: { Handlers: { '/clip': { Proxy: 'http://127.0.0.1:8787' } } }, [`${NAME}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8766' } } } },
  };
  const calls: string[] = [];
  return {
    calls, config,
    self: async () => ({ dnsName: NAME, ownerLogin: OWNER, ips: ['100.64.0.10'], peers: [{ name: 'localhost', dnsName: `phone.tail123456.ts.net`, os: 'iOS', login: OWNER, ips: ['100.64.0.11'] }] }),
    serveStatus: async () => structuredClone(config),
    serve: async (port, target) => {
      calls.push(`serve ${port} ${target}`);
      config.TCP![port] = { HTTPS: true };
      config.Web![`${NAME}:${port}`] = { Handlers: { '/': { Proxy: target } } };
    },
    serveOff: async (port) => {
      calls.push(`off ${port}`);
      delete config.TCP![port];
      delete config.Web![`${NAME}:${port}`];
    },
    packetFilter: async () => [],
  };
}

interface Answer { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any }

/** Raw HTTP, since fetch will not send a Host header of our choosing. */
function raw(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...options.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** What tailscale serve sends for the owner's iPhone: the ts.net Host, the login, and X-Forwarded-For. */
const viaServe = (extra: Record<string, string> = {}, login = OWNER) => ({ Host: HOST, 'Tailscale-User-Login': login, 'X-Forwarded-For': '100.64.0.11', ...extra });

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
  vi.useRealTimers();
});

async function boot(): Promise<{ h: Harness; ts: ReturnType<typeof fakeTailscale>; port: number }> {
  const ts = fakeTailscale();
  h = await startServer({ tailscale: ts, phonePort: 0 });
  const on = await fetch(`${h.base}/api/phone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });
  expect(on.status).toBe(200);
  return { h, ts, port: h.server.phone.boundPort };
}

async function pairPhone(base: string, port: number): Promise<{ cookie: string; id: string }> {
  const { code } = await (await fetch(`${base}/api/phone/code`, { method: 'POST' })).json() as { code: string };
  const paired = await raw(port, '/api/phone/pair', { method: 'POST', headers: viaServe({ Origin: `https://${HOST}`, 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), body: { code } });
  expect(paired.status).toBe(201);
  const set = String(paired.headers['set-cookie']);
  expect(set).toMatch(/^__Host-bogen_phone=[\w-]{40,}; Path=\/; Secure; HttpOnly; SameSite=Strict/);
  return { cookie: set.split(';')[0]!, id: paired.json().id };
}

describe('pairing codes', () => {
  it('gives the link as QR rows on request, for the bar widget', async () => {
    const { h: harness } = await boot();
    const plain = await (await fetch(`${harness.base}/api/phone/code`, { method: 'POST' })).json() as Record<string, unknown>;
    expect(plain.qr).toBeUndefined();
    const withQr = await (await fetch(`${harness.base}/api/phone/code?qr`, { method: 'POST' })).json() as { code: string; link: string; qr: string[] };
    expect(withQr.link).toBe(`https://${HOST}/#/pair/${withQr.code}`);
    expect(withQr.qr.length).toBeGreaterThan(20);
    expect(withQr.qr.every((row) => row.length === withQr.qr.length && /^[01]+$/.test(row))).toBe(true);
  });

  it('are eight unambiguous letters, typed in any case with or without the dash', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = newPairingCode();
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(200);
    expect(formatCode('ABCDEFGH')).toBe('ABCD-EFGH');
    expect(normalizeCode(' abcd-efgh ')).toBe('ABCDEFGH');
    // Bytes from 248 up would favour the first letters, so they are skipped.
    expect(newPairingCode(() => Uint8Array.from([255, 248, 0, 1, 2, 3, 4, 5, 6, 30, 31]))).toBe('ABCDEFG9');
  });

  it('work once, die after five wrong tries, and expire after ten minutes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bogen-phone-'));
    try {
      const phone = new Phone({ home, tailscale: fakeTailscale(), createServer: () => { throw new Error('not used'); } });
      const { code } = phone.newCode();
      await expect(phone.pair('WRONG', OWNER, undefined, undefined)).rejects.toThrow(/4 tries left/);
      const { device, token } = await phone.pair(code.toLowerCase(), OWNER, 'Phone of M', undefined);
      expect(device.name).toBe('Phone of M');
      expect(token).not.toContain(device.hash);
      await expect(phone.pair(code, OWNER, undefined, undefined)).rejects.toMatchObject({ status: 410 });

      const second = phone.newCode().code;
      for (let i = 0; i < 4; i++) await expect(phone.pair('AAAAAAAA', OWNER, undefined, undefined)).rejects.toMatchObject({ status: 403 });
      await expect(phone.pair('AAAAAAAA', OWNER, undefined, undefined)).rejects.toThrow(/no longer works/);
      await expect(phone.pair(second, OWNER, undefined, undefined)).rejects.toMatchObject({ status: 410 });

      vi.useFakeTimers({ toFake: ['Date'] });
      const third = phone.newCode().code;
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      await expect(phone.pair(third, OWNER, undefined, undefined)).rejects.toMatchObject({ status: 410 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the phone listener', () => {
  it('pairs a phone, which then reaches files and the sockets', async () => {
    const { h, ts, port } = await boot();
    expect(ts.calls).toEqual(['serve 29443 http://127.0.0.1:29991']);
    const status = await (await fetch(`${h.base}/api/phone`)).json();
    expect(status).toMatchObject({ on: true, listening: true, url: `https://${HOST}/`, logins: [OWNER], loginsFrom: 'owner', serve: 'ours' });

    // The app shell loads before pairing, so that the phone can show where to type the code.
    expect((await raw(port, '/', { headers: viaServe() })).status).toBe(200);
    expect((await raw(port, '/api/phone/me', { headers: viaServe() })).json()).toEqual({ paired: false });

    const { cookie, id } = await pairPhone(h.base, port);
    const me = await raw(port, '/api/phone/me', { headers: viaServe({ Cookie: cookie }) });
    expect(me.json()).toEqual({ paired: true, id, name: 'iPhone' });
    expect(String(me.headers['set-cookie'])).toContain('Max-Age=');
    const files = await raw(port, '/api/files', { headers: viaServe({ Cookie: cookie }) });
    expect(files.status).toBe(200);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/events`, { headers: viaServe({ Cookie: cookie, Origin: `https://${HOST}` }) });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.close();
  });

  it('refuses a missing token, on routes and on sockets', async () => {
    const { port } = await boot();
    const files = await raw(port, '/api/files', { headers: viaServe() });
    expect(files.status).toBe(401);
    expect(files.json().error).toMatch(/not paired/);
    expect((await raw(port, '/assets/abc.png', { headers: viaServe() })).status).toBe(401);
    expect((await raw(port, '/api/files', { headers: viaServe({ Cookie: '__Host-bogen_phone=made-up-token-made-up-token-made-up-token' }) })).status).toBe(401);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events`, { headers: viaServe() });
    const refused = await new Promise<number>((resolve) => ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(refused).toBe(401);
  });

  it('refuses the wrong login, no login, and the login of a node shared in from elsewhere, token or not', async () => {
    const { h, port } = await boot();
    const { cookie } = await pairPhone(h.base, port);
    const wrong = await raw(port, '/api/files', { headers: viaServe({ Cookie: cookie }, 'someone@example.com') });
    expect(wrong.status).toBe(403);
    expect(wrong.json().error).toMatch(/not allowed/);
    // The shell too: nothing at all for a login that is not on the list.
    expect((await raw(port, '/', { headers: viaServe({}, SHARED_IN) })).status).toBe(403);
    expect((await raw(port, '/api/files', { headers: viaServe({ Cookie: cookie }, SHARED_IN) })).status).toBe(403);
    const page = await raw(port, '/', { headers: viaServe({ Accept: 'text/html' }, SHARED_IN) });
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain(`${SHARED_IN} is not allowed`);
    const { 'Tailscale-User-Login': _drop, ...noLogin } = viaServe({ Cookie: cookie });
    expect((await raw(port, '/api/files', { headers: noLogin })).status).toBe(403);
    expect((await raw(port, '/api/phone/pair', { method: 'POST', headers: viaServe({}, SHARED_IN), body: { code: 'ABCDEFGH' } })).status).toBe(403);
  });

  it('keeps DNS rebinding and other origins out', async () => {
    const { h, port } = await boot();
    const { cookie } = await pairPhone(h.base, port);
    expect((await raw(port, '/api/files', { headers: viaServe({ Cookie: cookie, Host: 'evil.example:29443' }) })).status).toBe(403);
    expect((await raw(port, '/api/files', { headers: viaServe({ Cookie: cookie, Host: '127.0.0.1:29991' }) })).status).toBe(403);
    expect((await raw(port, '/api/files', { headers: viaServe({ Cookie: cookie, Host: `${NAME}:8443` }) })).status).toBe(403);
    expect((await raw(port, '/api/files', { method: 'POST', headers: viaServe({ Cookie: cookie, Origin: 'https://evil.example' }), body: {} })).status).toBe(403);
    expect((await raw(port, '/api/files', { method: 'POST', headers: viaServe({ Cookie: cookie, Origin: `http://${HOST}` }), body: {} })).status).toBe(403);
    // Another app behind tailscale serve on this name is the same site to a browser, and still not us.
    expect((await raw(port, '/api/files', { headers: viaServe({ Cookie: cookie, 'Sec-Fetch-Site': 'same-site' }) })).status).toBe(403);
    expect((await raw(port, '/api/files', { method: 'POST', headers: viaServe({ Cookie: cookie, Origin: `https://${HOST}` }), body: { name: 'From the phone' } })).status).toBe(201);
  });

  it('stops a revoked phone at once, sockets included', async () => {
    const { h, port } = await boot();
    const { cookie, id } = await pairPhone(h.base, port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events`, { headers: viaServe({ Cookie: cookie }) });
    await new Promise((resolve) => ws.once('open', resolve));
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    const removed = await fetch(`${h.base}/api/phone/devices/${id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await closed).toBe(4401);
    expect((await raw(port, '/api/files', { headers: viaServe({ Cookie: cookie }) })).status).toBe(401);
    expect((await raw(port, '/api/phone/me', { headers: viaServe({ Cookie: cookie }) })).json()).toEqual({ paired: false });
  });

  it('lets a paired phone act as the owner in person, and keeps it away from the machine', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'bogen-phone-bin-'));
    writeFileSync(join(bin, 'claude'), '#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("9.9.9 (Fake)"); process.exit(0); }\nprocess.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n');
    chmodSync(join(bin, 'claude'), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const { h, port } = await boot();
      const { cookie } = await pairPhone(h.base, port);
      const as = (extra: Record<string, string> = {}) => viaServe({ Cookie: cookie, Origin: `https://${HOST}`, ...extra });
      const { id: fileId } = (await raw(port, '/api/files', { method: 'POST', headers: as(), body: { name: 'Phone file' } })).json();

      const run = await raw(port, '/api/runs', { method: 'POST', headers: as(), body: { fileId, prompt: 'Make it calmer', runner: 'claude' } });
      expect(run.status).toBe(201);
      const comment = await raw(port, '/api/comments', { method: 'POST', headers: as(), body: { fileId, text: 'Looks good', author: 'M' } });
      expect(comment.status).toBe(201);

      for (const [method, path, body] of [
        ['POST', '/mcp', {}], ['POST', '/api/live/sites', { url: 'http://127.0.0.1:5173', dir: '/tmp' }], ['GET', '/api/peers', undefined],
        ['GET', '/api/phone', undefined], ['POST', '/api/phone/code', {}], ['GET', '/api/config/figma', undefined],
        ['POST', `/api/files/${fileId}/git`, { action: 'log' }], ['POST', '/api/omarchy/reload', {}], ['GET', '/peer', undefined],
      ] as const) {
        const answer = await raw(port, path, { method, headers: as(), body });
        expect(answer.status, `${method} ${path}`).toBe(403);
      }
      // Linking a code project reads this machine's disk: refused by the route itself, as from any other device.
      const link = await raw(port, '/api/code/projects', { method: 'POST', headers: as(), body: { dir: '/home' } });
      expect(link.status).toBe(403);
    } finally {
      process.env.PATH = savedPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('leaves another app\'s port in tailscale serve alone, and removes only its own', async () => {
    const ts = fakeTailscale();
    h = await startServer({ tailscale: ts, phonePort: 0, phoneHttpsPort: 8443 });
    const post = (body: unknown) => fetch(`${h!.base}/api/phone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const taken = await post({ on: true });
    expect(taken.served.state).toBe('taken');
    expect(taken.serve).toBe('taken');
    expect(ts.calls).toEqual([]);
    const off = await post({ on: false });
    expect(off.served.state).toBe('taken');
    expect(ts.calls).toEqual([]);
    expect(ts.config.Web![`${NAME}:8443`]).toBeTruthy();
  });

  it('turns off its own port, and stays off after a restart', async () => {
    const { h: first, ts } = await boot();
    const off = await fetch(`${first.base}/api/phone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) }).then((r) => r.json());
    expect(off).toMatchObject({ on: false, listening: false, serve: 'free', served: { state: 'removed' } });
    expect(ts.calls).toEqual(['serve 29443 http://127.0.0.1:29991', 'off 29443']);
    expect(ts.config.Web![`${NAME}:443`]).toBeTruthy();
    expect(first.server.phone.boundPort).toBe(0);
  });

  it('is closed on the tailnet listener, and only from this machine on loopback', () => {
    expect(isLocalOnlyPath('/api/phone')).toBe(true);
    expect(isLocalOnlyPath('/api/phone/code')).toBe(true);
    expect(phoneRefusedPath('/api/phone/pair')).toBe(false);
    expect(phoneRefusedPath('/api/phone/devices/abc')).toBe(true);
    expect(phoneOpenPath('GET', '/static/index-abc.js')).toBe(true);
    expect(phoneOpenPath('GET', '/assets/abc.png')).toBe(false);
    expect(phoneOpenPath('POST', '/')).toBe(false);
  });
});

describe('the inbox and decisions from the phone', () => {
  it('lists open proposals and comments, and lets the phone accept a proposal', async () => {
    const { h, port } = await boot();
    // This HTTP/auth/decision fixture has fixed dimensions; exercise the declared-geometry fallback.
    // Real Chromium rendering belongs to the sandboxed browser checks, not the CI runner's browser.
    h.server.renderer.launchGuard = () => 'Browser-free phone decision contract';
    const { cookie } = await pairPhone(h.base, port);
    const as = viaServe({ Cookie: cookie, Origin: `https://${HOST}` });
    const agent = await connectAgent(h.base, 'claude');
    const file = await call(agent, 'file_create', { name: 'Landing' });
    const board = await call(agent, 'artboard_create', { name: 'Hero', width: 390, height: 300, file_id: file.id });
    const made = await call(agent, 'proposal_create', { node_id: board.id, notes: ['Larger headline'], file_id: file.id });
    const proposalId = (made.proposals?.[0]?.id ?? made.ids?.[0]) as string;
    await fetch(`${h.base}/api/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: file.id, text: 'Is tomato only for the cursor?', author: 'M' }) });

    const { items } = (await raw(port, '/api/inbox', { headers: as })).json();
    expect(items.map((i: { kind: string }) => i.kind).sort()).toEqual(['comment', 'proposal']);
    expect(items.find((i: { kind: string }) => i.kind === 'proposal')).toMatchObject({ id: proposalId, fileName: 'Landing', of: board.id, by: 'claude', note: 'Larger headline', ofName: 'Hero' });

    const accepted = await raw(port, `/api/files/${file.id}/proposals/${proposalId}/accept`, { method: 'POST', headers: as, body: { who: 'M' } });
    expect(accepted.status).toBe(200);
    expect(accepted.json().nodeId).toBe(board.id);
    expect((await raw(port, '/api/inbox', { headers: as })).json().items.map((i: { kind: string }) => i.kind)).toEqual(['comment']);
    expect((await raw(port, `/api/files/${file.id}/proposals/${proposalId}/discard`, { method: 'POST', headers: as, body: {} })).status).toBe(404);
    expect(isLocalOnlyPath('/api/inbox')).toBe(true);
    expect(isLocalOnlyPath(`/api/files/${file.id}/proposals/x/accept`)).toBe(true);
    expect(h.server.renderer.running).toBe(false);
    await agent.close();
  });
});

describe('tailscale status and the packet filter', () => {
  it('finds the owner and the name, and whether the policy lets a phone in', () => {
    const self = parseTailscaleStatus({
      Self: { DNSName: `${NAME}.`, UserID: 1, TailscaleIPs: ['100.64.0.10'] },
      User: { 1: { LoginName: OWNER }, 2: { LoginName: SHARED_IN } },
      Peer: { a: { HostName: 'localhost', DNSName: 'phone.tail123456.ts.net.', OS: 'iOS', UserID: 1, TailscaleIPs: ['100.64.0.11'] } },
    });
    expect(self).toMatchObject({ dnsName: NAME, ownerLogin: OWNER, peers: [{ os: 'iOS', login: OWNER, dnsName: 'phone.tail123456.ts.net' }] });
    const rules = parsePacketFilter({ PacketFilter: [
      { SrcIPs: ['100.64.0.11'], DstPorts: [{ IP: '100.64.0.10', Ports: { First: 443, Last: 443 } }, { IP: '100.64.0.10', Ports: { First: 8443, Last: 8443 } }], IPProto: [6] },
      { SrcIPs: ['100.64.0.0/10'], DstPorts: [{ IP: '*', Ports: { First: 29000, Last: 29500 } }], IPProto: [17] },
    ] })!;
    expect(filterAllows(rules, ['100.64.0.11'], ['100.64.0.10'], 8443)).toBe(true);
    expect(filterAllows(rules, ['100.64.0.11'], ['100.64.0.10'], 29443)).toBe(false);
    rules[1]!.protos = [6, 17];
    expect(filterAllows(rules, ['100.64.0.11'], ['100.64.0.10'], 29443)).toBe(true);
    expect(parsePacketFilter({})).toBeNull();
    // The client's compiled shape, as a real `tailscale debug netmap` has it next to PacketFilterRules.
    const compiled = parsePacketFilter({ PacketFilter: [
      { Srcs: ['100.64.0.11/32', 'fd7a:115c:a1e0::1111:2222/128'], Dsts: [{ Net: '100.64.0.10/32', Ports: { First: 29443, Last: 29443 } }], IPProto: [6] },
    ] })!;
    expect(filterAllows(compiled, ['100.64.0.11'], ['100.64.0.10'], 29443)).toBe(true);
    expect(filterAllows(compiled, ['100.64.0.13'], ['100.64.0.10'], 29443)).toBe(false);
    expect(phonePolicy(self!, rules, [OWNER], 29443)).toEqual({ checked: true, devices: [{ name: 'phone', os: 'iOS', allowed: true }] });
    expect(phonePolicy(self!, null, [OWNER], 29443).devices[0]!.allowed).toBeNull();
    expect(phonePolicy(self!, rules, [SHARED_IN], 29443).devices).toEqual([]);
  });
});
