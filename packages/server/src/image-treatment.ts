import type { Rgba } from './image-raster.ts';

/**
 * Image treatments: a photograph turned into a brand's own colours, on this computer and deterministically, so that
 * one preset gives every photo of a brand the same look. Pure functions over RGBA pixels: the tool reads the image
 * (vectorize.ts assetPixels) and stores the result as an SVG layer or a PNG asset.
 *
 * - halftone: a rotated grid of dots, squares, rounded cells or lines whose size follows the tone.
 * - mosaic: an upright grid of square pixels, each in the ink of its tone or region, thinning out toward a side.
 * - dither: ordered (Bayer) or error-diffusion dither to the inks, at a chosen pixel size.
 * - duotone: the tone mapped onto a ramp through the inks (two for duotone, three for tritone).
 * - posterize: every pixel in the ink of its tone band or of its colour region.
 *
 * Inks are ordered from dark to light by their lightness, and tone 0 is the darkest part of the photo. With
 * inkBy region the photo is first split into as many colour regions as there are inks (k-means in OKLab), and each
 * region takes the ink nearest in lightness order, so a hand, a pod and a background each get their own colour.
 */

export const TREATMENT_MODES = ['halftone', 'mosaic', 'dither', 'duotone', 'posterize'] as const;
export type TreatmentMode = (typeof TREATMENT_MODES)[number];
export const TREATMENT_SHAPES = ['dot', 'square', 'cell', 'line'] as const;
export type TreatmentShape = (typeof TREATMENT_SHAPES)[number];
export const DITHER_KINDS = ['bayer4', 'bayer8', 'floyd-steinberg', 'atkinson'] as const;
export type DitherKind = (typeof DITHER_KINDS)[number];
export const DROP_KINDS = ['none', 'light', 'dark', 'border', 'color'] as const;
export type DropKind = (typeof DROP_KINDS)[number];
export const FALLOFF_FROM = ['none', 'top', 'bottom', 'left', 'right', 'center', 'edges'] as const;
export type FalloffFrom = (typeof FALLOFF_FROM)[number];
export const INK_BY = ['tone', 'region'] as const;
export type InkBy = (typeof INK_BY)[number];

export interface TreatmentParams {
  mode: TreatmentMode;
  /** halftone and mosaic: the cell size, dither: the size of one dither pixel, in output pixels. */
  grid: number;
  shape: TreatmentShape;
  /** halftone: the grid's angle in degrees. */
  angle: number;
  dither: DitherKind;
  inkBy: InkBy;
  /** -100 to 100: spreads (or flattens) the tones around the middle. */
  contrast: number;
  /** -100 to 100: lifts (or darkens) every tone. */
  brightness: number;
  invert: boolean;
  /** Stretches the photo's own darkest and lightest 2 % to the full range first, so a pale photo still carries. */
  levels: boolean;
  /** halftone and mosaic: the largest shape as a share of the cell (1 fills it), and below what share a shape is left out. */
  maxSize: number;
  minSize: number;
  /** mosaic: the gap between pixels as a share of the cell. */
  gap: number;
  /** mosaic: 0 keeps every cell, 1 keeps a cell only as often as it is dark, which dissolves the light parts. */
  sparse: number;
  /** What part of the photo is left out: none, light or dark tones past threshold, the colour around the border, or one colour. */
  drop: DropKind;
  threshold: number;
  dropColor: string;
  /** For border and color: how near a colour must be to be left out, 0 to 1. */
  tolerance: number;
  /** Cells thin out toward one side, the centre or the edges, by amount (0 to 1). */
  falloff: FalloffFrom;
  falloffAmount: number;
  seed: number;
}

export const TREATMENT_DEFAULTS: TreatmentParams = {
  mode: 'halftone', grid: 12, shape: 'dot', angle: 45, dither: 'bayer4', inkBy: 'tone', contrast: 0, brightness: 0, invert: false, levels: true,
  maxSize: 1, minSize: 0.04, gap: 0.12, sparse: 0, drop: 'none', threshold: 0.85, dropColor: '', tolerance: 0.12, falloff: 'none', falloffAmount: 0.6, seed: 1,
};

export interface Ink {
  /** #rrggbb */
  color: string;
  /** A token the SVG refers to, so a change of the brand colour follows: written as var(--token, #rrggbb). */
  token?: string;
}

export interface TreatmentInput {
  image: Rgba;
  params: TreatmentParams;
  /** One or more inks. Order does not matter: they are sorted from dark to light. */
  inks: Ink[];
  /** Painted under everything, or left transparent when absent. */
  ground?: Ink;
  /** The width of the result in pixels; the height follows the photo's shape. */
  width: number;
}

