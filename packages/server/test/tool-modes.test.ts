import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { firstSentence, parseToolMode, parseToolProfile, SCHEMA_TOOL, stripDescriptions } from '../src/mcp/tool-modes.ts';
import { call, callRaw, startServer, type Harness } from './helpers.ts';
import { invalidArguments } from './tool-modes.test-support.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

async function connect(base: string, query = '', headers: Record<string, string> = {}): Promise<Client> {
  const client = new McpClient({ name: 'modes-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp${query}`), { requestInit: { headers } }));
  return client;
}

/** The bytes of a tools/list response as a client receives it, the JSON-RPC envelope included. */
async function listBytes(base: string, query: string): Promise<number> {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const init = await fetch(`${base}/mcp${query}`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'measure', version: '1' } } }) });
  const session = init.headers.get('mcp-session-id')!;
  await init.text();
  const list = await fetch(`${base}/mcp${query}`, { method: 'POST', headers: { ...headers, 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
  return Buffer.byteLength(await list.text());
}

/** Whether a schema still has prose: a description anywhere, except a property that is itself called description. */
function prose(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(prose);
  if (!schema || typeof schema !== 'object') return false;
  return Object.entries(schema).some(([k, v]) => (k === 'description' && typeof v === 'string') || (k === 'properties' ? Object.values(v as object).some(prose) : prose(v)));
}

const text = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n');

describe('tool list modes', () => {
  let h: Harness;
  const clients: Client[] = [];
  let full: Tool[];
  let compact: Tool[];
  let grouped: Tool[];
  let open: (query?: string, headers?: Record<string, string>) => Promise<Client>;
  beforeAll(async () => {
    h = await startServer();
    open = async (query = '', headers = {}) => {
      const c = await connect(h.base, query, headers);
      clients.push(c);
      return c;
    };
    full = (await (await open()).listTools()).tools;
    compact = (await (await open('?tools=compact')).listTools()).tools;
    grouped = (await (await open('', { 'X-Bogen-Tools': 'grouped' })).listTools()).tools;
  });
  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => {});
    await h.cleanup();
  });

  it('names its modes and profiles, and takes an unknown one as the full list, with a warning', () => {
    expect(parseToolMode(undefined)).toEqual({ mode: 'full' });
    expect(parseToolMode('Grouped').mode).toBe('grouped');
    expect(parseToolMode('tiny')).toMatchObject({ mode: 'full', warning: expect.stringContaining('BOGEN_MCP_TOOLS=tiny') });
    expect(parseToolProfile('reviewer').profile).toBe('reviewer');
    expect(parseToolProfile('admin')).toMatchObject({ profile: 'all', warning: expect.stringContaining('admin') });
    expect(firstSentence('Wait up to 60 s. Running is fine.')).toBe('Wait up to 60 s.');
    expect(firstSentence('Reads e.g. files. Then')).toBe('Reads e.g. files.');
    expect(firstSentence('word '.repeat(60)).endsWith('…')).toBe(true);
    expect(stripDescriptions({ type: 'object', description: 'x', properties: { description: { type: 'string', description: 'y' } }, required: [] })).toEqual({ type: 'object', properties: { description: { type: 'string' } } });
  });

  it('lists the full mode for an unknown value, as without one', async () => {
    const unknown = (await (await open('?tools=tiny')).listTools()).tools;
    expect(unknown.map((t) => t.name)).toEqual(full.map((t) => t.name));
  });

  it('measures each mode, and the docs give the same sizes', async () => {
    const sizes = { full: await listBytes(h.base, ''), compact: await listBytes(h.base, '?tools=compact'), grouped: await listBytes(h.base, '?tools=grouped'), reviewer: await listBytes(h.base, '?profile=reviewer') };
    console.log(`tools/list bytes: ${JSON.stringify(sizes)}; tools: full ${full.length}, compact ${compact.length}, grouped ${grouped.length}`);
    expect(sizes.compact * 10).toBeLessThan(sizes.full * 6);
    expect(sizes.grouped * 10).toBeLessThan(sizes.full);
    // The guide states the sizes, rounded to the kilobyte, so a schema change that moves them a lot shows up here.
    const agents = readFileSync(join(ROOT, 'docs', 'guide', 'agents.md'), 'utf8');
    for (const [mode, bytes] of Object.entries(sizes)) {
      const stated = (mode === 'reviewer' ? /\*\*Reviewer profile\.\*\*[^*]*?about (\d+) KB/ : new RegExp(`\\| \`${mode}\`[^\\n]*\\| about (\\d+) KB \\|`)).exec(agents)?.[1];
      expect(stated, `agents.md states the ${mode} size`).toBeDefined();
      expect(Math.abs(Number(stated) - bytes / 1000), `${mode}: ${bytes} bytes`).toBeLessThan(Math.max(6, bytes / 1000 / 5));
    }
    expect(agents).toContain(`${grouped.length - 1} area tools`);
  });

  it('keeps every tool in compact form, with first sentences, no argument prose and the same hints', () => {
    expect(compact.map((t) => t.name)).toEqual([...full.map((t) => t.name), SCHEMA_TOOL]);
    const defaults: Record<string, boolean> = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
    for (const [i, whole] of full.entries()) {
      const short = compact[i]!;
      expect(whole.description!.startsWith(short.description!.replace(/…$/, '')), whole.name).toBe(true);
      expect(prose(short.inputSchema), whole.name).toBe(false);
      expect(short.inputSchema.required ?? [], whole.name).toEqual(whole.inputSchema.required ?? []);
      expect(Object.keys(short.inputSchema.properties ?? {}), whole.name).toEqual(Object.keys(whole.inputSchema.properties ?? {}));
      for (const [key, fallback] of Object.entries(defaults)) {
        const hints = (t: Tool) => (t.annotations ?? {}) as Record<string, boolean | undefined>;
        expect(hints(short)[key] ?? fallback, `${whole.name} ${key}`).toBe(hints(whole)[key] ?? fallback);
      }
    }
  });

  it('groups every tool once, under an area with its strictest hints', () => {
    const areas = grouped.filter((t) => t.name !== SCHEMA_TOOL);
    expect(areas.length).toBeLessThanOrEqual(24);
    const ops = areas.flatMap((t) => (t.inputSchema.properties!.operation as { enum: string[] }).enum);
    expect(ops.sort()).toEqual(full.map((t) => t.name).sort());
    const byName = new Map(full.map((t) => [t.name, t]));
    for (const area of areas) {
      const members = (area.inputSchema.properties!.operation as { enum: string[] }).enum.map((n) => byName.get(n)!);
      expect(area.annotations?.readOnlyHint, area.name).toBe(members.every((m) => m.annotations?.readOnlyHint));
      expect(area.annotations?.destructiveHint, area.name).toBe(members.some((m) => m.annotations?.destructiveHint));
      expect(area.annotations?.openWorldHint, area.name).toBe(members.some((m) => m.annotations?.openWorldHint));
      expect(area.description, area.name).toContain(members[0]!.name);
    }
    expect(grouped.find((t) => t.name === 'read')!.annotations?.readOnlyHint).toBe(true);
    expect(grouped.find((t) => t.name === 'edit')!.description).toMatch(/Destructive, ask the person first: [^.]*layer_delete\(node_ids\)/);
  });

  it('answers any tool\'s whole schema through the schema tool and the reference resource, in every mode', async () => {
    const short = await open('?tools=grouped');
    const whole = full.find((t) => t.name === 'layer_style')!;
    const answer = await call(short, SCHEMA_TOOL, { operation: 'layer_style' });
    expect(answer.description).toBe(whole.description);
    expect(answer.inputSchema).toEqual(whole.inputSchema);
    expect(answer._meta).toEqual({ area: 'edit' });
    const resource = await short.readResource({ uri: 'bogen://reference/layer_style' });
    expect(JSON.parse(String((resource.contents[0] as { text?: string }).text)).inputSchema).toEqual(whole.inputSchema);
    expect((await callRaw(short, SCHEMA_TOOL, { operation: 'layer_styl' })).content[0]!.text).toMatch(/no tool layer_styl.*layer_style/);
    // The full list leaves it out, and still answers it.
    expect(full.some((t) => t.name === SCHEMA_TOOL)).toBe(false);
    expect((await call(clients[0]!, SCHEMA_TOOL, { operation: 'html_write' })).name).toBe('html_write');
  });

  it('reaches every tool by its own name in every mode, and through its area in grouped mode', async () => {
    const sessions = { full: clients[0]!, compact: clients[1]!, grouped: clients[2]! };
    const areaOf = new Map(grouped.flatMap((t) => ((t.inputSchema.properties?.operation as { enum?: string[] })?.enum ?? []).map((n) => [n, t.name] as const)));
    for (const tool of full) {
      const bad = invalidArguments(tool.inputSchema as never);
      if (bad === null) {
        // A tool that takes nothing it could refuse is read-only, so it is called for real.
        expect(tool.annotations?.readOnlyHint, `${tool.name} takes no arguments to refuse`).toBe(true);
        for (const [mode, client] of Object.entries(sessions)) expect((await callRaw(client, tool.name)).isError, `${mode} ${tool.name}`).toBe(false);
        expect((await callRaw(sessions.grouped, areaOf.get(tool.name)!, { operation: tool.name })).isError, tool.name).toBe(false);
        continue;
      }
      // Arguments the tool's own validation refuses: the call reaches the tool and runs nothing.
      for (const [mode, client] of Object.entries(sessions)) {
        const direct = await callRaw(client, tool.name, bad);
        expect(direct.isError, `${mode} ${tool.name}`).toBe(true);
        expect(text(direct), `${mode} ${tool.name}`).toMatch(new RegExp(`Invalid arguments for tool ${tool.name}`));
      }
      const viaArea = await callRaw(sessions.grouped, areaOf.get(tool.name)!, { operation: tool.name, arguments: bad });
      expect(viaArea.isError, tool.name).toBe(true);
      expect(text(viaArea), tool.name).toMatch(new RegExp(`^Invalid arguments for ${tool.name}:`));
    }
  });

  it('gives the same results by name and through an area', async () => {
    const g = clients[2]!;
    const file = await call(g, 'files', { operation: 'file_create', arguments: { name: 'Grouped' } });
    expect(file.id).toBeTruthy();
    const board = await call(g, 'edit', { operation: 'artboard_create', arguments: { name: 'Home', width: 390 } });
    const written = await call(g, 'html_write', { target_id: board.id, mode: 'into', html: '<p>Hello</p>' });
    const byName = await call(g, 'layer_get', { node_id: written.ids[0] });
    const byArea = await call(g, 'read', { operation: 'layer_get', arguments: { node_id: written.ids[0] } });
    expect(byArea).toEqual(byName);
    expect(text(await callRaw(g, 'read', { operation: 'html_write' }))).toMatch(/html_write is in edit, not read/);
    expect(text(await callRaw(g, 'read', { operation: 'layer_get', node_id: written.ids[0] }))).toMatch(/Unknown argument node_id/);
    expect(text(await callRaw(g, 'read', { operation: 'nothing' }))).toMatch(/operation is one of layer_tree/);
    expect((await g.getInstructions())).toMatch(/one tool per area/);
  });
});

