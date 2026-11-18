/**
 * Generate image, through the real editor and a real server in a temporary BOGEN_HOME, in secure-chromium with its
 * sandbox on. The Codex CLI is a stand-in that writes a small PNG where Codex keeps its pictures, so nothing leaves
 * the machine.
 *
 * - an empty image layer shows Upload image and Generate side by side;
 * - the dialog guesses the shape from the layer, makes the pictures two at a time and shows them as a sheet;
 * - arrow keys move the choice, and the picked one becomes the layer's src, with the description as its alt;
 * - one picture that fails is said in its cell and can be made again, the others stay;
 * - without the CLI signed in, the same button explains how to set it up, and Check again sees the change;
 * - the palette command places a new image when nothing is selected;
 * - axe (WCAG 2.2 AA) finds nothing in the dialog in each state, dark and light.
 *
 *   (cd apps/editor && npx vite build)
 *   node --import tsx apps/editor/test/e2e/generate-image.ts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { ImageGenerator } from '../../../../packages/server/src/image-generate.ts';
import { freshPage, launch } from './craft-harness.ts';

const root = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-generate-image-'));
const shots = process.env.BOGEN_SHOTS ?? join(root, 'shots');
const bin = join(root, 'bin');
const codexHome = join(root, 'codex');
for (const d of [shots, bin, codexHome]) mkdirSync(d, { recursive: true });
const signedOut = join(root, 'signed-out');
const failNext = join(root, 'fail-next');

// Two pictures, so the sheet shows which one is picked: a warm one and a cool one.
const PNGS = [
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACAQMAAACnuvRZAAAAA1BMVEXAUDCqt8ZiAAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACAQMAAACnuvRZAAAAA1BMVEUrPfKqOU9VAAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC',
];
writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 9.9.9'); process.exit(0); }
if (args[0] === 'login') {
  if (fs.existsSync(${JSON.stringify(signedOut)})) { console.error('Not logged in'); process.exit(1); }
  console.log('Logged in using ChatGPT'); process.exit(0);
}
const thread = 'thread-' + process.pid + '-' + Date.now();
console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));
let fail = false;
try { fs.rmSync(${JSON.stringify(failNext)}); fail = true; } catch {}
setTimeout(() => {
  if (fail) { console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } })); process.exit(1); }
  const dir = path.join(${JSON.stringify(codexHome)}, 'generated_images', thread);
  fs.mkdirSync(dir, { recursive: true });
  const pngs = ${JSON.stringify(PNGS)};
  fs.writeFileSync(path.join(dir, 'exec-1.png'), Buffer.from(pngs[process.pid % 2], 'base64'));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }));
  process.exit(0);
}, 900);
`);
chmodSync(join(bin, 'codex'), 0o755);

const generator = new ImageGenerator({ command: join(bin, 'codex'), codexHome, tmp: root });
const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false, imageGenerator: generator });
await server.listen();
const base = server.localUrl();
const browser = await launch(Number(new URL(base).port));

let passed = 0;
const failures: string[] = [];
const errors: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`pass  ${name}`); } else { failures.push(name); console.log(`FAIL  ${name}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* between states */ }
    await wait(50);
  }
  return false;
}
const exists = (page: Page, sel: string) => page.$(sel).then(Boolean);
const text = (page: Page, sel: string) => page.$eval(sel, (e) => (e as HTMLElement).innerText).catch(() => '');
const click = (page: Page, sel: string) => page.$eval(sel, (e) => (e as HTMLElement).click());
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
async function axe(page: Page, sel: string): Promise<string[]> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(axeSource);
  return page.evaluate(async (s) => {
    const r = await (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe.run(
      { include: [[s]] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((v) => `${v.id} x${v.nodes.length}`);
  }, sel);
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) });

const entry = server.storage.create('Teahouse');
const room = await server.rooms.get(entry.id);
const pageId = room.doc.getPages()[0]!.id;
const board = room.doc.insert(pageId, { type: 'frame', name: 'Home', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '1200px', height: '700px', background: '#f4f2ec' } });
const hero = room.doc.insert(board, { type: 'image', tag: 'img', name: 'Hero photo', style: { width: '1200px', height: '520px', objectFit: 'cover' } });
room.doc.invalidate();
const ready = (page: Page) => until(() => page.evaluate(() => Boolean(document.querySelector('[data-testid="editor"]')) && !document.querySelector('[data-testid="loading"]')), 20_000);
const selectLayer = async (page: Page, name: string) => {
  await page.waitForSelector('[data-testid="layer-row"]', { timeout: 10_000 });
  const rows = await page.$$('[data-testid="layer-row"]');
  for (const r of rows) if ((await r.evaluate((e) => e.textContent ?? '')).includes(name)) { await r.click(); return true; }
  return false;
};

