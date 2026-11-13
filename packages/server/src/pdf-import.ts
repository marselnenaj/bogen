import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import type { Renderer } from './render.ts';
import { vendorPath } from './vendor-files.ts';

/**
 * PDF pages as layers. pdf.js (Apache-2.0) reads the file here, in Node, without running anything in it (no eval, no
 * scripts, no fonts loaded); its operator list is then walked the way a PDF viewer draws it: text runs become text
 * layers with their font, size and colour, paths become SVG layers in device coordinates, and images become pictures
 * from their own pixels. What has no plain HTML or SVG form (shadings, patterns, soft masks, image masks, Type 3 fonts,
 * annotations) is drawn on its own by pdf.js in a render page and kept as a picture in its place, and the report
 * says which those were. Coordinates are CSS pixels: 1pt is 4/3 px, so 12pt text is 16px.
 */

export const PDF_SCALE = 4 / 3;
export const MAX_PDF_PAGES = 50;
const MAX_OPS = 400_000;
const MAX_LAYERS = 4000;
const MAX_PATHS_PER_LAYER = 400;
const PICTURE_SCALE = 2;
const ORIGIN = 'https://pdf.bogen.invalid';
/**
 * Where the baseline sits in a line box of line-height 1, as a share of the font size. It depends on the font that
 * draws the text here, not on the PDF's, and is close to 0.84 for the common sans, serif and mono faces.
 */
const BASELINE = 0.84;

