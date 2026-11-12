import { brandBookMap, coerceBrandBook, readBrandBook, BRAND_BOOK_CHAPTERS, type BrandBook } from './brand-book.ts';
import { normalizeLanguageTag } from './content-language.ts';
import { converter, formatHex, parse } from 'culori';
import * as Y from 'yjs';
import { newId, type BogenDoc, type Token, type TokenKind } from './doc.ts';
import { createMode, deleteTextStyle, getTextStyles, isModeName, setTextStyle, setTokenMode, textStyleKey } from './design-system.ts';
import { sanitizeSvgMarkup } from './html-import.ts';

/**
 * A brand is a document of its own kind: a normal Y.Doc with `meta.kind = 'brand'`, so that sync, undo,
 * multiplayer and `.bogen` files apply unchanged. Its structured content lives in shared maps of its own,
 * and its pages hold the example artboards. Design files point at one through `meta.brandLink`.
 *
 * Brands arrive from other devices and imported files, so nothing here trusts what is stored: every read goes
 * through `coerceItem`, which keeps known fields of the right type, within limits.
 */

export const BRAND_KIND = 'brand';
const FIELDS_MAP = 'brandFields';
const ITEMS_MAP = 'brandItems';
const VERSIONS_MAP = 'brandVersions';
const WAIVERS_MAP = 'brandWaivers';
const LINK_KEY = 'brandLink';
const KIND_KEY = 'kind';

const MAX_TEXT = 2000;
const MAX_NAME = 200;
const MAX_ITEMS_PER_SECTION = 500;
const MAX_LIST = 64;
const MAX_SVG = 256 * 1024;

export type Severity = 'hard' | 'soft';
export type BrandSection = 'colors' | 'pairings' | 'logos' | 'families' | 'typeScale' | 'spacing' | 'radius' | 'rules' | 'words' | 'voiceExamples' | 'artboards' | 'assets';
export const BRAND_SECTIONS: readonly BrandSection[] = ['colors', 'pairings', 'logos', 'families', 'typeScale', 'spacing', 'radius', 'rules', 'words', 'voiceExamples', 'artboards', 'assets'];

/** Every value starts as a suggestion when it was extracted or an agent added it, until a person or an instruction confirms it. */
export interface BrandItemBase { id: string; suggested?: boolean; source?: string; note?: string }
export interface BrandColor extends BrandItemBase {
  name: string;
  role: string;
  value: string;
  token: string;
  usage?: number;
  /** Its value in other theme modes of a file, such as `{ light: '#...' }`. */
  modes?: Record<string, string>;
}
export interface BrandPairing extends BrandItemBase { fg: string; bg: string; verdict: 'allow' | 'forbid' }
export interface BrandLogo extends BrandItemBase { name: string; asset: string; svg?: string; background: string; minWidth: number; clearSpace: number; aspect?: number }
export interface BrandFamily extends BrandItemBase { family: string; role: string; fallback: string; weights: number[]; license: string; assets: string[]; token: string }
export interface BrandTypeStep extends BrandItemBase { name: string; role: string; size: number; lineHeight: string; weight: number; tracking: string; family: string; token: string }
export interface BrandSize extends BrandItemBase { name: string; value: number; token: string }
export type BrandRuleTopic = 'general' | 'color' | 'type' | 'layout' | 'imagery' | 'iconography' | 'logo' | 'voice';
export type BrandRuleCheck = { type: 'no-gradient' | 'no-shadow' | 'no-glow' | 'no-uppercase' } | { type: 'forbid-text'; value: string } | { type: 'require-text'; value: string } | { type: 'forbid-style'; prop: string; value: string } | { type: 'max-families'; value: number };
/**
 * The language of a word, an example or a rule (brand-language.ts): a BCP 47 tag, `*` for every language, or left out
 * for the brand's primary language.
 */
export interface BrandItemLanguage { lang?: string }
export interface BrandRule extends BrandItemBase, BrandItemLanguage { text: string; kind: 'do' | 'dont'; severity: Severity; topic: BrandRuleTopic; check?: BrandRuleCheck; flagged?: boolean }
export interface BrandWord extends BrandItemBase, BrandItemLanguage { word: string; use: 'use' | 'avoid'; instead?: string; severity: Severity }
export interface BrandVoiceExample extends BrandItemBase, BrandItemLanguage { good: string; bad: string }
export interface BrandArtboard extends BrandItemBase { nodeId: string; name: string; verdict: 'good' | 'bad'; template?: boolean }
export interface BrandAsset extends BrandItemBase { name: string; asset: string; kind: 'image' | 'icon' | 'font' | 'other'; tags: string[]; alt: string }

export interface BrandFields {
  name: string;
  positioning: string;
  audience: string;
  tone: string;
  license: string;
  layoutNotes: string;
  grid: string;
  /** Widest content, in px. */
  container: number;
  /** Text under this contrast is a violation. */
  minContrast: number;
  /** With `forbid`, only pairs listed as allowed may be combined. */
  pairingDefault: 'allow' | 'forbid';
  offPalette: Severity;
  shadows: 'any' | 'none';
  gradients: 'any' | 'none';
  /** A write that adds a hard violation is refused. */
  strict: boolean;
  /** The brand with the latest time is the default for new files. 0 means not the default. */
  defaultAt: number;
  /**
   * The brand's primary language, a BCP 47 tag such as en, de-AT or pt-BR (brand-language.ts). Empty means not set,
   * and then the voice check reads German or English from the brand's own words where they say it. Brands from before
   * other languages could only say de or en, which stay valid.
   */
  language: string;
  /** The other languages the brand speaks, as tags, without the primary. */
  languages: string[];
  /** How a German text addresses the reader. */
  address: '' | 'du' | 'sie';
  /** At most this many words in a sentence. */
  sentenceWords: number;
  /** At most this many sentences in one text, such as a paragraph. */
  paragraphSentences: number;
  headingMinWords: number;
  headingMaxWords: number;
  /** Decimal and thousands separators: de writes 1.000,50, en writes 1,000.50. */
  numberFormat: '' | 'de' | 'en';
}

export const BRAND_FIELD_DEFAULTS: BrandFields = {
  name: '', positioning: '', audience: '', tone: '', license: '', layoutNotes: '', grid: '', container: 0,
  minContrast: 4.5, pairingDefault: 'allow', offPalette: 'hard', shadows: 'any', gradients: 'any', strict: false, defaultAt: 0,
  language: '', languages: [], address: '', sentenceWords: 0, paragraphSentences: 0, headingMinWords: 0, headingMaxWords: 0, numberFormat: '',
};

export interface BrandData {
  /** Optional for legacy documents; drafts never become binding rules automatically. */
  book?: BrandBook;
  fields: BrandFields;
  /** Fields not confirmed yet. */
  suggestedFields: string[];
  /** What each of those fields held in the latest version: what binds until the suggestion is confirmed. */
  priorFields?: Partial<BrandFields>;
  colors: BrandColor[];
  pairings: BrandPairing[];
  logos: BrandLogo[];
  families: BrandFamily[];
  typeScale: BrandTypeStep[];
  spacing: BrandSize[];
  radius: BrandSize[];
  rules: BrandRule[];
  words: BrandWord[];
  voiceExamples: BrandVoiceExample[];
  artboards: BrandArtboard[];
  assets: BrandAsset[];
}

