/**
 * The app on a device, in a real browser against the real server, with a stand-in for tomaccoctl: the Export tab
 * says Tomacco is missing and gives its install line; once installed with no device running, the import dialog
 * gives doctor's next step after Look again; once a device runs, the screen is taken, lands beside the selected
 * artboard and opens Design versus app on the same capture. Nothing here builds or starts an app.
 * Run: node --import tsx apps/editor/test/e2e/app-screens.ts (after building the editor).
 * The browser comes from BOGEN_BROWSER, with its sandbox on; a secure-chromium wrapper is told which local port to share.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';

const home = mkdtempSync(join(tmpdir(), 'bogen-app-screens-'));
const SHOTS = process.env.SHOTS ?? join(home, 'shots');
mkdirSync(SHOTS, { recursive: true });
process.env.BOGEN_WELCOME = '0';

/** The stand-in reads whether a device runs from a file, so the test can start one between steps. */
const FIXTURE = resolve(import.meta.dirname, '../../../../packages/server/test/fixtures/tomacco/android-login');
const running = join(home, 'device-running');
const standIn = join(home, 'tomaccoctl');
writeFileSync(standIn, `#!/usr/bin/env node
const fs = require('node:fs');
const [, , cmd, op, raw] = process.argv;
const up = fs.existsSync(${JSON.stringify(running)});
const say = (v, code = 0) => { console.log(JSON.stringify(v)); process.exit(code); };
if (cmd === '--version') { console.log('tomaccoctl 1.5.0 (Tomacco)'); process.exit(0); }
if (op === 'device.list') say({ ok: true, result: { devices: up ? [{ id: 'emulator-5554', platform: 'android', model: 'Pixel 9', state: 'device' }] : [], diagnostics: [] } });
if (op === 'doctor') say({ ok: true, result: { next_steps: [{ goal: 'android', what: 'Install the Android SDK and create an emulator', how: 'Run: tomaccoctl setup --yes. It downloads about 5 GB and accepts Google\\'s Android SDK license, so tell the person that first.', ask_first: true }] } });
if (op === 'screen.export' && up) { fs.cpSync(${JSON.stringify(FIXTURE)}, JSON.parse(raw).directory, { recursive: true }); say({ ok: true, result: {} }); }
say({ ok: false, error: { code: 'refused', message: 'Not in this stand-in.' } }, 1);
`);
chmodSync(standIn, 0o755);
process.env.BOGEN_TOMACCOCTL = 'none';

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
const text = (page: Page, sel: string) => page.$eval(sel, (el) => el.textContent ?? '').catch(() => '');
async function until(fn: () => Promise<boolean>, ms = 10000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}

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
  const file = (await call('file_create', { name: 'Login' })).id;
  const design = await call('artboard_create', { name: 'Login, design', width: 360, height: 780, x: 0, y: 0, background: '#f4f2ec', file_id: file });
  await call('html_write', { file_id: file, target_id: design.id, html: '<h1 style="margin:128px 24px 0;font:700 28px/36px Arial">Sign in</h1>' });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument('window.__name = (f) => f');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/#/file/${file}`);
  await page.waitForSelector(t('tab-export'), { timeout: 15000 });
  await call('selection_set', { node_ids: [design.id], file_id: file });

  // 1. Not installed: the Export tab says so and gives Tomacco's install line to copy.
  await page.click(t('tab-export'));
  await page.waitForSelector(t('export-app'));
  check('the Export tab has the app on a device', (await text(page, t('export-app'))).includes('The app on a device'));
  check('it says Tomacco is missing', await until(async () => (await page.$eval(`${t('export-app')} ${t('tomacco-state')}`, (el) => el.getAttribute('data-state'))) === 'missing'));
  check('with the install line', (await text(page, t('tomacco-command'))).includes('https://tomacco.dev/install.sh'));
  await shot(page, 'missing');

  // 2. Installed, nothing running: Look again asks Tomacco afresh and shows doctor's next step, not run.
  process.env.BOGEN_TOMACCOCTL = standIn;
  // An agent's selection waits while the person is busy, and clicks count: open only once it has landed.
  await page.waitForSelector(`${t('export-app-compare')}:not([disabled])`, { timeout: 15000 });
  await page.click(t('export-app-import'));
  await page.waitForSelector(t('appscreen-dialog'));
  // With no device, the dialog turns to exports; the device tab has Look again.
  const lookAgain = async () => {
    // The dialog may still be settling in, so the click goes to the element and not to a point.
    await page.waitForSelector(t('appscreen-tab-device'));
    await page.$eval(t('appscreen-tab-device'), (el) => (el as HTMLElement).click());
    await page.waitForSelector(t('appscreen-look-again'));
    await page.$eval(t('appscreen-look-again'), (el) => (el as HTMLElement).click());
  };
  await lookAgain();
  check('no device: doctor\'s next step', await until(async () => (await page.$eval(`${t('appscreen-dialog')} ${t('tomacco-state')}`, (el) => el.getAttribute('data-state'))) === 'no-device'));
  check('with its command, taken out of the sentence', (await text(page, `${t('appscreen-dialog')} ${t('tomacco-command')}`)) === 'tomaccoctl setup --yes');
  check('and Tomacco\'s warning beside it', (await text(page, t('appscreen-dialog'))).includes('about 5 GB'));
  await shot(page, 'no-device');

  // 3. A device runs: take the screen, place it beside the design, and compare on the same capture.
  writeFileSync(running, '');
  await lookAgain();
  check('the device is listed', await until(async () => (await page.$$(t('appscreen-device'))).length === 1));
  await page.click(t('appscreen-take'));
  await page.waitForSelector(t('appscreen-summary'), { timeout: 30000 });
  check('compare afterwards is offered and on', await page.$eval(t('appscreen-compare-after'), (el) => (el as HTMLInputElement).checked).catch(() => false));
  await shot(page, 'taken');
  await page.click(t('appscreen-import'));
  check('the comparison opens', await until(async () => Boolean(await page.$(t('appscreen-percent'))), 30000));
  const room = await server.rooms.get(file);
  const placed = room.doc.getChildren(room.doc.getPages()[0]!.id).find((n) => n.id !== design.id && n.artboard);
  check('the screen sits beside the design', placed?.style.left === '440px' && placed?.style.top === '0px', placed?.style);
  check('the comparison names the design', (await text(page, t('appscreen-compare'))).includes('Login, design'));
  await shot(page, 'compare');
  await page.keyboard.press('Escape');
  check('the Export tab asks Tomacco again and drops its note', await until(async () => !(await page.$(`${t('export-app')} ${t('tomacco-state')}`))));

  check('no errors in the browser', errors.length === 0, errors.slice(0, 6));
} catch (e) {
  bad++;
  console.error(e);
} finally {
  await browser.close();
  await client.close();
  await server.close();
  rmSync(home, { recursive: true, force: true });
  console.log(`\n${ok} passed, ${bad} failed.`);
  process.exit(bad ? 1 : 0);
}