type M = [number, number, number, number, number, number];
const ID: M = [1, 0, 0, 1, 0, 0];
/** `a` then `b`, in PDF's row-vector order: a point goes through `a` first. */
const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface Box { x: number; y: number; w: number; h: number }
const union = (a: Box | null, b: Box): Box => (a ? { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) } : b);
const intersect = (a: Box, b: Box): Box | null => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
};
function boxOf(points: [number, number][]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface PdfText { kind: 'text'; text: string; x: number; y: number; size: number; angle: number; color: string; alpha: number; family: string; weight: number; italic: boolean; width: number; ascent: number }
export interface PdfPath { d: string; fill: string | null; stroke: string | null; width: number; dash: string | null; evenOdd: boolean; fillAlpha: number; strokeAlpha: number; cap: string; join: string }
export interface PdfVectors { kind: 'vectors'; paths: PdfPath[]; box: Box }
export interface PdfImage { kind: 'image'; png: Buffer; box: Box; pixels: [number, number] }
export interface PdfPicture { kind: 'picture'; ops: number[]; box: Box; reason: string; png?: Buffer }
export type PdfItem = PdfText | PdfVectors | PdfImage | PdfPicture;
export interface PdfPage { index: number; width: number; height: number; background: string | null; items: PdfItem[]; notes: string[] }

// ---------------------------------------------------------------- pdf.js

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let loaded: Promise<PdfJs> | null = null;
/**
 * pdf.js in Node, with its worker in this thread: nothing is fetched and nothing is run from the document. Loaded from
 * its own files (vendor-files.ts), not from cli.js, where it would be most of the bundle.
 */
function pdfjs(): Promise<PdfJs> {
  loaded ??= (async () => {
    const worker: unknown = await import(pathToFileURL(vendorPath('pdfWorker')).href);
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    // pdf.js looks for a canvas package to draw pages in Node, and says so when it is missing. Bogen only reads the
    // operators here and draws in the render browser, so those three warnings are noise on the CLI's output.
    const log = console.log;
    console.log = (...args: unknown[]) => {
      if (!/^Warning: Cannot (load "@napi-rs\/canvas"|polyfill)/.test(String(args[0]))) log(...args);
    };
    try {
      return (await import(pathToFileURL(vendorPath('pdf')).href)) as PdfJs;
    } finally {
      console.log = log;
    }
  })();
  loaded.catch(() => (loaded = null));
  return loaded;
}

// ---------------------------------------------------------------- fonts

interface FontFacts { family: string; weight: number; italic: boolean; ascent: number; type3: boolean; matrix: M }

function cssFamilyOf(name: string, fallback: string): string {
  const base = name.replace(/^[A-Z]{6}\+/, '').replace(/[,-](Bold|Italic|Oblique|BoldItalic|BoldOblique|Regular|Roman|Medium|Light|Semibold|SemiBold|Black|Heavy|Thin|ExtraBold|Book|Condensed|Demi\w*)+$/i, '').replace(/(PS)?MT$|PS$/, '');
  if (/^helvetica|^arial/i.test(base)) return 'Helvetica, Arial, sans-serif';
  if (/^times/i.test(base)) return '"Times New Roman", Times, serif';
  if (/^courier/i.test(base)) return '"Courier New", Courier, monospace';
  const spaced = base.includes(' ') ? base : base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const clean = spaced.replace(/["\\;{}<>]/g, '').trim().slice(0, 60);
  return clean ? `"${clean}", ${fallback}` : fallback;
}

function weightOf(name: string, bold: boolean, black: boolean): number {
  if (black || /black|heavy/i.test(name)) return 900;
  if (/extrabold|ultrabold/i.test(name)) return 800;
  if (bold || /bold/i.test(name) && !/semibold|demibold/i.test(name)) return 700;
  if (/semibold|demi/i.test(name)) return 600;
  if (/medium/i.test(name)) return 500;
  if (/extralight|ultralight/i.test(name)) return 200;
  if (/light/i.test(name)) return 300;
  if (/thin|hairline/i.test(name)) return 100;
  return 400;
}

// ---------------------------------------------------------------- the walk

interface State {
  ctm: M;
  fill: string | null; stroke: string | null; fillAlpha: number; strokeAlpha: number; fillPattern: boolean; strokePattern: boolean;
  width: number; dash: number[]; dashPhase: number; cap: number; join: number;
  clip: Box | null; masked: boolean; blend: boolean;
  font: string | null; size: number; Tc: number; Tw: number; Th: number; TL: number; Ts: number; mode: number;
}

const CAPS = ['butt', 'round', 'square'];
const JOINS = ['miter', 'round', 'bevel'];

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const row = width * 4 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * row + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** An image object of pdf.js as RGBA, or null for a kind it has not decoded to pixels. */
function rgbaOf(img: { width: number; height: number; kind?: number; data?: Uint8Array | Uint8ClampedArray }): Uint8Array | null {
  const { width: w, height: h, data, kind } = img;
  if (!data || !w || !h || w * h > 40_000_000) return null;
  if (kind === 3 && data.length >= w * h * 4) return new Uint8Array(data.buffer, data.byteOffset, w * h * 4);
  const out = new Uint8Array(w * h * 4);
  if (kind === 2 && data.length >= w * h * 3) {
    for (let i = 0, j = 0; i < w * h; i++, j += 3) out.set([data[j]!, data[j + 1]!, data[j + 2]!, 255], i * 4);
    return out;
  }
  if (kind === 1) {
    const stride = Math.ceil(w / 8);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = (data[y * stride + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 255 : 0;
      out.set([v, v, v, 255], (y * w + x) * 4);
    }
    return out;
  }
  return null;
}

const arr6 = (v: unknown): M | null => {
  const a = v && typeof v === 'object' ? Array.from(v as ArrayLike<number>) : null;
  return a && a.length >= 6 && a.every((n) => Number.isFinite(n)) ? (a.slice(0, 6) as M) : null;
};

/** One page, walked. Pictures are listed with the operators that draw them, to be rendered afterwards. */
async function walkPage(lib: PdfJs, page: import('pdfjs-dist/legacy/build/pdf.mjs').PDFPageProxy, index: number): Promise<PdfPage> {
  const { OPS } = lib;
  const viewport = page.getViewport({ scale: PDF_SCALE });
  const width = r2(viewport.width), height = r2(viewport.height);
  const pageBox: Box = { x: 0, y: 0, w: width, h: height };
  const list = await page.getOperatorList();
  const notes: string[] = [];
  const items: PdfItem[] = [];
  let background: string | null = null;
  if (list.fnArray.length > MAX_OPS) {
    notes.push(`The page has ${list.fnArray.length} drawing operations, over ${MAX_OPS}, so it came in as one picture.`);
    return { index, width, height, background, items: [{ kind: 'picture', ops: list.fnArray.map((_, i) => i), box: pageBox, reason: 'too many drawing operations' }], notes };
  }
  const fonts = new Map<string, FontFacts>();
  const fontOf = (id: string | null): FontFacts => {
    const key = id ?? '';
    let f = fonts.get(key);
    if (f) return f;
    let obj: Record<string, unknown> = {};
    try {
      obj = (id && page.commonObjs.has(id) ? page.commonObjs.get(id) : {}) as Record<string, unknown>;
    } catch {
      obj = {};
    }
    const name = String(obj.name ?? obj.loadedName ?? '');
    const generic = obj.isMonospace ? 'monospace' : obj.isSerifFont ? 'serif' : String(obj.fallbackName ?? 'sans-serif').replace(/[^\w-]/g, '') || 'sans-serif';
    f = {
      family: cssFamilyOf(name, generic), weight: weightOf(name, Boolean(obj.bold), Boolean(obj.black)), italic: Boolean(obj.italic) || /italic|oblique/i.test(name),
      ascent: BASELINE, type3: Boolean(obj.isType3Font), matrix: arr6(obj.fontMatrix) ?? [0.001, 0, 0, 0.001, 0, 0],
    };
    fonts.set(key, f);
    return f;
  };

  let st: State = {
    ctm: viewport.transform as M, fill: '#000000', stroke: '#000000', fillAlpha: 1, strokeAlpha: 1, fillPattern: false, strokePattern: false,
    width: 1, dash: [], dashPhase: 0, cap: 0, join: 0, clip: null, masked: false, blend: false,
    font: null, size: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0, mode: 0,
  };
  const stack: State[] = [];
  let Tm: M = ID, Tlm: M = ID;
  let pendingClip = false;
  let lastPath: Box | null = null;
  let annotation: { box: Box; ops: number[] } | null = null;
  let invisible = 0;

  let vectors: PdfVectors | null = null;
  let picture: PdfPicture | null = null;
  const endVectors = () => {
    if (vectors?.paths.length) items.push(vectors);
    vectors = null;
  };
  const endPicture = () => {
    if (picture) items.push(picture);
    picture = null;
  };
  const toPicture = (i: number, box: Box | null, reason: string) => {
    const b = box && st.clip ? intersect(box, st.clip) : box ?? st.clip ?? pageBox;
    if (!b) return;
    endVectors();
    if (!picture) picture = { kind: 'picture', ops: [], box: b, reason };
    else {
      picture.box = union(picture.box, b);
      if (!picture.reason.includes(reason)) picture.reason += `, ${reason}`;
    }
    picture.ops.push(i);
  };
  const unitBox = () => boxOf([apply(st.ctm, 0, 0), apply(st.ctm, 1, 0), apply(st.ctm, 0, 1), apply(st.ctm, 1, 1)]);
  const scaleOf = (m: M) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

  const pathOf = (data: ArrayLike<number> | null, close: boolean): { d: string; box: Box } | null => {
    if (!data || !data.length) return null;
    const out: string[] = [];
    const pts: [number, number][] = [];
    const p = (x: number, y: number) => {
      const q = apply(st.ctm, x, y);
      pts.push(q);
      return `${r2(q[0])} ${r2(q[1])}`;
    };
    for (let k = 0; k < data.length;) {
      switch (data[k++]) {
        case 0: out.push(`M${p(data[k++]!, data[k++]!)}`); break;
        case 1: out.push(`L${p(data[k++]!, data[k++]!)}`); break;
        case 2: out.push(`C${p(data[k++]!, data[k++]!)} ${p(data[k++]!, data[k++]!)} ${p(data[k++]!, data[k++]!)}`); break;
        case 3: out.push(`Q${p(data[k++]!, data[k++]!)} ${p(data[k++]!, data[k++]!)}`); break;
        case 4: out.push('Z'); break;
        default: return null;
      }
    }
    if (close) out.push('Z');
    return pts.length ? { d: out.join(''), box: boxOf(pts) } : null;
  };

  const PAINT: Record<number, { fill: boolean; stroke: boolean; close: boolean; evenOdd: boolean }> = {
    [OPS.stroke]: { fill: false, stroke: true, close: false, evenOdd: false }, [OPS.closeStroke]: { fill: false, stroke: true, close: true, evenOdd: false },
    [OPS.fill]: { fill: true, stroke: false, close: false, evenOdd: false }, [OPS.eoFill]: { fill: true, stroke: false, close: false, evenOdd: true },
    [OPS.fillStroke]: { fill: true, stroke: true, close: false, evenOdd: false }, [OPS.eoFillStroke]: { fill: true, stroke: true, close: false, evenOdd: true },
    [OPS.closeFillStroke]: { fill: true, stroke: true, close: true, evenOdd: false }, [OPS.closeEOFillStroke]: { fill: true, stroke: true, close: true, evenOdd: true },
    [OPS.rawFillPath]: { fill: true, stroke: false, close: false, evenOdd: false },
  };

  const showText = (i: number, glyphs: unknown[]) => {
    if (!st.font) return;
    const font = fontOf(st.font);
    const visible = st.mode !== 3 && st.mode !== 7;
    if (font.type3 || st.fillPattern || st.masked || st.blend) {
      // Measured as text would be, then drawn as a picture.
      const start = apply(mul([st.size * st.Th, 0, 0, st.size, 0, st.Ts], mul(Tm, st.ctm)), 0, 0);
      let adv = 0;
      for (const g of glyphs) adv += typeof g === 'number' ? -g * 0.001 * st.size * st.Th : ((Number((g as { width?: number }).width) || 0) * font.matrix[0] * st.size + st.Tc) * st.Th;
      const end = apply(mul(Tm, st.ctm), adv, 0);
      const up = apply(mul([st.size, 0, 0, st.size, 0, 0], mul(Tm, st.ctm)), 0, 1);
      const b = boxOf([start, end, up, [end[0] + up[0] - start[0], end[1] + up[1] - start[1]]]);
      toPicture(i, { x: b.x - 2, y: b.y - st.size, w: b.w + 4, h: b.h + st.size * 2 }, font.type3 ? 'Type 3 font' : 'patterned or masked text');
      Tm = mul([1, 0, 0, 1, adv, 0], Tm);
      return;
    }
    let text = '';
    let x = 0;
    const startTm = Tm;
    for (const g of glyphs) {
      if (typeof g === 'number') {
        const tx = -g * 0.001 * st.size * st.Th;
        // A wide gap in a TJ array is how many writers put a space.
        if (g < -200 && text && !/\s$/.test(text)) text += ' ';
        x += tx;
        continue;
      }
      const glyph = g as { unicode?: string; width?: number; isSpace?: boolean };
      text += glyph.unicode ?? '';
      x += ((Number(glyph.width) || 0) * font.matrix[0] * st.size + st.Tc + (glyph.isSpace ? st.Tw : 0)) * st.Th;
    }
    Tm = mul([1, 0, 0, 1, x, 0], Tm);
    if (!visible) {
      if (text.trim()) invisible++;
      return;
    }
    if (!text.trim()) return;
    const trm = mul([st.size * st.Th, 0, 0, st.size, 0, st.Ts], mul(startTm, st.ctm));
    const [ox, oy] = apply(trm, 0, 0);
    const [ex, ey] = apply(mul([1, 0, 0, 1, x, 0], mul(startTm, st.ctm)), 0, st.Ts);
    const upx = trm[2], upy = trm[3];
    const size = Math.hypot(upx, upy);
    if (size < 0.5) return;
    const angle = Math.atan2(trm[1], trm[0]);
    const runWidth = Math.hypot(ex - ox, ey - oy);
    if (st.clip && !intersect({ x: Math.min(ox, ex), y: Math.min(oy, ey) - size, w: Math.abs(ex - ox) + 1, h: Math.abs(ey - oy) + size * 1.3 }, st.clip)) return;
    endVectors();
    endPicture();
    const color = (st.mode === 1 || st.mode === 5 ? st.stroke : st.fill) ?? '#000000';
    const prev = items.at(-1);
    // A run that carries on the last one, in its style and on its baseline, joins it.
    if (prev?.kind === 'text' && prev.color === color && prev.family === font.family && prev.weight === font.weight && prev.italic === font.italic && Math.abs(prev.size - size) < 0.3 && Math.abs(prev.angle - angle) < 0.01 && Math.abs(angle) < 0.01) {
      const prevEnd = prev.x + prev.width;
      const gap = ox - prevEnd;
      if (Math.abs(oy - prev.y) < size * 0.2 && gap > -size * 0.3 && gap < size * 1.2) {
        prev.text += gap > size * 0.15 && !/\s$/.test(prev.text) && !/^\s/.test(text) ? ` ${text}` : text;
        prev.width = ox + runWidth - prev.x;
        return;
      }
    }
    items.push({ kind: 'text', text, x: r2(ox), y: r2(oy), size: r2(size), angle, color, alpha: st.fillAlpha, family: font.family, weight: font.weight, italic: font.italic, width: r2(runWidth), ascent: font.ascent });
  };

  const objOf = (id: string): Promise<unknown> => new Promise((res) => {
    try {
      if (page.objs.has(id)) return res(page.objs.get(id));
      page.objs.get(id, res);
      setTimeout(() => res(null), 5000).unref();
    } catch {
      res(null);
    }
  });

  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i]!;
    const args = (list.argsArray[i] ?? []) as unknown[];
    if (annotation) {
      if (fn === OPS.endAnnotation) {
        if (annotation.ops.length) {
          endVectors();
          endPicture();
          items.push({ kind: 'picture', ops: annotation.ops, box: annotation.box, reason: 'form field or annotation' });
        }
        annotation = null;
      } else annotation.ops.push(i);
      continue;
    }
    switch (fn) {
      case OPS.save: stack.push({ ...st, dash: [...st.dash] }); break;
      case OPS.restore: if (stack.length) st = stack.pop()!; break;
      case OPS.transform: { const m = arr6(args); if (m) st.ctm = mul(m, st.ctm); break; }
      case OPS.setLineWidth: st.width = Number(args[0]) || 0; break;
      case OPS.setLineCap: st.cap = Number(args[0]) || 0; break;
      case OPS.setLineJoin: st.join = Number(args[0]) || 0; break;
      case OPS.setDash: st.dash = Array.from((args[0] as ArrayLike<number>) ?? []); st.dashPhase = Number(args[1]) || 0; break;
      case OPS.setGState:
        for (const [k, v] of (args[0] as [string, unknown][]) ?? []) {
          if (k === 'LW') st.width = Number(v) || 0;
          else if (k === 'LC') st.cap = Number(v) || 0;
          else if (k === 'LJ') st.join = Number(v) || 0;
          else if (k === 'D') { st.dash = Array.from(((v as unknown[])[0] as ArrayLike<number>) ?? []); st.dashPhase = Number((v as unknown[])[1]) || 0; }
          else if (k === 'CA') st.strokeAlpha = Number(v);
          else if (k === 'ca') st.fillAlpha = Number(v);
          else if (k === 'Font') { st.font = String((v as unknown[])[0]); st.size = Number((v as unknown[])[1]) || 0; }
          else if (k === 'SMask') st.masked = Boolean(v);
          else if (k === 'BM') st.blend = typeof v === 'string' && v !== 'source-over' && v !== 'normal';
        }
        break;
      case OPS.setFillRGBColor: st.fill = String(args[0]); st.fillPattern = false; break;
      case OPS.setStrokeRGBColor: st.stroke = String(args[0]); st.strokePattern = false; break;
      case OPS.setFillTransparent: st.fill = null; st.fillPattern = false; break;
      case OPS.setStrokeTransparent: st.stroke = null; st.strokePattern = false; break;
      case OPS.setFillColorN: st.fillPattern = true; break;
      case OPS.setStrokeColorN: st.strokePattern = true; break;
      case OPS.clip: case OPS.eoClip:
        if (lastPath) st.clip = st.clip ? intersect(st.clip, lastPath) ?? { x: 0, y: 0, w: 0, h: 0 } : lastPath;
        else pendingClip = true;
        lastPath = null;
        break;
      case OPS.constructPath: {
        const paintOp = Number(args[0]);
        const path = pathOf(((args[1] as unknown[]) ?? [])[0] as ArrayLike<number> | null, false);
        if (paintOp === OPS.endPath) {
          if (path && pendingClip) st.clip = st.clip ? intersect(st.clip, path.box) ?? { x: 0, y: 0, w: 0, h: 0 } : path.box;
          lastPath = pendingClip ? null : path?.box ?? null;
          pendingClip = false;
          break;
        }
        lastPath = null;
        const paint = PAINT[paintOp];
        if (!paint || !path) break;
        if (pendingClip) {
          st.clip = st.clip ? intersect(st.clip, path.box) ?? { x: 0, y: 0, w: 0, h: 0 } : path.box;
          pendingClip = false;
        }
        const lw = st.width * scaleOf(st.ctm);
        const vis = { x: path.box.x - lw, y: path.box.y - lw, w: path.box.w + lw * 2, h: path.box.h + lw * 2 };
        if (st.clip && !intersect(vis, st.clip)) break;
        if ((paint.fill && st.fillPattern) || (paint.stroke && st.strokePattern) || st.masked || st.blend) {
          toPicture(i, vis, st.masked ? 'soft mask' : st.blend ? 'blend mode' : 'pattern or gradient fill');
          break;
        }
        const fill = paint.fill ? st.fill : null;
        const stroke = paint.stroke && lw > 0 ? st.stroke : paint.stroke ? st.stroke : null;
        if (!fill && !stroke) break;
        // A rectangle filling the page in an opaque colour, before anything else, is the page's own colour.
        if (!items.length && !vectors && fill && !stroke && st.fillAlpha >= 1 && path.box.w >= width * 0.98 && path.box.h >= height * 0.98) {
          background = fill;
          break;
        }
        endPicture();
        if (!vectors || vectors.paths.length >= MAX_PATHS_PER_LAYER) {
          endVectors();
          vectors = { kind: 'vectors', paths: [], box: vis };
        } else vectors.box = union(vectors.box, vis);
        vectors.paths.push({
          d: paint.close ? `${path.d}Z` : path.d, fill, stroke, width: r2(Math.max(lw, stroke ? 0.5 : 0)), dash: st.dash.length ? st.dash.map((v) => r2(v * scaleOf(st.ctm))).join(' ') : null,
          evenOdd: paint.evenOdd, fillAlpha: st.fillAlpha, strokeAlpha: st.strokeAlpha, cap: CAPS[st.cap] ?? 'butt', join: JOINS[st.join] ?? 'miter',
        });
        break;
      }
      case OPS.beginText: Tm = ID; Tlm = ID; break;
      case OPS.setCharSpacing: st.Tc = Number(args[0]) || 0; break;
      case OPS.setWordSpacing: st.Tw = Number(args[0]) || 0; break;
      case OPS.setHScale: st.Th = (Number(args[0]) || 100) / 100; break;
      case OPS.setLeading: st.TL = Number(args[0]) || 0; break;
      case OPS.setFont: st.font = String(args[0]); st.size = Math.abs(Number(args[1]) || 0); break;
      case OPS.setTextRenderingMode: st.mode = Number(args[0]) || 0; break;
      case OPS.setTextRise: st.Ts = Number(args[0]) || 0; break;
      case OPS.moveText: Tlm = mul([1, 0, 0, 1, Number(args[0]) || 0, Number(args[1]) || 0], Tlm); Tm = Tlm; break;
      case OPS.setLeadingMoveText: st.TL = -(Number(args[1]) || 0); Tlm = mul([1, 0, 0, 1, Number(args[0]) || 0, Number(args[1]) || 0], Tlm); Tm = Tlm; break;
      case OPS.setTextMatrix: { const m = arr6(args[0]) ?? arr6(args); if (m) { Tm = m; Tlm = m; } break; }
      case OPS.nextLine: Tlm = mul([1, 0, 0, 1, 0, -st.TL], Tlm); Tm = Tlm; break;
      case OPS.showText: case OPS.showSpacedText: showText(i, (args[0] as unknown[]) ?? []); break;
      case OPS.paintImageXObject: case OPS.paintInlineImageXObject: {
        const box = unitBox();
        if (st.clip && !intersect(box, st.clip)) break;
        const axisAligned = Math.abs(st.ctm[1]) < 1e-6 && Math.abs(st.ctm[2]) < 1e-6 && st.ctm[0] > 0 && st.ctm[3] < 0;
        const obj = (fn === OPS.paintInlineImageXObject ? args[0] : await objOf(String(args[0]))) as Parameters<typeof rgbaOf>[0] | null;
        const rgba = obj && axisAligned && !st.masked && !st.blend && st.fillAlpha >= 1 ? rgbaOf(obj) : null;
        const clipped = st.clip ? intersect(box, st.clip) : box;
        if (!rgba || !clipped || clipped.w < box.w - 1 || clipped.h < box.h - 1) {
          toPicture(i, box, !rgba ? 'image in a form this import does not decode' : 'clipped image');
          break;
        }
        endVectors();
        endPicture();
        items.push({ kind: 'image', png: encodePng(obj!.width, obj!.height, rgba), box: { x: r2(box.x), y: r2(box.y), w: r2(box.w), h: r2(box.h) }, pixels: [obj!.width, obj!.height] });
        break;
      }
      case OPS.paintImageMaskXObject: case OPS.paintImageMaskXObjectGroup: case OPS.paintImageXObjectRepeat: case OPS.paintImageMaskXObjectRepeat: case OPS.paintSolidColorImageMask: case OPS.paintInlineImageXObjectGroup:
        toPicture(i, unitBox(), 'image mask');
        break;
      case OPS.shadingFill: toPicture(i, st.clip ?? pageBox, 'gradient'); break;
      case OPS.paintFormXObjectBegin: {
        stack.push({ ...st, dash: [...st.dash] });
        const m = arr6(args[0]);
        if (m) st.ctm = mul(m, st.ctm);
        const bb = args[1] as ArrayLike<number> | null;
        if (bb && bb.length === 4) {
          const b = boxOf([apply(st.ctm, bb[0]!, bb[1]!), apply(st.ctm, bb[2]!, bb[1]!), apply(st.ctm, bb[0]!, bb[3]!), apply(st.ctm, bb[2]!, bb[3]!)]);
          st.clip = st.clip ? intersect(st.clip, b) ?? { x: 0, y: 0, w: 0, h: 0 } : b;
        }
        break;
      }
      case OPS.paintFormXObjectEnd: if (stack.length) st = stack.pop()!; break;
      case OPS.beginGroup: {
        stack.push({ ...st, dash: [...st.dash] });
        const g = (args[0] ?? {}) as { smask?: unknown; knockout?: boolean };
        if (g.smask) st.masked = true;
        break;
      }
      case OPS.endGroup: if (stack.length) st = stack.pop()!; break;
      case OPS.beginAnnotation: {
        const rect = args[1] as ArrayLike<number> | null;
        const b = rect && rect.length === 4 ? boxOf([apply(viewport.transform as M, rect[0]!, rect[1]!), apply(viewport.transform as M, rect[2]!, rect[3]!)]) : pageBox;
        annotation = { box: b, ops: [] };
        break;
      }
      default: break;
    }
  }
  endVectors();
  endPicture();
  if (invisible) notes.push(`${invisible} invisible text run${invisible === 1 ? ' was' : 's were'} left out, such as the text layer of a scan.`);
  const layers = items.length;
  if (layers > MAX_LAYERS) {
    notes.push(`The page made ${layers} layers, over ${MAX_LAYERS}, so it came in as one picture.`);
    return { index, width, height, background, items: [{ kind: 'picture', ops: list.fnArray.map((_, k) => k), box: pageBox, reason: 'too many layers' }], notes };
  }
  return { index, width, height, background, items, notes };
}

// ---------------------------------------------------------------- pictures, drawn by pdf.js in a page

let pdfBrowserFiles: Promise<{ lib: string; worker: string }> | null = null;
/** The same files the Node side runs, served to the render page: both read a PDF to the same operator list. */
function browserBuild(): Promise<{ lib: string; worker: string }> {
  pdfBrowserFiles ??= (async () => ({ lib: await readFile(vendorPath('pdf'), 'utf8'), worker: await readFile(vendorPath('pdfWorker'), 'utf8') }))();
  pdfBrowserFiles.catch(() => (pdfBrowserFiles = null));
  return pdfBrowserFiles;
}

/** Operators that change state and draw nothing: a picture keeps them, so that what it draws is where and as it was. */
function stateOps(lib: PdfJs): Set<number> {
  const O = lib.OPS;
  return new Set([O.dependency, O.setLineWidth, O.setLineCap, O.setLineJoin, O.setMiterLimit, O.setDash, O.setRenderingIntent, O.setFlatness, O.setGState, O.save, O.restore, O.transform, O.clip, O.eoClip,
    O.beginText, O.endText, O.setCharSpacing, O.setWordSpacing, O.setHScale, O.setLeading, O.setFont, O.setTextRenderingMode, O.setTextRise, O.moveText, O.setLeadingMoveText, O.setTextMatrix, O.nextLine,
    O.setCharWidth, O.setCharWidthAndBounds, O.setStrokeColorSpace, O.setFillColorSpace, O.setStrokeColor, O.setStrokeColorN, O.setFillColor, O.setFillColorN, O.setStrokeGray, O.setFillGray, O.setStrokeRGBColor,
    O.setFillRGBColor, O.setStrokeCMYKColor, O.setFillCMYKColor, O.beginMarkedContent, O.beginMarkedContentProps, O.endMarkedContent, O.markPoint, O.markPointProps, O.beginCompat, O.endCompat,
    O.paintFormXObjectBegin, O.paintFormXObjectEnd, O.beginGroup, O.endGroup, O.beginAnnotation, O.endAnnotation, O.setStrokeTransparent, O.setFillTransparent]);
}

/** Runs in the page: each picture drawn alone, with the state before it, and cut to its box. */
async function picturesInPage(args: { data: string; pages: { page: number; count: number; pictures: { ops: number[]; box: Box }[] }[]; keep: number[]; scale: number; factor: number; endPath: number; constructPath: number }): Promise<(string | null)[][]> {
  const lib = (globalThis as unknown as { pdfjsLib: { getDocument: (o: unknown) => { promise: Promise<{ getPage: (n: number) => Promise<{ getViewport: (o: unknown) => { width: number; height: number }; render: (o: unknown) => { promise: Promise<void> }; getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }> }> }> } } }).pdfjsLib;
  const bytes = Uint8Array.from(atob(args.data), (c) => c.charCodeAt(0));
  const pdf = await lib.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false, disableFontFace: false, useSystemFonts: true }).promise;
  const keep = new Set(args.keep);
  const out: (string | null)[][] = [];
  for (const p of args.pages) {
    const page = await pdf.getPage(p.page + 1);
    const viewport = page.getViewport({ scale: args.scale });
    const ops = await page.getOperatorList();
    // The same pdf.js reads the same file to the same list; if not, each picture is cut from the whole page instead.
    const same = ops.fnArray.length === p.count;
    const shots: (string | null)[] = [];
    for (const pic of p.pictures) {
      const wanted = new Set(pic.ops);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d')!;
      try {
        await page.render({
          canvasContext: ctx, canvas, viewport, background: 'rgba(0,0,0,0)', annotationMode: 1,
          ...(same ? { operationsFilter: (i: number) => wanted.has(i) || (keep.has(ops.fnArray[i]!) || (ops.fnArray[i] === args.constructPath && Number(ops.argsArray[i]?.[0]) === args.endPath)) } : {}),
        }).promise;
      } catch {
        shots.push(null);
        continue;
      }
      const k = args.factor;
      const sx = Math.max(0, Math.floor(pic.box.x * k)), sy = Math.max(0, Math.floor(pic.box.y * k));
      const sw = Math.min(canvas.width - sx, Math.ceil(pic.box.w * k) + 1), sh = Math.min(canvas.height - sy, Math.ceil(pic.box.h * k) + 1);
      if (sw <= 0 || sh <= 0) {
        shots.push(null);
        continue;
      }
      const cut = document.createElement('canvas');
      cut.width = sw;
      cut.height = sh;
      cut.getContext('2d')!.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      shots.push(cut.toDataURL('image/png'));
    }
    out.push(shots);
  }
  return out;
}

