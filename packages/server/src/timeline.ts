import { appendFile, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { diffEncoded, dirtyKeys, encodeKey, LABEL_KEY, rootNames, summarizeOps, UNTRACKED_ROOTS, type ChangeLabel, type ChangeOp, type Encoded, type EditLocation, type Y } from '@bogen/core';
import { editLocations } from './recent-edits.ts';
import { sourceOf } from './file-events.ts';
import type { Storage } from './storage.ts';
import type { Room } from './sync.ts';
import { atomicWrite, errorMessage } from './util.ts';

/**
 * The change timeline of a file: every transaction, with who, when, by which tool and what it did to
 * which layers, on disk under `$BOGEN_HOME/history/<id>/changes-<device>.jsonl`, one log per device.
 * Each device writes what happened on it, and logs travel to other devices as they are, so a change is
 * listed once however many devices have it.
 *
 * Retention, per file and per device:
 * - The last 30 days, up to 32 MB: every entry with its details, so it can be reverted.
 * - Older, or over that: who, when, which tool and which layers stay, and the details are dropped. Such a
 *   change can no longer be reverted, and says so.
 * - At most 50,000 entries. The oldest records go after that.
 * Named commits are kept apart from this and for good. See `history.ts`.
 */
export interface ChangeEntry {
  /** `<device>:<seq>`, unique across devices. */
  id: string;
  device: string;
  deviceName: string;
  seq: number;
  at: number;
  source: 'person' | 'agent' | 'peer' | 'system';
  actor: string;
  /** The MCP tool, or what a client said it was doing. */
  tool?: string;
  /** Agent run this belongs to. */
  run?: string;
  summary: string;
  layers: string[];
  layerCount: number;
  locations?: EditLocation[];
  locationCount?: number;
  fields?: string[];
  ops?: ChangeOp[];
  /** The details were dropped under the retention policy. */
  thinned?: boolean;
  revertOf?: string[];
  restoreOf?: string;
}

export interface TimelineOptions {
  deviceId: () => string;
  deviceName: () => string;
  /** A person's quick edits to the same layers within this long are one entry. */
  coalesceMs?: number;
  maxAgeMs?: number;
  maxOpsBytes?: number;
  maxEntries?: number;
  /** Called when entries are safely written, so that devices can be told. */
  onSealed?: (fileId: string) => void;
  onRecorded?: (fileId: string, entry: ChangeEntry) => void;
  /** A name for another device, for changes that arrive from it. */
  peerName?: (id: string) => string | undefined;
}

const DAY = 86_400_000;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_LAYERS_LISTED = 200;
const SAFE_DEVICE = /^[\w-]{1,80}$/;

interface Open { entry: ChangeEntry; timer: NodeJS.Timeout; signature: string }

interface FileState {
  shadow: Map<string, Encoded>;
  open: Open | null;
  names: Map<string, string>;
  seq: Promise<number> | null;
  next: number;
  nextReceipt: number;
  /** Labels already used. Undo brings back old ones, and those say nothing about the new transaction. */
  seenLabels: Set<string>;
  bytes: number;
}

const TOP = (root: string, key: string) => `${root}\u0000${key}`;

function mergeOps(into: ChangeOp[], more: ChangeOp[]): ChangeOp[] {
  const byPath = new Map(into.map((op) => [op.p.join('\u0000'), op]));
  for (const op of more) {
    const key = op.p.join('\u0000');
    const known = byPath.get(key);
    if (known) {
      if ('a' in op) known.a = op.a;
      else delete known.a;
      if (op.ah) known.ah = op.ah;
      else delete known.ah;
    } else {
      const copy = { ...op };
      byPath.set(key, copy);
      into.push(copy);
    }
  }
  // A field that ended where it started is no change.
  return into.filter((op) => JSON.stringify(op.b) !== JSON.stringify(op.a) || op.ah !== undefined);
}

export class Timeline {
  private files = new Map<string, FileState>();
  private queues = new Map<string, Promise<unknown>>();
  private readonly coalesceMs: number;
  private readonly maxAgeMs: number;
  private readonly maxOpsBytes: number;
  private readonly maxEntries: number;
  private closed = false;
  private seqs = new Map<string, number>();

  constructor(private readonly storage: Storage, private readonly options: TimelineOptions) {
    this.coalesceMs = options.coalesceMs ?? 1500;
    this.maxAgeMs = options.maxAgeMs ?? 30 * DAY;
    this.maxOpsBytes = options.maxOpsBytes ?? 32 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 50_000;
  }

  private dir(fileId: string): string {
    return join(this.storage.home, 'history', fileId);
  }

  /** What arrived from other devices, as seen here. It stays here: their own logs tell it better. */
  private receiptsPath(fileId: string): string {
    return join(this.dir(fileId), 'received.jsonl');
  }

  private logPath(fileId: string, device: string): string {
    if (!SAFE_DEVICE.test(device)) throw new Error('Bad device id.');
    return join(this.dir(fileId), `changes-${device}.jsonl`);
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.queues.set(key, next);
    return next;
  }

  /**
   * Appends to a log of a file that is still here. A file deleted meanwhile has no history to add to: its folder
   * goes with it (`Storage.remove`), at any point between two steps of a write, and nothing may bring it back.
   * False when the file is gone.
   */
  private async appendLog(fileId: string, path: string, text: string): Promise<boolean> {
    if (!this.storage.get(fileId)) return false;
    try {
      await mkdir(this.dir(fileId), { recursive: true, mode: 0o700 });
      await appendFile(path, text, { mode: 0o600 });
      return true;
    } catch (e) {
      // The folder went between the two steps: the file was deleted, and the write goes with it.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !this.storage.get(fileId)) return false;
      throw e;
    }
  }

  /** Starts recording a loaded file. Whatever it holds now is the starting point. */
  watch(room: Room): void {
    const state: FileState = { shadow: new Map(), open: null, names: new Map(), seq: null, next: 0, nextReceipt: 0, seenLabels: new Set(), bytes: 0 };
    this.files.set(room.id, state);
    const { doc } = room;
    for (const root of rootNames(doc)) {
      doc.y.getMap(root).forEach((_, key) => state.shadow.set(TOP(root, key), encodeKey(doc, root, key)));
    }
    const current = doc.meta.get(LABEL_KEY) as ChangeLabel | undefined;
    if (current?.n) state.seenLabels.add(current.n);
    const onTransaction = (tx: Y.Transaction) => {
      try {
        this.onTransaction(room, state, tx);
      } catch (e) {
        console.error(`bogen: could not record a change in ${room.id}: ${errorMessage(e)}`);
      }
    };
    doc.y.on('afterTransaction', onTransaction);
    room.cleanups.push(() => {
      doc.y.off('afterTransaction', onTransaction);
      this.seal(room.id, state);
      if (this.files.get(room.id) === state) this.files.delete(room.id);
    });
    void this.thinIfNeeded(room.id);
  }

  private onTransaction(room: Room, state: FileState, tx: Y.Transaction): void {
    if (!tx.changed.size) return;
    const { doc } = room;
    const ops: ChangeOp[] = [];
    let label: ChangeLabel | null = null;
    for (const { root, key } of dirtyKeys(tx)) {
      if (UNTRACKED_ROOTS.has(root)) continue;
      const id = TOP(root, key);
      const after = encodeKey(doc, root, key);
      const before = state.shadow.get(id);
      if (after === undefined) state.shadow.delete(id);
      else state.shadow.set(id, after);
      if (root === 'meta' && key === LABEL_KEY) {
        const value = after as ChangeLabel | undefined;
        if (value?.n && !state.seenLabels.has(value.n)) {
          label = value;
          state.seenLabels.add(value.n);
        }
        continue;
      }
      diffEncoded([root, key], before, after, ops);
      if (root === 'nodes') {
        const name = ((after ?? before) as { $map?: { name?: string } } | undefined)?.$map?.name;
        if (typeof name === 'string') state.names.set(key, name);
      }
    }
    if (!ops.length) return;
    const who = sourceOf(room, tx.origin);
    let actor = who.actor ?? (who.source === 'person' ? 'Someone' : typeof tx.origin === 'string' ? tx.origin : 'Bogen');
    if (who.source === 'peer') actor = this.options.peerName?.(actor) ?? actor;
    const presence = who.source === 'agent' ? room.agents.get(actor) : undefined;
    const originTool = who.source === 'system' && typeof tx.origin === 'string' ? tx.origin : undefined;
    const tool = label?.label ?? presence?.lastTool ?? originTool;
    const signature = `${who.source}|${actor}|${tool ?? ''}|${[...new Set(ops.map((op) => `${op.p[0]}/${op.p[1]}`))].sort().join()}`;
    const now = Date.now();
    const open = state.open;
    // Dragging a layer is many transactions and one change. Agents' tool calls stay apart.
    if (open && who.source !== 'agent' && !label && open.signature === signature && now - open.entry.at < this.coalesceMs * 20) {
      open.entry.ops = mergeOps(open.entry.ops!, ops);
      this.describe(open.entry, state);
      Object.assign(open.entry, editLocations(doc, open.entry.ops ?? []));
      clearTimeout(open.timer);
      open.timer = this.sealTimer(room.id, state);
      return;
    }
    this.seal(room.id, state);
    const entry: ChangeEntry = {
      id: '', device: this.options.deviceId(), deviceName: this.options.deviceName(), seq: 0, at: now,
      source: who.source, actor, summary: '', layers: [], layerCount: 0, ops,
      ...(tool ? { tool } : {}),
      ...(presence?.runId ? { run: presence.runId } : {}),
      ...(label?.revertOf ? { revertOf: label.revertOf } : {}),
      ...(label?.restoreOf ? { restoreOf: label.restoreOf } : {}),
    };
    this.describe(entry, state);
    Object.assign(entry, editLocations(doc, ops));
    state.open = { entry, signature, timer: this.sealTimer(room.id, state) };
    if (who.source === 'agent' || label) this.seal(room.id, state);
  }

  private describe(entry: ChangeEntry, state: FileState): void {
    const out = summarizeOps(entry.ops ?? [], (id) => state.names.get(id));
    entry.summary = out.summary;
    entry.layers = out.layers.slice(0, MAX_LAYERS_LISTED);
    entry.layerCount = out.layers.length;
    if (out.fields.length) entry.fields = out.fields.slice(0, 40);
    else delete entry.fields;
  }

  private sealTimer(fileId: string, state: FileState): NodeJS.Timeout {
    const timer = setTimeout(() => this.seal(fileId, state), this.coalesceMs);
    timer.unref();
    return timer;
  }

  /** Ends the entry being added to, gives it its number, and writes it. */
  private seal(fileId: string, state: FileState): void {
    const open = state.open;
    if (!open) return;
    clearTimeout(open.timer);
    state.open = null;
    const { entry } = open;
    if (!entry.ops?.length) return;
    const device = entry.device;
    const receipt = entry.source === 'peer';
    const line = this.serial(fileId, async () => {
      if (!this.storage.get(fileId)) return false;
      if (receipt) {
        if (!state.nextReceipt) state.nextReceipt = ((await this.readFileLines(this.receiptsPath(fileId))).at(-1)?.seq ?? 0) + 1;
        entry.seq = state.nextReceipt++;
        entry.id = `${device}:r${entry.seq}`;
      } else {
        if (!state.next) state.next = (await this.lastSeq(fileId, device)) + 1;
        entry.seq = state.next++;
        entry.id = `${device}:${entry.seq}`;
      }
      let text = JSON.stringify(entry);
      if (text.length > MAX_ENTRY_BYTES) {
        // A change of this size stays in the record, without what it would take to turn it around.
        const { ops: _ops, ...rest } = entry;
        text = JSON.stringify({ ...rest, thinned: true });
      }
      if (!(await this.appendLog(fileId, receipt ? this.receiptsPath(fileId) : this.logPath(fileId, device), `${text}\n`))) return false;
      if (!receipt) this.seqs.set(`${fileId}|${device}`, entry.seq);
      state.bytes += text.length;
      return true;
    });
    void line.then((written) => {
      if (!written) return;
      this.options.onRecorded?.(fileId, entry);
      this.options.onSealed?.(fileId);
      if (state.bytes > this.maxOpsBytes / 4) {
        state.bytes = 0;
        void this.thinIfNeeded(fileId);
      }
    }, (e) => console.error(`bogen: could not write a change of ${fileId}: ${errorMessage(e)}`));
  }

  /** Writes everything this file has so far. */
  async flush(fileId: string): Promise<void> {
    const state = this.files.get(fileId);
    if (state) this.seal(fileId, state);
    await this.queues.get(fileId);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [id, state] of this.files) this.seal(id, state);
    // A write that failed was already reported to whoever made it. It must not keep the server from closing.
    await Promise.all([...this.queues.values()].map((q) => q.catch(() => {})));
  }

  private readLog(fileId: string, device: string): Promise<ChangeEntry[]> {
    return this.readFileLines(this.logPath(fileId, device));
  }

  private async readFileLines(path: string): Promise<ChangeEntry[]> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return [];
    }
    const out: ChangeEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as ChangeEntry);
      } catch {
        // A line cut short by a crash loses that line only.
      }
    }
    return out;
  }

  /** Read once per log. After that this process is the only writer, so it knows. */
  private async lastSeq(fileId: string, device: string): Promise<number> {
    const key = `${fileId}|${device}`;
    const known = this.seqs.get(key);
    if (known !== undefined) return known;
    const seq = (await this.readLog(fileId, device)).at(-1)?.seq ?? 0;
    this.seqs.set(key, seq);
    return seq;
  }

  /** Devices with a log for this file. */
  async devices(fileId: string): Promise<string[]> {
    const names = await readdir(this.dir(fileId)).catch(() => [] as string[]);
    return names.flatMap((n) => {
      const m = /^changes-([\w-]+)\.jsonl$/.exec(n);
      return m ? [m[1]!] : [];
    });
  }

  /** Every change on every device, oldest first by time. */
  async all(fileId: string): Promise<ChangeEntry[]> {
    // Only what is written. An entry still being added to shows up when it ends, a moment later.
    await this.queues.get(fileId)?.catch(() => {});
    const devices = await this.devices(fileId);
    const lists = await Promise.all(devices.map((d) => this.readLog(fileId, d)));
    // Another device's log tells the same story as what arrived from it, in more detail.
    const speaking = new Set(devices.map((d) => this.options.peerName?.(d)).filter(Boolean));
    const receipts = (await this.readFileLines(this.receiptsPath(fileId))).filter((e) => !speaking.has(e.actor));
    return [...lists.flat(), ...receipts].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  }

  /** Navigation backfill only: bounded tails, never the full history or a document load. */
  async recent(fileId: string, limit = 40): Promise<ChangeEntry[]> {
    await this.queues.get(fileId)?.catch(() => {});
    limit = Math.max(1, Math.min(40, Math.floor(limit)));
    const tail = async (path: string): Promise<ChangeEntry[]> => {
      const file = await open(path, 'r').catch(() => null);
      if (!file) return [];
      try {
        const size = (await file.stat()).size, length = Math.min(size, 512 * 1024), offset = size - length;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, offset);
        let text = buffer.subarray(0, bytesRead).toString('utf8');
        if (offset) text = text.slice(text.indexOf('\n') + 1);
        const rows: ChangeEntry[] = [];
        for (const line of text.trimEnd().split('\n').slice(-limit)) {
          try { const entry = JSON.parse(line) as ChangeEntry; if (typeof entry.id === 'string' && Number.isFinite(entry.at)) rows.push(entry); } catch { /* Partial/oversized older lines have no reliable navigation hint. */ }
        }
        return rows;
      } finally { await file.close(); }
    };
    const devices = (await this.devices(fileId)).slice(0, 32);
    const speaking = new Set(devices.map(d => this.options.peerName?.(d)).filter(Boolean));
    const lists = await Promise.all(devices.map(d => tail(this.logPath(fileId, d))));
    const receipts = (await tail(this.receiptsPath(fileId))).filter(e => !speaking.has(e.actor));
    return [...lists.flat(), ...receipts].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).slice(-limit);
  }

  /** Changes by id, and a whole run. Newest first, which is the order reverting needs. */
  async pick(fileId: string, query: { ids?: string[]; run?: string }): Promise<ChangeEntry[]> {
    await this.flush(fileId);
    const all = await this.all(fileId);
    const wanted = new Set(query.ids ?? []);
    const picked = all.filter((e) => wanted.has(e.id) || (query.run !== undefined && e.run === query.run && !e.revertOf));
    return picked.reverse();
  }

  /** Lightly: no details, which can be big. `revertedBy` says what has already turned a change back. */
  list(entries: ChangeEntry[]): (Omit<ChangeEntry, 'ops'> & { revertedBy?: string; revertable: boolean })[] {
    const revertedBy = new Map<string, string>();
    for (const e of entries) for (const id of e.revertOf ?? []) revertedBy.set(id, e.id);
    return entries.map(({ ops, ...rest }) => ({
      ...rest,
      revertable: Boolean(ops?.length),
      ...(revertedBy.has(rest.id) ? { revertedBy: revertedBy.get(rest.id) } : {}),
    }));
  }

  /** Drops details that are over the age or size limit, oldest first. Whole lines stay. */
  async thinIfNeeded(fileId: string): Promise<void> {
    if (this.closed) return;
    for (const device of await this.devices(fileId)) {
      const path = this.logPath(fileId, device);
      const size = await stat(path).then((s) => s.size, () => 0);
      await this.serial(fileId, async () => {
        const entries = await this.readLog(fileId, device);
        const cutoff = Date.now() - this.maxAgeMs;
        const old = entries.some((e) => e.ops && e.at < cutoff);
        if (!old && size <= this.maxOpsBytes && entries.length <= this.maxEntries) return;
        let total = entries.reduce((sum, e) => sum + (e.ops ? JSON.stringify(e.ops).length : 0), 0);
        const kept = entries.slice(Math.max(0, entries.length - this.maxEntries)).map((e) => {
          if (e.ops && (e.at < cutoff || total > this.maxOpsBytes)) {
            total -= JSON.stringify(e.ops).length;
            const { ops: _ops, ...rest } = e;
            return { ...rest, thinned: true };
          }
          return e;
        });
        await atomicWrite(path, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), 0o600);
      }).catch((e) => console.error(`bogen: could not thin the changes of ${fileId}: ${errorMessage(e)}`));
    }
  }

  async forget(fileId: string): Promise<void> {
    for (const key of this.seqs.keys()) if (key.startsWith(`${fileId}|`)) this.seqs.delete(key);
    await this.serial(fileId, () => rm(this.dir(fileId), { recursive: true, force: true }));
  }

  // Replication: logs are append-only per device, so a cursor per device is all it takes.

  /** How far this device's copy of each log goes. */
  async cursors(fileId: string): Promise<Record<string, number>> {
    await this.queues.get(fileId)?.catch(() => {});
    const out: Record<string, number> = {};
    for (const device of await this.devices(fileId)) out[device] = await this.lastSeq(fileId, device);
    return out;
  }

  async entriesAfter(fileId: string, device: string, after: number, limit = 500): Promise<ChangeEntry[]> {
    if (!SAFE_DEVICE.test(device)) return [];
    return (await this.readLog(fileId, device)).filter((e) => e.seq > after).slice(0, limit);
  }

  /** Adds another device's entries to its log here. Numbers already held are ignored. */
  async receive(fileId: string, device: string, entries: ChangeEntry[]): Promise<number> {
    if (device === this.options.deviceId() || !SAFE_DEVICE.test(device) || !entries.length) return 0;
    return this.serial(fileId, async () => {
      if (!this.storage.get(fileId)) return 0;
      const last = await this.lastSeq(fileId, device);
      const fresh = entries.filter((e) => Number.isInteger(e.seq) && e.seq > last && e.device === device && typeof e.at === 'number' && typeof e.actor === 'string').sort((a, b) => a.seq - b.seq);
      if (!fresh.length) return 0;
      if (!(await this.appendLog(fileId, this.logPath(fileId, device), fresh.map((e) => JSON.stringify(e)).join('\n') + '\n'))) return 0;
      this.seqs.set(`${fileId}|${device}`, fresh.at(-1)!.seq);
      for (const entry of fresh.slice(-40)) this.options.onRecorded?.(fileId, entry);
      return fresh.length;
    });
  }

}

