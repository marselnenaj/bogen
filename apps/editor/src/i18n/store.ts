/// <reference types="vite/client" />
/**
 * The language in use and its catalog. One catalog is in memory at a time besides the ones already fetched; each
 * language is its own chunk (`locales/<code>.json`), fetched when it is first chosen.
 *
 * Switching is a race-free swap: a later choice always wins over an earlier one whose catalog arrives late, and the
 * interface keeps the old words until the new catalog is there, so it never flashes keys or half a language.
 */
import { makeTranslate, type Catalog, type Translate, type Vars } from './core.ts';
import { isLanguageCode, language, SOURCE_LANGUAGE } from './registry.ts';

export type Loader = (code: string) => Promise<Catalog>;

const bundled = import.meta.glob<Catalog>('./locales/*.json', { import: 'default' });

/** The build's loader: Vite makes each catalog a chunk of its own, so the main bundle carries none of them. */
export const chunkLoader: Loader = async (code) => {
  const load = bundled[`./locales/${code}.json`];
  if (!load) throw new Error(`No catalog for ${code}.`);
  return load();
};

let loader: Loader = chunkLoader;
const loaded = new Map<string, Catalog>([[SOURCE_LANGUAGE, {}]]);
let current: Translate = makeTranslate(SOURCE_LANGUAGE, {});
let wanted = SOURCE_LANGUAGE;
let sequence = 0;
const listeners = new Set<() => void>();

export function currentTranslate(): Translate {
  return current;
}

/** The language being shown. While a new one loads, the old one. */
export function currentLanguage(): string {
  return current.code;
}

export function subscribeLanguage(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function show(code: string, catalog: Catalog): void {
  if (current.code === code && loaded.get(code) === catalog) return;
  current = makeTranslate(code, catalog);
  applyToDocument();
  for (const fn of [...listeners]) fn();
}

/**
 * Shows `code`, loading its catalog first if need be. Resolves once the language is shown, or once a later call
 * has taken over. An unknown code, or a catalog that fails to load, shows English and rejects nothing: the
 * interface stays usable, and `lastLoadError` says what happened.
 */
export async function showLanguage(code: string): Promise<void> {
  const target = isLanguageCode(code) ? code : SOURCE_LANGUAGE;
  const mine = ++sequence;
  wanted = target;
  const ready = loaded.get(target);
  if (ready) {
    lastLoadError = null;
    show(target, ready);
    return;
  }
  try {
    const catalog = await loader(target);
    loaded.set(target, catalog);
    if (mine !== sequence) return;
    lastLoadError = null;
    show(target, catalog);
  } catch (e) {
    if (mine !== sequence) return;
    lastLoadError = { code: target, message: e instanceof Error ? e.message : String(e) };
    show(SOURCE_LANGUAGE, loaded.get(SOURCE_LANGUAGE)!);
  }
}

export let lastLoadError: { code: string; message: string } | null = null;

/** The language last asked for, which may still be loading. */
export function wantedLanguage(): string {
  return wanted;
}

/**
 * `lang` and `dir` of the page, for the interface around the design. The canvas, previews and code keep their own
 * direction (see styles/i18n.css), so a right-to-left interface never turns a design or its coordinates around.
 */
let documentTarget: { lang: string; dir: 'ltr' | 'rtl' } | null = null;
export function applyToDocument(): void {
  if (typeof document === 'undefined' || documentLocked) return;
  const lang = current.lang;
  const next = { lang: lang.formatLocale, dir: lang.dir };
  if (documentTarget && documentTarget.lang === next.lang && documentTarget.dir === next.dir) return;
  documentTarget = next;
  document.documentElement.lang = next.lang;
  document.documentElement.dir = next.dir;
}

let documentLocked = false;
/** For pages that are a design and nothing else, such as the full-screen preview: they keep the page's own lang and dir. */
export function lockDocumentLanguage(): void {
  documentLocked = true;
}

/** The plain `t` for code outside components (toasts, commands): the language at the moment it runs. */
export const t: Translate = Object.assign(
  (key: string, vars?: Vars) => current(key, vars),
  {
    n: (count: number, one: string, other: string, vars?: Vars) => current.n(count, one, other, vars),
    rich: (key: string, parts: Parameters<Translate['rich']>[1]) => current.rich(key, parts),
  },
) as Translate;
Object.defineProperty(t, 'code', { get: () => current.code });
Object.defineProperty(t, 'lang', { get: () => current.lang });

/** For tests: another loader, and everything forgotten. */
export function resetForTests(next: Loader = chunkLoader): void {
  loader = next;
  loaded.clear();
  loaded.set(SOURCE_LANGUAGE, {});
  sequence = 0;
  wanted = SOURCE_LANGUAGE;
  current = makeTranslate(SOURCE_LANGUAGE, {});
  lastLoadError = null;
  documentTarget = null;
  documentLocked = false;
}

export { language };
