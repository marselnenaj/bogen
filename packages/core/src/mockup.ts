import type { NewNode } from './doc.ts';
import { MOCKUP_SCENES, type MockupScene } from './mockup-scenes.ts';

/**
 * Mockups: a design placed onto a photo or a drawn object, by four corners or by a mesh of top and bottom points for
 * bent surfaces such as a bag or a cap. The design stays a live instance of its artboard, so a change to the poster
 * shows on the billboard. Each strip of the design gets one projective transform (CSS matrix3d), which every
 * renderer and export draws the same; the shading of the surface is laid over it with multiply, from the scene's own
 * light, or from the photo itself, so the print picks up folds and shadows.
 */

export const MOCKUP_ATTR = 'data-bogen-mockup';
export const MOCKUP_BLENDS = ['normal', 'multiply', 'darken', 'screen', 'overlay'] as const;
export type MockupBlend = (typeof MOCKUP_BLENDS)[number];

export type Point = [number, number];
/** Top-left, top-right, bottom-right, bottom-left, in px of the scene. */
export type Quad = [Point, Point, Point, Point];
/** Points along the top and the bottom edge, left to right, as many on each: one strip between neighbours. */
export interface Mesh { top: Point[]; bottom: Point[] }

export interface MockupConfig {
  /** The main the design comes from (usually an artboard made a component for this). */
  source: string;
  /** The design's own size, in px. */
  sourceWidth: number;
  sourceHeight: number;
  /** A built-in scene, or `photo`. */
  scene: string;
  /** For `photo`: the image, a bogen-asset src or URL. */
  photo?: string;
  width: number;
  height: number;
  mesh: Mesh;
  blend: MockupBlend;
  /** How strongly the surface's light and shadow show on the print, 0 to 1. */
  shading: number;
  /**
   * When the design's shape differs from the surface: cover crops to the middle, contain shows all of it and fills the
   * bands with `ground` (so no line of type is ever cut), stretch distorts.
   */
  fit: 'cover' | 'contain' | 'stretch';
  /** For contain: the colour of the bands, normally the design's own background. */
  ground?: string;
}

/** The projective map of the rectangle 0..w x 0..h onto a quad, as CSS matrix3d. */
export function quadMatrix(w: number, h: number, q: Quad): string {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let a: number, b: number, d: number, e: number, g: number, hh: number;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = x1 - x0; b = x3 - x0; d = y1 - y0; e = y3 - y0; g = 0; hh = 0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-12) throw new Error('Those corners do not make a surface: three of them are on one line.');
    g = (dx3 * dy2 - dx2 * dy3) / den;
    hh = (dx1 * dy3 - dx3 * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + hh * x3; d = y1 - y0 + g * y1; e = y3 - y0 + hh * y3;
  }
  const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, hh / h, 0, 0, 1, 0, x0, y0, 0, 1];
  return `matrix3d(${m.map((v) => String(Number(v.toPrecision(10)))).join(', ')})`;
}

/** Where a point of the design lands: for tests and for checking that a quad is the right way round. */
export function mapPoint(w: number, h: number, q: Quad, x: number, y: number): Point {
  const m = /matrix3d\(([^)]+)\)/.exec(quadMatrix(w, h, q))![1]!.split(',').map(Number);
  const X = m[0]! * x + m[4]! * y + m[12]!;
  const Y = m[1]! * x + m[5]! * y + m[13]!;
  const W = m[3]! * x + m[7]! * y + m[15]!;
  return [X / W, Y / W];
}

export function quadMesh(q: Quad): Mesh {
  return { top: [q[0], q[1]], bottom: [q[3], q[2]] };
}

/** A mesh read leniently from stored or given data, or null when it is not one. */
export function readMesh(raw: unknown): Mesh | null {
  const pts = (v: unknown): Point[] | null => (Array.isArray(v) && v.length >= 2 && v.length <= 33 && v.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n))) ? (v as Point[]) : null);
  if (!raw || typeof raw !== 'object') return null;
  const top = pts((raw as Mesh).top);
  const bottom = pts((raw as Mesh).bottom);
  return top && bottom && top.length === bottom.length ? { top, bottom } : null;
}

