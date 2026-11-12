import type { GradientStop } from '../lib/fills.ts';
import type { Vec } from './geometry.ts';

/** How CSS draws gradients, in a layer's own pixels. Pure, so that handles and CSS can be tested to agree. */
const RAD = Math.PI / 180;

/** The gradient line of `linear-gradient(<angle>)` in a box. 0% is at `start`, 100% at `end`. */
export function linearLine(angle: number, w: number, h: number): { start: Vec; end: Vec; dir: Vec; length: number } {
  const dir = { x: Math.sin(angle * RAD), y: -Math.cos(angle * RAD) };
  const length = Math.abs(w * dir.x) + Math.abs(h * dir.y);
  const cx = w / 2;
  const cy = h / 2;
  return { dir, length, start: { x: cx - (dir.x * length) / 2, y: cy - (dir.y * length) / 2 }, end: { x: cx + (dir.x * length) / 2, y: cy + (dir.y * length) / 2 } };
}

export function linearPoint(angle: number, w: number, h: number, at: number): Vec {
  const { start, dir, length } = linearLine(angle, w, h);
  return { x: start.x + (dir.x * length * at) / 100, y: start.y + (dir.y * length * at) / 100 };
}

/** The stop position of a point, projected on the gradient line. */
export function linearAt(angle: number, w: number, h: number, p: Vec): number {
  const { start, dir, length } = linearLine(angle, w, h);
  return length ? (((p.x - start.x) * dir.x + (p.y - start.y) * dir.y) / length) * 100 : 0;
}

export function angleBetween(from: Vec, to: Vec): number {
  const a = Math.atan2(to.x - from.x, -(to.y - from.y)) / RAD;
  return ((a % 360) + 360) % 360;
}

const tenth = (n: number) => Math.round(n * 10) / 10;

/**
 * After an end stop is dragged to `p`: the angle follows, the colour of the other end stays at that point
 * of the layer, and the stops between keep their share of the distance. CSS keeps its gradient line through
 * the centre, so the handle of the other end may slide along its colour band. `index` is the one dragged.
 */
export function dragLinearEnd(angle: number, stops: GradientStop[], w: number, h: number, index: number, p: Vec, snapDeg = 0): { angle: number; stops: GradientStop[] } {
  const ordered = stops.map((s, i) => ({ s, i })).sort((a, b) => a.s.at - b.s.at);
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  const draggingLast = index === last.i;
  const fixed = draggingLast ? first : last;
  const fixedPoint = linearPoint(angle, w, h, fixed.s.at);
  let next = draggingLast ? angleBetween(fixedPoint, p) : angleBetween(p, fixedPoint);
  if (snapDeg) next = (Math.round(next / snapDeg) * snapDeg) % 360;
  const fixedAt = linearAt(next, w, h, fixedPoint);
  const movedAt = linearAt(next, w, h, p);
  const from = draggingLast ? fixedAt : movedAt;
  const to = draggingLast ? movedAt : fixedAt;
  const span = last.s.at - first.s.at || 1;
  return {
    angle: tenth(next),
    stops: stops.map((s, i) => {
      if (i === first.i) return { ...s, at: tenth(from) };
      if (i === last.i) return { ...s, at: tenth(to) };
      return { ...s, at: tenth(from + ((s.at - first.s.at) / span) * (to - from)) };
    }),
  };
}

export interface RadialShape { kind: 'circle' | 'ellipse'; cx: number; cy: number; rx: number; ry: number }

function percentOf(token: string | undefined, size: number): number {
  if (!token) return size / 2;
  const named: Record<string, number> = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };
  if (token in named) return (named[token]! / 100) * size;
  if (token.endsWith('%')) return (parseFloat(token) / 100) * size;
  return parseFloat(token) || 0;
}

/** Reads the first argument of `radial-gradient()` into pixels, sized as the browser would size it. */
export function parseRadial(shape: string, w: number, h: number): RadialShape {
  const [head = '', tail = ''] = shape.trim().split(/\bat\b/).map((p) => p.trim());
  const tokens = head.split(/\s+/).filter(Boolean);
  const pos = tail.split(/\s+/).filter(Boolean);
  // A lone position keyword names one axis.
  let xToken = pos[0];
  let yToken = pos[1];
  if (pos.length === 1 && (xToken === 'top' || xToken === 'bottom')) { yToken = xToken; xToken = undefined; }
  const cx = percentOf(xToken, w);
  const cy = percentOf(yToken, h);
  const sizes = tokens.filter((t) => /^[\d.]/.test(t));
  const keyword = tokens.find((t) => /^(closest|farthest)-/.test(t)) ?? 'farthest-corner';
  const kind: RadialShape['kind'] = tokens.includes('circle') || (sizes.length === 1 && !tokens.includes('ellipse')) ? 'circle' : 'ellipse';
  const dx = keyword.startsWith('closest') ? Math.min(cx, w - cx) : Math.max(cx, w - cx);
  const dy = keyword.startsWith('closest') ? Math.min(cy, h - cy) : Math.max(cy, h - cy);
  if (sizes.length) {
    const rx = sizes[0]!.endsWith('%') ? (parseFloat(sizes[0]!) / 100) * w : parseFloat(sizes[0]!);
    const ry = sizes[1] ? (sizes[1].endsWith('%') ? (parseFloat(sizes[1]) / 100) * h : parseFloat(sizes[1])) : rx;
    return { kind, cx, cy, rx, ry: kind === 'circle' ? rx : ry };
  }
  if (kind === 'circle') {
    const r = keyword.endsWith('side') ? (keyword.startsWith('closest') ? Math.min(dx, dy) : Math.max(dx, dy)) : Math.hypot(dx, dy);
    return { kind, cx, cy, rx: r, ry: r };
  }
  const factor = keyword.endsWith('corner') ? Math.SQRT2 : 1;
  return { kind, cx, cy, rx: dx * factor, ry: dy * factor };
}

export function printRadial(r: RadialShape, w: number, h: number): string {
  const size = r.kind === 'circle' ? `circle ${tenth(r.rx)}px` : `ellipse ${tenth(r.rx)}px ${tenth(r.ry)}px`;
  return `${size} at ${tenth(w ? (r.cx / w) * 100 : 50)}% ${tenth(h ? (r.cy / h) * 100 : 50)}%`;
}

export function radialPoint(r: RadialShape, at: number): Vec {
  return { x: r.cx + (r.rx * at) / 100, y: r.cy };
}

/** Where a point falls on the radius a stop handle runs along. */
export function radialAt(r: RadialShape, p: Vec): number {
  return r.rx ? ((p.x - r.cx) / r.rx) * 100 : 0;
}
