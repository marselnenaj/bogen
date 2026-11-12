import { describe, expect, it } from 'vitest';
import {
  BogenDoc, Y, brandBrief, brandCompact, brandFieldProblem, brandItemProblem, brandLanguages, brandRulesText, brandVersions, chapterLanguage, confirmBrandItems, copyLanguage, diffBrand,
  emptyBrand, itemsForLanguage, markBrandDoc, markBrandFields, matchBrandLanguage, publishBrandVersion, readBrand, readBrandBook, setBrandField, updateBrandBookChapter, upsertBrandItem, voiceFindings,
  type BrandData,
} from '../src/index.ts';

function brandDoc(): BogenDoc {
  const doc = new BogenDoc(new Y.Doc());
  markBrandDoc(doc);
  return doc;
}

const text = (id: string, value: string, lang?: string) => ({ id, name: id, tag: 'p', text: value, ...(lang ? { lang } : {}) });

/** English first, and German too, each with words, examples and a required line of its own. */
function bilingual(): BrandData {
  const data = emptyBrand();
  data.fields.language = 'en';
  data.fields.languages = ['de'];
  data.fields.address = 'du';
  data.words = [
    { id: 'w1', word: 'Sign-up', use: 'use', severity: 'soft' },
    { id: 'w2', word: 'Anmeldung', use: 'use', severity: 'soft', lang: 'de' },
    { id: 'w3', word: 'Follow-up', use: 'use', severity: 'soft', lang: '*' },
  ];
  data.voiceExamples = [
    { id: 'e1', good: 'You write to us. We answer the same day.', bad: '' },
    { id: 'e2', good: 'Du schreibst uns. Wir melden uns am selben Tag.', bad: '', lang: 'de' },
  ];
  data.rules = [
    { id: 'r1', text: 'Every page says it.', kind: 'do', severity: 'soft', topic: 'voice', check: { type: 'require-text', value: 'Made in Graz' } },
    { id: 'r2', text: 'Jede Seite sagt es.', kind: 'do', severity: 'soft', topic: 'voice', check: { type: 'require-text', value: 'Aus Graz' }, lang: 'de' },
  ];
  return data;
}

