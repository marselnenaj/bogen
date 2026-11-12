// Desktop displays for an Omarchy theme: the screens a theme is previewed on, landscape and portrait, and the wallpaper
// composition each orientation gets. Pure: no files, no processes. hyprctl output comes in as text.
//
// A portrait display here is a desktop monitor turned on its side, running the same Omarchy desktop: bar, tiling
// windows, launcher, lock screen. Whether a theme is for a desktop or a phone is the theme's own target, chosen on
// purpose; a display's width or shape never decides it.
//
// What Omarchy 4.5 does at runtime, read from shell/plugins/background/Background.qml: one `current/background` link,
// drawn on every screen with Image.PreserveAspectCrop. It does not pick a background per screen or per orientation, so
// a portrait monitor shows the middle of whatever background is current. Bogen does not change that. A theme file
// carries a portrait composition of its own so the theme is designed for both shapes, and the export ships it under
// displays/, outside backgrounds/, where Omarchy does not cycle through it.

export type Orientation = 'landscape' | 'portrait' | 'square';

/** A screen's size in the logical pixels the shell lays out in: its mode, turned as mounted, divided by its scale. */
export interface DisplaySize { width: number; height: number }

/** One monitor as `hyprctl monitors -j` reports it, after checking every field. */
export interface DetectedDisplay {
  /** The connector, such as DP-5. */
  name: string;
  /** The mode in device pixels, turned the way the monitor is mounted: what a full-size wallpaper is drawn at. */
  pixels: DisplaySize;
  /** What the desktop lays out in: pixels divided by the scale. */
  logical: DisplaySize;
  /** Hyprland's wl_output transform, 0 to 7. 1, 3, 5 and 7 swap width and height; 4 to 7 are also mirrored. */
  transform: number;
  rotation: 0 | 90 | 180 | 270;
  flipped: boolean;
  scale: number;
  orientation: Orientation;
  /** Outside the preview sizes Bogen supports: listed with the reason, not offered as a display. */
  usable: boolean;
  reason?: string;
}

/** Where a display of a theme came from. */
export type DisplaySource = 'detected' | 'preset' | 'custom';

export interface DisplayPreset extends DisplaySize { id: string; label: string; orientation: Orientation; note: string }

/** The previews every desktop theme has had since the first: 1920 x 1080, landscape. preview.png is drawn from it. */
export const CANONICAL: DisplaySize = { width: 1920, height: 1080 };

/** Sizes a person can add without a monitor of that shape at hand, such as on a laptop or a Mac. */
export const DISPLAY_PRESETS: readonly DisplayPreset[] = [
  { id: 'portrait-1080x1920', width: 1080, height: 1920, label: 'Portrait 1080 × 1920', orientation: 'portrait', note: 'A 1080p or 4K at 200 % monitor turned on its side' },
  { id: 'portrait-1200x1920', width: 1200, height: 1920, label: 'Portrait 1200 × 1920', orientation: 'portrait', note: 'A 16:10 monitor turned on its side' },
  { id: 'portrait-1440x2560', width: 1440, height: 2560, label: 'Portrait 1440 × 2560', orientation: 'portrait', note: 'A 1440p or 5K at 200 % monitor turned on its side' },
  { id: 'portrait-2160x3840', width: 2160, height: 3840, label: 'Portrait 2160 × 3840', orientation: 'portrait', note: 'A 4K monitor at 100 % turned on its side' },
  { id: 'landscape-2560x1440', width: 2560, height: 1440, label: 'Landscape 2560 × 1440', orientation: 'landscape', note: 'A 1440p monitor at 100 %' },
  { id: 'landscape-3840x2160', width: 3840, height: 2160, label: 'Landscape 3840 × 2160', orientation: 'landscape', note: 'A 4K monitor at 100 %' },
];

/** The portrait display a new theme gets when this machine has none: the shape most turned monitors have. */
export const PORTRAIT_FALLBACK = DISPLAY_PRESETS[0]!;

/**
 * The display sizes Bogen draws desktop previews for. These are bounds of this feature, not of what a desktop can
 * be: a narrower or longer custom desktop exists, the previews are just not laid out for it.
 */
