import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { colorsIn, listMains, readBrand, type BogenDoc } from '@bogen/core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

const FIXTURE = join(import.meta.dirname, 'fixtures/brand-score/tomacco-brand.bogen.gz');

async function setup(): Promise<{ h: Harness; client: Client; brand: string }> {
  const h = await startServer();
  harnesses.push(h);
  const res = await fetch(`${h.base}/api/files/import`, { method: 'POST', headers: { 'X-Bogen-Filename': 'Tomacco Brand System' }, body: gunzipSync(readFileSync(FIXTURE)) });
  const { id: brand } = (await res.json()) as { id: string };
  return { h, client: await connectAgent(h.base, 'claude'), brand };
}

/** Every layer under the boards a template made, as stored. */
async function layers(h: Harness, fileId: string, boards: { id: string }[]) {
  const { doc } = await h.server.rooms.get(fileId);
  return { doc, nodes: boards.flatMap((b) => [doc.getNode(b.id)!, ...doc.descendants(b.id)]).filter((n) => !n.virtual) };
}

/** Values a template wrote literally rather than through a token: only the brand's own may appear. */
function literals(doc: BogenDoc, nodes: ReturnType<BogenDoc['descendants']>, palette: string[]) {
  const colours: string[] = [];
  const offPalette: string[] = [];
  for (const n of nodes) {
    for (const [prop, value] of Object.entries(n.style)) {
      if (!/color|background|border/i.test(prop) || value.includes('var(')) continue;
      for (const c of colorsIn(value)) {
        colours.push(c);
        if (!palette.includes(c.slice(0, 7))) offPalette.push(`${n.name} ${prop} ${value}`);
      }
    }
  }
  void doc;
  return { colours, offPalette };
}

