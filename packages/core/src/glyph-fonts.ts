import { parseDocument } from 'htmlparser2';
import { isTag, type Element } from 'domhandler';
import * as Y from 'yjs';
import type { BogenDoc, NewNode } from './doc.ts';
import { boundsOf, ellipsePath, multiplyM, parseD, parseTransformAttr, pathToD, roundedRectPath, transformPaths, type Matrix, type SubPath } from './vector-paths.ts';

/**
 * Fonts drawn in a file. A font lives on a page of its own as glyph cells: one frame per glyph on a shared em grid,
 * named by its character, whose width is the advance and whose vector layers are the outline. The record here holds
 * what the cells do not: names, metrics, kerning, where the font came from and its last build.
 *
 * Coordinates of a cell, as agents write them and the canvas draws them: font units, y down, 0 on the ascender
 * line. So the baseline is at y = ascender, the cap height at ascender - capHeight, and the descender line at
 * ascender - descender (the descender is negative, as in a font file).
 */
export interface GlyphFontMetrics {
  unitsPerEm: number;
  ascender: number;
  capHeight: number;
  xHeight: number;
  /** Below the baseline, so negative. */
  descender: number;
}

export interface KerningPair { left: string; right: string; value: number }

export interface GlyphFontOrigin {
  kind: 'scratch' | 'derived';
  /** The family it was made from, for a derived font. */
  from?: string;
  /** The licence of the source, such as OFL-1.1. */
  license?: string;
  reservedNames?: string[];
}

export interface GlyphFontBuild {
  at: number;
  otf: string;
  woff2: string;
  glyphs: number;
  kerning: number;
  /** What the cells, metrics and names were when it was built: a different hash means it changed since. */
  hash: string;
  notes: string[];
  by?: string;
}

export interface GlyphFont {
  id: string;
  pageId: string;
  /** The artboard that holds the cells. */
  rootId: string;
  family: string;
  style: string;
  weight: number;
  italic: boolean;
  metrics: GlyphFontMetrics;
  /** Pixels per font unit on the canvas. */
  scale: number;
  kerning: KerningPair[];
  designer?: string;
  version?: string;
  copyright?: string;
  /** A short licence name such as OFL-1.1, or a sentence. */
  license?: string;
  licenseUrl?: string;
  /** The licence text kept with the font, as a `bogen-asset:` text file. */
  licenseText?: string;
  origin: GlyphFontOrigin;
  build?: GlyphFontBuild;
  createdAt: number;
}

const MAP_NAME = 'glyphFonts';
export const GLYPH_ATTR = 'data-glyph';
export const UNICODE_ATTR = 'data-unicode';
export const ADVANCE_ATTR = 'data-advance';
export const PART_ATTR = 'data-glyph-part';
export const FONT_ROOT_ATTR = 'data-glyph-font';
export const SPECIMEN_ATTR = 'data-glyph-specimen';
/** Height of the strip under a cell that names its glyph, in px. */
export const CELL_LABEL = 24;
/** A new font's em box is this many px tall on the canvas, whatever the units per em. */
export const EM_PX = 200;
export const GLYPH_ROOT_WIDTH = 1280;
export const FAMILY_NAME = /^[\p{L}\p{N} _.+-]{1,60}$/u;

export const DEFAULT_METRICS: GlyphFontMetrics = { unitsPerEm: 1000, ascender: 800, capHeight: 700, xHeight: 500, descender: -200 };

export const GUIDE_COLORS = { ascender: '#c9c6bb', capHeight: '#2b3df2', xHeight: '#7d8bff', baseline: '#f2361f', descender: '#c9c6bb' } as const;

function fontMap(doc: BogenDoc): Y.Map<unknown> {
  return doc.y.getMap(MAP_NAME);
}

function isFont(v: unknown): v is GlyphFont {
  return Boolean(v) && typeof v === 'object' && typeof (v as GlyphFont).id === 'string' && typeof (v as GlyphFont).family === 'string' && typeof (v as GlyphFont).metrics === 'object';
}