export interface BrandVersion { id: string; n: number; at: number; by: string; note: string; data: BrandData }
export interface BrandLink { id: string; version: string; at: number }
export interface BrandWaiver { nodeId: string; rule: string; reason: string; by: string; at: number }

// ---------------------------------------------------------------- colour

const oklab = converter('oklab');

/** `#rrggbb` for any CSS colour, or null. Translucent colours keep their alpha as `#rrggbbaa`. */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 120) return null;
  const parsed = parse(value.trim());
  if (!parsed) return null;
  const hex = formatHex(parsed);
  if (!hex) return null;
  const alpha = parsed.alpha ?? 1;
  if (alpha >= 1) return hex;
  return `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}

/** The alpha of a colour, 1 when it has none. */
export function colorAlpha(value: string): number {
  return parse(value)?.alpha ?? 1;
}

/** Perceptual distance. 0 is identical, about 2 is the smallest difference people see. */
export function colorDistance(a: string, b: string): number {
  const x = oklab(parse(a));
  const y = oklab(parse(b));
  if (!x || !y) return Infinity;
  return 100 * Math.hypot(x.l - y.l, (x.a ?? 0) - (y.a ?? 0), (x.b ?? 0) - (y.b ?? 0));
}

const rgb = converter('rgb');

/** WCAG relative luminance, from 0 to 1. */
export function luminance(color: string): number {
  const c = rgb(parse(color));
  if (!c) return 0;
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round((((hi + 0.05) / (lo + 0.05)) * 100)) / 100;
}

/** Puts a translucent colour on top of an opaque one. */
export function flattenColor(top: string, under: string): string {
  const t = rgb(parse(top));
  const u = rgb(parse(under));
  if (!t || !u) return top;
  const a = t.alpha ?? 1;
  return formatHex({ mode: 'rgb', r: t.r * a + u.r * (1 - a), g: t.g * a + u.g * (1 - a), b: t.b * a + u.b * (1 - a) }) ?? top;
}

/** All CSS colours named inside a value, such as a border shorthand or a shadow. */
export function colorsIn(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color|hwb)\([^()]*\)|\b[a-zA-Z]{3,}\b/g)) {
    if (/^(transparent|currentcolor|inherit|initial|unset|none|solid|dashed|dotted|double|inset)$/i.test(m[0])) continue;
    const hex = normalizeColor(m[0]);
    if (hex) out.push(hex);
  }
  return out;
}

// ---------------------------------------------------------------- reading stored values

function text(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string') return '';
  // Control characters have no place in brand text, and could hide things from a reader.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, max).trim();
}

function num(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

function list(value: unknown, max = MAX_LIST): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

const ASSET = /^bogen-asset:[a-f0-9]{64}\.[a-z0-9]{2,5}$/;
function assetRef(value: unknown): string {
  return typeof value === 'string' && ASSET.test(value) ? value : '';
}

const TOKEN_NAME = /^[a-zA-Z_][\w-]{0,79}$/;
function tokenName(value: unknown): string {
  return typeof value === 'string' && TOKEN_NAME.test(value) ? value : '';
}

/** Font names go into CSS, so only letters, digits and a few separators get through. */
export function safeFamily(value: unknown): string {
  const t = text(value, 120).replace(/^["']|["']$/g, '');
  return /^[\p{L}\p{N} _.+-]{1,120}$/u.test(t) ? t : '';
}

/** Rules that talk to an agent rather than about a design. Kept visible, and left out of what an agent must follow. */
const INSTRUCTION_LIKE = /\b(ignore|disregard|forget)\b.{0,40}\b(instructions?|rules?|prompts?|above|previous|prior)\b|system prompt|you are now|\bmcp__|\b(file|layer|page|batch|html|comment|brand|agent|tokens?)_(create|delete|write|list|open|undo|set|reply|add|update|link)\b|\bcall (the |a )?\w*\s*tool\b|\b(run|execute)\b.{0,20}\b(command|shell|script|curl|bash)\b|\bcurl\s|\bexfiltrat|\b(api[ _-]?key|password|credential|secret)s?\b|\bsend\b.{0,60}\bhttps?:|https?:\/\/\S+.{0,30}\b(post|send|upload)\b|\bdelete (all|every|everything)\b/i;

export function looksLikeInstruction(value: string): boolean {
  return INSTRUCTION_LIKE.test(value);
}

function ruleCheck(value: unknown): BrandRuleCheck | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v.type === 'no-gradient' || v.type === 'no-shadow' || v.type === 'no-glow' || v.type === 'no-uppercase') return { type: v.type };
  if (v.type === 'forbid-text' || v.type === 'require-text') {
    const t = text(v.value, 200);
    return t ? { type: v.type, value: t } : undefined;
  }
  if (v.type === 'forbid-style') {
    const prop = text(v.prop, 80);
    const t = text(v.value, 200);
    return /^[a-zA-Z-]+$/.test(prop) && t ? { type: 'forbid-style', prop, value: t } : undefined;
  }
  if (v.type === 'max-families') return { type: 'max-families', value: num(v.value, 1, 20, 2) };
  return undefined;
}

function base(id: string, raw: Record<string, unknown>): BrandItemBase {
  const source = text(raw.source, 300);
  const note = text(raw.note);
  return { id, ...(raw.suggested === true ? { suggested: true } : {}), ...(source ? { source } : {}), ...(note ? { note } : {}) };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/**
 * The known fields of one item, of the right type and within limits, or null when what makes it an item is missing.
 * Writes go through it as well, so an agent and an imported file are held to the same shape.
 */
export function coerceItem(section: BrandSection, id: string, raw: Record<string, unknown>): BrandData[BrandSection][number] | null {
  const b = base(id, raw);
  switch (section) {
    case 'colors': {
      const value = normalizeColor(raw.value);
      if (!value) return null;
      const name = text(raw.name, MAX_NAME) || value;
      const usage = num(raw.usage, 0, 1e9, 0);
      const modes: Record<string, string> = {};
      if (raw.modes && typeof raw.modes === 'object') {
        for (const [mode, v] of Object.entries(raw.modes as Record<string, unknown>).slice(0, 8)) {
          const hex = normalizeColor(v);
          if (hex && isModeName(mode)) modes[mode] = hex;
        }
      }
      return { ...b, name, role: text(raw.role, 80), value, token: tokenName(raw.token) || slug(name) || 'color', ...(usage ? { usage } : {}), ...(Object.keys(modes).length ? { modes } : {}) };
    }
    case 'pairings': {
      const fg = text(raw.fg, 80);
      const bg = text(raw.bg, 80);
      return fg && bg ? { ...b, fg, bg, verdict: oneOf(raw.verdict, ['allow', 'forbid'] as const, 'forbid') } : null;
    }
    case 'logos': {
      const asset = assetRef(raw.asset);
      const svg = typeof raw.svg === 'string' && raw.svg.length <= MAX_SVG ? sanitizeSvgMarkup(raw.svg) : '';
      if (!asset && !svg) return null;
      const aspect = num(raw.aspect, 0, 1000, 0);
      return {
        ...b, name: text(raw.name, MAX_NAME) || 'Logo', asset, ...(svg ? { svg } : {}), background: text(raw.background, 80) || 'any',
        minWidth: num(raw.minWidth, 0, 10000, 0), clearSpace: num(raw.clearSpace, 0, 10000, 0), ...(aspect ? { aspect } : {}),
      };
    }
    case 'families': {
      const family = safeFamily(raw.family);
      if (!family) return null;
      return {
        ...b, family, role: text(raw.role, 80) || 'body', fallback: text(raw.fallback, 200).replace(/[^\p{L}\p{N} ,_"'.-]/gu, ''),
        weights: list(raw.weights).map((w) => num(w, 1, 1000, 0)).filter(Boolean), license: text(raw.license),
        assets: list(raw.assets).map(assetRef).filter(Boolean), token: tokenName(raw.token) || `font-${slug(text(raw.role, 80) || family)}`,
      };
    }
    case 'typeScale': {
      const size = num(raw.size, 0, 2000, 0);
      if (!size) return null;
      const name = text(raw.name, MAX_NAME) || `${size}px`;
      return {
        ...b, name, role: text(raw.role, 80), size, lineHeight: text(raw.lineHeight, 20).replace(/[^\d.a-z%]/gi, ''), weight: num(raw.weight, 0, 1000, 0),
        tracking: text(raw.tracking, 20).replace(/[^\d.a-z%-]/gi, ''), family: text(raw.family, 120), token: tokenName(raw.token) || `text-${slug(name)}`,
      };
    }
    case 'spacing':
    case 'radius': {
      const value = num(raw.value, 0, 10000, -1);
      if (value < 0) return null;
      const name = text(raw.name, MAX_NAME) || String(value);
      return { ...b, name, value, token: tokenName(raw.token) || `${section === 'spacing' ? 'space' : 'radius'}-${slug(name)}` };
    }
    case 'rules': {
      const body = text(raw.text);
      if (!body) return null;
      const check = ruleCheck(raw.check);
      return {
        ...b, text: body, kind: oneOf(raw.kind, ['do', 'dont'] as const, 'do'), severity: oneOf(raw.severity, ['hard', 'soft'] as const, 'soft'),
        topic: oneOf(raw.topic, ['general', 'color', 'type', 'layout', 'imagery', 'iconography', 'logo', 'voice'] as const, 'general'),
        ...(check ? { check } : {}), ...itemLang(raw.lang), ...(looksLikeInstruction(body) ? { flagged: true } : {}),
      };
    }
    case 'words': {
      const word = text(raw.word, 120);
      if (!word) return null;
      const instead = text(raw.instead, 120);
      return { ...b, word, use: oneOf(raw.use, ['use', 'avoid'] as const, 'avoid'), ...(instead ? { instead } : {}), severity: oneOf(raw.severity, ['hard', 'soft'] as const, 'soft'), ...itemLang(raw.lang) };
    }
    case 'voiceExamples': {
      const good = text(raw.good);
      const bad = text(raw.bad);
      return good || bad ? { ...b, good, bad, ...itemLang(raw.lang) } : null;
    }
    case 'artboards': {
      const nodeId = text(raw.nodeId, 64);
      if (!/^[0-9a-z]{1,64}$/i.test(nodeId)) return null;
      return { ...b, nodeId, name: text(raw.name, MAX_NAME) || 'Example', verdict: oneOf(raw.verdict, ['good', 'bad'] as const, 'good'), ...(raw.template === true ? { template: true } : {}) };
    }
    case 'assets': {
      const asset = assetRef(raw.asset);
      if (!asset) return null;
      return {
        ...b, name: text(raw.name, MAX_NAME) || 'Asset', asset, kind: oneOf(raw.kind, ['image', 'icon', 'font', 'other'] as const, 'image'),
        tags: list(raw.tags).map((t) => text(t, 60)).filter(Boolean), alt: text(raw.alt, 400),
      };
    }
  }
}

/** An item's own language: a tag, or `*` for every language. Left out for the primary, and for what is not a tag. */
function itemLang(value: unknown): { lang?: string } {
  if (value === '*') return { lang: '*' };
  const tag = normalizeLanguageTag(value);
  return tag ? { lang: tag } : {};
}

/** Language tags, each once, in the order given. What is not a tag is dropped. */
function languageList(value: unknown): string[] {
  const out: string[] = [];
  for (const v of list(value, 64)) {
    const tag = normalizeLanguageTag(v);
    if (tag && !out.includes(tag) && out.length < 20) out.push(tag);
  }
  return out;
}

function fieldValue<K extends keyof BrandFields>(key: K, value: unknown): BrandFields[K] {
  const fallback = BRAND_FIELD_DEFAULTS[key];
  let out: unknown = fallback;
  switch (key) {
    case 'container': out = num(value, 0, 20000, 0); break;
    case 'minContrast': out = num(value, 1, 21, 4.5); break;
    case 'defaultAt': out = num(value, 0, 8.64e15, 0); break;
    case 'pairingDefault': out = oneOf(value, ['allow', 'forbid'] as const, 'allow'); break;
    case 'offPalette': out = oneOf(value, ['hard', 'soft'] as const, 'hard'); break;
    case 'shadows': out = oneOf(value, ['any', 'none'] as const, 'any'); break;
    case 'gradients': out = oneOf(value, ['any', 'none'] as const, 'any'); break;
    case 'strict': out = value === true; break;
    case 'language': out = normalizeLanguageTag(value) ?? ''; break;
    case 'languages': out = languageList(value); break;
    case 'address': out = oneOf(value, ['', 'du', 'sie'] as const, ''); break;
    case 'numberFormat': out = oneOf(value, ['', 'de', 'en'] as const, ''); break;
    case 'sentenceWords': out = Math.round(num(value, 0, 200, 0)); break;
    case 'paragraphSentences': out = Math.round(num(value, 0, 50, 0)); break;
    case 'headingMinWords': out = Math.round(num(value, 0, 50, 0)); break;
    case 'headingMaxWords': out = Math.round(num(value, 0, 50, 0)); break;
    case 'name': out = text(value, MAX_NAME); break;
    default: out = text(value);
  }
  return out as BrandFields[K];
}

export function brandFieldsMap(doc: BogenDoc): Y.Map<unknown> {
  return doc.y.getMap(FIELDS_MAP);
}

export function brandItemsMap(doc: BogenDoc): Y.Map<Y.Map<unknown>> {
  return doc.y.getMap(ITEMS_MAP);
}

export function brandVersionsMap(doc: BogenDoc): Y.Map<unknown> {
  return doc.y.getMap(VERSIONS_MAP);
}

export function brandWaiversMap(doc: BogenDoc): Y.Map<unknown> {
  return doc.y.getMap(WAIVERS_MAP);
}

/** What an undo manager of a file must also track, so that brand edits undo like any others. */
export function brandUndoScope(doc: BogenDoc): Y.Map<any>[] {
  return [brandFieldsMap(doc), brandItemsMap(doc), brandVersionsMap(doc), brandBookMap(doc)];
}

/** Asset names a brand holds on to, so that `.bogen` files carry them. */
export function brandAssets(doc: BogenDoc): string[] {
  const out = new Set<string>();
  const add = (src: string) => {
    if (src.startsWith('bogen-asset:')) out.add(src.slice('bogen-asset:'.length));
  };
  brandItemsMap(doc).forEach((m) => {
    if (!(m instanceof Y.Map)) return;
    const asset = m.get('asset');
    if (typeof asset === 'string') add(asset);
    const assets = m.get('assets');
    if (Array.isArray(assets)) for (const a of assets) if (typeof a === 'string') add(a);
  });
  return [...out];
}

export function isBrandDoc(doc: BogenDoc): boolean {
  return doc.meta.get(KIND_KEY) === BRAND_KIND;
}

export function markBrandDoc(doc: BogenDoc, origin?: unknown): void {
  doc.transact(() => doc.meta.set(KIND_KEY, BRAND_KIND), origin);
}

/** Rejects a shape that would break readers. Applied to whatever arrives from another device or file. */
export function assertBrandShape(doc: BogenDoc): void {
  brandItemsMap(doc).forEach((m) => {
    if (!(m instanceof Y.Map) || typeof m.get('section') !== 'string') throw new Error('This brand is damaged.');
  });
}

export function emptyBrand(): BrandData {
  return { fields: { ...BRAND_FIELD_DEFAULTS }, suggestedFields: [], colors: [], pairings: [], logos: [], families: [], typeScale: [], spacing: [], radius: [], rules: [], words: [], voiceExamples: [], artboards: [], assets: [] };
}

/** The whole brand as checked, plain values. Cheap enough to call on each change of a small document. */
export function readBrand(doc: BogenDoc): BrandData {
  const out = emptyBrand();
  const book = readBrandBook(doc);
  if (book) out.book = book;
  const fields = brandFieldsMap(doc);
  for (const key of Object.keys(BRAND_FIELD_DEFAULTS) as (keyof BrandFields)[]) {
    if (fields.has(key)) (out.fields as unknown as Record<string, unknown>)[key] = fieldValue(key, fields.get(key));
  }
  const suggested = fields.get('suggested');
  if (Array.isArray(suggested)) out.suggestedFields = suggested.filter((s): s is string => typeof s === 'string' && s in BRAND_FIELD_DEFAULTS);
  if (out.suggestedFields.length) {
    const published = headVersionFields(doc);
    const prior: Record<string, unknown> = {};
    for (const key of out.suggestedFields as (keyof BrandFields)[]) if (published && key in published) prior[key] = fieldValue(key, published[key]);
    out.priorFields = prior as Partial<BrandFields>;
  }
  const order = new Map<string, string>();
  brandItemsMap(doc).forEach((m, id) => {
    if (!(m instanceof Y.Map)) return;
    const section = m.get('section') as BrandSection;
    if (!BRAND_SECTIONS.includes(section)) return;
    const bucket = out[section] as BrandItemBase[];
    if (bucket.length >= MAX_ITEMS_PER_SECTION) return;
    const item = coerceItem(section, id, m.toJSON() as Record<string, unknown>);
    if (!item) return;
    bucket.push(item);
    order.set(id, String(m.get('order') ?? id));
  });
  const byOrder = (a: BrandItemBase, b: BrandItemBase) => {
    const x = order.get(a.id)!;
    const y = order.get(b.id)!;
    return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : 1;
  };
  for (const section of BRAND_SECTIONS) (out[section] as BrandItemBase[]).sort(byOrder);
  return out;
}

/** The fields of the newest version as stored, without reading the rest of what versions hold. */
function headVersionFields(doc: BogenDoc): Record<string, unknown> | null {
  let head: { id: string; at: number; fields: unknown } | null = null;
  brandVersionsMap(doc).forEach((value, id) => {
    const v = value as { at?: unknown; data?: { fields?: unknown } } | null;
    const at = num(v?.at, 0, 8.64e15, 0);
    if (!head || at > head.at || (at === head.at && id > head.id)) head = { id, at, fields: v?.data?.fields };
  });
  const fields = (head as { fields: unknown } | null)?.fields;
  return fields && typeof fields === 'object' ? (fields as Record<string, unknown>) : null;
}

/**
 * The fields as they bind. A field that is still a suggestion binds nobody, like a suggested item: until it is
 * confirmed, what counts is what the latest version held, or the default where there is no version. This is also
 * what dismissing the suggestion puts back. The name is who the brand is, not a rule, and stays.
 */
export function bindingFields(data: BrandData): BrandFields {
  if (!data.suggestedFields.length) return data.fields;
  const out = { ...data.fields } as unknown as Record<string, unknown>;
  for (const key of data.suggestedFields as (keyof BrandFields)[]) {
    if (key === 'name' || key === 'defaultAt' || !(key in BRAND_FIELD_DEFAULTS)) continue;
    out[key] = data.priorFields && key in data.priorFields ? data.priorFields[key] : BRAND_FIELD_DEFAULTS[key];
  }
  return out as unknown as BrandFields;
}

/** The brand with its fields as they bind: what a check, a brief or a linked file goes by. Safe to call twice. */
export function bindingBrand(data: BrandData): BrandData {
  const fields = bindingFields(data);
  return fields === data.fields ? data : { ...data, fields };
}

// ---------------------------------------------------------------- writing

export function setBrandField<K extends keyof BrandFields>(doc: BogenDoc, key: K, value: BrandFields[K], origin?: unknown): void {
  doc.transact(() => keepingItemLanguages(doc, key === 'language', () => brandFieldsMap(doc).set(key, fieldValue(key, value))), origin);
}

/** Marks identity fields as suggestions, or confirms them with `suggested: false`. */
export function markBrandFields(doc: BogenDoc, keys: string[], suggested: boolean, origin?: unknown): void {
  doc.transact(() => keepingItemLanguages(doc, keys.includes('language'), () => {
    const map = brandFieldsMap(doc);
    const current = new Set(Array.isArray(map.get('suggested')) ? (map.get('suggested') as string[]) : []);
    for (const k of keys) {
      if (suggested) current.add(k);
      else current.delete(k);
    }
    map.set('suggested', [...current]);
  }), origin);
}

/** The primary language as it binds, read cheaply: the field, or what the latest version held while it is a suggestion. */
function bindingPrimary(doc: BogenDoc): string {
  const fields = brandFieldsMap(doc);
  const open = fields.get('suggested');
  if (Array.isArray(open) && open.includes('language')) return fieldValue('language', headVersionFields(doc)?.language);
  return fieldValue('language', fields.get('language'));
}

/** Items with no language of their own, which are in the primary. */
const LANGUAGE_ITEMS: readonly BrandSection[] = ['words', 'voiceExamples', 'rules'];

/**
 * Runs a write that may change the primary language, and keeps what the brand's words, examples and rules are in.
 * They are in the primary when they name no language, so when one primary takes over from another, those are marked
 * with the language they were written in, and that language stays among the brand's languages. Setting a primary for
 * the first time, or clearing it, changes nothing: the items were in no named language before, or are again.
 */
function keepingItemLanguages(doc: BogenDoc, touchesPrimary: boolean, write: () => void): void {
  if (!touchesPrimary) return write();
  const before = bindingPrimary(doc);
  write();
  const after = bindingPrimary(doc);
  if (!before || !after || before === after) return;
  let kept = false;
  brandItemsMap(doc).forEach((m) => {
    if (!(m instanceof Y.Map) || !LANGUAGE_ITEMS.includes(m.get('section') as BrandSection)) return;
    const lang = m.get('lang');
    if (lang === before) kept = true;
    if (typeof lang === 'string' && lang) return;
    m.set('lang', before);
    kept = true;
  });
  const fields = brandFieldsMap(doc);
  const others = fieldValue('languages', fields.get('languages')).filter((t) => t !== after);
  const next = kept && !others.includes(before) ? [before, ...others] : others;
  if (JSON.stringify(next) !== JSON.stringify(fieldValue('languages', fields.get('languages')))) fields.set('languages', next);
}

let orderSeq = 0;

/**
 * What a writer may give where a value is a choice. Reading stays lenient, because stored values come from other
 * devices and old files, and falls back to a default. A writer is told instead: a rule sent as kind "don't" must not
 * quietly become a "do", nor a pair sent as "allowed" a forbidden one.
 */
export const BRAND_FIELD_CHOICES: Partial<Record<keyof BrandFields, readonly string[]>> = {
  pairingDefault: ['allow', 'forbid'], offPalette: ['hard', 'soft'], shadows: ['any', 'none'], gradients: ['any', 'none'],
  address: ['', 'du', 'sie'], numberFormat: ['', 'de', 'en'],
};
const TAG_EXAMPLE = 'a language tag such as en, de-AT or pt-BR';
const NUMBER_FIELDS: readonly (keyof BrandFields)[] = ['container', 'minContrast', 'sentenceWords', 'paragraphSentences', 'headingMinWords', 'headingMaxWords'];
export const BRAND_ITEM_CHOICES: Partial<Record<BrandSection, Record<string, readonly string[]>>> = {
  pairings: { verdict: ['allow', 'forbid'] },
  rules: { kind: ['do', 'dont'], severity: ['hard', 'soft'], topic: ['general', 'color', 'type', 'layout', 'imagery', 'iconography', 'logo', 'voice'] },
  words: { use: ['use', 'avoid'], severity: ['hard', 'soft'] },
  artboards: { verdict: ['good', 'bad'] },
  assets: { kind: ['image', 'icon', 'font', 'other'] },
};
const RULE_CHECKS = 'no-gradient, no-shadow, no-glow, no-uppercase, forbid-text (with value), require-text (with value), forbid-style (with prop and value), max-families (with value)';

function choices(options: readonly string[]): string {
  return options.map((o) => (o ? `"${o}"` : '"" (not set)')).join(', ');
}

/** Why a field value from a writer cannot be stored as it was meant, or null when it can. */
export function brandFieldProblem(key: string, value: unknown): string | null {
  if (!(key in BRAND_FIELD_DEFAULTS) || key === 'defaultAt') return `There is no brand field "${key}". The fields are: ${Object.keys(BRAND_FIELD_DEFAULTS).filter((k) => k !== 'defaultAt').join(', ')}.`;
  const options = BRAND_FIELD_CHOICES[key as keyof BrandFields];
  if (options && !(typeof value === 'string' && options.includes(value))) return `${key} must be one of ${choices(options)}, not ${JSON.stringify(value)}.`;
  if (key === 'strict' && typeof value !== 'boolean') return `strict must be true or false, not ${JSON.stringify(value)}.`;
  if (key === 'language') return value === '' || normalizeLanguageTag(value) ? null : `language is the brand's primary language: ${TAG_EXAMPLE}, or "" (not set), not ${JSON.stringify(value)}.`;
  if (key === 'languages') {
    if (!Array.isArray(value)) return `languages is a list of the other languages the brand speaks, each ${TAG_EXAMPLE}, not ${JSON.stringify(value)}.`;
    const bad = value.find((v) => !normalizeLanguageTag(v));
    if (bad !== undefined) return `languages: ${JSON.stringify(bad)} is not ${TAG_EXAMPLE}.`;
    if (value.length > 20) return 'languages: a brand speaks at most 20 languages besides its primary.';
    return null;
  }
  if ((NUMBER_FIELDS as readonly string[]).includes(key) && !Number.isFinite(typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN)) return `${key} must be a number, not ${JSON.stringify(value)}.`;
  if (!options && key !== 'strict' && !(NUMBER_FIELDS as readonly string[]).includes(key) && typeof value !== 'string') return `${key} must be text, not ${JSON.stringify(value)}.`;
  return null;
}