describe('bogen mcp', () => {
  it('sends --tools and BOGEN_MCP_PROFILE on, and warns about a value it does not know', async () => {
    const h = await startServer();
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const start = async (args: string[], env: Record<string, string> = {}) => {
      const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', join(ROOT, 'packages/server/src/cli.ts'), 'mcp', ...args], cwd: ROOT, env: { ...process.env as Record<string, string>, BOGEN_URL: h.base, ...env }, stderr: 'pipe' });
      let err = '';
      transport.stderr?.on('data', (c) => (err += c));
      const client = new McpClient({ name: 'stdio-test', version: '1' });
      await client.connect(transport);
      return { client, stderr: () => err };
    };
    try {
      const grouped = await start(['--tools', 'grouped'], { BOGEN_MCP_PROFILE: 'reviewer' });
      const tools = (await grouped.client.listTools()).tools;
      expect(tools.find((t) => t.name === 'read')).toBeDefined();
      expect(await grouped.client.getInstructions()).toMatch(/This session reviews/);
      await grouped.client.close();
      const unknown = await start([], { BOGEN_MCP_TOOLS: 'tiny' });
      expect((await unknown.client.listTools()).tools.length).toBeGreaterThan(150);
      expect(unknown.stderr()).toMatch(/BOGEN_MCP_TOOLS=tiny is not a tool list Bogen knows/);
      await unknown.client.close();
    } finally {
      await h.cleanup();
    }
  }, 60_000);
});

