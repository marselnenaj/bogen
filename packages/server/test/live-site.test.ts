import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttp, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildCommand } from '../src/agents.ts';
import { FileRoot } from '../src/live-files.ts';
import { elementText, historyKey, injectPicker, liveInstructions } from '../src/live-site.ts';
import { call, callRaw, connectAgent, startServer, until, type Harness } from './helpers.ts';

const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
const ROOT = resolve(import.meta.dirname, '../../..');

describe('the file tools of a live site run', () => {
  const base = mkdtempSync(join(tmpdir(), 'bogen-files-'));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  let files: FileRoot;

  beforeAll(() => {
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(join(project, 'node_modules/x'), { recursive: true });
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside secret');
    writeFileSync(join(project, 'src/a.css'), '.a { color: red; }\n.b { color: red; }\n');
    writeFileSync(join(project, '.env'), 'TOKEN=1');
    writeFileSync(join(project, '.git/config'), 'x');
    writeFileSync(join(project, 'vite.config.ts'), 'export default {}');
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(join(project, 'node_modules/x/i.js'), 'x');
    symlinkSync(outside, join(project, 'link-dir'));
    symlinkSync(join(outside, 'secret.txt'), join(project, 'link-file'));
    symlinkSync(join(outside, 'not-yet'), join(project, 'dangling'));
    files = new FileRoot(project);
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('reads, lists, finds and searches source', async () => {
    expect((await files.read('src/a.css')).content).toContain('.a');
    expect(await files.list('.')).toEqual(expect.arrayContaining(['src/', 'package.json']));
    expect(await files.list('.')).not.toEqual(expect.arrayContaining(['.env']));
    expect(await files.find('**/*.css')).toEqual(['src/a.css']);
    expect(await files.find('*.css')).toEqual(['src/a.css']);
    expect((await files.search('color: red')).map((m) => m.line)).toEqual([1, 2]);
    expect((await files.search('COLOR', '.', true)).length).toBe(2);
    expect(await files.search('TOKEN')).toEqual([]);
    expect(await files.find('**/i.js')).toEqual([]);
  });

  it('never leaves the folder, however it is asked', async () => {
    for (const path of ['../outside/secret.txt', '/etc/passwd', join(outside, 'secret.txt'), 'src/../../outside/secret.txt', 'link-dir/secret.txt', 'link-file', 'dangling']) {
      await expect(files.read(path), path).rejects.toThrow();
      await expect(files.write(path, 'x'), path).rejects.toThrow();
    }
    await expect(files.write('../escaped.txt', 'x')).rejects.toThrow(/outside/);
    expect(existsSync(join(base, 'escaped.txt'))).toBe(false);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside secret');
    expect(existsSync(join(outside, 'not-yet'))).toBe(false);
    await expect(files.read('.env')).rejects.toThrow(/off limits/);
    await expect(files.read('.git/config')).rejects.toThrow(/off limits/);
    await expect(files.read('node_modules/x/i.js')).rejects.toThrow(/off limits/);
    await expect(files.write('a\0b', 'x')).rejects.toThrow();
  });

  it('will not write what runs code', async () => {
    for (const path of ['vite.config.ts', 'package.json', '.github/workflows/x.yml', '.claude/settings.json', '.husky/pre-commit', 'tools/run.sh', '.vscode/tasks.json', 'next.config.mjs']) {
      await expect(files.write(path, 'x'), path).rejects.toThrow(/not source|run code/);
    }
    expect((await files.read('vite.config.ts')).content).toContain('export default');
    expect(readFileSync(join(project, 'vite.config.ts'), 'utf8')).toBe('export default {}');
  });

  it('edits exactly, and keeps track of what it wrote', async () => {
    await expect(files.edit('src/a.css', 'color: red', 'color: blue')).rejects.toThrow(/2 times/);
    expect(await files.edit('src/a.css', '.a { color: red; }', '.a { color: blue; }')).toBe(1);
    expect(readFileSync(join(project, 'src/a.css'), 'utf8')).toContain('.a { color: blue; }');
    await expect(files.edit('src/a.css', 'nothing like this', 'x')).rejects.toThrow(/not in/);
    await files.write('src/new/b.css', '.b {}');
    expect(readFileSync(join(project, 'src/new/b.css'), 'utf8')).toBe('.b {}');
    expect([...files.written].sort()).toEqual(['src/a.css', 'src/new/b.css']);
  });
});

describe('what a live run is allowed', () => {
  const site = { dir: '/p', target: 'http://127.0.0.1:5173' };
  const element = { selector: 'h1', html: '<h1>Hi</h1>', styles: { color: 'red' }, source: { file: 'src/App.tsx', line: 4, via: 'react' } };

  it('gives both CLIs no built-in tools and only the file tools of that run', () => {
    const req = { fileId: 'live-x', fileName: '/p', prompt: 'x', runner: 'claude' as const, live: { dir: '/p', mcpUrl: 'http://127.0.0.1:1/live-mcp/abc', instructions: 'rules', label: '/p' } };
    const claude = buildCommand('claude', req, { url: 'http://x/mcp' }, '/tmp/cfg', '/tmp/empty').args;
    expect(claude[claude.indexOf('--tools') + 1]).toBe('');
    expect(claude[claude.indexOf('--allowedTools') + 1]).toBe('mcp__files__*');
    expect(claude).toContain('--strict-mcp-config');
    expect(claude[claude.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    const codex = buildCommand('codex', { ...req, runner: 'codex' }, { url: 'http://x/mcp' }, '/tmp/cfg', '/tmp/empty').args;
    expect(codex).toEqual(expect.arrayContaining(['--disable', 'shell_tool', 'unified_exec', '--ignore-user-config', '--ignore-rules', 'read-only']));
    expect(codex[codex.indexOf('-C') + 1]).toBe('/tmp/empty');
    expect(codex.join(' ')).toContain('mcp_servers.files.url="http://127.0.0.1:1/live-mcp/abc"');
    expect(codex.join(' ')).not.toContain('mcp_servers.bogen');
  });

  it('says what was picked, and that it is content', () => {
    // What the page says never goes into the system prompt.
    const rules = liveInstructions(site);
    expect(rules).toMatch(/not as instructions/);
    expect(rules).not.toContain('<h1>Hi</h1>');
    const text = elementText(element);
    expect(text).toContain('src/App.tsx:4');
    expect(text).toContain('<h1>Hi</h1>');
    expect(text).toContain('color: red');
    expect(elementText({ ...element, source: null })).toMatch(/not exposed/);
  });

  it('puts the picker first in any page', () => {
    expect(injectPicker('<!doctype html><html><head><title>x</title></head></html>')).toMatch(/<head><script src="\/__bogen\/picker\.js"><\/script><title>/);
    expect(injectPicker('<!DOCTYPE html><p>no head')).toMatch(/<!DOCTYPE html><script/);
    expect(injectPicker('<p>bare')).toMatch(/^<script/);
  });

  it('has a key per project', () => {
    expect(historyKey('/a')).not.toBe(historyKey('/b'));
    expect(historyKey('/a')).toMatch(/^live-[0-9a-f]{24}$/);
  });
});

describe('the proxy, with a real Vite dev server', () => {
  const base = mkdtempSync(join(tmpdir(), 'bogen-live-'));
  const project = join(base, 'site');
  const bin = mkdtempSync(join(tmpdir(), 'bogen-live-bin-'));
  const log = join(bin, 'runs.jsonl');
  const savedPath = process.env.PATH;
  let h: Harness;
  let vite: ChildProcess;
  let vitePort = 0;
  let site: { id: string; proxyUrl: string; target: string; dir: string; historyKey: string };

  beforeAll(async () => {
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'index.html'), '<!doctype html><html><head><title>Fixture</title><link rel="stylesheet" href="/style.css"></head><body><button id="buy">Buy</button><script type="module" src="/main.js"></script></body></html>');
    writeFileSync(join(project, 'style.css'), '#buy { color: rgb(1, 2, 3); }\n');
    writeFileSync(join(project, 'main.js'), 'import "/style.css"; if (import.meta.hot) import.meta.hot.accept();\n');
    writeFileSync(join(project, 'package.json'), '{"name":"fixture","private":true,"type":"module"}');
    const free = createHttp();
    await new Promise<void>((done) => free.listen(0, '127.0.0.1', done));
    vitePort = (free.address() as { port: number }).port;
    await new Promise((done) => free.close(done));
    vite = spawn(join(ROOT, 'node_modules/.bin/vite'), ['--port', String(vitePort), '--strictPort', '--host', '127.0.0.1', '--clearScreen', 'false'], { cwd: project, stdio: 'ignore', env: { ...process.env } });
    await until(async () => fetch(`http://127.0.0.1:${vitePort}/`).then((r) => r.ok, () => false), 30_000);

    // Reads a file through the tools it was given, edits it, and tries what it may not.
    writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.0.0 (Fake)'); process.exit(0); }
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin, cwd: process.cwd() }) + '\\n');
const config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.files;
const rpc = (session, id, method, params) => fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
(async () => {
  const init = await rpc(null, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  const session = init.headers.get('mcp-session-id');
  await rpc(session, null, 'notifications/initialized', {});
  const answer = async (id, name, args) => (await rpc(session, id, 'tools/call', { name, arguments: args })).json();
  const tools = await (await rpc(session, 2, 'tools/list', {})).json();
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tools: tools.result.tools.map((t) => t.name) }) + '\\n');
  const escape = await answer(3, 'read_file', { path: '../secret.txt' });
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ escape: escape.result }) + '\\n');
  await answer(4, 'edit_file', { path: 'style.css', old_text: 'rgb(1, 2, 3)', new_text: 'rgb(9, 8, 7)' });
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Changed the colour.' }] } }));
  if (stdin.includes('fake:keep')) { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: config.url }) + '\\n'); }
})();
`);
    chmodSync(join(bin, 'claude'), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    h = await startServer();
    const res = await fetch(`${h.base}/api/live/sites`, json({ url: `http://127.0.0.1:${vitePort}`, dir: project }));
    expect(res.status).toBe(201);
    site = await res.json() as typeof site;
  }, 60_000);

  afterAll(async () => {
    process.env.PATH = savedPath;
    await h.cleanup();
    vite?.kill();
    rmSync(base, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  it('serves the page with the picker, on its own origin, without Vite minding', async () => {
    expect(site.proxyUrl).not.toBe(h.base);
    const html = await (await fetch(`${site.proxyUrl}/`)).text();
    expect(html).toContain('<script src="/__bogen/picker.js"></script>');
    expect(html).toContain('/@vite/client');
    const picker = await fetch(`${site.proxyUrl}/__bogen/picker.js`);
    expect(picker.headers.get('content-type')).toContain('javascript');
    const script = await picker.text();
    expect(script).toContain('postMessage');
    expect(script).not.toContain(project);
    const css = await fetch(`${site.proxyUrl}/style.css`);
    expect(css.status).toBe(200);
    expect(await css.text()).toContain('rgb');
  });

  it('passes the hot reload socket through', async () => {
    const client = await (await fetch(`${site.proxyUrl}/@vite/client`)).text();
    const token = /wsToken = "?([^";]+)/.exec(client)?.[1] ?? '';
    const ws = new WebSocket(`${site.proxyUrl.replace('http', 'ws')}/?token=${token}`, 'vite-hmr', { headers: { Origin: site.proxyUrl } });
    const messages: string[] = [];
    await new Promise<void>((done, fail) => {
      ws.on('open', () => done());
      ws.on('error', fail);
    });
    ws.on('message', (data) => messages.push(String(data)));
    await until(() => messages.some((m) => m.includes('connected')));
    writeFileSync(join(project, 'style.css'), '#buy { color: rgb(4, 5, 6); }\n');
    await until(() => messages.some((m) => m.includes('update') || m.includes('full-reload')), 8000);
    ws.close();
    writeFileSync(join(project, 'style.css'), '#buy { color: rgb(1, 2, 3); }\n');
  });

  it('answers only under its own name, refuses other sites, and does not pass the Bogen cookie on', async () => {
    const seen: Record<string, string | undefined> = {};
    const echo: Server = createHttp((req, res) => {
      seen.cookie = req.headers.cookie;
      seen.host = req.headers.host;
      seen.origin = req.headers.origin;
      res.writeHead(302, { location: `http://127.0.0.1:${(echo.address() as { port: number }).port}/next`, 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'", 'content-type': 'text/html' });
      res.end('<html></html>');
    });
    await new Promise<void>((done) => echo.listen(0, '127.0.0.1', done));
    const echoPort = (echo.address() as { port: number }).port;
    const other = await (await fetch(`${h.base}/api/live/sites`, json({ url: `http://127.0.0.1:${echoPort}`, dir: project }))).json() as { id: string; proxyUrl: string };
    const got = await fetch(`${other.proxyUrl}/x`, { redirect: 'manual', headers: { cookie: 'bogen_token=secret; theirs=1', origin: other.proxyUrl } });
    expect(seen.cookie).toBe('theirs=1');
    expect(seen.host).toBe(`127.0.0.1:${echoPort}`);
    expect(seen.origin).toBe(`http://127.0.0.1:${echoPort}`);
    expect(got.headers.get('location')).toBe(`${other.proxyUrl}/next`);
    expect(got.headers.get('x-frame-options')).toBeNull();
    expect(got.headers.get('content-security-policy')).toBeNull();
    const rawHost = await new Promise<number>((done) => {
      const url = new URL(other.proxyUrl);
      // fetch sets Host by itself, so this one is written by hand.
      import('node:http').then(({ request }) => request({ host: url.hostname, port: url.port, path: '/', headers: { host: 'evil.example' } }, (r) => { r.resume(); done(r.statusCode ?? 0); }).end());
    });
    expect(rawHost).toBe(403);
    expect((await fetch(`${other.proxyUrl}/x`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    await fetch(`${h.base}/api/live/sites/${other.id}`, { method: 'DELETE' });
    await new Promise((done) => echo.close(done));
    await expect(fetch(`${other.proxyUrl}/`)).rejects.toThrow();
  });

  it('only goes to this machine, and only for a real project folder', async () => {
    const open = (url: string, dir: string) => fetch(`${h.base}/api/live/sites`, json({ url, dir }));
    expect((await open('http://example.com', project)).status).toBe(400);
    expect((await open('https://127.0.0.1:1', project)).status).toBe(400);
    expect((await open('http://169.254.169.254/', project)).status).toBe(400);
    expect((await open(`http://127.0.0.1:${vitePort}`, 'relative/path')).status).toBe(400);
    expect((await open(`http://127.0.0.1:${vitePort}`, '/nope/nothing')).status).toBe(400);
    expect((await open(`http://127.0.0.1:${vitePort}`, homedir())).status).toBe(400);
    expect((await open(`http://127.0.0.1:${vitePort}`, '/')).status).toBe(400);
  });

  it('keeps the page away from Bogen: Origin, same-site and sockets are all refused', async () => {
    const origin = site.proxyUrl;
    // What a browser sends from that page. Reading with fetch, posting, and opening a socket.
    const api = await fetch(`${h.base}/api/status`, { headers: { origin, 'sec-fetch-site': 'same-site' } });
    expect(api.status).toBe(403);
    expect((await fetch(`${h.base}/api/status`, { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' } })).status).toBe(403);
    expect((await fetch(`${h.base}/api/live/sites/${site.id}/runs`, json({ prompt: 'x', runner: 'claude' }, { origin, 'sec-fetch-site': 'same-site' }))).status).toBe(403);
    expect((await fetch(`${h.base}/api/runs`, json({ fileId: 'x', prompt: 'x', runner: 'claude' }, { origin }))).status).toBe(403);
    expect((await fetch(`${h.base}/mcp`, json({}, { origin }))).status).toBe(403);
    for (const path of ['/events', '/sync/abcd']) {
      const code = await new Promise<number>((done) => {
        const ws = new WebSocket(`${h.base.replace('http', 'ws')}${path}`, { headers: { Origin: origin } });
        ws.on('unexpected-response', (_req, res) => done(res.statusCode ?? 0));
        ws.on('open', () => done(101));
        ws.on('error', () => {});
      });
      expect(code).toBe(403);
    }
    // Also when the dev flag loosens the rule for other loopback origins.
    const dev = await startServer({ dev: true });
    const devSite = await (await fetch(`${dev.base}/api/live/sites`, json({ url: `http://127.0.0.1:${vitePort}`, dir: project }))).json() as { proxyUrl: string };
    expect((await fetch(`${dev.base}/api/status`, { headers: { origin: devSite.proxyUrl } })).status).toBe(403);
    expect((await fetch(`${dev.base}/api/status`, { headers: { origin: 'http://127.0.0.1:5173' } })).status).toBe(200);
    await dev.cleanup();
  });

  it('runs the CLI with only file tools, in a folder of its own, and closes the door afterwards', async () => {
    writeFileSync(join(base, 'secret.txt'), 'do not read');
    writeFileSync(join(project, 'style.css'), '#buy { color: rgb(1, 2, 3); }\n');
    const element = { selector: '#buy', html: '<button id="buy">Buy</button>', styles: { color: 'rgb(1, 2, 3)' }, source: null };
    const started = await fetch(`${h.base}/api/live/sites/${site.id}/runs`, json({ prompt: 'Make it another colour fake:keep', runner: 'claude', model: 'haiku', effort: 'low', element }));
    expect(started.status).toBe(201);
    const { runId } = await started.json() as { runId: string };
    await until(() => !h.server.runs.activeFor(site.historyKey), 15_000);
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const first = lines[0];
    expect(first.args[first.args.indexOf('--tools') + 1]).toBe('');
    expect(first.args[first.args.indexOf('--model') + 1]).toBe('haiku');
    expect(first.cwd).not.toBe(project);
    const system = first.args[first.args.indexOf('--append-system-prompt') + 1];
    expect(system).toContain(project);
    expect(system).not.toContain('Buy');
    expect(first.stdin).toContain('#buy');
    expect(first.stdin).toContain('Make it another colour');
    expect(lines[1].tools.sort()).toEqual(['edit_file', 'find_files', 'list_dir', 'read_file', 'search', 'write_file']);
    expect(lines[2].escape.isError).toBe(true);
    expect(readFileSync(join(project, 'style.css'), 'utf8')).toContain('rgb(9, 8, 7)');
    await until(async () => {
      const list = await (await fetch(`${h.base}/api/runs?fileId=${site.historyKey}`)).json() as any[];
      return list[0]?.status === 'done' && list[0]?.files?.includes('style.css');
    });
    const records = await (await fetch(`${h.base}/api/runs?fileId=${site.historyKey}`)).json() as any[];
    expect(records[0]).toMatchObject({ id: runId, source: 'live', status: 'done', result: 'Changed the colour.', title: 'Make it another colour fake:keep' });
    // The address of a finished run opens nothing.
    const after = await fetch(lines[3].url, json({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    expect(after.status).toBe(404);
    // A real CLI process against a real Vite server: the 15 s wait above allows for a busy machine, so the test does too.
  }, 30_000);

  it('cannot be started by anything but a person on this machine', async () => {
    const before = readFileSync(log, 'utf8');
    const url = `${h.base}/api/live/sites/${site.id}/runs`;
    // Through a proxy, or with forwarded headers, it is not this machine.
    expect((await fetch(url, json({ prompt: 'x', runner: 'claude' }, { 'x-forwarded-for': '10.0.0.1' }))).status).toBe(403);
    // No MCP tool reaches it, whatever an agent is told.
    const agent = await connectAgent(h.base, 'visitor');
    const { tools } = await agent.listTools();
    expect(tools.filter((t) => /^live|shell|exec|^run/.test(t.name)).map((t) => t.name)).toEqual([]);
    await agent.close();
    // Nor does a run on the canvas start for what comes through a proxy.
    expect((await fetch(`${h.base}/api/runs`, json({ fileId: 'x', prompt: 'x', runner: 'claude' }, { 'x-forwarded-for': '10.0.0.1' }))).status).toBe(403);
    expect((await fetch(`${h.base}/api/runs/x/rerun`, json({ fileId: 'x' }, { 'x-forwarded-for': '10.0.0.1' }))).status).toBe(403);
    // A made-up address for the file tools answers nothing.
    expect((await fetch(`${h.base}/live-mcp/${'a'.repeat(40)}`, json({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))).status).toBe(404);
    expect((await fetch(`${h.base}/live-mcp/${'a'.repeat(40)}`, json({}, { origin: site.proxyUrl }))).status).toBe(403);
    expect(readFileSync(log, 'utf8')).toBe(before);
  });

  it('is not on the tailnet listener at all', async () => {
    const { isLocalOnlyPath } = await import('../src/peers.ts');
    for (const path of ['/api/live/sites', '/api/live/sites/x/runs', '/live-mcp/abc', '/api/runs', '/api/runs/x/rerun', '/api/run-settings', '/api/notifications', '/api/omarchy/palette', '/api/agents/steps/undo', '/api/files/abcd/away', '/api/files/abcd/conflicts/x']) expect(isLocalOnlyPath(path), path).toBe(true);
    expect(isLocalOnlyPath('/api/status')).toBe(false);
  });
});
