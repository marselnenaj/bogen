import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { emptyBrand, voiceFindings, voiceProfile, voiceProfileLines, type BrandData } from '@bogen/core';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

/** A German brand that says its voice in its own words, as brands written by people do. */
const KANZLEI_ITEMS = [
  { section: 'rules', text: 'Website und Newsletter sprechen Du. Du und Sie werden nie gemischt.', kind: 'do', severity: 'hard', topic: 'voice' },
  { section: 'rules', text: 'Kurze Sätze. Absätze höchstens zwei Sätze, Überschriften mit 3 bis 6 Wörtern.', kind: 'do', severity: 'soft', topic: 'voice' },
  { section: 'rules', text: 'Jede Seite nennt den Ort: Persönlich aus Graz.', kind: 'do', severity: 'soft', topic: 'voice', check: { type: 'require-text', value: 'Persönlich aus Graz' } },
  { section: 'words', word: 'IT & Recht', use: 'use' },
  { section: 'words', word: 'Follow-up', use: 'use' },
  { section: 'words', word: 'Mandat', use: 'use' },
  { section: 'voiceExamples', good: 'Du schreibst uns. Wir melden uns am selben Tag.', bad: 'Sie erhalten zeitnah eine Rückmeldung von unserem Team.', note: 'Kontakt: Du, ein Gedanke pro Satz.' },
  { section: 'voiceExamples', good: 'Verträge, die du verstehst.', note: 'Eine Überschrift, eine Aussage.' },
];

function brand(): BrandData {
  const data = emptyBrand();
  data.fields.tone = 'Ruhig und konkret. Wir sprechen wie ein guter erster Anruf.';
  data.rules = KANZLEI_ITEMS.filter((i) => i.section === 'rules').map((r, n) => ({ id: `r${n}`, text: r.text!, kind: 'do', severity: r.severity as 'hard' | 'soft', topic: 'voice', ...(r.check ? { check: r.check as { type: 'require-text'; value: string } } : {}) }));
  data.words = KANZLEI_ITEMS.filter((i) => i.section === 'words').map((w, n) => ({ id: `w${n}`, word: w.word!, use: 'use', severity: 'soft' }));
  data.voiceExamples = KANZLEI_ITEMS.filter((i) => i.section === 'voiceExamples').map((e, n) => ({ id: `e${n}`, good: e.good!, bad: e.bad ?? '', ...(e.note ? { note: e.note } : {}) }));
  return data;
}

const text = (id: string, value: string, tag = 'p') => ({ id, name: id, tag, text: value });

describe('the brand\'s voice, measured', () => {
  it('reads each measure from the brand\'s own words, and says where from', () => {
    const p = voiceProfile(brand());
    expect(p.language?.value).toBe('de');
    expect(p.address).toEqual({ value: 'du', from: 'the rule "Website und Newsletter sprechen Du. Du und Sie werden nie gemischt."', severity: 'hard' });
    expect(p.sentenceWords?.value).toBe(20);
    expect(p.sentenceWords?.from).toContain('"short sentences" read as at most 20 words');
    expect(p.paragraphSentences?.value).toBe(2);
    expect(p.headingWords?.value).toEqual({ min: 3, max: 6 });
    expect(p.numberFormat?.value).toBe('de');
    expect(p.terms).toEqual(['IT & Recht', 'Follow-up', 'Mandat']);
    expect(p.required.map((r) => r.text)).toEqual(['Persönlich aus Graz']);
    expect(voiceProfileLines(p)).toContain('Address the reader as du, never mixed');
  });

  it('the brand\'s settings win over what its words say', () => {
    const data = brand();
    Object.assign(data.fields, { address: 'sie', sentenceWords: 12, headingMinWords: 0, headingMaxWords: 4, numberFormat: 'en' });
    const p = voiceProfile(data);
    expect(p.address).toEqual({ value: 'sie', from: 'the brand\'s address setting', severity: 'hard' });
    expect(p.sentenceWords?.value).toBe(12);
    expect(p.headingWords?.value).toEqual({ min: 0, max: 4 });
    expect(p.numberFormat?.value).toBe('en');
  });

  it('finds Sie in a du brand, long sentences and texts, headings out of range, numbers, other spellings and missing text, with the brand\'s examples', () => {
    const data = brand();
    const findings = voiceFindings(data, [
      text('a', 'Wir prüfen Ihren Vertrag in zwei Tagen.'),
      text('b', 'Du und Sie werden bei uns nie gemischt, das steht in der Anrede.'),
      text('c', 'Wir lesen jeden Vertrag, den du uns schickst, vollständig und sorgfältig durch, markieren jede Klausel, die dir schaden könnte, und erklären sie dir in einfachen Worten.'),
      text('d', 'Erster Satz. Zweiter Satz. Dritter Satz.'),
      text('e', 'Recht', 'h2'),
      text('f', 'Über 10,000 Mandate und 4.5 % weniger Aufwand.'),
      text('g', 'Wir beraten zu IT und Recht und machen das Followup.'),
    ]);
    const by = (rule: string) => findings.filter((f) => f.rule === rule);
    expect(by('voice.address')).toHaveLength(1);
    expect(by('voice.address')[0]).toMatchObject({ node_id: 'a', quote: 'Ihren', severity: 'hard', example: { good: 'Du schreibst uns. Wir melden uns am selben Tag.', bad: 'Sie erhalten zeitnah eine Rückmeldung von unserem Team.' } });
    // A text about the forms of address mentions them; it does not use them.
    expect(findings.some((f) => f.node_id === 'b' && f.rule.startsWith('voice.address'))).toBe(false);
    expect(by('voice.sentence-length')[0]).toMatchObject({ node_id: 'c', how: 'Split it into two sentences, one thought each.' });
    expect(by('voice.sentence-length')[0]!.message).toMatch(/^A sentence of 2\d words/);
    expect(by('voice.paragraph-length')[0]).toMatchObject({ node_id: 'd' });
    expect(by('voice.heading-length')[0]!.message).toContain('has 1 word, and the brand\'s headings have 3 to 6');
    expect(by('voice.heading-length')[0]!.example?.good).toBe('Verträge, die du verstehst.');
    expect(by('voice.number-format').map((f) => [f.quote, f.how])).toEqual([['10,000', 'Write 10.000.'], ['4.5', 'Write 4,5.']]);
    expect(by('voice.term').map((f) => [f.quote, f.text])).toEqual([
      ['IT und Recht', 'Wir beraten zu IT & Recht und machen das Followup.'],
      ['Followup', 'Wir beraten zu IT und Recht und machen das Follow-up.'],
    ]);
    expect(by('voice.required')[0]!.message).toContain('Nothing here says "Persönlich aus Graz"');
  });

  it('says when du and Sie sit side by side, and leaves English and sentence starts alone', () => {
    const data = brand();
    const mixed = voiceFindings(data, [text('a', 'Du bekommst eine Antwort.'), text('b', 'Gerne beraten wir Sie persönlich.')]);
    expect(mixed.map((f) => f.rule)).toContain('voice.address');
    // "Sie" at the start of a sentence can mean they.
    expect(voiceFindings(data, [text('a', 'Sie kommen aus Graz und kennen den Markt.')]).filter((f) => f.rule.startsWith('voice.address'))).toEqual([]);
    expect(voiceFindings(data, [text('a', 'We read every contract you send us.')]).filter((f) => f.rule.startsWith('voice.address'))).toEqual([]);
    const english = { ...emptyBrand(), fields: { ...emptyBrand().fields, tone: 'Plain and short. We say what it does.' } };
    expect(voiceFindings(english, [text('a', 'It costs €9,99 and saves 4,5 % of the time.')]).map((f) => f.quote)).toEqual(['4,5', '9,99']);
    expect(voiceFindings(english, [text('a', 'Version 2.5 ships with 1.000 tests on 04.11.2026.')])).toEqual([]);
  });
});

