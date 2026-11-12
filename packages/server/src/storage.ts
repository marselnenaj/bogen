import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId, type RecentEdit } from '@bogen/core';
import { atomicWrite, atomicWriteSync, errorMessage } from './util.ts';

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

const DEBOUNCE_MS = 400;
const MAX_WAIT_MS = 3000;

interface PendingSave {
  timer: NodeJS.Timeout | null;
  firstAt: number;
  state: () => Uint8Array;
}

/** Files under `$BOGEN_HOME`: `files/<id>.ydoc`, `assets/<sha256>.<ext>`, `index.json`, `config.json`. */
export class Storage {
  private entries = new Map<string, FileEntry>();
  private folders = new Set<string>();
  private pending = new Map<string, PendingSave>();
  private writes = new Map<string, Promise<void>>();
  private indexTimer: NodeJS.Timeout | null = null;
  private indexWrite: Promise<void> = Promise.resolve();
  /** Device sync listens here, so that no way of making a file or an asset can miss it. */
  readonly hooks: { entryChanged?: (id: string) => void; assetAdded?: (name: string) => void; missingAsset?: (name: string) => Promise<boolean> } = {};

  constructor(readonly home: string) {}

  async init(): Promise<void> {
    for (const dir of ['files', 'assets', 'thumbs']) await mkdir(join(this.home, dir), { recursive: true });
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
    Object.assign(entry, patch);
    this.scheduleIndex();
    if (renamed) this.hooks.entryChanged?.(id);
  }

  async remove(id: string): Promise<void> {
    this.entries.delete(id);
    this.dropPending(id);
    await this.writes.get(id)?.catch(() => {});
    await rm(this.docPath(id), { force: true });
    await rm(this.thumbPath(id), { force: true });
    // Versions belong to the file, on this device. Device sync never carries them.
    await rm(join(this.home, 'history', id), { recursive: true, force: true });
    this.scheduleIndex();
  }

  private scheduleIndex(): void {
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      void this.writeIndex();
    }, 150);
    this.indexTimer.unref();
  }

  private writeIndex(): Promise<void> {
    const body = JSON.stringify({ files: [...this.entries.values()], ...(this.folders.size ? { folders: [...this.folders] } : {}) }, null, 2);
    this.indexWrite = this.indexWrite.catch(() => {}).then(() => atomicWrite(join(this.home, 'index.json'), body));
    this.indexWrite.catch((e) => console.error(`bogen: could not write index.json: ${errorMessage(e)}`));
    return this.indexWrite;
  }

  // Documents

  docPath(id: string): string {
    return join(this.home, 'files', `${id}.ydoc`);
  }

  thumbPath(id: string): string {
    return join(this.home, 'thumbs', `${id}.webp`);
  }

  /** The saved state. Null for a file that has never been written. */
  async readDoc(id: string): Promise<Uint8Array | null> {
    await this.flushDoc(id);
    try {
      return await readFile(this.docPath(id));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  /** Saves soon. Keeps pushing back while edits arrive, but never past `MAX_WAIT_MS`. */
  scheduleDoc(id: string, state: () => Uint8Array): void {
    const now = Date.now();
    const pending = this.pending.get(id) ?? { timer: null, firstAt: now, state };
    pending.state = state;
    if (pending.timer) clearTimeout(pending.timer);
    const delay = Math.min(DEBOUNCE_MS, Math.max(0, pending.firstAt + MAX_WAIT_MS - now));
    pending.timer = setTimeout(() => void this.flushDoc(id).catch(() => {}), delay);
    pending.timer.unref();
    this.pending.set(id, pending);
  }

  private dropPending(id: string): void {
    const pending = this.pending.get(id);
    if (pending?.timer) clearTimeout(pending.timer);
    this.pending.delete(id);
  }

  /** Writes any pending state and waits for writes in flight. Writes per file are serialized. */
  async flushDoc(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (pending) {
      this.dropPending(id);
      const bytes = pending.state();
      const previous = this.writes.get(id) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(() => atomicWrite(this.docPath(id), bytes));
      this.writes.set(id, next);
      next.catch((e) => console.error(`bogen: could not save ${id}: ${errorMessage(e)}`));
    }
    await this.writes.get(id);
  }

  async flushAll(): Promise<void> {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    const ids = new Set([...this.pending.keys(), ...this.writes.keys()]);
    await Promise.all([...ids].map((id) => this.flushDoc(id).catch(() => {})));
    await this.writeIndex().catch(() => {});
  }

  async duplicateDoc(from: string, to: string): Promise<void> {
    await this.flushDoc(from);
    await copyFile(this.docPath(from), this.docPath(to)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }

  /** Moves an unreadable document aside so that nothing overwrites what may be recoverable. */
  async quarantineDoc(id: string): Promise<string> {
    const aside = `${this.docPath(id)}.corrupt-${randomUUID().slice(0, 8)}`;
    await rename(this.docPath(id), aside);
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
    await writeFile(this.thumbPath(id), bytes);
  }
}