describe('the languages a brand speaks', () => {
  it('keeps a brand of one language as it was: de and en stay valid, and its items are in it', () => {
    const doc = brandDoc();
    // As a brand from before brand languages stored it: one field, and items without a language.
    setBrandField(doc, 'language', 'de');
    upsertBrandItem(doc, 'words', { word: 'Mandat', use: 'use' });
    const data = readBrand(doc);
    expect(data.fields.languages).toEqual([]);
    expect(brandLanguages(data)).toEqual({ primary: 'de', inferred: false, additional: [], all: ['de'] });
    expect(itemsForLanguage(data.words, brandLanguages(data), 'de').map((w) => w.word)).toEqual(['Mandat']);
    // A brand that sets nothing still reads German from its own words, as the voice check did.
    const unset = emptyBrand();
    unset.fields.tone = 'Wir sprechen ruhig und konkret, wie ein guter erster Anruf.';
    expect(brandLanguages(unset)).toMatchObject({ primary: 'de', inferred: true });
  });

  it('takes any BCP 47 tag for the primary and the others, and refuses what is not one', () => {
    for (const ok of ['', 'de', 'de-AT', 'pt-BR', 'zh-Hant-TW']) expect(brandFieldProblem('language', ok)).toBeNull();
    expect(brandFieldProblem('language', 'German')).toMatch(/language tag/);
    expect(brandFieldProblem('languages', ['en', 'pt-BR'])).toBeNull();
    expect(brandFieldProblem('languages', 'en, de')).toMatch(/list/);
    expect(brandFieldProblem('languages', ['en', 'Klingon please'])).toMatch(/not a language tag/);
    expect(brandItemProblem('words', { word: 'x', lang: 'de-AT' })).toBeNull();
    expect(brandItemProblem('words', { word: 'x', lang: '*' })).toBeNull();
    expect(brandItemProblem('words', { word: 'x', lang: 'german' })).toMatch(/lang must be/);
    expect(brandItemProblem('colors', { value: '#fff', lang: 'de' })).toMatch(/only words/);
    const doc = brandDoc();
    setBrandField(doc, 'language', 'pt_br' as never);
    setBrandField(doc, 'languages', ['EN', 'en', 'not a tag', 'de-at'] as never);
    expect(readBrand(doc).fields).toMatchObject({ language: 'pt-BR', languages: ['en', 'de-AT'] });
  });

  it('keeps what words and examples are in when another primary takes over', () => {
    const doc = brandDoc();
    upsertBrandItem(doc, 'words', { word: 'Mandat', use: 'use' });
    // Set for the first time: the items were in no named language, and are now in this one.
    setBrandField(doc, 'language', 'de');
    expect(readBrand(doc).words[0]!.lang).toBeUndefined();
    // German stops being the primary: its words stay German, and German stays one of the brand's languages.
    setBrandField(doc, 'language', 'en');
    const data = readBrand(doc);
    expect(data.words[0]!.lang).toBe('de');
    expect(brandLanguages(data)).toMatchObject({ primary: 'en', additional: ['de'] });
    // A proposal of another primary changes nothing until it is confirmed: the published English binds.
    publishBrandVersion(doc, { by: 'owner' });
    setBrandField(doc, 'language', 'fr');
    markBrandFields(doc, ['language'], true);
    upsertBrandItem(doc, 'words', { word: 'plainly', use: 'use' });
    expect(brandLanguages(readBrand(doc)).primary).toBe('en');
    confirmBrandItems(doc, ['language']);
    expect(readBrand(doc).words.find((w) => w.word === 'plainly')?.lang).toBe('en');
    expect(brandLanguages(readBrand(doc))).toMatchObject({ primary: 'fr', additional: ['en', 'de'] });
  });

  it('finds the brand language of copy: the same tag, else the same language, the primary first', () => {
    const langs = { all: ['de', 'de-AT', 'en'] };
    expect(matchBrandLanguage(langs, 'de-AT')).toBe('de-AT');
    expect(matchBrandLanguage(langs, 'de-CH')).toBe('de');
    expect(matchBrandLanguage({ all: ['de-AT'] }, 'de')).toBe('de-AT');
    expect(matchBrandLanguage(langs, 'fr')).toBeNull();
    // What a layer declares wins over the words, unless they clearly say German instead of English or back.
    expect(copyLanguage('Le prix du café', 'fr')).toBe('fr');
    expect(copyLanguage('Wir sind für dich da und helfen dir.', 'en')).toBe('de');
    expect(copyLanguage('OK', null)).toBeNull();
  });

  it('gives copy the words of its language, those of the primary where it has none, and words for every language always', () => {
    const data = bilingual();
    const langs = brandLanguages(data);
    expect(itemsForLanguage(data.words, langs, 'de').map((w) => w.word)).toEqual(['Anmeldung', 'Follow-up']);
    expect(itemsForLanguage(data.words, langs, null).map((w) => w.word)).toEqual(['Sign-up', 'Follow-up']);
    // A language the brand speaks with nothing of its own, or one it does not speak: the primary's stand in.
    expect(itemsForLanguage(data.words, { primary: 'en' }, 'fr').map((w) => w.word)).toEqual(['Sign-up', 'Follow-up']);
    // Text a rule requires does not stand in for another language.
    expect(itemsForLanguage(data.rules, langs, 'fr', { fallback: false })).toEqual([]);
  });
});

describe('copy judged in the language it is written in', () => {
  it('checks German copy for du and Sie, English copy not, whichever the primary is', () => {
    const findings = voiceFindings(bilingual(), [text('de', 'Melden Sie sich jetzt an und sichern Sie sich den Platz.', 'de'), text('en', 'Sie is a word in this English sentence for you.', 'en')]);
    const address = findings.filter((f) => f.rule === 'voice.address');
    expect(address.map((f) => f.node_id)).toEqual(['de']);
    expect(address[0]!.language).toBe('de');
  });

  it('writes numbers the way each of the brand\'s languages does', () => {
    const findings = voiceFindings(bilingual(), [text('en', 'It saves 4,5 % of the time.', 'en'), text('de', 'Das spart 4.5 % der Zeit.', 'de')]).filter((f) => f.rule === 'voice.number-format');
    expect(findings.map((f) => [f.node_id, f.quote, f.language])).toEqual([['en', '4,5', 'en'], ['de', '4.5', 'de']]);
    expect(findings[1]!.message).toMatch(/in German \(de\)/);
  });

  it('holds each language to its own spelling of terms, and terms for every language everywhere', () => {
    const findings = voiceFindings(bilingual(), [text('de', 'Die Anmel-dung und das Followup sind schnell erledigt.', 'de'), text('en', 'The Signup takes a minute.', 'en')]).filter((f) => f.rule === 'voice.term');
    expect(findings.map((f) => [f.node_id, f.quote])).toEqual([['de', 'Followup'], ['en', 'Signup']]);
  });

  it('requires a rule\'s text only of copy in its language, where there is copy in it', () => {
    const germanOnly = voiceFindings(bilingual(), [text('a', 'Wir beraten dich persönlich.', 'de')]).filter((f) => f.rule === 'voice.required');
    expect(germanOnly.map((f) => f.quote)).toEqual(['Aus Graz']);
    expect(germanOnly[0]!.message).toMatch(/in the German \(de\) copy/);
    const both = voiceFindings(bilingual(), [text('a', 'Wir beraten dich. Aus Graz.', 'de'), text('b', 'We advise you in person.', 'en')]).filter((f) => f.rule === 'voice.required');
    expect(both.map((f) => f.quote)).toEqual(['Made in Graz']);
  });

  it('gives a finding the brand\'s example in the language of the copy', () => {
    const data = bilingual();
    data.fields.sentenceWords = 6;
    const [finding] = voiceFindings(data, [text('de', 'Wir melden uns bei dir so schnell wie es nur irgendwie geht.', 'de')]).filter((f) => f.rule === 'voice.sentence-length');
    expect(finding?.example?.good).toMatch(/^Du schreibst uns/);
  });
});

