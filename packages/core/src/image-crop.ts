/**
 * Image crop: the part of an image a layer shows, as fractions of the whole image, in the attribute
 * `data-crop="x y w h"`. A cropped image renders as one element with the image as its background, sized and
 * placed in percentages of the layer, so it is plain CSS that every export writes as it is and that follows
 * the layer when it is resized. Filters stay the layer's own `filter` style.
 */
export interface Crop { x: number; y: number; w: number; h: number }

export const CROP_ATTR = 'data-crop';
/** Aspect presets of the inspector and of `image_crop`. `original` is the image's own, `free` keeps what there is. */
export const CROP_ASPECTS = ['free', 'original', '1:1', '4:3', '3:2', '16:9', '9:16', '4:5'] as const;
export type CropAspect = (typeof CROP_ASPECTS)[number];

const MIN = 0.01;
const round = (n: number) => Math.round(n * 10000) / 10000;

/** A stored crop, or nothing when it is missing, malformed or the whole image. Documents come from other people. */
export function parseCrop(value: string | undefined): Crop | undefined {
  if (!value || value.length > 80) return undefined;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [x, y, w, h] = parts as [number, number, number, number];
  if (w < MIN || h < MIN || x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) return undefined;
  if (x === 0 && y === 0 && w >= 0.9999 && h >= 0.9999) return undefined;
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

export function clampCrop(c: Crop): Crop {
  const w = Math.min(1, Math.max(MIN, c.w));
  const h = Math.min(1, Math.max(MIN, c.h));
  return { x: round(Math.min(1 - w, Math.max(0, c.x))), y: round(Math.min(1 - h, Math.max(0, c.y))), w: round(w), h: round(h) };
}

export function formatCrop(c: Crop): string {
  const k = clampCrop(c);
  return `${k.x} ${k.y} ${k.w} ${k.h}`;
}

const pct = (n: number) => `${round(n * 100)}%`;

/** The background that shows the crop of `url` over the whole layer. */
export function cropStyle(url: string, c: Crop): Record<string, string> {
  // background-position p% puts p% of the image on p% of the box: p = x / (1 - w) shows the image from x on.
  const px = c.w >= 0.9999 ? 0 : c.x / (1 - c.w);
  const py = c.h >= 0.9999 ? 0 : c.y / (1 - c.h);
  return {
    backgroundImage: `url("${url.replace(/["\\\n]/g, '')}")`,
    backgroundSize: `${pct(1 / c.w)} ${pct(1 / c.h)}`,
    backgroundPosition: `${pct(px)} ${pct(py)}`,
    backgroundRepeat: 'no-repeat',
  };
}

export function aspectRatioOf(aspect: CropAspect, natural: { width: number; height: number }): number | null {
  if (aspect === 'free') return null;
  if (aspect === 'original') return natural.width / Math.max(1, natural.height);
  const [a, b] = aspect.split(':').map(Number) as [number, number];
  return a / b;
}

/**
 * The largest crop of a displayed ratio (width over height, in pixels) inside the current one, centred on it.
 * `natural` is the image's size in pixels, so that fractions of width and height compare.
 */
export function cropToAspect(current: Crop | undefined, ratio: number, natural: { width: number; height: number }): Crop {
  const base = current ?? { x: 0, y: 0, w: 1, h: 1 };
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  // In pixels the crop is w*W by h*H: trim the side that is too long for the ratio.
  const W = Math.max(1, natural.width);
  const H = Math.max(1, natural.height);
  let pw = base.w * W;
  let ph = base.h * H;
  if (pw / ph > ratio) pw = ph * ratio;
  else ph = pw / ratio;
  const w = pw / W;
  const h = ph / H;
  return clampCrop({ x: cx - w / 2, y: cy - h / 2, w, h });
}

/** The layer height in px that shows a crop of an image undistorted at a layer width. */
export function croppedHeight(width: number, c: Crop | undefined, natural: { width: number; height: number }): number {
  const k = c ?? { x: 0, y: 0, w: 1, h: 1 };
  return Math.max(1, Math.round((width * k.h * natural.height) / (k.w * natural.width)));
}
