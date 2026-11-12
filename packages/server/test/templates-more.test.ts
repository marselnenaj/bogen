import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { colorsIn, listMains, readBrand } from '@bogen/core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

/**
 * The deck, store screenshots, email, docs page and pricing page, each laid out from three brands: Tomacco (a real,
 * full brand), a German brand that states its voice in its own words, and a brand of three colours. Every board keeps to
 * the brand's colours, passes the copy and voice check and the contrast check, and returns its slots.
 */

const FIXTURE = join(import.meta.dirname, 'fixtures/brand-score/tomacco-brand.bogen.gz');

const GERMAN_ITEMS = [
  { section: 'colors', name: 'Tinte', role: 'text', value: '#1b1a17', token: 'tinte' },
  { section: 'colors', name: 'Papier', role: 'background', value: '#f3efe6', token: 'papier' },
  { section: 'colors', name: 'Moos', role: 'primary', value: '#2f5d3a', token: 'moos' },
  { section: 'colors', name: 'Stein', role: 'muted', value: '#5a5750', token: 'stein' },
  { section: 'colors', name: 'Linie', role: 'border', value: '#cfc8b8', token: 'linie' },
  { section: 'families', family: 'Inter', role: 'body', fallback: 'sans-serif', weights: [400, 700], token: 'font-body' },
  { section: 'families', family: 'Fraunces', role: 'display', fallback: 'serif', weights: [600], token: 'font-display' },
  { section: 'typeScale', name: 'Klein', size: 14, weight: 400, token: 'text-klein' },
  { section: 'typeScale', name: 'Text', size: 18, weight: 400, token: 'text-text' },
  { section: 'typeScale', name: 'Einstieg', role: 'lead', size: 24, weight: 400, token: 'text-einstieg' },
  { section: 'typeScale', name: 'Zwischen', size: 32, weight: 600, token: 'text-zwischen' },
  { section: 'typeScale', name: 'Titel', size: 56, weight: 600, token: 'text-titel' },
  { section: 'typeScale', name: 'Bühne', size: 96, weight: 600, token: 'text-buehne' },
  { section: 'spacing', name: 's', value: 8, token: 'space-s' },
  { section: 'spacing', name: 'm', value: 16, token: 'space-m' },
  { section: 'spacing', name: 'l', value: 32, token: 'space-l' },
  { section: 'spacing', name: 'xl', value: 64, token: 'space-xl' },
  { section: 'radius', name: 'sanft', value: 6, token: 'radius-sanft' },
  { section: 'rules', text: 'Website und Newsletter sprechen Du. Du und Sie werden nie gemischt.', kind: 'do', severity: 'hard', topic: 'voice' },
  { section: 'rules', text: 'Kurze Sätze. Absätze höchstens zwei Sätze, Überschriften mit 3 bis 7 Wörtern.', kind: 'do', severity: 'soft', topic: 'voice' },
  { section: 'voiceExamples', good: 'Verträge, die du verstehst.', note: 'Eine Überschrift, eine Aussage.' },
  { section: 'voiceExamples', good: 'Du schreibst uns. Wir melden uns am selben Tag.', bad: 'Sie erhalten zeitnah eine Rückmeldung.' },
];
const SPARSE_ITEMS = [
  { section: 'colors', name: 'Night', role: 'background', value: '#101418', token: 'night' },
  { section: 'colors', name: 'Snow', role: 'text', value: '#f5f7fa', token: 'snow' },
  { section: 'colors', name: 'Lime', role: 'primary', value: '#b6f23a', token: 'lime' },
];

const TEMPLATES = ['pitch-deck', 'app-store-screenshots', 'email', 'docs-page', 'pricing-page'] as const;
const SIZES: Record<(typeof TEMPLATES)[number], [number, number | 'hug'][]> = {
  'pitch-deck': Array.from({ length: 10 }, () => [1920, 1080] as [number, number]),
  'app-store-screenshots': [[1320, 2868], [1320, 2868], [1320, 2868], [1080, 1920], [1080, 1920], [1080, 1920]],
  email: [[600, 'hug']],
  'docs-page': [[1440, 'hug'], [390, 'hug']],
  'pricing-page': [[1440, 'hug'], [390, 'hug']],
};

