import type { BogenDoc, ChangeOp, EditLocation, RecentEdit } from '@bogen/core';
import type { ChangeEntry } from './timeline.ts';
import type { Storage } from './storage.ts';

export const RECENT_LIMIT = 40;
const LOCATION_LIMIT = 16;

/** Locate touched layers without walking/rendering the document. Before-values keep deleted locations useful. */
export function editLocations(doc: BogenDoc, ops: ChangeOp[]): Pick<RecentEdit, 'locations' | 'locationCount'> {
  const before = new Map<string, Record<string, unknown>>();
  const oldPages = new Map<string, string>();
  for (const op of ops) if (op.p.length === 2) {
    const value = (op.b as { $map?: Record<string, unknown> } | undefined)?.$map;
    if (value && op.p[0] === 'nodes') before.set(op.p[1]!, value);
    if (op.p[0] === 'pages' && typeof value?.name === 'string') oldPages.set(op.p[1]!, value.name);
  }
  const locations = new Map<string, EditLocation>();
  const field = (id: string, key: string): unknown => doc.nodes.get(id)?.get(key) ?? before.get(id)?.[key];
  const addPage = (pageId: string, screenId?: string) => {
    const page = doc.pages.get(pageId);
    const name = page?.get('name') ?? oldPages.get(pageId);
    if (typeof name !== 'string') return;
    const screenName = screenId ? field(screenId, 'name') : undefined;
    locations.set(`${pageId}/${screenId ?? ''}`, { pageId, pageName: name.slice(0, 160), ...(screenId ? { screenId, screenName: typeof screenName === 'string' ? screenName.slice(0, 160) : screenId } : {}) });
  };
  const ids = new Set(ops.filter(op => op.p[0] === 'nodes').map(op => op.p[1]!));
  for (const id of ids) {
    let at = id, screen: string | undefined;
    const seen = new Set<string>();
    while (!seen.has(at) && seen.size < 256) {
      seen.add(at);
      if (doc.pages.has(at)) { addPage(at, screen); break; }
      if (field(at, 'artboard') === true) screen = at;
      const parent = field(at, 'parent');
      if (typeof parent !== 'string') break;
      at = parent;
    }
  }
  for (const op of ops) if (op.p[0] === 'pages') addPage(op.p[1]!);
  // A large first page must not crowd every other affected page out of the compact index.
  const all = [...locations.values()], seenPages = new Set<string>();
  const first = all.filter(location => {
    if (seenPages.has(location.pageId)) return false;
    seenPages.add(location.pageId); return true;
  });
  const preferred = new Set(first);
  return { locations: [...first, ...all.filter(location => !preferred.has(location))].slice(0, LOCATION_LIMIT), locationCount: locations.size };
}

/** Bounded, defensive index data: entries may also have arrived from an older or paired device. */
export function toRecentEdit(entry: ChangeEntry, doc?: BogenDoc): RecentEdit | null {
  if (!entry.id || !Number.isFinite(entry.at) || entry.at < 0 || typeof entry.actor !== 'string' || typeof entry.summary !== 'string') return null;
  let located = entry.locations && Array.isArray(entry.locations) ? { locations: entry.locations, locationCount: entry.locationCount ?? entry.locations.length } : undefined;
  if (doc && !located?.locations.length) {
    const ops = entry.ops ?? entry.layers?.slice(0, 200).map(id => ({ p: ['nodes', id] })) ?? [];
    located = editLocations(doc, ops);
  }
  const locations = (located?.locations ?? []).slice(0, LOCATION_LIMIT).flatMap(l => {
    if (!l || typeof l.pageId !== 'string' || typeof l.pageName !== 'string') return [];
    return [{ pageId: l.pageId.slice(0, 80), pageName: l.pageName.slice(0, 160), ...(typeof l.screenId === 'string' && typeof l.screenName === 'string' ? { screenId: l.screenId.slice(0, 80), screenName: l.screenName.slice(0, 160) } : {}) }];
  });
  return { id: entry.id.slice(0, 180), at: entry.at, actor: entry.actor.slice(0, 120), summary: entry.summary.slice(0, 400), locations, locationCount: Math.max(locations.length, Math.min(100_000, Number(located?.locationCount) || 0)) };
}

export function rememberEdit(storage: Storage, fileId: string, entry: ChangeEntry, doc?: BogenDoc): boolean {
  const edit = toRecentEdit(entry, doc), file = storage.get(fileId);
  if (!edit || !file) return false;
  const before = file.recentEdits ?? [];
  const next = [edit, ...before.filter(e => e.id !== edit.id)].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)).slice(0, RECENT_LIMIT);
  if (JSON.stringify(before) === JSON.stringify(next)) return false;
  storage.update(fileId, { recentEdits: next });
  return true;
}