export interface SvgResult { kind: 'svg'; svg: string; width: number; height: number; shapes: number; bytes: number }
export interface RasterResult { kind: 'raster'; rgba: Uint8ClampedArray; width: number; height: number }

/** Limits that keep a result a layer a page can carry. */
export const MAX_SHAPES = 60_000;
export const MAX_OUTPUT_SIDE = 4096;
export const MAX_TREATMENT_SVG_BYTES = 4 * 1024 * 1024;

/** Which modes can give an SVG: those made of shapes. The others give pixels. */
export function svgCapable(mode: TreatmentMode): boolean {
  return mode === 'halftone' || mode === 'mosaic' || mode === 'dither';
}

// ---------------------------------------------------------------- colour

const srgbToLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const LIN = Array.from({ length: 256 }, (_, i) => srgbToLinear(i));
const linearToSrgb = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/** OKLab of an sRGB colour (Björn Ottosson's matrices). */
export function oklab(r: number, g: number, b: number): [number, number, number] {
  const lr = LIN[r]!, lg = LIN[g]!, lb = LIN[b]!;
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromOklab(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim()) ?? /^#([0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** The inks from dark to light, by OKLab lightness. */
export function sortInks(inks: Ink[]): Ink[] {
  const light = (ink: Ink) => {
    const rgb = parseHex(ink.color);
    return rgb ? oklab(...rgb)[0] : 0;
  };
  return [...inks].sort((a, b) => light(a) - light(b));
}

// ---------------------------------------------------------------- randomness

/** A small seeded generator (mulberry32): the same seed gives the same cells every time. */
export function rng(seed: number): () => number {
  let a = (Math.floor(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- analysis of the photo

interface Analysis {
  width: number;
  height: number;
  /** Tone per pixel, 0 dark to 1 light, after contrast, brightness and invert. */
  tone: Float32Array;
  /** 1 where the pixel is left out. */
  dropped: Uint8Array;
  /** Region per pixel (inkBy region), or empty. */
  region: Uint8Array;
  regions: number;
}

function analyse(img: Rgba, p: TreatmentParams, inkCount: number): Analysis {
  const n = img.width * img.height;
  const tone = new Float32Array(n);
  const dropped = new Uint8Array(n);
  const labs = new Float32Array(n * 3);
  const k = 1 + p.contrast / 100;
  const lift = p.brightness / 200;
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 4]!, g = img.data[i * 4 + 1]!, b = img.data[i * 4 + 2]!;
    const lab = oklab(r, g, b);
    labs[i * 3] = lab[0];
    labs[i * 3 + 1] = lab[1];
    labs[i * 3 + 2] = lab[2];
    tone[i] = lab[0];
    if (img.data[i * 4 + 3]! < 128) dropped[i] = 1;
  }
  let lo = 0, hi = 1;
  if (p.levels) [lo, hi] = percentiles(tone, dropped, 0.02, 0.98);
  const span = Math.max(0.05, hi - lo);
  for (let i = 0; i < n; i++) {
    let t = ((tone[i]! - lo) / span - 0.5) * k + 0.5 + lift;
    if (p.invert) t = 1 - t;
    tone[i] = Math.max(0, Math.min(1, t));
  }
  const distance = (i: number, c: [number, number, number]) => Math.hypot(labs[i * 3]! - c[0], labs[i * 3 + 1]! - c[1], labs[i * 3 + 2]! - c[2]);
  if (p.drop === 'light' || p.drop === 'dark') {
    for (let i = 0; i < n; i++) if (p.drop === 'light' ? tone[i]! > p.threshold : tone[i]! < p.threshold) dropped[i] = 1;
  } else if (p.drop === 'border' || p.drop === 'color') {
    let target: [number, number, number] | null = null;
    if (p.drop === 'color') {
      const rgb = parseHex(p.dropColor);
      if (!rgb) throw new Error('drop color needs dropColor, a colour such as #f2efe6.');
      target = oklab(...rgb);
    } else target = borderColour(img, labs);
    // OKLab distances run to about 0.5 between very different colours, so tolerance 1 covers everything.
    const limit = p.tolerance * 0.5;
    for (let i = 0; i < n; i++) if (distance(i, target) < limit) dropped[i] = 1;
  }
  let region: Uint8Array = new Uint8Array(0);
  let regions = 0;
  if (p.inkBy === 'region' && inkCount > 1) {
    ({ region, regions } = kmeans(labs, dropped, n, inkCount, p.seed));
  }
  return { width: img.width, height: img.height, tone, dropped, region, regions };
}

/** The tones at two shares of the kept pixels, from a 256-bin histogram. */
function percentiles(tone: Float32Array, dropped: Uint8Array, a: number, b: number): [number, number] {
  const bins = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < tone.length; i++) {
    if (dropped[i]) continue;
    const bin = Math.max(0, Math.min(255, Math.round(tone[i]! * 255)));
    bins[bin] = bins[bin]! + 1;
    count++;
  }
  if (!count) return [0, 1];
  const at = (share: number) => {
    let seen = 0;
    for (let v = 0; v < 256; v++) { seen += bins[v]!; if (seen >= share * count) return v / 255; }
    return 1;
  };
  return [at(a), at(b)];
}

/** The median OKLab colour of the outermost ring of pixels: what is around the subject. */
function borderColour(img: Rgba, labs: Float32Array): [number, number, number] {
  const ls: number[] = [], as: number[] = [], bs: number[] = [];
  const ring = Math.max(1, Math.round(Math.min(img.width, img.height) * 0.02));
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (x >= ring && y >= ring && x < img.width - ring && y < img.height - ring) continue;
      const i = y * img.width + x;
      ls.push(labs[i * 3]!); as.push(labs[i * 3 + 1]!); bs.push(labs[i * 3 + 2]!);
    }
  }
  const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
  return [median(ls), median(as), median(bs)];
}

