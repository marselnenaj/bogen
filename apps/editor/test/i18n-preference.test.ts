import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automaticLanguage, parsePlatform, parsePreference } from '../src/i18n/preference.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('Automatic', () => {
  it('follows Omarchy on this computer first, then the browser, then the session locale, then English', () => {
    expect(automaticLanguage({ omarchy: 'fa', system: ['de_DE.UTF-8'] }, ['ja-JP'])).toBe('fa');
    expect(automaticLanguage({ omarchy: null, system: ['de_DE.UTF-8'] }, ['ja-JP', 'en-US'])).toBe('ja');
    expect(automaticLanguage({ omarchy: null, system: ['de_DE.UTF-8'] }, ['af-ZA'])).toBe('de');
    expect(automaticLanguage(null, ['af-ZA', 'cy'])).toBe('en');
    expect(automaticLanguage(null, ['nb-NO'])).toBe('no');
    expect(automaticLanguage(null, ['zh-HK'])).toBe('zh-TW');
  });

  it('trusts nothing in the server\'s answer it does not know', () => {
    expect(parsePlatform({ omarchy: 'de', system: ['de_DE.UTF-8'] })).toEqual({ omarchy: 'de', system: ['de_DE.UTF-8'] });
    expect(parsePlatform({ omarchy: '../../x', system: 'de' })).toEqual({ omarchy: null, system: [] });
    expect(parsePlatform({ omarchy: 'xx', system: [1, 'a'.repeat(100), 'fr_FR'] })).toEqual({ omarchy: null, system: ['fr_FR'] });
    expect(parsePlatform(null)).toBeNull();
    expect(parsePlatform('de')).toBeNull();
  });

  it('reads a stored choice only when it is a known language', () => {
    expect(parsePreference('de')).toBe('de');
    expect(parsePreference('auto')).toBe('auto');
    expect(parsePreference('klingon')).toBe('auto');
    expect(parsePreference(null)).toBe('auto');
  });
});

describe('this device\'s language', () => {
  let storage: ReturnType<typeof memoryStorage>;
  const catalogs: Record<string, Record<string, string>> = { de: { Layers: 'Ebenen' }, fr: { Layers: 'Calques' }, ja: { Layers: 'レイヤー' } };

  async function fresh(initial: Record<string, string> = {}, browser: string[] = ['en-US']) {
    storage = memoryStorage(initial);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('navigator', { languages: browser, language: browser[0] });
    vi.resetModules();
    const store = await import('../src/i18n/store.ts');
    store.resetForTests(async (code) => catalogs[code] ?? {});
    const pref = await import('../src/i18n/preference.ts');
    return { store, pref };
  }

  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('starts in the browser\'s language when nothing was chosen and the computer says nothing', async () => {
    const { store, pref } = await fresh({}, ['fr-CH']);
    await pref.startLanguage({ fetchPlatform: async () => ({ omarchy: null, system: [] }), follow: false });
    expect(store.currentLanguage()).toBe('fr');
    expect(pref.languagePreference()).toBe('auto');
  });

  it('follows Omarchy\'s language in Automatic, and remembers the answer for the next start', async () => {
    const { store, pref } = await fresh({}, ['fr-FR']);
    await pref.startLanguage({ fetchPlatform: async () => ({ omarchy: 'ja', system: [] }), follow: false });
    expect(store.currentLanguage()).toBe('ja');
    expect(JSON.parse(storage.data.get('bogen-language-platform')!)).toEqual({ omarchy: 'ja', system: [] });
    // Omarchy switches to German under Setup > Language; the next look follows it.
    await pref.refreshPlatformLanguage(async () => ({ omarchy: 'de', system: [] }));
    expect(store.currentLanguage()).toBe('de');
  });

  it('starts at once in the remembered Automatic language, before the computer answers', async () => {
    const { store, pref } = await fresh({ 'bogen-language-platform': JSON.stringify({ omarchy: 'de', system: [] }) }, ['fr-FR']);
    let answer: (v: unknown) => void = () => {};
    const start = pref.startLanguage({ fetchPlatform: () => new Promise((r) => { answer = r; }), follow: false, waitMs: 1000 });
    await start;
    expect(store.currentLanguage()).toBe('de');
    answer({ omarchy: 'de', system: [] });
  });

  it('keeps a person\'s choice over Omarchy, on this device only', async () => {
    const { store, pref } = await fresh({}, ['en-US']);
    await pref.setLanguagePreference('fr');
    expect(store.currentLanguage()).toBe('fr');
    expect(storage.data.get('bogen-language')).toBe('fr');
    await pref.refreshPlatformLanguage(async () => ({ omarchy: 'de', system: [] }));
    expect(store.currentLanguage()).toBe('fr');
    // Back to Automatic: the stored choice is gone and Omarchy's language shows.
    await pref.setLanguagePreference('auto');
    expect(storage.data.has('bogen-language')).toBe(false);
    expect(store.currentLanguage()).toBe('de');
    // Only the two keys of this feature are written; nothing else of the person's.
    expect([...storage.data.keys()].sort()).toEqual(['bogen-language-platform']);
  });

  it('reads the stored choice on the next start', async () => {
    const { store, pref } = await fresh({ 'bogen-language': 'ja' }, ['de-DE']);
    await pref.startLanguage({ fetchPlatform: async () => ({ omarchy: 'fr', system: [] }), follow: false });
    expect(store.currentLanguage()).toBe('ja');
  });

  it('starts in English when storage and the computer both fail', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} });
    vi.stubGlobal('navigator', { languages: [], language: '' });
    vi.resetModules();
    const store = await import('../src/i18n/store.ts');
    store.resetForTests(async () => ({}));
    const pref = await import('../src/i18n/preference.ts');
    await pref.startLanguage({ fetchPlatform: async () => { throw new Error('offline'); }, follow: false });
    expect(store.currentLanguage()).toBe('en');
    await pref.setLanguagePreference('de');
    expect(store.currentLanguage()).toBe('de');
  });

  it('does not hold the first paint for a slow catalog', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'bogen-language': 'de' }));
    vi.stubGlobal('navigator', { languages: ['en'], language: 'en' });
    vi.resetModules();
    const store = await import('../src/i18n/store.ts');
    let release: (c: Record<string, string>) => void = () => {};
    store.resetForTests(() => new Promise((r) => { release = r; }));
    const pref = await import('../src/i18n/preference.ts');
    const before = Date.now();
    await pref.startLanguage({ fetchPlatform: async () => ({ omarchy: null, system: [] }), follow: false, waitMs: 30 });
    expect(Date.now() - before).toBeLessThan(1000);
    expect(store.currentLanguage()).toBe('en');
    release({ Layers: 'Ebenen' });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.currentLanguage()).toBe('de');
  });
});
