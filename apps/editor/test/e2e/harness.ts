import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer-core';
import { BogenDoc, type BogenNode } from '@bogen/core';
import { startMockServer, type MockServer } from '../../test-support/mock-server.ts';

export const SHOTS = resolve(import.meta.dirname, '../../screenshots');
mkdirSync(SHOTS, { recursive: true });
const PROFILE_ROOT = resolve(import.meta.dirname, '../../.out/profiles');
mkdirSync(PROFILE_ROOT, { recursive: true });

export interface Ctx {
  server: MockServer;
  browser: Browser;
  base: string;
  results: { name: string; ok: boolean; detail?: string }[];
}

export async function setup(): Promise<Ctx> {
  const server = await startMockServer(Number(process.env.E2E_PORT ?? 0));
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    userDataDir: resolve(PROFILE_ROOT, `p${Date.now()}`),
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--window-size=1500,960'],
    defaultViewport: { width: 1500, height: 960 },
  });
  return { server, browser, base: `http://127.0.0.1:${server.port}`, results: [] };
}

export async function teardown(ctx: Ctx): Promise<void> {
  await ctx.browser.close();
  await ctx.server.close();
}

export function check(ctx: Ctx, name: string, ok: boolean, detail?: unknown): void {
  ctx.results.push({ name, ok, ...(detail !== undefined ? { detail: String(typeof detail === 'object' ? JSON.stringify(detail) : detail) } : {}) });
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${typeof detail === 'object' ? JSON.stringify(detail) : String(detail)}` : ''}`);
}

export function summary(ctx: Ctx): number {
  const failed = ctx.results.filter((r) => !r.ok);
  console.log(`\n${ctx.results.length - failed.length}/${ctx.results.length} checks passed`);
  for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail ?? ''}`);
  return failed.length;
}

export function watchErrors(page: Page, sink: string[]): void {
  page.on('pageerror', (e) => sink.push(`pageerror: ${(e as Error).message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/fonts\.g|net::ERR|Failed to load resource|WebSocket connection/.test(m.text())) sink.push(`console: ${m.text()}`);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function shot(page: Page, name: string): Promise<string> {
  const path = resolve(SHOTS, `${name}.png`);
  await page.screenshot({ path: path as `${string}.png` });
  return path;
}

export function docOf(ctx: Ctx, fileId: string): BogenDoc {
  const rec = ctx.server.files.get(fileId);
  if (!rec) throw new Error(`no file ${fileId}`);
  return new BogenDoc(rec.doc);
}

export function allNodes(doc: BogenDoc): BogenNode[] {
  const out: BogenNode[] = [];
  doc.nodes.forEach((_, id) => {
    const n = doc.getNode(id);
    if (n) out.push(n);
  });
  return out;
}

export async function newFilePage(ctx: Ctx, name = 'Test', browserCtx?: { newPage: () => Promise<Page> }): Promise<{ page: Page; fileId: string; errors: string[] }> {
  const res = await fetch(`${ctx.base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  const { id } = (await res.json()) as { id: string };
  const page = await (browserCtx ?? ctx.browser).newPage();
  // tsx names the functions it compiles, including those sent to the page.
  await page.evaluateOnNewDocument('window.__name = (f) => f');
  const errors: string[] = [];
  watchErrors(page, errors);
  await page.goto(`${ctx.base}/#/file/${id}`);
  await page.waitForSelector('[data-testid="canvas"]');
  await sleep(150);
  return { page, fileId: id, errors };
}

/** Bounding box of the canvas viewport in client coordinates. */
export async function canvasBox(page: Page) {
  const b = await page.$eval('[data-testid="canvas"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  return b;
}

export async function drag(page: Page, x0: number, y0: number, x1: number, y1: number, steps = 8): Promise<void> {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
  await page.mouse.up();
  await sleep(30);
}

export async function pressKey(page: Page, combo: string): Promise<void> {
  const parts = combo.split('+');
  const key = parts.pop()!;
  for (const m of parts) await page.keyboard.down(m as 'Control');
  await page.keyboard.press(key as 'a');
  for (const m of parts.reverse()) await page.keyboard.up(m as 'Control');
  await sleep(20);
}

export async function clickTest(page: Page, id: string): Promise<void> {
  const el = await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 3000 });
  await (el as ElementHandle<Element>).click();
  await sleep(20);
}

/** Types into an inspector field and commits it. */
export async function fillField(page: Page, id: string, value: string): Promise<void> {
  const el = await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 3000 });
  await (el as ElementHandle<Element>).click();
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
  await sleep(30);
}

/** Rect of a layer on screen. */
export async function layerRect(page: Page, id: string) {
  return page.$eval(`[data-bogen-id="${id}"]`, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
}

/** Fires a real paste event with this clipboard data at the document. */
export async function paste(page: Page, data: Record<string, string>): Promise<void> {
  await page.evaluate((d) => {
    const dt = new DataTransfer();
    for (const [k, v] of Object.entries(d)) dt.setData(k, v);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, data);
  await sleep(60);
}
