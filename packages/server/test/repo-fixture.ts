import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A Git repository for pull request tests, with a bare repository in a temp folder as its `origin`, and stand-ins
 * for `claude`, `codex` and `gh` in a folder of their own, to put first on PATH. Nothing here reaches a network:
 * pushes go to the bare repository, and the stand-in `gh` only writes down what it was asked.
 */
export interface RepoFixture {
  base: string;
  repo: string;
  remote: string;
  bin: string;
  ghLog: string;
  agentLog: string;
  git: (args: string[], cwd?: string) => string;
  ghCalls: () => { args: string[]; cwd: string; body: string | null }[];
  /** Makes the stand-in `gh` fail from now on, or work again. */
  ghFails: (on: boolean) => void;
  agentCalls: () => { runner: string; args: string[]; stdin: string; cwd: string; tools?: string[]; wrote?: string; refused?: string }[];
  cleanup: () => void;
}

const AGENT = (log: string, runner: string) => `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.0.0 (stand-in ${runner})'); process.exit(0); }
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
const entry = { runner: ${JSON.stringify(runner)}, args, stdin, cwd: process.cwd() };
let url, headers = {};
if (args.includes('--mcp-config')) {
  const config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.files;
  url = config.url; headers = config.headers || {};
} else {
  const c = args.find((a) => a.startsWith('mcp_servers.files.url='));
  url = c && c.slice('mcp_servers.files.url='.length).replace(/^"|"$/g, '');
}
const say = (text) => console.log(JSON.stringify(${JSON.stringify(runner)} === 'claude'
  ? { type: 'assistant', message: { content: [{ type: 'text', text }] } }
  : { type: 'item.completed', item: { type: 'agent_message', text } }));
const rpc = (session, id, method, params) => fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
(async () => {
  const init = await rpc(null, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stand-in', version: '1' } });
  const session = init.headers.get('mcp-session-id');
  await rpc(session, null, 'notifications/initialized', {});
  const call = async (id, name, a) => (await (await rpc(session, id, 'tools/call', { name, arguments: a })).json()).result;
  entry.tools = (await (await rpc(session, 2, 'tools/list', {})).json()).result.tools.map((t) => t.name);
  const escape = await call(3, 'write_file', { path: '../outside.txt', content: 'x' });
  entry.refused = escape.isError ? escape.content[0].text : 'not refused';
  if (stdin.includes('Footer')) {
    say('There is nothing to change in the code for this.');
  } else {
    const file = JSON.parse((await call(4, 'read_file', { path: 'src/Hero.tsx' })).content[0].text).content;
    const old = /#[0-9a-f]{6}/i.exec(file)[0];
    // The colour the design has now: one the change mentions that the code does not have yet.
    const changed = stdin.slice(stdin.indexOf('## What changed'), stdin.indexOf('## The design as it is now'));
    const colour = (changed.match(/#[0-9a-f]{6}/gi) || []).find((c) => c.toLowerCase() !== old.toLowerCase()) || '#000000';
    await call(5, 'edit_file', { path: 'src/Hero.tsx', old_text: old, new_text: colour });
    entry.wrote = colour;
    say('Changed the colour of the hero title in src/Hero.tsx.');
  }
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n');
})().catch((e) => { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ ...entry, error: String(e) }) + '\\n'); process.exit(1); });
`;

const GH = (log: string) => `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh version 0.0.0 (stand-in)'); process.exit(0); }
const fs = require('node:fs');
const at = args.indexOf('--body-file');
const body = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : null;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), body }) + '\\n');
// A test that wants gh to fail, as when the person is not signed in, leaves this file.
if (fs.existsSync(${JSON.stringify(log)} + '.fail')) { console.error('To get started with GitHub CLI, please run:  gh auth login'); process.exit(4); }
console.log('https://github.com/acme/app/pull/42');
`;

function lines<T>(path: string): T[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

/** `parent` is where its folder goes, the system's temp folder by default. */
export function makeRepoFixture(files: Record<string, string>, parent = tmpdir()): RepoFixture {
  mkdirSync(parent, { recursive: true });
  const base = mkdtempSync(join(parent, 'bogen-pr-'));
  const repo = join(base, 'app');
  const remote = join(base, 'remote.git');
  const bin = join(base, 'bin');
  mkdirSync(bin);
  const ghLog = join(base, 'gh.jsonl');
  const agentLog = join(base, 'agents.jsonl');
  const git = (args: string[], cwd = repo) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
  mkdirSync(repo);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(['init', '--quiet', '-b', 'main']);
  git(['config', 'user.name', 'Fixture Person']);
  git(['config', 'user.email', 'person@example.test']);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'Start']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '--quiet', '-u', 'origin', 'main']);
  for (const runner of ['claude', 'codex']) {
    writeFileSync(join(bin, runner), AGENT(agentLog, runner));
    chmodSync(join(bin, runner), 0o755);
  }
  // The stand-ins are CommonJS, also when the folder is in a package of ES modules.
  writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(join(bin, 'gh'), GH(ghLog));
  chmodSync(join(bin, 'gh'), 0o755);
  return {
    base, repo, remote, bin, ghLog, agentLog, git,
    ghCalls: () => lines(ghLog),
    ghFails: (on) => (on ? writeFileSync(`${ghLog}.fail`, '') : rmSync(`${ghLog}.fail`, { force: true })),
    agentCalls: () => lines(agentLog),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
