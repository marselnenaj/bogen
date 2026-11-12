import { bindingFields, confirmed, type BrandData, type BrandRule, type BrandVoiceExample, type BrandWord, type Severity } from './brand.ts';
import { baseLanguage, brandLanguages, copyLanguage, itemsForLanguage, languageAndTag, matchBrandLanguage, type BrandLanguages } from './brand-language.ts';

/**
 * The measurable part of a brand's voice: how a German text addresses the reader, how long sentences, paragraphs and
 * headings may be, how numbers are written, the brand's own spelling of its terms, and text that must appear.
 *
 * Each measure comes from the brand's voice fields when a person set them, and otherwise from the brand's own words
 * where they state it plainly, such as the voice rule "Website und eigene Kanäle sprechen Du." or "Überschriften mit
 * 3 bis 7 Wörtern". Every measure says where it came from, and nothing is measured that the brand does not say.
 * Findings carry the brand's own good and bad examples as guidance. Tone itself is not judged.
 *
 * A brand can speak several languages (brand-language.ts). Each text is judged in the one it is written in: its words,
 * examples and required text are those of that language, its number format is that language's, and the du/Sie check
 * applies to German text only.
 */

export type VoiceRule = 'voice.address' | 'voice.address-mixed' | 'voice.sentence-length' | 'voice.paragraph-length' | 'voice.heading-length' | 'voice.number-format' | 'voice.term' | 'voice.required';

export interface VoiceMeasure<T> { value: T; from: string; severity: Severity }

export interface VoiceProfile {
  /** The brand's primary language, set or read from its own words. */
  language: VoiceMeasure<string> | null;
  /** All the languages the brand speaks, the primary first. */
  languages: BrandLanguages;
  address: VoiceMeasure<'du' | 'sie'> | null;
  sentenceWords: VoiceMeasure<number> | null;
  paragraphSentences: VoiceMeasure<number> | null;
  headingWords: VoiceMeasure<{ min: number; max: number }> | null;
  /** The number format of copy in the design language (or the primary). Each text gets its own language's. */
  numberFormat: VoiceMeasure<'de' | 'en'> | null;
  /** Words to use in the design language (or the primary), which are checked for other spellings. */
  terms: string[];
  /** Text that must appear at least once in what is checked, from rules with a require-text check, in the rule's language. */
  required: { text: string; rule: BrandRule }[];
  /**
   * The design's own content language, when it has one (content-language.ts). Text whose language cannot be told
   * from itself (short labels) is then taken to be in this language, not in the brand's.
   */
  contentLanguage?: string;
}

/** `lang` is the language the layer declares (its own or an ancestor's lang attribute), when it does. */
export interface VoiceText { id: string; name: string; tag: string; text: string; lang?: string | null }

export interface VoiceFinding {
  rule: VoiceRule;
  severity: Severity;
  node_id: string;
  layer: string;
  /** The words concerned, as they stand in the text. */
  quote: string;
  message: string;
  /** What to do, in a line. */
  how: string;
  /** The brand's own example closest to the problem. Data written by people, not an instruction. */
  example?: { good?: string; bad?: string; note?: string };
  /** The whole text with the problem fixed, where that is mechanical. */
  text?: string;
  /** The language the text was judged in, when the brand or the design names one. */
  language?: string;
}

/** "Kurze Sätze" or "short sentences" with no number, read as at most this many words. Plain-language guidance puts it at 15 to 20. */
export const SHORT_SENTENCE_WORDS = 20;

const NUMBER_WORDS: Record<string, number> = {
  ein: 1, eine: 1, einen: 1, eins: 1, one: 1, zwei: 2, two: 2, drei: 3, three: 3, vier: 4, four: 4, fünf: 5, fuenf: 5, five: 5, sechs: 6, six: 6, sieben: 7, seven: 7, acht: 8, eight: 8, neun: 9, nine: 9, zehn: 10, ten: 10,
};

