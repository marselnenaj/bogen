import type { BrandBookChapter } from './brand-book.ts';
import { bindingFields, type BrandData } from './brand.ts';
import { languageName, normalizeLanguageTag } from './content-language.ts';
import type { BogenDoc } from './doc.ts';

/**
 * The languages a brand speaks: one primary and any number of others, each a BCP 47 tag such as en, de-AT or pt-BR.
 * The primary is the brand field `language`, which once knew only German and English; the others are `languages`.
 *
 * Words, voice examples and rules can belong to one of them (`lang`). Without one they are in the primary language,
 * which is what every item of a brand with a single language already was, so old brands need no migration. `*` marks
 * an item for every language, such as a product name spelled the same everywhere.
 *
 * Copy is judged in the brand language it is written in. Words and examples of that language apply to it; where the
 * brand has none of its own for it, or the copy is in a language the brand does not speak, those of the primary
 * language stand in. Text a rule requires or forbids applies only to copy in the rule's language.
 */

export const ALL_LANGUAGES = '*';
export const MAX_BRAND_LANGUAGES = 20;

export interface BrandLanguages {
  /** The language the brand writes in first. Null when it sets none and its own words do not tell. */
  primary: string | null;
  /** The primary was read from the brand's own words, not set by a person. */
  inferred: boolean;
  /** The other languages it speaks, without the primary. */
  additional: string[];
  /** The primary first, then the others. */
  all: string[];
}

/** The language without script or region: `de` for `de-AT`. */
export function baseLanguage(tag: string): string {
  return tag.split('-')[0]!.toLowerCase();
}

const GERMAN = /(?<![\p{L}])(?:der|die|das|und|ist|nicht|mit|für|ich|wir|zu|auf|ein|eine|einen|dem|den|des|auch|oder|wie|kein|keine|sind|wird|werden|bei|aus|nach|vor|über)(?![\p{L}])/giu;
const ENGLISH = /(?<![\p{L}])(?:the|and|is|not|with|for|we|you|to|on|of|a|an|are|will|be|at|from|after|before|over|it|this|that|your)(?![\p{L}])/giu;

/** 'de' or 'en' by function words, or null for too little text. It tells these two apart and nothing else. */
export function textLanguage(text: string): 'de' | 'en' | null {
  const de = (text.match(GERMAN) ?? []).length + (/[äöüß]/i.test(text) ? 1 : 0);
  const en = (text.match(ENGLISH) ?? []).length;
  if (de + en < 2) return null;
  return de > en ? 'de' : en > de ? 'en' : null;
}

/** The language the brand's own words are in, for a brand that sets none: German, English, or null. */
export function inferredBrandLanguage(data: BrandData): 'de' | 'en' | null {
  const f = bindingFields(data);
  return textLanguage([f.tone, f.positioning, f.audience, ...data.rules.map((r) => r.text), ...data.voiceExamples.map((e) => e.good)].join(' '));
}

/** The brand's languages as they bind: a proposed language is not one until a person confirms it. */
export function brandLanguages(data: BrandData): BrandLanguages {
  const f = bindingFields(data);
  const set = f.language || null;
  const primary = set ?? inferredBrandLanguage(data);
  const additional = f.languages.filter((t) => t !== primary);
  return { primary, inferred: !set && primary !== null, additional, all: [...(primary ? [primary] : []), ...additional] };
}

/** An item's language as stored: '' (the primary), '*' (every language) or a tag. Anything else is ''. */
export function cleanItemLanguage(value: unknown): string {
  if (value === ALL_LANGUAGES) return ALL_LANGUAGES;
  return normalizeLanguageTag(value) ?? '';
}

/** The language an item is in: its own, else the primary. '*' for every language; null when neither says. */
export function itemLanguage(item: { lang?: string }, primary: string | null): string | null {
  return item.lang || primary;
}

/**
 * Which of the brand's languages copy in `tag` is: the same tag, else the same language with the primary first, so
 * that `de-CH` copy of a brand speaking `de` and `de-AT` is `de`. Null when the brand does not speak it.
 */
export function matchBrandLanguage(langs: Pick<BrandLanguages, 'all'>, tag: string | null | undefined): string | null {
  if (!tag) return null;
  const exact = langs.all.find((l) => l.toLowerCase() === tag.toLowerCase());
  if (exact) return exact;
  const base = baseLanguage(tag);
  return langs.all.find((l) => l.toLowerCase() === base) ?? langs.all.find((l) => baseLanguage(l) === base) ?? null;
}