/** Why an item from a writer cannot be stored as it was meant, or null when it can. Looks only at what the patch gives. */
export function brandItemProblem(section: BrandSection, patch: Record<string, unknown>): string | null {
  for (const [key, options] of Object.entries(BRAND_ITEM_CHOICES[section] ?? {})) {
    const value = patch[key];
    if (value !== undefined && !(typeof value === 'string' && options.includes(value))) return `${section}: ${key} must be one of ${choices(options)}, not ${JSON.stringify(value)}.`;
  }
  if (section === 'rules' && patch.check !== undefined && patch.check !== null && !ruleCheck(patch.check)) return `rules: check is not one this brand can run. Checks: ${RULE_CHECKS}. Leave check out for a rule that is judged by eye.`;
  if (patch.lang !== undefined && patch.lang !== null && patch.lang !== '') {
    if (!['rules', 'words', 'voiceExamples'].includes(section)) return `${section}: only words, voiceExamples and rules have a language.`;
    if (patch.lang !== '*' && !normalizeLanguageTag(patch.lang)) return `${section}: lang must be ${TAG_EXAMPLE}, "*" for every language, or left out for the primary, not ${JSON.stringify(patch.lang)}.`;
  }
  return null;
}

/** The item a patch would make, merged with what is stored under its id. Throws what `upsertBrandItem` would. */
export function previewBrandItem(doc: BogenDoc, section: BrandSection, patch: Record<string, unknown> & { id?: string }): BrandData[BrandSection][number] {
  const id = patch.id && /^[0-9a-z]{4,40}$/.test(patch.id) ? patch.id : '';
  const existing = id ? brandItemsMap(doc).get(id) : undefined;
  if (existing && existing.get('section') !== section) throw new Error(`Item ${id} is in ${String(existing.get('section'))}, not ${section}.`);
  const clean = coerceItem(section, id || 'new', { ...(existing?.toJSON() as Record<string, unknown> | undefined), ...patch });
  if (!clean) throw new Error(`That is not a valid item for ${section}: ${describeRequired(section)}`);
  return clean;
}

