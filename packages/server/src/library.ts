import * as Y from 'yjs';
import {
  acceptLibraryUpdates, BogenDoc, brandLinkOf, cachedMains, libraryInfo, libraryLinks, libraryTokenRenames, libraryUpdates, linkLibrary, readPublished, unpublishedChanges,
  type LibraryInfo, type LibraryUpdate, type PublishedComponent,
} from '@bogen/core';
import type { EventHub } from './events.ts';
import type { Storage } from './storage.ts';
import type { Room, Rooms } from './sync.ts';

export interface LibrarySummary {
  id: string;
  name: string;
  kind: 'file' | 'brand';
  /** The file's own name, which can differ from what it publishes as. */
  fileName: string;
  description?: string;
  version: number;
  publishedAt: number;
  components: { main: string; name: string; set?: string; version: number }[];
}

export interface LinkedLibrary {
  id: string;
  name: string;
  kind: 'file' | 'brand';
  /** Not on this device, deleted, or no longer published: instances render from the copies. */
  missing: boolean;
  version?: number;
  components: { id: string; main: string; name: string; version: number; removed?: boolean }[];
  updates: LibraryUpdate[];
  /** Tokens the library renamed since this file took its last update: accepting renames them here too. */
  renames: { from: string; to: string }[];
}

/**
 * Which files publish a library, and what a file that links one is missing. A library is a file like
 * any other, so device sync brings it; this only reads documents, and every write is a document
 * transaction made by the caller, so that it is one undo step for whoever made it.
 */
export class Libraries {
  private probes = new Map<string, { updatedAt: number; summary: LibrarySummary | null; published: PublishedComponent[]; info?: LibraryInfo }>();

  constructor(private deps: { storage: Storage; rooms: Rooms; hub: EventHub }) {}

