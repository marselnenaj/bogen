import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { isRunnerId, runnerLabel } from '@bogen/core';
import type { FileEvent, FileEvents } from './file-events.ts';
import type { PhoneDevice } from './phone.ts';
import type { Storage } from './storage.ts';
import { atomicWrite, errorMessage, HttpError } from './util.ts';

/**
 * Notifications on a paired phone, through Web Push: the phone's browser gives an address at its push service
 * (Apple's, for an iPhone), and this computer sends small encrypted messages there, which the push service
 * passes on to the phone. RFC 8030 for the protocol, RFC 8292 (VAPID) for who sends, RFC 8291 for the
 * encryption, all with node:crypto. Only the phone can read what is sent; the push service sees that a
 * message of some size went from this computer to that phone, and when.
 *
 * What a message says: what happened in a few words, the name of the file, and where in the app to open.
 * Never what a comment, a prompt, an answer or a layer says.
 */

export type PushKind = 'run' | 'comment' | 'proposal';
export const PUSH_KINDS: readonly PushKind[] = ['run', 'comment', 'proposal'];

/** What reaches the phone, encrypted. The service worker shows `title` and `body` and opens `url` on a tap. */
export interface PushPayload { title: string; body: string; url: string; tag: string; kind: PushKind | 'test' }

/** A push service a phone may name. Anything else would make this computer send requests where a page says. */
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
/** What the VAPID claim says who sends. Apple wants a mailto: or an https address; this one says nothing about the computer. */
const DEFAULT_SUBJECT = 'https://github.com/marselnenaj/bogen';
const TTL_SECONDS = 24 * 3600;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT = 20;
/** Proposals made outside a run, such as by an agent in a terminal, come in bursts: three directions are one message. */
const SETTLE_MS = 2500;
const NAME_LIMIT = 80;

export function pushHostAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443') && PUSH_HOSTS.some((re) => re.test(url.hostname));
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const unb64url = (text: string) => Buffer.from(text, 'base64url');

/** A JSON Web Key as createPrivateKey takes it; taken from its signature because the Node types moved the name between versions. */
type Jwk = Extract<Parameters<typeof createPrivateKey>[0], { format: 'jwk' }>['key'];
export interface VapidKeys { publicKey: string; privateKey: Jwk }

export function newVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: b64url(Buffer.concat([Buffer.from([4]), unb64url(jwk.x!), unb64url(jwk.y!)])), privateKey: jwk };
}

/** The `Authorization` header of RFC 8292: a JWT for the push service's origin, signed with this phone's key. */
export function vapidHeader(endpoint: string, keys: VapidKeys, subject = DEFAULT_SUBJECT, now = Date.now()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = createPrivateKey({ key: keys.privateKey, format: 'jwk' });
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

/**
 * RFC 8291: the payload encrypted for one subscription, as an aes128gcm body (RFC 8188) with one record.
 * `p256dh` and `auth` come from the phone's subscription. `local` and `salt` are for tests.
 */
export function encryptPayload(payload: Uint8Array, p256dh: string, auth: string, local?: ReturnType<typeof createECDH>, salt = randomBytes(16)): Buffer {
  const uaPublic = unb64url(p256dh);
  const authSecret = unb64url(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('The subscription key is not a P-256 public key.');
  if (authSecret.length < 16) throw new Error('The subscription secret is too short.');
  if (!local) {
    local = createECDH('prime256v1');
    local.generateKeys();
  }
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record, so it ends with the last-record delimiter and no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

const Subscription = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{16,40}$/) }),
});
const Kinds = z.object({ run: z.boolean(), comment: z.boolean(), proposal: z.boolean() });
type Kinds = z.output<typeof Kinds>;
const DEFAULT_KINDS: Kinds = { run: true, comment: true, proposal: true };

const Record_ = z.object({
  publicKey: z.string(),
  privateKey: z.record(z.string(), z.unknown()),
  subscription: Subscription.nullable().default(null),
  kinds: Kinds.default(DEFAULT_KINDS),
  sent: z.number().default(0),
  lastSentAt: z.number().nullable().default(null),
  lastError: z.string().max(300).optional(),
});
type PushRecord = z.output<typeof Record_>;
const File_ = z.object({ devices: z.record(z.string(), Record_).default({}) });

/** How a message goes out. Tests give a stand-in; otherwise it is `fetch`. */
export type PushFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: Buffer }) => Promise<{ status: number; text?: () => Promise<string> }>;

