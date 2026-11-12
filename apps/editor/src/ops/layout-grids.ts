import { defaultLayoutGrid, gridLines, layoutGridTracks, type BogenNode, type LayoutGrid, type LayoutGridKind } from '@bogen/core';
import type { Rect } from '../canvas/geometry.ts';
import { rectOf } from '../canvas/measure.ts';
import { session } from '../doc/session.ts';
import { settings, useSettings } from '../state/settings.ts';
import { editor } from '../state/store.ts';
import { t } from '../i18n/store.ts';

/** Frames in the selection, or the frames the selected layers are in, that can carry a layout grid. */
function framesFor(ids: readonly string[]): string[] {
  const { snap } = session();
  const out = new Set<string>();
  for (const id of ids) {
    const n = snap.nodes.get(id);
    if (!n) continue;
    if (n.type === 'frame' && !n.virtual) out.add(id);
  }
  return [...out];
}

export function setLayoutGrids(id: string, grids: LayoutGrid[]): void {
  const s = session();
  s.tx(() => s.doc.updateFields(id, { layoutGrids: grids }));
}

/** Adds a grid of this kind, sized for each frame's width, to the selected frames. */
export function addLayoutGrid(kind: LayoutGridKind = 'columns', ids: readonly string[] = editor().selection): void {
  const s = session();
  const frames = framesFor(ids);
  if (!frames.length) {
    editor().showToast(t('Select a frame to give it a layout grid.'));
    return;
  }
  s.tx(() => {
    for (const id of frames) {
      const n = s.snap.nodes.get(id)!;
      const width = rectOf(id)?.w ?? (Number.parseFloat(n.style.width ?? '') || 1440);
      s.doc.updateFields(id, { layoutGrids: [...(n.layoutGrids ?? []), defaultLayoutGrid(kind, width)] });
    }
  });
  if (!settings().layoutGrids) useSettings.getState().update({ layoutGrids: true });
}

export function removeLayoutGrids(ids: readonly string[] = editor().selection): void {
  const s = session();
  const frames = framesFor(ids).filter((id) => s.snap.nodes.get(id)?.layoutGrids);
  if (!frames.length) return;
  s.tx(() => { for (const id of frames) s.doc.updateFields(id, { layoutGrids: undefined }); });
}

export function toggleLayoutGridsShown(): void {
  const next = !settings().layoutGrids;
  useSettings.getState().update({ layoutGrids: next });
  editor().showToast(next ? t('Layout grids shown') : t('Layout grids hidden'));
}

/** What a grid looks like in the world: rectangles for columns and rows, lines for a square grid. */
export interface WorldGrid { tracks: Rect[]; lines: { x: number[]; y: number[] }; grid: LayoutGrid }

export function worldGrids(n: BogenNode, frame: Rect): WorldGrid[] {
  return (n.layoutGrids ?? []).filter((g) => !g.hidden).map((grid) => ({
    grid,
    tracks: layoutGridTracks(grid, frame).map((t) => (t.axis === 'x' ? { x: frame.x + t.start, y: frame.y, w: t.size, h: frame.h } : { x: frame.x, y: frame.y + t.start, w: frame.w, h: t.size })),
    lines: gridLines(grid, frame),
  }));
}

/** Columns and rows of the frames a moved layer sits in, to snap to. Nothing while grids are hidden. */
export function gridSnapRects(parent: string | undefined): Rect[] {
  if (!parent || !settings().layoutGrids) return [];
  const { snap } = session();
  const out: Rect[] = [];
  for (const id of [parent, ...snap.ancestors(parent)]) {
    const n = snap.nodes.get(id);
    if (!n?.layoutGrids || n.hidden) continue;
    const r = rectOf(id);
    if (!r) continue;
    for (const g of worldGrids(n, r)) out.push(...g.tracks);
  }
  return out.slice(0, 600);
}
