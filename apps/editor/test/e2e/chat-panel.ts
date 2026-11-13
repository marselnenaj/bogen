/**
 * The chat panel and the microphone, through the real editor, a real server in a temporary BOGEN_HOME, stand-in
 * CLIs and a stand-in speech model, in secure-chromium with its sandbox on and a made-up microphone:
 *
 * - the chat opens docked beside the canvas, is remembered for the file, and takes the selection as a chip that can
 *   be taken out; Shift+Enter is a new line and Enter sends;
 * - a reply arrives as markdown (bold, a list, inline code, no raw HTML), with the layers it changed under it;
 * - a run that hangs shows Stop with its time, remains attached after a reload, and stopping it says so;
 * - Edit puts the last message back, earlier chats are listed and one opens again, and a reload keeps it all;
 * - the microphone records, the computer writes it out, and the words land in the field to be checked; without a
 *   local model the chat says how to get one and a comment keeps a voice note; a blocked microphone says so;
 * - in a narrow window the chat opens over the canvas, and Esc closes it.
 *
 * Deterministic: no provider is called, nothing leaves the machine.
 *
 *   (cd apps/editor && npx vite build)
 *   node --import tsx apps/editor/test/e2e/chat-panel.ts
 *
 * Screenshots go to the folder printed at the end (or $BOGEN_SHOTS).
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { writeFakeClis } from '../../../../packages/server/test/fake-cli.ts';
import { freshPage, launch } from './craft-harness.ts';

const root = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-chat-'));
const shots = process.env.BOGEN_SHOTS ?? join(root, 'shots');
const bin = join(root, 'bin');
for (const d of [shots, bin]) mkdirSync(d, { recursive: true });
writeFakeClis(bin, join(root, 'cli.log'));
process.env.PATH = `${bin}:${process.env.PATH}`;
// A stand-in for a local speech model: it is given the recording's path and prints what was said.
const transcriber = join(bin, 'transcribe');
writeFileSync(transcriber, '#!/bin/sh\ntest -s "$1" || exit 3\necho "[00:00:00.000 --> 00:00:02.000]  Make the footer ink."\n');
chmodSync(transcriber, 0o755);
process.env.BOGEN_TRANSCRIBER = transcriber;

const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false });
// The design checks a run must pass before it finishes have their own tests; here a run is just a run.
server.runs.beforeFinish = undefined;
await server.listen();
const base = server.localUrl();
const browser = await launch(Number(new URL(base).port), { fakeMedia: true });

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
async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      // The page is between states.
    }
    await wait(60);
  }
  return false;
}
const exists = (page: Page, sel: string) => page.$(sel).then(Boolean);
const text = (page: Page, sel: string) => page.$eval(sel, (e) => (e as HTMLElement).innerText).catch(() => '');
const value = (page: Page, sel: string) => page.$eval(sel, (e) => (e as HTMLTextAreaElement).value).catch(() => '');
const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) });

const entry = server.storage.create('Pricing');
let heroId = '';
{
  const room = await server.rooms.get(entry.id);
  const pageId = room.doc.getPages()[0]!.id;
  heroId = room.doc.insert(pageId, { type: 'frame', name: 'Hero', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '960px', height: '560px', background: '#f4f2ec' } });
  room.doc.invalidate();
}

/** No local model, as the computer would say it. */
function noModel(req: HTTPRequest): void {
  if (!req.url().includes('/api/voice/status')) return void req.continue();
  void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ transcriber: null, device: 'This PC', limit: 10485760, maxSeconds: 300, retentionDays: 30 }) });
}

async function open(options: { width?: number; height?: number; scheme?: 'dark' | 'light'; intercept?: (req: HTTPRequest) => void; before?: string } = {}): Promise<Page> {
  const page = await freshPage(browser);
  page.on('pageerror', (e) => errors.push(String(e)));
  if (options.before) await page.evaluateOnNewDocument(options.before);
  if (options.intercept) {
    await page.setRequestInterception(true);
    page.on('request', options.intercept);
  }
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: options.scheme ?? 'dark' }]);
  await page.setViewport({ width: options.width ?? 1440, height: options.height ?? 900, deviceScaleFactor: 1 });
  await page.goto(`${base}/#/file/${entry.id}`);
  await page.waitForSelector('[data-testid="editor"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="layer-row"]', { timeout: 20_000 });
  return page;
}

