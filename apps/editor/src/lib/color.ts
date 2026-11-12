import { converter, formatHex, formatHex8, parse, type Color } from 'culori';

/** Colour parsing and formatting for the picker. HSV is the working space of the 2D area. */

export interface Hsva { h: number; s: number; v: number; a: number }
export type ColorFormat = 'hex' | 'oklch' | 'p3';

const toHsv = converter('hsv');
const toOklch = converter('oklch');
const toP3 = converter('p3');
const toRgb = converter('rgb');

export function isVar(value: string): boolean {
  return /^var\(--/.test(value.trim());
}

export function varName(value: string): string | null {
  const m = /^var\(--([\w-]+)/.exec(value.trim());
  return m ? m[1]! : null;
}

export function parseToHsva(value: string): Hsva | null {
  const c = parse(value.trim());
  if (!c) return null;
  const hsv = toHsv(c);
  return { h: hsv.h ?? 0, s: hsv.s ?? 0, v: hsv.v ?? 0, a: hsv.alpha ?? 1 };
}

export function hsvaToColor(h: Hsva): Color {
  return { mode: 'hsv', h: h.h, s: h.s, v: h.v, alpha: h.a };
}

const r = (n: number, d = 3) => String(Number((n ?? 0).toFixed(d)));

export function formatColor(h: Hsva, format: ColorFormat): string {
  const c = hsvaToColor(h);
  if (format === 'oklch') {
    const o = toOklch(c);
    return `oklch(${r((o.l ?? 0) * 100, 2)}% ${r(o.c ?? 0, 4)} ${r(o.h ?? 0, 2)}${h.a < 1 ? ` / ${r(h.a, 3)}` : ''})`;
  }
  if (format === 'p3') {
    const p = toP3(c);
    return `color(display-p3 ${r(p.r ?? 0, 4)} ${r(p.g ?? 0, 4)} ${r(p.b ?? 0, 4)}${h.a < 1 ? ` / ${r(h.a, 3)}` : ''})`;
  }
  return (h.a < 1 ? formatHex8(c) : formatHex(c)) ?? '#000000';
}

/** Which format an existing value is written in, so an edit keeps it. */
export function detectFormat(value: string): ColorFormat {
  const v = value.trim().toLowerCase();
  if (v.startsWith('oklch(') || v.startsWith('lch(') || v.startsWith('oklab(') || v.startsWith('lab(')) return 'oklch';
  if (v.startsWith('color(')) return 'p3';
  return 'hex';
}

export function hsvToCssHue(h: number): string {
  return `hsl(${h} 100% 50%)`;
}

export function hexOf(value: string): string {
  const c = parse(value.trim());
  return c ? (formatHex(c) ?? '#000000') : '#000000';
}

export function oklchParts(h: Hsva): { l: number; c: number; h: number } {
  const o = toOklch(hsvaToColor(h));
  return { l: (o.l ?? 0) * 100, c: o.c ?? 0, h: o.h ?? 0 };
}

export function hsvaFromOklch(l: number, c: number, hue: number, a: number): Hsva {
  const v = toHsv({ mode: 'oklch', l: l / 100, c, h: hue, alpha: a });
  return { h: v.h ?? hue, s: v.s ?? 0, v: v.v ?? 0, a };
}

export function p3Parts(h: Hsva): { r: number; g: number; b: number } {
  const p = toP3(hsvaToColor(h));
  return { r: p.r ?? 0, g: p.g ?? 0, b: p.b ?? 0 };
}

export function hsvaFromP3(rr: number, g: number, b: number, a: number): Hsva {
  const v = toHsv({ mode: 'p3', r: rr, g, b, alpha: a });
  return { h: v.h ?? 0, s: v.s ?? 0, v: v.v ?? 0, a };
}

export function rgbParts(h: Hsva): { r: number; g: number; b: number } {
  const c = toRgb(hsvaToColor(h));
  return { r: c.r ?? 0, g: c.g ?? 0, b: c.b ?? 0 };
}
