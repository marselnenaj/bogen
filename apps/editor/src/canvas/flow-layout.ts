/**
 * The geometry of a page's canvas plan: routes for the connections between screens, and where the plan's words may
 * stand at a zoom. Pure functions on world coordinates, so they can be tested without a browser.
 *
 * Routes are orthogonal and run along the middle of the gaps between screens, never across one that is not an end.
 * They depend on the layout only, not on the zoom. Words keep a fixed size on the screen while the gaps shrink, so
 * where they fit is decided again whenever the zoom changes, in order of importance: section titles, lane names,
 * connection labels. What does not fit waits, and a label comes back on hover.
 */
import type { CanvasBox } from '@bogen/core';

export type Box = CanvasBox;
export type Pt = { x: number; y: number };
type Side = 'left' | 'right' | 'top' | 'bottom';
const NORMAL: Record<Side, Pt> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };

export interface FlowInput { from: string; to: string; label: string }
export interface FlowRoute extends FlowInput {
  points: Pt[];
  /** The path in world units, corners rounded. */
  d: string;
  /** Where the arrowhead's point touches the target, and the angle it travels in, in degrees. */
  tip: Pt & { angle: number };
  /** False when no route through the gaps exists and a direct line stands in. */
  routed: boolean;
}

const MARGIN = 16; const BEND = 90; const RADIUS = 18;
/**
 * Distances that must hold on the screen, not only on the canvas, in world units for the zoom a pass routes for: the
 * straight run out of a port and into an arrowhead, how far apart ports on one side and parallel lines stay, and how
 * far a line keeps from a section's frame. Set at the start of each routing pass.
 */
let K = { stub: 24, spread: 24, separate: 12, keepOff: 24, lead: 12 };
const scaleFor = (z: number) => ({ stub: Math.max(24, 14 / z), spread: Math.max(24, 12 / z), separate: Math.max(12, 8 / z), keepOff: Math.max(24, 14 / z), lead: 12 / z });
/**
 * The farthest zoom a plan page shows the screens' names at. Names and titles keep their size on the screen, so they
 * take the most of a gap here; routes are worked out once, round names and titles as large as they stand at this
 * zoom, and serve every zoom.
 */
export const NAME_ZOOM = 0.22;

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);
const inflate = (b: Box, m: number): Box => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m });

/**
 * Sides to try for a connection, best first: facing sides, or, when other screens stand between two screens of a row,
 * under the row and back up, the way a step that skips screens is drawn by hand.
 */
function sidePairs(a: Box, b: Box, screens: Box[]): [Side, Side][] {
  const rows = overlap(a.y, a.y + a.h, b.y, b.y + b.h) > 0;
  const cols = overlap(a.x, a.x + a.w, b.x, b.x + b.w) > 0;
  if (rows && !cols) {
    const x0 = Math.min(a.x + a.w, b.x + b.w); const x1 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y); const y1 = Math.min(a.y + a.h, b.y + b.h);
    const facing: [Side, Side] = b.x > a.x ? ['right', 'left'] : ['left', 'right'];
    const between = screens.some(s => s !== a && s !== b && overlap(s.x, s.x + s.w, x0, x1) > 0 && overlap(s.y, s.y + s.h, y0, y1) > 0);
    return between ? [['bottom', 'bottom'], facing, ['top', 'top']] : [facing, ['bottom', 'bottom'], ['top', 'top']];
  }
  if (cols && !rows) {
    const x0 = Math.max(a.x, b.x); const x1 = Math.min(a.x + a.w, b.x + b.w);
    const y0 = Math.min(a.y + a.h, b.y + b.h); const y1 = Math.max(a.y, b.y);
    const facing: [Side, Side] = b.y > a.y ? ['bottom', 'top'] : ['top', 'bottom'];
    const between = screens.some(s => s !== a && s !== b && overlap(s.x, s.x + s.w, x0, x1) > 0 && overlap(s.y, s.y + s.h, y0, y1) > 0);
    return between ? [['right', 'right'], facing, ['left', 'left']] : [facing, ['right', 'right'], ['left', 'left']];
  }
  if (rows && cols) return [];
  // Diagonal: down (or up) and in from the top, else down and in from the side that faces the source, else across.
  const v: [Side, Side] = b.y > a.y ? ['bottom', 'top'] : ['top', 'bottom'];
  const h: [Side, Side] = b.x > a.x ? ['right', 'left'] : ['left', 'right'];
  return [v, [v[0], h[1]], h];
}

/**
 * Where on its side a port prefers to sit: across from the other screen when they face, else a little towards it.
 * `clear`: for a line that meets the top of a screen, where that screen's name ends; the port keeps right of it.
 */
function preferred(box: Box, side: Side, other: Box, exit: boolean, clear = -Infinity): number {
  const inset = Math.min(24, (side === 'left' || side === 'right' ? box.h : box.w) / 4);
  if (side === 'left' || side === 'right') {
    const o0 = Math.max(box.y, other.y); const o1 = Math.min(box.y + box.h, other.y + other.h);
    const at = o1 > o0 ? (o0 + o1) / 2 : box.y + box.h / 2;
    return Math.min(box.y + box.h - inset, Math.max(box.y + inset, at));
  }
  const o0 = Math.max(box.x, other.x); const o1 = Math.min(box.x + box.w, other.x + other.w);
  // Facing straight on, the line drops without a bend. Otherwise an exit leans towards its target; an entry stays
  // central, so that a line leaving one screen and one arriving below it never share a column.
  if (o1 > o0) return clear + 24 <= o1 - inset ? Math.max((o0 + o1) / 2, clear + 24) : (o0 + o1) / 2;
  const lean = exit ? Math.sign(other.x + other.w / 2 - (box.x + box.w / 2)) * 0.12 : 0;
  const at = box.x + box.w * (0.5 + lean);
  return clear + 24 <= box.x + box.w - inset ? Math.max(at, clear + 24) : at;
}

