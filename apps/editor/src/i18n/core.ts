/**
 * The interface's words in the chosen language.
 *
 * Messages are keyed by their English source text, so `t('Delete layer')` reads naturally in the code and shows the
 * English when a catalog lacks the message: an untranslated string is visible as English, never as a key. Only
 * the selected language's catalog is loaded, on demand, as its own chunk (see `loaders`).
 *
 * - Placeholders are `{name}`, filled from `vars`. Numbers are written with the language's digits and decimal
 *   separator, ungrouped, as Omarchy does, so `1920` stays `1920` and is `۱۹۲۰` in Persian.
 * - Plurals: `t.n(count, '{count} layer', '{count} layers')`. The key is the English `other` form; a catalog entry
 *   is an object of CLDR categories for the language (`one`, `few`, `many`, ...), chosen by `Intl.PluralRules`.
 * - Rich text: `t.rich('Open {file} to edit it', { file: <b>{name}</b> })` places React nodes into a translated
 *   sentence, so word order stays the translator's.
 *
 * In a right-to-left language, text put into a placeholder is wrapped in Unicode isolates (FSI ... PDI), so a
 * file name or a CSS value in Latin script keeps its own order inside the sentence.
 *
 * Nothing here walks or observes the DOM: components ask for their words while they render.
 */
import { createElement, Fragment, type ReactNode } from 'react';
import { language, SOURCE_LANGUAGE, type Language } from './registry.ts';

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
export type PluralForms = Partial<Record<PluralCategory, string>> & { other: string };
export type Entry = string | PluralForms;
export type Catalog = Readonly<Record<string, Entry>>;
export type Vars = Readonly<Record<string, string | number>>;

export interface Translate {
  (key: string, vars?: Vars): string;
  /** The form of `one`/`other` for `count` in this language. `{count}` is filled in, besides `vars`. */
  n(count: number, one: string, other: string, vars?: Vars): string;
  /** A sentence with React nodes in its placeholders. Plain values may be mixed in. */
  rich(key: string, parts: Readonly<Record<string, ReactNode>>): ReactNode;
  readonly code: string;
  readonly lang: Language;
}

const FSI = '\u2068';
/** Separates a context from the English in a message key, as gettext's msgctxt does. */
export const CONTEXT = '\u0004';

/** The English a key shows: the key itself, less its context. */
export function englishOf(key: string): string {
  const at = key.indexOf(CONTEXT);
  return at < 0 ? key : key.slice(at + 1);
}
const PDI = '\u2069';
const PLACEHOLDER = /\{(\w+)\}/g;

const pluralRules = new Map<string, Intl.PluralRules>();
function pluralRule(locale: string): Intl.PluralRules {
  let rule = pluralRules.get(locale);
  if (!rule) {
    try { rule = new Intl.PluralRules(locale); } catch { rule = new Intl.PluralRules('en-US'); }
    pluralRules.set(locale, rule);
  }
  return rule;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
/** A number as Omarchy writes it for the language: its digits and decimal sign, no grouping. */
export function formatPlainNumber(value: number, locale: string): string {
  let nf = numberFormats.get(locale);
  if (!nf) {
    try { nf = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 6 }); } catch { nf = new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 6 }); }
    numberFormats.set(locale, nf);
  }
  return Number.isFinite(value) ? nf.format(value) : String(value);
}

/** The placeholder names in a message, sorted, each once. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))].sort();
}

export function makeTranslate(code: string, catalog: Catalog): Translate {
  const lang = language(code) ?? language(SOURCE_LANGUAGE)!;
  const rtl = lang.dir === 'rtl';
  const value = (v: string | number): string => {
    if (typeof v === 'number') return formatPlainNumber(v, lang.formatLocale);
    return rtl && v ? FSI + v + PDI : v;
  };
  const fill = (text: string, vars?: Vars): string => (vars ? text.replace(PLACEHOLDER, (all, name: string) => (name in vars ? value(vars[name]!) : all)) : text);
  const lookup = (key: string): Entry | undefined => (Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : undefined);

  const t = ((key: string, vars?: Vars): string => {
    const entry = lookup(key);
    return fill(typeof entry === 'string' && entry ? entry : typeof entry === 'object' ? entry.other : englishOf(key), vars);
  }) as Translate;

  t.n = (count, one, other, vars) => {
    const all = { ...vars, count };
    const entry = lookup(other);
    if (entry && typeof entry === 'object') {
      const category = pluralRule(lang.formatLocale).select(count) as PluralCategory;
      return fill(entry[category] ?? entry.other, all);
    }
    if (typeof entry === 'string' && entry) return fill(entry, all);
    // English, or a language without the message: English's own rule.
    return fill(count === 1 ? one : other, all);
  };

  t.rich = (key, parts) => {
    const entry = lookup(key);
    const text = typeof entry === 'string' && entry ? entry : typeof entry === 'object' ? entry.other : englishOf(key);
    const out: ReactNode[] = [];
    let last = 0;
    for (const m of text.matchAll(PLACEHOLDER)) {
      const name = m[1]!;
      if (!(name in parts)) continue;
      if (m.index > last) out.push(text.slice(last, m.index));
      const part = parts[name];
      out.push(typeof part === 'string' || typeof part === 'number' ? value(part) : part);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return createElement(Fragment, null, ...out);
  };

  Object.defineProperty(t, 'code', { value: lang.code });
  Object.defineProperty(t, 'lang', { value: lang });
  return t;
}

/**
 * The same English word with another meaning, as its own message: `t(ctx('font weight', 'Light'))` shows "Light"
 * in English and lets a translator write the weight's name, apart from a light theme.
 */
export function ctx(context: string, source: string): string {
  return context + CONTEXT + source;
}

/** Marks a string for translation where it is defined, for lists and tables outside components; `t(label)` shows it. */
export function msg<const S extends string>(source: S): S {
  return source;
}
