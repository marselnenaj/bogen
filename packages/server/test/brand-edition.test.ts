import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addCritique, BogenDoc, getFontFaces, brandEditionParts, brandLinkOf, emptyBrand, readBrandEdition, readProject, upsertBrandItem, writeBrandEdition, Y } from '@bogen/core';
import { editionBrief, editionLoop, editionReviewPurpose } from '../src/brand-edition.ts';
import { disciplineSkill, readKnowledge } from '../src/design-knowledge/index.ts';
import { call, connectAgent, startServer, until, withoutDesignReview, type Harness } from './helpers.ts';

const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('the brand guidelines discipline', () => {
  it('is a skill of its own with the book arc and applications by kind of business as recipes', () => {
    const skill = disciplineSkill('brand-guidelines');
    expect(skill).toContain('One idea per page');
    expect(skill).toContain('Honest gaps');
    expect(skill.length).toBeLessThan(10700);
    const recipes = readKnowledge({ action: 'recipes', discipline: 'brand-guidelines', limit: 30 }) as { items: { id: string; sequence: string[] }[] };
    expect(recipes.items.map((r) => r.id)).toEqual(expect.arrayContaining(['studio-book-arc', 'applications-services', 'applications-software', 'sparse-brand-book']));
    expect(recipes.items.find((r) => r.id === 'studio-book-arc')!.sequence[0]).toMatch(/^Cover/);
  });

  it('briefs the maker on the reference, the honest gaps and the review loop', () => {
    const brief = editionBrief({ brandId: 'b1', brandName: 'Kiln', fileId: 'f1', pageId: 'p1', referencePageId: 'p2', reference: [{ id: 'n1', name: '01 Cover' }], language: 'de', examples: 2, assets: 0 });
    for (const part of ['brand_id b1', 'page_id p1', '"01 Cover" n1', 'until 7.5 and max_rounds 1', 'design_verify', 'German (de)', 'never invent']) expect(brief).toContain(part);
  });
});

describe('the review loop of an edition run', () => {
  it('is the whole book, and continues the run\'s own series so that the rounds count up to the cap', () => {
    const doc = new BogenDoc(new Y.Doc());
    doc.ensureFirstPage('Brand book');
    const pageId = doc.getPages()[0]!.id;
    expect(editionLoop(doc, 0)).toBeNull();
    writeBrandEdition(doc, { brandId: 'kiln00001', brandName: 'Kiln', at: 1, parts: brandEditionParts(emptyBrand()), pageId });
    expect(editionLoop(doc, 0)).toEqual({ pageId, until: 7.5, maxRounds: 1 });
    writeBrandEdition(doc, { brandId: 'kiln00001', brandName: 'Kiln', at: 1, parts: brandEditionParts(emptyBrand()), pageId, rounds: 4 });
    expect(editionLoop(doc, 0)?.maxRounds).toBe(4);
    const round = (id: string, at: number, series: string) => addCritique(doc, { id, at, screens: [], pageId, series, round: 1, maxRounds: 4, until: 7.5, reviewer: 'Fable', score: 6, dimensions: {}, verdict: '', defects: [], taste: [], keep: [], ruleFindings: 0, durationMs: 1 });
    round('old', 100, 'aaaaaaaaaaaa');
    round('new', 300, 'bbbbbbbbbbbb');
    expect(editionLoop(doc, 200)?.series).toBe('bbbbbbbbbbbb');
    // A run that started after both has its own loop still to begin.
    expect(editionLoop(doc, 400)?.series).toBeUndefined();
  });
});