export interface PushDeps {
  home: string;
  storage: Pick<Storage, 'get'>;
  fileEvents: Pick<FileEvents, 'onEvent'>;
  /** Whether an agent run is going in this file: what it makes is told once, when it ends. */
  activeRun: (fileId: string) => boolean;
  /** Paired phones right now. A message only goes to one that is still paired. */
  paired: (id: string) => boolean;
  fetch?: PushFetch;
  subject?: string;
}

/** What one run did while it went, told in one message when it ends. */
interface Held { proposals: string[]; thread?: string; by: string }

export interface PushStatus { key: string; on: boolean; kinds: Kinds; service: string | null; sent: number; lastSentAt: number | null; lastError?: string }

function agentName(id: string): string {
  return id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude' : isRunnerId(id) ? runnerLabel(id) : id ? id.charAt(0).toUpperCase() + id.slice(1) : 'An agent';
}

const isAgentAuthor = (name: string) => isRunnerId(name.toLowerCase());

/** The words of a notification, and nothing more: see the comment at the top. Exported for tests. */
export function describePush(kind: PushKind, details: { agent: string; fileName: string; fileId: string; status?: string; proposals?: string[]; thread?: string; client?: boolean }): PushPayload {
  const who = agentName(details.agent);
  const body = details.fileName.slice(0, NAME_LIMIT);
  const tag = `bogen-${kind}-${details.fileId}`;
  if (kind === 'proposal') {
    const n = details.proposals?.length ?? 1;
    const url = n === 1 && details.proposals?.[0] ? `#/review/${details.fileId}/${details.proposals[0]}` : '#/';
    return { kind, title: n > 1 ? `${who} has ${n} proposals ready` : `${who} has a proposal ready`, body, url, tag };
  }
  if (kind === 'comment') {
    const url = details.thread ? `#/file/${details.fileId}/thread/${details.thread}` : `#/file/${details.fileId}`;
    return { kind, title: details.client ? 'A client commented' : `${who} answered a comment`, body, url, tag };
  }
  return { kind, title: details.status === 'failed' ? `${who} stopped with an error` : `${who} finished`, body, url: `#/file/${details.fileId}`, tag };
}

/**
 * The phones' push subscriptions, one VAPID key pair per paired phone, in `$BOGEN_HOME/push.json` (mode 600),
 * and what is worth telling them: an agent run that ended, a comment from an agent or a client, a proposal.
 */
export class PushNotices {
  private devices = new Map<string, PushRecord>();
  private held = new Map<string, Held>();
  private settling = new Map<string, { timer: NodeJS.Timeout; proposals: string[]; by: string }>();
  private recent = new Map<string, number[]>();
  private write: Promise<void> = Promise.resolve();
  private stop: () => void;
  private sending = new Set<Promise<void>>();

  constructor(private readonly deps: PushDeps) {
    this.stop = deps.fileEvents.onEvent((fileId, event) => this.onFileEvent(fileId, event));
  }

  private get path(): string {
    return join(this.deps.home, 'push.json');
  }

