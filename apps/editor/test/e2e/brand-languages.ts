/**
 * Brand languages, proposed settings and duplicates on the brand's page, in a real browser against the real server:
 * a proposed Strict and a proposed setting show the value that binds with the proposal beside it, to confirm or
 * dismiss; the Voice tab adds a language and gives a word its language; a chapter written in German is marked as
 * German; a duplicate says where it came from.
 * Run: node --import tsx apps/editor/test/e2e/brand-languages.ts (after building the editor).
 * The browser comes from BOGEN_BROWSER, with its sandbox on; a secure-chromium wrapper is told which local port to share.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';

const home = mkdtempSync(join(tmpdir(), 'bogen-brand-languages-'));
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
async function until(fn: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(80);
  }
  return false;
}

const client = new Client({ name: 'setup', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};
const brandNow = async (id: string) => (await fetch(`${base}/api/brands/${id}`)).json();

const browserPath = process.env.BOGEN_BROWSER ?? '/usr/bin/chromium';
const browser = await puppeteer.launch({
  executablePath: browserPath, headless: true, pipe: true, userDataDir: join(home, 'profile'), defaultViewport: { width: 1500, height: 960 },
  args: ['--window-size=1500,960', ...(/secure-chromium$/.test(browserPath) ? [`--secure-local-port=${port}`] : [])],
});
try {
  // A published brand in English, then an agent's proposals: strict mode and flat colour only.
  const brand = (await call('brand_create', { name: 'Ledger' })).id;
  await call('brand_update', { brand_id: brand, confirmed: true, fields: { language: 'en' }, items: [{ section: 'words', word: 'cheap', use: 'avoid' }] });
  await call('brand_publish', { brand_id: brand, note: 'First' });
  await call('brand_update', { brand_id: brand, fields: { strict: true, gradients: 'none' } });
  await call('brand_book_update', { brand_id: brand, chapter: 'strategy', markdown: 'Wir bauen Werkzeuge für Kanzleien.', source: 'Owner brief', questions: '', status: 'draft', expected_revision: null, lang: 'de' });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument('window.__name = (f) => f');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/#/brand/${brand}`);
  await page.waitForSelector(t('brand-page'), { timeout: 15000 });

  // 1. Strict is only proposed: the box shows what binds, the proposal sits beside it.
  check('the Strict box is clear while strict mode is only proposed', !(await page.$eval(t('brand-strict'), (el) => (el as HTMLInputElement).checked)));
  check('the proposal shows beside it', (await count(page, 'brand-proposed-strict')) === 1);
  await shot(page, 'proposed-strict');
  await page.click(`${t('brand-proposed-strict')} ${t('brand-proposed-confirm')}`);
  check('confirming it sets the box and binds', await until(async () => (await page.$eval(t('brand-strict'), (el) => (el as HTMLInputElement).checked)) && (await brandNow(brand)).data.suggestedFields.length === 1));

  // 2. A proposed setting elsewhere, dismissed: the field keeps the value of the version.
  await page.click(t('brand-tab-layout'));
  await page.waitForSelector(t('brand-proposed-gradients'));
  check('the gradients field shows what binds', (await page.$eval(t('brand-gradients'), (el) => (el as HTMLSelectElement).value)) === 'any');
  await page.click(`${t('brand-proposed-gradients')} ${t('brand-proposed-dismiss')}`);
  check('dismissing puts the version\'s value back and drops the proposal', await until(async () => (await count(page, 'brand-proposed-gradients')) === 0 && (await brandNow(brand)).data.suggestedFields.length === 0));

  // 3. Languages: German as another language, and a word of its own.
  await page.click(t('brand-tab-voice'));
  await page.waitForSelector(t('brand-languages'));
  check('the primary shows the brand\'s language', (await page.$eval(t('brand-voice-language'), (el) => (el as HTMLSelectElement).value)) === 'en');
  await page.select(t('brand-language-add'), 'de');
  check('a language added from the list', await until(async () => JSON.stringify((await brandNow(brand)).data.fields.languages) === '["de"]'));
  check('and shown as one the brand speaks', await until(async () => (await count(page, 'brand-language')) === 1));
  await page.type(t('brand-language-custom'), 'pt_br');
  await page.keyboard.press('Enter');
  check('a typed tag is added as its canonical form', await until(async () => JSON.stringify((await brandNow(brand)).data.fields.languages) === '["de","pt-BR"]'));
  await page.waitForSelector(t('brand-item-language'));
  await page.select(t('brand-item-language'), 'de');
  check('a word gets its language', await until(async () => (await brandNow(brand)).data.words[0]?.lang === 'de'));
  await shot(page, 'voice-languages');

  // 4. A chapter written in German is marked German, inside an interface in English.
  await page.click(t('brand-tab-book'));
  await page.waitForSelector(t('brand-book-copy'));
  check('the chapter text says its own language', (await page.$eval(t('brand-book-copy'), (el) => el.getAttribute('lang'))) === 'de');
  check('the chapter title stays marked English', (await page.$eval('.brand-book-title h3', (el) => el.getAttribute('lang'))) === 'en');

  // 5. A duplicate is a new brand that says where it came from.
  const copy = await call('brand_duplicate', { brand_id: brand });
  await page.goto(`${base}/#/brand/${copy.id}`);
  await page.waitForSelector(t('brand-duplicated-from'), { timeout: 15000 });
  check('the copy says which brand and version it came from', (await page.$eval(t('brand-duplicated-from'), (el) => el.textContent ?? '')) === 'Duplicated from Ledger, version 1');
  check('and is not published yet', (await page.$eval('.bp-head .bp-note', (el) => el.textContent ?? '')) === 'Not published yet');
  await shot(page, 'duplicate');

  check('no errors in the browser', errors.length === 0, errors.slice(0, 6));
} catch (e) {
  bad++;
  console.error(e);
} finally {
  await browser.close();
  await client.close();
  await server.close();
  rmSync(home, { recursive: true, force: true });
  console.log(`\n${ok} passed, ${bad} failed.`);
  process.exit(bad ? 1 : 0);
}
