import { applyRemoteUpdate, staleFor } from './design-branches.ts';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, chmod, mkdir } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { BogenDoc, replaceLayerText, Y } from '@bogen/core';
import { assertWellFormed } from './bogen-file.ts';
import type { EventHub } from './events.ts';
import { tokenMatches, type GuardOptions } from './http/security.ts';
import { FILE_ID, Storage, type FileEntry } from './storage.ts';
import type { TimelineSync } from './timeline-sync.ts';
import type { Rooms } from './sync.ts';
import { FEATURE_PRESENCE, PeerPresence, PresenceMessage } from './peer-presence.ts';
import { compareSync, fromTheOtherSide, SyncConflicts, type RawConflict } from './sync-conflicts.ts';
import { normalizePeerUrl, tailscaleIp, TailnetListener } from './tailnet.ts';
import { atomicWrite, errorMessage, HttpError } from './util.ts';
import { FULL_VERSION } from './version.ts';

/**
 * Device sync: this server and each paired one hold replicas of the same Y.Docs and exchange state vectors and
 * diffs, so edits made offline on both sides merge instead of one overwriting the other.
 *
 * - Catch-up over HTTP: on every connect and periodically. This is what makes a sleeping laptop recover.
 * - Live link over WebSocket: each side dials the other, and sends on its own outgoing socket, else on the
 *   incoming one. Y updates carry origin `peer:<id>`, which no undo manager tracks and which is not sent back.
 * - File lifecycle: names merge by time, deletes are tombstones. An edit the deleting device had not seen
 *   restores the file; see `beyond`.
 */

const MAX_LIVE_BYTES = 16 * 1024 * 1024;
const MAX_SYNC_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
/** As big as an upload may be, so that a video that exists here also reaches other devices. */
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const MAX_QUEUED_UPDATES = 2000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const CATCH_UP_MS = 60_000;
const FULL_EVERY = 10;
const HEARTBEAT_MS = 15_000;
const HINT_DELAY_MS = 50;
const APPLY_DELAY_MS = 10;
const TOMBSTONE_DOC_DAYS = 30;
const DEVICE_HEADER = 'x-bogen-device';
const VERSION_HEADER = 'x-bogen-version';
const FEATURES_HEADER = 'x-bogen-features';
/** This build settles text both devices edited while apart, and takes the other's note about it. */
const FEATURE_TEXT_CONFLICTS = 'text-conflicts';
const OWN_FEATURES = [FEATURE_PRESENCE, FEATURE_TEXT_CONFLICTS];
/** Origin of the write that settles a text both devices edited while apart. */
export const TEXT_CONFLICT = 'sync-text-conflict';
/** What `Y.diffUpdate` returns when it has nothing to say: no structs, an empty delete set. */
const EMPTY_UPDATE_BYTES = 2;
const EMPTY_STATE_VECTOR = new Uint8Array([0]);

const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

export interface PeerRecord { id: string; name: string; url: string; token: string }
export interface PeerStatus {
  id: string; name: string; state: 'connected' | 'offline'; lastSyncAt: number | null; pending: number; error?: string;
  /** What that device reports, once it has been heard from. Old builds say nothing. */
  version?: string;
  /** True when both versions are known and differ. */
  versionMismatch?: boolean;
  /** Where a paired phone opens Bogen on that device, when it has its phone listener on. Old builds say nothing. */
  phoneUrl?: string;
  /** Since this server started. */
  bytesIn: number; bytesOut: number;
  /** The last problem, also after it went away. */
  lastError?: string; lastErrorAt?: number;
  /** Who has which file open over there. */
  here: { fileId: string; people: { name: string; selection: number }[] }[];
}
interface Tombstone { name: string; deletedAt: number; snapshot: string }

const DeviceId = z.string().regex(/^[0-9a-zA-Z_-]{4,64}$/);
const DeviceName = z.string().trim().min(1).max(100);
const FileId = z.string().regex(FILE_ID);
const Timestamp = z.number().finite().nonnegative();

const PeerRecordSchema = z.object({ id: DeviceId, name: DeviceName, url: z.string().max(300), token: z.string().min(16).max(200) });
const RemoteFile = z.object({
  id: FileId, name: z.string().trim().min(1).max(200), updatedAt: Timestamp,
  nameAt: Timestamp.optional(), createdAt: Timestamp.optional(), deleted: z.boolean().optional(), snapshot: z.string().max(MAX_JSON_BYTES).optional(), kind: z.literal('brand').optional(),
});
type RemoteFile = z.output<typeof RemoteFile>;
const Manifest = z.object({
  files: z.array(RemoteFile).max(200_000), assets: z.array(z.string().max(100)).max(1_000_000),
  version: z.string().max(100).optional(), features: z.array(z.string().max(40)).max(40).optional(),
  phone: z.string().max(300).optional(),
});
// `apart`: the sender changed this file while the link was down. Older builds leave it out and drop it.
const SyncBody = z.object({ sv: z.string().max(MAX_JSON_BYTES), update: z.string().max(MAX_SYNC_BYTES).optional(), apart: z.boolean().optional() });
const SyncResult = z.object({ update: z.string(), sv: z.string(), deleted: z.boolean().optional(), apart: z.boolean().optional() });
const TextVersionSchema = z.object({ text: z.string().max(100_000), spans: z.array(z.object({ start: z.number(), end: z.number(), style: z.record(z.string(), z.string()).optional(), href: z.string().max(2000).optional() })).max(10_000).optional() });
const NotesBody = z.object({
  conflicts: z.array(z.object({
    kind: z.literal('layer'), nodeId: z.string().max(100), name: z.string().max(2000), field: z.literal('text'),
    ours: z.string().max(1000), theirs: z.string().max(1000), kept: z.enum(['ours', 'theirs']),
    texts: z.object({ ours: TextVersionSchema, theirs: TextVersionSchema }).optional(),
  })).max(100),
});
const RegisterBody = z.object({ id: DeviceId, name: DeviceName, url: z.string().max(300), token: z.string().min(16).max(200) });
const AddBody = z.object({ url: z.string().max(300), token: z.string().min(16).max(200), name: DeviceName.optional(), insecure: z.boolean().optional() });
const PairBody = z.object({ name: DeviceName.optional(), insecure: z.boolean().optional() });
const TailnetBody = z.object({ on: z.boolean() });
const Wire = z.discriminatedUnion('t', [
  z.object({ t: z.literal('update'), id: FileId, u: z.string() }),
  z.object({ t: z.literal('asset'), name: z.string().max(100) }),
  z.object({ t: z.literal('changed') }),
  z.object({ t: z.literal('timeline'), id: FileId }),
  PresenceMessage,
]);
const WIRE_KINDS = new Set(['update', 'asset', 'changed', 'timeline', 'presence']);

// ---------------------------------------------------------------- merging

function snapshotOf(doc: Y.Doc): string {
  return b64(Y.encodeSnapshot(Y.snapshot(doc)));
}

function covered(ranges: { clock: number; len: number }[] | undefined, clock: number, len: number): boolean {
  let at = clock;
  const end = clock + len;
  for (const r of ranges ?? []) {
    if (r.clock > at) return false;
    if (r.clock + r.len > at) at = r.clock + r.len;
    if (at >= end) return true;
  }
  return at >= end;
}

/**
 * True when state `a` holds anything `b` did not know: a new struct, or a deletion. A state vector alone would
 * miss the second, and deleting a layer is an edit like any other.
 */
export function beyond(a: string, b: string): boolean {
  const left = Y.decodeSnapshot(unb64(a));
  const right = Y.decodeSnapshot(unb64(b));
  for (const [client, clock] of left.sv) if (clock > (right.sv.get(client) ?? 0)) return true;
  for (const [client, ranges] of left.ds.clients) {
    const known = [...(right.ds.clients.get(client) ?? [])].sort((x, y) => x.clock - y.clock);
    for (const r of ranges) if (!covered(known, r.clock, r.len)) return true;
  }
  return false;
}

function parentIsGone(doc: BogenDoc, id: string): boolean {
  return Boolean(doc.nodes._map.get(id)?.deleted || doc.pages._map.get(id)?.deleted);
}

/**
 * After a merge a layer can be cut off from every page: drawn into a frame the other side deleted, or caught
 * in a parent cycle when both sides moved one layer into the other. It would stay in the file, unseen. Those
 * layers go to the first page instead. A parent that has merely not arrived yet is left alone.
 */