describe('more templates, from three brands', () => {
  let h: Harness;
  let client: Client;
  const brands: Record<string, string> = {};

  beforeAll(async () => {
    h = await startServer();
    const res = await fetch(`${h.base}/api/files/import`, { method: 'POST', headers: { 'X-Bogen-Filename': 'Tomacco Brand System' }, body: gunzipSync(readFileSync(FIXTURE)) });
    brands.tomacco = ((await res.json()) as { id: string }).id;
    client = await connectAgent(h.base, 'claude');
    brands.german = (await call(client, 'brand_create', { name: 'Kanzlei' })).id;
    await call(client, 'brand_update', { brand_id: brands.german, confirmed: true, fields: { positioning: 'Verträge für kleine Firmen, geprüft in zwei Tagen.' }, items: GERMAN_ITEMS });
    brands.sparse = (await call(client, 'brand_create', { name: 'Sparse' })).id;
    await call(client, 'brand_update', { brand_id: brands.sparse, confirmed: true, items: SPARSE_ITEMS });
  }, 60_000);
  afterAll(async () => {
    await client.close();
    await h.cleanup();
  });

  for (const template of TEMPLATES) {
    for (const which of ['tomacco', 'german', 'sparse'] as const) {
      it(`${template} from the ${which} brand keeps to the brand, passes copy, voice and contrast, and returns its slots`, async () => {
        const out = await call(client, 'template_use', { template, brand_id: brands[which] });
        expect(out.boards.map((b: { width: number; height: number | 'hug' }) => [b.width, b.height])).toEqual(SIZES[template]);
        const { doc } = await h.server.rooms.get(out.file_id);
        const brand = readBrand((await h.server.brands.read(brands[which]!)).room.doc);
        const palette = new Set(brand.colors.flatMap((c) => [c.value, ...Object.values(c.modes ?? {})]));

        // Literal colours only from the palette.
        const off: string[] = [];
        for (const b of out.boards) for (const n of [doc.getNode(b.id)!, ...doc.descendants(b.id)].filter((x) => !x.virtual)) {
          for (const [prop, value] of Object.entries(n.style)) {
            if (!/color|background|border/i.test(prop) || value.includes('var(')) continue;
            for (const c of colorsIn(value)) if (!palette.has(c.slice(0, 7))) off.push(`${n.name} ${prop} ${value}`);
          }
        }
        expect(off).toEqual([]);

        // Copy, voice and contrast, as design_lint measures them in the render.
        for (const b of out.boards) {
          const lint = await call(client, 'design_lint', { file_id: out.file_id, node_id: b.id });
          const bad = lint.issues.filter((i: { rule: string }) => i.rule === 'copy' || i.rule === 'contrast');
          expect(bad.map((i: { message: string }) => `${b.name}: ${i.message}`)).toEqual([]);
        }

        // Accessible as made: no audit errors, and nothing at all on docs and pricing, which are whole pages.
        for (const b of out.boards) {
          const audit = await call(client, 'a11y_audit', { file_id: out.file_id, node_id: b.id });
          const all = audit.layers.flatMap((l: { layer: string; issues: { severity: string; rule: string; message: string }[] }) => l.issues.map((i) => ({ ...i, layer: l.layer })));
          const worth = template === 'docs-page' || template === 'pricing-page' ? all : all.filter((i: { severity: string }) => i.severity === 'error');
          expect(worth.map((i: { layer: string; rule: string; message: string }) => `${b.name} / ${i.layer}: ${i.rule} ${i.message}`)).toEqual([]);
        }

        // Slots point at real layers, with what goes there.
        expect(out.slots.length).toBeGreaterThan(2);
        for (const s of out.slots) {
          expect(doc.getNode(s.id)?.name).toBe(s.name);
          expect(s.hint.length).toBeGreaterThan(10);
        }

        if (which === 'tomacco') {
          const check = await call(client, 'brand_check', { file_id: out.file_id, limit: 50 });
          expect(check.violations.filter((v: { severity: string }) => v.severity === 'hard').map((v: { layer: string; message: string }) => `${v.layer}: ${v.message}`)).toEqual([]);
        }

        const mains = listMains(doc.source).map((m) => m.name);
        if (template === 'pricing-page') {
          expect(mains).toEqual(expect.arrayContaining(['Plan / standard', 'Plan / featured']));
          // Each board holds three plans, all of the Plan set: the mains on the first, instances everywhere else.
          for (const b of out.boards) {
            const row = doc.descendants(b.id).find((n) => n.name === 'Plans')!;
            const plans = doc.getChildren(row.id);
            expect(plans).toHaveLength(3);
            expect(plans.filter((n) => n.instanceOf !== undefined).length).toBeGreaterThanOrEqual(b === out.boards[0] ? 1 : 3);
          }
        }
        if (template === 'pitch-deck') expect(mains).toEqual(expect.arrayContaining(['Deck step', 'Deck person']));
        if (template === 'app-store-screenshots') expect(mains).toEqual(expect.arrayContaining(['Phone / iPhone 6.9 inch', 'Phone / Android phone']));
        if (template === 'email') {
          const nodes = doc.descendants(out.boards[0].id);
          const table = nodes.find((n) => n.tag === 'table' && n.name === 'Email')!;
          expect(table.attrs?.role).toBe('presentation');
          const inside = doc.descendants(table.id);
          expect(inside.some((n) => n.tag === 'tr')).toBe(true);
          expect(inside.some((n) => n.tag === 'td')).toBe(true);
          expect(inside.filter((n) => /flex|grid/.test(n.style.display ?? '')).map((n) => n.name)).toEqual([]);
          expect(inside.filter((n) => Object.values(n.style).some((v) => v.includes('var('))).map((n) => n.name)).toEqual([]);
        }
        if (template === 'docs-page' || template === 'pricing-page') {
          for (const b of out.boards) {
            const tags = doc.descendants(b.id).map((n) => n.tag);
            expect(doc.getNode(b.id)!.tag).toBe('div');
            expect(tags.filter((t) => t === 'main')).toHaveLength(1);
            expect(tags).toEqual(expect.arrayContaining(['header', 'nav', 'footer']));
            expect(tags.filter((t) => t === 'h1')).toHaveLength(1);
          }
        }
      }, 120_000);
    }
  }

  it('makes only the parts asked for, and a second deck reuses its components', async () => {
    const file = (await call(client, 'file_create', { name: 'Deck' })).id;
    await call(client, 'brand_link', { brand_id: brands.german, file_id: file });
    const first = await call(client, 'template_use', { template: 'pitch-deck', file_id: file, options: { only: ['title', 'how', 'ask'] } });
    expect(first.boards.map((b: { name: string }) => b.name)).toEqual(['01 Title', '04 How it works', '10 The ask']);
    const second = await call(client, 'template_use', { template: 'pitch-deck', file_id: file, options: { only: ['how'] } });
    expect(second.components).toEqual([]);
    const { doc } = await h.server.rooms.get(file);
    expect(listMains(doc.source).filter((m) => m.name === 'Deck step')).toHaveLength(1);
    const shots = await call(client, 'template_use', { template: 'app-store-screenshots', brand_id: brands.german, options: { only: ['android'] } });
    expect(shots.boards.map((b: { width: number; height: number }) => [b.width, b.height])).toEqual([[1080, 1920], [1080, 1920], [1080, 1920]]);
  }, 120_000);
});