/**
 * Colour regions by k-means in OKLab over a sample of the kept pixels, seeded, then every pixel to its nearest
 * centre. Regions are numbered from dark to light, so region i takes ink i.
 */
const CHROMA_WEIGHT = 2.5;

function kmeans(labs: Float32Array, dropped: Uint8Array, n: number, k: number, seed: number): { region: Uint8Array; regions: number } {
  const random = rng(seed);
  const kept: number[] = [];
  for (let i = 0; i < n; i++) if (!dropped[i]) kept.push(i);
  const region = new Uint8Array(n);
  if (!kept.length) return { region, regions: 0 };
  const step = Math.max(1, Math.floor(kept.length / 20000));
  const sample = kept.filter((_, j) => j % step === 0);
  // Hue and colourfulness count more than lightness, so that a green pod and a pale hand of about the same lightness
  // become two regions, while light and shade on one surface stay one.
  const at = (i: number): [number, number, number] => [labs[i * 3]!, labs[i * 3 + 1]! * CHROMA_WEIGHT, labs[i * 3 + 2]! * CHROMA_WEIGHT];
  const d2 = (a: [number, number, number], b: [number, number, number]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  // k-means++ start: each next centre far from those chosen.
  const centres: [number, number, number][] = [at(sample[Math.floor(random() * sample.length)]!)];
  while (centres.length < k) {
    const weights = sample.map((i) => Math.min(...centres.map((c) => d2(at(i), c))));
    const total = weights.reduce((s, w) => s + w, 0);
    if (total <= 0) break;
    let pick = random() * total;
    let chosen = sample[0]!;
    for (let j = 0; j < sample.length; j++) {
      pick -= weights[j]!;
      if (pick <= 0) { chosen = sample[j]!; break; }
    }
    centres.push(at(chosen));
  }
  for (let iter = 0; iter < 12; iter++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (const i of sample) {
      const c = at(i);
      let best = 0, bestD = Infinity;
      centres.forEach((centre, j) => { const d = d2(c, centre); if (d < bestD) { bestD = d; best = j; } });
      const s = sums[best]!;
      s[0] = s[0]! + c[0]; s[1] = s[1]! + c[1]; s[2] = s[2]! + c[2]; s[3] = s[3]! + 1;
    }
    centres.forEach((centre, j) => { const s = sums[j]!; if (s[3]) { centre[0] = s[0]! / s[3]!; centre[1] = s[1]! / s[3]!; centre[2] = s[2]! / s[3]!; } });
  }
  const order = centres.map((c, j) => ({ j, l: c[0] })).sort((a, b) => a.l - b.l).map((o) => o.j);
  const rank = new Map(order.map((j, r) => [j, r]));
  for (const i of kept) {
    const c = at(i);
    let best = 0, bestD = Infinity;
    centres.forEach((centre, j) => { const d = d2(c, centre); if (d < bestD) { bestD = d; best = j; } });
    region[i] = rank.get(best)!;
  }
  return { region, regions: centres.length };
}

// ---------------------------------------------------------------- sampling

/** Box averages over any rectangle in O(1): summed-area tables of tone and of dropped pixels. */
class Sampler {
  private readonly toneSum: Float64Array;
  private readonly dropSum: Float64Array;
  constructor(private readonly a: Analysis) {
    const w = a.width + 1;
    this.toneSum = new Float64Array(w * (a.height + 1));
    this.dropSum = new Float64Array(w * (a.height + 1));
    for (let y = 0; y < a.height; y++) {
      let rowT = 0, rowD = 0;
      for (let x = 0; x < a.width; x++) {
        const i = y * a.width + x;
        rowT += a.tone[i]!;
        rowD += a.dropped[i]!;
        this.toneSum[(y + 1) * w + x + 1] = this.toneSum[y * w + x + 1]! + rowT;
        this.dropSum[(y + 1) * w + x + 1] = this.dropSum[y * w + x + 1]! + rowD;
      }
    }
  }
  /** Mean tone and share of dropped pixels in a box given in source pixels, clipped to the photo. */
  box(x0: number, y0: number, x1: number, y1: number): { tone: number; dropped: number } {
    const a = this.a;
    const ax = Math.max(0, Math.min(a.width, Math.floor(x0))), bx = Math.max(ax + 1, Math.min(a.width, Math.ceil(x1)));
    const ay = Math.max(0, Math.min(a.height, Math.floor(y0))), by = Math.max(ay + 1, Math.min(a.height, Math.ceil(y1)));
    if (ax >= a.width || ay >= a.height) return { tone: 1, dropped: 1 };
    const w = a.width + 1;
    const sum = (t: Float64Array) => t[by * w + bx]! - t[ay * w + bx]! - t[by * w + ax]! + t[ay * w + ax]!;
    const area = (bx - ax) * (by - ay);
    return { tone: sum(this.toneSum) / area, dropped: sum(this.dropSum) / area };
  }
  regionAt(x: number, y: number): number {
    const a = this.a;
    if (!a.regions) return -1;
    const xi = Math.max(0, Math.min(a.width - 1, Math.floor(x))), yi = Math.max(0, Math.min(a.height - 1, Math.floor(y)));
    return a.region[yi * a.width + xi]!;
  }
}

/** How much of the cells to keep at a point (u, v in 0..1 across the result), for falloff. */
function density(p: TreatmentParams, u: number, v: number): number {
  const amount = Math.max(0, Math.min(1, p.falloffAmount));
  let d: number;
  switch (p.falloff) {
    case 'none': return 1;
    case 'top': d = 1 - v; break;
    case 'bottom': d = v; break;
    case 'left': d = 1 - u; break;
    case 'right': d = u; break;
    case 'center': d = 1 - Math.min(1, Math.hypot(u - 0.5, v - 0.5) / 0.7071); break;
    case 'edges': d = Math.min(1, Math.hypot(u - 0.5, v - 0.5) / 0.7071); break;
  }
  // d is 1 far from where it thins out and 0 where it is thinnest.
  return 1 - amount * (1 - d);
}

/** The ink of a cell: by its tone band, or by its region. Index into inks sorted dark to light. */
function inkIndex(tone: number, region: number, inks: number): number {
  if (region >= 0) return Math.min(inks - 1, region);
  return Math.min(inks - 1, Math.floor(tone * inks));
}

// ---------------------------------------------------------------- shapes

type Shape = { ink: number; kind: 'circle'; cx: number; cy: number; r: number } | { ink: number; kind: 'rect'; cx: number; cy: number; w: number; h: number; rx: number; rot: number };

function halftoneShapes(a: Analysis, p: TreatmentParams, inks: number, W: number, H: number, onDark: boolean): Shape[] {
  const sampler = new Sampler(a);
  const scale = a.width / W; // source pixels per output pixel
  const g = Math.max(2, p.grid);
  const rad = (p.angle * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const random = rng(p.seed);
  const reach = Math.ceil(Math.hypot(W, H) / g) + 1;
  const cx0 = W / 2, cy0 = H / 2;
  const shapes: Shape[] = [];
  for (let j = -reach; j <= reach; j++) {
    for (let i = -reach; i <= reach; i++) {
      const gx = i * g, gy = j * g;
      const x = cx0 + gx * cos - gy * sin;
      const y = cy0 + gx * sin + gy * cos;
      if (x < -g / 2 || y < -g / 2 || x > W + g / 2 || y > H + g / 2) continue;
      const half = (g / 2) * scale;
      const s = sampler.box(x * scale - half, y * scale - half, x * scale + half, y * scale + half);
      if (s.dropped > 0.5) continue;
      if (density(p, x / W, y / H) < random()) continue;
      // Shapes carry what stands out from the ground: the dark parts on a light ground, the light parts on a dark one.
      const cover = onDark ? s.tone : 1 - s.tone;
      const size = p.maxSize * Math.sqrt(cover);
      if (size < p.minSize) continue;
      const ink = inkIndex(s.tone, sampler.regionAt(x * scale, y * scale), inks);
      if (p.shape === 'dot') shapes.push({ ink, kind: 'circle', cx: x, cy: y, r: (g / 2) * size * Math.SQRT2 * 0.8 });
      else if (p.shape === 'line') shapes.push({ ink, kind: 'rect', cx: x, cy: y, w: g, h: g * p.maxSize * cover, rx: 0, rot: p.angle });
      else {
        const side = g * size;
        shapes.push({ ink, kind: 'rect', cx: x, cy: y, w: side, h: side, rx: p.shape === 'cell' ? side * 0.28 : 0, rot: p.angle });
      }
      if (shapes.length > MAX_SHAPES) throw tooMany(shapes.length);
    }
  }
  return shapes;
}

function mosaicShapes(a: Analysis, p: TreatmentParams, inks: number, W: number, H: number, onDark: boolean): Shape[] {
  const sampler = new Sampler(a);
  const scale = a.width / W;
  const g = Math.max(2, p.grid);
  const random = rng(p.seed);
  const cols = Math.ceil(W / g), rows = Math.ceil(H / g);
  if (cols * rows > MAX_SHAPES) throw tooMany(cols * rows);
  const side = g * Math.max(0.05, Math.min(1, p.maxSize) * (1 - Math.max(0, Math.min(0.9, p.gap))));
  const shapes: Shape[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * g + g / 2, y = r * g + g / 2;
      const s = sampler.box(c * g * scale, r * g * scale, (c + 1) * g * scale, (r + 1) * g * scale);
      if (s.dropped > 0.5) continue;
      const cover = onDark ? s.tone : 1 - s.tone;
      const keep = density(p, x / W, y / H) * (1 - p.sparse * (1 - cover));
      if (keep < random()) continue;
      if (cover < p.minSize && p.sparse > 0) continue;
      const ink = inkIndex(s.tone, sampler.regionAt(x * scale, y * scale), inks);
      shapes.push({ ink, kind: 'rect', cx: x, cy: y, w: side, h: side, rx: 0, rot: 0 });
    }
  }
  return shapes;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const BAYER8 = (() => {
  const out: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const q = BAYER4[(y % 4) * 4 + (x % 4)]! * 16 - 0.5;
      const o = [0, 2, 3, 1][((y >> 2) & 1) * 2 + ((x >> 2) & 1)]!;
      out.push((q * 4 + o + 0.5) / 64);
    }
  }
  return out;
})();

