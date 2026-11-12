/**
 * WebMCP in a real Chromium against the real server: the built editor registers Bogen's tools with
 * `document.modelContext`, an in-page agent calls them through `getTools` and `executeTool`, and the canvas shows the
 * result. Chromium 156 has WebMCP behind `--enable-features=WebMCP`; without it, the page gets a small stand-in of the
 * draft of 2 November 2026 before it loads.
 *
 * Run: BOGEN_EDITOR_DIR=<built editor> BOGEN_E2E_BROWSER=<chromium> [BOGEN_E2E_WEBMCP=stand-in] npx tsx apps/editor/test/e2e/webmcp.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';

const BROWSER = process.env.BOGEN_E2E_BROWSER ?? '/usr/bin/chromium';
/** Chromium 156 has WebMCP behind a switch. BOGEN_E2E_WEBMCP=stand-in leaves it off, so the page's stand-in runs. */
const NATIVE_FLAGS = process.env.BOGEN_E2E_WEBMCP === 'stand-in' ? [] : ['--enable-features=WebMCP'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};

/** Defines `document.modelContext` as the draft does, unless the browser already has it. */
const STAND_IN = `(() => {
  if ('modelContext' in Document.prototype || 'modelContext' in document) { window.__webmcpNative = true; return; }
  const tools = new Map();
  const mc = new EventTarget();
  mc.registerTool = (tool, options = {}) => {
    if (tools.has(tool.name)) return Promise.reject(new DOMException('taken', 'InvalidStateError'));
    tools.set(tool.name, { ...tool, inputSchema: JSON.parse(JSON.stringify(tool.inputSchema ?? {})) });
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => { tools.delete(tool.name); reject(options.signal.reason); });
      resolve(undefined);
    });
  };
  mc.getTools = async () => [...tools.values()].map(({ execute, ...t }) => ({ ...t, window, origin: location.origin }));
  mc.executeTool = async (tool, input = {}) => {
    const t = tools.get(tool.name);
    if (!t) throw new DOMException('tool not found', 'NotFoundError');
    return JSON.stringify(await t.execute(JSON.parse(JSON.stringify(input)), { signal: new AbortController().signal }));
  };
  Object.defineProperty(document, 'modelContext', { value: mc });
})();`;

async function execute(page: Page, name: string, input: Record<string, unknown>): Promise<any> {
  const out = await page.evaluate(async (n, i) => {
    const mc = (document as unknown as { modelContext: { getTools: () => Promise<{ name: string }[]>; executeTool: (t: unknown, i: unknown) => Promise<string> } }).modelContext;
    const tool = (await mc.getTools()).find((t) => t.name === n);
    if (!tool) return JSON.stringify({ missing: n });
    return mc.executeTool(tool, i);
  }, name, input);
  return JSON.parse(out);
}

const toolCount = (page: Page) => page.evaluate(async () => (await (document as unknown as { modelContext: { getTools: () => Promise<unknown[]> } }).modelContext.getTools()).length);

