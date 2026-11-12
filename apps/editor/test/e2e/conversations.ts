/**
 * Conversations in comment threads, in the real editor against the real server, in a real browser with its
 * sandbox on: replies without a mention reach the thread's agent with its model and effort, an explicit choice
 * overrides it, Comment only starts nothing, a bare mention after criticism runs on the criticism, nothing
 * starts itself, threads are compact headers that open and close, drafts stay per thread, a pin opens its thread
 * past a filter, and the phone does the same in its list -> conversation -> list flow.
 * The CLIs are stand-ins (no plan, no provider is called). Generic fixture text only.
 *
 * Build the editor first, then: BOGEN_BROWSER=~/.local/bin/secure-chromium npx tsx apps/editor/test/e2e/conversations.ts
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import puppeteer, { type Page } from 'puppeteer-core';
import { fake, fakeLog, writeFakeClis } from '../../../../packages/server/test/fake-cli.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOT = resolve(import.meta.dirname, '../../../..');
const home = mkdtempSync(join(tmpdir(), 'bogen-conv-home-'));
const bin = mkdtempSync(join(tmpdir(), 'bogen-conv-bin-'));
const profile = mkdtempSync(join(tmpdir(), 'bogen-conv-profile-'));
const shots = process.env.BOGEN_SHOTS ?? mkdtempSync(join(tmpdir(), 'bogen-conv-shots-'));
const PORT = 29000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${PORT}`;
const browserPath = process.env.BOGEN_BROWSER;
if (!browserPath) throw new Error('Set BOGEN_BROWSER to a Chromium with its sandbox on, such as ~/.local/bin/secure-chromium.');

const log = join(bin, 'calls.jsonl');
writeFakeClis(bin, log);
const server = spawn('npx', ['tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(PORT), '--insecure-allow-any-host'], { cwd: ROOT, env: { ...process.env, BOGEN_HOME: home, BOGEN_WELCOME: '0', PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore', detached: true });

let ok = 0;
let bad = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (pass) ok++; else bad++;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${!pass && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
type Call = { runner: string; args: string[]; text: string };
const calls = () => fakeLog(log).filter((c) => c.kind === 'call') as unknown as Call[];
const flag = (c: Call | undefined, name: 'model' | 'effort') => {
  if (!c) return undefined;
  if (c.runner === 'claude') {
    const i = c.args.indexOf(name === 'model' ? '--model' : '--effort');
    return i < 0 ? undefined : c.args[i + 1];
  }
  if (name === 'model') return c.args[c.args.indexOf('-m') + 1];
  return /model_reasoning_effort="(\w+)"/.exec(c.args.join(' '))?.[1];
};
const post = async <T = any>(path: string, body: unknown): Promise<T> => (await (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as T;
const get = async <T = any>(path: string): Promise<T> => (await (await fetch(`${base}${path}`)).json()) as T;
const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) });
const waitCalls = async (n: number, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (calls().length >= n) return true;
    await sleep(100);
  }
  return false;
};
/** Nothing running or waiting in the file. */
const idle = async (file: string, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const runs = await get<unknown[]>(`/api/comments/runs?fileId=${file}`);
    const queue = await get<{ running: { fileId: string }[] }>('/api/runs/queue');
    if (!runs.length && !queue.running.some((r) => r.fileId === file)) return;
    await sleep(150);
  }
  throw new Error('The file did not go idle.');
};
const head = (threadId: string) => `[data-thread="${threadId}"] [data-testid="thread-head"]`;
const replyBox = (threadId: string) => `[data-thread="${threadId}"] [data-testid="thread-reply"]`;
const textOf = (page: Page, selector: string) => page.$eval(selector, (e) => e.textContent ?? '').catch(() => '');
const valueOf = (page: Page, selector: string) => page.$eval(selector, (e) => (e as HTMLTextAreaElement).value).catch(() => null);
/** Opens who-gets-this-message only when it is closed, so that a step never closes it by accident. */
const openChooser = async (page: Page, scope: string, testId = 'reply-target') => {
  const chip = `${scope} [data-testid="${testId}-chip"]`.trim();
  if (await page.$eval(chip, (b) => b.getAttribute('aria-expanded') !== 'true')) await page.click(chip);
  await page.waitForSelector(`${scope} [data-testid="${testId}-comment"]`.trim());
};
const typeInto = async (page: Page, selector: string, text: string) => {
  await page.click(selector);
  await page.keyboard.type(text);
};