/** One ink index per dither pixel (cols x rows), or -1 where the photo is left out. */
function ditherGrid(a: Analysis, p: TreatmentParams, inks: number, W: number, H: number): { cols: number; rows: number; cells: Int16Array } {
  const sampler = new Sampler(a);
  const scale = a.width / W;
  const g = Math.max(1, p.grid);
  const cols = Math.ceil(W / g), rows = Math.ceil(H / g);
  const levels = Math.max(1, inks - 1);
  const tone = new Float32Array(cols * rows);
  const cells = new Int16Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s = sampler.box(c * g * scale, r * g * scale, (c + 1) * g * scale, (r + 1) * g * scale);
      tone[r * cols + c] = s.tone;
      cells[r * cols + c] = s.dropped > 0.5 ? -1 : 0;
    }
  }
  const quant = (t: number) => Math.max(0, Math.min(levels, Math.round(t * levels)));
  if (p.dither === 'bayer4' || p.dither === 'bayer8') {
    const m = p.dither === 'bayer4' ? BAYER4 : BAYER8;
    const size = p.dither === 'bayer4' ? 4 : 8;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (cells[i] === -1) continue;
        const v = tone[i]! * levels;
        const base = Math.floor(v);
        cells[i] = Math.min(levels, base + (v - base > m[(r % size) * size + (c % size)]! ? 1 : 0));
      }
    }
  } else {
    const spread: [number, number, number][] = p.dither === 'atkinson'
      ? [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]]
      : [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (cells[i] === -1) continue;
        const q = quant(tone[i]!);
        cells[i] = q;
        const err = tone[i]! - q / levels;
        for (const [dx, dy, w] of spread) {
          const x = c + dx, y = r + dy;
          if (x < 0 || x >= cols || y >= rows) continue;
          tone[y * cols + x] = tone[y * cols + x]! + err * w;
        }
      }
    }
  }
  return { cols, rows, cells };
}

