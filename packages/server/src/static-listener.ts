import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { z } from 'zod';
import { keepToOwnUser } from './local-user.ts';
import { serveOwner } from './phone.ts';
import type { ServeStatus, TailnetSelf, TailscaleCli } from './tailnet.ts';
import { atomicWrite, errorMessage, HttpError } from './util.ts';

/**
 * A listener for static files only: published sites and review links. Each one is its own HTTP server on
 * loopback, which `tailscale serve` puts on one HTTPS port of this machine's tailnet name, and `tailscale
 * funnel` on the internet when the owner asks for that. It shares nothing with the other listeners: no API, no
 * WebSocket, no cookie, no session. It answers GET and HEAD of files, and POST only where its handler takes one.
 */

/** The ports Tailscale Funnel can use. Any port works on the tailnet. */
export const FUNNEL_PORTS = [443, 8443, 10000];

const SELF_REFRESH_MS = 5 * 60_000;

const Settings = z.object({
  on: z.boolean().default(false),
  public: z.boolean().default(false),
  port: z.number().int().min(1024).max(65535),
  httpsPort: z.number().int().min(1).max(65535),
});
type ListenerSettings = z.output<typeof Settings>;

export interface StaticListenerStatus {
  kind: string;
  on: boolean;
  /** Funnel is wanted: the site is public on the internet. */
  public: boolean;
  listening: boolean;
  port: number;
  httpsPort: number;
  url: string | null;
  /** Who holds the HTTPS port in `tailscale serve`. */
  serve: 'ours' | 'free' | 'taken' | 'unknown';
  /** Our entry is open to the internet right now. */
  funnel: boolean;
  /** Whether the tailnet policy lets this node use Funnel. Null when Tailscale does not say. */
  funnelAllowed: boolean | null;
}

export interface ListenerOutcome { state: 'added' | 'present' | 'removed' | 'absent' | 'taken' | 'failed' | 'refused'; command: string; message: string }

/** What the gate found out about a request that passed it. */
export interface Gate {
  url: URL;
  /** `https://<name>[:port]`, the origin a form of ours posts from. */
  origin: string;
  /** The decoded path, as segments that are each safe to use as a file name. */
  segments: string[];
  /** Whether the path ended in `/`. */
  dir: boolean;
  /** The client's address as `tailscale serve` passed it on, for rate limits. Never logged. */
  ip: string;
}

export interface StaticListenerDeps {
  kind: 'site' | 'review';
  settingsPath: string;
  defaults: { port: number; httpsPort: number };
  tailscale: TailscaleCli;
  /** Tests: listen here instead of the saved port. 0 picks a free one. */
  port?: number;
  /** Tests: the HTTPS port the Host header must name. */
  httpsPort?: number;
  /** Paths where a POST is taken. Everything else is GET and HEAD only. */
  postAllowed?: (segments: string[]) => boolean;
  handle: (req: IncomingMessage, res: ServerResponse, gate: Gate) => Promise<void>;
  changed?: () => void;
  /** Tests: the user this server counts as its own. */
  uid?: number;
}

/**
 * A request path as file names: decoded once, and refused when it is anything but plain segments. No `..` or `.`,
 * no empty segment, no hidden name, no backslash, no NUL, no encoded slash, and nothing still encoded after one
 * decoding, which is how double encoding slips past a check.
 */
export function safeSegments(rawPath: string): { segments: string[]; dir: boolean } | null {
  if (!rawPath.startsWith('/') || rawPath.length > 1024) return null;
  if (/%(2f|5c|00|2e)/i.test(rawPath)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (/[\\\0%\u0000-\u001f\u007f]/.test(decoded)) return null;
  const dir = decoded.endsWith('/');
  const parts = decoded.split('/').slice(1);
  if (dir) parts.pop();
  if (parts.some((p) => p === '' || p.startsWith('.') || p.length > 200)) return null;
  return { segments: parts, dir };
}

/** Headers every answer of these listeners carries. No cookie, ever. */
export function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Only reachable through tailscale serve or Funnel, which speak HTTPS.
    'Strict-Transport-Security': 'max-age=31536000',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    ...extra,
  };
}

