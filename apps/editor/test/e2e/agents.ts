/**
 * Agents and people in the real editor, against the real server, in a real browser: a comment mentioning
 * an agent, and an agent showing the person something. The agent is a stand-in CLI, so no plan is used.
 * Run after building the editor: npx tsx apps/editor/test/e2e/agents.ts
 * BOGEN_EDITOR_DIR points at a build elsewhere.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import puppeteer, { type Page } from 'puppeteer-core';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOT = resolve(import.meta.dirname, '../../../..');
const home = mkdtempSync(join(tmpdir(), 'bogen-e2e-home-'));
const bin = mkdtempSync(join(tmpdir(), 'bogen-e2e-bin-'));
const profile = mkdtempSync(join(tmpdir(), 'bogen-e2e-profile-'));
const PORT = 29000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${PORT}`;

// Replies over the MCP server it was given, after a pause in which the thread shows it working.
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('1.0.0 (Fake)'); process.exit(0); }
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
const config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.bogen;
const thread = /Comment thread (\\w+):/.exec(stdin)[1];
const rpc = (session, id, method, params) => fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
(async () => {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const init = await rpc(null, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  const session = init.headers.get('mcp-session-id');
  await rpc(session, null, 'notifications/initialized', {});
  await rpc(session, 2, 'tools/call', { name: 'comment_reply', arguments: { thread_id: thread, text: 'Looks good to me.' } });
})();
`);
chmodSync(join(bin, 'claude'), 0o755);

const server = spawn('npx', ['tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(PORT)], { cwd: ROOT, env: { ...process.env, BOGEN_HOME: home, BOGEN_WELCOME: '0', PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore', detached: true });

let ok = 0;
let bad = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (pass) ok++; else bad++;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${!pass && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
const waitText = (page: Page, testId: string, text: string, timeout = 8000) => page.waitForFunction((id: string, t: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)].some((e) => e.textContent?.includes(t)), { timeout }, testId, text);
const transform = (page: Page) => page.$eval('.bogen-world', (e) => (e as HTMLElement).style.transform);

async function main(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }
  const agent = new Client({ name: 'shower', version: '1' });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const callTool = async (name: string, args: object) => JSON.parse(((await agent.callTool({ name, arguments: args as Record<string, unknown> })).content as { text: string }[])[0]!.text);
  const file = await callTool('file_create', { name: 'Agents e2e' });
  const near = await callTool('artboard_create', { name: 'Near', width: 300, height: 200, x: 0, y: 0 });
  const far = await callTool('artboard_create', { name: 'Far away', width: 300, height: 200, x: 6000, y: 4000 });

  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, userDataDir: profile, args: ['--no-sandbox', '--window-size=1500,960', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], defaultViewport: { width: 1500, height: 960 } });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument('window.__name = (f) => f');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push((e as Error).message));
    await page.goto(`${base}/#/file/${file.id}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 15000 });
    await sleep(500);

    // A comment that mentions an agent.
    const box = await page.$eval('[data-testid="canvas"]', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top };
    });
    await page.keyboard.press('c');
    await page.mouse.click(box.x + 400, box.y + 300);
    await page.waitForSelector('[data-testid="comment-input"]');
    check('the composer says agents can be asked', (await page.$eval('[data-testid="comment-input"]', (e) => (e as HTMLTextAreaElement).placeholder)).includes('@claude'));
    await page.keyboard.type('@claude is this any good?');
    await page.keyboard.press('Enter');
    await waitText(page, 'thread', 'is this any good');
    await waitText(page, 'thread-run', 'claude is working');
    check('the thread shows the agent working', true);
    check('the mention stands out', (await page.$('.message-mention')) !== null);
    check('there is a way to stop it', (await page.$('[data-testid="thread-run-stop"]')) !== null);
    await waitText(page, 'thread', 'Looks good to me.');
    check('the answer lands in the same thread', (await page.$$('[data-testid="thread"]')).length === 1);
    await page.waitForFunction(() => !document.querySelector('[data-testid="thread-run"]'), { timeout: 8000 });
    check('the working line goes away at the end', true);

    // An agent shows something, and the view follows.
    await page.mouse.move(box.x + 700, box.y + 500);
    await sleep(100);
    const before = await transform(page);
    await callTool('view_focus', { node_ids: [far.id], note: 'The far one' });
    await waitText(page, 'toast', 'shower: The far one');
    await sleep(200);
    check('view_focus moves the view', (await transform(page)) !== before, { before, after: await transform(page) });

    // While the person holds the mouse down, nothing moves.
    await page.mouse.move(box.x + 700, box.y + 500);
    await page.mouse.down({ button: 'middle' });
    await sleep(100);
    const held = await transform(page);
    await callTool('view_focus', { node_ids: [near.id], note: 'Back here' });
    await sleep(1000);
    check('it waits while the person is dragging', (await transform(page)) === held, { held, now: await transform(page) });
    await page.mouse.up({ button: 'middle' });
    await waitText(page, 'toast', 'shower: Back here');
    await sleep(200);
    check('it follows once they let go', (await transform(page)) !== held);

    // selection_set selects, and only when allowed.
    await callTool('selection_set', { node_ids: [near.id] });
    await page.click('[data-testid="tab-design"]');
    await page.waitForSelector('[data-testid="inspector"]', { timeout: 4000 });
    check('selection_set selects the layer', true);

    await page.click('[data-testid="tab-agents"]');
    await page.waitForSelector('[data-testid="follow-agents"]');
    await page.click('[data-testid="follow-agents"]');
    await sleep(100);
    const quiet = await transform(page);
    await callTool('view_focus', { node_ids: [far.id] });
    await sleep(800);
    check('the person can turn it off', (await transform(page)) === quiet);

    check('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
    await agent.close();
  }
}

await main().catch((e) => {
  bad++;
  console.error(e);
});
try {
  process.kill(-server.pid!, 'SIGTERM');
} catch { /* gone */ }
await sleep(300);
for (const dir of [home, bin, profile]) rmSync(dir, { recursive: true, force: true });
console.log(`${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
