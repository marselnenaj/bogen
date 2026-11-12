import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

/** The score explains itself: the layers behind each part, and what would raise it most, worth what. */
describe('the score, explained', () => {
  let h: Harness;
  let agent: Client;
  let file: string;
  let board: string;
  let ids: string[];

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'checker');
    const brand = (await call(agent, 'brand_create', { name: 'Ledger' })).id;
    await call(agent, 'brand_update', {
      brand_id: brand, confirmed: true, fields: { shadows: 'none' },
      items: [
        { section: 'colors', name: 'Ink', role: 'text', value: '#101010', token: 'ink' },
        { section: 'colors', name: 'Paper', role: 'background', value: '#f8f6f0', token: 'paper' },
        { section: 'colors', name: 'Signal', role: 'primary', value: '#e03010', token: 'signal' },
        { section: 'families', family: 'Inter', role: 'body', weights: [400, 700], token: 'font-body' },
        { section: 'typeScale', name: 'Body', size: 16, weight: 400, token: 'text-body' },
        { section: 'typeScale', name: 'Title', size: 48, weight: 700, token: 'text-title' },
        { section: 'spacing', name: 's', value: 8, token: 'space-s' },
        { section: 'spacing', name: 'm', value: 16, token: 'space-m' },
        { section: 'spacing', name: 'l', value: 48, token: 'space-l' },
      ],
    });
    file = (await call(agent, 'file_create', { name: 'Page' })).id;
    await call(agent, 'brand_link', { brand_id: brand, file_id: file });
    board = (await call(agent, 'artboard_create', { file_id: file, name: 'Board', width: 800, background: 'var(--paper)' })).id;
    ids = (await call(agent, 'html_write', { file_id: file, target_id: board, html: `
      <section style="display:flex;flex-direction:column;gap:16px;padding:48px;box-shadow:0 2px 8px rgba(0,0,0,.2)">
        <h1 style="font-family:Inter;font-size:48px;font-weight:700;color:#2a4cd0">A title in a blue the brand does not have</h1>
        <p style="font-family:Inter;font-size:16px;color:#2a4cd0">A line in the same blue.</p>
        <p style="font-family:Inter;font-size:16px;color:var(--ink)">A line in ink.</p>
        <p style="font-family:Inter;font-size:16px;color:var(--ink)">Another line in ink.</p>
      </section>
      <div style="display:flex;gap:16px;padding:16px;box-shadow:0 1px 2px #0003"><p style="font-family:Inter;font-size:16px;color:var(--ink)">A row with a shadow.</p></div>` })).ids;
  });
  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('names the layers behind each category and lists what would raise the score, largest gain first', async () => {
    const report = await call(agent, 'brand_check', { file_id: file, limit: 200 });
    const why = report.why;
    const colour = why.categories.find((c: any) => c.category === 'colour');
    expect(colour.failed).toBeGreaterThan(0);
    const { doc } = await h.server.rooms.get(file);
    const blue = doc.descendants(board).filter((n) => n.style.color === '#2a4cd0').map((n) => n.id);
    expect(colour.node_ids).toEqual(expect.arrayContaining(blue));
    expect(why.raise.length).toBeGreaterThan(1);
    const gains = why.raise.map((l: any) => l.gain);
    expect([...gains].sort((a, b) => b - a)).toEqual(gains);
    const palette = why.raise.find((l: any) => l.key === 'color.off-palette');
    expect(palette).toMatchObject({ kind: 'rule', category: 'colour', label: 'Colours off the palette' });
    expect(palette.node_ids.sort()).toEqual([...blue].sort());
    expect(palette.how).toContain('2 violations');
    const shadow = why.raise.find((l: any) => l.key === 'layout.shadow');
    expect(shadow.node_ids.sort()).toEqual([ids[0], ids[1]].sort());
    expect(shadow.safe).toBe(2);
    expect(shadow.how).toContain('All are safe fixes');
    for (const part of why.quality_parts) expect(Array.isArray(part.node_ids)).toBe(true);
  });

  it('a lever is worth what it says: fixing it raises the score by its gain', async () => {
    const before = await call(agent, 'brand_check', { file_id: file, limit: 200 });
    const lever = before.why.raise.find((l: any) => l.key === 'color.off-palette');
    await call(agent, 'layer_style', { file_id: file, node_ids: lever.node_ids, style: { color: 'var(--ink)' } });
    const after = await call(agent, 'brand_check', { file_id: file, limit: 200 });
    // Quality may move a little with the colours in use, so the gain is a forecast to within a point or two.
    expect(Math.abs(after.score - before.score - lever.gain)).toBeLessThanOrEqual(2);
    expect(after.why.raise.some((l: any) => l.key === 'color.off-palette')).toBe(false);
  });

  it('quality parts say how to raise them, and which layers they are about', async () => {
    const flat = (await call(agent, 'artboard_create', { file_id: file, name: 'Flat', width: 800, background: 'var(--paper)' })).id;
    await call(agent, 'html_write', { file_id: file, target_id: flat, html: `<div style="display:flex;flex-direction:column;gap:16px;padding:16px">${Array.from({ length: 5 }, (_, i) => `<p style="font-family:Inter;font-size:16px;color:var(--ink);padding:16px">Line ${i + 1} of five, all one size.</p>`).join('')}</div>` });
    const report = await call(agent, 'brand_check', { file_id: file, node_id: flat, limit: 200 });
    const hierarchy = report.why.quality_parts.find((q: any) => q.dimension === 'hierarchy');
    expect(hierarchy.how).toMatch(/^Use at least four sizes of the type scale \(1 now\), and make the largest text at least 2\.5x/);
    expect(hierarchy.node_ids.length).toBe(5);
    const lever = report.why.raise.find((l: any) => l.key === 'hierarchy');
    expect(lever).toMatchObject({ kind: 'quality', label: 'Type hierarchy' });
    expect(lever.gain).toBeGreaterThan(0);
  });
});