  /** Tells editors when a library a file may link was published, also when that arrives from another device. */
  watch(room: Room): void {
    const published = room.doc.y.getMap('libraryPublished');
    let timer: NodeJS.Timeout | null = null;
    const changed = () => {
      this.probes.delete(room.id);
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        this.deps.hub.broadcast({ t: 'library', id: room.id });
      }, 150);
      timer.unref();
    };
    published.observeDeep(changed);
    room.cleanups.push(() => {
      published.unobserveDeep(changed);
      if (timer) clearTimeout(timer);
    });
  }

  private summarize(id: string, doc: BogenDoc): { summary: LibrarySummary | null; published: PublishedComponent[]; info?: LibraryInfo } {
    const info = libraryInfo(doc);
    const published = info ? readPublished(doc) : [];
    const entry = this.deps.storage.get(id);
    if (!info || !entry || !published.length) return { summary: null, published: [] };
    return {
      published, info,
      summary: {
        id, name: info.name, kind: entry.kind === 'brand' ? 'brand' : 'file', fileName: entry.name, ...(info.description ? { description: info.description } : {}),
        version: info.version, publishedAt: info.publishedAt,
        components: published.map((p) => ({ main: p.main, name: p.name, ...(p.set ? { set: p.set } : {}), version: p.version })),
      },
    };
  }

  /** A library as it is now: from the open room, else from disk without loading a room. */
  private async read(id: string): Promise<{ summary: LibrarySummary | null; published: PublishedComponent[]; info?: LibraryInfo }> {
    const live = this.deps.rooms.peek(id);
    if (live) return this.summarize(id, live.doc);
    const entry = this.deps.storage.get(id);
    if (!entry) return { summary: null, published: [] };
    const known = this.probes.get(id);
    if (known && known.updatedAt === entry.updatedAt) return known;
    const state = await this.deps.storage.readDoc(id);
    let out: { summary: LibrarySummary | null; published: PublishedComponent[]; info?: LibraryInfo } = { summary: null, published: [] };
    if (state) {
      const probe = new BogenDoc(new Y.Doc());
      try {
        Y.applyUpdate(probe.y, state);
        out = this.summarize(id, probe);
      } catch {
        // A damaged file publishes nothing.
      } finally {
        probe.y.destroy();
      }
    }
    this.probes.set(id, { updatedAt: entry.updatedAt, ...out });
    return out;
  }

  async list(): Promise<LibrarySummary[]> {
    const out: LibrarySummary[] = [];
    for (const entry of this.deps.storage.listAll()) {
      const { summary } = await this.read(entry.id);
      if (summary) out.push(summary);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The published components of a library, or null when it is not here or publishes nothing. */
  async get(id: string): Promise<{ summary: LibrarySummary; published: PublishedComponent[]; info?: LibraryInfo } | null> {
    const { summary, published, info } = await this.read(id);
    return summary ? { summary, published, ...(info ? { info } : {}) } : null;
  }

  /** A library by id, by its published name, or by its file's name. */
  async find(ref: string): Promise<LibrarySummary> {
    const all = await this.list();
    const lower = ref.trim().toLowerCase();
    const hit = all.find((l) => l.id === ref) ?? all.find((l) => l.name.toLowerCase() === lower) ?? all.find((l) => l.fileName.toLowerCase() === lower);
    if (!hit) throw new Error(`There is no library "${ref}". Libraries here: ${all.map((l) => `${l.name} (${l.id})`).join(', ') || 'none; a file offers its components with library_publish'}.`);
    return hit;
  }

  /** What a file links, what it could link, and what it publishes itself. */
  async status(fileId: string, doc: BogenDoc) {
    const linked: LinkedLibrary[] = [];
    const copies = cachedMains(doc);
    for (const link of libraryLinks(doc)) {
      const found = await this.get(link.id);
      const mine = copies.filter((c) => c.meta.lib === link.id);
      linked.push({
        id: link.id, name: found?.summary.name ?? link.name, kind: found?.summary.kind ?? link.kind ?? 'file', missing: !found,
        ...(found ? { version: found.summary.version } : {}),
        components: mine.map((c) => ({ id: c.id, main: c.meta.main, name: c.meta.name, version: c.meta.version, ...(c.meta.removed ? { removed: true } : {}) })),
        updates: found ? libraryUpdates(doc, link.id, found.published) : [],
        renames: found ? libraryTokenRenames(doc, link.id, found.info) : [],
      });
    }
    const brandId = brandLinkOf(doc)?.id;
    const all = await this.list();
    const linkedIds = new Set(linked.map((l) => l.id));
    const own = libraryInfo(doc);
    return {
      ...(own ? { library: { ...own, unpublished: unpublishedChanges(doc) } } : {}),
      linked,
      available: all.filter((l) => l.id !== fileId && !linkedIds.has(l.id)).map((l) => ({ ...l, ...(l.id === brandId ? { brand: true } : {}) })),
    };
  }

  /** Links a library into a room's document. The caller decides the origin, for undo. */
  async link(room: Room, ref: string, write: <T>(fn: () => T) => T): Promise<{ library: LibrarySummary; ids: Record<string, string> }> {
    const library = await this.find(ref);
    if (library.id === room.id) throw new Error('A file cannot link its own library: its components are here already.');
    const found = await this.get(library.id);
    if (!found) throw new Error(`The library ${library.name} publishes nothing any more.`);
    const ids = write(() => linkLibrary(room.doc, { id: library.id, name: library.name, kind: library.kind, ...(found.info?.renames?.length ? { renamesAt: found.info.renames.at(-1)!.at } : {}) }, found.published));
    return { library, ids };
  }

  async accept(room: Room, libId: string, only: string[] | undefined, write: <T>(fn: () => T) => T) {
    const found = await this.get(libId);
    if (!found) throw new Error('That library is not on this device, or publishes nothing now. Its instances go on showing the copies this file has.');
    return write(() => acceptLibraryUpdates(room.doc, libId, found.published, only, undefined, found.info));
  }
}
