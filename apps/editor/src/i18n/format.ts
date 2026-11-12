/**
 * Dates, times and numbers in the language in use, with the registry's formatting locale, so a Persian interface
 * writes Persian digits and a German one `5.11.2026`. For words around them, use `t`.
 */
import { formatPlainNumber } from './core.ts';
import { t } from './store.ts';

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.ListFormat>();

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.ListFormat>(kind: string, options: object, make: (locale: string) => T): T {
  const locale = t.lang.formatLocale;
  const key = `${kind}|${locale}|${JSON.stringify(options)}`;
  let f = cache.get(key) as T | undefined;
  if (!f) {
    try { f = make(locale); } catch { f = make('en-US'); }
    cache.set(key, f);
  }
  return f;
}

export function formatDate(at: number | Date, options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }): string {
  return cached('date', options, (l) => new Intl.DateTimeFormat(l, options)).format(at);
}

export function formatTime(at: number | Date, options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }): string {
  return cached('time', options, (l) => new Intl.DateTimeFormat(l, options)).format(at);
}

export function formatDateTime(at: number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  return cached('datetime', options, (l) => new Intl.DateTimeFormat(l, options)).format(at);
}

/** A count or measure with grouping, such as `12,480 frames`. */
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return cached('number', options, (l) => new Intl.NumberFormat(l, options)).format(value);
}

/** A number the way Omarchy writes it in the language: its digits and decimal sign, no grouping. */
export function formatPlain(value: number): string {
  return formatPlainNumber(value, t.lang.formatLocale);
}

export function formatList(items: readonly string[], type: 'conjunction' | 'disjunction' = 'conjunction'): string {
  return cached('list', { type }, (l) => new Intl.ListFormat(l, { type, style: 'long' })).format(items);
}