/** Creates or merges an item, field by field, so that two devices editing different fields both keep theirs. */
export function upsertBrandItem(doc: BogenDoc, section: BrandSection, patch: Record<string, unknown> & { id?: string }, origin?: unknown): string {
  const id = patch.id && /^[0-9a-z]{4,40}$/.test(patch.id) ? patch.id : newId();
  const items = brandItemsMap(doc);
  const existing = items.get(id);
  if (existing && existing.get('section') !== section) throw new Error(`Item ${id} is in ${String(existing.get('section'))}, not ${section}.`);
  const merged = { ...(existing?.toJSON() as Record<string, unknown> | undefined), ...patch };
  const clean = coerceItem(section, id, merged);
  if (!clean) throw new Error(`That is not a valid item for ${section}: ${describeRequired(section)}`);
  doc.transact(() => {
    let m = items.get(id);
    if (!m) {
      m = new Y.Map<unknown>();
      m.set('section', section);
      m.set('order', `${Date.now().toString(36).padStart(9, '0')}${(orderSeq++ % 1296).toString(36).padStart(2, '0')}${id}`);
      items.set(id, m);
    }
    for (const [key, value] of Object.entries(clean)) {
      if (key === 'id' || key === 'flagged') continue;
      if (JSON.stringify(m.get(key)) !== JSON.stringify(value)) m.set(key, value);
    }
    for (const key of ['suggested', 'source', 'note', 'instead', 'check', 'template', 'svg', 'usage', 'aspect', 'modes', 'lang'] as const) {
      if (m.has(key) && !(key in clean)) m.delete(key);
    }
  }, origin);
  return id;
}