describe('the reviewer profile', () => {
  let h: Harness;
  let reviewer: Client;
  let grouped: Client;
  let writer: Client;
  beforeAll(async () => {
    h = await startServer();
    writer = await connect(h.base);
    reviewer = await connect(h.base, '?profile=reviewer');
    grouped = await connect(h.base, '?tools=grouped', { 'X-Bogen-Profile': 'reviewer' });
  });
  afterAll(async () => {
    for (const c of [writer, reviewer, grouped]) await c.close().catch(() => {});
    await h.cleanup();
  });

  it('lists only read-only tools and the critique scope\'s comment and check tools', async () => {
    const { tools } = await reviewer.listTools();
    const names = tools.map((t) => t.name);
    for (const t of tools) if (!t.annotations?.readOnlyHint) expect(['comment_add', 'comment_reply', 'design_lint', 'brand_check', 'file_open'], t.name).toContain(t.name);
    expect(names).toContain('layer_tree');
    expect(names).toContain('comment_add');
    expect(names).not.toContain('html_write');
    expect(await reviewer.getInstructions()).toMatch(/This session reviews/);
  });

  it('refuses writes, by name, through an area and as a fix, and still comments', async () => {
    const file = await call(writer, 'file_create', { name: 'Review me' });
    const board = await call(writer, 'artboard_create', { file_id: file.id, name: 'Home', width: 390 });
    await call(reviewer, 'file_open', { file_id: file.id });
    const write = await callRaw(reviewer, 'html_write', { target_id: board.id, mode: 'into', html: '<p>x</p>' });
    expect(write.isError).toBe(true);
    expect(write.content[0]!.text).toMatch(/html_write changes the design, and this session is a reviewer/);
    const viaArea = await callRaw(grouped, 'read', { operation: 'layer_delete', arguments: { node_ids: [board.id] } });
    expect(viaArea.content[0]!.text).toMatch(/this session is a reviewer/);
    expect((await grouped.listTools()).tools.every((t) => t.name === SCHEMA_TOOL || !String((t.inputSchema.properties?.operation as { enum: string[] })?.enum).includes('html_write'))).toBe(true);
    const fix = await callRaw(reviewer, 'design_lint', { node_id: board.id, fix: true });
    expect(fix.content[0]!.text).toMatch(/session is a reviewer and fixes nothing/);
    const comment = await call(reviewer, 'comment_add', { node_id: board.id, text: 'The heading needs more room.' });
    expect(comment).toBeTruthy();
    const tree = await call(writer, 'layer_tree', { file_id: file.id, node_id: board.id });
    expect(JSON.stringify(tree)).not.toContain('<p>x</p>');
  });
});
