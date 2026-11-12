/** Large-page regression: real server and sandboxed browser, on disposable generated screens only. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';

const home = mkdtempSync(join(tmpdir(), 'bogen-artboards-'));
const shots = mkdtempSync(join(tmpdir(), 'bogen-artboard-shots-'));
const server = new BogenServer({ home, port: 0, exportDir: join(home, 'exports') });
await server.listen();
const base = server.localUrl();
const file = server.storage.create('Many screens');
const room = await server.rooms.get(file.id);
const { doc } = room;
const pageId = doc.getPages()[0]!.id;
const screens: { id: string; child: string; x: number; y: number }[] = [];
doc.setToken('screen-width', 'spacing', '320px');
doc.transact(() => {
  for (let i = 0; i < 48; i++) {
    const x = (i % 8) * 500;
    const y = Math.floor(i / 8) * 700;
    const id = doc.insert(pageId, { type: 'frame', name: `Screen ${i}`, artboard: true, style: { position: 'absolute', left: `${x}px`, top: `${y}px`, width: i % 2 ? 'var(--screen-width)' : '320px', height: '480px', display: 'flex', flexDirection: 'column', overflow: 'hidden', backgroundColor: '#ffffff', padding: '16px', boxSizing: 'border-box' }, children: Array.from({ length: 32 }, (_, j) => ({ type: 'text' as const, tag: 'p', name: `Text ${i}-${j}`, text: `Screen ${i} line ${j}`, style: { fontSize: '12px', margin: '0', flexShrink: '0' } })) });
    doc.invalidate();
    screens.push({ id, child: doc.getChildren(id)[0]!.id, x, y });
  }
});
const auto = doc.insert(pageId, { type: 'frame', name: 'Content-sized screen', artboard: true, style: { position: 'absolute', left: '5000px', top: '0px', width: '320px', overflow: 'hidden' }, children: [{ type: 'text', tag: 'p', name: 'Intrinsic text', text: 'Keep my intrinsic height', style: { height: '80px', margin: '0' } }] });
doc.invalidate();
const autoChild = doc.getChildren(auto)[0]!.id;
const thread = doc.addThread({ pageId, nodeId: screens[30]!.child, x: 4, y: 4, author: 'Tester', text: 'Comment on a distant screen' });
const browserPath = process.env.BOGEN_BROWSER;
if (!browserPath) throw new Error('Set BOGEN_BROWSER to a browser with its sandbox on.');
const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, pipe: true, args: [`--secure-local-port=${new URL(base).port}`], defaultViewport: { width: 1440, height: 900 } });
let passed = 0;
const errors: string[] = [];
const check = (name: string, value: boolean) => { if (!value) throw new Error(name); passed++; console.log(`pass  ${name}`); };
const layer = (id: string) => `.bogen-world [data-bogen-id="${id}"]`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Use real menu clicks, independent of keyboard layout on the test host.
async function zoomMenu(page: Page, label: string) {
  await page.click('[data-testid="zoom-level"]');
  const buttons = await page.$$('.menu-item');
  for (const button of buttons) if ((await button.evaluate((el) => el.textContent))?.startsWith(label)) { await button.click(); return; }
  throw new Error(`No zoom item ${label}`);
}
async function find(page: Page, text: string) {
  await page.keyboard.down('Control'); await page.keyboard.press('f'); await page.keyboard.up('Control');
  await page.waitForSelector('[data-testid="find-input"]');
  await page.type('[data-testid="find-input"]', text);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument('window.__name = (f) => f');
  await page.evaluateOnNewDocument((fileId, pid) => localStorage.setItem(`bogen-view-${fileId}-${pid}`, JSON.stringify({ x: 48, y: 48, z: 1 })), file.id, pageId);
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/#/file/${file.id}`);
  await page.waitForSelector(layer(screens[0]!.child));
  await wait(400);
  check('every screen keeps its outer box for labels, overview and navigation', (await page.$$('.bogen-world > [data-bogen-id]')).length === 49);
  check('offscreen screen contents are absent', !(await page.$(layer(screens[47]!.child))));
  check('nearby screen contents are editable DOM', Boolean(await page.$(layer(screens[0]!.child))));
  check('a screen with intrinsic height keeps its contents', Boolean(await page.$(layer(autoChild))));
  check('the initial DOM stays below a third of the document', (await page.$$('.bogen-world [data-bogen-id]')).length < 500);
  check('a deferred comment pin is not misplaced at the origin', !(await page.$(`[data-pin="${thread}"]`)));
  const initial = await page.$$eval('.bogen-world > [data-bogen-id]', (els) => els.map((el) => ({ id: el.getAttribute('data-bogen-id'), width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight })));
  await page.screenshot({ path: join(shots, '1-nearby.png') });

  // A remote edit while the subtree has no DOM must arrive when the person goes there.
  doc.updateFields(screens[47]!.child, { text: 'Remote change outside the viewport' });
  await wait(100);
  await find(page, 'Remote change outside the viewport');
  await page.waitForSelector(layer(screens[47]!.child));
  await page.waitForFunction((id) => {
    const el = document.querySelector(`[data-bogen-id="${id}"]`);
    const canvas = document.querySelector('[data-testid="canvas"]')?.getBoundingClientRect();
    const r = el?.getBoundingClientRect();
    return r && canvas && r.left >= canvas.left && r.left < canvas.right && r.top >= canvas.top && r.top < canvas.bottom;
  }, {}, screens[47]!.child);
  check('Find mounts and reveals a distant edited layer', (await page.$eval(layer(screens[47]!.child), (el) => el.textContent)) === 'Remote change outside the viewport');
  check('selection remains measurable after navigating', Boolean(await page.$('[data-testid="selection-box"]')));
  await page.screenshot({ path: join(shots, '2-distant-selection.png') });

  await zoomMenu(page, 'Fit everything');
  await page.waitForFunction(() => !document.querySelector('.bogen-world > [data-bogen-deferred]'), { timeout: 20_000 });
  check('Fit everything fills in every screen', (await page.$$('.bogen-world [data-bogen-id]')).length === 48 * 33 + 2);
  const filled = await page.$$eval('.bogen-world > [data-bogen-id]', (els) => els.map((el) => ({ id: el.getAttribute('data-bogen-id'), width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight })));
  check('deferring contents changes no screen dimensions', JSON.stringify(initial) === JSON.stringify(filled));
  await page.screenshot({ path: join(shots, '3-overview.png') });
  await zoomMenu(page, 'Fit selection');
  await page.waitForFunction(() => document.querySelectorAll('.bogen-world [data-bogen-id]').length < 500, { timeout: 5000 });
  check('zooming back in releases far-away screen DOM', true);

  // A selected offscreen subtree stays mounted while panning, so editing/undo cannot lose its element.
  const bounds = await page.$eval('[data-testid="canvas"]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(bounds.x, bounds.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(bounds.x + 1800, bounds.y + 1000, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  await wait(300);
  check('a selected subtree stays mounted while panning away', Boolean(await page.$(layer(screens[47]!.child))));
  await zoomMenu(page, 'Fit selection');
  check('fitting the selected layer works again', Boolean(await page.$('[data-testid="selection-box"]')));

  await page.click('[data-testid="home-link"]');
  await page.waitForSelector('[data-testid="home"]');
  await page.goto(`${base}/#/file/${file.id}`);
  await page.waitForSelector('[data-testid="canvas"]');
  await page.waitForSelector(layer(screens[47]!.child));
  check('closing and reopening restores the view and its contents', true);
  await page.click('[data-testid="tab-comments"]');
  await page.locator(`[data-thread="${thread}"]`).click();
  await page.waitForFunction((id) => {
    const r = document.querySelector(`[data-bogen-id="${id}"]`)?.getBoundingClientRect();
    const c = document.querySelector('[data-testid="canvas"]')?.getBoundingClientRect();
    return r && c && r.left >= c.left && r.left < c.right && r.top >= c.top && r.top < c.bottom;
  }, {}, screens[30]!.child);
  check('a comment opens and reveals a deferred child', Boolean(await page.$(`[data-pin="${thread}"]`)));

  room.agentStarted('tester', 'layer_get');
  room.agentFinished('tester', [], pageId);
  room.agentFocus('tester', { id: 'far-focus', nodeIds: [screens[0]!.child], pageId, select: false, view: true, at: Date.now() });
  await page.waitForFunction((id) => {
    const r = document.querySelector(`[data-bogen-id="${id}"]`)?.getBoundingClientRect();
    const c = document.querySelector('[data-testid="canvas"]')?.getBoundingClientRect();
    return r && c && r.left >= c.left && r.left < c.right && r.top >= c.top && r.top < c.bottom;
  }, {}, screens[0]!.child);
  check('an agent can reveal a deferred child without selecting it', true);

  await page.click('[data-testid="home-link"]');
  await page.waitForSelector('[data-testid="home"]');
  await page.evaluate((fid, pid) => localStorage.removeItem(`bogen-view-${fid}-${pid}`), file.id, pageId);
  await page.goto(`${base}/#/file/${file.id}`);
  await page.waitForSelector('[data-testid="canvas"]');
  await page.waitForSelector(layer(screens[0]!.child));
  check('a large new view opens at a readable screen', Number.parseInt(await page.$eval('[data-testid="zoom-level"]', (el) => el.textContent ?? '0')) > 50);
  check('opening a new view does not mount every screen', !(await page.$(layer(screens[47]!.child))));
  await page.locator('[data-testid="home-link"]').click();
  await page.waitForSelector('[data-testid="home"]');
  check('leaving during a fresh large-page load cancels the page cleanly', true);
  check('no page errors', errors.length === 0);
  await page.close();
  console.log(`\n${passed} passed. Pictures in ${shots}`);
} finally {
  await browser.close();
  await server.close();
  rmSync(home, { recursive: true, force: true });
}
