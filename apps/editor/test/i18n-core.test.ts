import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ctx, formatPlainNumber, makeTranslate, placeholders, type Catalog } from '../src/i18n/core.ts';
import { isLanguageCode, LANGUAGE_CODES, LANGUAGES, language, languagesForPicker } from '../src/i18n/registry.ts';
import { omarchyLanguageFromFile, pickLanguage, resolveLanguage } from '../src/i18n/resolve.ts';
import { currentLanguage, lastLoadError, resetForTests, showLanguage, subscribeLanguage, t, wantedLanguage } from '../src/i18n/store.ts';
import { LANGUAGE_CODES as SERVER_CODES, parseLanguageFile } from '../../../packages/server/src/platform-language.ts';

const OMARCHY_REGISTRY = '/usr/share/omarchy/default/i18n/locales.json';

describe('the language registry', () => {
  it('has Omarchy\'s 50 languages, each once, with a formatting locale Intl knows', () => {
    expect(LANGUAGES).toHaveLength(50);
    expect(new Set(LANGUAGE_CODES).size).toBe(50);
    for (const l of LANGUAGES) {
      expect(l.name.trim()).not.toBe('');
      expect(Intl.NumberFormat.supportedLocalesOf([l.formatLocale])).toHaveLength(1);
    }
    expect(LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.code).sort()).toEqual(['ar', 'fa', 'he', 'ur']);
  });

  it('is the same list the server accepts from Omarchy\'s language file', () => {
    expect([...SERVER_CODES].sort()).toEqual([...LANGUAGE_CODES].sort());
  });

  it.skipIf(!existsSync(OMARCHY_REGISTRY))('matches the installed Omarchy registry it was copied from', () => {
    const installed = JSON.parse(readFileSync(OMARCHY_REGISTRY, 'utf8')) as Record<string, { name: string; englishName: string; formatLocale: string; direction?: string; decimal: string; zeroDigit: string }>;
    expect(Object.keys(installed)).toEqual([...LANGUAGE_CODES]);
    for (const [code, entry] of Object.entries(installed)) {
      expect(language(code)).toEqual({ code, name: entry.name, englishName: entry.englishName, formatLocale: entry.formatLocale, dir: entry.direction ?? 'ltr', decimal: entry.decimal, zeroDigit: entry.zeroDigit });
    }
  });

  it('agrees with Intl on each language\'s digits and decimal sign', () => {
    for (const l of LANGUAGES) {
      expect(formatPlainNumber(1.5, l.formatLocale), l.code).toBe(`${l.zeroDigit === '0' ? '1' : String.fromCodePoint(l.zeroDigit.codePointAt(0)! + 1)}${l.decimal}${l.zeroDigit === '0' ? '5' : String.fromCodePoint(l.zeroDigit.codePointAt(0)! + 5)}`);
    }
  });

  it('sorts the picker by native name', () => {
    const names = languagesForPicker('en').map((l) => l.code);
    expect(names).toHaveLength(50);
    expect(names.indexOf('de')).toBeLessThan(names.indexOf('fr'));
  });
});