function tooMany(n: number): Error {
  return new Error(`That makes about ${n} shapes, more than ${MAX_SHAPES}: use a larger grid or a smaller width.`);
}

// ---------------------------------------------------------------- output

const r2 = (v: number) => Math.round(v * 100) / 100;

function fill(ink: Ink): string {
  return ink.token ? `var(--${ink.token}, ${ink.color})` : ink.color;
}

/** One path per ink: compact, and each ink stays one fill to change. */
function shapesSvg(shapes: Shape[], inks: Ink[], ground: Ink | undefined, W: number, H: number): string {
  const paths: string[][] = inks.map(() => []);
  for (const s of shapes) {
    const d = paths[s.ink]!;
    if (s.kind === 'circle') {
      const r = r2(s.r);
      d.push(`M${r2(s.cx - s.r)} ${r2(s.cy)}a${r} ${r} 0 1 0 ${r2(2 * s.r)} 0a${r} ${r} 0 1 0 ${r2(-2 * s.r)} 0z`);
    } else {
      const corners = rectCorners(s);
      if (s.rx > 0 && s.rot % 90 === 0) {
        const x = s.cx - s.w / 2, y = s.cy - s.h / 2, rx = Math.min(s.rx, s.w / 2, s.h / 2);
        d.push(`M${r2(x + rx)} ${r2(y)}h${r2(s.w - 2 * rx)}a${r2(rx)} ${r2(rx)} 0 0 1 ${r2(rx)} ${r2(rx)}v${r2(s.h - 2 * rx)}a${r2(rx)} ${r2(rx)} 0 0 1 ${r2(-rx)} ${r2(rx)}h${r2(-(s.w - 2 * rx))}a${r2(rx)} ${r2(rx)} 0 0 1 ${r2(-rx)} ${r2(-rx)}v${r2(-(s.h - 2 * rx))}a${r2(rx)} ${r2(rx)} 0 0 1 ${r2(rx)} ${r2(-rx)}z`);
      } else d.push(`M${corners.map(([x, y]) => `${r2(x)} ${r2(y)}`).join('L')}z`);
    }
  }
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="100%">`];
  if (ground) parts.push(`<rect width="${W}" height="${H}" fill="${fill(ground)}"/>`);
  paths.forEach((d, i) => { if (d.length) parts.push(`<path fill="${fill(inks[i]!)}" d="${d.join('')}"/>`); });
  parts.push('</svg>');
  return parts.join('');
}

function rectCorners(s: Extract<Shape, { kind: 'rect' }>): [number, number][] {
  const rad = (s.rot * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = (sx! * s.w) / 2, y = (sy! * s.h) / 2;
    return [s.cx + x * cos - y * sin, s.cy + x * sin + y * cos];
  });
}

/** Paints shapes into pixels with 4x4 supersampling, so edges are smooth without a browser. */
function rasterShapes(shapes: Shape[], inks: Ink[], ground: Ink | undefined, W: number, H: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  if (ground) paintAll(out, parseHex(ground.color)!);
  const rgb = inks.map((ink) => parseHex(ink.color)!);
  const SS = 4;
  for (const s of shapes) {
    let inside: (x: number, y: number) => boolean;
    let x0: number, y0: number, x1: number, y1: number;
    if (s.kind === 'circle') {
      const r2c = s.r * s.r;
      inside = (x, y) => (x - s.cx) ** 2 + (y - s.cy) ** 2 <= r2c;
      x0 = s.cx - s.r; x1 = s.cx + s.r; y0 = s.cy - s.r; y1 = s.cy + s.r;
    } else {
      const rad = (-s.rot * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const hw = s.w / 2, hh = s.h / 2, rx = Math.min(s.rx, hw, hh);
      inside = (x, y) => {
        const dx = x - s.cx, dy = y - s.cy;
        const lx = Math.abs(dx * cos - dy * sin), ly = Math.abs(dx * sin + dy * cos);
        if (lx > hw || ly > hh) return false;
        if (rx <= 0 || lx <= hw - rx || ly <= hh - rx) return true;
        return (lx - (hw - rx)) ** 2 + (ly - (hh - rx)) ** 2 <= rx * rx;
      };
      const reach = Math.hypot(hw, hh);
      x0 = s.cx - reach; x1 = s.cx + reach; y0 = s.cy - reach; y1 = s.cy + reach;
    }
    const c = rgb[s.ink]!;
    for (let py = Math.max(0, Math.floor(y0)); py < Math.min(H, Math.ceil(y1)); py++) {
      for (let px = Math.max(0, Math.floor(x0)); px < Math.min(W, Math.ceil(x1)); px++) {
        let hits = 0;
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) if (inside(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)) hits++;
        if (hits) blend(out, (py * W + px) * 4, c, hits / (SS * SS));
      }
    }
  }
  return out;
}

function paintAll(out: Uint8ClampedArray, c: [number, number, number]): void {
  for (let i = 0; i < out.length; i += 4) { out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255; }
}

/** Source-over of an opaque colour at coverage a. */
function blend(out: Uint8ClampedArray, i: number, c: [number, number, number], a: number): void {
  const da = out[i + 3]! / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  for (let k = 0; k < 3; k++) out[i + k] = (c[k]! * a + out[i + k]! * da * (1 - a)) / oa;
  out[i + 3] = oa * 255;
}

function ditherOutput(grid: { cols: number; rows: number; cells: Int16Array }, g: number, inks: Ink[], ground: Ink | undefined, W: number, H: number, svg: boolean): SvgResult | RasterResult {
  const { cols, rows, cells } = grid;
  if (svg) {
    // Runs of one ink along a row become one rectangle, so a flat area is a few shapes, not one per pixel.
    const paths: string[][] = inks.map(() => []);
    let shapes = 0;
    for (let r = 0; r < rows; r++) {
      let c = 0;
      while (c < cols) {
        const ink = cells[r * cols + c]!;
        let end = c + 1;
        while (end < cols && cells[r * cols + end] === ink) end++;
        if (ink >= 0) {
          paths[ink]!.push(`M${c * g} ${r * g}h${(end - c) * g}v${g}h${-(end - c) * g}z`);
          shapes++;
        }
        c = end;
      }
    }
    if (shapes > MAX_SHAPES) throw tooMany(shapes);
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="100%" shape-rendering="crispEdges">`];
    if (ground) parts.push(`<rect width="${W}" height="${H}" fill="${fill(ground)}"/>`);
    paths.forEach((d, i) => { if (d.length) parts.push(`<path fill="${fill(inks[i]!)}" d="${d.join('')}"/>`); });
    parts.push('</svg>');
    const text = parts.join('');
    return { kind: 'svg', svg: text, width: W, height: H, shapes, bytes: Buffer.byteLength(text) };
  }
  const out = new Uint8ClampedArray(W * H * 4);
  if (ground) paintAll(out, parseHex(ground.color)!);
  const rgb = inks.map((ink) => parseHex(ink.color)!);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ink = cells[Math.min(rows - 1, Math.floor(y / g)) * cols + Math.min(cols - 1, Math.floor(x / g))]!;
      if (ink < 0) continue;
      const i = (y * W + x) * 4, c = rgb[ink]!;
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
    }
  }
  return { kind: 'raster', rgba: out, width: W, height: H };
}