export function readMockupConfig(raw: string | undefined): MockupConfig | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as MockupConfig;
    const mesh = readMesh(c.mesh);
    if (!mesh || typeof c.source !== 'string' || !(c.sourceWidth > 0) || !(c.sourceHeight > 0) || !(c.width > 0) || !(c.height > 0)) return null;
    return { ...c, mesh, blend: MOCKUP_BLENDS.includes(c.blend) ? c.blend : 'multiply', shading: Math.min(1, Math.max(0, Number(c.shading) || 0)), fit: c.fit === 'stretch' || c.fit === 'contain' ? c.fit : 'cover', ...(typeof c.ground === 'string' && /^(#[0-9a-f]{3,8}|var\(--[\w-]+\)|rgba?\([\d.,\s%]+\))$/i.test(c.ground.trim()) ? { ground: c.ground.trim() } : {}) };
  } catch {
    return null;
  }
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const pct = (n: number, of: number) => `${Math.round((n / of) * 10000) / 100}%`;

/** The surface's own aspect, from the mesh's edge lengths, to crop the design to. */
export function meshAspect(mesh: Mesh): number {
  const len = (pts: Point[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]), 0);
  const w = (len(mesh.top) + len(mesh.bottom)) / 2;
  const side = (i: number) => Math.hypot(mesh.top[i]![0] - mesh.bottom[i]![0], mesh.top[i]![1] - mesh.bottom[i]![1]);
  const h = (side(0) + side(mesh.top.length - 1)) / 2;
  return h > 0 ? w / h : 1;
}

/**
 * The layers inside a mockup frame: the scene, the design in strips, the shading over it and what lies in front.
 * The design's part is cropped to the surface's shape with cover, so a square artboard on a wide billboard shows its
 * middle band rather than squashed letters.
 */
export function mockupChildren(c: MockupConfig, scene: MockupScene | null): NewNode[] {
  const out: NewNode[] = [];
  const full = { position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%' };
  if (scene) out.push({ type: 'svg', tag: 'svg', name: 'Scene', svg: scene.svg, style: { ...full, pointerEvents: 'none' }, attrs: { 'aria-hidden': 'true' } });
  else if (c.photo) out.push({ type: 'image', tag: 'img', name: 'Photo', src: c.photo, style: { ...full, objectFit: 'cover', display: 'block' }, attrs: { alt: '' } });
  // The part of the design that goes on the surface.
  let sx = 0, sy = 0, sw = c.sourceWidth, sh = c.sourceHeight;
  if (c.fit === 'cover') {
    const want = meshAspect(c.mesh);
    const have = sw / sh;
    if (have > want) { sw = sh * want; sx = (c.sourceWidth - sw) / 2; } else { sh = sw / want; sy = (c.sourceHeight - sh) / 2; }
  } else if (c.fit === 'contain') {
    // A window larger than the design, centred on it: the whole design shows, the rest is its ground.
    const want = meshAspect(c.mesh);
    const have = sw / sh;
    if (have > want) { sh = sw / want; sy = (c.sourceHeight - sh) / 2; } else { sw = sh * want; sx = (c.sourceWidth - sw) / 2; }
  }
  const n = c.mesh.top.length - 1;
  const strips: NewNode[] = [];
  for (let i = 0; i < n; i++) {
    const x0 = (i / n) * sw;
    const x1 = ((i + 1) / n) * sw;
    const q: Quad = [c.mesh.top[i]!, c.mesh.top[i + 1]!, c.mesh.bottom[i + 1]!, c.mesh.bottom[i]!];
    // A hair wider than its share, so neighbouring strips overlap instead of showing a seam.
    const overlap = n > 1 && i < n - 1 ? 0.6 : 0;
    strips.push({
      type: 'frame', tag: 'div', name: n > 1 ? `Print ${i + 1}` : 'Print',
      style: { position: 'absolute', left: '0px', top: '0px', width: px(x1 - x0 + overlap), height: px(sh), overflow: 'hidden', transformOrigin: '0 0', transform: quadMatrix(x1 - x0, sh, q), backfaceVisibility: 'hidden', ...(c.fit === 'contain' && c.ground ? { backgroundColor: c.ground } : {}) },
      children: [{ type: 'frame', instanceOf: c.source, name: 'Design', style: { position: 'absolute', left: px(-(sx + x0)), top: px(-sy), width: px(c.sourceWidth), height: px(c.sourceHeight), margin: '0px', transform: 'none' } }],
    });
  }
  out.push({ type: 'frame', tag: 'div', name: 'Surface', style: { ...full, ...(c.blend !== 'normal' ? { mixBlendMode: c.blend } : {}), isolation: 'auto' }, children: strips });
  if (c.shading > 0) {
    const poly = [...c.mesh.top, ...[...c.mesh.bottom].reverse()].map(([x, y]) => `${pct(x, c.width)} ${pct(y, c.height)}`).join(', ');
    if (scene?.shade) out.push({ type: 'svg', tag: 'svg', name: 'Light on the surface', svg: scene.shade, style: { ...full, mixBlendMode: 'multiply', opacity: String(c.shading), pointerEvents: 'none', clipPath: `polygon(${poly})` }, attrs: { 'aria-hidden': 'true' } });
    else if (c.photo) out.push({ type: 'image', tag: 'img', name: 'Light from the photo', src: c.photo, style: { ...full, objectFit: 'cover', mixBlendMode: 'multiply', opacity: String(c.shading), filter: 'grayscale(1) contrast(1.6) brightness(1.25)', clipPath: `polygon(${poly})`, pointerEvents: 'none' }, attrs: { alt: '' } });
    if (scene?.sheen) out.push({ type: 'svg', tag: 'svg', name: 'Sheen', svg: scene.sheen, style: { ...full, mixBlendMode: 'screen', opacity: String(Math.min(1, c.shading * 0.9)), pointerEvents: 'none', clipPath: `polygon(${poly})` }, attrs: { 'aria-hidden': 'true' } });
  }
  if (scene?.front) out.push({ type: 'svg', tag: 'svg', name: 'In front', svg: scene.front, style: { ...full, pointerEvents: 'none' }, attrs: { 'aria-hidden': 'true' } });
  return out;
}

export function sceneById(id: string): MockupScene | null {
  return MOCKUP_SCENES.find((s) => s.id === id) ?? null;
}

export { MOCKUP_SCENES, type MockupScene };