/** Where the name above `top` ends, when a line between a and b meets the top of `top`. */
function nameClear(side: Side, box: Box, other: Box, names: Map<Box, number>): number {
  if (side === 'top') return names.get(box) ?? -Infinity;
  // A straight drop from a bottom port meets the top of the screen below it.
  if (side === 'bottom' && other.y >= box.y + box.h && overlap(box.x, box.x + box.w, other.x, other.x + other.w) > 0) return names.get(other) ?? -Infinity;
  return -Infinity;
}

function portPoint(box: Box, side: Side, at: number): Pt {
  // On the half-unit grid the search runs on.
  const along = Math.round(at * 2) / 2;
  if (side === 'left') return { x: box.x, y: along };
  if (side === 'right') return { x: box.x + box.w, y: along };
  if (side === 'top') return { x: along, y: box.y };
  return { x: along, y: box.y + box.h };
}

/** A binary heap of [priority, value]. */
class Heap {
  private p: number[] = []; private v: number[] = [];
  get size() { return this.v.length; }
  push(pr: number, val: number) {
    const p = this.p; const v = this.v; let i = v.length; p.push(pr); v.push(val);
    while (i > 0) { const up = (i - 1) >> 1; if (p[up]! <= pr) break; p[i] = p[up]!; v[i] = v[up]!; i = up; }
    p[i] = pr; v[i] = val;
  }
  pop(): number {
    const p = this.p; const v = this.v; const top = v[0]!; const lp = p.pop()!; const lv = v.pop()!;
    if (v.length) {
      let i = 0; const n = v.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && p[c + 1]! < p[c]!) c++; if (p[c]! >= lp) break; p[i] = p[c]!; v[i] = v[c]!; i = c; }
      p[i] = lp; v[i] = lv;
    }
    return top;
  }
}

const DIRS: Pt[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
const dirOf = (d: Pt) => DIRS.findIndex(k => k.x === d.x && k.y === d.y);

/**
 * The cheapest orthogonal path from s to e on lines through the middle of every gap, with a cost for each bend.
 * Returns the corner points, or null when the obstacles leave no way.
 */
function search(s: Pt, sDir: number, e: Pt, eDir: number, obstacles: Box[], frames: Box[] = []): { points: Pt[]; cost: number } | null {
  const lo = { x: Math.min(s.x, e.x), y: Math.min(s.y, e.y) }; const hi = { x: Math.max(s.x, e.x), y: Math.max(s.y, e.y) };
  for (const o of obstacles) { lo.x = Math.min(lo.x, o.x); lo.y = Math.min(lo.y, o.y); hi.x = Math.max(hi.x, o.x + o.w); hi.y = Math.max(hi.y, o.y + o.h); }
  // Lines through the middle of every gap, between screens, names and frames.
  const axis = (a: number, b: number, solid: number[], frame: number[], lo: number, hi: number) => {
    const edges = [...solid.map(v => ({ v, frame: false })), ...frame.map(v => ({ v, frame: true }))].sort((p, q) => p.v - q.v);
    const out = [a, b, lo - 48, hi + 48];
    for (let i = 0; i + 1 < edges.length; i++) {
      // The middle of the gap, but never along a frame: a line keeps K.keepOff from one, or that gap has no line.
      const g0 = edges[i]!.v + (edges[i]!.frame ? K.keepOff : 0); const g1 = edges[i + 1]!.v - (edges[i + 1]!.frame ? K.keepOff : 0);
      if (g1 >= g0) out.push((g0 + g1) / 2);
    }
    return [...new Set(out.map(v => Math.round(v * 2) / 2))].sort((p, q) => p - q);
  };
  const xs = axis(s.x, e.x, obstacles.flatMap(o => [o.x, o.x + o.w]), frames.flatMap(f => [f.x, f.x + f.w]), lo.x, hi.x);
  const ys = axis(s.y, e.y, obstacles.flatMap(o => [o.y, o.y + o.h]), frames.flatMap(f => [f.y, f.y + f.h]), lo.y, hi.y);
  const nx = xs.length; const ny = ys.length;
  // Blocked nodes and edges, marked once from the obstacles.
  const inside = new Uint8Array(nx * ny); const blockH = new Uint8Array(nx * ny); const blockV = new Uint8Array(nx * ny);
  const first = (arr: number[], v: number) => { let a = 0; let b = arr.length; while (a < b) { const m = (a + b) >> 1; if (arr[m]! <= v) a = m + 1; else b = m; } return a; };
  for (const o of obstacles) {
    const i0 = first(xs, o.x); const i1 = first(xs, o.x + o.w - 1e-6); const j0 = first(ys, o.y); const j1 = first(ys, o.y + o.h - 1e-6);
    for (let j = j0; j < j1; j++) {
      if (!(ys[j]! > o.y && ys[j]! < o.y + o.h)) continue;
      for (let i = Math.max(0, i0 - 1); i < Math.min(nx - 1, i1 + 1); i++) if (overlap(xs[i]!, xs[i + 1]!, o.x, o.x + o.w) > 0) blockH[j * nx + i] = 1;
      for (let i = i0; i < i1; i++) if (xs[i]! > o.x && xs[i]! < o.x + o.w) inside[j * nx + i] = 1;
    }
    for (let i = i0; i < i1; i++) {
      if (!(xs[i]! > o.x && xs[i]! < o.x + o.w)) continue;
      for (let j = Math.max(0, j0 - 1); j < Math.min(ny - 1, j1 + 1); j++) if (overlap(ys[j]!, ys[j + 1]!, o.y, o.y + o.h) > 0) blockV[j * nx + i] = 1;
    }
  }
  // A line one stub away from a screen's edge hugs it: going along one costs more, so routes keep to the middle of
  // a gap where they can.
  const hugX = new Uint8Array(nx); const hugY = new Uint8Array(ny);
  for (const [p, dir] of [[s, sDir], [e, eDir]] as const) {
    if (DIRS[dir]!.y !== 0) hugY[ys.indexOf(Math.round(p.y * 2) / 2)] = 1; else hugX[xs.indexOf(Math.round(p.x * 2) / 2)] = 1;
  }
  const si = xs.indexOf(Math.round(s.x * 2) / 2); const sj = ys.indexOf(Math.round(s.y * 2) / 2);
  const ei = xs.indexOf(Math.round(e.x * 2) / 2); const ej = ys.indexOf(Math.round(e.y * 2) / 2);
  if (si < 0 || sj < 0 || ei < 0 || ej < 0 || inside[sj * nx + si] || inside[ej * nx + ei]) return null;
  const n = nx * ny * 4;
  const dist = new Float64Array(n).fill(Infinity); const prev = new Int32Array(n).fill(-1);
  const heap = new Heap();
  const h = (i: number, j: number) => Math.abs(xs[i]! - xs[ei]!) + Math.abs(ys[j]! - ys[ej]!);
  const start = (sj * nx + si) * 4 + sDir;
  dist[start] = 0; heap.push(h(si, sj), start);
  let best = -1; let bestCost = Infinity;
  while (heap.size) {
    const st = heap.pop(); const d = dist[st]!;
    if (d >= bestCost) break;
    const node = st >> 2; const dir = st & 3; const i = node % nx; const j = (node / nx) | 0;
    if (i === ei && j === ej) {
      const turn = dir === eDir ? 0 : (DIRS[dir]!.x === -DIRS[eDir]!.x && DIRS[dir]!.y === -DIRS[eDir]!.y ? 3 * BEND : BEND);
      if (d + turn < bestCost) { bestCost = d + turn; best = st; }
      continue;
    }
    for (let k = 0; k < 4; k++) {
      const m = DIRS[k]!;
      if (m.x === -DIRS[dir]!.x && m.y === -DIRS[dir]!.y) continue;
      const ni = i + m.x; const nj = j + m.y;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      if (m.y === 0 ? blockH[j * nx + Math.min(i, ni)] : blockV[Math.min(j, nj) * nx + i]) continue;
      if (inside[nj * nx + ni]) continue;
      const len = Math.abs(xs[ni]! - xs[i]!) + Math.abs(ys[nj]! - ys[j]!);
      const hug = m.y === 0 ? hugY[j] : hugX[i];
      const nd = d + len * (hug ? 1.15 : 1) + (k === dir ? 0 : BEND);
      const ns = (nj * nx + ni) * 4 + k;
      if (nd < dist[ns]!) { dist[ns] = nd; prev[ns] = st; heap.push(nd + h(ni, nj), ns); }
    }
  }
  if (best < 0) return null;
  const pts: Pt[] = [];
  for (let st = best; st >= 0; st = prev[st]!) { const node = st >> 2; pts.push({ x: xs[node % nx]!, y: ys[(node / nx) | 0]! }); }
  return { points: pts.reverse(), cost: bestCost };
}

/** Drops points that do not turn. */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1]!.x === p.x && out[out.length - 1]!.y === p.y) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2]!; const b = out[out.length - 1]!;
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}