export function getGlyphFonts(doc: BogenDoc): GlyphFont[] {
  const out: GlyphFont[] = [];
  fontMap(doc).forEach((v) => {
    if (isFont(v) && doc.pages.has(v.pageId)) out.push(v);
  });
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function getGlyphFont(doc: BogenDoc, id: string): GlyphFont | undefined {
  const v = fontMap(doc).get(id);
  return isFont(v) && doc.pages.has(v.pageId) ? v : undefined;
}

export function glyphFontOfPage(doc: BogenDoc, pageId: string): GlyphFont | undefined {
  return getGlyphFonts(doc).find((f) => f.pageId === pageId);
}

/** Stores the whole record. Called inside the caller's transaction. */
export function setGlyphFont(doc: BogenDoc, font: GlyphFont): void {
  fontMap(doc).set(font.id, JSON.parse(JSON.stringify(font)) as GlyphFont);
}

export function deleteGlyphFont(doc: BogenDoc, id: string): void {
  fontMap(doc).delete(id);
}

/** The shared map an undo manager has to track so that undoing font_create or font_build takes back the record too. */
export function glyphFontsUndoScope(doc: BogenDoc): Y.Map<unknown>[] {
  return [fontMap(doc)];
}

export function observeGlyphFonts(doc: BogenDoc, listener: () => void): () => void {
  const map = fontMap(doc);
  map.observe(listener);
  return () => map.unobserve(listener);
}

/** What text uses: the family with a fallback. */
export function glyphFontStack(font: Pick<GlyphFont, 'family'>): string {
  return `"${font.family}", sans-serif`;
}

/** Problems with metrics, in words. Empty when they make sense. */
export function metricsProblems(m: GlyphFontMetrics): string[] {
  const out: string[] = [];
  if (!(m.unitsPerEm >= 16 && m.unitsPerEm <= 16384)) out.push('units per em must be between 16 and 16384 (1000 or 2048 are usual).');
  if (!(m.ascender > 0)) out.push('the ascender must be above the baseline, so positive.');
  if (!(m.descender <= 0)) out.push('the descender must be at or below the baseline, so 0 or negative.');
  if (!(m.capHeight > 0 && m.capHeight <= m.ascender)) out.push('the cap height must be above the baseline and at most the ascender.');
  if (!(m.xHeight > 0 && m.xHeight <= m.capHeight)) out.push('the x-height must be above the baseline and at most the cap height.');
  if (m.ascender - m.descender > m.unitsPerEm * 2) out.push('ascender to descender is more than two ems.');
  return out;
}

// ------------------------------------------------------------------ glyph names

const AGL: Record<string, string> = {
  ' ': 'space', '!': 'exclam', '"': 'quotedbl', '#': 'numbersign', $: 'dollar', '%': 'percent', '&': 'ampersand', "'": 'quotesingle',
  '(': 'parenleft', ')': 'parenright', '*': 'asterisk', '+': 'plus', ',': 'comma', '-': 'hyphen', '.': 'period', '/': 'slash',
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
  ':': 'colon', ';': 'semicolon', '<': 'less', '=': 'equal', '>': 'greater', '?': 'question', '@': 'at', '[': 'bracketleft',
  '\\': 'backslash', ']': 'bracketright', '^': 'asciicircum', _: 'underscore', '`': 'grave', '{': 'braceleft', '|': 'bar',
  '}': 'braceright', '~': 'asciitilde', ' ': 'uni00A0', '–': 'endash', '—': 'emdash', '‘': 'quoteleft',
  '’': 'quoteright', '“': 'quotedblleft', '”': 'quotedblright', '…': 'ellipsis', 'ä': 'adieresis',
  'ö': 'odieresis', 'ü': 'udieresis', 'Ä': 'Adieresis', 'Ö': 'Odieresis', 'Ü': 'Udieresis', 'ß': 'germandbls',
  'é': 'eacute', 'É': 'Eacute', 'è': 'egrave', 'à': 'agrave', 'ç': 'ccedilla', '€': 'Euro',
};
const AGL_BACK = new Map(Object.entries(AGL).map(([c, n]) => [n, c]));
const NAME = /^[A-Za-z_.][A-Za-z0-9_.]{0,62}$/;

/** The PostScript glyph name of a character: A, a, zero, period, or uniXXXX. */
export function glyphNameOf(char: string): string {
  if (AGL[char]) return AGL[char];
  const cp = char.codePointAt(0)!;
  if (/^[A-Za-z]$/.test(char)) return char;
  return cp > 0xffff ? `u${cp.toString(16).toUpperCase().padStart(5, '0')}` : `uni${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** The character a glyph name stands for, if it stands for one. */
export function charOfGlyphName(name: string): string | undefined {
  if (AGL_BACK.has(name)) return AGL_BACK.get(name);
  if (/^[A-Za-z]$/.test(name)) return name;
  const m = /^uni([0-9A-F]{4})$/.exec(name) ?? /^u([0-9A-F]{4,6})$/.exec(name);
  return m ? String.fromCodePoint(parseInt(m[1]!, 16)) : undefined;
}

export function isGlyphName(name: string): boolean {
  return NAME.test(name) || name === '.notdef';
}

/** What a cell is called on the canvas: the character itself when it can be seen, else the glyph name. */
export function cellLabel(name: string, unicodes: number[]): string {
  const c = unicodes[0] !== undefined ? String.fromCodePoint(unicodes[0]) : undefined;
  return c && /\S/.test(c) && unicodes[0]! >= 0x21 ? c : name;
}

/** A glyph named by a character, a glyph name, or both, with its code points. */
export function resolveGlyphRef(ref: { char?: string; name?: string; unicode?: string | number }): { name: string; unicodes: number[] } {
  let unicodes: number[] = [];
  if (ref.char !== undefined) {
    const chars = [...ref.char];
    if (chars.length !== 1) throw new Error(`char must be one character, not "${ref.char}". For a ligature or an alternate, give name (such as "f_i" or "a.alt") without char.`);
    unicodes = [chars[0]!.codePointAt(0)!];
  }
  if (ref.unicode !== undefined) {
    const cp = typeof ref.unicode === 'number' ? ref.unicode : parseInt(String(ref.unicode).replace(/^(U\+|0x)/i, ''), 16);
    if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) throw new Error(`unicode ${ref.unicode} is not a code point. Write it as hex, such as "0041" or "U+0041".`);
    if (!unicodes.includes(cp)) unicodes.push(cp);
  }
  const name = ref.name ?? (unicodes[0] !== undefined ? glyphNameOf(String.fromCodePoint(unicodes[0])) : undefined);
  if (!name) throw new Error('Name each glyph with char (such as "A") or name (such as "A.alt").');
  if (!isGlyphName(name)) throw new Error(`"${name}" is not a glyph name: letters, digits, _ and ., starting with a letter, _ or ., at most 63 long.`);
  if (!ref.name && !ref.char && ref.unicode === undefined) throw new Error('Name each glyph with char or name.');
  if (unicodes.length === 0) {
    const c = charOfGlyphName(name);
    if (c) unicodes = [c.codePointAt(0)!];
  }
  return { name, unicodes };
}

/** A kerning side given as a character or a glyph name, as the glyph name. */
export function kerningSide(side: string): string {
  if ([...side].length === 1) return glyphNameOf(side);
  return side;
}

// ------------------------------------------------------------------ layers

export function scaleFor(metrics: GlyphFontMetrics): number {
  return EM_PX / (metrics.ascender - metrics.descender || metrics.unitsPerEm);
}

/** How tall the em box of a cell is on the canvas, in px. The scale stays when metrics change, so this follows them. */
export function emPx(font: Pick<GlyphFont, 'metrics' | 'scale'>): number {
  return (font.metrics.ascender - font.metrics.descender) * font.scale;
}

/** Where the guides sit in a cell, in font units from the top: the y values agents draw against. */
export function guideLines(m: GlyphFontMetrics): { ascender: number; capHeight: number; xHeight: number; baseline: number; descender: number } {
  return { ascender: 0, capHeight: m.ascender - m.capHeight, xHeight: m.ascender - m.xHeight, baseline: m.ascender, descender: m.ascender - m.descender };
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const px = (n: number) => `${fmt(n)}px`;

function guideSpec(font: GlyphFont, width: number): NewNode {
  const s = font.scale;
  const g = guideLines(font.metrics);
  const line = (name: string, y: number, color: string, dashed = false): NewNode => ({
    type: 'frame', tag: 'div', name,
    style: { position: 'absolute', left: '0px', top: px(Math.min(y * s, emPx(font) - 1)), width: '100%', height: dashed ? '0px' : '1px', ...(dashed ? { borderTop: `1px dashed ${color}` } : { background: color }) },
  });
  const m = font.metrics;
  return {
    type: 'frame', tag: 'div', name: 'Guides', attrs: { [PART_ATTR]: 'guides', 'aria-hidden': 'true' },
    style: { position: 'absolute', left: '0px', top: '0px', width: px(width), height: px(emPx(font)), pointerEvents: 'none' },
    children: [
      line(`Ascender ${m.ascender}`, g.ascender, GUIDE_COLORS.ascender),
      line(`Cap height ${m.capHeight}`, g.capHeight, GUIDE_COLORS.capHeight),
      line(`x-height ${m.xHeight}`, g.xHeight, GUIDE_COLORS.xHeight, true),
      line('Baseline 0', g.baseline, GUIDE_COLORS.baseline),
      line(`Descender ${m.descender}`, g.descender, GUIDE_COLORS.descender),
    ],
  };
}

/** The svg of an outline in cell coordinates. The path data is written again from parsed numbers, so it is clean. */
export function outlineSvg(font: GlyphFont, advance: number, paths: SubPath[], fillRule: 'nonzero' | 'evenodd' = 'nonzero'): string {
  const h = font.metrics.ascender - font.metrics.descender;
  const d = pathToD(paths);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(advance)} ${fmt(h)}" width="100%" height="100%" preserveAspectRatio="none" overflow="visible"><path d="${d}" fill="#0e0e0c"${fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}/></svg>`;
}

export function outlineSpec(font: GlyphFont, advance: number, paths: SubPath[], fillRule: 'nonzero' | 'evenodd' = 'nonzero'): NewNode {
  return {
    type: 'svg', tag: 'svg', name: 'Outline', attrs: { [PART_ATTR]: 'outline' }, svg: outlineSvg(font, advance, paths, fillRule),
    style: { position: 'absolute', left: '0px', top: '0px', width: px(advance * font.scale), height: px(emPx(font)), overflow: 'visible' },
  };
}

export function cellSpec(font: GlyphFont, glyph: { name: string; unicodes: number[]; advance: number; paths?: SubPath[]; fillRule?: 'nonzero' | 'evenodd' }): NewNode {
  const w = glyph.advance * font.scale;
  const label = cellLabel(glyph.name, glyph.unicodes);
  return {
    type: 'frame', tag: 'div', name: label,
    attrs: { [GLYPH_ATTR]: glyph.name, [UNICODE_ATTR]: glyph.unicodes.map((u) => u.toString(16).toUpperCase().padStart(4, '0')).join(' '), [ADVANCE_ATTR]: String(Math.round(glyph.advance)) },
    style: { position: 'relative', width: px(w), height: px(emPx(font) + CELL_LABEL), flexShrink: '0', background: '#ffffff' },
    children: [
      guideSpec(font, w),
      ...(glyph.paths?.length ? [outlineSpec(font, glyph.advance, glyph.paths, glyph.fillRule)] : []),
      { type: 'text', tag: 'span', name: 'Label', text: label, attrs: { [PART_ATTR]: 'label' }, style: { position: 'absolute', left: '0px', top: px(emPx(font) + 4), fontFamily: 'system-ui, sans-serif', fontSize: '12px', lineHeight: '16px', color: '#5f5d55', whiteSpace: 'nowrap' } },
    ],
  };
}

export function glyphRootSpec(font: Pick<GlyphFont, 'id' | 'family'>, x: number, y: number): NewNode {
  return {
    type: 'frame', tag: 'section', name: `${font.family} glyphs`, artboard: true, attrs: { [FONT_ROOT_ATTR]: font.id },
    style: { position: 'absolute', left: px(x), top: px(y), width: px(GLYPH_ROOT_WIDTH), display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '24px 16px', padding: '32px', background: '#ebe8df' },
  };
}

/** The cells of a font, in canvas order. */
export function glyphCells(doc: BogenDoc, font: GlyphFont): { id: string; name: string; unicodes: number[] }[] {
  return doc.getChildren(font.rootId).flatMap((n) => {
    const name = n.attrs?.[GLYPH_ATTR];
    if (n.type !== 'frame' || !name) return [];
    return [{ id: n.id, name, unicodes: parseUnicodes(n.attrs?.[UNICODE_ATTR]) }];
  });
}

export function parseUnicodes(value: string | undefined): number[] {
  return (value ?? '').split(/[\s,]+/).filter(Boolean).map((h) => parseInt(h, 16)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 0x10ffff);
}

const PX = /^(-?\d+(?:\.\d+)?)px$/;
const pxOf = (v: string | undefined): number | undefined => {
  const m = PX.exec(v ?? '');
  return m ? Number(m[1]) : undefined;
};

/** The advance of a cell: its width on the canvas in font units, or what it was written with. */
export function cellAdvance(doc: BogenDoc, font: GlyphFont, cellId: string): number {
  const node = doc.getNode(cellId);
  const w = pxOf(node?.style.width);
  if (w !== undefined) return Math.max(0, Math.round(w / font.scale));
  return Math.max(0, Math.round(Number(node?.attrs?.[ADVANCE_ATTR]) || 0));
}

// ------------------------------------------------------------------ reading outlines

/** One closed contour in font units, y up, and how much of the outline came from where. */
export interface CompiledGlyph {
  cellId: string;
  name: string;
  unicodes: number[];
  advance: number;
  /** Font units, y up, baseline at 0. */
  contours: SubPath[];
  notes: string[];
}

function attr(el: Element, name: string): string | undefined {
  const own = el.attribs[name];
  if (own !== undefined) return own;
  const style = el.attribs.style;
  if (!style) return undefined;
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style);
  return m?.[1]?.trim();
}

