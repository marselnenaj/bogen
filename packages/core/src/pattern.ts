/**
 * Pattern layers: a brand's graphic device as a grid of cells, each filled or left out and toned by a value field.
 * The field comes from a gradient, a radial falloff, seeded noise, or a sampled image or text mask (sampled by the
 * server and stored with the layer, so the editor can redraw it without the image or the font). The result is plain
 * SVG with one group per tone, filled with the brand's tokens, so it follows token changes and exports as vector.
 */

export const PATTERN_ATTR = 'data-bogen-pattern';
export const PATTERN_FIELD_ATTR = 'data-bogen-pattern-field';

export const PATTERN_CELLS = ['circle', 'square', 'rounded', 'diamond', 'plus', 'custom'] as const;
export type PatternCell = (typeof PATTERN_CELLS)[number];
export const PATTERN_FILLS = ['solid', 'gradient', 'radial', 'noise', 'figure', 'bars', 'image', 'text'] as const;
/** Shapes a pattern can form as a figure rather than a texture, from the same cells. */
export const PATTERN_FIGURES = ['wave', 'mountain', 'tower', 'cloud', 'sun', 'hill'] as const;
export type PatternFigure = (typeof PATTERN_FIGURES)[number];
export type PatternFillKind = (typeof PATTERN_FILLS)[number];

export interface PatternSpec {
  columns: number;
  rows: number;
  cell: PatternCell;
  /** For `custom`: SVG path data in a 0..1 box. */
  path?: string;
  /** Share of the cell left empty around the shape, 0 to 0.9. */
  gap: number;
  fill: PatternFillKind;
  /** Gradient: direction in degrees, 0 runs left to right, 90 top to bottom. */
  angle: number;
  /** Radial: centre and radius as fractions of the grid. */
  cx: number;
  cy: number;
  radius: number;
  /** Noise: size of its features in cells. */
  scale: number;
  /** figure: the shape the filled cells form; the same material as the texture, in a second register. */
  figure?: PatternFigure;
  /** bars: one value per bar from 0 to 1, as a chart in the device's cells. */
  values?: number[];
  /** Added to every value: noise this strong (0 to 1) roughens any fill, so edges break up. */
  roughness: number;
  /** Values under this leave the cell empty. */
  threshold: number;
  /** Cells left out at random, 0 to 1, as a scatter. */
  scatter: number;
  /** Cells grow with their value, from this share of the full size, instead of all being full size. */
  sizeByValue: boolean;
  minSize: number;
  invert: boolean;
  /** Raises values to this power: below 1 grows the filled part, above 1 shrinks it. */
  curve: number;
  /** One per tone, lowest value first: `var(--token)` or a colour. */
  colors: string[];
  seed: number;
}

export const PATTERN_DEFAULTS: PatternSpec = {
  columns: 32, rows: 18, cell: 'square', gap: 0.12, fill: 'gradient', angle: 0, cx: 0.5, cy: 0.5, radius: 0.6, scale: 6,
  roughness: 0.25, threshold: 0.35, scatter: 0, sizeByValue: false, minSize: 0.3, invert: false, curve: 1, colors: ['currentColor'], seed: 1,
};

export const MAX_PATTERN_CELLS = 25_000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A small fast seeded generator (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value noise with smooth interpolation over a lattice, in [0, 1], summed over three octaves. */
function noiseField(columns: number, rows: number, scale: number, seed: number): Float32Array {
  const out = new Float32Array(columns * rows);
  const octaves = [1, 0.5, 0.25];
  let total = 0;
  for (const amp of octaves) total += amp;
  octaves.forEach((amp, o) => {
    const step = Math.max(1, scale) / 2 ** o;
    const gw = Math.ceil(columns / step) + 2;
    const gh = Math.ceil(rows / step) + 2;
    const rnd = seeded(seed * 9973 + o * 131);
    const lattice = new Float32Array(gw * gh).map(() => rnd());
    const smooth = (t: number) => t * t * (3 - 2 * t);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const fx = x / step;
        const fy = y / step;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = smooth(fx - x0);
        const ty = smooth(fy - y0);
        const at = (i: number, j: number) => lattice[j * gw + i]!;
        const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
        const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
        out[y * columns + x]! += (amp / total) * (top * (1 - ty) + bottom * ty);
      }
    }
  });
  return out;
}

