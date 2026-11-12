import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stand-ins for both CLIs, driven by a `FAKE{...}` directive anywhere in what they are told (the system prompt,
 * the message, a comment in the thread; the last one counts). They log how they were called and what they got,
 * then use the MCP server they were given, the way each real CLI is told to: Claude through --mcp-config, Codex
 * through -c flags.
 *
 * Directive: { tools?: [{ name, args }], delayMs?, hang?, reply?, thread?: 'reply' | 'resolve', verify?: 'revision' | string[], verifyDiscipline?: string }. In tool
 * arguments, "$thread" is the thread the run was asked in.
 */
export function writeFakeClis(bin: string, log: string): void {
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(bin, name), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.0.0 (Fake)'); process.exit(0); }
if (args[0] === '--help') { console.log("  --model <model>  Provide an alias (e.g. 'opus', or 'sonnet')."); process.exit(0); }
if (args[0] === 'debug') { console.log(JSON.stringify({ models: [{ slug: 'small', display_name: 'Small', description: 'Fast and affordable', visibility: 'list', priority: 1 }] })); process.exit(0); }
const fs = require('node:fs');
const codex = ${JSON.stringify(name)} === 'codex';
let stdin = fs.readFileSync(0, 'utf8');
if (args.includes('--input-format')) {
  const frames = stdin.trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line));
  if (frames.length === 1 && frames[0].type === 'control_request' && frames[0].request?.subtype === 'initialize') {
    const models = ['haiku', 'sonnet', 'opus', 'fable'].map((id) => ({ value: id, displayName: id[0].toUpperCase() + id.slice(1) + (id === 'fable' ? ' 5.1' : ' 5.5'), resolvedModel: 'claude-' + id + (id === 'fable' ? '-5-1' : '-5-5'), supportsEffort: true, supportedEffortLevels: ['low','medium','high','xhigh','max'] }));
    console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frames[0].request_id, response: { models } } }));
    process.exit(0);
  }
}
const sys = args.includes('--append-system-prompt') ? args[args.indexOf('--append-system-prompt') + 1] : '';
const images = [];
for (let i = 0; i < args.length; i++) if (args[i] === '-i') images.push({ via: 'file', bytes: fs.readFileSync(args[i + 1]).length });
if (args.includes('--input-format')) {
  let message = '';
  for (const line of stdin.split('\\n')) {
    if (!line.trim()) continue;
    for (const part of JSON.parse(line).message.content) {
      if (part.type === 'image') images.push({ via: 'stream', bytes: Buffer.from(part.source.data, 'base64').length, mime: part.source.media_type });
      if (part.type === 'text') message += part.text;
    }
  }
  stdin = message;
}
const text = sys + '\\n' + stdin;
const log = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ runner: ${JSON.stringify(name)}, ...o }) + '\\n');
log({ kind: 'call', args, text: text.slice(-60000), images });
const say = (o) => console.log(JSON.stringify(o));
const sayText = (t) => say(codex ? { type: 'item.completed', item: { type: 'agent_message', text: t } } : { type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const sayTool = (t) => say(codex ? { type: 'item.started', item: { type: 'mcp_tool_call', tool: t } } : { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__bogen__' + t }] } });
const finish = (t) => { sayText(t); if (!codex) say({ type: 'result', is_error: false }); };
const start = text.lastIndexOf('FAKE{');
let plan = {};
if (start >= 0) {
  let depth = 0, end = start + 4;
  for (; end < text.length; end++) { if (text[end] === '{') depth++; else if (text[end] === '}' && --depth === 0) break; }
  try { plan = JSON.parse(text.slice(start + 4, end + 1)); } catch (e) { log({ kind: 'bad-plan', error: String(e) }); }
}
const thread = (/Comment thread (\\w+):/.exec(text) || [])[1];
let config = null;
if (args.includes('--mcp-config')) config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.bogen;
else {
  const url = args.find((a) => a.startsWith('mcp_servers.bogen.url='));
  const headers = args.find((a) => a.startsWith('mcp_servers.bogen.http_headers='));
  if (url) config = { url: JSON.parse(url.slice(url.indexOf('=') + 1)), headers: JSON.parse(headers.slice(headers.indexOf('=') + 1).replace(/"=/g, '":')) };
}
if (!config) { finish(plan.reply || 'Done.'); process.exit(0); }
const rpc = async (session, id, method, params) => {
  const res = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
  return { session: res.headers.get('mcp-session-id'), body: id ? await res.json() : null };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fill = (v) => typeof v === 'string' ? v.replace('$thread', thread || '') : Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
(async () => {
  const { session } = await rpc(null, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  await rpc(session, null, 'notifications/initialized', {});
  let n = 10;
  const tool = async (name, a) => {
    sayTool(name);
    const r = (await rpc(session, n++, 'tools/call', { name, arguments: fill(a) })).body;
    log({ kind: 'tool', name, error: r.result && r.result.isError ? r.result.content[0].text : r.error ? r.error.message : null });
    return r.result;
  };
  for (const t of plan.tools || []) {
    if (plan.delayMs) await wait(plan.delayMs);
    await tool(t.name, t.args || {});
  }
  if (plan.hang) { setInterval(() => {}, 1000); return; }
  if (plan.verify) {
    const mapping = /Artboards, original → copy: ([^\\n]+)/.exec(text)?.[1] || '';
    const targets = plan.verify === 'revision' ? [...mapping.matchAll(/\\w+ → (\\w+)/g)].map(m => m[1]) : plan.verify;
    if (!Array.isArray(targets) || !targets.length) throw Error('No explicit verification targets in fixture');
    for (const target of targets) {
      await tool('canvas_screenshot', { node_id: target });
      await tool('design_verify', { node_id: target, discipline: plan.verifyDiscipline || 'foundations', observations: [
        { criterion: 'priority', verdict: 'pass', evidence: 'The supplied heading is the primary message on this isolated fixture screen.' },
        { criterion: 'content', verdict: 'pass', evidence: 'The fixture content is preserved except for the explicitly requested text or size change.' },
        { criterion: 'context', verdict: 'pass', evidence: 'This screen contains a single supplied heading and has no hidden controls or interactions.' },
      ] , rubric: ['hierarchy', 'type', 'spacing', 'colour', 'content', 'craft', 'originality', 'fit'].map((c) => ({ criterion: c, score: 3, evidence: 'The fixture screen holds one supplied heading, judged for ' + c + '.' })) });
    }
  }
  if (thread && plan.thread) {
    await tool('comment_reply', { thread_id: thread, text: plan.reply || 'Done.' });
    // An agent from before agents lost comment_resolve tries it anyway; the server refuses it and changes nothing.
    if (plan.thread === 'resolve') await tool('comment_resolve', { thread_id: thread });
  }
  finish(plan.reply || 'Done.');
})();
`);
    chmodSync(join(bin, name), 0o755);
  }
}

/**
 * Stand-ins that answer the three requests of `bogen agents check` the way a good agent does, through the MCP
 * server. `forgetful` ignores the conversation before; `agreeable` only agrees with a polite request until it
 * is told it changed nothing, as Codex used to.
 */
export function writeCheckClis(bin: string, behaviour: { claude?: 'good' | 'forgetful' | 'agreeable'; codex?: 'good' | 'forgetful' | 'agreeable' } = {}): void {
  for (const name of ['claude', 'codex'] as const) {
    writeFileSync(join(bin, name), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.0.0 (Fake)'); process.exit(0); }
if (args[0] === '--help') { console.log("  --model <model>  Provide an alias (e.g. 'opus', or 'sonnet')."); process.exit(0); }
if (args[0] === 'debug') { console.log(JSON.stringify({ models: [{ slug: 'small', display_name: 'Small', description: 'Fast and affordable', visibility: 'list', priority: 1 }] })); process.exit(0); }
const fs = require('node:fs');
const codex = ${JSON.stringify(name)} === 'codex';
const mood = ${JSON.stringify(behaviour[name] ?? 'good')};
const stdin = fs.readFileSync(0, 'utf8');
const said = stdin.includes("The person's new message:") ? stdin.slice(stdin.lastIndexOf("The person's new message:")) : stdin;
const earlier = mood === 'forgetful' ? '' : stdin.slice(0, stdin.length - said.length);
const nudged = stdin.includes('You replied without changing anything');
const say = (o) => console.log(JSON.stringify(o));
const sayText = (t) => say(codex ? { type: 'item.completed', item: { type: 'agent_message', text: t } } : { type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const finish = (t) => { sayText(t); if (!codex) say({ type: 'result', is_error: false }); };
let config = null;
if (args.includes('--mcp-config')) config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.bogen;
else {
  const url = args.find((a) => a.startsWith('mcp_servers.bogen.url='));
  const headers = args.find((a) => a.startsWith('mcp_servers.bogen.http_headers='));
  config = { url: JSON.parse(url.slice(url.indexOf('=') + 1)), headers: JSON.parse(headers.slice(headers.indexOf('=') + 1).replace(/"=/g, '":')) };
}
const rpc = async (session, id, method, params) => {
  const res = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
  return { session: res.headers.get('mcp-session-id'), body: id ? await res.json() : null };
};
(async () => {
  const { session } = await rpc(null, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  await rpc(session, null, 'notifications/initialized', {});
  let n = 10;
  const tool = async (t, a) => {
    say(codex ? { type: 'item.started', item: { type: 'mcp_tool_call', tool: t } } : { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__bogen__' + t }] } });
    const r = (await rpc(session, n++, 'tools/call', { name: t, arguments: a })).body.result;
    return JSON.parse(r.content[0].text);
  };
  const find = async (tag) => (await tool('layer_find', { tag })).layers[0].id;
  if (/Überschrift größer/.test(said)) {
    if (mood === 'agreeable' && !nudged) return finish('Gute Idee, die Überschrift sollte größer sein.');
    await tool('layer_style', { node_ids: [await find('h1')], style: { fontSize: '44px' } });
    return finish('Die Überschrift ist jetzt 44 px groß.');
  }
  if (/Text auf dem Button/.test(said)) return finish('Jetzt buchen');
  if (/Absatzes zu/.test(said)) {
    await tool('layer_text', { node_id: await find('p'), text: 'Tickets ab Samstag.' });
    return finish('Der Absatz sagt jetzt: Tickets ab Samstag.');
  }
  if (/Mach ihn jetzt fett/.test(said)) {
    // Only the turn before says what "ihn" is.
    const target = /Absatz/.test(earlier) ? 'p' : 'h1';
    await tool('layer_style', { node_ids: [await find(target)], style: { fontWeight: '700' } });
    return finish(target === 'p' ? 'Der Absatz ist jetzt fett.' : 'Die Überschrift ist jetzt fett.');
  }
  finish('Nichts zu tun.');
})();
`);
    chmodSync(join(bin, name), 0o755);
  }
}

export interface FakeCall { runner: string; kind: string; args?: string[]; text?: string; images?: { via: string; bytes: number; mime?: string }[]; name?: string; error?: string | null }

export function fakeLog(log: string): FakeCall[] {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeCall) : [];
}

/** The directive, as it goes into a prompt or a comment. */
export function fake(plan: Record<string, unknown>): string {
  return `FAKE${JSON.stringify(plan)}`;
}