async function probeNative(browser: Browser, base: string): Promise<void> {
  const page = await browser.newPage();
  await page.goto(`${base}/api/status`);
  const found = await page.evaluate(() => ({ document: 'modelContext' in document, navigator: 'modelContext' in navigator }));
  console.log(`native WebMCP in ${await browser.version()} with its flags: ${JSON.stringify(found)}`);
  await page.close();
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'bogen-webmcp-'));
  const server = new BogenServer({ home, port: 0, exportDir: join(home, 'exports') });
  await server.listen();
  const base = server.localUrl();
  // Chromium's names for the switch over its versions; a name it does not know is ignored. The first argument
  // shares the server's port with ~/.local/bin/secure-chromium, which lets a page reach no other local port.
  const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, pipe: true, args: [`--secure-local-port=${server.port}`, ...NATIVE_FLAGS, '--window-size=1400,900'], defaultViewport: { width: 1400, height: 900 } });
  try {
    await probeNative(browser, base);
    const { id: fileId } = (await (await fetch(`${base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'WebMCP e2e' }) })).json()) as { id: string };
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.evaluateOnNewDocument(STAND_IN);
    await page.goto(`${base}/#/file/${fileId}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 20000 }).catch(async (e: unknown) => {
      console.log(`page: ${page.url()} ${(await page.evaluate(() => document.body?.innerText ?? '')).slice(0, 400)} ${errors.join(' | ')}`);
      throw e;
    });
    console.log(`running on ${(await page.evaluate(() => (window as unknown as { __webmcpNative?: boolean }).__webmcpNative)) ? 'the browser\'s own WebMCP' : 'the stand-in'}`);
    let count = 0;
    for (let i = 0; i < 100 && count < 100; i++) {
      count = await toolCount(page);
      await sleep(100);
    }
    check('the editor registers Bogen\'s tools with document.modelContext', count > 100, count);

    const activity: { agent: string; tool: string }[] = [];
    server.hub.tap((e) => {
      if (e.t === 'activity') activity.push(e);
    });
    const made = await execute(page, 'artboard_create', { name: 'Made in the browser', width: 480, x: 0, y: 0 });
    const boardId = JSON.parse(made.content?.[0]?.text ?? '{}').id as string;
    check('artboard_create through WebMCP', Boolean(boardId) && !made.isError, made);
    const shown = await page.waitForSelector(`[data-bogen-id="${boardId}"]`, { timeout: 5000 }).then(() => true, () => false);
    check('the canvas shows the new artboard', shown);
    const written = await execute(page, 'html_write', { parent_id: boardId, html: '<h1 style="font-size:40px;margin:24px">Hello from WebMCP</h1>' });
    check('html_write through WebMCP', !written.isError, written);
    const text = await page.waitForFunction(() => document.body.innerText.includes('Hello from WebMCP'), { timeout: 5000 }).then(() => true, () => false);
    check('the canvas shows the written text', text);
    const room = await server.rooms.get(fileId);
    check('the server holds it, made by the agent webmcp', room.doc.getNode(boardId) !== undefined && activity.some((a) => a.agent === 'webmcp' && a.tool === 'artboard_create'), activity);

    // The browser's own dialog: no first, then yes.
    let answer = false;
    const asked: string[] = [];
    page.on('dialog', (d) => {
      asked.push(d.message());
      void (answer ? d.accept() : d.dismiss());
    });
    const refused = await execute(page, 'layer_delete', { node_ids: [boardId] });
    check('layer_delete asks in a dialog and stops on no', refused.isError === true && asked.length === 1 && asked[0]!.includes('layer_delete'), { refused, asked });
    check('the artboard is still there', room.doc.getNode(boardId) !== undefined);
    answer = true;
    const deleted = await execute(page, 'layer_delete', { node_ids: [boardId] });
    check('on yes it is deleted', !deleted.isError && room.doc.getNode(boardId) === undefined, deleted);
    const gone = await page.waitForSelector(`[data-bogen-id="${boardId}"]`, { hidden: true, timeout: 5000 }).then(() => true, () => false);
    check('and gone from the canvas', gone);

    // Settings: Off takes every tool away, Allowed brings them back.
    await page.keyboard.down('Control');
    await page.keyboard.press(',');
    await page.keyboard.up('Control');
    await page.waitForSelector('[data-testid="setting-webmcp"]');
    await page.click('[data-testid="setting-webmcp-off"]');
    await sleep(300);
    check('Off in Settings unregisters the tools', (await toolCount(page)) === 0, await toolCount(page));
    await page.click('[data-testid="setting-webmcp-on"]');
    let back = 0;
    for (let i = 0; i < 50 && back < 100; i++) {
      back = await toolCount(page);
      await sleep(100);
    }
    check('Allowed registers them again', back > 100, back);
    await page.keyboard.press('Escape');

    await page.goto(`${base}/#/`);
    await page.waitForSelector('[data-testid="home"]');
    await sleep(300);
    check('closing the file unregisters the tools', (await toolCount(page)) === 0, await toolCount(page));
    check('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
}

void main();
