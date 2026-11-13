import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { nodeToHtml, tokensCss } from '@bogen/core';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

describe('design system over MCP', () => {
  let h: Harness;
  let agent: Client;
  let fileId: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'designer');
    ({ id: fileId } = await call(agent, 'file_create', { name: 'System' }));
  }, 60000);

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  const room = () => h.server.rooms.get(fileId);

  async function makeButton(name: string) {
    const { ids } = await call(agent, 'html_write', { file_id: fileId, html: `<button data-name="${name}" style="display:inline-flex;gap:8px;padding:8px 16px;background:#123456;color:#ffffff"><span data-name="Label">Buy</span><span data-name="Badge" style="width:8px;height:8px;display:block;background:#f00"></span></button>` });
    return ids[0] as string;
  }

  it('makes a component, and its instances follow a main edit made with the usual tools', async () => {
    const main = await makeButton('Button');
    const made = await call(agent, 'component_create', { node_ids: [main], name: 'Button', description: 'Primary action', props: [{ name: 'label', type: 'text', target: 'Label' }, { name: 'badge', type: 'boolean', target: 'Badge' }] });
    expect(made.props.map((p: { name: string }) => p.name)).toEqual(['label', 'badge']);
    const { doc } = await room();
    const page2 = await call(agent, 'page_create', { name: 'Other' });
    const a = await call(agent, 'instance_create', { component: 'Button', x: 400, y: 0 });
    const b = await call(agent, 'instance_create', { component: main, page_id: page2.id, props: { label: 'Elsewhere', badge: false } });
    expect(a.controls.find((c: { name: string }) => c.name === 'label').value).toBe('Buy');
    expect(nodeToHtml(doc, b.id)).toContain('Elsewhere');
    await call(agent, 'layer_style', { node_ids: [main], style: { 'background-color': '#ff0000' } });
    const label = doc.getChildren(main)[0]!.id;
    await call(agent, 'layer_text', { node_id: label, text: 'Sale' });
    expect(doc.getNode(a.id)?.style.backgroundColor).toBe('#ff0000');
    expect(doc.getNode(b.id)?.style.backgroundColor).toBe('#ff0000');
    expect(nodeToHtml(doc, a.id)).toContain('Sale');
    expect(nodeToHtml(doc, b.id)).toContain('Elsewhere');
    const list = await call(agent, 'component_list', {});
    expect(list.components[0]).toMatchObject({ name: 'Button', instances: 2, description: 'Primary action' });
    const got = await call(agent, 'component_get', { component: 'Button' });
    expect(got.instance_ids.sort()).toEqual([a.id, b.id].sort());
    expect(got.html).toContain('Sale');
    expect(got.tree).toContain('main');
  });

  it('html_write takes x-instance, and reports what does not exist', async () => {
    const page = await call(agent, 'page_create', { name: 'Html' });
    const board = await call(agent, 'artboard_create', { name: 'Board', page_id: page.id, width: 800 });
    const out = await call(agent, 'html_write', { target_id: board.id, html: '<section><x-instance component="Button" prop-label="From html" prop-badge="false" style="margin:4px"></x-instance><x-instance component="Button"></x-instance></section>' });
    const { doc } = await room();
    const insts = doc.getChildren(out.ids[0]);
    expect(insts.every((n) => n.instanceOf)).toBe(true);
    expect(nodeToHtml(doc, insts[0]!.id)).toContain('From html');
    expect(insts[0]!.style.margin).toBe('4px');
    expect(out.tree).toContain('instance of');
    const missing = await callRaw(agent, 'html_write', { target_id: board.id, html: '<x-instance component="Ghost"></x-instance>' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain('Button');
    const wrong = await callRaw(agent, 'html_write', { target_id: board.id, html: '<x-instance component="Button" prop-nope="1"></x-instance>' });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0]!.text).toContain('nope');
  });

  it('overrides through instance_set and through the usual tools on inner ids, then resets and detach', async () => {
    const { doc } = await room();
    const main = (await call(agent, 'component_get', { component: 'Button' })).id;
    const a = await call(agent, 'instance_create', { component: main, x: 900 });
    const label = doc.getChildren(main)[0]!.id;
    const out = await call(agent, 'instance_set', { node_id: a.id, overrides: [{ layer: 'Label', field: 'text', value: 'Over' }, { layer: 'Badge', field: 'hidden', value: true }, { layer: label, field: 'style.color', value: '#00ff00' }] });
    expect(out.overrides.length).toBe(3);
    await call(agent, 'layer_style', { node_ids: [`${a.id}/${label}`], style: { 'font-size': '20px' } });
    await call(agent, 'layer_text', { node_id: `${a.id}/${label}`, text: 'Typed' });
    const inner = await call(agent, 'layer_get', { node_id: `${a.id}/${label}` });
    expect(inner.text).toBe('Typed');
    expect(inner.overridden.map((o: { field: string }) => o.field)).toContain('style.fontSize');
    expect(doc.rawNode(label)?.text).toBe('Sale');
    const tree = await call(agent, 'layer_tree', { node_id: a.id, depth: 3 });
    expect(tree).toContain(`${a.id}/${label}`);
    const moved = await callRaw(agent, 'layer_move', { node_ids: [`${a.id}/${label}`], parent_id: main });
    expect(moved.isError).toBe(true);
    expect(moved.content[0]!.text).toContain('inside an instance');
    const key = out.overrides.find((o: { field: string }) => o.field === 'hidden').key;
    const reset = await call(agent, 'instance_set', { node_id: a.id, reset: [key] });
    expect(reset.overrides.some((o: { field: string }) => o.field === 'hidden')).toBe(false);
    const cleared = await call(agent, 'instance_set', { node_id: a.id, reset_all: true });
    expect(cleared.overrides).toEqual([]);
    expect(doc.getNode(`${a.id}/${label}`)?.text).toBe('Sale');
    await call(agent, 'layer_text', { node_id: `${a.id}/${label}`, text: 'Kept' });
    const undone = await call(agent, 'agent_undo', {});
    expect(undone.undone).toBe(true);
    expect(doc.getNode(`${a.id}/${label}`)?.text).toBe('Sale');
    await call(agent, 'layer_text', { node_id: `${a.id}/${label}`, text: 'Kept' });
    await call(agent, 'instance_detach', { node_id: a.id });
    expect(doc.rawNode(a.id)?.instanceOf).toBeUndefined();
    expect(doc.getChildren(a.id)[0]?.text).toBe('Kept');
    await call(agent, 'layer_text', { node_id: label, text: 'Sale again' });
    expect(doc.getChildren(a.id)[0]?.text).toBe('Kept');
  });

  it('an image source can be a prop or an override, and passes the same rules', async () => {
    const { ids } = await call(agent, 'html_write', { html: '<figure data-name="Figure" style="display:flex;margin:0"><img data-name="Pic" alt="x" src="data:image/png;base64,iVBORw0KGgo=" style="width:40px;height:40px"><figcaption data-name="Cap">Cap</figcaption></figure>' });
    await call(agent, 'component_create', { node_ids: ids, name: 'Figure', props: [{ name: 'image', type: 'image', target: 'Pic' }] });
    const a = await call(agent, 'instance_create', { component: 'Figure', x: 5000, props: { image: 'https://example.com/a.png' } });
    const { doc } = await room();
    expect(nodeToHtml(doc, a.id)).toContain('https://example.com/a.png');
    const b = await call(agent, 'instance_create', { component: 'Figure', x: 5100 });
    const set = await call(agent, 'instance_set', { node_id: b.id, overrides: [{ layer: 'Pic', field: 'src', value: 'https://example.com/b.png' }] });
    expect(set.overrides[0].field).toBe('src');
    expect(nodeToHtml(doc, b.id)).toContain('https://example.com/b.png');
    const evil = await callRaw(agent, 'instance_set', { node_id: b.id, overrides: [{ layer: 'Pic', field: 'src', value: 'javascript:alert(1)' }] });
    expect(evil.isError).toBe(true);
    const bad = await callRaw(agent, 'instance_set', { node_id: b.id, overrides: [{ layer: 'Pic', field: 'onclick', value: 'x' }] });
    expect(bad.isError).toBe(true);
  });

  it('an image placeholder shows its size, and with an image prop still exports as an img', async () => {
    const { ids } = await call(agent, 'html_write', { html: '<figure data-name="Polaroid" style="display:flex;margin:0"><img data-name="Photo" alt="Photo" style="width:64px;height:48px"></figure>' });
    const { doc } = await room();
    expect(nodeToHtml(doc, ids[0])).toMatch(/<span role="img" aria-label="Photo, 64 × 48" style="[^"]*display:flex[^"]*">Photo, 64 × 48<\/span>/);
    await call(agent, 'component_create', { node_ids: ids, name: 'Polaroid', props: [{ name: 'photo', type: 'image', target: 'Photo' }] });
    const code = await call<string>(agent, 'code_get', { node_id: ids[0], format: 'react-inline' });
    expect(code).toMatch(/<img[^>]*src=\{[^}]*photo/);
  });

  it('variants: a variant set, switching by prop, and code with a union', async () => {
    const main = await makeButton('Chip');
    await call(agent, 'component_create', { node_ids: [main], name: 'Chip', props: [{ name: 'label', type: 'text', target: 'Label' }] });
    const added = await call(agent, 'component_update', { component: 'Chip', add_variant: { size: 'lg' }, base_variant: { size: 'sm' } });
    expect(added.added_variant).toBeTruthy();
    await call(agent, 'layer_style', { node_ids: [added.added_variant], style: { padding: '24px' } });
    const a = await call(agent, 'instance_create', { component: 'Chip', variant: { size: 'sm' }, x: 1200, props: { label: 'Keeps' } });
    expect(a.controls[0]).toMatchObject({ name: 'size', type: 'variant', value: 'sm', options: ['sm', 'lg'] });
    const out = await call(agent, 'instance_set', { node_id: a.id, props: { size: 'lg' } });
    expect(out.component).toBe(added.added_variant);
    const { doc } = await room();
    expect(doc.getNode(a.id)?.style.padding).toBe('24px');
    expect(nodeToHtml(doc, a.id)).toContain('Keeps');
    const code = await call(agent, 'code_get', { node_id: main, format: 'react-tailwind' });
    expect(code).toContain('size?: "sm" | "lg";');
    expect(code).toContain('export function Chip(');
    const usage = await call(agent, 'code_get', { node_id: a.id, format: 'react-inline' });
    expect(usage).toContain('<Chip size="lg"');
    expect(usage).toContain('label="Keeps"');
    const missing = await callRaw(agent, 'instance_set', { node_id: a.id, props: { size: 'xl' } });
    expect(missing.isError).toBe(true);
  });

  it('slots from html, filled by x-instance children and through the slot id', async () => {
    const { ids } = await call(agent, 'html_write', { html: '<article data-name="Card" style="padding:16px"><h3 data-name="Title">Card</h3><div data-name="Body" data-slot="body"><p>Default</p></div><div data-name="Foot" data-slot="foot"></div></article>' });
    await call(agent, 'component_create', { node_ids: ids, name: 'Card' });
    const page = await call(agent, 'page_create', { name: 'Cards' });
    const board = await call(agent, 'artboard_create', { name: 'B', page_id: page.id, width: 600 });
    const out = await call(agent, 'html_write', { target_id: board.id, html: '<x-instance component="Card"><p slot="body">Mine</p><span slot="foot">Footer</span></x-instance>' });
    const { doc } = await room();
    const html = nodeToHtml(doc, out.ids[0]);
    expect(html).toContain('Mine');
    expect(html).toContain('Footer');
    expect(html).not.toContain('Default');
    const unknown = await callRaw(agent, 'html_write', { target_id: board.id, html: '<x-instance component="Card"><p slot="nope">x</p></x-instance>' });
    expect(unknown.isError).toBe(true);
    const shot = await agent.callTool({ name: 'canvas_screenshot', arguments: { node_id: out.ids[0] } });
    expect((shot.content as { type: string }[])[0]!.type).toBe('image');
  });

  it('renders inner layers in the browser under the same ids', async () => {
    const { doc } = await room();
    const main = (await call(agent, 'component_get', { component: 'Button' })).id;
    const a = await call(agent, 'instance_create', { component: main, x: 2000, style: { width: '200px' } });
    const label = doc.getChildren(main)[0]!.id;
    const computed = await call(agent, 'layer_styles_computed', { node_ids: [a.id, `${a.id}/${label}`], properties: ['width', 'color'] });
    expect(computed[a.id].style.width).toBe('200px');
    expect(computed[`${a.id}/${label}`].box.width).toBeGreaterThan(0);
  });

  it('design_lint flags repeated structures, and not instances', async () => {
    const page = await call(agent, 'page_create', { name: 'Repeat' });
    const board = await call(agent, 'artboard_create', { name: 'B', page_id: page.id, width: 900 });
    const card = (t: string) => `<article style="padding:16px;background:#eee"><h3 style="margin:0">${t}</h3><p style="margin:0">Copy ${t}</p></article>`;
    await call(agent, 'html_write', { target_id: board.id, html: `<section style="display:flex;gap:16px">${card('One')}${card('Two')}${card('Three')}</section>` });
    const lint = await call(agent, 'design_lint', { page_id: page.id });
    const repeated = lint.issues.filter((i: { rule: string }) => i.rule === 'repeated');
    expect(lint.counts.repeated).toBeGreaterThan(0);
    expect(repeated[0].message).toContain('3 layers share');
    expect(repeated[0].message).toContain('component_create');
    const clean = await call(agent, 'page_create', { name: 'Clean' });
    const b2 = await call(agent, 'artboard_create', { name: 'B', page_id: clean.id, width: 900 });
    await call(agent, 'html_write', { target_id: b2.id, html: '<section style="display:flex"><x-instance component="Button"></x-instance><x-instance component="Button"></x-instance><x-instance component="Button"></x-instance></section>' });
    const lint2 = await call(agent, 'design_lint', { page_id: clean.id });
    expect(lint2.counts.repeated).toBe(0);
  });

  it('modes: per-mode tokens, a mode per layer and page, export in CSS and Tailwind', async () => {
    await call(agent, 'tokens_set', { tokens: [
      { name: 'bg', kind: 'color', value: '#ffffff', modes: { dark: '#000000' } },
      { name: 'gap', kind: 'spacing', value: '16px', modes: { compact: '8px' } },
    ] });
    const modes = await call(agent, 'modes_list', {});
    expect(modes.modes.map((m: { name: string }) => m.name)).toEqual(['light', 'dark', 'compact']);
    const got = await call(agent, 'tokens_get', {});
    expect(got.find((t: { name: string }) => t.name === 'bg').modes).toEqual({ dark: '#000000' });
    const css = await call(agent, 'tokens_export', { format: 'css' });
    expect(css).toContain('[data-mode="dark"] {');
    expect(css).toContain('--bg: #000000;');
    const classy = await call(agent, 'tokens_export', { format: 'tailwind', mode_selector: '.{mode}' });
    expect(classy).toContain('.dark {');
    expect(classy).toContain('@theme inline');
    await call(agent, 'tokens_from_css', { css: '.dark { --bg: #0a0a0a; --extra: #123 }', selector: '.dark', mode: 'dark' });
    const afterCss = await call(agent, 'tokens_get', {});
    expect(afterCss.find((t: { name: string }) => t.name === 'bg')).toMatchObject({ value: '#ffffff', modes: { dark: '#0a0a0a' } });
    expect(afterCss.find((t: { name: string }) => t.name === 'extra')).toMatchObject({ value: '#123', modes: { dark: '#123' } });
    const page = await call(agent, 'page_create', { name: 'Modes' });
    const light = await call(agent, 'artboard_create', { name: 'Light', page_id: page.id, width: 200, height: 100, background: 'var(--bg)' });
    const dark = await call(agent, 'artboard_create', { name: 'Dark', page_id: page.id, width: 200, height: 100, background: 'var(--bg)' });
    const set = await call(agent, 'mode_set', { node_ids: [dark.id], mode: 'dark' });
    expect(set.layers[0].mode).toBe('dark');
    const computed = await call(agent, 'layer_styles_computed', { node_ids: [light.id, dark.id], properties: ['background-color'] });
    expect(computed[light.id].style['background-color']).toBe('rgb(255, 255, 255)');
    expect(computed[dark.id].style['background-color']).toBe('rgb(10, 10, 10)');
    await call(agent, 'mode_set', { page_id: page.id, mode: 'dark' });
    const pageComputed = await call(agent, 'layer_styles_computed', { node_ids: [light.id], properties: ['background-color'] });
    expect(pageComputed[light.id].style['background-color']).toBe('rgb(10, 10, 10)');
    const refused = await callRaw(agent, 'mode_set', { page_id: page.id, mode: 'nope' });
    expect(refused.isError).toBe(true);
    await call(agent, 'mode_set', { page_id: page.id, mode: null });
    expect(await call(agent, 'design_system_css', { mode_selector: '[data-theme="{mode}"]' })).toContain('[data-theme="dark"]');
  });

  it('text styles: apply, update, class in the export, html attribute', async () => {
    const made = await call(agent, 'text_style_set', { name: 'Heading 1', style: { 'font-family': 'Georgia, serif', 'font-size': '40px', 'font-weight': '700', 'line-height': '1.1', 'letter-spacing': '-0.5px' } });
    expect(made.class).toBe('ts-heading-1');
    const page = await call(agent, 'page_create', { name: 'Type' });
    const board = await call(agent, 'artboard_create', { name: 'B', page_id: page.id, width: 600 });
    const { ids } = await call(agent, 'html_write', { target_id: board.id, html: '<h1 text-style="heading-1">Title</h1><p style="font-size:9px">Other</p>' });
    const { doc } = await room();
    expect(doc.getNode(ids[0])?.textStyle).toBe('heading-1');
    await call(agent, 'text_style_apply', { node_ids: [ids[1]], style: 'Heading 1' });
    expect(doc.getNode(ids[1])?.style.fontSize).toBeUndefined();
    const before = await call(agent, 'layer_styles_computed', { node_ids: ids, properties: ['font-size', 'font-family'] });
    expect(before[ids[0]].style['font-size']).toBe('40px');
    expect(before[ids[1]].style['font-size']).toBe('40px');
    await call(agent, 'text_style_set', { name: 'Heading 1', style: { 'font-size': '50px' } });
    const after = await call(agent, 'layer_styles_computed', { node_ids: ids, properties: ['font-size'] });
    expect(after[ids[1]].style['font-size']).toBe('50px');
    const css = await call(agent, 'tokens_export', { format: 'css' });
    expect(css).toContain('.ts-heading-1 {');
    expect(css).toContain('font-size: 50px;');
    expect(await call(agent, 'code_get', { node_id: ids[0], format: 'react-inline' })).toContain('.ts-heading-1');
    const listed = await call(agent, 'text_styles_list', {});
    expect(listed[0].style.fontSize).toBe('50px');
    const bad = await callRaw(agent, 'text_style_set', { name: 'Bad', style: { color: 'red' } });
    expect(bad.isError).toBe(true);
    await call(agent, 'text_style_delete', { style: 'Heading 1' });
    expect(doc.getNode(ids[0])?.textStyle).toBeUndefined();
    expect(doc.getNode(ids[0])?.style.fontSize).toBe('50px');
  });

  it('icons: search and insert editable, sanitized vector layers', async () => {
    const found = await call(agent, 'icon_search', { query: 'settings' });
    expect(found.icons[0]).toBe('settings');
    expect((await call(agent, 'icon_search', { query: 'close' })).icons).toContain('x');
    const page = await call(agent, 'page_create', { name: 'Icons' });
    const board = await call(agent, 'artboard_create', { name: 'B', page_id: page.id, width: 300, height: 100 });
    const icon = await call(agent, 'icon_insert', { name: 'arrow-right', parent_id: board.id, size: 32, color: '#ff0000', stroke_width: 1.5 });
    const { doc } = await room();
    const node = doc.getNode(icon.id)!;
    expect(node.type).toBe('svg');
    expect(node.style.width).toBe('32px');
    expect(node.svg).toContain('stroke="#ff0000"');
    expect(node.svg).toContain('<path');
    const wrong = await callRaw(agent, 'icon_insert', { name: 'arow-right', parent_id: board.id });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0]!.text).toContain('arrow-right');
    const computed = await call(agent, 'layer_styles_computed', { node_ids: [icon.id], properties: ['width'] });
    expect(computed[icon.id].box.width).toBe(32);
  });

  it('icons: searches and places the other sets, stroked and filled, and none of their logos', async () => {
    expect((await call(agent, 'icon_search', { query: 'home', set: 'tabler' })).icons[0]).toBe('tabler:home');
    expect((await call(agent, 'icon_search', { query: 'house', set: 'phosphor' })).icons[0]).toBe('phosphor:house');
    expect((await call(agent, 'icon_search', { query: 'add home', set: 'material-symbols' })).icons[0]).toBe('material-symbols:add_home');
    // Every set takes turns in a search of all of them.
    const all = (await call(agent, 'icon_search', { query: 'home', set: 'all', limit: 12 })).icons as string[];
    for (const set of ['phosphor:', 'tabler:', 'heroicons:', 'heroicons-solid:', 'material-symbols:']) expect(all.some((n) => n.startsWith(set)), set).toBe(true);
    expect(all).toContain('house');
    // Logos are other companies' trademarks, so the sets leave them out.
    expect((await call(agent, 'icon_search', { query: 'github', set: 'all' })).icons.filter((n: string) => /logo|brand/.test(n))).toEqual([]);
    const page = await call(agent, 'page_create', { name: 'More icons' });
    const board = await call(agent, 'artboard_create', { name: 'B', page_id: page.id, width: 300, height: 100 });
    const { doc } = await room();
    const outline = await call(agent, 'icon_insert', { name: 'heroicons:home', parent_id: board.id });
    expect(doc.getNode(outline.id)!.svg).toMatch(/stroke-width="1.5"/);
    expect(doc.getNode(outline.id)!.svg).toContain('viewBox="0 0 24 24"');
    const filled = await call(agent, 'icon_insert', { name: 'material-symbols:home', parent_id: board.id, color: '#123456' });
    expect(doc.getNode(filled.id)!.svg).toContain('fill="#123456"');
    expect(doc.getNode(filled.id)!.svg).toContain('viewBox="0 -960 960 960"');
    expect(doc.getNode(filled.id)!.name).toBe('material-symbols:home');
    const wrong = await callRaw(agent, 'icon_insert', { name: 'tabler:hom', parent_id: board.id });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0]!.text).toContain('tabler:home');
    expect((await callRaw(agent, 'icon_insert', { name: 'remix:home', parent_id: board.id })).isError).toBe(true);
  });

  it('batch: components and instances in one atomic step, with references', async () => {
    const out = await call(agent, 'batch', { steps: [
      { tool: 'html_write', args: { html: '<div data-name="Tag" style="padding:4px;display:flex"><span data-name="T">Tag</span></div>' }, as: 'made' },
      { tool: 'component_create', args: { node_ids: '$made.ids', props: [{ name: 'text', type: 'text', target: 'T' }] }, as: 'comp' },
      { tool: 'instance_create', args: { component: '$comp.id', x: 3000, props: { text: 'One' } } },
    ] }).catch((e: Error) => e);
    if (out instanceof Error) throw out;
    const list = await call(agent, 'component_list', { query: 'Tag' });
    expect(list.total).toBe(1);
    expect(list.components[0].instances).toBe(1);
    const undo = await call(agent, 'agent_undo', {});
    expect(undo.undone).toBe(true);
    expect((await call(agent, 'component_list', { query: 'Tag' })).total).toBe(0);
  });

  it('old guide topics stay, and the new one tells agents to reuse', async () => {
    const guide = await call(agent, 'guide_get', { topic: 'components' });
    expect(guide).toContain('x-instance');
    expect(guide).toContain('component_list');
    const init = agent.getInstructions();
    expect(init).toContain('Reuse, do not copy');
  });
});

