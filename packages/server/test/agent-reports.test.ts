import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, callRaw, connectAgent, pngStats, startServer, type Harness } from './helpers.ts';

/** Bugs that agents ran into while building brand files, each reported by several of them. */
describe('what agents reported', () => {
  let h: Harness;
  let agent: Client;
  let file: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'reporter');
    file = (await call(agent, 'file_create', { name: 'Reports' })).id;
  });
  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('screenshots a child layer at the scale asked for, sized by the layer', async () => {
    const board = (await call(agent, 'artboard_create', { name: 'Tall', width: 1200, height: 3000 })).id;
    const chip = (await call(agent, 'html_write', { target_id: board, html: '<div style="height:2600px;flex:none"></div><div data-name="Chip" style="width:200px;height:100px;flex:none;background:#c33"></div>' })).ids[1];
    const raw = await callRaw(agent, 'canvas_screenshot', { node_id: chip, scale: 2 });
    expect(raw.isError).toBe(false);
    expect(raw.content[1]!.text).toMatch(/^400x200px at scale 2,/);
    const png = await pngStats(Buffer.from(raw.content[0]!.data!, 'base64'));
    expect([png.width, png.height]).toEqual([400, 200]);
    expect(png.distinctColors).toBe(1);

    // So long that the artboard at this density is more than a browser paints at once: the layer alone is.
    const longBoard = (await call(agent, 'artboard_create', { name: 'Long', width: 1200, height: 7000 })).id;
    const low = (await call(agent, 'html_write', { target_id: longBoard, html: '<div style="height:6800px;flex:none;background:#eee"></div><div style="width:200px;height:100px;flex:none;background:#36c"></div>' })).ids[1];
    const deep = await callRaw(agent, 'canvas_screenshot', { node_id: low, scale: 4 });
    expect(deep.content[1]!.text).toMatch(/^800x400px at scale 4,/);
    const deepPng = await pngStats(Buffer.from(deep.content[0]!.data!, 'base64'));
    expect([deepPng.width, deepPng.height, deepPng.distinctColors]).toEqual([800, 400, 1]);
  }, 60_000);

  it('exports to a path the agent gives, safely', async () => {
    const board = (await call(agent, 'artboard_create', { name: 'Export', width: 120, height: 80 })).id;
    const exports = h.server.exportDir!;
    const target = join(exports, 'site', 'public', 'og.png');
    const out = await call(agent, 'export_file', { format: 'png', node_ids: [board], path: target });
    expect(out.paths).toEqual([target]);
    expect(readFileSync(target).subarray(1, 4).toString()).toBe('PNG');

    // Never replaced without asking.
    writeFileSync(target, 'mine');
    const again = await callRaw(agent, 'export_file', { format: 'png', node_ids: [board], path: target });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toMatch(/already exists.*overwrite/);
    expect(readFileSync(target, 'utf8')).toBe('mine');
    await call(agent, 'export_file', { format: 'png', node_ids: [board], path: target, overwrite: true });
    expect(readFileSync(target).subarray(1, 4).toString()).toBe('PNG');

    // A folder gets a name chosen for it.
    const inFolder = await call(agent, 'export_file', { format: 'svg', node_ids: [board], path: `${join(exports, 'svgs')}/` });
    expect(inFolder.paths[0]).toMatch(/\/svgs\/Reports-Export\.svg$/);

    const refused = async (args: Record<string, unknown>, message: RegExp) => {
      const res = await callRaw(agent, 'export_file', { format: 'png', node_ids: [board], ...args });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(message);
    };
    await refused({ path: '/etc/bogen-export-test.png' }, /outside your home/);
    await refused({ path: join(h.home, 'elsewhere.png') }, /outside your home/);
    await refused({ path: 'relative/og.png' }, /must be absolute/);
    await refused({ path: '~/.config/bogen-export-test/og.png' }, /hidden folder.*allow_hidden/);
    await refused({ path: '~/.ssh/og.png', allow_hidden: true }, /protected/);
    await refused({ path: join(exports, 'og.jpg') }, /needs a path ending in \.png/);
    await refused({ node_ids: [board, board], path: join(exports, 'two.png') }, /give a folder/);
    expect(existsSync(join(homedir(), '.config', 'bogen-export-test'))).toBe(false);
  }, 60_000);

  it('exports an image taller than one browser capture without repeating its top', async () => {
    const board = (await call(agent, 'artboard_create', { name: 'Very tall', width: 600, height: 12000 })).id;
    const colors = ['#e11', '#1a1', '#22e', '#ee1', '#1ee', '#e1e'];
    await call(agent, 'html_write', { target_id: board, html: colors.map((c) => `<div style="height:2000px;flex:none;background:${c}"></div>`).join('') });
    const { paths } = await call(agent, 'export_file', { format: 'png', node_ids: [board] });
    const png = await pngStats(readFileSync(paths[0]));
    // Past 8192 rows a single capture started over with the first bands, so the last two colours were missing.
    expect([png.width, png.height, png.distinctColors]).toEqual([600, 12000, 6]);
  }, 60_000);

  it('design_lint suggests tokens of the kind a property takes, and components only for real repeats', async () => {
    const page = (await call(agent, 'page_create', { name: 'Lint' })).id;
    // All four are 16px; the spacing one comes first, so it used to be offered for everything.
    await call(agent, 'tokens_set', { tokens: [
      { name: 'space-4', kind: 'spacing', value: '16px' },
      { name: 'text-base', kind: 'font-size', value: '16px' },
      { name: 'radius-md', kind: 'radius', value: '16px' },
      { name: 'ink', kind: 'color', value: '#111111' },
    ] });
    const board = (await call(agent, 'artboard_create', { name: 'L', width: 800, page_id: page })).id;
    const swatch = await call(agent, 'html_write', { target_id: board, html: '<p style="font-size:16px;padding:16px;border-radius:16px;width:16px;color:#111111">Type</p>' });
    const lint = await call(agent, 'design_lint', { node_id: swatch.ids[0] });
    const tokenMessages = lint.issues.filter((i: { rule: string }) => i.rule === 'token').map((i: { message: string }) => i.message).sort();
    expect(tokenMessages).toEqual([
      'borderRadius is 16px, which equals the token --radius-md. Use var(--radius-md).',
      'color is #111111, which equals the token --ink. Use var(--ink).',
      'fontSize is 16px, which equals the token --text-base. Use var(--text-base).',
      'padding is 16px, which equals the token --space-4. Use var(--space-4).',
    ]);

    // Two sections that open the same way share a layout, not a component.
    const block = (t: string) => `<div style="padding:24px;flex:none"><h2 style="margin:0">${t}</h2><p style="margin:0">About ${t}</p></div>`;
    await call(agent, 'html_write', { target_id: board, html: `<section style="flex:none">${block('Colour')}<img alt="" style="width:40px;height:40px"></section><footer style="flex:none">${block('Type')}</footer>` });
    const apart = await call(agent, 'design_lint', { page_id: page });
    expect(apart.counts.repeated).toBe(0);
    // Side by side, the same block is a repeat.
    const row = (await call(agent, 'html_write', { target_id: board, html: `<div style="display:flex;gap:16px;flex:none">${block('Red')}${block('Blue')}</div>` })).ids[0];
    const together = await call(agent, 'design_lint', { node_id: row });
    expect(together.counts.repeated).toBe(1);
    expect(together.issues.find((i: { rule: string }) => i.rule === 'repeated').message).toContain('component_create');

    // A proposal is a copy on purpose.
    const card = (await call(agent, 'html_write', { target_id: board, html: '<article style="padding:16px;flex:none"><h3>Plan</h3><p>Copy</p><button>Buy</button><small>Note</small><span>More</span></article>' })).ids[0];
    await call(agent, 'proposal_create', { node_id: card });
    const withProposal = await call(agent, 'design_lint', { page_id: page });
    expect(withProposal.issues.filter((i: { rule: string; message: string }) => i.rule === 'repeated' && i.message.includes(card))).toEqual([]);
  }, 60_000);

  it('layer_attrs sets viewBox and other drawing attributes on an svg, and nothing scriptable', async () => {
    const board = (await call(agent, 'artboard_create', { name: 'Svg', width: 200, height: 200 })).id;
    const svg = (await call(agent, 'html_write', { target_id: board, html: '<svg width="48" height="48" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>' })).ids[0];
    const out = await call(agent, 'layer_attrs', { node_id: svg, attrs: { viewBox: '0 0 24 24', 'stroke-width': '2', fill: 'url(#g)', 'aria-label': 'Arrow' } });
    expect(out.svg).toEqual({ viewBox: '0 0 24 24', 'stroke-width': '2', fill: 'url(#g)' });
    const node = await call(agent, 'layer_get', { node_id: svg });
    expect(node.svg).toContain('viewBox="0 0 24 24"');
    expect(node.svg).not.toContain('0 0 10 10');
    expect(node.svg).toContain('stroke-width="2"');
    expect(node.attrs).toEqual({ 'aria-label': 'Arrow' });
    // Lower case is what the attribute is, written as SVG spells it; null takes it away.
    await call(agent, 'layer_attrs', { node_id: svg, attrs: { viewbox: '0 0 32 32', fill: null } });
    const again = await call(agent, 'layer_get', { node_id: svg });
    expect(again.svg).toContain('viewBox="0 0 32 32"');
    expect(again.svg).not.toMatch(/viewbox=|fill=/);

    for (const attrs of [{ onload: 'alert(1)' }, { viewBox: '0 0 1 1" onload="x' }, { fill: 'url(https://evil.example/x)' }, { stroke: 'javascript:alert(1)' }, { href: 'javascript:alert(1)' }, { style: 'x' }, { width: '10' }]) {
      const res = await callRaw(agent, 'layer_attrs', { node_id: svg, attrs });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('Nothing was changed');
    }
    expect((await call(agent, 'layer_get', { node_id: svg })).svg).toBe(again.svg);
    // On other layers these stay refused.
    const box = (await call(agent, 'html_write', { target_id: board, html: '<div style="width:10px;height:10px"></div>' })).ids[0];
    expect((await callRaw(agent, 'layer_attrs', { node_id: box, attrs: { viewBox: '0 0 1 1' } })).isError).toBe(true);
  }, 30_000);

  it('html_write keeps the white space of <pre> and white-space: pre, and of nothing else', async () => {
    const board = (await call(agent, 'artboard_create', { name: 'Code', width: 600 })).id;
    const out = await call(agent, 'html_write', { target_id: board, html: '<pre style="font-family:monospace;margin:0">\n  const a = 1;\n    return  a;\n</pre><p style="white-space:pre-wrap">   lead  two</p><p>  plain   text</p>' });
    const [pre, wrap, plain] = await Promise.all(out.ids.map((id: string) => call(agent, 'layer_get', { node_id: id })));
    expect(pre.text).toBe('  const a = 1;\n    return  a;');
    expect(pre.style.whiteSpace).toBe('pre');
    expect(wrap.text).toBe('   lead  two');
    expect(plain.text).toBe('plain text');
    // The spaces are there when it renders, too.
    const computed = await call(agent, 'layer_styles_computed', { node_ids: [pre.id], properties: ['white-space'] });
    expect(computed[pre.id].style['white-space']).toBe('pre');
  }, 30_000);

  it('layer_find compares style values as CSS', async () => {
    const page = (await call(agent, 'page_create', { name: 'Find' })).id;
    const board = (await call(agent, 'artboard_create', { name: 'F', width: 400, page_id: page })).id;
    const id = (await call(agent, 'html_write', { target_id: board, html: '<div style="opacity:.55;margin:0px;color:#ABCDEF;box-shadow:0 4px 12px rgba(0, 0, 0, .1)">x</div><div style="opacity:0.5">y</div>' })).ids[0];
    const found = async (style: Record<string, string>) => (await call(agent, 'layer_find', { style, within: page })).layers.map((l: { id: string }) => l.id);
    for (const style of [{ opacity: '0.55' }, { opacity: '.55' }, { opacity: '0.550' }, { margin: '0' }, { margin: '0px' }, { color: '#abcdef' }, { color: 'rgb(171, 205, 239)' }, { 'box-shadow': 'rgba(0,0,0,0.1)' }] as Record<string, string>[]) {
      expect([style, await found(style)]).toEqual([style, [id]]);
    }
    // 0.5 is another value than 0.55.
    expect((await found({ opacity: '0.5' })).length).toBe(1);
    expect(await found({ opacity: '0.5' })).not.toContain(id);
  }, 30_000);

  it('html_write drops CSS a browser would ignore and says what, without failing', async () => {
    const board = (await call(agent, 'artboard_create', { name: 'Css', width: 400 })).id;
    const out = await call(agent, 'html_write', { target_id: board, html: '<style>.c::after{content:"";colr:red}</style><div class="c" style="padding:12;gap:8px;display:flexbox;font-weight:semibold;color:#ABCDEF;width:calc(100% - 8px)">x</div>' });
    expect(out.ids).toHaveLength(1);
    const warning = out.warnings.find((w: string) => w.includes('dropped'));
    expect(warning).toContain('4 CSS declarations were dropped');
    expect(warning).toContain('padding: 12 on <div>');
    expect(warning).toContain('(12 needs a unit, such as 12px)');
    expect(warning).toContain('display: flexbox');
    expect(warning).toContain('font-weight: semibold');
    expect(warning).toContain('colr: red on <div> "x" ::after (not a CSS property)');
    const node = await call(agent, 'layer_get', { node_id: out.ids[0] });
    expect(node.style).toEqual({ gap: '8px', color: '#ABCDEF', width: 'calc(100% - 8px)' });
    expect(node.rules).toEqual({ '::after': { content: '""' } });
    // Valid CSS says nothing.
    const clean = await call(agent, 'html_write', { target_id: board, html: '<p style="margin:0 auto;font-weight:600">ok</p>' });
    expect(clean.warnings).toBeUndefined();
  }, 30_000);

  it('layer_move takes an artboard to another page in one undo step, with its id, contents and comments', async () => {
    const from = (await call(agent, 'page_create', { name: 'From' })).id;
    const to = (await call(agent, 'page_create', { name: 'To' })).id;
    const there = (await call(agent, 'artboard_create', { name: 'Already there', width: 500, page_id: to })).id;
    const board = (await call(agent, 'artboard_create', { name: 'Traveller', width: 300, y: 40, page_id: from })).id;
    const inner = (await call(agent, 'html_write', { target_id: board, html: '<section style="width:100%;padding:24px"><h2>Inside</h2></section>' })).ids[0];
    const thread = (await call(agent, 'comment_add', { node_id: inner, text: 'About this' })).id;
    const pageOfThread = async () => (await call(agent, 'comments_list', {})).find((t: { id: string }) => t.id === thread)?.pageId;

    const moved = await call(agent, 'layer_move', { node_ids: [board], page_id: to });
    expect(moved).toMatchObject({ moved: [board], parents: [to], page_id: to });
    const node = await call(agent, 'layer_get', { node_id: board });
    expect(node.page).toBe(to);
    // Placed to the right of what was there, at its own height.
    expect(node.style).toMatchObject({ position: 'absolute', left: '580px', top: '40px', width: '300px' });
    expect((await call(agent, 'layer_get', { node_id: inner })).page).toBe(to);
    expect(await pageOfThread()).toBe(to);
    expect((await call(agent, 'layer_tree', { page_id: from })).toString()).toContain('(empty)');
    expect(there).toBeTruthy();

    // A layer inside a frame becomes an artboard of its own there, as wide as it was.
    const section = await call(agent, 'layer_move', { node_ids: [inner], page_id: from, x: 0, y: 0 });
    expect(section.parents).toEqual([from]);
    const loose = await call(agent, 'layer_get', { node_id: inner });
    expect(loose).toMatchObject({ artboard: true, page: from, style: { position: 'absolute', left: '0px', top: '0px', width: '300px' } });

    // Each move is one step back.
    await call(agent, 'agent_undo');
    expect((await call(agent, 'layer_get', { node_id: inner })).parent).toBe(board);
    expect((await call(agent, 'layer_get', { node_id: inner })).artboard).toBeUndefined();
    await call(agent, 'agent_undo');
    const back = await call(agent, 'layer_get', { node_id: board });
    expect(back.page).toBe(from);
    expect(back.style).toMatchObject({ left: '0px', top: '40px' });
    expect(await pageOfThread()).toBe(from);

    const refused = await callRaw(agent, 'layer_move', { node_ids: [board], page_id: 'nope' });
    expect(refused.content[0]!.text).toMatch(/No page with id nope/);
  }, 60_000);
});