/** Per output pixel, the nearest source pixel's tone, drop and region: for the modes that work pixel by pixel. */
function eachOutputPixel(a: Analysis, W: number, H: number, visit: (i: number, tone: number, dropped: boolean, region: number) => void): void {
  for (let y = 0; y < H; y++) {
    const sy = Math.min(a.height - 1, Math.floor(((y + 0.5) * a.height) / H));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(a.width - 1, Math.floor(((x + 0.5) * a.width) / W));
      const si = sy * a.width + sx;
      visit(y * W + x, a.tone[si]!, a.dropped[si] === 1, a.regions ? a.region[si]! : -1);
    }
  }
}

function rampOutput(a: Analysis, inks: Ink[], ground: Ink | undefined, W: number, H: number): RasterResult {
  const out = new Uint8ClampedArray(W * H * 4);
  if (ground) paintAll(out, parseHex(ground.color)!);
  const labs = inks.map((ink) => oklab(...parseHex(ink.color)!));
  const steps = 256;
  // The ramp through the inks, in OKLab so midtones do not go muddy, as a lookup table.
  const lut = Array.from({ length: steps }, (_, s) => {
    const t = (s / (steps - 1)) * (labs.length - 1);
    const i = Math.min(labs.length - 2, Math.floor(t));
    if (labs.length === 1) return fromOklab(...labs[0]!);
    const f = t - i, a0 = labs[i]!, a1 = labs[i + 1]!;
    return fromOklab(a0[0] + (a1[0] - a0[0]) * f, a0[1] + (a1[1] - a0[1]) * f, a0[2] + (a1[2] - a0[2]) * f);
  });
  eachOutputPixel(a, W, H, (i, tone, dropped) => {
    if (dropped) return;
    const c = lut[Math.round(tone * (steps - 1))]!;
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
  });
  return { kind: 'raster', rgba: out, width: W, height: H };
}