export const LIMITS = { minSide: 600, maxSide: 7680, maxPixels: 7680 * 4320, maxAspect: 4, maxDisplays: 6, perRequest: 4, maxMonitors: 16 } as const;

/** The size a portrait composition is drawn at when no monitor says otherwise: 4K tall, sharp on any of the presets. */
const WALLPAPER_LONG_SIDE = 3840;

export function orientationOf(s: DisplaySize): Orientation {
  if (Math.abs(s.width - s.height) <= Math.max(s.width, s.height) * 0.05) return 'square';
  return s.width > s.height ? 'landscape' : 'portrait';
}

/** Landscape shares the theme's Wallpaper; portrait and square shapes get a composition of their own. */
export const needsOwnWallpaper = (s: DisplaySize): boolean => orientationOf(s) !== 'landscape';

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

/**
 * The shape of a display as a ratio people read, such as 9:16. Shapes within 1 % of a common ratio take its name,
 * so 1080 x 1920 and 2160 x 3840 share one composition while 1200 x 1920 (10:16) gets its own.
 */
export function aspectOf(s: DisplaySize): string {
  const ratio = s.width / s.height;
  const common: [number, number][] = [[9, 16], [10, 16], [3, 4], [2, 3], [9, 21], [1, 1], [16, 9], [16, 10], [4, 3], [21, 9], [32, 9]];
  for (const [w, h] of common) if (Math.abs(ratio / (w / h) - 1) < 0.01) return `${w}:${h}`;
  const d = gcd(s.width, s.height);
  const [w, h] = [s.width / d, s.height / d];
  return w <= 64 && h <= 64 ? `${w}:${h}` : `${Math.round(ratio * 1000) / 1000}:1`;
}

/** 9:16 as it goes into a file name: 9x16. */
export const aspectSlug = (aspect: string): string => aspect.replace(':', 'x').replace(/[^0-9x.]/g, '');

export const sizeLabel = (s: DisplaySize): string => `${s.width} × ${s.height}`;
export const displayLabel = (s: DisplaySize): string => `${orientationOf(s)} ${sizeLabel(s)}`;

/** Why a size cannot be a desktop display, or null when it can. */
export function displayProblem(s: DisplaySize): string | null {
  const { width: w, height: h } = s;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return 'Width and height are whole numbers of pixels.';
  if (Math.min(w, h) < LIMITS.minSide) return `${sizeLabel(s)} is outside the desktop preview sizes Bogen supports: each side is at least ${LIMITS.minSide} px.`;
  if (Math.max(w, h) > LIMITS.maxSide || w * h > LIMITS.maxPixels) return `${sizeLabel(s)} is outside the desktop preview sizes Bogen supports: at most ${LIMITS.maxSide} px on a side and 8K in pixels. Give the size the desktop lays out in: the mode divided by the scale.`;
  if (Math.max(w, h) / Math.min(w, h) > LIMITS.maxAspect) return `${sizeLabel(s)} is outside the desktop preview shapes Bogen supports: at most ${LIMITS.maxAspect}:1.`;
  return null;
}

/**
 * Monitors from `hyprctl monitors -j`. Each field is checked: a monitor that is disabled, mirrors another (and so shows
 * no desktop of its own), or reports a size, transform or scale outside what Hyprland gives, is left out. The rest
 * are turned as mounted (transforms 1, 3, 5, 7, mirrored or not) and divided by their scale.
 */
export function parseMonitors(text: string): DetectedDisplay[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: DetectedDisplay[] = [];
  for (const m of raw.slice(0, LIMITS.maxMonitors) as Record<string, unknown>[]) {
    if (!m || typeof m !== 'object') continue;
    const { width, height } = m;
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 16384 || height > 16384) continue;
    if (m.disabled === true) continue;
    if (typeof m.mirrorOf === 'string' && m.mirrorOf && m.mirrorOf !== 'none') continue;
    const transform = m.transform === undefined ? 0 : m.transform;
    if (typeof transform !== 'number' || !Number.isInteger(transform) || transform < 0 || transform > 7) continue;
    const scale = m.scale === undefined ? 1 : m.scale;
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.25 || scale > 4) continue;
    const name = typeof m.name === 'string' && /^[\w.:-]{1,32}$/.test(m.name) ? m.name : `Monitor ${out.length + 1}`;
    const turned = transform % 2 === 1;
    const pixels = turned ? { width: height, height: width } : { width, height };
    const logical = { width: Math.round(pixels.width / scale), height: Math.round(pixels.height / scale) };
    const problem = displayProblem(logical);
    out.push({
      name, pixels, logical, transform, rotation: ((transform % 4) * 90) as DetectedDisplay['rotation'], flipped: transform >= 4, scale,
      orientation: orientationOf(logical), usable: !problem, ...(problem ? { reason: problem } : {}),
    });
  }
  return out;
}

