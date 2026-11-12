/**
 * OpenCode runs end to end with a stand-in `opencode` and the real Bogen server: the run's own MCP server and
 * agent, tool steps under Bogen names, the conversation reaching the next turn, Stop taking a lingering process's
 * MCP access away at once, and run identities that do not match being refused.
 *
 * These are contract fixtures, not a live provider smoke. The stand-in follows OpenCode's documented interface:
 * `--format json` events, `OPENCODE_CONFIG_CONTENT` merged over the person's config, agents selected with
 * `--agent`, and permissions whose last matching rule wins, an agent's own rules applied over the global ones
 * (dev.opencode.ai/docs/permissions, /docs/agents, /docs/config). That a real OpenCode build does the same is for
 * a separate, manual smoke run to check.
 *
 * Runs here render before/after pictures, so this suite needs BOGEN_BROWSER (the secure Chromium wrapper).
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { call, connectAgent, startServer, until, type Harness } from './helpers.ts';

// These stand-in CLIs exercise process routing, conversations and history, not visual design.
// Real measurement and repair enforcement are covered in design-quality.test.ts.
async function runnerServer(...args: Parameters<typeof startServer>) {
  const h = await startServer(...args);
  h.server.runs.beforeFinish = async () => ({ ok: true, message: 'Runner protocol fixture; visual review tested separately.' });
  return h;
}


const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const fake = (plan: Record<string, unknown>) => `FAKE${JSON.stringify(plan)}`;

const HELP = 'opencode [project]\n\nOptions:\n  -h, --help     show help\n  -v, --version  show version number\n      --pure     run without external plugins\n';
const RUN_HELP = 'opencode run [message..]\n\nOptions:\n  -m, --model   model to use in the format of provider/model\n      --agent   agent to use\n      --format  format: default (formatted) or json (raw JSON events)\n';

/**
 * The person's own OpenCode config, as unsafe as it gets: everything allowed, specific allows for the shell,
 * edits and their own MCP server, a default agent with its own allows, and a `bogen` server registered without
 * a run by `bogen install opencode`.
 */
const AMBIENT = {
  permission: { '*': 'allow', bash: 'allow', edit: 'allow', 'notes_*': 'allow', 'bogen_*': 'allow' },
  default_agent: 'build',
  agent: { build: { mode: 'primary', permission: { bash: 'allow', webfetch: 'allow' } } },
  mcp: { notes: { type: 'local', command: ['notes-mcp'] }, bogen: { type: 'local', command: ['bogen', 'mcp'] } },
};

