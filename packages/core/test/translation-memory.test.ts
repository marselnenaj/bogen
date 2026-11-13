import { describe, expect, it } from 'vitest';
import {
  BogenDoc, branchContent, createDesignBranch, docToContent, keepAsIs, languageVersions, localeStatus, rememberTranslations, setContentLanguage, setLocaleStatus,
  setTranslationRules, switchDesignBranch, syncLanguageVersion, translatableTexts, translationStatus, TRANSLATION_ROOT,
} from '../src/index.ts';

/** A small English page and a German version of it, translated by hand in its branch. */
function file() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  setContentLanguage(doc, 'en');
  const board = doc.insert(page, {
    type: 'frame', name: 'Home', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '400px', height: '300px' },
    children: [
      { type: 'text', tag: 'h1', name: 'Title', text: 'Night trains', style: {} },
      { type: 'text', tag: 'p', name: 'Brand', text: 'Couchette', style: {} },
      { type: 'text', tag: 'code', name: 'Code', text: 'npm install bogen', style: {} },
      { type: 'text', tag: 'p', name: 'Price', text: '€ 49', style: {} },
      { type: 'image', tag: 'img', name: 'Photo', attrs: { alt: 'A sleeping compartment' }, style: {} },
    ],
  });
  const [title, brand, , , photo] = doc.rawKids(board);
  const { branch } = createDesignBranch(doc, { name: 'German (de)', by: 'claude', checkout: true });
  setContentLanguage(doc, 'de');
  doc.updateFields(title!, { text: 'Nachtzüge' });
  switchDesignBranch(doc, 'main');
  return { doc, page, board, title: title!, brand: brand!, photo: photo!, branch: branch.id };
}

describe('what a translation covers', () => {
  it('leaves out code, numbers, addresses and the words the rules keep', () => {
    expect(keepAsIs('€ 49')).toBe(true);
    expect(keepAsIs('https://trains.example')).toBe(true);
    expect(keepAsIs('getUserName()')).toBe(true);
    expect(keepAsIs('Ctrl+K')).toBe(true);
    expect(keepAsIs('Couchette', ['couchette'])).toBe(true);
    expect(keepAsIs('Book a couchette')).toBe(false);
    const { doc } = file();
    const texts = translatableTexts(docToContent(doc), { keep: ['Couchette'] });
    expect(texts.map((t) => [t.field, t.source])).toEqual([['text', 'Night trains'], ['alt', 'A sleeping compartment']]);
  });
});

describe('a language version with a translation memory', () => {
  it('learns what the version translated, lists only new and changed text, and fills the rest from memory', () => {
    const { doc, page, board, title, photo, branch } = file();
    setTranslationRules(doc, { keep: ['Couchette'] });
    expect(languageVersions(doc).map((v) => [v.branch.id, v.tag, v.status])).toEqual([[branch, 'de', 'include']]);

    const first = translationStatus(doc, 'de');
    // The title was translated in the branch: learned. The alt text was not.
    expect(first.needed.map((n) => n.source)).toEqual(['A sleeping compartment']);
    expect(first.translated).toBe(1);

    // The original changes: a new section, and the title gets a new wording.
    doc.insert(board, { type: 'text', tag: 'p', name: 'Lead', text: 'Sleep through Europe.', style: {} });
    doc.updateFields(title, { text: 'Night trains across Europe' });
    const second = translationStatus(doc, 'de');
    expect(second.behind).toBe(true);
    expect(second.needed.map((n) => n.source).sort()).toEqual(['A sleeping compartment', 'Night trains across Europe', 'Sleep through Europe.']);
    // The old translation comes along as a hint for the changed title.
    expect(second.needed.find((n) => n.source === 'Night trains across Europe')!.was).toBe('Nachtzüge');

    // The agent translates the three; unchanged text is never asked for again.
    rememberTranslations(doc, 'de', [
      { source: 'Night trains across Europe', target: 'Nachtzüge durch Europa' },
      { source: 'Sleep through Europe.', target: 'Schlafen Sie sich durch Europa.' },
      { source: 'A sleeping compartment', target: 'Ein Schlafabteil' },
    ], 'claude');
    const sync = syncLanguageVersion(doc, 'de', 'claude');
    expect(sync).toMatchObject({ filled: 3, left: 0, structure: true });
    expect(translationStatus(doc, 'de').needed).toEqual([]);

    const de = branchContent(doc, branch);
    const byName = (name: string) => de.nodes.find((n) => n.name === name)!;
    expect(byName('Title').text).toBe('Nachtzüge durch Europa');
    expect(byName('Lead').text).toBe('Schlafen Sie sich durch Europa.');
    expect((byName('Photo').attrs as Record<string, string>).alt).toBe('Ein Schlafabteil');
    expect(byName('Brand').text).toBe('Couchette');
    expect(byName('Code').text).toBe('npm install bogen');
    expect((byName('Home').attrs as Record<string, string>).lang).toBe('de');
    expect(de.extra?.meta?.contentLanguage).toBe('de');
    // Main is untouched, and the memory is not part of any version's content.
    expect(doc.getNode(title)!.text).toBe('Night trains across Europe');
    expect(JSON.stringify(docToContent(doc))).not.toContain(TRANSLATION_ROOT);
    void page;
    void photo;
  });

  it('keeps the version\'s own layout changes when it follows its original', () => {
    const { doc, board, title, branch } = file();
    switchDesignBranch(doc, branch);
    doc.updateStyle(title, { fontSize: '28px' });
    switchDesignBranch(doc, 'main');
    doc.insert(board, { type: 'text', name: 'Footer', text: 'Since 1998', style: {} });
    syncLanguageVersion(doc, branch, 'person');
    const de = branchContent(doc, branch);
    expect(de.nodes.find((n) => n.id === title)!.style.fontSize).toBe('28px');
    expect(de.nodes.find((n) => n.name === 'Footer')!.text).toBe('Since 1998');
  });

  it('asks nothing for a language left untranslated or hidden', () => {
    const { doc } = file();
    setLocaleStatus(doc, 'de', 'untranslated');
    expect(localeStatus(doc, 'de')).toBe('untranslated');
    expect(translationStatus(doc, 'de').needed).toEqual([]);
    setLocaleStatus(doc, 'de', 'hidden');
    expect(translationStatus(doc, 'de').status).toBe('hidden');
    expect(() => setLocaleStatus(doc, 'de', 'gone' as never)).toThrow();
  });
});