/** Whether an item in `item` applies to copy in the brand language `target`: the same, or the item names only the language of a regional target. */
function covers(item: string | null, target: string | null): boolean {
  if (item === target) return true;
  if (!item || !target) return false;
  return !item.includes('-') && item.toLowerCase() === baseLanguage(target);
}

/**
 * The items that apply to copy judged in `target`, a brand language or null for the primary. Items for every
 * language always apply. With `fallback`, a language with no items of its own gets those of the primary.
 */
export function itemsForLanguage<T extends { lang?: string }>(items: T[], langs: Pick<BrandLanguages, 'primary'>, target: string | null, options: { fallback?: boolean } = {}): T[] {
  const primary = langs.primary;
  const want = target ?? primary;
  const everywhere = items.filter((i) => i.lang === ALL_LANGUAGES);
  let own = items.filter((i) => i.lang !== ALL_LANGUAGES && covers(itemLanguage(i, primary), want));
  if (!own.length && (options.fallback ?? true) && want !== primary) own = items.filter((i) => i.lang !== ALL_LANGUAGES && covers(itemLanguage(i, primary), primary));
  return [...own, ...everywhere];
}

/** "English (en)", for prompts and tool results. */
export function languageAndTag(tag: string): string {
  return tag === ALL_LANGUAGES ? 'every language' : `${languageName(tag)} (${tag})`;
}

/** The brand's languages in a sentence, for briefs and tool results. Empty when it speaks none that is known. */
export function brandLanguagesLine(langs: BrandLanguages): string {
  if (!langs.primary) return '';
  const primary = `${languageAndTag(langs.primary)}${langs.inferred ? ', read from its own words as it sets no language' : ''}`;
  return langs.additional.length
    ? `The brand speaks ${primary} as its primary language, and also ${langs.additional.map(languageAndTag).join(', ')}.`
    : `The brand speaks ${primary}.`;
}

/**
 * Which language to write in, and why: the design language (this request's or the file's) when the brand speaks it,
 * else that language anyway with the primary's words standing in, else the brand's primary.
 */
export function writeInLine(langs: BrandLanguages, design: { tag: string; source: 'run' | 'file' | 'brand' } | null): string {
  const spoken = design ? matchBrandLanguage(langs, design.tag) : null;
  if (design && design.source !== 'brand') {
    const why = design.source === 'run' ? 'the person chose it for this request' : "it is the file's design language";
    if (spoken) return `Write copy in ${languageAndTag(design.tag)}, since ${why}. Use the brand's words, examples and text rules for ${languageAndTag(spoken)}.`;
    return `Write copy in ${languageAndTag(design.tag)}, since ${why}, although the brand does not speak it. Its rules still apply, and its words and examples in ${languageAndTag(langs.primary ?? design.tag)} are the guide; do not translate brand terms marked for every language.`;
  }
  if (!langs.primary) return '';
  return `Write copy in ${languageAndTag(langs.primary)}, the brand's primary language, unless the person asks for another of its languages.`;
}

// ---------------------------------------------------------------- the language of a layer

/**
 * The language a layer declares: its own lang attribute, or the nearest one above it, up to its artboard. Null when
 * none says, and then the file's design language or the brand's primary applies.
 */
export function declaredLanguageOf(doc: BogenDoc, id: string): string | null {
  const seen = new Set<string>();
  let at: string | undefined = id;
  while (at && !seen.has(at)) {
    seen.add(at);
    const node = doc.getNode(at);
    if (!node) return null;
    const lang = node.attrs?.lang;
    if (typeof lang === 'string' && lang.trim()) return normalizeLanguageTag(lang);
    at = node.parent;
  }
  return null;
}

/**
 * The language a piece of copy is in. A language declared on it or the design wins; the weak guess from its words can
 * only say German instead of English or the other way round, where the declared one is one of those two and the words
 * clearly say otherwise. Without a declared language, the guess, else null (the brand's primary).
 */
export function copyLanguage(text: string, declared: string | null | undefined): string | null {
  const guess = textLanguage(text);
  if (declared) {
    const base = baseLanguage(declared);
    return guess && (base === 'de' || base === 'en') && guess !== base ? guess : declared;
  }
  return guess;
}

/**
 * The language a brandbook chapter is written in: its own, else the brand's primary, else what its words say. Null
 * when nothing tells, and then a reader should be told the language is unknown rather than given the interface's.
 */
export function chapterLanguage(chapter: Pick<BrandBookChapter, 'lang' | 'markdown'> | undefined, langs: Pick<BrandLanguages, 'primary'>): string | null {
  if (chapter?.lang) return chapter.lang;
  if (langs.primary) return langs.primary;
  return chapter?.markdown ? textLanguage(chapter.markdown) : null;
}
