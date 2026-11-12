import { useCallback, useSyncExternalStore } from 'react';
import type { EditLocation, RecentEdit } from '@bogen/core';
import { onServerEvent } from './events.ts';
import { session } from '../doc/session.ts';
import { editor, useEditor } from '../state/store.ts';
import { jumpToLayers } from '../ops/jump.ts';
import { formatDate } from '../i18n/format.ts';

const EMPTY: readonly RecentEdit[] = [];
type Entry = { items: readonly RecentEdit[]; listeners: Set<() => void>; stop?: () => void };
const cache = new Map<string, Entry>();
function entryFor(id: string): Entry {
  let entry = cache.get(id);
  if (!entry) {
    for (const [key, value] of cache) if (cache.size >= 8 && !value.listeners.size) cache.delete(key);
    entry = { items: EMPTY, listeners: new Set() }; cache.set(id, entry);
  }
  return entry;
}
function subscribe(id: string, notify: () => void): () => void {
  const entry = entryFor(id); entry.listeners.add(notify);
  if (!entry.stop) {
    let timer = 0, generation = 0, active = true;
    const controllers = new Set<AbortController>();
    const load = async () => {
      const version = ++generation, controller = new AbortController(); controllers.add(controller);
      try {
        const response = await fetch(`/api/files/${encodeURIComponent(id)}/recent-edits`, { signal: controller.signal });
        if (!response.ok) return;
        const items: unknown = await response.json();
        if (active && generation === version && Array.isArray(items)) {
          entry.items = items.slice(0, 40) as RecentEdit[];
          for (const changed of entry.listeners) changed();
        }
      } catch { /* Keep the last metadata while offline or talking to an older server. */ }
      finally { controllers.delete(controller); }
    };
    const off = onServerEvent(event => {
      if ((event.t !== 'history' || event.fileId !== id) && event.t !== 'files') return;
      if (!timer) timer = window.setTimeout(() => { timer = 0; void load(); }, 250);
    });
    entry.stop = () => { active = false; generation++; off(); clearTimeout(timer); for (const c of controllers) c.abort(); };
    void load();
  }
  return () => { entry.listeners.delete(notify); if (!entry.listeners.size) { entry.stop?.(); delete entry.stop; } };
}
/** Every in-file surface shares one bounded request/subscription, not a timeline scan per row. */
export function useRecentEdits(): readonly RecentEdit[] {
  const id = useEditor(s => s.fileId);
  const listen = useCallback((notify: () => void) => id ? subscribe(id, notify) : () => {}, [id]);
  const read = useCallback(() => id ? entryFor(id).items : EMPTY, [id]);
  return useSyncExternalStore(listen, read, () => EMPTY);
}
export function recentByPage(items: readonly RecentEdit[]): Map<string, RecentEdit> {
  const result = new Map<string, RecentEdit>();
  for (const edit of items) for (const location of edit.locations) if (!result.has(location.pageId)) result.set(location.pageId, edit);
  return result;
}
export function editDate(at: number): string {
  return formatDate(at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function locationName(location: EditLocation): string {
  return [location.pageName, location.screenName].filter(Boolean).join(' · ');
}
export function editLink(fileId: string, location: EditLocation): string {
  return `#/file/${fileId}?page=${encodeURIComponent(location.pageId)}${location.screenId ? `&select=${encodeURIComponent(location.screenId)}` : ''}`;
}
export function visitEdit(location: EditLocation): boolean {
  const s = session();
  if (!s.snap.pages.some(p => p.id === location.pageId)) return false;
  if (location.screenId && s.snap.nodes.has(location.screenId) && s.doc.pageOf(location.screenId) === location.pageId) return jumpToLayers([location.screenId], location.pageId);
  editor().set({ pageId: location.pageId, selection: [], hoverId: null });
  return true;
}
