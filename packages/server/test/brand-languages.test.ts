import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RunRequest } from '../src/agents.ts';
import { copyIssues } from '../src/mcp/copy-check.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/**
 * A brand that speaks English first and German too, with words of each, a rule per language and an example in German.
 * The checks here run without a browser: brand_check falls back to what the document declares.
 */
const ITEMS = [
  { section: 'words', word: 'cheap', use: 'avoid', instead: 'affordable', severity: 'soft' },
  { section: 'words', word: 'billig', use: 'avoid', instead: 'günstig', severity: 'soft', lang: 'de' },
  { section: 'words', word: 'Follow-up', use: 'use', lang: '*' },
  { section: 'rules', text: 'Never say "free trial".', kind: 'dont', severity: 'hard', topic: 'voice', check: { type: 'forbid-text', value: 'free trial' } },
  { section: 'rules', text: 'Jede Seite nennt den Ort.', kind: 'do', severity: 'soft', topic: 'voice', check: { type: 'require-text', value: 'Aus Graz' }, lang: 'de' },
  { section: 'voiceExamples', good: 'Du schreibst uns. Wir melden uns am selben Tag.', lang: 'de' },
];

describe('brand languages through the tools', () => {
  let h: Harness;
  let agent: Client;
  let brandId: string;
  let file: string;
  let english: string;
  let german: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'writer');
    brandId = (await call(agent, 'brand_create', { name: 'Kanzlei' })).id;
    await call(agent, 'brand_update', { brand_id: brandId, confirmed: true, fields: { language: 'en', languages: ['de'], address: 'du' }, items: ITEMS });
    file = (await call(agent, 'file_create', { name: 'Site' })).id;
    await call(agent, 'brand_link', { brand_id: brandId, file_id: file });
    english = (await call(agent, 'artboard_create', { file_id: file, name: 'Home EN', width: 800 })).id;
    await call(agent, 'html_write', { file_id: file, target_id: english, html: '<p>Not billig, just cheap.</p><p>Start your free trial today.</p>' });
    german = (await call(agent, 'artboard_create', { file_id: file, name: 'Home DE', width: 800, x: 900 })).id;
    await call(agent, 'html_write', { file_id: file, target_id: german, html: '<p>Nicht billig, aber cheap ist es auch nicht.</p><p>Melden Sie sich für den free trial an.</p>' });
    await call(agent, 'layer_attrs', { file_id: file, node_id: english, attrs: { lang: 'en' } });
    await call(agent, 'layer_attrs', { file_id: file, node_id: german, attrs: { lang: 'de' } });
  });
  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('brand_update takes the primary and other languages and each item\'s language, and refuses what is not a tag', async () => {
    const got = await call(agent, 'brand_get', { brand_id: brandId, raw: true });
    expect(got.languages).toEqual({ primary: 'en', also: ['de'] });
    expect(got.raw.words.map((w: any) => [w.word, w.lang ?? null])).toEqual([['cheap', null], ['billig', 'de'], ['Follow-up', '*']]);
    const refused = await callRaw(agent, 'brand_update', { brand_id: brandId, confirmed: true, fields: { languages: ['de', 'Klingon please'] }, items: [{ section: 'words', word: 'never written' }] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toMatch(/not a language tag/);
    const after = await call(agent, 'brand_get', { brand_id: brandId, raw: true });
    expect(after.raw.fields.languages).toEqual(['de']);
    expect(after.raw.words.some((w: any) => w.word === 'never written')).toBe(false);
    // A brand of one language reads as one, and its old single field keeps working.
    const solo = (await call(agent, 'brand_create', { name: 'Solo' })).id;
    await call(agent, 'brand_update', { brand_id: solo, confirmed: true, fields: { language: 'de' } });
    expect((await call(agent, 'brand_get', { brand_id: solo })).languages).toEqual({ primary: 'de', also: [] });
  });

  it('brand_check judges each artboard\'s copy in its own language: its words to avoid and its text rules', async () => {
    const report = await call(agent, 'brand_check', { file_id: file, limit: 200 });
    const avoid = report.violations.filter((v: any) => v.rule === 'voice.avoid-word').map((v: any) => v.message);
    expect(avoid).toEqual(['The text says "cheap", which the brand avoids.', 'The text says "billig", which the brand avoids.']);
    const forbidden = report.violations.filter((v: any) => v.rule.startsWith('rule:') && v.message.includes('free trial'));
    // The English rule is not held against the German page.
    expect(forbidden).toHaveLength(1);
    const required = report.violations.filter((v: any) => v.rule === 'voice.required');
    expect(required.map((v: any) => v.message)).toEqual([expect.stringContaining('Nothing in the German (de) copy here says "Aus Graz"')]);
    // du/Sie is checked on the German page only, with the German example.
    const address = report.violations.filter((v: any) => v.rule === 'voice.address');
    expect(address).toHaveLength(1);
    expect(address[0].message).toContain('Du schreibst uns.');
  });

  it('voice_check says which language each text was judged in, and which the brand does not speak', async () => {
    const page = await call(agent, 'voice_check', { file_id: file });
    expect(page.languages).toMatchObject({ primary: 'en', also: ['de'], checked_in: { en: 2, de: 2 } });
    expect(page.findings.find((f: any) => f.rule === 'voice.address').language).toBe('de');
    const french = await call(agent, 'voice_check', { brand_id: brandId, text: 'Le prix du café est bas.', lang: 'fr' });
    expect(french.languages.not_spoken).toEqual(['fr']);
    expect(french.languages.note).toMatch(/does not speak fr/);
    expect((await callRaw(agent, 'voice_check', { brand_id: brandId, text: 'x', lang: 'not a tag' })).isError).toBe(true);
  });

  it('design_lint\'s copy check takes each layer\'s words to avoid', () => {
    const nodes = [
      { id: 'a', name: 'a', type: 'text', tag: 'p', text: 'Not billig, just cheap.' },
      { id: 'b', name: 'b', type: 'text', tag: 'p', text: 'Nicht billig, aber cheap.' },
    ] as never[];
    const byLayer = (n: { id: string }) => (n.id === 'a' ? [{ word: 'cheap' }] : [{ word: 'billig' }]);
    expect(copyIssues(nodes, byLayer).filter((c) => c.message.includes('the brand avoids')).map((c) => [c.nodeId, c.quote])).toEqual([['a', 'cheap'], ['b', 'billig']]);
  });

  it('the brief says which languages the brand speaks and which one to write in', async () => {
    const plain = await (await fetch(`${h.base}/api/brands/${brandId}/brief`)).json();
    expect(plain.brief).toContain('The brand speaks English (en) as its primary language, and also German (de).');
    expect(plain.brief).toContain("Write copy in English (en), the brand's primary language");
    await call(agent, 'context_get', { file_id: file });
    const run = await h.server.brands.prepareRun({ fileId: file, runner: 'claude', prompt: 'Neue Startseite', language: { tag: 'de' } } as RunRequest);
    expect(run.brand).toContain('Write copy in German (de), since the person chose it for this request. Use the brand\'s words, examples and text rules for German (de).');
    const opened = await call(agent, 'file_open', { file_id: file });
    expect(opened.content_language).toMatchObject({ tag: 'en', source: 'brand' });
    expect((await (await fetch(`${h.base}/api/files/${file}/brand`)).json()).languages).toEqual(['en', 'de']);
  });

  it('brand_book_get says the language of each chapter, and brand_book_update keeps a chapter\'s own', async () => {
    const outline = await call(agent, 'brand_book_get', { brand_id: brandId });
    expect(outline.chapters.find((c: any) => c.id === 'voice').lang).toBe('en');
    const saved = await call(agent, 'brand_book_update', { brand_id: brandId, chapter: 'voice', markdown: 'Wir duzen.', source: 'Owner brief', questions: '', status: 'draft', expected_revision: null, lang: 'de' });
    expect(saved.chapter.lang).toBe('de');
    expect((await call(agent, 'brand_book_get', { brand_id: brandId, chapter: 'voice' })).chapter.lang).toBe('de');
    expect((await callRaw(agent, 'brand_book_update', { brand_id: brandId, chapter: 'voice', markdown: 'x', source: 'x', questions: '', status: 'draft', expected_revision: saved.chapter.revision, lang: 'Deutsch' })).isError).toBe(true);
  });
});
