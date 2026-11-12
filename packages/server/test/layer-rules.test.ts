import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { findBrowser } from '../src/render.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

const fixtures = join(import.meta.dirname, '..', '..', 'core', 'test', 'fixtures');

describe('pseudo-elements and conditions over MCP', () => {
  let h: Harness;
  let agent: Client;
  let fileId: string;
  let board: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'designer');
    ({ id: fileId } = await call(agent, 'file_create', { name: 'Rules' }));
    ({ id: board } = await call(agent, 'artboard_create', { file_id: fileId, name: 'Docs', width: 900 }));
  }, 60000);

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  const room = () => h.server.rooms.get(fileId);

  it('layer_style writes a pseudo-element and a condition, and the read tools show them', async () => {
    const { ids } = await call(agent, 'html_write', { file_id: fileId, target_id: board, html: '<section data-name="Wrap" style="container-type:inline-size"><p data-name="Sign">Guides</p></section>' });
    const sign = (await room()).doc.getChildren(ids[0])[0]!.id;
    const out = await call(agent, 'layer_style', { file_id: fileId, node_ids: [sign], pseudo: '::after', style: { content: '"+"', 'margin-left': '8px' } });
    expect(out).toMatchObject({ block: '::after', rules: { '::after': { content: '"+"', marginLeft: '8px' } } });
    expect(out.warnings).toBeUndefined();
    await call(agent, 'layer_style', { file_id: fileId, node_ids: [sign], when: '@container (max-width: 560px)', pseudo: 'after', style: { display: 'none' } });
    await call(agent, 'layer_style', { file_id: fileId, node_ids: [sign], when: ':hover', style: { color: 'red' } });
    const tree = await call<string>(agent, 'layer_tree', { file_id: fileId, node_id: ids[0] });
    expect(tree).toContain('rules {::after, @container (max-width: 560px) ::after, :hover}');
    const got = await call(agent, 'layer_get', { file_id: fileId, node_id: sign });
    expect(got.rules).toEqual({ '::after': { content: '"+"', marginLeft: '8px' }, '@container (max-width: 560px) ::after': { display: 'none' }, ':hover': { color: 'red' } });
    await call(agent, 'layer_style', { file_id: fileId, node_ids: [sign], when: ':hover', clear_block: true });
    await call(agent, 'layer_style', { file_id: fileId, node_ids: [sign], pseudo: '::after', style: { 'margin-left': null } });
    expect((await room()).doc.getNode(sign)?.rules).toEqual({ '::after': { content: '"+"' }, '@container (max-width: 560px) ::after': { display: 'none' } });
    const code = await call<string>(agent, 'code_get', { file_id: fileId, node_id: ids[0] });
    expect(code).toMatch(/<style>[\s\S]*::after\{content:"\+"\}[\s\S]*<\/style>/);
    // One agent undo takes back one call, block writes included.
    await call(agent, 'layer_style', { file_id: fileId, node_ids: [sign], pseudo: '::before', style: { content: '"x"' } });
    await call(agent, 'agent_undo', { file_id: fileId });
    expect((await room()).doc.getNode(sign)?.rules?.['::before']).toBeUndefined();
  });

  it('refuses what cannot go into a style sheet, and says why', async () => {
    const { ids } = await call(agent, 'html_write', { file_id: fileId, target_id: board, html: '<div>x</div>' });
    const bad = [
      { pseudo: '::backdrop', style: { color: 'red' } },
      { when: ':visited', style: { color: 'red' } },
      { when: '@media (x) { body', style: { color: 'red' } },
      { pseudo: '::before', style: { content: '"a"}body{color:red' } },
      { pseudo: '::before', style: { content: '"</style><script>alert(1)</script>"' } },
      { pseudo: '::before', style: { 'x}y': 'red' } },
      { pseudo: '::before', style: {} },
    ];
    for (const args of bad) {
      const res = await callRaw(agent, 'layer_style', { file_id: fileId, node_ids: ids, ...args });
      expect(res.isError, JSON.stringify(args)).toBe(true);
    }
    expect((await room()).doc.getNode(ids[0])?.rules).toBeUndefined();
    const warned = await call(agent, 'layer_style', { file_id: fileId, node_ids: ids, pseudo: '::before', style: { color: 'red' } });
    expect(warned.warnings.join(' ')).toContain('shows nothing until it has content');
    const lonely = await call(agent, 'layer_style', { file_id: fileId, node_ids: ids, when: '@container (max-width: 300px)', style: { color: 'red' } });
    expect(lonely.warnings.join(' ')).toContain('container-type');
  });

  it('design_lint sees values inside rules', async () => {
    await call(agent, 'tokens_set', { file_id: fileId, tokens: [{ name: 'accent', kind: 'color', value: '#e5281c' }] });
    const { ids } = await call(agent, 'html_write', { file_id: fileId, target_id: board, html: '<p style="color:#111">Lint me</p>' });
    await call(agent, 'layer_style', { file_id: fileId, node_ids: ids, when: ':hover', style: { color: '#e5281c' } });
    const lint = await call(agent, 'design_lint', { file_id: fileId, node_id: ids[0] });
    const issues = (lint.issues ?? lint) as { rule: string; message: string }[];
    expect(issues.some((i) => i.rule === 'token' && i.message.includes('color in :hover is #e5281c'))).toBe(true);
  });

  it('html_write keeps the tomacco docs rules and warns about what it cannot keep', async () => {
    const css = readFileSync(join(fixtures, 'tomacco-site.css'), 'utf8');
    const html = readFileSync(join(fixtures, 'tomacco-docs.html'), 'utf8');
    const page = await call(agent, 'page_create', { file_id: fileId, name: 'Docs' });
    const art = await call(agent, 'artboard_create', { file_id: fileId, page_id: page.id, name: 'Architecture', width: 900 });
    const out = await call(agent, 'html_write', { file_id: fileId, target_id: art.id, html: `<style>${css}</style>${html}` });
    expect(out.warnings.join(' ')).toContain('::-webkit-details-marker');
    const tree = await call<string>(agent, 'layer_tree', { file_id: fileId, node_id: art.id, depth: 6 });
    expect(tree).toMatch(/"Dg merge".*rules \{/);
  });
});