const num = (v: string | undefined, d = 0) => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : d;
};

function elementShape(el: Element): SubPath[] {
  switch (el.name.toLowerCase()) {
    case 'path': return parseD(el.attribs.d ?? '');
    case 'rect': {
      const w = num(el.attribs.width), h = num(el.attribs.height);
      const r = num(el.attribs.rx ?? el.attribs.ry);
      return w > 0 && h > 0 ? [roundedRectPath(num(el.attribs.x), num(el.attribs.y), w, h, [r, r, r, r])] : [];
    }
    case 'circle': {
      const r = num(el.attribs.r);
      return r > 0 ? [ellipsePath(num(el.attribs.cx) - r, num(el.attribs.cy) - r, r * 2, r * 2)] : [];
    }
    case 'ellipse': {
      const rx = num(el.attribs.rx), ry = num(el.attribs.ry);
      return rx > 0 && ry > 0 ? [ellipsePath(num(el.attribs.cx) - rx, num(el.attribs.cy) - ry, rx * 2, ry * 2)] : [];
    }
    case 'polygon': case 'polyline': {
      const v = (el.attribs.points ?? '').trim().split(/[\s,]+/).map(parseFloat);
      const points = [];
      for (let i = 0; i + 1 < v.length; i += 2) if (Number.isFinite(v[i]) && Number.isFinite(v[i + 1])) points.push({ x: v[i]!, y: v[i + 1]! });
      return points.length > 2 ? [{ closed: true, points }] : [];
    }
    default: return [];
  }
}