describe('voice through the tools', () => {
  let h: Harness;
  let agent: Client;
  let brandId: string;
  let file: string;
  let board: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'writer');
    brandId = (await call(agent, 'brand_create', { name: 'Kanzlei' })).id;
    await call(agent, 'brand_update', { brand_id: brandId, confirmed: true, fields: { tone: 'Ruhig und konkret. Wir sprechen wie ein guter erster Anruf.' }, items: KANZLEI_ITEMS });
    file = (await call(agent, 'file_create', { name: 'Seite' })).id;
    await call(agent, 'brand_link', { brand_id: brandId, file_id: file });
    board = (await call(agent, 'artboard_create', { file_id: file, name: 'Start', width: 800 })).id;
    await call(agent, 'html_write', { file_id: file, target_id: board, html: '<h1>Recht</h1><p>Wir prüfen Ihren Vertrag in zwei Tagen.</p><p>Persönlich aus Graz.</p>' });
  });
  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('voice_check checks a draft before it is written, and says what it measures and why', async () => {
    const out = await call(agent, 'voice_check', { brand_id: brandId, text: 'Senden Sie uns Ihre Unterlagen.\n\nWir melden uns.' });
    expect(out.checked).toBe(2);
    expect(out.profile.address).toMatchObject({ value: 'du', severity: 'hard' });
    expect(out.profile.measures).toContain('Headings of 3 to 6 words');
    expect(out.findings.map((f: any) => f.rule)).toEqual(['voice.address', 'voice.required']);
    expect(out.findings[0].example.good).toBe('Du schreibst uns. Wir melden uns am selben Tag.');
    const heading = await call(agent, 'voice_check', { brand_id: brandId, text: 'Recht', tag: 'h1' });
    expect(heading.findings.map((f: any) => f.rule)).toContain('voice.heading-length');
  });

  it('brand_check counts voice, and design_lint reports it as copy with the brand\'s example', async () => {
    const report = await call(agent, 'brand_check', { file_id: file, limit: 200 });
    const voice = report.violations.filter((v: any) => v.category === 'voice');
    expect(voice.map((v: any) => v.rule).sort()).toEqual(['voice.address', 'voice.heading-length']);
    expect(voice.find((v: any) => v.rule === 'voice.address').message).toContain('The brand\'s own example, good: "Du schreibst uns.');
    expect(report.why.categories.find((c: any) => c.category === 'voice').failed).toBe(2);
    const lint = await call(agent, 'design_lint', { file_id: file, node_id: board });
    const copy = lint.issues.filter((i: any) => i.rule === 'copy').map((i: any) => i.message);
    expect(copy.some((m: string) => m.includes('says "Ihren", and the brand addresses the reader as du'))).toBe(true);
  });

  it('the brief carries what is measured, so an agent writes to it from the start', async () => {
    const brief = await (await fetch(`${h.base}/api/brands/${brandId}/brief`)).json();
    expect(brief.brief).toContain('"measured":["Address the reader as du, never mixed"');
  });
});
