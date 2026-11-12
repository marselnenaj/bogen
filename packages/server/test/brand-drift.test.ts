import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

/** Brand drift across files: every linked file checked, its worst layers, a summary, and the history behind a trend. */
describe('brand_drift', () => {
  let h: Harness;
  let agent: Client;
  let brand: string;
  const files: Record<string, string> = {};
  const boards: Record<string, string> = {};

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'checker');
    brand = (await call(agent, 'brand_create', { name: 'Ledger' })).id;
    await call(agent, 'brand_update', {
      brand_id: brand, confirmed: true, fields: { shadows: 'none' },
      items: [
        { section: 'colors', name: 'Ink', role: 'text', value: '#101010', token: 'ink' },
        { section: 'colors', name: 'Paper', role: 'background', value: '#f8f6f0', token: 'paper' },
        { section: 'colors', name: 'Signal', role: 'primary', value: '#e03010', token: 'signal' },
        { section: 'families', family: 'Inter', role: 'body', weights: [400, 700], token: 'font-body' },
        { section: 'typeScale', name: 'Body', size: 16, weight: 400, token: 'text-body' },
        { section: 'typeScale', name: 'Title', size: 48, weight: 700, token: 'text-title' },
        { section: 'spacing', name: 'm', value: 16, token: 'space-m' },
      ],
    });
    for (const name of ['Tidy', 'Messy', 'Empty']) {
      files[name] = (await call(agent, 'file_create', { name })).id;
      await call(agent, 'brand_link', { brand_id: brand, file_id: files[name] });
      if (name === 'Empty') continue;
      boards[name] = (await call(agent, 'artboard_create', { file_id: files[name], name: 'Page', width: 800, background: 'var(--paper)' })).id;
    }
    await call(agent, 'html_write', { file_id: files.Tidy, target_id: boards.Tidy, html: '<section style="display:flex;flex-direction:column;gap:16px;padding:16px"><h1 style="font-family:var(--font-body);font-size:var(--text-title);font-weight:700;color:var(--ink)">A tidy title</h1><p style="font-family:var(--font-body);font-size:var(--text-body);color:var(--ink)">A tidy line.</p></section>' });
    await call(agent, 'html_write', { file_id: files.Messy, target_id: boards.Messy, html: '<section data-name="Loud" style="display:flex;flex-direction:column;gap:13px;padding:13px;box-shadow:0 4px 12px #0004"><h1 data-name="Wrong title" style="font-family:Georgia;font-size:47px;color:#2a4cd0">A title</h1><p data-name="Fine line" style="font-family:var(--font-body);color:var(--ink)">A line.</p></section>' });
  }, 60_000);
  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('checks every linked file, worst first, with its worst layers and a summary', async () => {
    const out = await call(agent, 'brand_drift', { brand_id: brand, worst: 3 });
    expect(out.files.map((f: any) => f.file_name)).toEqual(['Messy', 'Tidy', 'Empty']);
    const [messy, tidy, empty] = out.files;
    expect(messy.score).toBeLessThan(tidy.score);
    expect(empty.score).toBeNull();
    expect(messy.worst[0]).toMatchObject({ layer: 'Wrong title', page: expect.any(String) });
    expect(messy.worst[0].hard).toBeGreaterThan(0);
    expect(messy.worst[0].rules).toEqual(expect.arrayContaining(['color.off-palette', 'type.off-brand-font']));
    expect(messy.worst.map((w: any) => w.layer)).toContain('Loud');
    expect(messy.top.length).toBeGreaterThan(0);
    expect(out.summary).toBe(Math.round((messy.score + tidy.score) / 2));
    expect(out.history).toHaveLength(1);
    expect(out.trend).toEqual({ last: out.summary });
  });

  it('keeps the scores over time, so that a fix shows as a trend, and a whole-file brand_check counts too', async () => {
    const before = await call(agent, 'brand_drift', { brand_id: brand });
    const messyBefore = before.files.find((f: any) => f.file_name === 'Messy');
    const { doc } = await h.server.rooms.get(files.Messy!);
    const title = doc.descendants(boards.Messy!).find((n) => n.name === 'Wrong title')!.id;
    await call(agent, 'layer_style', { file_id: files.Messy, node_ids: [title], style: { fontFamily: 'var(--font-body)', color: 'var(--ink)', fontSize: 'var(--text-title)' } });
    const after = await call(agent, 'brand_drift', { brand_id: brand });
    const messyAfter = after.files.find((f: any) => f.file_name === 'Messy');
    expect(messyAfter.score).toBeGreaterThan(messyBefore.score);
    expect(messyAfter.trend.change).toBe(messyAfter.score - messyBefore.score);
    expect(after.trend.change).toBeGreaterThan(0);
    expect(after.history.length).toBe(3);

    await call(agent, 'brand_check', { file_id: files.Tidy });
    const scores = await (await fetch(`${h.base}/api/brands/${brand}/scores`)).json();
    expect(scores.summary).toHaveLength(3);
    const tidy = scores.files.find((f: any) => f.file_name === 'Tidy');
    // Three drift checks and a brand_check of an unchanged file within a minute are one point per change.
    expect(tidy.points.length).toBeGreaterThanOrEqual(1);
    expect(tidy.points.at(-1).by).toBe('agent:checker');
    const stored = join(h.home, 'brand-scores', `${brand}.json`);
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored, 'utf8')).not.toContain('A tidy title');
  });

  it('the Brand tab\'s check returns the file\'s history, and the panel runs a drift check over HTTP', async () => {
    const check = await (await fetch(`${h.base}/api/files/${files.Messy}/brand/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    expect(check.history.length).toBeGreaterThanOrEqual(2);
    const drift = await (await fetch(`${h.base}/api/brands/${brand}/drift`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'Mara' }) })).json();
    expect(drift.files).toHaveLength(3);
    const scores = await (await fetch(`${h.base}/api/brands/${brand}/scores`)).json();
    expect(scores.files.find((f: any) => f.file_name === 'Messy').points.at(-1).by).toBe('person:Mara');
  });
});
