import type { HTTPResponse, Page } from 'puppeteer-core';
import type { BogenDoc, InteractionRule, NewNode, StoredFontFace } from '@bogen/core';
import { fetchPublic } from './net-guard.ts';
import type { Storage } from './storage.ts';

/**
 * What a page's style sheets hold beyond the computed styles Capture reads from elements: its
 * `@font-face` rules and its hover and focus rules. Style sheets from another origin cannot be read
 * from the page, so their text comes from the responses and is parsed there instead.
 */
const MAX_FONT_BYTES = 16 * 1024 * 1024;
const MAX_FONT_TOTAL = 96 * 1024 * 1024;
const MAX_FACES = 64;
const MAX_RULES = 600;
const MAX_DECLARATION = 2000;
const MAX_LAYERS_PER_RULE = 40;
const FONT_MAGIC: [number[], string][] = [
  [[0x77, 0x4f, 0x46, 0x32], 'font/woff2'], [[0x77, 0x4f, 0x46, 0x46], 'font/woff'],
  [[0x00, 0x01, 0x00, 0x00], 'font/ttf'], [[0x74, 0x72, 0x75, 0x65], 'font/ttf'], [[0x4f, 0x54, 0x54, 0x4f], 'font/otf'],
];

export function fontMime(bytes: Uint8Array): string | null {
  return FONT_MAGIC.find(([magic]) => magic.every((b, i) => bytes[i] === b))?.[1] ?? null;
}

export interface PageResources {
  fonts: Map<string, Uint8Array>;
  sheets: { url: string; text: string }[];
  /** Waits for bodies still being read. */
  settle: () => Promise<void>;
}

/** Keeps the bytes of font files and the text of style sheets as the browser receives them. */
export function watchResources(page: Page): PageResources {
  const fonts = new Map<string, Uint8Array>();
  const sheets: { url: string; text: string }[] = [];
  const pending = new Set<Promise<void>>();
  let total = 0;
  page.on('response', (res: HTTPResponse) => {
    const type = res.request().resourceType();
    if (type !== 'font' && type !== 'stylesheet') return;
    if (res.status() < 200 || res.status() >= 300) return;
    const url = res.url().split('#')[0]!;
    const work = res.buffer().then((body) => {
      if (type === 'font') {
        if (body.length > MAX_FONT_BYTES || total + body.length > MAX_FONT_TOTAL) return;
        total += body.length;
        fonts.set(url, new Uint8Array(body));
      } else if (body.length < 8 * 1024 * 1024) sheets.push({ url, text: body.toString('utf8') });
    }).catch(() => {}).finally(() => pending.delete(work));
    pending.add(work);
  });
  return { fonts, sheets, settle: async () => { await Promise.all(pending); } };
}

export interface ScannedFace {
  family: string;
  src: string;
  base: string;
  weight?: string;
  style?: string;
  stretch?: string;
  unicodeRange?: string;
  display?: string;
  ascentOverride?: string;
  descentOverride?: string;
  lineGapOverride?: string;
  sizeAdjust?: string;
  featureSettings?: string;
  variationSettings?: string;
}

export interface ScannedRule extends Omit<InteractionRule, 'layers'> { keys: number[] }
export interface SheetScan { faces: ScannedFace[]; usedFamilies: string[]; rules: ScannedRule[] }

