import { lookup as dnsLookup } from 'node:dns/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { isPrivateAddress } from './net-guard.ts';

/**
 * The headless browser's only way out. Chromium is started with `--proxy-server` pointing here, so it never resolves a
 * name itself: this proxy resolves it, refuses private, loopback and reserved answers, and connects to the very
 * address it checked. A page can therefore not point its own name at 127.0.0.1 between the check in request
 * interception and Chromium's own lookup (DNS rebinding), and WebSockets, which interception never sees, go through
 * the same check, because Chromium tunnels them with CONNECT.
 *
 * A port of this computer is reached only while a capture the person asked for on this machine has it open
 * (`allowLocal`), as `--secure-local-port` does for the secure-chromium wrapper, which brings a proxy of its own and
 * is left to it.
 */

export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;

export interface EgressProxyOptions {
  /** For tests: what a name resolves to. */
  resolve?: Resolve;
  /** Ports a public address may be reached on. */
  publicPorts?: ReadonlySet<number>;
  /** Most tunnels and requests open at once. */
  maxConnections?: number;
  idleMs?: number;
}

const PUBLIC_PORTS: ReadonlySet<number> = new Set([80, 443, 8080, 8443]);
const LOOPBACK_NAMES = new Set(['localhost', 'localhost.']);
const HOP_HEADERS = new Set(['proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

const realResolve: Resolve = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

function isLoopback(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  return /^127\./.test(bare) || bare === '::1' || /^::ffff:127\./i.test(bare);
}

export class EgressRefused extends Error {}

export class EgressProxy {
  private server: http.Server | null = null;
  private readonly localPorts = new Map<number, number>();
  private readonly open = new Set<Socket | Duplex>();
  private readonly resolve: Resolve;
  private readonly publicPorts: ReadonlySet<number>;
  private readonly maxConnections: number;
  private readonly idleMs: number;
  port = 0;

  constructor(options: EgressProxyOptions = {}) {
    this.resolve = options.resolve ?? realResolve;
    this.publicPorts = options.publicPorts ?? PUBLIC_PORTS;
    this.maxConnections = options.maxConnections ?? 256;
    this.idleMs = options.idleMs ?? 60_000;
  }

  /** Lets the browser reach this computer's `port` until the returned function is called. Counted, so overlapping captures share it. */
  allowLocal(port: number): () => void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return () => {};
    this.localPorts.set(port, (this.localPorts.get(port) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.localPorts.get(port) ?? 1) - 1;
      if (left > 0) this.localPorts.set(port, left);
      else this.localPorts.delete(port);
    };
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    const server = http.createServer((req, res) => void this.forward(req, res));
    server.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => void this.tunnel(req, socket, head));
    // Chromium tunnels ws:// through CONNECT as well; an upgrade sent here as a plain request is not something it does.
    server.on('upgrade', (_req, socket: Duplex) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
    server.on('clientError', (_err, socket) => socket.destroy());
    server.maxConnections = this.maxConnections;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.open) socket.destroy();
    this.open.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The address to connect to for host:port, checked once and used as checked. */
  async destination(host: string, port: number): Promise<{ address: string; family: number }> {
    const name = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (!name || !Number.isInteger(port) || port < 1 || port > 65535) throw new EgressRefused('Invalid destination.');
    const literal = isIP(name);
    // localhost is this computer whatever a resolver says, and is never looked up.
    const answers = literal ? [{ address: name, family: literal }] : LOOPBACK_NAMES.has(name) ? [{ address: '127.0.0.1', family: 4 }] : await this.resolve(name).catch(() => []);
    if (!answers.length) throw new EgressRefused(`${name} does not resolve.`);
    const local = LOOPBACK_NAMES.has(name) || answers.every((a) => isLoopback(a.address));
    if (local) {
      if (!this.localPorts.has(port)) throw new EgressRefused(`Port ${port} of this computer is not shared with this page.`);
      return answers.find((a) => isLoopback(a.address))!;
    }
    // One private answer among public ones refuses the name: which one Chromium would pick is not ours to guess.
    if (answers.some((a) => isPrivateAddress(a.address))) throw new EgressRefused(`${name} resolves to a private address.`);
    if (!this.publicPorts.has(port)) throw new EgressRefused(`Port ${port} is not reached on the internet.`);
    return answers[0]!;
  }

  private track<T extends Socket | Duplex>(socket: T): T {
    this.open.add(socket);
    socket.once('close', () => this.open.delete(socket));
    if ('setTimeout' in socket && typeof socket.setTimeout === 'function') socket.setTimeout(this.idleMs, () => socket.destroy());
    return socket;
  }

  private async tunnel(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    this.track(client);
    client.on('error', () => client.destroy());
    const m = /^(\[[0-9a-fA-F:.]+\]|[^:\s/]+):(\d{1,5})$/.exec(req.url ?? '');
    if (!m) return void client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    let to: { address: string; family: number };
    try {
      to = await this.destination(m[1]!, Number(m[2]));
    } catch {
      return void client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    }
    const upstream = this.track(connect({ host: to.address, port: Number(m[2]), family: to.family }));
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  }

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== 'http:' || target.username || target.password) {
      res.writeHead(403).end();
      return;
    }
    const port = Number(target.port) || 80;
    let to: { address: string; family: number };
    try {
      to = await this.destination(target.hostname, port);
    } catch {
      res.writeHead(403).end();
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) if (!HOP_HEADERS.has(key) && value !== undefined) headers[key] = value;
    headers.host = target.host;
    const upstream = http.request({ host: to.address, family: to.family, port, method: req.method, path: `${target.pathname}${target.search}`, headers, timeout: this.idleMs }, (answer) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(answer.headers)) if (!HOP_HEADERS.has(key) && value !== undefined) out[key] = value;
      res.writeHead(answer.statusCode ?? 502, out);
      answer.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }
}

/**
 * Switches that keep the browser to the proxy above. With a proxy set, Chromium does not resolve names itself, QUIC
 * would leave the proxy, and WebRTC could send UDP around it.
 */
export function egressArgs(proxyPort: number | null): string[] {
  const always = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic', '--dns-prefetch-disable'];
  return proxyPort ? [`--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>', ...always] : always;
}