/** How a detected monitor reads in a list: DP-5, 3840 × 2160 turned 270°, scale 1: 2160 × 3840. */
export function describeMonitor(d: DetectedDisplay): string {
  const mode = d.transform % 2 === 1 ? `${d.pixels.height} × ${d.pixels.width}` : `${d.pixels.width} × ${d.pixels.height}`;
  const turn = d.rotation ? ` turned ${d.rotation}°` : '';
  const flip = d.flipped ? ', mirrored' : '';
  return `${d.name}, ${mode}${turn}${flip}, scale ${Math.round(d.scale * 100) / 100}: ${sizeLabel(d.logical)} ${d.orientation}`;
}

/** What a theme records about one of its displays, in `meta.omarchyTheme.displays`. */
export interface ThemeDisplay extends DisplaySize {
  source: DisplaySource;
  /** The monitor it was detected from, such as DP-5. */
  monitor?: string;
}

/**
 * A wallpaper composition of a shape other than landscape, in `meta.omarchyTheme.wallpapers`. `placeholder` is set
 * when it was made as a stand-in from the palette for a theme whose backgrounds are pictures: it then needs its own
 * design. The fingerprints tell whether either side changed since it was made.
 */
export interface ThemeWallpaper {
  aspect: string;
  /** The component its previews show, such as "Wallpaper · portrait 9:16". */
  component: string;
  placeholder: boolean;
  /** Of the composition and of the landscape Wallpaper when this one was made. */
  fingerprint?: string;
  landscapeFingerprint?: string;
}

export const wallpaperComponentName = (aspect: string, orientation: Orientation): string => `Wallpaper · ${orientation} ${aspect}`;

/** The size a composition of this shape is drawn at: the largest monitor of that shape, else 3840 on its long side. */
export function wallpaperSize(shape: DisplaySize, monitors: readonly DisplaySize[] = []): DisplaySize {
  const aspect = aspectOf(shape);
  const same = monitors.filter((m) => aspectOf(m) === aspect && !displayProblem(m)).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (same && Math.max(same.width, same.height) >= WALLPAPER_LONG_SIDE) return same;
  const long = Math.max(shape.width, shape.height);
  if (long >= WALLPAPER_LONG_SIDE) return { width: shape.width, height: shape.height };
  const k = WALLPAPER_LONG_SIDE / long;
  return { width: Math.round(shape.width * k), height: Math.round(shape.height * k) };
}

/** Sizes asked for, as given: a preset id, a detected monitor's name, or a width and height. */
export type DisplayRequest = { preset: string } | { monitor: string } | { width: number; height: number };

export interface ResolvedRequest { size: DisplaySize; source: DisplaySource; monitor?: string }

/**
 * Turns requests into sizes, checking each, and drops repeats and sizes the theme has already. Throws on a size that
 * cannot be a desktop display, on an unknown preset or monitor, and on more than the limits allow.
 */
