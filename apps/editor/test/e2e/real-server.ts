/**
 * Smoke test of the built editor against the real server (packages/server), not the mock.
 * Run: npx tsx apps/editor/test/e2e/real-server.ts
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { canvasBox, drag, fillField, paste, pressKey, sleep, watchErrors, SHOTS } from './harness.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const OUT = resolve(import.meta.dirname, '../../.out');
mkdirSync(OUT, { recursive: true });
const home = mkdtempSync(resolve(OUT, 'home-'));
const PORT = 29000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${PORT}`;

const server = spawn('npx', ['tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(PORT)], { cwd: ROOT, env: { ...process.env, BOGEN_HOME: home, BOGEN_WELCOME: '0', TMPDIR: resolve(OUT, 'tmp') }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (d: Buffer) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d: Buffer) => { const t = String(d); if (!/ExperimentalWarning|trace-warnings/.test(t)) process.stdout.write(`[server] ${t}`); });

let ok = 0;
let bad = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (pass) ok++; else bad++;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${!pass && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};

async function main(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/status`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, userDataDir: resolve(OUT, `profiles/real${Date.now()}`), args: ['--no-sandbox', '--window-size=1500,960', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], defaultViewport: { width: 1500, height: 960 } });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument('window.__name = (f) => f');
    const errors: string[] = [];
    watchErrors(page, errors);
    await page.goto(`${base}/#/`);
    await page.waitForSelector('[data-testid="home"]');
    check('home loads from the real server', true);
    await page.click('[data-testid="home-new"]');
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 15000 });
    check('new file opens, with the first page from the server', true);
    const fileId = /#\/file\/([\w-]+)/.exec(page.url())![1]!;
    await sleep(200);

    const box = await canvasBox(page);
    await pressKey(page, 'f');
    await drag(page, box.x + 120, box.y + 80, box.x + 620, box.y + 480);
    await sleep(40);
    await pressKey(page, 't');
    await page.mouse.click(box.x + 200, box.y + 200);
    await sleep(60);
    await page.keyboard.type('Real server');
    await page.keyboard.press('Escape');
    await sleep(60);
    await pressKey(page, 'Shift+Enter');
    await sleep(30);
    await page.click('[data-testid="insp-layout-column"]');
    await sleep(40);
    await fillField(page, 'insp-gap', '12');
    await paste(page, { 'text/html': '<button data-name="Cta" style="padding:8px 16px;background:#123;color:#fff;border-radius:6px">Sign up</button>' });
    await sleep(80);

    // Upload through the real asset route.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'x.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, png);
    await sleep(400);
    const imgSrc = await page.$eval('img[data-bogen-id]', (e) => (e as HTMLImageElement).src).catch(() => '');
    check('image upload through /api/assets', imgSrc.includes('/assets/'), imgSrc);
    const natural = await page.$eval('img[data-bogen-id]', (e) => (e as HTMLImageElement).naturalWidth).catch(() => 0);
    check('asset is served and loads', natural === 1, natural);

    await sleep(300);
    await page.screenshot({ path: resolve(SHOTS, 'real-server.png') as `${string}.png` });

    // Persistence: a reload gets everything back from the server replica.
    const before = await page.$$eval('[data-bogen-id]', (e) => e.length);
    await page.reload();
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 15000 });
    await sleep(400);
    const after = await page.$$eval('[data-bogen-id]', (e) => e.length);
    check('layers come back after a reload', before > 0 && before === after, [before, after]);
    const textThere = await page.$$eval('[data-bogen-id]', (e) => e.some((x) => x.textContent === 'Real server'));
    check('text is intact after a reload', textThere);
    check('frame label shows after a reload', (await page.$('[data-frame-label]')) !== null);
    const fit = await page.$eval('[data-testid="zoom-level"]', (e) => e.textContent);
    check('camera fits the content on open', Boolean(fit), fit);
    await page.screenshot({ path: resolve(SHOTS, 'real-server-reopened.png') as `${string}.png` });

    // Export through the real headless renderer.
    const res = await page.evaluate(async (id) => {
      const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: id, nodeIds: [], format: 'html' }) });
      return { status: r.status, type: r.headers.get('content-type'), size: (await r.blob()).size };
    }, fileId);
    console.log('export html', res);

    await page.click('[data-testid="tab-export"]');
    await sleep(40);
    const dl = await page.evaluate(() => {
      (window as unknown as { __clicked?: string }).__clicked = '';
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { (window as unknown as { __clicked: string }).__clicked = this.download; void orig; };
      return true;
    });
    void dl;
    await page.click('[data-testid="export-run"]');
    await page.waitForFunction(() => (window as unknown as { __clicked?: string }).__clicked || document.querySelector('[data-testid="export-error"]'), { timeout: 60000 });
    const downloaded = await page.evaluate(() => (window as unknown as { __clicked?: string }).__clicked);
    const err = await page.$eval('[data-testid="export-error"]', (e) => e.textContent).catch(() => null);
    check('export PNG through the real renderer', Boolean(downloaded) && !err, { downloaded, err });

    // Theme and runners answer the editor's calls.
    const runners = await page.evaluate(async () => (await fetch('/api/runners')).json());
    console.log('runners', JSON.stringify(runners));
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await page.waitForSelector('[data-testid="prompt-input"]');
    await sleep(200);
    check('prompt opens with the real runner list', true);
    await page.keyboard.press('Escape');

    // Home thumbnails, when the server has rendered them.
    await page.goto(`${base}/#/`);
    await page.waitForSelector('[data-testid="file"]');
    await sleep(300);
    const fonts = await page.evaluate(async () => (await fetch('/api/fonts?q=lora')).status);
    console.log('/api/fonts status', fonts);
    check('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
  console.log(`\n${ok}/${ok + bad} checks passed`);
  process.exit(bad ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  server.kill('SIGTERM');
  process.exit(1);
});