describe('a second capture in another colour scheme fills in a mode', () => {
  let h: Harness;
  let site: Server;
  let url: string;

  const PAGE = `<!doctype html><html><head><title>Themed</title><style>
:root { --bg: #fafafa; --ink: #111111; --accent: #0055ff }
@media (prefers-color-scheme: dark) { :root { --bg: #101010; --ink: #eeeeee; --accent: #66aaff } }
body { margin: 0; background: var(--bg); color: var(--ink) }
.cta { background: var(--accent); color: #ffffff; padding: 8px }
/* Colours the page never made variables of. */
.card { background: #f0f0f0; color: #222222; border: 1px solid #cccccc; padding: 16px }
.same { color: #123456 }
@media (prefers-color-scheme: dark) { .card { background: #1c1c1c; color: #dddddd; border: 1px solid #333333 } }
</style></head><body><h1>Title</h1><button class="cta">Go</button><div class="card"><p>Inner</p></div><p class="same">Same</p></body></html>`;

  beforeAll(async () => {
    site = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE));
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    h = await startServer();
  }, 60000);

  afterAll(async () => {
    await new Promise((r) => site.close(r));
    await h.cleanup();
  });

  it('leaves no second palette: values land in the mode, and each artboard shows its own colours', async () => {
    const fileId = h.server.storage.create('Themed').id;
    const first = await h.server.capturePageInto(fileId, { url, width: 800, colorScheme: 'light', name: 'Light' });
    expect(first.modes).toBeUndefined();
    const second = await h.server.capturePageInto(fileId, { url, width: 800, colorScheme: 'dark', name: 'Dark' });
    expect(second.modes).toMatchObject({ mode: 'dark', base: 'light', pair: first.nodeId });
    expect(second.modes!.from_variables).toBe(3);
    expect(second.modes!.from_comparison).toBeGreaterThan(0);
    const { doc } = await h.server.rooms.get(fileId);
    const tokens = doc.getTokens();
    expect(tokens.find((t) => t.name === 'bg')).toMatchObject({ value: '#fafafa', modes: { dark: '#101010' } });
    expect(tokens.find((t) => t.name === 'accent')).toMatchObject({ value: '#0055ff', modes: { dark: '#66aaff' } });
    expect(doc.getNode(second.nodeId)?.mode).toBe('dark');
    expect(doc.getNode(first.nodeId)?.mode).toBe('light');
    // No colour that differs between the schemes is left hard-coded in either artboard.
    const colours = (id: string) => doc.descendants(id).flatMap((n) => Object.entries(n.style)).filter(([k]) => /^(color|backgroundColor|border)$/.test(k)).map(([, v]) => v);
    const hard = [...colours(first.nodeId), ...colours(second.nodeId)].filter((v) => /rgb|#/.test(v) && !v.includes('var('));
    expect(hard.filter((v) => !v.includes('18, 52, 86') && !v.includes('255, 255, 255'))).toEqual([]);
    // What stays the same in both schemes stays hard-coded.
    expect(hard.join()).toContain('18, 52, 86');
    expect(tokensCss(doc)).toContain('[data-mode="dark"]');
    const card = (root: string) => doc.descendants(root).find((n) => n.name === 'card' || (n.style.padding === '16px'))!.id;
    const computed = await h.server.renderer.computed(doc, [card(first.nodeId), card(second.nodeId), first.nodeId, second.nodeId], ['background-color', 'color']);
    expect(computed[card(first.nodeId)]!.style['background-color']).toBe('rgb(240, 240, 240)');
    expect(computed[card(second.nodeId)]!.style['background-color']).toBe('rgb(28, 28, 28)');
    expect(computed[first.nodeId]!.style['background-color']).toBe('rgb(250, 250, 250)');
    expect(computed[second.nodeId]!.style['background-color']).toBe('rgb(16, 16, 16)');
  }, 120000);

  it('a site with no difference says so', async () => {
    const plain = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>x</title><body style="background:#fff"><p style="color:#000">Same</p>'));
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
    const at = `http://127.0.0.1:${(plain.address() as AddressInfo).port}/`;
    const fileId = h.server.storage.create('Plain').id;
    await h.server.capturePageInto(fileId, { url: at, width: 400, colorScheme: 'light' });
    const second = await h.server.capturePageInto(fileId, { url: at, width: 400, colorScheme: 'dark' });
    expect(second.modes?.note).toContain('prefers-color-scheme');
    await new Promise((r) => plain.close(r));
  }, 120000);
});