/** A stored field of `columns x rows` bytes, as base64. */
export function encodeField(values: ArrayLike<number>): string {
  const bytes = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) bytes[i] = Math.round(clamp(values[i]!, 0, 1) * 255);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodeField(encoded: string, length: number): Float32Array | null {
  let raw: string;
  try {
    raw = atob(encoded);
  } catch {
    return null;
  }
  if (raw.length !== length) return null;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = raw.charCodeAt(i) / 255;
  return out;
}

/** The value of every cell before threshold and tones, in [0, 1]. */
export function patternValues(spec: PatternSpec, sampled?: Float32Array | null): Float32Array {
  const { columns, rows } = spec;
  const out = new Float32Array(columns * rows);
  const rad = (spec.angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // The gradient runs over the grid's extent along its direction, corner to corner.
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => u! * columns * dx + v! * rows * dy);
  const lo = Math.min(...corners);
  const span = Math.max(...corners) - lo || 1;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const i = y * columns + x;
      const px = x + 0.5;
      const py = y + 0.5;
      let v: number;
      switch (spec.fill) {
        case 'solid': v = 1; break;
        case 'gradient': v = (px * dx + py * dy - lo) / span; break;
        case 'radial': {
          const ddx = px / columns - spec.cx;
          const ddy = (py / rows - spec.cy) * (rows / columns);
          v = 1 - Math.sqrt(ddx * ddx + ddy * ddy) / Math.max(0.01, spec.radius);
          break;
        }
        case 'image': case 'text': v = sampled?.[i] ?? 0; break;
        case 'figure': v = figureValue(spec.figure ?? 'wave', px / columns, py / rows, columns / rows); break;
        case 'bars': {
          const vals = spec.values?.length ? spec.values : [0.5];
          const bar = Math.min(vals.length - 1, Math.floor((px / columns) * vals.length));
          // A cell is in its bar when it sits under the bar's height, counted from the bottom; a gap column between bars.
          const within = ((px / columns) * vals.length) % 1;
          v = within > 0.82 && vals.length > 1 ? 0 : 1 - py / rows <= clamp(vals[bar]!, 0, 1) ? 1 : 0;
          break;
        }
        default: v = 0;
      }
      out[i] = v;
    }
  }
  if (spec.fill === 'noise') out.set(noiseField(columns, rows, spec.scale, spec.seed));
  else if (spec.roughness > 0) {
    const n = noiseField(columns, rows, Math.max(1.5, spec.scale / 2), spec.seed + 17);
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + (n[i]! - 0.5) * 2 * spec.roughness;
  }
  for (let i = 0; i < out.length; i++) {
    let v = clamp(out[i]!, 0, 1);
    if (spec.invert) v = 1 - v;
    if (spec.curve !== 1) v = v ** spec.curve;
    out[i] = v;
  }
  return out;
}

