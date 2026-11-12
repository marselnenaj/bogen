/**
 * Interface languages end to end, in the built editor and a sandboxed Chromium (~/.local/bin/secure-chromium, its
 * sandbox on, over a pipe, reaching only the one loopback port it is given):
 *
 * - Automatic follows the Omarchy language file of this machine (a temp file named by OMARCHY_LANGUAGE_FILE, never
 *   the person's), and only that language's catalog chunk is fetched;
 * - a choice in Settings switches at once, is kept over a reload, and wins over Omarchy until Automatic is chosen
 *   again, which then follows a changed Omarchy language;
 * - right-to-left (Arabic): the page is `dir=rtl`, the panels read from the right, the canvas, the design on it and
 *   its layout stay left-to-right, and a layer keeps its place on screen;
 * - the design file is not changed by any of it;
 * - a narrow desktop window, and the phone layout with a phone's own languages (the computer's answer is what a
 *   phone gets: nothing), each with its picker.
 *
 * Nothing of the person's is read or written: the Bogen data folder is a temp folder given to the server, and the
 * Omarchy language comes from a temp file named by OMARCHY_LANGUAGE_FILE, which the server reads before anything
 * under the home folder. HOME and XDG_CONFIG_HOME are left as they are, so the browser wrapper keeps its own setup.
 *
 * Needs the built editor (npm run build). Run:
 *   BOGEN_BROWSER=$HOME/.local/bin/secure-chromium npx tsx apps/editor/test/e2e/languages.ts
 * Screenshots go to $BOGEN_SHOTS, or a new temp folder.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const CHROMIUM = resolve(process.env.HOME ?? '', '.local/bin/secure-chromium');
if (process.env.BOGEN_NO_SANDBOX === '1') throw new Error('This test runs only with the browser sandbox on. Unset BOGEN_NO_SANDBOX.');
if (process.env.BOGEN_BROWSER && process.env.BOGEN_BROWSER !== CHROMIUM) throw new Error(`BOGEN_BROWSER is ${process.env.BOGEN_BROWSER}; this test runs only with ${CHROMIUM}.`);
if (!existsSync(CHROMIUM)) throw new Error(`There is no ${CHROMIUM}.`);
process.env.BOGEN_BROWSER = CHROMIUM;

const SHOTS = process.env.BOGEN_SHOTS ?? mkdtempSync(join(tmpdir(), 'bogen-languages-shots-'));
mkdirSync(SHOTS, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'bogen-languages-e2e-'));
const languageFile = join(work, 'omarchy-language');
writeFileSync(languageFile, 'de\n');
process.env.OMARCHY_LANGUAGE_FILE = languageFile;

let passed = 0;
const failed: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failed.push(name);
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

const { BogenServer } = await import('../../../../packages/server/src/http/server.ts');
const server = new BogenServer({ home: join(work, 'bogen'), port: 0 });
await server.listen();
const base = server.localUrl();
const created = await (await fetch(`${base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sprachen' }) })).json() as { id: string };
const room = await server.rooms.get(created.id);
const page0 = room.doc.getPages()[0]!.id;
const board = room.doc.insert(page0, { type: 'frame', name: 'Row', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '480px', height: '160px', display: 'flex', flexDirection: 'row', gap: '20px', padding: '20px', background: '#ffffff' } });
const first = room.doc.insert(board, { type: 'text', name: 'First', tag: 'p', text: 'First', style: { fontSize: '24px', color: '#111111' } });
const second = room.doc.insert(board, { type: 'text', name: 'Second', tag: 'p', text: 'Second', style: { fontSize: '24px', color: '#111111' } });
const docBefore = JSON.stringify(room.doc.getPages().flatMap((p) => room.doc.descendants(p.id).map((n) => [n.id, n.name, n.text ?? null, JSON.stringify(n.style ?? {})])));

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) as `${string}.png` });
const htmlLang = (page: Page) => page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir }));

async function openSettings(page: Page): Promise<void> {
  await page.keyboard.down('Control');
  await page.keyboard.press('Comma');
  await page.keyboard.up('Control');
  await page.waitForSelector('[data-testid="setting-language"]', { timeout: 5000 });
}

async function choose(page: Page, value: string, selector = '[data-testid="setting-language"]'): Promise<void> {
  await page.select(selector, value);
  await page.waitForFunction((v) => {
    const want: Record<string, string> = { ar: 'ar-AE', de: 'de-DE', fr: 'fr-FR', ga: 'ga-IE', fa: 'fa-IR', sw: 'sw-TZ', en: 'en-US' };
    return !want[v] || document.documentElement.lang === want[v];
  }, { timeout: 5000 }, value);
}

let browser: Browser | null = null;
try {
  browser = await puppeteer.launch({
    executablePath: CHROMIUM, pipe: true, headless: true,
    args: [`--secure-local-port=${server.port}`, '--lang=en-US'],
    defaultViewport: { width: 1500, height: 1000 },
  });

  // ---------------------------------------------------------------- desktop, Automatic from Omarchy
  const page = await browser.newPage();
  const chunks: string[] = [];
  page.on('request', (r) => {
    const m = /\/static\/locale-([\w-]+?)-[\w-]{6,}\.js$/.exec(new URL(r.url()).pathname);
    if (m) chunks.push(m[1]!);
  });
  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  check('Automatic shows Omarchy\'s language (German) on this machine', (await htmlLang(page)).lang === 'de-DE', await htmlLang(page));
  check('only the German catalog was fetched', chunks.length === 1 && chunks[0] === 'de', chunks);
  const settingsTitle = await page.$eval('[data-testid="home-settings"]', (el) => el.getAttribute('title') ?? el.getAttribute('aria-label') ?? '').catch(() => '');
  check('Home is in German, with the shortcut kept as it is', /Einstellungen/.test(settingsTitle) && settingsTitle.includes('Ctrl+,'), settingsTitle);
  await openSettings(page);
  const auto = await page.$eval('[data-testid="setting-language"]', (el) => ({ value: (el as HTMLSelectElement).value, first: (el as HTMLSelectElement).options[0]!.textContent, count: (el as HTMLSelectElement).options.length }));
  check('the picker says Automatic (Deutsch) and lists the 50 languages', auto.value === 'auto' && /Deutsch/.test(auto.first ?? '') && auto.count === 51, auto);
  const nativeNames = await page.$$eval('[data-testid="setting-language"] option', (os) => os.map((o) => o.textContent));
  check('languages are listed under their own names', ['العربية', '日本語', 'Gaeilge', 'සිංහල', 'Oʻzbekcha', 'Kiswahili', 'Norsk', 'Español (México)'].every((n) => nativeNames.includes(n)), nativeNames);
  await shot(page, 'desktop-settings-de');

  // ---------------------------------------------------------------- a choice, kept, over Omarchy
  await choose(page, 'fr');
  check('a choice shows at once', (await htmlLang(page)).lang === 'fr-FR');
  check('the choice is stored on this device', await page.evaluate(() => localStorage.getItem('bogen-language')) === 'fr');
  writeFileSync(languageFile, 'ja\n');
  await page.reload({ waitUntil: 'networkidle0' });
  check('the choice survives a reload and wins over Omarchy', (await htmlLang(page)).lang === 'fr-FR', await htmlLang(page));
  await openSettings(page);
  await choose(page, 'auto');
  await page.waitForFunction(() => document.documentElement.lang === 'ja-JP', { timeout: 5000 }).catch(() => undefined);
  check('Automatic again follows Omarchy\'s new language (Japanese)', (await htmlLang(page)).lang === 'ja-JP', await htmlLang(page));
  check('Automatic stores no choice', await page.evaluate(() => localStorage.getItem('bogen-language')) === null);

  // ---------------------------------------------------------------- right to left, with the canvas left to right
  await page.keyboard.press('Escape');
  await page.goto(`${base}/#/file/${created.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector(`[data-bogen-id="${first}"]`, { timeout: 15000 }).catch(() => undefined);
  const where = (id: string) => page.evaluate((nodeId) => {
    const el = document.querySelector(`[data-bogen-id="${nodeId}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y) };
  }, id);
  const ltrFirst = await where(first);
  const ltrSecond = await where(second);
  await openSettings(page);
  await choose(page, 'ar');
  await page.keyboard.press('Escape');
  // No named helper inside the page: tsx keeps function names with a __name call the page does not have.
  const dirs = await page.evaluate(() => {
    const [canvas, world, left, toolbar] = ['.canvas', '.bogen-world', '[data-testid="pages"]', '.toolbar, [data-testid="toolbar"]'].map((sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).direction : null;
    });
    return { page: document.documentElement.dir, canvas, world, left, toolbar };
  });
  check('Arabic: the interface is right to left', dirs.page === 'rtl' && dirs.left === 'rtl', dirs);
  check('Arabic: the canvas and the design on it stay left to right', dirs.canvas === 'ltr' && dirs.world === 'ltr', dirs);
  const rtlFirst = await where(first);
  const rtlSecond = await where(second);
  check('a row in the design keeps its order: First left of Second', Boolean(rtlFirst && rtlSecond && rtlFirst.x < rtlSecond.x), { rtlFirst, rtlSecond });
  check('layers keep their place on screen', JSON.stringify([ltrFirst, ltrSecond]) === JSON.stringify([rtlFirst, rtlSecond]), { ltrFirst, ltrSecond, rtlFirst, rtlSecond });
  const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth);
  check('no sideways scroll in Arabic', overflow <= 0, overflow);
  await shot(page, 'desktop-editor-ar');
  const docAfter = JSON.stringify(room.doc.getPages().flatMap((p) => room.doc.descendants(p.id).map((n) => [n.id, n.name, n.text ?? null, JSON.stringify(n.style ?? {})])));
  check('the design file is unchanged by switching languages', docAfter === docBefore);

  // ---------------------------------------------------------------- Persian digits
  await openSettings(page);
  await choose(page, 'fa');
  check('Persian is right to left too', (await htmlLang(page)).dir === 'rtl');
  await page.keyboard.press('Escape');
  await shot(page, 'desktop-editor-fa');

  // ---------------------------------------------------------------- a narrow desktop window
  await page.setViewport({ width: 760, height: 900 });
  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  await openSettings(page);
  await choose(page, 'ga');
  const narrow = await page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="settings-dialog"]')!.getBoundingClientRect();
    return { overflow: document.scrollingElement!.scrollWidth - innerWidth, fits: dialog.left >= 0 && dialog.right <= innerWidth };
  });
  check('narrow window: the settings dialog fits, in Irish', narrow.overflow <= 0 && narrow.fits, narrow);
  await shot(page, 'narrow-settings-ga');
  await page.close();

  // ---------------------------------------------------------------- the phone: its own languages, never the computer's
  const context = await browser.createBrowserContext();
  const phone = await context.newPage();
  await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  // Plain values, no functions inside the page (see the direction check above).
  await phone.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'languages', { value: ['sw-TZ', 'en-US'], configurable: true });
    Object.defineProperty(navigator, 'language', { value: 'sw-TZ', configurable: true });
  });
  // On the phone listener the computer says nothing about its own language; here, on loopback, the answer is stood in.
  await phone.setRequestInterception(true);
  phone.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/language') void r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ omarchy: null, system: [] }) });
    else void r.continue();
  });
  await phone.goto(`${base}/#/settings`, { waitUntil: 'networkidle0' });
  check('the phone follows its own language (Swahili), not the computer\'s', (await htmlLang(phone)).lang === 'sw-TZ', await htmlLang(phone));
  const phonePicker = await phone.$('[data-testid="set-language-select"]');
  check('the phone settings have the picker', phonePicker !== null);
  if (phonePicker) await choose(phone, 'he', '[data-testid="set-language-select"]');
  await phone.waitForFunction(() => document.documentElement.lang === 'he-IL', { timeout: 5000 }).catch(() => undefined);
  check('the phone switches to Hebrew, right to left', JSON.stringify(await htmlLang(phone)) === JSON.stringify({ lang: 'he-IL', dir: 'rtl' }), await htmlLang(phone));
  const phoneOverflow = await phone.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth);
  check('no sideways scroll on the phone', phoneOverflow <= 0, phoneOverflow);
  await shot(phone, 'phone-settings-he');
  await context.close();
} finally {
  await browser?.close();
  await server.close();
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed.length} failed. Screenshots in ${SHOTS}`);
if (failed.length) process.exit(1);
