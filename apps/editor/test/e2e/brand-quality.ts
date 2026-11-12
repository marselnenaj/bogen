/**
 * The brand's quality tools in a real browser against the real server: the parts of the score in a file's Brand tab,
 * reviewing suggestions by keyboard on the brand's page, and the drift of linked files with its trend.
 * Run: node --import tsx apps/editor/test/e2e/brand-quality.ts (after building the editor).
 * The browser comes from BOGEN_BROWSER, with its sandbox on; a secure-chromium wrapper is told which local port to share.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';

const home = mkdtempSync(join(tmpdir(), 'bogen-brand-quality-'));
const SHOTS = process.env.SHOTS ?? join(home, 'shots');
mkdirSync(SHOTS, { recursive: true });
process.env.BOGEN_WELCOME = '0';
const server = new BogenServer({ home, port: 29100 + Math.floor(Math.random() * 700), exportDir: join(home, 'exports') });
await server.listen();
const base = server.localUrl();
const port = Number(new URL(base).port);

let ok = 0;
let bad = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (pass) ok++; else bad++;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${!pass && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
const t = (id: string) => `[data-testid="${id}"]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) as `${string}.png` });
const count = (page: Page, id: string) => page.$$eval(t(id), (els) => els.length);

const client = new Client({ name: 'setup', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

const browserPath = process.env.BOGEN_BROWSER ?? '/usr/bin/chromium';
const browser = await puppeteer.launch({
  executablePath: browserPath, headless: true, pipe: true, userDataDir: join(home, 'profile'), defaultViewport: { width: 1500, height: 960 },
  args: ['--window-size=1500,960', ...(/secure-chromium$/.test(browserPath) ? [`--secure-local-port=${port}`] : [])],
});
try {
  // A brand with a published version, then an extraction's and an agent's suggestions.
  const brand = (await call('brand_create', { name: 'Ledger' })).id;
  await call('brand_update', { brand_id: brand, confirmed: true, fields: { shadows: 'none' }, items: [
    { section: 'colors', name: 'Ink', role: 'text', value: '#101010', token: 'ink' },
    { section: 'colors', name: 'Paper', role: 'background', value: '#f8f6f0', token: 'paper' },
    { section: 'colors', name: 'Signal', role: 'primary', value: '#e03010', token: 'signal' },
    { section: 'families', family: 'Inter', role: 'body', weights: [400, 700], token: 'font-body' },
    { section: 'typeScale', name: 'Body', size: 16, weight: 400, token: 'text-body' },
    { section: 'typeScale', name: 'Title', size: 48, weight: 700, token: 'text-title' },
    { section: 'spacing', name: 'm', value: 16, token: 'space-m' },
  ] });
  await call('brand_publish', { brand_id: brand, note: 'First' });
  const raw = (await call('brand_get', { brand_id: brand, raw: true })).raw;
  const title = raw.typeScale.find((s: { name: string }) => s.name === 'Title').id;
  await call('brand_update', { brand_id: brand, items: [
    { section: 'typeScale', id: title, size: 44 },
    { section: 'colors', name: 'Ink', role: 'text', value: '#111111', token: 'ink', source: 'capture:https://example.com' },
    { section: 'colors', name: 'Moss', role: 'accent', value: '#2f6b3a', token: 'moss', source: 'capture:https://example.com' },
  ] });

  const file = (await call('file_create', { name: 'Page' })).id;
  await call('brand_link', { brand_id: brand, file_id: file });
  const board = (await call('artboard_create', { file_id: file, name: 'Board', width: 800, background: 'var(--paper)' })).id;
  await call('html_write', { file_id: file, target_id: board, html: '<section style="display:flex;flex-direction:column;gap:13px;padding:16px;box-shadow:0 2px 6px #0003"><h1 data-name="Blue title" style="font-family:Inter;font-size:48px;color:#2a4cd0">A blue title</h1><p style="font-family:Inter;font-size:16px;color:var(--ink)">A line in ink.</p></section>' });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument('window.__name = (f) => f');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // 1. The parts of the score, in the file's Brand tab.
  await page.goto(`${base}/#/file/${file}`);
  await page.waitForSelector(t('canvas'), { timeout: 20000 });
  await page.click(t('tab-brand'));
  await page.waitForSelector(t('brand-score-parts'), { timeout: 20000 });
  const levers = await page.$$eval(t('brand-lever'), (els) => els.map((e) => ({ key: e.getAttribute('data-key'), text: e.textContent })));
  check('the Brand tab lists what would raise the score, with points', levers.length > 1 && levers.every((l) => /^\+\d+/.test(l.text ?? '')), levers);
  check('the sum says how the score is made', /conformance \d+ and 40% of quality \d+/.test(await page.$eval(t('brand-score-sum'), (e) => e.textContent ?? '')));
  await page.click(`${t('brand-lever')}[data-key="color.off-palette"]`);
  await sleep(200);
  const { doc } = await server.rooms.get(file);
  const blue = doc.descendants(board).find((n) => n.name === 'Blue title')!.id;
  // The Brand tab replaces the layer tree: open Layers before checking its selected row.
  await page.click(t('tab-layers'));
  check('a lever selects its layers', await page.waitForSelector(`#layer-${blue}[aria-selected="true"]`, { timeout: 5000 }).then(() => true, () => false));
  await page.click(t('tab-brand'));
  await page.waitForSelector(t('brand-score-parts-toggle'));
  await page.click(t('brand-score-parts-toggle'));
  check('the parts list conformance per category and quality', (await count(page, 'brand-score-category')) >= 3 && (await count(page, 'brand-score-quality-part')) >= 0);
  await shot(page, '1-score-parts');

  // 2. Reviewing suggestions, by keyboard.
  await page.goto(`${base}/#/brand/${brand}`);
  await page.waitForSelector(t('brand-review-open'), { timeout: 20000 });
  await page.click(t('brand-review-open'));
  await page.waitForSelector(t('brand-review'));
  const statuses = await page.$$eval(t('brand-review-row'), (els) => els.map((e) => e.getAttribute('data-status')).sort());
  check('each suggestion shows as new, an edit or a second take', JSON.stringify(statuses) === JSON.stringify(['edit', 'new', 'replaces']), statuses);
  const diff = await page.$$eval('.br-diff tr', (rows) => rows.map((r) => r.textContent));
  check('an edit shows the old value next to the suggested one', diff.some((d) => d?.includes('48') && d.includes('44')), diff);
  check('the source is shown', (await page.$$eval('.br-source', (els) => els.map((e) => e.textContent))).some((s) => s?.includes('Captured from https://example.com')));
  await shot(page, '2-review');
  await page.focus(t('brand-review-list'));
  await page.keyboard.down('Control');
  await page.keyboard.press('c');
  await page.keyboard.up('Control');
  check('Ctrl+C leaves the suggestions alone', (await count(page, 'brand-review-row')) === 3);
  await page.keyboard.press('j');
  await page.keyboard.press('c');
  await sleep(150);
  check('c confirms the current suggestion', (await count(page, 'brand-review-row')) === 2);
  await page.keyboard.press('d');
  await sleep(150);
  check('d dismisses the current suggestion', (await count(page, 'brand-review-row')) === 1);
  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  await sleep(150);
  check('Ctrl+Z brings the dismissed one back', (await count(page, 'brand-review-row')) === 2);
  await page.focus(t('brand-review-list'));
  await page.keyboard.down('Shift');
  await page.keyboard.press('C');
  await page.keyboard.up('Shift');
  await sleep(200);
  check('Shift+C confirms the rest', Boolean(await page.$(t('brand-review-empty'))));
  const after = (await call('brand_get', { brand_id: brand, raw: true })).raw;
  check('a second take was written into the confirmed value, with no duplicate', after.colors.filter((c: { name: string }) => c.name === 'Ink').length === 1, after.colors.map((c: { name: string; value: string }) => `${c.name} ${c.value}`));

  // 3. Across linked files, with the trend.
  await page.click(t('brand-tab-health'));
  await page.waitForSelector(t('brand-health'));
  await page.click(t('brand-health-run'));
  await page.waitForSelector(t('brand-health-layer'), { timeout: 30000 });
  check('the drift lists the file with its worst layers', (await count(page, 'brand-health-file')) === 1 && (await count(page, 'brand-health-layer')) >= 1);
  await page.click(t('brand-health-run'));
  await page.waitForFunction(() => document.querySelector('[data-testid="brand-health-trend"]'), { timeout: 30000 });
  check('two checks draw a trend line', Boolean(await page.$(t('brand-health-trend'))));
  await shot(page, '3-health');
  const href = await page.$eval(t('brand-health-layer'), (e) => e.getAttribute('href'));
  await page.click(t('brand-health-layer'));
  await page.waitForSelector(t('canvas'), { timeout: 20000 });
  await sleep(800);
  const selectedId = /select=([\w]+)/.exec(href ?? '')?.[1];
  await page.click(t('tab-layers'));
  check('a worst layer opens the file with it selected', await page.waitForSelector(`#layer-${selectedId}[aria-selected="true"]`, { timeout: 5000 }).then(() => true, () => false), href);
  await page.click(t('tab-brand'));
  await page.waitForSelector(t('brand-check'));
  await page.click(t('brand-check'));
  await page.waitForSelector(t('brand-file-trend'), { timeout: 20000 });
  check('the file\'s Brand tab shows its own trend', true);
  await shot(page, '4-file-trend');
  check('no page errors', errors.length === 0, errors);
} catch (e) {
  bad++;
  console.log(`FAIL  ${(e as Error).stack}`);
} finally {
  await browser.close();
  await client.close();
  await server.close();
  console.log(`\n${ok} passed, ${bad} failed. Pictures in ${SHOTS}`);
  if (!process.env.SHOTS) rmSync(home, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
}
