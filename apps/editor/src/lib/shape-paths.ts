import type { SubPath } from '../canvas/path.ts';

/** Shapes as editable bezier paths, in a layer's own pixels. Pure. */
const K = 0.5522847498;

export function ellipsePath(x: number, y: number, w: number, h: number): SubPath {
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  const kx = rx * K;
  const ky = ry * K;
  return {
    closed: true,
    points: [
      { x: cx, y: y, hx1: cx - kx, hy1: y, hx2: cx + kx, hy2: y },
      { x: x + w, y: cy, hx1: x + w, hy1: cy - ky, hx2: x + w, hy2: cy + ky },
      { x: cx, y: y + h, hx1: cx + kx, hy1: y + h, hx2: cx - kx, hy2: y + h },
      { x: x, y: cy, hx1: x, hy1: cy + ky, hx2: x, hy2: cy - ky },
    ],
  };
}

/** Radii in order top left, top right, bottom right, bottom left, as CSS would shrink them to fit. */
export function fitRadii(radii: [number, number, number, number], w: number, h: number): [number, number, number, number] {
  const [a, b, c, d] = radii;
  const f = Math.min(1, w / Math.max(a + b, 1e-6), w / Math.max(c + d, 1e-6), h / Math.max(a + d, 1e-6), h / Math.max(b + c, 1e-6));
  return [a * f, b * f, c * f, d * f];
}

export function roundedRectPath(x: number, y: number, w: number, h: number, radii: [number, number, number, number] = [0, 0, 0, 0]): SubPath {
  const [a, b, c, d] = fitRadii(radii, w, h);
  if (a === 0 && b === 0 && c === 0 && d === 0) return { closed: true, points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] };
  const r = x + w;
  const bt = y + h;
  const pts: SubPath['points'] = [];
  const corner = (px: number, py: number, nx: number, ny: number, ox: number, oy: number) => {
    // From (px,py) around to (nx,ny), with control points pulled toward the corner (ox,oy).
    if (px === nx && py === ny) { pts.push({ x: px, y: py }); return; }
    pts.push({ x: px, y: py, hx2: px + (ox - px) * K, hy2: py + (oy - py) * K });
    pts.push({ x: nx, y: ny, hx1: nx + (ox - nx) * K, hy1: ny + (oy - ny) * K });
  };
  corner(x, y + a, x + a, y, x, y);
  corner(r - b, y, r, y + b, r, y);
  corner(r, bt - c, r - c, bt, r, bt);
  corner(x + d, bt, x, bt - d, x, bt);
  return { closed: true, points: pts };
}

export type Matrix = [number, number, number, number, number, number];
export const IDENTITY_M: Matrix = [1, 0, 0, 1, 0, 0];

export function multiplyM(m: Matrix, n: Matrix): Matrix {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

export function parseTransformAttr(text: string | null | undefined): Matrix {
  let out: Matrix = IDENTITY_M;
  for (const match of (text ?? '').matchAll(/([a-zA-Z]+)\(([^)]*)\)/g)) {
    const a = match[2]!.trim().split(/[\s,]+/).filter(Boolean).map(parseFloat);
    let m: Matrix = IDENTITY_M;
    switch (match[1]) {
      case 'translate': m = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]; break;
      case 'scale': m = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const r = ((a[0] ?? 0) * Math.PI) / 180;
        const rot: Matrix = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
        m = a.length >= 3 ? multiplyM(multiplyM([1, 0, 0, 1, a[1]!, a[2]!], rot), [1, 0, 0, 1, -a[1]!, -a[2]!]) : rot;
        break;
      }
      case 'skewX': m = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': m = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
      case 'matrix': if (a.length === 6) m = a as Matrix; break;
      default: break;
    }
    out = multiplyM(out, m);
  }
  return out;
}

export function transformPaths(paths: SubPath[], m: Matrix): SubPath[] {
  const px = (x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
  return paths.map((s) => ({
    closed: s.closed,
    points: s.points.map((p) => {
      const a = px(p.x, p.y);
      const h1 = p.hx1 !== undefined ? px(p.hx1, p.hy1!) : null;
      const h2 = p.hx2 !== undefined ? px(p.hx2, p.hy2!) : null;
      return { x: a.x, y: a.y, ...(h1 ? { hx1: h1.x, hy1: h1.y } : {}), ...(h2 ? { hx2: h2.x, hy2: h2.y } : {}) };
    }),
  }));
}