export function refuseText(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox" }));
  res.end(`${message}\n`);
}

/** What to put in the tailnet policy so that this node may use Funnel. Only the tailnet's admin can change it. */
export function funnelPolicyHint(login: string | undefined): string[] {
  const target = JSON.stringify([login || '<your login>']);
  return [
    `"nodeAttrs": [{"target": ${target}, "attr": ["funnel"]}]`,
    'and HTTPS certificates turned on under DNS in the Tailscale admin console.',
  ];
}

export class StaticListener {
  private settings: ListenerSettings;
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private self: TailnetSelf | null = null;
  private selfAt = 0;
  private selfLoading: Promise<void> | null = null;
  private write: Promise<void> = Promise.resolve();
  boundPort = 0;

  constructor(private readonly deps: StaticListenerDeps) {
    this.settings = { on: false, public: false, ...deps.defaults };
  }

  get kind(): string {
    return this.deps.kind;
  }

  get httpsPort(): number {
    return this.deps.httpsPort ?? this.settings.httpsPort;
  }

  private get target(): string {
    return `http://127.0.0.1:${this.boundPort || this.settings.port}`;
  }

  private get targetPort(): number {
    return this.boundPort || this.settings.port;
  }

  get serveCommand(): string {
    return `tailscale ${this.settings.public ? 'funnel' : 'serve'} --bg --https=${this.httpsPort} ${this.target}`;
  }

  get url(): string | null {
    if (!this.self) return null;
    return this.httpsPort === 443 ? `https://${this.self.dnsName}/` : `https://${this.self.dnsName}:${this.httpsPort}/`;
  }

  get origin(): string | null {
    return this.url?.replace(/\/$/, '') ?? null;
  }

  get ownerLogin(): string | undefined {
    return this.self?.ownerLogin;
  }