function describeRequired(section: BrandSection): string {
  const need: Record<BrandSection, string> = {
    colors: 'value must be a CSS colour.', pairings: 'fg and bg are required: ids of colours.', logos: 'asset (bogen-asset:...) or svg is required.', families: 'family must be a plain font name.',
    typeScale: 'size in px is required.', spacing: 'value in px is required.', radius: 'value in px is required.', rules: 'text is required.', words: 'word is required.', voiceExamples: 'good or bad is required.',
    artboards: 'nodeId is required.', assets: 'asset (bogen-asset:...) is required.',
  };
  return need[section];
}

export function deleteBrandItem(doc: BogenDoc, id: string, origin?: unknown): void {
  doc.transact(() => brandItemsMap(doc).delete(id), origin);
}

/** Confirms suggestions. Without ids it confirms everything. Returns how many changed. */
export function confirmBrandItems(doc: BogenDoc, ids: string[] | null, origin?: unknown): number {
  let changed = 0;
  doc.transact(() => {
    brandItemsMap(doc).forEach((m, id) => {
      if (m.get('suggested') !== true || (ids && !ids.includes(id))) return;
      m.delete('suggested');
      changed++;
    });
    const fields = brandFieldsMap(doc);
    const open = fields.get('suggested');
    if (Array.isArray(open) && open.length) {
      const kept = ids ? (open as string[]).filter((k) => !ids.includes(k)) : [];
      changed += open.length - kept.length;
      keepingItemLanguages(doc, open.includes('language') && !kept.includes('language'), () => fields.set('suggested', kept));
    }
  }, origin);
  return changed;
}