describe('templates', () => {
  it('lists what each template makes', async () => {
    const { client } = await setup();
    const out = await call(client, 'template_list');
    expect(out.templates.map((t: { id: string }) => t.id)).toEqual(['brand-system', 'landing-page', 'social-images', 'pitch-deck', 'app-store-screenshots', 'email', 'docs-page', 'pricing-page', 'app-flow', 'desktop-workspace', 'analytics-dashboard', 'checkout-flow', 'social-carousel', 'social-story', 'case-study-page', 'one-page-pitch', 'example-landing', 'example-app', 'example-deck', 'example-social']);
    expect(out.templates[0].parts.map((p: { key: string }) => p.key)).toEqual(['cover', 'logo', 'colour', 'type', 'layout', 'components', 'voice']);
  });

  it('lays out a brand system from the brand: real layers, the brand\'s tokens and components, and nothing invented', async () => {
    const { h, client, brand } = await setup();
    const out = await call(client, 'template_use', { template: 'brand-system', brand_id: brand });
    expect(out.linked).toBe(true);
    expect(out.file_name).toBe('Tomacco brand system');
    expect(out.boards.map((b: { name: string }) => b.name)).toEqual(['1 Cover', '2 Logo', '3 Colour', '4 Type', '5 Layout and spacing', '6 Components', '7 Voice']);
    const { doc, nodes } = await layers(h, out.file_id, out.boards);
    expect(doc.getPages().map((p) => p.name)).toEqual(['Brand system']);

    // Side by side, 1440 wide, hugging their content.
    const lefts = out.boards.map((b: { id: string }) => Number.parseFloat(doc.getNode(b.id)!.style.left!));
    expect([...lefts].sort((a, b) => a - b)).toEqual(lefts);
    for (const b of out.boards) expect(doc.getNode(b.id)!.style).toMatchObject({ width: '1440px', height: 'fit-content' });
    expect(nodes.length).toBeGreaterThan(300);
    expect(nodes.some((n) => n.style.display === 'grid') && nodes.some((n) => n.style.display === 'flex')).toBe(true);

    // The brand's tokens, not copies of its values.
    const styles = nodes.flatMap((n) => Object.values(n.style)).join(' ');
    for (const token of ['--ink', '--paper', '--red', '--green', '--font-sans', '--font-mono', '--text-display', '--text-body', '--space-88', '--radius-0']) expect(styles.includes(`var(${token})`), token).toBe(true);
    const data = readBrand((await h.server.brands.read(brand)).room.doc);
    const { offPalette } = literals(doc, nodes, data.colors.map((c) => c.value));
    expect(offPalette).toEqual([]);
    // Every text size is a step of the scale.
    const sizes = new Set(data.typeScale.map((t) => `var(--${t.token})`));
    expect(nodes.filter((n) => n.type === 'text' && n.style.fontSize && !sizes.has(n.style.fontSize))).toEqual([]);

    // Logos are the brand's own files.
    const logoSrcs = new Set(data.logos.map((l) => l.asset));
    const images = nodes.filter((n) => n.type === 'image');
    expect(images.length).toBeGreaterThan(8);
    expect(images.every((n) => logoSrcs.has(n.src!))).toBe(true);

    // What repeats is a component, used through instances.
    const mains = listMains(doc.source);
    expect(mains.filter((m) => m.component?.set === 'Button').map((m) => m.component?.variant)).toHaveLength(6);
    for (const name of ['Swatch', 'Field', 'Card']) expect(mains.some((m) => m.name === name)).toBe(true);
    expect(out.components).toContain('Button / primary / large');
    const instances = [...doc.nodes.keys()].filter((id) => doc.rawNode(id)?.instanceOf);
    expect(instances.length).toBeGreaterThan(10);

    // The brand's words, not made-up ones.
    const texts = nodes.filter((n) => n.type === 'text').map((n) => n.text ?? '');
    expect(texts).toContain('Tomacco');
    expect(texts).toContain(data.fields.positioning);
    expect(texts).toContain('Same idea. Less soil.');
    expect(texts.some((t) => t.startsWith('17.26:1'))).toBe(true);
    expect(texts.some((t) => /^1\.28:1/.test(t))).toBe(true);
    // Tomacco lists no words and no bad lines: each gap says so, once, on the board and in the result.
    expect(out.gaps).toEqual([
      'No bad lines yet: a good line says more next to a bad one. Add them with brand_update (voiceExamples, bad).',
      'No word list yet: add words to use and to avoid with brand_update (words).',
    ]);
    for (const gap of out.gaps) expect(texts).toContain(gap);
    // Nothing set in capitals by style.
    expect(nodes.some((n) => n.style.textTransform === 'uppercase')).toBe(false);
    expect(styles).not.toMatch(/gradient|box-shadow|boxShadow/);

    // It checks well against its own brand. The wrong examples are left out, and the report says so.
    const check = await call(client, 'brand_check', { file_id: out.file_id, limit: 50 });
    expect(check.counts.hard).toBe(0);
    expect(check.score).toBeGreaterThanOrEqual(95);
    expect(check.not_checked.some((n: string) => /counter-examples/.test(n))).toBe(true);

    // One undo step takes it all back.
    await call(client, 'agent_undo', { file_id: out.file_id });
    expect(doc.getChildren(out.page_id)).toHaveLength(0);
  }, 60_000);

  it('leaves gaps as quiet notes and invents nothing for a brand with little in it', async () => {
    const { h, client } = await setup();
    const brand = (await call(client, 'brand_create', { name: 'Sparse' })).id;
    await call(client, 'brand_update', { brand_id: brand, confirmed: true, items: [
      { section: 'colors', name: 'Night', role: 'background', value: '#101418', token: 'night' },
      { section: 'colors', name: 'Snow', role: 'text', value: '#f5f7fa', token: 'snow' },
      { section: 'colors', name: 'Lime', role: 'primary', value: '#b6f23a', token: 'lime' },
    ] });
    const out = await call(client, 'template_use', { template: 'brand-system', brand_id: brand });
    expect(out.gaps).toEqual(expect.arrayContaining([
      'No logo yet: add one with brand_asset_add (kind logo, with its background, minimum width and clear space).',
      'No fonts yet: add the families with brand_update (families, with role and weights) and their files with brand_asset_add.',
      'No type scale yet: add steps with brand_update (typeScale, each with size, weight and line height).',
      'No spacing scale yet: add the steps with brand_update (spacing, each a value in px).',
      'No positioning yet: add one line with brand_update (fields.positioning).',
      'No voice examples yet: add pairs of good and bad lines with brand_update (voiceExamples).',
    ]));
    const { doc, nodes } = await layers(h, out.file_id, out.boards);
    const texts = nodes.filter((n) => n.type === 'text').map((n) => n.text ?? '');
    for (const gap of out.gaps) expect(texts).toContain(gap);
    expect(nodes.filter((n) => n.type === 'image' || n.type === 'svg')).toHaveLength(0);
    expect(literals(doc, nodes, ['#101418', '#f5f7fa', '#b6f23a']).offPalette).toEqual([]);
    // No pairs are listed and the brand allows what it does not forbid, so the right pairs are worked out from its values.
    expect(texts.some((t) => /^\d+(\.\d+)?:1$/.test(t))).toBe(true);
    const check = await call(client, 'brand_check', { file_id: out.file_id });
    expect(check.counts.hard).toBe(0);
  }, 60_000);

  it('makes a landing page at 1440 and 390, and social images, in the brand', async () => {
    const { h, client, brand } = await setup();
    const landing = await call(client, 'template_use', { template: 'landing-page', brand_id: brand });
    expect(landing.boards.map((b: { name: string; width: number }) => [b.name, b.width])).toEqual([['Landing, 1440', 1440], ['Landing, 390', 390]]);
    const { doc, nodes } = await layers(h, landing.file_id, landing.boards);
    const mains = listMains(doc.source).map((m) => m.name);
    expect(mains).toEqual(expect.arrayContaining(['Button / primary / large', 'Button / quiet / large', 'Feature', 'Step', 'Question']));
    // The narrow page reuses what the wide one made.
    const narrow = [...doc.nodes.keys()].filter((id) => doc.rawNode(id)?.instanceOf && doc.ancestors(id).includes(landing.boards[1].id));
    expect(narrow.length).toBeGreaterThanOrEqual(10);
    for (const name of ['Header', 'Hero', 'Proof', 'Features', 'How it works', 'Get it', 'FAQ', 'Footer']) expect(nodes.some((n) => n.name === name)).toBe(true);
    expect(nodes.find((n) => n.name === 'Headline')?.text).toBe('Same idea. Less soil.');
    const check = await call(client, 'brand_check', { file_id: landing.file_id });
    expect(check.counts.hard).toBe(0);
    expect(check.score).toBeGreaterThanOrEqual(95);

    // Into the same file, on a page of its own: the file already links to this brand.
    const social = await call(client, 'template_use', { template: 'social-images', file_id: landing.file_id });
    expect(social.file_id).toBe(landing.file_id);
    expect(social.linked).toBe(false);
    expect(social.boards.map((b: { width: number; height: number }) => [b.width, b.height])).toEqual([[1200, 630], [1080, 1080]]);
    expect(doc.getPages().map((p) => p.name)).toEqual(['Landing page', 'Social images']);
    const socialCheck = await call(client, 'brand_check', { file_id: landing.file_id, page_id: social.page_id, whole_file: false });
    expect(socialCheck.counts.hard).toBe(0);
  }, 60_000);

  it('lets no agent mark its own layers as counter-examples', async () => {
    const { client, brand } = await setup();
    const file = await call(client, 'file_create', { name: 'Page' });
    await call(client, 'brand_link', { brand_id: brand, file_id: file.id });
    const board = await call(client, 'artboard_create', { name: 'A', width: 800 });
    const written = await call(client, 'html_write', { target_id: board.id, html: '<div data-brand-example="dont"><p style="color:#00ff00">Off palette</p></div>' });
    const report = await call(client, 'brand_check', { limit: 200 });
    expect(report.violations.some((v: any) => v.rule === 'color.off-palette')).toBe(true);
    expect(report.not_checked.join(' ')).not.toContain('counter-examples');
    const refused = await callRaw(client, 'layer_attrs', { node_id: written.ids[0], attrs: { 'data-brand-example': 'dont' } });
    expect(refused.isError).toBe(true);
    await client.close();
  });

  it('keeps to strict mode, refuses another brand\'s file, and makes only the parts asked for', async () => {
    const { h, client, brand } = await setup();
    await call(client, 'brand_update', { brand_id: brand, fields: { strict: true }, confirmed: true });
    const file = await call(client, 'file_create', { name: 'Work' });
    await call(client, 'brand_link', { brand_id: brand, file_id: file.id });
    const out = await call(client, 'template_use', { template: 'brand-system', file_id: file.id, options: { only: ['colour', 'type'] } });
    expect(out.boards.map((b: { name: string }) => b.name)).toEqual(['3 Colour', '4 Type']);

    const other = (await call(client, 'brand_create', { name: 'Other' })).id;
    const refused = await callRaw(client, 'template_use', { template: 'social-images', brand_id: other, file_id: file.id });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toMatch(/links to another brand/);

    // The editor's way in: a new file from the brand.
    const res = await fetch(`${h.base}/api/brands/${brand}/template`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template: 'social-images' }) });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { file_id: string; boards: unknown[] };
    expect(made.boards).toHaveLength(2);
    expect(h.server.storage.get(made.file_id)?.brandId).toBe(brand);
    const list = (await (await fetch(`${h.base}/api/brands/templates`)).json()) as { id: string }[];
    expect(list.map((t) => t.id)).toContain('landing-page');
  }, 60_000);
});
