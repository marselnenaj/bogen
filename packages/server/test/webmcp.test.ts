import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { OPEN_WORLD_TOOLS } from '../src/mcp/kit.ts';
import { consentText, findModelContext, needsConsent, startWebMcp, type ModelContextLike, type ModelContextTool } from '../../../apps/editor/src/lib/webmcp.ts';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * A stand-in for `document.modelContext` as the draft of 2 November 2026 describes it: names checked, a second
 * tool of one name refused, schemas serialized, and the registration signal unregistering the tool.
 */
class DraftModelContext implements ModelContextLike {
  tools = new Map<string, ModelContextTool & { schemaText: string }>();
  registerTool(tool: ModelContextTool, options: { signal?: AbortSignal } = {}): Promise<undefined> {
    if (!NAME.test(tool.name)) return Promise.reject(new DOMException('bad name', 'InvalidStateError'));
    if (!tool.description) return Promise.reject(new DOMException('no description', 'InvalidStateError'));
    if (this.tools.has(tool.name)) return Promise.reject(new DOMException('taken', 'InvalidStateError'));
    this.tools.set(tool.name, { ...tool, schemaText: JSON.stringify(tool.inputSchema) });
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        this.tools.delete(tool.name);
        reject(options.signal!.reason);
      });
      resolve(undefined);
    });
  }
  /** What the browser does for an agent: the input goes in as JSON and the result comes back as JSON. */
  async execute(name: string, input: Record<string, unknown>): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    return JSON.parse(JSON.stringify(await tool.execute(JSON.parse(JSON.stringify(input)), { signal: new AbortController().signal })));
  }
}

const text = (result: { content: { text?: string }[] }) => result.content.map((c) => c.text ?? '').join('');

let h: Harness;
let agent: Client;
let fileId: string;

beforeAll(async () => {
  h = await startServer();
  agent = await connectAgent(h.base, 'reference');
  fileId = (await call(agent, 'file_create', { name: 'WebMCP' })).id;
});
afterAll(async () => {
  await agent.close();
  await h.cleanup();
});

describe('finding the model context', () => {
  it('takes document.modelContext of the current draft, then navigator.modelContext of the older ones', () => {
    const current = { registerTool: () => {} };
    const older = { registerTool: () => {} };
    expect(findModelContext({ modelContext: current }, { modelContext: older })).toBe(current);
    expect(findModelContext({}, { modelContext: older })).toBe(older);
    expect(findModelContext({}, {})).toBeNull();
    expect(findModelContext({ modelContext: {} }, undefined)).toBeNull();
  });
});