/** The obstacles near a connection: screens within reach of the two ends, kept off by a margin. */
function near(a: Box, b: Box, screens: Box[], reach: number, margin: number): Box[] {
  const x0 = Math.min(a.x, b.x) - reach; const y0 = Math.min(a.y, b.y) - reach;
  const x1 = Math.max(a.x + a.w, b.x + b.w) + reach; const y1 = Math.max(a.y + a.h, b.y + b.h) + reach;
  return screens.filter(s => s.x < x1 && s.x + s.w > x0 && s.y < y1 && s.y + s.h > y0).map(s => inflate(s, margin));
}

function tryRoute(a: Box, b: Box, sa: Side, sb: Side, pa: number, pb: number, screens: Box[], frames: Box[]): { points: Pt[]; cost: number } | null {
  const A = portPoint(a, sa, pa); const B = portPoint(b, sb, pb);
  /** The straight run out of a port, as long as wanted unless its end would sit near a frame's edge. */
  const stubFrom = (P: Pt, side: Side, want: number) => {
    const n = NORMAL[side];
    for (const len of [want, 24, want * 1.5]) {
      const at = n.y ? P.y + n.y * len : P.x + n.x * len;
      const near = frames.some(f => n.y
        ? P.x > f.x && P.x < f.x + f.w && (Math.abs(at - f.y) < K.keepOff / 2 || Math.abs(at - f.y - f.h) < K.keepOff / 2)
        : P.y > f.y && P.y < f.y + f.h && (Math.abs(at - f.x) < K.keepOff / 2 || Math.abs(at - f.x - f.w) < K.keepOff / 2));
      if (!near) return len;
    }
    return want;
  };
  // Facing ports in line with nothing between them: one straight line.
  const facing = NORMAL[sa].x === -NORMAL[sb].x && NORMAL[sa].y === -NORMAL[sb].y && (B.x - A.x) * NORMAL[sa].x + (B.y - A.y) * NORMAL[sa].y > 0;
  if (facing && (A.x === B.x || A.y === B.y)) {
    const r = { x: Math.min(A.x, B.x), y: Math.min(A.y, B.y), w: Math.abs(B.x - A.x) || 0.01, h: Math.abs(B.y - A.y) || 0.01 };
    if (!screens.some(o => o !== a && o !== b && touch(r, o))) return { points: [A, B], cost: Math.hypot(B.x - A.x, B.y - A.y) };
  }
  // Between facing ports the two runs out of them never pass each other.
  const room = facing ? Math.abs((B.x - A.x) * NORMAL[sa].x + (B.y - A.y) * NORMAL[sa].y) / 2 - 1 : Infinity;
  for (const [margin, wanted] of [[MARGIN, K.stub], [MARGIN, 24], [4, 8]] as const) {
    const sA = Math.min(room, stubFrom(A, sa, wanted)); const sB = Math.min(room, stubFrom(B, sb, wanted));
    const S = { x: A.x + NORMAL[sa].x * sA, y: A.y + NORMAL[sa].y * sA };
    const E = { x: B.x + NORMAL[sb].x * sB, y: B.y + NORMAL[sb].y * sB };
    for (const reach of [480, Infinity]) {
      const found = search(S, dirOf(NORMAL[sa]), E, dirOf({ x: -NORMAL[sb].x, y: -NORMAL[sb].y }), near(a, b, screens, reach, margin), frames);
      if (found) return { points: simplify([A, ...found.points, B]), cost: found.cost };
    }
  }
  return null;
}

