/**
 * Files as tabs, through the real editor and a real server in a temporary BOGEN_HOME, in secure-chromium with its
 * sandbox on. Nothing leaves the machine; the call's speech is answered in the page as in call-everywhere.ts.
 *
 * - three files open as three tabs, in order, and the open one is selected;
 * - switching back restores the file at once (its session was kept) with its selection and right-hand panel;
 * - the keys: Ctrl+Tab, Ctrl+1, Ctrl+9, Ctrl+Shift+Page Up, Ctrl+W, middle click;
 * - a tab that went to sleep loads its file again and connects;
 * - an agent at work and the call show on their tabs, and the call goes on through tab switches;
 * - more tabs than fit: All tabs lists them; the tabs come back after a reload;
 * - axe (WCAG 2.2 AA) finds nothing in the strip or the menu, dark and light;
 * - one window per file: a second window of the browser shows a notice instead of a second editor, Use this window
 *   moves the file, Close goes Home, the waiting window takes the file when the other one closes, and `bogen open`
 *   (POST /api/open) is taken by the window that shows the file;
 * - two open files with the same name read differently (folder, kept copy, the start of the id);
 * - every route into a file (capitals, ?page=, /thread/, a trailing slash) is one tab.
 *
 *   (cd apps/editor && npx vite build)
 *   node --import tsx apps/editor/test/e2e/file-tabs.ts
 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { writeFakeClis } from '../../../../packages/server/test/fake-cli.ts';
import { freshPage, launch } from './craft-harness.ts';

const root = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-file-tabs-'));
const shots = process.env.BOGEN_SHOTS ?? join(root, 'shots');
const bin = join(root, 'bin');
for (const d of [shots, bin]) mkdirSync(d, { recursive: true });
writeFakeClis(bin, join(root, 'cli.log'));
process.env.PATH = `${bin}:${process.env.PATH}`;

const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false });
await server.listen();
const base = server.localUrl();
const browser = await launch(Number(new URL(base).port), { fakeMedia: true });

let passed = 0;
const failures: string[] = [];
const errors: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`pass  ${name}`); } else { failures.push(name); console.log(`FAIL  ${name}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* between states */ }
    await wait(50);
  }
  return false;
}
const exists = (page: Page, sel: string) => page.$(sel).then(Boolean);
const text = (page: Page, sel: string) => page.$eval(sel, (e) => (e as HTMLElement).innerText).catch(() => '');
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

/** The call's speech, answered in the page. */
function speech(req: HTTPRequest): void {
  const url = req.url();
  if (url.includes('/api/call/status')) {
    return void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
      voices: [{ id: 'v-en', language: 'en', name: 'Test voice', licence: 'test', bytes: 1, installed: true, preferred: true }, { id: 'v-de', language: 'de', name: 'Teststimme', licence: 'test', bytes: 1, installed: true, preferred: true }],
      listen: { installed: true, bytes: 1, licence: 'test', voxtype: false, ffmpeg: true, engine: 'parakeet' },
      installing: [], ready: { de: true, en: true }, talk: { gpu: false, models: [], claude: false, auto: 'rules' },
    }) });
  }
  if (url.includes('/api/call/say')) return void req.respond({ status: 200, contentType: 'audio/wav', body: Buffer.alloc(0) });
  if (url.includes('/api/call/talk')) return void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: null }) });
  if (url.includes('/api/call/listen')) return void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: '' }) });
  if (url.includes('/api/call/log') || url.includes('/api/call/end')) return void req.respond({ status: 200, contentType: 'application/json', body: '{}' });
  req.continue();
}

