/**
 * The editor's own chrome at many window sizes and UI scales, through the real editor, a real server and a sandboxed
 * browser with a mouse (no touch): the toolbar never overflows and keeps the file name readable, every command stays
 * reachable in the toolbar or its menus, panels that do not fit open as drawers with keyboard access and Escape, the
 * canvas keeps its minimum width, widths a person chose survive folding, dialogs and the prompt fit a low window, and
 * Home works small. Deterministic: a temporary home and stand-in CLIs, so no agent runs.
 *
 *   npm run build
 *   BOGEN_BROWSER=~/.local/bin/secure-chromium node --import tsx apps/editor/test/e2e/responsive-chrome.ts
 *
 * Screenshots go to the folder printed at the end.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type KeyInput, type Page } from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { writeFakeClis } from '../../../../packages/server/test/fake-cli.ts';
import { connectAgent } from '../../../../packages/server/test/helpers.ts';
import { CANVAS_MIN, chromeLayout } from '../../src/state/chrome-layout.ts';

const browserPath = process.env.BOGEN_BROWSER;
if (!browserPath) throw new Error('Set BOGEN_BROWSER to a browser with its sandbox on, such as ~/.local/bin/secure-chromium.');

const root = mkdtempSync(join(tmpdir(), 'bogen-chrome-'));
const shots = join(root, 'shots');
const bin = join(root, 'bin');
for (const d of [shots, bin]) mkdirSync(d, { recursive: true });
writeFakeClis(bin, join(root, 'cli.log'));
process.env.PATH = `${bin}:${process.env.PATH}`;

const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false });
await server.listen();
const base = server.localUrl();
const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, pipe: true, args: [`--secure-local-port=${new URL(base).port}`], defaultViewport: { width: 1440, height: 900 } });

let passed = 0;
const failures: string[] = [];
const errors: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) {
    passed++;
    console.log(`pass  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(50);
  }
  return false;
}
const exists = (page: Page, sel: string) => page.$(sel).then(Boolean);

const LONG = 'GitHub Traffic · Bar panel, quarterly review for the infrastructure team with every repository';
const entry = server.storage.create(LONG);
{
  const room = await server.rooms.get(entry.id);
  const pageId = room.doc.getPages()[0]!.id;
  const board = room.doc.insert(pageId, { type: 'frame', name: 'Dashboard', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '1200px', height: '800px', background: '#ffffff', display: 'flex', padding: '32px', gap: '16px' } });
  const title = room.doc.insert(board, { type: 'text', name: 'Title', tag: 'h1', text: 'Traffic', style: { fontSize: '40px', margin: '0' } });
  room.doc.addThread({ pageId, nodeId: title, x: 0, y: 0, author: 'Lena', text: 'Is this the weekly or the monthly view?' });
  room.doc.invalidate();
}
const TITLE_ID = (await server.rooms.get(entry.id)).doc.descendants((await server.rooms.get(entry.id)).doc.getPages()[0]!.id).find((n) => n.name === 'Title')!.id;

/** Panel widths a person dragged to: they must survive every fold. */
const CHOSEN = { leftWidth: 300, rightWidth: 320 };

async function open(width: number, height: number, scale: number, path = `#/file/${entry.id}?select=${TITLE_ID}`): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(`window.__name = (f) => f; try { localStorage.setItem('bogen-layout', ${JSON.stringify(JSON.stringify(CHOSEN))}); localStorage.setItem('bogen-settings', ${JSON.stringify(JSON.stringify({ uiScale: scale }))}); } catch {}`);
  page.on('pageerror', (e) => errors.push(`${width}x${height}@${scale}: ${String(e)}`));
  // A mouse, not a touch screen: a narrow desktop window stays the desktop editor.
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  await page.goto(`${base}/${path}`);
  return page;
}

/** Geometry of the chrome, measured in the page. */
function measure(page: Page) {
  return page.evaluate(() => {
    const box = (sel: string) => { const el = document.querySelector<HTMLElement>(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const toolbar = document.querySelector<HTMLElement>('[data-testid="toolbar"]');
    const tb = toolbar?.getBoundingClientRect();
    const outside = toolbar ? [...toolbar.querySelectorAll<HTMLElement>('button, a, input, .sync-status')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > tb!.right + 0.5 || r.left < tb!.left - 0.5);
    }).map((el) => el.dataset.testid ?? el.className) : [];
    const editorEl = document.querySelector<HTMLElement>('[data-testid="editor"]');
    return {
      docOverflow: document.documentElement.scrollWidth - innerWidth,
      toolbarOverflow: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : 0,
      outside,
      level: toolbar?.dataset.level,
      chrome: editorEl?.dataset.chrome,
      short: editorEl?.dataset.short !== undefined,
      name: box('[data-testid="file-name"]'),
      stage: box('main.stage'),
      phone: Boolean(document.querySelector('[data-testid="phone-file"]')),
    };
  });
}

