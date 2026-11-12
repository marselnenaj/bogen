/**
 * The editor's upper navigation and Home's header in narrow desktop windows, through the real editor, a real server
 * and a sandboxed browser with a mouse (no touch). The file is on a real internal branch with a long name, its own
 * name is long, an agent is connected, a synced device has a long name, and an agent run is busy with its Stop button
 * showing. In English, German and Tamil (the catalog with the longest header labels), at 1280, 1024, 860, 700, 640, 520
 * and 430 px, UI scales 1, 1.25 and 1.5, and a 480 px high window:
 *
 * - nothing is clipped, overlaps or scrolls the document sideways; the file name stays readable; Home, file, branch
 *   and agent controls stay in the toolbar;
 * - every command is in the toolbar or one of its menus; the menus stay inside the window and scroll in a low one;
 * - the menus work from the keyboard: Enter opens with the focus inside, arrows move, Escape closes and gives the focus
 *   back to their button, which shows it;
 * - a panel in a drawer opens from its visible control (its button, or More at the smallest level), takes the focus,
 *   and Escape gives it back;
 * - following the agent, the way to stop following stays reachable at every width (the pill, or More).
 *
 * Deterministic: a temporary home and stand-in CLIs (the run hangs until it is stopped), no provider is called.
 *
 *   (cd apps/editor && npx vite build)
 *   BOGEN_BROWSER=~/.local/bin/secure-chromium node --import tsx apps/editor/test/e2e/narrow-nav.ts
 *
 * Optional: NAV_ONLY=en,1280:1 runs a subset; screenshots go to the folder printed at the end (or $BOGEN_SHOTS).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type HTTPRequest, type Page } from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { writeFakeClis } from '../../../../packages/server/test/fake-cli.ts';
import { connectAgent } from '../../../../packages/server/test/helpers.ts';

const browserPath = process.env.BOGEN_BROWSER;
if (!browserPath) throw new Error('Set BOGEN_BROWSER to a browser with its sandbox on, such as ~/.local/bin/secure-chromium.');
if (!/secure-chromium$/.test(browserPath)) throw new Error('This check runs only with secure-chromium, its sandbox on.');

const root = mkdtempSync(join(tmpdir(), 'bogen-nav-'));
const shots = process.env.BOGEN_SHOTS ?? join(root, 'shots');
const bin = join(root, 'bin');
for (const d of [shots, bin]) mkdirSync(d, { recursive: true });
writeFakeClis(bin, join(root, 'cli.log'));
process.env.PATH = `${bin}:${process.env.PATH}`;

const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false });
await server.listen();
const base = server.localUrl();
const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, pipe: true, args: [`--secure-local-port=${new URL(base).port}`, '--lang=en-US'], defaultViewport: { width: 1440, height: 900 } });

let passed = 0;
const failures: string[] = [];
const errors: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) {
    passed++;
    if (process.env.VERBOSE) console.log(`pass  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(50);
  }
  return false;
}
const exists = (page: Page, sel: string) => page.$(sel).then(Boolean);

// ---------------------------------------------------------------- the fixture: a long file on a long branch
const LONG = 'GitHub Traffic · Bar panel, quarterly review for the infrastructure team with every repository';
const BRANCH = 'Darker header with the compact navigation and the sidebar experiment';
const DEVICE = 'Mara’s ThinkPad X1 Carbon in the studio';
const entry = server.storage.create(LONG);
{
  const room = await server.rooms.get(entry.id);
  const pageId = room.doc.getPages()[0]!.id;
  room.doc.insert(pageId, { type: 'frame', name: 'Dashboard', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '1200px', height: '800px', background: '#ffffff' } });
  room.doc.invalidate();
}
const api = (path: string, body?: unknown) => fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => { if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`); return r.json(); });
await api(`/api/files/${entry.id}/design-branches`, { name: 'Pricing table', by: 'person' });
await api(`/api/files/${entry.id}/design-branches`, { name: BRANCH, checkout: true, by: 'person' });
const agent = await connectAgent(base, 'Claude Code');
/** The agent reads the file: it is in the file, as a person in the toolbar, for a while after. */
const touch = () => agent.callTool({ name: 'layer_tree', arguments: { file_id: entry.id } }).catch(() => undefined);
await touch();