describe('a designed edition of a brand book', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-edition-cli-'));
  const log = join(bin, 'runs.jsonl');
  const savedPath = process.env.PATH;
  let h: Harness;
  let brandId: string;
  const runs = (): { stdin: string; system: string }[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];

  beforeAll(async () => {
    // A stand-in agent: it says what it was asked and stops.
    for (const name of ['claude', 'codex']) {
      writeFileSync(join(bin, name), `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('1.0.0 (Fake)'); process.exit(0); }
if (process.argv[2] === '--help' || process.argv[2] === 'debug') process.exit(0);
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
const system = process.argv[process.argv.indexOf('--append-system-prompt') + 1] || '';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ stdin, system }) + '\\n');
`);
      chmodSync(join(bin, name), 0o755);
    }
    process.env.PATH = `${bin}:${savedPath}`;
    h = await startServer();
    withoutDesignReview(h.server);
    brandId = ((await (await fetch(`${h.base}/api/brands`, post({ name: 'Kiln' }))).json()) as { id: string }).id;
    const brand = await h.server.rooms.get(brandId);
    upsertBrandItem(brand.doc, 'colors', { id: 'clay', name: 'Clay', value: '#b5562f', role: 'accent' });
    upsertBrandItem(brand.doc, 'colors', { id: 'ink', name: 'Ink', value: '#1d1b19', role: 'text' });
  });

  afterAll(async () => {
    process.env.PATH = savedPath;
    await h.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  it('makes a linked file with the generated book as a locked reference, and starts the run on the brand-guidelines skill', async () => {
    expect((await (await fetch(`${h.base}/api/brands/${brandId}/designed-edition`)).json())).toEqual({ edition: null });
    const res = await fetch(`${h.base}/api/brands/${brandId}/designed-edition`, post({ runner: 'claude', by: 'Mara' }));
    expect(res.status).toBe(201);
    const out = await res.json() as { file_id: string; file_name: string; page_id: string; reference_page_id: string; run_id: string; conversation_id: string };
    expect(out.file_name).toBe('Kiln · Brand book');
    expect(out.conversation_id).toMatch(/^c[\w]+$/);
    const { doc } = await h.server.rooms.get(out.file_id);
    expect(doc.getPages().map((p) => p.name)).toEqual(['Brand book', 'Generated book (reference)']);
    expect(doc.getChildren(out.page_id)).toEqual([]);
    const reference = doc.getChildren(out.reference_page_id);
    expect(reference.length).toBeGreaterThan(3);
    expect(reference.every((n) => n.artboard && n.locked)).toBe(true);
    expect(brandLinkOf(doc)?.id).toBe(brandId);
    expect(readProject(doc).type).toBe('brand');
    expect(readBrandEdition(doc)).toMatchObject({ brandId, brandName: 'Kiln', pageId: out.page_id, runId: out.run_id });
    await until(() => runs().length > 0, 8000);
    const run = runs()[0]!;
    expect(run.stdin).toContain(`brand_id ${brandId}`);
    expect(run.stdin).toContain('until 7.5 and max_rounds 1');
    expect(run.system).toContain('Design guidance already supplied for brand-guidelines');
    await until(() => !h.server.runs.activeFor(out.file_id), 8000);
    // The review of this file is told what it is, ahead of anything the agent says, and compares no flow.
    expect(editionReviewPurpose(doc, 'Twelve pages.')).toMatch(/^A studio brand guidelines book for "Kiln".*Pentagram, Koto or Collins.*Twelve pages\.$/s);
    expect(editionReviewPurpose((await h.server.rooms.get(brandId)).doc)).toBeNull();
  });

  it('says what changed in the brand since, and a refresh that finishes brings it up to date', async () => {
    const status = async () => ((await (await fetch(`${h.base}/api/brands/${brandId}/designed-edition`)).json()) as { edition: { file_id: string; changed: string[]; running: boolean } }).edition;
    expect((await status()).changed).toEqual([]);
    const brand = await h.server.rooms.get(brandId);
    upsertBrandItem(brand.doc, 'colors', { id: 'clay', name: 'Clay', value: '#a14b28', role: 'accent' });
    upsertBrandItem(brand.doc, 'words', { word: 'artisanal', use: 'avoid', severity: 'soft' });
    expect((await status()).changed).toEqual(['colour', 'voice']);
    const before = runs().length;
    const res = await fetch(`${h.base}/api/brands/${brandId}/designed-edition/refresh`, post({ runner: 'claude' }));
    expect(res.status).toBe(201);
    const out = await res.json() as { file_id: string; changed: string[] };
    expect(out.changed).toEqual(['colour', 'voice']);
    await until(() => runs().length > before, 8000);
    expect(runs().at(-1)!.stdin).toContain('changed since this designed edition of its guidelines was made, in: Colour, Voice.');
    await until(() => !h.server.runs.activeFor(out.file_id), 8000);
    await until(async () => (await status()).changed.length === 0, 4000);
    const again = await fetch(`${h.base}/api/brands/${brandId}/designed-edition/refresh`, post({ runner: 'claude' }));
    expect(again.status).toBe(400);
  });

  it('links one font file that serves two roles of a family with both roles\' weights', async () => {
    const brand = await h.server.rooms.get(brandId);
    const src = `bogen-asset:${'ab'.repeat(32)}.woff2`;
    upsertBrandItem(brand.doc, 'families', { family: 'Archivo', role: 'display', weights: [800, 900], assets: [src] });
    upsertBrandItem(brand.doc, 'families', { family: 'Archivo', role: 'body', weights: [400, 700], assets: [src] });
    const file = h.server.createFile('Linked');
    await h.server.brands.link(file.id, brandId, 'test');
    const faces = getFontFaces((await h.server.rooms.get(file.id)).doc).filter((f) => f.src === src);
    expect(faces).toEqual([{ family: 'Archivo', src, weight: '400 900', display: 'swap' }]);
  });

  it('gives an agent the status, or a file and the brief to work on itself', async () => {
    const agent = await connectAgent(h.base, 'book-agent');
    const status = await call(agent, 'brand_book_design', { action: 'status', brand_id: brandId });
    expect(status.edition.file_name).toBe('Kiln · Brand book');
    const made = await call(agent, 'brand_book_design', { brand_id: brandId, start_run: false });
    expect(made.run_id).toBeUndefined();
    expect(made.brief).toContain('design_critique');
    expect(made.next).toContain('brand-guidelines');
    // The newest edition is the one the brand points at.
    expect((await call(agent, 'brand_book_design', { action: 'status', brand_id: brandId })).edition.file_id).toBe(made.file_id);
  });
});
