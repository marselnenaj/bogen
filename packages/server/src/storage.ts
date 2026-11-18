import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import * as Y from 'yjs';
import { newId, type RecentEdit } from '@bogen/core';
import { decodeRecords, encodeRecords } from './doc-log.ts';
import { atomicWrite, atomicWriteSync, errorMessage, sweepTempFiles } from './util.ts';

export interface FileEntry {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Bounded navigation hints, so listing files never opens their documents. */
  recentEdits?: RecentEdit[];
  thumbnail?: string;
  /** When the name last changed. Device sync merges names by this, apart from content edits. */
  nameAt?: number;
  /** Where the file sits on the dashboard, as a path like `Clients/Acme`. On this device only. */
  folder?: string;
  /** A brand is a file of its own kind. Left out of `list`, and otherwise handled like any file. */
  kind?: 'brand';
  /** The brand this file links to, as last read from its document. */
  brandId?: string;
  /** What the file is a design for, as last read from its document: a person's answer or the file's own records. */
  project?: { type: string; platforms?: string[]; source: 'person' | 'file' | 'unknown' };
  /**
   * For an Omarchy theme: its identity and branches as last read from its document, so that finding a theme's project
   * and listing the theme library never load every theme. The identity is main's; a branch only moves `branch*`.
   */
  theme?: ThemeIndex;
}

/** The compact record of a theme file in the index (theme-projects.ts keeps it). */
export interface ThemeIndex {
  name: string;
  slug: string | null;
  /** The installed theme it started from. */
  from?: string;
  target: 'desktop' | 'mobile';
  profile?: string;
  /** Stable id of the logical theme, given when the file was made; files made before it have none. */
  project?: string;
  /** The checked-out branch. */
  branch: string;
  branchName?: string;
  /** Open branches, main first. */
  branches: { id: string; name: string }[];
  /**
   * This file was brought into another theme project as a branch (theme-consolidate.ts): it is a recoverable source of
   * that project now, not a project of its own. `at` is when; a change after it shows as `changedAfter`.
   */
  consolidatedInto?: { fileId: string; branchId: string; at: number; changed: boolean };
}

/** Fields an older version wrote, such as image keys, are kept in the file and ignored. */
export interface BogenConfig {
  /** A personal access token, kept only if the person asked. */
  figmaToken?: string;
}

const ASSET_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'image/heic': 'heic', 'image/heif': 'heif', 'video/mp4': 'mp4', 'video/webm': 'webm',
  // The other video containers Omarchy plays as theme intros and loop wallpapers, kept as they came.
  'video/x-m4v': 'm4v', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf',
  // Files attached to a comment, which a comment run reads as text.
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json',
};
const ASSET_MIME = Object.fromEntries(Object.entries(ASSET_TYPES).map(([mime, ext]) => [ext, mime]));
/** The only asset names that exist. There is no way to spell a path with this. */
const ASSET_NAME = /^[a-f0-9]{64}\.[a-z0-9]{2,5}$/;
export const FILE_ID = /^[0-9a-z]{4,40}$/;

const INDEX_SOON_MS = 150;
const INDEX_LATE_MS = 5000;
const RECENT_DELAY_MS = 1000;
const DEBOUNCE_MS = 400;
const MAX_WAIT_MS = 3000;
/** A file whose last full save was smaller than this is saved whole each time; that costs less than keeping a log. */
const LOG_FROM_BYTES = 1024 * 1024;
/** The log is folded into the full save once it holds this much, or this share of the full save if that is more... */
const COMPACT_MIN_BYTES = 4 * 1024 * 1024;
const COMPACT_SHARE = 1 / 8;
/** ...and once edits have paused this long, so that a burst of agent writes never waits for it. */
const COMPACT_IDLE_MS = 15_000;
/** Past this the log is folded in at once, pause or not. */
const COMPACT_HARD_BYTES = 64 * 1024 * 1024;

/** What is known about one file's saves. */
interface DocSaves {
  timer: NodeJS.Timeout | null;
  firstAt: number;
  /** The whole document now. Set while the file is loaded. */
  state: (() => Uint8Array) | null;
  /** Updates not yet in the log. */
  pending: Uint8Array[];
  /** The next save writes the whole document instead of appending. */
  whole: boolean;
  /** Size of the last full save, and of the log on disk after it. */
  baseBytes: number;
  logBytes: number;
  compactTimer: NodeJS.Timeout | null;
}

