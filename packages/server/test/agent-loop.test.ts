import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { acceptProposal, BogenDoc, createProposals, discardProposal, listProposals, proposalMark, Y } from '@bogen/core';
import { buildCommand } from '../src/agents.ts';
import { install, jsoncRemove, tomlRemoveServer, uninstall, registration } from '../src/install.ts';
import { parseClaudeHelp, parseCodexModels } from '../src/run-settings.ts';
import { skillPath, skillText } from '../src/skill.ts';
import { call, callRaw, connectAgent, startServer, until, type Harness } from './helpers.ts';

const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// These stand-in CLIs exercise process routing, conversations and history, not visual design.
// Real measurement and repair enforcement are covered in design-quality.test.ts.
async function runnerServer(...args: Parameters<typeof startServer>) {
  const h = await startServer(...args);
  h.server.runs.beforeFinish = async () => ({ ok: true, message: 'Runner protocol fixture; visual review tested separately.' });
  return h;
}

/** A CLI that records how it was called, and uses the MCP server it was given for a few tool calls. */
function fakeClis(bin: string, log: string): void {
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(bin, name), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.0.0 (Fake)'); process.exit(0); }
if (args[0] === '--help') { console.log("  --effort <level>  Effort level (low, medium, high)\\n  --model <model>  Provide an alias (e.g. 'opus', or 'sonnet')."); process.exit(0); }
if (args[0] === 'debug') { console.log(JSON.stringify({ models: [
  { slug: 'big', display_name: 'Big', description: 'Frontier', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
  { slug: 'small', display_name: 'Small', description: 'Fast and affordable', visibility: 'list', priority: 5, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
  { slug: 'secret', visibility: 'hide', priority: 0, description: 'Fast' },
] })); process.exit(0); }
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
if (args.includes('--input-format')) {
  const frames = stdin.trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line));
  if (frames.length === 1 && frames[0].type === 'control_request' && frames[0].request?.subtype === 'initialize') {
    const models = ['haiku', 'sonnet', 'opus'].map((id) => ({ value:id, displayName:id[0].toUpperCase()+id.slice(1)+' 5.5', resolvedModel:'claude-'+id+'-5-5', supportsEffort:true, supportedEffortLevels:['low','medium','high'] }));
    console.log(JSON.stringify({type:'control_response', response:{subtype:'success',request_id:frames[0].request_id,response:{models}}}));process.exit(0);
  }
}

fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ runner: ${JSON.stringify(name)}, args, stdin }) + '\\n');
const say = (o) => console.log(JSON.stringify(o));
const mode = (/fake:(\\w+)/.exec(stdin) || [])[1];
const codex = ${JSON.stringify(name)} === 'codex';
// Only agrees, unless it was told it changed nothing.
const talk = mode === 'talk' && !stdin.includes('You replied without changing anything');
const text = (t) => say(codex ? { type: 'item.completed', item: { type: 'agent_message', text: t } } : { type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const finish = () => { text(talk ? "You're right, that should be bigger." : 'All done with fake.'); if (!codex) say({ type: 'result', is_error: false }); };
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
if (mode === 'fail') { say({ type: 'result', is_error: true, result: 'It broke.' }); process.exit(1); }
// Claude gets a config file; Codex gets -c options, with the headers as a TOML inline table.
const option = (key) => { const a = args.find((x) => x.startsWith(key + '=')); return a && a.slice(key.length + 1); };
const config = args.includes('--mcp-config') ? JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.bogen
  : option('mcp_servers.bogen.url') ? { url: JSON.parse(option('mcp_servers.bogen.url')), headers: JSON.parse(option('mcp_servers.bogen.http_headers').replace(/"=/g, '":')) } : null;
if (!config) { finish(); process.exit(0); }
if (!codex) say({ type: 'system', subtype: 'init', model: 'fake-model-1' });
const rpc = (session, id, method, params) => fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
(async () => {
  const init = await rpc(null, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  const session = init.headers.get('mcp-session-id');
  await rpc(session, null, 'notifications/initialized', {});
  if (!talk) {
    say(codex ? { type: 'item.started', item: { type: 'mcp_tool_call', tool: 'artboard_create' } } : { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__bogen__artboard_create' }] } });
    await rpc(session, 2, 'tools/call', { name: 'artboard_create', arguments: { name: 'From a run', width: 200, height: 100 } });
  }
  finish();
})();
`);
    chmodSync(join(bin, name), 0o755);
  }
}

describe('choosing a model, and what runs leave behind', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-loop-bin-'));
  const log = join(bin, 'runs.jsonl');
  const savedPath = process.env.PATH;
  let h: Harness;
  let file: string;
  let page: string;
  const runs = (): { runner: string; args: string[]; stdin: string }[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const history = async () => (await fetch(`${h.base}/api/runs?fileId=${file}`)).json() as Promise<any[]>;
  const last = () => runs().at(-1)!;

  beforeAll(async () => {
    fakeClis(bin, log);
    process.env.PATH = `${bin}:${savedPath}`;
    h = await runnerServer();
    const created = await (await fetch(`${h.base}/api/files`, json({ name: 'Runs' }))).json() as { id: string };
    file = created.id;
    page = (await h.server.rooms.get(file)).doc.getPages()[0]!.id;
  });

  afterAll(async () => {
    process.env.PATH = savedPath;
    await h.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  it('lists what each CLI offers, from the CLI itself', async () => {
    const answer = await (await fetch(`${h.base}/api/run-settings`)).json() as any;
    expect(answer.catalogs.claude.source).toBe('cli');
    expect(answer.catalogs.claude.efforts).toEqual(['low', 'medium', 'high']);
    expect(answer.catalogs.claude.models.map((m: any) => m.id)).toEqual(expect.arrayContaining(['haiku', 'sonnet', 'opus']));
    expect(answer.catalogs.claude.cheap).toEqual({ model: 'haiku', effort: 'low' });
    expect(answer.catalogs.codex.models.map((m: any) => m.id)).toEqual(['big', 'small']);
    expect(answer.catalogs.codex.cheap).toEqual({ model: 'small', effort: 'low' });
  });

  it('parses the real shapes of both CLIs', () => {
    const help = `  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.`;
    const parsed = parseClaudeHelp(help);
    expect(parsed.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(parsed.models).toEqual(expect.arrayContaining(['haiku', 'sonnet', 'opus', 'fable']));
    expect(parseCodexModels('{"models":[]}').models).toEqual([]);
  });

  it('makes a comment cheap unless someone chose otherwise, and remembers the choice', async () => {
    const post = (body: object) => fetch(`${h.base}/api/comments`, json({ fileId: file, author: 'Mara', pageId: page, ...body }));
    expect((await post({ text: '@claude look at this' })).status).toBe(201);
    await until(() => runs().length === 1 && !h.server.runs.activeFor(file));
    expect(flag(last().args, '--model')).toBe('haiku');
    expect(flag(last().args, '--effort')).toBe('low');

    expect((await post({ text: '@codex and you' })).status).toBe(201);
    await until(() => runs().length === 2 && !h.server.runs.activeFor(file));
    expect(last().args).toEqual(expect.arrayContaining(['-m', 'small', '-c', 'model_reasoning_effort="low"']));

    // What is asked for in one comment wins.
    await post({ text: '@claude harder', model: 'opus', effort: 'high' });
    await until(() => runs().length === 3 && !h.server.runs.activeFor(file));
    expect(flag(last().args, '--model')).toBe('opus');
    expect(flag(last().args, '--effort')).toBe('high');

    // The saved choice comes next, survives a restart of the settings, and default means no flag.
    const saved = await fetch(`${h.base}/api/run-settings`, json({ runner: 'claude', scope: 'comment', model: 'sonnet', effort: 'default' }, 'PATCH'));
    expect(saved.status).toBe(200);
    await post({ text: '@claude again' });
    await until(() => runs().length === 4 && !h.server.runs.activeFor(file));
    expect(flag(last().args, '--model')).toBe('sonnet');
    expect(last().args).not.toContain('--effort');
    expect(JSON.parse(readFileSync(join(h.home, 'run-settings.json'), 'utf8')).runners.claude.comment.model).toBe('sonnet');
  });

  it('refuses a model or effort that could be read as something else', async () => {
    for (const body of [{ model: '--dangerously' + ' x' }, { model: 'a;rm' }, { effort: 'low"; x' }]) {
      const res = await fetch(`${h.base}/api/runs`, json({ fileId: file, prompt: 'hi', runner: 'claude', ...body }));
      expect(res.status).toBe(400);
    }
    expect((await fetch(`${h.base}/api/run-settings`, json({ runner: 'claude', scope: 'prompt', model: 'x y' }, 'PATCH'))).status).toBe(400);
  });

  it('keeps a history per file with everything about a run, across a restart', async () => {
    await until(() => !h.server.runs.activeFor(file));
    const { runId } = await (await fetch(`${h.base}/api/runs`, json({ fileId: file, pageId: page, prompt: 'Draw something', runner: 'claude', model: 'opus', effort: 'high' }))).json() as { runId: string };
    await until(async () => (await history()).find((r) => r.id === runId)?.status === 'done', 8000);
    const record = (await history()).find((r) => r.id === runId);
    expect(record).toMatchObject({ prompt: 'Draw something', runner: 'claude', model: 'opus', effort: 'high', actualModel: 'fake-model-1', source: 'prompt', status: 'done', result: 'All done with fake.' });
    expect(record.tools).toEqual([{ name: 'artboard_create', count: 1 }]);
    expect(record.durationMs).toBeGreaterThan(0);
    expect(record.layers).toHaveLength(1);
    const layer = (await h.server.rooms.get(file)).doc.getNode(record.layers[0]);
    expect(layer?.name).toBe('From a run');

    // It also knows comment runs, and failures.
    await fetch(`${h.base}/api/comments`, json({ fileId: file, author: 'M', pageId: page, text: '@claude fake:fail' }));
    await until(async () => (await history())[0].status === 'failed', 8000);
    expect((await history())[0]).toMatchObject({ source: 'comment', status: 'failed', error: 'It broke.' });

    // Stop, and re-run.
    const started = await (await fetch(`${h.base}/api/runs`, json({ fileId: file, prompt: 'fake:hang', runner: 'claude' }))).json() as { runId: string };
    await until(async () => (await history())[0].id === started.runId);
    expect((await fetch(`${h.base}/api/runs/${started.runId}/stop`, { method: 'POST' })).status).toBe(200);
    await until(async () => (await history())[0].status === 'stopped', 8000);
    const before = runs().length;
    const again = await fetch(`${h.base}/api/runs/${runId}/rerun`, json({ fileId: file }));
    expect(again.status).toBe(201);
    await until(() => runs().length === before + 1);
    expect(last().stdin).toBe('Draw something');
    expect(flag(last().args, '--model')).toBe('opus');
    await until(() => !h.server.runs.activeFor(file), 8000);
    expect((await fetch(`${h.base}/api/runs/nope/rerun`, json({ fileId: file }))).status).toBe(404);

    const { BogenServer } = await import('../src/http/server.ts');
    await until(async () => (await history())[0].status === 'done', 8000);
    const count = (await history()).length;
    await h.server.history.close();
    const second = new BogenServer({ home: h.home, port: 0 });
    await second.listen();
    try {
      const reread = await (await fetch(`${second.localUrl()}/api/runs?fileId=${file}`)).json() as any[];
      expect(reread).toHaveLength(count);
      expect(reread.find((r) => r.id === runId).prompt).toBe('Draw something');
    } finally {
      await second.close();
    }
  });

  it('says that a run was cut off when the server went away', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bogen-loop-cut-'));
    const first = await runnerServer({}, home);
    const id = (await (await fetch(`${first.base}/api/files`, json({}))).json() as { id: string }).id;
    const started = await (await fetch(`${first.base}/api/runs`, json({ fileId: id, prompt: 'fake:hang', runner: 'claude' }))).json() as { runId: string };
    await until(async () => ((await (await fetch(`${first.base}/api/runs?fileId=${id}`)).json()) as any[]).length === 1);
    await first.server.close();
    // What the file says when a crash, rather than a clean stop, cut it off.
    const path = join(home, 'runs', `${id}.json`);
    const list = JSON.parse(readFileSync(path, 'utf8'));
    list[0].status = 'running';
    writeFileSync(path, JSON.stringify(list));
    const again = await runnerServer({}, home);
    const records = await (await fetch(`${again.base}/api/runs?fileId=${id}`)).json() as any[];
    expect(records[0]).toMatchObject({ id: started.runId, status: 'interrupted' });
    await again.cleanup();
  });

  it('tells the bar widget about comments and finished runs, and lists recent runs', async () => {
    const before = await (await fetch(`${h.base}/api/notifications?since=0`)).json() as { seq: number };
    await fetch(`${h.base}/api/comments`, json({ fileId: file, author: 'Someone', pageId: page, text: 'A plain note' }));
    const notes = await (await fetch(`${h.base}/api/notifications?since=${before.seq}`)).json() as { seq: number; items: any[] };
    expect(notes.items.map((n) => n.title)).toEqual(['Someone commented']);
    expect(notes.items[0]).toMatchObject({ kind: 'comment', fileId: file, fileName: 'Runs', body: 'A plain note' });
    await fetch(`${h.base}/api/comments`, json({ fileId: file, author: 'Someone', pageId: page, text: '@claude ok' }));
    await until(async () => ((await (await fetch(`${h.base}/api/notifications?since=${notes.seq}`)).json()) as { items: any[] }).items.some((n) => n.kind === 'run'), 8000);
    const later = await (await fetch(`${h.base}/api/notifications?since=${notes.seq}`)).json() as { items: any[] };
    expect(later.items.find((n) => n.kind === 'run')).toMatchObject({ title: 'claude finished on a comment', fileId: file });
    expect(await (await fetch(`${h.base}/api/notifications?since=${later.items.at(-1).seq}`)).json()).toMatchObject({ items: [] });

    const recent = await (await fetch(`${h.base}/api/runs/recent?limit=2`)).json() as any[];
    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({ fileId: file, fileName: 'Runs' });
    expect(recent[0].prompt.length).toBeLessThanOrEqual(200);
    expect(recent[0].prompt).not.toContain('Comment thread');
  });

  it('imports the palette only where there is a theme', async () => {
    const answer = await (await fetch(`${h.base}/api/omarchy/palette`)).json() as { tokens: { name: string }[] };
    const res = await fetch(`${h.base}/api/omarchy/palette`, json({ fileId: file }));
    if (!answer.tokens.length) expect(res.status).toBe(409);
    else {
      expect(res.status).toBe(200);
      const room = await h.server.rooms.get(file);
      expect(room.doc.getTokens().map((t) => t.name)).toEqual(expect.arrayContaining(answer.tokens.map((t) => t.name)));
    }
  });

  it('asks a run to work in a proposal when the person wants to review', () => {
    const built = buildCommand('claude', { fileId: 'f', fileName: 'F', prompt: 'x', runner: 'claude', review: 'directions' }, { url: 'http://x' }, '/tmp/c', '/tmp');
    expect(built.args.join(' ')).toMatch(/proposal_create on the layer with count 3/);
  });

  /** Starts a prompt run and waits for it to end, nudge and all. */
  const run = async (body: Record<string, unknown>) => {
    const res = await fetch(`${h.base}/api/runs`, json({ fileId: file, pageId: page, ...body }));
    expect(res.status).toBe(201);
    const { runId } = await res.json() as { runId: string };
    await until(() => !h.server.runs.activeFor(file), 8000);
    return runId;
  };

  it('remembers a conversation across runs and runners, and each run hears the turns before it', async () => {
    const first = await run({ prompt: 'Draw a pricing card', runner: 'claude', conversationId: 'chat-a' });
    expect(last().stdin).toBe('Draw a pricing card');
    const drawn = (await history()).find((r) => r.id === first)!;
    expect(drawn.layers).toHaveLength(1);
    expect(drawn.conversationId).toBe('chat-a');

    // The person switches to Codex mid-conversation: it gets what Claude was asked, said and drew.
    await run({ prompt: 'Now make it narrower', runner: 'codex', conversationId: 'chat-a' });
    expect(last().runner).toBe('codex');
    expect(last().stdin).toContain('Earlier in this conversation, oldest first:\n\nThe person: Draw a pricing card\nclaude answered: All done with fake.');
    expect(last().stdin).toContain(`Layers it created or changed: ${drawn.layers[0]}`);
    expect(last().stdin).toMatch(/The person's new message:\nNow make it narrower$/);
    expect(last().stdin).toContain('Treat the earlier turns as context');

    await run({ prompt: 'And darker', runner: 'claude', conversationId: 'chat-a' });
    expect(last().stdin).toContain('The person: Now make it narrower\ncodex answered: All done with fake.');
    expect(flag(last().args, '--append-system-prompt')).toContain('Treat the earlier turns as context');

    // Outside the conversation, or in another one, a run starts with nothing.
    await run({ prompt: 'Something else', runner: 'claude' });
    expect(last().stdin).toBe('Something else');
    expect(flag(last().args, '--append-system-prompt')).not.toContain('earlier turns');
    await run({ prompt: 'Another chat', runner: 'claude', conversationId: 'chat-b' });
    expect(last().stdin).toBe('Another chat');

    const chat = await (await fetch(`${h.base}/api/runs/conversations/chat-a?fileId=${file}`)).json() as { turns: any[] };
    expect(chat.turns.map((t) => [t.runner, t.message, t.reply, t.status])).toEqual([
      ['claude', 'Draw a pricing card', 'All done with fake.', 'done'],
      ['codex', 'Now make it narrower', 'All done with fake.', 'done'],
      ['claude', 'And darker', 'All done with fake.', 'done'],
    ]);
    expect(chat.turns[0].layers).toEqual(drawn.layers);
    expect((await (await fetch(`${h.base}/api/runs/conversations/none-yet?fileId=${file}`)).json() as { turns: any[] }).turns).toEqual([]);
  });

  it('continues a run once that agreed without changing anything, and leaves the others alone', async () => {
    let before = runs().length;
    const nudged = await run({ prompt: 'make the title bigger fake:talk', runner: 'claude' });
    const [asked, again, ...more] = runs().slice(before);
    expect(more).toEqual([]);
    expect(asked!.stdin).toBe('make the title bigger fake:talk');
    expect(again!.stdin).toContain("make the title bigger fake:talk\n\n---\nYou already answered this request once. Your reply was:\nYou're right, that should be bigger.");
    expect(again!.stdin).toMatch(/You replied without changing anything\. If the person asked for a change, make it now; if it truly was only a question, say so in one sentence\.$/);
    const record = (await history()).find((r) => r.id === nudged)!;
    expect(record).toMatchObject({ status: 'done', nudged: true, firstReply: "You're right, that should be bigger.", result: 'All done with fake.' });
    expect(record.layers).toHaveLength(1);

    // Codex's stream is read the same way.
    before = runs().length;
    await run({ prompt: 'can you make it darker? fake:talk', runner: 'codex' });
    expect(runs().length).toBe(before + 2);

    // A question for information, a critique, and a run that changed something get no second go.
    for (const body of [
      { prompt: 'which font is this, fake:talk?', runner: 'claude' },
      { prompt: 'make the title bigger fake:talk', runner: 'claude', review: 'critique' },
      { prompt: 'make the title bigger', runner: 'claude' },
    ]) {
      before = runs().length;
      const runId = await run(body);
      expect(runs().length, body.prompt).toBe(before + 1);
      expect((await history()).find((r) => r.id === runId)!.nudged).toBeUndefined();
    }
  });

  it('keeps a conversation across a restart of the server', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bogen-loop-chat-'));
    const first = await runnerServer({}, home);
    const id = (await (await fetch(`${first.base}/api/files`, json({}))).json() as { id: string }).id;
    await fetch(`${first.base}/api/runs`, json({ fileId: id, prompt: 'Draw a hero', runner: 'claude', conversationId: 'kept' }));
    await until(() => !first.server.runs.activeFor(id), 8000);
    await first.server.close();
    const again = await runnerServer({}, home);
    try {
      const chat = await (await fetch(`${again.base}/api/runs/conversations/kept?fileId=${id}`)).json() as { turns: any[] };
      expect(chat.turns.map((t) => [t.message, t.status])).toEqual([['Draw a hero', 'done']]);
      await fetch(`${again.base}/api/runs`, json({ fileId: id, prompt: 'Make it calmer', runner: 'claude', conversationId: 'kept' }));
      await until(() => !again.server.runs.activeFor(id), 8000);
      expect(last().stdin).toContain('The person: Draw a hero\nclaude answered: All done with fake.');
    } finally {
      await again.cleanup();
    }
  });
});

describe('the activity feed', () => {
  let h: Harness;
  let agent: Client;
  let other: Client;
  let file: string;
  let board: string;

  beforeAll(async () => {
    h = await runnerServer();
    agent = await connectAgent(h.base, 'alice');
    other = await connectAgent(h.base, 'bob');
    file = (await call(agent, 'file_create', { name: 'Feed' })).id;
    await call(other, 'file_open', { file_id: file });
    board = (await call(agent, 'artboard_create', { name: 'Board', width: 200, height: 120 })).id;
  });

  afterAll(async () => {
    await agent.close();
    await other.close();
    await h.cleanup();
  });

  const steps = async () => (await fetch(`${h.base}/api/agents/steps?fileId=${file}`)).json() as Promise<any[]>;

  it('keeps each step with its layers, before and after', async () => {
    await call(agent, 'layer_style', { node_ids: [board], style: { backgroundColor: '#ff0000' } });
    await call(agent, 'layer_style', { node_ids: [board], style: { backgroundColor: '#00ff00', borderRadius: '8px' } });
    const list = await steps();
    expect(list[0]).toMatchObject({ agent: 'alice', tool: 'layer_style', undone: false });
    const change = list[0].changes.find((c: any) => c.nodeId === board);
    expect(change.kind).toBe('changed');
    expect(change.name).toBe('Board');
    expect(change.fields).toEqual(expect.arrayContaining([
      { field: 'style.backgroundColor', before: '#ff0000', after: '#00ff00' },
      expect.objectContaining({ field: 'style.borderRadius', after: '8px' }),
    ]));
    expect(list.at(-1).changes[0].kind).toBe('added');
    expect(list.at(-1).pageId).toBeTruthy();
  });

  it('renders before and after as images that differ', async () => {
    const [newest] = await steps();
    const image = async (which: string) => {
      const res = await fetch(`${h.base}/api/agents/steps/${newest.id}/preview?fileId=${file}&which=${which}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/png');
      return Buffer.from(await res.arrayBuffer());
    };
    const before = await image('before');
    const after = await image('after');
    expect(before.equals(after)).toBe(false);
    const made = (await steps()).at(-1);
    const none = await fetch(`${h.base}/api/agents/steps/${made.id}/preview?fileId=${file}&which=before`);
    expect(none.status).toBe(404);
  });

  it('undoes one step out of order, and only that agent\'s', async () => {
    const room = await h.server.rooms.get(file);
    await call(agent, 'layer_style', { node_ids: [board], style: { opacity: '0.5' } });
    await call(other, 'layer_style', { node_ids: [board], style: { color: '#123456' } });
    await call(agent, 'layer_style', { node_ids: [board], style: { padding: '4px' } });
    const list = await steps();
    const opacity = list.find((s) => s.changes[0]?.fields?.some((f: any) => f.field === 'style.opacity'));
    const res = await fetch(`${h.base}/api/agents/steps/undo`, json({ fileId: file, stepId: opacity.id }));
    expect(await res.json()).toEqual({ undone: true });
    const style = room.doc.getNode(board)!.style;
    expect(style.opacity).toBeUndefined();
    expect(style.padding).toBe('4px');
    expect(style.color).toBe('#123456');
    expect((await steps()).find((s) => s.id === opacity.id).undone).toBe(true);
    // Twice is no more than once.
    expect(await (await fetch(`${h.base}/api/agents/steps/undo`, json({ fileId: file, stepId: opacity.id }))).json()).toEqual({ undone: false });
    // The newest step can still be undone and redone as usual.
    await call(agent, 'agent_undo', {});
    expect(room.doc.getNode(board)!.style.padding).toBeUndefined();
    expect((await steps()).find((s) => s.changes[0]?.fields?.some((f: any) => f.field === 'style.padding')).undone).toBe(true);
    await call(agent, 'agent_undo', { redo: true });
    expect(room.doc.getNode(board)!.style.padding).toBe('4px');
    expect((await steps()).find((s) => s.changes[0]?.fields?.some((f: any) => f.field === 'style.padding')).undone).toBe(false);
  });

  it('keeps a value someone changed since', async () => {
    const room = await h.server.rooms.get(file);
    await call(agent, 'layer_style', { node_ids: [board], style: { margin: '1px' } });
    const step = (await steps())[0];
    await call(other, 'layer_style', { node_ids: [board], style: { margin: '2px' } });
    await fetch(`${h.base}/api/agents/steps/undo`, json({ fileId: file, stepId: step.id }));
    expect(room.doc.getNode(board)!.style.margin).toBe('2px');
  });
});

describe('proposals', () => {
  describe('in the document', () => {
    let doc: BogenDoc;
    let page: string;
    let source: string;
    let child: string;

    beforeEach(() => {
      doc = new BogenDoc();
      doc.ensureFirstPage();
      page = doc.getPages()[0]!.id;
      source = doc.insert(page, { type: 'frame', name: 'Hero', artboard: true, style: { position: 'absolute', left: '100px', top: '50px', width: '300px', height: '200px', backgroundColor: '#111' }, children: [{ type: 'text', name: 'Title', text: 'Old' }] });
      child = doc.getChildren(source)[0]!.id;
    });

    it('sets copies beside the original, side by side and clear of other layers', () => {
      doc.insert(page, { type: 'frame', name: 'In the way', style: { position: 'absolute', left: '500px', top: '50px', width: '100px', height: '100px' } });
      const ids = createProposals(doc, source, { by: 'claude', count: 3, notes: ['A', 'B', 'C'] });
      expect(ids).toHaveLength(3);
      const lefts = ids.map((id) => parseInt(doc.getNode(id)!.style.left!, 10));
      expect(lefts[0]).toBe(680);
      expect(lefts[1]).toBe(1060);
      expect(lefts[2]).toBe(1440);
      expect(doc.getNode(ids[0]!)!.style.top).toBe('50px');
      const list = listProposals(doc);
      expect(list.map((p) => p.note)).toEqual(['A', 'B', 'C']);
      expect(new Set(list.map((p) => p.group)).size).toBe(1);
      expect(list[0]).toMatchObject({ of: source, by: 'claude', sourceExists: true });
      // The original was not touched, and the children were copied.
      expect(doc.getChildren(source)[0]!.text).toBe('Old');
      expect(doc.getChildren(ids[0]!)[0]!.text).toBe('Old');
      expect(() => createProposals(doc, ids[0]!, { by: 'x' })).toThrow(/proposal itself/);
    });

    it('accepts as one undo step, keeping the original id and place', () => {
      const [copy] = createProposals(doc, source, { by: 'claude' });
      const copyChild = doc.getChildren(copy!)[0]!.id;
      doc.updateFields(copyChild, { text: 'New' });
      doc.updateStyle(copy!, { backgroundColor: '#f00', borderRadius: '8px' });
      const undo = new Y.UndoManager([doc.nodes, doc.pages], { trackedOrigins: new Set(['me']), captureTimeout: 0 });
      const result = acceptProposal(doc, copy!, 'me');
      expect(result.sourceId).toBe(source);
      const after = doc.getNode(source)!;
      expect(after.style).toMatchObject({ backgroundColor: '#f00', borderRadius: '8px', left: '100px', top: '50px', width: '300px' });
      expect(after.name).toBe('Hero');
      expect(doc.getChildren(source).map((n) => n.text)).toEqual(['New']);
      expect(doc.getNode(copy!)).toBeUndefined();
      // The original's child keeps its id and takes the copy's text, so threads and links on it stay attached.
      expect(doc.getChildren(source).map((n) => n.id)).toEqual([child]);
      expect(doc.getNode(copyChild)).toBeUndefined();
      expect(listProposals(doc)).toEqual([]);

      expect(undo.undoStack).toHaveLength(1);
      undo.undo();
      expect(doc.getNode(source)!.style.backgroundColor).toBe('#111');
      expect(doc.getChildren(source).map((n) => n.id)).toEqual([child]);
      expect(doc.getNode(child)!.text).toBe('Old');
      expect(proposalMark(doc, copy!)?.of).toBe(source);
      expect(doc.getChildren(copy!)[0]!.text).toBe('New');
    });

    it('takes a changed size along, and leaves the original its own otherwise', () => {
      const [copy] = createProposals(doc, source, { by: 'claude' });
      doc.updateStyle(copy!, { width: '500px' });
      acceptProposal(doc, copy!);
      expect(doc.getNode(source)!.style.width).toBe('500px');
    });

    it('copies a layer from inside a frame next to that frame, and gives it back its own sizing', () => {
      const inner = doc.insert(source, { type: 'frame', name: 'Inner', style: { width: '100%', flexGrow: '1', color: '#000' } });
      const [copy] = createProposals(doc, inner, { by: 'x', rect: { x: 230, y: 50, w: 170, h: 40 } });
      const placed = doc.getNode(copy!)!;
      expect(placed.parent).toBe(page);
      expect(placed.style).toMatchObject({ position: 'absolute', left: '480px', top: '50px', width: '170px' });
      doc.updateStyle(copy!, { color: '#f00' });
      acceptProposal(doc, copy!);
      expect(doc.getNode(inner)!.style).toMatchObject({ width: '100%', flexGrow: '1', color: '#f00' });
      expect(doc.getNode(inner)!.style.position).toBeUndefined();
      expect(doc.getNode(inner)!.parent).toBe(source);
    });

    it('accepting one direction discards the others, and discarding touches nothing else', () => {
      const ids = createProposals(doc, source, { by: 'codex', count: 3 });
      const result = acceptProposal(doc, ids[1]!);
      expect(result.discarded.sort()).toEqual([ids[0]!, ids[2]!].sort());
      expect(listProposals(doc)).toEqual([]);
      const before = JSON.stringify(doc.getNode(source));
      const [lone] = createProposals(doc, source, { by: 'x' });
      expect(discardProposal(doc, lone!)).toEqual([lone]);
      expect(doc.getNode(lone!)).toBeUndefined();
      expect(JSON.stringify(doc.getNode(source))).toBe(before);
    });

    it('cannot accept when the original is gone', () => {
      const [copy] = createProposals(doc, source, { by: 'x' });
      doc.delete([source]);
      expect(listProposals(doc)[0]!.sourceExists).toBe(false);
      expect(() => acceptProposal(doc, copy!)).toThrow(/gone/);
      expect(discardProposal(doc, copy!)).toEqual([copy]);
    });
  });

  describe('over MCP', () => {
    let h: Harness;
    let agent: Client;
    let file: string;
    let board: string;

    beforeAll(async () => {
      h = await runnerServer();
      agent = await connectAgent(h.base, 'claude');
      file = (await call(agent, 'file_create', { name: 'Proposals' })).id;
      board = (await call(agent, 'artboard_create', { name: 'Page', width: 400, height: 300, x: 0, y: 0 })).id;
      await call(agent, 'html_write', { target_id: board, html: '<h1 style="font-size:40px">Old title</h1>' });
    });

    afterAll(async () => {
      await agent.close();
      await h.cleanup();
    });

    it('works through the whole loop, and reports the decision as an event', async () => {
      const made = await call(agent, 'proposal_create', { node_id: board, count: 3, notes: ['Bold', 'Quiet', 'Odd'] });
      expect(made.proposals).toHaveLength(3);
      const room = await h.server.rooms.get(file);
      const id = made.proposals[0].id;
      expect(parseInt(room.doc.getNode(id)!.style.left!, 10)).toBe(480);
      const listed = await call(agent, 'proposal_list', {});
      expect(listed.proposals.map((p: any) => p.note)).toEqual(['Bold', 'Quiet', 'Odd']);

      const start = (await call(agent, 'wait_for_event', { timeout_seconds: 0, include_own: true })).cursor;
      const title = room.doc.getChildren(id)[0]!.id;
      // The copy's ids for the original's layers, so the original's own ids are not what the agent edits.
      expect(made.proposals[0].layers).toEqual({ [room.doc.getChildren(board)[0]!.id]: title });
      expect(made.proposals[1].layers[room.doc.getChildren(board)[0]!.id]).toBe(room.doc.getChildren(made.proposals[1].id)[0]!.id);
      await call(agent, 'layer_text', { node_id: title, text: 'New title' });
      expect(room.doc.getChildren(board)[0]!.text).toBe('Old title');

      const accepted = await call(agent, 'proposal_accept', { proposal_id: id });
      expect(accepted).toMatchObject({ node_id: board, discarded: [made.proposals[1].id, made.proposals[2].id] });
      expect(room.doc.getChildren(board)[0]!.text).toBe('New title');
      expect(room.doc.getNode(board)!.style.left).toBe('0px');
      const events = await call(agent, 'wait_for_event', { cursor: start, timeout_seconds: 1, include_own: true, kinds: ['proposal_accepted'] });
      expect(events.events[0]).toMatchObject({ kind: 'proposal_accepted', proposal_id: id, node_id: board });

      // One agent_undo takes all of it back.
      await call(agent, 'agent_undo', {});
      expect(room.doc.getChildren(board)[0]!.text).toBe('Old title');
      expect(listProposals(room.doc)).toHaveLength(3);
    });

    it('reports a discard, and refuses what is not a proposal', async () => {
      const room = await h.server.rooms.get(file);
      const existing = listProposals(room.doc);
      await call(agent, 'proposal_discard', { proposal_id: existing[0]!.id, all: true });
      expect(listProposals(room.doc)).toEqual([]);
      const cursor = (await call(agent, 'wait_for_event', { timeout_seconds: 0, include_own: true })).cursor;
      const made = await call(agent, 'proposal_create', { node_id: board });
      await call(agent, 'proposal_discard', { proposal_id: made.proposals[0].id });
      const events = await call(agent, 'wait_for_event', { cursor, timeout_seconds: 1, include_own: true, kinds: ['proposal_discarded'] });
      expect(events.events[0]).toMatchObject({ proposal_id: made.proposals[0].id });
      expect((await callRaw(agent, 'proposal_accept', { proposal_id: board })).isError).toBe(true);
    });

    it('teaches when to use them', async () => {
      expect(agent.getInstructions()).toMatch(/proposal_create/);
      const guide = await call<string>(agent, 'guide_get', { topic: 'live' });
      expect(guide).toMatch(/Review before accept/);
      expect(guide).toMatch(/Do not use it for a new artboard/);
    });
  });
});

describe('install and uninstall, with a skill', () => {
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, XDG: process.env.XDG_CONFIG_HOME, CODEX: process.env.CODEX_HOME };
  const command = { command: '/usr/bin/bogen', args: ['mcp'] };
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bogen-skill-'));
    process.env.HOME = home;
    process.env.PATH = '';
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    if (saved.XDG) process.env.XDG_CONFIG_HOME = saved.XDG;
    if (saved.CODEX) process.env.CODEX_HOME = saved.CODEX;
    rmSync(home, { recursive: true, force: true });
  });

  it('makes a small skill from the guide, in the format skills have', () => {
    const text = skillText();
    expect(text.startsWith('---\nname: bogen\ndescription: ')).toBe(true);
    expect(text).toMatch(/\n---\n/);
    expect(text).toMatch(/wait_for_event/);
    expect(text).toMatch(/proposal_create/);
    // About 1,850 tokens: it rides along in every session of the agent, so it stays short; details live in guide_get.
    expect(text).toMatch(/## Writing copy/);
    expect(text.length).toBeLessThan(7500);
  });

  it('installs and removes it without touching anything else, and repeats cleanly', async () => {
    mkdirSync(join(home, '.claude', 'skills', 'mine'), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), 'keep');
    const claudeJson = { numStartups: 7, mcpServers: { other: { command: 'x' } } };
    writeFileSync(join(home, '.claude.json'), JSON.stringify(claudeJson, null, 2));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), '# mine\nmodel = "m"\n');
    const before = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');

    for (let i = 0; i < 2; i++) {
      const results = await install(['claude-code', 'codex'], { command });
      expect(results.every((r) => r.ok), JSON.stringify(results)).toBe(true);
    }
    expect(readFileSync(skillPath('claude-code')!, 'utf8')).toContain('name: bogen');
    expect(readFileSync(skillPath('codex')!, 'utf8')).toContain('name: bogen');
    expect((await registration('claude-code')).registered).toBe(true);
    expect((await registration('codex')).skill).toBe(true);

    const removed = await uninstall(['claude-code', 'codex']);
    expect(removed.every((r) => r.ok), JSON.stringify(removed)).toBe(true);
    expect(existsSync(skillPath('claude-code')!)).toBe(false);
    expect(existsSync(join(home, '.claude', 'skills', 'bogen'))).toBe(false);
    expect(readFileSync(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('keep');
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual(claudeJson);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(before);
    expect((await registration('claude-code')).registered).toBe(false);
  });

  it('leaves a skill alone that it did not write', async () => {
    const path = join(home, '.claude', 'skills', 'bogen', 'SKILL.md');
    mkdirSync(join(home, '.claude', 'skills', 'bogen'), { recursive: true });
    writeFileSync(path, 'my own');
    const [result] = await install(['claude-code'], { command });
    expect(result!.how).toMatch(/not ours/);
    expect(readFileSync(path, 'utf8')).toBe('my own');
    await uninstall(['claude-code']);
    expect(readFileSync(path, 'utf8')).toBe('my own');
  });

  it('takes one key out of JSON with comments and a TOML section out of text', () => {
    const text = '{\n  // hand written\n  "a": 1, // yes\n  "bogen": { "x": 1 },\n  "c": 2\n}\n';
    const out = jsoncRemove(text, ['bogen']);
    expect(out.removed).toBe(true);
    expect(out.text).toContain('// hand written');
    expect(out.text).toContain('"c": 2');
    expect(out.text).not.toContain('bogen');
    expect(jsoncRemove('{ "a": 1, "b": 2 }', ['b']).text).toBe('{ "a": 1 }');
    expect(jsoncRemove('{ "b": 2 }', ['b']).text).toBe('{ }');
    expect(jsoncRemove('{ "m": { "b": 2, "c": 3 } }', ['m', 'b']).text).toBe('{ "m": { "c": 3 } }');
    expect(jsoncRemove('{ "a": 1 }', ['nope']).removed).toBe(false);
    expect(tomlRemoveServer('# mine\n\n[mcp_servers.bogen]\ncommand = "x"\n\n[other]\na = 1\n', 'bogen').text).toBe('# mine\n\n[other]\na = 1\n');
  });

  it('runs for real through the CLI in a temporary home, with the real clients', async () => {
    const cli = resolve(import.meta.dirname, '../src/cli.ts');
    const tsx = resolve(import.meta.dirname, '../../../node_modules/.bin/tsx');
    const env = { ...process.env, HOME: home, PATH: saved.PATH, CODEX_HOME: join(home, '.codex'), XDG_CONFIG_HOME: join(home, '.config'), BOGEN_HOME: join(home, 'bogen') };
    const run = (...args: string[]) => {
      try {
        return execFileSync(tsx, [cli, ...args], { env, encoding: 'utf8', timeout: 60_000 });
      } catch (error) {
        const e = error as Error & { stdout?: string; stderr?: string };
        throw new Error(`${e.message}\nstdout: ${e.stdout ?? ''}\nstderr: ${e.stderr ?? ''}`, { cause: error });
      }
    };
    const installed = run('install', 'claude-code', 'codex');
    expect(installed).toMatch(/claude-code: ran claude mcp add; wrote skill/);
    expect(installed).toMatch(/codex: ran codex mcp add; wrote skill/);
    expect(existsSync(join(home, '.claude', 'skills', 'bogen', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, '.codex', 'skills', 'bogen', 'SKILL.md'))).toBe(true);
    expect(execFileSync('claude', ['mcp', 'list'], { env, encoding: 'utf8', timeout: 60_000 })).toMatch(/bogen/);
    expect(execFileSync('codex', ['mcp', 'list'], { env, encoding: 'utf8', timeout: 60_000 })).toMatch(/bogen/);
    const removed = run('uninstall', 'claude-code', 'codex');
    expect(removed).toMatch(/removed skill/);
    expect(existsSync(join(home, '.claude', 'skills', 'bogen'))).toBe(false);
    expect(execFileSync('claude', ['mcp', 'list'], { env, encoding: 'utf8', timeout: 60_000 })).not.toMatch(/bogen/);
    expect(execFileSync('codex', ['mcp', 'list'], { env, encoding: 'utf8', timeout: 60_000 })).not.toMatch(/bogen/);
  }, 180_000);
});
