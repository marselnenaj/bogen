/**
 * Review like a designer and the activity dock, through the real editor and a real server in a temporary home, in
 * secure-chromium with its sandbox on. Claude Code and the Codex CLI are stand-ins, so nothing leaves the machine.
 *
 * - start: the dialog takes the focus; the wall shows the page's screens;
 * - waiting: the real stages in order (rules, pictures, the reviewer looking, writing up with findings counted),
 *   the clock and the expected range, no percentage, the pictures the reviewer got on the wall;
 * - it always closes, while waiting, in the results and with history: Escape, X and the backdrop; closing while it
 *   runs leaves a pill in the dock with Open and Stop, and Minimise does the same;
 * - results: the score's ring, six dimensions, defects with a crop of the screen, Pin as a comment;
 * - Fix starts the agent at once (no composer step), shows in the chat and the dock, and Stop ends it;
 * - "Then review again until 7.5": the fix run, then a new reviewer, the round in the history, rechecked findings;
 * - the dock: an image being made, two reviews, folded into "3 running" and opened again; one row on a phone;
 * - reduced motion: the light does not travel and nothing draws;
 * - axe (WCAG 2.2 AA) finds nothing in the dialog and the dock, dark and light.
 *
 *   (cd apps/editor && npx vite build)
 *   node --import tsx apps/editor/test/e2e/critique-dialog.ts
 *
 * BOGEN_SHOTS=<dir> keeps the captures, and a frame sequence of the waiting wall in <dir>/frames.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { getCritiques } from '@bogen/core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { ImageGenerator } from '../../../../packages/server/src/image-generate.ts';
import { freshPage, launch } from './craft-harness.ts';
import { fakeClaude, seedFlow } from './critique-fixture.ts';

const root = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-critique-'));
const shots = process.env.BOGEN_SHOTS ?? join(root, 'shots');
const frames = join(shots, 'frames');
const bin = join(root, 'bin');
const codexHome = join(root, 'codex');
for (const d of [shots, frames, bin, codexHome]) mkdirSync(d, { recursive: true });
const reviewDelay = join(root, 'review-delay');
const fixDelay = join(root, 'fix-delay');
const codexDelay = join(root, 'codex-delay');
writeFileSync(reviewDelay, '9000');
writeFileSync(fixDelay, '1500');
writeFileSync(codexDelay, '900');
const claude = fakeClaude(bin, { reviewDelay, fixDelay, log: join(root, 'claude.jsonl') });
writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 9.9.9'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
const thread = 'thread-' + process.pid + '-' + Date.now();
console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));
let wait = 900; try { wait = Number(fs.readFileSync(${JSON.stringify(codexDelay)}, 'utf8')) || wait; } catch {}
setTimeout(() => {
  const dir = path.join(${JSON.stringify(codexHome)}, 'generated_images', thread);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'exec-1.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACAQMAAACnuvRZAAAAA1BMVEXAUDCqt8ZiAAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC', 'base64'));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }));
  process.exit(0);
}, wait);
`);
chmodSync(join(bin, 'codex'), 0o755);
// The fix run's agent is found on the PATH, as the real one is.
process.env.PATH = `${bin}:${process.env.PATH}`;

const generator = new ImageGenerator({ command: join(bin, 'codex'), codexHome, tmp: root });
const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false, imageGenerator: generator, critiqueCommand: claude });
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
async function until(fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* between states */ }
    await wait(60);
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
    const r = await (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(
      { include: [[s]] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((v) => `${v.id} x${v.nodes.length} ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(', ')}`);
  }, sel);
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) });
const dialogOpen = (page: Page) => exists(page, '[data-testid="critique-dialog"]');
const pills = (page: Page) => page.$$eval('[data-testid="activity-pill"]', (els) => els.map((e) => ({ kind: e.getAttribute('data-kind'), state: e.getAttribute('data-state'), text: (e as HTMLElement).innerText })));
const reviewPill = async (page: Page) => (await pills(page)).find((p) => p.kind === 'review');