/**
 * Opens or closes a panel's drawer from the control the toolbar shows for it: its own button, or its item in More at
 * the smallest level. Says which control has the focus back after Escape.
 */
async function toggleDrawer(page: Page, side: 'left' | 'right'): Promise<string> {
  if (await exists(page, `[data-testid="toolbar"] [data-testid="panel-toggle-${side}"]`)) {
    await page.click(`[data-testid="panel-toggle-${side}"]`);
    return `panel-toggle-${side}`;
  }
  await page.click('[data-testid="toolbar-more"]');
  await page.waitForSelector(`[data-testid="more-panel-${side}"]`, { timeout: 2000 });
  await page.click(`[data-testid="more-panel-${side}"]`);
  return 'toolbar-more';
}

/** Every command of the toolbar is a button in it or an item of one of its menus. */
async function reachable(page: Page): Promise<string[]> {
  const missing: string[] = [];
  const tools = ['move', 'hand', 'frame', 'rect', 'ellipse', 'line', 'text', 'pen', 'pencil', 'image', 'app-screen', 'icons', 'comment', 'shader', 'zoom'];
  const inToolbar = async (id: string) => exists(page, `[data-testid="toolbar"] [data-testid="${id}"]`);
  const hidden: string[] = [];
  for (const t of tools) if (!(await inToolbar(`tool-${t}`))) hidden.push(t);
  if (hidden.length) {
    await page.click('[data-testid="tools-more"]');
    for (const t of hidden) if (!(await exists(page, `[data-testid="tools-more-${t}"]`))) missing.push(`tool ${t}`);
    await page.keyboard.press('Escape');
    await wait(100);
  }
  const actions: [string, string][] = [['preview-open', 'more-preview'], ['checks-open', 'more-checks'], ['settings-open', 'more-settings'], ['toolbar-history', 'more-history'], ['minimal-toggle', 'more-minimal'], ['shortcuts-open', 'more-shortcuts'], ['undo', 'more-undo'], ['redo', 'more-redo'], ['zoom-level', 'more-zoom-in']];
  const needMenu: { direct: string; menu: string }[] = [];
  for (const [direct, menu] of actions) if (!(await inToolbar(direct))) needMenu.push({ direct, menu });
  if (needMenu.length) {
    if (!(await exists(page, '[data-testid="toolbar-more"]'))) return [...missing, ...needMenu.map((a) => a.direct)];
    await page.click('[data-testid="toolbar-more"]');
    for (const a of needMenu) if (!(await exists(page, `[data-testid="${a.menu}"]`))) missing.push(a.direct);
    await page.keyboard.press('Escape');
    await wait(100);
  }
  for (const p of ['prompt-toggle', 'home-link']) if (!(await inToolbar(p))) missing.push(p);
  // Me is in the toolbar, or in More at the smallest level.
  if (!(await inToolbar('me'))) {
    await page.click('[data-testid="toolbar-more"]');
    if (!(await exists(page, '[data-testid="more-me"]'))) missing.push('me');
    await page.keyboard.press('Escape');
    await wait(100);
  }
  return missing;
}

const SIZES: [number, number, number][] = [
  [1728, 1117, 1], [1440, 900, 1], [1280, 720, 1], [1280, 500, 1], [1024, 640, 1], [860, 540, 1], [640, 480, 1],
  [1440, 900, 1.5], [1024, 640, 1.25], [860, 540, 1.25], [640, 480, 1.25], [640, 480, 1.5],
  [1440, 900, 2], [1280, 720, 2],
];