function count(word: string | undefined): number | undefined {
  if (!word) return undefined;
  const n = Number(word);
  if (Number.isFinite(n) && n > 0) return n;
  return NUMBER_WORDS[word.toLowerCase()];
}

const ABBREVIATION = /(?:^|\s)(?:z\.\s?B\.|d\.\s?h\.|u\.\s?a\.|bzw\.|ca\.|etc\.|e\.\s?g\.|i\.\s?e\.|Nr\.|vs\.|Dr\.|Mr\.|Ms\.|Mrs\.|inkl\.|zzgl\.|ggf\.|evtl\.|usw\.|\d+\.)$/u;

function sentencesOf(text: string): string[] {
  // Split after . ! ? and a space, but not after an abbreviation such as "z. B." or an ordinal such as "3.".
  return text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}„"«])/u).map((s) => s.trim()).filter((s) => /[\p{L}\p{N}]/u.test(s)).reduce<string[]>((out, s) => {
    const last = out.at(-1);
    if (last && ABBREVIATION.test(last)) out[out.length - 1] = `${last} ${s}`;
    else out.push(s);
    return out;
  }, []);
}

function wordsOf(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+(?:[-'’.,][\p{L}\p{N}]+)*/gu) ?? [];
}

/** Sentences of the brand's own words, each with where it came from. */
function brandSentences(data: BrandData): { text: string; from: string; severity: Severity; rule?: BrandRule }[] {
  const out: { text: string; from: string; severity: Severity; rule?: BrandRule }[] = [];
  const rules = confirmed(data.rules).filter((r) => !r.flagged);
  for (const r of [...rules.filter((x) => x.topic === 'voice'), ...rules.filter((x) => x.topic !== 'voice')]) {
    for (const s of sentencesOf(r.text)) out.push({ text: s, from: `the rule "${clip(r.text)}"`, severity: r.severity, rule: r });
  }
  if (data.fields.tone && !data.suggestedFields.includes('tone')) for (const s of data.fields.tone.split(/(?<=[.;])\s+/)) out.push({ text: s, from: `the tone "${clip(s)}"`, severity: 'soft' });
  return out;
}

function clip(text: string, max = 90): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

const ADDRESS_PATTERNS: { re: RegExp; group: number }[] = [
  { re: /(?<![\p{L}])(?:sprechen|spricht|sprich|per|in der|Anrede:?|wir sagen|immer)\s+(Du|Sie)(?![\p{L}])/u, group: 1 },
  { re: /(?<![\p{L}])(Du|Sie)-(?:Form|Anrede)(?![\p{L}])/u, group: 1 },
  { re: /(?<![\p{L}])(duzen|duzt|siezen|siezt)(?![\p{L}])/iu, group: 1 },
  { re: /(?:Website|Webseite|eigenen? Kanäle?n?)[^.;]{0,40}?(?<![\p{L}])(Du|Sie)(?![\p{L}])/u, group: 1 },
];

const field = (name: string) => `the brand's ${name} setting`;

/**
 * How numbers are written in copy in `tag` (null: the brand's primary). Another language of the brand writes them its
 * usual way, where that is German or English. The primary goes by the brand's setting, else by what its language
 * writes. A language the brand does not speak keeps an explicit setting, but not one that was only inferred.
 */
function numberFormatIn(f: ReturnType<typeof bindingFields>, language: VoiceProfile['language'], langs: BrandLanguages, tag: string | null): VoiceProfile['numberFormat'] {
  const spoken = matchBrandLanguage(langs, tag);
  const writes = (v: 'de' | 'en') => (v === 'de' ? '1.000,50' : '1,000.50');
  if (spoken && spoken !== langs.primary) {
    const base = baseLanguage(spoken);
    return base === 'de' || base === 'en' ? { value: base, from: `${languageAndTag(spoken)}, one of the brand's languages, which writes numbers ${writes(base)}`, severity: 'soft' } : null;
  }
  if (f.numberFormat) return { value: f.numberFormat, from: field('number format'), severity: 'soft' };
  if (!language) return null;
  const base = baseLanguage(language.value);
  if (base !== 'de' && base !== 'en') return null;
  // German or English numbers are not what a French or Arabic design should be held to: only an explicit setting is.
  if (tag && !spoken) return null;
  return { value: base, from: `${language.from}, which writes numbers ${writes(base)}`, severity: 'soft' };
}

function termsIn(data: BrandData, langs: BrandLanguages, target: string | null): string[] {
  return itemsForLanguage(confirmed(data.words).filter((w) => w.use === 'use' && wordsOf(w.word).length), langs, target).map((w: BrandWord) => w.word);
}

/**
 * What the brand's voice fields and words say about each measure. `contentLanguage` is the design's own language
 * (content-language.ts), when it has one: a design in a language the brand does not speak keeps every explicit
 * measure, but no longer gets the number format that was only inferred from the brand's language, and one in another
 * of the brand's languages gets that language's.
 */
export function voiceProfile(data: BrandData, options: { contentLanguage?: string | null } = {}): VoiceProfile {
  // A measure an agent proposed is not measured against until a person confirms it.
  const f = bindingFields(data);
  const sentences = brandSentences(data);
  const languages = brandLanguages(data);

  const language: VoiceProfile['language'] = f.language
    ? { value: f.language, from: field('language'), severity: 'soft' }
    : languages.primary ? { value: languages.primary, from: 'the language the brand is written in', severity: 'soft' } : null;

  let address: VoiceProfile['address'] = f.address ? { value: f.address, from: field('address'), severity: 'hard' } : null;
  if (!address) {
    for (const s of sentences) {
      for (const p of ADDRESS_PATTERNS) {
        const m = p.re.exec(s.text);
        if (!m) continue;
        const word = m[p.group]!.toLowerCase();
        address = { value: word.startsWith('du') ? 'du' : 'sie', from: s.from, severity: s.severity };
        break;
      }
      if (address) break;
    }
  }

  let sentenceWords: VoiceProfile['sentenceWords'] = f.sentenceWords ? { value: f.sentenceWords, from: field('sentence length'), severity: 'soft' } : null;
  let paragraphSentences: VoiceProfile['paragraphSentences'] = f.paragraphSentences ? { value: f.paragraphSentences, from: field('paragraph length'), severity: 'soft' } : null;
  let headingWords: VoiceProfile['headingWords'] = f.headingMinWords || f.headingMaxWords ? { value: { min: f.headingMinWords, max: f.headingMaxWords }, from: field('heading length'), severity: 'soft' } : null;
  for (const s of sentences) {
    if (!sentenceWords) {
      const n = /(?:Sätze|Satz|sentences?)[^.;]{0,30}?(?:höchstens|maximal|max\.?|at most|no more than|under|unter|bis)\s+(\d+)\s+(?:Wörter|Wörtern|words)/iu.exec(s.text)
        ?? /(?:höchstens|maximal|max\.?|at most|no more than|under|unter|bis zu)\s+(\d+)\s+(?:Wörter|Wörtern|words)\s+(?:pro|per|in a|im|je)\s+(?:Satz|sentence)/iu.exec(s.text);
      if (n) sentenceWords = { value: Number(n[1]), from: s.from, severity: s.severity };
      else if (/(?<![\p{L}])(?:kurze Sätze|short sentences|keep sentences short)(?![\p{L}])/iu.test(s.text)) sentenceWords = { value: SHORT_SENTENCE_WORDS, from: `${s.from}, "short sentences" read as at most ${SHORT_SENTENCE_WORDS} words`, severity: 'soft' };
    }
    if (!paragraphSentences) {
      const n = /(?:Absätze|Absatz|paragraphs?)[^.;]{0,20}?(?:höchstens|maximal|max\.?|at most|no more than|bis)\s+([\p{L}\d]+)\s+(?:Sätze|Sätzen|sentences?)/iu.exec(s.text);
      const value = count(n?.[1]);
      if (value) paragraphSentences = { value, from: s.from, severity: s.severity };
    }
    if (!headingWords) {
      const range = /(?:Überschriften|Überschrift|headings?|headlines?|titles?)[^.;]{0,20}?(\d+)\s*(?:bis|to|-|–)\s*(\d+)\s+(?:Wörter|Wörtern|words)/iu.exec(s.text);
      const most = /(?:Überschriften|Überschrift|headings?|headlines?|titles?)[^.;]{0,20}?(?:höchstens|maximal|at most|no more than|under|unter)\s+(\d+)\s+(?:Wörter|Wörtern|words)/iu.exec(s.text);
      if (range) headingWords = { value: { min: Number(range[1]), max: Number(range[2]) }, from: s.from, severity: s.severity };
      else if (most) headingWords = { value: { min: 0, max: Number(most[1]) }, from: s.from, severity: s.severity };
    }
  }

  const design = options.contentLanguage ?? null;
  return {
    language, languages, address, sentenceWords, paragraphSentences, headingWords,
    numberFormat: numberFormatIn(f, language, languages, design),
    ...(design ? { contentLanguage: design } : {}),
    terms: termsIn(data, languages, matchBrandLanguage(languages, design)),
    required: confirmed(data.rules).filter((r) => !r.flagged && r.check?.type === 'require-text').map((r) => ({ text: (r.check as { value: string }).value, rule: r })),
  };
}

/** The language a text is in, and which of the brand's languages that is (null: one it does not speak, or none known). */
export interface CopyJudgement { language: string | null; spoken: string | null }

/** What language a text is judged in: what it or its design declares, else what its words say, else the brand's primary. */
export function judgeCopy(p: Pick<VoiceProfile, 'languages' | 'contentLanguage'>, t: Pick<VoiceText, 'text' | 'lang'>): CopyJudgement {
  const language = copyLanguage(t.text, t.lang ?? p.contentLanguage ?? null) ?? p.languages.primary;
  return { language, spoken: matchBrandLanguage(p.languages, language) };
}

/** The profile in lines, for the brand's brief and the panel. */
export function voiceProfileLines(p: VoiceProfile): string[] {
  return [
    p.address ? `Address the reader as ${p.address.value === 'du' ? 'du' : 'Sie'}, never mixed` : '',
    p.sentenceWords ? `Sentences of at most ${p.sentenceWords.value} words` : '',
    p.paragraphSentences ? `At most ${p.paragraphSentences.value} sentences in one text` : '',
    p.headingWords ? `Headings of ${p.headingWords.value.min ? `${p.headingWords.value.min} to ` : 'at most '}${p.headingWords.value.max || 'any number of'} words` : '',
    p.numberFormat ? `Numbers written ${p.numberFormat.value === 'de' ? '1.000,50' : '1,000.50'}` : '',
    p.terms.length ? `Spelled as the brand spells them: ${p.terms.slice(0, 12).join(', ')}` : '',
    ...p.required.map((r) => `Must say "${r.text}"`),
  ].filter(Boolean);
}

// ---------------------------------------------------------------- checking text

const DU_FORMS = /(?<![\p{L}])(du|dich|dir|dein|deine|deinen|deinem|deiner|deines|euch|euer|eure|euren|eurem|eurer|eures)(?![\p{L}])/giu;
/** Formal address is capitalised in the middle of a sentence; at its start the capital says nothing. */
const SIE_FORMS = /(?<![\p{L}])(Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)(?![\p{L}])/gu;

function midSentence(text: string, index: number): boolean {
  const before = text.slice(0, index).trimEnd();
  return before.length > 0 && !/[.!?:…„"«(]$/.test(before);
}

/** Text about the forms of address, such as a guideline's "Du und Sie nie mischen", mentions them rather than using them. */
const ABOUT_ADDRESS = /(?<![\p{L}])(?:Du|Sie)\s*(?:und|oder|\/|bzw\.)\s*(?:Du|Sie)(?![\p{L}])|(?<![\p{L}])(?:Anrede|duzen|duzt|siezen|siezt|Du-Form|Sie-Form)(?![\p{L}])/u;

function addressForms(text: string): { du: string[]; sie: string[] } {
  if (ABOUT_ADDRESS.test(text)) return { du: [], sie: [] };
  const du = [...text.matchAll(DU_FORMS)].map((m) => m[0]);
  const sie = [...text.matchAll(SIE_FORMS)].filter((m) => midSentence(text, m.index)).map((m) => m[0]);
  return { du, sie };
}

const HEADING = /^h[1-6]$/;
const CODE = /^(?:code|pre|kbd|samp)$/;
/** Section headings. An h3 is often a card's title or a name, which a word count says little about. */
const MAJOR_HEADING = /^h[12]$/;
// Units of prose. CSS units such as px and rem are code, which keeps its decimal point in any language.
const UNIT_AFTER = String.raw`\s?(?:%|‰|€|\$|£|EUR|USD|CHF|Euro|Prozent|percent|x|×|Mio\.?|Mrd\.?|k|K|MB|GB|kg|km|cm|mm|Std\.?)(?![\p{L}])`;
const CURRENCY_BEFORE = String.raw`(?:€|\$|£|EUR|USD|CHF)\s?`;

function numberProblems(text: string, format: 'de' | 'en'): { quote: string; fixed: string }[] {
  const out: { quote: string; fixed: string }[] = [];
  const add = (quote: string, fixed: string) => {
    if (!out.some((o) => o.quote === quote)) out.push({ quote, fixed });
  };
  const swap = (n: string) => n.replace(/[.,]/g, (c) => (c === '.' ? ',' : '.'));
  if (format === 'de') {
    // Thousands with commas, as in 10,000 or 1,000,000.
    for (const m of text.matchAll(/(?<![\d.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,.]\d)/g)) add(m[0], swap(m[0]));
    // A decimal point next to a unit or a currency: 4.5 %, 9.99 €, € 9.99.
    for (const m of text.matchAll(new RegExp(String.raw`(?<![\d.,])\d+\.\d{1,2}(?=${UNIT_AFTER})`, 'gu'))) add(m[0], swap(m[0]));
    for (const m of text.matchAll(new RegExp(String.raw`(?<=${CURRENCY_BEFORE})\d+\.\d{1,2}(?![\d.])`, 'gu'))) add(m[0], swap(m[0]));
  } else {
    for (const m of text.matchAll(/(?<![\d.,])\d{1,3}(?:\.\d{3}){2,}(?![\d,.]\d)/g)) add(m[0], swap(m[0]));
    for (const m of text.matchAll(new RegExp(String.raw`(?<![\d.,])\d{1,3}\.\d{3}(?=${UNIT_AFTER})`, 'gu'))) add(m[0], swap(m[0]));
    for (const m of text.matchAll(new RegExp(String.raw`(?<![\d.,])\d+,\d{1,2}(?=${UNIT_AFTER})`, 'gu'))) add(m[0], swap(m[0]));
    for (const m of text.matchAll(new RegExp(String.raw`(?<=${CURRENCY_BEFORE})\d+,\d{1,2}(?![\d,])`, 'gu'))) add(m[0], swap(m[0]));
  }
  return out;
}

const normalizeTerm = (s: string) => s.toLowerCase().replace(/(?<![\p{L}])(?:und|and)(?![\p{L}])/gu, '').replace(/[^\p{L}\p{N}]+/gu, '');

/** Other spellings of a term in a text: "IT und Automatisierung" for "IT & Automatisierung", "Followup" for "Follow-up". */
function termVariants(text: string, term: string): string[] {
  const key = normalizeTerm(term);
  if (key.length < 3) return [];
  const tokens = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  const parts = term.match(/[\p{L}\p{N}]+/gu) ?? [];
  const size = parts.length;
  const head = parts[0]!.toLowerCase();
  const tail = parts.at(-1)!.toLowerCase();
  const out = new Set<string>();
  for (let n = Math.max(1, size - 1); n <= size + 2; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const first = tokens[i]!;
      const last = tokens[i + n - 1]!;
      // The span begins and ends where the term does: "your agent and" is the term and a word after it.
      if (!first[0].toLowerCase().startsWith(head) || !last[0].toLowerCase().endsWith(tail)) continue;
      const span = text.slice(first.index, last.index + last[0].length);
      if (normalizeTerm(span) !== key || span === term) continue;
      // A capital at the start of a sentence, or a lower-case first letter in running text, is the same word.
      const sameButFirst = span.slice(1) === term.slice(1) && span[0]!.toLowerCase() === term[0]!.toLowerCase();
      if (sameButFirst) continue;
      out.add(span);
    }
  }
  return [...out];
}

/** The brand's good example closest to a kind of problem, and a bad one that shows it. */
function exampleFor(examples: BrandVoiceExample[], rule: VoiceRule, p: VoiceProfile, quote: string): VoiceFinding['example'] | undefined {
  if (!examples.length) return undefined;
  const pick = (e: BrandVoiceExample | undefined) => (e ? { ...(e.good ? { good: e.good } : {}), ...(e.bad ? { bad: e.bad } : {}), ...(e.note ? { note: e.note } : {}) } : undefined);
  const longest = (s: string) => Math.max(0, ...sentencesOf(s).map((x) => wordsOf(x).length));
  const goods = examples.filter((e) => e.good);
  switch (rule) {
    case 'voice.address':
    case 'voice.address-mixed': {
      const want = p.address?.value;
      return pick(goods.find((e) => (want === 'du' ? addressForms(e.good).du.length : addressForms(e.good).sie.length) > 0));
    }
    case 'voice.sentence-length':
    case 'voice.paragraph-length': {
      const limit = p.sentenceWords?.value ?? Infinity;
      const ok = goods.filter((e) => longest(e.good) <= limit && sentencesOf(e.good).length >= 2);
      return pick(ok.find((e) => /satz|sätze|sentence|kurz|short/i.test(e.note ?? '')) ?? ok[0] ?? goods.filter((e) => longest(e.good) <= limit)[0]);
    }
    case 'voice.heading-length': {
      const h = p.headingWords?.value;
      const fits = (e: BrandVoiceExample) => !h || ((!h.min || wordsOf(e.good).length >= h.min) && (!h.max || wordsOf(e.good).length <= h.max));
      return pick(goods.find((e) => /überschrift|heading|headline|h1|kopf|title/i.test(e.note ?? '') && fits(e)) ?? goods.find((e) => sentencesOf(e.good).length === 1 && fits(e)));
    }
    case 'voice.term':
      return pick(examples.find((e) => e.good.includes(quote)) ?? undefined);
    default:
      return undefined;
  }
}

/**
 * Checks text layers against the measurable voice. `scope` is what was checked as a whole, for text that must appear
 * somewhere in it. A heading is an h1 to h6, or text at least as large as `headingPx` says. Each text is judged in the
 * brand language it is written in (judgeCopy), with that language's words, examples, number format and required text.
 */
export function voiceFindings(data: BrandData, texts: VoiceText[], options: { profile?: VoiceProfile; scopeName?: string; contentLanguage?: string | null } = {}): VoiceFinding[] {
  const p = options.profile ?? voiceProfile(data, { contentLanguage: options.contentLanguage ?? null });
  const f = bindingFields(data);
  const langs = p.languages;
  const examples = confirmed(data.voiceExamples);
  const out: VoiceFinding[] = [];
  const add = (t: VoiceText | null, language: string | null, spoken: string | null, finding: Omit<VoiceFinding, 'node_id' | 'layer' | 'example' | 'language'>) => {
    const example = exampleFor(itemsForLanguage(examples, langs, spoken), finding.rule, p, finding.quote);
    out.push({ ...finding, node_id: t?.id ?? '', layer: t?.name ?? '', ...(example ? { example } : {}), ...(language ? { language } : {}) });
  };
  // Per language, worked out once: a page has few.
  const formats = new Map<string, VoiceProfile['numberFormat']>();
  const terms = new Map<string, string[]>();
  const formatIn = (lang: string | null) => {
    const key = lang ?? '';
    if (!formats.has(key)) formats.set(key, numberFormatIn(f, p.language, langs, lang));
    return formats.get(key)!;
  };
  const termsFor = (spoken: string | null) => {
    const key = spoken ?? '';
    if (!terms.has(key)) terms.set(key, termsIn(data, langs, spoken));
    return terms.get(key)!;
  };
  const several = langs.all.length > 1;
  const forms = { du: 0, sie: 0 };
  const firstOf: { du?: VoiceText; sie?: VoiceText } = {};
  /** What each brand language's texts say together, for the text a rule requires in that language. */
  const byLanguage = new Map<string, { texts: string[]; spoken: string | null }>();
  for (const t of texts) {
    const judged = judgeCopy(p, t);
    const groupKey = judged.spoken ?? langs.primary ?? '';
    const group = byLanguage.get(groupKey) ?? { texts: [], spoken: judged.spoken ?? langs.primary };
    group.texts.push(t.text);
    byLanguage.set(groupKey, group);
    const text = t.text.replace(/\s+/g, ' ').trim();
    if (!text || !/[\p{L}]/u.test(text)) continue;
    const { language, spoken } = judged;
    const heading = HEADING.test(t.tag);
    // Code and commands are not prose.
    const code = CODE.test(t.tag) || /^\s*[$#>]\s/.test(text);
    const finding = (x: Omit<VoiceFinding, 'node_id' | 'layer' | 'example' | 'language'>) => add(t, language, spoken, x);

    // Only German text gets the du/Sie check: the word guess is too weak to tell a German sentence from French "du"
    // or a short label, and the brand's German address does not apply to other languages.
    if (p.address && language && baseLanguage(language) === 'de') {
      const found = addressForms(text);
      forms.du += found.du.length;
      forms.sie += found.sie.length;
      if (found.du.length && !firstOf.du) firstOf.du = t;
      if (found.sie.length && !firstOf.sie) firstOf.sie = t;
      const wrong = p.address.value === 'du' ? found.sie : found.du;
      if (wrong.length) {
        finding({
          rule: 'voice.address', severity: p.address.severity, quote: wrong[0]!,
          message: `"${clip(text, 60)}" says "${wrong[0]}", and the brand addresses the reader as ${p.address.value === 'du' ? 'du' : 'Sie'} (from ${p.address.from}).`,
          how: `Rewrite it with ${p.address.value === 'du' ? 'du, dich, dir and dein' : 'Sie, Ihnen and Ihr'}.`,
        });
      }
    }

    if (p.sentenceWords && !heading && !code) {
      for (const s of sentencesOf(text)) {
        const n = wordsOf(s).length;
        if (n > p.sentenceWords.value) {
          finding({ rule: 'voice.sentence-length', severity: p.sentenceWords.severity, quote: clip(s, 80), message: `A sentence of ${n} words: "${clip(s, 70)}". The brand keeps sentences to ${p.sentenceWords.value} words (from ${p.sentenceWords.from}).`, how: 'Split it into two sentences, one thought each.' });
          break;
        }
      }
    }
    if (p.paragraphSentences && !heading && !code) {
      const n = sentencesOf(text).length;
      if (n > p.paragraphSentences.value) finding({ rule: 'voice.paragraph-length', severity: p.paragraphSentences.severity, quote: clip(text, 80), message: `This text has ${n} sentences, and the brand keeps one to ${p.paragraphSentences.value} (from ${p.paragraphSentences.from}).`, how: `Keep ${p.paragraphSentences.value}, or make the rest a list or a second text.` });
    }
    if (p.headingWords && MAJOR_HEADING.test(t.tag)) {
      const n = wordsOf(text).length;
      const { min, max } = p.headingWords.value;
      if ((min && n < min) || (max && n > max)) finding({ rule: 'voice.heading-length', severity: p.headingWords.severity, quote: clip(text, 80), message: `The heading "${clip(text, 60)}" has ${n} ${n === 1 ? 'word' : 'words'}, and the brand's headings have ${min ? `${min} to ${max || 'any number of'}` : `at most ${max}`} (from ${p.headingWords.from}).`, how: n < min ? 'Say what the section gives the reader, in a few more words.' : 'Keep the one statement that matters, and cut the rest.' });
    }
    const numbers = formatIn(language);
    if (numbers) {
      for (const problem of numberProblems(text, numbers.value)) {
        finding({ rule: 'voice.number-format', severity: 'soft', quote: problem.quote, message: `"${problem.quote}" is written the ${numbers.value === 'de' ? 'English' : 'German'} way, and the brand writes numbers ${numbers.value === 'de' ? '1.000,50' : '1,000.50'}${several && spoken ? ` in ${languageAndTag(spoken)}` : ''} (from ${numbers.from}).`, how: `Write ${problem.fixed}.`, text: text.replace(problem.quote, problem.fixed) });
      }
    }
    for (const term of termsFor(spoken)) {
      for (const variant of termVariants(text, term)) {
        finding({ rule: 'voice.term', severity: 'soft', quote: variant, message: `"${variant}" is the brand's term "${term}", spelled another way.`, how: `Write "${term}".`, text: text.split(variant).join(term) });
      }
    }
  }
  if (p.address && forms.du && forms.sie && firstOf.du && firstOf.sie) {
    const other = p.address.value === 'du' ? firstOf.sie : firstOf.du;
    // Each wrong text is already reported; this says that one place mixes both.
    if (!out.some((x) => x.rule === 'voice.address' && x.node_id === other.id)) {
      const judged = judgeCopy(p, other);
      add(other, judged.language, judged.spoken, { rule: 'voice.address-mixed', severity: p.address.severity, quote: '', message: `This${options.scopeName ? ` ${options.scopeName}` : ''} uses du and Sie side by side, and the brand never mixes them (from ${p.address.from}).`, how: `Use ${p.address.value === 'du' ? 'du' : 'Sie'} throughout.` });
    }
  }
  // Text a rule requires is required of the copy in the rule's language, wherever there is copy in it.
  for (const group of byLanguage.values()) {
    const all = group.texts.join('\n').toLowerCase();
    for (const r of itemsForLanguage(p.required.map((x) => ({ ...x, lang: x.rule.lang })), langs, group.spoken, { fallback: false })) {
      const where = several && group.spoken ? ` in the ${languageAndTag(group.spoken)} copy` : '';
      if (!all.includes(r.text.toLowerCase())) add(null, group.spoken, group.spoken, { rule: 'voice.required', severity: r.rule.severity, quote: r.text, message: `Nothing${where} here says "${r.text}", which the brand requires (the rule "${clip(r.rule.text)}").`, how: `Say "${r.text}" where it fits.` });
    }
  }
  return out;
}

export function exampleLine(example: VoiceFinding['example']): string {
  if (!example) return '';
  const parts = [example.good ? `good: "${clip(example.good, 120)}"` : '', example.bad ? `bad: "${clip(example.bad, 120)}"` : ''].filter(Boolean);
  return parts.length ? ` The brand's own example, ${parts.join(', ')}.` : '';
}
