/**
 * A race of agents, a critique with Fix it, rule suggestions from decisions and Rebuild as layers, in the real
 * editor against the real server in a real browser. Both CLIs are stand-ins, so no plan is used.
 * Run after building the editor: npx tsx apps/editor/test/e2e/agent-features.ts
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

// One stand-in for both CLIs. It reads what kind of run it is from its prompt, as a real CLI would, and works
// over the MCP server it was given: a race lane restyles its own copy (the third one keeps going until stopped),
// a critique leaves notes, a comment run answers and resolves.
const STAND_IN = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.0.0 (Fake)'); process.exit(0); }
if (args[0] === '--help' || args[0] === 'debug') { console.log(args[0] === 'debug' ? '{"models":[]}' : ''); process.exit(0); }
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
const sys = args.includes('--append-system-prompt') ? args[args.indexOf('--append-system-prompt') + 1] : '';
const text = sys + '\\n' + stdin;
const say = (o) => console.log(JSON.stringify(o));
let config;
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { session } = await rpc(null, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  await rpc(session, null, 'notifications/initialized', {});
  let n = 10;
  const tool = async (name, a) => {
    say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__bogen__' + name, input: a }] } });
    return (await rpc(session, n++, 'tools/call', { name, arguments: a })).body.result;
  };
  const race = /Yours is proposal (\\w+)/.exec(text);
  if (race) {
    const agent = config.headers['X-Bogen-Agent'];
    await wait(1200);
    await tool('layer_style', { node_ids: [race[1]], style: { backgroundColor: agent === 'codex' ? '#2b3df2' : '#f4f2ec' } });
    if (agent === 'claude 2') { setInterval(() => {}, 1000); return; }
    await wait(1200);
  } else if (/This is a critique/.test(text)) {
    const layer = /selected these layers: (\\w+)/.exec(text)[1];
    await tool('comment_add', { node_id: layer, text: 'The heading and the price compete.', suggestion: 'Set the price to 20px, weight 500.', check: 'practice' });
    await tool('comment_add', { node_id: layer, text: 'At 390 the card overflows.', suggestion: 'Use width 100% and max-width 420px.', check: 'widths' });
    // Refused: a critique changes nothing.
    await tool('layer_style', { node_ids: [layer], style: { backgroundColor: '#ff0000' } });
  } else if (/Rebuild the attached image/.test(text)) {
    await wait(2500);
  } else if (/Comment thread/.test(text)) {
    const thread = /Comment thread (\\w+):/.exec(text)[1];
    await wait(1200);
    await tool('comment_reply', { thread_id: thread, text: 'Done.' });
  }
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
  say({ type: 'result', is_error: false });
})();
`;
for (const name of ['claude', 'codex']) {
  writeFileSync(join(bin, name), STAND_IN);
  chmodSync(join(bin, name), 0o755);
}

const server = spawn('npx', ['tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(PORT)], { cwd: ROOT, env: { ...process.env, BOGEN_HOME: home, BOGEN_WELCOME: '0', PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore', detached: true });

let ok = 0;
let bad = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (pass) ok++; else bad++;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${!pass && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
const waitFor = async (fn: () => Promise<boolean>, timeout = 10_000): Promise<boolean> => {
  for (const until = Date.now() + timeout; Date.now() < until; await sleep(150)) if (await fn()) return true;
  return false;
};
const texts = (page: Page, selector: string) => page.$$eval(selector, (els) => els.map((e) => e.textContent ?? ''));
const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function main(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }
  const agent = new Client({ name: 'setup', version: '1' });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const callTool = async (name: string, args: object) => JSON.parse(((await agent.callTool({ name, arguments: args as Record<string, unknown> })).content as { text: string }[])[0]!.text);
  const brand = await (await fetch(`${base}/api/brands`, json({ name: 'Calm' }))).json() as { id: string };
  const file = await callTool('file_create', { name: 'Agent features e2e' });
  await fetch(`${base}/api/files/${file.id}/brand`, json({ brandId: brand.id }, 'PUT'));
  const card = await callTool('artboard_create', { name: 'Pricing card', width: 460, height: 320, x: 0, y: 0 });
  await callTool('html_write', { target_id: card.id, html: '<section style="display:flex;flex-direction:column;gap:16px;padding:32px"><h2 style="margin:0">Studio</h2><p style="margin:0">$24 a month</p></section>' });
  // Decisions for the memory: twice, the flat copy is accepted and the two with gradients go.
  const hero = await callTool('artboard_create', { name: 'Hero', width: 300, height: 200, x: 0, y: 1200 });
  for (let round = 0; round < 2; round++) {
    const made = await callTool('proposal_create', { node_id: hero.id, count: 3, notes: ['Flat', 'Glow', 'Shine'] });
    const [flat, glow, shine] = made.proposals.map((p: { id: string }) => p.id);
    await callTool('layer_style', { node_ids: [glow, shine], style: { background: 'linear-gradient(90deg, #a0f, #0af)' } });
    await fetch(`${base}/api/files/${file.id}/proposals/${flat}/accept`, json({ who: 'Tester' }));
  }

  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, userDataDir: profile, args: ['--no-sandbox', '--window-size=1500,960', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], defaultViewport: { width: 1500, height: 960 } });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument('window.__name = (f) => f');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push((e as Error).message));
    await page.goto(`${base}/#/file/${file.id}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 15000 });
    await sleep(800);
    const select = async (id: string) => {
      await callTool('selection_set', { node_ids: [id], file_id: file.id });
      await sleep(300);
    };
    const openPrompt = async (review: string) => {
      await page.keyboard.down('Control');
      await page.keyboard.press('k');
      await page.keyboard.up('Control');
      await page.waitForSelector('[data-testid="prompt-input"]');
      await page.select('select[data-testid="prompt-review"]', review);
      await sleep(200);
    };
    const races = async () => (await (await fetch(`${base}/api/races?fileId=${file.id}`)).json()) as { id: string; lanes: { agent: string; status: string; decision?: string }[] }[];

    // A race: three lanes, one copy each, followed on the canvas.
    await select(card.id);
    await callTool('view_focus', { node_ids: [card.id], file_id: file.id });
    await openPrompt('directions');
    check('three directions offers lanes to pick', (await page.$$('[data-testid="prompt-lane"]')).length === 3);
    check('the bar says each run is on your own plan', (await texts(page, '[data-testid="prompt-target"]'))[0]?.includes('3 runs, each on your own plan') ?? false);
    await page.select('[data-testid="prompt-lane"]:nth-child(2) select[data-testid="prompt-lane-runner"]', 'codex');
    await page.type('[data-testid="prompt-input"]', 'Make it calmer');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="race-tray"]', { timeout: 8000 });
    check('the race tray shows while it runs', (await texts(page, '[data-testid="race-tray"]'))[0]?.includes('uses your plan 3 times') ?? false);
    check('each copy has its own bar', await waitFor(async () => (await page.$$('[data-testid="proposal-bar"][data-lane]')).length === 3));
    const colors = await page.$$eval('[data-testid="proposal-outline"]', (els) => els.map((e) => (e as HTMLElement).style.borderColor));
    check('each copy has its own colour', new Set(colors).size === 3, colors);
    check('two lanes finish', await waitFor(async () => (await races())[0]!.lanes.filter((l) => l.status === 'done').length === 2));
    check('a lane shows what it does', (await texts(page, '[data-testid="lane-status"]')).some((t) => t.startsWith('Done')));
    await page.$eval('[data-testid="proposal-bar"][data-lane="l3"] [data-testid="lane-stop"]', (e) => (e as HTMLElement).click());
    check('Stop stops one lane', await waitFor(async () => (await races())[0]!.lanes[2]!.status === 'stopped'));
    await page.waitForFunction(() => document.querySelector('[data-testid="race-tray"]')?.textContent?.includes('Race done'), { timeout: 5000 });
    check('the tray offers to keep the others', (await page.$('[data-testid="race-keep-branch"]')) !== null);
    await page.$eval('[data-testid="proposal-bar"][data-lane="l2"] [data-testid="proposal-accept"]', (e) => (e as HTMLElement).click());
    check('accepting one discards the others', await waitFor(async () => (await races())[0]!.lanes.map((l) => l.decision).join() === 'discarded,accepted,discarded'));
    check('the bars go', await waitFor(async () => (await page.$$('[data-testid="proposal-bar"]')).length === 0));

    // A critique: notes with suggestions, and Fix it.
    await page.keyboard.press('Escape');
    await select(card.id);
    await openPrompt('critique');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="prompt-show-notes"]', { timeout: 10000 });
    await page.click('[data-testid="prompt-show-notes"]');
    await page.waitForSelector('[data-testid="critique-head"]', { timeout: 5000 });
    check('the comments tab heads the notes as a critique', (await texts(page, '[data-testid="critique-head"]'))[0]?.includes('2 open notes') ?? false);
    check('each note carries its suggestion', (await page.$$('[data-testid="thread-suggestion"]')).length === 2);
    check('the critique changed nothing', !JSON.stringify(await callTool('layer_get', { node_id: card.id, file_id: file.id })).includes('#ff0000'));
    await page.$eval('[data-testid="thread-fix"]', (e) => (e as HTMLElement).click());
    check('Fix it hands the note to a run that resolves it', await waitFor(async () => (await page.$$('[data-testid="thread-suggestion"]')).length === 1, 10000));

    // Memory: the suggestion in the Brand panel, added only on a click.
    await page.click('[data-testid="tab-brand"]').catch(() => {});
    const found = await page.waitForSelector('[data-testid="memory-suggestion"][data-suggestion="no-gradient"]', { timeout: 6000 }).then(() => true, () => false);
    check('the Brand panel suggests a rule from decisions', found);
    if (found) {
      check('it says why', (await texts(page, '[data-testid="memory-suggestion"][data-suggestion="no-gradient"]'))[0]?.includes('You discarded 4 of 4 proposals with gradients.') ?? false);
      await page.click('[data-testid="memory-suggestion"][data-suggestion="no-gradient"] [data-testid="memory-add"]');
      const added = await waitFor(async () => JSON.stringify(await (await fetch(`${base}/api/brands/${brand.id}`)).json()).includes('"No gradients"'));
      check('Add rule adds it to the brand', added);
    }

    // Rebuild as layers from the context menu of an image.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const asset = await (await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png })).json() as { src: string };
    const image = (await callTool('html_write', { file_id: file.id, html: `<img src="${asset.src}" style="position:absolute;left:0px;top:700px;width:300px;height:200px">` })).ids[0];
    await callTool('view_focus', { node_ids: [image], file_id: file.id });
    await sleep(600);
    await select(image);
    const mid = await page.$eval('[data-testid="canvas"]', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(mid.x, mid.y, { button: 'right' });
    await page.waitForSelector('.menu-item', { timeout: 3000 });
    check('the menu of an image offers Rebuild as layers', (await texts(page, '.menu-item'))[0]?.startsWith('Rebuild as layers') ?? false);
    await page.$eval('.menu-item', (e) => (e as HTMLElement).click());
    const started = await waitFor(async () => ((await (await fetch(`${base}/api/runs?fileId=${file.id}`)).json()) as { rebuildOf?: string }[]).some((r) => r.rebuildOf === image));
    check('it starts a run with the image', started);
    await select(card.id);
    await page.mouse.click(mid.x - 300, mid.y - 300, { button: 'right' });
    await sleep(300);
    check('other layers do not offer it', !(await texts(page, '.menu-item')).some((t) => t.startsWith('Rebuild as layers')));

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
