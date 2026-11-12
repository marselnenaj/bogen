/**
 * Drift and "like this site, in a brand" in a real browser against the real server, with a fixture site served here.
 * Run: npx tsx apps/editor/test/e2e/drift.ts
 * Uses a temp home and a spare port. BOGEN_EDITOR_DIR points at a built editor, else apps/editor/dist is used.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sleep, watchErrors } from './harness.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const home = mkdtempSync(join(tmpdir(), 'bogen-drift-e2e-'));
const SHOTS = process.env.SHOTS ?? join(home, 'shots');
mkdirSync(SHOTS, { recursive: true });
const PORT = 29100 + Math.floor(Math.random() * 700);
const base = `http://127.0.0.1:${PORT}`;
const server = spawn('npx', ['tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(PORT)], { cwd: ROOT, env: { ...process.env, BOGEN_HOME: home, BOGEN_WELCOME: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d: Buffer) => { const t = String(d); if (!/ExperimentalWarning|trace-warnings/.test(t)) process.stdout.write(`[server] ${t}`); });

// The fixture site: what the design was captured from, then what a developer changed.
const STYLE = `body { margin: 0; background: #f4efe6; color: #1f1a14; font-family: Arial, sans-serif }
header { display: flex; justify-content: space-between; padding: 18px 28px; font-size: 14px }
.hero { display: flex; flex-direction: column; gap: 12px; padding: 56px 28px 32px }
h1 { font-size: 56px; margin: 0; font-weight: 400; font-family: Georgia, serif }
.lead { font-size: 18px; margin: 0 }
.book { align-self: flex-start; font: 600 15px Arial, sans-serif; padding: 10px 18px; background: #c8472b; color: #fff; border: 0 }
.note { margin: 20px 28px; font-size: 14px }`;
const ORIGINAL = `<!doctype html><html><head><style>${STYLE}</style></head><body><header><strong>Couchette</strong><a href="/routes">Routes</a></header><section class="hero"><h1>Sleep your way across Europe</h1><p class="lead">Night trains to 40 cities.</p><button class="book">Book a berth</button></section><p class="note">Fares from 49 euros</p></body></html>`;
const CHANGED = `<!doctype html><html><head><style>${STYLE} h1 { font-size: 48px } .book { background: #e0562f }</style></head><body><header><strong>Couchette</strong><a href="/routes">Routes</a></header><section class="hero"><h1>Sleep your way across Europe</h1><p class="lead">Night trains to 52 cities.</p><button class="book">Book a berth</button></section><div class="note">One cookie, for your basket.</div></body></html>`;
let served = ORIGINAL;
const site = createServer((_req, res) => void res.writeHead(200, { 'Content-Type': 'text/html' }).end(served));

let ok = 0;
let bad = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (pass) ok++; else bad++;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${!pass && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
const t = (id: string) => `[data-testid="${id}"]`;
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) as `${string}.png` });

async function clickOn(page: Page, id: string): Promise<void> {
  const el = await page.waitForSelector(t(id), { timeout: 8000 });
  await el!.click();
  await sleep(60);
}

async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${base}${path}`, { method: init?.method ?? 'GET', headers: { 'Content-Type': 'application/json' }, ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function until(fn: () => Promise<boolean>, ms = 15000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(80);
  }
  return false;
}

async function main(): Promise<void> {
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/status`)).ok) break; } catch { /* not up yet */ }
    await sleep(250);
  }
  const captured = await api<{ fileId: string; nodeId: string }>('/api/capture', { method: 'POST', body: { url: siteUrl, width: 1000, colorScheme: 'light', name: 'Couchette' } });
  const { fileId } = captured;
  served = CHANGED;

  // A brand to restyle into, entered the way an agent would.
  const agent = new Client({ name: 'drift-e2e', version: '1' });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const tool = async (name: string, args: Record<string, unknown>) => JSON.parse(((await agent.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text);
  const brand = await tool('brand_create', { name: 'Kiln' });
  await tool('brand_update', { brand_id: brand.id, confirmed: true, items: [
    { section: 'colors', name: 'Ink', role: 'text', value: '#141414', token: 'ink' },
    { section: 'colors', name: 'Paper', role: 'background', value: '#faf7f0', token: 'paper' },
    { section: 'colors', name: 'Glaze', role: 'primary', value: '#2b3df2', token: 'glaze' },
    { section: 'families', family: 'Archivo', role: 'display', fallback: 'Arial, sans-serif', weights: [400, 700], token: 'font-display' },
    { section: 'spacing', name: 'S', value: 8, token: 'space-8' },
    { section: 'spacing', name: 'M', value: 16, token: 'space-16' },
  ] });
  await agent.close();

  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, userDataDir: join(home, 'profile'), args: ['--no-sandbox', '--window-size=1500,960', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], defaultViewport: { width: 1500, height: 960 } });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument('window.__name = (f) => f');
    const errors: string[] = [];
    watchErrors(page, errors);
    await page.goto(`${base}/#/file/${fileId}`);
    await page.waitForSelector(t('canvas'), { timeout: 15000 });
    await sleep(300);

    await clickOn(page, 'tab-drift');
    await page.waitForSelector(t('drift-panel'), { timeout: 8000 });
    check('the address defaults to where the artboard was captured from', await until(async () => (await page.$eval(t('drift-url'), (el) => (el as HTMLInputElement).value)) === siteUrl));
    check('and says at which width and scheme', /1000 wide, light/.test(await page.$eval(t('drift-meta'), (el) => el.textContent ?? '')));
    await clickOn(page, 'drift-run');
    check('the comparison comes back', await until(async () => (await page.$$(t('drift-item'))).length > 0, 60000));
    const kinds = await page.$$eval(t('drift-item'), (els) => els.map((el) => (el as HTMLElement).dataset.kind));
    for (const kind of ['font', 'color', 'text', 'missing', 'extra']) check(`a ${kind} drift is listed`, kinds.includes(kind), kinds);
    const text = await page.$eval(t('drift-panel'), (el) => el.textContent ?? '');
    check('with the values of both sides', text.includes('56px') && text.includes('48px') && text.includes('#c8472b') && text.includes('#e0562f'), text.slice(0, 400));
    check('the overlay is on the canvas', (await page.$$(t('drift-overlay'))).length === 1);
    await shot(page, 'drift-panel');

    // A click on a drift selects its layer.
    const fontRow = (await page.$$(`${t('drift-item')}[data-kind="font"]`))[0]!;
    await fontRow.click();
    await sleep(150);
    check('a click selects the layer', await until(async () => (await page.$eval(`${t('drift-item')}[data-kind="font"]`, (el) => el.classList.contains('is-active')))));
    const selected = await page.$$eval(`${t('layer-row')}[aria-selected="true"]`, (els) => els.map((el) => (el as HTMLElement).dataset.layer));
    const fontLayer = await page.$eval(`${t('drift-item')}[data-kind="font"]`, (el) => (el as HTMLElement).dataset.layer);
    check('the layer list follows', selected.length === 1 && selected[0] === fontLayer, { selected, fontLayer });

    await clickOn(page, 'drift-overlay-toggle');
    check('the toggle hides the overlay', await until(async () => (await page.$$(t('drift-overlay'))).length === 0));
    await clickOn(page, 'drift-overlay-toggle');
    check('and shows it again', await until(async () => (await page.$$(t('drift-overlay'))).length === 1));

    // Like this site, in a brand: from the command palette.
    await page.mouse.click(700, 500);
    await page.keyboard.down('Control');
    await page.keyboard.press('p');
    await page.keyboard.up('Control');
    await page.waitForSelector(t('palette-input'), { timeout: 5000 });
    await page.keyboard.type('like this site');
    await sleep(150);
    await page.keyboard.press('Enter');
    await page.waitForSelector(t('restyle-dialog'), { timeout: 5000 });
    check('the command opens the dialog', true);
    check('it says what it is for before anything runs', /structure and inspiration/.test(await page.$eval(t('restyle-dialog'), (el) => el.textContent ?? '')));
    await (await page.$(t('restyle-url')))!.type(siteUrl);
    await clickOn(page, 'restyle-run');
    check('the restyle comes back with its brand check', await until(async () => (await page.$$(t('restyle-result'))).length === 1, 60000));
    check('and the notice about rights', /right to use/.test(await page.$eval(t('restyle-notice'), (el) => el.textContent ?? '')));
    await shot(page, 'restyle-result');
    await clickOn(page, 'restyle-show');
    check('the dialog closes on Show artboard', await until(async () => (await page.$$(t('restyle-dialog'))).length === 0));
    const files = await api<{ id: string }[]>('/api/files');
    check('a file that followed no brand takes this one, so no new file', files.length === 1, files.length);
    const link = await api<{ link?: { id: string } }>(`/api/files/${fileId}/brand`);
    check('and is linked to it', link.link?.id === brand.id, link);
    await shot(page, 'restyle-artboard');

    check('no errors in the browser', errors.length === 0, errors.slice(0, 6));
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (e) {
  bad++;
  console.error(e);
} finally {
  server.kill();
  site.close();
  console.log(`\n${ok} passed, ${bad} failed. Screenshots: ${SHOTS}`);
  setTimeout(() => process.exit(bad ? 1 : 0), 500);
}
