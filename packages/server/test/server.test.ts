import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { BogenDoc, Y } from '@bogen/core';
import { call, callRaw, connectAgent, pngStats, startServer, until, type Harness } from './helpers.ts';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function peer(base: string, fileId: string) {
  const y = new Y.Doc();
  const provider = new WebsocketProvider(`${base.replace('http', 'ws')}/sync`, fileId, y, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  return { y, doc: new BogenDoc(y), provider, close: () => { provider.destroy(); y.destroy(); } };
}

describe('Bogen server', () => {
  let h: Harness;
  let agent: Client;
  let file: string;
  let page: string;
  let artboard: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'test-agent');
    const created = await call(agent, 'file_create', { name: 'Landing' });
    file = created.id;
    page = created.pages[0].id;
    artboard = (await call(agent, 'artboard_create', { name: 'Home', width: 800 })).id;
  });

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('lists tools with descriptions and teaches design in its instructions', async () => {
    const { tools } = await agent.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of ['file_list', 'file_open', 'file_create', 'file_rename', 'page_list', 'page_create', 'page_rename', 'page_delete', 'page_reorder', 'context_get', 'layer_tree', 'layer_get', 'layer_find', 'layer_styles_computed', 'canvas_screenshot', 'code_get', 'artboard_create', 'html_write', 'layer_style', 'layer_text', 'layer_rename', 'layer_move', 'layer_duplicate', 'layer_delete', 'layer_set_flags', 'tokens_get', 'tokens_set', 'tokens_delete', 'tokens_from_css', 'comments_list', 'comment_add', 'comment_reply', 'export_file', 'fonts_list', 'asset_upload', 'guide_get', 'design_lint']) {
      expect(names).toContain(expected);
    }
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(20);
    expect(agent.getInstructions()).toMatch(/small chunks/);
    // Only a person resolves or reopens a thread: no tool for it, and nothing that tells an agent to.
    expect(names).not.toContain('comment_resolve');
    expect(JSON.stringify(tools)).not.toMatch(/comment_resolve(?!d)/);
    expect(agent.getInstructions()).not.toMatch(/comment_resolve|resolve them/);
  });

  it('writes html as layers and shows them in the tree', async () => {
    const written = await call(agent, 'html_write', {
      target_id: artboard,
      html: '<section data-name="Hero" style="display:flex;flex-direction:column;gap:16px;padding:48px;background:#101820"><h1 style="color:#fff;font-size:48px">Hello Bogen</h1><p style="color:#ddd">Real HTML</p></section>',
    });
    expect(written.ids).toHaveLength(1);
    const tree = await call<string>(agent, 'layer_tree', { depth: 4 });
    expect(tree).toContain('Hello Bogen');
    expect(tree).toContain('<section>');
    const found = await call(agent, 'layer_find', { text: 'hello' });
    expect(found.layers[0].tag).toBe('h1');
    const byStyle = await call(agent, 'layer_find', { style: { 'font-size': '48px' } });
    expect(byStyle.total).toBe(1);
    const got = await call(agent, 'layer_get', { node_id: found.layers[0].id });
    expect(got.text).toBe('Hello Bogen');
  });

  it('supports every html_write mode', async () => {
    const host = (await call(agent, 'html_write', { target_id: artboard, html: '<div data-name="Modes" style="display:flex"><span style="color:red">a</span></div>' })).ids[0];
    await call(agent, 'html_write', { target_id: host, mode: 'append', html: '<b style="color:red">c</b>' });
    await call(agent, 'html_write', { target_id: host, mode: 'prepend', html: '<i style="color:red">start</i>' });
    await call(agent, 'html_write', { target_id: host, mode: 'into', index: 2, html: '<em style="color:red">b</em>' });
    const texts = async () => {
      const room = await h.server.rooms.get(file);
      return room.doc.getChildren(host).map((n) => n.text);
    };
    expect(await texts()).toEqual(['start', 'a', 'b', 'c']);
    const room = await h.server.rooms.get(file);
    const victim = room.doc.getChildren(host)[1]!.id;
    await call(agent, 'html_write', { target_id: victim, mode: 'replace', html: '<u style="color:red">A</u>' });
    expect(await texts()).toEqual(['start', 'A', 'b', 'c']);
    await call(agent, 'layer_delete', { node_ids: [host] });
  });

  it('warns about things the canvas drops, and sanitizes them', async () => {
    const out = await call(agent, 'html_write', { target_id: artboard, html: '<div class="p-4" onclick="alert(1)"><img src="x" onerror="alert(1)"><script>alert(1)</script>Safe</div>' });
    expect(out.warnings.join(' ')).toMatch(/Class attributes/);
    const room = await h.server.rooms.get(file);
    const code = await call<string>(agent, 'code_get', { node_id: out.ids[0] });
    expect(code).not.toMatch(/onclick|onerror|<script/);
    room.doc.delete(out.ids);
  });

  it('places a bare section written straight to a page', async () => {
    const out = await call(agent, 'html_write', { target_id: page, html: '<section style="height:50px"><p style="color:#000">x</p></section>' });
    const node = await call(agent, 'layer_get', { node_id: out.ids[0] });
    expect(node.style.position).toBe('absolute');
    expect(node.style.left).toMatch(/px$/);
    expect(node.artboard).toBe(true);
    await call(agent, 'layer_delete', { node_ids: out.ids });
  });

  it('edits style, text, name, flags, order and copies', async () => {
    const { ids: [card] } = await call(agent, 'html_write', { target_id: artboard, html: '<div data-name="Card" style="padding:8px"><p style="color:#000">Old</p></div>' });
    const styled = await call(agent, 'layer_style', { node_ids: [card], style: { 'background-color': 'red', padding: null } });
    expect(styled.style).toEqual({ backgroundColor: 'red' });
    const room = await h.server.rooms.get(file);
    const para = room.doc.getChildren(card)[0]!.id;
    await call(agent, 'layer_text', { node_id: para, text: 'New' });
    expect(room.doc.getNode(para)!.text).toBe('New');
    const wrong = await callRaw(agent, 'layer_text', { node_id: card, text: 'x' });
    expect(wrong.isError).toBe(true);
    await call(agent, 'layer_rename', { node_id: card, name: 'Renamed' });
    const { ids: [copy] } = await call(agent, 'layer_duplicate', { node_ids: [card] });
    expect(room.doc.getNode(copy)!.name).toBe('Renamed');
    await call(agent, 'layer_move', { node_ids: [copy], index: 0 });
    expect(room.doc.getChildren(artboard)[0]!.id).toBe(copy);
    await call(agent, 'layer_set_flags', { node_ids: [copy], hidden: true, locked: true });
    expect(room.doc.getNode(copy)).toMatchObject({ hidden: true, locked: true });
    const refused = await callRaw(agent, 'layer_style', { node_ids: [copy], style: { color: 'red' } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/locked/);
    await call(agent, 'layer_set_flags', { node_ids: [copy], locked: false });
    await call(agent, 'layer_delete', { node_ids: [copy, card] });
    expect(room.doc.getNode(card)).toBeUndefined();
  });

  it('undoes one agent without touching another', async () => {
    const other = await connectAgent(h.base, 'second-agent');
    await call(other, 'file_open', { file_id: file });
    const mine = (await call(agent, 'html_write', { target_id: artboard, html: '<div data-name="mine" style="height:10px"></div>' })).ids[0];
    const theirs = (await call(other, 'html_write', { target_id: artboard, html: '<div data-name="theirs" style="height:10px"></div>' })).ids[0];
    const room = await h.server.rooms.get(file);

    const res = await fetch(`${h.base}/api/agents/undo`, json({ fileId: file, agent: 'test-agent' }));
    expect(await res.json()).toEqual({ undone: true });
    expect(room.doc.getNode(mine)).toBeUndefined();
    expect(room.doc.getNode(theirs)).toBeDefined();

    const res2 = await fetch(`${h.base}/api/agents/undo`, json({ fileId: file, agent: 'second-agent' }));
    expect(await res2.json()).toEqual({ undone: true });
    expect(room.doc.getNode(theirs)).toBeUndefined();

    const nothing = await fetch(`${h.base}/api/agents/undo`, json({ fileId: file, agent: 'nobody' }));
    expect(await nothing.json()).toEqual({ undone: false });
    await other.close();
  });

  it('handles tokens, including reading a repo stylesheet', async () => {
    await call(agent, 'tokens_set', { tokens: [{ name: 'accent', kind: 'color', value: '#ff5500' }, { name: 'space-4', kind: 'spacing', value: '16px' }] });
    expect(await call(agent, 'tokens_get')).toHaveLength(2);
    await call(agent, 'tokens_delete', { names: ['space-4'] });
    expect(await call(agent, 'tokens_get')).toHaveLength(1);

    const css = `/* theme */
      :root { --background: 0 0% 100%; --radius-md: 8px; --font-display: "Inter", sans-serif; --text-lg: 18px; --mystery: foo; }
      .dark { --background: 0 0% 0%; }
      @media (min-width: 1px) { :root { --inside: 1px; } }`;
    const out = await call(agent, 'tokens_from_css', { css });
    expect(out.applied).toBe(4);
    const kinds = Object.fromEntries(out.tokens.map((t: any) => [t.name, t.kind]));
    expect(kinds).toEqual({ background: 'color', 'radius-md': 'radius', 'font-display': 'font-family', 'text-lg': 'font-size' });
    expect(out.tokens.find((t: any) => t.name === 'background').value).toBe('hsl(0 0% 100%)');
    expect(out.unclassified[0]).toContain('mystery');
    expect(out.skipped.map((s: any) => s.selector).join(' ')).toContain('.dark');
    const dark = await call(agent, 'tokens_from_css', { css, selector: '.dark', dry_run: true });
    expect(dark.tokens[0].value).toBe('hsl(0 0% 0%)');
    await call(agent, 'tokens_delete', { names: ['background', 'radius-md', 'font-display', 'text-lg'] });
  });

  it('handles comment threads', async () => {
    const { id } = await call(agent, 'comment_add', { text: 'Is this right?', node_id: artboard });
    await call(agent, 'comment_reply', { thread_id: id, text: 'Yes' });
    const open = await call(agent, 'comments_list');
    expect(open[0].messages.map((m: any) => m.text)).toEqual(['Is this right?', 'Yes']);
    expect(open[0].messages[0].author).toBe('test-agent');
    expect(await call(agent, 'comments_list', { status: 'resolved' })).toHaveLength(0);
  });

  describe('only a person resolves or reopens a thread', () => {
    const refused = async (name: string, args: Record<string, unknown>) => {
      try {
        return (await callRaw(agent, name, args)).isError;
      } catch {
        return true;
      }
    };
    const threadOf = async (id: string) => (await h.server.rooms.get(file)).doc.getComments().find((t) => t.id === id)!;

    it('refuses a stale comment_resolve, either way, and changes nothing', async () => {
      const { id } = await call(agent, 'comment_add', { text: 'Make the heading bigger', node_id: artboard });
      const room = await h.server.rooms.get(file);
      const state = () => Buffer.from(Y.encodeStateVector(room.doc.y)).toString('base64');
      const before = state();
      expect(await refused('comment_resolve', { thread_id: id })).toBe(true);
      expect(await refused('comment_resolve', { thread_id: id, resolved: true, file_id: file })).toBe(true);
      // Not one update reached the document.
      expect(state()).toBe(before);
      expect((await threadOf(id)).resolved).toBe(false);
      // A person resolves it; a stale reopen is refused too.
      room.doc.setThreadResolved(id, true, 'person:Mara');
      const resolved = state();
      expect(await refused('comment_resolve', { thread_id: id, resolved: false })).toBe(true);
      expect(state()).toBe(resolved);
      expect((await threadOf(id)).resolved).toBe(true);
    });

    it('refuses a batch with a comment_resolve step before any step runs', async () => {
      const { id } = await call(agent, 'comment_add', { text: 'And the colour', node_id: artboard });
      const res = await refused('batch', { steps: [
        { tool: 'layer_rename', args: { node_id: artboard, name: 'Renamed by batch' } },
        { tool: 'comment_resolve', args: { thread_id: id } },
      ] });
      const room = await h.server.rooms.get(file);
      expect(res).toBe(true);
      expect(room.doc.getNode(artboard)!.name).toBe('Home');
      expect((await threadOf(id)).resolved).toBe(false);
    });

    it('lets a person resolve and reopen, and an agent reply leaves that as it is', async () => {
      const { id } = await call(agent, 'comment_add', { text: 'Tighten the spacing', node_id: artboard });
      const room = await h.server.rooms.get(file);
      room.doc.setThreadResolved(id, true, 'person:Mara');
      await call(agent, 'comment_reply', { thread_id: id, text: 'Tightened it to 24 px.' });
      expect((await threadOf(id)).resolved).toBe(true);
      expect((await threadOf(id)).messages).toHaveLength(2);
      room.doc.setThreadResolved(id, false, 'person:Mara');
      await call(agent, 'comment_reply', { thread_id: id, text: 'And the gap below.' });
      expect((await threadOf(id)).resolved).toBe(false);
      expect(await call(agent, 'comments_list', { status: 'open' })).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    });
  });

  it('manages pages', async () => {
    const created = await call(agent, 'page_create', { name: 'Second' });
    await call(agent, 'page_rename', { page_id: created.id, name: 'Two' });
    const order = await call(agent, 'page_reorder', { page_id: created.id, index: 0 });
    expect(order[0].name).toBe('Two');
    await call(agent, 'page_delete', { page_id: created.id });
    const pages = await call(agent, 'page_list');
    expect(pages).toHaveLength(1);
    // Later tools must not stick to the deleted page.
    expect(await call<string>(agent, 'layer_tree')).toContain('Home');
  });

  it('returns a real PNG screenshot with pixels in it', async () => {
    const result = await callRaw(agent, 'canvas_screenshot', { node_id: artboard });
    const image = result.content.find((c) => c.type === 'image')!;
    expect(image.mimeType).toBe('image/png');
    const stats = await pngStats(Buffer.from(image.data!, 'base64'));
    expect(stats.width).toBe(800);
    expect(stats.distinctColors).toBeGreaterThan(2);
  });

  it('clamps big screenshots for MCP clients', async () => {
    const big = await call(agent, 'artboard_create', { name: 'Big', width: 3000, height: 3000, background: '#102030' });
    const result = await callRaw(agent, 'canvas_screenshot', { node_id: big.id, scale: 4, format: 'jpg' });
    const text = result.content.find((c) => c.type === 'text')!.text!;
    expect(text).toMatch(/^2000x2000px/);
    await call(agent, 'layer_delete', { node_ids: [big.id] });
  });

  it('captures a layer inside its context, on a page with negative coordinates', async () => {
    const pageId = (await call(agent, 'page_create', { name: 'Offset' })).id;
    const board = (await call(agent, 'artboard_create', { name: 'Far', width: 300, height: 200, x: -2000, y: -1000, background: '#ffffff', page_id: pageId })).id;
    const { ids: [inner] } = await call(agent, 'html_write', { target_id: board, html: '<div style="margin:20px;width:100px;height:50px;background:#ff0000"></div>' });
    const whole = await callRaw(agent, 'canvas_screenshot', { page_id: pageId });
    expect(whole.content.find((c) => c.type === 'text')!.text).toMatch(/^300x200px/);
    const part = await callRaw(agent, 'canvas_screenshot', { node_id: inner });
    expect(part.content.find((c) => c.type === 'text')!.text).toMatch(/^100x50px/);
    const stats = await pngStats(Buffer.from(part.content.find((c) => c.type === 'image')!.data!, 'base64'));
    expect(stats.distinctColors).toBe(1);
    const computed = await call(agent, 'layer_styles_computed', { node_ids: [inner], properties: ['background-color'] });
    expect(computed[inner].style['background-color']).toBe('rgb(255, 0, 0)');
    expect(computed[inner].box.width).toBe(100);
    await call(agent, 'page_delete', { page_id: pageId });
    await call(agent, 'file_open', { file_id: file });
  });

  it('renders shader layers', async () => {
    const pageId = (await call(agent, 'page_create', { name: 'Shader' })).id;
    const board = (await call(agent, 'artboard_create', { name: 'FX', width: 200, height: 200, page_id: pageId })).id;
    await call(agent, 'html_write', { target_id: board, html: '<x-shader type="mesh-gradient" colors="#ff0000,#00ff00,#0000ff" style="width:200px;height:200px"></x-shader>' });
    const shot = await callRaw(agent, 'canvas_screenshot', { node_id: board });
    const stats = await pngStats(Buffer.from(shot.content.find((c) => c.type === 'image')!.data!, 'base64'));
    expect(stats.distinctColors).toBeGreaterThan(20);
    const manyBoard = (await call(agent, 'artboard_create', { name: 'Many', width: 400, height: 400, x: 6000, y: 3000, background: '#000000', page_id: pageId })).id;
    // More effects than a page can hold WebGL contexts. All must draw, including the first.
    const cell = '<x-shader type="mesh-gradient" colors="#ff0000,#00ff00" style="width:20px;height:20px"></x-shader>';
    const { ids } = await call(agent, 'html_write', { target_id: manyBoard, html: `<div style="display:grid;grid-template-columns:repeat(5,20px)">${cell.repeat(20)}</div>` });
    const room = await h.server.rooms.get(file);
    const first = room.doc.getChildren(ids[0])[0]!.id;
    const firstShot = await callRaw(agent, 'canvas_screenshot', { node_id: first });
    expect((await pngStats(Buffer.from(firstShot.content.find((c) => c.type === 'image')!.data!, 'base64'))).distinctColors).toBeGreaterThan(3);
    await call(agent, 'page_delete', { page_id: pageId });
  }, 30_000);

  it('exports through MCP and REST in every format', async () => {
    for (const format of ['png', 'jpg', 'webp', 'svg', 'pdf', 'html']) {
      const out = await call(agent, 'export_file', { format, node_ids: [artboard] });
      const bytes = readFileSync(out.paths[0]);
      expect(out.paths[0].startsWith(join(h.home, 'exports'))).toBe(true);
      expect(bytes.length).toBeGreaterThan(50);
      if (format === 'png') expect(bytes.subarray(1, 4).toString()).toBe('PNG');
      if (format === 'pdf') expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
      if (format === 'html') expect(bytes.toString()).toContain('Hello Bogen');
      if (format === 'svg') expect(bytes.toString()).toMatch(/<text [^>]*>Hello Bogen<\/text>/);
    }
    const res = await fetch(`${h.base}/api/export`, json({ fileId: file, nodeIds: [artboard], format: 'pdf' }));
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const res2 = await fetch(`${h.base}/api/export`, json({ fileId: file, nodeIds: [], format: 'png', scale: 2 }));
    expect((await pngStats(new Uint8Array(await res2.arrayBuffer()))).width).toBe(1600);
    const bad = await fetch(`${h.base}/api/export`, json({ fileId: file, nodeIds: ['nope'], format: 'png' }));
    expect(bad.status).toBe(400);
    const { paths } = await call(agent, 'export_file', { format: 'pdf', node_ids: [artboard, artboard] });
    expect(paths).toHaveLength(1);
  }, 60_000);

  it('hands off code', async () => {
    const found = await call(agent, 'layer_find', { name: 'Hero' });
    const hero = found.layers[0].id;
    expect(await call<string>(agent, 'code_get', { node_id: hero })).toContain('<section');
    expect(await call<string>(agent, 'code_get', { node_id: hero, format: 'react-inline' })).toContain('style={{');
    expect(await call<string>(agent, 'code_get', { node_id: hero, format: 'react-tailwind' })).toContain('className=');
  });

  it('lints contrast, tokens, grid and overflow', async () => {
    const pageId = (await call(agent, 'page_create', { name: 'Lint' })).id;
    await call(agent, 'tokens_set', { tokens: [{ name: 'brand', kind: 'color', value: '#123456' }] });
    const board = (await call(agent, 'artboard_create', { name: 'L', width: 300, height: 300, page_id: pageId })).id;
    await call(agent, 'html_write', { target_id: board, html: `<div style="background:#ffffff;padding:7px;flex-shrink:0;width:100px;height:100px;overflow:visible">
      <p style="color:#cccccc;font-size:14px">Faint</p>
      <div style="width:400px;height:10px;background:#123456;flex-shrink:0"></div>
    </div>` });
    const lint = await call(agent, 'design_lint', { page_id: pageId });
    expect(lint.counts.contrast).toBe(1);
    expect(lint.counts.grid).toBe(1);
    expect(lint.counts.token).toBeGreaterThanOrEqual(1);
    expect(lint.counts.overflow).toBeGreaterThanOrEqual(1);
    await call(agent, 'tokens_delete', { names: ['brand'] });
    await call(agent, 'page_delete', { page_id: pageId });
  }, 30_000);

  it('lists fonts and guides, generates no images, and says so for bogen-gen:', async () => {
    const fonts = await call(agent, 'fonts_list', { query: 'inter', source: 'google' });
    expect(fonts.google).toContain('Inter');
    for (const topic of ['design', 'layout', 'tokens', 'shaders', 'code']) expect((await call<string>(agent, 'guide_get', { topic })).length).toBeGreaterThan(300);
    const { tools } = await agent.listTools();
    expect(tools.some((t) => t.name === 'image_generate')).toBe(false);
    expect(tools.find((t) => t.name === 'asset_upload')!.description).toMatch(/no image generator/);
    const write = await call(agent, 'html_write', { target_id: artboard, html: '<div style="background-image:url(bogen-gen:a dot);height:4px"><img src="bogen-gen:a cat" alt="Cat" style="width:120px;height:80px"></div>' });
    expect(write.warnings.join(' ')).toMatch(/bogen-gen: does nothing.*asset_upload/);
    const room = await h.server.rooms.get(file);
    const div = room.doc.getNode(write.ids[0])!;
    expect(div.style.backgroundImage).toBeUndefined();
    const img = room.doc.getChildren(div.id)[0]!;
    expect(img.type).toBe('image');
    expect(img.src).toBeUndefined();
    // What is left is a placeholder of its size, until a src arrives.
    const code = await call<string>(agent, 'code_get', { node_id: img.id, format: 'html' });
    expect(code).toMatch(/<span[^>]*role="img"[^>]*>Cat, 120 × 80<\/span>/);
    room.doc.delete(write.ids);
  });

  it('stores data URIs as assets and refuses private image addresses', async () => {
    const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    const write = await call(agent, 'html_write', { target_id: artboard, html: `<img src="${data}" style="width:1px"><img src="http://127.0.0.1:${h.server.port}/api/status" style="width:1px"><img src="http://169.254.169.254/latest/meta-data" style="width:1px">` });
    const room = await h.server.rooms.get(file);
    expect(room.doc.getNode(write.ids[0])!.src).toMatch(/^bogen-asset:/);
    expect(write.warnings.join(' ')).toMatch(/127\.0\.0\.1 is a private address/);
    expect(write.warnings.join(' ')).toMatch(/169\.254\.169\.254 is a private address/);
    room.doc.delete(write.ids);
  });

  it('keeps agents in awareness with working state, and reports them in status', async () => {
    const p = peer(h.base, file);
    await new Promise<void>((resolve) => p.provider.once('sync', () => resolve()));
    const { ids } = await call(agent, 'html_write', { target_id: artboard, html: '<div data-name="seen" style="height:2px"></div>' });
    const agentState = () => [...p.provider.awareness.getStates().values()].find((s) => s.user?.agent);
    await until(() => Boolean(agentState()));
    expect(agentState()!.user.name).toBe('test-agent');
    expect(agentState()!.working).toBe(true);
    expect(agentState()!.selection).toEqual(ids);
    const status = await (await fetch(`${h.base}/api/status`)).json() as any;
    expect(status.agents[0]).toMatchObject({ name: 'test-agent', fileId: file, fileName: 'Landing', status: 'working', lastTool: 'html_write' });
    await call(agent, 'layer_delete', { node_ids: ids });
    p.close();
  });

  it('syncs an agent edit to a y-websocket peer live, and a peer edit back', async () => {
    const p = peer(h.base, file);
    await new Promise<void>((resolve) => p.provider.once('sync', () => resolve()));
    expect(p.doc.getPages()).toHaveLength(1);
    const { ids } = await call(agent, 'html_write', { target_id: artboard, html: '<h2 style="color:#000">From agent</h2>' });
    await until(() => p.doc.getNode(ids[0]) !== undefined);
    expect(p.doc.getNode(ids[0])!.text).toBe('From agent');
    const fromPeer = p.doc.insert(artboard, { type: 'text', text: 'From peer' });
    const room = await h.server.rooms.get(file);
    await until(() => room.doc.getNode(fromPeer) !== undefined);
    room.doc.delete([ids[0], fromPeer]);
    p.close();
  });

  it('reads the person\'s context from awareness', async () => {
    const before = await call(agent, 'context_get');
    expect(before.editorOpen).toBe(false);
    const p = peer(h.base, file);
    await new Promise<void>((resolve) => p.provider.once('sync', () => resolve()));
    p.provider.awareness.setLocalState({ user: { name: 'Mara', color: '#f00' }, cursor: null, selection: [artboard], pageId: page });
    const server = await h.server.rooms.get(file);
    await until(() => server.humans().length === 1);
    const context = await call(agent, 'context_get');
    expect(context).toMatchObject({ editorOpen: true, file: { id: file }, page: { id: page }, user: 'Mara' });
    expect(context.selection[0].id).toBe(artboard);
    p.close();
    await until(() => server.humans().length === 0);
  });

  it('creates the first page only on the server, once', async () => {
    const created = await (await fetch(`${h.base}/api/files`, json({ name: 'Fresh' }))).json() as { id: string };
    const [a, b] = [peer(h.base, created.id), peer(h.base, created.id)];
    await Promise.all([a, b].map((p) => new Promise<void>((resolve) => p.provider.once('sync', () => resolve()))));
    expect(a.doc.getPages()).toHaveLength(1);
    expect(b.doc.getPages()).toHaveLength(1);
    a.close();
    b.close();
  });

  it('serves the REST file API and broadcasts changes', async () => {
    const events: any[] = [];
    const ws = new WebSocket(`${h.base.replace('http', 'ws')}/events`);
    ws.on('message', (d) => events.push(JSON.parse(String(d))));
    await new Promise((resolve) => ws.once('open', resolve));
    const created = await (await fetch(`${h.base}/api/files`, json({ name: 'REST' }))).json() as { id: string; name: string };
    expect(created.name).toBe('REST');
    const patch = await fetch(`${h.base}/api/files/${created.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) });
    expect(patch.status).toBe(200);
    const listed = await (await fetch(`${h.base}/api/files`)).json() as any[];
    expect(listed.find((f) => f.id === created.id).name).toBe('Renamed');

    const agent2 = await connectAgent(h.base, 'activity-agent');
    await call(agent2, 'file_open', { file_id: created.id });
    const board = await call(agent2, 'artboard_create', { name: 'A', width: 100, height: 100 });
    await agent2.close();
    await until(() => events.some((e) => e.t === 'activity' && e.tool === 'artboard_create'));
    expect(events.find((e) => e.t === 'activity')).toMatchObject({ fileId: created.id, agent: 'activity-agent', nodeIds: [board.id] });
    expect(events.some((e) => e.t === 'files')).toBe(true);

    const dup = await (await fetch(`${h.base}/api/files/${created.id}/duplicate`, { method: 'POST' })).json() as { id: string; name: string };
    expect(dup.name).toBe('Renamed copy');
    const copy = await h.server.rooms.get(dup.id);
    expect(copy.doc.getChildren(copy.doc.getPages()[0]!.id)[0]!.name).toBe('A');

    const del = await fetch(`${h.base}/api/files/${created.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await fetch(`${h.base}/api/files/${created.id}`, { method: 'PATCH', body: '{"name":"x"}' })).status).toBe(404);
    ws.close();
  });

  it('stores assets by content and rejects bad uploads and traversal', async () => {
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const up = await (await fetch(`${h.base}/api/assets`, { method: 'POST', headers: { 'content-type': 'image/svg+xml' }, body: bytes })).json() as any;
    expect(up.src).toBe(`bogen-asset:${up.name}`);
    expect(up.name).toMatch(/^[a-f0-9]{64}\.svg$/);
    const got = await fetch(`${h.base}${up.url}`);
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await fetch(`${h.base}/api/assets`, { method: 'POST', headers: { 'content-type': 'text/html' }, body: '<b>' })).status).toBe(415);
    for (const path of ['/assets/..%2f..%2findex.json', '/assets/%2e%2e%2findex.json', '/..%2f..%2findex.json']) {
      const res = await fetch(`${h.base}${path}`);
      expect(await res.text()).not.toContain('"files"');
    }
    const raw = await rawRequest(h.server.port, 'GET /assets/../index.json HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    expect(raw).not.toContain('"files"');
  });

  it('enforces body limits', async () => {
    const res = await fetch(`${h.base}/api/files`, { method: 'POST', body: 'x'.repeat(5 * 1024 * 1024) }).catch(() => null);
    expect(res === null || res.status === 413).toBe(true);
    const bad = await fetch(`${h.base}/api/files`, { method: 'POST', body: '{not json' });
    expect(bad.status).toBe(400);
    const tooBig = await callRaw(agent, 'html_write', { target_id: artboard, html: `<p>${'x'.repeat(300 * 1024)}</p>` });
    expect(tooBig.content[0]!.text).toMatch(/smaller chunks/);
  });

  it('rejects foreign origins and hosts on REST, sync, events and MCP', async () => {
    const evil = 'https://evil.example';
    for (const [path, init] of [['/api/status', {}], ['/api/files', json({ name: 'x' })], ['/api/runs', json({})], ['/mcp', json({})]] as const) {
      const res = await fetch(`${h.base}${path}`, { ...init, headers: { ...(init as RequestInit).headers, origin: evil } });
      expect(res.status).toBe(403);
    }
    const nullOrigin = await fetch(`${h.base}/api/status`, { headers: { origin: 'null' } });
    expect(nullOrigin.status).toBe(403);
    const crossSite = await fetch(`${h.base}/api/status`, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.status).toBe(403);
    const sameOrigin = await fetch(`${h.base}/api/status`, { headers: { origin: h.base } });
    expect(sameOrigin.status).toBe(200);
    const otherPort = await fetch(`${h.base}/api/status`, { headers: { origin: 'http://127.0.0.1:1' } });
    expect(otherPort.status).toBe(403);

    const rebinding = await rawRequest(h.server.port, 'GET /api/status HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
    expect(rebinding).toMatch(/^HTTP\/1\.1 403/);

    for (const path of [`/sync/${file}`, '/events']) {
      const refused = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`${h.base.replace('http', 'ws')}${path}`, { origin: evil });
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => resolve(101));
        ws.on('error', () => {});
      });
      expect(refused).toBe(403);
    }
    const unknown = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${h.base.replace('http', 'ws')}/sync/doesnotexist`);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => {});
    });
    expect(unknown).toBe(404);
  });

  it('reports runners and refuses a bad run', async () => {
    const runners = await (await fetch(`${h.base}/api/runners`)).json() as any[];
    expect(runners.map((r) => r.id).sort()).toEqual(['claude', 'codex', 'grok', 'hermes', 'omp', 'opencode']);
    for (const id of ['grok', 'hermes', 'omp']) {
      expect(runners.find((r) => r.id === id)).toMatchObject({ available: false, reason: expect.stringContaining(`bogen install ${id}`) });
    }
    expect((await fetch(`${h.base}/api/runs`, json({ fileId: file, prompt: 'x', runner: 'nope' }))).status).toBe(400);
    expect((await fetch(`${h.base}/api/runs`, json({ fileId: 'missing1', prompt: 'x', runner: 'claude' }))).status).toBe(404);
    expect((await fetch(`${h.base}/api/runs/nope/stop`, { method: 'POST' })).status).toBe(404);
  });

  it('answers /api/theme and serves something at /', async () => {
    const theme = await fetch(`${h.base}/api/theme`);
    expect(theme.status).toBe(200);
    const index = await fetch(`${h.base}/`);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect((await fetch(`${h.base}/no-such.js`)).status).toBe(404);
  });
});

describe('persistence and lifecycle', () => {
  it('serves a built editor, with client-side routes, and nothing outside it', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'bogen-editor-'));
    mkdirSync(join(dist, 'static'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Editor</title>');
    writeFileSync(join(dist, 'static', 'index-abc.js'), 'console.log(1)');
    writeFileSync(join(dist, '..', 'bogen-outside.txt'), 'outside');
    process.env.BOGEN_EDITOR_DIR = dist;
    const h = await startServer();
    try {
      expect(await (await fetch(`${h.base}/`)).text()).toContain('Editor');
      expect(await (await fetch(`${h.base}/file/abc`)).text()).toContain('Editor');
      const script = await fetch(`${h.base}/static/index-abc.js`);
      expect(script.headers.get('content-type')).toContain('text/javascript');
      expect(script.headers.get('cache-control')).toContain('immutable');
      expect((await fetch(`${h.base}/static/missing.js`)).status).toBe(404);
      for (const path of ['/..%2fbogen-outside.txt', '/%2e%2e/bogen-outside.txt', '/assets/..%2f..%2fbogen-outside.txt']) {
        expect(await (await fetch(`${h.base}${path}`)).text(), path).not.toContain('outside');
      }
    } finally {
      delete process.env.BOGEN_EDITOR_DIR;
      await h.cleanup();
      rmSync(dist, { recursive: true, force: true });
      rmSync(join(dist, '..', 'bogen-outside.txt'), { force: true });
    }
  });

  it('keeps a file across a restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bogen-restart-'));
    const first = await startServer({}, home);
    const agent = await connectAgent(first.base, 'keeper');
    const { id } = await call(agent, 'file_create', { name: 'Durable' });
    const board = await call(agent, 'artboard_create', { name: 'Stays', width: 100, height: 100 });
    await call(agent, 'tokens_set', { tokens: [{ name: 'c', kind: 'color', value: '#000' }] });
    await agent.close();
    await first.server.close();

    const second = await startServer({}, home);
    const list = await (await fetch(`${second.base}/api/files`)).json() as any[];
    expect(list.map((f) => f.name)).toEqual(['Durable']);
    const again = await connectAgent(second.base, 'keeper');
    await call(again, 'file_open', { file_id: id });
    expect((await call(again, 'layer_get', { node_id: board.id })).name).toBe('Stays');
    expect(await call(again, 'tokens_get')).toHaveLength(1);
    expect((await call(again, 'page_list'))).toHaveLength(1);
    await again.close();
    await second.cleanup();
    expect(() => readFileSync(join(home, 'index.json'))).toThrow();
  });

  it('saves soon after an edit, drops agents after their expiry, and unloads an idle file', async () => {
    const h = await startServer({ idleMs: 150, agentExpiryMs: 100 });
    const agent = await connectAgent(h.base, 'saver');
    const { id } = await call(agent, 'file_create', { name: 'Autosave' });
    const board = await call(agent, 'artboard_create', { name: 'S', width: 10, height: 10 });
    const path = join(h.home, 'files', `${id}.ydoc`);
    await until(() => {
      try {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, readFileSync(path));
        return new BogenDoc(doc).nodes.size === 1;
      } catch {
        return false;
      }
    });
    const p = peer(h.base, id);
    await new Promise<void>((resolve) => p.provider.once('sync', () => resolve()));
    await until(async () => (await (await fetch(`${h.base}/api/status`)).json() as any).agents.length === 0);
    await until(() => ![...p.provider.awareness.getStates().values()].some((s) => s.user?.agent));
    // A peer keeps the file loaded, however long it is idle.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.server.rooms.peek(id)).toBeDefined();
    const fromPeer = p.doc.insert(board.id, { type: 'text', text: 'Late edit' });
    const room = await h.server.rooms.get(id);
    await until(() => room.doc.getNode(fromPeer) !== undefined);
    p.close();
    await until(() => h.server.rooms.peek(id) === undefined);
    // Loads again on use, with everything still there.
    expect((await call(agent, 'layer_get', { node_id: fromPeer, file_id: id })).text).toBe('Late edit');
    await agent.close();
    await h.cleanup();
  });

  it('renders a dashboard thumbnail after edits settle', async () => {
    const h = await startServer({ thumbnails: true, thumbnailDelayMs: 30 });
    const agent = await connectAgent(h.base, 'thumb');
    const { id } = await call(agent, 'file_create', { name: 'Thumb' });
    await call(agent, 'artboard_create', { name: 'T', width: 800, height: 400, background: '#336699' });
    await agent.close();
    let listed: any;
    await until(async () => {
      listed = (await (await fetch(`${h.base}/api/files`)).json() as any[]).find((f) => f.id === id);
      return Boolean(listed.thumbnail);
    }, 10_000);
    const image = await fetch(h.base + listed.thumbnail);
    expect(image.headers.get('content-type')).toBe('image/webp');
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(20);
    await h.cleanup();
  }, 20_000);

  it('does not let a rendered page reach private addresses', async () => {
    const { createServer } = await import('node:http');
    const hits: string[] = [];
    const inner = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('secret');
    });
    await new Promise<void>((resolve) => inner.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(inner.address() as { port: number }).port}`;
    const h = await startServer();
    const agent = await connectAgent(h.base, 'ssrf');
    await call(agent, 'file_create', { name: 'SSRF' });
    const board = await call(agent, 'artboard_create', { name: 'S', width: 200, height: 200 });
    const out = await call(agent, 'html_write', { target_id: board.id, html: `<div style="width:50px;height:50px;background-image:url(${url}/css)"><img src="${url}/img" style="width:9px;height:9px"></div><iframe src="${url}/frame" style="width:9px;height:9px"></iframe>` });
    expect(out.warnings.join(' ')).toMatch(/private address/);
    await callRaw(agent, 'canvas_screenshot', { node_id: board.id });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hits).toEqual([]);
    await agent.close();
    await h.cleanup();
    inner.close();
  }, 20_000);

  it('runs a CLI with no shell string, streams it, and stops the whole process group', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'bogen-fake-cli-'));
    const log = join(bin, 'log.json');
    const pidFile = join(bin, 'child.pid');
    writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('9.9.9 (Fake)'); process.exit(0); }
