import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { qrMatrix } from '@bogen/core';
import { z } from 'zod';
import { filterAllows, type FilterRule, type ServeStatus, type TailnetSelf, type TailscaleCli } from './tailnet.ts';
import { atomicWrite, errorMessage, HttpError } from './util.ts';

/**
 * The phone listener: a third HTTP server, on loopback only, for `tailscale serve` to put on an HTTPS port of
 * this machine's tailnet name. Three things must hold for a request there: it came through Tailscale from a
 * login on the allow list, its Host and Origin are that name, and it carries the token of a paired phone.
 * Only the app shell and the pairing routes do without the token, since a phone has none before it pairs.
 */

export const PHONE_PORT = 29991;
export const PHONE_HTTPS_PORT = 29443;
/** `__Host-` makes the browser insist on Secure, Path=/ and no Domain, so no other name can set or read it. */
export const PHONE_COOKIE = '__Host-bogen_phone';

const CODE_TTL_MS = 10 * 60_000;
const CODE_TRIES = 5;
/** No 0, O, 1, I or L: the code is read off a screen and typed on a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const COOKIE_MAX_AGE = 400 * 86_400;
const SELF_REFRESH_MS = 5 * 60_000;
const SEEN_SAVE_MS = 60_000;

/** A short code to pair a phone with, without bias, as `ABCD-EFGH` with `formatCode`. */
export function newPairingCode(random: (n: number) => Uint8Array = randomBytes): string {
  // 248 is the largest multiple of 31 under 256, so every letter is equally likely.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const byte of random(16)) {
      if (byte < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return out;
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** What someone typed, as the code it means: case, spaces and dashes do not matter. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

const Device = z.object({
  id: z.string().regex(/^[a-f0-9]{8}$/), name: z.string().min(1).max(60), hash: z.string().regex(/^[a-f0-9]{64}$/),
  login: z.string().max(200), pairedAt: z.number(), seenAt: z.number().nullable(),
});
export type PhoneDevice = z.output<typeof Device>;

const Settings = z.object({
  on: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(PHONE_PORT),
  httpsPort: z.number().int().min(1).max(65535).default(PHONE_HTTPS_PORT),
  /** Unset means the login that owns this node. */
  logins: z.array(z.string().min(1).max(200)).optional(),
  devices: z.array(Device).default([]),
});
type PhoneSettings = z.output<typeof Settings>;

export type PhoneVerdict = { ok: true; device: PhoneDevice | null } | { ok: false; status: number; message: string };

/** Paths a phone may load before it has paired: the app shell, and the routes to pair. Nothing in them is data. */
export function phoneOpenPath(method: string, pathname: string): boolean {
  if (pathname === '/api/phone/pair') return method === 'POST';
  if (pathname === '/api/phone/me') return method === 'GET';
  if (method !== 'GET' && method !== 'HEAD') return false;
  return !/^\/(api|assets|sync|events|mcp|live-mcp|peer)(\/|$)/.test(pathname);
}

/**
 * What a paired phone never reaches, token or not: everything that works on this machine rather than on
 * designs. Its disk, its local network and its configuration. Route code checks `fromThisDevice` for the same
 * things; this list is the second wall, and it also keeps out what has no check of its own, like MCP.
 */
export function phoneRefusedPath(pathname: string): boolean {
  if (/^\/api\/phone\/(pair|me|forget|push|push\/test|hosts)$/.test(pathname)) return false;
  return /^\/(mcp|live-mcp|peer)(\/|$)/.test(pathname)
    || /^\/api\/(peer|peers|phone|live|omarchy|config|code\/pulls|publish|shares)(\/|$)/.test(pathname)
    || /^\/api\/code\/[^/]+\/(stories|tokens)(\/|$)/.test(pathname)
    || /^\/api\/files\/[^/]+\/git(\/|$)/.test(pathname);
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

export function phoneCookie(token: string): string {
  return `${PHONE_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
}

const CLEAR_COOKIE = `${PHONE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

function deviceName(given: string | undefined, userAgent: string | undefined): string {
  const trimmed = given?.trim().slice(0, 60);
  if (trimmed) return trimmed;
  if (/iPad/.test(userAgent ?? '')) return 'iPad';
  if (/iPhone/.test(userAgent ?? '')) return 'iPhone';
  if (/Android/.test(userAgent ?? '')) return 'Android phone';
  return 'Phone';
}

export interface PhoneDeps {
  home: string;
  tailscale: TailscaleCli;
  /** Builds a fresh server for each bind, wired to the shared request handler. */
  createServer: () => Server;
  /** Tests: listen here instead of the saved port. 0 picks a free one. */
  port?: number;
  /** Tests: the HTTPS port the Host header must name. */
  httpsPort?: number;
  changed?: () => void;
  /** A phone was removed: what else belongs to it goes too, such as its notification keys. */
  removed?: (id: string) => void;
  /** Whether a phone gets notifications, for the list of phones. */
  pushOn?: (id: string) => boolean;
}

/** Which of the allowed logins' devices the tailnet policy lets reach the HTTPS port. Null rules: not readable. */
export function phonePolicy(self: TailnetSelf, rules: FilterRule[] | null, logins: string[], httpsPort: number): { checked: boolean; devices: { name: string; os: string; allowed: boolean | null }[] } {
  const own = self.peers.filter((p) => logins.includes(p.login.toLowerCase()));
  // Phones and tablets first: they are what this is for.
  own.sort((a, b) => Number(/ios|android/i.test(b.os)) - Number(/ios|android/i.test(a.os)));
  return {
    checked: Boolean(rules),
    devices: own.map((p) => ({ name: p.dnsName.split('.')[0] || p.name, os: p.os, allowed: rules ? filterAllows(rules, p.ips, self.ips, httpsPort) : null })),
  };
}

/** What to add to the tailnet policy, in both of its syntaxes. Tailscale's own admin console is the only place to change it. */
export function policyHint(logins: string[], ip: string | undefined, httpsPort: number): string[] {
  const src = JSON.stringify(logins.length ? logins : ['<your login>']);
  const dst = ip ?? '<this computer\'s tailnet IP>';
  return [
    `With grants:  {"src": ${src}, "dst": ["${dst}"], "ip": ["tcp:${httpsPort}"]}`,
    `With ACLs:    {"action": "accept", "src": ${src}, "dst": ["${dst}:${httpsPort}"]}`,
  ];
}

/** Who holds the HTTPS port in `tailscale serve`: us, nobody, or another app, whose config is never touched. */
export function serveOwner(config: ServeStatus | null, httpsPort: number, port: number): 'ours' | 'free' | 'taken' | 'unknown' {
  if (!config) return 'unknown';
  const key = String(httpsPort);
  const web = Object.entries(config.Web ?? {}).filter(([host]) => host.endsWith(`:${key}`));
  if (!config.TCP?.[key] && !web.length) return 'free';
  const ours = web.length > 0 && web.every(([, site]) => {
    const handlers = Object.entries(site.Handlers ?? {});
    return handlers.length === 1 && handlers[0]![0] === '/' && handlers[0]![1].Proxy?.replace(/\/$/, '') === `http://127.0.0.1:${port}`;
  });
  return ours ? 'ours' : 'taken';
}

/** The saved setting, read without a server, for `bogen doctor`. */
export function readPhoneSettings(raw: unknown): { on: boolean; port: number; httpsPort: number; logins?: string[]; devices: number } | null {
  const parsed = Settings.safeParse(raw);
  return parsed.success ? { on: parsed.data.on, port: parsed.data.port, httpsPort: parsed.data.httpsPort, logins: parsed.data.logins, devices: parsed.data.devices.length } : null;
}

export interface PhoneStatus {
  on: boolean;
  listening: boolean;
  port: number;
  httpsPort: number;
  /** The address to open on the phone, once Tailscale has said this node's name. */
  url: string | null;
  logins: string[];
  loginsFrom: 'saved' | 'owner' | 'none';
  /** This computer's tailnet addresses. */
  ips: string[];
  /** Who holds the HTTPS port in `tailscale serve`. */
  serve: 'ours' | 'free' | 'taken' | 'unknown';
  devices: (Omit<PhoneDevice, 'hash'> & { push: boolean })[];
  code: { code: string; expiresAt: number } | null;
  policy?: ReturnType<typeof phonePolicy>;
}

export interface ServeOutcome { state: 'added' | 'present' | 'removed' | 'absent' | 'taken' | 'failed'; command: string; message: string }

export class Phone {
  private settings: PhoneSettings = Settings.parse({});
  private server: Server | null = null;
  private self: TailnetSelf | null = null;
  private selfAt = 0;
  private selfLoading: Promise<void> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private code: { code: string; expiresAt: number; tries: number } | null = null;
  private sockets = new Map<string, Set<WebSocket>>();
  private seenDirty = false;
  private seenTimer: NodeJS.Timeout | null = null;
  private write: Promise<void> = Promise.resolve();
  boundPort = 0;

  constructor(private readonly deps: PhoneDeps) {}

  private get path(): string {
    return join(this.deps.home, 'phone.json');
  }

  get httpsPort(): number {
    return this.deps.httpsPort ?? this.settings.httpsPort;
  }

  get target(): string {
    return `http://127.0.0.1:${this.boundPort || this.settings.port}`;
  }

  /** `tailscale serve --bg --https=<port> http://127.0.0.1:<phone port>`, the one command that puts it on the tailnet. */
  get serveCommand(): string {
    return `tailscale serve --bg --https=${this.httpsPort} http://127.0.0.1:${this.settings.port}`;
  }

  get serveOffCommand(): string {
    return `tailscale serve --https=${this.httpsPort} off`;
  }

  async start(): Promise<void> {
    try {
      this.settings = Settings.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`bogen: phone.json was unreadable (${errorMessage(e)}), the phone stays off`);
    }
    if (this.settings.on) await this.bind();
  }

  async close(): Promise<void> {
    if (this.seenTimer) clearTimeout(this.seenTimer);
    if (this.seenDirty) await this.save().catch(() => {});
    await this.unbind();
  }

  private save(): Promise<void> {
    this.seenDirty = false;
    const body = `${JSON.stringify(this.settings, null, 2)}\n`;
    this.write = this.write.catch(() => {}).then(() => atomicWrite(this.path, body, 0o600));
    return this.write;
  }

  private async bind(): Promise<void> {
    if (this.server) return;
    void this.refreshSelf();
    this.refreshTimer = setInterval(() => void this.refreshSelf(true), SELF_REFRESH_MS);
    this.refreshTimer.unref();
    const server = this.deps.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Loopback only. Whatever reaches it from the tailnet comes through `tailscale serve`, which says who sent it.
      server.listen(this.deps.port ?? this.settings.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    }).catch((e) => {
      console.error(`bogen: the phone listener cannot use 127.0.0.1:${this.settings.port}: ${errorMessage(e)}`);
      throw new HttpError(409, `Port ${this.settings.port} on 127.0.0.1 is in use, so the phone listener cannot start.`);
    });
    server.on('error', (e) => console.error(`bogen: phone listener: ${errorMessage(e)}`));
    const address = server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : 0;
    this.server = server;
    this.deps.changed?.();
  }

  private async unbind(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    for (const set of this.sockets.values()) for (const ws of set) ws.terminate();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    this.deps.changed?.();
  }

  /** This node's name and owner. Asked again now and then, and right away when a request finds it missing. */
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

  get logins(): { list: string[]; from: PhoneStatus['loginsFrom'] } {
    if (this.settings.logins?.length) return { list: this.settings.logins.map((l) => l.toLowerCase()), from: 'saved' };
    if (this.self?.ownerLogin) return { list: [this.self.ownerLogin.toLowerCase()], from: 'owner' };
    return { list: [], from: 'none' };
  }

  get listening(): boolean {
    return Boolean(this.server);
  }

  get url(): string | null {
    if (!this.self) return null;
    return this.httpsPort === 443 ? `https://${this.self.dnsName}/` : `https://${this.self.dnsName}:${this.httpsPort}/`;
  }

  async status(withPolicy = false): Promise<PhoneStatus> {
    await this.refreshSelf();
    const { list, from } = this.logins;
    const code = this.code && this.code.expiresAt > Date.now() ? { code: formatCode(this.code.code), expiresAt: this.code.expiresAt } : null;
    const serve = this.serveOwner(await this.deps.tailscale.serveStatus().catch(() => null));
    const policy = withPolicy && this.self ? phonePolicy(this.self, await this.deps.tailscale.packetFilter().catch(() => null), list, this.httpsPort) : undefined;
    return {
      on: this.settings.on, listening: Boolean(this.server), port: this.settings.port, httpsPort: this.httpsPort, url: this.url,
      logins: list, loginsFrom: from, ips: this.self?.ips ?? [], serve, devices: this.settings.devices.map(({ hash: _hash, ...rest }) => ({ ...rest, push: this.deps.pushOn?.(rest.id) ?? false })), code,
      ...(policy ? { policy } : {}),
    };
  }

  /** Turns the listener on or off and saves that. With `serve`, also adds or removes this one port in `tailscale serve`. */
  async setOn(on: boolean, options: { logins?: string[]; serve?: boolean } = {}): Promise<{ status: PhoneStatus; serve: ServeOutcome | null }> {
    if (options.logins) this.settings.logins = options.logins.length ? options.logins : undefined;
    this.settings.on = on;
    await this.save();
    if (on) await this.bind();
    else await this.unbind();
    await this.refreshSelf(true);
    const serve = options.serve === false ? null : on ? await this.serveOn() : await this.serveOff();
    return { status: await this.status(), serve };
  }

  serveOwner(config: ServeStatus | null): 'ours' | 'free' | 'taken' | 'unknown' {
    return serveOwner(config, this.httpsPort, this.settings.port);
  }

  private async serveOn(): Promise<ServeOutcome> {
    const command = this.serveCommand;
    const owner = this.serveOwner(await this.deps.tailscale.serveStatus());
    if (owner === 'ours') return { state: 'present', command, message: `tailscale serve already sends https port ${this.httpsPort} here.` };
    if (owner === 'taken') return { state: 'taken', command, message: `Another app uses https port ${this.httpsPort} in tailscale serve. Bogen leaves it alone. Pick another port with --https-port.` };
    try {
      await this.deps.tailscale.serve(this.httpsPort, `http://127.0.0.1:${this.settings.port}`);
      return { state: 'added', command, message: `tailscale serve now sends https port ${this.httpsPort} here.` };
    } catch (e) {
      return { state: 'failed', command, message: `tailscale serve failed: ${errorMessage(e)}. Run it yourself: ${command}` };
    }
  }

  private async serveOff(): Promise<ServeOutcome> {
    const command = this.serveOffCommand;
    const owner = this.serveOwner(await this.deps.tailscale.serveStatus());
    if (owner === 'free') return { state: 'absent', command, message: `tailscale serve had nothing on https port ${this.httpsPort}.` };
    if (owner === 'taken') return { state: 'taken', command, message: `https port ${this.httpsPort} in tailscale serve belongs to another app now. Bogen left it alone.` };
    try {
      await this.deps.tailscale.serveOff(this.httpsPort);
      return { state: 'removed', command, message: `tailscale serve no longer uses https port ${this.httpsPort}.` };
    } catch (e) {
      return { state: 'failed', command, message: `tailscale serve failed: ${errorMessage(e)}. Run it yourself: ${command}` };
    }
  }

  async setPort(port: number | undefined, httpsPort: number | undefined): Promise<void> {
    if (port === undefined && httpsPort === undefined) return;
    if (this.server) throw new HttpError(409, 'Turn the phone off before changing its ports.');
    if (port !== undefined) this.settings.port = port;
    if (httpsPort !== undefined) this.settings.httpsPort = httpsPort;
    await this.save();
  }

  /** A new code replaces the last one. It works once, for ten minutes, and dies after five wrong tries. */
  newCode(): { code: string; expiresAt: number } {
    const code = newPairingCode();
    this.code = { code, expiresAt: Date.now() + CODE_TTL_MS, tries: 0 };
    return { code: formatCode(code), expiresAt: this.code.expiresAt };
  }

  /** Exchanges a code for a token of this phone's own. Only the hash of the token is kept. */
  async pair(input: string, login: string, name: string | undefined, userAgent: string | undefined): Promise<{ device: PhoneDevice; token: string }> {
    const current = this.code;
    if (!current || current.expiresAt <= Date.now()) {
      this.code = null;
      throw new HttpError(410, 'There is no pairing code right now. On the computer, run: bogen phone pair');
    }
    if (!sameHash(hashToken(normalizeCode(input)), hashToken(current.code))) {
      current.tries++;
      const left = CODE_TRIES - current.tries;
      if (left <= 0) this.code = null;
      throw new HttpError(403, left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That code is not right, and it no longer works. On the computer, run bogen phone pair for a new one.');
    }
    this.code = null;
    const token = randomBytes(32).toString('base64url');
    const device: PhoneDevice = { id: randomBytes(4).toString('hex'), name: deviceName(name, userAgent), hash: hashToken(token), login, pairedAt: Date.now(), seenAt: Date.now() };
    this.settings.devices.push(device);
    await this.save();
    this.deps.changed?.();
    return { device, token };
  }

  /** Revokes a phone: its token stops working at once, and its open sockets close. */
  async revoke(id: string): Promise<PhoneDevice> {
    const device = this.settings.devices.find((d) => d.id === id);
    if (!device) throw new HttpError(404, `No paired phone "${id}". See: bogen phone list`);
    this.settings.devices = this.settings.devices.filter((d) => d !== device);
    await this.save();
    for (const ws of this.sockets.get(id) ?? []) ws.close(4401, 'This phone was removed.');
    this.sockets.delete(id);
    this.deps.removed?.(id);
    this.deps.changed?.();
    return device;
  }

  /** Sockets of a phone, so that removing it also ends them. */
  attach(device: PhoneDevice, ws: WebSocket): void {
    let set = this.sockets.get(device.id);
    if (!set) this.sockets.set(device.id, (set = new Set()));
    set.add(ws);
    ws.once('close', () => set.delete(ws));
  }

  private tokenDevice(req: IncomingMessage, login: string): PhoneDevice | null {
    const auth = req.headers.authorization;
    const token = (auth?.startsWith('Bearer ') ? auth.slice(7) : undefined) ?? cookieValue(req, PHONE_COOKIE);
    if (!token) return null;
    const hash = hashToken(token);
    // A token works with the login that paired it, and with no other.
    const device = this.settings.devices.find((d) => sameHash(d.hash, hash));
    return device && device.login === login ? device : null;
  }

  private noteSeen(device: PhoneDevice): void {
    const now = Date.now();
    if (device.seenAt && now - device.seenAt < SEEN_SAVE_MS) return;
    device.seenAt = now;
    this.seenDirty = true;
    this.seenTimer ??= setTimeout(() => {
      this.seenTimer = null;
      if (this.seenDirty) void this.save().catch(() => {});
    }, SEEN_SAVE_MS);
    this.seenTimer.unref();
  }

  /**
   * Every request and upgrade on the phone listener. The Host must be this node's tailnet name on the HTTPS
   * port, which is what stops DNS rebinding, and a browser's Origin must be that same https origin.
   */
  check(req: IncomingMessage, url: URL): PhoneVerdict {
    if (!this.self) {
      void this.refreshSelf();
      return { ok: false, status: 503, message: 'Bogen does not know its tailnet name yet. Is Tailscale up on the computer?' };
    }
    const host = (req.headers.host ?? '').trim().toLowerCase();
    const allowedHosts = [`${this.self.dnsName}:${this.httpsPort}`, ...(this.httpsPort === 443 ? [this.self.dnsName] : [])];
    if (!allowedHosts.includes(host)) return { ok: false, status: 403, message: 'This Host is not allowed.' };
    const site = req.headers['sec-fetch-site'];
    // Same-site is another port of this name, such as another app behind tailscale serve. Not us.
    if (site === 'cross-site' || site === 'same-site') return { ok: false, status: 403, message: 'Requests from another site are not allowed.' };
    const origin = req.headers.origin;
    if (origin !== undefined && origin.toLowerCase() !== `https://${host}`) return { ok: false, status: 403, message: 'This Origin is not allowed.' };
    const login = String(req.headers['tailscale-user-login'] ?? '').trim().toLowerCase();
    if (!login) return { ok: false, status: 403, message: 'No Tailscale login came with this request. Open Bogen at its https address on the tailnet.' };
    const { list } = this.logins;
    if (!list.includes(login)) return { ok: false, status: 403, message: `The Tailscale login ${login} is not allowed on this Bogen.` };
    const method = req.method ?? 'GET';
    const device = this.tokenDevice(req, login);
    if (device) this.noteSeen(device);
    if (!device && !(phoneOpenPath(method, url.pathname) && !req.headers.upgrade)) {
      return { ok: false, status: 401, message: 'This phone is not paired, or it was removed. Pair it again: on the computer, run bogen phone pair.' };
    }
    return { ok: true, device };
  }

  /** Whether a phone with this id is paired right now. */
  isPaired(id: string): boolean {
    return this.settings.devices.some((d) => d.id === id);
  }

  /** `/api/phone/pair`, `/api/phone/me` and `/api/phone/forget`, the routes a phone itself calls. */
  async handlePhoneRoute(req: IncomingMessage, res: ServerResponse, url: URL, device: PhoneDevice | null, body: () => Promise<Buffer>): Promise<boolean> {
    const send = (status: number, data: unknown, cookie?: string) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) });
      res.end(JSON.stringify(data));
    };
    const method = req.method ?? 'GET';
    if (url.pathname === '/api/phone/me' && method === 'GET') {
      // Answering renews the cookie, so a phone that is used keeps its pairing.
      if (!device) return send(200, { paired: false }, CLEAR_COOKIE), true;
      const cookie = cookieValue(req, PHONE_COOKIE);
      return send(200, { paired: true, id: device.id, name: device.name }, cookie ? phoneCookie(cookie) : undefined), true;
    }
    if (url.pathname === '/api/phone/pair' && method === 'POST') {
      let parsed: { code: string; name?: string };
      try {
        parsed = z.object({ code: z.string().min(1).max(40), name: z.string().max(60).optional() }).parse(JSON.parse((await body()).toString('utf8') || '{}'));
      } catch {
        throw new HttpError(400, 'Send {"code": "..."}.');
      }
      const login = String(req.headers['tailscale-user-login'] ?? '').trim().toLowerCase();
      const { device: paired, token } = await this.pair(parsed.code, login, parsed.name, req.headers['user-agent']);
      return send(201, { paired: true, id: paired.id, name: paired.name }, phoneCookie(token)), true;
    }
    if (url.pathname === '/api/phone/forget' && method === 'POST') {
      if (!device) throw new HttpError(401, 'This phone is not paired.');
      await this.revoke(device.id);
      return send(200, { ok: true }, CLEAR_COOKIE), true;
    }
    return false;
  }

  /** `/api/phone/*` for this machine: the CLI and the desktop editor. Never reachable from a phone. */
  async handleAdmin(req: IncomingMessage, res: ServerResponse, parts: string[], json: <T>(schema: z.ZodType<T>) => Promise<T>): Promise<void> {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const [, b, c] = parts;
    const method = req.method ?? 'GET';
    const policy = new URL(req.url ?? '/', 'http://x').searchParams.has('policy');
    if (!b && method === 'GET') return send(200, { ...(await this.status(policy)), serveCommand: this.serveCommand, serveOffCommand: this.serveOffCommand });
    if (!b && method === 'POST') {
      const body = await json(z.object({
        on: z.boolean(), logins: z.array(z.string().trim().min(3).max(200)).max(20).optional(), serve: z.boolean().optional(),
        port: z.number().int().min(1024).max(65535).optional(), httpsPort: z.number().int().min(1).max(65535).optional(),
      }));
      if (body.on) await this.setPort(body.port, body.httpsPort);
      const result = await this.setOn(body.on, { logins: body.logins, serve: body.serve });
      return send(200, { ...(policy ? await this.status(true) : result.status), served: result.serve, serveCommand: this.serveCommand, serveOffCommand: this.serveOffCommand });
    }
    if (b === 'code' && method === 'POST') {
      if (!this.settings.on) throw new HttpError(409, 'The phone is off. Turn it on first: bogen phone on');
      const pair = { ...this.newCode(), url: (await this.status()).url };
      // `?qr` adds the code's link as rows of 0 and 1, for a client with no QR encoder of its own: the Omarchy bar widget.
      const link = pair.url ? `${pair.url}#/pair/${pair.code}` : null;
      const qr = link && new URL(req.url ?? '/', 'http://x').searchParams.has('qr') ? { link, qr: qrMatrix(link).map((row) => row.map((on) => (on ? '1' : '0')).join('')) } : {};
      return send(201, { ...pair, ...qr });
    }
    if (b === 'devices' && c && method === 'DELETE') {
      const gone = await this.revoke(decodeURIComponent(c));
      return send(200, { removed: gone.id, name: gone.name });
    }
    throw new HttpError(404, 'No such route.');
  }

  /** A refusal a person can read, for a page load; JSON for everything else. */
  static refuse(req: IncomingMessage, res: ServerResponse, status: number, message: string): void {
    if (/text\/html/.test(String(req.headers.accept ?? '')) && !/^\/api\//.test(req.url ?? '')) {
      const safe = message.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bogen</title><body style="font:17px system-ui;margin:32px;max-width:520px;background:#f4f2ec;color:#0e0e0c"><h1 style="font-size:20px">Bogen cannot open here</h1><p>${safe}</p>`);
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: message }));
  }
}