try {
  for (const [w, h, scale] of SIZES) {
    const tag = `${w}x${h}@${scale}`;
    const page = await open(w, h, scale);
    await page.waitForSelector('[data-testid="toolbar"]', { timeout: 10_000 });
    await wait(400);
    const expected = chromeLayout({ width: w, height: h, scale, ...CHOSEN });
    const m = await measure(page);
    check(`${tag}: layout ${expected.mode}, toolbar ${expected.toolbar}`, m.chrome === expected.mode && m.level === expected.toolbar, m);
    check(`${tag}: nothing wider than the window`, m.docOverflow <= 0 && m.toolbarOverflow <= 1 && m.outside.length === 0, m);
    check(`${tag}: the file name stays readable`, (m.name?.width ?? 0) >= (scale === 1 && w >= 640 ? 120 : 64), m.name);
    check(`${tag}: the canvas keeps its minimum`, (m.stage?.width ?? 0) >= Math.min(CANVAS_MIN, w) - 1, m.stage);
    check(`${tag}: a mouse keeps the desktop editor`, !m.phone);
    const missing = await reachable(page);
    check(`${tag}: every toolbar command reachable`, missing.length === 0, missing);
    await page.screenshot({ path: join(shots, `${tag}.png`) });

    if (expected.left === 'drawer') {
      const control = await toggleDrawer(page, 'left');
      const opened = await until(() => exists(page, '[data-testid="panel-drawer-left"]'), 2000);
      const focusIn = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="panel-drawer-left"]')));
      const fits = await page.evaluate(() => { const r = document.querySelector('[data-testid="panel-drawer-left"]')!.getBoundingClientRect(); return r.right <= innerWidth - 39 && r.left >= 0; });
      await page.screenshot({ path: join(shots, `${tag}-drawer-left.png`) });
      await page.keyboard.press('Escape');
      const closed = await until(async () => !(await exists(page, '[data-testid="panel-drawer-left"]')), 2000);
      const back = await until(() => page.evaluate((id: string) => document.activeElement?.getAttribute('data-testid') === id, control), 2000);
      check(`${tag}: layers open as a drawer with the focus, leave the canvas a strip, Escape closes and gives the focus back`, opened && focusIn && fits && closed && back, { opened, focusIn, fits, closed, back });
      // The shortcut does the same; and asking for a left tab opens it.
      await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.press('1'); await page.keyboard.up('Alt'); await page.keyboard.up('Control');
      const byKey = await until(() => exists(page, '[data-testid="panel-drawer-left"]'), 2000);
      await page.keyboard.press('Escape');
      check(`${tag}: Ctrl+Alt+1 opens the layers drawer`, byKey);
    }
    if (expected.right === 'drawer') {
      await toggleDrawer(page, 'right');
      const inspector = await until(() => exists(page, '[data-testid="panel-drawer-right"] [data-testid="inspector"]'), 3000);
      check(`${tag}: the selected layer's inspector opens as a drawer`, inspector);
      await page.screenshot({ path: join(shots, `${tag}-drawer-right.png`) });
      await toggleDrawer(page, 'right');
      check(`${tag}: its button closes it again`, await until(async () => !(await exists(page, '[data-testid="panel-drawer-right"]')), 2000));
    } else {
      check(`${tag}: the inspector sits beside the canvas`, await exists(page, '.panel-slot[data-dock="docked"] [data-testid="inspector"]'));
    }

    if (expected.short) {
      // Low windows: Settings fits with its actions; the prompt stays inside the canvas.
      await page.click(await exists(page, '[data-testid="toolbar"] [data-testid="settings-open"]') ? '[data-testid="settings-open"]' : '[data-testid="toolbar-more"]');
      if (await exists(page, '[data-testid="more-settings"]')) await page.click('[data-testid="more-settings"]');
      await page.waitForSelector('[data-testid="settings-dialog"]', { timeout: 3000 });
      const dialog = await page.evaluate(() => {
        const d = document.querySelector('[data-testid="settings-dialog"]')!.getBoundingClientRect();
        const foot = document.querySelector('[data-testid="settings-dialog"] .settings-foot')?.getBoundingClientRect();
        return { top: d.top, bottom: d.bottom, right: d.right, foot: foot ? foot.bottom : null, h: innerHeight, w: innerWidth };
      });
      check(`${tag}: Settings fits the window with its actions visible`, dialog.top >= 0 && dialog.bottom <= dialog.h && dialog.right <= dialog.w && (dialog.foot === null || dialog.foot <= dialog.h), dialog);
      await page.screenshot({ path: join(shots, `${tag}-settings.png`) });
      await page.keyboard.press('Escape');
      await wait(150);
      await page.click('[data-testid="prompt-toggle"]');
      await page.waitForSelector('[data-testid="prompt"]', { timeout: 3000 });
      const prompt = await page.evaluate(() => {
        const p = document.querySelector('[data-testid="prompt"]')!.getBoundingClientRect();
        const send = document.querySelector('[data-testid="prompt-send"], [data-testid="prompt-input"]')!.getBoundingClientRect();
        return { inside: p.left >= -0.5 && p.right <= innerWidth + 0.5 && p.top >= 0 && p.bottom <= innerHeight + 0.5 && send.bottom <= innerHeight + 0.5, p: [p.left, p.top, p.right, p.bottom], w: innerWidth, h: innerHeight };
      });
      check(`${tag}: the chat and its field stay inside the window`, prompt.inside, prompt);
      await page.screenshot({ path: join(shots, `${tag}-prompt.png`) });
      await page.click('[data-testid="prompt-toggle"]');
    }
    await page.close();
  }

  // ---------------------------------------------------------------- the window changes while the file is open
  {
    const page = await open(1440, 900, 1);
    await page.waitForSelector('[data-testid="toolbar"]');
    const seen: string[] = [];
    for (const [w, h] of [[1440, 900], [1100, 700], [860, 540], [700, 500], [600, 480], [1024, 640], [1440, 900]] as const) {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
      await wait(250);
      const m = await measure(page);
      const want = chromeLayout({ width: w, height: h, scale: 1, ...CHOSEN });
      seen.push(`${w}:${m.chrome}/${m.level}`);
      if (m.chrome !== want.mode || m.level !== want.toolbar || m.docOverflow > 0) check(`live ${w}x${h}`, false, m);
    }
    check('live resizing follows the window both ways', true, seen.join(' '));
    // Folded and unfolded, the widths a person chose are still theirs.
    const widths = await page.evaluate(() => {
      const slots = [...document.querySelectorAll<HTMLElement>('.panel-slot[data-dock="docked"]')].map((s) => Math.round(s.getBoundingClientRect().width));
      return { slots, stored: JSON.parse(localStorage.getItem('bogen-layout') ?? '{}') };
    });
    check('chosen panel widths survive folding', widths.slots[0] === CHOSEN.leftWidth && widths.slots[1] === CHOSEN.rightWidth && widths.stored.leftWidth === CHOSEN.leftWidth && widths.stored.rightWidth === CHOSEN.rightWidth, widths);
    // A drawer open while the window grows closes into its docked place.
    await page.setViewport({ width: 860, height: 540, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
    await wait(250);
    await toggleDrawer(page, 'left');
    await until(() => exists(page, '[data-testid="panel-drawer-left"]'), 2000);
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
    check('a drawer becomes a docked panel again when there is room', await until(async () => !(await exists(page, '[data-testid="panel-drawer-left"]')) && (await page.$$('.panel-slot[data-dock="docked"]')).length === 2, 2000));
    // The long file name is complete in the More menu.
    await page.setViewport({ width: 860, height: 540, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
    await wait(250);
    await page.click('[data-testid="toolbar-more"]');
    check('the More menu names the whole file', (await page.$eval('[data-testid="toolbar-more-file"]', (e) => e.textContent ?? '').catch(() => '')) === LONG);
    await page.keyboard.press('Escape');
    // Show comments (a right tab) from a shortcut while the inspector is a drawer opens it. At 600 px the inspector
    // still docks (600 - 360 = 240 px >= the 200 px minimum); at 520 it is a drawer.
    await page.setViewport({ width: 520, height: 480, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
    await wait(250);
    check('at 520 px the inspector is a closed drawer', (await page.$eval('#panel-drawer-right', (e) => (e as HTMLElement).dataset.dock).catch(() => '')) === 'stowed');
    await page.keyboard.down('Alt'); await page.keyboard.press('c'); await page.keyboard.up('Alt');
    check('asking for comments opens the inspector drawer on that tab', await until(() => exists(page, '[data-testid="panel-drawer-right"]'), 2000));
    await page.close();
  }

  // ---------------------------------------------------------------- panels keep what they hold
  {
    const page = await open(1440, 900, 1);
    await page.waitForSelector('[data-testid="toolbar"]');
    await wait(300);
    const resize = async (w: number, h: number) => { await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: false, hasTouch: false }); await wait(300); };
    const altC = async () => { await page.keyboard.down('Alt'); await page.keyboard.press('c'); await page.keyboard.up('Alt'); await wait(150); };
    await altC();
    await page.waitForSelector('[data-testid="thread"]', { timeout: 4000 });
    await page.click('[data-testid="thread"]');
    await page.waitForSelector('[data-testid="thread-reply"]', { timeout: 4000 });
    const DRAFT = 'Monthly, and the axis should start at zero';
    await page.type('[data-testid="thread-reply"]', DRAFT);
    const reply = () => page.$eval('[data-testid="thread-reply"]', (e) => (e as HTMLTextAreaElement).value).catch(() => null);
    // Narrow: the inspector becomes a closed drawer; its panel is stowed, not unmounted. Nothing else happens in
    // between: no click on the canvas, which would close the thread for reasons of its own.
    await resize(520, 480);
    const stowed = await page.evaluate(() => { const el = document.querySelector<HTMLElement>('[data-testid="panel-slot-right"]'); return el ? { hidden: el.hidden, inert: el.inert, focusable: el.querySelectorAll('textarea, button').length > 0 } : null; });
    check('a closed drawer keeps its panel, hidden and inert', Boolean(stowed?.hidden && stowed.inert && stowed.focusable), stowed);
    await toggleDrawer(page, 'right');
    await page.waitForSelector('[data-testid="panel-drawer-right"]', { timeout: 3000 });
    check('an unsent reply survives narrowing and opening the drawer', (await reply()) === DRAFT, await reply());
    await page.keyboard.press('Escape');
    await toggleDrawer(page, 'right');
    check('and closing and opening it again', (await reply()) === DRAFT, await reply());
    await resize(1440, 900);
    check('and widening the window again', (await reply()) === DRAFT && (await page.$$('.panel-slot[data-dock="docked"]')).length === 2, await reply());

    // Comments is already the tab: a pin and Alt+C must still open the closed drawer.
    await resize(520, 480);
    check('Comments already chosen: Alt+C opens the closed drawer', await (async () => { await altC(); return until(() => exists(page, '[data-testid="panel-drawer-right"]'), 2000); })());
    await page.keyboard.press('Escape');
    await until(async () => !(await exists(page, '[data-testid="panel-drawer-right"]')), 2000);
    // The pin of the thread that is already open: nothing changes in the store, and the drawer must open anyway.
    const pin = await page.$('.ov-pin');
    if (pin) {
      await pin.click();
      check('a comment pin opens the closed drawer on its thread', await until(() => exists(page, '[data-testid="panel-drawer-right"] [data-testid="thread-reply"]'), 3000));
    } else check('a comment pin opens the closed drawer on its thread', false, 'no pin on the canvas');
    await page.close();
  }

  // ---------------------------------------------------------------- a working agent's outline stays on its layer
  {
    const page = await open(1440, 900, 1, `#/file/${entry.id}`);
    await page.waitForSelector('[data-testid="toolbar"]');
    await wait(500);
    const agent = await connectAgent(base, 'outline-check');
    // Each edit marks the layer as being worked on for a few seconds. A colour keeps its geometry, so what is measured
    // after a camera move is the camera tracking alone; the edit and its outline are settled before the move.
    let hue = 0;
    const work = async () => {
      hue = (hue + 37) % 360;
      await agent.callTool({ name: 'layer_style', arguments: { file_id: entry.id, node_ids: [TITLE_ID], style: { color: `hsl(${hue} 40% 30%)` } } });
      await until(() => exists(page, '[data-testid="agent-outline"]'), 3000);
      await wait(200);
    };
    const offset = () => page.evaluate((id: string) => {
      const o = document.querySelector('[data-testid="agent-outline"]')?.getBoundingClientRect();
      const l = document.querySelector(`.bogen-world [data-bogen-id="${id}"]`)?.getBoundingClientRect();
      if (!o || !l) return null;
      return Math.max(Math.abs(o.left - l.left), Math.abs(o.top - l.top), Math.abs(o.width - l.width), Math.abs(o.height - l.height));
    }, TITLE_ID);
    const steps: [string, () => Promise<void>][] = [
      ['at rest', async () => {}],
      ['after a pan', async () => { await page.mouse.move(700, 400); await page.mouse.wheel({ deltaX: 180, deltaY: 140 }); }],
      ['after a zoom', async () => { await page.mouse.move(700, 400); await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: -240 }); await page.keyboard.up('Control'); }],
      ['after Fit screen', async () => { await page.keyboard.down('Shift'); await page.keyboard.press('3'); await page.keyboard.up('Shift'); }],
      ['after a window resize', async () => { await page.setViewport({ width: 1024, height: 640, deviceScaleFactor: 1, isMobile: false, hasTouch: false }); }],
    ];
    for (const [label, step] of steps) {
      await work();
      await step();
      // The same frame: no wait for React. Then again after things settle.
      const now = await offset();
      await wait(250);
      const later = await offset();
      check(`the working agent's outline stays on its layer ${label}`, now !== null && now <= 2 && later !== null && later <= 2, { now, later });
    }
    // An edit that changes the layer's size: the outline follows once the canvas has laid the change out.
    await agent.callTool({ name: 'layer_style', arguments: { file_id: entry.id, node_ids: [TITLE_ID], style: { fontSize: '56px', letterSpacing: '2px' } } });
    const settled = await until(async () => { const o = await offset(); return o !== null && o <= 2; }, 2000);
    check('after an agent edit resizes the layer, its outline settles on the new size', settled, await offset());
    await page.screenshot({ path: join(shots, 'agent-outline.png') });
    await agent.close();
    await page.close();
  }

  // ---------------------------------------------------------------- fit the screen you work on
  {
    const many = server.storage.create('Many screens');
    const room = await server.rooms.get(many.id);
    const pageId = room.doc.getPages()[0]!.id;
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(room.doc.insert(pageId, { type: 'frame', name: `Screen ${i + 1}`, artboard: true, style: { position: 'absolute', left: `${(i % 10) * 1600}px`, top: `${Math.floor(i / 10) * 1100}px`, width: '1440px', height: '900px', background: '#ffffff' } }));
    const tall = room.doc.insert(pageId, { type: 'frame', name: 'Long page', artboard: true, style: { position: 'absolute', left: '0px', top: '3400px', width: '1440px', height: '7200px', background: '#f6f6f6' } });
    const child = room.doc.insert(ids[12]!, { type: 'frame', name: 'Card in 13', style: { width: '200px', height: '120px', background: '#dddddd' } });
    room.doc.invalidate();
    let page = await open(1440, 900, 1, `#/file/${many.id}?select=${child}`);
    await page.waitForSelector('[data-testid="toolbar"]');
    await wait(600);
    const geo = (id: string) => page.evaluate((nid: string) => {
      const b = document.querySelector(`.bogen-world [data-bogen-id="${nid}"]`)!.getBoundingClientRect();
      const st = document.querySelector('main.stage')!.getBoundingClientRect();
      const drawer = document.querySelector('.panel-drawer:not([hidden])')?.getBoundingClientRect();
      const left = drawer && drawer.left <= st.left + 1 ? drawer.right : st.left;
      const right = drawer && drawer.left > st.left + 1 ? drawer.left : st.right;
      return { inside: b.left >= left - 1 && b.right <= right + 1 && b.top >= st.top - 1 && b.bottom <= st.bottom + 1, fillW: b.width / (right - left), fillH: b.height / st.height, top: b.top - st.top, b: [b.left, b.top, b.width, b.height], area: [left, right] };
    }, id);
    const key = async (k: KeyInput) => { await page.keyboard.down('Shift'); await page.keyboard.press(k); await page.keyboard.up('Shift'); await wait(250); };
    const holding = () => page.$eval('[data-testid="zoom-level"]', (e) => (e as HTMLElement).dataset.autofit ?? '').catch(() => '');

    await key('3');
    let g = await geo(ids[12]!);
    check('Fit screen: a selected child fits its own artboard, whole and large', g.inside && Math.max(g.fillW, g.fillH) > 0.8 && (await holding()) === 'screen', g);
    // Nothing selected: the artboard most in view, not all 31.
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await wait(150);
    await key('3');
    g = await geo(ids[12]!);
    check('Fit screen with nothing selected: the artboard in view, not every artboard', g.inside && Math.max(g.fillW, g.fillH) > 0.8, g);
    await key('2');
    g = await geo(ids[12]!);
    check('Fit selection with nothing selected stays on the artboard in view', g.inside && Math.max(g.fillW, g.fillH) > 0.8, g);

    // The window and the panels change: the fit holds.
    await key('3');
    for (const [w, h] of [[1024, 640], [860, 540], [1280, 500]] as const) {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
      await wait(350);
      g = await geo(ids[12]!);
      check(`the fit holds at ${w}x${h}`, g.inside && Math.max(g.fillW, g.fillH) > 0.8 && (await holding()) === 'screen', g);
    }
    await page.setViewport({ width: 860, height: 540, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
    await wait(300);
    await toggleDrawer(page, 'left');
    await wait(350);
    g = await geo(ids[12]!);
    check('an open drawer moves the fitted artboard beside it', g.inside && (await holding()) === 'screen', g);
    await page.keyboard.press('Escape');
    await wait(300);

    // Panning by hand lets go; a later resize leaves the camera alone.
    await page.mouse.move(500, 300);
    await page.mouse.wheel({ deltaY: 120 });
    await wait(200);
    const before = await geo(ids[12]!);
    check('a manual pan stops holding the fit', (await holding()) === '');
    await page.setViewport({ width: 1024, height: 640, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
    await wait(350);
    const after = await geo(ids[12]!);
    check('and the camera stays where the person put it', Math.abs(after.b[2]! - before.b[2]!) < 1, { before: before.b, after: after.b });

    // A tall page: Fit width fills the width and starts at the top, readable.
    // A new tab opened on it: changing only the hash of a file already open does not read ?select= again.
    await page.close();
    page = await open(1024, 640, 1, `#/file/${many.id}?select=${tall}`);
    await page.waitForSelector('[data-testid="toolbar"]');
    await wait(600);
    const selected = await page.$eval('[data-testid="insp-name"]', (e) => (e as HTMLInputElement).value).catch(() => '');
    check('the tall page is the selection before fitting it', selected === 'Long page', selected);
    await key('4');
    g = await geo(tall);
    check('Fit width: a tall page fills the canvas width from its top', g.fillW > 0.8 && g.fillW <= 1 && g.top >= 0 && g.top < 60 && (await holding()) === 'width', g);
    // Menus offer it too, with clear names.
    await page.click('[data-testid="zoom-level"]');
    const labels = await page.$$eval('[data-testid^="zoom-"]:not([data-testid="zoom-level"]) span:first-child', (els) => els.map((e) => e.textContent));
    check('the zoom menu names Fit screen, Fit width, 100% and All screens', ['Fit screen', 'Fit width', '100%', 'All screens'].every((l) => labels.includes(l)), labels);
    await page.keyboard.press('Escape');

    // In a text field the keys type.
    await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
    await page.waitForSelector('[data-testid="prompt-input"]');
    // The chat docks beside the canvas now: the wheel goes over the canvas itself to end the fit.
    const over = await page.$eval('main.stage', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(over.x, over.y); await page.mouse.wheel({ deltaY: 60 }); await wait(150);
    await page.focus('[data-testid="prompt-input"]');
    await key('3');
    const typed = await page.$eval('[data-testid="prompt-input"]', (e) => (e as HTMLTextAreaElement).value);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    // Puppeteer types a literal 3 for Shift+3 where a keyboard gives #; either way it lands in the field, not in a fit.
    check('Shift+3 in the prompt types, it does not fit', /[3#]$/.test(typed) && (await holding()) === '' && focused === 'prompt-input', { typed, holding: await holding(), focused });
    await page.screenshot({ path: join(shots, 'fit-width-tall.png') });
    await page.close();
  }

  // ---------------------------------------------------------------- Home: kinds beside folders, from cheap metadata
  {
    const site = server.storage.create('Studio site');
    { const r = await server.rooms.get(site.id); const p = r.doc.getPages()[0]!.id; r.doc.insert(p, { type: 'frame', name: 'Home', artboard: true, attrs: { 'data-web': 'page' }, style: { width: '1440px' } }); }
    const theme = server.storage.create('Ember mobile');
    { const r = await server.rooms.get(theme.id); r.doc.meta.set('omarchyTheme', { name: 'ember', format: 2, target: 'mobile' }); }
    const app = server.storage.create('Habit tracker');
    await fetch(`${base}/api/files/${app.id}/project`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'app', platforms: ['ios', 'android'] }) });
    server.storage.moveToFolder(app.id, 'Clients');
    const loose = server.storage.create('Sidebar weather');
    await wait(1800);
    for (const id of [site.id, theme.id, app.id]) await server.rooms.unload(id);
    const loaded = () => [site.id, theme.id, app.id, loose.id].filter((id) => server.rooms.peek(id));
    check('the fixture files are classified and none is loaded', loaded().length === 0 && server.storage.get(site.id)?.project?.type === 'website' && server.storage.get(theme.id)?.project?.platforms?.[0] === 'mobile', loaded());

    const page = await open(1280, 720, 1, '#/');
    await page.waitForSelector('[data-testid="home-kinds"]');
    await wait(300);
    const count = (kind: string, platform = '') => page.$eval(`[data-testid="kind-row"][data-kind="${kind}"][data-platform="${platform}"] .folder-count`, (e) => e.textContent).catch(() => '');
    const names = () => page.$$eval('[data-testid="file"]', (els) => els.map((e) => (e as HTMLElement).dataset.fileName));
    check('kinds count websites, apps on two platforms, and Omarchy Mobile themes', (await count('website')) === '1' && (await count('app')) === '1' && (await count('app', 'ios')) === '1' && (await count('app', 'android')) === '1' && (await count('app', 'desktop')) === '' && (await count('omarchy-theme', 'mobile')) === '1', { site: await count('website'), app: await count('app'), ios: await count('app', 'ios') });
    await page.click('[data-testid="kind-row"][data-kind="app"][data-platform="android"] .folder-open');
    check('Apps, Android shows the one file for iOS and Android, and says what is shown', JSON.stringify(await names()) === JSON.stringify(['Habit tracker']) && /Apps, Android/.test(await page.$eval('[data-testid="home-scope"]', (e) => e.textContent ?? '').catch(() => '')));
    await page.click('[data-testid="kind-row"][data-kind="omarchy-theme"][data-platform=""] .folder-open');
    check('Themes shows the Omarchy Mobile theme', JSON.stringify(await names()) === JSON.stringify(['Ember mobile']));
    // A folder and a kind together, then a search on top.
    await page.click('[data-testid="kind-row"][data-kind="app"][data-platform=""] .folder-open');
    await page.click('[data-testid="folder-row"][data-folder="Clients"] .folder-open');
    check('a folder and a kind together', JSON.stringify(await names()) === JSON.stringify(['Habit tracker']) && /in Clients/.test(await page.$eval('[data-testid="home-scope"]', (e) => e.textContent ?? '')));
    await page.type('[data-testid="home-search"]', 'zzz');
    await wait(150);
    check('a search with nothing left says so, with a way back', (await names()).length === 0 && await exists(page, '[data-testid="home-scope-clear"]'));
    await page.click('[data-testid="home-scope-clear"]');
    await page.click('[data-testid="folder-all"] .folder-open');
    check('Show all clears the kind and the search', (await names()).length >= 4 && !(await exists(page, '[data-testid="home-scope"]')));

    // A person says what a file is. A failed save keeps the menu and says so; the retry saves.
    const card = `[data-testid="file"][data-file-name="Sidebar weather"]`;
    await page.click(`${card} [data-testid="file-menu"]`);
    await page.click('[data-testid="file-action-kind"]');
    await page.click('[data-testid="project-type-omasidebar-widget"]');
    await page.setRequestInterception(true);
    const fail = (req: import('puppeteer-core').HTTPRequest) => { if (req.url().endsWith('/project')) void req.respond({ status: 500, contentType: 'application/json', body: '{"error":"The disk is full."}' }); else void req.continue(); };
    page.on('request', fail);
    await page.click('[data-testid="project-save"]');
    const failed = await until(() => exists(page, '[data-testid="project-error"]'), 3000);
    const stillOpen = await exists(page, '[data-testid="project-type-omasidebar-widget"][aria-checked="true"]');
    page.off('request', fail);
    await page.setRequestInterception(false);
    await page.click('[data-testid="project-save"]');
    const saved = await until(async () => (await page.$eval(`${card} [data-testid="file-kind"]`, (e) => e.textContent).catch(() => '')) === 'Omasidebar widget', 4000);
    check('a failed save says so and keeps the choice; the retry saves it', failed && stillOpen && saved, { failed, stillOpen, saved });

    // All of it after a reload: the kind filter, counts and the person's answer.
    await page.click('[data-testid="kind-row"][data-kind="omasidebar-widget"][data-platform=""] .folder-open');
    await page.reload();
    await page.waitForSelector('[data-testid="home-kinds"]');
    await wait(400);
    check('after a reload the kind filter, its count and the answer stay', JSON.stringify(await names()) === JSON.stringify(['Sidebar weather']) && (await count('omasidebar-widget')) === '1');
    // At laptop size the first match is in view without scrolling: no gallery above it while a kind is chosen.
    const firstCard = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="file"]')?.getBoundingClientRect();
      const body = document.querySelector('.home-body') as HTMLElement | null;
      return card ? { top: card.top, bottom: card.bottom, h: innerHeight, scrolled: body?.scrollTop ?? 0, galleries: document.querySelectorAll('.home-body [data-testid="examples"], .home-body [data-testid="brands-section"], .home-body [data-testid="omarchy-themes"]').length } : null;
    });
    check('the first matching file is visible at 1280x720 without scrolling', Boolean(firstCard && firstCard.top >= 0 && firstCard.bottom <= firstCard.h && firstCard.scrolled === 0), firstCard);
    check('listing and filtering loaded none of the other files', [site.id, theme.id, app.id].every((id) => !server.rooms.peek(id)), [site.id, theme.id, app.id].filter((id) => server.rooms.peek(id)));
    await page.screenshot({ path: join(shots, 'home-kinds.png') });
    await page.close();
  }

  // ---------------------------------------------------------------- Home, small and low
  for (const [w, h] of [[640, 480], [1280, 500]] as const) {
    const page = await open(w, h, 1, '#/');
    await page.waitForSelector('[data-testid="home"]');
    await wait(300);
    const m = await page.evaluate(() => {
      const body = document.querySelector('.home-body')!.getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth - innerWidth, body: body.height, right: body.right, w: innerWidth };
    });
    check(`Home ${w}x${h}: no sideways scroll, its files have room`, m.overflow <= 0 && m.body >= 160 && m.right <= m.w + 0.5, m);
    await page.screenshot({ path: join(shots, `home-${w}x${h}.png`) });
    // Settings without opening a file: the button, and Ctrl+, too.
    await page.click('[data-testid="home-settings"]');
    const dialog = await until(() => exists(page, '[data-testid="settings-dialog"] [data-testid="setting-scale"]'), 3000);
    await page.click('[data-testid="settings-nav-about"]');
    const about = await until(async () => /Version \d/.test(await page.$eval('[data-testid="setting-version"]', (e) => e.textContent ?? '').catch(() => '')), 3000);
    const fits = await page.evaluate(() => { const d = document.querySelector('[data-testid="settings-dialog"]')!.getBoundingClientRect(); return d.top >= 0 && d.bottom <= innerHeight && d.right <= innerWidth; });
    await page.screenshot({ path: join(shots, `home-settings-${w}x${h}.png`) });
    await page.keyboard.press('Escape');
    const closed = await until(async () => !(await exists(page, '[data-testid="settings-dialog"]')), 2000);
    await page.keyboard.down('Control'); await page.keyboard.press(','); await page.keyboard.up('Control');
    const byKey = await until(() => exists(page, '[data-testid="settings-dialog"]'), 2000);
    check(`Home ${w}x${h}: Settings open without a file, with the version, fit the window, close with Esc, and Ctrl+, opens them`, dialog && about && fits && closed && byKey, { dialog, about, fits, closed, byKey });
    await page.close();
  }

  check('no page errors', errors.length === 0, errors.slice(0, 5));
} finally {
  await browser.close();
  await server.close();
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `:\n  ${failures.join('\n  ')}` : ''}`);
  console.log(`screenshots: ${shots}`);
  if (!failures.length && process.env.KEEP !== '1') rmSync(join(root, 'bogen'), { recursive: true, force: true });
  process.exitCode = failures.length ? 1 : 0;
}
