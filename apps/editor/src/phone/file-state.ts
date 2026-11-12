import { create } from 'zustand';
import type { Camera, Rect } from '../canvas/geometry.ts';
import { MAX_ZOOM, MIN_ZOOM } from '../canvas/geometry.ts';
import { msg } from '../i18n/core.ts';

/**
 * A file on the phone: which sheet is open over the canvas, and the boards of the page with a way to step
 * through them. Everything here but the store is pure, so that it can be tested without a browser.
 */

export type SheetKind = 'pages' | 'layers' | 'edit' | 'comment' | 'ask' | 'photo';
export type EditTab = 'text' | 'fill' | 'layout' | 'type';
/** The tools of the bar at the bottom. Pages opens from the top bar. Labels are English, shown through `t(label)`. */
export const TOOLS: { id: Exclude<SheetKind, 'pages'>; label: string }[] = [
  { id: 'layers', label: msg('Layers') },
  { id: 'edit', label: msg('Edit') },
  { id: 'photo', label: msg('Photo') },
  { id: 'comment', label: msg('Comment') },
  { id: 'ask', label: msg('Ask') },
];

interface PhoneFileState {
  sheet: SheetKind | null;
  editTab: EditTab;
  /** The board in view, worked out from the camera. */
  boardId: string | null;
  /** The boards of the page, in reading order, as laid out. */
  boards: BoardBox[];
  set: (patch: Partial<Omit<PhoneFileState, 'set'>>) => void;
}

export const usePhoneFile = create<PhoneFileState>((set) => ({
  sheet: null,
  editTab: 'text',
  boardId: null,
  boards: [],
  set: (patch) => set(patch),
}));

export function phoneFile(): PhoneFileState {
  return usePhoneFile.getState();
}

/** A tool tapped in the bar: it opens its sheet, or closes it when it is the one open. */
export function toggleSheet(current: SheetKind | null, tapped: SheetKind): SheetKind | null {
  return current === tapped ? null : tapped;
}

/**
 * What a sheet does when the finger lets go of its handle after dragging it `dy` px down at `velocity`
 * px/ms: it closes when pulled a good part of the way, or flicked down.
 */
export function sheetRelease(dy: number, velocity: number, height: number): 'close' | 'stay' {
  if (dy <= 0) return 'stay';
  if (dy > Math.min(140, height * 0.3)) return 'close';
  return velocity > 0.5 && dy > 24 ? 'close' : 'stay';
}

// Boards

export interface BoardBox extends Rect { id: string; name: string }

/**
 * Boards in reading order: rows from the top, each from the left. A board starts a new row when it begins
 * below the middle of the first board of the row it would join.
 */