/**
 * Pushes apart stretches of different routes that run along the same line, so that each stays its own, as far as the
 * screens around them allow.
 */
function separate(routes: Pt[][], obstacles: Box[], frames: Box[] = []): void {
  const blocked = (p: Pt, q: Pt) => { const r = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x) || 0.01, h: Math.abs(q.y - p.y) || 0.01 }; return obstacles.some(o => touch(r, inflate(o, 4))); };
  /** A stretch moved to run along a frame's edge, nearer than half the distance lines keep from frames. */
  const hugs = (p: Pt, q: Pt) => {
    const near = K.keepOff / 2;
    return frames.some(f => p.y === q.y
      ? overlap(Math.min(p.x, q.x), Math.max(p.x, q.x), f.x, f.x + f.w) > 0 && (Math.abs(p.y - f.y) < near || Math.abs(p.y - f.y - f.h) < near)
      : overlap(Math.min(p.y, q.y), Math.max(p.y, q.y), f.y, f.y + f.h) > 0 && (Math.abs(p.x - f.x) < near || Math.abs(p.x - f.x - f.w) < near));
  };
  for (const horizontal of [true, false]) {
    const segs: { r: number; s: number; at: number; lo: number; hi: number }[] = [];
    routes.forEach((pts, r) => {
      // Not the first and last stretch: those meet their screens at fixed ports.
      for (let s = 1; s < pts.length - 2; s++) {
        const p = pts[s]!; const q = pts[s + 1]!;
        if (horizontal ? p.y === q.y : p.x === q.x) segs.push({ r, s, at: horizontal ? p.y : p.x, lo: Math.min(horizontal ? p.x : p.y, horizontal ? q.x : q.y), hi: Math.max(horizontal ? p.x : p.y, horizontal ? q.x : q.y) });
      }
    });
    const byLine = new Map<number, typeof segs>();
    for (const g of segs) { const k = Math.round(g.at); byLine.set(k, [...(byLine.get(k) ?? []), g]); }
    for (const group of byLine.values()) {
      if (group.length < 2) continue;
      group.sort((p, q) => p.lo - q.lo);
      // Clusters of stretches that overlap along the line.
      let cluster: typeof segs = []; let end = -Infinity;
      const flush = () => {
        cluster.forEach((g, k) => {
          const pts = routes[g.r]!;
          for (const scale of [1, 0.5, 0.25]) {
            const off = (k - (cluster.length - 1) / 2) * K.separate * scale;
            if (!off) return;
            const move = (p: Pt) => horizontal ? { x: p.x, y: p.y + off } : { x: p.x + off, y: p.y };
            const p = move(pts[g.s]!); const q = move(pts[g.s + 1]!);
            // The stretch and the two it joins must stay clear of screens where they move to.
            // A stretch that starts at a port leaves its own screen: only what lies beyond the first few units counts.
            const away = (port: Pt, to: Pt) => { const len = Math.hypot(to.x - port.x, to.y - port.y) || 1; const t = Math.min(1, 8 / len); return { x: port.x + (to.x - port.x) * t, y: port.y + (to.y - port.y) * t }; };
            const before = g.s - 1 === 0 ? away(pts[0]!, p) : pts[g.s - 1]!;
            const after = g.s + 2 === pts.length - 1 ? away(pts[g.s + 2]!, q) : pts[g.s + 2]!;
            if (blocked(p, q) || hugs(p, q) || blocked(before, p) || blocked(q, after)) continue;
            pts[g.s] = p; pts[g.s + 1] = q;
            return;
          }
        });
      };
      for (const g of group) {
        if (g.lo >= end - 0.5 && cluster.length) { if (cluster.length > 1) flush(); cluster = []; end = -Infinity; }
        cluster.push(g); end = Math.max(end, g.hi);
      }
      if (cluster.length > 1) flush();
    }
  }
}

