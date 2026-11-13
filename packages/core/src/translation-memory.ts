import * as Y from 'yjs';
import type { ContentNode, DesignContent } from './content.ts';
import { CONTENT_LANGUAGE_KEY, languageDirection, languageName, normalizeLanguageTag } from './content-language.ts';
import { branchBaseContent, branchContent, contentHash, getDesignBranch, listDesignBranches, mergeDesignContent, rebaseDesignBranch, type DesignBranch } from './design-branches.ts';
import type { BogenDoc } from './doc.ts';

/**
 * Continuous translation, on top of language versions (a design branch per language, content-language.ts). The file
 * keeps a translation memory: for each language, a source text and its translation. It is one map in the document,
 * outside the design content (content.ts leaves it alone), so it is the same on every branch, syncs, goes with a
 * download, and survives a restore of the design.
 *
 * Bringing a language version up to date takes the original's structure as it is now (a three-way merge from where the
 * version last followed it, so the version's own layout fixes stay), then fills in every text the memory knows. Only
 * text that is new or changed since is left for the person's agent to translate: Bogen translates nothing itself and
 * calls no service.
 *
 * Rules say what is never translated: words and phrases the person lists (brand and product names), and by itself
 * code, addresses, numbers and layers marked translate="no" or inside code. Each language has a status: included
 * (translated and kept up to date), untranslated (it shows the original's words), or hidden (left out of the work and
 * of publishing).
 */

export const TRANSLATION_ROOT = 'translationMemory';
export type LocaleStatus = 'include' | 'untranslated' | 'hidden';
export const LOCALE_STATUSES: readonly LocaleStatus[] = ['include', 'untranslated', 'hidden'];

/** Texts of a layer an agent translates: its own text, and the attributes a person reads or hears. */
export const TRANSLATED_ATTRS = ['alt', 'aria-label', 'title', 'placeholder'] as const;
export type TranslatedField = 'text' | (typeof TRANSLATED_ATTRS)[number];

export interface MemoryEntry { source: string; target: string; at: number; by: string }
export interface TranslationRules { keep: string[] }

const MAX_KEEP = 200;
const MAX_TEXT = 4000;
const CODE_TAGS = new Set(['code', 'pre', 'kbd', 'samp', 'var', 'script', 'style']);

const root = (doc: BogenDoc): Y.Map<unknown> => doc.y.getMap<unknown>(TRANSLATION_ROOT);
const entryKey = (tag: string, source: string) => `t:${tag.toLowerCase()}:${contentHash(source)}`;
const localeKey = (tag: string) => `locale:${tag.toLowerCase()}`;

function cleanTag(tag: string): string {
  const t = normalizeLanguageTag(tag);
  if (!t) throw new Error(`"${String(tag).slice(0, 40)}" is not a language tag such as de, fr-CA or pt-BR.`);
  return t;
}

// ---------------------------------------------------------------- rules

export function translationRules(doc: BogenDoc): TranslationRules {
  const raw = root(doc).get('rules') as { keep?: unknown } | undefined;
  const keep = Array.isArray(raw?.keep) ? raw.keep.filter((w): w is string => typeof w === 'string' && Boolean(w.trim())).map((w) => w.trim().slice(0, 120)) : [];
  return { keep: [...new Set(keep)].slice(0, MAX_KEEP) };
}

export function setTranslationRules(doc: BogenDoc, rules: Partial<TranslationRules>, origin?: unknown): TranslationRules {
  const now = translationRules(doc);
  const keep = rules.keep ? [...new Set(rules.keep.map((w) => w.trim()).filter(Boolean).map((w) => w.slice(0, 120)))].slice(0, MAX_KEEP) : now.keep;
  doc.transact(() => root(doc).set('rules', { keep }), origin);
  return { keep };
}

export function localeStatus(doc: BogenDoc, tag: string): LocaleStatus {
  const v = root(doc).get(localeKey(tag));
  return v === 'untranslated' || v === 'hidden' ? v : 'include';
}

export function setLocaleStatus(doc: BogenDoc, tag: string, status: LocaleStatus, origin?: unknown): void {
  if (!LOCALE_STATUSES.includes(status)) throw new Error(`A language is include, untranslated or hidden, not "${String(status)}".`);
  const key = localeKey(cleanTag(tag));
  doc.transact(() => {
    if (status === 'include') root(doc).delete(key);
    else root(doc).set(key, status);
  }, origin);
}

/**
 * Whether a text is not for translating: nothing but numbers and signs, an address, a path or a piece of code, a key
 * shortcut, or one of the words the rules keep.
 */
