/**
 * A designed edition of a brand book, through the real editor and a real server in a temporary BOGEN_HOME, in
 * secure-chromium with its sandbox on. The agent is a stand-in; nothing leaves the machine.
 *
 * - the brand's book offers "Make a designed edition", which says which agent runs it on the person's plan;
 * - Start makes "<Brand> · Brand book" with the generated book as a reference page, starts the run there with the
 *   chat's agent, and opens the file: its chat shows the run, and a pill in the activity dock follows it to the end;
 * - back on the brand, the book links to the edition, says which part of the brand changed since, and offers to
 *   refresh those pages; axe (WCAG 2.2 AA) finds nothing in the new bar.
 *
 *   (cd apps/editor && npx vite build)
 *   node --import tsx apps/editor/test/e2e/brand-edition.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { readBrandEdition, setBrandField, upsertBrandItem } from '@bogen/core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { writeFakeClis } from '../../../../packages/server/test/fake-cli.ts';
import { freshPage, launch } from './craft-harness.ts';

const root = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-brand-edition-'));
const shots = process.env.BOGEN_SHOTS ?? join(root, 'shots');
const bin = join(root, 'bin');
for (const d of [shots, bin]) mkdirSync(d, { recursive: true });
const cliLog = join(root, 'cli.log');
writeFakeClis(bin, cliLog);
// The stand-in takes two seconds before it works, as a real agent would, so that the run can be seen going.
renameSync(join(bin, 'claude'), join(bin, 'claude-fake'));
writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncase "$1" in --version|--help|debug) ;; *) sleep 2 ;; esac\nexec "$(dirname "$0")/claude-fake" "$@"\n`);
chmodSync(join(bin, 'claude'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false });
// The stand-in changes no layer, so the design completion check is not what this test is about.
server.runs.beforeFinish = async () => ({ ok: true, message: 'Fixture run.' });
await server.listen();
const base = server.localUrl();
const browser = await launch(Number(new URL(base).port));

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`pass  ${name}`); } else { failures.push(name); console.log(`FAIL  ${name}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* between states */ }
    await wait(60);
  }
  return false;
}
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
async function axe(page: Page, sel: string): Promise<string[]> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(axeSource);
  return page.evaluate(async (s) => {
    const r = await (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe.run(
      { include: [[s]] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((v) => `${v.id} x${v.nodes.length}`);
  }, sel);
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) });
const text = (page: Page, sel: string) => page.$eval(sel, (e) => e.textContent ?? '');
const pill = (page: Page) => page.$eval('[data-testid="activity-pill"][data-kind="brand"]', (e) => ({ state: e.getAttribute('data-state'), text: e.textContent ?? '' }));

// A brand with colours.
const kiln = await server.brands.create('Kiln', 'test');
{
  const room = await server.brands.room(kiln.id);
  room.doc.transact(() => {
    upsertBrandItem(room.doc, 'colors', { id: 'clay', name: 'Clay', value: '#b5562f', role: 'primary', token: 'clay' });
    upsertBrandItem(room.doc, 'colors', { id: 'ash', name: 'Ash', value: '#f4efe8', role: 'background', token: 'ash' });
    setBrandField(room.doc, 'positioning', 'A pottery studio.');
  });
}

try {
  const page = await freshPage(browser);
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${base}/#/brand/${kiln.id}`, { waitUntil: 'networkidle0' });
  check('the brand book offers a designed edition', await until(() => page.$('[data-testid="brand-edition-make"]').then(Boolean)));
  check('it says what an edition is', (await text(page, '[data-testid="brand-edition"]')).includes('One template serves every brand'));
  check('axe finds nothing in the edition bar', (await axe(page, '[data-testid="brand-edition"]')).length === 0, await axe(page, '[data-testid="brand-edition"]'));
  await shot(page, 'edition-offer');

  await page.click('[data-testid="brand-edition-make"]');
  check('Make asks first, naming the agent, the plan and the one review', await until(async () => /Claude.*on your plan.*judge it once/.test(await text(page, '[data-testid="brand-edition-confirm"]'))), await text(page, '[data-testid="brand-edition"]').catch(() => ''));
  await shot(page, 'edition-confirm');
  await page.click('[data-testid="brand-edition-start"]');

  check('Start opens the new file', await until(async () => /#\/file\//.test(page.url()), 15_000), page.url());
  const fileId = /#\/file\/(\w+)/.exec(page.url())?.[1] ?? '';
  const entry = server.storage.get(fileId);
  check('the file is named for the brand book', entry?.name === 'Kiln · Brand book', entry?.name);
  const room = await server.rooms.get(fileId);
  check('it holds an empty book page and the generated book as a reference', room.doc.getPages().map((p) => p.name).join('|') === 'Brand book|Generated book (reference)');
  check('the run started there with the brand-guidelines skill', await until(() => readFileSync(cliLog, 'utf8').includes('Design guidance already supplied for brand-guidelines'), 10_000));
  check('the edition is recorded on the file', readBrandEdition(room.doc)?.brandId === kiln.id);
  check('the chat shows the run', await until(async () => (await page.evaluate(() => document.body.textContent ?? '')).includes('Design the Kiln brand book'), 10_000));
  check('the dock shows it running', await until(async () => (await pill(page)).state === 'running', 5000), await pill(page).catch(() => null));
  await shot(page, 'edition-running');
  check('the pill says it is done when the run ends', await until(async () => (await pill(page)).state === 'done', 20_000), await pill(page).catch(() => null));
  check('the chat shows the agent\'s answer', await until(async () => (await page.evaluate(() => document.body.textContent ?? '')).includes('Done.'), 5000));
  await shot(page, 'edition-done');

  await page.evaluate((r) => { location.hash = r; }, `#/brand/${kiln.id}`);
  check('back on the brand, the book links to the edition', await until(async () => (await text(page, '[data-testid="brand-edition-open"]')) === 'Kiln · Brand book'));
  check('nothing changed since, so nothing to refresh', !(await page.$('[data-testid="brand-edition-stale"]')));
  {
    const brand = await server.brands.room(kiln.id);
    brand.doc.transact(() => { upsertBrandItem(brand.doc, 'colors', { id: 'clay', name: 'Clay', value: '#a14b28', role: 'primary', token: 'clay' }); });
  }
  check('a changed colour is named, with the pages to refresh', await until(async () => (await text(page, '[data-testid="brand-edition-stale"]')).includes('Colour')), await text(page, '[data-testid="brand-edition"]').catch(() => ''));
  check('Refresh those pages is offered', await page.$('[data-testid="brand-edition-refresh"]').then(Boolean));
  check('axe finds nothing in the edition bar with an edition', (await axe(page, '[data-testid="brand-edition"]')).length === 0, await axe(page, '[data-testid="brand-edition"]'));
  await shot(page, 'edition-stale');
} catch (e) {
  failures.push(String((e as Error).stack ?? e));
  console.log(e);
} finally {
  await browser.close();
  await server.close();
}
console.log(`\n${passed} passed, ${failures.length} failed. Shots: ${shots}`);
process.exit(failures.length ? 1 : 0);