async function renderPictures(renderer: Renderer, lib: PdfJs, bytes: Uint8Array, pages: PdfPage[], counts: Map<number, number>): Promise<void> {
  const wanted = pages.filter((p) => p.items.some((i) => i.kind === 'picture'));
  if (!wanted.length) return;
  const files = await browserBuild();
  const html = `<!doctype html><html><head><meta charset="utf-8"><script type="module">import * as pdfjsLib from '${ORIGIN}/pdf.mjs'; pdfjsLib.GlobalWorkerOptions.workerSrc = '${ORIGIN}/pdf.worker.mjs'; window.pdfjsLib = pdfjsLib; window.pdfReady = true;</script></head><body></body></html>`;
  const shots = await renderer.withBrowser(async (browser) => {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.evaluateOnNewDocument('globalThis.__name = (f) => f');
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const url = req.url();
        if (url === `${ORIGIN}/`) void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
        else if (url === `${ORIGIN}/pdf.mjs`) void req.respond({ status: 200, contentType: 'text/javascript', body: files.lib });
        else if (url === `${ORIGIN}/pdf.worker.mjs`) void req.respond({ status: 200, contentType: 'text/javascript', body: files.worker });
        else if (url.startsWith('data:') || url.startsWith('blob:')) void req.continue();
        else void req.abort('blockedbyclient');
      });
      await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 20_000 });
      await page.waitForFunction('window.pdfReady === true', { timeout: 20_000 });
      return await page.evaluate(picturesInPage, {
        data: Buffer.from(bytes).toString('base64'), keep: [...stateOps(lib)], scale: PDF_SCALE * PICTURE_SCALE, factor: PICTURE_SCALE, endPath: lib.OPS.endPath, constructPath: lib.OPS.constructPath,
        pages: wanted.map((p) => ({ page: p.index, count: counts.get(p.index) ?? -1, pictures: p.items.filter((i): i is PdfPicture => i.kind === 'picture').map((i) => ({ ops: i.ops, box: i.box })) })),
      });
    } finally {
      await context.close().catch(() => {});
    }
  });
  wanted.forEach((p, n) => {
    const pics = p.items.filter((i): i is PdfPicture => i.kind === 'picture');
    pics.forEach((pic, k) => {
      const url = shots[n]?.[k];
      if (url?.startsWith('data:image/png;base64,')) pic.png = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
    });
  });
}

