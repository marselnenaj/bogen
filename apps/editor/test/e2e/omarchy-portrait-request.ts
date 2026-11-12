/**
 * "Add 9:16 layout" in the theme dialog, end to end in the built editor and a sandboxed Chromium
 * (~/.local/bin/secure-chromium, its sandbox on, over a pipe, reaching only the one loopback port it is given).
 *
 * - The section renders without React warnings (an unstable store snapshot shows up as "getSnapshot should be cached"
 *   or "Maximum update depth exceeded"), and the button can be used before any request was made.
 * - A theme with no 9:16 shape: three fast clicks make one checkpoint, add exactly the 9:16 shape, and start exactly
 *   one run against the same file, on the new 9:16 board, with the short title. No file, page or "Custom" copy.
 * - A theme whose 9:16 board exists but is not designed: the run reuses that board and adds nothing; Stop stops it.
 * - The run ends with an honest line: the stand-in designs nothing, so the layout still needs its own design.
 * - Nothing is installed or applied, and no real agent runs: `claude` is a stand-in that only waits and answers,
 *   and `codex` is one that is never found.
 *
 * Nothing of the person's is read or written: HOME is a temp folder, `hyprctl` reports a stand-in desk with a 4K
 * landscape and a 16:10 monitor turned on its side (so a new theme has 10:16 but no 9:16), and `omarchy` only
 * records calls (and must record none).
 *
 * Needs the built editor (npm run build). Run:
 *   BOGEN_BROWSER=$HOME/.local/bin/secure-chromium npx tsx apps/editor/test/e2e/omarchy-portrait-request.ts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';

const CHROMIUM = resolve(process.env.HOME ?? '', '.local/bin/secure-chromium');
if (process.env.BOGEN_NO_SANDBOX === '1') throw new Error('This test runs only with the browser sandbox on. Unset BOGEN_NO_SANDBOX.');
if (process.env.BOGEN_BROWSER && process.env.BOGEN_BROWSER !== CHROMIUM) throw new Error(`BOGEN_BROWSER is ${process.env.BOGEN_BROWSER}; this test runs only with ${CHROMIUM}.`);
if (!existsSync(CHROMIUM)) throw new Error(`There is no ${CHROMIUM}.`);
process.env.BOGEN_BROWSER = CHROMIUM;

const SHOTS = process.env.BOGEN_SHOTS ?? mkdtempSync(join(tmpdir(), 'bogen-portrait-request-shots-'));
mkdirSync(SHOTS, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'bogen-portrait-request-e2e-'));
const home = join(work, 'home');
const omarchyPath = join(work, 'omarchy');
const bin = join(work, 'bin');
const omarchyLog = join(work, 'omarchy.log');
const runsLog = join(work, 'runs.jsonl');

let passed = 0;
const failed: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failed.push(name);
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

// ---------------------------------------------------------------- the fixture machine

/** What the server says when it continues a run that changed nothing (packages/server/src/run-guard.ts). */
const NUDGE = 'You replied without changing anything.';