describe('what an agent is told', () => {
  it('says which languages the brand speaks, and which one to write in', () => {
    const data = bilingual();
    const brief = brandBrief(data, { id: 'b1', writeIn: { tag: 'de', source: 'file' } });
    expect(brief).toMatch(/The brand speaks English \(en\) as its primary language, and also German \(de\)/);
    expect(brief).toMatch(/Write copy in German \(de\), since it is the file's design language/);
    expect(brandBrief(data, { id: 'b1' })).toMatch(/Write copy in English \(en\), the brand's primary language/);
    expect(brandBrief(data, { id: 'b1', writeIn: { tag: 'fr', source: 'run' } })).toMatch(/Write copy in French \(fr\), since the person chose it for this request, although the brand does not speak it/);
    const compact = brandCompact(data) as { languages: { primary: string; also: string[] }; voice: { use: string[]; in_other_languages: Record<string, { use: string[] }> } };
    expect(compact.languages).toMatchObject({ primary: 'en', also: ['de'] });
    expect(compact.voice.use).toEqual(['Sign-up', 'Follow-up']);
    expect(compact.voice.in_other_languages.de?.use).toEqual(['Anmeldung']);
    expect(brandRulesText(data, 'voice')).toMatch(/Languages: en, primary; also de/);
    // A brand without languages reads as before.
    expect(brandCompact(emptyBrand())).not.toHaveProperty('languages');
  });

  it('counts the same languages in two versions as no change', () => {
    expect(diffBrand(bilingual(), bilingual())).toEqual([]);
    const other = bilingual();
    other.fields.languages = ['de', 'pt-BR'];
    expect(diffBrand(bilingual(), other).map((c) => c.id)).toEqual(['languages']);
  });

  it('syncs the languages and each item\'s language to another device', () => {
    const doc = brandDoc();
    setBrandField(doc, 'language', 'en');
    setBrandField(doc, 'languages', ['de-AT']);
    upsertBrandItem(doc, 'voiceExamples', { good: 'Servus, wir sind für dich da.', lang: 'de-AT' });
    const other = new BogenDoc(new Y.Doc());
    Y.applyUpdate(other.y, Y.encodeStateAsUpdate(doc.y));
    const data = readBrand(other);
    expect(data.fields).toMatchObject({ language: 'en', languages: ['de-AT'] });
    expect(data.voiceExamples[0]!.lang).toBe('de-AT');
    // A version holds them too.
    publishBrandVersion(doc, { by: 'owner' });
    expect(brandVersions(doc)[0]!.data.voiceExamples[0]!.lang).toBe('de-AT');
  });
});

describe('brandbook chapters keep the language they are written in', () => {
  const draft = { id: 'voice' as const, markdown: 'Wir sprechen dich direkt an.', source: 'Owner', questions: '', status: 'draft' as const, expectedRevision: null };

  it('stores a chapter\'s own language, keeps it on later edits, and falls back to the primary', () => {
    const doc = brandDoc();
    const a = updateBrandBookChapter(doc, { ...draft, lang: 'de-AT' }, 'owner', true);
    expect(a.lang).toBe('de-AT');
    const b = updateBrandBookChapter(doc, { ...draft, markdown: 'Wir sprechen dich an.', expectedRevision: a.revision }, 'agent');
    expect(b.lang).toBe('de-AT');
    const c = updateBrandBookChapter(doc, { ...draft, expectedRevision: b.revision, lang: null }, 'owner', true);
    expect(c.lang).toBeUndefined();
    expect(() => updateBrandBookChapter(doc, { ...draft, expectedRevision: c.revision, lang: 'Deutsch bitte' }, 'owner', true)).toThrow('language tag');
    expect(readBrandBook(doc)?.chapters[0]?.lang).toBeUndefined();
    expect(chapterLanguage(readBrandBook(doc)?.chapters[0], { primary: 'en' })).toBe('en');
    expect(chapterLanguage({ markdown: 'Wir sind für dich da und helfen dir.' }, { primary: null })).toBe('de');
    expect(chapterLanguage({ markdown: 'OK' }, { primary: null })).toBeNull();
  });
});
