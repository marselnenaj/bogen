/** Bezier paths for the pen and pencil. Pure, no DOM. Parsing and writing path data live in @bogen/core. */
import type { PathPoint, SubPath } from '@bogen/core';

export { arcToCubics, boundsOf, parseD, pathToD, translatePaths, type PathPoint, type SubPath } from '@bogen/core';

/** Ramer-Douglas-Peucker. */
export function simplify(points: { x: number; y: number }[], tolerance: number): { x: number; y: number }[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = points[a]!;
    const pb = points[b]!;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    let far = -1;
    let farDist = tolerance;
    for (let i = a + 1; i < b; i++) {
      const p = points[i]!;
      const dist = Math.abs(dy * (p.x - pa.x) - dx * (p.y - pa.y)) / len;
      if (dist > farDist) { far = i; farDist = dist; }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Smooth bezier through points (Catmull-Rom), for pencil strokes. */
export function smoothPath(points: { x: number; y: number }[]): SubPath {
  const out: PathPoint[] = points.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 0; i < out.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    out[i]!.hx2 = p1.x + (p2.x - p0.x) / 6;
    out[i]!.hy2 = p1.y + (p2.y - p0.y) / 6;
    out[i + 1]!.hx1 = p2.x - (p3.x - p1.x) / 6;
    out[i + 1]!.hy1 = p2.y - (p3.y - p1.y) / 6;
  }
  return { points: out, closed: false };
}

/** Splits one cubic segment at t, returning the point to insert and updated neighbours. */
export function splitSegment(a: PathPoint, b: PathPoint, t: number): { a: PathPoint; mid: PathPoint; b: PathPoint } {
  const x1 = a.hx2 ?? a.x; const y1 = a.hy2 ?? a.y; const x2 = b.hx1 ?? b.x; const y2 = b.hy1 ?? b.y;
  const lerp = (p: number, q: number) => p + (q - p) * t;
  const ax = lerp(a.x, x1); const ay = lerp(a.y, y1);
  const mx = lerp(x1, x2); const my = lerp(y1, y2);
  const bx = lerp(x2, b.x); const by = lerp(y2, b.y);
  const lx = lerp(ax, mx); const ly = lerp(ay, my);
  const rx = lerp(mx, bx); const ry = lerp(my, by);
  const x = lerp(lx, rx); const y = lerp(ly, ry);
  if (a.hx2 === undefined && b.hx1 === undefined) return { a, mid: { x, y }, b };
  return { a: { ...a, hx2: ax, hy2: ay }, mid: { x, y, hx1: lx, hy1: ly, hx2: rx, hy2: ry }, b: { ...b, hx1: bx, hy1: by } };
}

/** Nearest place on a path: which segment and where along it. */
export function nearestOnPath(paths: SubPath[], p: { x: number; y: number }): { sub: number; seg: number; t: number; dist: number } | null {
  let best: { sub: number; seg: number; t: number; dist: number } | null = null;
  paths.forEach((sub, si) => {
    const n = sub.points.length;
    const segs = sub.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = sub.points[i]!;
      const b = sub.points[(i + 1) % n]!;
      const x1 = a.hx2 ?? a.x; const y1 = a.hy2 ?? a.y; const x2 = b.hx1 ?? b.x; const y2 = b.hy1 ?? b.y;
      for (let k = 0; k <= 24; k++) {
        const t = k / 24; const u = 1 - t;
        const x = u * u * u * a.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * b.x;
        const y = u * u * u * a.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * b.y;
        const dist = Math.hypot(x - p.x, y - p.y);
        if (!best || dist < best.dist) best = { sub: si, seg: i, t, dist };
      }
    }
  });
  return best;
}
