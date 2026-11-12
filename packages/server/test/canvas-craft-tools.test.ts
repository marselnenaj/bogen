import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

let h: Harness;
let agent: Client;

beforeAll(async () => {
  h = await startServer();
  agent = await connectAgent(h.base, 'claude');
  await call(agent, 'file_create', { name: 'Craft tools' });
});

afterAll(async () => {
  await agent.close();
  await h.cleanup();
});

describe('canvas craft over MCP', () => {
  it('makes an artboard from a preset, in either orientation', async () => {
    const phone = await call(agent, 'artboard_create', { name: 'Phone', preset: 'iPhone 16 Pro Max' });
    expect([phone.width, phone.height]).toEqual([440, 956]);
    const wide = await call(agent, 'artboard_create', { name: 'Phone sideways', preset: 'phone', landscape: true });
    expect([wide.width, wide.height]).toEqual([852, 393]);
    const bad = await callRaw(agent, 'artboard_create', { name: 'Nope', preset: 'Typewriter' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/No preset called "Typewriter".*Desktop/);
  });

  it('sets layout grids with defaults for the width, shows them in the tree and removes them', async () => {
    const board = await call(agent, 'artboard_create', { name: 'Grid board', width: 1440 });
    const set = await call(agent, 'layout_grid_set', { node_ids: [board.id], grids: [{ kind: 'columns' }, { kind: 'grid', size: 8, hidden: true }] });
    expect(set.layers[board.id].described).toEqual(['12 columns, gutter 24, margin 80', 'Grid 8']);
    const node = await call(agent, 'layer_get', { node_id: board.id });
    expect(node.layoutGrids[0]).toEqual({ kind: 'columns', count: 12, gutter: 24, margin: 80, align: 'stretch' });
    expect(await call(agent, 'layer_tree', {})).toMatch(/grids: 12 columns, gutter 24, margin 80; Grid 8/);
    await call(agent, 'layout_grid_set', { node_ids: [board.id], grids: [] });
    expect((await call(agent, 'layer_get', { node_id: board.id })).layoutGrids).toBeUndefined();
    // Undo per agent brings them back.
    await call(agent, 'agent_undo', {});
    expect((await call(agent, 'layer_get', { node_id: board.id })).layoutGrids).toHaveLength(2);
    const text = await call(agent, 'html_write', { target_id: board.id, html: '<p>Hi</p>' });
    const bad = await callRaw(agent, 'layout_grid_set', { node_ids: [text.ids[0]], grids: [{ kind: 'rows' }] });
    expect(bad.isError).toBe(true);
  });

  it('finds and replaces text across the file as one step, with a dry run first', async () => {
    const a = await call(agent, 'artboard_create', { name: 'Copy A' });
    await call(agent, 'html_write', { target_id: a.id, html: '<h1>Book a <b>table</b> today</h1><p>Book now</p>' });
    const page2 = await call(agent, 'page_create', { name: 'Second' });
    const b = await call(agent, 'artboard_create', { name: 'Copy B', page_id: page2.id });
    await call(agent, 'html_write', { target_id: b.id, html: '<p>Notebook. book.</p>' });
    const dry = await call(agent, 'text_replace', { find: 'book', replace: 'Reserve', dry_run: true });
    expect(dry.matches).toBe(4);
    const whole = await call(agent, 'text_replace', { find: 'book', replace: 'Reserve', whole_word: true, dry_run: true });
    expect(whole.matches).toBe(3);
    const done = await call(agent, 'text_replace', { find: 'book', replace: 'Reserve', whole_word: true });
    expect(done.replaced).toBe(3);
    const found = await call(agent, 'layer_find', { text: 'Reserve' });
    expect(found.layers.map((l: { text: string }) => l.text).sort()).toEqual(['Notebook. Reserve.', 'Reserve a table today', 'Reserve now']);
    // The bold range is still on "table".
    const h1 = found.layers.find((l: { text: string }) => l.text.startsWith('Reserve a'));
    const node = await call(agent, 'layer_get', { node_id: h1.id });
    expect(node.spans).toEqual([{ start: 10, end: 15, style: { fontWeight: '700' } }]);
    await call(agent, 'agent_undo', {});
    expect((await call(agent, 'layer_find', { text: 'Reserve' })).total).toBe(0);
  });

  it('renames layers in bulk and finds matching layers', async () => {
    const board = await call(agent, 'artboard_create', { name: 'Cards' });
    await call(agent, 'html_write', { target_id: board.id, html: '<div style="display:flex;gap:8px"><div style="padding:8px;background:#eee"><p>A</p></div><div style="padding:8px;background:#eee"><p>Bee</p></div><div style="padding:8px;background:#000"><p>C</p></div></div>' });
    const tree = await call(agent, 'layer_find', { within: board.id, style: { background: '#eee' } });
    expect(tree.total).toBe(2);
    const like = await call(agent, 'layer_find', { like: [tree.layers[0].id] });
    expect(like.layers.map((l: { id: string }) => l.id)).toEqual(tree.layers.map((l: { id: string }) => l.id));
    const renamed = await call(agent, 'layers_rename', { node_ids: like.layers.map((l: { id: string }) => l.id), pattern: 'Card $nn' });
    expect(renamed.layers.map((l: { name: string }) => l.name)).toEqual(['Card 1', 'Card 2']);
    const again = await call(agent, 'layers_rename', { node_ids: like.layers.map((l: { id: string }) => l.id), find: 'card', replace: 'Tile' });
    expect(again.layers.map((l: { name: string }) => l.name)).toEqual(['Tile 1', 'Tile 2']);
    expect((await callRaw(agent, 'layers_rename', { node_ids: [board.id] })).isError).toBe(true);
  });

  it('works inside a batch', async () => {
    const out = await call(agent, 'batch', { steps: [
      { tool: 'artboard_create', args: { name: 'Batch board', preset: 'Desktop' }, as: 'b' },
      { tool: 'layout_grid_set', args: { node_ids: ['$b.id'], grids: [{ kind: 'columns', count: 6 }] } },
      { tool: 'layers_rename', args: { node_ids: ['$b.id'], pattern: '$& 1440' } },
    ] });
    expect(JSON.stringify(out)).toMatch(/Batch board 1440/);
  });
});
