import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brandLinkOf, type BogenDoc } from '@bogen/core';
import { restyleSite, type RestyleResult } from '../src/restyle.ts';
import { writeBrandSpec, type BrandSpec } from '../src/templates/brand-spec.ts';
import { callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

/** Someone else's site: white, near-black text, a blue accent, Arial and Georgia, spacing off any scale. */
const SITE = `<!doctype html><html><head><title>Northwind Bikes</title><style>
body { margin: 0; background: #ffffff; color: #222222; font-family: Arial, sans-serif; font-size: 15px }
header { display: flex; justify-content: space-between; align-items: center; padding: 13px 22px; border-bottom: 1px solid #dddddd }
.logo { width: 120px; height: 28px }
h1 { font-family: Georgia, serif; font-size: 60px; margin: 0 }
.hero { display: flex; flex-direction: column; gap: 18px; padding: 70px 22px }
.sub { color: #777777; font-size: 19px; margin: 0 }
.cta { align-self: flex-start; background: #0055ff; color: #ffffff; padding: 11px 21px; border-radius: 6px; border: 0; font-size: 15px; font-weight: 700 }
.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; padding: 0 22px 50px }
.card { border: 1px solid #dddddd; border-radius: 9px; padding: 19px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12) }
.card img { width: 100%; height: 120px; display: block }
.card h2 { font-family: Georgia, serif; font-size: 30px; margin: 10px 0 }
.band { background: #111111; padding: 32px 22px }
.band p { color: #3388ff; margin: 0 }
</style></head><body>
<header><svg class="logo" viewBox="0 0 120 28"><rect width="120" height="28" fill="#0055ff"/></svg><nav><a href="/shop">Shop</a></nav></header>
<section class="hero"><h1>Bikes that outlast you</h1><p class="sub">Hand built in Leeds since 1987, serviced for life.</p><button class="cta">Find your frame</button></section>
<section class="cards"><article class="card"><img src="/frame.png" alt="The Fell frame"><h2>Fell</h2><p>Steel touring frame with rack mounts.</p></article><article class="card"><img src="/frame.png" alt="The Dale frame"><h2>Dale</h2><p>Light commuter with hub gears.</p></article></section>
<section class="band"><p class="night">Open late on Thursdays.</p></section>
</body></html>`;

const SOURCE_WORDS = ['Open late on Thursdays', 'Bikes that outlast you', 'Hand built in Leeds', 'Find your frame', 'Steel touring frame', 'Light commuter', 'Fell', 'Dale', 'Shop', 'Northwind'];

const BRAND: BrandSpec = {
  name: 'Kiln',
  positioning: 'Pottery classes in Bristol.',
  colors: [
    { name: 'Ink', role: 'text', value: '#141414', token: 'ink' },
    { name: 'Paper', role: 'background', value: '#faf7f0', token: 'paper' },
    { name: 'Stone', role: 'text-secondary', value: '#6d685c', token: 'stone' },
    { name: 'Rule', role: 'border', value: '#d9d4c7', token: 'rule' },
    { name: 'Glaze', role: 'primary', value: '#c2361f', token: 'glaze' },
  ],
  families: [
    { family: 'Archivo', role: 'display', fallback: 'Arial, sans-serif', weights: [400, 700], token: 'font-display' },
    { family: 'Inter', role: 'body', fallback: 'Arial, sans-serif', weights: [400, 600], token: 'font-body' },
  ],
  typeScale: [
    { name: 'Body', role: 'body', size: 16, lineHeight: '1.5', weight: 400, family: 'Inter', token: 'text-body' },
    { name: 'Lead', role: 'lead', size: 20, lineHeight: '1.4', weight: 400, family: 'Inter', token: 'text-lead' },
    { name: 'Heading', role: 'heading', size: 32, lineHeight: '1.2', weight: 700, family: 'Archivo', token: 'text-heading' },
    { name: 'Display', role: 'display', size: 56, lineHeight: '1.05', weight: 700, family: 'Archivo', token: 'text-display' },
  ],
  spacing: [4, 8, 16, 24, 32, 48, 64],
  radius: [0, 4],
  fields: { shadows: 'none' },
  logos: [],
  rules: [],
  voice: [],
};

describe('restyle a site in a brand', () => {
  let h: Harness;
  let site: Server;
  let url: string;
  let brandId: string;
  let fileId: string;
  let result: RestyleResult;

  beforeAll(async () => {
    site = createServer((req, res) => {
      if (req.url === '/frame.png') return void res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(SITE);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    h = await startServer();
    brandId = (await h.server.brands.create('Kiln', 'test')).id;
    writeBrandSpec((await h.server.brands.room(brandId)).doc, BRAND, 'test');
    fileId = h.server.storage.create('Ideas').id;
    result = await restyleSite(h.server, { url, brandId, fileId, width: 1000, colorScheme: 'light', allowLocal: true, actor: 'restyle' });
  }, 90_000);

  afterAll(async () => {
    await h.cleanup();
    site.close();
  });

  const doc = async (id = fileId): Promise<BogenDoc> => (await h.server.rooms.get(id)).doc;
  const layers = async (id = fileId, node = result.node_id) => {
    const d = await doc(id);
    return [d.getNode(node)!, ...d.descendants(node)];
  };

  it('links the file to the brand and puts one artboard in it', async () => {
    expect(result.file_id).toBe(fileId);
    expect(result.created_file).toBe(false);
    expect(result.linked).toBe(true);
    expect(brandLinkOf(await doc())?.id).toBe(brandId);
    expect((await doc()).getNode(result.node_id)).toMatchObject({ artboard: true, name: '127.0.0.1, in Kiln' });
  });

  it('moves colours onto the palette by lightness and role', () => {
    const to = Object.fromEntries(result.restyle.colors.map((c) => [c.from, c.name]));
    expect(to['#ffffff']).toBe('Paper');
    expect(to['#222222']).toBe('Ink');
    expect(to['#777777']).toBe('Stone');
    expect(to['#dddddd']).toBe('Rule');
    expect(to['#0055ff']).toBe('Glaze');
  });

  it('writes the brand\'s tokens into the layers', async () => {
    const all = await layers();
    const button = all.find((n) => n.tag === 'button')!;
    expect(button.style.backgroundColor).toBe('var(--glaze)');
    expect(all[0]!.style.backgroundColor).toBe('var(--paper)');
    const h1 = all.find((n) => n.tag === 'h1')!;
    expect(h1.style.fontFamily).toBe('var(--font-display)');
    expect(h1.style.fontSize).toBe('var(--text-display)');
    expect(all[0]!.style.fontFamily).toBe('var(--font-body)');
    expect(result.restyle.fonts).toEqual(expect.arrayContaining([{ from: 'arial', to: 'Inter' }, { from: 'georgia', to: 'Archivo' }]));
  });

  it('puts spacing and radii on the brand\'s scales and drops shadows the brand does not have', async () => {
    const all = await layers();
    const tokens = new Map((await doc()).getTokens().map((t) => [t.name, t.value]));
    const steps = new Set(['0px', '4px', '8px', '16px', '24px', '32px', '48px', '64px', 'auto']);
    for (const n of all) {
      for (const p of ['padding', 'gap', 'rowGap', 'columnGap', 'paddingTop', 'paddingLeft', 'margin']) {
        const value = n.style[p as keyof typeof n.style] as string | undefined;
        if (!value) continue;
        for (const part of value.split(/\s+(?![^()]*\))/)) {
          const resolved = part.replace(/^var\(--([\w-]+)\)$/, (_m, name: string) => tokens.get(name) ?? part);
          expect(steps, `${n.name} ${p}: ${value}`).toContain(resolved);
        }
      }
      expect(n.style.boxShadow).toBeUndefined();
    }
    const hero = all.find((n) => n.tag === 'section' && n.style.display === 'flex')!;
    expect(hero.style.rowGap ?? hero.style.gap).toBe('var(--space-16)');
    expect(result.restyle.shadows_removed).toBeGreaterThan(0);
  });

  it('replaces the site\'s words and images with placeholders by default', async () => {
    const all = await layers();
    const seen = JSON.stringify(all.map((n) => ({ text: n.text, name: n.name, attrs: n.attrs })));
    for (const words of SOURCE_WORDS) expect(seen).not.toContain(words);
    const images = all.filter((n) => n.type === 'image');
    expect(images.length).toBe(3);
    expect(images.every((n) => !n.src)).toBe(true);
    expect(all.some((n) => n.type === 'svg')).toBe(false);
    expect(result.restyle.texts_replaced).toBeGreaterThan(5);
    expect(result.kept).toEqual({ text: false, images: false });
  });

  it('gives text another palette colour where its new one would not stand out', async () => {
    // A light blue on near black becomes the brand's red on its ink, which does not read; the text takes paper.
    const all = await layers();
    const band = all.find((n) => n.tag === 'section' && n.style.backgroundColor === 'var(--ink)')!;
    const text = (await doc()).descendants(band.id).find((n) => n.type === 'text')!;
    expect(text.style.color).toBe('var(--paper)');
    expect(result.restyle.contrast_fixed).toBeGreaterThan(0);
    expect(result.check.violations.filter((v) => v.rule === 'color.contrast')).toEqual([]);
  });

  it('checks the result against the brand and says what it is for', () => {
    expect(result.check.score).toBeGreaterThan(50);
    expect(result.check.violations.filter((v) => v.rule === 'color.off-palette')).toEqual([]);
    expect(result.notice).toMatch(/structure and inspiration/);
    expect(result.notice).toMatch(/right to use/);
  });

  it('keeps text and images when asked to', async () => {
    const kept = await restyleSite(h.server, { url, brandId, fileId, width: 1000, colorScheme: 'light', keepText: true, keepImages: true, allowLocal: true, actor: 'restyle' });
    const all = await layers(fileId, kept.node_id);
    expect(all.some((n) => n.text === 'Bikes that outlast you')).toBe(true);
    expect(all.filter((n) => n.type === 'image').every((n) => n.src?.startsWith('bogen-asset:'))).toBe(true);
    const logo = all.find((n) => n.type === 'svg')!;
    expect(logo.svg).toContain('#c2361f');
  }, 60_000);

  it('goes into a new file when the file follows another brand', async () => {
    const other = (await h.server.brands.create('Other', 'test')).id;
    const theirs = h.server.storage.create('Theirs').id;
    await h.server.brands.link(theirs, other, 'test');
    const out = await restyleSite(h.server, { url, brandId, fileId: theirs, width: 1000, allowLocal: true, actor: 'restyle' });
    expect(out.created_file).toBe(true);
    expect(out.file_id).not.toBe(theirs);
    expect(brandLinkOf(await doc(theirs))?.id).toBe(other);
    expect(brandLinkOf(await doc(out.file_id))?.id).toBe(brandId);
  }, 60_000);

  it('undoes as one step of its actor', async () => {
    const room = await h.server.rooms.get(fileId);
    const before = room.doc.getChildren(room.doc.getPages()[0]!.id).length;
    const res = await fetch(`${h.base}/api/agents/undo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, agent: 'restyle' }) });
    expect(res.ok).toBe(true);
    expect(room.doc.getChildren(room.doc.getPages()[0]!.id).length).toBe(before - 1);
  });

  it('is an MCP tool that keeps Capture\'s rule for pages on this computer', async () => {
    const agent = await connectAgent(h.base, 'restyle-agent');
    const out = await callRaw(agent, 'site_restyle', { url, brand_id: brandId, file_id: fileId });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/command line or the editor/);
    await agent.close();
  });

  it('answers the editor from this computer', async () => {
    const res = await fetch(`${h.base}/api/files/${fileId}/restyle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, brandId, width: 1000 }) });
    expect(res.status).toBe(200);
    const out = await res.json() as RestyleResult;
    expect(out.file_id).toBe(fileId);
    expect(out.notice).toMatch(/right to use/);
  }, 60_000);
});
