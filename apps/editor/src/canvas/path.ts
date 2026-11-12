/** Bezier paths for the pen and pencil. Pure, no DOM. */

export interface PathPoint { x: number; y: number; /** Control point before. */ hx1?: number; hy1?: number; /** Control point after. */ hx2?: number; hy2?: number }
export interface SubPath { points: PathPoint[]; closed: boolean }

const round = (n: number) => Math.round(n * 100) / 100;

export function pathToD(paths: SubPath[]): string {
  const out: string[] = [];
  for (const sub of paths) {
    const pts = sub.points;
    if (!pts.length) continue;
    out.push(`M${round(pts[0]!.x)} ${round(pts[0]!.y)}`);
    const seg = (a: PathPoint, b: PathPoint) => {
      if (a.hx2 === undefined && b.hx1 === undefined) out.push(`L${round(b.x)} ${round(b.y)}`);
      else out.push(`C${round(a.hx2 ?? a.x)} ${round(a.hy2 ?? a.y)} ${round(b.hx1 ?? b.x)} ${round(b.hy1 ?? b.y)} ${round(b.x)} ${round(b.y)}`);
    };
    for (let i = 1; i < pts.length; i++) seg(pts[i - 1]!, pts[i]!);
    if (sub.closed && pts.length > 1) {
      seg(pts.at(-1)!, pts[0]!);
      out.push('Z');
    }
  }
  return out.join('');
}

const ARG_COUNT: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Parses SVG path data into editable subpaths; quadratics become cubics, arcs become cubics too. */
export function parseD(d: string): SubPath[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: SubPath[] = [];
  let i = 0;
  let cmd = '';
  let cur: SubPath | null = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lastC: { x: number; y: number } | null = null;
  let lastQ: { x: number; y: number } | null = null;
  const num = () => parseFloat(tokens[i++] ?? '0');
  const add = (p: PathPoint) => cur!.points.push(p);
  const prevPoint = () => cur!.points.at(-1)!;
  const cubic = (x1: number, y1: number, x2: number, y2: number, nx: number, ny: number) => {
    const prev = prevPoint();
    prev.hx2 = x1;
    prev.hy2 = y1;
    add({ x: nx, y: ny, hx1: x2, hy1: y2 });
    x = nx;
    y = ny;
  };
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i]!)) cmd = tokens[i++]!;
    const upper = cmd.toUpperCase();
    if (!(upper in ARG_COUNT)) { i++; continue; }
    const rel = cmd !== upper;
    if (upper === 'Z') {
      if (cur) {
        cur.closed = true;
        const first = cur.points[0]!;
        const last = cur.points.at(-1)!;
        if (cur.points.length > 1 && Math.abs(first.x - last.x) < 0.01 && Math.abs(first.y - last.y) < 0.01) {
          if (last.hx1 !== undefined) { first.hx1 = last.hx1; first.hy1 = last.hy1; }
          cur.points.pop();
        }
        x = sx;
        y = sy;
        cur = null;
      }
      lastC = null;
      lastQ = null;
      continue;
    }
    if (upper === 'M') {
      const nx = num() + (rel ? x : 0);
      const ny = num() + (rel ? y : 0);
      cur = { points: [{ x: nx, y: ny }], closed: false };
      out.push(cur);
      x = sx = nx;
      y = sy = ny;
      cmd = rel ? 'l' : 'L';
      lastC = lastQ = null;
      continue;
    }
    if (!cur) {
      cur = { points: [{ x, y }], closed: false };
      out.push(cur);
    }
    switch (upper) {
      case 'L': { const nx = num() + (rel ? x : 0); const ny = num() + (rel ? y : 0); add({ x: nx, y: ny }); x = nx; y = ny; lastC = lastQ = null; break; }
      case 'H': { const nx = num() + (rel ? x : 0); add({ x: nx, y }); x = nx; lastC = lastQ = null; break; }
      case 'V': { const ny = num() + (rel ? y : 0); add({ x, y: ny }); y = ny; lastC = lastQ = null; break; }
      case 'C': {
        const b = rel ? { x, y } : { x: 0, y: 0 };
        const x1 = num() + b.x; const y1 = num() + b.y; const x2 = num() + b.x; const y2 = num() + b.y; const nx = num() + b.x; const ny = num() + b.y;
        cubic(x1, y1, x2, y2, nx, ny);
        lastC = { x: x2, y: y2 };
        lastQ = null;
        break;
      }
      case 'S': {
        const b = rel ? { x, y } : { x: 0, y: 0 };
        const x1 = lastC ? 2 * x - lastC.x : x; const y1 = lastC ? 2 * y - lastC.y : y;
        const x2 = num() + b.x; const y2 = num() + b.y; const nx = num() + b.x; const ny = num() + b.y;
        cubic(x1, y1, x2, y2, nx, ny);
        lastC = { x: x2, y: y2 };
        lastQ = null;
        break;
      }
      case 'Q': case 'T': {
        const b = rel ? { x, y } : { x: 0, y: 0 };
        let qx: number; let qy: number;
        if (upper === 'Q') { qx = num() + b.x; qy = num() + b.y; }
        else { qx = lastQ ? 2 * x - lastQ.x : x; qy = lastQ ? 2 * y - lastQ.y : y; }
        const nx = num() + b.x; const ny = num() + b.y;
        cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny);
        lastQ = { x: qx, y: qy };
        lastC = null;
        break;
      }
      case 'A': {
        const rx = num(); const ry = num(); const rot = num(); const large = num(); const sweep = num();
        const nx = num() + (rel ? x : 0); const ny = num() + (rel ? y : 0);
        for (const c of arcToCubics(x, y, rx, ry, rot, Boolean(large), Boolean(sweep), nx, ny)) cubic(c[0], c[1], c[2], c[3], c[4], c[5]);
        x = nx; y = ny;
        lastC = lastQ = null;
        break;
      }
    }
  }
  return out;
}

