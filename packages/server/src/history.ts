import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { BogenDoc, commentsToContent, docToContent, Y, type DesignContent } from '@bogen/core';
import type { Storage } from './storage.ts';
import { atomicWrite, errorMessage } from './util.ts';

const zip = promisify(gzip);
const unzip = promisify(gunzip);

/**
 * Commits of a file under `$BOGEN_HOME/history/<id>/`: one gzipped plain copy of the design per commit,
 * and a `commits.json`. Together with the change timeline (`timeline.ts`) this is the file's history.
 *
 * Kinds, and what happens to each:
 * - `commit`: named, by a person or an agent. Kept for good.
 * - `run`: made when an agent run ends, with its prompt as the message. Kept for good until the file's
 *   commits pass the size limit, when the oldest of these go first.
 * - `restore`: the state just before a restore or a merge. Same rule as `run`.
 * - `auto`: taken every few minutes while a file changes. Thinned: the latest 24, then one per hour for a
 *   day, one per day for a month. They stay on the device that made them, as the timeline already
 *   travels and these would only be noise there.
 */
export type CommitKind = 'commit' | 'run' | 'restore' | 'auto';

export interface CommitInfo {
  id: string;
  at: number;
  kind: CommitKind;
  message?: string;
  author?: string;
  authorKind?: 'person' | 'agent' | 'system';
  device?: string;
  deviceName?: string;
  run?: string;
  bytes: number;
  pages: number;
  layers: number;
  hash: string;
}

export type CommitContent = DesignContent & { comments?: Record<string, unknown> };

export interface HistoryOptions {
  /** Least time between automatic commits of a file. */
  intervalMs?: number;
  maxBytesPerFile?: number;
  /** Automatic commits that stay however close together they are. */
  keepRecent?: number;
  deviceId?: () => string;
  deviceName?: () => string;
  /** A commit other devices should hear about. */
  onCommit?: (fileId: string, info: CommitInfo) => void;
}

const COMMIT_ID = /^[0-9a-z]{6,14}-[0-9a-f]{8}$/;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Which automatic commits to keep. */
export function thinAuto(commits: CommitInfo[], now: number, keepRecent: number): CommitInfo[] {
  const newest = [...commits].sort((a, b) => b.at - a.at);
  const keep = new Set(newest.slice(0, keepRecent));
  const buckets = new Set<string>();
  for (const c of newest.slice(keepRecent)) {
    const age = now - c.at;
    if (age > 30 * DAY) continue;
    const bucket = age <= DAY ? `h${Math.floor(c.at / HOUR)}` : `d${Math.floor(c.at / DAY)}`;
    if (!buckets.has(bucket)) {
      buckets.add(bucket);
      keep.add(c);
    }
  }
  return newest.filter((c) => keep.has(c));
}

export class History {
  private timers = new Map<string, NodeJS.Timeout>();
  private lastSaved = new Map<string, number>();
  private queue = new Map<string, Promise<unknown>>();
  private readonly intervalMs: number;
  private readonly maxBytes: number;
  private readonly keepRecent: number;

  constructor(private readonly storage: Storage, private readonly liveDoc: (id: string) => BogenDoc | undefined, private readonly options: HistoryOptions = {}) {
    this.intervalMs = options.intervalMs ?? 5 * 60_000;
    this.maxBytes = options.maxBytesPerFile ?? 256 * 1024 * 1024;
    this.keepRecent = options.keepRecent ?? 24;
  }

  private dir(fileId: string): string {
    return join(this.storage.home, 'history', fileId);
  }

  /** One thing at a time per file, so that an index never loses an entry to a race. */
  private serial<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(fileId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.queue.set(fileId, next);
    return next;
  }

  private async readIndex(fileId: string): Promise<CommitInfo[]> {
    try {
      const parsed = JSON.parse(await readFile(join(this.dir(fileId), 'commits.json'), 'utf8')) as { commits?: CommitInfo[] };
      return (parsed.commits ?? []).filter((c) => COMMIT_ID.test(c.id));
    } catch {
      return [];
    }
  }

