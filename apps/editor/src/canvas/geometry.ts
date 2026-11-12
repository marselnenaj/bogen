/** Pure geometry for the canvas. No DOM in here, so all of it can be unit tested. */

export interface Vec { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
/** Linear part of a CSS transform: x' = a x + c y, y' = b x + d y. */
export interface Mat2 { a: number; b: number; c: number; d: number }
/** Layout position in the parent, unrotated size, and rotation about the centre in degrees. */
export interface LocalBox extends Rect { rot: number }

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const RAD = Math.PI / 180;

export const IDENTITY: Mat2 = { a: 1, b: 0, c: 0, d: 1 };

export function multiply(m: Mat2, n: Mat2): Mat2 {
  return { a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b, c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d };
}

export function invert(m: Mat2): Mat2 {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-9) return IDENTITY;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det };
}

export function apply(m: Mat2, v: Vec): Vec {
  return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y };
}

export function rotation(deg: number): Mat2 {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return { a: c, b: s, c: -s, d: c };
}

export function matRotation(m: Mat2): number {
  return normalizeDeg(Math.atan2(m.b, m.a) / RAD);
}

/** Angle into (-180, 180]. */
export function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return Object.is(d, -0) ? 0 : d;
}

function parseAngle(text: string): number {
  const v = parseFloat(text);
  if (Number.isNaN(v)) return 0;
  if (text.endsWith('grad')) return v * 0.9;
  if (text.endsWith('rad')) return v / RAD;
  if (text.endsWith('turn')) return v * 360;
  return v;
}

/** Reads the `rotate`, `scale` and `transform` declarations of a style into one linear matrix. */
export function linearOf(style: { rotate?: string; scale?: string; transform?: string }): Mat2 {
  let m = IDENTITY;
  if (style.rotate && style.rotate !== 'none') m = multiply(m, rotation(parseAngle(style.rotate.trim().split(/\s+/).at(-1)!)));
  if (style.scale && style.scale !== 'none') {
    const parts = style.scale.trim().split(/\s+/).map(parseFloat);
    const sx = parts[0] ?? 1;
    m = multiply(m, { a: sx, b: 0, c: 0, d: parts[1] ?? sx });
  }
  if (style.transform && style.transform !== 'none') {
    for (const match of style.transform.matchAll(/([a-zA-Z0-9]+)\(([^)]*)\)/g)) {
      const fn = match[1]!;
      const args = match[2]!.split(/[\s,]+/).filter(Boolean);
      if (fn === 'rotate' || fn === 'rotateZ') m = multiply(m, rotation(parseAngle(args[0] ?? '0')));
      else if (fn === 'scale') {
        const sx = parseFloat(args[0] ?? '1');
        m = multiply(m, { a: sx, b: 0, c: 0, d: parseFloat(args[1] ?? args[0] ?? '1') });
      } else if (fn === 'scaleX') m = multiply(m, { a: parseFloat(args[0] ?? '1'), b: 0, c: 0, d: 1 });
      else if (fn === 'scaleY') m = multiply(m, { a: 1, b: 0, c: 0, d: parseFloat(args[0] ?? '1') });
      else if (fn === 'matrix' && args.length === 6) {
        const [a, b, c, d] = args.map(parseFloat) as [number, number, number, number];
        m = multiply(m, { a, b, c, d });
      }
    }
  }
  return m;
}

export function hasLinear(style: { rotate?: string; scale?: string; transform?: string }): boolean {
  return Boolean((style.rotate && style.rotate !== 'none') || (style.scale && style.scale !== 'none') || (style.transform && style.transform !== 'none'));
}

export function rectFromPoints(a: Vec, b: Vec): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/** Whether a rotated box touches an upright rectangle, by separating axes. A marquee picks by this. */
export function boxIntersectsRect(box: LocalBox, r: Rect): boolean {
  const c = corners(box);
  const xs = c.map((p) => p.x);
  const ys = c.map((p) => p.y);
  if (Math.max(...xs) <= r.x || Math.min(...xs) >= r.x + r.w || Math.max(...ys) <= r.y || Math.min(...ys) >= r.y + r.h) return false;
  const rectCorners: Vec[] = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
  const m = rotation(box.rot);
  for (const axis of [{ x: m.a, y: m.b }, { x: m.c, y: m.d }]) {
    const a = c.map((p) => p.x * axis.x + p.y * axis.y);
    const b = rectCorners.map((p) => p.x * axis.x + p.y * axis.y);
    if (Math.max(...a) <= Math.min(...b) || Math.max(...b) <= Math.min(...a)) return false;
  }
  return true;
}

