import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { OUTPUT_SCHEMAS } from '../src/mcp/outputs.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/** What an agent reads: descriptions that say when to use a tool, results with a shape, errors that say how to fix the call. */
describe('MCP ergonomics', () => {
  let h: Harness;
  let client: Client;
  beforeAll(async () => {
    h = await startServer();
    client = await connectAgent(h.base, 'claude');
  });
  afterAll(async () => {
    await client.close();
    await h.cleanup();
  });

  it('lists an output schema for the most used tools, and only for tools that exist', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(Object.keys(OUTPUT_SCHEMAS).length).toBeGreaterThanOrEqual(10);
    for (const name of Object.keys(OUTPUT_SCHEMAS)) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(tool!.outputSchema?.type, name).toBe('object');
      expect(Object.keys(tool!.outputSchema?.properties ?? {}).length, name).toBeGreaterThan(0);
    }
    // No description only points at another tool: each says what it does by itself.
    for (const t of tools) expect(t.description, t.name).not.toMatch(/^The same as \w+\.?$/);
    expect(byName.get('version_save')!.description).toMatch(/older name of commit_create/);
  });

  it('returns structured results that match their schemas, from a first call to an undo', async () => {
    // The SDK client checks structuredContent against the listed outputSchema, and throws when it does not match.
    await client.listTools();
    const structured = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).toBeFalsy();
      expect(result.structuredContent, name).toBeDefined();
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(JSON.parse(text), name).toEqual(result.structuredContent);
      return result.structuredContent as Record<string, any>;
    };
    expect((await structured('context_get')).editorOpen).toBe(false);
    const file = await structured('file_create', { name: 'Shapes' });
    expect(file.pages).toHaveLength(1);
    expect((await structured('file_open', { file_id: file.id })).id).toBe(file.id);
    const board = await structured('artboard_create', { name: 'Home', width: 390 });
    expect(board.height).toBe('hug');
    const written = await structured('html_write', { target_id: board.id, mode: 'into', html: '<section style="display:flex;padding:24px;gap:12px"><h1 style="font-size:32px">Hello</h1><p style="color:#333">Body</p></section>' });
    expect(written.ids).toHaveLength(1);
    const layer = await structured('layer_get', { node_id: written.ids[0] });
    expect(layer.children.length).toBe(2);
    expect((await structured('layer_style', { node_ids: written.ids, style: { gap: '16px' } })).updated).toBe(1);
    expect((await structured('layer_style', { node_ids: written.ids, pseudo: '::before', style: { content: '""' } })).block).toBe('::before');
    expect((await structured('component_list')).total).toBe(0);
    expect(typeof (await structured('design_lint', { node_id: board.id })).total).toBe('number');
    const undo = await structured('agent_undo');
    expect(undo.undone).toBe(true);
    expect(undo.can_redo).toBe(1);
  });

  it('says how to fix a call that went wrong', async () => {
    const file = await call(client, 'file_create', { name: 'Errors' });
    const text = async (name: string, args: Record<string, unknown>) => {
      const result = await callRaw(client, name, args);
      expect(result.isError, name).toBe(true);
      return result.content[0]!.text!;
    };
    expect(await text('template_use', { template: 'landing-page', page_id: 'p1' })).toMatch(/pass the file the page belongs to/);
    expect(await text('asset_upload', { data_base64: 'iVBORw0KGgo=' })).toMatch(/such as image\/png/);
    expect(await text('asset_upload', { data_base64: 'not base64!', mime_type: 'image/png' })).toMatch(/give path/);
    expect(await text('change_revert', {})).toMatch(/change_ids with ids from change_list/);
    expect(await text('library_accept', { file_id: file.id })).toMatch(/library_list shows/);
    expect(await text('variable_set', { name: 'open', delete: true, file_id: file.id })).toMatch(/Variables: none/);
    expect(await text('layer_style', { node_ids: ['nope'], style: { color: 'red' } })).toMatch(/layer_tree|layer_find/);
    // A reference to a field that a step's result does not have lists the fields it does have.
    const board = await call(client, 'artboard_create', { name: 'B', width: 390, file_id: file.id });
    const batch = await text('batch', { file_id: file.id, steps: [
      { tool: 'html_write', args: { target_id: board.id, mode: 'into', html: '<p>x</p>' }, as: 'p' },
      { tool: 'layer_style', args: { node_ids: ['$p.nodes'], style: { color: 'red' } } },
    ] });
    expect(batch).toMatch(/Its result has: ids, tree/);
  });
});