describe('locale tags to registry languages', () => {
  it.each([
    ['de-AT', 'de'], ['de', 'de'], ['fr-CA', 'fr'], ['en-GB', 'en'], ['ar-EG', 'ar'], ['ur-IN', 'ur'],
    ['nb', 'no'], ['nn-NO', 'no'], ['no', 'no'], ['nb_NO.UTF-8', 'no'],
    ['es', 'es-MX'], ['es-ES', 'es-MX'], ['es-419', 'es-MX'], ['es_MX.UTF-8', 'es-MX'],
    ['pt', 'pt'], ['pt-PT', 'pt'], ['pt-AO', 'pt'], ['pt-BR', 'pt-BR'], ['pt_BR.UTF-8', 'pt-BR'],
    ['zh', 'zh-CN'], ['zh-CN', 'zh-CN'], ['zh-SG', 'zh-CN'], ['zh-Hans', 'zh-CN'], ['zh-Hans-HK', 'zh-CN'],
    ['zh-TW', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh-MO', 'zh-TW'], ['zh-Hant', 'zh-TW'], ['zh-Hant-CN', 'zh-TW'], ['zh_TW.UTF-8', 'zh-TW'],
    ['iw', 'he'], ['in', 'id'], ['tl', 'fil'], ['fil-PH', 'fil'], ['sr-Latn-RS', 'sr'], ['sr_RS@latin', 'sr'], ['uz-Cyrl', 'uz'],
    ['ga-IE', 'ga'], ['si-LK', 'si'], ['sw-KE', 'sw'], ['fa-AF', 'fa'], ['ms-BN', 'ms'], ['ca-ES-valencia', 'ca'],
    ['DE-de', 'de'], ['ja_JP.eucJP', 'ja'],
  ])('%s is %s', (tag, code) => {
    expect(resolveLanguage(tag)).toBe(code);
  });

  it.each(['', 'C', 'POSIX', 'C.UTF-8', 'xx', 'af-ZA', 'eu', 'cy', 'yue-HK', '../../etc/passwd', 'de;rm -rf', 42, null, 'a'.repeat(80)])('%s is not a language Bogen has', (tag) => {
    expect(resolveLanguage(tag)).toBeNull();
  });

  it('takes the first language Bogen has, else English', () => {
    expect(pickLanguage(['af', 'eu', 'nl-BE', 'de'])).toBe('nl');
    expect(pickLanguage(['af', 'cy'])).toBe('en');
    expect(pickLanguage([])).toBe('en');
  });

  it('reads Omarchy\'s language file the way Omarchy does', () => {
    expect(omarchyLanguageFromFile('de\n')).toBe('de');
    expect(omarchyLanguageFromFile('  pt-BR  \nignored')).toBe('pt-BR');
    expect(omarchyLanguageFromFile('zh-TW')).toBe('zh-TW');
    expect(omarchyLanguageFromFile('de-AT')).toBeNull();
    expect(omarchyLanguageFromFile('klingon')).toBeNull();
    expect(omarchyLanguageFromFile('')).toBeNull();
    for (const code of LANGUAGE_CODES) expect(parseLanguageFile(`${code}\n`)).toBe(code);
  });
});

describe('the translator', () => {
  const de: Catalog = {
    'Delete layer': 'Ebene löschen',
    'Rename {name}': '{name} umbenennen',
    '{count} layers': { one: '{count} Ebene', other: '{count} Ebenen' },
    'Press {key} to search': 'Zum Suchen {key} drücken',
  };

  it('shows the translation, and the English where there is none', () => {
    const tr = makeTranslate('de', de);
    expect(tr('Delete layer')).toBe('Ebene löschen');
    expect(tr('Not translated yet')).toBe('Not translated yet');
    expect(tr('Rename {name}', { name: 'Kopf' })).toBe('Kopf umbenennen');
    expect(tr('Hello {who}', { who: 'du' })).toBe('Hello du');
    // An unknown placeholder stays visible rather than vanishing.
    expect(tr('Rename {name}')).toBe('{name} umbenennen');
  });

  it('is English without a catalog, with English plurals', () => {
    const en = makeTranslate('en', {});
    expect(en.n(1, '{count} layer', '{count} layers')).toBe('1 layer');
    expect(en.n(0, '{count} layer', '{count} layers')).toBe('0 layers');
    expect(en.n(1920, '{count} layer', '{count} layers')).toBe('1920 layers');
  });

  it('picks the plural form by the language\'s rules', () => {
    const ru = makeTranslate('ru', { '{count} layers': { one: '{count} слой', few: '{count} слоя', many: '{count} слоёв', other: '{count} слоя' } });
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => ru.n(n, '{count} layer', '{count} layers'))).toEqual(['1 слой', '2 слоя', '5 слоёв', '11 слоёв', '21 слой', '22 слоя', '25 слоёв']);
    const ar = makeTranslate('ar', { '{count} files': { zero: 'لا ملفات', one: 'ملف واحد', two: 'ملفان', few: '{count} ملفات', many: '{count} ملفًا', other: '{count} ملف' } });
    expect([0, 1, 2, 3, 11, 100].map((n) => ar.n(n, '{count} file', '{count} files'))).toEqual(['لا ملفات', 'ملف واحد', 'ملفان', '⁨3⁩ ملفات'.replace(/⁨|⁩/g, ''), '11 ملفًا', '100 ملف']);
    const ja = makeTranslate('ja', { '{count} files': { other: '{count} 個のファイル' } });
    expect(ja.n(1, '{count} file', '{count} files')).toBe('1 個のファイル');
    // A plural catalog entry without the language's category falls back to `other`.
    const pl = makeTranslate('pl', { '{count} files': { one: '{count} plik', other: '{count} pliki' } });
    expect(pl.n(5, '{count} file', '{count} files')).toBe('5 pliki');
  });

  it('writes numbers with the language\'s digits, ungrouped', () => {
    expect(makeTranslate('fa', { 'Size {size}': 'اندازه {size}' })('Size {size}', { size: 1920.5 })).toBe('اندازه ۱۹۲۰٫۵');
    expect(makeTranslate('bn', {})('{n} px', { n: 12 })).toBe('১২ px');
    expect(makeTranslate('de', {})('{n} px', { n: 12.5 })).toBe('12,5 px');
    expect(makeTranslate('en', {})('{n} px', { n: 12480 })).toBe('12480 px');
  });

  it('isolates inserted text in a right-to-left language, and only there', () => {
    const he = makeTranslate('he', { 'Rename {name}': 'שינוי שם של {name}' });
    expect(he('Rename {name}', { name: 'Header (v2)' })).toBe('שינוי שם של ⁨Header (v2)⁩');
    expect(makeTranslate('de', de)('Rename {name}', { name: 'Header (v2)' })).toBe('Header (v2) umbenennen');
  });

  it('puts React nodes into a translated sentence in the translator\'s order', () => {
    const tr = makeTranslate('de', de);
    const node = tr.rich('Press {key} to search', { key: 'KBD' }) as { props: { children: unknown[] } };
    expect(node.props.children).toEqual(['Zum Suchen ', 'KBD', ' drücken']);
  });

  it('keeps a word with another meaning apart, and shows its English unchanged', () => {
    const weight = ctx('font weight', 'Light');
    expect(makeTranslate('en', {})(weight)).toBe('Light');
    const de = makeTranslate('de', { Light: 'Hell', [weight]: 'Light' });
    expect(de('Light')).toBe('Hell');
    expect(de(weight)).toBe('Light');
    expect(makeTranslate('fr', {})(weight)).toBe('Light');
  });

  it('lists placeholders', () => {
    expect(placeholders('{b} and {a}, {b}')).toEqual(['a', 'b']);
  });
});

