import { useEffect, useState } from 'react';
import { Y } from '@bogen/core';
import { WebsocketProvider } from 'y-websocket';
import { phoneOrigin } from '../lib/phone.ts';

/**
 * Files on the phone, in IndexedDB. Every file opened on the phone is stored as Yjs updates, so it opens
 * without the computer and what is edited there merges through the usual provider when it is back. A file
 * kept on the phone also keeps its assets in the Cache API; the others make room for newer ones after a while.
 * Only on the phone listener's origin: on the desktop the server is always there, and none of this runs.
 */

const DB_NAME = 'bogen-offline';
/** Same name as `ASSET_CACHE` in pwa/sw-rules.ts, which the worker reads. Not imported, so that sw.js stands alone. */
const ASSET_CACHE = 'bogen-assets-v1';
/** Files opened and not kept stay until there are more than this many. */
const LOOSE_LIMIT = 12;
/** Past this many stored updates a file is written as one. */
const COMPACT_AFTER = 150;
export const OFFLINE_ORIGIN = 'bogen-offline';
/** Edits closer together than this count as one change in the queue: a drag is many small transactions. */
const CHANGE_GAP_MS = 1500;

/**
 * `queued`: changes made on this phone while it could not reach the computer, which the computer does not have
 * yet. `syncedAt`: when this file was last known to be the same here and there.
 */
export interface StoredFile {
  id: string; name: string; kept: boolean; openedAt: number; assets: string[]; queued?: number; syncedAt?: number | null;
  /** Conflict notes the computer has for this file, as last heard. */
  notes?: number;
}

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('updates', { autoIncrement: true }).createIndex('file', 'file');
      d.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const listeners = new Set<() => void>();
function changed(): void {
  for (const fn of listeners) fn();
}

export function onStoredChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function storedFiles(): Promise<StoredFile[]> {
  if (!phoneOrigin) return [];
  const d = await db();
  return result(d.transaction('files').objectStore('files').getAll() as IDBRequest<StoredFile[]>);
}

async function putFile(record: StoredFile): Promise<void> {
  const d = await db();
  const tx = d.transaction('files', 'readwrite');
  tx.objectStore('files').put(record);
  await done(tx);
  changed();
}

/** Changes fields of a stored file in one transaction, so that two writers in a row do not undo each other. */
export async function patchFile(id: string, patch: (record: StoredFile) => Partial<StoredFile>): Promise<StoredFile | null> {
  if (!phoneOrigin) return null;
  const d = await db();
  const tx = d.transaction('files', 'readwrite');
  const store = tx.objectStore('files');
  const record = await result(store.get(id) as IDBRequest<StoredFile | undefined>);
  if (!record) return null;
  const next = { ...record, ...patch(record) };
  store.put(next);
  await done(tx);
  changed();
  return next;
}

/** Every stored update of a file, as one: what the phone has of it. */
export async function storedState(id: string): Promise<Uint8Array | null> {
  const d = await db();
  const updates = await result(d.transaction('updates').objectStore('updates').index('file').getAll(id) as IDBRequest<{ file: string; update: Uint8Array }[]>);
  return updates.length ? Y.mergeUpdates(updates.map((u) => u.update)) : null;
}

/** How many changes wait for the computer, in how many files. */
export function queueOf(files: Iterable<StoredFile>): { changes: number; files: number } {
  let changes = 0;
  let count = 0;
  for (const f of files) {
    if (!f.queued) continue;
    changes += f.queued;
    count++;
  }
  return { changes, files: count };
}

async function dropFile(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['files', 'updates'], 'readwrite');
  tx.objectStore('files').delete(id);
  const keys = await result(tx.objectStore('updates').index('file').getAllKeys(id));
  for (const key of keys) tx.objectStore('updates').delete(key);
  await done(tx);
}

/** Every asset a document names, found in its encoded state: images, fonts, fills, whatever field holds them. */
export function assetNames(update: Uint8Array): string[] {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(update);
  const names = new Set<string>();
  for (const m of text.matchAll(/(?:bogen-asset:|\/assets\/)([a-f0-9]{64}\.[a-z0-9]{2,5})/g)) names.add(m[1]!);
  return [...names];
}