export function keepAsIs(text: string, keep: readonly string[] = []): boolean {
  const s = text.trim();
  if (!s) return true;
  if (!/\p{L}/u.test(s)) return true;
  if (/^(https?:\/\/|www\.)\S+$/i.test(s) || /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(s)) return true;
  if (/^[~.]?\/[\w./-]*$/.test(s) || /^--[\w-]+$/.test(s) || /^#[0-9a-f]{3,8}$/i.test(s)) return true;
  if (/^(Ctrl|Cmd|Alt|Option|Shift|Meta|Super)(\s*\+\s*[\w.,/[\]-]+)+$/i.test(s)) return true;
  // One token with no spaces that looks like code: snake_case, camelCase, dotted names, calls, tags.
  if (!/\s/.test(s) && (/^[A-Za-z_$][\w$]*([._][\w$]+)+(\(\))?$/.test(s) || /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(s) || /^<\/?[a-z][\w-]*\/?>$/i.test(s) || /\(\)$/.test(s))) return true;
  const lower = s.toLowerCase();
  return keep.some((w) => w.toLowerCase() === lower);
}

// ---------------------------------------------------------------- what there is to translate

export interface TranslatableText { id: string; field: TranslatedField; source: string; layer: string; screen: string }

/** The texts of a version of the design that a translation covers, by layer and field, in the order they are drawn. */
export function translatableTexts(content: DesignContent, rules: TranslationRules = { keep: [] }): TranslatableText[] {
  const pages = new Set(content.pages.map((p) => p.id));
  const byId = new Map(content.nodes.map((n) => [n.id, n]));
  const skipped = new Map<string, boolean>();
  const screenName = (n: ContentNode): string => {
    let cur: ContentNode | undefined = n;
    for (let guard = 0; cur && guard < 500; guard++) {
      if (pages.has(cur.parent)) return cur.name || cur.type;
      cur = byId.get(cur.parent);
    }
    return '';
  };
  const excluded = (n: ContentNode | undefined): boolean => {
    if (!n) return false;
    const known = skipped.get(n.id);
    if (known !== undefined) return known;
    const attrs = (n.attrs ?? {}) as Record<string, string>;
    const own = CODE_TAGS.has(String(n.tag).toLowerCase()) || attrs.translate === 'no' || /\bnotranslate\b/.test(attrs.class ?? '') || Boolean((n as { hidden?: boolean }).hidden);
    const out = own || (!pages.has(n.parent) && excluded(byId.get(n.parent)));
    skipped.set(n.id, out);
    return out;
  };
  const out: TranslatableText[] = [];
  for (const n of content.nodes) {
    if (!reachesPage(n, byId, pages) || excluded(n)) continue;
    const text = typeof n.text === 'string' ? n.text : undefined;
    if (n.type === 'text' && text && text.length <= MAX_TEXT && !keepAsIs(text, rules.keep)) out.push({ id: n.id, field: 'text', source: text, layer: n.name, screen: screenName(n) });
    const attrs = (n.attrs ?? {}) as Record<string, string>;
    for (const field of TRANSLATED_ATTRS) {
      const v = attrs[field];
      if (typeof v === 'string' && v.length <= MAX_TEXT && !keepAsIs(v, rules.keep)) out.push({ id: n.id, field, source: v, layer: n.name, screen: screenName(n) });
    }
  }
  return out;
}

function reachesPage(n: ContentNode, byId: Map<string, ContentNode>, pages: Set<string>): boolean {
  let cur: ContentNode | undefined = n;
  for (let guard = 0; cur && guard < 500; guard++) {
    if (pages.has(cur.parent)) return true;
    cur = byId.get(cur.parent);
  }
  return false;
}

const fieldOf = (n: ContentNode | undefined, field: TranslatedField): string | undefined => {
  if (!n) return undefined;
  if (field === 'text') return typeof n.text === 'string' ? n.text : undefined;
  const v = (n.attrs as Record<string, string> | undefined)?.[field];
  return typeof v === 'string' ? v : undefined;
};

// ---------------------------------------------------------------- the memory

export function rememberedTranslation(doc: BogenDoc, tag: string, source: string): MemoryEntry | undefined {
  const v = root(doc).get(entryKey(tag, source)) as Partial<MemoryEntry> | undefined;
  return v && v.source === source && typeof v.target === 'string' ? { source, target: v.target, at: Number(v.at) || 0, by: String(v.by ?? '') } : undefined;
}

/** Puts translations into the memory. A target equal to its source is kept too: "this stays as it is in German". */
export function rememberTranslations(doc: BogenDoc, tag: string, pairs: readonly { source: string; target: string }[], by: string, origin?: unknown): number {
  const lang = cleanTag(tag);
  let n = 0;
  doc.transact(() => {
    for (const p of pairs) {
      if (typeof p.source !== 'string' || typeof p.target !== 'string' || !p.source.trim() || !p.target.trim() || p.source.length > MAX_TEXT || p.target.length > MAX_TEXT * 2) continue;
      const had = rememberedTranslation(doc, lang, p.source);
      if (had?.target === p.target) continue;
      root(doc).set(entryKey(lang, p.source), { source: p.source, target: p.target, at: Date.now(), by: by.slice(0, 80) } satisfies MemoryEntry);
      n++;
    }
  }, origin);
  return n;
}

export function forgetTranslations(doc: BogenDoc, tag: string, sources: readonly string[], origin?: unknown): number {
  const lang = cleanTag(tag);
  let n = 0;
  doc.transact(() => {
    for (const s of sources) if (root(doc).has(entryKey(lang, s))) { root(doc).delete(entryKey(lang, s)); n++; }
  }, origin);
  return n;
}

export function memorySize(doc: BogenDoc, tag?: string): number {
  const prefix = tag ? `t:${tag.toLowerCase()}:` : 't:';
  let n = 0;
  for (const k of root(doc).keys()) if (k.startsWith(prefix)) n++;
  return n;
}

// ---------------------------------------------------------------- language versions

export interface LanguageVersion { branch: DesignBranch; tag: string; name: string; status: LocaleStatus }

const languageOfContent = (c: DesignContent): string | null => normalizeLanguageTag(c.extra?.meta?.[CONTENT_LANGUAGE_KEY]);

/** The open branches whose design language differs from the version they started from: the file's language versions. */
export function languageVersions(doc: BogenDoc): LanguageVersion[] {
  const out: LanguageVersion[] = [];
  for (const b of listDesignBranches(doc)) {
    if (b.status !== 'open' || !b.parent) continue;
    let tag: string | null;
    let parentTag: string | null;
    try {
      tag = languageOfContent(branchContent(doc, b.id));
      parentTag = languageOfContent(branchContent(doc, b.parent));
    } catch {
      continue;
    }
    if (!tag || tag === parentTag) continue;
    out.push({ branch: b, tag, name: languageName(tag), status: localeStatus(doc, tag) });
  }
  return out;
}

export function findLanguageVersion(doc: BogenDoc, ref: string): LanguageVersion {
  const all = languageVersions(doc);
  const tag = normalizeLanguageTag(ref);
  const hit = all.find((v) => v.branch.id === ref) ?? (tag ? all.find((v) => v.tag.toLowerCase() === tag.toLowerCase()) ?? all.find((v) => v.tag.split('-')[0] === tag.split('-')[0]) : undefined);
  if (!hit) throw new Error(`This file has no ${tag ? `${languageName(tag)} (${tag})` : `"${ref.slice(0, 40)}"`} language version. ${all.length ? `It has: ${all.map((v) => `${v.name} (${v.tag})`).join(', ')}.` : 'Add one with a run that adds a language version (Add a language version in the prompt bar).'}`);
  return hit;
}

/**
 * Pairs of source and translation the version holds already: the same layer and field in the version and in the
 * original where the version started, with different text. That is how a version translated before the memory existed,
 * or edited by hand, teaches it.
 */
export function learnedTranslations(doc: BogenDoc, branchId: string): { source: string; target: string }[] {
  const base = branchBaseContent(doc, branchId);
  if (!base) return [];
  const rules = translationRules(doc);
  const now = new Map(branchContent(doc, branchId).nodes.map((n) => [n.id, n]));
  const out = new Map<string, string>();
  for (const t of translatableTexts(base, rules)) {
    const target = fieldOf(now.get(t.id), t.field);
    if (target !== undefined && target.trim() && target !== t.source && !out.has(t.source)) out.set(t.source, target);
  }
  return [...out].map(([source, target]) => ({ source, target }));
}

export interface NeededText { source: string; layers: { id: string; field: TranslatedField; layer: string; screen: string }[]; /** What the version shows for it now, when it differs: an older translation, as a hint. */ was?: string }

export interface TranslationStatus {
  branch: { id: string; name: string };
  tag: string;
  language: string;
  dir: 'ltr' | 'rtl';
  status: LocaleStatus;
  /** Texts of the original that a translation covers, counted once per distinct text. */
  texts: number;
  translated: number;
  needed: NeededText[];
  /** Whether the original changed since the version last followed it. */
  behind: boolean;
  rules: TranslationRules;
}

/** What a language version still needs: the original's texts the memory (with what the version teaches) does not know. */
export function translationStatus(doc: BogenDoc, ref: string): TranslationStatus {
  const v = findLanguageVersion(doc, ref);
  const rules = translationRules(doc);
  const parent = branchContent(doc, v.branch.parent!);
  const texts = translatableTexts(parent, rules);
  const learned = new Map(learnedTranslations(doc, v.branch.id).map((p) => [p.source, p.target]));
  const here = new Map(branchContent(doc, v.branch.id).nodes.map((n) => [n.id, n]));
  const bySource = new Map<string, NeededText>();
  let translated = 0;
  const seen = new Set<string>();
  for (const t of texts) {
    const known = seen.has(t.source);
    seen.add(t.source);
    if (rememberedTranslation(doc, v.tag, t.source) || learned.has(t.source)) {
      if (!known) translated++;
      continue;
    }
    let need = bySource.get(t.source);
    if (!need) {
      bySource.set(t.source, (need = { source: t.source, layers: [] }));
      const shown = fieldOf(here.get(t.id), t.field);
      if (shown && shown !== t.source) need.was = shown;
    }
    if (need.layers.length < 8) need.layers.push({ id: t.id, field: t.field, layer: t.layer, screen: t.screen });
  }
  const base = branchBaseContent(doc, v.branch.id);
  const behind = base ? contentHash(JSON.stringify(base.nodes)) !== contentHash(JSON.stringify(parent.nodes)) || JSON.stringify(base.tokens) !== JSON.stringify(parent.tokens) : true;
  return {
    branch: { id: v.branch.id, name: v.branch.name }, tag: v.tag, language: v.name, dir: languageDirection(v.tag), status: v.status,
    texts: seen.size, translated, needed: v.status === 'include' ? [...bySource.values()] : [], behind, rules,
  };
}

export interface SyncResult { branch: { id: string; name: string }; tag: string; filled: number; learned: number; left: number; structure: boolean }

/**
 * Brings a language version up to date with its original: the original's structure and changes come in by a three-way
 * merge from where the version last followed it (where both changed a layer, the original's side wins, since its text
 * is the new source), then every text the memory knows is filled in. Texts the memory does not know show the
 * original's words until they are translated. One transaction, which a person undoes like any change.
 */
export function syncLanguageVersion(doc: BogenDoc, ref: string, by: string, origin?: unknown): SyncResult {
  const v = findLanguageVersion(doc, ref);
  const rules = translationRules(doc);
  const base = branchBaseContent(doc, v.branch.id);
  if (!base) throw new Error(`Where "${v.branch.name}" started is not in this file any more, so it cannot follow its original. Translate it in place instead.`);
  let learned = 0;
  let filled = 0;
  let left = 0;
  let structure = false;
  doc.transact(() => {
    learned = rememberTranslations(doc, v.tag, learnedTranslations(doc, v.branch.id), by);
    const parent = branchContent(doc, v.branch.parent!);
    const mine = branchContent(doc, v.branch.id);
    const { content } = mergeDesignContent(base, parent, mine, 'primary');
    structure = JSON.stringify(content.nodes.map((n) => n.id)) !== JSON.stringify(mine.nodes.map((n) => n.id));
    const nodes = new Map(content.nodes.map((n) => [n.id, n]));
    const pages = new Set(content.pages.map((p) => p.id));
    for (const t of translatableTexts(parent, rules)) {
      const node = nodes.get(t.id);
      if (!node || fieldOf(node, t.field) !== t.source) continue;
      const hit = v.status === 'include' ? rememberedTranslation(doc, v.tag, t.source) : undefined;
      if (!hit) {
        left++;
        continue;
      }
      if (t.field === 'text') {
        node.text = hit.target;
        // Ranges of the source's text do not fit the translation; the layer's own style still applies.
        delete node.spans;
      } else node.attrs = { ...(node.attrs as Record<string, string>), [t.field]: hit.target };
      filled++;
    }
    // The version's language on its screens, also on those that came from the original just now.
    for (const n of content.nodes) {
      if (!pages.has(n.parent)) continue;
      const attrs = { ...((n.attrs ?? {}) as Record<string, string>) };
      if (attrs.lang === v.tag && attrs.dir === languageDirection(v.tag)) continue;
      if (v.status === 'untranslated' && !attrs.lang) continue;
      attrs.lang = v.tag;
      attrs.dir = languageDirection(v.tag);
      n.attrs = attrs;
    }
    const meta = { ...(content.extra?.meta ?? {}), [CONTENT_LANGUAGE_KEY]: v.tag };
    content.extra = { ...(content.extra ?? {}), meta };
    rebaseDesignBranch(doc, v.branch.id, content);
  }, origin);
  return { branch: { id: v.branch.id, name: getDesignBranch(doc, v.branch.id).name }, tag: v.tag, filled, learned, left, structure };
}
