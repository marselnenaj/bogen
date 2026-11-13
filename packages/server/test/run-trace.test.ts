import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { traceArgs, traceResult, traceValue, type RunTrace } from '../src/run-trace.ts';
import { agentsTraceCommand } from '../src/agents-check-cli.ts';
import { fake, writeFakeClis } from './fake-cli.ts';
import { call, connectAgent, startServer, until, type Harness } from './helpers.ts';

// Made up, and joined at run time so that a secret scanner does not take it for a real token.
const FAKE_GITHUB_TOKEN = ['ghp', 'a'.repeat(28)].join('_');

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('what a trace keeps', () => {
  it('masks secrets, shows the home folder as ~, and keeps design tokens', () => {
    const home = homedir();
    const value = traceValue({ token: 'abc123secret', authorization: 'Bearer zzzzzzzzzzzz', path: `${home}/Work/app/src/x.tsx`, tokens: [{ name: 'accent', value: '#b4410c' }], note: `key ${FAKE_GITHUB_TOKEN}` }, 2000, home) as Record<string, unknown>;
    expect(value.token).toBe('[redacted]');
    expect(value.authorization).toBe('[redacted]');
    expect(value.path).toBe('~/Work/app/src/x.tsx');
    expect(value.tokens).toEqual([{ name: 'accent', value: '#b4410c' }]);
    expect(value.note).not.toContain('ghp_');
  });

  it('leaves out the contents of the person\'s files, keeping their size', () => {
    expect(traceResult('files', 'read_file', 'export const secretRecipe = 1;', false)).toBe('[file content left out: 30 characters]');
    expect(traceResult('files', 'read_file', 'No such file.', true)).toBe('No such file.');
    expect(traceResult('bogen', 'code_get', 'export function Hero() {}', false)).toMatch(/left out/);
    expect(traceArgs('files', 'write_file', { path: 'a.ts', content: 'abc' })).toEqual({ path: 'a.ts', content: '[file content left out: 3 characters]' });
    expect(traceResult('bogen', 'layer_tree', 'x'.repeat(9000), false).length).toBeLessThan(4100);
  });
});

describe('the trace of a run', () => {
  let h: Harness;
  let agent: Client;
  let bin = '';
  let fileId = '';
  let board = '';
  let runId = '';
  const saved = { path: process.env.PATH, browser: process.env.BOGEN_BROWSER };

  beforeAll(async () => {
    bin = mkdtempSync(join(tmpdir(), 'bogen-trace-'));
    writeFakeClis(bin, join(bin, 'log.jsonl'));
    process.env.PATH = `${bin}:${saved.path}`;
    process.env.BOGEN_BROWSER = join(bin, 'no-browser-here');
    h = await startServer();
    h.server.runs.beforeFinish = async () => ({ ok: true, message: 'Trace fixture.' });
    fileId = h.server.storage.create('Trace').id;
    const room = await h.server.rooms.get(fileId);
    const page = room.doc.getPages()[0]!.id;
    board = room.doc.insert(page, { type: 'frame', name: 'Hero', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '400px', height: '300px' } });
    const heading = room.doc.insert(board, { type: 'text', tag: 'h1', name: 'Title', text: 'Hello' });
    const res = await fetch(`${h.base}/api/runs`, json({ fileId, pageId: page, runner: 'claude', prompt: `Make the title red. ${fake({ tools: [{ name: 'layer_tree', args: {} }, { name: 'layer_style', args: { node_ids: [heading], style: { color: '#e11d48' } } }, { name: 'layer_get', args: { node_id: 'nope' } }], reply: 'The title is red now.' })}`, conversationId: 'trace-chat' }));
    expect(res.status, await res.clone().text()).toBe(201);
    runId = ((await res.json()) as { runId: string }).runId;
    await until(() => !h.server.runs.isActive(runId), 20_000);
    agent = await connectAgent(h.base, 'reviewer');
  }, 40_000);

  afterAll(async () => {
    process.env.PATH = saved.path;
    if (saved.browser === undefined) delete process.env.BOGEN_BROWSER;
    else process.env.BOGEN_BROWSER = saved.browser;
    await agent?.close();
    await h?.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  it('has the request, the instructions, each tool call with its timing, and the touched layers', async () => {
    const res = await fetch(`${h.base}/api/runs/trace/${runId}`);
    expect(res.status).toBe(200);
    const trace = await res.json() as RunTrace;
    expect(trace).toMatchObject({ format: 'bogen-run-trace', version: 1, runId, fileId, runner: 'claude', status: 'done', source: 'prompt', conversationId: 'trace-chat' });
    expect(trace.prompt.request).toContain('Make the title red.');
    expect(trace.prompt.instructions).toContain('You are drawing in Bogen');
    expect(trace.calls.map((c) => c.tool)).toEqual(['layer_tree', 'layer_style', 'layer_get']);
    const style = trace.calls[1]!;
    expect(style.args).toMatchObject({ style: { color: '#e11d48' } });
    expect(style.layers?.length).toBe(1);
    expect(style.ms).toBeGreaterThanOrEqual(0);
    expect(trace.calls[2]!.error).toBe(true);
    expect(trace.calls[2]!.result).toMatch(/No layer/);
    expect(trace.layers).toEqual(style.layers);
    expect(trace.events.some((e) => e.kind === 'text' && e.text === 'The title is red now.')).toBe(true);
    expect(trace.durationMs).toBeGreaterThan(0);
    expect(trace.redaction).toMatch(/Read it before you share it/);
  });

  it('downloads as a file', async () => {
    const res = await fetch(`${h.base}/api/runs/trace/${runId}?download=1`);
    expect(res.headers.get('content-disposition')).toMatch(new RegExp(`attachment; filename="bogen-trace-.*-${runId}\\.json"`));
    expect(((await res.json()) as RunTrace).runId).toBe(runId);
    expect((await fetch(`${h.base}/api/runs/trace/nosuchrun`)).status).toBe(404);
  });

  it('comes from MCP, listed or saved, and from the command line', async () => {
    const listed = await call(agent, 'trace_get', { file_id: fileId });
    expect(listed.runs[0].run_id).toBe(runId);
    const trace = await call(agent, 'trace_get', { run_id: runId });
    expect(trace.calls).toHaveLength(3);
    const saved = await call(agent, 'trace_get', { run_id: runId, save: true });
    expect(saved.saved.startsWith(join(h.home, 'exports'))).toBe(true);
    expect((JSON.parse(readFileSync(saved.saved, 'utf8')) as RunTrace).runId).toBe(runId);
    // The reviewer's own calls are not traced: only runs Bogen started are.
    expect((await (await fetch(`${h.base}/api/runs/trace/${runId}`)).json() as RunTrace).calls).toHaveLength(3);
    let out = '';
    const target = join(h.home, 'cli-trace.json');
    expect(await agentsTraceCommand({ url: h.base }, runId, target, (t) => { out += t; })).toBe(0);
    expect(out).toContain(target);
    expect((JSON.parse(readFileSync(target, 'utf8')) as RunTrace).calls).toHaveLength(3);
    expect(await agentsTraceCommand({ url: h.base }, 'bad id!', undefined, () => {})).toBe(2);
  });
});