/** An SVG path along the points with gently rounded corners, and a straight run of `lead` into the end. */
export function roundedPath(pts: Pt[], radius = RADIUS, lead = 0): string {
  const f = (v: number) => Math.round(v * 10) / 10;
  let d = `M${f(pts[0]!.x)},${f(pts[0]!.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!; const b = pts[i]!; const c = pts[i + 1]!;
    const l1 = Math.hypot(b.x - a.x, b.y - a.y); const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, l1 / 2, i === pts.length - 2 ? Math.max(0, l2 - lead) : l2 / 2);
    if (r < 0.5) { d += ` L${f(b.x)},${f(b.y)}`; continue; }
    d += ` L${f(b.x - ((b.x - a.x) / l1) * r)},${f(b.y - ((b.y - a.y) / l1) * r)} Q${f(b.x)},${f(b.y)} ${f(b.x + ((c.x - b.x) / l2) * r)},${f(b.y + ((c.y - b.y) / l2) * r)}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L${f(last.x)},${f(last.y)}`;
}

/**
 * Routes for a plan's connections. `boxes` holds the screens the connections join, `screens` every visible screen on
 * the page, which the routes go round. `frames`: the section frames, which routes keep off. `names`: for a screen,
 * where the name above it ends at zoom `nameZoom`; routes go round names as large as they stand there.
 */
export function routeFlows(connections: FlowInput[], boxes: Map<string, Box>, screens: Box[], options: { frames?: Box[]; names?: Map<Box, number>; titles?: Box[]; nameZoom?: number; zoom?: number } = {}): FlowRoute[] {
  K = scaleFor(options.zoom ?? 1);
  const frames = options.frames ?? []; const names = options.names ?? new Map<Box, number>();
  // The names above the screens are obstacles too, kept off by a few screen pixels rather than a screen's margin.
  const nz = options.nameZoom ?? NAME_ZOOM; const band = (SIZES.nameRise + SIZES.air) / nz; const tight = MARGIN - 4 / nz;
  const words = [...[...names].map(([b, end]) => ({ x: b.x, y: b.y - band, w: end - b.x, h: band })), ...(options.titles ?? [])];
  const solid = [...screens, ...words.flatMap(w => w.w > 2 * tight && w.h > 2 * tight ? [{ x: w.x + tight, y: w.y + tight, w: w.w - 2 * tight, h: w.h - 2 * tight }] : [])];
  /** A route round screens and names; failing that, round the screens only, marked as running through a name. */
  const route = (a: Box, b: Box, sa: Side, sb: Side, pa: number, pb: number) => {
    const clean = tryRoute(a, b, sa, sb, pa, pb, solid, frames);
    if (clean || !names.size) return clean && { ...clean, throughName: false };
    const rough = tryRoute(a, b, sa, sb, pa, pb, screens, frames);
    return rough && { ...rough, throughName: true };
  };
  const want = (box: Box, side: Side, other: Box, exit: boolean) => preferred(box, side, other, exit, nameClear(side, box, other, names));
  /** A port on top whose line would run through the name above the screen. */
  const crossesName = (box: Box, side: Side, other: Box, at: number) => { const clear = nameClear(side, box, other, names); return clear > -Infinity && at < clear + 6; };
  type Pick = { c: FlowInput; a: Box; b: Box; sides: [Side, Side] | null };
  const picks: Pick[] = connections.flatMap(c => {
    const a = boxes.get(c.from); const b = boxes.get(c.to);
    if (!a || !b) return [];
    // The sides: the cheapest of the candidates, each routed from its preferred ports.
    let sides: [Side, Side] | null = null; let cost = Infinity;
    sidePairs(a, b, screens).forEach((pair, k) => {
      const pa = want(a, pair[0], b, true); const pb = want(b, pair[1], a, false);
      const r = route(a, b, pair[0], pair[1], pa, pb);
      // The first candidate is the drawing a person expects; another wins only when it is much shorter. A line through
      // a screen's name is the last resort.
      const total = r ? r.cost + k * 1500 + (r.throughName || crossesName(a, pair[0], b, pa) || crossesName(b, pair[1], a, pb) ? 6000 : 0) : Infinity;
      if (total < cost) { cost = total; sides = pair; }
    });
    return [{ c, a, b, sides }];
  });
  // Several connections on one side of a screen share it out, in the order of where each would like to sit.
  const groups = new Map<string, { k: number; end: 0 | 1; want: number; size: number }[]>();
  picks.forEach((p, k) => {
    if (!p.sides) return;
    for (const end of [0, 1] as const) {
      const key = `${end ? p.c.to : p.c.from}:${p.sides[end]}`;
      const at = end ? want(p.b, p.sides[1], p.a, false) : want(p.a, p.sides[0], p.b, true);
      groups.set(key, [...(groups.get(key) ?? []), { k, end, want: at, size: 0 }]);
    }
  });
  const ports = new Map<string, number>();
  for (const [key, members] of groups) {
    const [id, side] = key.split(':') as [string, Side];
    const box = boxes.get(id)!;
    const span = side === 'left' || side === 'right' ? [box.y, box.y + box.h] : [box.x, box.x + box.w];
    members.sort((p, q) => p.want - q.want || p.k - q.k);
    const mean = members.reduce((s, m) => s + m.want, 0) / members.length;
    const step = Math.min(K.spread, (span[1]! - span[0]!) / (members.length + 1));
    members.forEach((m, i) => {
      const at = members.length === 1 ? m.want : mean + (i - (members.length - 1) / 2) * step;
      ports.set(`${m.k}:${m.end}`, Math.min(span[1]! - step / 2, Math.max(span[0]! + step / 2, at)));
      m.size = members.length;
    });
  }
  // Screens that face each other keep a straight line: the end on the busier side sets where both sit.
  const sizes = new Map([...groups.values()].flat().map(m => [`${m.k}:${m.end}`, m.size]));
  picks.forEach((p, k) => {
    if (!p.sides) return;
    const [sa, sb] = p.sides;
    const horizontal = (sa === 'right' && sb === 'left') || (sa === 'left' && sb === 'right');
    const vertical = (sa === 'bottom' && sb === 'top') || (sa === 'top' && sb === 'bottom');
    if (!horizontal && !vertical) return;
    const lo = horizontal ? Math.max(p.a.y, p.b.y) + 12 : Math.max(p.a.x, p.b.x) + 12;
    const hi = horizontal ? Math.min(p.a.y + p.a.h, p.b.y + p.b.h) - 12 : Math.min(p.a.x + p.a.w, p.b.x + p.b.w) - 12;
    const a = ports.get(`${k}:0`)!; const b = ports.get(`${k}:1`)!;
    const at = (sizes.get(`${k}:0`) ?? 1) >= (sizes.get(`${k}:1`) ?? 1) ? a : b;
    if (at >= lo && at <= hi) { ports.set(`${k}:0`, at); ports.set(`${k}:1`, at); }
  });
  const lines: Pt[][] = []; const routed: boolean[] = [];
  picks.forEach((p, k) => {
    const r = p.sides ? route(p.a, p.b, p.sides[0], p.sides[1], ports.get(`${k}:0`)!, ports.get(`${k}:1`)!) : null;
    if (r) { lines.push(r.points); routed.push(true); return; }
    // No way through the gaps, or screens that overlap: a direct line from edge to edge stands in.
    const ca = { x: p.a.x + p.a.w / 2, y: p.a.y + p.a.h / 2 }; const cb = { x: p.b.x + p.b.w / 2, y: p.b.y + p.b.h / 2 };
    lines.push([edgeToward(p.a, cb), edgeToward(p.b, ca)]); routed.push(false);
  });
  separate(lines, screens, frames);
  lines.forEach(pts => straighten(pts, solid));
  return picks.map((p, k) => {
    const pts = lines[k]!; const a = pts[pts.length - 2]!; const b = pts[pts.length - 1]!;
    return { ...p.c, points: pts, d: roundedPath(pts, RADIUS, K.lead), tip: { ...b, angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI }, routed: routed[k]! };
  });
}

function edgeToward(box: Box, to: Pt): Pt {
  const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const dx = to.x - c.x; const dy = to.y - c.y;
  const t = Math.min(dx ? box.w / 2 / Math.abs(dx) : Infinity, dy ? box.h / 2 / Math.abs(dy) : Infinity, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Where the words stand at a zoom.                                                                              */

/** Sizes in screen pixels, from the overlay's styles. */
export const SIZES = {
  /** A screen's name stands this far above it, this tall (the editor's frame labels). */
  nameRise: 20, nameHeight: 16, namePad: 4,
  titleLine: 20, purposeLine: 16, titleGap: 2, titlePad: 6, compactLine: 16,
  laneLine: 16, laneGap: 10,
  labelLine: 16, labelPadX: 6, labelPadY: 2, labelMaxLines: 3,
  /** Room kept around every word, so that nothing touches; more around a connection's label and a section's title. */
  air: 3, labelAir: 5, titleAir: 8, labelLead: 10,
};

/**
 * Zoom tiers. Below NAMES_MIN_Z a plan page shows its frames, titles and routes only: the screens' names no longer
 * fit the gaps between rows. Lane names, connection labels and a section's purpose each wait for their tier, and
 * then for room.
 */
export const NAMES_MIN_Z = NAME_ZOOM; export const LANES_MIN_Z = 0.4; export const LABELS_MIN_Z = 0.12; export const PURPOSE_MIN_Z = 0.2;

export type TitleLod = 'full' | 'one' | 'title' | 'compact';
/** `top`: where the section's first screens start, whose names may rise above the frame when zoomed far out. */
export interface PlaceSection { id: string; box: Box; top: number; titleWidth: number; purposeWidth: number; compactWidth: number }
export interface PlaceLane { key: string; section: string; box: Box; width: number }
export interface PlaceLabel { key: string; route: Pt[]; width: number; words: number[]; space: number }
export interface PlaceScreen { box: Box; nameWidth: number }
export interface Placement {
  /** How much of a title shows, and how far in screen pixels the frame reaches up to hold its first screens' names. */
  sections: Map<string, { lod: TitleLod; grow: number; wide: boolean }>;
  lanes: Map<string, boolean>;
  /** Shown labels: the centre in world units and the lines the text breaks into, as word counts. */
  labels: Map<string, { x: number; y: number; lines: number[]; width: number; height: number }>;
}
type Candidate = { x: number; y: number; lines: number[]; width: number; height: number; id: string };

/** A grid of world cells over the screens, so that each test looks at the screens nearby only. */
export class ScreenIndex {
  private cells = new Map<string, number[]>();
  constructor(readonly screens: PlaceScreen[], private size = 1024) {
    screens.forEach((s, i) => {
      for (let cx = Math.floor(s.box.x / size); cx <= Math.floor((s.box.x + s.box.w) / size); cx++)
        for (let cy = Math.floor(s.box.y / size); cy <= Math.floor((s.box.y + s.box.h) / size); cy++) {
          const k = `${cx},${cy}`; const list = this.cells.get(k); if (list) list.push(i); else this.cells.set(k, [i]);
        }
    });
  }
  /** Whether r (world) touches a screen or a screen's name at zoom z. */
  hits(r: Box, z: number): boolean {
    const rise = (SIZES.nameRise + SIZES.air) / z;
    const seen = new Set<number>();
    for (let cx = Math.floor(r.x / this.size); cx <= Math.floor((r.x + r.w) / this.size); cx++)
      for (let cy = Math.floor(r.y / this.size); cy <= Math.floor((r.y + r.h + rise) / this.size); cy++)
        for (const i of this.cells.get(`${cx},${cy}`) ?? []) {
          if (seen.has(i)) continue; seen.add(i);
          const s = this.screens[i]!;
          if (touch(r, s.box)) return true;
          if (z < NAMES_MIN_Z) continue;
          const nameW = Math.min(s.nameWidth + 2 * SIZES.namePad, Math.max(18, s.box.w * z)) / z;
          if (touch(r, { x: s.box.x, y: s.box.y - SIZES.nameRise / z, w: nameW, h: SIZES.nameHeight / z })) return true;
        }
    return false;
  }
}

const touch = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Greedy line breaks of words of these widths at most `max` wide; widths in screen pixels. */
export function breakLines(words: number[], space: number, max: number): number[] | null {
  const lines: number[] = []; let w = -space; let n = 0;
  for (const word of words) {
    if (word > max) return null;
    if (n && w + space + word > max) { lines.push(n); n = 0; w = -space; }
    w += space + word; n++;
  }
  if (n) lines.push(n);
  return lines;
}

function lineWidths(words: number[], space: number, lines: number[]): number {
  let i = 0; let widest = 0;
  for (const n of lines) { let w = 0; for (let k = 0; k < n; k++) w += words[i++]! + (k ? space : 0); widest = Math.max(widest, w); }
  return widest;
}

/**
 * Decides, for zoom z, which words stand and where. `previous` keeps a label where it was while it still fits, so
 * that zooming does not make labels jump between places.
 */
export function placeWords(z: number, screens: ScreenIndex, sections: PlaceSection[], lanes: PlaceLane[], labels: PlaceLabel[], previous?: Placement): Placement {
  const air = SIZES.air / z;
  const lines = routeIndex(labels);
  const taken: Box[] = [];
  /** Clear of screens, their names and what already stands; titles and lane names also stay out of other frames. */
  const free = (r: Box, own: string | null, room = air) => {
    const padded = { x: r.x - room, y: r.y - room, w: r.w + 2 * room, h: r.h + 2 * room };
    if (screens.hits(padded, z)) return false;
    if (taken.some(t => touch(padded, t))) return false;
    return own === null || !sections.some(s => s.id !== own && touch(r, s.box));
  };
  const out: Placement = { sections: new Map(), lanes: new Map(), labels: new Map() };
  // Section titles first: they always stand, as large as the room above their frame allows.
  for (const s of sections) {
    const P = SIZES;
    const variants: [TitleLod, number, number][] = [
      ['full', P.titlePad + P.titleLine + P.titleGap + 2 * P.purposeLine, Math.max(s.titleWidth, Math.min(s.purposeWidth, s.box.w * z))],
      ['one', P.titlePad + P.titleLine + P.titleGap + P.purposeLine, Math.max(s.titleWidth, s.purposeWidth)],
      ['title', P.titlePad + P.titleLine, s.titleWidth],
      ['compact', 4 + P.compactLine, s.compactWidth],
    ];
    // Where names show, the frame reaches up past the names of its first screens.
    const grow = z < NAMES_MIN_Z ? 0 : Math.max(0, SIZES.nameRise + 4 - (s.top - s.box.y) * z);
    const bottom = s.box.y - grow / z;
    let chosen = variants[variants.length - 1]!; let width = Math.min(chosen[2], s.box.w * z);
    // A title wider than a narrow frame runs on past it where nothing stands there, rather than being cut.
    const title = (v: [TitleLod, number, number], w: number) => ({ x: s.box.x, y: bottom - v[1] / z, w: w / z, h: v[1] / z });
    pick: for (const v of variants) {
      // Two lines of purpose only when one line would not hold it; none far out.
      if (v[0] === 'full' && s.purposeWidth <= s.box.w * z) continue;
      if ((v[0] === 'full' || v[0] === 'one') && z < PURPOSE_MIN_Z) continue;
      for (const w of v[0] === 'full' ? [Math.min(v[2], s.box.w * z)] : [v[2], Math.min(v[2], s.box.w * z)]) {
        if (free(title(v, w), s.id)) { chosen = v; width = w; break pick; }
      }
    }
    out.sections.set(s.id, { lod: chosen[0], grow, wide: width > s.box.w * z + 0.5 });
    // Kept at a distance, so that nothing else reads as part of the title.
    const room = (SIZES.titleAir - SIZES.air) / z; const r = title(chosen, width);
    taken.push({ x: r.x - room, y: r.y - room, w: r.w + 2 * room, h: r.h + 2 * room });
  }
  // Lane names above the names of their first screens, inside the frame, where the gap holds them.
  for (const l of lanes) {
    const w = Math.min(l.width, l.box.w * z) / z; const h = SIZES.laneLine / z;
    const r = { x: l.box.x, y: l.box.y - (SIZES.nameRise + SIZES.laneGap + SIZES.laneLine) / z, w, h };
    const section = sections.find(s => s.id === l.section)?.box;
    // Cut short with an ellipsis at the lane's width, but not to a stub.
    const ok = z >= LANES_MIN_Z && Math.min(l.width, l.box.w * z) >= Math.min(l.width, 72) && (!section || r.y >= section.y + air) && free(r, l.section);
    out.lanes.set(l.key, ok);
    if (ok) taken.push(r);
  }
  // Connection labels on their own route, on the longest free stretch, wrapped to a gap when it is narrow.
  for (const l of labels) {
    // A label that still fits in its shape stays where it was, so that zooming does not make it jump.
    const before = previous?.labels.get(l.key);
    const best = z >= LABELS_MIN_Z ? bestLabel(l) : null;
    const found = before && best && before.lines.length === best.lines.length && onRoute(before, l.route) && fits(before, l.key) ? before : best;
    if (found) { out.labels.set(l.key, found); taken.push(rectOf(found)); }
  }
  return out;

  /** Whether a spot still lies on the route, which moves when a screen does. */
  function onRoute(c: Pt, route: Pt[]): boolean {
    return route.slice(1).some((q, i) => { const p = route[i]!; return Math.min(p.x, q.x) - 0.5 <= c.x && c.x <= Math.max(p.x, q.x) + 0.5 && Math.min(p.y, q.y) - 0.5 <= c.y && c.y <= Math.max(p.y, q.y) + 0.5; });
  }
  function rectOf(c: { x: number; y: number; width: number; height: number }): Box {
    return { x: c.x - c.width / 2 / z, y: c.y - c.height / 2 / z, w: c.width / z, h: c.height / z };
  }
  function fits(c: { x: number; y: number; width: number; height: number }, own?: string): boolean {
    const r = rectOf(c);
    return free(r, null, SIZES.labelAir / z) && !lines.crosses(r, own);
  }
  function bestLabel(l: PlaceLabel): Candidate | null {
    const shapes: { lines: number[]; width: number; height: number }[] = [];
    const one = lineWidths(l.words, l.space, [l.words.length]);
    for (const max of [Infinity, 168, 128, 96, 72, 56]) {
      if (max !== Infinity && max >= one) continue;
      const lines = breakLines(l.words, l.space, max);
      if (!lines || lines.length > SIZES.labelMaxLines) continue;
      if (shapes.some(s => s.lines.length === lines.length)) continue;
      shapes.push({ lines, width: lineWidths(l.words, l.space, lines) + 2 * SIZES.labelPadX, height: lines.length * SIZES.labelLine + 2 * SIZES.labelPadY });
    }
    const segs = l.route.slice(1).map((q, i) => ({ p: l.route[i]!, q, len: Math.hypot(q.x - l.route[i]!.x, q.y - l.route[i]!.y) })).sort((a, b) => b.len - a.len).slice(0, 4);
    for (const shape of shapes) for (const s of segs) {
      // The label sits on its line, clear of the ends where the line meets a screen or turns.
      const along = (s.p.y === s.q.y ? shape.width : shape.height) / z;
      // At least this much of the line shows on either side, so that the label never swallows it.
      const show = SIZES.labelLead / z;
      if (s.len < along + 2 * show) continue;
      for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const c = { x: s.p.x + (s.q.x - s.p.x) * t, y: s.p.y + (s.q.y - s.p.y) * t, ...shape };
        const r = rectOf(c);
        // Kept within its own stretch, so it never hangs past a corner onto another.
        const lo = Math.min(s.p.x, s.q.x); const hi = Math.max(s.p.x, s.q.x); const top = Math.min(s.p.y, s.q.y); const bottom = Math.max(s.p.y, s.q.y);
        if (s.p.y === s.q.y ? (r.x < lo + show || r.x + r.w > hi - show) : (r.y < top + show || r.y + r.h > bottom - show)) continue;
        if (fits(c, l.key)) return { ...c, id: l.key };
      }
    }
    return null;
  }
}

/** The stretches of every route in world cells, so that a label can check it covers no other connection's line. */
function routeIndex(labels: PlaceLabel[], size = 1024) {
  const cells = new Map<string, { key: string; p: Pt; q: Pt }[]>();
  for (const l of labels) for (let i = 1; i < l.route.length; i++) {
    const p = l.route[i - 1]!; const q = l.route[i]!;
    for (let cx = Math.floor(Math.min(p.x, q.x) / size); cx <= Math.floor(Math.max(p.x, q.x) / size); cx++)
      for (let cy = Math.floor(Math.min(p.y, q.y) / size); cy <= Math.floor(Math.max(p.y, q.y) / size); cy++) {
        const k = `${cx},${cy}`; const list = cells.get(k); const seg = { key: l.key, p, q };
        if (list) list.push(seg); else cells.set(k, [seg]);
      }
  }
  return {
    crosses(r: Box, own?: string): boolean {
      for (let cx = Math.floor(r.x / size); cx <= Math.floor((r.x + r.w) / size); cx++)
        for (let cy = Math.floor(r.y / size); cy <= Math.floor((r.y + r.h) / size); cy++)
          for (const g of cells.get(`${cx},${cy}`) ?? []) {
            if (g.key === own) continue;
            // Orthogonal stretches, or a direct line's bounding box.
            if (touch(r, { x: Math.min(g.p.x, g.q.x), y: Math.min(g.p.y, g.q.y), w: Math.abs(g.q.x - g.p.x) || 0.01, h: Math.abs(g.q.y - g.p.y) || 0.01 })) return true;
          }
      return false;
    },
  };
}

/**
 * Takes out small steps: where a short stretch joins two parallel ones, one of them moves across to line up with the
 * other, when nothing stands in the way. Not the first or last stretch, which meet their screens at fixed ports.
 */
function straighten(pts: Pt[], obstacles: Box[]): void {
  const clear = (p: Pt, q: Pt) => { const r = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x) || 0.01, h: Math.abs(q.y - p.y) || 0.01 }; return !obstacles.some(o => touch(r, inflate(o, 4))); };
  for (let i = 1; i + 1 < pts.length - 1; i++) {
    const a = pts[i]!; const b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0 || len >= 2 * K.separate) continue;
    const horizontal = a.y === b.y;
    // Move the stretch before (ending at a) onto b's line, or the stretch after (starting at b) onto a's line.
    if (i - 1 >= 1) {
      const p = horizontal ? { x: b.x, y: pts[i - 1]!.y } : { x: pts[i - 1]!.x, y: b.y };
      if (clear(pts[i - 2]!, p) && clear(p, b)) { pts[i - 1] = p; pts[i] = { ...b }; continue; }
    }
    if (i + 2 <= pts.length - 2) {
      const q = horizontal ? { x: a.x, y: pts[i + 2]!.y } : { x: pts[i + 2]!.x, y: a.y };
      if (clear(a, q) && clear(q, pts[i + 3]!)) { pts[i + 2] = q; pts[i + 1] = { ...a }; }
    }
  }
  const out = simplify(pts); pts.length = 0; pts.push(...out);
}