describe.skipIf(!findBrowser())('rules in the server render', () => {
  let h: Harness;
  let agent: Client;
  let fileId: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'renderer');
    ({ id: fileId } = await call(agent, 'file_create', { name: 'Render' }));
  }, 60000);

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('flips a container query of the tomacco diagram and a media query at a narrow width', async () => {
    const board = await call(agent, 'artboard_create', { file_id: fileId, name: 'Diagram', width: 900 });
    const css = readFileSync(join(fixtures, 'tomacco-site.css'), 'utf8');
    const html = readFileSync(join(fixtures, 'tomacco-docs.html'), 'utf8');
    await call(agent, 'html_write', { file_id: fileId, target_id: board.id, html: `<style>${css}</style>${html}` });
    const { doc } = await h.server.rooms.get(fileId);
    const all = doc.descendants(board.id);
    const merge = all.find((n) => n.name === 'Dg merge')!.id;
    const row = all.find((n) => n.tag === 'ol' && n.name === 'Dg row')!.id;
    const pre = all.find((n) => n.tag === 'pre')!.id;
    const wide = await call(agent, 'layer_styles_computed', { file_id: fileId, node_ids: [merge], pseudo: '::before', properties: ['display', 'content'] });
    const narrow = await call(agent, 'layer_styles_computed', { file_id: fileId, node_ids: [merge], pseudo: '::before', properties: ['display'], width: 420 });
    expect(wide[merge].style).toMatchObject({ display: 'block', content: '""' });
    expect(narrow[merge].style.display).toBe('none');
    const cols = async (width?: number) => (await call(agent, 'layer_styles_computed', { file_id: fileId, node_ids: [row], properties: ['grid-template-columns'], ...(width ? { width } : {}) }))[row].style['grid-template-columns'].split(' ').length;
    expect(await cols()).toBe(3);
    expect(await cols(420)).toBe(1);
    // A media width query reads the artboard, not the 1440 wide browser that renders it.
    const label = async (width?: number) => (await call(agent, 'layer_styles_computed', { file_id: fileId, node_ids: [pre], properties: ['border-left-width'], ...(width ? { width } : {}) }))[pre].style['border-left-width'];
    expect(await label(700)).toBe('0px');
    expect(await label()).not.toBe('0px');
    const shot = await callRaw(agent, 'canvas_screenshot', { file_id: fileId, node_id: board.id });
    expect(shot.isError).toBe(false);
  }, 60000);
});
