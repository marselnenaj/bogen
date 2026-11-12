import { useEffect, useState } from 'react';
import { currentBranchId } from '@bogen/core';
import { session } from '../doc/session.ts';

export interface ScreenPreview {
  id: string; key: string; layers: number; state: 'pending' | 'ready' | 'unavailable';
  src?: string; smallSrc?: string; width?: number; height?: number; scope?: string;
}
const remembered = new Map<string, ReadonlyMap<string, ScreenPreview>>();

/** Preserve existing pixels while an edited screen is being recaptured, within the same design branch only. */
export function mergeScreenPreviews(previous: ReadonlyMap<string, ScreenPreview>, screens: ScreenPreview[], scope: string): ReadonlyMap<string, ScreenPreview> {
  return new Map(screens.map(screen => {
    const old = previous.get(screen.id);
    return [screen.id, screen.state !== 'ready' && old?.scope === scope && old.src
      ? { ...screen, scope, src: old.src, smallSrc: old.smallSrc, width: old.width, height: old.height }
      : { ...screen, scope }];
  }));
}

/** One page-level catalog. Retain cached metadata on navigation; never unload a picture because a refresh began. */
export function useScreenPreviews(pageId: string, enabled: boolean): ReadonlyMap<string, ScreenPreview> {
  const { fileId, y, doc } = session();
  const cacheKey = () => `${fileId}:${pageId}:${currentBranchId(doc)}`;
  const [screens, setScreens] = useState<ReadonlyMap<string, ScreenPreview>>(() => remembered.get(cacheKey()) ?? new Map());
  useEffect(() => {
    if (!enabled) { setScreens(new Map()); return; }
    let closed = false, timer = 0, controller: AbortController | null = null, key = cacheKey(), last = '';
    let previous = remembered.get(key) ?? new Map<string, ScreenPreview>();
    setScreens(previous);
    const load = async () => {
      controller?.abort(); const request = new AbortController(); controller = request;
      const requestKey = cacheKey();
      try {
        const data: { screens: ScreenPreview[]; paused: boolean; branch?: string } = { screens: [], paused: false };
        let offset: number | null = 0;
        while (offset !== null) {
          const res = await fetch(`/api/files/${fileId}/screen-previews?page=${encodeURIComponent(pageId)}&offset=${offset}`, { signal: request.signal });
          if (!res.ok) throw new Error('Preview catalog unavailable');
          const batch = await res.json() as { screens: ScreenPreview[]; paused: boolean; next: number | null; branch?: string };
          if (data.branch !== undefined && batch.branch !== undefined && data.branch !== batch.branch) throw new Error('Preview branch changed');
          data.screens.push(...batch.screens); data.paused ||= batch.paused; data.branch = batch.branch; offset = batch.next ?? null;
        }
        if (closed || request.signal.aborted || requestKey !== cacheKey()) return;
        const merged = mergeScreenPreviews(previous, data.screens, data.branch ?? currentBranchId(doc));
        const serial = JSON.stringify([...merged]);
        if (serial !== last) {
          last = serial; previous = merged; setScreens(merged);
          if (remembered.size >= 8 && !remembered.has(key)) remembered.delete(remembered.keys().next().value!);
          remembered.set(key, merged);
        }
        if (data.screens.some(s => s.state === 'pending')) schedule(data.paused ? 5000 : 750);
        else if (data.screens.some(s => s.state === 'unavailable')) schedule(60000);
      } catch (e) { if (!closed && !request.signal.aborted) schedule(5000); }
    };
    const schedule = (delay: number) => { clearTimeout(timer); timer = window.setTimeout(() => void load(), delay); };
    const changed = () => {
      const next = cacheKey();
      if (next !== key) { controller?.abort(); key = next; previous = remembered.get(key) ?? new Map(); last = ''; setScreens(previous); }
      schedule(500);
    };
    y.on('update', changed); schedule(0);
    return () => { closed = true; clearTimeout(timer); controller?.abort(); y.off('update', changed); };
  }, [fileId, pageId, enabled, y, doc]);
  return screens;
}