// A string, not a function: it must reach the browser exactly as written, untouched by the bundler.
export const SHEET_SCAN = String.raw`(args) => {
  const faces = [];
  const rules = [];
  const seenFace = new Set();
  const seenRule = new Set();
  const STATE = /:(hover|focus-visible|focus-within|focus|active)(?![\w-])/g;
  const clean = (v) => { const t = (v || '').trim(); return t && t !== 'normal' ? t : undefined; };
  const readFace = (rule, base) => {
    const s = rule.style;
    const family = (s.getPropertyValue('font-family') || '').trim().replace(/^["']|["']$/g, '');
    const src = s.getPropertyValue('src') || '';
    if (!family || !src) return;
    const key = family + '|' + src;
    if (seenFace.has(key)) return;
    seenFace.add(key);
    faces.push({
      family, src, base,
      weight: clean(s.getPropertyValue('font-weight')), style: clean(s.getPropertyValue('font-style')), stretch: clean(s.getPropertyValue('font-stretch')),
      unicodeRange: clean(s.getPropertyValue('unicode-range')), display: clean(s.getPropertyValue('font-display')),
      ascentOverride: clean(s.getPropertyValue('ascent-override')), descentOverride: clean(s.getPropertyValue('descent-override')),
      lineGapOverride: clean(s.getPropertyValue('line-gap-override')), sizeAdjust: clean(s.getPropertyValue('size-adjust')),
      featureSettings: clean(s.getPropertyValue('font-feature-settings')), variationSettings: clean(s.getPropertyValue('font-variation-settings')),
    });
  };
  const split = (list) => {
    const out = [];
    let depth = 0, current = '';
    for (const c of list) {
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      if (c === ',' && depth === 0) { out.push(current.trim()); current = ''; } else current += c;
    }
    if (current.trim()) out.push(current.trim());
    return out;
  };
  const readRule = (rule, selector, condition) => {
    if (rules.length >= args.maxRules) return;
    const text = rule.style.cssText.trim();
    if (!text) return;
    for (const one of split(selector)) {
      const states = [...new Set([...one.matchAll(STATE)].map((m) => m[1]))];
      if (!states.length) continue;
      // The same elements without the state, which is what the selector can find right now.
      let base = one.replace(/:(?:is|where)\(\s*(?::(?:hover|focus-visible|focus-within|focus|active)\s*,?\s*)+\)/g, '').replace(STATE, '').replace(/:not\(\s*\)/g, '').trim().replace(/[>+~]\s*$/, '').trim();
      if (!base) base = '*';
      let found;
      try { found = document.querySelectorAll(base); } catch { continue; }
      if (!found.length) continue;
      const key = one + '{' + text + '}' + (condition || '');
      if (seenRule.has(key)) continue;
      seenRule.add(key);
      const keys = [];
      for (const el of found) { if (el.__bogenKey && keys.length < args.maxLayers) keys.push(el.__bogenKey); }
      rules.push({ states, selector: one, declarations: text.slice(0, args.maxDeclaration), ...(condition ? { condition } : {}), keys, matches: found.length });
    }
  };
  const visit = (list, base, condition, parent) => {
    for (const rule of list) {
      if (rule instanceof CSSFontFaceRule) { readFace(rule, base); continue; }
      if (rule instanceof CSSImportRule) {
        try { if (rule.styleSheet) visit(rule.styleSheet.cssRules, rule.styleSheet.href || base, condition, parent); } catch {}
        continue;
      }
      if (rule instanceof CSSStyleRule) {
        const selector = parent ? split(rule.selectorText).map((s) => s.includes('&') ? s.replaceAll('&', parent) : parent + ' ' + s).join(', ') : rule.selectorText;
        if (rule.style.length) { STATE.lastIndex = 0; if (STATE.test(selector)) { STATE.lastIndex = 0; readRule(rule, selector, condition); } }
        if (rule.cssRules && rule.cssRules.length) visit(rule.cssRules, base, condition, selector);
        continue;
      }
      if (rule.cssRules) {
        const own = rule.conditionText || (rule.media && rule.media.mediaText) || '';
        visit(rule.cssRules, base, [condition, own].filter(Boolean).join(' and '), parent);
      }
    }
  };
  const readable = new Set();
  for (const sheet of document.styleSheets) {
    try { visit(sheet.cssRules, sheet.href || location.href); if (sheet.href) readable.add(sheet.href); } catch {}
  }
  for (const { url, text } of args.sheets) {
    if (readable.has(url)) continue;
    try { const s = new CSSStyleSheet(); s.replaceSync(text); visit(s.cssRules, url); } catch {}
  }
  const usedFamilies = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/^["']|["']$/g, ''));
  return { faces, usedFamilies: [...new Set(usedFamilies)], rules };
}`;

export function scanArgs(resources: PageResources): string {
  return JSON.stringify({ sheets: resources.sheets, maxRules: MAX_RULES, maxLayers: MAX_LAYERS_PER_RULE, maxDeclaration: MAX_DECLARATION });
}

export interface FontReport {
  /** Font files stored with the document, each one the page itself served. */
  stored: number;
  families: string[];
  /** Families left to Google Fonts by name, since that is where the page got them too. */
  google: string[];
  failed: string[];
}

interface SrcChoice { url?: string; local?: string; format?: string }

