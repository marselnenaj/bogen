/**
 * Layout grids: columns, rows or a square grid drawn over a frame on the canvas, as a guide to place
 * things on and to snap to. They belong to the design file, not to the page it describes, so no export
 * writes them. Stored on the layer as `layoutGrids`, a plain list that arrives from other devices too, so
 * it is cleaned on every read.
 */

export type LayoutGridKind = 'columns' | 'rows' | 'grid';
export type LayoutGridAlign = 'stretch' | 'start' | 'center' | 'end';

export interface LayoutGrid {
  kind: LayoutGridKind;
  /** Columns and rows: how many. */
  count?: number;
  /** Columns and rows: px between two tracks. */
  gutter?: number;
  /** Columns and rows: px kept free at both edges when stretched, or the offset from the edge they align to. */
  margin?: number;
  /** Columns and rows: stretch fills the frame, the others keep `size` and sit at that edge or the centre. */
  align?: LayoutGridAlign;
  /** A grid's cell, or a track's width when not stretched, in px. */
  size?: number;
  /** A CSS colour for this grid on the canvas. Without it the canvas picks one. */
  color?: string;
  hidden?: boolean;
}

export const LAYOUT_GRID_KINDS: readonly LayoutGridKind[] = ['columns', 'rows', 'grid'];
export const LAYOUT_GRID_ALIGNS: readonly LayoutGridAlign[] = ['stretch', 'start', 'center', 'end'];
export const MAX_LAYOUT_GRIDS = 8;
const MAX_TRACKS = 200;
const MAX_LINES = 400;

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab)\([\d.,%\s/+-]+\)|[a-z]{3,20})$/i;

const num = (v: unknown, min: number, max: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v * 100) / 100)) : undefined);

/** A grid as it may be stored, or undefined when it is not one. */
export function cleanLayoutGrid(raw: unknown): LayoutGrid | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const kind = LAYOUT_GRID_KINDS.find((k) => k === r.kind);
  if (!kind) return undefined;
  const out: LayoutGrid = { kind };
  if (kind === 'grid') {
    out.size = num(r.size, 1, 2000) ?? 8;
  } else {
    out.count = Math.round(num(r.count, 1, MAX_TRACKS) ?? 12);
    out.gutter = num(r.gutter, 0, 2000) ?? 0;
    out.margin = num(r.margin, -2000, 2000) ?? 0;
    out.align = LAYOUT_GRID_ALIGNS.find((a) => a === r.align) ?? 'stretch';
    const size = num(r.size, 1, 4000);
    if (out.align !== 'stretch') out.size = size ?? 80;
  }
  if (typeof r.color === 'string' && COLOR.test(r.color.trim())) out.color = r.color.trim();
  if (r.hidden === true) out.hidden = true;
  return out;
}

/** A stored list, cleaned. Undefined when there is nothing left. */
export function cleanLayoutGrids(raw: unknown): LayoutGrid[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.slice(0, MAX_LAYOUT_GRIDS).flatMap((g) => cleanLayoutGrid(g) ?? []);
  return out.length ? out : undefined;
}

/** A grid that suits a frame of this width: 12 columns on a desktop, 8 on a tablet, 4 on a phone. */
export function defaultLayoutGrid(kind: LayoutGridKind, width: number): LayoutGrid {
  if (kind === 'grid') return { kind, size: 8 };
  if (kind === 'rows') return { kind, count: 8, gutter: 16, margin: 0, align: 'stretch' };
  if (width >= 1024) return { kind, count: 12, gutter: 24, margin: 80, align: 'stretch' };
  if (width >= 600) return { kind, count: 8, gutter: 16, margin: 32, align: 'stretch' };
  return { kind, count: 4, gutter: 16, margin: 16, align: 'stretch' };
}

/** A track of a columns or rows grid, from the frame's top left: x and width for columns, y and height for rows. */
export interface GridTrack { axis: 'x' | 'y'; start: number; size: number }

/** Where the columns or rows of a grid fall in a frame of this size. A square grid has no tracks; see gridLines. */
export function layoutGridTracks(grid: LayoutGrid, box: { w: number; h: number }): GridTrack[] {
  if (grid.kind === 'grid') return [];
  const axis = grid.kind === 'columns' ? 'x' : 'y';
  const length = axis === 'x' ? box.w : box.h;
  const count = Math.max(1, Math.min(MAX_TRACKS, Math.round(grid.count ?? 12)));
  const gutter = Math.max(0, grid.gutter ?? 0);
  const margin = grid.margin ?? 0;
  const align = grid.align ?? 'stretch';
  let size: number;
  let first: number;
  if (align === 'stretch') {
    size = (length - 2 * margin - (count - 1) * gutter) / count;
    first = margin;
  } else {
    size = Math.max(1, grid.size ?? 80);
    const total = count * size + (count - 1) * gutter;
    first = align === 'start' ? margin : align === 'end' ? length - margin - total : (length - total) / 2;
  }
  if (!(size > 0)) return [];
  const out: GridTrack[] = [];
  for (let i = 0; i < count; i++) out.push({ axis, start: first + i * (size + gutter), size });
  return out;
}

/** The lines of a square grid in a frame, from its top left; nothing when they would be too dense to help. */
export function gridLines(grid: LayoutGrid, box: { w: number; h: number }): { x: number[]; y: number[] } {
  if (grid.kind !== 'grid') return { x: [], y: [] };
  const size = Math.max(1, grid.size ?? 8);
  if (box.w / size + box.h / size > MAX_LINES * 2) return { x: [], y: [] };
  const along = (length: number) => {
    const out: number[] = [];
    for (let at = size; at < length; at += size) out.push(at);
    return out;
  };
  return { x: along(box.w), y: along(box.h) };
}

/** A short description, such as "12 columns, gutter 24, margin 80". */
export function describeLayoutGrid(grid: LayoutGrid): string {
  if (grid.kind === 'grid') return `Grid ${grid.size ?? 8}`;
  const count = grid.count ?? 12;
  const word = grid.kind === 'columns' ? (count === 1 ? 'column' : 'columns') : count === 1 ? 'row' : 'rows';
  const align = grid.align ?? 'stretch';
  const parts = [`${count} ${word}`, `gutter ${grid.gutter ?? 0}`];
  if (align === 'stretch') parts.push(`margin ${grid.margin ?? 0}`);
  else parts.push(`${align}, size ${grid.size ?? 80}`);
  return parts.join(', ');
}