  private async writeIndex(fileId: string, commits: CommitInfo[]): Promise<void> {
    await atomicWrite(join(this.dir(fileId), 'commits.json'), JSON.stringify({ commits }, null, 1), 0o600);
  }

  /** Newest first. */
  async list(fileId: string): Promise<CommitInfo[]> {
    await this.queue.get(fileId)?.catch(() => {});
    return (await this.readIndex(fileId)).sort((a, b) => b.at - a.at);
  }

  async read(fileId: string, id: string): Promise<CommitContent | null> {
    if (!COMMIT_ID.test(id)) return null;
    try {
      return JSON.parse((await unzip(await readFile(join(this.dir(fileId), `${id}.json.gz`)))).toString('utf8')) as CommitContent;
    } catch {
      return null;
    }
  }

  async readPacked(fileId: string, id: string): Promise<Buffer | null> {
    if (!COMMIT_ID.test(id)) return null;
    return readFile(join(this.dir(fileId), `${id}.json.gz`)).catch(() => null);
  }

  /** Records the design as it is. An automatic commit the same as the latest one is not worth a file. */
  async commit(fileId: string, doc: BogenDoc, options: { message?: string; author?: string; authorKind?: CommitInfo['authorKind']; kind?: CommitKind; run?: string } = {}): Promise<CommitInfo | null> {
    const content: CommitContent = { ...docToContent(doc), comments: commentsToContent(doc) };
    const body = JSON.stringify(content);
    const design = JSON.stringify({ ...content, comments: undefined });
    const hash = createHash('sha256').update(design).digest('hex').slice(0, 32);
    const kind = options.kind ?? (options.message ? 'commit' : 'auto');
    const info = await this.serial(fileId, async () => {
      await mkdir(this.dir(fileId), { recursive: true, mode: 0o700 });
      const index = await this.readIndex(fileId);
      const latest = [...index].sort((a, b) => b.at - a.at)[0];
      if (kind === 'auto' && latest?.hash === hash) {
        this.lastSaved.set(fileId, Date.now());
        return null;
      }
      const at = Math.max(Date.now(), (latest?.at ?? 0) + 1);
      const id = `${at.toString(36)}-${randomBytes(4).toString('hex')}`;
      const packed = await zip(body);
      await atomicWrite(join(this.dir(fileId), `${id}.json.gz`), packed, 0o600);
      const commit: CommitInfo = {
        id, at, kind, bytes: packed.length, pages: content.pages.length, layers: content.nodes.length, hash,
        ...(options.message ? { message: options.message } : {}),
        ...(options.author ? { author: options.author } : {}),
        ...(options.authorKind ? { authorKind: options.authorKind } : {}),
        ...(options.run ? { run: options.run } : {}),
        ...(this.options.deviceId ? { device: this.options.deviceId() } : {}),
        ...(this.options.deviceName ? { deviceName: this.options.deviceName() } : {}),
      };
      await this.keep(fileId, [...index, commit], at);
      this.lastSaved.set(fileId, at);
      return commit;
    });
    if (info && kind !== 'auto') this.options.onCommit?.(fileId, info);
    return info;
  }

  private async keep(fileId: string, commits: CommitInfo[], now: number): Promise<void> {
    const auto = thinAuto(commits.filter((c) => c.kind === 'auto'), now, this.keepRecent);
    const lasting = commits.filter((c) => c.kind !== 'auto');
    let total = [...auto, ...lasting].reduce((sum, c) => sum + c.bytes, 0);
    // Over the limit: the oldest automatic ones, then run and restore points. Named commits never.
    const order = [...auto.slice(1).reverse(), ...lasting.filter((c) => c.kind !== 'commit').sort((a, b) => a.at - b.at)];
    const dropped = new Set<CommitInfo>();
    for (const c of order) {
      if (total <= this.maxBytes) break;
      dropped.add(c);
      total -= c.bytes;
    }
    const kept = [...auto, ...lasting].filter((c) => !dropped.has(c)).sort((a, b) => a.at - b.at);
    await this.writeIndex(fileId, kept);
    const keptIds = new Set(kept.map((c) => c.id));
    for (const old of commits) if (!keptIds.has(old.id)) await rm(join(this.dir(fileId), `${old.id}.json.gz`), { force: true });
  }