function writeFakeOpencode(bin: string, log: string, ambient: string): void {
  writeFileSync(join(bin, 'opencode'), `#!/usr/bin/env node
const fs = process.getBuiltinModule('node:fs');
const args = process.argv.slice(2);
const log = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(o) + '\\n');
if (args[0] === '--version') { console.log('1.4.0'); process.exit(0); }
if (args[0] === '--help') { process.stdout.write(${JSON.stringify(HELP)}); process.exit(0); }
if (args[0] === 'run' && args[1] === '--help') { process.stdout.write(${JSON.stringify(RUN_HELP)}); process.exit(0); }
if (args[0] === 'models') { console.log('anthropic/claude-sonnet-4-5'); process.exit(0); }
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
if (!args.includes('--pure') || args[args.indexOf('--pure') + 1] !== 'run' || flag('--format') !== 'json') { console.error('unexpected argv'); process.exit(2); }
const message = args.at(-1);
// The person's config, then the inline one over it: keys already there keep their place, new ones come after.
const merge = (a, b) => { const out = { ...a }; for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? merge(out[k], v) : v; return out; };
const config = merge(JSON.parse(fs.readFileSync(${JSON.stringify(ambient)}, 'utf8')), JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}'));
const agentName = flag('--agent') || config.default_agent;
const agent = (config.agent || {})[agentName];
if (!agent) { console.log(JSON.stringify({ type: 'error', error: { name: 'UnknownAgent', data: { message: 'no agent ' + agentName } } })); process.exit(1); }
// Last match wins; the agent's own rules come after the global ones.
const rules = [...Object.entries(config.permission || {}), ...Object.entries(agent.permission || {})];
// The patterns used here are exact names or a prefix with a trailing *.
const matches = (p, tool) => (p.endsWith('*') ? tool.startsWith(p.slice(0, -1)) : tool === p);
const decide = (tool) => { let d = 'ask'; for (const [p, v] of rules) if (matches(p, tool)) d = v; return d; };
const run = Object.entries(config.mcp).find(([name, s]) => s.type === 'remote' && name.startsWith('bogen_run_'));
const decisions = Object.fromEntries(['bash', 'edit', 'read', 'webfetch', 'notes_search', 'bogen_layer_text', run[0] + '_layer_text'].map((t) => [t, decide(t)]));
const say = (o) => console.log(JSON.stringify({ timestamp: Date.now(), sessionID: 'ses_fake', ...o }));
const server = run[1];
log({ kind: 'call', pid: process.pid, args, message, agent: agentName, mode: agent.mode, decisions, servers: Object.keys(config.mcp), headers: Object.keys(server.headers), run: server.headers['X-Bogen-Run'] });
const start = message.lastIndexOf('FAKE{');
let plan = {};
if (start >= 0) { let depth = 0, end = start + 4; for (; end < message.length; end++) { if (message[end] === '{') depth++; else if (message[end] === '}' && --depth === 0) break; } plan = JSON.parse(message.slice(start + 4, end + 1)); }
const rpc = async (session, id, method, params) => {
  const res = await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
  return { session: res.headers.get('mcp-session-id'), body: id ? await res.json() : null };
};
(async () => {
  say({ type: 'step_start', part: { type: 'step-start' } });
  // A denied built-in shows up as a tool with an error state, and never runs.
  if (plan.tryShell) say({ type: 'tool_use', part: { tool: 'bash', state: { status: 'error', error: 'denied by permission' } } });
  const { session } = await rpc(null, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'opencode', version: '1.4.0' } });
  await rpc(session, null, 'notifications/initialized', {});
  let n = 10;
  for (const t of plan.tools || []) {
    if (decide(run[0] + '_' + t.name) !== 'allow') throw new Error('denied ' + t.name);
    say({ type: 'tool_use', part: { tool: run[0] + '_' + t.name, state: { status: 'running' } } });
    const r = (await rpc(session, n++, 'tools/call', { name: t.name, arguments: t.args || {} })).body;
    log({ kind: 'tool', name: t.name, error: r.result && r.result.isError ? r.result.content[0].text : r.error ? r.error.message : null });
  }
  // It lingers past SIGTERM, as a CLI that ignores it would; "ready" says so, and only then may a test stop it.
  if (plan.hang) { process.on('SIGTERM', () => log({ kind: 'sigterm' })); setInterval(() => {}, 1000); log({ kind: 'ready', run: server.headers['X-Bogen-Run'] }); return; }
  if (plan.error) { say({ type: 'error', error: { name: 'APIError', data: { message: plan.error } } }); say({ type: 'error', error: { name: 'APIError', data: { message: plan.error } } }); process.exit(0); }
  say({ type: 'text', part: { type: 'text', text: plan.reply || 'Done.' } });
  say({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } });
})().catch((e) => { console.error(String(e)); process.exit(1); });
`);
  chmodSync(join(bin, 'opencode'), 0o755);
}