export function resolveRequests(requests: readonly DisplayRequest[], have: readonly DisplaySize[], detected: readonly DetectedDisplay[]): { add: ResolvedRequest[]; skipped: { size: DisplaySize; reason: string }[] } {
  if (requests.length > LIMITS.perRequest) throw new Error(`Add at most ${LIMITS.perRequest} displays at a time.`);
  const add: ResolvedRequest[] = [];
  const skipped: { size: DisplaySize; reason: string }[] = [];
  const key = (s: DisplaySize) => `${s.width}x${s.height}`;
  const seen = new Set(have.map(key));
  for (const r of requests) {
    let resolved: ResolvedRequest;
    if ('preset' in r) {
      const p = DISPLAY_PRESETS.find((x) => x.id === r.preset);
      if (!p) throw new Error(`There is no preset "${r.preset}". Presets: ${DISPLAY_PRESETS.map((x) => x.id).join(', ')}.`);
      resolved = { size: { width: p.width, height: p.height }, source: 'preset' };
    } else if ('monitor' in r) {
      const d = detected.find((x) => x.name === r.monitor);
      if (!d) throw new Error(`There is no monitor "${r.monitor}" on this machine. ${detected.length ? `Monitors: ${detected.map((x) => x.name).join(', ')}.` : 'hyprctl reports none here: give a preset or a size.'}`);
      if (!d.usable) throw new Error(`${d.name} cannot be a desktop display: ${d.reason}`);
      resolved = { size: d.logical, source: 'detected', monitor: d.name };
    } else {
      const size = { width: r.width, height: r.height };
      const problem = displayProblem(size);
      if (problem) throw new Error(problem);
      resolved = { size, source: 'custom' };
    }
    if (seen.has(key(resolved.size))) {
      skipped.push({ size: resolved.size, reason: key(resolved.size) === key(CANONICAL) ? 'The theme\'s own previews are already 1920 × 1080.' : 'The theme has previews at this size already.' });
      continue;
    }
    seen.add(key(resolved.size));
    add.push(resolved);
  }
  const total = have.filter((s) => key(s) !== key(CANONICAL)).length + add.length;
  if (total > LIMITS.maxDisplays) throw new Error(`A theme holds at most ${LIMITS.maxDisplays} displays besides its 1920 × 1080 previews; this would make ${total}. Nothing was added.`);
  return { add, skipped };
}

/**
 * The portrait displays a new desktop theme gets: this machine's portrait (and square) monitors, each size once and at
 * most two, or the 1080 x 1920 preset when it has none, as on a laptop, a Mac or anywhere without Hyprland.
 */
export function newThemeDisplays(detected: readonly DetectedDisplay[]): ThemeDisplay[] {
  const out: ThemeDisplay[] = [];
  for (const d of detected) {
    if (!d.usable || d.orientation === 'landscape') continue;
    if (out.some((o) => o.width === d.logical.width && o.height === d.logical.height)) continue;
    out.push({ ...d.logical, source: 'detected', monitor: d.name });
    if (out.length === 2) break;
  }
  return out.length ? out : [{ width: PORTRAIT_FALLBACK.width, height: PORTRAIT_FALLBACK.height, source: 'preset' }];
}

/** Reads `meta.displays` and `meta.wallpapers` back, keeping only what is well formed. */
export function readDisplays(raw: unknown): ThemeDisplay[] {
  if (!Array.isArray(raw)) return [];
  const out: ThemeDisplay[] = [];
  for (const d of raw.slice(0, LIMITS.maxDisplays) as Record<string, unknown>[]) {
    if (!d || typeof d !== 'object' || typeof d.width !== 'number' || typeof d.height !== 'number') continue;
    const size = { width: d.width, height: d.height };
    if (displayProblem(size)) continue;
    const source: DisplaySource = d.source === 'detected' || d.source === 'custom' ? d.source : 'preset';
    out.push({ ...size, source, ...(typeof d.monitor === 'string' && /^[\w.:-]{1,32}$/.test(d.monitor) ? { monitor: d.monitor } : {}) });
  }
  return out;
}

export function readWallpapers(raw: unknown): ThemeWallpaper[] {
  if (!Array.isArray(raw)) return [];
  const out: ThemeWallpaper[] = [];
  for (const w of raw.slice(0, LIMITS.maxDisplays) as Record<string, unknown>[]) {
    if (!w || typeof w !== 'object' || typeof w.aspect !== 'string' || !/^[\d.]{1,8}:[\d.]{1,8}$/.test(w.aspect)) continue;
    if (typeof w.component !== 'string' || !/^Wallpaper · [\w :.]{1,40}$/.test(w.component)) continue;
    const fp = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{8,64}$/.test(v) ? v : undefined);
    const fingerprint = fp(w.fingerprint);
    const landscapeFingerprint = fp(w.landscapeFingerprint);
    out.push({ aspect: w.aspect, component: w.component, placeholder: w.placeholder === true, ...(fingerprint ? { fingerprint } : {}), ...(landscapeFingerprint ? { landscapeFingerprint } : {}) });
  }
  return out;
}

