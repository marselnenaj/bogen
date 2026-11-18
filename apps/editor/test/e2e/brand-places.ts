/**
 * Home's places, the prompt box, brands and the brand book, through the real editor and a real server in a temporary
 * BOGEN_HOME, in secure-chromium with its sandbox on. The agents are stand-ins; nothing leaves the machine.
 *
 * - Files and Brands are places in the side bar; #/brands lists every brand and takes one from a website address;
 * - a brand card and a file card open from anywhere on them: each corner and the empty middle, and Enter on the card;
 * - a brand opens on its book; the sections are grouped and each has an address; the old "health" address goes on;
 * - the prompt box makes one file of the kind, with the brand, and starts the agent there;
 * - a website that cannot be read fails cleanly: the message, and no brand left behind;
 * - at phone width the book reflows rather than shrinking; axe (WCAG 2.2 AA) finds nothing in the new parts.
 *
 *   (cd apps/editor && npx vite build)
 *   node --import tsx apps/editor/test/e2e/brand-places.ts
 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { upsertBrandItem } from '@bogen/core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { writeFakeClis } from '../../../../packages/server/test/fake-cli.ts';
import { freshPage, launch } from './craft-harness.ts';

const root = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-brand-places-'));
const shots = process.env.BOGEN_SHOTS ?? join(root, 'shots');
const bin = join(root, 'bin');
for (const d of [shots, bin]) mkdirSync(d, { recursive: true });
writeFakeClis(bin, join(root, 'cli.log'));
process.env.PATH = `${bin}:${process.env.PATH}`;

const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false });
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
const hash = (page: Page) => page.evaluate(() => location.hash);
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

// Two brands, one with colours; and a few files.
const kiln = await server.brands.create('Kiln', 'test');
{
  const room = await server.brands.room(kiln.id);
  room.doc.transact(() => {
    upsertBrandItem(room.doc, 'colors', { name: 'Clay', value: '#b5562f', role: 'primary', token: 'clay' });
    upsertBrandItem(room.doc, 'colors', { name: 'Ash', value: '#f4efe8', role: 'background', token: 'ash' });
  });
}
const shelf = await server.brands.create('Second Shelf', 'test');
for (const name of ['Studio site', 'Price list', 'Opening hours']) server.storage.create(name);

/** Clicks at a point of an element's box: fx and fy from 0 to 1. */
async function clickAt(page: Page, sel: string, fx: number, fy: number) {
  const box = await (await page.$(sel))!.boundingBox();
  if (!box) throw new Error(`${sel} has no box`);
  await page.mouse.click(box.x + Math.max(3, Math.min(box.width - 3, box.width * fx)), box.y + Math.max(3, Math.min(box.height - 3, box.height * fy)));
}
/** Goes to a route in the page, as a link would: the editor is a single page and keeps its connections open. */
async function go(page: Page, route: string) {
  await page.evaluate((r) => { location.hash = r; }, route);
  await wait(400);
}
const POINTS: [string, number, number][] = [['top left', 0, 0], ['top right', 0.82, 0], ['bottom left', 0, 1], ['bottom right', 0.82, 1], ['empty middle', 0.5, 0.62]];