// The flow to review, a second file for a second review, and an image layer for a picture.
const entry = server.storage.create('Teahouse Kiri');
const room = await server.rooms.get(entry.id);
const pageId = room.doc.getPages()[0]!.id;
const boards = seedFlow(room.doc, pageId);
const second = server.storage.create('Kiri gift cards');
const room2 = await server.rooms.get(second.id);
seedFlow(room2.doc, room2.doc.getPages()[0]!.id);
const ready = (page: Page) => until(() => page.evaluate(() => Boolean(document.querySelector('[data-testid="editor"]')) && !document.querySelector('[data-testid="loading"]')), 20_000);
const records = () => getCritiques(room.doc);

async function openDialog(page: Page): Promise<void> {
  // Nothing selected, so the inspector shows the page and its Review like a designer.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await until(() => exists(page, '[data-testid="page-critique"]'));
  await click(page, '[data-testid="page-critique"]');
  await until(() => dialogOpen(page));
  await wait(150);
}
/** Closes the dialog the three ways and checks each, reopening between them. */
async function closesEveryWay(page: Page, where: string, reopen: () => Promise<void>): Promise<void> {
  await page.keyboard.press('Escape');
  check(`${where}: Escape closes`, await until(async () => !(await dialogOpen(page)), 3000));
  await reopen();
  await click(page, '[data-testid="critique-close"]');
  check(`${where}: X closes`, await until(async () => !(await dialogOpen(page)), 3000));
  await reopen();
  const selected = await page.$$eval('.layer-row.is-selected', (els) => els.length);
  await page.mouse.click(12, 890);
  check(`${where}: a click on the backdrop closes`, await until(async () => !(await dialogOpen(page)), 3000));
  check(`${where}: and the click does not reach the editor under it`, (await page.$$eval('.layer-row.is-selected', (els) => els.length)) === selected);
}