/**
 * What a person reads about a composition's state. Only `artwork` and `composed` are done; the others are problems,
 * shown in the dialog, returned to agents and listed by the export, until someone designs the shape.
 */
export type WallpaperStatus = 'artwork' | 'composed' | 'needs-design' | 'mismatch' | 'unverified' | 'missing';

export const WALLPAPER_DONE: ReadonlySet<WallpaperStatus> = new Set(['artwork', 'composed']);

export const WALLPAPER_STATUS_TEXT: Record<WallpaperStatus, string> = {
  artwork: 'Own artwork',
  composed: 'Composed for this shape',
  'needs-design': 'Needs its own design',
  mismatch: 'Picture of another shape, cropped',
  unverified: 'Picture of unknown size',
  missing: 'No composition',
};

/** Whether a picture is the shape of a display, within 1.5 %: the only artwork assigned to it. */
export function sameShape(a: DisplaySize, b: DisplaySize): boolean {
  if (!a.width || !a.height || !b.width || !b.height) return false;
  return Math.abs((a.width / a.height) / (b.width / b.height) - 1) <= 0.015;
}

// ---------------------------------------------------------------- what a composition is

/** One visible layer inside a composition, as the classifier needs it. Pure data: no document. */
export interface CompositionLayer {
  id: string;
  name: string;
  type: string;
  style: Record<string, string | undefined>;
  src?: string;
  /** The picture's alt text or layer name, for messages. */
  label?: string;
  /** Bogen's placeholder note, the palette arcs of older files, or a layer inside one of them. */
  generated: boolean;
  /** Ids of the layers it sits in, inside the composition. */
  ancestors: string[];
}

export type CompositionVerdict =
  | { status: 'artwork'; layer: CompositionLayer; size: DisplaySize }
  | { status: 'mismatch'; layer: CompositionLayer; size: DisplaySize }
  | { status: 'unverified'; layer: CompositionLayer }
  | { status: 'composed'; own: number; contained: CompositionLayer[] }
  | { status: 'needs-design'; legacy: boolean };

type Axis = 'x' | 'y';

/** A CSS length in px against the composition, by axis: px, %, cqw, cqh, cqmin, cqmax, vw, vh, or a bare 0. Null when unknown (calc, auto). */
function lengthPx(v: string | undefined, axis: Axis, frame: DisplaySize): number | null {
  if (v === undefined) return null;
  const m = /^\s*(-?\d*\.?\d+)(px|%|cqw|cqh|cqmin|cqmax|vw|vh)?\s*$/.exec(v);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  const unit = m[2] ?? (n === 0 ? 'px' : '');
  switch (unit) {
    case 'px': return n;
    case '%': return (n / 100) * (axis === 'x' ? frame.width : frame.height);
    case 'cqw': case 'vw': return (n / 100) * frame.width;
    case 'cqh': case 'vh': return (n / 100) * frame.height;
    case 'cqmin': return (n / 100) * Math.min(frame.width, frame.height);
    case 'cqmax': return (n / 100) * Math.max(frame.width, frame.height);
    default: return null;
  }
}

/** The box a picture takes in the composition, in px, or null when its size cannot be told from its style. */
export function pictureBox(style: Record<string, string | undefined>, frame: DisplaySize): { left: number; top: number; width: number; height: number } | null {
  const inset = (style.inset ?? '').trim().split(/\s+/).filter(Boolean);
  const side = (i: number) => inset.length ? inset[[0, inset.length > 1 ? 1 : 0, inset.length > 2 ? 2 : 0, inset.length > 3 ? 3 : inset.length > 1 ? 1 : 0][i]!] : undefined;
  const pick = (own: string | undefined, i: number) => (own !== undefined && own !== 'auto' ? own : side(i));
  const top = lengthPx(pick(style.top, 0), 'y', frame);
  const right = lengthPx(pick(style.right, 1), 'x', frame);
  const bottom = lengthPx(pick(style.bottom, 2), 'y', frame);
  const left = lengthPx(pick(style.left, 3), 'x', frame);
  let width = style.width && style.width !== 'auto' ? lengthPx(style.width, 'x', frame) : null;
  let height = style.height && style.height !== 'auto' ? lengthPx(style.height, 'y', frame) : null;
  // Pinned to both edges with no size of its own, it stretches between them, as Bogen lays artwork in (inset: 0).
  if (width === null && left !== null && right !== null && (style.width === undefined || style.width === 'auto')) width = frame.width - left - right;
  if (height === null && top !== null && bottom !== null && (style.height === undefined || style.height === 'auto')) height = frame.height - top - bottom;
  if (width === null || height === null) return null;
  const x = left ?? (right !== null ? frame.width - right - width : 0);
  const y = top ?? (bottom !== null ? frame.height - bottom - height : 0);
  return { left: x, top: y, width, height };
}

