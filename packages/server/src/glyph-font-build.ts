/// <reference path="./opentype.d.ts" />
import * as opentype from 'opentype.js';
import { compress, decompress } from 'woff2-encoder';
import {
  addFontFaces, compileGlyphPage, FAMILY_NAME, getGlyphFont, glyphFontHash, setGlyphFont, glyphNameOf, notdefContours, parseD,
  type BogenDoc, type CompiledGlyph, type GlyphFont, type GlyphFontMetrics, type KerningPair, type SubPath,
} from '@bogen/core';
import type { Storage } from './storage.ts';

// Bundlers take the ES module, where the names are exports; Node takes the UMD build, where they sit on the default.
const ot = ((opentype as unknown as { Font?: unknown }).Font ? opentype : (opentype as unknown as { default: typeof opentype }).default);

/**
 * Glyph pages to real fonts, with opentype.js (MIT) for the OpenType file with CFF outlines and woff2-encoder (MIT,
 * Google's woff2 and Brotli compiled to WebAssembly) for WOFF2. Both are plain JavaScript and WebAssembly: nothing
 * native to build. opentype.js writes no kerning, so the kern feature goes in as a GPOS table written here.
 */

export interface BuiltFont {
  otf: Uint8Array;
  woff2: Uint8Array;
  glyphs: number;
  kerning: number;
  hash: string;
  /** About the whole font. */
  notes: string[];
  /** Per glyph, for those with something to say. */
  glyphNotes: { name: string; notes: string[] }[];
  empty: string[];
}

const MAX_KERNING = 8000;

/** ASCII letters, digits and hyphens, as a PostScript name must be, at most 63 long. */
export function postScriptName(family: string, style: string): string {
  const ascii = (s: string) => s.normalize('NFKD').replace(/[^A-Za-z0-9-]/g, '');
  const name = `${ascii(family) || 'Font'}-${ascii(style) || 'Regular'}`;
  return name.slice(0, 63);
}

function toOtPath(contours: SubPath[]): opentype.Path {
  const path = new ot.Path();
  const r = Math.round;
  for (const c of contours) {
    const pts = c.points;
    if (pts.length < 2) continue;
    path.moveTo(r(pts[0]!.x), r(pts[0]!.y));
    for (let i = 1; i <= pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i % pts.length]!;
      if (i === pts.length && a.hx2 === undefined && b.hx1 === undefined) break; // closing straight edge: close() draws it
      if (a.hx2 === undefined && b.hx1 === undefined) path.lineTo(r(b.x), r(b.y));
      else path.curveTo(r(a.hx2 ?? a.x), r(a.hy2 ?? a.y), r(b.hx1 ?? b.x), r(b.hy1 ?? b.y), r(b.x), r(b.y));
    }
    path.close();
  }
  return path;
}

class Bytes {
  private parts: number[] = [];
  u16(v: number): this { this.parts.push((v >> 8) & 0xff, v & 0xff); return this; }
  i16(v: number): this { return this.u16(v < 0 ? 0x10000 + v : v); }
  u32(v: number): this { this.parts.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); return this; }
  tag(t: string): this { for (let i = 0; i < 4; i++) this.parts.push(t.charCodeAt(i)); return this; }
  get length(): number { return this.parts.length; }
  bytes(): Uint8Array { return Uint8Array.from(this.parts); }
}