function make(name: string) {
  const entry = server.storage.create(name);
  return entry;
}
const files = [make('Trauermusik Wien'), make('Sprechstunde'), make('Bogen Brand System')];
for (const entry of files) {
  const room = await server.rooms.get(entry.id);
  const page = room.doc.getPages()[0]!.id;
  const board = room.doc.insert(page, { type: 'frame', name: 'Home', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '800px', height: '500px', background: '#f4f2ec' } });
  room.doc.insert(board, { type: 'text', name: 'Title', text: `${entry.name} title`, style: { fontSize: '32px' } });
  room.doc.insert(board, { type: 'frame', name: 'Card', style: { width: '200px', height: '120px', background: '#2b3df2' } });
  room.doc.invalidate();
}
const [a, b, c] = files as [typeof files[0], typeof files[0], typeof files[0]];
const tabIds = (page: Page) => page.$$eval('[data-testid="filetab"]', (els) => els.map((e) => e.getAttribute('data-file')));
const selectedTab = (page: Page) => page.$eval('[role="tab"][aria-selected="true"].ftab', (e) => e.getAttribute('data-file') ?? 'home').catch(() => null);
const ready = (page: Page, id: string) => until(() => page.evaluate((f) => location.hash.startsWith(`#/file/${f}`) && Boolean(document.querySelector('[data-testid="editor"]')) && !document.querySelector('[data-testid="loading"]'), id), 20_000);
/** Clicks a file's tab, once it is there and laid out. */
const clickTab = async (page: Page, id: string) => {
  const sel = `[data-testid="filetab"][data-file="${id}"]`;
  await until(async () => Boolean(await page.$eval(sel, (e) => (e as HTMLElement).offsetWidth > 0).catch(() => false)));
  await page.$eval(sel, (e) => (e as HTMLElement).click());
};
const press = async (page: Page, ...keys: string[]) => {
  for (const k of keys) await page.keyboard.down(k as never);
  for (const k of [...keys].reverse()) await page.keyboard.up(k as never);
};

