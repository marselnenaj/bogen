/// <reference path="./opentype.d.ts" />
import * as opentype from 'opentype.js';
import { decompress } from 'woff2-encoder';
import { getFontFaces, type BogenDoc, type StoredFontFace } from '@bogen/core';
import { fetchPublic } from './net-guard.ts';
import type { Storage } from './storage.ts';

// Bundlers take the ES module, where the names are exports; Node takes the UMD build, where they sit on the default.
const ot = ((opentype as unknown as { Font?: unknown }).Font ? opentype : (opentype as unknown as { default: typeof opentype }).default);

/**
 * Text to outlines, for wordmarks and display lines that must look the same everywhere, also where the font is not
 * installed: each line set with opentype.js (MIT) from the very font file the canvas draws, with its kerning and the
 * layer's tracking, as one SVG path in currentColor. The font comes from the file (captured, made here or brought by
 * its brand) or else from Google Fonts.
 */

export interface OutlineStyle {
  /** One family, without fallbacks. */
  family: string;
  /** In px. */
  fontSize: number;
  weight: number;
  italic: boolean;
  /** Extra space between letters in px, as CSS letter-spacing. */
  letterSpacing: number;
  /** Distance between baselines in px, or null for the font's own. */
  lineHeight: number | null;
  align: 'left' | 'center' | 'right';
  transform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  /** CSS font-kerning: none switches kerning off. */
  kerning: boolean;
}

export interface Outline {
  svg: string;
  /** Size of the SVG in px. */
  width: number;
  height: number;
  /** Characters the font has no glyph for, drawn as its .notdef or left out. */
  missing: string[];
  lines: number;
}

export type FontBytes = { bytes: Uint8Array; source: string };

/** Parses OTF, TTF, WOFF and WOFF2. */
export async function parseFont(bytes: Uint8Array): Promise<opentype.Font> {
  let data = bytes;
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  if (magic === 'wOF2') data = await decompress(bytes);
  if (magic === 'ttcf') throw new Error('That font is a collection, which text_outline cannot read. Give the file one font of it.');
  return ot.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
}