const DESK = JSON.stringify([
  { name: 'DP-3', width: 3840, height: 2160, transform: 0, scale: 1, disabled: false, mirrorOf: 'none' },
  { name: 'DP-5', width: 1920, height: 1200, transform: 3, scale: 1, disabled: false, mirrorOf: 'none' },
]);
mkdirSync(join(omarchyPath, 'themes', 'calm'), { recursive: true });
writeFileSync(join(omarchyPath, 'themes', 'calm', 'colors.toml'), 'mode = "dark"\naccent = "#89b4fa"\nbackground = "#1e1e2e"\nforeground = "#cdd6f4"\n');
mkdirSync(join(home, '.local', 'state', 'omarchy', 'current'), { recursive: true });
mkdirSync(join(home, '.config', 'omarchy', 'themes'), { recursive: true });
writeFileSync(join(home, '.local', 'state', 'omarchy', 'current', 'theme.name'), 'calm\n');
mkdirSync(bin);
writeFileSync(join(bin, 'hyprctl'), `#!/bin/sh\necho '${DESK}'\n`);
writeFileSync(join(bin, 'omarchy'), `#!/bin/sh\necho "$@" >> "${omarchyLog}"\n`);
// A stand-in for Claude Code: logs what it was asked, waits long enough to click again, answers, changes nothing.
// Because it changes nothing, the server continues the same run once with its nudge (same --mcp-config, same run id),
// which this stand-in answers at once, again without a change: the composition stays undesigned.
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.0.0 (Fake)'); process.exit(0); }
if (args[0] === '--help') { console.log("  --model <model>  An alias (e.g. 'opus', or 'sonnet')."); process.exit(0); }
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(runsLog)}, JSON.stringify({ args, stdin: stdin.slice(-20000) }) + '\\n');
const say = (o) => console.log(JSON.stringify(o));
say({ type: 'system', subtype: 'init', model: 'stand-in-model' });
const nudged = stdin.includes(${JSON.stringify(NUDGE)});
setTimeout(() => {
  say({ type: 'assistant', message: { content: [{ type: 'text', text: nudged ? 'I could not design it.' : 'Looked at the board.' }] } });
  say({ type: 'result', is_error: false });
}, nudged ? 300 : 4000);
`);
// Codex is never found here, so no real one on PATH is ever asked.
writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 1\n');
for (const f of ['hyprctl', 'omarchy', 'claude', 'codex']) chmodSync(join(bin, f), 0o755);
process.env.HOME = home;
process.env.OMARCHY_PATH = omarchyPath;
process.env.PATH = `${bin}:${process.env.PATH}`;

const { BogenServer } = await import('../../../../packages/server/src/http/server.ts');

const runs = () => (existsSync(runsLog) ? readFileSync(runsLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; stdin: string }) : []);
/** Each server run has its own MCP config file; a nudge continues the same run with the same one. */
const configOf = (c: { args: string[] }) => c.args[c.args.indexOf('--mcp-config') + 1] ?? '';
function byRun(): Map<string, { args: string[]; stdin: string }[]> {
  const out = new Map<string, { args: string[]; stdin: string }[]>();
  for (const c of runs()) out.set(configOf(c), [...(out.get(configOf(c)) ?? []), c]);
  return out;
}
/** One run's CLI calls: the request, then at most one continuation, which is the server's nudge. */
const oneRun = (calls: { stdin: string }[] | undefined) => Boolean(calls?.length) && calls!.length <= 2 && !calls![0]!.stdin.includes(NUDGE) && (calls!.length === 1 || calls![1]!.stdin.includes(NUDGE));
const REACT_LOOP = /getSnapshot should be cached|Maximum update depth exceeded|infinite loop/i;

async function main(): Promise<void> {
  const server = new BogenServer({ home: join(work, 'bogen'), port: 0 });
  await server.listen();
  const base = server.localUrl();
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM, pipe: true, headless: true,
    args: [`--secure-local-port=${server.port}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    defaultViewport: { width: 1500, height: 1000 },
  });
  const warnings: string[] = [];
  const open = async (fileId: string): Promise<Page> => {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') warnings.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => warnings.push(String((e as Error).message).slice(0, 300)));
    await page.goto(`${base}/#/file/${fileId}`);
    await page.waitForSelector('[data-testid="omarchy-theme-banner"]', { timeout: 30_000 });
    await page.click('[data-testid="omarchy-theme-open"]');
    await page.waitForSelector('[data-testid="omarchy-theme-displays"]', { timeout: 15_000 });
    return page;
  };
  const shape = (fileId: string) => server.rooms.get(fileId).then((room) => {
    const pages = room.doc.getPages();
    const all = pages.flatMap((p) => room.doc.getChildren(p.id)).flatMap((b) => [b, ...room.doc.descendants(b.id).filter((n) => !n.virtual)]);
    return { pages: pages.length, ids: new Set(all.map((n) => n.id)), names: all.map((n) => n.name), boards: pages.flatMap((p) => room.doc.getChildren(p.id)).map((b) => ({ id: b.id, name: b.name })) };
  });
  const status = (page: Page) => page.$eval('[data-testid="omarchy-portrait-request-status"]', (e) => e.textContent ?? '').catch(() => '');
  const ended = (page: Page) => page.waitForSelector('[data-testid="omarchy-portrait-request"][data-phase="ended"]', { timeout: 30_000 });

  try {
    // ---------------------------------------------------------------- no 9:16 shape yet
    const made = await api('/api/omarchy/themes', { from: 'calm', name: 'Calm Desk' });
    check('a desktop theme is made', made.status === 201, made.body);
    const id = made.body.file_id as string;
    const files = server.storage.list().length;
    const before = await shape(id);
    check('it has a 10:16 board and no 9:16 board', before.boards.some((b) => b.name.startsWith('Portrait background · 10:16')) && !before.boards.some((b) => b.name.startsWith('Portrait background · 9:16')), before.boards.map((b) => b.name));

    const page = await open(id);
    await page.waitForSelector('[data-testid="omarchy-portrait-request-start"]', { timeout: 15_000 });
    await page.waitForFunction(() => /Asks Claude Code/.test(document.querySelector('[data-testid="omarchy-portrait-request-agent"]')?.textContent ?? ''), { timeout: 15_000 }).catch(() => null);
    const ready = await page.$eval('[data-testid="omarchy-portrait-request"]', (e) => ({
      text: e.textContent ?? '', disabled: (e.querySelector('[data-testid="omarchy-portrait-request-start"]') as HTMLButtonElement).disabled, phase: e.getAttribute('data-phase'),
    }));
    check('before any request the section is idle, the button can be used, and it names the agent and model', ready.phase === 'idle' && !ready.disabled && /Add 9:16 layout/.test(ready.text) && /Asks Claude Code · /.test(ready.text), ready);
    check('it says there is no 9:16 layout yet, and names no tool', /No 9:16 layout yet/.test(ready.text) && !/omarchy_theme|canvas_screenshot|@claude/.test(ready.text), ready.text);
    check('rendering it raised no React loop warning', !warnings.some((w) => REACT_LOOP.test(w)), warnings);
    await page.screenshot({ path: join(SHOTS, 'portrait-request-idle.png') as `${string}.png` });

    // Three clicks as fast as a person can't: one request.
    const commitsBefore = (await server.commits.list(id)).length;
    await page.$eval('[data-testid="omarchy-portrait-request-start"]', (b) => { for (let i = 0; i < 3; i++) (b as HTMLButtonElement).click(); });
    await page.waitForSelector('[data-testid="omarchy-portrait-request"][data-phase="running"]', { timeout: 30_000 });
    await page.click('[data-testid="omarchy-portrait-request-start"]').catch(() => {});
    const running = await page.$eval('[data-testid="omarchy-portrait-request"]', (e) => ({ text: e.textContent ?? '', disabled: (e.querySelector('[data-testid="omarchy-portrait-request-start"]') as HTMLButtonElement).disabled }));
    check('while it runs the button is disabled and says Claude Code is composing it, with Stop', running.disabled && /Claude Code is composing the 9:16 layout/.test(running.text) && /Stop/.test(running.text), running);
    const queue = (await api('/api/runs/queue')).body as { running: { fileId: string; title: string }[] };
    const here = queue.running.filter((r) => r.fileId === id);
    check('the queue shows exactly one run in this file, by its short title', here.length === 1 && here[0]!.title === 'Add 9:16 layout', here);
    await page.screenshot({ path: join(SHOTS, 'portrait-request-running.png') as `${string}.png` });

    await ended(page);
    await page.waitForFunction(() => /still needs its own design/.test(document.querySelector('[data-testid="omarchy-portrait-request-status"]')?.textContent ?? ''), { timeout: 20_000 }).catch(() => null);
    const said = await status(page);
    check('the end is honest: the stand-in designed nothing, so it still needs its own design', /Claude Code finished, but the 9:16 layout still needs its own design\./.test(said), said);
    const first = byRun();
    const [firstConfig, firstCalls] = [...first][0] ?? ['', []];
    check('the clicks started one run: one MCP config, the request plus at most the server\'s one nudge in that same run', first.size === 1 && oneRun(firstCalls), [...first].map(([k, v]) => ({ config: k, calls: v.length, nudged: v.map((c) => c.stdin.includes(NUDGE)) })));
    const asked = firstCalls[0]?.stdin ?? '';
    check('the agent got the brief: same file, the 9:16 board, no crop, no install', /Portrait background · 9:16/.test(asked) && /Never crop, stretch or rotate/.test(asked) && /Do not export, install or apply/.test(asked), asked.slice(0, 400));

    const after = await shape(id);
    const board916 = after.boards.find((b) => b.name.startsWith('Portrait background · 9:16'));
    check('the 9:16 shape was added in this file, and nothing was removed', Boolean(board916) && [...before.ids].every((n) => after.ids.has(n)), after.boards.map((b) => b.name));
    check('no new file, page or Custom copy', server.storage.list().length === files && after.pages === before.pages && !after.names.some((n) => /Custom|copy/i.test(n)), { files: server.storage.list().length, pages: after.pages });
    const records = await server.history.list(id);
    check('the run is on the 9:16 board, titled Add 9:16 layout', records.length === 1 && records[0]!.title === 'Add 9:16 layout' && records[0]!.nodeIds.join() === board916?.id, records.map((r) => ({ title: r.title, nodeIds: r.nodeIds })));
    check('its record says whether it was nudged, matching the CLI calls of that one run', Boolean(records[0]?.nudged) === (firstCalls.length === 2), { nudged: records[0]?.nudged, calls: firstCalls.length });
    const commits = await server.commits.list(id);
    const checkpoint = commits.find((c) => c.message === 'Before adding the 9:16 layout');
    check('a checkpoint was saved before the run', commits.length > commitsBefore && Boolean(checkpoint) && checkpoint!.at <= records[0]!.startedAt, commits.map((c) => c.message));

    // ---------------------------------------------------------------- the 9:16 board exists, not designed
    const second = await api('/api/omarchy/themes', { from: 'calm', name: 'Tall Desk', copy: true });
    const id2 = second.body.file_id as string;
    const added = await api(`/api/omarchy/theme/${id2}/displays`, { add: [{ preset: 'portrait-2160x3840' }] });
    check('a second theme gets a 9:16 board that needs its own design', added.status === 200 && added.body.theme.wallpapers.some((w: { aspect: string; status: string }) => w.aspect === '9:16' && w.status === 'needs-design'), added.body.theme?.wallpapers);
    const existing = (await shape(id2)).boards.find((b) => b.name.startsWith('Portrait background · 9:16'))!;
    const displays2 = (await api(`/api/omarchy/theme/${id2}/displays`)).body.displays.length as number;
    const page2 = await open(id2);
    await page2.waitForSelector('[data-testid="omarchy-portrait-request-start"]:not([disabled])', { timeout: 15_000 });
    await page2.click('[data-testid="omarchy-portrait-request-start"]');
    await page2.waitForSelector('[data-testid="omarchy-portrait-request-stop"]', { timeout: 30_000 });
    await page2.click('[data-testid="omarchy-portrait-request-stop"]');
    await ended(page2);
    const stopped = await status(page2);
    check('Stop stops it and says so', /^Stopped\./.test(stopped), stopped);
    const rec2 = (await server.history.list(id2))[0];
    check('it reused the existing 9:16 board and added no display', rec2?.nodeIds.join() === existing.id && (await api(`/api/omarchy/theme/${id2}/displays`)).body.displays.length === displays2, { nodeIds: rec2?.nodeIds, existing: existing.id });
    const all = byRun();
    const secondCalls = [...all].filter(([k]) => k !== firstConfig).map(([, v]) => v);
    check('the second request started exactly one more run, no more than one nudge in it, and the first run got no more calls', all.size === 2 && secondCalls.length === 1 && oneRun(secondCalls[0]) && all.get(firstConfig)!.length === firstCalls.length, [...all].map(([k, v]) => ({ config: k, calls: v.length })));
    check('one run record per request', (await server.history.list(id)).length === 1 && (await server.history.list(id2)).length === 1);

    // ---------------------------------------------------------------- narrow
    await page2.setViewport({ width: 390, height: 800 });
    const fits = await page2.$eval('.omarchy-dialog', (e) => e.scrollWidth <= e.clientWidth + 1);
    check('the dialog fits a phone-wide window without scrolling sideways', fits);
    await page2.screenshot({ path: join(SHOTS, 'portrait-request-narrow.png') as `${string}.png` });

    check('nothing was installed or applied', !existsSync(omarchyLog), existsSync(omarchyLog) ? readFileSync(omarchyLog, 'utf8') : '');
    check('no React loop warning at any point', !warnings.some((w) => REACT_LOOP.test(w)), warnings.filter((w) => REACT_LOOP.test(w)));
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`\n${passed}/${passed + failed.length} checks passed. Shots in ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
