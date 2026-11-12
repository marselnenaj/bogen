/**
 * Shared libraries in a real browser against a real server from source: the library section in
 * Assets, the update banner after the library publishes, accepting with overrides kept, undo, and a
 * copy of a library instance pasted into another file that stays linked.
 *
 * Run: npx tsx apps/editor/test/e2e/library.ts
 * With a built editor from elsewhere: BOGEN_EDITOR_DIR=/path/to/dist. Screenshots: E2E_SHOTS=/path.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createComponent, createInstance, linkLibrary, publishLibrary, readPublished, setOverride, libraryLayerId } from '@bogen/core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';

const SHOTS = process.env.E2E_SHOTS ?? resolve(import.meta.dirname, '../../screenshots/library');
mkdirSync(SHOTS, { recursive: true });

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failures.push(`${name}: ${JSON.stringify(detail)}`);
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errors: string[] = [];

async function until(what: string, fn: () => Promise<boolean> | boolean, timeout = 8000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  console.log(`  timed out waiting for: ${what}`);
  return false;
}

async function open(browser: Browser, base: string, fileId: string): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument('window.__name = (f) => f');
  page.on('pageerror', (e) => errors.push(`pageerror: ${(e as Error).message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/fonts\.g|net::ERR|Failed to load resource|WebSocket connection/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${base}/#/file/${fileId}`);
  await page.waitForSelector('[data-testid="canvas"]', { timeout: 20000 });
  await sleep(300);
  return page;
}

const textOf = (page: Page, id: string) => page.$eval(`[data-bogen-id="${id}"]`, (el) => el.textContent).catch(() => null);
const has = (page: Page, selector: string) => page.$(selector).then((e) => e !== null);

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'bogen-lib-e2e-'));
  const server = new BogenServer({ home, port: 0, exportDir: join(home, 'exports') });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'bogen-lib-profile-')), args: ['--no-sandbox', '--window-size=1500,960', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 960 } });
  const post = (path: string, body: unknown) => fetch(`${server.localUrl()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const newFile = async (name: string) => ((await (await post('/api/files', { name })).json()) as { id: string }).id;
  try {
    // The library: a Button with a label, published.
    const libId = await newFile('Kit');
    const lib = await server.rooms.get(libId);
    const libPage = lib.doc.getPages()[0]!.id;
    const main = lib.doc.insert(libPage, { type: 'frame', tag: 'button', name: 'Button', style: { position: 'absolute', left: '0px', top: '0px', padding: '8px 16px', backgroundColor: 'rgb(18, 52, 86)', color: 'rgb(255, 255, 255)', display: 'inline-flex' }, children: [{ type: 'text', tag: 'span', name: 'Label', text: 'Buy' }] });
    const label = lib.doc.rawKids(main)[0]!;
    createComponent(lib.doc, main);
    publishLibrary(lib.doc, { name: 'Kit' });

    // A file that uses it, with an override on the label.
    const fileId = await newFile('App');
    const app = await server.rooms.get(fileId);
    const appPage = app.doc.getPages()[0]!.id;
    const ids = linkLibrary(app.doc, { id: libId, name: 'Kit' }, readPublished(lib.doc));
    const inst = createInstance(app.doc, ids[main]!, appPage, { style: { position: 'absolute', left: '100px', top: '100px' } });
    const labelView = `${inst}/${libraryLayerId(libId, label)}`;
    setOverride(app.doc, labelView, 'text', 'Order now');

    const page = await open(browser, server.localUrl(), fileId);
    check('the instance renders from the copy', (await textOf(page, labelView)) === 'Order now', await textOf(page, labelView));
    await (await page.waitForSelector('[data-testid="tab-assets"]'))!.click();
    await sleep(200);
    check('assets list the library as its own group', await has(page, `[data-testid="asset-group"][data-library="${libId}"]`));
    check('the library is listed as linked', await until('linked row', () => has(page, `[data-testid="library-linked"][data-library="${libId}"]`)));
    check('no banner before the library publishes', !(await has(page, '[data-testid="library-banner"]')));

    // The library changes and publishes: the banner says so, and nothing changes yet.
    lib.doc.updateStyle(main, { backgroundColor: 'rgb(200, 0, 0)', borderRadius: '999px' });
    publishLibrary(lib.doc);
    check('a banner says the library has an update', await until('banner', () => has(page, '[data-testid="library-banner"]')));
    const bannerText = await page.$eval('[data-testid="library-banner"]', (e) => e.textContent ?? '').catch(() => '');
    check('it names the library and the component', /Kit/.test(bannerText) && /Button/.test(bannerText), bannerText);
    const bg = () => page.$eval(`[data-bogen-id="${inst}"]`, (e) => getComputedStyle(e).backgroundColor).catch(() => '');
    check('nothing changes before accepting', (await bg()) === 'rgb(18, 52, 86)', await bg());
    await page.screenshot({ path: resolve(SHOTS, 'banner.png') as `${string}.png` });

    await (await page.waitForSelector('[data-testid="library-accept"]'))!.click();
    check('accepting updates the instance', await until('new background', async () => (await bg()) === 'rgb(200, 0, 0)'), await bg());
    check('the override stays', (await textOf(page, labelView)) === 'Order now', await textOf(page, labelView));
    check('the banner goes away', await until('banner gone', async () => !(await has(page, '[data-testid="library-banner"]'))));
    await page.screenshot({ path: resolve(SHOTS, 'accepted.png') as `${string}.png` });
    await (await page.$('[data-testid="canvas"]'))!.click({ offset: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    check('Ctrl+Z takes the update back', await until('old background', async () => (await bg()) === 'rgb(18, 52, 86)'), await bg());
    check('and the banner offers it again', await until('banner again', () => has(page, '[data-testid="library-banner"]')));

    // Copy the instance and paste it into a file that never linked the library: it stays linked.
    // Select through the layer list, which is what a person would click.
    await (await page.waitForSelector('[data-testid="tab-layers"]'))!.click();
    await (await page.waitForSelector(`[data-testid="layer-row"][data-layer="${inst}"]`))!.click();
    await sleep(80);
    const clip = await page.evaluate(() => {
      const dt = new DataTransfer();
      document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
      return dt.getData('text/html');
    });
    check('the copy carries the library', clip.includes('bogen-clip:'), clip.slice(0, 80));
    const otherId = await newFile('Other');
    const other = await open(browser, server.localUrl(), otherId);
    await other.evaluate((html) => {
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, clip);
    const otherRoom = await server.rooms.get(otherId);
    const linked = await until('pasted instance on the server', () => {
      const page0 = otherRoom.doc.getPages()[0]!.id;
      return otherRoom.doc.getChildren(page0).some((n) => n.instanceOf === ids[main]);
    });
    check('the pasted copy is still an instance of the library component', linked);
    check('and that file now shows the update banner too', await until('banner in other file', () => has(other, '[data-testid="library-banner"]')));
    await other.screenshot({ path: resolve(SHOTS, 'pasted.png') as `${string}.png` });
    check('no errors in the page', errors.length === 0, errors);
  } finally {
    await browser.close();
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

void main();