async function main(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }
  const file = (await post<{ id: string }>('/api/files', { name: 'Conversations e2e' })).id;
  // A board, made by a run, so that runs in threads have something to change.
  const setup = await post<{ runId: string }>('/api/runs', { fileId: file, prompt: `set up ${fake({ tools: [{ name: 'artboard_create', args: { name: 'Landing', width: 360, height: 200 } }] })}`, runner: 'claude' });
  let board = '';
  for (let i = 0; i < 80 && !board; i++) {
    const run = (await get<{ id: string; status: string; layers: string[] }[]>(`/api/runs?fileId=${file}`)).find((r) => r.id === setup.runId);
    if (run && run.status !== 'running') board = run.layers[0] ?? '';
    else await sleep(250);
  }
  check('setup: a board to work on', Boolean(board), board);
  let pad = 0;
  const work = (reply = 'Done.') => fake({ tools: [{ name: 'layer_style', args: { node_ids: [board], style: { padding: `${++pad}px` } } }], thread: 'reply', reply });

  // Seeds: a thread asked of Claude with Opus and High, and a plain comment no agent was asked in.
  const asked = await post<{ threadId: string }>('/api/comments', { fileId: file, author: 'Alex', nodeId: board, x: 20, y: 20, text: `@claude write the Lumen headline ${work('Wrote a headline.')}`, model: 'opus', effort: 'high' });
  const plain = await post<{ threadId: string }>('/api/comments', { fileId: file, author: 'Alex', nodeId: board, x: 200, y: 20, text: 'Plain note for the Landing page' });
  await idle(file);
  const seeded = calls().length;
  check('seed: one run for the asked thread, none for the plain comment', seeded === 2, calls().map((c) => c.runner));

  const browser = await puppeteer.launch({
    executablePath: browserPath, headless: true, pipe: true, userDataDir: profile, defaultViewport: { width: 1500, height: 960 },
    args: ['--window-size=1500,960', `--secure-local-port=${PORT}`],
  });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument('window.__name = (f) => f');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push((e as Error).message));
    await page.goto(`${base}/#/file/${file}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 20_000 });
    await page.click('[data-testid="tab-comments"]');
    await page.waitForSelector(head(asked.threadId));

    // ---------------------------------------------------------------- compact, clickable conversations
    check('desktop: conversations start closed, as compact headers', (await page.$$('[data-testid="thread"][data-open]')).length === 0);
    check('desktop: a header says expanded false and names its region', await page.$eval(head(asked.threadId), (b) => b.getAttribute('aria-expanded') === 'false' && Boolean(b.getAttribute('aria-controls'))));
    await page.waitForFunction((sel: string) => document.querySelector(sel)?.textContent?.includes('Claude · Opus · High'), { timeout: 8000 }, `[data-thread="${asked.threadId}"] [data-testid="thread-target"]`);
    check('desktop: the header shows the agent and model of the thread', true);
    check('desktop: the header previews the newest message', (await textOf(page, `[data-thread="${asked.threadId}"] [data-testid="thread-preview"]`)).includes('Wrote a headline.'));
    check('desktop: a plain comment shows no agent', (await page.$(`[data-thread="${plain.threadId}"] [data-testid="thread-target"]`)) === null);
    await shot(page, '1-desktop-list');

    await page.click(head(asked.threadId));
    await page.waitForSelector(replyBox(asked.threadId));
    check('desktop: clicking a header opens it, with its composer', await page.$eval(head(asked.threadId), (b) => b.getAttribute('aria-expanded') === 'true'));
    check('desktop: the composer says where a reply goes', (await textOf(page, `[data-thread="${asked.threadId}"] [data-testid="reply-target-name"]`)).includes('Claude · Opus · High'));
    await page.click(head(asked.threadId));
    await sleep(100);
    check('desktop: clicking it again closes it', (await page.$(replyBox(asked.threadId))) === null);

    // Keyboard: arrows move between headers.
    await page.focus(head(asked.threadId));
    await page.keyboard.press('ArrowDown');
    const focused = await page.evaluate(() => document.activeElement?.closest('[data-thread]')?.getAttribute('data-thread'));
    check('desktop: arrow keys move between conversation headers', focused !== asked.threadId && Boolean(focused), focused);

    // ---------------------------------------------------------------- drafts per thread
    await page.click(head(asked.threadId));
    await page.waitForSelector(replyBox(asked.threadId));
    await typeInto(page, replyBox(asked.threadId), 'half a thought');
    await page.click(head(plain.threadId));
    await page.waitForSelector(replyBox(plain.threadId));
    check('desktop: another thread starts with an empty reply (no draft leaks)', (await valueOf(page, replyBox(plain.threadId))) === '');
    check('desktop: the closed thread says it has a draft', (await page.$(`[data-thread="${asked.threadId}"] [data-testid="thread-draft"]`)) !== null);
    await page.setViewport({ width: 1100, height: 800 });
    await sleep(150);
    await page.setViewport({ width: 1500, height: 960 });
    await page.click(head(asked.threadId));
    await page.waitForSelector(replyBox(asked.threadId));
    check('desktop: the draft is still there after switching and resizing', (await valueOf(page, replyBox(asked.threadId))) === 'half a thought');
    await shot(page, '2-desktop-open');

    // ---------------------------------------------------------------- no-mention reply reaches the agent
    await page.click(replyBox(asked.threadId), { count: 3 });
    await page.keyboard.press('Backspace');
    await page.keyboard.type(`shorter please ${work('Shortened.')}`);
    await page.keyboard.press('Enter');
    check('desktop: a reply without a mention starts the thread agent', await waitCalls(seeded + 1));
    check('desktop: ... with the same model and effort', flag(calls().at(-1), 'model') === 'opus' && flag(calls().at(-1), 'effort') === 'high', calls().at(-1)?.args);
    await idle(file);
    check('desktop: the reply was written once, and the draft is gone', (await valueOf(page, replyBox(asked.threadId))) === '');

    // Plain comments stay plain.
    const before = calls().length;
    await page.click(head(plain.threadId));
    await page.waitForSelector(replyBox(plain.threadId));
    check('desktop: a plain thread says Comment only', (await textOf(page, `[data-thread="${plain.threadId}"] [data-testid="reply-target-name"]`)).includes('Comment only'));
    await typeInto(page, replyBox(plain.threadId), 'agreed');
    await page.keyboard.press('Enter');
    await sleep(800);
    check('desktop: a reply in a plain thread starts nothing', calls().length === before, calls().length - before);

    // Comment only for one message in an agent thread.
    await page.click(head(asked.threadId));
    await page.waitForSelector(replyBox(asked.threadId));
    await openChooser(page, `[data-thread="${asked.threadId}"]`);
    await page.click(`[data-thread="${asked.threadId}"] [data-testid="reply-target-comment"]`);
    check('desktop: Comment only is shown before sending', (await textOf(page, `[data-thread="${asked.threadId}"] [data-testid="reply-target-name"]`)).includes('Comment only'));
    await typeInto(page, replyBox(asked.threadId), 'note to self');
    await page.keyboard.press('Enter');
    await sleep(800);
    check('desktop: Comment only starts nothing', calls().length === before);
    check('desktop: after it, the thread goes to Claude again', (await textOf(page, `[data-thread="${asked.threadId}"] [data-testid="reply-target-name"]`)).includes('Claude'));
    check('desktop: the chooser closed with the sent message', await page.$eval(`[data-thread="${asked.threadId}"] [data-testid="reply-target-chip"]`, (b) => b.getAttribute('aria-expanded') === 'false'));

    // Explicit override: Codex for this message, then the thread follows Codex.
    await openChooser(page, `[data-thread="${asked.threadId}"]`);
    await page.click(`[data-thread="${asked.threadId}"] [data-testid="reply-target-codex"]`);
    await typeInto(page, replyBox(asked.threadId), `your take ${work('Codex take.')}`);
    await page.keyboard.press('Enter');
    check('desktop: choosing Codex sends it to Codex', await waitCalls(before + 1) && calls().at(-1)?.runner === 'codex');
    await idle(file);
    await page.waitForFunction((sel: string) => document.querySelector(sel)?.textContent?.includes('Codex'), { timeout: 8000 }, `[data-thread="${asked.threadId}"] [data-testid="reply-target-name"]`).catch(() => {});
    await typeInto(page, replyBox(asked.threadId), `and the subline ${work()}`);
    await page.keyboard.press('Enter');
    check('desktop: the next plain reply follows Codex', await waitCalls(before + 2) && calls().at(-1)?.runner === 'codex');
    await idle(file);

    // ---------------------------------------------------------------- bare mention after criticism
    const intro = await post<{ threadId: string }>('/api/comments', { fileId: file, author: 'Alex', nodeId: board, x: 120, y: 120, text: `@claude Lumen intro ${work('Wrote an intro.')}` });
    await idle(file);
    await page.waitForSelector(head(intro.threadId));
    await page.click(head(intro.threadId));
    await page.waitForSelector(replyBox(intro.threadId));
    await openChooser(page, `[data-thread="${intro.threadId}"]`);
    await page.click(`[data-thread="${intro.threadId}"] [data-testid="reply-target-comment"]`);
    const criticism = `the Lumen description makes no sense, not good enough ${fake({ thread: 'reply', reply: 'Which part?' })}`;
    await typeInto(page, replyBox(intro.threadId), criticism);
    await page.keyboard.press('Enter');
    await sleep(500);
    const n = calls().length;
    await typeInto(page, replyBox(intro.threadId), '@claude');
    // Past the name list that @ opens, then send.
    await page.keyboard.type(' ');
    await page.keyboard.press('Enter');
    check('desktop: a bare @claude starts one run', await waitCalls(n + 1));
    check('desktop: ... that answers the criticism as the request', calls()[n]?.text.includes('Answer this as the request:') === true && calls()[n]!.text.includes('the Lumen description makes no sense'), calls()[n]?.text.slice(-800));
    await idle(file);
    check('desktop: a finished run leaves the thread open', await page.$eval(`[data-thread="${intro.threadId}"]`, (el) => !el.classList.contains('is-resolved')));

    // ---------------------------------------------------------------- nothing starts itself
    const settled = calls().length;
    await sleep(2500);
    check('desktop: agent replies and notes start nothing more', calls().length === settled, calls().length - settled);

    // ---------------------------------------------------------------- a pin opens its thread past a filter
    await page.select('[data-testid="comments-filter"]', 'resolved');
    await page.click('[data-testid="comments-search"]');
    await page.keyboard.type('nothing matches this');
    await sleep(200);
    check('desktop: the filter hides the threads', (await page.$(`[data-thread="${asked.threadId}"]`)) === null);
    // Close the open one, then click the other's pin on the canvas, as a person would.
    await page.evaluate(() => (document.querySelector('[data-testid="thread"][data-open] [data-testid="thread-head"]') as HTMLElement | null)?.click());
    const pin = await page.$(`.ov-pin[data-pin="${plain.threadId}"]`);
    const box = await pin?.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    check('desktop: the pin is on the canvas', Boolean(box));
    await page.waitForSelector(`[data-thread="${plain.threadId}"][data-open][data-outside]`, { timeout: 5000 }).then(() => check('desktop: a pin opens its thread, shown past the filter and search', true), () => check('desktop: a pin opens its thread, shown past the filter and search', false));
    await shot(page, '3-desktop-pin-past-filter');
    check('desktop: no page errors', errors.length === 0, errors);
    await page.close();

    // ---------------------------------------------------------------- phone
    const phone = await browser.newPage();
    await phone.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await phone.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    await phone.evaluateOnNewDocument('window.__name = (f) => f');
    const phoneErrors: string[] = [];
    phone.on('pageerror', (e) => phoneErrors.push((e as Error).message));
    // As a notification opens it.
    await phone.goto(`${base}/#/file/${file}/thread/${asked.threadId}`);
    await phone.waitForSelector(`[data-testid="pf-thread"][data-thread-id="${asked.threadId}"]`, { timeout: 20_000 });
    check('phone: a notification link opens the right conversation', true);
    check('phone: the newest messages first, the rest one tap away', (await phone.$('[data-testid="pf-earlier"]')) !== null);
    await phone.waitForFunction(() => document.querySelector('[data-testid="pf-reply-target-name"]')?.textContent?.includes('Codex'), { timeout: 8000 }).then(() => check('phone: the composer shows the thread agent', true), () => check('phone: the composer shows the thread agent', false));
    await phone.type('[data-testid="pf-reply"]', 'phone draft');
    await phone.tap('[data-testid="pf-back"]');
    await phone.waitForSelector('[data-testid="pf-thread-row"]');
    check('phone: back to a list of compact rows', (await phone.$$('[data-testid="pf-thread-row"]')).length >= 2);
    check('phone: the row says Draft', (await textOf(phone, `[data-testid="pf-thread-row"][data-thread="${asked.threadId}"]`)).includes('Draft'));
    await phone.tap(`[data-testid="pf-thread-row"][data-thread="${plain.threadId}"]`);
    await phone.waitForSelector(`[data-testid="pf-thread"][data-thread-id="${plain.threadId}"]`);
    check('phone: another conversation starts empty', (await valueOf(phone, '[data-testid="pf-reply"]')) === '');
    await phone.tap('[data-testid="pf-back"]');
    await phone.tap(`[data-testid="pf-thread-row"][data-thread="${asked.threadId}"]`);
    await phone.waitForSelector(`[data-testid="pf-thread"][data-thread-id="${asked.threadId}"]`);
    check('phone: the draft is back', (await valueOf(phone, '[data-testid="pf-reply"]')) === 'phone draft');
    await shot(phone, '4-phone-thread');
    const p0 = calls().length;
    await phone.click('[data-testid="pf-reply"]', { count: 3 });
    await phone.keyboard.press('Backspace');
    await phone.type('[data-testid="pf-reply"]', `from the phone ${work()}`);
    await phone.tap('[data-testid="pf-reply-send"]');
    check('phone: a reply without a mention starts the thread agent', await waitCalls(p0 + 1) && calls().at(-1)?.runner === 'codex');
    await idle(file);
    await openChooser(phone, '', 'pf-reply-target');
    await phone.tap('[data-testid="pf-reply-target-comment"]');
    await phone.type('[data-testid="pf-reply"]', 'phone note only');
    await phone.tap('[data-testid="pf-reply-send"]');
    await sleep(800);
    check('phone: Comment only starts nothing', calls().length === p0 + 1);
    check('phone: no page errors', phoneErrors.length === 0, phoneErrors);
  } finally {
    await browser.close();
  }
}

await main().catch((e) => {
  bad++;
  console.log(`FAIL  ${(e as Error).stack ?? inspect(e, { depth: 3 })}`);
});
try {
  process.kill(-server.pid!, 'SIGTERM');
} catch {
  // Gone already.
}
console.log(`\n${ok} passed, ${bad} failed. Pictures in ${shots}`);
rmSync(home, { recursive: true, force: true });
rmSync(bin, { recursive: true, force: true });
rmSync(profile, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