  /** A file changed. The first change after the interval is saved shortly afterwards. */
  noteChange(fileId: string): void {
    if (this.timers.has(fileId)) return;
    const since = Date.now() - (this.lastSaved.get(fileId) ?? 0);
    const delay = Math.max(Math.min(this.intervalMs, 30_000), this.intervalMs - since);
    const timer = setTimeout(() => {
      this.timers.delete(fileId);
      void this.saveAuto(fileId);
    }, delay);
    timer.unref();
    this.timers.set(fileId, timer);
  }

  /** The state a file was opened in, so that even its first edit can be taken back. */
  async baseline(fileId: string, doc: BogenDoc): Promise<void> {
    if (doc.nodes.size === 0) return;
    if ((await this.readIndex(fileId)).length) return;
    await this.commit(fileId, doc, { kind: 'auto' }).catch((e) => console.error(`bogen: no commit of ${fileId}: ${errorMessage(e)}`));
  }

  private async saveAuto(fileId: string): Promise<void> {
    try {
      const live = this.liveDoc(fileId);
      if (live) {
        await this.commit(fileId, live, { kind: 'auto' });
        return;
      }
      const state = await this.storage.readDoc(fileId);
      if (!state) return;
      const doc = new BogenDoc(new Y.Doc());
      Y.applyUpdate(doc.y, state);
      await this.commit(fileId, doc, { kind: 'auto' });
    } catch (e) {
      console.error(`bogen: no commit of ${fileId}: ${errorMessage(e)}`);
    }
  }

  async forget(fileId: string): Promise<void> {
    const timer = this.timers.get(fileId);
    if (timer) clearTimeout(timer);
    this.timers.delete(fileId);
    this.lastSaved.delete(fileId);
    await this.serial(fileId, () => rm(this.dir(fileId), { recursive: true, force: true }));
  }

  /** Writes what is waiting, so that the last edits before a shutdown are a commit too. */
  async close(): Promise<void> {
    const waiting = [...this.timers.keys()];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(waiting.map((id) => this.saveAuto(id)));
    // A write that failed was already reported to whoever made it. It must not keep the server from closing.
    await Promise.all([...this.queue.values()].map((q) => q.catch(() => {})));
  }

  // Replication

  /** Commits other devices should have. */
  async shareable(fileId: string): Promise<CommitInfo[]> {
    return (await this.list(fileId)).filter((c) => c.kind !== 'auto');
  }

  /** Adds a commit from another device. The hash in its details is checked against what it holds. */
  async receive(fileId: string, info: CommitInfo, packed: Buffer): Promise<boolean> {
    if (!COMMIT_ID.test(info.id) || info.kind === 'auto') return false;
    let parsed: CommitContent;
    try {
      parsed = JSON.parse((await unzip(packed)).toString('utf8')) as CommitContent;
    } catch {
      return false;
    }
    const hash = createHash('sha256').update(JSON.stringify({ ...parsed, comments: undefined })).digest('hex').slice(0, 32);
    if (hash !== info.hash) return false;
    return this.serial(fileId, async () => {
      // Deleted while the commit was on its way: its history went with it, and this does not bring it back.
      if (!this.storage.get(fileId)) return false;
      await mkdir(this.dir(fileId), { recursive: true, mode: 0o700 });
      const index = await this.readIndex(fileId);
      if (index.some((c) => c.id === info.id)) return false;
      await atomicWrite(join(this.dir(fileId), `${info.id}.json.gz`), packed, 0o600);
      const clean: CommitInfo = { ...info, bytes: packed.length };
      await this.keep(fileId, [...index, clean], Date.now());
      return true;
    });
  }

  async size(fileId: string): Promise<number> {
    let total = 0;
    for (const c of await this.list(fileId)) total += await stat(join(this.dir(fileId), `${c.id}.json.gz`)).then((s) => s.size, () => 0);
    return total;
  }
}

