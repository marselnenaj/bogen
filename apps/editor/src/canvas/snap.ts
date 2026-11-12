import type { Rect } from './geometry.ts';

/** Pure snapping for moves and resizes. Everything is in world coordinates. */

export interface Guide { axis: 'x' | 'y'; at: number; from: number; to: number }
export interface GapMark { axis: 'x' | 'y'; from: number; to: number; cross: number; size: number }
export interface SnapResult { dx: number; dy: number; guides: Guide[]; gaps: GapMark[] }

function linesX(r: Rect): number[] { return [r.x, r.x + r.w / 2, r.x + r.w]; }
function linesY(r: Rect): number[] { return [r.y, r.y + r.h / 2, r.y + r.h]; }

interface AxisBest { delta: number; abs: number }

function closest(moving: number[], targets: number[], threshold: number): AxisBest | null {
  let best: AxisBest | null = null;
  for (const m of moving) {
    for (const t of targets) {
      const d = t - m;
      const a = Math.abs(d);
      if (a <= threshold && (!best || a < best.abs)) best = { delta: d, abs: a };
    }
  }
  return best;
}

interface GapOption { delta: number; marks: GapMark[] }

/** Offers positions that repeat a gap already present between neighbours on the same row. */
function gapOptions(moving: Rect, others: Rect[], axis: 'x' | 'y'): GapOption[] {
  const start = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const size = (r: Rect) => (axis === 'x' ? r.w : r.h);
  const crossStart = (r: Rect) => (axis === 'x' ? r.y : r.x);
  const crossSize = (r: Rect) => (axis === 'x' ? r.h : r.w);
  const row = others
    .filter((r) => crossStart(r) < crossStart(moving) + crossSize(moving) && crossStart(r) + crossSize(r) > crossStart(moving))
    .sort((a, b) => start(a) - start(b));
  if (!row.length) return [];
  const crossAt = crossStart(moving) + crossSize(moving) / 2;
  const mark = (from: number, to: number): GapMark => ({ axis, from, to, cross: crossAt, size: to - from });
  const out: GapOption[] = [];
  const gaps: { a: Rect; b: Rect; gap: number }[] = [];
  for (let i = 0; i + 1 < row.length; i++) {
    const a = row[i]!;
    const b = row[i + 1]!;
    const gap = start(b) - (start(a) + size(a));
    if (gap > 0) gaps.push({ a, b, gap });
  }
  for (const { a, b, gap } of gaps) {
    // After b, repeating the gap.
    const afterB = start(b) + size(b) + gap;
    out.push({ delta: afterB - start(moving), marks: [mark(start(a) + size(a), start(b)), mark(start(b) + size(b), afterB)] });
    // Before a, repeating the gap.
    const beforeA = start(a) - gap - size(moving);
    out.push({ delta: beforeA - start(moving), marks: [mark(beforeA + size(moving), start(a)), mark(start(a) + size(a), start(b))] });
  }
  // Centred between two neighbours.
  for (let i = 0; i + 1 < row.length; i++) {
    const a = row[i]!;
    const b = row[i + 1]!;
    const free = start(b) - (start(a) + size(a)) - size(moving);
    if (free <= 0) continue;
    const at = start(a) + size(a) + free / 2;
    out.push({ delta: at - start(moving), marks: [mark(start(a) + size(a), at), mark(at + size(moving), start(b))] });
  }
  return out;
}

export interface SnapOptions {
  threshold: number;
  /** Round to whole pixels when nothing else snaps. */
  pixel?: boolean;
  /** Skip one axis, for shift-constrained drags. */
  lockX?: boolean;
  lockY?: boolean;
}

export function snapMove(moving: Rect, others: Rect[], options: SnapOptions): SnapResult {
  const { threshold } = options;
  const targetsX = others.flatMap(linesX);
  const targetsY = others.flatMap(linesY);
  const bestX = options.lockX ? null : closest(linesX(moving), targetsX, threshold);
  const bestY = options.lockY ? null : closest(linesY(moving), targetsY, threshold);
  let dx = bestX?.delta ?? 0;
  let dy = bestY?.delta ?? 0;
  let gapMarksX: GapMark[] = [];
  let gapMarksY: GapMark[] = [];
  let absX = bestX?.abs ?? Infinity;
  let absY = bestY?.abs ?? Infinity;
  if (!options.lockX) {
    for (const o of gapOptions(moving, others, 'x')) {
      const a = Math.abs(o.delta);
      if (a <= threshold && a < absX) { absX = a; dx = o.delta; gapMarksX = o.marks; }
    }
  }
  if (!options.lockY) {
    for (const o of gapOptions(moving, others, 'y')) {
      const a = Math.abs(o.delta);
      if (a <= threshold && a < absY) { absY = a; dy = o.delta; gapMarksY = o.marks; }
    }
  }
  if (options.pixel) {
    if (absX === Infinity && !options.lockX) dx = Math.round(moving.x) - moving.x;
    if (absY === Infinity && !options.lockY) dy = Math.round(moving.y) - moving.y;
  }
  const moved: Rect = { ...moving, x: moving.x + dx, y: moving.y + dy };
  return { dx, dy, guides: guidesFor(moved, others, absX !== Infinity && !gapMarksX.length, absY !== Infinity && !gapMarksY.length), gaps: [...gapMarksX, ...gapMarksY] };
}