/** Puts the assets of kept files in the cache and takes out those no kept file uses any more. */
async function syncAssets(): Promise<void> {
  if (!('caches' in window)) return;
  const files = await storedFiles();
  const wanted = new Set(files.filter((f) => f.kept).flatMap((f) => f.assets));
  const cache = await caches.open(ASSET_CACHE);
  const have = new Set((await cache.keys()).map((r) => new URL(r.url).pathname.slice('/assets/'.length)));
  for (const name of have) if (!wanted.has(name)) await cache.delete(`/assets/${name}`);
  for (const name of wanted) {
    if (have.has(name)) continue;
    // One at a time: a phone on a slow link should not open fifty requests. A miss is tried again next time.
    await cache.add(`/assets/${name}`).catch(() => {});
  }
}

export async function setKept(id: string, kept: boolean, name?: string): Promise<void> {
  const files = await storedFiles();
  const existing = files.find((f) => f.id === id);
  const record = existing ?? { id, name: name ?? 'Untitled', kept, openedAt: 0, assets: [] };
  if (existing) await patchFile(id, () => ({ kept, ...(name ? { name } : {}) }));
  else await putFile({ ...record, kept, ...(name ? { name } : {}) });
  if (kept && !(await storedUpdates(id))) await fetchCopy(id, name ?? record.name).catch(() => {});
  void syncAssets().catch(() => {});
}

async function storedUpdates(id: string): Promise<number> {
  const d = await db();
  return result(d.transaction('updates').objectStore('updates').index('file').count(id));
}

/** A file kept before it was ever opened here: its state comes over once, the same way an open file's does. */
function fetchCopy(id: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const y = new Y.Doc();
    const copy = new OfflineDoc(id, y, name);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const provider = new WebsocketProvider(`${proto}//${location.host}/sync`, id, y, { disableBc: true });
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      provider.destroy();
      void copy.loaded.then(() => copy.flush()).then(() => copy.saveAssets()).finally(() => {
        copy.destroy();
        y.destroy();
        if (ok) resolve();
        else reject(new Error('The file did not arrive.'));
      });
    };
    const timer = window.setTimeout(() => finish(false), 20_000);
    provider.on('sync', (synced: boolean) => { if (synced) finish(true); });
  });
}

/** Files that were opened once and not kept make room, oldest first. */
async function evict(): Promise<void> {
  // A file with changes the computer does not have yet never makes room: they would be lost.
  const loose = (await storedFiles()).filter((f) => !f.kept && !f.queued).sort((a, b) => b.openedAt - a.openedAt);
  for (const f of loose.slice(LOOSE_LIMIT)) await dropFile(f.id);
  if (loose.length > LOOSE_LIMIT) changed();
}

/** One open file's copy on the phone. */
export class OfflineDoc {
  /** True once the stored copy is in the document, and it had something in it. */
  readonly loaded: Promise<boolean>;
  private pending: Uint8Array[] = [];
  private timer = 0;
  private assetTimer = 0;
  private stored = 0;
  private closed = false;
  /** Changes waiting for the computer, as stored. */
  queued = 0;
  syncedAt: number | null = null;
  private lastChangeAt = 0;
  private syncedSaved = 0;

  constructor(readonly fileId: string, private readonly y: Y.Doc, private name = '') {
    this.loaded = this.load().catch((e) => {
      console.warn('bogen: no offline copy:', e);
      return false;
    });
  }

  static enabled(): boolean {
    return phoneOrigin && typeof indexedDB !== 'undefined';
  }

  private async load(): Promise<boolean> {
    const d = await db();
    const updates = await result(d.transaction('updates').objectStore('updates').index('file').getAll(this.fileId) as IDBRequest<{ file: string; update: Uint8Array }[]>);
    this.stored = updates.length;
    if (updates.length) {
      Y.transact(this.y, () => {
        for (const { update } of updates) Y.applyUpdate(this.y, update, OFFLINE_ORIGIN);
      }, OFFLINE_ORIGIN);
    }
    if (this.closed) return updates.length > 0;
    this.y.on('update', this.onUpdate);
    // What the server sent before this was ready is part of the document too.
    this.pending.push(Y.encodeStateAsUpdate(this.y));
    this.schedule();
    const record = (await storedFiles()).find((f) => f.id === this.fileId);
    // Counted while this was loading, before there was a record to count in.
    this.queued += record?.queued ?? 0;
    this.syncedAt = Math.max(this.syncedAt ?? 0, record?.syncedAt ?? 0) || null;
    await putFile({ id: this.fileId, name: this.name || record?.name || 'Untitled', kept: record?.kept ?? false, openedAt: Date.now(), assets: record?.assets ?? [], queued: this.queued, syncedAt: this.syncedAt });
    void evict().catch(() => {});
    this.noteAssets();
    return updates.length > 0;
  }