// ---------------------------------------------------------------- versions

export function brandVersions(doc: BogenDoc): BrandVersion[] {
  const out: Omit<BrandVersion, 'n'>[] = [];
  brandVersionsMap(doc).forEach((value, id) => {
    const v = value as { at?: unknown; by?: unknown; note?: unknown; data?: unknown };
    if (!v || typeof v !== 'object' || !v.data || typeof v.data !== 'object') return;
    out.push({ id, at: num(v.at, 0, 8.64e15, 0), by: text(v.by, 80), note: text(v.note), data: coerceBrandData(v.data as Record<string, unknown>) });
  });
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).map((v, i) => ({ ...v, n: i + 1 }));
}

/** Versions hold plain copies, which come from other devices like everything else. */
function coerceBrandData(raw: Record<string, unknown>): BrandData {
  const out = emptyBrand();
  const book = coerceBrandBook(raw.book);
  if (book) out.book = book;
  const fields = (raw.fields ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(BRAND_FIELD_DEFAULTS) as (keyof BrandFields)[]) {
    if (key in fields) (out.fields as unknown as Record<string, unknown>)[key] = fieldValue(key, fields[key]);
  }
  for (const section of BRAND_SECTIONS) {
    const bucket = out[section] as BrandItemBase[];
    for (const item of list(raw[section], MAX_ITEMS_PER_SECTION)) {
      if (!item || typeof item !== 'object') continue;
      const id = text((item as Record<string, unknown>).id, 64);
      const clean = id ? coerceItem(section, id, item as Record<string, unknown>) : null;
      if (clean) bucket.push(clean);
    }
  }
  return out;
}

export function latestBrandVersion(doc: BogenDoc): BrandVersion | undefined {
  return brandVersions(doc).at(-1);
}

/** The newest version's id, time and number, without reading what versions hold. */
export function brandVersionHead(doc: BogenDoc): { id: string; at: number; n: number } | null {
  let head: { id: string; at: number } | null = null;
  let n = 0;
  brandVersionsMap(doc).forEach((value, id) => {
    const at = num((value as { at?: unknown } | null)?.at, 0, 8.64e15, 0);
    n++;
    if (!head || at > head.at || (at === head.at && id > head.id)) head = { id, at };
  });
  return head ? { ...(head as { id: string; at: number }), n } : null;
}

/** Records the brand as it is now. Linked files see the new version and can take it over. */
export function publishBrandVersion(doc: BogenDoc, info: { note?: string; by?: string }, origin?: unknown): BrandVersion {
  const id = newId();
  // A version records what binds: a field that is still a suggestion keeps the value it had, as a suggested item
  // keeps its mark. Publishing does not confirm anything.
  const { suggestedFields: _open, priorFields: _prior, ...read } = readBrand(doc);
  const data: BrandData = { ...read, fields: bindingFields(readBrand(doc)), suggestedFields: [] };
  const prior = latestBrandVersion(doc);
  const at = Math.max(Date.now(), (prior?.at ?? 0) + 1);
  doc.transact(() => brandVersionsMap(doc).set(id, { at, by: text(info.by, 80), note: text(info.note), data: JSON.parse(JSON.stringify(data)) as unknown }), origin);
  return { id, at, by: text(info.by, 80), note: text(info.note), data, n: (prior?.n ?? 0) + 1 };
}

export interface BrandChange { section: BrandSection | 'fields' | 'book'; id: string; name: string; kind: 'added' | 'removed' | 'changed'; fields?: { field: string; from: unknown; to: unknown }[] }

