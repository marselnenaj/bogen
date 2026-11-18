import http from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EgressProxy, egressArgs, type Resolve } from '../src/egress-proxy.ts';
import { isPrivateAddress } from '../src/net-guard.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function site(): Promise<number> {
  const server = http.createServer((req, res) => res.end(`hello ${req.headers.host} ${req.url}`));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

async function proxy(resolve: Resolve): Promise<EgressProxy> {
  const p = new EgressProxy({ resolve });
  await p.start();
  closers.push(() => p.close());
  return p;
}

/** Sends CONNECT host:port and answers the proxy's status code. */
function tunnel(proxyPort: number, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1');
    socket.on('error', reject);
    socket.once('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once('data', (chunk) => {
      socket.destroy();
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(chunk.toString('latin1'))?.[1] ?? 0));
    });
  });
}

/** A plain proxied GET, as Chromium sends for http:// URLs. */
function proxiedGet(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: url, method: 'GET', headers: { Host: new URL(url).host } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const names: Record<string, string[]> = {
  'rebind.test': ['127.0.0.1'],
  'mixed.test': ['93.184.216.34', '10.0.0.7'],
  'public.test': ['93.184.216.34'],
  'compat.test': ['::127.0.0.1'],
  'nat64.test': ['64:ff9b:1::a00:1'],
};
const fake: Resolve = async (host) => (names[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('the browser egress proxy', () => {
  it('reaches a port of this computer only while a capture has it open', async () => {
    const port = await site();
    const p = await proxy(fake);
    expect(await tunnel(p.port, `127.0.0.1:${port}`)).toBe(403);
    expect(await tunnel(p.port, `localhost:${port}`)).toBe(403);
    expect((await proxiedGet(p.port, `http://localhost:${port}/a`)).status).toBe(403);

    const release = p.allowLocal(port);
    const again = p.allowLocal(port);
    expect(await tunnel(p.port, `127.0.0.1:${port}`)).toBe(200);
    const got = await proxiedGet(p.port, `http://localhost:${port}/a?b=1`);
    expect(got).toEqual({ status: 200, body: `hello localhost:${port} /a?b=1` });
    // Another port stays closed.
    expect(await tunnel(p.port, `127.0.0.1:${port === 65535 ? 1 : port + 1}`)).toBe(403);

    release();
    release();
    expect(await tunnel(p.port, `127.0.0.1:${port}`)).toBe(200);
    again();
    expect(await tunnel(p.port, `127.0.0.1:${port}`)).toBe(403);
  });

  it('refuses names that resolve to a private address, even once among public ones', async () => {
    const port = await site();
    const p = await proxy(fake);
    p.allowLocal(port);
    // A public name that points at this computer is not a page of this computer.
    for (const host of ['mixed.test', 'compat.test', 'nat64.test', 'nothing.test', '10.0.0.1', '[::1]', '169.254.169.254', '[fd00::1]']) {
      expect(await tunnel(p.port, `${host}:443`), host).toBe(403);
    }
    await expect(p.destination('mixed.test', 443)).rejects.toThrow(/private/);
    await expect(p.destination('public.test', 22)).rejects.toThrow(/not reached/);
    await expect(p.destination('public.test', 443)).resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('checks a name once and connects to the address it checked', async () => {
    const port = await site();
    const asked: string[] = [];
    // A rebinding resolver: the first answer is what gets checked, the second would point elsewhere.
    let calls = 0;
    const p = await proxy(async (host) => {
      asked.push(host);
      calls++;
      return [{ address: calls === 1 ? '127.0.0.1' : '10.9.9.9', family: 4 }];
    });
    p.allowLocal(port);
    const got = await proxiedGet(p.port, `http://pinned.test:${port}/x`);
    expect(got.status).toBe(200);
    expect(got.body).toBe(`hello pinned.test:${port} /x`);
    expect(asked).toEqual(['pinned.test']);
  });

  it('does not forward https as a plain request, credentials, or a bare upgrade', async () => {
    const p = await proxy(fake);
    expect((await proxiedGet(p.port, 'https://public.test/')).status).toBe(403);
    expect((await proxiedGet(p.port, 'http://user:pw@public.test/')).status).toBe(403);
    expect(await tunnel(p.port, 'public.test')).toBe(400);
    const status = await new Promise<number>((resolve, reject) => {
      const socket = connect(p.port, '127.0.0.1');
      socket.on('error', reject);
      socket.once('connect', () => socket.write('GET ws://public.test/ HTTP/1.1\r\nHost: public.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
      socket.once('data', (c) => { socket.destroy(); resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(c.toString('latin1'))?.[1] ?? 0)); });
    });
    expect(status).toBe(403);
  });

  it('gives Chromium switches that keep it to the proxy', () => {
    expect(egressArgs(4321)).toEqual(expect.arrayContaining(['--proxy-server=http://127.0.0.1:4321', '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic']));
    // The secure-chromium wrapper brings its own proxy and refuses --proxy-*.
    expect(egressArgs(null).some((a) => a.startsWith('--proxy'))).toBe(false);
    expect(egressArgs(null)).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  });
});

describe('private address ranges', () => {
  it.each(['::127.0.0.1', '::a00:1', '64:ff9b:1::a00:1', '2001::1', '3fff::1', '5f00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(['2001:4860:4860::8888', '2606:4700:4700::1111', '64:ff9b::808:808'])('%s is public', (ip) => {
    // 64:ff9b::/96 is the well-known NAT64 prefix; it stays refused as before.
    expect(isPrivateAddress(ip)).toBe(ip.startsWith('64:ff9b::'));
  });
});

describe('fetching for a page of this computer', () => {
  it('reaches this computer with limits, and follows no redirect away from it', async () => {
    const { fetchPublic } = await import('../src/net-guard.ts');
    const server = http.createServer((req, res) => {
      if (req.url === '/away') return void res.writeHead(302, { Location: 'http://10.0.0.1/x' }).end();
      if (req.url === '/public') return void res.writeHead(302, { Location: 'https://example.com/' }).end();
      if (req.url === '/home') return void res.writeHead(302, { Location: '/font.woff2' }).end();
      if (req.url === '/big') return void res.end(Buffer.alloc(2048));
      res.end('font');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(Buffer.from((await fetchPublic(`${base}/font.woff2`, { onlyLoopback: true })).bytes).toString()).toBe('font');
    expect(Buffer.from((await fetchPublic(`${base}/home`, { onlyLoopback: true })).bytes).toString()).toBe('font');
    await expect(fetchPublic(`${base}/away`, { onlyLoopback: true })).rejects.toThrow(/not this computer/);
    await expect(fetchPublic(`${base}/public`, { onlyLoopback: true })).rejects.toThrow(/not this computer/);
    await expect(fetchPublic(`${base}/big`, { onlyLoopback: true, maxBytes: 1024 })).rejects.toThrow(/larger/);
    await expect(fetchPublic('http://192.168.1.1/', { onlyLoopback: true })).rejects.toThrow(/not this computer/);
    // Without the option, this computer is refused as before.
    await expect(fetchPublic(`${base}/font.woff2`)).rejects.toThrow(/private/);
  });
});
