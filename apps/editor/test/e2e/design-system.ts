/**
 * The design system, driven with a real mouse and keyboard in Chromium against real servers from
 * source: components, overrides, props, variants, slots, assets, modes, text styles, icons, code,
 * two browsers, a synced peer, an old document, and 500 instances.
 *
 * Run: npx tsx apps/editor/test/e2e/design-system.ts
 * With a built editor from elsewhere: BOGEN_EDITOR_DIR=/path/to/dist. Screenshots: E2E_SHOTS=/path.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createComponent, createInstance, Y } from '@bogen/core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';

const SHOTS = process.env.E2E_SHOTS ?? resolve(import.meta.dirname, '../../screenshots/design-system');
mkdirSync(SHOTS, { recursive: true });
const only = process.env.E2E_ONLY?.split(',');

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

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) as `${string}.png` });
}

async function open(browser: Browser | { newPage: () => Promise<Page> }, base: string, fileId: string): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument('window.__name = (f) => f');
  page.on('pageerror', (e) => errors.push(`pageerror: ${(e as Error).message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/fonts\.g|net::ERR|Failed to load resource|WebSocket connection/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${base}/#/file/${fileId}`);
  await page.waitForSelector('[data-testid="canvas"]', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="pages"]') !== null, { timeout: 10000 }).catch(() => undefined);
  await sleep(250);
  return page;
}

const box = (page: Page, selector: string) => page.$eval(selector, (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
});

async function drag(page: Page, x0: number, y0: number, x1: number, y1: number, steps = 8): Promise<void> {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
  await page.mouse.up();
  await sleep(40);
}

async function key(page: Page, combo: string): Promise<void> {
  const parts = combo.split('+');
  const k = parts.pop()!;
  for (const m of parts) await page.keyboard.down(m as 'Control');
  await page.keyboard.press(k as 'a');
  for (const m of [...parts].reverse()) await page.keyboard.up(m as 'Control');
  await sleep(40);
}

async function clickTest(page: Page, id: string): Promise<void> {
  const el = await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 4000 });
  await el!.click();
  await sleep(40);
}

async function fill(page: Page, id: string, value: string): Promise<void> {
  const el = await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 4000 });
  await el!.click({ count: 3 });
  await key(page, 'Control+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
  await sleep(50);
}

/** The text of a layer on the canvas. */
const textOf = (page: Page, id: string) => page.$eval(`[data-bogen-id="${id}"]`, (el) => el.textContent).catch(() => null);
const has = (page: Page, selector: string) => page.$(selector).then((e) => e !== null);
const canvasTexts = (page: Page, text: string) => page.$$eval('.bogen-world [data-bogen-id]', (els, t) => els.filter((e) => e.textContent === t && !e.querySelector('[data-bogen-id]')).length, text);

async function selectRow(page: Page, id: string): Promise<void> {
  await clickTest(page, 'tab-layers');
  const row = await page.$(`[data-testid="layer-row"][data-layer="${id}"]`);
  if (!row) throw new Error(`no row for ${id}`);
  await row.click();
  await sleep(40);
}

/** Opens an instance in the list, so that its inside has rows. */
async function expandRow(page: Page, id: string): Promise<void> {
  await clickTest(page, 'tab-layers');
  const open = await page.$eval(`[data-testid="layer-row"][data-layer="${id}"]`, (e) => e.getAttribute('aria-expanded'));
  if (open === 'true') return;
  const toggle = await page.$(`[data-testid="layer-row"][data-layer="${id}"] .layer-toggle`);
  await toggle?.click();
  await sleep(40);
}

const selected = (page: Page) => page.$$eval('[data-testid="layer-row"].is-selected', (rows) => rows.map((r) => (r as HTMLElement).dataset.layer!));