/** The server's own status, plus a synced device with a long name: SyncStatus shows it in the toolbar. */
async function withDevice(req: HTTPRequest): Promise<void> {
  if (!req.url().endsWith('/api/status')) return void req.continue();
  const real = await (await fetch(`${base}/api/status`)).json() as Record<string, unknown>;
  void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...real, peers: [{ id: 'p1', name: DEVICE, state: 'connected', lastSyncAt: Date.now(), pending: 0, here: [{ fileId: entry.id, people: [{ name: 'Lena', selection: 1 }] }] }] }) });
}

async function open(width: number, height: number, scale: number, lang: string, path = `#/file/${entry.id}`): Promise<Page> {
  await touch();
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(`window.__name = (f) => f; try { localStorage.setItem('bogen-settings', ${JSON.stringify(JSON.stringify({ uiScale: scale }))}); ${lang === 'en' ? "localStorage.removeItem('bogen-language');" : `localStorage.setItem('bogen-language', '${lang}');`} } catch {}`);
  page.on('pageerror', (e) => errors.push(`${lang} ${width}x${height}@${scale}: ${String(e)}`));
  await page.setRequestInterception(true);
  page.on('request', (r) => void withDevice(r));
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  await page.goto(`${base}/${path}`);
  return page;
}

/**
 * The toolbar's geometry: its controls, each with its box, whether it is cut by the toolbar or by its own group, and
 * which controls overlap. A control counts when it is drawn (width above 0).
 */
function measure(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('[data-testid="toolbar"]');
    if (!bar) return null;
    const tb = bar.getBoundingClientRect();
    const controls = [...bar.querySelectorAll<HTMLElement>('button, a, input, .sync-status')].filter((el) => el.getBoundingClientRect().width > 0 && !el.parentElement?.closest('button, a, .sync-status'));
    const name = (el: HTMLElement) => el.dataset.testid ?? el.className.split(' ')[0] ?? el.tagName;
    const boxes = controls.map((el) => { const r = el.getBoundingClientRect(); return { id: name(el), l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width }; });
    const outside = boxes.filter((b) => b.r > tb.right + 0.5 || b.l < tb.left - 0.5 || b.t < tb.top - 0.5 || b.b > tb.bottom + 0.5).map((b) => b.id);
    // Cut by its own group: a group that is narrower than what it holds clips or spills into the next one.
    const groups = [...bar.children].map((g) => ({ id: (g as HTMLElement).className, over: g.scrollWidth - g.clientWidth }));
    const spill = groups.filter((g) => g.over > 1);
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      const x = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const y = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (x > 1 && y > 1) overlaps.push(`${a.id}×${b.id}`);
    }
    const fileName = document.querySelector<HTMLElement>('[data-testid="file-name"]');
    const branch = document.querySelector<HTMLElement>('[data-testid="branch-menu"]');
    const branchName = branch?.querySelector<HTMLElement>('.db-trigger-name');
    return {
      docOverflow: document.documentElement.scrollWidth - innerWidth,
      level: bar.dataset.level,
      outside, spill, overlaps,
      name: fileName ? Math.round(fileName.getBoundingClientRect().width) : 0,
      nameFull: fileName ? fileName.scrollWidth <= fileName.clientWidth + 1 : false,
      branch: branch ? Math.round(branch.getBoundingClientRect().width) : 0,
      branchLabel: branchName ? Math.round(branchName.getBoundingClientRect().width) : 0,
      branchOn: branch?.dataset.branch ?? '',
      phone: Boolean(document.querySelector('[data-testid="phone-file"]')),
      ids: boxes.map((b) => b.id),
    };
  });
}

