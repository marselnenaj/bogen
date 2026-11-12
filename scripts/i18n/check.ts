/**
 * The rules a language's catalog must keep, for the audit and the tests.
 *
 * - every key is a message of the source (no stale or misspelt keys);
 * - a translation has exactly the placeholders of its English (`{name}` neither lost nor invented);
 * - a plural message has every category the language's plural rules use (Intl.PluralRules), and only those;
 * - no value is empty.
 *
 * Values equal to the English are counted (`sameAsEnglish`): right for names and technical terms, a sign of an
 * untranslated catalog when there are many.
 */
import { onlyTechnical } from './extract.ts';

type Source = Record<string, string | { one: string; other: string }>;
type Value = string | Record<string, string>;

export interface CatalogReport {
  code: string;
  translated: number;
  missing: string[];
  sameAsEnglish: string[];
  errors: string[];
  /** Translated messages over all messages. */
  coverage: number;
}

const PLACEHOLDER = /\{(\w+)\}/g;
const names = (s: string) => [...new Set([...s.matchAll(PLACEHOLDER)].map((m) => m[1]!))].sort().join(',');
const withoutCount = (list: string) => list.split(',').filter((n) => n && n !== 'count').join(',');

/** The plural categories a language uses for whole numbers, from the platform's CLDR data. */
export function pluralCategories(formatLocale: string): string[] {
  const rules = new Intl.PluralRules(formatLocale);
  const seen = new Set<string>();
  for (let n = 0; n <= 200; n++) seen.add(rules.select(n));
  for (const n of [1000, 1000000, 2000000]) seen.add(rules.select(n));
  return [...seen].sort();
}

export const FORMAT_LOCALES: Record<string, string> = {
  da: 'da-DK', ar: 'ar-AE', fi: 'fi-FI', fr: 'fr-FR', el: 'el-GR', hu: 'hu-HU', hi: 'hi-IN', is: 'is-IS', ja: 'ja-JP', ko: 'ko-KR', 'es-MX': 'es-MX',
  fil: 'fil-PH', pt: 'pt-PT', sv: 'sv-SE', tr: 'tr-TR', vi: 'vi-VN', ur: 'ur-PK', bn: 'bn-BD', ca: 'ca-AD', si: 'si-LK', ta: 'ta-LK', th: 'th-TH',
  uz: 'uz-UZ', it: 'it-IT', 'zh-CN': 'zh-CN', pl: 'pl-PL', lt: 'lt-LT', ga: 'ga-IE', nl: 'nl-NL', no: 'nb-NO', ru: 'ru-RU', id: 'id-ID', de: 'de-DE',
  sw: 'sw-TZ', fa: 'fa-IR', ms: 'ms-MY', uk: 'uk-UA', ro: 'ro-RO', cs: 'cs-CZ', sr: 'sr-RS', he: 'he-IL', bg: 'bg-BG', sk: 'sk-SK', hr: 'hr-HR',
  sl: 'sl-SI', 'zh-TW': 'zh-TW', et: 'et-EE', lv: 'lv-LV', 'pt-BR': 'pt-BR',
};

export function checkCatalog(code: string, catalog: Record<string, Value> | null, source: Source): CatalogReport {
  const errors: string[] = [];
  const missing: string[] = [];
  const same: string[] = [];
  let translated = 0;
  const categories = pluralCategories(FORMAT_LOCALES[code] ?? code);
  if (!catalog) return { code, translated: 0, missing: Object.keys(source), sameAsEnglish: [], errors: ['no catalog file'], coverage: 0 };
  for (const key of Object.keys(catalog)) if (!(key in source)) errors.push(`unknown key ${JSON.stringify(key)}`);
  for (const [key, english] of Object.entries(source)) {
    const value = catalog[key];
    if (value === undefined) {
      missing.push(key);
      continue;
    }
    if (typeof english === 'string') {
      if (typeof value !== 'string') { errors.push(`${JSON.stringify(key)}: a plain message, given plural forms`); continue; }
      if (!value.trim()) { errors.push(`${JSON.stringify(key)}: empty`); continue; }
      if (names(value) !== names(english)) errors.push(`${JSON.stringify(key)}: placeholders {${names(value)}} instead of {${names(english)}}`);
      if (value === english && !onlyTechnical(english)) same.push(key);
    } else {
      if (typeof value !== 'object' || value === null) { errors.push(`${JSON.stringify(key)}: a plural message, given ${typeof value}`); continue; }
      const want = names(english.other);
      for (const c of categories) {
        const form = value[c];
        if (typeof form !== 'string' || !form.trim()) errors.push(`${JSON.stringify(key)}: no "${c}" form`);
        // A form other than `other` may leave out {count}, where the language says the number in words ("one file").
        else if (names(form) !== want && !(c !== 'other' && names(form) === withoutCount(want))) errors.push(`${JSON.stringify(key)}: "${c}" has placeholders {${names(form)}} instead of {${want}}`);
      }
      for (const c of Object.keys(value)) if (!categories.includes(c)) errors.push(`${JSON.stringify(key)}: "${c}" is not a plural category of ${code}`);
      if (value.other === english.other) same.push(key);
    }
    translated++;
  }
  const total = Object.keys(source).length;
  return { code, translated, missing, sameAsEnglish: same, errors, coverage: total ? translated / total : 1 };
}