function itemName(item: BrandItemBase & Record<string, unknown>): string {
  return String(item.name ?? item.family ?? item.word ?? item.text ?? item.good ?? item.id).slice(0, 80);
}

const DIFF_IGNORE = new Set(['id', 'usage', 'source', 'order']);

/** What changed from `a` to `b`, by item id. */
export function diffBrand(a: BrandData, b: BrandData): BrandChange[] {
  const out: BrandChange[] = [];
  for (const def of BRAND_BOOK_CHAPTERS) {
    const before = a.book?.chapters.find((c) => c.id === def.id);
    const after = b.book?.chapters.find((c) => c.id === def.id);
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ section: 'book', id: def.id, name: def.title, kind: !before ? 'added' : !after ? 'removed' : 'changed', fields: [{ field: 'chapter', from: before ?? null, to: after ?? null }] });
  }
  for (const key of Object.keys(BRAND_FIELD_DEFAULTS) as (keyof BrandFields)[]) {
    if (key !== 'defaultAt' && JSON.stringify(a.fields[key]) !== JSON.stringify(b.fields[key])) out.push({ section: 'fields', id: key, name: key, kind: 'changed', fields: [{ field: key, from: a.fields[key], to: b.fields[key] }] });
  }
  for (const section of BRAND_SECTIONS) {
    const before = new Map((a[section] as unknown as (BrandItemBase & Record<string, unknown>)[]).map((i) => [i.id, i]));
    const after = new Map((b[section] as unknown as (BrandItemBase & Record<string, unknown>)[]).map((i) => [i.id, i]));
    for (const [id, item] of after) {
      const old = before.get(id);
      if (!old) {
        out.push({ section, id, name: itemName(item), kind: 'added' });
        continue;
      }
      const fields: { field: string; from: unknown; to: unknown }[] = [];
      for (const field of new Set([...Object.keys(old), ...Object.keys(item)])) {
        if (DIFF_IGNORE.has(field)) continue;
        if (JSON.stringify(old[field]) !== JSON.stringify(item[field])) fields.push({ field, from: old[field], to: item[field] });
      }
      if (fields.length) out.push({ section, id, name: itemName(item), kind: 'changed', fields });
    }
    for (const [id, item] of before) if (!after.has(id)) out.push({ section, id, name: itemName(item), kind: 'removed' });
  }
  return out;
}

// ---------------------------------------------------------------- where a brand came from

const ORIGIN_KEY = 'brandDuplicatedFrom';

/** The brand a duplicate was made from, as it was then: its id, its name and its version number (0: never published). */
export interface BrandOrigin { id: string; name: string; version: number; at: number }

export function brandOriginOf(doc: BogenDoc): BrandOrigin | null {
  const raw = doc.meta.get(ORIGIN_KEY) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[0-9a-z]{4,40}$/.test(raw.id)) return null;
  return { id: raw.id, name: text(raw.name, MAX_NAME), version: Math.round(num(raw.version, 0, 1e6, 0)), at: num(raw.at, 0, 8.64e15, 0) };
}

/**
 * Makes a copy of a brand a brand of its own: no versions, so it starts at version 0 as a draft, and a note of where it
 * came from. A field that is still a suggestion takes the value that binds in the original, since that came from the
 * original's versions, which the copy does not have; suggested items stay suggestions. The default mark and the
 * original's brand system file stay with the original, and so do the files linked to it.
 */
export function makeBrandCopy(doc: BogenDoc, from: BrandOrigin, name: string, origin?: unknown): void {
  const before = readBrand(doc);
  const bound = bindingFields(before);
  const versions = brandVersionsMap(doc);
  // Without versions, a suggestion binds the same in the copy as in the original: the default.
  const resolve = versions.size > 0;
  const differs = (key: string) => JSON.stringify(bound[key as keyof BrandFields]) !== JSON.stringify(before.fields[key as keyof BrandFields]);
  doc.transact(() => {
    const fields = brandFieldsMap(doc);
    if (resolve && before.suggestedFields.some(differs)) {
      for (const key of before.suggestedFields) if (key in BRAND_FIELD_DEFAULTS && differs(key)) fields.set(key, bound[key as keyof BrandFields]);
      fields.set('suggested', before.suggestedFields.filter((k) => !differs(k)));
    }
    for (const id of [...versions.keys()]) versions.delete(id);
    fields.set('defaultAt', 0);
    fields.set('name', fieldValue('name', name));
    doc.meta.delete('brandSystemFile');
    doc.meta.set(ORIGIN_KEY, { id: from.id, name: text(from.name, MAX_NAME), version: from.version, at: from.at });
  }, origin);
}

// ---------------------------------------------------------------- links and waivers

export function brandLinkOf(doc: BogenDoc): BrandLink | null {
  const raw = doc.meta.get(LINK_KEY) as { id?: unknown; version?: unknown; at?: unknown } | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[0-9a-z]{4,40}$/.test(raw.id)) return null;
  return { id: raw.id, version: typeof raw.version === 'string' ? raw.version : '', at: typeof raw.at === 'number' ? raw.at : 0 };
}

export function setBrandLink(doc: BogenDoc, link: BrandLink | null, origin?: unknown): void {
  doc.transact(() => {
    if (link) doc.meta.set(LINK_KEY, link);
    else doc.meta.delete(LINK_KEY);
  }, origin);
}

export function waiverKey(nodeId: string, rule: string): string {
  return `${nodeId}|${rule}`;
}

export function readWaivers(doc: BogenDoc): BrandWaiver[] {
  const out: BrandWaiver[] = [];
  brandWaiversMap(doc).forEach((value, key) => {
    const v = value as { reason?: unknown; by?: unknown; at?: unknown } | null;
    const [nodeId, rule] = key.split('|');
    if (!nodeId || !rule || !v || typeof v !== 'object') return;
    const reason = text(v.reason, 500);
    if (reason) out.push({ nodeId, rule, reason, by: text(v.by, 80), at: num(v.at, 0, 8.64e15, 0) });
  });
  return out;
}

/** Only a person's request reaches this: no MCP tool writes a waiver. */
export function setWaiver(doc: BogenDoc, waiver: { nodeId: string; rule: string; reason: string; by: string } | { nodeId: string; rule: string; remove: true }, origin?: unknown): void {
  doc.transact(() => {
    const key = waiverKey(waiver.nodeId, waiver.rule);
    if ('remove' in waiver) brandWaiversMap(doc).delete(key);
    else brandWaiversMap(doc).set(key, { reason: text(waiver.reason, 500), by: text(waiver.by, 80), at: Date.now() });
  }, origin);
}

// ---------------------------------------------------------------- tokens

function pxValue(n: number): string {
  return `${n}px`;
}

export function familyStack(f: BrandFamily): string {
  const name = /\s/.test(f.family) ? `"${f.family}"` : f.family;
  return f.fallback ? `${name}, ${f.fallback}` : name;
}