/** The matrix from svg user space to the layer's own pixels, from its viewBox and preserveAspectRatio. */
function viewBoxMatrix(root: Element, w: number, h: number): Matrix {
  const vb = (root.attribs.viewBox ?? root.attribs.viewbox ?? '').trim().split(/[\s,]+/).map(parseFloat);
  if (vb.length !== 4 || vb.some((v) => !Number.isFinite(v)) || vb[2]! <= 0 || vb[3]! <= 0) return [1, 0, 0, 1, 0, 0];
  const [vx, vy, vw, vh] = vb as [number, number, number, number];
  const par = (root.attribs.preserveAspectRatio ?? 'xMidYMid meet').trim();
  if (par.startsWith('none')) return [w / vw, 0, 0, h / vh, (-vx * w) / vw, (-vy * h) / vh];
  const slice = par.includes('slice');
  const s = slice ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
  const ax = /xMin/.test(par) ? 0 : /xMax/.test(par) ? 1 : 0.5;
  const ay = /YMin/.test(par) ? 0 : /YMax/.test(par) ? 1 : 0.5;
  return [s, 0, 0, s, (w - vw * s) * ax - vx * s, (h - vh * s) * ay - vy * s];
}

const SKIP = new Set(['defs', 'clippath', 'mask', 'marker', 'symbol', 'pattern', 'lineargradient', 'radialgradient', 'filter', 'title', 'desc', 'style', 'metadata', 'text']);

export interface DrawnShape { paths: SubPath[]; evenodd: boolean; /** The fill as written, or black, the default. */ fill: string }