/** Every command of the toolbar is a button in it or an item of one of its menus. */
async function reachable(page: Page): Promise<string[]> {
  const missing: string[] = [];
  const inToolbar = (id: string) => exists(page, `[data-testid="toolbar"] [data-testid="${id}"]`);
  const tools = ['move', 'hand', 'frame', 'rect', 'ellipse', 'line', 'text', 'pen', 'pencil', 'image', 'app-screen', 'icons', 'comment', 'shader', 'zoom'];
  const hidden: string[] = [];
  for (const t of tools) if (!(await inToolbar(`tool-${t}`))) hidden.push(t);
  if (hidden.length) {
    if (!(await inToolbar('tools-more'))) return hidden.map((t) => `tool ${t}`);
    await page.click('[data-testid="tools-more"]');
    for (const t of hidden) if (!(await exists(page, `[data-testid="tools-more-${t}"]`))) missing.push(`tool ${t}`);
    await page.keyboard.press('Escape');
    await wait(80);
  }
  const actions: [string, string][] = [['preview-open', 'more-preview'], ['checks-open', 'more-checks'], ['settings-open', 'more-settings'], ['toolbar-history', 'more-history'], ['minimal-toggle', 'more-minimal'], ['shortcuts-open', 'more-shortcuts'], ['undo', 'more-undo'], ['redo', 'more-redo'], ['zoom-level', 'more-zoom-in'], ['me', 'more-me']];
  // A panel's button is there while the panel is a drawer, not while it sits beside the canvas.
  for (const side of ['left', 'right']) if (!(await exists(page, `.panel-slot[data-dock="docked"]#panel-drawer-${side}`))) actions.push([`panel-toggle-${side}`, `more-panel-${side}`]);
  const needMenu = [];
  for (const [direct, menu] of actions) if (!(await inToolbar(direct))) needMenu.push({ direct, menu });
  if (needMenu.length) {
    if (!(await inToolbar('toolbar-more'))) return [...missing, ...needMenu.map((a) => a.direct)];
    await page.click('[data-testid="toolbar-more"]');
    for (const a of needMenu) if (!(await exists(page, `[data-testid="${a.menu}"]`))) missing.push(a.direct);
    await page.keyboard.press('Escape');
    await wait(80);
  }
  // Essential: always in the toolbar itself.
  for (const p of ['home-link', 'file-name', 'branch-menu', 'prompt-toggle']) if (!(await inToolbar(p))) missing.push(p);
  return missing;
}

/** A menu of the toolbar: inside the window, its contents reachable by scrolling when the window is low. */
async function menuFits(page: Page, trigger: string, menu: string) {
  if (!(await exists(page, `[data-testid="toolbar"] [data-testid="${trigger}"]`))) return { skipped: true, ok: true };
  await page.click(`[data-testid="${trigger}"]`);
  const opened = await until(() => exists(page, `[data-testid="${menu}"]`), 2000);
  await wait(80);
  const geo = await page.evaluate((sel: string) => {
    const el = document.querySelector<HTMLElement>(sel)?.closest<HTMLElement>('.popover');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // The element that scrolls: the popover or the one panel inside it.
    const scroller = [el, ...el.querySelectorAll<HTMLElement>('*')].find((n) => n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY));
    const inner = [el, ...el.querySelectorAll<HTMLElement>('*')].some((n) => n.scrollHeight > n.clientHeight + 1 && !/(auto|scroll)/.test(getComputedStyle(n).overflowY) && getComputedStyle(n).overflowY !== 'visible');
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: innerWidth, h: innerHeight, scrolls: Boolean(scroller), cut: inner, tall: el.scrollHeight > el.clientHeight + 1 || Boolean(scroller) };
  }, `[data-testid="${menu}"]`);
  await page.keyboard.press('Escape');
  await until(async () => !(await exists(page, `[data-testid="${menu}"]`)), 1500);
  const inside = Boolean(geo && geo.l >= -0.5 && geo.t >= -0.5 && geo.r <= geo.w + 0.5 && geo.b <= geo.h + 0.5);
  return { opened, inside, geo, ok: opened && inside && !geo?.cut };
}