function posterizeOutput(a: Analysis, inks: Ink[], ground: Ink | undefined, W: number, H: number): RasterResult {
  const out = new Uint8ClampedArray(W * H * 4);
  if (ground) paintAll(out, parseHex(ground.color)!);
  const rgb = inks.map((ink) => parseHex(ink.color)!);
  eachOutputPixel(a, W, H, (i, tone, dropped, region) => {
    if (dropped) return;
    const c = rgb[inkIndex(tone, region, inks.length)]!;
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
  });
  return { kind: 'raster', rgba: out, width: W, height: H };
}

/** Applies a treatment. svg asks for shapes; modes that are not made of shapes always give pixels. */
export function applyTreatment(input: TreatmentInput, options: { svg: boolean }): SvgResult | RasterResult {
  const p = input.params;
  if (!input.inks.length) throw new Error('A treatment needs at least one ink.');
  for (const ink of [...input.inks, ...(input.ground ? [input.ground] : [])]) if (!parseHex(ink.color)) throw new Error(`${ink.color} is not a colour as #rrggbb.`);
  if (options.svg && !svgCapable(p.mode)) throw new Error(`${p.mode} gives pixels, not shapes: ask for output raster, or use halftone, mosaic or dither for an SVG.`);
  const inks = sortInks(input.inks);
  const W = Math.max(8, Math.min(MAX_OUTPUT_SIDE, Math.round(input.width)));
  const H = Math.max(8, Math.min(MAX_OUTPUT_SIDE, Math.round((W * input.image.height) / Math.max(1, input.image.width))));
  const a = analyse(input.image, p, inks.length);
  if (p.mode === 'duotone') return rampOutput(a, inks, input.ground, W, H);
  if (p.mode === 'posterize') return posterizeOutput(a, inks, input.ground, W, H);
  if (p.mode === 'dither') return ditherOutput(ditherGrid(a, p, inks.length, W, H), Math.max(1, p.grid), inks, input.ground, W, H, options.svg);
  const groundRgb = input.ground ? parseHex(input.ground.color) : null;
  const onDark = groundRgb ? oklab(...groundRgb)[0] < 0.55 : false;
  const shapes = p.mode === 'halftone' ? halftoneShapes(a, p, inks.length, W, H, onDark) : mosaicShapes(a, p, inks.length, W, H, onDark);
  if (options.svg) {
    const svg = shapesSvg(shapes, inks, input.ground, W, H);
    const bytes = Buffer.byteLength(svg);
    if (bytes > MAX_TREATMENT_SVG_BYTES) throw new Error(`The SVG would be ${Math.round(bytes / 1024)} KB: use a larger grid, a smaller width, or output raster.`);
    return { kind: 'svg', svg, width: W, height: H, shapes: shapes.length, bytes };
  }
  return { kind: 'raster', rgba: rasterShapes(shapes, inks, input.ground, W, H), width: W, height: H };
}

