import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { cssLength, fluidExpressions, isFluid, svgColors } from '../src/brand-check.ts';
import * as variants from './fixtures/brand-score/variants.ts';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

describe('fluid lengths', () => {
  const at = (vw: number) => ({ vw, vh: 900, rem: 16, em: 16 });

  it('works out clamp, min, max, calc and viewport units at a width', () => {
    expect(cssLength('clamp(88px, 13vw, 220px)', at(1440))).toBe(187.2);
    expect(cssLength('clamp(88px, 13vw, 220px)', at(390))).toBe(88);
    expect(cssLength('clamp(1.06rem, .92rem + .62vw, 1.5rem)', at(1440))).toBeCloseTo(23.65, 2);
    expect(cssLength('max(clamp(16px, 3vw, 48px), env(safe-area-inset-left))', at(390))).toBe(16);
    expect(cssLength('min(calc(100vw - 2 * 24px), 1200px)', at(390))).toBe(342);
    expect(cssLength('calc(var(--x) * 2)', at(390))).toBeNull();
    expect(cssLength('50%', at(390))).toBeNull();
    expect(cssLength('-2px')).toBe(-2);
    expect(cssLength('1.5em', { ...at(390), em: 20 })).toBe(30);
    expect(isFluid('clamp(16px, 3vw, 48px)')).toBe(true);
    expect(isFluid('2rem')).toBe(false);
  });

  it('reads fluid steps a brand states in its notes', () => {
    expect(fluidExpressions('Gutter 3vw between 16px and 48px, sections clamp(88px, 13vw, 220px) apart.')).toEqual(['clamp(88px, 13vw, 220px)', 'clamp(16px, 3vw, 48px)']);
    expect(fluidExpressions('9.4vw at 1440.')).toEqual(['9.4vw']);
    expect(fluidExpressions('The hero h1 at 1440.')).toEqual([]);
  });

  it('counts only colours a drawing shows', () => {
    // Captured markup: the root carries the browser's defaults, which every shape overrides.
    const captured = '<svg style="fill: rgb(0, 0, 0); stroke: none; stop-color: rgb(0, 0, 0)" viewBox="0 0 16 16"><path d="M2 3.5h2M6.5 8H14" style="stroke:rgb(244, 242, 236)"/><rect x="1" y="1" width="4" height="4" style="fill:rgb(242, 54, 31)"/></svg>';
    expect(svgColors(captured).map((c) => c.color)).toEqual(['#f4f2ec', '#f2361f']);
    // A shape with no fill of its own shows the one it inherits.
    expect(svgColors('<svg fill="#123456"><circle cx="5" cy="5" r="4"/></svg>').map((c) => c.color)).toEqual(['#123456']);
    expect(svgColors('<svg><linearGradient><stop stop-color="#abcdef"/></linearGradient></svg>').map((c) => c.color)).toEqual(['#abcdef']);
  });
});

/** The Tomacco brand as a Bogen file, with a Capture of tomacco.dev at 1440 on its Reference page. */
const FIXTURE = join(import.meta.dirname, 'fixtures/brand-score/tomacco-brand.bogen.gz');
const REAL_SITE = 'nq3u14ark1';

async function tomacco() {
  const h = await startServer();
  harnesses.push(h);
  const res = await fetch(`${h.base}/api/files/import`, { method: 'POST', headers: { 'X-Bogen-Filename': 'Tomacco Brand System' }, body: gunzipSync(readFileSync(FIXTURE)) });
  const { id: brand } = (await res.json()) as { id: string };
  const client = await connectAgent(h.base, 'claude');
  const file = await call(client, 'file_create', { name: 'Pricing' });
  await call(client, 'brand_link', { brand_id: brand, file_id: file.id });
  const board = async (html: string, width = 1440, background = 'var(--ink)', logo = false) => {
    const created = await call(client, 'artboard_create', { name: 'Page', width, background, file_id: file.id });
    await call(client, 'html_write', { target_id: created.id, html, file_id: file.id });
    if (logo) {
      const header = (await h.server.rooms.get(file.id)).doc.descendants(created.id).find((n) => n.tag === 'header')!;
      await call(client, 'brand_asset_use', { target_id: header.id, index: 0, file_id: file.id });
    }
    return created.id as string;
  };
  const check = (node: string) => call(client, 'brand_check', { node_id: node, file_id: file.id, limit: 200 });
  return { h, client, brand, file: file.id as string, board, check };
}

describe('brand score calibration', () => {
  it('scores the real site high against its own brand, and keeps good, flat, careless and off-brand work apart', async () => {
    const { client, brand, board, check } = await tomacco();
    const real = await call(client, 'brand_check', { node_id: REAL_SITE, file_id: brand, brand_id: brand, limit: 200 });
    const good = await check(await board(variants.good(), 1440, 'var(--ink)', true));
    const fluid = await check(await board(variants.good(true), 390, 'var(--ink)', true));
    const careless = await check(await board(variants.careless(), 1440, '#0e0e0c'));
    const mediocre = await check(await board(variants.mediocre(), 1440, '#f4f2ec'));
    const offBrand = await check(await board(variants.offBrand(), 1440, '#ffffff'));
    const scores = { real: real.score, good: good.score, fluid: fluid.score, careless: careless.score, mediocre: mediocre.score, offBrand: offBrand.score };

    // Before: the site scored 52, and flat work scored 100 like good work.
    expect(scores.real, JSON.stringify(scores)).toBeGreaterThanOrEqual(78);
    expect(scores.good).toBeGreaterThanOrEqual(90);
    expect(scores.fluid).toBeGreaterThanOrEqual(90);
    expect(scores.mediocre).toBeLessThanOrEqual(scores.good - 20);
    expect(scores.careless).toBeLessThanOrEqual(scores.good - 20);
    expect(scores.offBrand).toBeLessThan(35);
    expect(scores.offBrand).toBeLessThan(Math.min(scores.careless, scores.mediocre) - 15);

    // Flat work keeps to every value, and says where it falls short.
    expect(mediocre.why.conformance).toBe(100);
    const parts = Object.fromEntries(mediocre.why.quality_parts.map((q: any) => [q.dimension, q.score]));
    expect(parts.hierarchy).toBeLessThan(30);
    expect(parts.rhythm).toBeLessThan(30);
    expect(mediocre.why.formula).toMatch(/Quality: hierarchy/);
    // The site's fluid gutter and section spacing are on the brand's scale at its width.
    expect(real.violations.some((v: any) => /43\.2px|187\.2px/.test(v.message))).toBe(false);
    await client.close();
  }, 240_000);

  it('works out viewport units at the width of the artboard, not of the renderer', async () => {
    const { client, board, check } = await tomacco();
    const html = (padding: string) => `<div style="display:flex;flex-direction:column;padding:${padding};background:var(--ink)"><p style="font-family:var(--font-sans);font-size:var(--text-body);color:var(--paper);margin:0">Give your agent a phone.</p></div>`;
    const onScale = await check(await board(html('clamp(16px, 3vw, 48px)'), 390));
    expect(onScale.violations.filter((v: any) => v.rule === 'layout.spacing-off-scale')).toEqual([]);
    const off = await check(await board(html('6vw'), 390));
    const spacing = off.violations.filter((v: any) => v.rule === 'layout.spacing-off-scale');
    expect(spacing[0]?.message).toContain('23.4px at 390px wide');
    expect(spacing[0]?.fix.safe).toBe(false);
    await client.close();
  }, 120_000);
});