/** The keyboard: Tab-reachable button, Enter opens with the focus inside, an arrow moves it, Escape gives it back. */
async function keyboardMenu(page: Page, trigger: string, menu: string) {
  if (!(await exists(page, `[data-testid="toolbar"] [data-testid="${trigger}"]`))) return { skipped: true, ok: true };
  // Tab from the Home link reaches the button.
  await page.focus('[data-testid="home-link"]');
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate((id: string) => document.activeElement?.getAttribute('data-testid') === id, trigger);
  }
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const cs = getComputedStyle(el);
    return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== 'none' && cs.boxShadow !== '');
  });
  await page.keyboard.press('Enter');
  const opened = await until(() => exists(page, `[data-testid="${menu}"]`), 2000);
  const inside = await until(() => page.evaluate((sel: string) => Boolean(document.activeElement?.closest('.popover') && document.querySelector(sel)?.closest('.popover')?.contains(document.activeElement)), `[data-testid="${menu}"]`), 1000);
  const first = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.textContent ?? '');
  await page.keyboard.press('ArrowDown');
  const second = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.textContent ?? '');
  await page.keyboard.press('Escape');
  const closed = await until(async () => !(await exists(page, `[data-testid="${menu}"]`)), 1500);
  const back = await until(() => page.evaluate((id: string) => document.activeElement?.getAttribute('data-testid') === id, trigger), 1000);
  const moved = menu === 'branch-panel' ? true : first !== second;
  return { reached, ring, opened, inside, moved, closed, back, ok: reached && ring && opened && inside && moved && closed && back };
}

/** A drawer from its visible control: its own button, or the item in More. Focus inside, Escape closes, focus back. */
async function drawer(page: Page, side: 'left' | 'right') {
  if (await exists(page, `.panel-slot[data-dock="docked"]#panel-drawer-${side}`)) return { skipped: true, ok: true };
  const direct = await exists(page, `[data-testid="toolbar"] [data-testid="panel-toggle-${side}"]`);
  const control = direct ? `panel-toggle-${side}` : 'toolbar-more';
  if (direct) await page.click(`[data-testid="panel-toggle-${side}"]`);
  else {
    await page.click('[data-testid="toolbar-more"]');
    if (!(await until(() => exists(page, `[data-testid="more-panel-${side}"]`), 1500))) return { direct, ok: false, item: false };
    await page.click(`[data-testid="more-panel-${side}"]`);
  }
  const opened = await until(() => exists(page, `[data-testid="panel-drawer-${side}"]`), 2000);
  const focusIn = await until(() => page.evaluate((s: string) => Boolean(document.activeElement?.closest(`[data-testid="panel-drawer-${s}"]`)), side), 1000);
  await page.keyboard.press('Escape');
  const closed = await until(async () => !(await exists(page, `[data-testid="panel-drawer-${side}"]`)), 2000);
  const back = await until(() => page.evaluate((id: string) => document.activeElement?.getAttribute('data-testid') === id, control), 1500);
  return { direct, opened, focusIn, closed, back, ok: opened && focusIn && closed && back };
}

const only = process.env.NAV_ONLY?.split(',') ?? null;
const LANGS = ['en', 'de', 'ta'];
const WIDTHS = [1280, 1024, 860, 700, 640, 520, 430];
const SCALES = [1, 1.25, 1.5];
const MENUS: [string, string][] = [['branch-menu', 'branch-panel'], ['toolbar-more', 'toolbar-more-menu'], ['tools-more', 'tools-more-menu'], ['zoom-level', 'zoom-fit-screen']];