/** Lines that coincide between a box and the others, spanning everything they touch. */
export function guidesFor(box: Rect, others: Rect[], showX = true, showY = true): Guide[] {
  const out: Guide[] = [];
  const EPS = 0.01;
  if (showX) {
    for (const line of linesX(box)) {
      let from = box.y;
      let to = box.y + box.h;
      let hit = false;
      for (const o of others) {
        if (linesX(o).some((l) => Math.abs(l - line) < EPS)) {
          hit = true;
          from = Math.min(from, o.y);
          to = Math.max(to, o.y + o.h);
        }
      }
      if (hit) out.push({ axis: 'x', at: line, from, to });
    }
  }
  if (showY) {
    for (const line of linesY(box)) {
      let from = box.x;
      let to = box.x + box.w;
      let hit = false;
      for (const o of others) {
        if (linesY(o).some((l) => Math.abs(l - line) < EPS)) {
          hit = true;
          from = Math.min(from, o.x);
          to = Math.max(to, o.x + o.w);
        }
      }
      if (hit) out.push({ axis: 'y', at: line, from, to });
    }
  }
  return out;
}

/**
 * Snaps the handle being dragged on a rotated layer, whose edges do not line up with anything.
 * A corner moves freely and snaps on both axes. An edge only moves along `along`, its direction in the
 * world, so that it stops where the line through it reaches a target.
 */
export function snapHandlePoint(p: { x: number; y: number }, along: { x: number; y: number } | null, others: Rect[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = others.flatMap((o) => linesX(o).map((at) => ({ at, o })));
  const ys = others.flatMap((o) => linesY(o).map((at) => ({ at, o })));
  const nearest = (value: number, list: { at: number; o: Rect }[]) => {
    let best: { at: number; o: Rect } | null = null;
    let abs = threshold;
    for (const t of list) {
      const a = Math.abs(t.at - value);
      if (a <= abs) { abs = a; best = t; }
    }
    return best ? { ...best, abs } : null;
  };
  const bx = nearest(p.x, xs);
  const by = nearest(p.y, ys);
  const guideX = (t: { at: number; o: Rect }, y: number): Guide => ({ axis: 'x', at: t.at, from: Math.min(y, t.o.y), to: Math.max(y, t.o.y + t.o.h) });
  const guideY = (t: { at: number; o: Rect }, x: number): Guide => ({ axis: 'y', at: t.at, from: Math.min(x, t.o.x), to: Math.max(x, t.o.x + t.o.w) });
  if (!along) {
    const dx = bx ? bx.at - p.x : 0;
    const dy = by ? by.at - p.y : 0;
    return { dx, dy, guides: [...(bx ? [guideX(bx, p.y + dy)] : []), ...(by ? [guideY(by, p.x + dx)] : [])] };
  }
  const viaX = bx && Math.abs(along.x) > 0.05 ? (bx.at - p.x) / along.x : null;
  const viaY = by && Math.abs(along.y) > 0.05 ? (by.at - p.y) / along.y : null;
  const useX = viaX !== null && (viaY === null || Math.abs(viaX) <= Math.abs(viaY));
  const s = useX ? viaX : viaY;
  if (s === null) return { dx: 0, dy: 0, guides: [] };
  const dx = s * along.x;
  const dy = s * along.y;
  return { dx, dy, guides: [useX ? guideX(bx!, p.y + dy) : guideY(by!, p.x + dx)] };
}

/** Snaps dragged edges of a resize. `edges` says which sides move. Returns the adjusted box. */
export function snapResize(box: Rect, edges: { l?: boolean; r?: boolean; t?: boolean; b?: boolean }, others: Rect[], threshold: number, pixel = true): { box: Rect; guides: Guide[] } {
  const targetsX = others.flatMap(linesX);
  const targetsY = others.flatMap(linesY);
  let { x, y, w, h } = box;
  const snapValue = (value: number, targets: number[]): number => {
    let best = value;
    let abs = threshold;
    let found = false;
    for (const t of targets) {
      const a = Math.abs(t - value);
      if (a <= abs) { abs = a; best = t; found = true; }
    }
    return found ? best : pixel ? Math.round(value) : value;
  };
  if (edges.l) { const nx = snapValue(x, targetsX); w += x - nx; x = nx; }
  if (edges.r) { const nr = snapValue(x + w, targetsX); w = nr - x; }
  if (edges.t) { const ny = snapValue(y, targetsY); h += y - ny; y = ny; }
  if (edges.b) { const nb = snapValue(y + h, targetsY); h = nb - y; }
  const next = { x, y, w: Math.max(1, w), h: Math.max(1, h) };
  return { box: next, guides: guidesFor(next, others) };
}