/** Standard endpoint to centre conversion, split in quarter-turn segments. */
export function arcToCubics(x0: number, y0: number, rxIn: number, ryIn: number, rotDeg: number, large: boolean, sweep: boolean, x1: number, y1: number): [number, number, number, number, number, number][] {
  if (rxIn === 0 || ryIn === 0) return [[x0, y0, x1, y1, x1, y1]];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x0 - x1) / 2;
  const dy = (y0 - y1) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const co = sign * Math.sqrt(Math.max(0, num / (den || 1)));
  const cxp = (co * rx * yp) / ry;
  const cyp = (-co * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x1) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y1) / 2;
  const th1 = Math.atan2((yp - cyp) / ry, (xp - cxp) / rx);
  let dth = Math.atan2((-yp - cyp) / ry, (-xp - cxp) / rx) - th1;
  if (sweep && dth < 0) dth += Math.PI * 2;
  if (!sweep && dth > 0) dth -= Math.PI * 2;
  const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
  const seg = dth / n;
  const t = (4 / 3) * Math.tan(seg / 4);
  const out: [number, number, number, number, number, number][] = [];
  let a = th1;
  const map = (ux: number, uy: number) => ({ x: cos * rx * ux - sin * ry * uy + cx, y: sin * rx * ux + cos * ry * uy + cy });
  for (let i = 0; i < n; i++) {
    const b = a + seg;
    const p1 = map(Math.cos(a) - t * Math.sin(a), Math.sin(a) + t * Math.cos(a));
    const p2 = map(Math.cos(b) + t * Math.sin(b), Math.sin(b) - t * Math.cos(b));
    const p3 = map(Math.cos(b), Math.sin(b));
    out.push([p1.x, p1.y, p2.x, p2.y, p3.x, p3.y]);
    a = b;
  }
  return out;
}

export function boundsOf(paths: SubPath[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  const visit = (x: number | undefined, y: number | undefined) => {
    if (x === undefined || y === undefined) return;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  for (const sub of paths) {
    const pts = sub.points;
    pts.forEach((p, i) => {
      visit(p.x, p.y);
      const next = pts[i + 1] ?? (sub.closed ? pts[0] : undefined);
      if (next && (p.hx2 !== undefined || next.hx1 !== undefined)) {
        // Sample the curve; control points alone would overestimate the box.
        const cx1 = p.hx2 ?? p.x; const cy1 = p.hy2 ?? p.y; const cx2 = next.hx1 ?? next.x; const cy2 = next.hy1 ?? next.y;
        for (let k = 1; k < 16; k++) {
          const t = k / 16; const u = 1 - t;
          visit(u * u * u * p.x + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * next.x, u * u * u * p.y + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t * t * t * next.y);
        }
      }
    });
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function translatePaths(paths: SubPath[], dx: number, dy: number): SubPath[] {
  return paths.map((s) => ({
    closed: s.closed,
    points: s.points.map((p) => ({
      x: p.x + dx, y: p.y + dy,
      ...(p.hx1 !== undefined ? { hx1: p.hx1 + dx, hy1: p.hy1! + dy } : {}),
      ...(p.hx2 !== undefined ? { hx2: p.hx2 + dx, hy2: p.hy2! + dy } : {}),
    })),
  }));
}

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