export function rescueStranded(doc: BogenDoc, origin: unknown): string[] {
  if (doc.pages.size === 0) doc.createPage('Page 1', origin);
  const stranded: string[] = [];
  doc.nodes.forEach((_, id) => {
    if (!doc.pageOf(id)) stranded.push(id);
  });
  const moved: string[] = [];
  const pageId = doc.getPages()[0]!.id;
  for (const id of stranded.sort()) {
    if (doc.pageOf(id)) continue;
    const path: string[] = [];
    let current = id;
    let top: string | null = null;
    for (;;) {
      path.push(current);
      const parent = String(doc.nodes.get(current)?.get('parent'));
      if (!doc.nodes.has(parent)) {
        if (parentIsGone(doc, parent)) top = current;
        break;
      }
      const loop = path.indexOf(parent);
      if (loop >= 0) {
        top = path.slice(loop).sort()[0]!;
        break;
      }
      current = parent;
    }
    if (!top) continue;
    doc.move([top], pageId, undefined, origin);
    if (doc.getNode(top)?.style.position !== 'absolute') doc.updateStyle(top, { position: 'absolute', left: '0px', top: '0px' }, origin);
    moved.push(top);
  }
  return moved;
}

/** Reads a response body, stopping as soon as it passes `limit`, whatever the headers claimed. */
async function readLimited(res: Response, limit: number): Promise<Buffer> {
  if (Number(res.headers.get('content-length') ?? 0) > limit) {
    await res.body?.cancel();
    throw new Error('The answer is larger than the limit.');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > limit) {
        await res.body.cancel().catch(() => {});
        throw new Error('The answer is larger than the limit.');
      }
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

function readRequest(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > limit) {
      req.resume();
      return reject(new HttpError(413, 'The body is larger than the limit.'));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'The body is larger than the limit.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseBody<S extends z.ZodType>(req: IncomingMessage, schema: S, limit = MAX_JSON_BYTES): Promise<z.output<S>> {
  let parsed: unknown;
  try {
    const raw = await readRequest(req, limit);
    parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(400, 'The body is not valid JSON.');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return result.data;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function isPeerPath(pathname: string): boolean {
  return pathname === '/peer' || pathname === '/api/peer' || pathname.startsWith('/api/peer/');
}

/** On the tailnet listener these answer nothing, token or not: they configure this machine or run programs on it. */
export function isLocalOnlyPath(pathname: string): boolean {
  return /^\/api\/(peers|phone|inbox|runs|races|run-settings|comments|voice|tomacco|omarchy|live|notifications|brands|libraries|kits|code|agents\/steps|publish|shares)(\/|$)/.test(pathname) || /^\/(live-)?mcp(\/|$)/.test(pathname) || /^\/api\/files\/[^/]+\/(away|conflicts|libraries|proposals|drift|restyle|catch-up|screen-previews)(\/|$)/.test(pathname) || /^\/api\/files\/[^/]+\/brand(\/|$)/.test(pathname);
}

// ---------------------------------------------------------------- one peer

class PeerLink {
  outgoing: WebSocket | null = null;
  incoming = new Set<WebSocket>();
  retry: NodeJS.Timeout | null = null;
  backoff = INITIAL_BACKOFF_MS;
  lastSyncAt: number | null = null;
  private currentError: string | undefined;
  lastError: string | undefined;
  lastErrorAt: number | undefined;
  version: string | undefined;
  phoneUrl: string | undefined;
  features = new Set<string>();
  bytesIn = 0;
  bytesOut = 0;

  get error(): string | undefined {
    return this.currentError;
  }

  set error(value: string | undefined) {
    this.currentError = value;
    if (value) {
      this.lastError = value;
      this.lastErrorAt = Date.now();
    }
  }

  /** Files with local changes this peer is not known to have. */
  dirty = new Set<string>();
  /** Files changed here while there was no live link to this peer, until it has them. Saved across restarts. */
  apart = new Set<string>();
  missingAssets = 0;
  /** What each file looked like on both sides at its last sync, so that a routine sweep can skip it. */
  seen = new Map<string, string>();
  refusedAssets = new Set<string>();
  catching = false;
  again: 'changed' | 'full' | null = null;
  removed = false;

  constructor(public record: PeerRecord) {}

  get id(): string {
    return this.record.id;
  }

  socket(): WebSocket | null {
    if (this.outgoing?.readyState === WebSocket.OPEN) return this.outgoing;
    for (const ws of this.incoming) if (ws.readyState === WebSocket.OPEN) return ws;
    return null;
  }
}

export interface PeerManagerDeps {
  home: string;
  storage: Storage;
  rooms: Rooms;
  hub: EventHub;
  port: () => number;
  localUrl: () => string;
  /** Builds a server for the tailnet listener. */
  createTailnetServer: () => Server;
  onFileArrived?: (id: string) => void;
  /** Whether cursors go to other devices too. Selections always do. */
  shareCursors?: () => boolean;
  /** Change timeline and commits, which travel with the files. */
  timelineSync?: () => TimelineSync;
  /** `/api/peer/runs/*`: a paired device asking this one's agents. It decides itself whether that device may. */
  remoteRuns?: (peer: { id: string; name: string }, req: IncomingMessage, res: ServerResponse, parts: string[]) => Promise<void>;
  /** Where a paired phone opens Bogen here, when the phone listener is on. Told to the other devices for their phones. */
  phoneUrl?: () => string | null;
}

/** A phone address another device may tell: its own https name on the tailnet. Anything else is not passed on to a phone. */
export function validPhoneUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 300) return undefined;
  return /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net(:\d{1,5})?\/$/.test(value) ? value : undefined;
}

export interface PeerOptions {
  /** `bogen serve --tailnet`. On for this run, without changing the saved setting. */
  tailnet?: boolean;
  /** Test permission: peers may be on any host. Only a server option and a command line flag can set this. */
  insecureAllowAnyHost?: boolean;
  /** For tests: where the tailnet address comes from. */
  tailscaleIp?: () => Promise<string | null>;
  /** How often a connected peer is swept. */
  peerCatchUpMs?: number;
  /** For tests: a smaller limit than a real upload's. */
  peerMaxAssetBytes?: number;
  /** How often sockets are pinged. A socket that misses one is taken for dead. */
  peerHeartbeatMs?: number;
  tailnetRetryMs?: number;
  /** For tests: the version this server reports to its peers. */
  reportVersion?: string;
}

export class PeerManager {
  deviceId = '';
  deviceName = '';
  private token = '';
  private tailnetSetting = false;
  /** `--tailnet` keeps the listener on until the person turns it off by hand during this run. */
  private tailnetFlag = false;
  private config: Record<string, unknown> = {};
  private configWrite: Promise<void> = Promise.resolve();
  private stateWrite: Promise<void> = Promise.resolve();
  private stateTimer: NodeJS.Timeout | null = null;
  private links = new Map<string, PeerLink>();
  private tombstones = new Map<string, Tombstone>();
  private fileLocks = new Map<string, Promise<unknown>>();
  private inbox = new Map<string, { updates: Uint8Array[]; timer: NodeJS.Timeout; link: PeerLink; id: string }>();
  private assetPulls = new Map<string, Promise<boolean>>();
  private assetSource = new Map<string, string>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LIVE_BYTES * 2 });
  private alive = new WeakSet<WebSocket>();
  private heartbeat: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private sweeps = 0;
  private hintTimer: NodeJS.Timeout | null = null;
  private timelineTimer: NodeJS.Timeout | null = null;
  private timelinePulling = new Set<string>();
  private timelineAgain = new Set<string>();
  private timelineFiles = new Set<string>();
  private hintExcept: string | null | undefined = undefined;
  private notifyTimer: NodeJS.Timeout | null = null;
  private tailnet: TailnetListener;
  private closed = false;
  private started = false;
  private quiet = 0;
  private abort = new AbortController();
  private busy = new Set<Promise<unknown>>();
  readonly presence: PeerPresence;
  readonly conflicts: SyncConflicts;

  /** Counters for tests and diagnosis. */
  readonly stats = { updatesSent: 0, updatesReceived: 0, updatesRefused: 0, hintsSent: 0, assetsPulled: 0, assetsRefused: 0 };
  /** Strict on purpose: bearer only, no cookie, no query token. Changed when the token rotates. */
  readonly guard: GuardOptions;

  constructor(private readonly deps: PeerManagerDeps, private readonly options: PeerOptions = {}) {
    this.guard = { port: deps.port, token: undefined, strict: true };
    this.tailnet = new TailnetListener({
      create: deps.createTailnetServer,
      port: deps.port,
      resolve: options.tailscaleIp ?? (() => tailscaleIp()),
      onChange: () => this.notify(),
      retryMs: options.tailnetRetryMs,
    });
    this.presence = new PeerPresence({
      rooms: deps.rooms,
      send: (message) => this.sendPresence(message),
      deviceName: (id) => this.links.get(id)?.record.name ?? 'Another device',
      shareCursors: () => deps.shareCursors?.() ?? false,
      changed: () => this.notify(),
    });
    this.conflicts = new SyncConflicts(deps.home, (fileId) => deps.hub.broadcast({ t: 'sync-conflicts', fileId }));
  }

  private get version(): string {
    return this.options.reportVersion ?? FULL_VERSION;
  }

  private sendPresence(message: PresenceMessage): void {
    if (!this.started || this.closed) return;
    for (const link of this.links.values()) {
      const ws = link.socket();
      if (ws && link.features.has(FEATURE_PRESENCE)) this.sendJson(ws, message);
    }
  }

  /** What a peer said about itself, in a header or in its manifest. */
  private heard(link: PeerLink, version: unknown, features: unknown, phone?: unknown): void {
    if (typeof version === 'string' && version.length <= 100 && version !== link.version) {
      link.version = version;
      this.notify();
    }
    // Only a manifest says this, and saying nothing there means it is off: null then, undefined from headers.
    if (phone !== undefined) {
      const url = validPhoneUrl(phone);
      if (url !== link.phoneUrl) {
        link.phoneUrl = url;
        this.notify();
      }
    }
    const list = Array.isArray(features) ? features : typeof features === 'string' ? features.split(',') : null;
    if (!list) return;
    const had = link.features.has(FEATURE_PRESENCE);
    link.features = new Set(list.map((f) => String(f).trim()).filter(Boolean));
    if (!had && link.features.has(FEATURE_PRESENCE)) {
      const ws = link.socket();
      if (ws) for (const message of this.presence.snapshot()) this.sendJson(ws, message);
    }
  }

  private get allowAnyHost(): boolean {
    return Boolean(this.options.insecureAllowAnyHost);
  }

  private get statePath(): string {
    return join(this.deps.home, 'peers-state.json');
  }

  private tombstoneDocPath(id: string): string {
    return join(this.deps.home, 'tombstones', `${id}.ydoc`);
  }

  async start(): Promise<void> {
    await this.loadConfig();
    await this.loadState();
    await this.conflicts.load();
    await mkdir(join(this.deps.home, 'tombstones'), { recursive: true });
    const { storage } = this.deps;
    // Notes about files that are gone, from a build that kept them after a delete from the other device.
    this.conflicts.prune((id) => Boolean(storage.get(id)));
    storage.hooks.entryChanged = () => {
      if (!this.quiet) this.hintPeers();
    };
    storage.hooks.assetAdded = (name) => this.announceAsset(name);
    storage.hooks.missingAsset = (name) => this.pullOnDemand(name);
    // A delete that a crash cut in half: the tombstone is written first, so it stands.
    for (const id of this.tombstones.keys()) if (storage.get(id)) await storage.remove(id);
    await this.purgeOldTombstoneDocs();
    this.started = true;
    this.heartbeat = setInterval(() => this.beat(), this.options.peerHeartbeatMs ?? HEARTBEAT_MS);
    this.heartbeat.unref();
    this.sweeper = setInterval(() => this.sweep(), this.options.peerCatchUpMs ?? CATCH_UP_MS);
    this.sweeper.unref();
    this.tailnetFlag = Boolean(this.options.tailnet);
    if (this.tailnetFlag || this.tailnetSetting) this.tailnet.start();
    for (const record of this.configuredPeers()) this.openLink(record);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.presence.close();
    for (const timer of [this.heartbeat, this.sweeper, this.hintTimer, this.notifyTimer, this.stateTimer]) if (timer) clearTimeout(timer);
    for (const queued of this.inbox.values()) clearTimeout(queued.timer);
    this.inbox.clear();
    for (const link of this.links.values()) this.closeLink(link);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
    await this.tailnet.stop();
    await Promise.allSettled([...this.busy, ...this.fileLocks.values()]);
    if (this.started) await this.saveState().catch(() => {});
    await this.conflicts.flush();
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const tracked = work.finally(() => this.busy.delete(tracked));
    this.busy.add(tracked);
    return tracked;
  }

  // ---------------------------------------------------------------- saved settings

  private async loadConfig(): Promise<void> {
    const path = join(this.deps.home, 'config.json');
    let raw: Record<string, unknown> = {};
    let existed = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      raw = parsed as Record<string, unknown>;
    } catch (e) {
      existed = false;
      // Never written over: it may hold the user's API keys.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        const aside = `${path}.corrupt-${randomBytes(4).toString('hex')}`;
        await rename(path, aside).catch(() => {});
        console.error(`bogen: config.json was unreadable (${errorMessage(e)}), moved to ${aside}`);
      }
    }
    let changed = !existed;
    const take = <S extends z.ZodType>(key: string, schema: S, fallback: () => z.output<S>): z.output<S> => {
      const result = schema.safeParse(raw[key]);
      if (result.success) return result.data;
      changed = true;
      raw[key] = fallback();
      return raw[key] as z.output<S>;
    };
    this.deviceId = take('deviceId', DeviceId, () => randomBytes(8).toString('hex'));
    this.deviceName = take('deviceName', DeviceName, () => hostname().replace(/\.local$/, '').slice(0, 100) || 'This device');
    this.token = take('peerToken', z.string().min(16).max(200), () => randomBytes(32).toString('base64url'));
    this.guard.token = this.token;
    this.tailnetSetting = raw.tailnet === true;
    if (!Array.isArray(raw.peers)) {
      raw.peers = [];
      changed = true;
    }
    this.config = raw;
    if (changed) await this.saveConfig();
    else if (((await stat(path)).mode & 0o077) !== 0) await chmod(path, 0o600);
  }

  private configuredPeers(): PeerRecord[] {
    const out: PeerRecord[] = [];
    for (const item of this.config.peers as unknown[]) {
      const parsed = PeerRecordSchema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  private saveConfig(): Promise<void> {
    const body = `${JSON.stringify(this.config, null, 2)}\n`;
    this.configWrite = this.configWrite.catch(() => {}).then(() => atomicWrite(join(this.deps.home, 'config.json'), body, 0o600));
    return this.configWrite;
  }

  private savePeers(): Promise<void> {
    this.config.peers = [...this.links.values()].map((l) => l.record);
    return this.saveConfig();
  }

  private async loadState(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { tombstones?: Record<string, Tombstone>; lastSync?: Record<string, number>; apart?: Record<string, string[]> };
      for (const [id, t] of Object.entries(parsed.tombstones ?? {})) {
        if (FILE_ID.test(id) && typeof t?.snapshot === 'string' && typeof t.deletedAt === 'number') this.tombstones.set(id, { name: String(t.name), deletedAt: t.deletedAt, snapshot: t.snapshot });
      }
      this.lastSyncSaved = parsed.lastSync ?? {};
      for (const [id, files] of Object.entries(parsed.apart ?? {})) if (Array.isArray(files)) this.apartSaved[id] = files.filter((f) => typeof f === 'string' && FILE_ID.test(f));
    } catch (e) {
      const aside = `${this.statePath}.corrupt-${randomBytes(4).toString('hex')}`;
      await rename(this.statePath, aside).catch(() => {});
      console.error(`bogen: peers-state.json was unreadable (${errorMessage(e)}), moved to ${aside}`);
    }
  }

  private lastSyncSaved: Record<string, number> = {};
  private apartSaved: Record<string, string[]> = {};

  private saveState(): Promise<void> {
    const lastSync = { ...this.lastSyncSaved };
    for (const link of this.links.values()) if (link.lastSyncAt) lastSync[link.id] = link.lastSyncAt;
    const apart: Record<string, string[]> = {};
    for (const link of this.links.values()) if (link.apart.size) apart[link.id] = [...link.apart];
    const body = JSON.stringify({ tombstones: Object.fromEntries(this.tombstones), lastSync, apart });
    this.stateWrite = this.stateWrite.catch(() => {}).then(() => atomicWrite(this.statePath, body, 0o600));
    return this.stateWrite;
  }

  private saveStateSoon(): void {
    if (this.stateTimer || this.closed) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      void this.saveState().catch((e) => console.error(`bogen: could not save peers-state.json: ${errorMessage(e)}`));
    }, 5000);
    this.stateTimer.unref();
  }

  private async purgeOldTombstoneDocs(): Promise<void> {
    const limit = Date.now() - TOMBSTONE_DOC_DAYS * 86_400_000;
    for (const [id, t] of this.tombstones) if (t.deletedAt < limit) await rm(this.tombstoneDocPath(id), { force: true });
  }

  // ---------------------------------------------------------------- status

  status(): PeerStatus[] {
    return [...this.links.values()].map((link) => ({
      id: link.id, name: link.record.name,
      state: link.socket() ? 'connected' as const : 'offline' as const,
      lastSyncAt: link.lastSyncAt, pending: link.dirty.size + link.missingAssets,
      ...(link.error ? { error: link.error } : {}),
      ...(link.version ? { version: link.version, versionMismatch: link.version !== this.version } : {}),
      ...(link.phoneUrl ? { phoneUrl: link.phoneUrl } : {}),
      bytesIn: link.bytesIn, bytesOut: link.bytesOut,
      ...(link.lastError ? { lastError: link.lastError, lastErrorAt: link.lastErrorAt! } : {}),
      here: this.presence.of(link.id),
    }));
  }

  /** `status`, with the address of each device. For this machine only. */
  statusWithUrls(): (PeerStatus & { url: string })[] {
    return this.status().map((p) => ({ ...p, url: this.links.get(p.id)!.record.url }));
  }

  device(): { id: string; name: string; tailnetUrl: string | null } {
    return { id: this.deviceId, name: this.deviceName, tailnetUrl: this.tailnet.url };
  }

  private notify(): void {
    if (this.notifyTimer || this.closed) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.deps.hub.broadcast({ t: 'peers' });
    }, 200);
    this.notifyTimer.unref();
  }

  // ---------------------------------------------------------------- connections

  private openLink(record: PeerRecord): PeerLink {
    const link = new PeerLink(record);
    link.lastSyncAt = this.lastSyncSaved[record.id] ?? null;
    link.apart = new Set(this.apartSaved[record.id] ?? []);
    this.links.set(record.id, link);
    this.dial(link);
    return link;
  }

  private closeLink(link: PeerLink): void {
    link.removed = true;
    if (link.retry) clearTimeout(link.retry);
    link.retry = null;
    link.outgoing?.terminate();
    link.outgoing = null;
    for (const ws of link.incoming) ws.terminate();
    link.incoming.clear();
  }

  private headers(link: PeerLink): Record<string, string> {
    return { Authorization: `Bearer ${link.record.token}`, 'X-Bogen-Device': this.deviceId, 'X-Bogen-Version': this.version, 'X-Bogen-Features': OWN_FEATURES.join(',') };
  }

  private dial(link: PeerLink): void {
    if (this.closed || link.removed || link.outgoing) return;
    if (link.retry) clearTimeout(link.retry);
    link.retry = null;
    let url: string;
    try {
      url = normalizePeerUrl(link.record.url, this.allowAnyHost);
    } catch (e) {
      // A saved address that is no longer allowed, so there is nothing to retry until it changes.
      link.error = errorMessage(e);
      this.notify();
      return;
    }
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/peer`, { headers: this.headers(link), maxPayload: MAX_LIVE_BYTES * 2, handshakeTimeout: 10_000, followRedirects: false });
    link.outgoing = ws;
    ws.on('open', () => {
      if (link.removed || this.closed) return ws.terminate();
      link.backoff = INITIAL_BACKOFF_MS;
      link.error = undefined;
      this.alive.add(ws);
      this.notify();
      this.requestCatchUp(link, 'full');
    });
    this.listen(link, ws);
    ws.on('error', (e) => {
      link.error = errorMessage(e).replace('Unexpected server response: 401', 'the peer refused this token');
      this.notify();
    });
    ws.on('upgrade', (res) => this.heard(link, res.headers[VERSION_HEADER], res.headers[FEATURES_HEADER]));
    ws.on('close', () => {
      if (link.outgoing === ws) link.outgoing = null;
      if (!link.socket()) this.presence.peerGone(link.id);
      this.notify();
      this.scheduleDial(link);
    });
  }

  private scheduleDial(link: PeerLink): void {
    if (this.closed || link.removed || link.outgoing || link.retry) return;
    const delay = link.backoff * (0.75 + Math.random() * 0.5);
    link.backoff = Math.min(link.backoff * 2, MAX_BACKOFF_MS);
    link.retry = setTimeout(() => {
      link.retry = null;
      this.dial(link);
    }, delay);
    link.retry.unref();
  }

  private listen(link: PeerLink, ws: WebSocket): void {
    ws.on('pong', () => this.alive.add(ws));
    ws.on('message', (data: Buffer) => {
      this.alive.add(ws);
      link.bytesIn += data.length;
      try {
        this.onMessage(link, data);
      } catch (e) {
        console.error(`bogen: bad message from ${link.record.name}: ${errorMessage(e)}`);
        ws.close(1007, 'bad message');
      }
    });
  }

  /** A half-open socket is what a laptop leaves behind when it sleeps. */
  private beat(): void {
    for (const link of this.links.values()) {
      for (const ws of [link.outgoing, ...link.incoming]) {
        if (!ws || ws.readyState !== WebSocket.OPEN) continue;
        if (!this.alive.has(ws)) {
          ws.terminate();
          continue;
        }
        this.alive.delete(ws);
        ws.ping();
      }
    }
  }

  private sweep(): void {
    const kind = ++this.sweeps % FULL_EVERY === 0 ? 'full' : 'changed';
    if (kind === 'full') void this.purgeOldTombstoneDocs().catch(() => {});
    for (const link of this.links.values()) {
      if (link.socket()) this.requestCatchUp(link, kind);
      else if (!link.outgoing && !link.retry) this.dial(link);
    }
  }

  private checkBearer(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    return tokenMatches(this.guard, auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
  }

  /** The `/peer` socket. Always needs the peer token, on either listener. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    const refuse = (status: number, message: string) => socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (url.pathname !== '/peer' || !this.started || this.closed) return void refuse(404, 'Not Found');
    if (req.headers.origin !== undefined) return void refuse(403, 'Forbidden');
    if (!this.checkBearer(req)) return void refuse(401, 'Unauthorized');
    const device = req.headers[DEVICE_HEADER];
    const link = typeof device === 'string' ? this.links.get(device) : undefined;
    if (!link) return void refuse(403, 'Forbidden');
    this.heard(link, req.headers[VERSION_HEADER], req.headers[FEATURES_HEADER]);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      link.incoming.add(ws);
      this.alive.add(ws);
      this.listen(link, ws);
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        link.incoming.delete(ws);
        if (!link.socket()) this.presence.peerGone(link.id);
        this.notify();
      });
      for (const message of link.features.has(FEATURE_PRESENCE) ? this.presence.snapshot() : []) this.sendJson(ws, message);
      this.notify();
      // The other side just woke up: no need to sit out our own backoff.
      if (!link.outgoing) {
        link.backoff = INITIAL_BACKOFF_MS;
        this.dial(link);
      }
    });
  }

  // ---------------------------------------------------------------- live link

  private sendJson(ws: WebSocket, message: unknown): void {
    ws.send(JSON.stringify(message), (e) => {
      if (e) ws.terminate();
    });
  }

  /** Every change to a loaded doc passes here. A peer's own update does not go back to that peer. */
  onRoomUpdate(id: string, update: Uint8Array, origin: unknown): void {
    if (!this.started || this.closed) return;
    for (const link of this.links.values()) {
      if (origin === `peer:${link.id}`) continue;
      const ws = link.socket();
      if (!ws && !link.apart.has(id)) {
        link.apart.add(id);
        this.saveStateSoon();
      }
      if (!ws || update.length > MAX_LIVE_BYTES || ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        link.dirty.add(id);
        this.notify();
        if (ws) this.requestCatchUp(link, 'changed');
        continue;
      }
      this.stats.updatesSent++;
      const encoded = b64(update);
      link.bytesOut += encoded.length;
      this.sendJson(ws, { t: 'update', id, u: encoded });
      link.lastSyncAt = Date.now();
    }
  }

  /** The timeline of a file grew. Devices come and get it soon, for that file alone. */
  hintChanged(fileId: string): void {
    if (this.closed) return;
    this.timelineFiles.add(fileId);
    if (this.timelineTimer) return;
    this.timelineTimer = setTimeout(() => {
      this.timelineTimer = null;
      const files = [...this.timelineFiles];
      this.timelineFiles.clear();
      for (const link of this.links.values()) {
        const ws = link.socket();
        if (ws) for (const id of files) this.sendJson(ws, { t: 'timeline', id });
      }
    }, 300);
    this.timelineTimer.unref();
  }

  private pullTimeline(link: PeerLink, fileId: string): void {
    const sync = this.deps.timelineSync?.();
    if (!sync) return;
    void this.track(this.withTimelineTurn(link, fileId, () => sync.pull((path, limit) => this.peerFetch(link, path, {}, limit, 120_000), fileId)));
  }

  /** One pull per device and file at a time, and one more if something else turned up meanwhile. */
  private async withTimelineTurn(link: PeerLink, fileId: string, pull: () => Promise<unknown>): Promise<void> {
    const key = `${link.id}:${fileId}`;
    if (this.timelinePulling.has(key)) {
      this.timelineAgain.add(key);
      return;
    }
    this.timelinePulling.add(key);
    try {
      do {
        this.timelineAgain.delete(key);
        await pull().catch(() => {});
      } while (this.timelineAgain.has(key) && !this.closed && !link.removed);
    } finally {
      this.timelinePulling.delete(key);
    }
  }

  private hintPeers(except: string | null = null): void {
    if (this.closed) return;
    // One hint for a burst. Several sources in one burst means nobody is left out.
    this.hintExcept = this.hintExcept === undefined || this.hintExcept === except ? except : null;
    if (this.hintTimer) return;
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      const skip = this.hintExcept;
      this.hintExcept = undefined;
      for (const link of this.links.values()) {
        if (link.id === skip) continue;
        const ws = link.socket();
        if (!ws) continue;
        this.stats.hintsSent++;
        this.sendJson(ws, { t: 'changed' });
      }
    }, HINT_DELAY_MS);
    this.hintTimer.unref();
  }

  private announceAsset(name: string): void {
    const source = this.assetSource.get(name);
    for (const link of this.links.values()) {
      if (link.id === source) continue;
      const ws = link.socket();
      if (ws) this.sendJson(ws, { t: 'asset', name });
    }
  }

  private onMessage(link: PeerLink, data: Buffer): void {
    const raw = JSON.parse(data.toString('utf8')) as { t?: unknown };
    // A newer device may say things this one has no word for. That is no reason to hang up.
    if (typeof raw?.t === 'string' && !WIRE_KINDS.has(raw.t)) return;
    const message = Wire.parse(raw);
    if (message.t === 'presence') {
      this.presence.receive(link.id, message);
    } else if (message.t === 'changed') {
      this.requestCatchUp(link, 'changed');
    } else if (message.t === 'timeline') {
      this.pullTimeline(link, message.id);
    } else if (message.t === 'asset') {
      if (Storage.isAssetName(message.name)) void this.track(this.pullAsset(link, message.name).catch(() => false));
    } else {
      this.stats.updatesReceived++;
      this.queueUpdate(link, message.id, unb64(message.u));
    }
  }

  /** Validating means building a copy of the doc, so what arrives within a moment is done in one go. */
  private queueUpdate(link: PeerLink, id: string, update: Uint8Array): void {
    const key = `${link.id}:${id}`;
    const queued = this.inbox.get(key);
    if (queued) {
      if (queued.updates.length >= MAX_QUEUED_UPDATES) {
        queued.updates.length = 0;
        link.dirty.add(id);
        this.requestCatchUp(link, 'changed');
      }
      queued.updates.push(update);
      return;
    }
    const timer = setTimeout(() => {
      const item = this.inbox.get(key);
      this.inbox.delete(key);
      if (item?.updates.length) void this.track(this.applyQueued(item.link, item.id, item.updates));
    }, APPLY_DELAY_MS);
    timer.unref();
    this.inbox.set(key, { updates: [update], timer, link, id });
  }

  private async applyQueued(link: PeerLink, id: string, updates: Uint8Array[]): Promise<void> {
    const refused = (e: unknown) => {
      this.stats.updatesRefused++;
      link.error = `refused an update: ${errorMessage(e)}`;
      console.error(`bogen: refused an update for ${id} from ${link.record.name}: ${errorMessage(e)}`);
    };
    await this.withFile(id, async () => {
      if (!this.deps.storage.get(id)) {
        // Not here yet, or deleted here. Catch-up knows which, and what to do.
        this.requestCatchUp(link, 'changed');
        return;
      }
      try {
        await this.applyChecked(link, id, updates.length > 1 ? Y.mergeUpdates(updates) : updates[0]!);
        link.lastSyncAt = Date.now();
      } catch (e) {
        if (updates.length === 1) return refused(e);
        // One bad update must not take the good ones around it down with it.
        for (const update of updates) {
          try {
            await this.applyChecked(link, id, update);
            link.lastSyncAt = Date.now();
          } catch (each) {
            refused(each);
          }
        }
      }
    }).catch((e) => console.error(`bogen: ${errorMessage(e)}`));
  }

  /**
   * One thing at a time per file: loading, deleting, restoring and applying must not interleave. Work in here
   * stays local. Holding a lock across a call to a peer would deadlock with that peer doing the same to us.
   */
  private withFile<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.fileLocks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      if (this.closed) throw new Error('The server is closing.');
      return work();
    });
    const settled = next.finally(() => {
      if (this.fileLocks.get(id) === settled) this.fileLocks.delete(id);
    });
    settled.catch(() => {});
    this.fileLocks.set(id, settled);
    return next;
  }

  private async currentState(id: string): Promise<Uint8Array | null> {
    const live = this.deps.rooms.peek(id);
    return live ? Y.encodeStateAsUpdate(live.doc.y) : this.deps.storage.readDoc(id);
  }

  /**
   * An update cannot be taken back once applied, so it first goes onto a copy of the doc. Applies to the live
   * room, loading it when needed. False when it changed nothing.
   */
  private async applyChecked(link: PeerLink, id: string, update: Uint8Array, catchUp?: { remoteSv: Uint8Array; apart: boolean }): Promise<boolean> {
    const base = await this.currentState(id);
    const probe = new BogenDoc(new Y.Doc());
    let changed = false;
    try {
      if (base) Y.applyUpdate(probe.y, base);
      probe.y.on('update', () => {
        changed = true;
      });
      Y.applyUpdate(probe.y, update);
      // Both sides deleting different last pages is a legal merge, and `rescueStranded` adds one back.
      assertWellFormed(probe, { requirePage: false });
      // Parts that wait for an earlier update still have to be kept.
      if (probe.y.store.pendingStructs || probe.y.store.pendingDs) changed = true;
    } finally {
      probe.y.destroy();
    }
    if (!changed) return false;
    // Only catch-up carries what was done while apart. Over the live link there is nothing to compare but a millisecond.
    // Text is settled only when one side changed the file with the link down: a sweep while both are connected can
    // also bring two people's typing that crossed, and that merges per character, as it does live.
    let fixes: { nodeId: string; text: string; spans: unknown }[] = [];
    // Edits made before this device saw a checkout go to the branch they were made on (design-branches.ts): comparing
    // them with the branch live here would note conflicts that are not there, and repair text that is not theirs.
    const loaded = this.deps.rooms.peek(id);
    const stale = Boolean(catchUp && loaded && staleFor(loaded, catchUp.remoteSv));
    if (catchUp && base && !stale) {
      try {
        const found = compareSync(base, update, catchUp.apart ? { remoteSv: catchUp.remoteSv } : undefined);
        this.conflicts.add(id, link.record.name, found.conflicts);
        fixes = found.fixes;
        const texts = found.conflicts.filter((c) => c.texts);
        if (texts.length && link.features.has(FEATURE_TEXT_CONFLICTS)) void this.track(this.sendNotes(link, id, texts));
      } catch (e) {
        console.error(`bogen: could not compare "${id}" for conflicts: ${errorMessage(e)}`);
      }
    }
    if (!base) {
      // Loading a file with no state adds a first page, which would then sit next to the one coming in.
      await atomicWrite(this.deps.storage.docPath(id), update);
      return true;
    }
    const room = await this.deps.rooms.get(id);
    // Catch-up carries what the other device did while apart: edits it made on a branch this file has since switched
    // away from go to that branch, not into the one checked out now (design-branches.ts).
    const diverted = catchUp ? applyRemoteUpdate({ storage: this.deps.storage }, room, update, catchUp.remoteSv, { name: link.record.name, id: `peer:${link.id}` }, `peer:${link.id}`).diverted : (Y.applyUpdate(room.doc.y, update, `peer:${link.id}`), false);
    // Text repairs were worked out against the branch live here, which a diverted update was not meant for.
    if (diverted) fixes = [];
    rescueStranded(room.doc, 'peer-rescue');
    if (fixes.length) {
      // Goes to the other device like any edit. If it settles the same text at the same time, the layer keeps one copy.
      room.doc.transact(() => {
        for (const fix of fixes) {
          const m = room.doc.nodes.get(fix.nodeId) as Y.Map<unknown> | undefined;
          if (m && !m._item?.deleted) replaceLayerText(m, fix.text, fix.spans);
        }
      }, TEXT_CONFLICT);
    }
    return true;
  }

  /** The other device settled nothing itself, so it hears about the text conflict from here, as its own note. */
  private async sendNotes(link: PeerLink, id: string, notes: RawConflict[]): Promise<void> {
    try {
      await this.peerFetch(link, `/api/peer/files/${id}/conflicts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conflicts: notes }) }, MAX_JSON_BYTES, 30_000);
    } catch (e) {
      console.error(`bogen: could not tell ${link.record.name} about a text conflict: ${errorMessage(e)}`);
    }
  }

  // ---------------------------------------------------------------- HTTP, peer facing

  /** `/api/peer/*`. Always needs the peer token, on either listener. Browsers have no business here. */
  async handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    try {
      if (!this.started || this.closed) throw new HttpError(503, 'Not ready.');
      if (req.headers.origin !== undefined) throw new HttpError(403, 'Not for browsers.');
      if (!this.checkBearer(req)) throw new HttpError(401, 'A valid peer token is required.');
      const parts = url.pathname.split('/').filter(Boolean).slice(2);
      const method = req.method ?? 'GET';
      const [a, b, c] = parts;
      if (a === 'register' && !b && method === 'POST') return send(res, 200, await this.onRegister(req));
      const device = req.headers[DEVICE_HEADER];
      const link = typeof device === 'string' ? this.links.get(device) : undefined;
      if (!link) throw new HttpError(403, 'This device is not paired.');
      this.heard(link, req.headers[VERSION_HEADER], req.headers[FEATURES_HEADER]);
      if (a === 'manifest' && !b && method === 'GET') return send(res, 200, await this.manifest());
      if (a === 'runs' && this.deps.remoteRuns) return await this.deps.remoteRuns({ id: link.id, name: link.record.name }, req, res, parts.slice(1));
      if (a === 'timeline' && this.deps.timelineSync) return await this.deps.timelineSync().serve(req, res, url, parts.slice(1), send);
      if (a === 'files' && b && c === 'sync' && method === 'POST') {
        if (!FILE_ID.test(b)) throw new HttpError(404, 'No such file.');
        return send(res, 200, await this.serveSync(link, b, await parseBody(req, SyncBody, MAX_SYNC_BYTES)));
      }
      if (a === 'files' && b && c === 'conflicts' && method === 'POST') {
        if (!FILE_ID.test(b) || !this.deps.storage.get(b)) throw new HttpError(404, 'No such file.');
        const body = await parseBody(req, NotesBody, MAX_JSON_BYTES);
        this.conflicts.add(b, link.record.name, body.conflicts.map((c) => fromTheOtherSide(c as RawConflict)));
        return send(res, 200, { ok: true });
      }
      if (a === 'assets' && b && !c && method === 'GET') {
        if (!Storage.isAssetName(b)) throw new HttpError(404, 'No such asset.');
        const asset = await this.deps.storage.readAsset(b, { localOnly: true });
        if (!asset) throw new HttpError(404, 'No such asset.');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
        res.end(asset.bytes);
        return;
      }
      throw new HttpError(404, 'No such route.');
    } catch (e) {
      if (res.headersSent) return void res.destroy();
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(`bogen: ${req.method} ${url.pathname}: ${errorMessage(e)}`);
      send(res, status, { error: errorMessage(e) });
    }
  }

  private async onRegister(req: IncomingMessage): Promise<{ id: string; name: string; version: string }> {
    const body = await parseBody(req, RegisterBody);
    if (body.id === this.deviceId) throw new HttpError(409, 'That is this device.');
    let url: string;
    try {
      url = normalizePeerUrl(body.url, this.allowAnyHost);
    } catch (e) {
      throw new HttpError(400, errorMessage(e));
    }
    await this.upsertPeer({ id: body.id, name: body.name, url, token: body.token });
    return { id: this.deviceId, name: this.deviceName, version: this.version };
  }

  private async upsertPeer(record: PeerRecord): Promise<void> {
    const existing = this.links.get(record.id);
    if (existing) {
      const moved = existing.record.url !== record.url || existing.record.token !== record.token;
      existing.record = record;
      if (moved) {
        existing.outgoing?.terminate();
        existing.outgoing = null;
        existing.backoff = INITIAL_BACKOFF_MS;
        this.dial(existing);
      }
    } else this.openLink(record);
    await this.savePeers();
    this.notify();
  }

  private async manifest(): Promise<z.input<typeof Manifest>> {
    const { storage } = this.deps;
    const files: RemoteFile[] = storage.listAll().filter((f) => !this.tombstones.has(f.id)).map((f) => ({ id: f.id, name: f.name, nameAt: f.nameAt ?? 0, createdAt: f.createdAt, updatedAt: f.updatedAt, ...(f.kind ? { kind: f.kind } : {}) }));
    for (const [id, t] of this.tombstones) files.push({ id, name: t.name, updatedAt: t.deletedAt, deleted: true, snapshot: t.snapshot });
    const phone = this.deps.phoneUrl?.();
    return { files, assets: await storage.listAssets(), version: this.version, features: OWN_FEATURES, ...(phone ? { phone } : {}) };
  }

  private serveSync(link: PeerLink, id: string, body: z.output<typeof SyncBody>): Promise<z.output<typeof SyncResult>> {
    return this.withFile(id, async () => {
      if (this.tombstones.has(id)) return { update: '', sv: '', deleted: true };
      const { storage, rooms } = this.deps;
      if (!storage.get(id)) throw new HttpError(404, 'No such file.');
      const sv = unb64(body.sv);
      try {
        Y.decodeStateVector(sv);
      } catch {
        throw new HttpError(400, 'The state vector is not valid.');
      }
      const apart = link.apart.has(id);
      if (body.update) {
        link.bytesIn += body.update.length;
        try {
          await this.applyChecked(link, id, unb64(body.update), { remoteSv: sv, apart: apart || Boolean(body.apart) });
        } catch (e) {
          this.stats.updatesRefused++;
          throw new HttpError(422, `The update was refused: ${errorMessage(e)}`);
        }
      }
      const live = rooms.peek(id);
      const saved = live ? null : await storage.readDoc(id);
      // What was changed here while apart goes with this answer, so the other side hears it once, then it is spent.
      if (apart) {
        link.apart.delete(id);
        this.saveStateSoon();
      }
      if (saved) return { update: b64(Y.diffUpdate(saved, sv)), sv: b64(Y.encodeStateVectorFromUpdate(saved)), ...(apart ? { apart } : {}) };
      // Never written, so it has no page yet. Only its first home may make one, or the two would both add theirs.
      const room = live ?? await rooms.get(id);
      return { update: b64(Y.encodeStateAsUpdate(room.doc.y, sv)), sv: b64(Y.encodeStateVector(room.doc.y)), ...(apart ? { apart } : {}) };
    });
  }

  // ---------------------------------------------------------------- catch-up

  private async peerFetch(link: PeerLink, path: string, init: RequestInit, limit: number, timeoutMs: number): Promise<Buffer> {
    const url = normalizePeerUrl(link.record.url, this.allowAnyHost);
    if (typeof init.body === 'string') link.bytesOut += init.body.length;
    const res = await fetch(`${url}${path}`, {
      ...init,
      // A redirect would carry the token somewhere else.
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.abort.signal]),
      headers: { ...this.headers(link), ...(init.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new HttpError(res.status, res.status === 401 ? 'The peer refused this token.' : `The peer answered ${res.status} for ${path}.`);
    }
    const body = await readLimited(res, limit);
    link.bytesIn += body.length;
    return body;
  }

  /** A request to a paired device's `/api/peer/*`, with this device's token and name, for features beyond sync. */
  async request(peerId: string, path: string, init: RequestInit = {}, limit = MAX_JSON_BYTES, timeoutMs = 30_000): Promise<Buffer> {
    const link = this.links.get(peerId);
    if (!link) throw new HttpError(404, 'No such paired device.');
    if (!path.startsWith('/api/peer/')) throw new Error('Only peer routes.');
    const url = normalizePeerUrl(link.record.url, this.allowAnyHost);
    const res = await fetch(`${url}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.abort.signal]),
      headers: { ...this.headers(link), ...(init.headers as Record<string, string> | undefined) },
    });
    const body = await readLimited(res, limit);
    if (!res.ok) {
      // The other device's own words, which say why: a refusal, a missing file.
      let said = '';
      try {
        said = String((JSON.parse(body.toString('utf8')) as { error?: unknown }).error ?? '');
      } catch {
        // Not JSON: the status says it.
      }
      throw new HttpError(res.status, said.slice(0, 500) || (res.status === 401 ? 'The peer refused this token.' : `The peer answered ${res.status} for ${path}.`));
    }
    return body;
  }

  private async postSync(link: PeerLink, id: string, body: z.input<typeof SyncBody>): Promise<z.output<typeof SyncResult>> {
    const raw = await this.peerFetch(link, `/api/peer/files/${id}/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, MAX_SYNC_BYTES, 120_000);
    return SyncResult.parse(JSON.parse(raw.toString('utf8')));
  }

  private requestCatchUp(link: PeerLink, kind: 'changed' | 'full'): void {
    if (this.closed || link.removed) return;
    if (link.catching) {
      link.again = link.again === 'full' || kind === 'full' ? 'full' : 'changed';
      return;
    }
    link.catching = true;
    void this.track(this.runCatchUps(link, kind));
  }

  private async runCatchUps(link: PeerLink, first: 'changed' | 'full'): Promise<void> {
    let kind: 'changed' | 'full' | null = first;
    while (kind && !this.closed && !link.removed) {
      link.again = null;
      try {
        await this.catchUp(link, kind === 'full');
        link.lastSyncAt = Date.now();
        this.saveStateSoon();
      } catch (e) {
        if (!this.closed) link.error = errorMessage(e);
      }
      this.notify();
      kind = link.again;
    }
    link.catching = false;
  }

  private async catchUp(link: PeerLink, full: boolean): Promise<void> {
    const raw = await this.peerFetch(link, '/api/peer/manifest', {}, MAX_JSON_BYTES, 30_000);
    const manifest = Manifest.parse(JSON.parse(raw.toString('utf8')));
    this.heard(link, manifest.version, manifest.features, manifest.phone ?? null);
    let failure: string | undefined;
    for (const remote of manifest.files) {
      if (this.closed || link.removed) return;
      try {
        await this.reconcile(link, remote, full);
      } catch (e) {
        failure = `${remote.name}: ${errorMessage(e)}`;
        console.error(`bogen: could not sync "${remote.name}" with ${link.record.name}: ${errorMessage(e)}`);
      }
    }
    const missing = (await Promise.all(manifest.assets.filter(Storage.isAssetName).map(async (name) => ((await this.deps.storage.hasAsset(name)) || link.refusedAssets.has(name) ? null : name)))).filter((n): n is string => n !== null);
    link.missingAssets = missing.length;
    this.notify();
    for (const name of missing) {
      if (this.closed || link.removed) return;
      await this.pullAsset(link, name).catch(() => false);
      link.missingAssets--;
    }
    link.missingAssets = 0;
    await this.deps.timelineSync?.().pull((path, limit) => this.peerFetch(link, path, {}, limit, 120_000));
    if (link.refusedAssets.size) failure ??= `refused ${link.refusedAssets.size} damaged or unsupported asset(s)`;
    link.error = failure;
  }

  private seenKey(remote: RemoteFile, local: FileEntry | undefined): string {
    return `${remote.updatedAt}|${remote.nameAt ?? 0}|${remote.deleted ? 1 : 0}|${local?.updatedAt ?? 0}|${local?.nameAt ?? 0}`;
  }

  private async reconcile(link: PeerLink, remote: RemoteFile, full: boolean): Promise<void> {
    const { storage } = this.deps;
    const local = storage.get(remote.id);
    if (!full && !link.dirty.has(remote.id) && link.seen.get(remote.id) === this.seenKey(remote, local)) return;
    const tomb = this.tombstones.get(remote.id);
    if (remote.deleted) {
      if (tomb) {
        link.dirty.delete(remote.id);
        return;
      }
      if (!remote.snapshot) throw new Error('A deleted file came without its snapshot.');
      if (!(await this.withFile(remote.id, () => this.applyRemoteDelete(link, remote, remote.snapshot!)))) return;
    } else if (tomb) {
      if (!(await this.maybeRestore(link, remote, tomb))) {
        link.seen.set(remote.id, this.seenKey(remote, undefined));
        return;
      }
      await this.syncExisting(link, remote);
    } else if (!local) {
      await this.pullNew(link, remote);
    } else {
      await this.syncExisting(link, remote);
    }
    link.dirty.delete(remote.id);
    link.seen.set(remote.id, this.seenKey(remote, storage.get(remote.id)));
  }

  /** The state is written before the file is listed, so nothing can open it and add a first page of its own. */
  private async pullNew(link: PeerLink, remote: RemoteFile): Promise<void> {
    const { storage, hub } = this.deps;
    const answer = await this.postSync(link, remote.id, { sv: b64(EMPTY_STATE_VECTOR) });
    if (answer.deleted) return;
    const state = unb64(answer.update);
    const probe = new BogenDoc(new Y.Doc());
    try {
      Y.applyUpdate(probe.y, state);
      assertWellFormed(probe);
    } finally {
      probe.y.destroy();
    }
    const arrived = await this.withFile(remote.id, async () => {
      if (this.tombstones.has(remote.id)) return false;
      // A second peer may have brought the same file in the meantime.
      if (storage.get(remote.id)) {
        await this.applyChecked(link, remote.id, state);
        return false;
      }
      await atomicWrite(storage.docPath(remote.id), state);
      this.listEntry(remote);
      return true;
    });
    if (!arrived) return;
    hub.broadcast({ t: 'files' });
    this.deps.onFileArrived?.(remote.id);
    this.hintPeers(link.id);
  }

  private listEntry(remote: RemoteFile): void {
    const { storage } = this.deps;
    this.quiet++;
    try {
      storage.create(remote.name, remote.id, remote.kind);
      storage.update(remote.id, { nameAt: remote.nameAt ?? 0, updatedAt: remote.updatedAt, ...(remote.createdAt ? { createdAt: remote.createdAt } : {}) });
    } finally {
      this.quiet--;
    }
  }

  private async syncExisting(link: PeerLink, remote: RemoteFile): Promise<void> {
    const { storage, hub } = this.deps;
    this.mergeName(link, remote);
    const apart = link.apart.has(remote.id);
    const state = await this.currentState(remote.id);
    const answer = await this.postSync(link, remote.id, { sv: b64(state ? Y.encodeStateVectorFromUpdate(state) : EMPTY_STATE_VECTOR), ...(apart ? { apart } : {}) });
    if (answer.deleted) {
      // Deleted over there since the manifest was read. The next sweep sees the tombstone.
      this.requestCatchUp(link, 'changed');
      return;
    }
    const update = unb64(answer.update);
    const after = await this.withFile(remote.id, async () => {
      if (!storage.get(remote.id)) return null;
      const before = storage.get(remote.id)!.updatedAt;
      if (update.length > EMPTY_UPDATE_BYTES && await this.applyChecked(link, remote.id, update, { remoteSv: unb64(answer.sv), apart: apart || Boolean(answer.apart) })) {
        // The time the edit was made there, not the time it got here, keeps the file list in a useful order.
        storage.update(remote.id, { updatedAt: Math.max(before, remote.updatedAt) });
        hub.broadcast({ t: 'files' });
      }
      return this.currentState(remote.id);
    });
    if (!after) return;
    const diff = Y.diffUpdate(after, unb64(answer.sv));
    if (diff.length > EMPTY_UPDATE_BYTES) await this.postSync(link, remote.id, { sv: b64(Y.encodeStateVectorFromUpdate(after)), update: b64(diff), ...(apart ? { apart } : {}) });
    if (apart) {
      link.apart.delete(remote.id);
      this.saveStateSoon();
    }
  }

  /** Last rename wins. The device id breaks a tie, so both sides pick the same name. */
  private mergeName(link: PeerLink, remote: RemoteFile): void {
    const { storage, hub } = this.deps;
    const local = storage.get(remote.id);
    if (!local || remote.name === local.name) return;
    const theirs = remote.nameAt ?? 0;
    const ours = local.nameAt ?? 0;
    if (theirs > ours || (theirs === ours && link.id > this.deviceId)) {
      this.quiet++;
      try {
        storage.update(remote.id, { name: remote.name, nameAt: theirs });
      } finally {
        this.quiet--;
      }
      hub.broadcast({ t: 'files' });
      this.hintPeers(link.id);
    }
  }

  // ---------------------------------------------------------------- deleting

  /** Called before a local delete. Without peers nothing is kept, and deleting works as it always did. */
  async recordDelete(id: string): Promise<void> {
    if (!this.started || !this.links.size) return;
    const entry = this.deps.storage.get(id);
    if (!entry) return;
    await this.withFile(id, async () => {
      const state = await this.currentState(id);
      const probe = new Y.Doc();
      try {
        if (state) Y.applyUpdate(probe, state);
        await this.writeTombstone(id, { name: entry.name, deletedAt: Date.now(), snapshot: snapshotOf(probe) }, state);
      } finally {
        probe.destroy();
      }
    });
    this.hintPeers();
  }

  private async writeTombstone(id: string, tomb: Tombstone, state: Uint8Array | null): Promise<void> {
    // The doc is kept for a while, because a concurrent edit brings the file back, and then these edits count too.
    if (state) await atomicWrite(this.tombstoneDocPath(id), state, 0o600);
    this.tombstones.set(id, tomb);
    await this.saveState();
  }

  /**
   * True when the file is gone or was never here. A file with edits the deleting device had not seen stays:
   * the other side finds those same edits and restores it. A file open in an editor stays until nobody has it
   * open, because anything typed after the socket closes would exist only in that browser.
   */
  private async applyRemoteDelete(link: PeerLink, remote: RemoteFile, snapshot: string): Promise<boolean> {
    const { storage, rooms, hub } = this.deps;
    const tomb = { name: remote.name, deletedAt: remote.updatedAt, snapshot };
    if (!storage.get(remote.id)) {
      this.tombstones.set(remote.id, tomb);
      await this.saveState();
      return true;
    }
    const room = rooms.peek(remote.id);
    if (room && (room.conns.size > 0 || room.agents.size > 0)) return false;
    const state = await this.currentState(remote.id);
    const probe = new Y.Doc();
    let ours: string;
    try {
      if (state) Y.applyUpdate(probe, state);
      ours = snapshotOf(probe);
    } finally {
      probe.destroy();
    }
    if (beyond(ours, snapshot)) {
      this.hintPeers();
      return false;
    }
    await this.writeTombstone(remote.id, tomb, state);
    rooms.drop(remote.id);
    // The notes go in the same moment the file leaves the list, not after its files are off the disk.
    this.conflicts.forget(remote.id);
    for (const other of this.links.values()) other.apart.delete(remote.id);
    await storage.remove(remote.id);
    hub.broadcast({ t: 'files' });
    this.hintPeers(link.id);
    return true;
  }

  /** The peer still has a file deleted here. If it has edits the delete did not know, the edits win. */
  private async maybeRestore(link: PeerLink, remote: RemoteFile, tomb: Tombstone): Promise<boolean> {
    const { storage, hub } = this.deps;
    const answer = await this.postSync(link, remote.id, { sv: b64(EMPTY_STATE_VECTOR) });
    if (answer.deleted) return false;
    const restored = await this.withFile(remote.id, async () => {
      if (!this.tombstones.has(remote.id)) return Boolean(storage.get(remote.id));
      const probe = new BogenDoc(new Y.Doc());
      try {
        Y.applyUpdate(probe.y, unb64(answer.update));
        assertWellFormed(probe);
        if (!beyond(snapshotOf(probe.y), tomb.snapshot)) return false;
        // What this device did before it deleted counts too, and goes back to the peer in the sync that follows.
        const kept = await readFile(this.tombstoneDocPath(remote.id)).catch(() => null);
        if (kept) Y.applyUpdate(probe.y, kept);
        await atomicWrite(storage.docPath(remote.id), Y.encodeStateAsUpdate(probe.y));
      } finally {
        probe.y.destroy();
      }
      this.tombstones.delete(remote.id);
      await this.saveState();
      await rm(this.tombstoneDocPath(remote.id), { force: true });
      this.listEntry(remote);
      return true;
    });
    if (!restored) return false;
    hub.broadcast({ t: 'files' });
    this.deps.onFileArrived?.(remote.id);
    console.error(`bogen: "${remote.name}" was deleted here but edited on ${link.record.name}, so it is back.`);
    this.hintPeers(link.id);
    return true;
  }

  // ---------------------------------------------------------------- assets

  private pullAsset(link: PeerLink, name: string): Promise<boolean> {
    const running = this.assetPulls.get(name);
    if (running) return running;
    const work = this.fetchAsset(link, name).finally(() => this.assetPulls.delete(name));
    this.assetPulls.set(name, work);
    return work;
  }

  private async fetchAsset(link: PeerLink, name: string): Promise<boolean> {
    const { storage } = this.deps;
    if (await storage.hasAsset(name)) return true;
    const mime = Storage.mimeOf(name);
    if (!Storage.extensionFor(mime)) {
      link.refusedAssets.add(name);
      return false;
    }
    const bytes = await this.peerFetch(link, `/api/peer/assets/${name}`, {}, this.options.peerMaxAssetBytes ?? MAX_ASSET_BYTES, 120_000);
    if (createHash('sha256').update(bytes).digest('hex') !== name.split('.')[0]) {
      this.stats.assetsRefused++;
      link.refusedAssets.add(name);
      link.error = `refused asset ${name}: its content does not match its hash`;
      console.error(`bogen: refused asset ${name} from ${link.record.name}: its content does not match its hash.`);
      return false;
    }
    this.assetSource.set(name, link.id);
    try {
      await storage.putAsset(bytes, mime);
    } finally {
      this.assetSource.delete(name);
    }
    this.stats.assetsPulled++;
    return true;
  }

  private async pullOnDemand(name: string): Promise<boolean> {
    if (!this.started || this.closed) return false;
    for (const link of this.links.values()) {
      if (!link.socket() || link.refusedAssets.has(name)) continue;
      try {
        if (await this.pullAsset(link, name)) return true;
      } catch {
        // This peer does not have it.
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- admin, for the local CLI

  private async ownUrl(allowLocal: boolean): Promise<string> {
    if (!allowLocal) {
      await this.setTailnet(true);
      const url = await this.tailnet.refresh();
      if (url) return url;
      throw new HttpError(409, 'No Tailscale address here. Start Tailscale (`tailscale up`) and try again.');
    }
    return this.tailnet.url ?? this.deps.localUrl();
  }

  private async setTailnet(on: boolean): Promise<void> {
    if (this.tailnetSetting !== on) {
      this.tailnetSetting = on;
      this.config.tailnet = on;
      await this.saveConfig();
    }
    // Asked for by hand, off means off now, also in a run started with --tailnet. That flag turns it on
    // again at the next start, which the CLI says.
    this.tailnetFlag = false;
    if (on) this.tailnet.start();
    else await this.tailnet.stop();
  }

  /** `/api/peers`. Reached through the loopback guard, and never on the tailnet listener. */
  async handleAdmin(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
    if (!this.started) throw new HttpError(503, 'Not ready.');
    const [, b] = parts;
    const method = req.method ?? 'GET';
    if (!b && method === 'GET') {
      return send(res, 200, {
        device: this.device(), tailnet: this.tailnetSetting || this.tailnetFlag,
        peers: this.status().map((p) => ({ ...p, url: this.links.get(p.id)!.record.url })),
      });
    }
    if (!b && method === 'POST') return send(res, 201, await this.addPeer(await parseBody(req, AddBody)));
    if (b === 'pair' && method === 'POST') return send(res, 200, await this.pair(await parseBody(req, PairBody)));
    if (b === 'tailnet' && method === 'POST') {
      const { on } = await parseBody(req, TailnetBody);
      await this.setTailnet(on);
      return send(res, 200, { on, url: on ? await this.tailnet.refresh() : this.tailnet.url, ...(on ? {} : { onAtStart: Boolean(this.options.tailnet) }) });
    }
    if (b && method === 'DELETE') return send(res, 200, await this.removePeer(decodeURIComponent(b)));
    throw new HttpError(404, 'No such route.');
  }

  private async pair(body: z.output<typeof PairBody>): Promise<{ url: string; token: string; name: string; command: string }> {
    if (body.insecure && !this.allowAnyHost) throw new HttpError(403, 'This server was not started with --insecure-allow-any-host.');
    if (body.name && body.name !== this.deviceName) {
      this.deviceName = body.name;
      this.config.deviceName = body.name;
      await this.saveConfig();
    }
    const url = await this.ownUrl(Boolean(body.insecure));
    const quoted = `'${this.deviceName.replace(/'/g, `'\\''`)}'`;
    return { url, token: this.token, name: this.deviceName, command: `bogen peer add ${url} --token ${this.token} --name ${quoted}` };
  }

  private async addPeer(body: z.output<typeof AddBody>): Promise<{ id: string; name: string; url: string }> {
    if (body.insecure && !this.allowAnyHost) throw new HttpError(403, 'This server was not started with --insecure-allow-any-host.');
    let url: string;
    try {
      url = normalizePeerUrl(body.url, Boolean(body.insecure));
    } catch (e) {
      throw new HttpError(400, errorMessage(e));
    }
    const self = await this.ownUrl(Boolean(body.insecure));
    let answer: Response;
    try {
      answer = await fetch(`${url}/api/peer/register`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), this.abort.signal]),
        headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json', 'X-Bogen-Device': this.deviceId },
        body: JSON.stringify({ id: this.deviceId, name: this.deviceName, url: self, token: this.token }),
      });
    } catch (e) {
      throw new HttpError(502, `Could not reach ${url}: ${errorMessage((e as Error).cause ?? e)}. Check that Bogen runs there, that your Tailscale policy allows TCP port 29990 between these devices, and that the firewall there lets Tailscale in; on Omarchy run there: sudo ufw allow in on tailscale0 to any port 29990 proto tcp`);
    }
    const text = (await readLimited(answer, MAX_JSON_BYTES)).toString('utf8');
    if (answer.status === 401) throw new HttpError(401, 'The peer refused this token.');
    if (!answer.ok) throw new HttpError(502, `The peer said ${answer.status}: ${text.slice(0, 300)}`);
    const parsed = z.object({ id: DeviceId, name: DeviceName }).safeParse(JSON.parse(text));
    if (!parsed.success) throw new HttpError(502, 'That answer did not come from a Bogen peer.');
    if (parsed.data.id === this.deviceId) throw new HttpError(409, 'That is this device.');
    const record = { id: parsed.data.id, name: body.name ?? parsed.data.name, url, token: body.token };
    await this.upsertPeer(record);
    return { id: record.id, name: record.name, url };
  }

  private async removePeer(key: string): Promise<{ removed: string; rotated: boolean }> {
    const link = this.links.get(key) ?? [...this.links.values()].find((l) => l.record.name === key);
    if (!link) throw new HttpError(404, `No peer "${key}".`);
    this.closeLink(link);
    this.links.delete(link.id);
    // With nobody left who should know it, the old token stops working. Otherwise it is shared with the others.
    const rotated = this.links.size === 0;
    if (rotated) {
      this.token = randomBytes(32).toString('base64url');
      this.guard.token = this.token;
      this.config.peerToken = this.token;
    }
    await this.savePeers();
    this.notify();
    return { removed: link.record.name, rotated };
  }
}
