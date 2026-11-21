/**
 * Device frames in a real browser against the real server: a phone artboard and a web artboard framed on the canvas
 * (the frame drawn around them, the label above the device, the inspector's device row), and the phone screen put
 * live into a device layer in a landing page.
 * Run: node --import tsx apps/editor/test/e2e/device-frames.ts (after building the editor).
 * The browser comes from BOGEN_BROWSER, with its sandbox on; a secure-chromium wrapper is told which local port to share.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';

const home = mkdtempSync(join(tmpdir(), 'bogen-device-frames-'));
const SHOTS = process.env.SHOTS ?? join(home, 'shots');
mkdirSync(SHOTS, { recursive: true });
process.env.BOGEN_WELCOME = '0';
const server = new BogenServer({ home, port: 29100 + Math.floor(Math.random() * 700), exportDir: join(home, 'exports') });
await server.listen();
const base = server.localUrl();
const port = Number(new URL(base).port);

let ok = 0;
let bad = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (pass) ok++; else bad++;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${!pass && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
const t = (id: string) => `[data-testid="${id}"]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) as `${string}.png` });

const client = new Client({ name: 'setup', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  const out = (r.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${out}`);
  return JSON.parse(out);
};

const browserPath = process.env.BOGEN_BROWSER ?? '/usr/bin/chromium';
const browser = await puppeteer.launch({
  executablePath: browserPath, headless: true, pipe: true, userDataDir: join(home, 'profile'), defaultViewport: { width: 1500, height: 960 },
  args: ['--window-size=1500,960', ...(/secure-chromium$/.test(browserPath) ? [`--secure-local-port=${port}`] : [])],
});
try {
  const file = (await call('file_create', { name: 'Devices' })).id;
  const phone = await call('artboard_create', { name: 'Today', width: 393, height: 852, x: 0, y: 0, background: '#f4f1ea', file_id: file });
  await call('html_write', { file_id: file, target_id: phone.id, html: '<div style="padding:64px 24px 0;font:600 15px/20px system-ui;color:#6b6457">Friday, 20 November</div><h1 style="margin:6px 24px 0;font:700 34px/40px system-ui;color:#1d1a15">Today</h1><div style="margin:24px;height:180px;border-radius:20px;background:#d8573a"></div><div style="margin:0 24px;height:80px;border-radius:16px;background:#e7e0d2"></div>' });
  const web = await call('artboard_create', { name: 'Landing', width: 1440, height: 900, x: 560, y: 0, background: '#ffffff', file_id: file });
  await call('html_write', { file_id: file, target_id: web.id, html: '<h1 style="margin:160px 120px 24px;font:700 72px/76px system-ui;color:#1d1a15;max-width:640px">The day, planned before coffee.</h1>' });
  const framedPhone = await call('device_frame', { file_id: file, around: phone.id });
  check('the phone artboard gets the iPhone of its size', framedPhone.device === 'iphone-16', framedPhone);
  const framedWeb = await call('device_frame', { file_id: file, around: web.id });
  check('a desktop artboard gets a browser window', framedWeb.device === 'browser', framedWeb);
  const layer = await call('device_frame', { file_id: file, source: phone.id, parent_id: web.id, x: 940, y: 80, width: 400 });
  check('the phone goes live into a device layer in the landing page', !!layer.id && layer.device === 'iphone-16', layer);

  const page = await browser.newPage();
  await page.evaluateOnNewDocument('window.__name = (f) => f');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/#/file/${file}`);
  await page.waitForSelector(t('device-frame'), { timeout: 20000 });
  await sleep(1200);
  check('two frames are drawn on the canvas', (await page.$$(t('device-frame'))).length === 2);
  check('the phone artboard is rounded to its screen on the canvas', !!(await page.$(t('device-frame-clips'))));
  const geometry = await page.evaluate((id) => {
    const frame = document.querySelector(`[data-testid="device-frame"][data-frame="${id}"]`)!.getBoundingClientRect();
    const label = document.querySelector(`[data-frame-label="${id}"]`)!.getBoundingClientRect();
    const board = document.querySelector(`[data-bogen-id="${id}"]`)!.getBoundingClientRect();
    return { frameTop: frame.top, labelBottom: label.bottom, boardTop: board.top, frameLeft: frame.left, boardLeft: board.left };
  }, phone.id);
  check('the frame reaches past the artboard', geometry.frameTop < geometry.boardTop && geometry.frameLeft < geometry.boardLeft, geometry);
  check('the label sits above the device, not on its bezel', geometry.labelBottom <= geometry.frameTop + 2, geometry);
  await shot(page, '1-canvas');

  // The inspector of the phone artboard.
  await page.click(`[data-frame-label="${phone.id}"]`).catch(() => {});
  await page.waitForSelector(t('insp-device-frame'), { timeout: 8000 }).catch(() => {});
  const value = await page.$eval(t('insp-device-frame'), (el) => (el as HTMLSelectElement).value).catch(() => '');
  check('the inspector shows the artboard\'s device frame', value === 'iphone-16', value);
  await page.select(t('insp-device-frame'), 'pixel-11').catch(() => {});
  await sleep(500);
  check('choosing another device keeps the frame', (await page.$$(t('device-frame'))).length === 2);
  await shot(page, '2-inspector');
  await page.select(t('insp-device-frame'), '').catch(() => {});
  await sleep(400);
  check('None removes the frame', (await page.$$(t('device-frame'))).length === 1);
  check('no page errors', errors.length === 0, errors);
} finally {
  await browser.close();
  await client.close();
  await server.close();
  if (!process.env.SHOTS) rmSync(home, { recursive: true, force: true });
}
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
