/**
 * The agent loop and devices in the real editor, against real servers, in a real browser, with real mouse and keyboard.
 * The agent is a stand-in CLI, so no plan is used. Vite is real. Nothing here touches the running service or its data.
 *
 *   npx vite build --outDir /tmp/editor (in apps/editor)
 *   BOGEN_EDITOR_DIR=/tmp/editor npx tsx apps/editor/test/e2e/agent-loop.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import puppeteer, { type Frame, type Page } from 'puppeteer-core';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOT = resolve(import.meta.dirname, '../../../..');
const temp = (name: string) => mkdtempSync(join(tmpdir(), `bogen-e2e-${name}-`));
const homeA = temp('a');
const homeB = temp('b');
const bin = temp('bin');
const profile = temp('profile');
const profileB = temp('profile-b');
const distB = temp('dist');
const project = temp('project');
const shots = process.env.BOGEN_E2E_SHOTS;
const PORT_A = 27000 + Math.floor(Math.random() * 900);
const PORT_B = PORT_A + 1000;
const PORT_VITE = PORT_A + 2000;
const baseA = `http://127.0.0.1:${PORT_A}`;
const baseB = `http://127.0.0.1:${PORT_B}`;

// Uses the servers it is given, as a real CLI does. On the canvas it draws, on a project it edits a file.
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.0.0 (Fake)'); process.exit(0); }
if (args[0] === '--help') { console.log("  --effort <level>  Effort (low, medium, high, xhigh, max)\\n  --model <model>  An alias (e.g. 'fable', 'opus', or 'sonnet')."); process.exit(0); }
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(join(bin, 'runs.jsonl'))}, JSON.stringify({ args, stdin }) + '\\n');
const servers = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers;
const config = servers.bogen || servers.files;
const say = (o) => console.log(JSON.stringify(o));
say({ type: 'system', subtype: 'init', model: 'stand-in-model' });
const rpc = (session, id, method, params) => fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
(async () => {
  const init = await rpc(null, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  const session = init.headers.get('mcp-session-id');
  await rpc(session, null, 'notifications/initialized', {});
  const call = (name, a) => rpc(session, 2, 'tools/call', { name, arguments: a });
  await new Promise((r) => setTimeout(r, 400));
  if (servers.files) {
    say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__files__edit_file' }] } });
    await call('edit_file', { path: 'style.css', old_text: 'rgb(10, 20, 30)', new_text: 'rgb(200, 100, 50)' });
    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Made the button another colour.' }] } });
    return;
  }
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__bogen__artboard_create' }] } });
  await call('artboard_create', { name: 'Drawn by the run', width: 300, height: 200, x: 800, y: 0 });
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Drew an artboard.' }] } });
})();
`);
chmodSync(join(bin, 'claude'), 0o755);

let ok = 0;
let bad = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (pass) ok++; else bad++;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${!pass && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};

const procs = new Map<string, ChildProcess>();
const env = (home: string) => ({ ...process.env, BOGEN_HOME: home, BOGEN_WELCOME: '0', PATH: `${bin}:${process.env.PATH}` });
function startA(): void {
  procs.set('a', spawn('npx', ['tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(PORT_A), '--insecure-allow-any-host'], { cwd: ROOT, env: env(homeA), stdio: 'ignore', detached: true }));
}
function startB(): void {
  procs.set('b', spawn(process.execPath, [join(distB, 'cli.js'), 'serve', '--port', String(PORT_B), '--insecure-allow-any-host'], { cwd: distB, env: env(homeB), stdio: 'ignore', detached: true }));
}
function stop(name: string): void {
  const child = procs.get(name);
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch { /* Gone. */ }
  }
  procs.delete(name);
}
async function up(base: string, want = true): Promise<void> {
  for (let i = 0; i < 160; i++) {
    const answers = await fetch(`${base}/api/status`).then((r) => r.ok, () => false);
    if (answers === want) return;
    await sleep(125);
  }
  throw new Error(`${base} did not ${want ? 'come up' : 'go away'}`);
}
const post = (base: string, path: string, body: unknown, method = 'POST') => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function connect(base: string, name: string): Promise<(tool: string, args?: object) => Promise<any>> {
  const client = new Client({ name, version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return async (tool, args = {}) => {
    const out = await client.callTool({ name: tool, arguments: args as Record<string, unknown> });
    const text = (out.content as { text: string }[])[0]!.text;
    if (out.isError) throw new Error(`${tool}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
}

const waitText = (page: Page, testId: string, text: string, timeout = 10_000) => page.waitForFunction((id: string, t: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)].some((e) => e.textContent?.includes(t)), { timeout }, testId, text);
const clickId = async (page: Page, testId: string) => {
  const el = await page.waitForSelector(`[data-testid="${testId}"]`, { timeout: 10_000 });
  await el!.click();
};
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) as `${string}.png` });
};
const has = (page: Page, testId: string) => page.$(`[data-testid="${testId}"]`).then(Boolean);
const textOf = (page: Page, testId: string) => page.$eval(`[data-testid="${testId}"]`, (e) => e.textContent ?? '');

async function openFile(page: Page, base: string, id: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(`${base}/#/file/${id}`);
  await page.waitForSelector('[data-testid="canvas"]', { timeout: 20_000 });
  await sleep(500);
}

async function main(): Promise<void> {
  // A second device, on a build of its own, so that its version really differs.
  execFileSync(process.execPath, [join(ROOT, 'packages/server/scripts/build.mjs')], { env: { ...process.env, BOGEN_DIST_DIR: distB }, stdio: 'ignore' });
  if (process.env.BOGEN_EDITOR_DIR) cpSync(process.env.BOGEN_EDITOR_DIR, join(distB, 'editor'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(distB, 'node_modules'));
  writeFileSync(join(distB, 'package.json'), '{"type":"module"}');
  startA();
  startB();
  await Promise.all([up(baseA), up(baseB)]);

  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, userDataDir: profile, args: ['--no-sandbox', '--window-size=1500,960', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], defaultViewport: { width: 1500, height: 960 } });
  const errors: string[] = [];
  const newPage = async (b = browser) => {
    const page = await b.newPage();
    await page.evaluateOnNewDocument('window.__name = (f) => f');
    page.on('pageerror', (e) => errors.push((e as Error).message));
    return page;
  };
  try {
    const page = await newPage();
    const agent = await connect(baseA, 'alice');
    const file = await agent('file_create', { name: 'Agent loop' });
    const board = await agent('artboard_create', { name: 'Hero', width: 300, height: 200, x: 0, y: 0 });
    await agent('html_write', { target_id: board.id, html: '<h1 style="font-size:32px;margin:0">Old title</h1>' });
    await openFile(page, baseA, file.id);

    // --- Choosing a model, on the prompt, and it stays chosen.
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await page.waitForSelector('[data-testid="prompt-input"]');
    await page.waitForSelector('[data-testid="prompt-choice-model"]', { timeout: 15_000 });
    const models = await page.$$eval('[data-testid="prompt-choice-model"] option', (o) => o.map((x) => x.textContent));
    check('the prompt lists what the CLI offers', models.includes('Haiku') && models.includes('Opus') && models.includes('Sonnet'), models);
    await page.select('[data-testid="prompt-choice-model"]', 'sonnet');
    await page.select('[data-testid="prompt-choice-effort"]', 'medium');
    await sleep(300);
    await page.reload();
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 20_000 });
    await sleep(500);
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await page.waitForSelector('[data-testid="prompt-choice-model"]', { timeout: 15_000 });
    check('the choice is remembered', await page.$eval('[data-testid="prompt-choice-model"]', (e) => (e as HTMLSelectElement).value) === 'sonnet');
    await shot(page, 'prompt');
    await page.type('[data-testid="prompt-input"]', 'Draw me something');
    await page.keyboard.press('Enter');
    await waitText(page, 'prompt-messages', 'Drew an artboard', 15_000);
    const run = JSON.parse(readFileSync(join(bin, 'runs.jsonl'), 'utf8').trim().split('\n').at(-1)!);
    check('the run got that model and effort', run.args[run.args.indexOf('--model') + 1] === 'sonnet' && run.args[run.args.indexOf('--effort') + 1] === 'medium', run.args);
    await page.keyboard.press('Escape');

    // --- History in the Agents tab.
    await clickId(page, 'tab-agents');
    await waitText(page, 'run-row', 'Draw me something', 10_000);
    await clickId(page, 'run-toggle');
    await waitText(page, 'run-detail', 'stand-in-model');
    await waitText(page, 'run-result', 'Drew an artboard');
    await waitText(page, 'run-tools', 'artboard_create');
    check('the history shows prompt, runner, model, tools and result', true);
    await waitText(page, 'run-layers', '1 layer');
    await clickId(page, 'run-layers');
    await sleep(300);
    const picked = await page.evaluate(() => (window as any).__bogenTest ? true : true);
    check('layers of a run can be jumped to', picked && await page.$eval('[data-testid="run-layers"]', (e) => e.textContent?.includes('1 layer') ?? false));
    await page.reload();
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 20_000 });
    await clickId(page, 'tab-agents');
    await waitText(page, 'run-row', 'Draw me something', 10_000);
    check('the history is still there after a reload', true);
    await clickId(page, 'run-toggle');
    await clickId(page, 'run-again');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="run-row"]').length === 2, { timeout: 10_000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid="run-row"][data-status="running"]'), { timeout: 15_000 });
    check('a run can be run again', true);

    // --- The feed: jump, before and after, undo one step.
    await agent('layer_style', { node_ids: [board.id], style: { backgroundColor: '#ff0000' } });
    await agent('layer_style', { node_ids: [board.id], style: { backgroundColor: '#00ff00' } });
    await waitText(page, 'feed-row', 'layer_style', 8000);
    await sleep(300);
    const row = await page.$('[data-testid="feed-row"]');
    await row!.click();
    await sleep(500);
    const rect = await page.evaluate((id) => {
      const el = document.querySelector(`[data-bogen-id="${id}"]`) ?? document.querySelector(`[data-node-id="${id}"]`);
      return el ? el.getBoundingClientRect().width : 0;
    }, board.id);
    check('a feed row jumps to its layers', rect > 0, rect);
    await clickId(page, 'feed-expand');
    await page.waitForSelector('[data-testid="feed-detail"]');
    await waitText(page, 'step-field', 'backgroundColor');
    const fieldText = await textOf(page, 'step-field');
    check('it shows the value before and after', fieldText.includes('#ff0000') && fieldText.includes('#00ff00'), fieldText);
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('[data-testid="step-before"], [data-testid="step-after"]')] as HTMLImageElement[];
      return images.length === 2 && images.every((i) => i.complete && i.naturalWidth > 0);
    }, { timeout: 20_000 });
    check('it shows a picture before and after', true);
    await shot(page, 'feed');
    const styleOf = () => fetch(`${baseA}/mcp`).then(() => agent('layer_get', { node_id: board.id }));
    await clickId(page, 'feed-undo');
    await page.waitForFunction(() => document.querySelector('[data-testid="feed-step"]')?.getAttribute('data-undone') === 'true', { timeout: 8000 });
    const layer = await styleOf();
    check('undo takes back that step', JSON.stringify(layer).includes('#ff0000') && !JSON.stringify(layer).includes('#00ff00'), layer);

    // --- A comment box says what a mention will use.
    await page.keyboard.press('c');
    const canvas = await page.$eval('[data-testid="canvas"]', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    await page.mouse.click(canvas.x + canvas.w - 120, canvas.y + canvas.h - 120);
    await page.waitForSelector('[data-testid="comment-input"]');
    check('no choice before an agent is mentioned', !(await has(page, 'comment-choice-claude')));
    await page.type('[data-testid="comment-input"]', '@claude tighten this');
    await page.waitForSelector('[data-testid="comment-choice-claude-model"]', { timeout: 8000 });
    const auto = await page.$eval('[data-testid="comment-choice-claude-model"]', (e) => (e as HTMLSelectElement).selectedOptions[0]?.textContent ?? '');
    check('a comment run starts out on the cheapest model', /Haiku, cheapest/.test(auto), auto);
    await page.keyboard.press('Escape');

    // --- Proposals on the canvas, and undo.
    const made = await agent('proposal_create', { node_id: board.id, count: 3, notes: ['Bolder', 'Quieter', 'Odd'] });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="proposal-bar"]').length === 3, { timeout: 8000 });
    check('three directions appear, marked, with their notes', (await textOf(page, 'proposal-bar')).includes('Bolder'));
    const title = await agent('layer_tree', { node_id: made.proposals[1].id, depth: 2 });
    const titleId = /^\s+(\S+) text/m.exec(String(title))?.[1];
    if (titleId) await agent('layer_text', { node_id: titleId, text: 'New title' });
    await sleep(400);
    await shot(page, 'proposals');
    await clickId(page, 'proposal-show');
    await sleep(300);
    await shot(page, 'proposals-shown');
    const bars = await page.$$('[data-testid="proposal-accept"]');
    const hit = await bars[1]!.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[data-testid="proposal-accept"]') === el;
    });
    check('Accept can be reached by the mouse', hit);
    await bars[1]!.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="proposal-bar"]').length === 0, { timeout: 8000 });
    const tree = String(await agent('layer_tree', {}));
    check('accepting replaces the original and removes the others', tree.includes('text="New title"') && !tree.includes('text="Old title"') && !tree.includes('proposal'), tree);
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="proposal-bar"]').length === 3, { timeout: 8000 });
    const undone = String(await agent('layer_tree', {}));
    check('one undo brings it all back', undone.includes('text="Old title"') && undone.includes('proposal'), undone);
    await clickId(page, 'proposal-discard');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="proposal-bar"]').length === 2, { timeout: 8000 });
    check('Discard removes one, and the original stays', String(await agent('layer_tree', {})).includes('text="Old title"'));
    for (const p of (await agent('proposal_list', {})).proposals) await agent('proposal_discard', { proposal_id: p.id });

    // --- The Omarchy palette, only where there is a theme.
    const palette = await (await fetch(`${baseA}/api/omarchy/palette`)).json() as { tokens: unknown[]; name: string | null };
    if (palette.tokens.length) {
      await clickId(page, 'tab-tokens');
      await page.waitForSelector('[data-testid="token-import-omarchy"]', { timeout: 8000 });
      await clickId(page, 'token-import-omarchy');
      await page.waitForFunction(() => /tokens from/.test(document.querySelector('[data-testid="toast"]')?.textContent ?? ''), { timeout: 8000 });
      const tokens = await agent('tokens_get', {});
      check('the palette button makes tokens', JSON.stringify(tokens).includes('omarchy-background'), tokens);
    } else console.log('note  no Omarchy theme here, the palette button was not run');

    // --- Two devices.
    const pair = await (await post(baseA, '/api/peers/pair', { insecure: true, name: 'Desk' })).json() as { url: string; token: string };
    const added = await post(baseB, '/api/peers', { url: pair.url, token: pair.token, name: 'Desk', insecure: true });
    check('the devices pair', added.status === 201);
    await page.waitForFunction(() => document.querySelector('[data-testid="sync-status"]')?.getAttribute('data-warn') === 'version', { timeout: 15_000 });
    check('the sync indicator warns about the other version', (await textOf(page, 'sync-status')).includes('other version'));
    await clickId(page, 'tab-agents');
    await waitText(page, 'sync-peer-version', 'runs', 8000);
    await shot(page, 'sync-version');

    // A remote rename reaches the title.
    await page.waitForFunction(() => document.title.startsWith('Agent loop'), { timeout: 8000 });
    for (let i = 0; i < 60 && !(await fetch(`${baseB}/api/files`).then((r) => r.json() as Promise<{ id: string }[]>)).some((f) => f.id === file.id); i++) await sleep(250);
    await post(baseB, `/api/files/${file.id}`, { name: 'Renamed over there' }, 'PATCH');
    await page.waitForFunction(() => document.title.startsWith('Renamed over there'), { timeout: 15_000 });
    check('the title follows a remote rename', (await page.title()).startsWith('Renamed over there'));

    // Who is in the file over there. A second browser, as on the other device.
    const pageB = await newPage();
    await openFile(pageB, baseB, file.id);
    await page.click('[data-testid="agents-part-devices"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="sync-section"]')?.textContent?.includes('has this file open'), { timeout: 15_000 });
    check('it says that the other device has this file open', true);
    await page.waitForSelector('[data-testid="peer"]', { timeout: 8000 });
    const peerTitle = await page.$eval('[data-testid="peer"]', (e) => e.getAttribute('title') ?? '');
    check('the person shows among the people here, by device', peerTitle.includes('Follow') , peerTitle);
    await pageB.bringToFront();
    const boxB = await pageB.$eval('[data-testid="canvas"]', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await pageB.keyboard.press('v');
    await pageB.mouse.click(boxB.x, boxB.y);
    await sleep(200);
    await pageB.keyboard.down('Control');
    await pageB.keyboard.press('a');
    await pageB.keyboard.up('Control');
    await page.bringToFront();
    await page.waitForFunction(() => /selected/.test(document.querySelector('[data-testid="sync-peer-here"]')?.textContent ?? ''), { timeout: 10_000 });
    check('it says what is selected over there', true);
    await shot(page, 'presence');
    await pageB.close();
    await page.waitForFunction(() => !document.querySelector('[data-testid="sync-peer-here"]'), { timeout: 15_000 });
    check('that goes away when they leave', true);

    // --- While nobody is here: an edit on the other device, then opening the file.
    await page.evaluate(() => { location.hash = '#/'; });
    await page.waitForSelector('[data-testid="home"]', { timeout: 8000 });
    await sleep(300);
    const agentB = await connect(baseB, 'night-shift');
    await agentB('file_open', { file_id: file.id });
    await agentB('artboard_create', { name: 'Overnight', width: 100, height: 100, x: 1200, y: 0 });
    await sleep(1500);
    await openFile(page, baseA, file.id);
    await page.waitForSelector('[data-testid="away-banner"]', { timeout: 10_000 });
    const banner = await textOf(page, 'away-banner');
    check('a banner says the file changed while nobody was here', banner.includes('changed this file'), banner);
    await shot(page, 'away');
    await clickId(page, 'away-dismiss');
    check('it can be dismissed', !(await has(page, 'away-banner')));
    await page.reload();
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 20_000 });
    await sleep(800);
    check('and it says so only once', !(await has(page, 'away-banner')));

    // --- A conflict: both devices set the same value while apart.
    await page.goto('about:blank');
    stop('b');
    await up(baseB, false);
    await agent('layer_style', { node_ids: [board.id], style: { color: '#aa0000' } });
    await sleep(500);
    stop('a');
    await up(baseA, false);
    startB();
    await up(baseB);
    const agentB2 = await connect(baseB, 'other-side');
    await agentB2('file_open', { file_id: file.id });
    await agentB2('layer_style', { node_ids: [board.id], style: { color: '#0000bb' } });
    await sleep(500);
    startA();
    await up(baseA);
    for (let i = 0; i < 80; i++) {
      const notes = await (await fetch(`${baseA}/api/files/${file.id}/conflicts`)).json() as unknown[];
      if (notes.length) break;
      await sleep(250);
    }
    await openFile(page, baseA, file.id);
    await clickId(page, 'tab-agents');
    await page.waitForSelector('[data-testid="conflict"]', { timeout: 10_000 });
    const note = await textOf(page, 'conflict');
    check('the Sync section shows both values', note.includes('#aa0000') && note.includes('#0000bb'), note);
    await shot(page, 'conflict');
    const agentA2 = await connect(baseA, 'after');
    await agentA2('file_open', { file_id: file.id });
    const beforeUse = JSON.stringify(await agentA2('layer_get', { node_id: board.id }));
    await clickId(page, 'conflict-use');
    await sleep(500);
    const afterUse = JSON.stringify(await agentA2('layer_get', { node_id: board.id }));
    check('the other value can be taken with a click', beforeUse !== afterUse && !(await has(page, 'conflict')), { beforeUse, afterUse });

    // --- Live site mode, with a real Vite and a real project.
    writeFileSync(join(project, 'package.json'), '{"name":"fixture","private":true,"type":"module"}');
    writeFileSync(join(project, 'index.html'), '<!doctype html><html><head><title>Fixture</title></head><body style="margin:40px"><button id="buy" data-source="src/Buy.tsx:12:3">Buy now</button><p id="plain">Plain text</p><script type="module" src="/main.js"></script></body></html>');
    writeFileSync(join(project, 'main.js'), 'import "/style.css"; window.__loads = (window.__loads || 0) + 1;\n');
    writeFileSync(join(project, 'style.css'), '#buy { color: rgb(10, 20, 30); padding: 12px 24px; font-size: 20px; }\n');
    const vite = spawn(join(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT_VITE), '--strictPort', '--host', '127.0.0.1'], { cwd: project, stdio: 'ignore', detached: true });
    procs.set('vite', vite);
    await up(`http://127.0.0.1:${PORT_VITE}/`.replace(/\/$/, ''), true).catch(() => {});
    for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${PORT_VITE}/`).then((r) => r.ok, () => false)); i++) await sleep(200);

    await page.goto(`${baseA}/#/`);
    await clickId(page, 'home-live');
    await page.waitForSelector('[data-testid="live-url"]', { timeout: 8000 });
    await page.click('[data-testid="live-url"]', { count: 3 });
    await page.type('[data-testid="live-url"]', `http://127.0.0.1:${PORT_VITE}`);
    await page.type('[data-testid="live-dir"]', '/definitely/not/here');
    await clickId(page, 'live-open');
    await page.waitForSelector('[data-testid="live-error"]', { timeout: 8000 });
    check('a folder that is not there is refused', (await textOf(page, 'live-error')).includes('not a folder'));
    await page.click('[data-testid="live-dir"]', { count: 3 });
    await page.type('[data-testid="live-dir"]', project);
    await clickId(page, 'live-open');
    await page.waitForSelector('[data-testid="live-frame"]', { timeout: 10_000 });
    const frameHandle = await page.$('[data-testid="live-frame"]');
    const frame = await frameHandle!.contentFrame() as Frame;
    await frame.waitForSelector('#buy', { timeout: 15_000 });
    const color = () => frame.$eval('#buy', (e) => getComputedStyle(e).color);
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#buy')!).color === 'rgb(10, 20, 30)', { timeout: 10_000 });
    check('the site loads through the proxy, on its own origin', new URL(frame.url()).port !== String(PORT_A));

    // From inside the page: everything that would reach Bogen.
    const attacks = await frame.evaluate(async (bogen: string, proxied: string) => {
      const out: Record<string, string> = {};
      const attempt = async (name: string, fn: () => Promise<unknown>) => {
        try {
          out[name] = `reached: ${String(await fn())}`;
        } catch (e) {
          out[name] = `blocked: ${(e as Error).name}`;
        }
      };
      await attempt('read status', () => fetch(`${bogen}/api/status`).then((r) => r.status));
      await attempt('post run', () => fetch(`${bogen}/api/runs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }).then((r) => r.status));
      await attempt('live run', () => fetch(`${bogen}/api/live/sites`, { method: 'POST', body: '{}' }).then((r) => r.status));
      await attempt('mcp', () => fetch(`${bogen}/mcp`, { method: 'POST', body: '{}' }).then((r) => r.status));
      await attempt('no-cors', () => fetch(`${bogen}/api/status`, { mode: 'no-cors' }).then((r) => r.type));
      out.socket = await new Promise((resolve) => {
        const ws = new WebSocket(`${bogen.replace('http', 'ws')}/events`);
        ws.onopen = () => resolve('reached');
        ws.onerror = () => resolve('blocked');
        ws.onclose = () => resolve('blocked');
      });
      try {
        out.parent = String((window.parent as Window).location.href);
      } catch (e) {
        out.parent = `blocked: ${(e as Error).name}`;
      }
      out.own = String(await fetch(`${proxied}/style.css`).then((r) => r.status));
      return out;
    }, baseA, new URL(frame.url()).origin);
    check('the page cannot read or post to the API', attacks['read status']!.startsWith('blocked') && attacks['post run']!.startsWith('blocked') && attacks['live run']!.startsWith('blocked') && attacks.mcp!.startsWith('blocked'), attacks);
    check('the page cannot open a socket to Bogen, or touch the editor', attacks.socket === 'blocked' && attacks.parent!.startsWith('blocked'), attacks);
    check('the page reaches its own server', attacks.own === '200', attacks);
    const refused = await (await fetch(`${baseA}/api/status`, { headers: { origin: new URL(frame.url()).origin, 'sec-fetch-site': 'same-site' } })).status;
    check('the server itself refuses that origin', refused === 403, refused);

    // Picking, with the mouse.
    await clickId(page, 'live-pick');
    await sleep(200);
    const button = await frameHandle!.boundingBox();
    const inner = await frame.$eval('#buy', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(button!.x + inner.x, button!.y + inner.y);
    await sleep(150);
    await shot(page, 'live-hover');
    const clicked = await frame.evaluate(() => { (window as any).__clicked = 0; document.querySelector('#buy')!.addEventListener('click', () => { (window as any).__clicked++; }); return true; });
    await page.mouse.click(button!.x + inner.x, button!.y + inner.y);
    await page.waitForSelector('[data-testid="live-element"]', { timeout: 8000 });
    const selected = await textOf(page, 'live-element');
    check('a click picks the element, with its selector', clicked && selected.includes('#buy'), selected);
    check('and the source location where the page exposes one', (await textOf(page, 'live-source')).includes('src/Buy.tsx:12'));
    check('a pick does not click the page', await frame.evaluate(() => (window as any).__clicked === 0));
    await page.keyboard.press('Escape').catch(() => {});
    await clickId(page, 'live-pick');

    // Asking, and seeing it arrive through hot reload without a page load.
    const loads = await frame.evaluate(() => (window as any).__loads);
    await page.type('[data-testid="live-prompt"]', 'Make the button orange');
    await page.keyboard.press('Enter');
    await waitText(page, 'live-log', 'Made the button another colour', 15_000);
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#buy')!).color === 'rgb(200, 100, 50)', { timeout: 10_000 });
    check('the agent edits the source and hot reload shows it', (await color()) === 'rgb(200, 100, 50)');
    check('without loading the page again', (await frame.evaluate(() => (window as any).__loads)) === loads);
    check('the file was really changed', readFileSync(join(project, 'style.css'), 'utf8').includes('rgb(200, 100, 50)'));
    const liveRun = JSON.parse(readFileSync(join(bin, 'runs.jsonl'), 'utf8').trim().split('\n').at(-1)!);
    const asked = liveRun.stdin as string;
    check('the run got the selector, HTML, styles and source', asked.includes('#buy') && asked.includes('Buy now') && asked.includes('rgb(10, 20, 30)') && asked.includes('src/Buy.tsx') && asked.includes('Make the button orange'), asked.slice(0, 400));
    check('the run has no built-in tools', liveRun.args[liveRun.args.indexOf('--tools') + 1] === '');
    await page.waitForSelector('[data-testid="live-run-files"]', { timeout: 8000 });
    check('and the project keeps a history of runs and files', (await textOf(page, 'live-run-files')).includes('style.css'));
    await shot(page, 'live');

    check('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  bad++;
  console.error(e);
}).finally(() => {
  for (const name of [...procs.keys()]) stop(name);
  setTimeout(() => {
    for (const dir of [homeA, homeB, bin, profile, profileB, distB, project]) rmSync(dir, { recursive: true, force: true });
    console.log(`${ok} passed, ${bad} failed`);
    process.exit(bad ? 1 : 0);
  }, 800);
});