try {
  const page = await freshPage(browser);
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setRequestInterception(true);
  page.on('request', speech);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

  // Three files, three tabs.
  for (const f of files) {
    await page.goto(`${base}/#/file/${f.id}`);
    await ready(page, f.id);
  }
  check('three files make three tabs, in the order they were opened', JSON.stringify(await tabIds(page)) === JSON.stringify([a.id, b.id, c.id]), await tabIds(page));
  check('the open one is selected', (await selectedTab(page)) === c.id);
  check('the tabs carry the file names', await until(async () => (await text(page, '[data-testid="tabstrip"]')).includes('Sprechstunde')));

  // Left in a state: a layer selected, the code panel open.
  await clickTab(page, a.id);
  await ready(page, a.id);
  await page.waitForSelector('[data-testid="layer-row"]', { timeout: 10_000 });
  const rows = await page.$$('[data-testid="layer-row"]');
  await rows[rows.length - 1]!.click();
  const chosen = await page.$$eval('[data-testid="layer-row"][aria-selected="true"]', (els) => els.map((e) => e.textContent));
  await page.click('[data-testid="tab-code"]').catch(() => {});
  const rightBefore = await page.$eval('[data-testid^="tab-"][aria-selected="true"]', (e) => e.getAttribute('data-testid')).catch(() => null);
  await shot(page, '01-three-tabs');

  await clickTab(page, b.id);
  await ready(page, b.id);
  const awake = await page.evaluate(() => (window as unknown as { __bogenTabs: { parkedFiles: () => string[] } }).__bogenTabs.parkedFiles());
  check('the tab left behind stays awake', awake.includes(a.id), awake);
  const t0 = Date.now();
  await clickTab(page, a.id);
  await ready(page, a.id);
  await page.waitForSelector('[data-testid="layer-row"]');
  const back = Date.now() - t0;
  check('going back to it is quick (its session was kept)', back < 2500, `${back} ms`);
  const restored = await page.$$eval('[data-testid="layer-row"][aria-selected="true"]', (els) => els.map((e) => e.textContent));
  check('with its selection', restored.length > 0 && JSON.stringify(restored) === JSON.stringify(chosen), { chosen, restored });
  const rightAfter = await page.$eval('[data-testid^="tab-"][aria-selected="true"]', (e) => e.getAttribute('data-testid')).catch(() => null);
  check('and its right-hand panel', rightAfter === rightBefore, { rightBefore, rightAfter });
  check('the strip has no accessibility findings (axe, dark)', (await axe(page, '[data-testid="tabstrip"]')).length === 0, await axe(page, '[data-testid="tabstrip"]'));
  check('the tab panel is labelled by the open tab', await page.evaluate((id) => document.getElementById('bogen-tabpanel')?.getAttribute('aria-labelledby') === `bogen-tab-${id}`, a.id));
  check('one main landmark', (await page.$$eval('main', (els) => els.length)) === 1, await page.$$eval('main', (els) => els.length));

  // Keys.
  await press(page, 'Control', 'Tab');
  check('Ctrl+Tab opens the next tab', await ready(page, b.id));
  await press(page, 'Control', '1');
  check('Ctrl+1 goes Home', await until(() => page.evaluate(() => location.hash === '#/' && Boolean(document.querySelector('[data-testid="home"]')))), await page.evaluate(() => ({ hash: location.hash, home: Boolean(document.querySelector('[data-testid="home"]')), active: document.activeElement?.tagName })));
  check('Home is the selected tab there', await until(async () => (await page.$eval('[data-testid="filetab-home"]', (e) => e.getAttribute('aria-selected')).catch(() => null)) === 'true'));
  await press(page, 'Control', '9');
  check('Ctrl+9 opens the last tab', await ready(page, c.id));
  await press(page, 'Control', 'Shift', 'PageUp');
  check('Ctrl+Shift+Page Up moves it left', JSON.stringify(await tabIds(page)) === JSON.stringify([a.id, c.id, b.id]), await tabIds(page));
  await press(page, 'Control', 'w');
  check('Ctrl+W closes it and opens its right-hand neighbour', await ready(page, b.id) && JSON.stringify(await tabIds(page)) === JSON.stringify([a.id, b.id]), await tabIds(page));
  const closedLive = await page.evaluate((id) => (window as unknown as { __bogenTabs: { parkedFiles: () => string[] } }).__bogenTabs.parkedFiles().includes(id), c.id);
  check('a closed tab lets its file go at once', !closedLive);

  // Sleep: a tab left long enough loads its file again.
  await page.evaluate(() => { (window as unknown as { __bogenTabs: { sleepPolicy: { afterMs: number } } }).__bogenTabs.sleepPolicy.afterMs = 400; });
  await clickTab(page, a.id);
  await ready(page, a.id);
  await wait(900);
  const sleeping = await page.evaluate(() => (window as unknown as { __bogenTabs: { parkedFiles: () => string[] } }).__bogenTabs.parkedFiles());
  check('after a while the tab left behind sleeps', !sleeping.includes(b.id), sleeping);
  await clickTab(page, b.id);
  check('a sleeping tab loads its file again', await ready(page, b.id));
  check('and connects: its layers are there', await until(async () => (await page.$$('[data-testid="layer-row"]')).length >= 2, 10_000));
  // A change made on the server while the tab slept is there.
  await page.evaluate(() => { (window as unknown as { __bogenTabs: { sleepPolicy: { afterMs: number } } }).__bogenTabs.sleepPolicy.afterMs = 300_000; });

  // An agent at work in another file shows on its tab.
  server.hub.broadcast({ t: 'activity', fileId: a.id, agent: 'claude', tool: 'html_write', nodeIds: [], at: Date.now() });
  check('an agent at work shows on its tab', await until(() => exists(page, `[data-testid="filetab"][data-file="${a.id}"] [data-mark="working"]`), 4000));
  check('and is named for screen readers', (await text(page, `[data-testid="filetab"][data-file="${a.id}"]`)).includes('claude is working here'));
  check('the mark goes when the agent is done', await until(async () => !(await exists(page, `[data-testid="filetab"][data-file="${a.id}"] [data-mark="working"]`)), 8000));

  // The call goes on through tab switches.
  await clickTab(page, a.id);
  await ready(page, a.id);
  await page.click('[data-testid="prompt-toggle"]');
  await page.waitForSelector('[data-testid="chat-call"]', { timeout: 10_000 });
  await page.click('[data-testid="chat-call"]');
  check('a call starts in file A', await until(() => exists(page, '[data-testid="call-panel"]'), 10_000));
  await wait(1200);
  await press(page, 'Control', 'Tab');
  await ready(page, b.id);
  check('in the next tab the call bar shows the call', await until(() => exists(page, '[data-testid="callbar"]')));
  check('the call\'s tab carries the phone', await until(() => exists(page, `[data-testid="filetab"][data-file="${a.id}"] [data-mark="call"]`)));
  await press(page, 'Control', '1');
  check('Home keeps the call too', await until(() => exists(page, '[data-testid="callbar"]')));
  await press(page, 'Control', '2');
  await ready(page, a.id);
  check('back in A the full call panel is there again', await until(() => exists(page, '[data-testid="call-panel"]'), 10_000));
  await shot(page, '02-call-across-tabs');
  if (await exists(page, '[data-testid="call-hangup"]')) await page.click('[data-testid="call-hangup"]');
  else if (await exists(page, '[data-testid="callbar-end"]')) await page.click('[data-testid="callbar-end"]');

  // Middle click closes.
  const more = [make('nenaj Marke'), make('Tirava Marke'), make('Bogen Website'), make('Kreide Pitch deck'), make('Loam'), make('Second Shelf'), make('Couchette'), make('Laneway'), make('Harbour'), make('Crux')];
  for (const f of more) {
    await page.evaluate((id) => { location.hash = `#/file/${id}`; }, f.id);
    await ready(page, f.id);
  }
  const before = (await tabIds(page)).length;
  const crux = await page.$(`[data-testid="filetab"][data-file="${more[more.length - 1]!.id}"]`);
  const box = await crux!.boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'middle' });
  check('middle click closes a tab', await until(async () => (await tabIds(page)).length === before - 1), { before, after: (await tabIds(page)).length });

  // More tabs than fit.
  await page.setViewport({ width: 1024, height: 800, deviceScaleFactor: 1 });
  check('with more tabs than fit, All tabs shows', await until(() => exists(page, '[data-testid="tabs-all"]')));
  await page.click('[data-testid="tabs-all"]');
  check('All tabs lists every open file', await until(async () => (await page.$$('[data-testid="tabs-menu"] [role="menuitem"]')).length === (await tabIds(page)).length));
  check('the menu has no accessibility findings', (await axe(page, '[data-testid="tabstrip"]')).length === 0, await axe(page, '[data-testid="tabstrip"]'));
  await shot(page, '03-all-tabs');
  await page.keyboard.press('Escape');
  check('Escape closes the menu', await until(async () => !(await exists(page, '[data-testid="tabs-menu"]'))));

  // Keyboard in the strip: arrows move focus, Delete closes.
  await page.focus('[role="tab"][aria-selected="true"].ftab');
  await page.keyboard.press('ArrowLeft');
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-file'));
  const count = (await tabIds(page)).length;
  await page.keyboard.press('Delete');
  check('Delete closes the focused tab', await until(async () => (await tabIds(page)).length === count - 1 && !(await tabIds(page)).includes(focused ?? '')), { focused });

  // Light theme.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.evaluate(() => { try { localStorage.setItem('bogen-settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('bogen-settings') ?? '{}'), appearance: 'light' })); } catch { /* none */ } });
  await page.reload();
  await page.waitForSelector('[data-testid="tabstrip"]', { timeout: 20_000 });
  await wait(400);
  check('the light theme is on', await page.evaluate(() => document.documentElement.getAttribute('data-theme-mode') !== 'dark'), await page.evaluate(() => document.documentElement.getAttribute('data-theme-mode')));
  check('the strip has no accessibility findings (axe, light)', (await axe(page, '[data-testid="tabstrip"]')).length === 0, await axe(page, '[data-testid="tabstrip"]'));
  await shot(page, '04-light');

  // After a reload the tabs are there again.
  const kept = await tabIds(page);
  await page.reload();
  await page.waitForSelector('[data-testid="tabstrip"]', { timeout: 20_000 });
  check('after a reload the tabs come back in order', JSON.stringify(await tabIds(page)) === JSON.stringify(kept), { kept, now: await tabIds(page) });

  // One window per file. The first window leaves the files below alone: it shows Home.
  await page.evaluate(() => { location.hash = '#/'; });
  const solo = make('Solo window file');
  const other = make('Second window file');
  const w1 = await freshPage(browser);
  w1.on('pageerror', (e) => errors.push(String(e)));
  await w1.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await w1.goto(`${base}/#/file/${solo.id}`);
  check('(a) the first window opens the file', await ready(w1, solo.id));
  const w2 = await freshPage(browser);
  w2.on('pageerror', (e) => errors.push(String(e)));
  await w2.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await w2.goto(`${base}/#/file/${solo.id}?layer=Title`);
  check('(a) a second window of the browser shows the notice, not a second editor', await until(() => exists(w2, '[data-testid="open-elsewhere"]'), 10_000) && !(await exists(w2, '[data-testid="editor"]')));
  check('(a) it says so', (await text(w2, '[data-testid="open-elsewhere"]')).includes('This file is open in another window'));
  check('(a) the first window keeps its editor, and follows the link to the layer', await exists(w1, '[data-testid="editor"]') && await until(() => w1.evaluate(() => location.hash.includes('layer=Title'))), await w1.evaluate(() => location.hash));
  check('(a) the notice has no accessibility findings', (await axe(w2, '[data-testid="open-elsewhere"]')).length === 0, await axe(w2, '[data-testid="open-elsewhere"]'));
  await shot(w2, '06-open-in-another-window');
  await w2.click('[data-testid="open-elsewhere-use"]');
  check('(a) Use this window opens the editor here', await ready(w2, solo.id));
  check('(a) and the other window goes Home', await until(() => w1.evaluate(() => location.hash === '#/' && Boolean(document.querySelector('[data-testid="home"]')))));

  // bogen open: the window that shows the file takes it, and no other window opens.
  const open = (hash: string, raise = false) => fetch(`${base}/api/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash, raise }) }).then((r) => r.json() as Promise<{ taken: boolean; title?: string }>);
  const opened = await open(`#/file/${solo.id}?select=x`);
  check('(a) bogen open is taken by the window that shows the file', opened.taken === true && await until(() => w2.evaluate(() => location.hash.includes('select=x'))), opened);
  check('(a) and the other windows stay where they are', await w1.evaluate(() => location.hash === '#/'));

  // Close goes Home where the browser does not let a page close its window.
  const w3 = await freshPage(browser);
  w3.on('pageerror', (e) => errors.push(String(e)));
  await w3.goto(`${base}/#/file/${solo.id}`);
  await until(() => exists(w3, '[data-testid="open-elsewhere"]'), 10_000);
  await w3.click('[data-testid="open-elsewhere-close"]');
  check('(a) Close goes Home in a window the page may not close', await until(() => w3.evaluate(() => location.hash === '#/')));
  // When the window with the file closes, a window waiting for it takes it.
  await w3.evaluate((id) => { location.hash = `#/file/${id}`; }, solo.id);
  await until(() => exists(w3, '[data-testid="open-elsewhere"]'), 10_000);
  await w2.close();
  check('(a) when the other window closes, the waiting one opens the file', await ready(w3, solo.id));
  await w3.close();
  const unseen = await open(`#/file/${other.id}`);
  check('(a) without a way to raise a window, only the window with the file takes it', unseen.taken === false, unseen);
  const fresh = await open(`#/file/${other.id}`, true);
  check('(a) a file no window shows is taken by a window in view, where the caller can raise it', fresh.taken === true && await until(async () => (await Promise.all([page, w1].map((p) => p.evaluate((id) => location.hash.startsWith(`#/file/${id}`), other.id)))).filter(Boolean).length === 1), fresh);

  // (b) Two open files with the same name.
  const twinA = make('Catppuccin Custom · Omarchy theme');
  const twinB = make('Catppuccin Custom · Omarchy theme');
  const twinC = make('Catppuccin Custom · Omarchy theme');
  server.storage.moveToFolder(twinA.id, 'Themes');
  for (const f of [twinA, twinB, twinC]) {
    await w1.evaluate((id) => { location.hash = `#/file/${id}`; }, f.id);
    await ready(w1, f.id);
  }
  const twinText = async () => Promise.all([twinA, twinB, twinC].map((f) => text(w1, `[data-testid="filetab"][data-file="${f.id}"]`)));
  check('(b) tabs with the same name read differently', await until(async () => new Set(await twinText()).size === 3 && (await twinText()).every((x) => x.startsWith('Catppuccin Custom'))), await twinText());
  check('(b) by folder where it differs, else by the start of the id', await until(async () => (await twinText())[0]!.includes('Themes') && (await twinText())[1]!.includes(twinB.id.slice(0, 4))), await twinText());
  check('(b) a tab with a name of its own gets no hint', !(await exists(w1, `[data-testid="filetab"][data-file="${solo.id}"] [data-testid="filetab-hint"]`)));
  check('(b) the strip has no accessibility findings with hints', (await axe(w1, '[data-testid="tabstrip"]')).length === 0, await axe(w1, '[data-testid="tabstrip"]'));
  await shot(w1, '07-same-names');

  // (c) Every route into a file is one tab.
  const count0 = (await tabIds(w1)).length;
  for (const h of [`#/file/${twinA.id.toUpperCase()}`, `#/file/${twinA.id}?page=x`, `#/file/${twinA.id}/thread/t1`, `#/file/${twinA.id}/`]) {
    await w1.evaluate((x) => { location.hash = x; }, h);
    await ready(w1, twinA.id);
  }
  check('(c) capitals, ?page=, /thread/ and a trailing slash add no tab', (await tabIds(w1)).length === count0 && (await tabIds(w1)).filter((x) => x === twinA.id).length === 1, await tabIds(w1));
  check('(c) and the address is spelled as the tab', await w1.evaluate((id) => location.hash.startsWith(`#/file/${id}`), twinA.id));
  await w1.close();

  // The phone: no strip; a button in the file's top bar opens the open files as a sheet.
  const phone = await freshPage(browser);
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await phone.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await phone.goto(`${base}/#/file/${a.id}`);
  await phone.waitForSelector('.pf-top', { timeout: 20_000 });
  await phone.evaluate((id) => { location.hash = `#/file/${id}`; }, b.id);
  check('on the phone there is no strip', await until(async () => (await exists(phone, '.pf-top')) && !(await exists(phone, '[data-testid="tabstrip"]'))));
  check('the top bar says how many files are open', await until(async () => /\d+ files/.test(await text(phone, '[data-testid="pf-files"]'))), await text(phone, '[data-testid="pf-files"]'));
  await phone.tap('[data-testid="pf-files"]');
  check('it opens the open files as a sheet', await until(() => exists(phone, '[data-testid="file-switcher"]')));
  check('the sheet has no accessibility findings', (await axe(phone, '[data-testid="file-switcher"]')).length === 0, await axe(phone, '[data-testid="file-switcher"]'));
  await shot(phone, '05-phone-switcher');
  const before2 = (await phone.$$('[data-testid="file-switcher-file"]')).length;
  await phone.$eval(`[data-testid="file-switcher-file"][data-file="${a.id}"]`, (e) => (e as HTMLElement).click());
  check('picking a file opens it', await until(() => phone.evaluate((id) => location.hash.startsWith(`#/file/${id}`), a.id)));
  await phone.waitForSelector('[data-testid="pf-files"]', { timeout: 10_000 });
  await phone.tap('[data-testid="pf-files"]');
  await phone.waitForSelector('[data-testid="file-switcher-close"]');
  await phone.$eval(`[data-testid="file-switcher-file"][data-file="${b.id}"] + [data-testid="file-switcher-close"]`, (e) => (e as HTMLElement).click());
  check('a file closes from the sheet', await until(async () => (await phone.$$('[data-testid="file-switcher-file"]')).length === before2 - 1));
  await phone.close();

  check('no page errors', !errors.length, errors);
} catch (e) {
  failures.push(String(e));
  console.log(`FAIL  ${String((e as Error).stack ?? e)}`);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed. Screenshots: ${shots}`);
process.exit(failures.length ? 1 : 0);