try {
  const page = await freshPage(browser);
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle0' });
  await until(() => page.$('[data-testid="home-places"]').then(Boolean));

  // Places
  check('Files and Brands are places in the side bar', await page.$$eval('[data-testid="home-places"] a', (els) => els.map((e) => e.textContent?.replace(/\d+$/, '').trim()).join(',')) === 'Files,Brands');
  check('Files is the current place', await page.$eval('[data-testid="place-files"]', (e) => e.getAttribute('aria-current')) === 'page');
  check('the prompt box is at the top of Home', await page.$('[data-testid="composer"]').then(Boolean));
  check('axe finds nothing in the prompt box and the places', (await axe(page, '[data-testid="composer"]')).length === 0 && (await axe(page, '[data-testid="home-places"]')).length === 0, await axe(page, '[data-testid="composer"]'));
  await shot(page, 'home');

  // Brand cards: anywhere on the card opens the brand.
  const card = `[data-testid="brand-row"][data-brand-id="${kiln.id}"]`;
  for (const [where, fx, fy] of POINTS) {
    await go(page, `#/`);
    await until(() => page.$(card).then(Boolean));
    await clickAt(page, card, fx, fy);
    check(`a brand card opens from its ${where}`, await until(async () => (await hash(page)).startsWith(`#/brand/${kiln.id}`), 4000), await hash(page));
  }
  await go(page, `#/`);
  await until(() => page.$(card).then(Boolean));
  // From the keyboard, so that the browser shows focus as it does for a person tabbing.
  await page.keyboard.press('Shift');
  await page.focus(`${card} [data-testid="brand-open"]`);
  const ring = await page.$eval(card, (e) => getComputedStyle(e).outlineStyle);
  check('a focused brand card shows a ring around the whole card', ring === 'solid', ring);
  await page.keyboard.press('Enter');
  check('Enter on a brand card opens it', await until(async () => (await hash(page)).startsWith(`#/brand/${kiln.id}`), 4000));
  // The card's menu still opens its menu, not the brand.
  await go(page, `#/`);
  await until(() => page.$(card).then(Boolean));
  await page.click(`${card} [data-testid="brand-menu"]`);
  check('the card\'s menu button opens the menu, not the brand', await until(() => page.$('[data-testid="brand-action-rename"]').then(Boolean), 3000) && (await hash(page)) === '#/');
  await page.keyboard.press('Escape');

  // File cards
  const fileCard = '[data-testid="file"]';
  for (const [where, fx, fy] of POINTS) {
    await go(page, `#/`);
    await until(() => page.$(fileCard).then(Boolean));
    await page.$eval(fileCard, (e) => e.scrollIntoView({ block: 'center' }));
    await clickAt(page, fileCard, fx, fy);
    check(`a file card opens from its ${where}`, await until(async () => (await hash(page)).startsWith('#/file/'), 4000), await hash(page));
  }

  // The Brands place
  await go(page, `#/`);
  await page.click('[data-testid="place-brands"]');
  check('Brands is a place of its own', await until(async () => (await hash(page)) === '#/brands' && Boolean(await page.$('.brands.is-place'))));
  check('it lists every brand', (await page.$$('[data-testid="brand-row"]')).length === 2);
  check('axe finds nothing on the Brands place', (await axe(page, '.home-body')).length === 0, await axe(page, '.home-body'));
  await shot(page, 'brands');

  // A website that cannot be read: a local address is refused by the capture.
  await page.type('[data-testid="from-website-url"]', 'http://127.0.0.1:9/');
  await page.click('[data-testid="from-website-start"]');
  check('a website that cannot be read ends as failed, with the message', await until(() => page.$eval('[data-testid="from-website-job"]', (e) => e.getAttribute('data-state') === 'failed'), 30_000), await page.$eval('[data-testid="from-website-job"]', (e) => e.textContent).catch(() => ''));
  check('and leaves no brand behind', await until(async () => (await server.brands.list()).length === 2, 5000));
  check('the address stays filled in', await page.$eval('[data-testid="from-website-url"]', (e) => (e as HTMLInputElement).value) === 'http://127.0.0.1:9/');
  await shot(page, 'from-website-failed');

  // The brand page opens on its book.
  await go(page, `#/brand/${kiln.id}`);
  check('a brand opens on its book', await until(() => page.$('[data-testid="brand-book-view"] iframe').then(Boolean), 10_000));
  const groups = await page.$$eval('.bp-nav-group', (els) => els.map((e) => e.getAttribute('aria-label')));
  check('the sections are grouped: book, edit, write, use', groups.join(',') === 'Brand book,Edit,Write,Use', groups);
  await page.click('[data-testid="brand-tab-files"]');
  check('each section has an address', await until(async () => (await hash(page)) === `#/brand/${kiln.id}/files`));
  await go(page, `#/brand/${kiln.id}/health`);
  check('the old Across files address goes to Files using it', await until(async () => (await hash(page)) === `#/brand/${kiln.id}/files` && Boolean(await page.$('[data-testid="brand-section-files"]'))));
  const sheet = await (await fetch(`${base}/api/brands/${kiln.id}/sheet.html`)).text();
  check('the book shows the brand\'s colours with their values', sheet.includes('#B5562F') && sheet.includes('Contents'));
  check('axe finds nothing in the brand sections', (await axe(page, '.bp-nav')).length === 0, await axe(page, '.bp-nav'));
  await go(page, `#/brand/${shelf.id}`);
  await shot(page, 'brand-book');

  // The prompt box makes a file of the kind, with the brand, and starts the agent there.
  await go(page, `#/`);
  await until(() => page.$('[data-testid="composer-prompt"]').then(Boolean));
  await page.click('[data-testid="composer-kind-app"]');
  await page.type('[data-testid="composer-prompt"]', 'A habit tracker for iOS with a streak');
  await page.select('[data-testid="composer-brand"]', kiln.id);
  await until(() => page.$eval('[data-testid="composer-create"]', (e) => !(e as HTMLButtonElement).disabled));
  await page.click('[data-testid="composer-create"]');
  check('Create opens the new file', await until(async () => (await hash(page)).startsWith('#/file/'), 15_000), await hash(page));
  const made = server.storage.list().find((f) => f.name.startsWith('A habit tracker'));
  check('the file has the kind and the brand', made?.project?.type === 'app' && (await (await fetch(`${base}/api/files/${made.id}/brand`)).json() as { link: { id: string } | null }).link?.id === kiln.id, made);
  check('the agent was started in it with the prompt', await until(() => readFileSync(join(root, 'cli.log'), 'utf8').includes('habit tracker'), 10_000));

  // A link in the prompt offers its brand.
  await go(page, `#/`);
  await until(() => page.$('[data-testid="composer-prompt"]').then(Boolean));
  await page.type('[data-testid="composer-prompt"]', 'Like https://kiln.example but for a bakery');
  check('a link in the prompt is offered for its brand', await until(() => page.$('[data-testid="composer-link"]').then(Boolean)));
  await page.click('[data-testid="composer-link-brand"]');
  check('Its brand moves the address to Brand from a website', await until(() => page.$eval('[data-testid="from-website-url"]', (e) => (e as HTMLInputElement).value === 'https://kiln.example')));

  // Phone width: the book reflows.
  await page.setViewport({ width: 390, height: 844 });
  await go(page, `#/brand/${kiln.id}`);
  await until(() => page.$('[data-testid="brand-book-frame"]').then(Boolean), 10_000);
  const frameWidth = await page.$eval('[data-testid="brand-book-frame"]', (e) => (e as HTMLElement).getBoundingClientRect().width);
  check('on a phone the book is as wide as the screen, not scaled down', frameWidth > 300 && frameWidth <= 390, frameWidth);
  // Named for screen readers without a title, which Chromium shows as a tooltip over the whole book.
  const named = await page.$eval('[data-testid="brand-book-frame"]', (e) => ({ title: e.getAttribute('title'), label: e.getAttribute('aria-label') }));
  check('the book frame has a name but no tooltip', named.title === null && Boolean(named.label), named);
  // A change to the brand loads the new book behind the one on screen: the book never goes blank.
  const before = await page.$eval('[data-testid="brand-book-frame"]', (e) => (e as HTMLIFrameElement).src);
  let blank = false;
  const watch = (async () => { const end = Date.now() + 8000; while (Date.now() < end) { if (!(await page.$('[data-testid="brand-book-frame"]'))) blank = true; if (await page.$eval('[data-testid="brand-book-frame"]', (e) => (e as HTMLIFrameElement).src).catch(() => before) !== before) return true; await wait(20); } return false; })();
  {
    const room = await server.brands.room(kiln.id);
    room.doc.transact(() => { upsertBrandItem(room.doc, 'colors', { name: 'Crust', value: '#7a4a24', role: 'accent', token: 'crust' }); });
  }
  check('a changed brand swaps in a new book without going blank', (await watch) && !blank, { blank });
  await shot(page, 'brand-book-phone');
  await go(page, `#/brands`);
  check('the Brands place works on a phone', await until(() => page.$('.brands.is-place').then(Boolean)));
  await shot(page, 'brands-phone');
} catch (e) {
  failures.push(String((e as Error).stack ?? e));
  console.log(e);
} finally {
  await browser.close();
  await server.close();
}
console.log(`\n${passed} passed, ${failures.length} failed. Shots: ${shots}`);
process.exit(failures.length ? 1 : 0);
