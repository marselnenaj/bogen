/**
 * Image filters as the layer's own CSS `filter`: brightness, contrast, saturation, blur and grayscale, the
 * adjustments the inspector and `image_filter` offer. Other functions in the value, such as a drop-shadow or a
 * hue-rotate written by hand, stay where they are, so these controls never take away what they do not show.
 */
export type ImageFilterKey = 'brightness' | 'contrast' | 'saturate' | 'blur' | 'grayscale';
export type ImageFilters = Partial<Record<ImageFilterKey, number>>;

/** Per adjustment: its unit, its neutral value, and the range the controls offer. */
export const IMAGE_FILTERS: Record<ImageFilterKey, { label: string; unit: '%' | 'px'; neutral: number; min: number; max: number }> = {
  brightness: { label: 'Brightness', unit: '%', neutral: 100, min: 0, max: 200 },
  contrast: { label: 'Contrast', unit: '%', neutral: 100, min: 0, max: 200 },
  saturate: { label: 'Saturation', unit: '%', neutral: 100, min: 0, max: 200 },
  blur: { label: 'Blur', unit: 'px', neutral: 0, min: 0, max: 50 },
  grayscale: { label: 'Grayscale', unit: '%', neutral: 0, min: 0, max: 100 },
};
export const IMAGE_FILTER_KEYS = Object.keys(IMAGE_FILTERS) as ImageFilterKey[];

/** The functions of a filter value, split at top-level spaces: `blur(2px) drop-shadow(0 0 2px rgb(0 0 0))`. */
function functionsOf(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(value.slice(start, i + 1));
        start = -1;
      }
    } else if (depth === 0 && start < 0 && /\S/.test(c)) start = i;
  }
  return out;
}

/** A number in the adjustment's unit: `1.1` and `110%` are both 110 for brightness. */
function amount(key: ImageFilterKey, arg: string): number | undefined {
  const m = /^\s*(-?[\d.]+)\s*(%|px)?\s*$/.exec(arg);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  if (key === 'blur') return m[2] === '%' ? undefined : n;
  return m[2] === '%' ? n : Math.round(n * 100 * 100) / 100;
}

/** The adjustments a filter value holds. Ones written twice count by their last use, as CSS does in effect. */
export function parseImageFilters(value: string | undefined): ImageFilters {
  const out: ImageFilters = {};
  if (!value || value === 'none') return out;
  for (const fn of functionsOf(value)) {
    const m = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(fn);
    if (!m) continue;
    const key = m[1]!.toLowerCase() as ImageFilterKey;
    if (!(key in IMAGE_FILTERS)) continue;
    const n = amount(key, m[2]!);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

function clampFilter(key: ImageFilterKey, n: number): number {
  const spec = IMAGE_FILTERS[key];
  return Math.round(Math.min(spec.max, Math.max(spec.min, n)) * 100) / 100;
}

/**
 * The filter value with these adjustments set. A neutral value or null takes one out. Functions it does not
 * know keep their order, and the adjustments follow them in a fixed order. Returns null for no filter at all.
 */
export function withImageFilters(current: string | undefined, patch: Partial<Record<ImageFilterKey, number | null>>): string | null {
  const kept: string[] = [];
  const known = parseImageFilters(current);
  for (const fn of current && current !== 'none' ? functionsOf(current) : []) {
    const name = /^([a-z-]+)\(/i.exec(fn)?.[1]?.toLowerCase();
    if (!name || !(name in IMAGE_FILTERS)) kept.push(fn);
  }
  const next: ImageFilters = { ...known };
  for (const [k, v] of Object.entries(patch) as [ImageFilterKey, number | null | undefined][]) {
    if (!(k in IMAGE_FILTERS) || v === undefined) continue;
    if (v === null || !Number.isFinite(v)) delete next[k];
    else next[k] = clampFilter(k, v);
  }
  const own = IMAGE_FILTER_KEYS.flatMap((k) => {
    const v = next[k];
    if (v === undefined || v === IMAGE_FILTERS[k].neutral) return [];
    return [`${k}(${v}${IMAGE_FILTERS[k].unit})`];
  });
  const all = [...kept, ...own];
  return all.length ? all.join(' ') : null;
}
