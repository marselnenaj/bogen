/**
 * The browser extension end to end, loaded unpacked in the sandboxed browser: pairing approved in the editor, a page
 * behind a login captured through its content script (cookie-only images and font included), an element picked on
 * the page, and the pairing revoked in Settings. The toolbar click is puppeteer's triggerExtensionAction, which gives
 * the extension activeTab exactly as a click would; the extension has no host permissions.
 * Run: BOGEN_EDITOR_DIR=<built editor> npx tsx apps/editor/test/e2e/browser-extension.ts [screenshot dir]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { freshPage, launch, sleep, startRealServer } from './craft-harness.ts';
import { watchErrors } from './harness.ts';
import { connectAgent } from '../../../../packages/server/test/helpers.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const SHOTS = process.argv[2] ? resolve(process.argv[2]) : null;
const FONT = readFileSync(join(dirname(createRequire(import.meta.url).resolve('@fontsource-variable/source-sans-3/package.json')), 'files/source-sans-3-latin-wght-normal.woff2'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

const SIGNED_IN = `<!doctype html><html><head><title>Invoices · Ledgerly</title><style>
@font-face { font-family: "Fixture Sans"; src: url(/font.woff2) format("woff2"); font-weight: 200 900; }
:root { --ink: #1c2230; --paper: #f7f8f3; --red: #b3261e }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: "Fixture Sans", sans-serif }
header { display: flex; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid #d0d4c8 }
h1 { font-size: 32px; margin: 24px }
table { margin: 0 24px; border-collapse: collapse; width: 560px } td { padding: 8px; border-bottom: 1px solid #e0e2da }
.late { color: var(--red); font-weight: 700 }
.logo { width: 24px; height: 24px; background-image: url(/private.png) }
button:hover { background: var(--red) }
</style></head><body>
<header><div class="logo"></div><span>Signed in as Ada</span></header>
<h1>Open invoices</h1>
<table id="invoices"><tr><td>INV-1042</td><td>Acme Tools</td><td class="late">12 days late</td></tr><tr><td>INV-1043</td><td>Northwind</td><td>Due Friday</td></tr></table>
<img src="/private.png" alt="Ledger mark" width="40" height="40"><button>Send reminders</button>
</body></html>`;
const SIGN_IN = '<!doctype html><title>Sign in</title><h1>Please sign in</h1>';

async function main(): Promise<void> {
  const fixture = createServer((req, res) => {
    const signedIn = /(^|;\s*)session=ada(;|$)/.test(req.headers.cookie ?? '');
    if (req.url === '/font.woff2') return void (signedIn ? res.writeHead(200, { 'Content-Type': 'font/woff2' }).end(FONT) : res.writeHead(403).end());
    if (req.url === '/private.png') return void (signedIn ? res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG) : res.writeHead(403).end());
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(signedIn ? SIGNED_IN : SIGN_IN);
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;

  const out = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-extension-'));
  execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'integrations/browser-extension/build.ts'), out], { cwd: ROOT, stdio: 'ignore' });
  const extensionDir = join(out, 'chromium');
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });

  const server = await startRealServer({ editorDir: process.env.BOGEN_EDITOR_DIR });
  let browser: Browser | null = null;
  let failed = 0;
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (!ok) failed++;
    console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 800)}` : ''}`);
  };
  const shot = async (page: Page, name: string, selector?: string) => {
    if (!SHOTS) return;
    const el = selector ? await page.$(selector) : null;
    await (el ?? page).screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const errors: string[] = [];
  try {
    browser = await launch(server.port, { ports: [Number(new URL(site).port)], extensions: [extensionDir] });
    const extension = [...(await browser.extensions()).values()].find((e) => e.name === 'Bogen capture');
    check('the unpacked extension loads in the sandboxed browser', Boolean(extension));
    if (!extension) throw new Error('No extension.');

    const editor = await freshPage(browser);
    watchErrors(editor, errors);
    await editor.goto(`${server.base}/`);
    await editor.waitForSelector('[data-testid="home-settings"]', { timeout: 20000 });

    const tab = await freshPage(browser);
    await tab.setViewport({ width: 900, height: 700 });
    await tab.setCookie({ name: 'session', value: 'ada', url: site });
    await tab.goto(site);
    await tab.bringToFront();

    const openPopup = async (): Promise<Page> => {
      // One popup at a time, as in a browser: an open one closes first.
      for (const t of browser!.targets().filter((x) => x.url().endsWith('/popup.html'))) await (await t.asPage())?.close().catch(() => {});
      await sleep(200);
      await tab.triggerExtensionAction(extension);
      const target = await browser!.waitForTarget((t) => t.url().endsWith('/popup.html'), { timeout: 10000 });
      const popup = (await target.asPage())!;
      await popup.waitForFunction(() => document.querySelector('.popup')?.getAttribute('data-state') !== 'loading', { timeout: 10000 });
      return popup;
    };
    const stateOf = (popup: Page) => popup.$eval('.popup', (el) => el.getAttribute('data-state'));

    // Pairing: the popup asks, the editor shows the same code, the person allows.
    let popup = await openPopup();
    check('a fresh extension is not paired', (await stateOf(popup)) === 'unpaired');
    await popup.$eval('#base', (el, v) => { (el as HTMLInputElement).value = v; }, server.base);
    await shot(popup, 'popup-unpaired', '.popup');
    await popup.click('#pair');
    await popup.waitForFunction(() => document.querySelector('.popup')?.getAttribute('data-state') === 'waiting', { timeout: 10000 });
    const code = await popup.$eval('#code', (el) => el.textContent);
    await shot(popup, 'popup-waiting', '.popup');
    await editor.bringToFront();
    await editor.waitForSelector('[data-testid="extension-approve"]', { timeout: 10000 });
    const shown = await editor.$eval('[data-testid="extension-code"]', (el) => el.textContent);
    check('the editor shows the code the extension shows', Boolean(code) && shown === code, { code, shown });
    await shot(editor, 'editor-approve');
    await editor.click('[data-testid="extension-allow"]');
    await editor.waitForSelector('[data-testid="extension-approve"]', { hidden: true, timeout: 5000 });
    // Going to the editor closed the popup, as it does for a person; opened again, it picks up the answer.
    await tab.bringToFront();
    popup = await openPopup();
    await popup.waitForFunction(() => document.querySelector('.popup')?.getAttribute('data-state') === 'ready', { timeout: 10000 });
    check('the popup is paired once allowed', true);
    const notice = await popup.$eval('#notice', (el) => el.textContent ?? '');
    check('the popup keeps the rights notice', /right to use/.test(notice), notice);
    const tabTitle = await popup.$eval('#tab-title', (el) => el.textContent);
    check('activeTab shows the tab the person is on', tabTitle === 'Invoices · Ledgerly', tabTitle);
    await shot(popup, 'popup-ready', '.popup');

    // The whole page, as the signed-in person sees it.
    await popup.click('#capture-page');
    await popup.waitForFunction(() => document.querySelector('.popup')?.getAttribute('data-state') !== 'busy', { timeout: 60000 });
    const sentState = await stateOf(popup);
    const sentText = await popup.$eval('#sent-summary', (el) => el.textContent ?? '');
    const errText = await popup.$eval('#error', (el) => el.textContent ?? '');
    check('the page is captured from the tab', sentState === 'sent', { sentState, errText });
    check('the summary counts layers and images', /\d+ layers, [1-9]\d* images/.test(sentText), sentText);
    await shot(popup, 'popup-sent', '.popup');

    const files = await (await fetch(`${server.base}/api/files`)).json() as { id: string; name: string }[];
    const captures = files.find((f) => f.name === 'Browser captures');
    check('captures go into their own file', Boolean(captures), files.map((f) => f.name));
    const refs = await (await fetch(`${server.base}/api/references`)).json() as { title: string; source: string; palette: { hex: string }[]; type?: { families: { family: string }[] }; fileId: string; nodeId: string; url: string }[];
    const ref = refs[0];
    check('the capture is kept as a reference with a palette from the screenshot', ref?.source === 'extension' && (ref.palette.length ?? 0) > 0 && ref.url.startsWith(site), ref);
    check('the reference reads the page\'s own font', Boolean(ref?.type?.families.some((f) => f.family === 'Fixture Sans')), ref?.type);

    // What the layers hold: the signed-in content, the cookie-only image stored with the file, the font file.
    const agent = await connectAgent(server.base, 'extension-e2e');
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const res = await agent.callTool({ name, arguments: args }) as { content?: { text?: string }[] };
      return res.content?.map((c) => c.text ?? '').join('\n') ?? '';
    };
    if (ref) {
      const tree = await mcp('layer_tree', { file_id: ref.fileId, node_id: ref.nodeId, depth: 8 });
      check('the layers hold what only the signed-in person sees', tree.includes('Signed in as Ada') && tree.includes('INV-1042') && !tree.includes('Please sign in'), tree.slice(0, 600));
      const fonts = await mcp('fonts_captured', { file_id: ref.fileId });
      check('the page\'s font file is stored with the file', fonts.includes('Fixture Sans'), fonts.slice(0, 400));
      const image = await mcp('layer_find', { file_id: ref.fileId, type: 'image' });
      check('the cookie-only image is stored with the file', /bogen-asset|Ledger mark/.test(image), image.slice(0, 400));
    }

    // An element, picked on the page.
    popup = await openPopup();
    await popup.click('#capture-element');
    await tab.bringToFront();
    await sleep(500);
    const box = await tab.$eval('#invoices', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await tab.mouse.move(box.x, box.y);
    await sleep(150);
    // The pointer is over a cell: the up arrow climbs to its row, the body of the table, then the table.
    for (let i = 0; i < 3; i++) { await tab.keyboard.press('ArrowUp'); await sleep(50); }
    await shot(tab, 'page-pick-element');
    await tab.keyboard.press('Enter');
    const newest = async (count: number) => {
      for (let i = 0; i < 60; i++) {
        const now = await (await fetch(`${server.base}/api/references`)).json() as { title: string; nodeId: string; fileId: string; image?: string }[];
        if (now.length > count) return now[0];
        await sleep(500);
      }
      return undefined;
    };
    const element = await newest(refs.length);
    check('a picked element becomes an artboard of its own', Boolean(element));
    if (element) {
      const tree = await mcp('layer_tree', { file_id: element.fileId, node_id: element.nodeId, depth: 6 });
      check('the element artboard holds just the table', tree.includes('INV-1042') && !tree.includes('Signed in as Ada') && /element/.test(tree.split('\n')[0] ?? ''), tree.slice(0, 400));
      const marked = await tab.$eval('#invoices', (el) => el.hasAttribute('data-bogen-pick'));
      check('the page is left as it was', !marked);
    }
    await sleep(400);
    await shot(tab, 'page-captured-note');

    // A region, dragged over the page.
    popup = await openPopup();
    await popup.click('#capture-region');
    await tab.bringToFront();
    await sleep(500);
    await tab.mouse.move(16, 70);
    await tab.mouse.down();
    await tab.mouse.move(300, 160, { steps: 6 });
    await shot(tab, 'page-pick-region');
    await tab.mouse.up();
    const region = await newest(refs.length + 1);
    check('a dragged region becomes an artboard of its size', Boolean(region));
    if (region) {
      const tree = await mcp('layer_tree', { file_id: region.fileId, node_id: region.nodeId, depth: 2 });
      check('the region artboard is cut to the rectangle', /region/.test(tree.split('\n')[0] ?? '') && /width:284px/.test(tree.split('\n')[0] ?? '') && /height:90px/.test(tree.split('\n')[0] ?? ''), tree.slice(0, 400));
      const png = region.image ? new Uint8Array(await (await fetch(`${server.base}/assets/${region.image.slice('bogen-asset:'.length)}`)).arrayBuffer()) : new Uint8Array();
      const size = png.length > 24 ? { width: new DataView(png.buffer).getUint32(16), height: new DataView(png.buffer).getUint32(20) } : null;
      check('the picture of a region is cut to it as well', size?.width === 284 && size.height === 90, size);
    }

    // Revoke in Settings, Privacy.
    await editor.bringToFront();
    await editor.click('[data-testid="home-settings"]');
    await editor.click('[data-testid="settings-nav-privacy"]');
    await editor.waitForSelector('[data-testid="extension-pairing"]', { timeout: 5000 });
    await shot(editor, 'settings-privacy');
    await editor.click('[data-testid="settings-nav-references"]');
    await editor.waitForSelector('[data-testid="reference-card"]', { timeout: 5000 });
    await sleep(500);
    await shot(editor, 'settings-references');
    await editor.click('[data-testid="settings-nav-privacy"]');
    await editor.waitForSelector('[data-testid="extension-revoke"]', { timeout: 5000 });
    await editor.click('[data-testid="extension-revoke"]');
    await editor.waitForSelector('[data-testid="extension-pairing"]', { hidden: true, timeout: 5000 });
    popup = await openPopup();
    check('a revoked extension is told so and pairs again', (await stateOf(popup)) === 'unpaired', await popup.$eval('#error', (el) => el.textContent));
    check('the editor logged no errors', errors.length === 0, errors);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${(e as Error).stack ?? e}`);
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
    fixture.close();
  }
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
}

void main();