  async load(): Promise<void> {
    try {
      const parsed = File_.parse(JSON.parse(await readFile(this.path, 'utf8')));
      for (const [id, record] of Object.entries(parsed.devices)) this.devices.set(id, record);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`bogen: push.json was unreadable (${errorMessage(e)}), notifications start over`);
    }
  }

  private save(): Promise<void> {
    const body = `${JSON.stringify({ devices: Object.fromEntries(this.devices) }, null, 2)}\n`;
    this.write = this.write.catch(() => {}).then(() => atomicWrite(this.path, body, 0o600));
    this.write.catch((e) => console.error(`bogen: could not save push.json: ${errorMessage(e)}`));
    return this.write;
  }

  async close(): Promise<void> {
    this.stop();
    for (const s of this.settling.values()) clearTimeout(s.timer);
    this.settling.clear();
    await Promise.allSettled([...this.sending]);
    await this.write.catch(() => {});
  }

  /** The keys of a phone, made the first time it asks. */
  private record(id: string): PushRecord {
    let record = this.devices.get(id);
    if (!record) {
      const keys = newVapidKeys();
      record = Record_.parse({ publicKey: keys.publicKey, privateKey: keys.privateKey });
      this.devices.set(id, record);
      void this.save();
    }
    return record;
  }

  status(id: string): PushStatus {
    const r = this.record(id);
    return {
      key: r.publicKey, on: Boolean(r.subscription), kinds: r.kinds, service: r.subscription ? new URL(r.subscription.endpoint).hostname : null,
      sent: r.sent, lastSentAt: r.lastSentAt, ...(r.lastError ? { lastError: r.lastError } : {}),
    };
  }

  /** For the list of phones on the computer. */
  isOn(id: string): boolean {
    return Boolean(this.devices.get(id)?.subscription);
  }

  async subscribe(id: string, subscription: z.output<typeof Subscription> | undefined, kinds: Partial<Kinds> | undefined): Promise<PushStatus> {
    const r = this.record(id);
    if (subscription) {
      if (!pushHostAllowed(subscription.endpoint)) throw new HttpError(400, `Bogen sends notifications only to a known push service, such as Apple's. Not to ${new URL(subscription.endpoint).hostname}.`);
      r.subscription = subscription;
      delete r.lastError;
    }
    if (kinds) r.kinds = { ...r.kinds, ...kinds };
    await this.save();
    return this.status(id);
  }

  async unsubscribe(id: string): Promise<PushStatus> {
    const r = this.devices.get(id);
    if (r) {
      r.subscription = null;
      await this.save();
    }
    return this.status(id);
  }

  /** A removed phone takes its keys with it. */
  async forget(id: string): Promise<void> {
    if (this.devices.delete(id)) await this.save();
  }

  // ---------------------------------------------------------------- what is worth a message

  private fileName(fileId: string): string {
    return this.deps.storage.get(fileId)?.name ?? 'Bogen';
  }

  private onFileEvent(fileId: string, event: FileEvent): void {
    if (event.kind === 'proposal_created' && event.source === 'agent') {
      const id = String(event.proposal_id ?? '');
      const by = String(event.actor ?? 'agent');
      if (this.deps.activeRun(fileId)) {
        const held = this.held.get(fileId) ?? { proposals: [], by };
        held.proposals.push(id);
        this.held.set(fileId, held);
        return;
      }
      // An agent outside a run: wait a moment for the rest of a burst.
      const settling = this.settling.get(fileId);
      if (settling) {
        settling.proposals.push(id);
        return;
      }
      const timer = setTimeout(() => {
        const s = this.settling.get(fileId);
        this.settling.delete(fileId);
        if (s) this.notify('proposal', describePush('proposal', { agent: s.by, fileName: this.fileName(fileId), fileId, proposals: s.proposals }));
      }, SETTLE_MS);
      timer.unref();
      this.settling.set(fileId, { timer, proposals: [id], by });
      return;
    }
    if (event.kind === 'comment_added' || event.kind === 'comment_replied') {
      const author = String(event.author ?? '');
      const client = event.from_client === true;
      // For you: an agent's words, or a client's. Not what the person wrote, here or on another device, and not Bogen's own notes.
      const fromAgent = event.source === 'agent' || (event.source === 'peer' && isAgentAuthor(author));
      if (!fromAgent && !client) return;
      const thread = typeof event.thread_id === 'string' ? event.thread_id : undefined;
      if (fromAgent && this.deps.activeRun(fileId)) {
        const held = this.held.get(fileId) ?? { proposals: [], by: author };
        if (thread) held.thread = thread;
        this.held.set(fileId, held);
        return;
      }
      this.notify('comment', describePush('comment', { agent: author, fileName: this.fileName(fileId), fileId, ...(thread ? { thread } : {}), client }));
      return;
    }
    if (event.kind === 'agent_finished') {
      const status = String(event.status ?? 'done');
      const agent = String(event.agent ?? event.actor ?? 'agent');
      const held = this.held.get(fileId);
      this.held.delete(fileId);
      // Stopped is what the person did. Nothing to tell them.
      if (status === 'stopped') return;
      const name = this.fileName(fileId);
      const choices: [PushKind, PushPayload][] = [];
      if (held?.proposals.length) choices.push(['proposal', describePush('proposal', { agent, fileName: name, fileId, proposals: held.proposals })]);
      if (held?.thread) choices.push(['comment', describePush('comment', { agent, fileName: name, fileId, thread: held.thread })]);
      choices.push(['run', describePush('run', { agent, fileName: name, fileId, status })]);
      // A failure is news even when something was made before it.
      if (status === 'failed') choices.unshift(choices.pop()!);
      this.notifyFirst(choices);
    }
  }

  /** One message per phone: the first of `choices` that the phone wants. */
  private notifyFirst(choices: [PushKind, PushPayload][]): void {
    for (const [id, r] of this.devices) {
      if (!r.subscription || !this.deps.paired(id)) continue;
      const pick = choices.find(([kind]) => r.kinds[kind]);
      if (pick) this.track(this.sendTo(id, pick[1]));
    }
  }

  private notify(kind: PushKind, payload: PushPayload): void {
    this.notifyFirst([[kind, payload]]);
  }

  private track(p: Promise<void>): void {
    this.sending.add(p);
    void p.finally(() => this.sending.delete(p));
  }

  /** Waits for messages on their way. Tests. */
  async settled(): Promise<void> {
    while (this.sending.size) await Promise.allSettled([...this.sending]);
  }

  /** "Notifications are on", from the phone's settings, to see that it works. */
  async test(id: string): Promise<{ status: number }> {
    const r = this.devices.get(id);
    if (!r?.subscription) throw new HttpError(409, 'Notifications are off on this phone.');
    return this.deliver(id, r, { kind: 'test', title: 'Notifications are on', body: 'Bogen tells you here when an agent is done.', url: '#/settings', tag: 'bogen-test' });
  }

  private async sendTo(id: string, payload: PushPayload): Promise<void> {
    const r = this.devices.get(id);
    if (!r?.subscription) return;
    const now = Date.now();
    const times = (this.recent.get(id) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (times.length >= RATE_LIMIT) return;
    times.push(now);
    this.recent.set(id, times);
    await this.deliver(id, r, payload).catch((e) => console.error(`bogen: no notification for a phone: ${errorMessage(e)}`));
  }

  private async deliver(id: string, r: PushRecord, payload: PushPayload): Promise<{ status: number }> {
    const sub = r.subscription!;
    if (!pushHostAllowed(sub.endpoint)) throw new HttpError(400, 'The phone named a push service Bogen does not send to.');
    const body = encryptPayload(Buffer.from(JSON.stringify(payload)), sub.keys.p256dh, sub.keys.auth);
    const send = this.deps.fetch ?? ((url, init) => fetch(url, { ...init, body: new Uint8Array(init.body), redirect: 'error', signal: AbortSignal.timeout(15_000) }));
    let status: number;
    try {
      const res = await send(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidHeader(sub.endpoint, r as VapidKeys, this.deps.subject ?? process.env.BOGEN_PUSH_SUBJECT ?? DEFAULT_SUBJECT),
          'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(TTL_SECONDS), Urgency: 'normal',
        },
        body,
      });
      status = res.status;
      if (status >= 400) r.lastError = `${status}${res.text ? `: ${(await res.text().catch(() => '')).slice(0, 200)}` : ''}`;
    } catch (e) {
      r.lastError = errorMessage(e).slice(0, 300);
      await this.save();
      throw e;
    }
    // Gone: the phone took notifications back, or the app was deleted. Stop sending there.
    if (status === 404 || status === 410) r.subscription = null;
    if (status < 300) {
      r.sent++;
      r.lastSentAt = Date.now();
      delete r.lastError;
    }
    // A message to a phone that was removed while it went out is not kept.
    if (this.devices.get(id) === r) await this.save();
    return { status };
  }

  /** `/api/phone/push` and `/api/phone/push/test`, for a paired phone about itself. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, device: PhoneDevice | null, body: () => Promise<Buffer>): Promise<boolean> {
    if (url.pathname !== '/api/phone/push' && url.pathname !== '/api/phone/push/test') return false;
    if (!device) throw new HttpError(401, 'This phone is not paired.');
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const method = req.method ?? 'GET';
    if (url.pathname === '/api/phone/push/test') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      const out = await this.test(device.id);
      if (out.status >= 300) throw new HttpError(502, `The push service answered ${out.status}.`);
      return send(200, { ok: true, status: out.status }), true;
    }
    if (method === 'GET') return send(200, this.status(device.id)), true;
    if (method === 'DELETE') return send(200, await this.unsubscribe(device.id)), true;
    if (method === 'POST') {
      let parsed: { subscription?: z.output<typeof Subscription>; kinds?: Partial<Kinds> };
      try {
        parsed = z.object({ subscription: Subscription.optional(), kinds: Kinds.partial().optional() }).parse(JSON.parse((await body()).toString('utf8') || '{}'));
      } catch {
        throw new HttpError(400, 'Send {"subscription": {"endpoint", "keys": {"p256dh", "auth"}}} or {"kinds": {...}}.');
      }
      return send(200, await this.subscribe(device.id, parsed.subscription, parsed.kinds)), true;
    }
    throw new HttpError(405, 'Method not allowed.');
  }
}