/** The first `url()` of a `src`, and its first `local()`. */
function parseSrc(src: string): SrcChoice[] {
  const out: SrcChoice[] = [];
  for (const m of src.matchAll(/(url|local)\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)(?:\s*format\(\s*["']?([\w-]+)["']?\s*\))?/g)) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (m[1] === 'url') out.push({ url: value, format: m[5]?.toLowerCase() });
    else out.push({ local: value });
  }
  return out;
}

const WEB_FORMATS = new Set(['woff2', 'woff', 'truetype', 'opentype', 'woff2-variations', 'woff-variations', 'truetype-variations', 'opentype-variations']);

/**
 * Stores the font files of a captured page. It only ever takes files that the page's own style sheets
 * declare: bytes the browser received when it can, and otherwise the same URL, for other weights of a
 * family the page is using. Files are checked by their first bytes, not by what the server calls them.
 */
export async function storeFonts(scan: SheetScan, resources: PageResources, storage: Storage, fetchFont: (url: string) => Promise<Uint8Array>): Promise<{ faces: StoredFontFace[]; report: FontReport }> {
  const report: FontReport = { stored: 0, families: [], google: [], failed: [] };
  const used = new Set(scan.usedFamilies.map((f) => f.toLowerCase()));
  const faces: StoredFontFace[] = [];
  const families = new Set<string>();
  const google = new Set<string>();
  let total = 0;
  const describe = (face: ScannedFace): StoredFontFace => {
    const { src: _src, base: _base, ...rest } = face;
    return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as unknown as StoredFontFace;
  };
  const rank = (face: ScannedFace) => {
    const candidates = parseSrc(face.src).flatMap((c) => (c.url ? [new URL(c.url, face.base).href.split('#')[0]!] : []));
    return candidates.some((u) => resources.fonts.has(u)) ? 0 : used.has(face.family.toLowerCase()) ? 1 : 2;
  };
  for (const face of [...scan.faces].sort((a, b) => rank(a) - rank(b))) {
    if (faces.length >= MAX_FACES) break;
    const choices = parseSrc(face.src);
    const local = choices.find((c) => c.local)?.local;
    let urls: string[];
    try {
      urls = choices.flatMap((c) => (c.url && (!c.format || WEB_FORMATS.has(c.format)) ? [c.url.startsWith('data:') ? c.url : new URL(c.url, face.base).href.split('#')[0]!] : []));
    } catch {
      report.failed.push(`${face.family}: unusable URL`);
      continue;
    }
    const inUse = used.has(face.family.toLowerCase());
    if (!urls.length) {
      if (local && inUse) faces.push({ ...describe(face), local });
      continue;
    }
    if (urls.some((u) => /^https:\/\/fonts\.gstatic\.com\//.test(u))) {
      google.add(face.family);
      continue;
    }
    const received = urls.find((u) => resources.fonts.has(u));
    // A family this page declares but never used is not worth having in the design.
    if (!received && !inUse) continue;
    let bytes: Uint8Array | null = null;
    const pick = received ?? urls[0]!;
    try {
      if (received) bytes = resources.fonts.get(received)!;
      else if (pick.startsWith('data:')) {
        const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(pick);
        bytes = m ? (m[1] ? Buffer.from(m[2]!, 'base64') : Buffer.from(decodeURIComponent(m[2]!))) : null;
      } else bytes = await fetchFont(pick);
    } catch (e) {
      report.failed.push(`${face.family}: ${(e as Error).message}`);
      if (local) faces.push({ ...describe(face), local });
      continue;
    }
    if (!bytes) continue;
    const mime = fontMime(bytes);
    if (!mime || bytes.length > MAX_FONT_BYTES || total + bytes.length > MAX_FONT_TOTAL) {
      report.failed.push(`${face.family}: ${mime ? 'too large' : 'not a font file'}`);
      continue;
    }
    total += bytes.length;
    const asset = await storage.putAsset(bytes, mime);
    faces.push({ ...describe(face), src: asset.src, ...(local ? { local } : {}), ...(pick.startsWith('data:') ? {} : { from: pick }) });
    families.add(face.family);
    report.stored++;
  }
  report.families = [...families].sort();
  report.google = [...google].sort();
  return { faces, report };
}

/** For a captured page: the same fetch and address rules as its images. */
export function fontFetcher(allowLocal: boolean, isLoopback: (host: string) => boolean): (url: string) => Promise<Uint8Array> {
  return async (url) => {
    const parsed = new URL(url);
    if (allowLocal && isLoopback(parsed.hostname)) {
      const res = await fetch(parsed);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    }
    return (await fetchPublic(url, { timeoutMs: 15_000, maxBytes: MAX_FONT_BYTES })).bytes;
  };
}

/** Turns the capture's element numbers into layer ids, walking the spec and the inserted tree together. */
export function resolveRuleLayers(doc: BogenDoc, rootId: string, root: NewNode & { key?: number }, rules: ScannedRule[]): InteractionRule[] {
  const ids = new Map<number, string>();
  const walk = (spec: NewNode & { key?: number }, id: string) => {
    if (spec.key) ids.set(spec.key, id);
    const kids = doc.getChildren(id);
    (spec.children ?? []).forEach((child, i) => {
      if (kids[i]) walk(child, kids[i]!.id);
    });
  };
  walk(root, rootId);
  return rules.map(({ keys, ...rule }) => ({ ...rule, layers: keys.flatMap((k) => ids.get(k) ?? []) }));
}
