/**
 * The agent loop with people, in the real editor against the real server, in a real browser: steps and Stop under
 * a thread, the queue in the Agents tab, what a run changed with Undo this run in the Ctrl+K bar and the thread, a
 * file attached to a comment, and Check the agents. The CLIs are stand-ins, so no plan is used.
 * Build the editor first, then: npx tsx apps/editor/test/e2e/agent-collab.ts
 * Chromium comes from BOGEN_BROWSER, with its sandbox on.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import puppeteer, { type Page } from 'puppeteer-core';
import { fake, writeCheckClis, writeFakeClis } from '../../../../packages/server/test/fake-cli.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOT = resolve(import.meta.dirname, '../../../..');
const home = mkdtempSync(join(tmpdir(), 'bogen-e2e-home-'));
const bin = mkdtempSync(join(tmpdir(), 'bogen-e2e-bin-'));
const profile = mkdtempSync(join(tmpdir(), 'bogen-e2e-profile-'));
const files = mkdtempSync(join(tmpdir(), 'bogen-e2e-files-'));
const shots = process.env.BOGEN_SHOTS ?? mkdtempSync(join(tmpdir(), 'bogen-e2e-shots-'));
const PORT = 29000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${PORT}`;
// A second device, the PC with the CLIs, which this one (the MacBook) asks.
const PC_PORT = PORT + 1000;
const pcBase = `http://127.0.0.1:${PC_PORT}`;
const pcHome = mkdtempSync(join(tmpdir(), 'bogen-e2e-pc-'));
const browserPath = process.env.BOGEN_BROWSER;
if (!browserPath) throw new Error('Set BOGEN_BROWSER to a Chromium with its sandbox on.');

writeFakeClis(bin, join(bin, 'calls.jsonl'));
const serve = (port: number, dir: string) => spawn('npx', ['tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(port), '--insecure-allow-any-host'], { cwd: ROOT, env: { ...process.env, BOGEN_HOME: dir, BOGEN_WELCOME: '0', PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore', detached: true });
const server = serve(PORT, home);
const pcServer = serve(PC_PORT, pcHome);

let ok = 0;
let bad = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (pass) ok++; else bad++;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${!pass && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
const post = async <T = any>(path: string, body: unknown, to = base): Promise<T> => (await (await fetch(`${to}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as T;
const waitText = (page: Page, testId: string, text: string, timeout = 10_000) => page.waitForFunction((id: string, t: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)].some((e) => e.textContent?.includes(t)), { timeout }, testId, text);
const textOf = (page: Page, testId: string) => page.$$eval(`[data-testid="${testId}"]`, (els) => els.map((e) => e.textContent ?? '').join(' | '));

async function main(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false) && await fetch(`${pcBase}/api/status`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }
  const file = (await post<{ id: string }>('/api/files', { name: 'Collab e2e' })).id;

  // The browser keeps its sandbox. A browser in its own namespaces (secure-chromium) reaches this server only on
  // the port shared with it, talks over a pipe, and reads only the folder the attachment is in.
  const browser = await puppeteer.launch({
    executablePath: browserPath, headless: true, pipe: true, userDataDir: profile, defaultViewport: { width: 1500, height: 960 },
    args: ['--window-size=1500,960', `--secure-local-port=${PORT}`, `--secure-local-port=${PC_PORT}`], env: { ...process.env, SECURE_BROWSER_READ_DIR: files },
  });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument('window.__name = (f) => f');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push((e as Error).message));
    await page.goto(`${base}/#/file/${file}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 20_000 });
    await sleep(800);
    // A board to work on, made by a run, so that it arrives in the editor as anything else does.
    const setup = await post<{ runId: string }>('/api/runs', { fileId: file, prompt: `set up ${fake({ tools: [{ name: 'artboard_create', args: { name: 'Hero', width: 360, height: 160 } }] })}`, runner: 'claude' });
    let boardId: string | null = null;
    for (let i = 0; i < 60 && !boardId; i++) {
      const runs = (await (await fetch(`${base}/api/runs?fileId=${file}`)).json()) as { id: string; status: string; layers: string[] }[];
      const run = runs.find((r) => r.id === setup.runId);
      if (run && run.status !== 'running') boardId = run.layers[0] ?? null;
      else await sleep(250);
    }
    await page.waitForSelector(`[data-bogen-id="${boardId}"]`, { timeout: 10_000 });
    check('the board is on the canvas', Boolean(boardId), boardId);

    // --- Steps and Stop under a thread.
    const tools = [1, 2, 3].map((n) => ({ name: 'layer_style', args: { node_ids: [boardId], style: { padding: `${n * 8}px`, backgroundColor: n === 3 ? '#e5484d' : '#ffffff' } } }));
    const thread = await post<{ threadId: string }>('/api/comments', { fileId: file, author: 'Mara', nodeId: boardId, text: `@claude tighten this ${fake({ tools, delayMs: 500, hang: true })}` });
    await page.click('[data-testid="tab-comments"]');
    await page.locator(`[data-thread="${thread.threadId}"] [data-testid="thread-head"]`).click();
    await waitText(page, 'thread-steps', 'Changed styles (3)', 15_000);
    check('the thread lists the steps so far, in words', true);
    await page.screenshot({ path: join(shots, '1-thread-steps.png') });
    await page.click('[data-testid="thread-run-stop"]');
    await waitText(page, 'thread', 'claude was stopped after 3 steps', 10_000);
    check('Stop ends it, and the thread says after how many steps', true);
    await page.waitForFunction(() => !document.querySelector('[data-testid="thread-run"]'), { timeout: 8000 });
    await waitText(page, 'run-changes', 'Changed', 15_000);
    check('under the thread: what the run changed', (await textOf(page, 'run-changes')).includes('Hero'), await textOf(page, 'run-changes'));
    await page.waitForSelector('[data-testid="run-changes-shots"] img', { timeout: 15_000 });
    check('with a picture before and after', (await page.$$('[data-testid="run-changes-shots"] img')).length === 2);
    await page.screenshot({ path: join(shots, '2-thread-result.png') });
    await page.click('[data-testid="run-undo"]');
    await waitText(page, 'run-changes-undone', 'Taken back', 10_000);
    check('Undo this run under the thread takes it back', true);
    void thread;

    // --- The queue: a run going on the file, and a comment waiting for it.
    const hang = await post<{ runId: string }>('/api/runs', { fileId: file, prompt: `wait ${fake({ hang: true })}`, runner: 'codex' });
    await post('/api/comments', { fileId: file, author: 'Mara', nodeId: boardId, text: `@claude after that ${fake({ thread: 'resolve' })}` });
    await page.click('[data-testid="tab-agents"]');
    await waitText(page, 'queue-reason', 'Waits for the run going on this file', 10_000);
    check('the queue says why a comment waits', true);
    check('and shows the run going', (await textOf(page, 'queue-running')).includes('codex'), await textOf(page, 'queue-running'));
    await page.screenshot({ path: join(shots, '3-queue.png') });
    await page.click('[data-testid="queue-cancel"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="queue-waiting"]'), { timeout: 8000 });
    check('cancel takes it out of the queue', true);
    await page.click('[data-testid="queue-stop"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="queue-running"]'), { timeout: 8000 });
    check('Stop in the queue stops the run', true);
    void hang;

    // --- The Ctrl+K bar: the reply shows what changed, the layer selects, and Undo this run.
    await page.mouse.click(1000, 500);
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await page.waitForSelector('[data-testid="prompt-input"]');
    await sleep(500);
    const ask = `make it green ${fake({ tools: [{ name: 'layer_style', args: { node_ids: [boardId], style: { backgroundColor: '#46a758' } } }], reply: 'Made the Hero green.' })}`;
    await page.$eval('[data-testid="prompt-input"]', (el, v) => {
      const area = el as HTMLTextAreaElement;
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(area, v as string);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }, ask);
    await page.keyboard.press('Enter');
    await waitText(page, 'prompt-messages', 'Made the Hero green.', 15_000);
    await waitText(page, 'run-changes', 'Hero', 15_000);
    check('the bar shows the layers the run changed', true);
    await page.waitForSelector('[data-testid="prompt"] [data-testid="run-changes-shots"] img', { timeout: 15_000 }).then(() => check('and its before and after', true), () => check('and its before and after', false));
    await page.screenshot({ path: join(shots, '4-prompt-result.png') });
    await page.click('[data-testid="prompt"] [data-testid="run-changes-layer"]');
    await sleep(400);
    await page.click('[data-testid="tab-design"]').catch(() => {});
    const selected = await page.$('[data-testid="inspector"]');
    check('a layer name selects the layer', selected !== null);
    await page.click('[data-testid="prompt"] [data-testid="run-undo"]');
    await waitText(page, 'run-changes-undone', 'Taken back', 10_000);
    check('Undo this run in the bar takes it back', true);
    await page.keyboard.press('Escape');

    // --- A file attached to a comment, shown as a file.
    const md = join(files, 'notes.md');
    writeFileSync(md, '# Notes\nThe heading says Sommerfest.\n');
    await page.click('[data-testid="tab-comments"]');
    await page.mouse.click(450, 300);
    await page.keyboard.press('c');
    await sleep(200);
    await page.mouse.click(450, 300);
    await page.waitForSelector('[data-testid="comment-input"]');
    const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('[data-testid="comment-input-attach"]')]);
    await chooser.accept([md]);
    await page.waitForSelector('[data-testid="comment-file"].is-doc, .comment-file.is-doc', { timeout: 8000 });
    check('a Markdown file attaches as a file', true);
    await page.type('[data-testid="comment-input"]', `@codex read this ${fake({ thread: 'resolve', reply: 'Read it.' })}`);
    await page.keyboard.press('Enter');
    await waitText(page, 'message-doc', 'notes.md', 10_000);
    check('the thread shows the file', true);
    await page.screenshot({ path: join(shots, '5-attachment.png') });

    // --- Asking the PC's agent from the MacBook. Paired the way `bogen peer add` pairs.
    await post('/api/peers/pair', { name: 'MacBook', insecure: true });
    const pcInfo = await post<{ url: string; token: string }>('/api/peers/pair', { name: 'PC', insecure: true }, pcBase);
    await post('/api/peers', { url: pcInfo.url, token: pcInfo.token, insecure: true });
    const pcId = ((await (await fetch(`${pcBase}/api/status`)).json()) as { device: { id: string } }).device.id;
    for (let i = 0; i < 80; i++) {
      const st = (await (await fetch(`${base}/api/status`)).json()) as { peers: { id: string; state: string }[] };
      const there = await fetch(`${pcBase}/api/files`).then((r) => r.json() as Promise<{ id: string }[]>, () => []);
      if (st.peers.some((p) => p.id === pcId && p.state === 'connected') && there.some((f) => f.id === file)) break;
      await sleep(250);
    }
    const pcPage = await browser.newPage();
    await pcPage.evaluateOnNewDocument('window.__name = (f) => f');
    await pcPage.goto(`${pcBase}/#/file/${file}`);
    await pcPage.waitForSelector('[data-testid="canvas"]', { timeout: 20_000 });
    await pcPage.click('[data-testid="tab-agents"]');
    await pcPage.click('[data-testid="agents-part-devices"]');
    await pcPage.waitForSelector('[data-testid="remote-runs-allow"]', { timeout: 10_000 });
    check('the PC lists the MacBook under Other devices, off', !(await pcPage.$eval('[data-testid="remote-runs-allow"]', (e) => (e as HTMLInputElement).checked)));
    await pcPage.click('[data-testid="remote-runs-allow"]');
    await pcPage.waitForFunction(() => (document.querySelector('[data-testid="remote-runs-allow"]') as HTMLInputElement | null)?.checked === true, { timeout: 8000 });
    check('and the PC\'s owner turns it on there', true);
    await pcPage.$eval('[data-testid="remote-runs"]', (e) => e.scrollIntoView());
    await pcPage.screenshot({ path: join(shots, '6-other-devices.png') });
    await pcPage.close();

    await page.bringToFront();
    await page.mouse.click(450, 300);
    await page.keyboard.press('Escape');
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await page.waitForFunction((id: string) => [...document.querySelectorAll('[data-testid="prompt-runner"] option')].some((o) => (o as HTMLOptionElement).value === `claude@${id}`), { timeout: 15_000 }, pcId);
    check('the MacBook\'s bar offers Claude Code on PC', (await textOf(page, 'prompt-runner')).includes('Claude Code on PC'));
    await page.select('[data-testid="prompt-runner"]', `claude@${pcId}`);
    await waitText(page, 'prompt-target', 'runs on PC');
    check('and says where it runs', true);
    const remoteAsk = `make it blue ${fake({ tools: [{ name: 'layer_style', args: { node_ids: [boardId], style: { backgroundColor: '#0090ff' } } }], reply: 'Made the Hero blue, on the PC.' })}`;
    await page.$eval('[data-testid="prompt-input"]', (el, v) => {
      const area = el as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, v as string);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }, remoteAsk);
    await page.keyboard.press('Enter');
    await waitText(page, 'prompt-messages', 'Made the Hero blue, on the PC.', 20_000);
    check('the reply streams back from the PC', true);
    await page.waitForFunction((id: string) => getComputedStyle(document.querySelector(`[data-bogen-id="${id}"]`)!).backgroundColor === 'rgb(0, 144, 255)', { timeout: 15_000 }, boardId!);
    check('its change arrives on the MacBook by sync', true);
    const pcRuns = (await (await fetch(`${pcBase}/api/runs?fileId=${file}`)).json()) as { id: string; askedFrom?: string }[];
    const remoteRun = pcRuns.find((r) => r.askedFrom === 'MacBook');
    check('it ran on the PC, recorded as asked from the MacBook', Boolean(remoteRun), pcRuns.map((r) => r.askedFrom));
    check('and nothing ran on the MacBook', !((await (await fetch(`${base}/api/runs?fileId=${file}`)).json()) as { id: string }[]).some((r) => r.id === remoteRun?.id));
    await page.waitForSelector('[data-testid="prompt-send"]', { timeout: 15_000 }).then(() => check('the bar is ready again when the run on the PC ends', true), () => check('the bar is ready again when the run on the PC ends', false));
    await page.waitForSelector(`[data-testid="run-changes"][data-run-id="${remoteRun?.id}"] [data-testid="run-changes-shots"] img`, { timeout: 15_000 })
      .then(() => check('what it changed, with pictures, comes from the PC', true), () => check('what it changed, with pictures, comes from the PC', false));
    await page.screenshot({ path: join(shots, '7-remote-run.png') });
    await page.keyboard.press('Escape');

    // --- Check the agents, with stand-ins that answer as good agents do.
    writeCheckClis(bin);
    await page.click('[data-testid="tab-agents"]');
    await page.click('[data-testid="agents-part-settings"]');
    // Setup and diagnostics are separate from the daily activity view.
    const [started] = await Promise.all([
      page.waitForResponse((r) => r.url() === `${base}/api/agents/check` && r.request().method() === 'POST'),
      page.locator('[data-testid="agents-check-start"]').click(),
    ]);
    check('Check the agents starts from its visible button', started.status() === 202, await started.json());
    const six = await page.waitForFunction(() => document.querySelectorAll('[data-testid="agents-check-case"][data-ok="true"]').length === 6, { timeout: 60_000 }).then(() => true, () => false);
    check('Check the agents shows six passes', six, six ? undefined : await (await fetch(`${base}/api/agents/check`)).json());
    await page.locator('[data-testid="agents-check-start"]').scroll();
    await page.screenshot({ path: join(shots, '8-agents-check.png') });

    check('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
  }
}

await main().catch((e) => {
  bad++;
  console.log(`FAIL  ${(e as Error).stack ?? inspect(e, { depth: 3 })}`);
});
for (const child of [server, pcServer]) {
  try {
    process.kill(-child.pid!, 'SIGTERM');
  } catch {
    // Gone already.
  }
}
console.log(`\n${ok} passed, ${bad} failed. Pictures in ${shots}`);
rmSync(home, { recursive: true, force: true });
rmSync(pcHome, { recursive: true, force: true });
rmSync(bin, { recursive: true, force: true });
rmSync(profile, { recursive: true, force: true });
rmSync(files, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