/** Where a box goes to stay clear of others: as far to the right as it takes, along its row. */
export function freeSpot(box: Rect, others: Rect[], gap: number): Vec {
  let x = box.x;
  for (let i = 0; i <= others.length; i++) {
    const at: Rect = { ...box, x };
    const hit = others.filter((o) => o.w > 0 && o.h > 0 && intersects(at, o));
    if (!hit.length) break;
    x = Math.max(...hit.map((o) => o.x + o.w)) + gap;
  }
  return { x, y: box.y };
}

export function pointInRect(p: Vec, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Corners of a rotated box in order nw, ne, se, sw. */
export function corners(box: LocalBox): Vec[] {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const r = rotation(box.rot);
  return [
    { x: -box.w / 2, y: -box.h / 2 },
    { x: box.w / 2, y: -box.h / 2 },
    { x: box.w / 2, y: box.h / 2 },
    { x: -box.w / 2, y: box.h / 2 },
  ].map((p) => {
    const q = apply(r, p);
    return { x: q.x + cx, y: q.y + cy };
  });
}

export function aabb(box: LocalBox): Rect {
  const c = corners(box);
  const xs = c.map((p) => p.x);
  const ys = c.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function handleSigns(h: HandleId): { sx: -1 | 0 | 1; sy: -1 | 0 | 1 } {
  return { sx: h.includes('w') ? -1 : h.includes('e') ? 1 : 0, sy: h.includes('n') ? -1 : h.includes('s') ? 1 : 0 };
}

export interface ResizeOptions { keepRatio?: boolean; fromCentre?: boolean; min?: number }

/**
 * New box after dragging a handle by `delta` (in the parent's coordinates). The opposite edge or
 * corner stays fixed in the parent even when the box is rotated; with `fromCentre` the centre does.
 */
export function resizeBox(start: LocalBox, handle: HandleId, delta: Vec, options: ResizeOptions = {}): LocalBox {
  const { sx, sy } = handleSigns(handle);
  const min = options.min ?? 1;
  const local = apply(rotation(-start.rot), delta);
  const grow = options.fromCentre ? 2 : 1;
  let w = start.w + sx * local.x * grow;
  let h = start.h + sy * local.y * grow;
  if (options.keepRatio && start.w > 0 && start.h > 0) {
    const fx = w / start.w;
    const fy = h / start.h;
    const f = sx === 0 ? fy : sy === 0 ? fx : Math.max(fx, fy);
    w = start.w * f;
    h = start.h * f;
  }
  w = Math.max(min, w);
  h = Math.max(min, h);
  const r = rotation(start.rot);
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;
  if (options.fromCentre) return { x: cx - w / 2, y: cy - h / 2, w, h, rot: start.rot };
  const anchorStart = apply(r, { x: (-sx * start.w) / 2, y: (-sy * start.h) / 2 });
  const anchorEnd = apply(r, { x: (-sx * w) / 2, y: (-sy * h) / 2 });
  const ncx = cx + anchorStart.x - anchorEnd.x;
  const ncy = cy + anchorStart.y - anchorEnd.y;
  return { x: ncx - w / 2, y: ncy - h / 2, w, h, rot: start.rot };
}

/** Maps a child box from one group rectangle to another, for resizing several layers at once. */
export function scaleInto(box: Rect, from: Rect, to: Rect): Rect {
  const fx = from.w ? to.w / from.w : 1;
  const fy = from.h ? to.h / from.h : 1;
  return { x: to.x + (box.x - from.x) * fx, y: to.y + (box.y - from.y) * fy, w: Math.max(0, box.w * fx), h: Math.max(0, box.h * fy) };
}

export function angleAt(centre: Vec, p: Vec): number {
  return Math.atan2(p.y - centre.y, p.x - centre.x) / RAD;
}

/** Rotation after dragging from `from` to `to` around `centre`, optionally stepped. */
export function rotateTo(startRot: number, centre: Vec, from: Vec, to: Vec, step = 0): number {
  const next = startRot + angleAt(centre, to) - angleAt(centre, from);
  return normalizeDeg(step ? Math.round(next / step) * step : next);
}

/** A cursor angle so that a resize cursor on a rotated box still points the right way. */
export function handleCursor(h: HandleId, rot: number): string {
  const base: Record<HandleId, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
  const a = ((base[h] + rot) % 180 + 180) % 180;
  if (a < 22.5 || a >= 157.5) return 'ew-resize';
  if (a < 67.5) return 'nwse-resize';
  if (a < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

export interface Camera { x: number; y: number; z: number }

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 256;

export function screenToWorld(c: Camera, p: Vec): Vec {
  return { x: (p.x - c.x) / c.z, y: (p.y - c.y) / c.z };
}

export function worldToScreen(c: Camera, p: Vec): Vec {
  return { x: p.x * c.z + c.x, y: p.y * c.z + c.y };
}

/** Camera after zooming to `z` while the world point under `anchor` (screen) stays put. */
export function zoomAt(c: Camera, z: number, anchor: Vec): Camera {
  const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  const w = screenToWorld(c, anchor);
  return { z: nz, x: anchor.x - w.x * nz, y: anchor.y - w.y * nz };
}

/** Camera that shows `rect` in a viewport of the given size. */
export function fitRect(rect: Rect, width: number, height: number, padding = 64, maxZoom = 1): Camera {
  const availW = Math.max(1, width - padding * 2);
  const availH = Math.max(1, height - padding * 2);
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(maxZoom, availW / Math.max(rect.w, 1), availH / Math.max(rect.h, 1))));
  return { z, x: width / 2 - (rect.x + rect.w / 2) * z, y: height / 2 - (rect.y + rect.h / 2) * z };
}

const ZOOM_STOPS = [0.02, 0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64, 128, 256];

export function nextZoomStop(z: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STOPS.find((s) => s > z * 1.001) ?? MAX_ZOOM;
  return [...ZOOM_STOPS].reverse().find((s) => s < z * 0.999) ?? MIN_ZOOM;
}

/** Index a dragged item takes among `items` along an axis, by comparing to item midpoints. */
export function insertionIndex(items: Rect[], p: Vec, axis: 'x' | 'y'): number {
  for (let i = 0; i < items.length; i++) {
    const r = items[i]!;
    const mid = axis === 'x' ? r.x + r.w / 2 : r.y + r.h / 2;
    if ((axis === 'x' ? p.x : p.y) < mid) return i;
  }
  return items.length;
}

/** Insertion index in a wrapping flow or a grid: first find the row, then the slot in it. */
export function insertionIndexWrapped(items: Rect[], p: Vec, axis: 'x' | 'y'): number {
  if (!items.length) return 0;
  const cross = (r: Rect) => (axis === 'x' ? { a: r.y, b: r.y + r.h } : { a: r.x, b: r.x + r.w });
  const pc = axis === 'x' ? p.y : p.x;
  let lineStart = 0;
  while (lineStart < items.length) {
    let lineEnd = lineStart;
    const first = cross(items[lineStart]!);
    let lineB = first.b;
    while (lineEnd + 1 < items.length) {
      const next = cross(items[lineEnd + 1]!);
      if (next.a >= lineB - 0.5) break;
      lineEnd++;
      lineB = Math.max(lineB, next.b);
    }
    if (pc < lineB || lineEnd === items.length - 1) {
      return lineStart + insertionIndex(items.slice(lineStart, lineEnd + 1), p, axis);
    }
    lineStart = lineEnd + 1;
  }
  return items.length;
}

/** Distances between two boxes for the alt measure overlay. */
export interface Measurement { axis: 'x' | 'y'; from: Vec; to: Vec; distance: number }

export function measureBetween(a: Rect, b: Rect): Measurement[] {
  const out: Measurement[] = [];
  const midY = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2;
  const midX = (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2;
  const overlapY = a.y < b.y + b.h && a.y + a.h > b.y;
  const overlapX = a.x < b.x + b.w && a.x + a.w > b.x;
  const yLine = overlapY ? midY : a.y + a.h / 2;
  const xLine = overlapX ? midX : a.x + a.w / 2;
  const pushX = (x0: number, x1: number) => { if (Math.abs(x1 - x0) > 0.01) out.push({ axis: 'x', from: { x: x0, y: yLine }, to: { x: x1, y: yLine }, distance: Math.abs(x1 - x0) }); };
  const pushY = (y0: number, y1: number) => { if (Math.abs(y1 - y0) > 0.01) out.push({ axis: 'y', from: { x: xLine, y: y0 }, to: { x: xLine, y: y1 }, distance: Math.abs(y1 - y0) }); };

  const insideX = a.x >= b.x && a.x + a.w <= b.x + b.w;
  const insideY = a.y >= b.y && a.y + a.h <= b.y + b.h;
  if (insideX && insideY) {
    pushX(b.x, a.x);
    pushX(a.x + a.w, b.x + b.w);
    pushY(b.y, a.y);
    pushY(a.y + a.h, b.y + b.h);
    return out;
  }
  if (a.x + a.w <= b.x) pushX(a.x + a.w, b.x);
  else if (b.x + b.w <= a.x) pushX(b.x + b.w, a.x);
  else {
    if (Math.abs(a.x - b.x) > 0.01) pushX(Math.min(a.x, b.x), Math.max(a.x, b.x));
    if (Math.abs(a.x + a.w - b.x - b.w) > 0.01) pushX(Math.min(a.x + a.w, b.x + b.w), Math.max(a.x + a.w, b.x + b.w));
  }
  if (a.y + a.h <= b.y) pushY(a.y + a.h, b.y);
  else if (b.y + b.h <= a.y) pushY(b.y + b.h, a.y);
  else {
    if (Math.abs(a.y - b.y) > 0.01) pushY(Math.min(a.y, b.y), Math.max(a.y, b.y));
    if (Math.abs(a.y + a.h - b.y - b.h) > 0.01) pushY(Math.min(a.y + a.h, b.y + b.h), Math.max(a.y + a.h, b.y + b.h));
  }
  return out;
}

/** Positions after aligning boxes to the group's edge or centre. Returns deltas in input order. */
export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export function alignDeltas(boxes: Rect[], kind: AlignKind, to?: Rect): Vec[] {
  const group = to ?? unionRects(boxes);
  if (!group) return [];
  return boxes.map((b) => {
    switch (kind) {
      case 'left': return { x: group.x - b.x, y: 0 };
      case 'hcenter': return { x: group.x + group.w / 2 - (b.x + b.w / 2), y: 0 };
      case 'right': return { x: group.x + group.w - (b.x + b.w), y: 0 };
      case 'top': return { x: 0, y: group.y - b.y };
      case 'vcenter': return { x: 0, y: group.y + group.h / 2 - (b.y + b.h / 2) };
      case 'bottom': return { x: 0, y: group.y + group.h - (b.y + b.h) };
    }
  });
}

/** Deltas that even out the gaps along an axis. Outer boxes stay where they are. */
export function distributeDeltas(boxes: Rect[], axis: 'x' | 'y'): Vec[] {
  const out: Vec[] = boxes.map(() => ({ x: 0, y: 0 }));
  if (boxes.length < 3) return out;
  const start = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const size = (r: Rect) => (axis === 'x' ? r.w : r.h);
  const order = boxes.map((b, i) => ({ b, i })).sort((p, q) => start(p.b) - start(q.b));
  const first = order[0]!.b;
  const last = order.at(-1)!.b;
  const total = order.reduce((sum, o) => sum + size(o.b), 0);
  const gap = (start(last) + size(last) - start(first) - total) / (order.length - 1);
  let cursor = start(first);
  for (const o of order) {
    const d = cursor - start(o.b);
    out[o.i] = axis === 'x' ? { x: d, y: 0 } : { x: 0, y: d };
    cursor += size(o.b) + gap;
  }
  return out;
}

/**
 * The gaps between boxes side by side along an axis, in that order, or null when two of them overlap
 * along it: then there is no spacing to speak of. `order` lists the indexes of the boxes from first to last.
 */
export function spacingOf(boxes: Rect[], axis: 'x' | 'y'): { order: number[]; gaps: number[] } | null {
  if (boxes.length < 2) return null;
  const start = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const size = (r: Rect) => (axis === 'x' ? r.w : r.h);
  const order = boxes.map((_, i) => i).sort((a, b) => start(boxes[a]!) - start(boxes[b]!) || a - b);
  const gaps: number[] = [];
  for (let k = 1; k < order.length; k++) {
    const prev = boxes[order[k - 1]!]!;
    const gap = start(boxes[order[k]!]!) - (start(prev) + size(prev));
    if (gap < -0.5) return null;
    gaps.push(Math.max(0, gap));
  }
  return { order, gaps };
}

/** Moves that leave `gap` between boxes side by side along an axis, the first staying where it is. */
export function spaceDeltas(boxes: Rect[], axis: 'x' | 'y', gap: number): Vec[] {
  const out: Vec[] = boxes.map(() => ({ x: 0, y: 0 }));
  const s = spacingOf(boxes, axis);
  if (!s) return out;
  const start = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const size = (r: Rect) => (axis === 'x' ? r.w : r.h);
  let cursor = start(boxes[s.order[0]!]!);
  for (const i of s.order) {
    const d = cursor - start(boxes[i]!);
    out[i] = axis === 'x' ? { x: d, y: 0 } : { x: 0, y: d };
    cursor += size(boxes[i]!) + gap;
  }
  return out;
}