const { spawn } = require('node:child_process');
const { writeFileSync, readFileSync } = require('node:fs');
const child = spawn('sleep', ['60'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
const configAt = process.argv[process.argv.indexOf('--mcp-config') + 1];
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin: readFileSync(0, 'utf8'), config: JSON.parse(readFileSync(configAt, 'utf8')), env: Object.keys(process.env), cwd: process.cwd() }));
console.log('not json at all');
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working' }, { type: 'tool_use', name: 'mcp__bogen__layer_tree' }] } }));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    const savedMark = process.env.CLAUDECODE;
    process.env.PATH = `${bin}:${savedPath}`;
    process.env.CLAUDECODE = '1';
    const h = await startServer();
    try {
      const { id } = await (await fetch(`${h.base}/api/files`, json({ name: 'Run' }))).json() as { id: string };
      const events: any[] = [];
      const ws = new WebSocket(`${h.base.replace('http', 'ws')}/events`);
      ws.on('message', (d) => events.push(JSON.parse(String(d))));
      await new Promise((resolve) => ws.once('open', resolve));
      const prompt = '$(touch /tmp/pwned); "quotes" `ticks`';
      const started = await fetch(`${h.base}/api/runs`, json({ fileId: id, prompt, runner: 'claude', model: 'cheap', nodeIds: ['abc'] }));
      expect(started.status).toBe(201);
      const { runId } = await started.json() as { runId: string };
      await until(() => events.some((e) => e.kind === 'tool'));
      expect(events.filter((e) => e.t === 'agent').slice(0, 2)).toEqual([
        { t: 'agent', runId, fileId: id, kind: 'text', text: 'Working' },
        { t: 'agent', runId, fileId: id, kind: 'tool', tool: 'layer_tree' },
      ]);
      const seen = JSON.parse(readFileSync(log, 'utf8'));
      expect(seen.stdin).toBe(prompt);
      expect(seen.argv).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', 'mcp__bogen__*', '--model', 'cheap']));
      expect(seen.config.mcpServers.bogen.url).toBe(`${h.base}/mcp`);
      expect(seen.env).not.toContain('CLAUDECODE');
      expect(seen.cwd).not.toBe(process.cwd());
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(grandchild, 0)).not.toThrow();
      expect((await fetch(`${h.base}/api/runs/${runId}/stop`, { method: 'POST' })).status).toBe(200);
      await until(() => events.some((e) => e.kind === 'done'));
      expect(events.at(-1)).toMatchObject({ kind: 'done', text: 'Stopped.' });
      await until(() => {
        try {
          process.kill(grandchild, 0);
          return false;
        } catch {
          return true;
        }
      });
      ws.close();
    } finally {
      process.env.PATH = savedPath;
      if (savedMark === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = savedMark;
      await h.cleanup();
      rmSync(bin, { recursive: true, force: true });
    }
  }, 20_000);

  it('requires a token when one is set', async () => {
    const h = await startServer({ token: 'sekret-token' });
    expect((await fetch(`${h.base}/api/status`)).status).toBe(401);
    expect((await fetch(`${h.base}/api/status`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${h.base}/`)).status).toBe(401);
    expect((await fetch(`${h.base}/api/status`, { headers: { authorization: 'Bearer sekret-token' } })).status).toBe(200);
    // Any Host is fine with a token, for proxies, but a foreign page still is not.
    expect(await rawRequest(h.server.port, 'GET /api/status HTTP/1.1\r\nHost: bogen.example\r\nAuthorization: Bearer sekret-token\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 200/);
    expect((await fetch(`${h.base}/api/status`, { headers: { authorization: 'Bearer sekret-token', origin: 'https://evil.example' } })).status).toBe(403);

    const login = await fetch(`${h.base}/?token=sekret-token`, { redirect: 'manual' });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect((await fetch(`${h.base}/api/status`, { headers: { cookie: cookie.split(';')[0]! } })).status).toBe(200);

    const agent = await connectAgent(h.base, 'with-token', { authorization: 'Bearer sekret-token' });
    expect(Array.isArray(await call(agent, 'file_list'))).toBe(true);
    await agent.close();
    await expect(connectAgent(h.base, 'without-token')).rejects.toThrow();

    const opened = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${h.base.replace('http', 'ws')}/events`);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => {});
    });
    expect(opened).toBe(401);
    const withToken = new WebSocket(`${h.base.replace('http', 'ws')}/events?token=sekret-token`);
    await new Promise((resolve) => withToken.once('open', resolve));
    withToken.close();
    await h.cleanup();
  });
});

