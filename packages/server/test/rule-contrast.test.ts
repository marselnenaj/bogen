import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BogenDoc, Y } from '@bogen/core';
import { pseudoWords, rulePairs, swapColor } from '../src/rule-contrast.ts';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

/** Contrast of text in ::before and ::after, and under @media, @container and state blocks, in brand_check and design_lint. */
describe('contrast inside pseudo-elements and conditions', () => {
  let h: Harness;
  let agent: Client;
  let file: string;
  let board: string;
  let ids: string[];

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'checker');
    const brand = (await call(agent, 'brand_create', { name: 'Ledger' })).id;
    await call(agent, 'brand_update', { brand_id: brand, confirmed: true, items: [
      { section: 'colors', name: 'Ink', role: 'text', value: '#101010', token: 'ink' },
      { section: 'colors', name: 'Paper', role: 'background', value: '#f8f6f0', token: 'paper' },
      { section: 'colors', name: 'Signal', role: 'primary', value: '#e03010', token: 'signal' },
      { section: 'colors', name: 'Mist', role: 'muted', value: '#d8d4cc', token: 'mist' },
      { section: 'families', family: 'Inter', role: 'body', weights: [400, 700], token: 'font-body' },
    ] });
    file = (await call(agent, 'file_create', { name: 'Conditions' })).id;
    await call(agent, 'brand_link', { brand_id: brand, file_id: file });
    board = (await call(agent, 'artboard_create', { file_id: file, name: 'Board', width: 800, background: 'var(--paper)' })).id;
    ids = (await call(agent, 'html_write', { file_id: file, target_id: board, html: `
      <p style="font-family:Inter;font-size:16px;color:var(--ink)">A plain line that reads well on paper.</p>
      <p style="font-family:Inter;font-size:16px;color:var(--ink)">A badge goes before this line.</p>
      <a href="/x" style="font-family:Inter;font-size:16px;color:var(--ink)">A link</a>` })).ids;
    // Dark mode on the artboard, and the text forgets to follow.
    await call(agent, 'layer_style', { file_id: file, node_ids: [board], when: '@media (prefers-color-scheme: dark)', style: { background: '#101010' } });
    // A badge of pale words on paper.
    await call(agent, 'layer_style', { file_id: file, node_ids: [ids[1]], pseudo: '::before', style: { content: '"New "', color: '#d8d4cc' } });
    // A hover colour a hair off the brand's Signal.
    await call(agent, 'layer_style', { file_id: file, node_ids: [ids[2]], when: ':hover', style: { color: '#e8401c' } });
  }, 60_000);
  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('works out each block\'s pair of colours from the styles', async () => {
    const { doc } = await h.server.rooms.get(file);
    const tokens = new Map(doc.getTokens().map((t) => [t.name, t.value]));
    const dark = rulePairs(doc, doc.getNode(ids[0]!)!, tokens);
    expect(dark).toEqual([{ block: '@media (prefers-color-scheme: dark)', color: '#101010', backdrop: '#101010', size: 16, sets: { color: false, backdrop: true } }]);
    const badge = rulePairs(doc, doc.getNode(ids[1]!)!, tokens).find((p) => p.block === '::before')!;
    expect(badge).toMatchObject({ content: 'New ', color: '#d8d4cc', backdrop: '#f8f6f0', sets: { color: true, backdrop: false } });
    expect(pseudoWords('"\\2192"')).toBeUndefined();
    expect(pseudoWords("'Beta'")).toBe('Beta');
    expect(pseudoWords('counter(item)')).toBeUndefined();
    expect(swapColor('1px solid #e8401c', '#e8401c', 'var(--signal)')).toBe('1px solid var(--signal)');
  });

  it('brand_check measures them, says where, and fixes a near colour inside its block', async () => {
    const before = await call(agent, 'brand_check', { file_id: file, limit: 200 });
    const contrast = before.violations.filter((v: any) => v.rule === 'color.contrast');
    const dark = contrast.find((v: any) => v.node_id === ids[0]);
    expect(dark.message).toBe('In @media (prefers-color-scheme: dark), the text has a contrast of 1:1, under 4.5:1 for normal text.');
    expect(dark.severity).toBe('hard');
    expect(dark.fix).toMatchObject({ safe: false, block: '@media (prefers-color-scheme: dark)', style: { color: 'var(--mist)' } });
    const badge = contrast.find((v: any) => v.node_id === ids[1]);
    expect(badge.message).toMatch(/^The words "New " in ::before has a contrast of 1\.\d+:1, under 4\.5:1/);
    const hover = before.violations.find((v: any) => v.rule === 'color.off-palette' && v.node_id === ids[2]);
    expect(hover.message).toContain('color in :hover is #e8401c');
    expect(hover.fix).toEqual({ description: 'Snap #e8401c to Signal (#e03010) in :hover.', safe: true, style: { color: 'var(--signal)' }, block: ':hover' });

    const after = await call(agent, 'brand_check', { file_id: file, fix: true, limit: 200 });
    expect(after.fixed.map((f: any) => f.node_id)).toContain(ids[2]);
    const link = await call(agent, 'layer_get', { file_id: file, node_id: ids[2] });
    expect(JSON.stringify(link)).toContain('var(--signal)');
    expect(after.violations.some((v: any) => v.rule === 'color.off-palette' && v.node_id === ids[2])).toBe(false);
    // The contrast problems are not safe to fix by machine, so they stay.
    expect(after.violations.filter((v: any) => v.rule === 'color.contrast').length).toBe(contrast.length);
    await call(agent, 'agent_undo', { file_id: file });
  });

  it('design_lint measures pseudo-elements in the render and conditions from the styles, and puts token fixes into the block', async () => {
    await call(agent, 'layer_style', { file_id: file, node_ids: [ids[0]], when: ':focus-visible', style: { outlineColor: '#e03010' } });
    const lint = await call(agent, 'design_lint', { file_id: file, node_id: board });
    const contrast = lint.issues.filter((i: any) => i.rule === 'contrast');
    expect(contrast.find((i: any) => i.nodeId === ids[1]).message).toMatch(/^The words "New " in ::before have a contrast of 1\.\d+:1/);
    const dark = contrast.find((i: any) => i.nodeId === ids[0]);
    expect(dark.message).toContain('In @media (prefers-color-scheme: dark), text contrast is 1.00:1');
    expect(dark.fix).toEqual({ style: { color: 'var(--paper)' }, safe: false, block: '@media (prefers-color-scheme: dark)' });
    const token = lint.issues.find((i: any) => i.rule === 'token' && i.nodeId === ids[0] && i.fix?.block);
    expect(token.fix).toEqual({ style: { outlineColor: 'var(--signal)' }, safe: true, block: ':focus-visible' });

    const fixed = await call(agent, 'design_lint', { file_id: file, node_id: board, fix: true });
    expect(fixed.fixed).toContainEqual({ node_id: ids[0], rule: 'token', style: { outlineColor: 'var(--signal)' }, block: ':focus-visible' });
    const { doc } = await h.server.rooms.get(file);
    expect(doc.getNode(ids[0]!)!.rules?.[':focus-visible']).toEqual({ outlineColor: 'var(--signal)' });
  });

  it('a block that sets nothing about colour is not a new pair', () => {
    const doc = new BogenDoc(new Y.Doc());
    doc.ensureFirstPage('P');
    const page = doc.getPages()[0]!.id;
    const root = doc.insert(page, { type: 'frame', name: 'Root', style: { background: '#ffffff' }, rules: { '@media (max-width: 600px)': { padding: '8px' } } });
    const text = doc.insert(root, { type: 'text', name: 'T', text: 'Hello', style: { color: '#111111' } });
    expect(rulePairs(doc, doc.getNode(text)!, new Map())).toEqual([]);
  });
});