try {
  for (const scheme of ['dark', 'light'] as const) {
    const page = await freshPage(browser);
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.goto(`${base}/#/file/${entry.id}`);
    await ready(page);
    if (scheme === 'light') {
      // The light pass only checks the states for accessibility.
      room.doc.updateFields(hero, { src: undefined });
      check('light: the layer is selected', await selectLayer(page, 'Hero photo'));
      await page.waitForSelector('[data-testid="image-generate"]', { timeout: 10_000 });
      await click(page, '[data-testid="image-generate"]');
      await page.waitForSelector('[data-testid="generate-prompt"]', { timeout: 10_000 });
      check('light: the prompt has no accessibility findings', (await axe(page, '[data-testid="generate-dialog"]')).length === 0, await axe(page, '[data-testid="generate-dialog"]'));
      await page.type('[data-testid="generate-prompt"]', 'a teapot by a window');
      await click(page, '[data-testid="generate-count-2"]');
      await click(page, '[data-testid="generate-start"]');
      await until(async () => (await page.$$('[data-testid="generate-picture"]')).length === 2);
      check('light: the sheet has no accessibility findings', (await axe(page, '[data-testid="generate-dialog"]')).length === 0, await axe(page, '[data-testid="generate-dialog"]'));
      await shot(page, '06-sheet-light');
      await page.keyboard.press('Escape');
      check('light: Escape closes it', await until(async () => !(await exists(page, '[data-testid="generate-dialog"]'))));
      await page.close();
      continue;
    }

    check('the image layer is selected', await selectLayer(page, 'Hero photo'));
    await page.waitForSelector('[data-testid="image-generate"]', { timeout: 10_000 });
    check('an empty image offers Upload image and Generate side by side', (await text(page, '.image-actions')).includes('Upload image') && (await text(page, '.image-actions')).includes('Generate'), await text(page, '.image-actions'));
    await click(page, '[data-testid="image-generate"]');
    await page.waitForSelector('[data-testid="generate-prompt"]', { timeout: 10_000 });
    check('the dialog names the layer the picture goes into', (await text(page, '[data-testid="generate-dialog"]')).includes('Hero photo'));
    check('it guesses Wide for a 1200 x 520 layer', await page.$eval('[data-testid="generate-aspect-wide"]', (e) => e.getAttribute('aria-checked') === 'true'));
    check('the prompt has the focus', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'generate-prompt'));
    check('Generate waits for a description', await page.$eval('[data-testid="generate-start"]', (e) => (e as HTMLButtonElement).disabled));
    check('the prompt has no accessibility findings', (await axe(page, '[data-testid="generate-dialog"]')).length === 0, await axe(page, '[data-testid="generate-dialog"]'));
    await page.type('[data-testid="generate-prompt"]', 'A stoneware teapot on an oak table by a window; $(id) "quoted"');
    await click(page, '[data-testid="generate-count-4"]');
    await shot(page, '01-prompt');
    await click(page, '[data-testid="generate-start"]');
    check('the pictures are made two at a time', await until(async () => (await text(page, '[data-testid="generate-sheet"]')).includes('Waiting for a free slot')), await text(page, '[data-testid="generate-sheet"]'));
    check('with progress and a Stop button', (await exists(page, '[role="progressbar"]')) && (await exists(page, '[data-testid="generate-stop"]')));
    await shot(page, '02-making');
    check('four pictures come back', await until(async () => (await page.$$('[data-testid="generate-picture"]')).length === 4, 15_000));
    check('the first is picked', await page.$eval('[data-testid="generate-picture"]', (e) => e.getAttribute('aria-selected') === 'true'));
    check('the sheet has no accessibility findings', (await axe(page, '[data-testid="generate-dialog"]')).length === 0, await axe(page, '[data-testid="generate-dialog"]'));
    await shot(page, '03-sheet');
    await page.focus('[data-testid="generate-picture"][aria-selected="true"]');
    await page.keyboard.press('ArrowRight');
    check('an arrow key picks the next', await until(async () => (await text(page, '[data-testid="generate-use"]')) === 'Use picture 2'), await text(page, '[data-testid="generate-use"]'));
    const second = await page.$$eval('[data-testid="generate-picture"] img', (els) => (els[1] as HTMLImageElement).getAttribute('src'));
    await page.keyboard.press('Enter');
    check('Enter uses it and closes the dialog', await until(async () => !(await exists(page, '[data-testid="generate-dialog"]'))));
    const node = room.doc.getNode(hero)!;
    check('the picked picture is the layer\'s src', Boolean(node.src && second?.includes(node.src.replace('bogen-asset:', ''))), { src: node.src, second });
    check('and the description its alt', node.attrs?.alt === 'A stoneware teapot on an oak table by a window; $(id) "quoted"', node.attrs);
    check('Codex\'s own copies are gone', !existsSync(join(codexHome, 'generated_images')) || readdirSync(join(codexHome, 'generated_images')).length === 0);

    // One that fails, then made again.
    await page.waitForSelector('[data-testid="image-generate-again"]', { timeout: 10_000 });
    await click(page, '[data-testid="image-generate-again"]');
    await page.waitForSelector('[data-testid="generate-prompt"]');
    check('the last description is kept', (await page.$eval('[data-testid="generate-prompt"]', (e) => (e as HTMLTextAreaElement).value)).startsWith('A stoneware teapot'));
    await click(page, '[data-testid="generate-count-2"]');
    writeFileSync(failNext, '');
    await click(page, '[data-testid="generate-start"]');
    check('one picture that fails says so in its cell', await until(async () => (await text(page, '[data-testid="generate-failed"]')).includes('usage limit reached'), 15_000), await text(page, '[data-testid="generate-sheet"]'));
    check('the other comes back', await until(async () => (await page.$$('[data-testid="generate-picture"]')).length === 1, 15_000));
    check('the failed cell has no accessibility findings', (await axe(page, '[data-testid="generate-dialog"]')).length === 0, await axe(page, '[data-testid="generate-dialog"]'));
    await shot(page, '04-one-failed');
    await click(page, '[data-testid="generate-retry"]');
    check('Try again makes only that one, and keeps the other', await until(async () => (await page.$$('[data-testid="generate-picture"]')).length === 2 && !(await exists(page, '[data-testid="generate-failed"]')), 15_000));
    await click(page, '[data-testid="generate-close"]');

    // Not signed in.
    writeFileSync(signedOut, '');
    await generator.status(true);
    await click(page, '[data-testid="image-generate-again"]');
    check('signed out, the dialog explains how to set it up', await until(async () => (await text(page, '[data-testid="generate-unavailable"]')).includes('codex login')), await text(page, '[data-testid="generate-dialog"]'));
    check('the explanation has no accessibility findings', (await axe(page, '[data-testid="generate-dialog"]')).length === 0, await axe(page, '[data-testid="generate-dialog"]'));
    await shot(page, '05-not-set-up');
    rmSync(signedOut);
    await click(page, '[data-testid="generate-recheck"]');
    check('Check again sees the sign-in', await until(() => exists(page, '[data-testid="generate-prompt"]')));
    await page.keyboard.press('Escape');
    await until(async () => !(await exists(page, '[data-testid="generate-dialog"]')));

    // The palette with nothing selected places a new image.
    await page.keyboard.press('Escape');
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    const images = () => room.doc.getChildren(pageId).filter((n) => n.type === 'image').length;
    const before = images();
    await page.keyboard.down('Control');
    await page.keyboard.press('p');
    await page.keyboard.up('Control');
    await page.waitForSelector('[data-testid="palette-input"]', { timeout: 5000 });
    await page.keyboard.type('Generate image');
    await wait(150);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="generate-prompt"]', { timeout: 10_000 });
    check('from the palette, the picture is placed in the view', (await text(page, '[data-testid="generate-dialog"]')).includes('Placed in the middle of the view'), await text(page, '[data-testid="generate-dialog"]'));
    await click(page, '[data-testid="generate-count-1"]');
    await click(page, '[data-testid="generate-start"]');
    await until(async () => (await page.$$('[data-testid="generate-picture"]')).length === 1, 15_000);
    await click(page, '[data-testid="generate-use"]');
    check('a new image layer appears', await until(() => images() === before + 1), { before });
    await page.close();
  }
  check('no page errors', !errors.length, errors);
} catch (e) {
  failures.push(String(e));
  console.log(`FAIL  ${String((e as Error).stack ?? e)}`);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed. Screenshots: ${shots}`);
process.exit(failures.length ? 1 : 0);