const send = async (page: Page, words: string) => {
  await page.click('[data-testid="prompt-input"]');
  await page.keyboard.type(words);
  await page.waitForSelector('[data-testid="prompt-send"]:not(:disabled)', { timeout: 10_000 });
  await page.keyboard.press('Enter');
};

try {
  // ---------------------------------------------------------------- open, docked, remembered, with the selection
  const page = await open();
  check('the chat starts closed for a file never opened', !(await exists(page, '[data-testid="chat-slot"][data-dock="docked"]')));
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press('3');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  check('Ctrl+Alt+3 docks the chat beside the canvas', await until(() => exists(page, '[data-testid="chat-slot"][data-dock="docked"] [data-testid="chat-empty"]')));
  const boxes = await page.evaluate(() => {
    const r = (s: string) => { const b = document.querySelector(s)!.getBoundingClientRect(); return { left: b.left, right: b.right }; };
    return { stage: r('main.stage'), chat: r('[data-testid="chat-slot"]'), right: r('[data-testid="panel-slot-right"], .panel-slot:last-child') };
  });
  check('it sits between the canvas and the inspector', boxes.chat.left >= boxes.stage.right - 1 && boxes.chat.right <= boxes.right.left + 1, boxes);
  await shot(page, '1-empty-dark');

  await page.click('[data-testid="layer-row"]');
  check('what is selected goes with the message as a chip', await until(async () => (await text(page, '[data-testid="chat-chip"]')).includes('Hero')));
  await page.click('[data-testid="chat-chip-remove"]');
  check('and the chip can be taken out', await until(async () => !(await exists(page, '[data-testid="chat-chip"]'))));

  // ---------------------------------------------------------------- a reply, as markdown, with what it changed
  await page.click('[data-testid="prompt-input"]');
  await page.keyboard.type('Draw a hero');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  check('Shift+Enter adds a line and sends nothing', (await value(page, '[data-testid="prompt-input"]')) === 'Draw a hero\n' && !(await exists(page, '[data-testid="chat-you"]')));
  await page.$eval('[data-testid="prompt-input"]', (e) => { (e as HTMLTextAreaElement).select(); });
  await page.keyboard.press('Backspace');
  const reply = 'Made **the hero**.\\n\\n- Gap is `24px`\\n- <b>no</b> raw HTML';
  await send(page, `Draw a hero FAKE{"tools":[{"name":"layer_style","args":{"node_ids":["${heroId}"],"style":{"backgroundColor":"#ebe8df"}}}],"reply":"${reply}"}`);
  check('the message shows at once', await until(async () => (await text(page, '[data-testid="chat-you"]')).includes('Draw a hero')));
  check('the reply arrives as markdown', await until(async () => (await text(page, '[data-testid="prompt-messages"] .md strong')) === 'the hero', 20_000));
  const md = await page.$eval('[data-testid="prompt-messages"] .md', (e) => ({ items: e.querySelectorAll('li').length, code: e.querySelector('code')?.textContent, raw: Boolean(e.querySelector('b')), words: e.textContent }));
  check('lists and inline code render, and HTML stays text', md.items === 2 && md.code === '24px' && !md.raw && (md.words ?? '').includes('<b>no</b>'), md);
  check('what the run changed shows under its words', await until(() => exists(page, '[data-testid="prompt"] [data-testid="run-changes-layer"]'), 15_000));
  check('the list is at its end', await page.$eval('[data-testid="prompt-messages"]', (e) => e.scrollHeight - e.scrollTop - e.clientHeight < 60));
  await shot(page, '2-reply-dark');

  // ---------------------------------------------------------------- running, with Stop
  await send(page, 'Now the footer FAKE{"hang":true}');
  check('a run going shows Stop with its time', await until(async () => (await text(page, '[data-testid="prompt-stop"]')).includes('Stop'), 10_000));
  check('and the steps it takes', await exists(page, '[data-testid="chat-steps"]'));
  await wait(1200);
  const runningId = server.runs.activeFor(entry.id);
  await page.reload();
  await page.waitForSelector('[data-testid="layer-row"]', { timeout: 20_000 });
  check('reloading a running chat restores Stop and elapsed time', await until(() => exists(page, '[data-testid="prompt-stop"]')) && /\d+:\d{2}/.test(await text(page, '[data-testid="prompt-stop"]')));
  check('the restored running turn keeps its question and blocks another send', (await text(page, '[data-testid="prompt-messages"]')).includes('Now the footer') && !(await exists(page, '[data-testid="prompt-send"]')));
  check('restoring attaches to the same run', server.runs.activeFor(entry.id) === runningId);
  await shot(page, '3-running-dark');
  await page.click('[data-testid="prompt-stop"]');
  check('Stop stops it and says so', await until(async () => (await text(page, '[data-testid="chat-note"]')).includes('Stopped')));
  check('and Send is back', await until(() => exists(page, '[data-testid="prompt-send"]')));

  // ---------------------------------------------------------------- edit, earlier chats, reload
  await page.click('[data-testid="chat-edit"]');
  check('Edit puts the last message back in the field', (await value(page, '[data-testid="prompt-input"]')).startsWith('Now the footer'));
  await page.$eval('[data-testid="prompt-input"]', (e) => { (e as HTMLTextAreaElement).select(); });
  await page.keyboard.press('Backspace');
  await page.click('[data-testid="chat-history-open"]');
  check('earlier chats are listed', await until(async () => (await page.$$('[data-testid="chat-history-row"]')).length === 1));
  await shot(page, '4-history-dark');
  await page.click('[data-testid="chat-history-new"]');
  check('a new chat starts empty', await until(() => exists(page, '[data-testid="chat-empty"]')));
  await send(page, 'A second chat FAKE{"reply":"Second answer."}');
  check('it answers in the new chat', await until(async () => (await text(page, '[data-testid="prompt-messages"]')).includes('Second answer.'), 15_000));
  check('and is done', await until(() => exists(page, '[data-testid="prompt-send"]'), 20_000));
  await page.click('[data-testid="chat-history-open"]');
  check('both chats are listed, the newest first', await until(async () => {
    const titles = await page.$$eval('[data-testid="chat-history-row"]', (r) => r.map((x) => x.textContent ?? ''));
    return titles.length === 2 && titles[0]!.startsWith('A second chat') && titles[1]!.startsWith('Draw a hero');
  }));
  const rows = await page.$$('[data-testid="chat-history-row"]');
  if (process.env.CHAT_DEBUG) console.log('row', await rows[1]!.evaluate((e) => ({ disabled: (e as HTMLButtonElement).disabled, html: e.outerHTML.slice(0, 200) })));
  await rows[1]!.click();
  await wait(600);
  await shot(page, '4b-older-chat-dark');
  check('the older one opens again, with what was said', await until(async () => (await text(page, '[data-testid="prompt-messages"]')).includes('Made the hero')));
  await page.reload();
  await page.waitForSelector('[data-testid="layer-row"]', { timeout: 20_000 });
  check('after a reload the chat is still open, with that chat', await until(async () => (await text(page, '[data-testid="prompt-messages"]')).includes('Made the hero'), 10_000));

  // Another tab may start work after this tab restored an idle conversation. The server's refusal must explain it.
  const elsewhere = await server.runs.start({ fileId: entry.id, fileName: entry.name, nodeIds: [], runner: 'codex', prompt: 'Work from another tab FAKE{"hang":true}' });
  try {
    await send(page, 'Can I start another run?');
    check('a conflict explains that the file already has a running agent', await until(async () => (await text(page, '[data-testid="prompt-messages"]')).includes('A run is already going on this file.')));
    check('the conflict does not expose only a technical HTTP error', !(await text(page, '[data-testid="prompt-messages"]')).includes('POST /api/runs failed with 409'));
  } finally {
    server.runs.stop(elsewhere);
    await until(() => !server.runs.isActive(elsewhere));
  }

  // ---------------------------------------------------------------- the microphone, with a local model
  await page.click('[data-testid="chat-mic"]');
  check('the microphone records, with its time and level', await until(() => exists(page, '[data-testid="chat-mic-recording"]')));
  check('Write it out has the focus', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'chat-mic-done'));
  await wait(1500);
  await shot(page, '5-recording-dark');
  await page.keyboard.press('Enter');
  check('the words land in the field, to be checked', await until(async () => (await value(page, '[data-testid="prompt-input"]')) === 'Make the footer ink.', 15_000), await value(page, '[data-testid="prompt-input"]'));
  check('and it says where they were written out', (await text(page, '[data-testid="chat-voice-note"]')).includes('on this computer'));
  check('nothing was sent by itself', !(await text(page, '[data-testid="prompt-messages"]')).includes('Make the footer ink.'));
  await shot(page, '6-written-out-dark');
  await page.$eval('[data-testid="prompt-input"]', (e) => { (e as HTMLTextAreaElement).select(); });
  await page.keyboard.press('Backspace');
  await page.click('[data-testid="chat-mic"]');
  await until(() => exists(page, '[data-testid="chat-mic-recording"]'));
  await page.keyboard.press('Escape');
  check('Esc cancels a recording and writes nothing', await until(async () => !(await exists(page, '[data-testid="chat-mic-recording"]'))) && (await value(page, '[data-testid="prompt-input"]')) === '');

  // A comment box has the same microphone.
  await page.click('[data-testid="tool-comment"]');
  const stage = await page.$eval('main.stage', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(stage.x, stage.y);
  await page.waitForSelector('[data-testid="comment-input-mic"]', { timeout: 8000 });
  await page.click('[data-testid="comment-input-mic"]');
  await until(() => exists(page, '[data-testid="comment-input-mic-recording"]'));
  await wait(900);
  await page.click('[data-testid="comment-input-mic-done"]');
  check('a comment gets the words too', await until(async () => (await value(page, '[data-testid="comment-input"]')) === 'Make the footer ink.', 15_000));
  await shot(page, '7-comment-written-out-dark');
  await page.close();

  // ---------------------------------------------------------------- without a local model, and a blocked microphone
  // The computer has no model now: the stand-in is turned off, and the server looks again.
  process.env.BOGEN_TRANSCRIBER = 'off';
  await fetch(`${base}/api/voice/status?fresh=1`);
  const bare = await open({ intercept: noModel });
  await until(() => exists(bare, '[data-testid="chat-slot"][data-dock="docked"]'));
  await bare.click('[data-testid="chat-mic"]');
  check('without a model the chat says how to get one', await until(async () => (await text(bare, '[data-testid="chat-voice-setup"]')).includes('Voxtype')));
  check('and records nothing', !(await exists(bare, '[data-testid="chat-mic-recording"]')));
  await shot(bare, '8-no-model-dark');
  await bare.click('[data-testid="tool-comment"]');
  const at = await bare.$eval('main.stage', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 3, y: r.top + r.height / 3 }; });
  await bare.mouse.click(at.x, at.y);
  await bare.waitForSelector('[data-testid="comment-input-mic"]', { timeout: 8000 });
  await bare.click('[data-testid="comment-input-mic"]');
  await until(() => exists(bare, '[data-testid="comment-input-mic-recording"]'));
  await wait(900);
  await bare.click('[data-testid="comment-input-mic-done"]');
  check('a comment without a model keeps the recording as a voice note', await until(() => exists(bare, '[data-testid="comment-voice"]'), 15_000));
  check('and says an agent cannot hear it', (await text(bare, '[data-testid="comment-input-voice-note"]')).includes('cannot hear'));
  await shot(bare, '8b-comment-voice-note-dark');
  await bare.close();
  process.env.BOGEN_TRANSCRIBER = transcriber;
  await fetch(`${base}/api/voice/status?fresh=1`);

  const blocked = await open({ before: "navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));" });
  await until(() => exists(blocked, '[data-testid="chat-slot"][data-dock="docked"]'));
  await blocked.click('[data-testid="chat-mic"]');
  check('a blocked microphone says what to do', await until(() => exists(blocked, '[data-testid="chat-voice-problem"][data-problem="denied"]')));
  await shot(blocked, '9-mic-blocked-dark');
  await blocked.close();

  // ---------------------------------------------------------------- narrow window, light theme
  const narrow = await open({ width: 860, height: 700 });
  check('in a narrow window the chat opens over the canvas', await until(() => exists(narrow, '[data-testid="chat-slot"][data-dock="drawer"]')));
  await wait(400);
  await shot(narrow, '10-narrow-dark');
  await narrow.click('[data-testid="prompt-input"]');
  await narrow.keyboard.press('Escape');
  check('Esc closes it there', await until(async () => !(await exists(narrow, '[data-testid="chat-slot"][data-dock="drawer"]'))));
  check('and the toolbar button opens it again', await narrow.click('[data-testid="prompt-toggle"]').then(() => until(() => exists(narrow, '[data-testid="chat-slot"][data-dock="drawer"]'))));
  await narrow.close();

  // The light theme, at a larger UI scale: the chat follows both like the rest of the editor.
  const light = await open({ scheme: 'light', before: "try { localStorage.setItem('bogen-settings', JSON.stringify({ appearance: 'light', uiScale: 1.25 })); } catch {}" });
  await until(() => exists(light, '[data-testid="prompt-messages"]'));
  await wait(400);
  await shot(light, '11-chat-light');
  await light.close();

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