try {
  for (const lang of LANGS) {
    if (only && !only.includes(lang)) continue;
    for (const w of WIDTHS) for (const scale of SCALES) for (const h of [720, 480]) {
      // The low window at each width and scale once, in English, where the menus are checked for scrolling.
      if (h === 480 && lang !== 'en') continue;
      if (only && !only.some((o) => o === `${w}:${scale}` || o === `${w}`)) { if (only.some((o) => o.includes(':') || /^\d+$/.test(o))) continue; }
      const tag = `${lang} ${w}x${h}@${scale}`;
      const page = await open(w, h, scale, lang);
      await page.waitForSelector('[data-testid="toolbar"] [data-testid="branch-menu"]', { timeout: 10_000 });
      await until(() => page.evaluate(() => Boolean(document.querySelector('.db-trigger-name') || document.querySelector('[data-testid="toolbar"]')?.getAttribute('data-level') !== 'full')), 3000);
      await until(() => exists(page, '[data-testid="sync-status"]'), 3000);
      await wait(250);
      const m = (await measure(page))!;
      check(`${tag}: nothing scrolls the window sideways`, m.docOverflow <= 0, m.docOverflow);
      check(`${tag}: no control outside the toolbar or cut by its group`, m.outside.length === 0 && m.spill.length === 0, { level: m.level, outside: m.outside, spill: m.spill });
      check(`${tag}: no controls overlap`, m.overlaps.length === 0, { level: m.level, overlaps: m.overlaps });
      check(`${tag}: the file name stays readable`, m.name >= (w / scale >= 600 ? 120 : 64), { level: m.level, name: m.name });
      check(`${tag}: the branch control is there and on the branch`, m.branch >= 22 && m.branchOn !== 'main', { branch: m.branch, on: m.branchOn });
      check(`${tag}: a mouse keeps the desktop editor`, !m.phone);
      // Renaming: the field takes the name's place without pushing anything out; Escape keeps the old name.
      if (h === 720) {
        await page.click('[data-testid="file-name"]');
        const field = await until(() => exists(page, '[data-testid="file-rename"]'), 1500);
        const r = (await measure(page))!;
        const rename = await page.evaluate(() => { const el = document.querySelector<HTMLElement>('[data-testid="file-rename"]'); return el ? Math.round(el.getBoundingClientRect().width) : 0; });
        check(`${tag}: renaming the file keeps the toolbar inside its row`, field && rename >= 48 && r.docOverflow <= 0 && r.outside.length === 0 && r.spill.length === 0 && r.overlaps.length === 0, { level: r.level, rename, outside: r.outside, spill: r.spill, overlaps: r.overlaps });
        await page.keyboard.press('Escape');
        const back = await until(async () => (await page.$eval('[data-testid="file-name"]', (e) => e.textContent ?? '').catch(() => '')) === LONG, 1500);
        check(`${tag}: Escape ends renaming and keeps the name`, back);
      }
      const missing = await reachable(page);
      check(`${tag}: every toolbar command reachable`, missing.length === 0, { level: m.level, missing });
      for (const [trigger, menu] of MENUS) {
        const fit = await menuFits(page, trigger, menu);
        check(`${tag}: ${trigger} menu inside the window${h === 480 ? ', scrolling when low' : ''}`, fit.ok, fit);
      }
      if (lang === 'en' && h === 720) {
        for (const [trigger, menu] of MENUS.slice(0, 2)) {
          const k = await keyboardMenu(page, trigger, menu);
          check(`${tag}: ${trigger} works from the keyboard`, k.ok, k);
        }
        for (const side of ['left', 'right'] as const) {
          const d = await drawer(page, side);
          check(`${tag}: the ${side} drawer opens from its visible control, Escape gives the focus back`, d.ok, d);
        }
      }
      await page.screenshot({ path: join(shots, `${tag.replace(/ /g, '-')}.png`) as `${string}.png` });
      await page.close();
    }
  }

  // ---------------------------------------------------------------- an agent busy: its Stop stays reachable
  if (!only || only.includes('busy')) for (const [w, scale] of [[1024, 1], [700, 1.25], [430, 1], [430, 1.5]] as const) {
    const tag = `busy ${w}x480@${scale}`;
    const page = await open(w, 480, scale, 'en');
    await page.waitForSelector('[data-testid="toolbar"]');
    await wait(300);
    await page.click('[data-testid="prompt-toggle"]');
    await page.waitForSelector('[data-testid="prompt-input"]');
    await page.type('[data-testid="prompt-input"]', 'Tighten the header FAKE{"hang":true}');
    // The first prompt loads the local runner list asynchronously; Enter is ignored until a runner is selected.
    await page.waitForSelector('[data-testid="prompt-send"]:not(:disabled)', { timeout: 10_000 });
    await page.keyboard.press('Enter');
    const stop = await until(() => exists(page, '[data-testid="prompt-stop"]'), 6000);
    const geo = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="prompt-stop"]')?.getBoundingClientRect();
      if (!s) return null;
      const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
      return { inside: s.left >= 0 && s.right <= innerWidth && s.top >= 0 && s.bottom <= innerHeight, top: Boolean(hit?.closest('[data-testid="prompt-stop"]')) };
    });
    const m = (await measure(page))!;
    check(`${tag}: the run's Stop is shown, inside the window and not covered`, stop && Boolean(geo?.inside && geo.top), geo);
    check(`${tag}: the toolbar still fits while the agent works`, m.docOverflow <= 0 && m.outside.length === 0 && m.spill.length === 0 && m.overlaps.length === 0, m);
    await page.screenshot({ path: join(shots, `${tag.replace(/ /g, '-')}.png`) as `${string}.png` });
    if (stop) await page.click('[data-testid="prompt-stop"]');
    await until(async () => !(await exists(page, '[data-testid="prompt-stop"]')), 4000);
    await page.close();
  }

  // ---------------------------------------------------------------- following the agent: Stop following stays reachable
  if (!only || only.includes('follow')) for (const [w, scale] of [[1280, 1], [1024, 1], [700, 1], [520, 1.25], [430, 1.5]] as const) {
    const tag = `follow ${w}x720@${scale}`;
    const page = await open(w, 720, scale, 'en');
    await page.waitForSelector('[data-testid="toolbar"]');
    await until(() => page.evaluate(() => Boolean(document.querySelector('[data-testid="peer"]') || document.querySelector('.peer-more'))), 4000);
    await wait(200);
    // Follow from the person's own button, or from More where the toolbar shows no people.
    let started = false;
    if (await exists(page, '[data-testid="toolbar"] [data-testid="peer"]')) { await page.click('[data-testid="toolbar"] [data-testid="peer"]'); started = true; }
    else {
      await page.click('[data-testid="toolbar-more"]');
      if (await until(() => exists(page, '[data-testid="more-follow"]'), 1500)) { await page.click('[data-testid="more-follow"]'); started = true; }
      else await page.keyboard.press('Escape');
    }
    await wait(250);
    const m = (await measure(page))!;
    check(`${tag}: following, the toolbar still fits`, started && m.docOverflow <= 0 && m.outside.length === 0 && m.spill.length === 0 && m.overlaps.length === 0 && m.name >= 64, { started, ...m, ids: undefined });
    await page.screenshot({ path: join(shots, `${tag.replace(/ /g, '-')}.png`) as `${string}.png` });
    let stopped = false;
    if (await exists(page, '[data-testid="toolbar"] [data-testid="follow-pill"]')) await page.click('[data-testid="follow-pill"]');
    else {
      await page.click('[data-testid="toolbar-more"]');
      if (await until(() => exists(page, '[data-testid="more-stop-following"]'), 1500)) await page.click('[data-testid="more-stop-following"]');
    }
    stopped = await until(() => page.evaluate(() => !document.querySelector('[data-testid="follow-pill"], [data-testid="toolbar-more"].is-following, .peer.is-following')), 2000);
    check(`${tag}: and Stop following is reachable and works`, started && stopped, { started, stopped });
    await page.close();
  }

  // ---------------------------------------------------------------- Home's header
  if (!only || only.includes('home')) for (const lang of LANGS) for (const w of WIDTHS) for (const scale of SCALES) {
    const tag = `home ${lang} ${w}x720@${scale}`;
    const page = await open(w, 720, scale, lang, '#/');
    await page.waitForSelector('[data-testid="home-new"]');
    await wait(200);
    const m = await page.evaluate(() => {
      const head = document.querySelector<HTMLElement>('.home-head')!;
      const hr = head.getBoundingClientRect();
      const items = [...head.querySelectorAll<HTMLElement>('a, button, label.home-search')].filter((el) => el.getBoundingClientRect().width > 0 && !el.parentElement?.closest('a, button, label'));
      const boxes = items.map((el) => { const r = el.getBoundingClientRect(); return { id: el.dataset.testid ?? el.className.split(' ')[0]!, l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, cut: el.scrollWidth > el.clientWidth + 1 }; });
      const overlaps: string[] = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        if (Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1) overlaps.push(`${a.id}×${b.id}`);
      }
      const search = boxes.find((b) => b.id === 'home-search');
      return {
        docOverflow: document.documentElement.scrollWidth - innerWidth,
        outside: boxes.filter((b) => b.l < hr.left - 0.5 || b.r > hr.right + 0.5 || b.t < hr.top - 0.5 || b.b > hr.bottom + 0.5).map((b) => b.id),
        cut: boxes.filter((b) => b.cut && b.id !== 'home-search').map((b) => b.id),
        overlaps,
        search: search ? Math.round(search.w) : 0,
        ids: boxes.map((b) => b.id),
      };
    });
    check(`${tag}: Home's header fits`, m.docOverflow <= 0 && m.outside.length === 0 && m.overlaps.length === 0 && m.cut.length === 0, m);
    check(`${tag}: search, new file and settings stay in the header`, m.search >= 100 && ['home-new', 'home-settings'].every((id) => m.ids.includes(id)), m);
    // Import and Open: in the header, or in its menu.
    const inHead = async (id: string) => exists(page, `.home-head [data-testid="${id}"]`);
    let importOk = (await inHead('home-figma')) && (await inHead('home-open'));
    if (!importOk && (await inHead('home-more'))) {
      await page.click('[data-testid="home-more"]');
      importOk = (await until(() => exists(page, '[data-testid="home-more-figma"]'), 1500)) && (await exists(page, '[data-testid="home-more-open"]')) && ((await inHead('home-live')) || (await exists(page, '[data-testid="home-more-live"]')));
      await page.keyboard.press('Escape');
      const back = await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'home-more'), 1000);
      importOk = importOk && back;
    }
    check(`${tag}: Import from Figma, Open and Live site reachable`, importOk);
    await page.screenshot({ path: join(shots, `${tag.replace(/ /g, '-')}.png`) as `${string}.png` });
    await page.close();
  }

  check('no page errors', errors.length === 0, errors.slice(0, 5));
} finally {
  await agent.close().catch(() => undefined);
  await browser.close();
  await server.close();
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `:\n  ${failures.slice(0, 80).join('\n  ')}${failures.length > 80 ? `\n  … ${failures.length - 80} more` : ''}` : ''}`);
  console.log(`screenshots: ${shots}`);
  rmSync(join(root, 'bogen'), { recursive: true, force: true });
  process.exitCode = failures.length ? 1 : 0;
}