  async start(): Promise<void> {
    try {
      this.settings = Settings.parse({ ...this.deps.defaults, ...JSON.parse(await readFile(this.deps.settingsPath, 'utf8')) });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`bogen: the ${this.deps.kind} listener's settings were unreadable (${errorMessage(e)}), it stays off`);
      this.settings = { on: false, public: false, ...this.deps.defaults };
    }
    if (this.settings.on) await this.bind().catch((e) => console.error(`bogen: the ${this.deps.kind} listener is off: ${errorMessage(e)}`));
  }

  async close(): Promise<void> {
    await this.unbind();
  }

  private save(): Promise<void> {
    const body = `${JSON.stringify(this.settings, null, 2)}\n`;
    this.write = this.write.catch(() => {}).then(() => atomicWrite(this.deps.settingsPath, body, 0o600));
    return this.write;
  }

  private async bind(): Promise<void> {
    if (this.server) return;
    void this.refreshSelf();
    const server = createServer((req, res) => void this.onRequest(req, res));
    // No WebSocket of any kind: an upgrade is dropped before anything reads it.
    server.on('upgrade', (_req, socket) => {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    });
    // tailscale serve connects as root. Another user of this machine could otherwise pose as it.
    keepToOwnUser(server, undefined, this.deps.uid);
    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    const port = this.deps.port ?? this.settings.port;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    }).catch((e) => {
      throw new HttpError(409, `Port ${port} on 127.0.0.1 is in use, so the ${this.deps.kind} listener cannot start (${errorMessage(e)}).`);
    });
    server.on('error', (e) => console.error(`bogen: ${this.deps.kind} listener: ${errorMessage(e)}`));
    const address = server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : 0;
    this.server = server;
    this.deps.changed?.();
  }

  private async unbind(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    });
    this.deps.changed?.();
  }

  refreshSelf(force = false): Promise<void> {
    if (!force && this.self && Date.now() - this.selfAt < SELF_REFRESH_MS) return Promise.resolve();
    if (!force && !this.self && Date.now() - this.selfAt < 10_000) return Promise.resolve();
    this.selfLoading ??= this.deps.tailscale.self().catch(() => null).then((self) => {
      this.selfAt = Date.now();
      if (self) this.self = self;
    }).finally(() => {
      this.selfLoading = null;
    });
    return this.selfLoading;
  }

  private funnelOn(config: ServeStatus | null): boolean {
    const key = String(this.httpsPort);
    return Object.entries(config?.AllowFunnel ?? {}).some(([host, on]) => on && host.endsWith(`:${key}`));
  }

  async status(): Promise<StaticListenerStatus> {
    await this.refreshSelf();
    const config = await this.deps.tailscale.serveStatus().catch(() => null);
    const serve = serveOwner(config, this.httpsPort, this.targetPort);
    return {
      kind: this.deps.kind, on: this.settings.on, public: this.settings.public, listening: Boolean(this.server),
      port: this.settings.port, httpsPort: this.httpsPort, url: this.url, serve, funnel: serve === 'ours' && this.funnelOn(config),
      funnelAllowed: this.self?.funnel ?? null,
    };
  }

  /**
   * Turns the listener on or off, and on the tailnet or the internet. Only this one HTTPS port is ever added to or
   * taken from Tailscale's config: an entry that is not ours, on this port or any other, is left as it is.
   */
  async set(on: boolean, options: { public?: boolean; httpsPort?: number } = {}): Promise<{ status: StaticListenerStatus; outcome: ListenerOutcome | null }> {
    const wantPublic = on && (options.public ?? this.settings.public);
    if (options.httpsPort !== undefined && options.httpsPort !== this.settings.httpsPort) {
      if (this.server) throw new HttpError(409, `Turn the ${this.deps.kind} listener off before changing its port.`);
      this.settings.httpsPort = options.httpsPort;
    }
    if (wantPublic) {
      await this.refreshSelf(true);
      if (!FUNNEL_PORTS.includes(this.httpsPort)) throw new HttpError(409, `Funnel only works on HTTPS port 443, 8443 or 10000, not ${this.httpsPort}. Pick one of them first.`);
      if (!this.deps.tailscale.funnel || !this.deps.tailscale.funnelOff) throw new HttpError(409, 'This Tailscale cannot turn Funnel on.');
      if (this.self?.funnel === false) throw new HttpError(409, `Your tailnet policy does not let this computer use Funnel yet. Add to it: ${funnelPolicyHint(this.self.ownerLogin).join(' ')}`);
    }
    this.settings.on = on;
    this.settings.public = wantPublic;
    await this.save();
    if (on) await this.bind();
    await this.refreshSelf(true);
    const outcome = await this.apply(on, wantPublic);
    if (!on) await this.unbind();
    return { status: await this.status(), outcome };
  }

  private async apply(on: boolean, wantPublic: boolean): Promise<ListenerOutcome> {
    const ts = this.deps.tailscale;
    const command = on ? `tailscale ${wantPublic ? 'funnel' : 'serve'} --bg --https=${this.httpsPort} ${this.target}` : `tailscale serve --https=${this.httpsPort} off`;
    let config: ServeStatus | null;
    try {
      config = await ts.serveStatus();
    } catch {
      config = null;
    }
    const owner = serveOwner(config, this.httpsPort, this.targetPort);
    if (owner === 'unknown') return { state: 'failed', command, message: `Bogen cannot read tailscale serve's config, so it changed nothing there. Run it yourself: ${command}` };
    if (owner === 'taken') return { state: 'taken', command, message: `Another app uses HTTPS port ${this.httpsPort} in tailscale serve. Bogen leaves it alone. Pick another port.` };
    const funnel = owner === 'ours' && this.funnelOn(config);
    try {
      if (!on) {
        if (owner === 'free') return { state: 'absent', command, message: `tailscale serve had nothing on HTTPS port ${this.httpsPort}.` };
        if (funnel) await ts.funnelOff!(this.httpsPort);
        else await ts.serveOff(this.httpsPort);
        return { state: 'removed', command, message: `HTTPS port ${this.httpsPort} is no longer served${funnel ? ', and no longer public' : ''}.` };
      }
      if (owner === 'ours' && funnel === wantPublic) return { state: 'present', command, message: `HTTPS port ${this.httpsPort} already comes here${funnel ? ', public through Funnel' : ', on the tailnet only'}.` };
      // Ours, but the other way round: take our entry away first, then add it as wanted.
      if (owner === 'ours') {
        if (funnel) await ts.funnelOff!(this.httpsPort);
        else await ts.serveOff(this.httpsPort);
      }
      if (wantPublic) await ts.funnel!(this.httpsPort, this.target);
      else await ts.serve(this.httpsPort, this.target);
      return { state: 'added', command, message: wantPublic ? `HTTPS port ${this.httpsPort} is now public on the internet through Funnel.` : `HTTPS port ${this.httpsPort} now comes here, on the tailnet only.` };
    } catch (e) {
      return { state: 'failed', command, message: `tailscale failed: ${errorMessage(e)}. Run it yourself: ${command}` };
    }
  }

  /**
   * Every request. The Host must be this node's tailnet name on the HTTPS port, which stops DNS rebinding; on the
   * tailnet only, tailscale serve must have said who is asking; a POST must come from a page of this origin.
   */
  check(req: IncomingMessage): { ok: true; gate: Gate } | { ok: false; status: number; message: string } {
    if (!this.self) {
      void this.refreshSelf();
      return { ok: false, status: 503, message: 'Not ready.' };
    }
    const host = (req.headers.host ?? '').trim().toLowerCase();
    const allowed = [`${this.self.dnsName}:${this.httpsPort}`, ...(this.httpsPort === 443 ? [this.self.dnsName] : [])];
    if (!allowed.includes(host)) return { ok: false, status: 403, message: 'This Host is not allowed.' };
    const method = req.method ?? 'GET';
    if (req.headers.upgrade) return { ok: false, status: 403, message: 'No WebSockets here.' };
    const raw = (req.url ?? '/').split('?')[0]!.split('#')[0]!;
    const path = safeSegments(raw);
    if (!path) return { ok: false, status: 404, message: 'Not found.' };
    if (method === 'POST') {
      if (!this.deps.postAllowed?.(path.segments)) return { ok: false, status: 405, message: 'Only GET and HEAD.' };
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      // No cookie is ever set here, so this is about forms on other sites posting into ours.
      if (!origin || origin.toLowerCase() !== `https://${host}` || (site !== undefined && site !== 'same-origin')) return { ok: false, status: 403, message: 'Comments are only taken from this page.' };
    } else if (method !== 'GET' && method !== 'HEAD') return { ok: false, status: 405, message: 'Only GET and HEAD.' };
    // On the tailnet only, everything comes through tailscale serve, which names the login. Funnel traffic does not.
    const login = String(req.headers['tailscale-user-login'] ?? '').trim();
    if (!this.settings.public && !login) return { ok: false, status: 403, message: 'This is only open on the tailnet.' };
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const url = new URL(raw, `https://${host}`);
    return { ok: true, gate: { url, origin: `https://${host}`, segments: path.segments, dir: path.dir, ip: forwarded.at(-1) || 'unknown' } };
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const verdict = this.check(req);
      if (!verdict.ok) return refuseText(res, verdict.status, verdict.message);
      await this.deps.handle(req, res, verdict.gate);
    } catch (e) {
      // Never the path: on the review listener it holds a link's token.
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(`bogen: ${this.deps.kind} listener: ${errorMessage(e)}`);
      refuseText(res, status, status === 500 ? 'Something went wrong.' : errorMessage(e));
    }
  }
}