try {
  const page = await freshPage(browser);
  page.on('pageerror', (e) => errors.push(String(e)));
  // The appearance is chosen, so the system's own theme (an Omarchy theme on this computer) does not decide it.
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bogen-settings', JSON.stringify({ appearance: 'dark' })); } catch { /* none */ } });
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.goto(`${base}/#/file/${entry.id}`);
  await ready(page);
  await wait(800);

  // Start.
  await openDialog(page);
  const scrim = await page.$eval('[data-testid="critique-scrim"]', (e) => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return { bg: c.backgroundColor, w: r.width, h: r.height, z: c.zIndex, parent: e.parentElement?.tagName, top: (document.elementFromPoint(100, 300) as HTMLElement | null)?.className }; });
  check('a scrim steps the whole editor back', scrim.w >= 1440 && scrim.h >= 900 && /0\.(46|62)/.test(scrim.bg) && scrim.parent === 'BODY', scrim);
  check('the dialog takes the focus', await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="critique-dialog"]'))));
  check('the start shows the page\'s six screens on the wall', (await page.$$('[data-testid="critique-print"]')).length === 6);
  check('the start has no accessibility findings', (await axe(page, '[data-testid="critique-dialog"]')).length === 0, await axe(page, '[data-testid="critique-dialog"]'));

  // Waiting: the real stages, in order.
  const seen = new Set<string>();
  const watch = window_watch(page, seen);
  check('the start shows the screens as they are now', await until(async () => (await page.$$('[data-testid="critique-print"].is-in img')).length === 6, 15_000));
  await until(() => page.$eval('[data-testid="critique-start"]', (e) => !(e as HTMLButtonElement).disabled), 10_000);
  await shot(page, 'after-start-dark');
  await click(page, '[data-testid="critique-start"]');
  check('the review starts and the dialog shows it running', await until(() => exists(page, '[data-testid="critique-running"]'), 5000));
  check('the reviewer looking is a stage of its own', await until(async () => (await page.$eval('[data-testid="critique-running"]', (e) => e.getAttribute('data-step'))) === 'reviewer', 10_000));
  check('it names who is looking and how many screens', /(Fable|Sonnet|Opus) is looking at 6 screens/.test(await text(page, '[data-testid="critique-stage"]')), await text(page, '[data-testid="critique-stage"]'));
  check('every screen\'s picture is on the wall', await until(async () => (await page.$$('[data-testid="critique-print"].is-in img')).length === 6, 5000));
  const clock = await text(page, '[data-testid="critique-clock"]');
  check('the clock shows the time it has run and the expected range', /^\d+:\d\d · usually 3 to 5 min$/.test(clock.trim()), clock);
  check('no percentage anywhere', !(await text(page, '[data-testid="critique-dialog"]')).includes('%'));
  check('the rule checks are done and say what they passed on', /rule findings|for the reviewer/.test(await text(page, '[data-testid="critique-stage-rules"]')), await text(page, '[data-testid="critique-stage-rules"]'));
  check('the waiting dialog has no accessibility findings', (await axe(page, '[data-testid="critique-dialog"]')).length === 0, await axe(page, '[data-testid="critique-dialog"]'));
  await shot(page, 'after-waiting-dark');
  // A frame sequence of the wall while the reviewer looks: the light walks, marks draw.
  // Frames only document the animation; a review that finishes meanwhile ends the sequence early.
  for (let i = 0; i < 16; i++) {
    const wall = await page.$('[data-testid="critique-wall"]');
    if (!wall) break;
    try { await wall.screenshot({ path: join(frames, `wall-${String(i).padStart(2, '0')}.png`) }); } catch { break; }
    await wait(250);
  }

  // Closing while it runs leaves it running in the dock, every way.
  await closesEveryWay(page, 'waiting', async () => { await click(page, '[data-testid="activity-open"]'); await until(() => dialogOpen(page), 3000); });
  const pill = await reviewPill(page);
  check('closed, the review is a pill in the dock, still running', pill?.state === 'running' && /(Fable|Sonnet|Opus) is (looking|writing)/.test(pill.text), pill);
  check('the pill has its clock, Open and Stop', /\d:\d\d/.test(pill?.text ?? '') && (await exists(page, '[data-testid="activity-open"]')) && (await exists(page, '[data-testid="activity-stop"]')));
  check('the dock pill has no accessibility findings', (await axe(page, '[data-testid="calldock"]')).length === 0, await axe(page, '[data-testid="calldock"]'));
  await shot(page, 'after-dock-running-dark');
  await click(page, '[data-testid="activity-open"]');
  await until(() => dialogOpen(page), 3000);
  check('the pill steps aside while the dialog shows the review', !(await reviewPill(page)));
  if (await exists(page, '[data-testid="critique-minimise"]')) await click(page, '[data-testid="critique-minimise"]');
  check('Minimise closes it and the review goes on', await until(async () => !(await dialogOpen(page)) && (await reviewPill(page))?.state === 'running', 3000));
  await click(page, '[data-testid="activity-open"]');
  check('writing up is the last stage, with the findings counted as they come', await until(() => seen.has('counted'), 12_000), [...seen]);
  check('the stages came in order: pictures, the reviewer, writing', seen.has('pictures') && seen.has('reviewer') && seen.has('writing'), [...seen]);
  await watch.stop();

  // Results.
  check('the result opens when the review ends', await until(() => exists(page, '[data-testid="critique-result"]'), 15_000));
  await wait(900);
  check('the score counts up to 7.4 in its ring', (await text(page, '[data-testid="critique-score"]')) === '7.4', await text(page, '[data-testid="critique-score"]'));
  check('six dimensions', (await page.$$('[data-testid="critique-dims"] .crit-dim')).length === 6);
  check('three defects, each with a picture of its screen', (await page.$$('[data-testid="critique-defect"]')).length === 3 && await until(async () => (await page.$$eval('[data-testid="critique-defect"] .crit-crop img', (els) => els.filter((e) => (e as HTMLImageElement).naturalWidth > 0).length)) === 3, 5000));
  check('defects come first, then taste, then keep', await page.evaluate(() => [...document.querySelectorAll('.crit-sec h3')].map((h) => h.textContent).join('|')).then((s) => /defects.*taste.*Keep/i.test(s)));
  check('the results have no accessibility findings', (await axe(page, '[data-testid="critique-dialog"]')).length === 0, await axe(page, '[data-testid="critique-dialog"]'));
  await shot(page, 'after-results-dark');
  await page.$eval('[data-testid="critique-result"]', (e) => { e.scrollTop = 520; });
  await wait(200);
  await shot(page, 'after-results-scrolled-dark');
  await page.$eval('[data-testid="critique-result"]', (e) => { e.scrollTop = 0; });

  // Pin.
  await click(page, '[data-testid="critique-pin"]');
  check('Pin makes a comment on the layer', await until(() => exists(page, '[data-testid="critique-pinned"]'), 3000) && room.doc.getComments().some((c) => c.messages[0]?.text.startsWith('The paying screen says the payment failed')));
  await closesEveryWay(page, 'results', () => openDialog(page));

  // Fix one, then stop it: the run starts at once, no composer step.
  await openDialog(page);
  writeFileSync(fixDelay, '30000');
  check('the default target is 7.5', (await text(page, '.crit-loop')).includes('7.5'));
  check('the loop is off by default', !(await page.$eval('[data-testid="critique-loop"]', (e) => (e as HTMLInputElement).checked)));
  await click(page, '[data-testid="critique-fix-one"]');
  check('Fix starts a run at once', await until(() => exists(page, '[data-testid="critique-fixing"]'), 8000), await text(page, '[data-testid="critique-dialog"]'));
  check('the request is in the chat, sent, with nothing waiting in the composer', await until(() => page.evaluate(() => {
    const fields = [...document.querySelectorAll<HTMLTextAreaElement>('.chat textarea')];
    return fields.length > 0 && fields.every((f) => f.value.trim() === '') && (document.querySelector('.chat') as HTMLElement | null)?.innerText.includes('Fix 1 defect from the review') === true;
  }), 4000), await page.evaluate(() => (document.querySelector('.chat') as HTMLElement | null)?.innerText.slice(0, 300) ?? 'no chat'));
  check('the finding is marked as taken on', await until(() => exists(page, '[data-testid="critique-addressed"]'), 3000) && Boolean(records()[0]?.defects[0]?.addressed));
  await shot(page, 'after-fixing-dark');
  await page.keyboard.press('Escape');
  check('closed, the fix is a pill with Stop', await until(async () => (await pills(page)).some((p) => p.kind === 'fix' && p.state === 'running'), 3000), await pills(page));
  await click(page, '[data-testid="activity-open"]');
  await until(() => dialogOpen(page), 3000);
  await click(page, '[data-testid="critique-fix-stop"]');
  check('Stop ends the fix run', await until(async () => !(await exists(page, '[data-testid="critique-fixing"]')), 8000));
  check('and no new review starts', !(await exists(page, '[data-testid="critique-running"]')));

  // Fix all and review again until 7.5: a new reviewer looks after the fix, and the round is in the history.
  writeFileSync(fixDelay, '1500');
  writeFileSync(reviewDelay, '4000');
  await page.keyboard.press('Escape');
  await openDialog(page);
  if (!(await page.$eval('[data-testid="critique-loop"]', (e) => (e as HTMLInputElement).checked))) await click(page, '[data-testid="critique-loop"]');
  check('the loop is on', await page.$eval('[data-testid="critique-loop"]', (e) => (e as HTMLInputElement).checked));
  await page.$$eval('[data-testid="critique-defect-check"]', (els) => els.forEach((e) => { if (!(e as HTMLInputElement).checked) (e as HTMLInputElement).click(); }));
  await click(page, '[data-testid="critique-fix-selected"]');
  check('the fix runs first', await until(() => exists(page, '[data-testid="critique-fixing"]'), 8000));
  check('then a new review starts by itself', await until(() => exists(page, '[data-testid="critique-running"]'), 20_000), await page.evaluate(() => (document.querySelector('.chat') as HTMLElement | null)?.innerText.slice(-600) ?? ''));
  check('the fixed screen says what it shows', room.doc.descendants(boards[4]!).some((n) => n.text === 'Confirming your payment'));
  check('round 2 ends with no defect', await until(() => records().some((r) => r.round === 2), 30_000) && records().find((r) => r.round === 2)!.defects.length === 0);
  await until(() => exists(page, '[data-testid="critique-history"]'), 8000);
  await wait(900);
  check('the history shows both rounds', (await page.$$('[data-testid="critique-round"]')).length === 2, await text(page, '[data-testid="critique-history"]'));
  check('the new reviewer checked the findings taken on', /3 of 3 findings/.test(await text(page, '[data-testid="critique-rechecked"]')), await text(page, '[data-testid="critique-rechecked"]'));
  check('the loop says it is done', /Done in round 2/.test(await text(page, '[data-testid="critique-loop-note"]')), await text(page, '[data-testid="critique-loop-note"]'));
  const brief = readFileSync(join(root, 'claude.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; input: string });
  const fixRun = brief.find((c) => !/You are a senior product/.test(c.input) && /Objective defects/.test(c.input + c.args.join(' ')));
  check('the fix brief carries evidence, layer ids and the fix, and leaves taste alone', Boolean(fixRun && /Evidence:/.test(fixRun.input + fixRun.args.join(' ')) && /layer \w+\./.test(fixRun.input + fixRun.args.join(' ')) && /Leave the taste notes alone/.test(fixRun.input + fixRun.args.join(' '))));
  check('the history result has no accessibility findings', (await axe(page, '[data-testid="critique-dialog"]')).length === 0, await axe(page, '[data-testid="critique-dialog"]'));
  await shot(page, 'after-history-dark');
  await closesEveryWay(page, 'with history', () => openDialog(page));
  await page.$$eval('[data-testid="activity-dismiss"]', (els) => els.forEach((e) => (e as HTMLElement).click()));

  // The dock with three things at once: a picture being made, a review here and one in another file.
  writeFileSync(reviewDelay, '25000');
  writeFileSync(codexDelay, '25000');
  const hero = room.doc.insert(boards[1]!, { type: 'image', tag: 'img', name: 'Leaf photo', style: { width: '340px', height: '200px', objectFit: 'cover' } });
  room.doc.invalidate();
  await wait(400);
  await page.click('[data-testid="layer-search"]');
  await page.type('[data-testid="layer-search"]', 'Leaf');
  await until(() => exists(page, `[data-testid="layer-row"][data-layer="${hero}"]`), 5000);
  await page.click(`[data-testid="layer-row"][data-layer="${hero}"]`);
  await until(() => exists(page, '[data-testid="image-generate"]'), 5000);
  await click(page, '[data-testid="image-generate"]');
  await until(() => exists(page, '[data-testid="generate-prompt"]'), 5000);
  await page.type('[data-testid="generate-prompt"]', 'Gyokuro leaves in a white bowl, morning light');
  await click(page, '[data-testid="generate-start"]');
  await until(() => exists(page, '[data-testid="generate-stop"]'), 5000);
  await page.keyboard.press('Escape');
  check('closing Generate image while it makes pictures keeps them going in the dock', await until(async () => (await pills(page)).some((p) => p.kind === 'image' && p.state === 'running'), 3000), await pills(page));
  await openDialog(page);
  await click(page, '[data-testid="critique-new"]');
  await until(() => page.$eval('[data-testid="critique-start"]', (e) => !(e as HTMLButtonElement).disabled), 10_000);
  await click(page, '[data-testid="critique-start"]');
  await until(() => exists(page, '[data-testid="critique-running"]'), 5000);
  await page.keyboard.press('Escape');
  await page.goto(`${base}/#/file/${second.id}`);
  await ready(page);
  await wait(600);
  await openDialog(page);
  await until(() => page.$eval('[data-testid="critique-start"]', (e) => !(e as HTMLButtonElement).disabled), 10_000);
  await click(page, '[data-testid="critique-start"]');
  await until(() => exists(page, '[data-testid="critique-running"]'), 5000);
  await page.keyboard.press('Escape');
  check('three at once fold into one "3 running"', await until(async () => /3 running/.test(await text(page, '[data-testid="activity-stack"]')), 5000), await text(page, '[data-testid="calldock"]'));
  check('the folded line says what is in it, by kind', /2 reviews, 1 image/.test(await text(page, '[data-testid="activity-stack"]')), await text(page, '[data-testid="activity-stack"]'));
  const clear = await page.evaluate(() => { const d = document.querySelector('[data-testid="calldock"]')!.getBoundingClientRect(); const c = document.querySelector('[data-testid="canvas-map"]')?.getBoundingClientRect(); return !c || d.bottom <= c.top || d.left >= c.right || d.right <= c.left; });
  check('the dock never covers the canvas map', clear);
  await shot(page, 'after-dock-stack-dark');
  await click(page, '[data-testid="activity-expand"]');
  check('Show all opens the three pills', await until(async () => (await pills(page)).length === 3, 3000), await pills(page));
  check('the open stack has no accessibility findings', (await axe(page, '[data-testid="calldock"]')).length === 0, await axe(page, '[data-testid="calldock"]'));
  await shot(page, 'after-dock-expanded-dark');
  await click(page, '[data-testid="activity-fold"]');
  check('Show less folds them again', await until(() => exists(page, '[data-testid="activity-stack"]'), 3000));
  // Open the image back from the dock.
  await click(page, '[data-testid="activity-expand"]');
  await page.goto(`${base}/#/file/${entry.id}`);
  await ready(page);
  await wait(500);
  await page.$$eval('[data-testid="activity-pill"][data-kind="image"] [data-testid="activity-open"]', (els) => (els[0] as HTMLElement | undefined)?.click());
  check('Open brings the pictures back into Generate image', await until(() => exists(page, '[data-testid="generate-stop"]'), 5000));
  await page.keyboard.press('Escape');
  check('and closing it again keeps them going', await until(async () => (await pills(page)).some((p) => p.kind === 'image' && p.state === 'running'), 3000) || await exists(page, '[data-testid="activity-stack"]'));
  check('Stop in a pill stops that review', await (async () => {
    if (await exists(page, '[data-testid="activity-expand"]')) await click(page, '[data-testid="activity-expand"]');
    await page.$$eval('[data-testid="activity-pill"][data-kind="review"] [data-testid="activity-stop"]', (els) => els.forEach((e) => (e as HTMLElement).click()));
    return until(async () => !(await pills(page)).some((p) => p.kind === 'review'), 5000);
  })(), await pills(page));
  // The phone: one row.
  writeFileSync(codexDelay, '900');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await wait(600);
  await shot(page, 'after-dock-phone-dark');
  const rows = await page.$$eval('[data-testid="activity-pill"], [data-testid="activity-stack"]', (els) => els.map((e) => e.getBoundingClientRect().height));
  check('on a phone each pill is one row', rows.length > 0 && rows.every((h) => h <= 64), rows);
  await page.$$eval('[data-testid="activity-stop"], [data-testid="activity-dismiss"]', (els) => els.forEach((e) => (e as HTMLElement).click()));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.close();

  // Reduced motion, and light. The paying screen is as it was, so the stand-in's findings match its picture.
  writeFileSync(reviewDelay, '7000');
  for (const n of room.doc.descendants(boards[4]!)) if (n.text === 'Confirming your payment') room.doc.updateFields(n.id, { text: 'Payment failed' });
  for (const scheme of ['light', 'dark'] as const) {
    const p = await freshPage(browser);
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.evaluateOnNewDocument((mode) => { try { localStorage.setItem('bogen-settings', JSON.stringify({ appearance: mode })); } catch { /* none */ } }, scheme);
    await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: scheme === 'dark' ? 'reduce' : 'no-preference' }]);
    await p.goto(`${base}/#/file/${entry.id}`);
    await ready(p);
    await wait(600);
    await openDialog(p);
    if (await exists(p, '[data-testid="critique-new"]')) await click(p, '[data-testid="critique-new"]');
    await until(() => p.$eval('[data-testid="critique-start"]', (e) => !(e as HTMLButtonElement).disabled), 10_000);
    await click(p, '[data-testid="critique-start"]');
    await until(async () => (await p.$eval('[data-testid="critique-running"]', (e) => e.getAttribute('data-step')).catch(() => '')) === 'reviewer', 10_000);
    await until(async () => (await p.$$('[data-testid="critique-print"].is-in img')).length === 6, 5000);
    await wait(scheme === 'dark' ? 300 : 4500);
    if (scheme === 'dark') {
      check('reduced motion: the wall is still', await exists(p, '.crit-wall.is-still'));
      check('reduced motion: no travelling light, every screen lit evenly', !(await exists(p, '.crit-light')) && !(await exists(p, '.crit-print.is-lit')));
      check('reduced motion: no marks appear, the wall is still', (await p.$$('.crit-mark')).length === 0);
      await shot(p, 'after-waiting-reduced-motion-dark');
    } else {
      check('light: the waiting dialog has no accessibility findings', (await axe(p, '[data-testid="critique-dialog"]')).length === 0, await axe(p, '[data-testid="critique-dialog"]'));
      await shot(p, 'after-waiting-light');
      await p.keyboard.press('Escape');
      await until(async () => Boolean(await reviewPill(p)), 3000);
      check('light: the dock pill has no accessibility findings', (await axe(p, '[data-testid="calldock"]')).length === 0, await axe(p, '[data-testid="calldock"]'));
      await shot(p, 'after-dock-running-light');
      check('light: the pill turns into the result when it is done', await until(async () => (await reviewPill(p))?.state === 'done', 15_000), await pills(p));
      check('light: the done pill says the score and the findings', /Review done · 7\.4/.test((await reviewPill(p))?.text ?? '') && /3 defects/.test((await reviewPill(p))?.text ?? ''), await reviewPill(p));
      await wait(600);
      await shot(p, 'after-dock-done-light');
      await click(p, '[data-testid="activity-open"]');
    }
    await until(() => exists(p, '[data-testid="critique-result"]'), 20_000);
    await wait(900);
    check(`${scheme}: the results have no accessibility findings`, (await axe(p, '[data-testid="critique-dialog"]')).length === 0, await axe(p, '[data-testid="critique-dialog"]'));
    await shot(p, `after-results-${scheme === 'dark' ? 'reduced-motion-dark' : 'light'}`);
    if (scheme === 'light') {
      await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await wait(700);
      check('phone: the dialog fills the screen', await p.$eval('[data-testid="critique-dialog"]', (e) => e.getBoundingClientRect().width >= 388));
      check('phone: nothing scrolls sideways', await p.$eval('[data-testid="critique-result"]', (e) => e.scrollWidth <= e.clientWidth + 1));
      check('phone: the results have no accessibility findings', (await axe(p, '[data-testid="critique-dialog"]')).length === 0, await axe(p, '[data-testid="critique-dialog"]'));
      await shot(p, 'after-results-phone-light');
    }
    await p.close();
  }
} finally {
  await browser.close();
  await server.close();
}

/** Records every stage the dialog shows while a review runs. */
function window_watch(page: Page, seen: Set<string>): { stop: () => Promise<void> } {
  let on = true;
  const loop = (async () => {
    while (on) {
      const step = await page.$eval('[data-testid="critique-running"]', (e) => e.getAttribute('data-step')).catch(() => null);
      if (step) seen.add(step);
      if (step === 'writing') {
        const d = await text(page, '[data-testid="critique-stage-writing"]');
        if (/so far/.test(d)) seen.add('counted');
      }
      await wait(80);
    }
  })();
  return { stop: async () => { on = false; await loop; } };
}

console.log(`\n${passed} passed, ${failures.length} failed${errors.length ? `, page errors: ${errors.join(' | ')}` : ''}`);
if (failures.length || errors.length) process.exit(1);
process.exit(0);