/** Files under `$BOGEN_HOME`: `files/<id>.ydoc`, `assets/<sha256>.<ext>`, `index.json`, `config.json`. */
export class Storage {
  private entries = new Map<string, FileEntry>();
  private folders = new Set<string>();
  private pending = new Map<string, DocSaves>();
  private writes = new Map<string, Promise<void>>();
  private indexTimer: NodeJS.Timeout | null = null;
  private indexSoon = false;
  private indexWrite: Promise<void> = Promise.resolve();
  private recentDirty = new Set<string>();
  private recentTimer: NodeJS.Timeout | null = null;
  private recentWrite: Promise<void> = Promise.resolve();
  /** Device sync listens here, so that no way of making a file or an asset can miss it. */
  readonly hooks: { entryChanged?: (id: string) => void; assetAdded?: (name: string) => void; missingAsset?: (name: string) => Promise<boolean> } = {};

  constructor(readonly home: string) {}

  async init(): Promise<void> {
    for (const dir of ['files', 'assets', 'thumbs']) await mkdir(join(this.home, dir), { recursive: true });
    const swept = await sweepTempFiles(this.home).catch(() => 0);
    if (swept) console.error(`bogen: removed ${swept} temporary file${swept === 1 ? '' : 's'} left by an interrupted write`);
    const path = join(this.home, 'index.json');
    let raw: string | null = null;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as { files?: FileEntry[]; folders?: string[] };
      for (const f of parsed.files ?? []) if (FILE_ID.test(f.id)) this.entries.set(f.id, f);
      for (const f of parsed.folders ?? []) if (typeof f === 'string') this.folders.add(f);
    } catch (e) {
      const aside = `${path}.corrupt-${randomUUID().slice(0, 8)}`;
      await rename(path, aside);
      console.error(`bogen: index.json was unreadable (${errorMessage(e)}), moved to ${aside}`);
    }
    await this.loadRecentEdits();
  }

  /**
   * Recent edits live beside each file's history, not in index.json, which is then written only when the list of
   * files changes. An index from an older version still has them: they move out on the first write.
   */
  private async loadRecentEdits(): Promise<void> {
    let moved = false;
    await Promise.all([...this.entries.values()].map(async (entry) => {
      if (entry.recentEdits?.length) {
        moved = true;
        this.recentDirty.add(entry.id);
        return;
      }
      try {
        const list = JSON.parse(await readFile(this.recentPath(entry.id), 'utf8')) as unknown;
        if (Array.isArray(list) && list.length) entry.recentEdits = list as RecentEdit[];
      } catch { /* none yet, or unreadable: the timeline fills it again when the file opens */ }
    }));
    if (moved) {
      await this.writeRecentEdits();
      await this.writeIndex();
    }
  }

  private recentPath(id: string): string {
    return join(this.home, 'history', id, 'recent-edits.json');
  }

  private scheduleRecent(id: string): void {
    this.recentDirty.add(id);
    if (this.recentTimer) return;
    this.recentTimer = setTimeout(() => {
      this.recentTimer = null;
      void this.writeRecentEdits().catch((e) => console.error(`bogen: could not write recent edits: ${errorMessage(e)}`));
    }, RECENT_DELAY_MS);
    this.recentTimer.unref();
  }

  private writeRecentEdits(): Promise<void> {
    const ids = [...this.recentDirty];
    this.recentDirty.clear();
    this.recentWrite = this.recentWrite.catch(() => {}).then(async () => {
      for (const id of ids) {
        const entry = this.entries.get(id);
        if (!entry) continue;
        await mkdir(join(this.home, 'history', id), { recursive: true });
        await atomicWrite(this.recentPath(id), JSON.stringify(entry.recentEdits ?? []));
      }
    });
    return this.recentWrite;
  }


  // Folders of the dashboard. A file names its folder; this list is what keeps empty ones.

  listFolders(): string[] {
    const all = new Set(this.folders);
    for (const e of this.entries.values()) if (e.folder) all.add(e.folder);
    for (const f of [...all]) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) all.add(parts.slice(0, i).join('/'));
    }
    return [...all].sort((a, b) => a.localeCompare(b));
  }

  addFolder(path: string): void {
    this.folders.add(path);
    this.scheduleIndex();
  }

  moveToFolder(id: string, folder: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (folder) entry.folder = folder;
    else delete entry.folder;
    this.scheduleIndex();
  }

  /** Renames a folder, or moves it by giving it a new path. What is inside goes along. */
  renameFolder(from: string, to: string): void {
    const moved = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p);
    this.folders = new Set([...this.folders].map(moved));
    for (const e of this.entries.values()) if (e.folder) e.folder = moved(e.folder);
    this.scheduleIndex();
  }

  /** Removes a folder. Files and folders in it move up one level; nothing is deleted. */
  removeFolder(path: string): void {
    const up = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const moved = (p: string) => (p === path ? up : p.startsWith(`${path}/`) ? `${up ? `${up}/` : ''}${p.slice(path.length + 1)}` : p);
    this.folders = new Set([...this.folders].map(moved).filter(Boolean));
    for (const e of this.entries.values()) {
      if (!e.folder) continue;
      const next = moved(e.folder);
      if (next) e.folder = next;
      else delete e.folder;
    }
    this.scheduleIndex();
  }

  // Index

  /** Design files. Brands are listed by `listBrands`, and device sync wants `listAll`. */
  list(): FileEntry[] {
    return this.listAll().filter((e) => e.kind !== 'brand');
  }

  listBrands(): FileEntry[] {
    return this.listAll().filter((e) => e.kind === 'brand');
  }

  listAll(): FileEntry[] {
    return [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): FileEntry | undefined {
    return this.entries.get(id);
  }

  create(name: string, id = newId(), kind?: 'brand'): FileEntry {
    const now = Date.now();
    const entry: FileEntry = { id, name, createdAt: now, updatedAt: now, nameAt: now, ...(kind ? { kind } : {}) };
    this.entries.set(id, entry);
    this.scheduleIndex();
    this.hooks.entryChanged?.(id);
    return entry;
  }

  update(id: string, patch: Partial<Pick<FileEntry, 'name' | 'updatedAt' | 'thumbnail' | 'nameAt' | 'createdAt' | 'kind' | 'brandId' | 'project' | 'theme' | 'recentEdits'>>): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    // Always later than the name it replaces, so that a clock running behind another device's still wins.
    const renamed = patch.name !== undefined && patch.nameAt === undefined;
    if (renamed) patch = { ...patch, nameAt: Math.max(Date.now(), (entry.nameAt ?? 0) + 1) };
    const { recentEdits, updatedAt, ...rest } = patch;
    Object.assign(entry, patch);
    if (recentEdits !== undefined) this.scheduleRecent(id);
    // A change of time alone happens on every edit: the list on disk catches up within seconds.
    const meta = Object.keys(rest).length > 0;
    if (meta) this.scheduleIndex();
    else if (updatedAt !== undefined) this.scheduleIndex(false);
    if (renamed) this.hooks.entryChanged?.(id);
  }

  async remove(id: string): Promise<void> {
    this.entries.delete(id);
    this.dropPending(id);
    this.pending.delete(id);
    await this.writes.get(id)?.catch(() => {});
    await rm(this.docPath(id), { force: true });
    await rm(this.logPath(id), { force: true });
    await rm(this.backupPath(id), { force: true });
    await rm(this.thumbPath(id), { force: true });
    // Versions belong to the file, on this device. Device sync never carries them.
    await rm(join(this.home, 'history', id), { recursive: true, force: true });
    this.scheduleIndex();
  }

  /** Writes the list soon, or within `INDEX_LATE_MS` for a change only of when files were edited. */
  private scheduleIndex(soon = true): void {
    if (this.indexTimer && (this.indexSoon || !soon)) return;
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexSoon = soon;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      void this.writeIndex();
    }, soon ? INDEX_SOON_MS : INDEX_LATE_MS);
    this.indexTimer.unref();
  }

  private writeIndex(): Promise<void> {
    const files = [...this.entries.values()].map(({ recentEdits: _recent, ...entry }) => entry);
    const body = JSON.stringify({ files, ...(this.folders.size ? { folders: [...this.folders] } : {}) });
    this.indexWrite = this.indexWrite.catch(() => {}).then(() => atomicWrite(join(this.home, 'index.json'), body));
    this.indexWrite.catch((e) => console.error(`bogen: could not write index.json: ${errorMessage(e)}`));
    return this.indexWrite;
  }

  // Documents

  /** The last full save of a document. Read documents with `readDoc` or `loadDoc`: edits since are in its log. */
  docPath(id: string): string {
    return join(this.home, 'files', `${id}.ydoc`);
  }

  /** Updates since the last full save (doc-log.ts). */
  logPath(id: string): string {
    return join(this.home, 'files', `${id}.updates`);
  }

  /** The full save before the last one, which the log was written against until that one was in place. */
  backupPath(id: string): string {
    return join(this.home, 'files', `${id}.ydoc.bak`);
  }

  thumbPath(id: string): string {
    return join(this.home, 'thumbs', `${id}.webp`);
  }

  /**
   * The saved state as its full save and the updates after it, in order: apply them one after the other. A log cut
   * short by a crash is trimmed to what checks out. Null for a file that has never been written.
   */
  async loadDoc(id: string): Promise<{ base: Uint8Array | null; updates: Uint8Array[] } | null> {
    await this.flushDoc(id);
    const run = this.queue(id, async () => {
      // Missing the full save but holding the one before: a crash came between the two renames of a compaction,
      // and the log was written against that one.
      const base = (await readIfThere(this.docPath(id))) ?? (await readIfThere(this.backupPath(id)));
      const log = await readIfThere(this.logPath(id));
      const { records, validBytes } = log ? decodeRecords(log) : { records: [], validBytes: 0 };
      if (log && validBytes < log.byteLength) {
        console.error(`bogen: the update log of ${id} ended in a torn record; kept the ${records.length} before it`);
        await truncate(this.logPath(id), validBytes);
      }
      const saves = this.saves(id);
      saves.baseBytes = base?.byteLength ?? 0;
      saves.logBytes = validBytes;
      return base || records.length ? { base, updates: records } : null;
    });
    return run;
  }

  /** The saved state as one update. Null for a file that has never been written. */
  async readDoc(id: string): Promise<Uint8Array | null> {
    const saved = await this.loadDoc(id);
    if (!saved) return null;
    const parts = saved.base ? [saved.base, ...saved.updates] : saved.updates;
    return parts.length === 1 ? parts[0]! : Y.mergeUpdates(parts);
  }

  /** Replaces the saved state with a whole document, for a file that is not loaded or whose replica is replaced. */
  async writeDoc(id: string, state: Uint8Array): Promise<void> {
    this.dropPending(id);
    await this.queue(id, () => this.writeWhole(id, state));
  }

  /**
   * An update to a loaded file, and how to get the whole file: saves soon. A small file is saved whole; a big one
   * appends the update to its log, which is folded into a full save when edits pause. Keeps pushing back while
   * edits arrive, but never past `MAX_WAIT_MS`.
   */
  noteUpdate(id: string, update: Uint8Array, state: () => Uint8Array): void {
    const saves = this.saves(id);
    saves.state = state;
    if (saves.whole || saves.baseBytes < LOG_FROM_BYTES) saves.whole = true;
    else saves.pending.push(update);
    this.schedule(id, saves);
    this.scheduleCompaction(id, saves);
  }

  /** Saves the whole document soon, as `noteUpdate` does for a small file. */
  scheduleDoc(id: string, state: () => Uint8Array): void {
    const saves = this.saves(id);
    saves.state = state;
    saves.whole = true;
    saves.pending = [];
    this.schedule(id, saves);
  }

  private saves(id: string): DocSaves {
    let saves = this.pending.get(id);
    if (!saves) {
      saves = { timer: null, firstAt: 0, state: null, pending: [], whole: false, baseBytes: 0, logBytes: 0, compactTimer: null };
      this.pending.set(id, saves);
    }
    return saves;
  }

  private schedule(id: string, saves: DocSaves): void {
    const now = Date.now();
    if (!saves.timer) saves.firstAt = now;
    else clearTimeout(saves.timer);
    const delay = Math.min(DEBOUNCE_MS, Math.max(0, saves.firstAt + MAX_WAIT_MS - now));
    saves.timer = setTimeout(() => void this.flushDoc(id).catch(() => {}), delay);
    saves.timer.unref();
  }

  private scheduleCompaction(id: string, saves: DocSaves): void {
    if (saves.compactTimer) clearTimeout(saves.compactTimer);
    saves.compactTimer = null;
    if (saves.whole) return;
    saves.compactTimer = setTimeout(() => {
      saves.compactTimer = null;
      if (saves.logBytes >= Math.max(COMPACT_MIN_BYTES, saves.baseBytes * COMPACT_SHARE)) void this.flushDoc(id, { compact: true }).catch(() => {});
    }, COMPACT_IDLE_MS);
    saves.compactTimer.unref();
  }

  /** Forgets what is pending for a file, such as one that was deleted or whose saved state is replaced. */
  private dropPending(id: string): void {
    const saves = this.pending.get(id);
    if (!saves) return;
    if (saves.timer) clearTimeout(saves.timer);
    if (saves.compactTimer) clearTimeout(saves.compactTimer);
    saves.timer = null;
    saves.compactTimer = null;
    saves.pending = [];
    saves.whole = false;
  }

  /** Runs one write of a file after the ones before it. */
  private queue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const settled = next.then(() => {}, (e) => console.error(`bogen: could not save ${id}: ${errorMessage(e)}`));
    this.writes.set(id, settled);
    void settled.then(() => { if (this.writes.get(id) === settled) this.writes.delete(id); });
    return next;
  }

  /**
   * Writes what is pending and waits for writes in flight. Writes per file are serialized. With `compact`, a file with
   * a log is saved whole, as when it is unloaded or the server stops.
   */
  async flushDoc(id: string, { compact = false } = {}): Promise<void> {
    const saves = this.pending.get(id);
    if (saves) {
      if (saves.timer) clearTimeout(saves.timer);
      saves.timer = null;
      const whole = saves.whole || ((compact || saves.logBytes >= COMPACT_HARD_BYTES) && saves.state !== null && (saves.logBytes > 0 || saves.pending.length > 0));
      if (whole && saves.state) {
        // The state includes every pending update, so they are dropped here, in the same tick.
        const bytes = saves.state();
        saves.pending = [];
        saves.whole = false;
        if (saves.compactTimer) clearTimeout(saves.compactTimer);
        saves.compactTimer = null;
        void this.queue(id, () => this.writeWhole(id, bytes)).catch(() => {});
      } else if (saves.pending.length) {
        const records = encodeRecords(saves.pending);
        saves.pending = [];
        void this.queue(id, async () => {
          await appendDurably(this.logPath(id), records);
          saves.logBytes += records.byteLength;
        }).catch(() => {});
      }
    }
    await this.writes.get(id);
  }

  /** A full save: the new one is durable before it replaces the old, which stays as the backup until the next. */
  private async writeWhole(id: string, bytes: Uint8Array): Promise<void> {
    const path = this.docPath(id);
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(tmp, 'w', 0o644);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
    } catch (e) {
      await handle.close().catch(() => {});
      await rm(tmp, { force: true });
      throw e;
    }
    const log = this.logPath(id);
    const hasLog = await stat(log).then(() => true, () => false);
    // With a log, the old full save is what the log belongs to: keep it until the new one is in place.
    if (hasLog) await rename(path, this.backupPath(id)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    await rename(tmp, path);
    await rm(log, { force: true });
    const saves = this.saves(id);
    saves.baseBytes = bytes.byteLength;
    saves.logBytes = 0;
  }

  /** Writes the file list now, leaving documents as they are. */
  async flushIndex(): Promise<void> {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    await this.writeIndex();
  }

  async flushAll(): Promise<void> {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    const ids = new Set([...this.pending.keys(), ...this.writes.keys()]);
    await Promise.all([...ids].map((id) => this.flushDoc(id, { compact: true }).catch(() => {})));
    if (this.recentTimer) {
      clearTimeout(this.recentTimer);
      this.recentTimer = null;
    }
    await this.writeRecentEdits().catch(() => {});
    await this.writeIndex().catch(() => {});
  }

  /** A file is closed: what it saves from now on needs a new way to get its state. */
  releaseDoc(id: string): void {
    const saves = this.pending.get(id);
    if (saves && !saves.timer && !saves.pending.length && !saves.whole) {
      if (saves.compactTimer) clearTimeout(saves.compactTimer);
      this.pending.delete(id);
    } else if (saves) saves.state = null;
  }

  async duplicateDoc(from: string, to: string): Promise<void> {
    const state = await this.readDoc(from);
    if (state) await this.writeDoc(to, state);
  }

  /** Moves an unreadable document aside so that nothing overwrites what may be recoverable. */
  async quarantineDoc(id: string): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    const aside = `${this.docPath(id)}.corrupt-${tag}`;
    this.dropPending(id);
    this.pending.delete(id);
    await rename(this.docPath(id), aside).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    await rename(this.logPath(id), `${this.logPath(id)}.corrupt-${tag}`).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    return aside;
  }

  // Assets

  static extensionFor(mime: string): string | undefined {
    return ASSET_TYPES[mime.split(';')[0]!.trim().toLowerCase()];
  }

  static isAssetName(name: string): boolean {
    return ASSET_NAME.test(name);
  }

  static mimeOf(name: string): string {
    return ASSET_MIME[name.split('.').pop() ?? ''] ?? 'application/octet-stream';
  }

  assetPath(name: string): string {
    if (!Storage.isAssetName(name)) throw new Error('Invalid asset name.');
    return join(this.home, 'assets', name);
  }

  async putAsset(bytes: Uint8Array, mime: string): Promise<{ name: string; src: string; url: string }> {
    const ext = Storage.extensionFor(mime);
    if (!ext) throw new Error(`Assets of type ${mime} are not supported.`);
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    const path = this.assetPath(name);
    const exists = await stat(path).then(() => true, () => false);
    if (!exists) {
      await atomicWrite(path, bytes);
      this.hooks.assetAdded?.(name);
    }
    return { name, src: `bogen-asset:${name}`, url: `/assets/${name}` };
  }

  /**
   * The same, synchronously and durably (fsynced): for a record that must exist before anything else happens, such as
   * an update held back from a device that came back after a checkout (design-branches.ts).
   */
  putAssetSync(bytes: Uint8Array, mime: string): { name: string; src: string } {
    const ext = Storage.extensionFor(mime);
    if (!ext) throw new Error(`Assets of type ${mime} are not supported.`);
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    const path = this.assetPath(name);
    if (atomicWriteSync(path, bytes, { exclusive: true })) this.hooks.assetAdded?.(name);
    return { name, src: `bogen-asset:${name}` };
  }

  /** With `localOnly` it never asks a paired device. Answering a device must not send it back to ask us. */
  async readAsset(name: string, { localOnly = false } = {}): Promise<{ bytes: Uint8Array; mime: string } | null> {
    if (!Storage.isAssetName(name)) return null;
    const read = () => readFile(this.assetPath(name)).then((bytes) => ({ bytes, mime: Storage.mimeOf(name) }), () => null);
    const found = await read();
    if (found || localOnly || !this.hooks.missingAsset) return found;
    return (await this.hooks.missingAsset(name).catch(() => false)) ? read() : null;
  }

  async hasAsset(name: string): Promise<boolean> {
    return Storage.isAssetName(name) && stat(this.assetPath(name)).then(() => true, () => false);
  }

  async listAssets(): Promise<string[]> {
    return (await readdir(join(this.home, 'assets')).catch(() => [] as string[])).filter(Storage.isAssetName);
  }

  // Config

  async readConfig(): Promise<BogenConfig> {
    try {
      return JSON.parse(await readFile(join(this.home, 'config.json'), 'utf8')) as BogenConfig;
    } catch {
      return {};
    }
  }

  /** Changes some settings. The file is readable by this user only, as it can hold secrets. */
  async updateConfig(patch: Partial<BogenConfig>): Promise<void> {
    const next = { ...(await this.readConfig()), ...patch } as Record<string, unknown>;
    for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
    await atomicWrite(join(this.home, 'config.json'), JSON.stringify(next, null, 2), 0o600);
    await chmod(join(this.home, 'config.json'), 0o600);
  }

  async writeThumb(id: string, bytes: Uint8Array): Promise<void> {
    // Read while it is written (Home loads thumbnails as they change): never half a picture.
    await atomicWrite(this.thumbPath(id), bytes);
  }
}

async function readIfThere(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Appends and waits until it is on disk. */
async function appendDurably(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'a', 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