function transformText(text: string, transform: OutlineStyle['transform']): string {
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  if (transform === 'capitalize') return text.replace(/(^|\s)(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
  return text;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Sets text in a font as outlines. `bounds: 'ink'` crops the SVG to the drawn shapes, as a wordmark wants for its
 * clear space; `'text'` keeps the line boxes, so the outline sits where the text did.
 */
export function outlineText(font: opentype.Font, text: string, style: OutlineStyle, bounds: 'ink' | 'text' = 'ink'): Outline {
  const scale = style.fontSize / font.unitsPerEm;
  const ascent = font.ascender * scale;
  const descent = -Math.min(0, font.descender) * scale;
  const gap = Number((font.tables.hhea as { lineGap?: number } | undefined)?.lineGap ?? 0) * scale;
  const lineHeight = style.lineHeight ?? ascent + descent + gap;
  const lines = transformText(text, style.transform).replace(/\r\n?/g, '\n').split('\n');
  const options = { kerning: style.kerning, letterSpacing: style.letterSpacing / style.fontSize };
  const missing = new Set<string>();
  const widths = lines.map((line) => {
    for (const ch of line) if (!/\s/.test(ch) && font.charToGlyph(ch).index === 0) missing.add(ch);
    // Like CSS, opentype.js puts the letter-spacing after every character, the last one too.
    return font.getAdvanceWidth(line, style.fontSize, options);
  });
  const boxWidth = Math.max(0, ...widths);
  // Half-leading as in CSS: the line box is lineHeight tall, the glyphs' ascent and descent centred in it.
  const half = (lineHeight - (ascent + descent)) / 2;
  const parts: string[] = [];
  let ink = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  lines.forEach((line, i) => {
    const w = widths[i]!;
    const x = style.align === 'center' ? (boxWidth - w) / 2 : style.align === 'right' ? boxWidth - w : 0;
    const baseline = i * lineHeight + half + ascent;
    const path = font.getPath(line, x, baseline, style.fontSize, options);
    const d = path.toPathData(2);
    if (!d) return;
    parts.push(d);
    const b = path.getBoundingBox();
    ink = { x1: Math.min(ink.x1, b.x1), y1: Math.min(ink.y1, b.y1), x2: Math.max(ink.x2, b.x2), y2: Math.max(ink.y2, b.y2) };
  });
  const d = parts.join('');
  const textBox = { x1: 0, y1: 0, x2: boxWidth, y2: lines.length * lineHeight };
  const box = bounds === 'ink' && Number.isFinite(ink.x1) ? ink : textBox;
  const width = Math.max(1, round(box.x2 - box.x1));
  const height = Math.max(1, round(box.y2 - box.y1));
  const viewBox = `${round(box.x1)} ${round(box.y1)} ${width} ${height}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" fill="currentColor"><path d="${d}"/></svg>`;
  return { svg, width, height, missing: [...missing], lines: lines.length };
}

/** `U+0-FF, U+131` to a test for one code point. No range means every code point. */
function rangeTest(range: string | undefined): (cp: number) => boolean {
  if (!range) return () => true;
  const spans = range.split(',').map((r) => r.trim().replace(/^U\+/i, '')).map((r) => {
    if (r.includes('?')) return [parseInt(r.replace(/\?/g, '0'), 16), parseInt(r.replace(/\?/g, 'f'), 16)] as const;
    const [a, b] = r.split('-');
    return [parseInt(a!, 16), parseInt(b ?? a!, 16)] as const;
  });
  return (cp) => spans.some(([a, b]) => cp >= a && cp <= b);
}

/** How well a face's weight matches: 0 for exact, more for further away. A range such as `100 900` contains. */
function weightDistance(face: string | undefined, want: number): number {
  const [a, b] = (face ?? '400').split(/\s+/).map(Number);
  const lo = a ?? 400;
  const hi = b ?? lo;
  if (want >= lo && want <= hi) return 0;
  return Math.min(Math.abs(want - lo), Math.abs(want - hi));
}

/** The stored faces that draw this family and these characters, best first. */
export function pickFaces(faces: StoredFontFace[], family: string, weight: number, italic: boolean, text: string): StoredFontFace[] {
  const cps = [...new Set([...text].filter((c) => !/\s/.test(c)).map((c) => c.codePointAt(0)!))];
  const want = family.toLowerCase();
  return faces
    .filter((f) => f.src && f.family.toLowerCase() === want)
    .filter((f) => cps.every(rangeTest(f.unicodeRange)) || cps.some(rangeTest(f.unicodeRange)))
    .map((f) => ({ f, score: weightDistance(f.weight, weight) * 10 + ((f.style ?? 'normal').startsWith('italic') || (f.style ?? '').startsWith('oblique') ? (italic ? 0 : 5000) : italic ? 5000 : 0) + (cps.every(rangeTest(f.unicodeRange)) ? 0 : 1000) }))
    .sort((a, b) => a.score - b.score)
    .map((x) => x.f);
}

export const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** The @font-face blocks of a Google Fonts stylesheet, as faces with remote sources. */
export function googleFaces(css: string, family: string): { url: string; weight?: string; style?: string; unicodeRange?: string }[] {
  const out: { url: string; weight?: string; style?: string; unicodeRange?: string }[] = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1]!;
    const fam = /font-family:\s*['"]?([^;'"]+)/.exec(body)?.[1]?.trim();
    if (fam && fam.toLowerCase() !== family.toLowerCase()) continue;
    const url = /url\((https:\/\/fonts\.gstatic\.com\/[^)\s'"]+)\)/.exec(body)?.[1];
    if (!url) continue;
    out.push({ url, weight: /font-weight:\s*([^;]+)/.exec(body)?.[1]?.trim(), style: /font-style:\s*([^;]+)/.exec(body)?.[1]?.trim(), unicodeRange: /unicode-range:\s*([^;]+)/.exec(body)?.[1]?.trim() });
  }
  return out;
}

export interface FontSources {
  storage: Pick<Storage, 'readAsset'>;
  /** Fetches a public URL; absent offline or in tests. */
  fetch?: (url: string, headers?: Record<string, string>) => Promise<Uint8Array>;
}

export const publicFetch: NonNullable<FontSources['fetch']> = async (url, headers) => (await fetchPublic(url, { timeoutMs: 8000, maxBytes: 8 * 1024 * 1024, headers: headers ?? {} })).bytes;

/** The font file the canvas uses for this family, weight and style, from the file, else from Google Fonts. */
export async function fontFor(doc: BogenDoc, sources: FontSources, family: string, weight: number, italic: boolean, text: string): Promise<FontBytes> {
  for (const face of pickFaces(getFontFaces(doc), family, weight, italic, text)) {
    const name = /^bogen-asset:(.+)$/.exec(face.src ?? '')?.[1];
    if (!name) continue;
    const asset = await sources.storage.readAsset(name);
    if (asset) return { bytes: asset.bytes, source: `the file's font ${face.family} ${face.weight ?? 400}${face.style && face.style !== 'normal' ? ` ${face.style}` : ''}` };
  }
  if (!sources.fetch) throw new Error(`${family} is not stored in this file, and Bogen could not fetch it here. Add the font to the file or its brand (brand_asset_add with a font file), then try again.`);
  const name = encodeURIComponent(family).replace(/%20/g, '+');
  const href = `https://fonts.googleapis.com/css2?family=${name}:ital,wght@${italic ? 1 : 0},${weight}&display=swap`;
  let css: string;
  try {
    css = Buffer.from(await sources.fetch(href, { 'user-agent': UA })).toString('utf8');
  } catch {
    throw new Error(`${family} at weight ${weight}${italic ? ' italic' : ''} is not in this file and not on Google Fonts (or Google Fonts could not be reached). Add the font file to the file or its brand, then try again.`);
  }
  const faces = googleFaces(css, family).map((f) => ({ family, src: f.url, weight: f.weight, style: f.style, unicodeRange: f.unicodeRange }));
  const best = pickFaces(faces, family, weight, italic, text)[0];
  if (!best) throw new Error(`Google Fonts has no ${family} face for these characters.`);
  return { bytes: await sources.fetch(best.src!), source: `${family} ${best.weight ?? weight} from Google Fonts` };
}

/** The first family of a font-family list. */
export function firstFamilyOf(value: string): string {
  return (value.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '');
}

/** A computed CSS length in px, or null for `normal` and anything else. */
export function px(value: string | undefined): number | null {
  const m = /^(-?[\d.]+)px$/.exec((value ?? '').trim());
  return m ? Number(m[1]) : null;
}