describe('OpenCode runs, with a stand-in CLI', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-opencode-bin-'));
  const log = join(bin, 'calls.jsonl');
  const ambient = join(bin, 'ambient.json');
  const savedPath = process.env.PATH;
  let h: Harness;
  let file: string;
  let other: string;
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const history = async () => (await fetch(`${h.base}/api/runs?fileId=${file}`)).json() as Promise<any[]>;
  const start = async (body: Record<string, unknown>) => {
    const res = await fetch(`${h.base}/api/runs`, json({ fileId: file, runner: 'opencode', ...body }));
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json() as { runId: string }).runId;
  };
  const idle = () => until(() => !h.server.runs.activeFor(file), 10_000);

  beforeAll(async () => {
    writeFileSync(ambient, JSON.stringify(AMBIENT));
    writeFakeOpencode(bin, log, ambient);
    // A grok on PATH that would say if it were ever started.
    writeFileSync(join(bin, 'grok'), `#!/usr/bin/env node\nprocess.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: 'grok', args: process.argv.slice(2) }) + '\\n');\n`);
    chmodSync(join(bin, 'grok'), 0o755);
    symlinkSync(process.execPath, join(bin, 'node'));
    process.env.PATH = `${bin}:${savedPath}`;
    h = await runnerServer();
    file = (await (await fetch(`${h.base}/api/files`, json({ name: 'OpenCode runs' }))).json() as { id: string }).id;
    other = (await (await fetch(`${h.base}/api/files`, json({ name: 'Another file' }))).json() as { id: string }).id;
  });

  afterAll(async () => {
    process.env.PATH = savedPath;
    await h.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  it('works through the run\'s own server and agent, with only Bogen\'s tools allowed over an unsafe config', async () => {
    const runId = await start({ prompt: `Draw a card ${fake({ tryShell: true, tools: [{ name: 'artboard_create', args: { name: 'From OpenCode', width: 200, height: 100 } }], reply: 'Made the card.' })}`, model: 'anthropic/claude-sonnet-4-5' });
    await until(async () => (await history()).find((r) => r.id === runId)?.status === 'done', 10_000);
    const record = (await history()).find((r) => r.id === runId);
    expect(record).toMatchObject({ runner: 'opencode', model: 'anthropic/claude-sonnet-4-5', status: 'done', result: 'Made the card.' });
    // Steps under Bogen's own tool names; the denied shell is no step.
    expect(record.tools).toEqual([{ name: 'artboard_create', count: 1 }]);
    expect((await h.server.rooms.get(file)).doc.getNode(record.layers[0])?.name).toBe('From OpenCode');

    const first = calls().find((c) => c.kind === 'call' && c.run === runId);
    expect(first.agent).toBe(`bogen-run-${runId.replace(/[^A-Za-z0-9]/g, '')}`);
    expect(first.mode).toBe('primary');
    expect(first.args.slice(0, 6)).toEqual(['--pure', 'run', '--format', 'json', '--agent', first.agent]);
    expect(first.args).toContain('anthropic/claude-sonnet-4-5');
    expect(first.message).toMatch(/^You are drawing in Bogen, a design canvas/);
    // The person's own servers are merged in; only the run's own is allowed.
    expect(first.servers).toEqual(['notes', 'bogen', `bogen_run_${runId.replace(/[^A-Za-z0-9]/g, '')}`]);
    expect(first.decisions).toEqual({ bash: 'deny', edit: 'deny', read: 'deny', webfetch: 'deny', notes_search: 'deny', bogen_layer_text: 'deny', [`bogen_run_${runId.replace(/[^A-Za-z0-9]/g, '')}_layer_text`]: 'allow' });
    expect(first.headers).toEqual(['X-Bogen-Agent', 'X-Bogen-File', 'X-Bogen-Run']);
    expect(calls().filter((c) => c.kind === 'tool')).toEqual([{ kind: 'tool', name: 'artboard_create', error: null }]);
  });

  it('gives the next turn of a conversation the turns before it', async () => {
    await idle();
    const conversationId = 'chatOpencode1';
    const one = await start({ prompt: `Make the heading blue ${fake({ tools: [{ name: 'artboard_create', args: { name: 'Turn one', width: 100, height: 100 } }], reply: 'Blue now.' })}`, conversationId });
    await until(async () => (await history()).find((r) => r.id === one)?.status === 'done', 10_000);
    const two = await start({ prompt: `And bigger ${fake({ tools: [{ name: 'artboard_create', args: { name: 'Turn two', width: 100, height: 100 } }], reply: 'Bigger.' })}`, conversationId });
    await until(async () => (await history()).find((r) => r.id === two)?.status === 'done', 10_000);
    const second = calls().find((c) => c.kind === 'call' && c.run === two);
    expect(second.message).toContain('Make the heading blue');
    expect(second.message).toContain("The person's new message:\nAnd bigger");
  });

  it('fails on an error event even when the CLI exits 0, and says it once', async () => {
    await idle();
    const runId = await start({ prompt: `Try ${fake({ error: 'No API key for anthropic' })}` });
    await until(async () => (await history()).find((r) => r.id === runId)?.status === 'failed', 10_000);
    expect((await history()).find((r) => r.id === runId)?.error).toBe('No API key for anthropic');
  });

  it('takes a run\'s MCP access away the moment it is stopped, while its process still lingers', async () => {
    await idle();
    const runId = await start({ prompt: `Wait ${fake({ hang: true })}` });
    await until(() => calls().some((c) => c.kind === 'ready' && c.run === runId), 10_000);
    const { pid } = calls().find((c) => c.kind === 'call' && c.run === runId);
    const headers = { 'X-Bogen-Run': runId, 'X-Bogen-File': file, 'X-Bogen-Agent': 'opencode' };
    const session = await connectAgent(h.base, 'opencode', headers);
    expect(await call(session, 'file_list')).toBeTruthy();

    // A run's identity that does not match is refused, never opened without a run.
    await expect(connectAgent(h.base, 'opencode', { ...headers, 'X-Bogen-File': other })).rejects.toThrow();
    await expect(connectAgent(h.base, 'opencode', { ...headers, 'X-Bogen-Agent': 'claude' })).rejects.toThrow();
    await expect(connectAgent(h.base, 'opencode', { ...headers, 'X-Bogen-Run': 'nosuchrun' })).rejects.toThrow();
    await expect(connectAgent(h.base, 'opencode', { ...headers, 'X-Bogen-Run': 'not a run id!' })).rejects.toThrow();
    // Without the file header, the session is on the run's own file.
    const unfiled = await connectAgent(h.base, 'opencode', { 'X-Bogen-Run': runId, 'X-Bogen-Agent': 'opencode' });
    const made = await call<{ id: string }>(unfiled, 'artboard_create', { name: 'Unfiled run board', width: 100, height: 100 });
    expect((await h.server.rooms.get(file)).doc.getNode(made.id)?.name).toBe('Unfiled run board');
    expect((await h.server.rooms.get(other)).doc.getNode(made.id)).toBeUndefined();

    expect((await fetch(`${h.base}/api/runs/${runId}/stop`, json({}))).status).toBe(200);
    // Right after Stop, before the process is gone: no tool call, no reconnect.
    expect(() => process.kill(pid, 0)).not.toThrow();
    await expect(call(session, 'file_list')).rejects.toThrow();
    await expect(call(unfiled, 'file_list')).rejects.toThrow();
    await expect(connectAgent(h.base, 'opencode', headers)).rejects.toThrow();
    await until(async () => (await history()).find((r) => r.id === runId)?.status === 'stopped', 10_000);
    // Long after it ended, the same identity is still refused.
    await expect(connectAgent(h.base, 'opencode', headers)).rejects.toThrow();
  });

  it('leaves an MCP session without a run as it was', async () => {
    const outside = await connectAgent(h.base, 'some-agent', { 'X-Bogen-File': file });
    expect(await call(outside, 'file_list')).toBeTruthy();
    await outside.close();
  });

  it('refuses a run of Grok with its reason, and never starts Grok or another runner instead', async () => {
    await idle();
    const before = calls().length;
    const res = await fetch(`${h.base}/api/runs`, json({ fileId: file, runner: 'grok', prompt: 'Hello' }));
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/Bogen cannot run Grok itself yet/);
    expect(calls().slice(before)).toEqual([]);
    expect(h.server.runs.count()).toBe(0);
  });

  it('lets go of a stopped run\'s branch at once, while an agent that is still writing keeps it busy', async () => {
    await idle();
    const runId = await start({ prompt: `Wait ${fake({ hang: true })}` });
    await until(() => calls().some((c) => c.kind === 'ready' && c.run === runId), 10_000);
    const run = await connectAgent(h.base, 'opencode', { 'X-Bogen-Run': runId, 'X-Bogen-File': file, 'X-Bogen-Agent': 'opencode' });
    await call(run, 'artboard_create', { name: 'Run is writing', width: 100, height: 100 });
    const asker = await connectAgent(h.base, 'claude', { 'X-Bogen-Agent': 'claude', 'X-Bogen-File': file });
    await expect(call(asker, 'branch_create', { name: 'while busy' })).rejects.toThrow(/^branch_create: opencode is working on the checked-out version/);

    const other = await connectAgent(h.base, 'codex', { 'X-Bogen-Agent': 'codex', 'X-Bogen-File': file });
    await call(other, 'artboard_create', { name: 'Codex is writing', width: 100, height: 100 });
    expect((await fetch(`${h.base}/api/runs/${runId}/stop`, json({}))).status).toBe(200);
    // The run is gone from the guard at once; Codex, still going, is not.
    await expect(call(asker, 'branch_create', { name: 'still busy' })).rejects.toThrow(/^branch_create: codex is working on the checked-out version/);

    // Codex's session ends: nothing holds the branch any more.
    await (other.transport as StreamableHTTPClientTransport).terminateSession();
    await other.close();
    // A branch is made inside this same file.
    const made = await call<{ file_id: string; branch: { id: string } }>(asker, 'branch_create', { name: 'after both' });
    expect(made.file_id).toBe(file);
    expect(made.branch.id).toBeTruthy();
    await asker.close();
    await until(async () => (await history()).find((r) => r.id === runId)?.status === 'stopped', 10_000);
  });

  it('lists the newer runners without starting them, and probes OpenCode only once picked', async () => {
    const runners = await (await fetch(`${h.base}/api/runners`)).json() as { id: string; available: boolean; reason?: string }[];
    expect(runners.map((r) => r.id)).toEqual(['claude', 'codex', 'grok', 'opencode', 'hermes', 'omp']);
    expect(runners.find((r) => r.id === 'grok')).toMatchObject({ available: false });
    const catalog = await (await fetch(`${h.base}/api/run-settings/catalog/opencode`)).json() as { models: { id: string }[] };
    expect(catalog.models.map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4-5']);
    expect((await fetch(`${h.base}/api/run-settings/catalog/nobody`)).status).toBe(404);
  });
});