/** A GPOS table with one kern feature: pair adjustments of the advance (PairPos format 1), for DFLT and latn. */
export function gposKerningTable(pairs: { left: number; right: number; value: number }[]): Uint8Array {
  const byFirst = new Map<number, Map<number, number>>();
  for (const p of pairs) {
    if (!p.value) continue;
    let m = byFirst.get(p.left);
    if (!m) byFirst.set(p.left, (m = new Map()));
    m.set(p.right, Math.round(p.value));
  }
  const firsts = [...byFirst.keys()].sort((a, b) => a - b);
  // PairPos: header, then the pair sets, then coverage. Offsets from the start of the subtable.
  const headLen = 10 + 2 * firsts.length;
  const sets: Uint8Array[] = firsts.map((g) => {
    const seconds = [...byFirst.get(g)!.entries()].sort((a, b) => a[0] - b[0]);
    const b = new Bytes().u16(seconds.length);
    for (const [second, value] of seconds) b.u16(second).i16(value);
    return b.bytes();
  });
  const setsLen = sets.reduce((n, s) => n + s.length, 0);
  const pairPos = new Bytes().u16(1).u16(headLen + setsLen).u16(0x0004).u16(0).u16(firsts.length);
  let at = headLen;
  for (const s of sets) { pairPos.u16(at); at += s.length; }
  const coverage = new Bytes().u16(1).u16(firsts.length);
  for (const g of firsts) coverage.u16(g);
  const pairPosBytes = concat([pairPos.bytes(), ...sets, coverage.bytes()]);
  if (pairPosBytes.length > 0xffff) throw new Error('Too many kerning pairs for one table.');

  const scriptTable = new Bytes().u16(4).u16(0).u16(0).u16(0xffff).u16(1).u16(0).bytes(); // default LangSys right after
  const scriptList = concat([new Bytes().u16(2).tag('DFLT').u16(2 + 12).tag('latn').u16(2 + 12 + scriptTable.length).bytes(), scriptTable, scriptTable]);
  const featureList = new Bytes().u16(1).tag('kern').u16(8).u16(0).u16(1).u16(0).bytes();
  const lookup = concat([new Bytes().u16(2).u16(0).u16(1).u16(8).bytes(), pairPosBytes]);
  const lookupList = concat([new Bytes().u16(1).u16(4).bytes(), lookup]);
  const header = new Bytes().u32(0x00010000).u16(10).u16(10 + scriptList.length).u16(10 + scriptList.length + featureList.length).bytes();
  return concat([header, scriptList, featureList, lookupList]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  const padded = data.length % 4 ? concat([data, new Uint8Array(4 - (data.length % 4))]) : data;
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  return sum;
}

/** The font with more tables, or with tables replaced: directory, offsets and checksums written again. */
export function withSfntTables(sfnt: Uint8Array, add: { tag: string; data: Uint8Array }[]): Uint8Array {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const flavor = view.getUint32(0);
  const count = view.getUint16(4);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(sfnt[rec]!, sfnt[rec + 1]!, sfnt[rec + 2]!, sfnt[rec + 3]!);
    const offset = view.getUint32(rec + 8);
    const length = view.getUint32(rec + 12);
    tables.set(tag, sfnt.slice(offset, offset + length));
  }
  for (const t of add) tables.set(t.tag, t.data);
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  let pow = 1, log = 0;
  while (pow * 2 <= n) { pow *= 2; log++; }
  const dirLen = 12 + n * 16;
  let total = dirLen;
  for (const tag of tags) total += Math.ceil(tables.get(tag)!.length / 4) * 4;
  const out = new Uint8Array(total);
  const o = new DataView(out.buffer);
  o.setUint32(0, flavor);
  o.setUint16(4, n);
  o.setUint16(6, pow * 16);
  o.setUint16(8, log);
  o.setUint16(10, n * 16 - pow * 16);
  let at = dirLen;
  let headAt = -1;
  tags.forEach((tag, i) => {
    const data = tables.get(tag)!;
    if (tag === 'head') {
      data.set([0, 0, 0, 0], 8); // checkSumAdjustment is left out of the sums
      headAt = at;
    }
    const rec = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[rec + k] = tag.charCodeAt(k);
    o.setUint32(rec + 4, checksum(data));
    o.setUint32(rec + 8, at);
    o.setUint32(rec + 12, data.length);
    out.set(data, at);
    at += Math.ceil(data.length / 4) * 4;
  });
  if (headAt >= 0) o.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

const FS = { ITALIC: 1, BOLD: 32, REGULAR: 64, USE_TYPO_METRICS: 128 };

/** Compiles the glyph page to an OpenType font with CFF outlines, and that to WOFF2. */
export async function compileGlyphFont(doc: BogenDoc, font: GlyphFont): Promise<BuiltFont> {
  if (!FAMILY_NAME.test(font.family)) throw new Error(`"${font.family}" cannot be a family name: letters, digits, spaces and _ . + - only, at most 60.`);
  const { glyphs: cells, notes } = compileGlyphPage(doc, font);
  const drawn = cells.filter((g) => g.contours.length);
  if (!drawn.length) throw new Error('Nothing was built: no glyph has an outline yet. Draw one with font_glyphs_set, or with the pen inside a cell.');
  const m = font.metrics;
  const notdefCell = cells.find((g) => g.name === '.notdef');
  const notdefAdvance = notdefCell?.advance || Math.round(m.unitsPerEm * 0.5);
  const order: CompiledGlyph[] = [
    notdefCell ?? { cellId: '', name: '.notdef', unicodes: [], advance: notdefAdvance, contours: notdefContours(m, notdefAdvance), notes: [] },
    ...cells.filter((g) => g !== notdefCell),
  ];
  const otGlyphs = order.map((g) => new ot.Glyph({
    name: g.name, advanceWidth: Math.max(0, Math.round(g.advance)), path: toOtPath(g.contours),
    ...(g.name === '.notdef' ? {} : g.unicodes.length ? { unicode: g.unicodes[0], unicodes: g.unicodes } : {}),
  }));
  let yMin = m.descender, yMax = m.ascender;
  for (const g of otGlyphs) {
    if (!g.path.commands.length) continue;
    const b = g.getBoundingBox();
    yMin = Math.min(yMin, b.y1);
    yMax = Math.max(yMax, b.y2);
  }
  const bold = font.weight >= 600;
  const fsSelection = (font.italic ? FS.ITALIC : 0) | (bold ? FS.BOLD : 0) | (!font.italic && !bold ? FS.REGULAR : 0) | FS.USE_TYPO_METRICS;
  const otFont = new ot.Font({
    familyName: font.family, styleName: font.style, postScriptName: postScriptName(font.family, font.style),
    unitsPerEm: m.unitsPerEm, ascender: m.ascender, descender: m.descender,
    designer: font.designer, version: `Version ${font.version ?? '1.000'}`, copyright: font.copyright, license: font.license, licenseURL: font.licenseUrl,
    manufacturer: 'Made with Bogen', weightClass: font.weight, italicAngle: 0, fsSelection, glyphs: otGlyphs,
    tables: { os2: { sCapHeight: m.capHeight, sxHeight: m.xHeight, usWinAscent: Math.ceil(yMax), usWinDescent: Math.ceil(-yMin), sTypoLineGap: 0, fsType: 0, fsSelection, usWeightClass: font.weight } },
  });
  let otf: Uint8Array = new Uint8Array(otFont.toArrayBuffer());

  // Kerning by glyph index; pairs naming a glyph the font lacks are reported and left out.
  const index = new Map(order.map((g, i) => [g.name, i]));
  const pairs: { left: number; right: number; value: number }[] = [];
  const missing = new Set<string>();
  for (const k of font.kerning) {
    const l = index.get(k.left), r = index.get(k.right);
    if (l === undefined) missing.add(k.left);
    if (r === undefined) missing.add(k.right);
    if (l !== undefined && r !== undefined && k.value) pairs.push({ left: l, right: r, value: k.value });
  }
  if (missing.size) notes.push(`Kerning names glyphs the font does not have, so those pairs were left out: ${[...missing].slice(0, 12).join(', ')}.`);
  if (pairs.length > MAX_KERNING) {
    notes.push(`Only the first ${MAX_KERNING} kerning pairs went in.`);
    pairs.length = MAX_KERNING;
  }
  if (pairs.length) otf = withSfntTables(otf, [{ tag: 'GPOS', data: gposKerningTable(pairs) }]);

  // Read it back before anyone uses it.
  try {
    ot.parse(otf.buffer.slice(otf.byteOffset, otf.byteOffset + otf.byteLength) as ArrayBuffer);
  } catch (e) {
    throw new Error(`The built font did not read back: ${e instanceof Error ? e.message : String(e)}`);
  }
  const woff2 = await compress(otf);
  return {
    otf, woff2, glyphs: order.length, kerning: pairs.length, hash: glyphFontHash(doc, font), notes,
    glyphNotes: cells.filter((g) => g.notes.length).map((g) => ({ name: g.name, notes: g.notes })),
    empty: cells.filter((g) => !g.contours.length && g.name !== 'space' && g.name !== 'uni00A0').map((g) => g.name),
  };
}

/** Writes a build into the file: the record and the font face text uses. Run inside the caller's transaction. */
export function recordBuild(doc: BogenDoc, font: GlyphFont, built: BuiltFont, files: { otf: string; woff2: string }, by?: string): GlyphFont {
  const next: GlyphFont = {
    ...font,
    build: { at: Date.now(), otf: files.otf, woff2: files.woff2, glyphs: built.glyphs, kerning: built.kerning, hash: built.hash, notes: built.notes, ...(by ? { by } : {}) },
  };
  addFontFaces(doc, [{ family: font.family, src: files.woff2, weight: String(font.weight), style: font.italic ? 'italic' : 'normal', display: 'swap', from: 'Built in this file' }]);
  return next;
}

/** Builds the font, stores both files and records the build. The write is one step of whoever calls. */
export async function buildGlyphFontInto(storage: Storage, doc: BogenDoc, font: GlyphFont, write: (fn: () => void) => void, by?: string): Promise<{ font: GlyphFont; built: BuiltFont }> {
  const built = await compileGlyphFont(doc, font);
  const [otf, woff2] = await Promise.all([storage.putAsset(built.otf, 'font/otf'), storage.putAsset(built.woff2, 'font/woff2')]);
  let next = font;
  write(() => {
    // Read again inside the write: the record may have changed while the font was built.
    const now = getGlyphFont(doc, font.id) ?? font;
    next = recordBuild(doc, now, built, { otf: otf.src, woff2: woff2.src }, by);
    setGlyphFont(doc, next);
  });
  return { font: next, built };
}

// ------------------------------------------------------------------ starting from an open font

export interface SourceFont {
  family: string;
  style: string;
  copyright: string;
  license: string;
  licenseUrl: string;
  trademark: string;
  metrics: GlyphFontMetrics;
  glyphs: { name: string; unicodes: number[]; advance: number; contours: SubPath[] }[];
  missing: string[];
  kerning: KerningPair[];
}

const english = (font: opentype.Font, key: string): string => {
  for (const table of [font.names.windows, font.names.macintosh, font.names.unicode, font.names as Record<string, Record<string, string> | undefined>]) {
    const v = table?.[key];
    if (v && typeof v === 'object') {
      const s = v.en ?? Object.values(v)[0];
      if (typeof s === 'string' && s.trim()) return s.trim();
    }
  }
  return '';
};

/** opentype.js path commands, y up, to closed contours. */
function commandsToContours(commands: opentype.PathCommand[]): SubPath[] {
  const d = commands.map((c) => {
    switch (c.type) {
      case 'M': case 'L': return `${c.type}${c.x} ${c.y}`;
      case 'C': return `C${c.x1} ${c.y1} ${c.x2} ${c.y2} ${c.x} ${c.y}`;
      case 'Q': return `Q${c.x1} ${c.y1} ${c.x} ${c.y}`;
      default: return 'Z';
    }
  }).join('');
  return parseD(d).map((p) => ({ ...p, closed: true }));
}

/** The printable ASCII range, a sensible start for a derived font. */
export const BASIC_LATIN = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join('');

export async function readSourceFont(bytes: Uint8Array, characters = BASIC_LATIN): Promise<SourceFont> {
  let data = bytes;
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  if (magic === 'wOF2') data = await decompress(bytes);
  if (magic === 'ttcf') throw new Error('That is a font collection. Give one font of it as its own file.');
  let font: opentype.Font;
  try {
    font = ot.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  } catch (e) {
    throw new Error(`That is not a font Bogen can read: ${e instanceof Error ? e.message : String(e)}. OTF, TTF, WOFF and WOFF2 work.`);
  }
  const os2 = font.tables.os2 ?? {};
  const bbox = (c: string) => {
    const g = font.charToGlyph(c);
    return g && g.index > 0 && g.path.commands.length ? g.getBoundingBox().y2 : 0;
  };
  const metrics: GlyphFontMetrics = {
    unitsPerEm: font.unitsPerEm,
    ascender: Math.round(font.ascender),
    descender: Math.round(Math.min(0, font.descender)),
    capHeight: Math.round(Number(os2.sCapHeight) || bbox('H') || font.ascender * 0.9),
    xHeight: Math.round(Number(os2.sxHeight) || bbox('x') || font.ascender * 0.6),
  };
  const glyphs: SourceFont['glyphs'] = [];
  const missing: string[] = [];
  const taken = new Map<number, { name: string; index: number }>();
  for (const char of new Set([...characters])) {
    const g = font.charToGlyph(char);
    if (!g || g.index === 0) {
      missing.push(char);
      continue;
    }
    const name = glyphNameOf(char);
    glyphs.push({ name, unicodes: [char.codePointAt(0)!], advance: Math.round(g.advanceWidth), contours: commandsToContours(g.path.commands) });
    taken.set(glyphs.length - 1, { name, index: g.index });
  }
  const kerning: KerningPair[] = [];
  const entries = [...taken.values()];
  for (const a of entries) {
    for (const b of entries) {
      const v = font.getKerningValue(a.index, b.index);
      if (v) kerning.push({ left: a.name, right: b.name, value: Math.round(v) });
      if (kerning.length >= MAX_KERNING) break;
    }
  }
  return {
    family: english(font, 'preferredFamily') || english(font, 'fontFamily'), style: english(font, 'preferredSubfamily') || english(font, 'fontSubfamily') || 'Regular',
    copyright: english(font, 'copyright'), license: english(font, 'license'), licenseUrl: english(font, 'licenseURL'), trademark: english(font, 'trademark'),
    metrics, glyphs, missing, kerning,
  };
}

export type OpenLicense = 'OFL-1.1' | 'Apache-2.0' | 'MIT';

/**
 * The open licence a font file states for itself, which lets the person change it, or an error that says why not.
 * Only what the file says counts: a licence an agent or a person types in is not proof.
 */
export function openLicenseOf(src: Pick<SourceFont, 'license' | 'licenseUrl' | 'copyright' | 'family'>): { license: OpenLicense; reservedNames: string[] } {
  const text = `${src.license}\n${src.licenseUrl}`;
  let license: OpenLicense | null = null;
  if (/open font licen[cs]e|\bOFL\b|scripts\.sil\.org\/OFL|openfontlicense\.org/i.test(text)) license = 'OFL-1.1';
  else if (/apache licen[cs]e|apache\.org\/licenses/i.test(text)) license = 'Apache-2.0';
  else if (/\bMIT licen[cs]e\b|opensource\.org\/licenses\/MIT/i.test(text)) license = 'MIT';
  if (!license) {
    const said = src.license ? `It says: "${src.license.slice(0, 160)}${src.license.length > 160 ? '...' : ''}"` : 'It names no licence at all';
    throw new Error(`${src.family || 'This font'} does not say it is under an open licence that allows changes (SIL Open Font License, Apache 2.0 or MIT). ${said}. A font without such a licence is not used as a starting point, whoever says it may be. Start from scratch, or from the official release of an open font, such as one from Google Fonts.`);
  }
  return { license, reservedNames: license === 'OFL-1.1' ? reservedFontNames(`${src.copyright}\n${src.license}`) : [] };
}

/** Names an OFL font reserves, as its copyright line declares them: with Reserved Font Name "Foo" and "Bar". */
export function reservedFontNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/Reserved\s+Font\s+Names?\s*:?\s*((?:["“‘'][^"”’']{1,80}["”’'](?:\s*(?:,|and|&)\s*)?)+|[A-Z][\w -]{0,60}?(?=[.;,)\n]|$))/g)) {
    const quoted = [...m[1]!.matchAll(/["“‘']([^"”’']{1,80})["”’']/g)].map((q) => q[1]!.trim());
    for (const n of quoted.length ? quoted : [m[1]!.trim()]) if (n) out.add(n);
  }
  return [...out];
}

const squash = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Why a new family name will not do for a font derived from another one, or null. */
export function renameProblem(next: string, source: string, reserved: string[]): string | null {
  const n = squash(next);
  if (!n) return 'Give the new font a family name.';
  if (source && n === squash(source)) return `A changed font needs a name of its own: "${next}" is the name of the font it comes from. Pick a new family name.`;
  const hit = reserved.find((r) => squash(r) && n.includes(squash(r)));
  if (hit) return `"${hit}" is a Reserved Font Name of ${source || 'the source font'}. Under the SIL Open Font License a changed version may not use it. Pick a family name without it.`;
  return null;
}