/** Filled shapes of svg markup, in the layer's pixels, one entry per element. Strokes without a fill are counted apart. */
export function svgFilledShapes(markup: string, w: number, h: number): { shapes: DrawnShape[]; strokeOnly: number; text: boolean } {
  const root = parseDocument(markup, { xmlMode: true }).children.find((c): c is Element => isTag(c) && c.name.toLowerCase() === 'svg');
  const out: DrawnShape[] = [];
  let strokeOnly = 0;
  let text = false;
  if (!root) return { shapes: out, strokeOnly, text };
  const walk = (el: Element, at: Matrix, fill: string | undefined, rule: string | undefined) => {
    const name = el.name.toLowerCase();
    if (name === 'text') text = true;
    if (SKIP.has(name)) return;
    if (attr(el, 'display') === 'none' || attr(el, 'visibility') === 'hidden') return;
    const here = multiplyM(at, parseTransformAttr(el.attribs.transform));
    const f = attr(el, 'fill') ?? fill;
    const r = attr(el, 'fill-rule') ?? rule;
    const shape = elementShape(el);
    if (shape.length) {
      const opacity = attr(el, 'fill-opacity') ?? attr(el, 'opacity');
      if (f === 'none' || f === 'transparent' || (opacity !== undefined && num(opacity, 1) === 0)) {
        const stroke = attr(el, 'stroke');
        if (stroke && stroke !== 'none') strokeOnly++;
      } else out.push({ paths: transformPaths(shape, here), evenodd: r === 'evenodd', fill: (f ?? '#000000').trim().toLowerCase() });
    }
    for (const c of el.children) if (isTag(c)) walk(c, here, f, r);
  };
  const base = viewBoxMatrix(root, w, h);
  for (const c of root.children) if (isTag(c)) walk(c, base, attr(root, 'fill'), attr(root, 'fill-rule'));
  return { shapes: out, strokeOnly, text };
}

/** Points along a contour, for areas and containment. Curves are sampled. */
function flatten(sub: SubPath, steps = 8): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const n = sub.points.length;
  for (let i = 0; i < n; i++) {
    const a = sub.points[i]!;
    const b = sub.points[(i + 1) % n]!;
    pts.push({ x: a.x, y: a.y });
    if (a.hx2 === undefined && b.hx1 === undefined) continue;
    const x1 = a.hx2 ?? a.x, y1 = a.hy2 ?? a.y, x2 = b.hx1 ?? b.x, y2 = b.hy1 ?? b.y;
    for (let k = 1; k < steps; k++) {
      const t = k / steps, u = 1 - t;
      pts.push({ x: u * u * u * a.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * b.y });
    }
  }
  return pts;
}

/** Signed area, positive for counter-clockwise in y-up coordinates. */
export function contourArea(sub: SubPath): number {
  const p = flatten(sub);
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i]!, r = p[(i + 1) % p.length]!;
    a += q.x * r.y - r.x * q.y;
  }
  return a / 2;
}