/** 1 inside a figure, 0 outside, soft over about a cell: u and v run 0..1 across the grid, aspect is its width / height. */
function figureValue(f: PatternFigure, u: number, v: number, aspect: number): number {
  const up = 1 - v;
  const edge = (d: number) => clamp(0.5 + d * 12, 0, 1);
  switch (f) {
    case 'wave': return edge(0.45 + 0.18 * Math.sin(u * Math.PI * 2.2 + 0.6) + 0.06 * Math.sin(u * Math.PI * 7) - up);
    case 'mountain': {
      const peaks = [[0.28, 0.82], [0.62, 0.62], [0.86, 0.48]] as const;
      const h = Math.max(...peaks.map(([x, top]) => top - Math.abs(u - x) * 1.6));
      return edge(h - up);
    }
    case 'hill': return edge(0.55 - (u - 0.5) * (u - 0.5) * 1.8 - up);
    case 'tower': {
      const steps = [[0.18, 0.34], [0.32, 0.58], [0.44, 0.9], [0.56, 0.9], [0.68, 0.58], [0.82, 0.34]] as const;
      const s = steps.find(([x]) => Math.abs(u - x) < 0.07);
      return s ? edge(s[1] - up) : 0;
    }
    case 'cloud': {
      const blobs = [[0.32, 0.52, 0.17], [0.5, 0.42, 0.22], [0.68, 0.54, 0.16], [0.5, 0.6, 0.18]] as const;
      return edge(Math.max(...blobs.map(([x, y, r]) => r - Math.hypot((u - x) * aspect * 0.6, v - y))));
    }
    case 'sun': return edge(0.32 - Math.hypot((u - 0.5) * aspect * 0.5, v - 0.55));
    default: return 0;
  }
}

const n2 = (v: number) => String(Math.round(v * 1000) / 1000);

function cellMarkup(spec: PatternSpec, x: number, y: number, size: number): string {
  const inset = (1 - size) / 2;
  const cx = x + 0.5;
  const cy = y + 0.5;
  const r = size / 2;
  switch (spec.cell) {
    case 'circle': return `<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(r)}"/>`;
    case 'rounded': return `<rect x="${n2(x + inset)}" y="${n2(y + inset)}" width="${n2(size)}" height="${n2(size)}" rx="${n2(size * 0.28)}"/>`;
    case 'diamond': return `<path d="M${n2(cx)} ${n2(cy - r)}L${n2(cx + r)} ${n2(cy)}L${n2(cx)} ${n2(cy + r)}L${n2(cx - r)} ${n2(cy)}Z"/>`;
    case 'plus': {
      const t = size / 3;
      return `<path d="M${n2(cx - t / 2)} ${n2(cy - r)}h${n2(t)}v${n2(r - t / 2)}h${n2(r - t / 2)}v${n2(t)}h${n2(-(r - t / 2))}v${n2(r - t / 2)}h${n2(-t)}v${n2(-(r - t / 2))}h${n2(-(r - t / 2))}v${n2(-t)}h${n2(r - t / 2)}Z"/>`;
    }
    case 'custom': return `<path transform="translate(${n2(x + inset)} ${n2(y + inset)}) scale(${n2(size)})" d="${(spec.path ?? '').replace(/[^0-9\s.,MmLlHhVvCcSsQqTtAaZzEe+\-]/g, '')}"/>`;
    default: return `<rect x="${n2(x + inset)}" y="${n2(y + inset)}" width="${n2(size)}" height="${n2(size)}"/>`;
  }
}