export interface PdfRead { pages: PdfPage[]; total: number; title: string | null; notes: string[] }

/** Reads the pages of a PDF (all, or the 0-based ones given) into items. Pictures are rendered when a browser is there. */
export async function readPdf(bytes: Uint8Array, renderer: Renderer | null, options: { pages?: number[] } = {}): Promise<PdfRead> {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false, disableFontFace: true, useSystemFonts: false, fontExtraProperties: true, verbosity: 0, stopAtErrors: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
  } as Parameters<PdfJs['getDocument']>[0]);
  const doc = await task.promise.catch((e: unknown) => {
    const name = (e as { name?: string })?.name;
    throw new Error(name === 'PasswordException' ? 'This PDF is protected with a password, so it cannot be read.' : `This is not a PDF that can be read: ${(e as Error)?.message ?? e}`);
  });
  try {
    const total = doc.numPages;
    const wanted = (options.pages?.length ? options.pages : Array.from({ length: total }, (_, i) => i)).filter((i) => i >= 0 && i < total);
    const notes: string[] = [];
    if (wanted.length > MAX_PDF_PAGES) notes.push(`The PDF has ${wanted.length} pages; the first ${MAX_PDF_PAGES} came in. Pass pages for others.`);
    const pages: PdfPage[] = [];
    const counts = new Map<number, number>();
    for (const i of wanted.slice(0, MAX_PDF_PAGES)) {
      const page = await doc.getPage(i + 1);
      counts.set(i, (await page.getOperatorList()).fnArray.length);
      pages.push(await walkPage(lib, page, i));
      page.cleanup();
    }
    if (renderer) {
      try {
        await renderPictures(renderer, lib, bytes, pages, counts);
      } catch (e) {
        notes.push(`The parts that only work as pictures could not be drawn: ${(e as Error)?.message ?? e}`);
      }
    } else if (pages.some((p) => p.items.some((i) => i.kind === 'picture'))) notes.push('No browser was there to draw the parts that only work as pictures, so they were left out.');
    const meta = await doc.getMetadata().catch(() => null);
    const title = typeof (meta?.info as { Title?: unknown } | undefined)?.Title === 'string' ? ((meta!.info as { Title: string }).Title.trim() || null) : null;
    return { pages, total, title, notes };
  } finally {
    await task.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------- layers

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const px = (n: number) => `${r2(n)}px`;

export interface PageReport { page: number; width: number; height: number; text: number; vectors: number; images: number; pictures: { reason: string; box: Box; drawn: boolean }[]; notes: string[] }

/** One page as HTML of layers. `src` stores a picture's bytes and gives back its src. */
export async function pageHtml(page: PdfPage, name: string, src: (png: Buffer) => Promise<string>): Promise<{ html: string; report: PageReport }> {
  const parts: string[] = [];
  const report: PageReport = { page: page.index + 1, width: page.width, height: page.height, text: 0, vectors: 0, images: 0, pictures: [], notes: [...page.notes] };
  for (const item of page.items) {
    if (item.kind === 'text') {
      const top = item.y - item.ascent * item.size;
      const rotate = Math.abs(item.angle) > 0.001 ? `transform:rotate(${r2((item.angle * 180) / Math.PI)}deg);transform-origin:0 ${px(item.ascent * item.size)};` : '';
      parts.push(`<p data-name="${esc(item.text.trim().slice(0, 60))}" style="position:absolute;left:${px(item.x)};top:${px(top)};margin:0;white-space:pre;line-height:1;font-family:${esc(item.family)};font-size:${px(item.size)};font-weight:${item.weight};${item.italic ? 'font-style:italic;' : ''}color:${item.color};${item.alpha < 1 ? `opacity:${r2(item.alpha)};` : ''}${rotate}">${esc(item.text)}</p>`);
      report.text++;
    } else if (item.kind === 'vectors') {
      const b = item.box;
      const paths = item.paths.map((p) => {
        const style = [
          `fill:${p.fill ?? 'none'}`, p.fill && p.fillAlpha < 1 ? `fill-opacity:${r2(p.fillAlpha)}` : '', p.evenOdd ? 'fill-rule:evenodd' : '',
          `stroke:${p.stroke ?? 'none'}`, p.stroke ? `stroke-width:${p.width}` : '', p.stroke && p.strokeAlpha < 1 ? `stroke-opacity:${r2(p.strokeAlpha)}` : '',
          p.stroke && p.dash ? `stroke-dasharray:${p.dash}` : '', p.stroke && p.cap !== 'butt' ? `stroke-linecap:${p.cap}` : '', p.stroke && p.join !== 'miter' ? `stroke-linejoin:${p.join}` : '',
        ].filter(Boolean).join(';');
        return `<path d="${p.d}" style="${style}"></path>`;
      }).join('');
      parts.push(`<svg data-name="Vector" xmlns="http://www.w3.org/2000/svg" viewBox="${r2(b.x)} ${r2(b.y)} ${r2(Math.max(b.w, 0.5))} ${r2(Math.max(b.h, 0.5))}" style="position:absolute;left:${px(b.x)};top:${px(b.y)};width:${px(Math.max(b.w, 0.5))};height:${px(Math.max(b.h, 0.5))};overflow:visible">${paths}</svg>`);
      report.vectors++;
    } else if (item.kind === 'image') {
      parts.push(`<img data-name="Image" alt="" src="${await src(item.png)}" style="position:absolute;left:${px(item.box.x)};top:${px(item.box.y)};width:${px(item.box.w)};height:${px(item.box.h)};object-fit:fill">`);
      report.images++;
    } else {
      report.pictures.push({ reason: item.reason, box: { x: r2(item.box.x), y: r2(item.box.y), w: r2(item.box.w), h: r2(item.box.h) }, drawn: Boolean(item.png) });
      if (!item.png) continue;
      parts.push(`<img data-name="Picture: ${esc(item.reason.slice(0, 50))}" alt="" src="${await src(item.png)}" style="position:absolute;left:${px(item.box.x)};top:${px(item.box.y)};width:${px(item.box.w)};height:${px(item.box.h)};object-fit:fill">`);
    }
  }
  const html = `<div data-name="${esc(name)}" style="position:relative;width:${px(page.width)};height:${px(page.height)};overflow:hidden;background:${page.background ?? '#ffffff'}">${parts.join('')}</div>`;
  return { html, report };
}