/** Params from anything, within limits, with defaults for what is missing: presets come from other devices. */
export function coerceTreatmentParams(raw: unknown): TreatmentParams {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const num = (key: keyof TreatmentParams, min: number, max: number) => {
    const v = typeof r[key] === 'number' ? (r[key] as number) : Number.NaN;
    return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : (TREATMENT_DEFAULTS[key] as number);
  };
  const pick = <T extends string>(key: keyof TreatmentParams, options: readonly T[]): T => (options.includes(r[key] as T) ? (r[key] as T) : (TREATMENT_DEFAULTS[key] as T));
  const color = typeof r.dropColor === 'string' && parseHex(r.dropColor) ? r.dropColor : '';
  return {
    mode: pick('mode', TREATMENT_MODES), grid: num('grid', 1, 400), shape: pick('shape', TREATMENT_SHAPES), angle: num('angle', -360, 360), dither: pick('dither', DITHER_KINDS),
    inkBy: pick('inkBy', INK_BY), contrast: num('contrast', -100, 100), brightness: num('brightness', -100, 100), invert: r.invert === true, levels: r.levels !== false,
    maxSize: num('maxSize', 0.05, 1.5), minSize: num('minSize', 0, 1), gap: num('gap', 0, 0.9), sparse: num('sparse', 0, 1),
    drop: pick('drop', DROP_KINDS), threshold: num('threshold', 0, 1), dropColor: color, tolerance: num('tolerance', 0, 1),
    falloff: pick('falloff', FALLOFF_FROM), falloffAmount: num('falloffAmount', 0, 1), seed: Math.round(num('seed', 0, 2 ** 31)),
  };
}