async function main(): Promise<void> {
  const base1 = mkdtempSync(join(tmpdir(), 'bogen-ds-a-'));
  const base2 = mkdtempSync(join(tmpdir(), 'bogen-ds-b-'));
  const a = new BogenServer({ home: base1, port: 0, insecureAllowAnyHost: true, peerCatchUpMs: 60_000, exportDir: join(base1, 'exports') });
  const b = new BogenServer({ home: base2, port: 0, insecureAllowAnyHost: true, peerCatchUpMs: 60_000, exportDir: join(base2, 'exports') });
  await a.listen();
  await b.listen();
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'bogen-ds-profile-')), args: ['--no-sandbox', '--window-size=1500,960', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], defaultViewport: { width: 1500, height: 960 } });
  const run = (name: string) => !only || only.includes(name);

  try {
    const post = (server: BogenServer, path: string, body: unknown) => fetch(`${server.localUrl()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const newFile = async (server: BogenServer, name: string) => ((await (await post(server, '/api/files', { name })).json()) as { id: string }).id;

    if (run('flow')) {
      const fileId = await newFile(a, 'Flow');
      const page = await open(browser, a.localUrl(), fileId);
      const canvas = await box(page, '[data-testid="canvas"]');

      // 1. Draw a frame with text, make it a component with the keyboard.
      await key(page, 'f');
      await drag(page, canvas.x + 60, canvas.y + 60, canvas.x + 260, canvas.y + 160);
      const [mainId] = await selected(page);
      check('drawing a frame selects it', Boolean(mainId));
      await clickTest(page, 'insp-layout-column');
      await key(page, 't');
      await page.mouse.click(canvas.x + 100, canvas.y + 100);
      await sleep(80);
      await page.keyboard.type('Hello');
      await page.keyboard.press('Escape');
      await sleep(80);
      const [textId] = await selected(page);
      check('typed text is a layer', (await textOf(page, textId!)) === 'Hello', await textOf(page, textId!));
      await selectRow(page, mainId!);
      await key(page, 'Control+Alt+k');
      await until('main section', () => has(page, '[data-testid="main-instance-count"]'));
      check('Ctrl+Alt+K makes a component', await has(page, '[data-testid="main-instance-count"]'));
      check('the main shows no instances yet', (await page.$eval('[data-testid="main-instance-count"]', (e) => e.textContent)) === '0 instances');
      check('the layer list marks the main', await has(page, `[data-layer="${mainId}"].is-main`));
      await shot(page, '01-main');

      // 4. Assets panel: preview, search, drag onto the canvas.
      await clickTest(page, 'tab-assets');
      await page.waitForSelector('[data-testid="asset-member"]');
      await until('preview', () => page.$eval('.asset-preview', (e) => (e.shadowRoot?.textContent ?? '').includes('Hello')));
      check('assets show a rendered preview', await page.$eval('.asset-preview', (e) => Boolean(e.shadowRoot?.querySelector('.fit')?.textContent?.includes('Hello'))));
      await fill(page, 'assets-search', 'zzz');
      check('search can come up empty', (await page.$$('[data-testid="asset-member"]')).length === 0);
      await fill(page, 'assets-search', '');
      check('search comes back', (await page.$$('[data-testid="asset-member"]')).length === 1);
      const member = await box(page, '[data-testid="asset-member"]');
      await page.mouse.move(member.cx, member.cy);
      await page.mouse.down();
      await page.mouse.move(member.cx + 20, member.cy + 20, { steps: 3 });
      check('a drag shows a ghost', await has(page, '[data-testid="asset-ghost"]'));
      await page.mouse.move(canvas.x + 420, canvas.y + 80, { steps: 6 });
      await shot(page, '02-asset-drag');
      await page.mouse.up();
      await sleep(120);
      check('dragging onto the canvas makes an instance', (await canvasTexts(page, 'Hello')) === 2, await canvasTexts(page, 'Hello'));
      await page.mouse.move(member.cx, member.cy);
      await page.mouse.down();
      await page.mouse.move(canvas.x + 420, canvas.y + 280, { steps: 8 });
      await page.mouse.up();
      await sleep(120);
      check('a second instance', (await canvasTexts(page, 'Hello')) === 3);
      const [instanceId] = await page.$$eval('.bogen-world [data-bogen-id]', (els) => els.map((e) => (e as HTMLElement).dataset.bogenId!).filter((id) => !id.includes('/')).filter((id, _i, all) => all.indexOf(id) === _i).slice(-1));
      check('an instance has one stored id, with views inside', Boolean(instanceId) && await has(page, `[data-bogen-id="${instanceId}/${textId}"]`), instanceId);

      // Across pages.
      await clickTest(page, 'tab-layers');
      await clickTest(page, 'page-add');
      await sleep(100);
      await page.keyboard.press('Escape');
      await clickTest(page, 'tab-assets');
      const member2 = await box(page, '[data-testid="asset-member"]');
      await page.mouse.move(member2.cx, member2.cy);
      await page.mouse.down();
      await page.mouse.move(canvas.x + 300, canvas.y + 300, { steps: 8 });
      await page.mouse.up();
      await sleep(120);
      await clickTest(page, 'tab-layers');
      const pages = await page.$$('[data-testid="page-row"]');
      await pages[0]!.click();
      await sleep(150);
      check('back on the first page', await has(page, `[data-bogen-id="${instanceId}"]`));

      // A second browser sees it all, and a main edit updates instances live.
      const other = await browser.createBrowserContext();
      const second = await open(other, a.localUrl(), fileId);
      await until('second browser sync', async () => (await canvasTexts(second, 'Hello')) === 3);
      check('a second browser context sees the instances', (await canvasTexts(second, 'Hello')) === 3);
      const r = await box(page, `[data-bogen-id="${textId}"]`);
      await page.mouse.click(r.cx, r.cy, { count: 2 });
      await sleep(120);
      await key(page, 'Control+a');
      await page.keyboard.type('Edited main');
      await sleep(60);
      await page.mouse.click(canvas.x + 800, canvas.y + 600);
      await sleep(150);
      check('a main edit updates its instances here', (await textOf(page, `${instanceId}/${textId}`)) === 'Edited main', await textOf(page, `${instanceId}/${textId}`));
      const live = await until('second browser instance', async () => (await canvasTexts(second, 'Edited main')) === 3);
      check('a main edit updates the instances in another browser, live', live, await canvasTexts(second, 'Edited main'));
      await shot(second, '03-second-browser');
      const secondPages = await second.$$('[data-testid="page-row"]');
      await secondPages[1]!.click();
      await sleep(200);
      check('and on the other page of the file', (await canvasTexts(second, 'Edited main')) === 1, await canvasTexts(second, 'Edited main'));
      await secondPages[0]!.click();
      await sleep(150);
      await selectRow(page, mainId!);
      await fill(page, 'insp-width', '240');
      await until('width follows', async () => (await box(second, `[data-bogen-id="${instanceId}"]`)).w > 230);
      const widths = await Promise.all([box(page, `[data-bogen-id="${instanceId}"]`), box(second, `[data-bogen-id="${instanceId}"]`)]);
      check('a main size change reaches both browsers', widths[0].w > 230 && widths[1].w > 230, widths.map((w) => w.w));

      // 2. Overrides: text by double clicking in, undo of it, a fill, hide, reset, detach.
      await page.bringToFront();
      const inst = await box(page, `[data-bogen-id="${instanceId}"]`);
      const inner = await box(page, `[data-bogen-id="${instanceId}/${textId}"]`);
      await page.mouse.click(inner.cx, inner.cy);
      await sleep(60);
      await page.mouse.click(inner.cx, inner.cy, { count: 2 });
      await sleep(100);
      check('double click drills into an instance', (await page.$eval('[data-testid="insp-name"]', (e) => (e as HTMLInputElement).value)) === 'Hello' || (await has(page, '[data-testid="overrides-empty"]')));
      await page.mouse.click(inner.cx, inner.cy, { count: 2 });
      await sleep(120);
      await key(page, 'Control+a');
      await page.keyboard.type('Only here');
      await sleep(40);
      await page.mouse.click(canvas.x + 800, canvas.y + 600);
      await sleep(150);
      check('typing in an instance overrides it', (await textOf(page, `${instanceId}/${textId}`)) === 'Only here', await textOf(page, `${instanceId}/${textId}`));
      check('the main keeps its text', (await textOf(page, textId!)) === 'Edited main');
      await until('other browser sees override', async () => (await canvasTexts(second, 'Only here')) === 1);
      check('the other browser sees the override', (await canvasTexts(second, 'Only here')) === 1);
      await key(page, 'Control+z');
      await sleep(120);
      check('undo takes back the override', (await textOf(page, `${instanceId}/${textId}`)) === 'Edited main', await textOf(page, `${instanceId}/${textId}`));
      await key(page, 'Control+Shift+z');
      await sleep(120);
      check('redo brings it back', (await textOf(page, `${instanceId}/${textId}`)) === 'Only here');
      await page.mouse.click(inst.cx, inst.y + 4);
      await sleep(80);
      await until('instance section', () => has(page, '[data-testid="instance-detach"]'));
      check('the inspector shows the instance', await has(page, '[data-testid="instance-detach"]'));
      const rows = await page.$$eval('[data-testid="override-row"]', (els) => els.map((e) => (e as HTMLElement).dataset.field));
      check('the inspector lists what is overridden', rows.includes('text'), rows);
      await shot(page, '04-overrides');
      await clickTest(page, 'override-reset');
      await sleep(80);
      check('resetting one override goes back to the main', (await textOf(page, `${instanceId}/${textId}`)) === 'Edited main');

      await expandRow(page, instanceId!);
      const row = await page.$(`[data-layer="${instanceId}/${textId}"]`);
      check('the list opens an instance on its inside', Boolean(row));
      await row!.hover();
      const hide = await page.$(`[data-layer="${instanceId}/${textId}"] [data-testid="layer-hide"]`);
      await hide!.click();
      await sleep(80);
      check('hiding a child hides it in this instance only', (await page.$eval(`[data-bogen-id="${instanceId}/${textId}"]`, (e) => getComputedStyle(e).display)) === 'none' && (await page.$eval(`[data-bogen-id="${textId}"]`, (e) => getComputedStyle(e).display)) !== 'none');
      await selectRow(page, instanceId!);
      await clickTest(page, 'overrides-reset-all');
      await sleep(80);
      check('reset all shows the main again', (await page.$eval(`[data-bogen-id="${instanceId}/${textId}"]`, (e) => getComputedStyle(e).display)) !== 'none');
      check('and leaves nothing listed', await has(page, '[data-testid="overrides-empty"]'));

      // 3. Props.
      await selectRow(page, mainId!);
      await expandRow(page, mainId!);
      await selectRow(page, textId!);
      await clickTest(page, 'expose-text-add');
      await sleep(60);
      check('exposing text makes a prop', await has(page, '[data-testid="expose-text-remove"]'));
      await selectRow(page, instanceId!);
      await page.waitForSelector('[data-testid^="instance-prop-"]');
      const propId = await page.$eval('[data-testid^="instance-prop-"]', (e) => (e as HTMLElement).dataset.testid!);
      await fill(page, propId, 'From a prop');
      check('a text prop on an instance drives its layer', (await textOf(page, `${instanceId}/${textId}`)) === 'From a prop', await textOf(page, `${instanceId}/${textId}`));
      await shot(page, '05-props');

      // Variants.
      await selectRow(page, mainId!);
      await fill(page, 'variant-axis', 'size');
      await fill(page, 'variant-value', 'lg');
      await until('variant selected', async () => (await selected(page))[0] !== mainId);
      const [variantId] = await selected(page);
      check('add variant selects a copy', Boolean(variantId) && variantId !== mainId, variantId);
      await fill(page, 'insp-width', '400');
      await sleep(80);
      await clickTest(page, 'tab-assets');
      await sleep(250);
      check('a variant set shows both members', (await page.$$('[data-testid="asset-member"]')).length === 2);
      await shot(page, '06-variants');
      await selectRow(page, instanceId!);
      await page.waitForSelector('[data-testid="instance-prop-size"]');
      await page.select('[data-testid="instance-prop-size"]', 'lg');
      await sleep(120);
      check('a variant value switches the instance', (await box(page, `[data-bogen-id="${instanceId}"]`)).w > 380, (await box(page, `[data-bogen-id="${instanceId}"]`)).w);
      const kept = await page.$$eval(`[data-bogen-id^="${instanceId}/"]`, (els) => els.map((e) => e.textContent));
      check('its prop value stays through the switch', kept.includes('From a prop'), kept);
      await page.select('[data-testid="instance-prop-size"]', 'default');
      await sleep(120);
      check('and back', (await box(page, `[data-bogen-id="${instanceId}"]`)).w < 260);

      // Slot: mark a frame in the main, then an instance holds layers of its own there.
      await selectRow(page, mainId!);
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/html', '<div data-name="Slot frame" style="padding:4px;display:flex"><p data-name="Slot default">Default body</p></div>');
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await sleep(120);
      const [slotFrame] = await selected(page);
      await clickTest(page, 'slot-add');
      await sleep(60);
      check('a frame in a main can be marked as a slot', await has(page, '[data-testid="slot-name"]'));
      await until('instances show default', async () => await has(page, `[data-bogen-id="${instanceId}/${slotFrame}"]`));
      check('an instance shows the slot default', ((await textOf(page, `${instanceId}/${slotFrame}`)) ?? '') === 'Default body', await textOf(page, `${instanceId}/${slotFrame}`));
      await expandRow(page, instanceId!);
      await selectRow(page, `${instanceId}/${slotFrame}`);
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/html', '<p data-name="Own layer" style="margin:0">My own layer</p>');
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await sleep(150);
      check('pasting into the slot fills it for this instance', ((await textOf(page, `${instanceId}/${slotFrame}`)) ?? '') === 'My own layer', await textOf(page, `${instanceId}/${slotFrame}`));
      check('another instance keeps the default', (await canvasTexts(page, 'Default body')) >= 2, await canvasTexts(page, 'Default body'));
      await shot(page, '07-slot');
      await key(page, 'Control+z');
      await sleep(120);
      check('undo empties the slot', ((await textOf(page, `${instanceId}/${slotFrame}`)) ?? '') === 'Default body');

      // Dragging a layer onto the slot with the mouse fills it too.
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/html', '<div data-name="Loose" style="width:40px;height:20px;background:#f40"></div>');
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await sleep(150);
      await clickTest(page, 'tab-layers');
      const [loose] = await selected(page);
      const slotBox = await box(page, `[data-bogen-id="${instanceId}/${slotFrame}"]`);
      const looseBox = await box(page, `[data-bogen-id="${loose}"]`);
      await drag(page, looseBox.cx, looseBox.cy, slotBox.cx, slotBox.cy, 12);
      await sleep(150);
      const parentOfLoose = await page.$eval(`[data-bogen-id="${loose}"]`, (e) => (e.parentElement as HTMLElement).dataset.bogenId);
      check('a layer dragged onto the slot of an instance goes in it', parentOfLoose === `${instanceId}/${slotFrame}`, parentOfLoose);
      await shot(page, '07b-slot-drop');
      await key(page, 'Control+z');
      await sleep(150);
      if (await has(page, `[data-bogen-id="${loose}"]`)) await selectRow(page, loose!);
      if (await has(page, `[data-bogen-id="${loose}"]`)) await key(page, 'Delete');
      await sleep(100);

      // Copying keeps the link, and a style change on the instance is listed and can go.
      await selectRow(page, instanceId!);
      await key(page, 'Control+d');
      await sleep(150);
      const [copyId] = await selected(page);
      check('a duplicate is an instance too', await has(page, `[data-bogen-id="${copyId}/${textId}"]`), copyId);
      await fill(page, 'insp-width', '333');
      await sleep(100);
      check('a size on an instance overrides it alone', (await box(page, `[data-bogen-id="${copyId}"]`)).w === 333 && (await box(page, `[data-bogen-id="${mainId}"]`)).w < 300, (await box(page, `[data-bogen-id="${copyId}"]`)).w);
      check('and is listed', (await page.$$eval('[data-testid="override-row"]', (e) => e.map((x) => (x as HTMLElement).dataset.field))).includes('style.width'));
      await clickTest(page, 'overrides-reset-all');
      await sleep(100);
      check('reset all gives the main size back', (await box(page, `[data-bogen-id="${copyId}"]`)).w < 300);
      await key(page, 'Delete');
      await sleep(100);

      // Detach.
      await selectRow(page, instanceId!);
      await clickTest(page, 'instance-detach');
      await sleep(120);
      check('detach turns an instance into layers', !(await has(page, `[data-bogen-id="${instanceId}/${textId}"]`)) && (await has(page, `[data-bogen-id="${instanceId}"]`)));
      const textBefore = await page.$eval(`[data-bogen-id="${instanceId}"]`, (e) => e.textContent);
      await key(page, 'Control+z');
      await sleep(120);
      check('undo links it again', await has(page, `[data-bogen-id="${instanceId}/${textId}"]`), textBefore);
      await second.close();
      await other.close();

      // 6. Code panel.
      await selectRow(page, mainId!);
      await clickTest(page, 'tab-code');
      await clickTest(page, 'code-mode-react');
      await until('code', async () => (await page.$eval('[data-testid="code-output"]', (e) => e.textContent ?? '')).includes('export interface'));
      const code = await page.$eval('[data-testid="code-output"]', (e) => e.textContent ?? '');
      check('the code panel writes a typed component', code.includes('export interface') && code.includes('size?:'), code.slice(0, 300));
      await shot(page, '08-code');
      await clickTest(page, 'code-mode-tailwind');
      await sleep(200);
      const tailwind = await page.$eval('[data-testid="code-output"]', (e) => e.textContent ?? '');
      check('and in Tailwind mode', tailwind.includes('className={['), tailwind.slice(0, 300));
      await selectRow(page, instanceId!);
      await clickTest(page, 'tab-code');
      await sleep(200);
      const usage = await page.$eval('[data-testid="code-output"]', (e) => e.textContent ?? '');
      check('an instance comes out as a usage', /<\w+ /.test(usage) && usage.includes('export function'), usage.slice(-300));
      await clickTest(page, 'tab-design');

      // 7/8. Tokens with modes, from the panel.
      await clickTest(page, 'tab-tokens');
      await fill(page, 'token-new-name', 'surface');
      await fill(page, 'token-new-value', 'rgb(255, 255, 255)');
      await sleep(80);
      if (!(await has(page, '[data-token="surface"]'))) await clickTest(page, 'token-add');
      await sleep(80);
      await clickTest(page, 'mode-add');
      await page.keyboard.type('dark');
      await page.keyboard.press('Enter');
      await sleep(120);
      check('adding a mode names the base one too', (await page.$$eval('[data-testid^="token-mode-"]', (e) => e.map((x) => x.textContent))).join() === 'light,dark', await page.$$eval('[data-testid^="token-mode-"]', (e) => e.map((x) => x.textContent)));
      check('a new mode opens for editing', await page.$eval('[data-testid="token-mode-dark"]', (e) => e.classList.contains('is-active')));
      const colorInput = await page.$('[data-testid="token-color-surface"] input, [data-testid="token-color-surface"]');
      check('the token row is there', Boolean(colorInput));
      await shot(page, '09-tokens-modes');
      await clickTest(page, 'tab-layers');
      await selectRow(page, mainId!);
      await clickTest(page, 'tab-design');

      // 9. Text styles.
      await selectRow(page, textId!);
      await page.waitForSelector('[data-testid="text-style-add"]');
      await fill(page, 'type-size', '20');
      await clickTest(page, 'text-style-add');
      await page.keyboard.type('Heading One');
      await page.keyboard.press('Enter');
      await sleep(150);
      check('a text style can be made from a layer', (await page.$eval('[data-testid="text-style"]', (e) => (e as HTMLSelectElement).value)) === 'heading-one', await page.$eval('[data-testid="text-style"]', (e) => (e as HTMLSelectElement).value));
      check('the layer writes its class', await page.$eval(`[data-bogen-id="${textId}"]`, (e) => e.className.includes('ts-heading-one')));
      check('instances show it too', await page.$eval(`[data-bogen-id="${instanceId}/${textId}"]`, (e) => e.className.includes('ts-heading-one')));
      await shot(page, '10-text-style');

      // 10. Icons.
      await clickTest(page, 'tool-icons');
      await page.waitForSelector('[data-testid="icon-cell"]', { timeout: 10000 });
      await page.keyboard.type('settings');
      await sleep(150);
      await shot(page, '11-icons');
      await page.waitForSelector('[data-icon="settings"]');
      await page.click('[data-icon="settings"]');
      await sleep(150);
      const [iconId] = await selected(page);
      check('the picker inserts an editable vector layer', await page.$eval(`[data-bogen-id="${iconId}"]`, (e) => Boolean(e.querySelector('svg path'))), iconId);
      check('and it is selected, as a vector', await has(page, '[data-section="Vector"], [data-section="Fill"]'));
      await key(page, 'Delete');

      // Deleting a main keeps the instances looking the same.
      await selectRow(page, variantId!);
      await key(page, 'Delete');
      await sleep(100);
      check('deleting a variant keeps the set', await has(page, `[data-bogen-id="${instanceId}/${textId}"]`));
      await page.close();
    }

    if (run('modes')) {
      // Mode toggle on an artboard and a page, read back from what the browser computes.
      const fileId = await newFile(a, 'Modes');
      const room = await a.rooms.get(fileId);
      const { doc } = room;
      const pageId = doc.getPages()[0]!.id;
      let board = '';
      doc.transact(() => {
        doc.setToken('bg', 'color', 'rgb(250, 250, 250)');
        doc.setToken('ink', 'color', 'rgb(20, 20, 20)');
        board = doc.insert(pageId, { type: 'frame', name: 'Board', artboard: true, style: { position: 'absolute', left: '40px', top: '40px', width: '300px', height: '200px', backgroundColor: 'var(--bg)', color: 'var(--ink)' } });
      }, 'seed');
      const page = await open(browser, a.localUrl(), fileId);
      await clickTest(page, 'tab-tokens');
      await clickTest(page, 'mode-add');
      await page.keyboard.type('dark');
      await page.keyboard.press('Enter');
      await sleep(150);
      await page.waitForSelector('[data-testid="token-color-bg"]');
      const editHex = await page.$('[data-token="bg"] input.field-input:not([data-testid^="token-name"])');
      if (editHex) {
        await editHex.click({ count: 3 });
        await key(page, 'Control+a');
        await page.keyboard.type('rgb(10, 10, 10)');
        await page.keyboard.press('Enter');
        await sleep(100);
      }
      const dark = doc.getTokens().find((t) => t.name === 'bg');
      check('editing a token in a mode writes that mode only', dark?.modes?.dark === 'rgb(10, 10, 10)' && dark.value === 'rgb(250, 250, 250)', dark);
      const bg = () => page.$eval(`[data-bogen-id="${board}"]`, (e) => getComputedStyle(e).backgroundColor);
      check('the artboard shows the base value', (await bg()) === 'rgb(250, 250, 250)', await bg());
      await page.select('[data-testid="token-page-mode"]', 'dark');
      await sleep(120);
      check('the page toggle in the tokens panel switches the page', (await bg()) === 'rgb(10, 10, 10)', await bg());
      await shot(page, '12-page-mode');
      await page.select('[data-testid="token-page-mode"]', '__inherit');
      await sleep(120);
      await selectRow(page, board);
      await clickTest(page, 'tab-design');
      await page.waitForSelector('[data-testid="insp-mode-dark"]');
      await clickTest(page, 'insp-mode-dark');
      await sleep(120);
      check('the toggle in the inspector switches one artboard', (await bg()) === 'rgb(10, 10, 10)', await bg());
      await key(page, 'Control+z');
      await sleep(120);
      check('undo takes the mode back', (await bg()) === 'rgb(250, 250, 250)', await bg());
      await page.mouse.click(1100, 900);
      await sleep(100);
      await page.waitForSelector('[data-testid="page-mode-dark"]');
      await clickTest(page, 'page-mode-dark');
      await sleep(120);
      check('with nothing selected the inspector switches the page', (await bg()) === 'rgb(10, 10, 10)', await bg());
      await page.close();
    }

    if (run('peer')) {
      // Two servers, paired for real, one browser on each.
      const info = (await (await post(a, '/api/peers/pair', { insecure: true })).json()) as { url: string; token: string };
      const added = await post(b, '/api/peers', { url: info.url, token: info.token, insecure: true });
      check('two servers pair', added.status === 201, added.status);
      await until('peers connected', () => a.peers.status().some((p) => p.state === 'connected') && b.peers.status().some((p) => p.state === 'connected'));
      const fileId = await newFile(a, 'Synced');
      const room = await a.rooms.get(fileId);
      const { doc } = room;
      const pageId = doc.getPages()[0]!.id;
      let mainId = '';
      let labelId = '';
      let instanceId = '';
      doc.transact(() => {
        mainId = doc.insert(pageId, { type: 'frame', name: 'Tag', style: { position: 'absolute', left: '40px', top: '40px', width: '200px', padding: '8px', backgroundColor: 'rgb(200, 220, 255)' }, children: [{ type: 'text', tag: 'p', name: 'Label', text: 'On A', style: {} }] });
      }, 'seed');
      labelId = doc.rawKids(mainId)[0]!;
      createComponent(doc, mainId, {}, 'seed');
      instanceId = createInstance(doc, mainId, pageId, { style: { position: 'absolute', left: '300px', top: '40px' } }, 'seed');
      const onA = await open(browser, a.localUrl(), fileId);
      await until('file on B', () => b.storage.get(fileId) !== undefined, 8000);
      const onB = await open(browser, b.localUrl(), fileId);
      const synced = await until('instance on B', async () => (await textOf(onB, `${instanceId}/${labelId}`)) === 'On A', 10000);
      check('an instance arrives on the other server', synced, await textOf(onB, `${instanceId}/${labelId}`));
      await onA.bringToFront();
      const r = await box(onA, `[data-bogen-id="${labelId}"]`);
      await onA.mouse.click(r.cx, r.cy, { count: 2 });
      await sleep(120);
      await key(onA, 'Control+a');
      await onA.keyboard.type('Main edit on A');
      await onA.mouse.click(1000, 800);
      const reached = await until('main edit reaches B', async () => (await textOf(onB, `${instanceId}/${labelId}`)) === 'Main edit on A', 10000);
      check('a main edit on one server updates the instance in a browser on the other', reached, await textOf(onB, `${instanceId}/${labelId}`));
      await onB.bringToFront();
      const inB = await box(onB, `[data-bogen-id="${instanceId}/${labelId}"]`);
      await onB.mouse.click(inB.cx, inB.cy);
      await sleep(60);
      await onB.mouse.click(inB.cx, inB.cy, { count: 2 });
      await sleep(100);
      await onB.mouse.click(inB.cx, inB.cy, { count: 2 });
      await sleep(120);
      await key(onB, 'Control+a');
      await onB.keyboard.type('Override on B');
      await onB.mouse.click(1000, 800);
      const back = await until('override reaches A', async () => (await textOf(onA, `${instanceId}/${labelId}`)) === 'Override on B', 10000);
      check('an override on the other server comes back', back, await textOf(onA, `${instanceId}/${labelId}`));
      check('and the main there is untouched', (await textOf(onA, labelId)) === 'Main edit on A');
      await shot(onB, '13-peer');
      await onA.close();
      await onB.close();
    }

    if (run('old')) {
      // A file as an older version wrote it: nothing here knows about components, modes or styles.
      const fileId = await newFile(a, 'Old');
      const room = await a.rooms.get(fileId);
      const y = room.doc.y;
      const pageId = room.doc.getPages()[0]!.id;
      y.transact(() => {
        const nodes = y.getMap<Y.Map<unknown>>('nodes');
        const make = (id: string, parent: string, order: string, fields: Record<string, unknown>, style: Record<string, string>) => {
          const m = new Y.Map<unknown>();
          m.set('type', 'frame');
          m.set('name', id);
          m.set('parent', parent);
          m.set('order', order);
          m.set('tag', 'div');
          const s = new Y.Map<string>();
          for (const [k, v] of Object.entries(style)) s.set(k, v);
          m.set('style', s);
          for (const [k, v] of Object.entries(fields)) m.set(k, v);
          nodes.set(id, m);
        };
        make('oldboard', pageId, 'a0', { artboard: true }, { position: 'absolute', left: '60px', top: '60px', width: '400px', height: '240px', backgroundColor: 'rgb(240, 240, 230)' });
        make('oldtext', 'oldboard', 'a0', { type: 'text', tag: 'h1', text: 'Written long ago' }, { color: 'var(--old-ink)', fontSize: '28px' });
        const token = new Y.Map<unknown>();
        token.set('kind', 'color');
        token.set('value', 'rgb(1, 2, 3)');
        y.getMap<Y.Map<unknown>>('tokens').set('old-ink', token);
      }, 'old');
      const page = await open(browser, a.localUrl(), fileId);
      await page.waitForSelector('[data-bogen-id="oldtext"]');
      check('an old document opens', (await textOf(page, 'oldtext')) === 'Written long ago');
      check('its tokens still apply', (await page.$eval('[data-bogen-id="oldtext"]', (e) => getComputedStyle(e).color)) === 'rgb(1, 2, 3)');
      await selectRow(page, 'oldtext');
      check('a plain layer shows nothing about components', !(await has(page, '[data-testid="instance-detach"]')) && !(await has(page, '[data-testid="expose-text-add"]')));
      await key(page, 'Control+Alt+k');
      await sleep(100);
      check('and can become a component now', await has(page, '[data-testid="main-instance-count"]'));
      await clickTest(page, 'tab-assets');
      await page.waitForSelector('[data-testid="asset-member"]');
      check('then shows in assets', (await page.$$('[data-testid="asset-member"]')).length === 1);
      await shot(page, '14-old-document');
      await page.close();
    }

    if (run('perf')) {
      const fileId = await newFile(a, 'Perf');
      const room = await a.rooms.get(fileId);
      const { doc } = room;
      const pageId = doc.getPages()[0]!.id;
      let mainId = '';
      doc.transact(() => {
        mainId = doc.insert(pageId, {
          type: 'frame', name: 'Card', artboard: false,
          style: { position: 'absolute', left: '0px', top: '-200px', width: '120px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px', backgroundColor: 'rgb(235, 240, 250)' },
          children: [
            { type: 'text', tag: 'h3', name: 'Title', text: 'Title', style: { margin: '0', fontSize: '12px' } },
            { type: 'text', tag: 'p', name: 'Body', text: 'Body', style: { margin: '0', fontSize: '10px' } },
            { type: 'frame', name: 'Row', style: { display: 'flex', gap: '2px' }, children: [
              { type: 'frame', name: 'Dot', style: { width: '8px', height: '8px', backgroundColor: 'rgb(10, 80, 200)' } },
              { type: 'text', tag: 'span', name: 'Meta', text: 'Meta', style: { fontSize: '10px' } },
            ] },
          ],
        });
      }, 'seed');
      createComponent(doc, mainId, {}, 'seed');
      const title = doc.rawKids(mainId)[0]!;
      doc.transact(() => {
        for (let i = 0; i < 500; i++) createInstance(doc, mainId, pageId, { style: { position: 'absolute', left: `${(i % 25) * 130}px`, top: `${Math.floor(i / 25) * 90}px` } });
      }, 'seed');
      const started = Date.now();
      const page = await open(browser, a.localUrl(), fileId);
      await page.waitForFunction((want: number) => document.querySelectorAll('.bogen-world [data-bogen-id]').length >= want, { timeout: 90000, polling: 100 }, 3000);
      const domNodes = await page.$$eval('.bogen-world [data-bogen-id]', (e) => e.length);
      console.log(`perf: ${domNodes} layers on the canvas, opened in ${Date.now() - started} ms`);
      check('500 instances render', domNodes >= 3000, domNodes);

      // Edit to paint, through the real inspector field: from the key press to the frame after the last instance changed.
      await clickTest(page, 'tab-layers');
      const toEnd = () => page.$eval('[data-testid="layer-scroll"]', (e) => { e.scrollTop = e.scrollHeight; });
      await toEnd();
      await sleep(150);
      await expandRow(page, mainId);
      await toEnd();
      await sleep(150);
      await selectRow(page, title);
      const sample = async (label: string, type: () => Promise<void>) => {
        await page.evaluate((id: string) => {
          const w = window as unknown as { __t: { start: number; seen: number; painted: number; last: Element | null; obs?: MutationObserver } };
          w.__t = { start: 0, seen: 0, painted: 0, last: null };
          document.addEventListener('keydown', (e) => { if (e.key === 'Enter') w.__t.start = performance.now(); }, true);
          const all = document.querySelectorAll(`[data-bogen-id$="/${id}"]`);
          const last = all[all.length - 1]!;
          w.__t.obs = new MutationObserver(() => {
            if (!w.__t.start || w.__t.seen) return;
            w.__t.seen = performance.now();
            requestAnimationFrame(() => requestAnimationFrame(() => { w.__t.painted = performance.now(); }));
          });
          w.__t.obs.observe(last, { attributes: true, characterData: true, childList: true, subtree: true });
        }, title);
        await type();
        await page.waitForFunction(() => (window as unknown as { __t: { painted: number } }).__t.painted > 0, { timeout: 20000, polling: 20 });
        const t = await page.evaluate(() => {
          const w = window as unknown as { __t: { start: number; seen: number; painted: number; obs?: MutationObserver } };
          w.__t.obs?.disconnect();
          return { commit: w.__t.seen - w.__t.start, paint: w.__t.painted - w.__t.start };
        });
        console.log(`perf: ${label}: instances updated after ${t.commit.toFixed(1)} ms, painted after ${t.paint.toFixed(1)} ms`);
        return t;
      };
      const samples: { commit: number; paint: number }[] = [];
      for (let i = 0; i < 8; i++) samples.push(await sample(`font size edit ${i}`, () => fill(page, 'type-size', String(13 + i))));
      const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
      const commit = median(samples.map((s) => s.commit));
      const paint = median(samples.map((s) => s.paint));
      console.log(`perf: median of 8 main edits with 500 instances: ${commit.toFixed(1)} ms to update, ${paint.toFixed(1)} ms to paint`);
      check('a main edit with 500 instances stays under 100 ms to update', commit < 100, commit);

      // A burst, as scrubbing a value does: frame times while a main value changes every frame.
      const frames = await page.evaluate(() => new Promise<{ count: number; worst: number; median: number; over50: number }>((done) => {
        const out: number[] = [];
        let last = performance.now();
        const tick = (now: number) => {
          out.push(now - last);
          last = now;
          if (out.length < 90) requestAnimationFrame(tick);
          else {
            const sorted = [...out].sort((a, b) => a - b);
            done({ count: out.length, worst: sorted.at(-1)!, median: sorted[Math.floor(sorted.length / 2)]!, over50: out.filter((f) => f > 50).length });
          }
        };
        requestAnimationFrame(tick);
      }));
      console.log(`perf: idle frames, no edits: median ${frames.median.toFixed(1)} ms, worst ${frames.worst.toFixed(1)} ms`);
      const label = await page.$('[data-testid="type-size"]');
      const labelBox = await label?.evaluate((e) => {
        const r = e.closest('label')!.querySelector('.field-label')?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      });
      if (labelBox) {
        await page.evaluate(() => {
          const w = window as unknown as { __frames: number[]; __run: boolean };
          w.__frames = [];
          w.__run = true;
          let last = performance.now();
          const tick = (now: number) => {
            w.__frames.push(now - last);
            last = now;
            if (w.__run) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        const before = await page.metrics();
        await page.mouse.move(labelBox.x, labelBox.y);
        await page.mouse.down();
        for (let i = 1; i <= 40; i++) {
          await page.mouse.move(labelBox.x + i * 3, labelBox.y);
          await sleep(16);
        }
        await page.mouse.up();
        const scrub = await page.evaluate(() => {
          const w = window as unknown as { __frames: number[]; __run: boolean };
          w.__run = false;
          const sorted = [...w.__frames].sort((a, b) => a - b);
          return { count: sorted.length, median: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.floor(sorted.length * 0.95)]!, worst: sorted.at(-1)! };
        });
        const after = await page.metrics();
        const per = (key: 'ScriptDuration' | 'LayoutDuration' | 'RecalcStyleDuration' | 'TaskDuration') => ((after[key]! - before[key]!) * 1000 / 40).toFixed(1);
        console.log(`perf: main thread per change while scrubbing: script ${per('ScriptDuration')} ms, style ${per('RecalcStyleDuration')} ms, layout ${per('LayoutDuration')} ms, all tasks ${per('TaskDuration')} ms`);
        console.log(`perf: frames while scrubbing a main value, 40 changes on 500 instances: median ${scrub.median.toFixed(1)} ms, p95 ${scrub.p95.toFixed(1)} ms, worst ${scrub.worst.toFixed(1)} ms over ${scrub.count} frames`);
      }
      await shot(page, '15-perf-500');
      await page.close();
    }

    const real = errors.filter((e) => !/ResizeObserver/.test(e));
    check('no errors in any page', real.length === 0, real.slice(0, 10));
  } finally {
    await browser.close();
    await a.close();
    await b.close();
    rmSync(base1, { recursive: true, force: true });
    rmSync(base2, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exitCode = failures.length ? 1 : 0;
}

await main();
process.exit(process.exitCode ?? 0);