describe('WebMCP against a real server', () => {
  it('registers every MCP tool with the same schema and the hints of the server', async () => {
    const mc = new DraftModelContext();
    const webmcp = startWebMcp({ fileId, modelContext: mc, url: `${h.base}/mcp`, confirm: () => true });
    const names = await webmcp.ready;
    const listed = (await agent.listTools()).tools;
    expect(names.sort()).toEqual(listed.map((t) => t.name).sort());
    expect(mc.tools.size).toBe(listed.length);
    for (const t of listed) {
      const got = mc.tools.get(t.name)!;
      expect(JSON.parse(got.schemaText)).toEqual(t.inputSchema);
      expect(got.description).toBe(t.description);
      expect(got.annotations?.readOnlyHint).toBe(Boolean(t.annotations?.readOnlyHint));
      expect(got.annotations?.consequentialHint).toBe(Boolean(t.annotations?.destructiveHint || t.annotations?.openWorldHint));
    }
    expect(mc.tools.get('layer_tree')!.annotations).toMatchObject({ readOnlyHint: true, consequentialHint: false });
    expect(mc.tools.get('html_write')!.annotations).toMatchObject({ readOnlyHint: false, consequentialHint: false });
    expect(mc.tools.get('layer_delete')!.annotations?.consequentialHint).toBe(true);
    expect(mc.tools.get('export_file')!.annotations?.consequentialHint).toBe(true);
    await webmcp.stop();
    expect(mc.tools.size).toBe(0);
  });

  it('marks only tools that exist as open world, and the MCP server lists them so', async () => {
    const listed = new Map((await agent.listTools()).tools.map((t) => [t.name, t]));
    for (const name of OPEN_WORLD_TOOLS) expect(listed.get(name)?.annotations?.openWorldHint, name).toBe(true);
    expect(listed.get('html_write')?.annotations?.openWorldHint).toBe(false);
  });

  it('runs a call on the server as the agent webmcp, in the open file, with undo of its own', async () => {
    const mc = new DraftModelContext();
    const activity: { agent: string; tool: string; fileId: string }[] = [];
    const untap = h.server.hub.tap((e) => {
      if (e.t === 'activity') activity.push(e);
    });
    const webmcp = startWebMcp({ fileId, modelContext: mc, url: `${h.base}/mcp`, confirm: () => true });
    await webmcp.ready;
    const made = await mc.execute('artboard_create', { name: 'From the browser', width: 400, x: 5000 });
    expect(made.isError).toBeFalsy();
    // artboard_create has an output schema, so the agent gets its fields rather than text.
    expect(made.content).toBeUndefined();
    const id = (made as unknown as { id: string }).id;
    const room = await h.server.rooms.get(fileId);
    expect(room.doc.getNode(id)?.name).toBe('From the browser');
    expect(activity).toContainEqual(expect.objectContaining({ agent: 'webmcp', tool: 'artboard_create', fileId }));

    // Another agent's work is not undone by this one's undo.
    const other = (await call(agent, 'artboard_create', { name: 'Reference', width: 400, x: 6000 })).id as string;
    const undone = await mc.execute('agent_undo', {});
    expect(undone.isError).toBeFalsy();
    expect(room.doc.getNode(id)).toBeUndefined();
    expect(room.doc.getNode(other)).toBeDefined();
    untap();
    await webmcp.stop();
  });

  it('keeps the server rules: a locked layer stays as it is, and errors come back for the agent to read', async () => {
    const mc = new DraftModelContext();
    const webmcp = startWebMcp({ fileId, modelContext: mc, url: `${h.base}/mcp`, confirm: () => true });
    await webmcp.ready;
    const id = (await call(agent, 'artboard_create', { name: 'Locked', width: 300, x: 7000 })).id as string;
    await call(agent, 'layer_set_flags', { node_ids: [id], locked: true });
    const styled = await mc.execute('layer_style', { node_ids: [id], style: { background: 'red' } });
    expect(styled.isError).toBe(true);
    expect(text(styled)).toMatch(/locked/);
    const bad = await mc.execute('layer_get', { node_id: 'nope' });
    expect(bad.isError).toBe(true);
    await webmcp.stop();
  });

  it('asks the person before a tool that deletes or reaches outside, and does nothing on no', async () => {
    const mc = new DraftModelContext();
    const asked: string[] = [];
    let answer = false;
    const webmcp = startWebMcp({ fileId, modelContext: mc, url: `${h.base}/mcp`, confirm: (t) => { asked.push(t); return answer; } });
    await webmcp.ready;
    const id = (await call(agent, 'artboard_create', { name: 'Keep me', width: 300, x: 8000 })).id as string;
    const room = await h.server.rooms.get(fileId);

    await mc.execute('layer_tree', {});
    await mc.execute('layer_rename', { node_id: id, name: 'Keep me still' });
    expect(asked).toEqual([]);

    const refused = await mc.execute('layer_delete', { node_ids: [id] });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/declined layer_delete/);
    expect(asked[0]).toContain('layer_delete');
    expect(asked[0]).toContain(id);
    expect(room.doc.getNode(id)).toBeDefined();

    const exportRefused = await mc.execute('export_file', { node_ids: [id], format: 'png' });
    expect(exportRefused.isError).toBe(true);
    expect(asked[1]).toMatch(/reaches past this file/);

    answer = true;
    const deleted = await mc.execute('layer_delete', { node_ids: [id] });
    expect(deleted.isError).toBeFalsy();
    expect(room.doc.getNode(id)).toBeUndefined();
    await webmcp.stop();
  });

  it('opens a new session when the server ended the old one', async () => {
    const mc = new DraftModelContext();
    const webmcp = startWebMcp({ fileId, modelContext: mc, url: `${h.base}/mcp`, confirm: () => true });
    await webmcp.ready;
    await h.server.mcp.close();
    const tree = await mc.execute('layer_tree', {});
    expect(tree.isError).toBeFalsy();
    await webmcp.stop();
  });

  it('works with the older drafts: an unregister handle, and asking through requestUserInteraction', async () => {
    const tools = new Map<string, ModelContextTool>();
    const older: ModelContextLike = {
      registerTool: (tool) => {
        tools.set(tool.name, tool);
        return { unregister: () => tools.delete(tool.name) };
      },
    };
    const confirmed: string[] = [];
    const webmcp = startWebMcp({ fileId, modelContext: older, url: `${h.base}/mcp`, confirm: (t) => { confirmed.push(t); return false; } });
    await webmcp.ready;
    let interactions = 0;
    const result = await tools.get('page_delete')!.execute({ page_id: 'x' }, { requestUserInteraction: async (cb) => { interactions++; return cb(); } }) as { isError: boolean };
    expect(interactions).toBe(1);
    expect(confirmed).toHaveLength(1);
    expect(result.isError).toBe(true);
    await webmcp.stop();
    expect(tools.size).toBe(0);
  });
});

describe('the consent text', () => {
  it('names the tool and why, and cuts long arguments short', () => {
    const t = { name: 'layer_delete', annotations: { destructiveHint: true } };
    expect(needsConsent(t)).toBe(true);
    expect(needsConsent({ name: 'html_write', annotations: {} })).toBe(false);
    const words = consentText(t, { html: 'x'.repeat(2000) });
    expect(words).toContain('layer_delete');
    expect(words.length).toBeLessThan(700);
  });
});