  /** A change made here while the computer could not be reached. A burst of transactions is one change. */
  noteLocalChange(now = Date.now()): void {
    if (now - this.lastChangeAt < CHANGE_GAP_MS && this.queued > 0) {
      this.lastChangeAt = now;
      return;
    }
    this.lastChangeAt = now;
    this.queued++;
    void patchFile(this.fileId, () => ({ queued: this.queued })).catch(() => {});
  }

  /** The computer has everything: the queue is empty, and this file is in sync as of now. */
  noteDelivered(now = Date.now()): void {
    this.queued = 0;
    this.lastChangeAt = 0;
    this.syncedAt = now;
    this.syncedSaved = now;
    void patchFile(this.fileId, () => ({ queued: 0, syncedAt: now })).catch(() => {});
  }

  /** Connected and in sync. Written down now and then, not on every keystroke. */
  noteInSync(now = Date.now()): void {
    this.syncedAt = now;
    if (now - this.syncedSaved < 15_000) return;
    this.syncedSaved = now;
    void patchFile(this.fileId, () => ({ syncedAt: now })).catch(() => {});
  }

  /** The editor learns the name later than the document opens. */
  setName(name: string): void {
    if (!name || name === this.name) return;
    this.name = name;
    void patchFile(this.fileId, () => ({ name })).catch(() => {});
  }

  private onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === OFFLINE_ORIGIN) return;
    this.pending.push(update);
    this.schedule();
  };

  private schedule(): void {
    if (this.timer) return;
    this.timer = window.setTimeout(() => void this.flush(), 400);
  }

  async flush(): Promise<void> {
    window.clearTimeout(this.timer);
    this.timer = 0;
    if (!this.pending.length) return;
    const update = Y.mergeUpdates(this.pending);
    this.pending = [];
    const d = await db();
    const tx = d.transaction('updates', 'readwrite');
    const store = tx.objectStore('updates');
    if (++this.stored > COMPACT_AFTER) {
      for (const key of await result(store.index('file').getAllKeys(this.fileId))) store.delete(key);
      store.add({ file: this.fileId, update: Y.encodeStateAsUpdate(this.y) });
      this.stored = 1;
    } else store.add({ file: this.fileId, update });
    await done(tx);
    this.noteAssets();
  }

  /** Which assets this file uses, looked at a while after it last changed. */
  private noteAssets(): void {
    window.clearTimeout(this.assetTimer);
    this.assetTimer = window.setTimeout(() => void this.saveAssets().catch(() => {}), 3000);
  }

  async saveAssets(): Promise<void> {
    window.clearTimeout(this.assetTimer);
    const assets = assetNames(Y.encodeStateAsUpdate(this.y));
    const record = (await storedFiles()).find((f) => f.id === this.fileId);
    if (!record || assets.join() === record.assets.join()) return;
    await patchFile(this.fileId, () => ({ assets }));
    if (record.kept) await syncAssets();
  }

  destroy(): void {
    if (this.syncedAt && this.syncedAt > this.syncedSaved) {
      const at = this.syncedAt;
      void patchFile(this.fileId, () => ({ syncedAt: at })).catch(() => {});
    }
    this.closed = true;
    this.y.off('update', this.onUpdate);
    window.clearTimeout(this.assetTimer);
    void this.flush().catch(() => {});
  }
}

/** The files stored on this phone, by id, kept current. Empty on the desktop. */
export function useStoredFiles(): Map<string, StoredFile> {
  const [files, setFiles] = useState<Map<string, StoredFile>>(() => new Map());
  useEffect(() => {
    if (!phoneOrigin) return;
    const load = () => void storedFiles().then((list) => setFiles(new Map(list.map((f) => [f.id, f]))), () => {});
    load();
    return onStoredChange(load);
  }, []);
  return files;
}