/** Only `var(--token)`, a hex colour, a colour function or a keyword: what can go into a style attribute safely. */
export function safePatternColor(value: string): string | null {
  const v = value.trim();
  if (/^var\(--[\w-]{1,80}\)$/.test(v)) return v;
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^(?:rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\([\w\s.,%/()#-]{1,120}\)$/i.test(v) && !/url|expression/i.test(v)) return v;
  if (/^(?:currentColor|transparent|[a-z]{3,20})$/i.test(v)) return v;
  return null;
}

export interface PatternResult {
  svg: string;
  filled: number;
  cells: number;
  /** Filled cells per tone, lowest value first. */
  tones: number[];
}

/**
 * The SVG of a pattern. The view box is one unit per cell and the SVG stretches to its layer
 * (`preserveAspectRatio="none"` would distort circles, so cells keep their shape and the grid fits the layer's
 * shape when columns and rows match it).
 */
export function renderPattern(spec: PatternSpec, sampled?: Float32Array | null): PatternResult {
  const values = patternValues(spec, sampled);
  const colors = spec.colors.map((c) => safePatternColor(c) ?? 'currentColor');
  const tones = colors.length || 1;
  const groups: string[][] = Array.from({ length: tones }, () => []);
  const drop = seeded(spec.seed * 7919 + 3);
  const threshold = clamp(spec.threshold, 0, 0.999);
  let filled = 0;
  for (let y = 0; y < spec.rows; y++) {
    for (let x = 0; x < spec.columns; x++) {
      const v = values[y * spec.columns + x]!;
      const r = drop();
      if (v < threshold || (spec.scatter > 0 && r < spec.scatter)) continue;
      const t = (v - threshold) / (1 - threshold);
      const tone = Math.min(tones - 1, Math.floor(t * tones));
      const full = 1 - clamp(spec.gap, 0, 0.9);
      const size = spec.sizeByValue ? full * (spec.minSize + (1 - spec.minSize) * t) : full;
      if (size <= 0.01) continue;
      groups[tone]!.push(cellMarkup(spec, x, y, size));
      filled++;
    }
  }
  const body = groups.map((cells, i) => (cells.length ? `<g style="fill:${colors[i] ?? 'currentColor'}">${cells.join('')}</g>` : '')).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${spec.columns} ${spec.rows}" width="100%" height="100%">${body}</svg>`;
  return { svg, filled, cells: spec.columns * spec.rows, tones: groups.map((g) => g.length) };
}

/** A stored spec, read leniently: what is missing or wrong falls back to the default. */
export function readPatternSpec(raw: string | undefined): PatternSpec | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return normalizePatternSpec(parsed as Partial<PatternSpec>);
}

export function normalizePatternSpec(p: Partial<PatternSpec>): PatternSpec {
  const d = PATTERN_DEFAULTS;
  const num = (v: unknown, fallback: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
  const columns = Math.round(num(p.columns, d.columns, 1, 400));
  const rows = Math.round(num(p.rows, d.rows, 1, 400));
  if (columns * rows > MAX_PATTERN_CELLS) throw new Error(`A pattern has at most ${MAX_PATTERN_CELLS} cells; ${columns} x ${rows} is ${columns * rows}. Use fewer columns or rows.`);
  return {
    columns, rows,
    cell: PATTERN_CELLS.includes(p.cell as PatternCell) ? (p.cell as PatternCell) : d.cell,
    ...(p.cell === 'custom' && typeof p.path === 'string' ? { path: p.path.slice(0, 4000) } : {}),
    gap: num(p.gap, d.gap, 0, 0.9),
    fill: PATTERN_FILLS.includes(p.fill as PatternFillKind) ? (p.fill as PatternFillKind) : d.fill,
    angle: num(p.angle, d.angle, -360, 360),
    cx: num(p.cx, d.cx, -1, 2), cy: num(p.cy, d.cy, -1, 2), radius: num(p.radius, d.radius, 0.01, 4),
    scale: num(p.scale, d.scale, 1, 200),
    ...(PATTERN_FIGURES.includes(p.figure as PatternFigure) ? { figure: p.figure as PatternFigure } : {}),
    ...(Array.isArray(p.values) && p.values.length ? { values: p.values.slice(0, 64).map((x) => clamp(Number(x) || 0, 0, 1)) } : {}),
    roughness: num(p.roughness, d.roughness, 0, 1),
    threshold: num(p.threshold, d.threshold, 0, 0.999),
    scatter: num(p.scatter, d.scatter, 0, 0.95),
    sizeByValue: typeof p.sizeByValue === 'boolean' ? p.sizeByValue : d.sizeByValue,
    minSize: num(p.minSize, d.minSize, 0, 1),
    invert: typeof p.invert === 'boolean' ? p.invert : d.invert,
    curve: num(p.curve, d.curve, 0.1, 10),
    colors: Array.isArray(p.colors) && p.colors.length ? p.colors.slice(0, 8).map(String) : d.colors,
    seed: Math.round(num(p.seed, d.seed, 0, 2 ** 31)),
  };
}