/** The CSS variables a brand defines. The brand is their one source: linked files receive them from here. */
export function brandTokens(data: BrandData): Token[] {
  const out = new Map<string, Token>();
  const add = (name: string, kind: TokenKind, value: string) => {
    if (TOKEN_NAME.test(name) && value) out.set(name, { name, kind, value });
  };
  for (const c of data.colors) if (!c.suggested) add(c.token, 'color', c.value);
  for (const f of data.families) if (!f.suggested) add(f.token, 'font-family', familyStack(f));
  for (const t of data.typeScale) if (!t.suggested) add(t.token, 'font-size', pxValue(t.size));
  for (const s of data.spacing) if (!s.suggested) add(s.token, 'spacing', pxValue(s.value));
  for (const r of data.radius) if (!r.suggested) add(r.token, 'radius', pxValue(r.value));
  const container = bindingFields(data).container;
  if (container) add('container', 'container', pxValue(container));
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** A type step as a text style of the design system: one name for family, size, weight, line height and tracking. */
export function stepTextStyle(data: BrandData, step: BrandTypeStep): Record<string, string> {
  const family = data.families.find((f) => f.id === step.family || f.family === step.family);
  return {
    ...(family ? { fontFamily: family.suggested ? familyStack(family) : `var(--${family.token})` } : {}),
    fontSize: `var(--${step.token})`,
    ...(step.weight ? { fontWeight: String(step.weight) } : {}),
    ...(step.lineHeight ? { lineHeight: step.lineHeight } : {}),
    ...(step.tracking ? { letterSpacing: step.tracking } : {}),
  };
}

/**
 * Writes what a brand defines into a file, using the file's own design system: tokens, values per theme mode, and a
 * text style per step of the scale. Removes what this brand set earlier and no longer has. Other tokens stay.
 */
export function applyBrandTokens(doc: BogenDoc, data: BrandData, origin?: unknown): { set: string[]; removed: string[] } {
  const tokens = brandTokens(data);
  const previous = doc.meta.get('brandTokens');
  const names = new Set(tokens.map((t) => t.name));
  const set: string[] = [];
  const removed: string[] = [];
  doc.transact(() => {
    const current = new Map(doc.getTokens().map((t) => [t.name, t]));
    for (const t of tokens) {
      const had = current.get(t.name);
      if (had?.value === t.value && had.kind === t.kind) continue;
      doc.setToken(t.name, t.kind, t.value);
      set.push(t.name);
    }
    if (Array.isArray(previous)) {
      for (const name of previous as unknown[]) {
        if (typeof name === 'string' && !names.has(name) && current.has(name)) {
          doc.deleteToken(name);
          removed.push(name);
        }
      }
    }
    doc.meta.set('brandTokens', [...names]);

    for (const c of confirmed(data.colors)) {
      for (const [mode, value] of Object.entries(c.modes ?? {})) {
        if (!doc.modes.has(mode)) createMode(doc, mode);
        setTokenMode(doc, c.token, mode, value);
      }
    }

    const styles = confirmed(data.typeScale).map((t) => ({ name: t.name, style: stepTextStyle(data, t) }));
    const existing = new Map(getTextStyles(doc).map((s) => [s.key, s]));
    const keys = new Set<string>();
    for (const s of styles) {
      keys.add(textStyleKey(s.name));
      const had = existing.get(textStyleKey(s.name));
      if (!had || JSON.stringify(had.style) !== JSON.stringify(s.style)) setTextStyle(doc, s.name, s.style);
    }
    const previousStyles = doc.meta.get('brandTextStyles');
    if (Array.isArray(previousStyles)) {
      for (const key of previousStyles as unknown[]) if (typeof key === 'string' && !keys.has(key) && existing.has(key)) deleteTextStyle(doc, key);
    }
    doc.meta.set('brandTextStyles', [...keys]);
  }, origin);
  return { set, removed };
}

/** Confirmed items of a section. What is still a suggestion does not bind anyone yet. */
export function confirmed<T extends BrandItemBase>(items: T[]): T[] {
  return items.filter((i) => !i.suggested);
}

/** A colour id, or a role, or a value, as the palette entry it means. */
export function resolveBrandColor(data: BrandData, ref: string): BrandColor | undefined {
  const value = normalizeColor(ref);
  return data.colors.find((c) => c.id === ref) ?? data.colors.find((c) => c.role === ref || c.token === ref || c.name === ref) ?? (value ? data.colors.find((c) => c.value === value) : undefined);
}

/** Pairs with their computed contrast, for the panel, the sheet and agents. */
export function pairingTable(data: BrandData): { id: string; fg: BrandColor; bg: BrandColor; verdict: 'allow' | 'forbid'; contrast: number; passes: boolean; note?: string; suggested?: boolean }[] {
  return data.pairings.flatMap((p) => {
    const fg = resolveBrandColor(data, p.fg);
    const bg = resolveBrandColor(data, p.bg);
    if (!fg || !bg) return [];
    const contrast = contrastRatio(fg.value, bg.value);
    return [{ id: p.id, fg, bg, verdict: p.verdict, contrast, passes: contrast >= data.fields.minContrast, ...(p.note ? { note: p.note } : {}), ...(p.suggested ? { suggested: true } : {}) }];
  });
}

/** Whether a logo meant for `spec` belongs on this background colour. */
export function logoFitsBackground(data: BrandData, spec: string, background: string): boolean {
  const s = spec.trim().toLowerCase();
  if (!s || s === 'any') return true;
  if (s === 'light') return luminance(background) >= 0.4;
  if (s === 'dark') return luminance(background) < 0.4;
  const wanted = resolveBrandColor(data, spec)?.value ?? normalizeColor(spec);
  return wanted ? colorDistance(wanted, background) < 6 : true;
}

/** The right logo variant for a background: exact colour first, then light or dark, then anything that fits. */
export function pickLogo(data: BrandData, background: string, wanted?: string): BrandLogo | undefined {
  const logos = confirmed(data.logos).length ? confirmed(data.logos) : data.logos;
  if (wanted) {
    const named = logos.find((l) => l.id === wanted || l.name === wanted);
    if (named) return named;
  }
  const specific = (l: BrandLogo) => {
    const s = l.background.toLowerCase();
    return s !== 'any' && s !== 'light' && s !== 'dark';
  };
  return logos.find((l) => specific(l) && logoFitsBackground(data, l.background, background))
    ?? logos.find((l) => !specific(l) && l.background.toLowerCase() !== 'any' && logoFitsBackground(data, l.background, background))
    ?? logos.find((l) => l.background.toLowerCase() === 'any');
}

/** The ratio an SVG says it has. */
export function svgAspect(markup: string): number | undefined {
  const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(markup);
  if (box) {
    const [w, h] = [Number(box[1]), Number(box[2])];
    if (w > 0 && h > 0) return w / h;
  }
  const width = /\bwidth\s*=\s*["']([\d.]+)/i.exec(markup);
  const height = /\bheight\s*=\s*["']([\d.]+)/i.exec(markup);
  if (width && height && Number(height[1]) > 0) return Number(width[1]) / Number(height[1]);
  return undefined;
}