async function rawRequest(port: number, text: string): Promise<string> {
  const { connect } = await import('node:net');
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let out = '';
    socket.on('connect', () => socket.write(text));
    socket.on('data', (d) => (out += d.toString()));
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  });
}


describe('.bogen files', () => {
  it('round trips a design with its assets, and refuses damaged files', async () => {
    const a = await startServer();
    const b = await startServer();
    try {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
      const asset = await (await fetch(`${a.base}/api/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json() as { src: string; name: string };
      const { id } = await (await fetch(`${a.base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Trip"}' })).json() as { id: string };
      const agent = await connectAgent(a.base, 'test');
      await call(agent, 'file_open', { file_id: id });
      await call(agent, 'artboard_create', { name: 'Board', width: 100, height: 100 });
      await call(agent, 'html_write', { html: `<img src="${asset.src}" alt="dot" style="position:absolute;left:300px;width:10px;height:10px">` });
      await agent.close();

      const res = await fetch(`${a.base}/api/files/${id}/download`);
      expect(res.headers.get('content-type')).toBe('application/x-bogen');
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.subarray(0, 5).toString()).toBe('BOGEN');

      const imported = await fetch(`${b.base}/api/files/import`, { method: 'POST', headers: { 'X-Bogen-Filename': 'Trip.bogen' }, body: bytes });
      expect(imported.status).toBe(201);
      const created = await imported.json() as { id: string; name: string };
      expect(created.name).toBe('Trip');
      const other = await connectAgent(b.base, 'test');
      await call(other, 'file_open', { file_id: created.id });
      expect(JSON.stringify(await call(other, 'layer_tree', {}))).toContain('Board');
      expect((await fetch(`${b.base}/assets/${asset.name}`)).status).toBe(200);
      await other.close();

      for (const bad of [Buffer.from('{"json":true}'), bytes.subarray(0, 12), Buffer.concat([bytes, Buffer.from([0, 0, 0, 200])])]) {
        const refused = await fetch(`${b.base}/api/files/import`, { method: 'POST', body: bad });
        expect(refused.status).toBe(400);
      }
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  }, 30000);

  it('serves the editor with a script policy that blocks injected scripts', async () => {
    const a = await startServer();
    try {
      const res = await fetch(`${a.base}/`);
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    } finally {
      await a.cleanup();
    }
  });
});