/** Whether a box covers the whole composition, within half a percent on each edge. */
function coversFrame(box: { left: number; top: number; width: number; height: number }, frame: DisplaySize): boolean {
  const tx = frame.width * 0.005;
  const ty = frame.height * 0.005;
  return box.left <= tx && box.top <= ty && box.left + box.width >= frame.width - tx && box.top + box.height >= frame.height - ty;
}

/**
 * Whether a picture fills the whole composition, so that it decides what the shape shows: its box, measured by axis
 * against the composition (px, %, container units), covers it, and it is not `object-fit: contain` or `scale-down`,
 * which show it whole. A picture placed as a plate inside a layout, such as a landscape picture shown whole in a band
 * of a portrait field, or a square picture in a square band, does not fill it: it is part of a composed design.
 * `object-fit: none` fills only when the picture is at least as large as the composition; smaller, it is a plate.
 */
export function fillsComposition(style: Record<string, string | undefined>, frame: DisplaySize, picture?: DisplaySize | null): boolean {
  const fit = (style.objectFit ?? 'fill').trim();
  if (fit === 'contain' || fit === 'scale-down') return false;
  const box = pictureBox(style, frame);
  if (!box || !coversFrame(box, frame)) return false;
  if (fit === 'none' && picture) return picture.width >= box.width * 0.995 || picture.height >= box.height * 0.995;
  return true;
}

/** A picture filling the composition that shows something other than itself whole: cropped, stretched or clipped. */
function notWhole(style: Record<string, string | undefined>, frame: DisplaySize, size: DisplaySize): boolean {
  const fit = (style.objectFit ?? 'fill').trim();
  const box = pictureBox(style, frame)!;
  // At its own size, it is clipped wherever it is larger than the box; of exactly the box's size it is whole.
  if (fit === 'none') return !(Math.abs(size.width - box.width) <= box.width * 0.005 && Math.abs(size.height - box.height) <= box.height * 0.005);
  return !sameShape(size, frame);
}

/**
 * What a composition of a shape is, from its visible layers and the measured sizes of its pictures:
 * - a picture filling it whose size is unknown: unverified; of another shape: mismatch (it would be cropped);
 * - one picture of exactly its shape filling it, and nothing else of its own: artwork, shipped byte for byte;
 * - any other layer someone made, a picture shown whole inside it included: composed, shipped as a render;
 * - nothing but Bogen's placeholder or the old palette arcs: needs-design, however recoloured.
 */
export function classifyComposition(layers: readonly CompositionLayer[], target: DisplaySize, sizeOf: (src: string | undefined) => DisplaySize | null): CompositionVerdict {
  const own = layers.filter((l) => !l.generated);
  const covers = own.filter((l) => l.type === 'image' && fillsComposition(l.style, target, sizeOf(l.src)));
  for (const img of covers) {
    const size = sizeOf(img.src);
    if (!size) return { status: 'unverified', layer: img };
    if (notWhole(img.style, target, size)) return { status: 'mismatch', layer: img, size };
  }
  if (covers.length === 1) {
    const img = covers[0]!;
    // Only the frames it sits in may be around it; any other layer of its own makes it a composition.
    const rest = own.filter((l) => l !== img);
    if (rest.every((l) => l.type === 'frame' && img.ancestors.includes(l.id))) return { status: 'artwork', layer: img, size: sizeOf(img.src)! };
  }
  if (own.length) return { status: 'composed', own: own.length, contained: own.filter((l) => l.type === 'image' && !covers.includes(l)) };
  return { status: 'needs-design', legacy: layers.some((l) => l.generated && /^Arc |^Accent dot$/.test(l.name)) };
}