function inside(pt: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

export function reverseContour(sub: SubPath): SubPath {
  const pts = [...sub.points].reverse().map((p) => ({
    x: p.x, y: p.y,
    ...(p.hx2 !== undefined ? { hx1: p.hx2, hy1: p.hy2 } : {}),
    ...(p.hx1 !== undefined ? { hx2: p.hx1, hy2: p.hy1 } : {}),
  }));
  return { closed: true, points: pts };
}

/**
 * Whether a contour lies within another: nearly all of its points are inside. Parts that only overlap, such as a
 * bar across a stem, are not within each other; a counter is. Points on the other's edge can count either way.
 */
function within(points: { x: number; y: number }[], other: { x: number; y: number }[]): boolean {
  if (other.length < 3 || !points.length) return false;
  let hits = 0;
  for (const p of points) if (inside(p, other)) hits++;
  return hits >= points.length * 0.9;
}

/** For each contour, the contours it lies within. */
function containers(contours: SubPath[]): number[][] {
  const flat = contours.map((c) => flatten(c));
  return flat.map((f, i) => flat.flatMap((other, j) => (j !== i && within(f, other) ? [j] : [])));
}

/** How many of the other contours each contour lies within. */
function depths(contours: SubPath[]): number[] {
  return containers(contours).map((c) => c.length);
}

/** Contours with even-odd filling turned into the nonzero directions a font needs: outer ones counter-clockwise, holes the other way. */
export function evenOddToNonzero(contours: SubPath[]): SubPath[] {
  const d = depths(contours);
  return contours.map((c, i) => ((contourArea(c) > 0) === (d[i]! % 2 === 0) ? c : reverseContour(c)));
}

/** The px offset of a layer inside a cell, through any frames between them. */
function offsetInCell(doc: BogenDoc, id: string, cellId: string): { x: number; y: number } | null {
  let x = 0, y = 0;
  let cur = doc.getNode(id);
  while (cur && cur.id !== cellId) {
    x += pxOf(cur.style.left) ?? 0;
    y += pxOf(cur.style.top) ?? 0;
    if (cur.style.transform && cur.style.transform !== 'none') return null;
    cur = doc.getNode(cur.parent);
  }
  return cur ? { x, y } : null;
}

/** Every outline layer of a cell, in font units. Guides, labels and hidden layers do not count. */
export function readCell(doc: BogenDoc, font: GlyphFont, cellId: string): { contours: SubPath[]; notes: string[] } {
  const notes: string[] = [];
  const contours: SubPath[] = [];
  const cell = doc.getNode(cellId);
  if (!cell) return { contours, notes };
  const cellW = pxOf(cell.style.width) ?? 0;
  const s = font.scale;
  const asc = font.metrics.ascender;
  const skipped = new Set<string>();
  for (const n of doc.descendants(cellId)) {
    if (n.hidden || n.attrs?.[PART_ATTR] === 'guides' || n.attrs?.[PART_ATTR] === 'label') skipped.add(n.id);
    if (skipped.has(n.parent)) skipped.add(n.id);
  }
  let texts = 0;
  for (const n of doc.descendants(cellId)) {
    if (skipped.has(n.id)) continue;
    if (n.type === 'text') texts++;
    if (n.type !== 'svg' || !n.svg) continue;
    const off = offsetInCell(doc, n.id, cellId);
    if (!off) {
      notes.push(`${n.name} is rotated or transformed with CSS, so it was left out. Apply the transform to its paths instead.`);
      continue;
    }
    const w = pxOf(n.style.width) ?? cellW;
    const h = pxOf(n.style.height) ?? emPx(font);
    const { shapes, strokeOnly, text } = svgFilledShapes(n.svg, w, h);
    if (strokeOnly) notes.push(`${strokeOnly} stroked shape${strokeOnly === 1 ? '' : 's'} without a fill ${strokeOnly === 1 ? 'was' : 'were'} left out: a font has only filled outlines. Draw the stroke as a filled shape.`);
    if (text) notes.push('Text inside an svg is not part of the outline.');
    // Layer px to font units, y up.
    const toFont: Matrix = [1 / s, 0, 0, -1 / s, off.x / s, asc - off.y / s];
    for (const shape of shapes) {
      const inFont = transformPaths(shape.paths, toFont).filter((p) => p.points.length > 2 || (p.points.length > 1 && p.points.some((q) => q.hx1 !== undefined || q.hx2 !== undefined)));
      contours.push(...(shape.evenodd ? evenOddToNonzero(inFont) : inFont).map((p) => ({ ...p, closed: true })));
    }
  }
  if (texts) notes.push('Text layers in a cell are not part of the outline; draw the shape as a vector.');
  return { contours, notes };
}

/** Notes on how an outline will come out: holes that fill in, parts outside the cell. */
export function outlineNotes(contours: SubPath[], advance: number, m: GlyphFontMetrics): string[] {
  const out: string[] = [];
  if (!contours.length) return out;
  const inner = containers(contours);
  const areas = contours.map(contourArea);
  contours.forEach((_, i) => {
    if (inner[i]!.length !== 1) return;
    const outer = inner[i]![0]!;
    if (Math.sign(areas[outer]!) === Math.sign(areas[i]!)) out.push(`A contour inside another runs the same way, so it fills in instead of cutting a counter. Reverse it, or give the path fill-rule="evenodd".`);
  });
  const b = boundsOf(contours);
  const tol = m.unitsPerEm * 0.02;
  if (b.x < -tol) out.push(`Reaches ${Math.round(-b.x)} units left of its origin: a negative left side bearing. Fine for an overhang, otherwise move it right.`);
  if (b.x + b.w > advance + tol) out.push(`Reaches ${Math.round(b.x + b.w - advance)} units past its advance on the right. Widen the cell or move the outline in.`);
  if (b.y + b.h > m.ascender + m.unitsPerEm * 0.25) out.push(`Rises ${Math.round(b.y + b.h - m.ascender)} units above the ascender, so lines may touch.`);
  if (b.y < m.descender - m.unitsPerEm * 0.25) out.push(`Drops ${Math.round(m.descender - b.y)} units below the descender, so lines may touch.`);
  return [...new Set(out)];
}

/** The whole page read as glyphs, in cell order. */
export function compileGlyphPage(doc: BogenDoc, font: GlyphFont): { glyphs: CompiledGlyph[]; notes: string[] } {
  const notes: string[] = [];
  const seen = new Set<string>();
  const used = new Map<number, string>();
  const glyphs: CompiledGlyph[] = [];
  for (const cell of glyphCells(doc, font)) {
    if (seen.has(cell.name)) {
      notes.push(`There are two cells for ${cell.name}; the second (${cell.id}) was left out.`);
      continue;
    }
    seen.add(cell.name);
    const unicodes = cell.unicodes.filter((u) => {
      if (used.has(u)) {
        notes.push(`U+${u.toString(16).toUpperCase().padStart(4, '0')} is on both ${used.get(u)} and ${cell.name}; ${cell.name} lost it.`);
        return false;
      }
      used.set(u, cell.name);
      return true;
    });
    const advance = cellAdvance(doc, font, cell.id);
    const read = readCell(doc, font, cell.id);
    glyphs.push({ cellId: cell.id, name: cell.name, unicodes, advance, contours: read.contours, notes: [...read.notes, ...outlineNotes(read.contours, advance, font.metrics)] });
  }
  return { glyphs, notes };
}

/** The outline of a cell in cell coordinates (y down), for a small picture of it. */
export function cellOutlineD(doc: BogenDoc, font: GlyphFont, cellId: string): string {
  const { contours } = readCell(doc, font, cellId);
  return pathToD(transformPaths(contours, [1, 0, 0, -1, 0, font.metrics.ascender]));
}

/** Contours in font units to cell coordinates and back are the same flip. */
export function fontToCell(paths: SubPath[], m: GlyphFontMetrics): SubPath[] {
  return transformPaths(paths, [1, 0, 0, -1, 0, m.ascender]);
}

function fnv(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A fingerprint of everything a build reads. */
export function glyphFontHash(doc: BogenDoc, font: GlyphFont): string {
  const { glyphs } = compileGlyphPage(doc, font);
  const r = (n: number) => Math.round(n);
  const text = JSON.stringify([
    font.family, font.style, font.weight, font.italic, font.metrics, font.kerning, font.designer, font.version, font.copyright, font.license, font.licenseUrl,
    glyphs.map((g) => [g.name, g.unicodes, g.advance, g.contours.map((c) => c.points.map((p) => [r(p.x), r(p.y), p.hx1 === undefined ? null : r(p.hx1), p.hy1 === undefined ? null : r(p.hy1!), p.hx2 === undefined ? null : r(p.hx2), p.hy2 === undefined ? null : r(p.hy2!)]))]),
  ]);
  return fnv(text, 0x811c9dc5) + fnv(text, 0x01000193);
}

// ------------------------------------------------------------------ specimen

export const SPECIMEN_PANGRAM = 'Sphinx of black quartz, judge my vow.';

/**
 * A specimen artboard: name and metrics, a waterfall, a pangram, the person's own words, spacing strings with
 * control characters and kerning pairs. Text is set in the font, so it shows the current build.
 */
export function specimenSpec(font: GlyphFont, options: { chars: string; words?: string; sizes?: number[]; x: number; y: number }): NewNode {
  const stack = glyphFontStack(font);
  const has = (s: string) => [...s].every((c) => c === ' ' || options.chars.includes(c));
  const upperOnly = !/[a-z]/.test(options.chars);
  const pick = (s: string) => (upperOnly ? s.toUpperCase() : s);
  const sample = has('Hamburgefonstiv') ? 'Hamburgefonstiv' : has('HAMBURGEFONSTIV') ? 'HAMBURGEFONSTIV' : [...options.chars].filter((c) => c.trim()).slice(0, 16).join('');
  const label = (text: string): NewNode => ({ type: 'text', tag: 'p', name: 'Label', text, style: { margin: '0px', fontFamily: 'system-ui, sans-serif', fontSize: '13px', lineHeight: '18px', color: '#5f5d55' } });
  const set = (text: string, size: number, name: string): NewNode => ({ type: 'text', tag: 'p', name, text, style: { margin: '0px', fontFamily: stack, fontSize: px(size), lineHeight: '1.15', color: '#0e0e0c', overflowWrap: 'anywhere' } });
  const block = (title: string, children: NewNode[]): NewNode => ({ type: 'frame', tag: 'div', name: title, style: { display: 'flex', flexDirection: 'column', gap: '8px' }, children: [label(title), ...children] });
  const sizes = options.sizes?.length ? options.sizes : [96, 64, 40, 24, 16];
  const m = font.metrics;
  const spacing = [
    has('HOH') ? 'HOHOHOH HHOHH OOHOO' : '',
    has('non') ? 'nnonnon nonon oonoo' : '',
    has('HAVATAW') ? pick('HAVATAWAYLTVA') : '',
  ].filter(Boolean);
  const kernLine = font.kerning.slice(0, 24).map((k) => `${charOfGlyphName(k.left) ?? ''}${charOfGlyphName(k.right) ?? ''}`).filter((s) => [...s].length === 2).join(' ');
  return {
    type: 'frame', tag: 'section', name: `${font.family} specimen`, artboard: true, attrs: { [SPECIMEN_ATTR]: font.id },
    style: { position: 'absolute', left: px(options.x), top: px(options.y), width: '1200px', display: 'flex', flexDirection: 'column', gap: '40px', padding: '64px', background: '#f4f2ec' },
    children: [
      { type: 'frame', tag: 'header', name: 'Name', style: { display: 'flex', flexDirection: 'column', gap: '8px' }, children: [
        set(pick(font.family), 72, 'Family'),
        label(`${font.style}, ${font.weight}. ${[...options.chars].filter((c) => c.trim()).length} characters. ${m.unitsPerEm} units per em, ascender ${m.ascender}, cap height ${m.capHeight}, x-height ${m.xHeight}, descender ${m.descender}.`),
      ] },
      block('Waterfall', sizes.map((s) => set(`${sample} ${has('0123') ? '0123' : ''}`.trim(), s, `${s} px`))),
      ...(options.words ? [block('Your words', [set(pick(options.words), 64, 'Words')])] : []),
      block('Pangram', [set(pick(SPECIMEN_PANGRAM), 40, 'Pangram')]),
      ...(spacing.length ? [block('Spacing', spacing.map((s) => set(s, 48, 'Spacing string')))] : []),
      ...(kernLine ? [block('Kerning pairs', [set(kernLine, 48, 'Kerning pairs')])] : []),
      block('Character set', [set([...options.chars].filter((c) => c.trim()).join(' '), 32, 'Characters')]),
    ],
  };
}

/** An empty box for .notdef, as fonts draw a character they lack. Font units, y up: outer counter-clockwise, hole the other way. */
export function notdefContours(m: GlyphFontMetrics, advance: number): SubPath[] {
  const t = Math.round(m.unitsPerEm * 0.05);
  const x0 = Math.round(advance * 0.1), x1 = Math.round(advance * 0.9);
  const outer = roundedRectPath(x0, 0, x1 - x0, m.capHeight);
  const inner = roundedRectPath(x0 + t, t, x1 - x0 - 2 * t, m.capHeight - 2 * t);
  return [contourArea(outer) > 0 ? outer : reverseContour(outer), contourArea(inner) < 0 ? inner : reverseContour(inner)];
}

// ------------------------------------------------------------------ writing

export interface NewGlyphFont {
  id: string;
  family: string;
  style?: string;
  weight?: number;
  italic?: boolean;
  metrics?: GlyphFontMetrics;
  designer?: string;
  version?: string;
  copyright?: string;
  license?: string;
  licenseUrl?: string;
  licenseText?: string;
  origin?: GlyphFontOrigin;
  kerning?: KerningPair[];
  pageName?: string;
}

/** A page of its own with the glyph artboard on it, and the record. Run inside the caller's transaction. */
export function createGlyphFontPage(doc: BogenDoc, init: NewGlyphFont): GlyphFont {
  const metrics = init.metrics ?? DEFAULT_METRICS;
  const pageId = doc.createPage(init.pageName ?? `${init.family} glyphs`);
  const rootId = doc.insert(pageId, glyphRootSpec({ id: init.id, family: init.family }, 0, 0));
  const font: GlyphFont = {
    id: init.id, pageId, rootId, family: init.family, style: init.style ?? 'Regular', weight: init.weight ?? 400, italic: init.italic ?? false,
    metrics, scale: scaleFor(metrics), kerning: init.kerning ?? [], origin: init.origin ?? { kind: 'scratch' }, createdAt: Date.now(),
    ...(init.designer ? { designer: init.designer } : {}), ...(init.version ? { version: init.version } : {}), ...(init.copyright ? { copyright: init.copyright } : {}),
    ...(init.license ? { license: init.license } : {}), ...(init.licenseUrl ? { licenseUrl: init.licenseUrl } : {}), ...(init.licenseText ? { licenseText: init.licenseText } : {}),
  };
  setGlyphFont(doc, font);
  return font;
}

export function findCell(doc: BogenDoc, font: GlyphFont, name: string): string | undefined {
  return glyphCells(doc, font).find((c) => c.name === name)?.id;
}

/** The outline layers right inside a cell: every vector that is not a guide or the label. */
function outlineLayers(doc: BogenDoc, cellId: string): string[] {
  return doc.getChildren(cellId).filter((n) => n.type === 'svg' && !n.attrs?.[PART_ATTR]?.match(/^(guides|label)$/)).map((n) => n.id);
}

function lockGuides(doc: BogenDoc, cellId: string): void {
  for (const n of doc.getChildren(cellId)) if (n.attrs?.[PART_ATTR] === 'guides') doc.updateFields(n.id, { locked: true });
}

/**
 * Writes one glyph: makes its cell, or changes the one there. `paths` in cell coordinates (y down, 0 at the
 * ascender) replaces the outline; leaving it out keeps the outline. Run inside the caller's transaction.
 */
export function writeGlyph(doc: BogenDoc, font: GlyphFont, g: { name: string; unicodes: number[]; advance?: number; paths?: SubPath[]; fillRule?: 'nonzero' | 'evenodd' }): { cellId: string; created: boolean; advance: number } {
  // Inside one transaction the document remembers children as first read: forget them, so each cell goes after the last.
  doc.invalidate();
  const existing = findCell(doc, font, g.name);
  const box = g.paths?.length ? boundsOf(g.paths) : undefined;
  const fromPaths = box ? Math.round(box.x + box.w + Math.max(0, box.x)) : undefined;
  if (!existing) {
    const advance = Math.max(0, Math.round(g.advance ?? fromPaths ?? font.metrics.unitsPerEm * 0.6));
    const cellId = doc.insert(font.rootId, cellSpec(font, { name: g.name, unicodes: g.unicodes, advance, paths: g.paths, fillRule: g.fillRule }));
    doc.invalidate();
    lockGuides(doc, cellId);
    return { cellId, created: true, advance };
  }
  const before = cellAdvance(doc, font, existing);
  const advance = Math.max(0, Math.round(g.advance ?? before));
  const cell = doc.getNode(existing)!;
  const w = advance * font.scale;
  if (advance !== before) {
    doc.updateStyle(existing, { width: px(w) });
    for (const n of doc.getChildren(existing)) if (n.attrs?.[PART_ATTR] === 'guides') doc.updateStyle(n.id, { width: px(w) });
  }
  const unicodeText = g.unicodes.map((u) => u.toString(16).toUpperCase().padStart(4, '0')).join(' ');
  if ((cell.attrs?.[UNICODE_ATTR] ?? '') !== unicodeText || cell.attrs?.[ADVANCE_ATTR] !== String(advance)) {
    doc.updateFields(existing, { attrs: { ...cell.attrs, [UNICODE_ATTR]: unicodeText, [ADVANCE_ATTR]: String(advance) } });
  }
  if (g.paths) {
    const old = outlineLayers(doc, existing);
    if (old.length) doc.delete(old);
    if (g.paths.length) {
      const at = doc.getChildren(existing).findIndex((n) => n.attrs?.[PART_ATTR] === 'label');
      doc.insert(existing, outlineSpec(font, advance, g.paths, g.fillRule), at < 0 ? undefined : at);
    }
    doc.invalidate();
  }
  return { cellId: existing, created: false, advance };
}

/** Draws the guides of every cell again for new metrics, and keeps outlines where they sit against the baseline. */
export function relayoutGlyphCells(doc: BogenDoc, before: GlyphFont, after: GlyphFont): void {
  const shift = (after.metrics.ascender - before.metrics.ascender) * after.scale;
  for (const cell of glyphCells(doc, before)) {
    const w = cellAdvance(doc, before, cell.id) * after.scale;
    const guides = doc.getChildren(cell.id).filter((n) => n.attrs?.[PART_ATTR] === 'guides').map((n) => n.id);
    if (guides.length) doc.delete(guides);
    doc.invalidate();
    doc.updateFields(doc.insert(cell.id, guideSpec(after, w), 0), { locked: true });
    doc.updateStyle(cell.id, { width: px(w), height: px(emPx(after) + CELL_LABEL) });
    if (!shift) continue;
    for (const n of doc.getChildren(cell.id)) if (n.type === 'svg') doc.updateStyle(n.id, { top: px((pxOf(n.style.top) ?? 0) + shift) });
  }
}