describe('loading a language', () => {
  type Deferred = { resolve: (c: Catalog) => void; reject: (e: Error) => void };
  let pending: Map<string, Deferred[]>;
  const loader = (code: string) => new Promise<Catalog>((resolve, reject) => {
    pending.set(code, [...(pending.get(code) ?? []), { resolve, reject }]);
  });
  const settle = (code: string, catalog: Catalog) => pending.get(code)!.shift()!.resolve(catalog);
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    pending = new Map();
    resetForTests(loader);
  });
  afterEach(() => resetForTests());

  it('keeps the old words until the new catalog is there, then tells the listeners once', async () => {
    const seen: string[] = [];
    const stop = subscribeLanguage(() => seen.push(currentLanguage()));
    const done = showLanguage('de');
    expect(currentLanguage()).toBe('en');
    expect(wantedLanguage()).toBe('de');
    settle('de', { Layers: 'Ebenen' });
    await done;
    expect(currentLanguage()).toBe('de');
    expect(t('Layers')).toBe('Ebenen');
    expect(seen).toEqual(['de']);
    stop();
  });

  it('lets the later choice win when an earlier catalog arrives late', async () => {
    const first = showLanguage('de');
    const second = showLanguage('fr');
    settle('fr', { Layers: 'Calques' });
    await second;
    expect(currentLanguage()).toBe('fr');
    settle('de', { Layers: 'Ebenen' });
    await first;
    expect(currentLanguage()).toBe('fr');
    expect(t('Layers')).toBe('Calques');
    // The late catalog is kept: going back to it needs no second fetch.
    await showLanguage('de');
    expect(t('Layers')).toBe('Ebenen');
    expect(pending.get('de')).toHaveLength(0);
  });

  it('a switch back to English while a catalog loads is not undone by it', async () => {
    const slow = showLanguage('ja');
    await showLanguage('en');
    settle('ja', { Layers: 'レイヤー' });
    await slow;
    expect(currentLanguage()).toBe('en');
    expect(t('Layers')).toBe('Layers');
  });

  it('shows English when a catalog cannot be loaded, and says why', async () => {
    const done = showLanguage('sw');
    pending.get('sw')!.shift()!.reject(new Error('offline'));
    await done;
    expect(currentLanguage()).toBe('en');
    expect(lastLoadError).toEqual({ code: 'sw', message: 'offline' });
  });

  it('treats an unknown code as English without fetching anything', async () => {
    await showLanguage('xx');
    await flush();
    expect(currentLanguage()).toBe('en');
    expect(pending.size).toBe(0);
  });

  it('sets lang and dir of the page for the interface', async () => {
    const root = { lang: 'en', dir: '' };
    vi.stubGlobal('document', { documentElement: root });
    try {
      const done = showLanguage('fa');
      settle('fa', {});
      await done;
      expect(root).toEqual({ lang: 'fa-IR', dir: 'rtl' });
      await showLanguage('en');
      expect(root).toEqual({ lang: 'en-US', dir: 'ltr' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('every language has a catalog chunk, loaded only on demand', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/i18n/store.ts'), 'utf8');
    expect(src).toMatch(/import\.meta\.glob<Catalog>\('\.\/locales\/\*\.json', \{ import: 'default' \}\)/);
    expect(src).not.toMatch(/eager:\s*true/);
    const files = readdirSync(join(import.meta.dirname, '../src/i18n/locales')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
    expect(files).toEqual(LANGUAGE_CODES.filter((c) => c !== 'en').slice().sort());
    // Nothing else reaches into the catalogs, so no catalog is pulled into the main bundle.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !p.endsWith('i18n/store.ts') && /locales\/[\w-]+\.json/.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(join(import.meta.dirname, '../src'));
    expect(offenders).toEqual([]);
  });

  it('knows each code', () => {
    expect(isLanguageCode('pt-BR')).toBe(true);
    expect(isLanguageCode('pt-br')).toBe(false);
  });
});