export function orderBoards<T extends BoardBox>(boards: T[]): T[] {
  const byTop = [...boards].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: T[][] = [];
  for (const b of byTop) {
    const row = rows.at(-1);
    const head = row?.[0];
    if (row && head && b.y < head.y + head.h / 2) row.push(b);
    else rows.push([b]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The board in view: the one that covers most of the view, or failing that the nearest to its middle. */
export function boardAt(boards: BoardBox[], view: Rect): string | null {
  let best: BoardBox | null = null;
  let bestArea = 0;
  for (const b of boards) {
    const area = overlap(b, view);
    if (area > bestArea) {
      best = b;
      bestArea = area;
    }
  }
  if (best) return best.id;
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  let nearest: BoardBox | null = null;
  let distance = Infinity;
  for (const b of boards) {
    const d = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
    if (d < distance) {
      nearest = b;
      distance = d;
    }
  }
  return nearest?.id ?? null;
}

/** The board before or after this one, or null at either end. Without a current board, the first. */
export function stepBoard(boards: { id: string }[], current: string | null, dir: 1 | -1): string | null {
  if (!boards.length) return null;
  const i = boards.findIndex((b) => b.id === current);
  if (i < 0) return boards[0]!.id;
  return boards[i + dir]?.id ?? null;
}

/**
 * A board on a phone screen: as wide as the screen allows, and from its top when it is taller than the
 * screen, which is how a page of a site or an app screen is read. Never above 2x.
 */
export function fitBoardCamera(rect: Rect, width: number, height: number, padding = 16): Camera {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(2, (width - padding * 2) / Math.max(1, rect.w))));
  const x = width / 2 - (rect.x + rect.w / 2) * z;
  const fits = rect.h * z <= height - padding * 2;
  const y = fits ? height / 2 - (rect.y + rect.h / 2) * z : padding - rect.y * z;
  return { x, y, z };
}

/** Adapt to the actual canvas bounds, including fold/unfold, Split View, sheets and keyboards.
 * A width-fit remains a width-fit; a person's zoom keeps its scale and world center. No device-name heuristics.
 */
export function resizePhoneCamera(current: Camera, before: { width: number; height: number }, after: { width: number; height: number }, board?: Rect | null, selection?: Rect | null): Camera {
  if (![before.width, before.height, after.width, after.height, current.z].every(n => Number.isFinite(n) && n > 0)) return current;
  let next: Camera = { x: current.x + (after.width - before.width) / 2, y: current.y + (after.height - before.height) / 2, z: current.z };
  if (board && board.w > 0 && board.h > 0) {
    const oldFit = fitBoardCamera(board, before.width, before.height, 16);
    const fitted = Math.abs(current.z - oldFit.z) <= Math.max(0.0001, oldFit.z * 0.005) && Math.abs(current.x - oldFit.x) < 3;
    if (fitted) {
      const fit = fitBoardCamera(board, after.width, after.height, 16);
      const wasAtFitTop = Math.abs(current.y - oldFit.y) < 3;
      // A scrolled, width-fitted tall board keeps its reading position instead of jumping to its top.
      const readingY = (16 - current.y) / current.z;
      next = { ...fit, y: wasAtFitTop ? fit.y : 16 - readingY * fit.z };
    }
  }
  if (selection) {
    const x = selection.x + selection.w / 2, y = selection.y + selection.h / 2;
    const px = x * next.z + next.x, py = y * next.z + next.y;
    if (px < 16 || px > after.width - 16 || py < 16 || py > after.height - 16) next = { ...next, x: after.width / 2 - x * next.z, y: after.height / 2 - y * next.z };
  }
  return next;
}

/** A quick sideways flick of one finger: the next board (1), the one before (-1), or nothing. */
export function classifySwipe(s: { dx: number; dy: number; ms: number }): 1 | -1 | null {
  if (s.ms > 400 || Math.abs(s.dx) < 60 || Math.abs(s.dx) < Math.abs(s.dy) * 2) return null;
  return s.dx < 0 ? 1 : -1;
}

/** The − and + buttons: a step of 1.5x, kept inside the zoom limits. */
export function zoomStep(z: number, dir: 1 | -1): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, dir > 0 ? z * 1.5 : z / 1.5));
}

/**
 * How much of the screen the keyboard takes, from `visualViewport`: zero while it is down. iOS keeps the
 * layout viewport and shrinks the visual one, and may scroll it too, so only the heights tell.
 */
export function keyboardInset(innerHeight: number, vv: { height: number; scale?: number }): number {
  if (vv.scale !== undefined && Math.abs(vv.scale - 1) > 0.01) return 0;
  const covered = innerHeight - vv.height;
  return covered > 120 ? Math.round(covered) : 0;
}

// Layers

export interface LayerLike { id: string; name: string; type: string; artboard?: boolean; hidden?: boolean }
export interface LayerRow { id: string; depth: number; name: string; type: string; board: boolean; open: boolean; hasKids: boolean }

/**
 * The rows of a board's layer list: the board, its layers, and inside them only the branch that leads to
 * the selection, opened one level past it. Long lists stop at `limit`.
 */
export function layerRows(boardId: string, get: (id: string) => LayerLike | undefined, kids: (id: string) => readonly string[], open: ReadonlySet<string>, limit = 400): LayerRow[] {
  const out: LayerRow[] = [];
  const walk = (id: string, depth: number) => {
    if (out.length >= limit) return;
    const n = get(id);
    if (!n) return;
    const children = kids(id);
    const isOpen = depth === 0 || open.has(id);
    out.push({ id, depth, name: n.name, type: n.type, board: Boolean(n.artboard) && depth === 0, open: isOpen && children.length > 0, hasKids: children.length > 0 });
    if (isOpen) for (const c of children) walk(c, depth + 1);
  };
  walk(boardId, 0);
  return out;
}

/** The layers that are open in the list for a selection: its ancestors below the board, and itself. */
export function openFor(selected: string | null, parentOf: (id: string) => string | undefined, boardId: string): Set<string> {
  const open = new Set<string>();
  for (let id: string | undefined = selected ?? undefined; id && id !== boardId; id = parentOf(id)) open.add(id);
  return open;
}

/** The glyph in front of a layer row. */
export function layerGlyph(row: Pick<LayerRow, 'type' | 'board'>): string {
  if (row.board) return '#';
  switch (row.type) {
    case 'text': return 'T';
    case 'image': case 'video': return '▣';
    case 'svg': return '◇';
    case 'shader': return '◍';
    case 'embed': return '⧉';
    default: return '▢';
  }
}
