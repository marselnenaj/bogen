/**
 * Every state of the call's interface, captured for design work: the call panel in its file, the call bar on Home
 * and in another file, the incoming, missed and ended cards, the call settings, at desktop and phone width, dark and
 * light. A real editor and server in a temporary BOGEN_HOME, secure-chromium with its sandbox on, a made-up
 * microphone; the speech is answered in the page and each state is set through the call's test door. Nothing leaves
 * the machine.
 *
 *   (cd apps/editor && npx vite build)
 *   BOGEN_SHOTS=<out> node --import tsx scripts/dev-call-shots.ts
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { BogenServer } from '../packages/server/src/http/server.ts';
import { writeFakeClis } from '../packages/server/test/fake-cli.ts';
import { nameSpecTree, RESET_CSS, type NewNode } from '@bogen/core';
import { CAPTURE, type SerializedCapture } from '../packages/server/src/capture.ts';
import { lintIssues } from '../packages/server/src/mcp/lint.ts';
import { auditA11y } from '../packages/server/src/a11y.ts';
import { freshPage, launch } from '../apps/editor/test/e2e/craft-harness.ts';

const root = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-call-shots-'));
const out = process.env.BOGEN_SHOTS ?? join(root, 'shots');
const bin = join(root, 'bin');
for (const d of [out, bin]) mkdirSync(d, { recursive: true });
writeFakeClis(bin, join(root, 'cli.log'));
process.env.PATH = `${bin}:${process.env.PATH}`;

const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false });
server.runs.beforeFinish = undefined;
await server.listen();
const base = server.localUrl();
const browser = await launch(Number(new URL(base).port), { fakeMedia: true });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function silence(): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const wav = silence();
const STATUS = {
  voices: [{ id: 'v-en', language: 'en', name: 'Heart', licence: 'Apache-2.0', bytes: 1, installed: true, preferred: true }, { id: 'v-en2', language: 'en', name: 'Michael', licence: 'Apache-2.0', bytes: 80_000_000, installed: false, preferred: false }],
  listen: { installed: true, bytes: 1, licence: 'CC-BY-4.0', voxtype: false, ffmpeg: true, engine: 'parakeet', parakeet: { installed: true, bytes: 1, licence: 'CC-BY-4.0' }, whisper: { installed: true, bytes: 1, licence: 'MIT', gpu: true } },
  installing: [], ready: { en: true }, talk: { gpu: true, models: [{ id: 'qwen3-4b', label: 'Qwen3 4B', licence: 'Apache-2.0', source: '', bytes: 2_497_280_256, installed: false, recommended: true }], claude: true, auto: 'claude' },
};
function speech(req: HTTPRequest): void {
  const url = req.url();
  if (url.includes('/api/call/status')) return void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(STATUS) });
  if (url.includes('/api/call/say')) return void req.respond({ status: 200, contentType: 'audio/wav', body: wav });
  if (url.includes('/api/call/talk')) return void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: null }) });
  if (url.includes('/api/call/listen')) return void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: '' }) });
  if (url.includes('/api/call/log') || url.includes('/api/call/end')) return void req.respond({ status: 200, contentType: 'application/json', body: '{}' });
  req.continue();
}

const a = server.storage.create('Lindenhof · Bakery orders and pickup');
const b = server.storage.create('Bogen Brand System');
for (const entry of [a, b]) {
  const room = await server.rooms.get(entry.id);
  room.doc.insert(room.doc.getPages()[0]!.id, { type: 'frame', name: 'Home', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '800px', height: '500px', background: '#f4f2ec' } });
  room.doc.invalidate();
}
await fetch(`${base}/api/call/preferences`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'length', value: 'short', text: 'Keep it short.' }) }).catch(() => null);

const FIXED = {
  light: { '--ui-bg': '#ffffff', '--ui-bg-2': '#f6f6f5', '--ui-bg-3': '#ecebea', '--ui-fg': '#1d1d1c', '--ui-fg-2': '#6d6c69', '--ui-border': '#e4e3e1', '--ui-accent': '#2560d8', '--ui-accent-fg': '#ffffff', '--ui-danger': '#b3261e' },
  dark: { '--ui-bg': '#1c1c1b', '--ui-bg-2': '#232322', '--ui-bg-3': '#2d2d2c', '--ui-fg': '#e8e7e4', '--ui-fg-2': '#b4b3ae', '--ui-border': '#3d3d38', '--ui-accent': '#8bb4ff', '--ui-accent-fg': '#10213d', '--ui-danger': '#f28b82' },
};
async function scheme(page: Page, mode: 'dark' | 'light'): Promise<void> {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluate((vars, m) => {
    const r = document.documentElement;
    for (const [k, v] of Object.entries(vars)) r.style.setProperty(k, v);
    r.setAttribute('data-theme-mode', m);
    // The dark pass's own page lingers as a guest's cursor on the canvas for a while: an artefact of the captures.
    const hide = () => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-testid="canvas"] *')) if (/^Guest \d+$/.test(el.textContent ?? '') && !el.children.length) (el.parentElement ?? el).style.visibility = 'hidden';
      // And as the other person on the tabs, which the dark pass's page was.
      for (const el of document.querySelectorAll<HTMLElement>('[data-mark="peer"]')) el.style.visibility = 'hidden';
    };
    hide();
    new MutationObserver(hide).observe(document.body, { childList: true, subtree: true });
  }, FIXED[mode], mode);
}
const setCall = (page: Page, patch: Record<string, unknown>) => page.evaluate((p) => (window as unknown as { __bogenCall: { set: (p: unknown) => void } }).__bogenCall.set(p), ids(patch));
const setIncoming = (page: Page, patch: Record<string, unknown>) => page.evaluate((p) => (window as unknown as { __bogenIncoming: { set: (p: unknown) => void } }).__bogenIncoming.set(p), patch);
const go = async (page: Page, hash: string) => { await page.evaluate((h) => { location.hash = h; }, hash); await rest(page); await wait(900); };
/** The pointer goes to an empty corner, so no row or button shows its hover state in a capture. */
const rest = async (page: Page) => { const v = page.viewport()!; await page.mouse.move(1, v.height - 1); };

const now = Date.now();
const you = (text: string) => ({ who: 'you', text, at: now });
const voice = (text: string) => ({ who: 'agent', text, at: now });
/** The call's states that the panel and the bar show, in the order a call goes through them. */
const STATES: [string, Record<string, unknown>][] = [
  ['connecting', { connecting: true, turn: 'listening', speaking: null, working: false, muted: false, error: null, captions: [], followed: null, reconnecting: false }],
  ['listening', { connecting: false, turn: 'listening', captions: [] }],
  ['you-speaking', { turn: 'hearing', captions: [you('Make the headline on the start page a lot bigger and maybe')] }],
  ['voice-speaking', { turn: 'speaking', speaking: 'A bigger headline on the start page. Starting now.', captions: [you('Make the headline on the start page a lot bigger, and give the portraits more room.'), voice('A bigger headline on the start page. Starting now.')], latencyMs: 1180 }],
  ['agent-working', { turn: 'listening', speaking: null, working: true, activity: 'Drawing', captions: [you('Make the headline on the start page a lot bigger, and give the portraits more room.'), voice('A bigger headline on the start page. Starting now.')] }],
  ['muted', { muted: true }],
  // The call moved with the person: its file is the other one now, as in the app.
  ['moved', { muted: false, working: false, activity: null, fileId: '@b', fileName: 'Bogen Brand System', followed: { at: Date.now() + 600_000, name: 'Bogen Brand System', runIn: null } }],
  ['reconnecting', { fileId: '@a', fileName: 'Lindenhof · Bakery orders and pickup', muted: false, followed: null, reconnecting: true }],
  ['error-mic', { reconnecting: false, errorKind: 'mic', error: 'The microphone is blocked for Bogen. Allow it in the browser to talk.' }],
];
/** The file ids are known only once the files exist: '@a' and '@b' stand for them in STATES. */
const ids = (patch: Record<string, unknown>) => Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === '@a' ? a.id : v === '@b' ? b.id : v]));

/**
 * Bogen's own checks over the call's interface as it renders now: the page is captured with the same script as a
 * site capture, the call panel or the dock is taken out of it, and design_lint and a11y_audit run on that alone.
 */
const checksFile = server.storage.create('Call UI checks');
const findings: string[] = [];
let hardTotal = 0, a11yTotal = 0, checked = 0;
function find(node: NewNode, names: string[]): NewNode | null {
  if (names.includes(node.name ?? '')) return node;
  for (const c of (node as { children?: NewNode[] }).children ?? []) { const f = find(c, names); if (f) return f; }
  return null;
}
async function checkHere(page: Page, label: string, width: number): Promise<void> {
  if (!process.env.BOGEN_CHECKS) return;
  const captured = await page.evaluate(`(${CAPTURE})(${JSON.stringify({ reset: RESET_CSS, known: [], liveTokens: false })})`) as SerializedCapture;
  if (!captured.root) return;
  const root = nameSpecTree(captured.root, true) as NewNode;
  const part = find(root, ['Call settings']) ?? find(root, ['calldock']) ?? find(root, ['Call with the agent']) ?? find(root, ['Call ended']);
  if (!part) { findings.push(`${label}: no call UI in the capture`); return; }
  const box = await page.evaluate(() => { const e = document.querySelector('.call-settings') ?? document.querySelector('.calldock') ?? document.querySelector('.call-panel'); const r = e!.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  part.style = { ...part.style, position: 'relative', left: '0px', top: '0px', right: 'auto', bottom: 'auto', transform: 'none', width: `${box.w}px` };
  const room = await server.rooms.get(checksFile.id);
  const doc = room.doc;
  const pageId = doc.createPage(label);
  const board = doc.insert(pageId, { type: 'frame', name: label, artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: `${box.w + 32}px`, padding: '16px', background: await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-bg-2') || '#222'), display: 'flex', flexDirection: 'column' }, children: [part] } as NewNode);
  doc.invalidate();
  const nodes = [doc.getNode(board)!, ...doc.descendants(board)];
  const issues = await lintIssues(doc, server.renderer, { nodeIds: [board] }, nodes);
  const hard = issues.filter((i) => i.severity === 'hard');
  const a11y = await auditA11y(doc, server.renderer, { nodeId: board });
  const a11yIssues = a11y.layers.flatMap((l) => l.issues.map((x) => `${(x as { rule?: string }).rule ?? ''} ${l.name ?? ''}: ${((x as { message?: string }).message ?? '').slice(0, 120)}`));
  hardTotal += hard.length; a11yTotal += a11yIssues.length; checked++;
  for (const i of hard) findings.push(`${label} hard ${i.rule} [${doc.getNode(i.nodeId)?.name}]: ${i.message.slice(0, 140)}`);
  for (const x of a11yIssues) findings.push(`${label} a11y ${x}`);
  void width;
}

let n = 0;
const shot = async (page: Page, name: string) => { n++; await page.screenshot({ path: join(out, `${String(n).padStart(2, '0')}-${name}.png`) }); };

try {
  for (const mode of ['dark', 'light'] as const) {
    // Desktop: the call's own file with the chat (the call panel), Home and another file (the call bar).
    const page = await freshPage(browser);
    await page.setRequestInterception(true);
    page.on('request', speech);
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    // File B first, so it has its tab as it would when the person opens it and the call moves there.
    await page.goto(`${base}/#/file/${b.id}`);
    await page.waitForSelector('[data-testid="editor"]', { timeout: 20_000 });
    await go(page, `#/file/${a.id}`);
    await page.waitForSelector('[data-testid="editor"]', { timeout: 20_000 });
    await scheme(page, mode);
    await wait(800);
    if (!(await page.$('[data-testid="chat-call"]'))) await page.click('[data-testid="prompt-toggle"]');
    await page.waitForSelector('[data-testid="chat-call"]', { timeout: 10_000 }).catch(async (e) => { await page.screenshot({ path: join(out, 'debug.png') }); throw e; });
    await shot(page, `${mode}-desktop-idle-call-button`);
    await page.click('[data-testid="chat-call"]');
    await page.waitForSelector('[data-testid="call-panel"]', { timeout: 10_000 });
    await rest(page);
    await wait(1200);
    await setCall(page, { follow: false });
    for (const [name, patch] of STATES) {
      // Moved, the call is in the other file, so the card here gives way to the bar: that shows on Home and in file B.
      if (name === 'moved') continue;
      await setCall(page, patch); await wait(250); await shot(page, `${mode}-desktop-panel-${name}`); if (['voice-speaking', 'agent-working', 'error-mic'].includes(name)) await checkHere(page, `${mode} panel ${name}`, 1440);
    }
    await setCall(page, { error: null, errorKind: null, status: { ...STATUS, ready: { en: false }, listen: { ...STATUS.listen, installed: false, bytes: 640_000_000 } } });
    await wait(250); await shot(page, `${mode}-desktop-panel-stt-unavailable`);
    await setCall(page, { status: STATUS, error: null, errorKind: null, reconnecting: false, muted: false, working: true, activity: 'Drawing', speaking: null, turn: 'listening', followed: null });
    await wait(300);
    await page.click('[data-testid="call-more"]'); await wait(200);
    await page.click('[data-testid="call-menu-transcript"]'); await rest(page); await wait(250); await shot(page, `${mode}-desktop-panel-transcript`);
    await page.click('[data-testid="call-transcript-close"]'); await rest(page); await wait(150);
    if (await page.$('[data-testid="call-more"]')) {
      await page.click('[data-testid="call-more"]'); await wait(250); await shot(page, `${mode}-desktop-panel-more`);
      await page.click('[data-testid="call-menu-settings"]'); await wait(300); await shot(page, `${mode}-desktop-settings`);
      await checkHere(page, `${mode} settings`, 1440);
      await page.keyboard.press('Escape'); await wait(200);
    } else {
      await page.evaluate(() => document.querySelector('[data-testid="call-prefs"]')?.scrollIntoView());
      await wait(200); await shot(page, `${mode}-desktop-panel-settings`);
    }
    // Home, and the other file.
    await go(page, '#/');
    await scheme(page, mode);
    for (const [name, patch] of STATES) { await setCall(page, patch); await wait(name === 'moved' ? 1200 : 250); await shot(page, `${mode}-desktop-bar-home-${name}`); if (['voice-speaking', 'agent-working', 'moved'].includes(name)) await checkHere(page, `${mode} bar ${name}`, 1440); }
    await setCall(page, { error: null, errorKind: null, reconnecting: false, muted: false, working: true, activity: 'Drawing', followed: null });
    await go(page, `#/file/${b.id}`);
    await page.waitForSelector('[data-testid="editor"]', { timeout: 20_000 });
    await scheme(page, mode);
    await wait(400); await shot(page, `${mode}-desktop-bar-other-file`);
    // Incoming during the call, then a missed one.
    await setIncoming(page, { ringing: { id: 'i1', fileId: a.id, fileName: 'Lindenhof · Bakery orders and pickup', runId: 'r1', runner: 'claude', question: 'I found two headers on the start page. Should both get the same height?', at: Date.now() - 12_000, expiresAt: Date.now() + 18_000 } });
    await wait(300); await shot(page, `${mode}-desktop-incoming`); await checkHere(page, `${mode} incoming`, 1440);
    await setIncoming(page, { ringing: null, missed: { id: 'i1', fileId: a.id, fileName: 'Lindenhof · Bakery orders and pickup', runId: 'r1', runner: 'claude', question: 'Should both get the same height?', at: Date.now(), expiresAt: Date.now() } });
    await wait(300); await shot(page, `${mode}-desktop-missed`);
    await setIncoming(page, { missed: null });
    // Ended: short, then with a note of what changed.
    await setCall(page, { active: false, ended: { at: Date.now(), seconds: 312, fileId: a.id, fileName: 'Lindenhof · Bakery orders and pickup', note: [] } });
    await wait(300); await shot(page, `${mode}-desktop-ended`);
    await setCall(page, { ended: { at: Date.now(), seconds: 312, fileId: a.id, fileName: 'Lindenhof · Bakery orders and pickup', note: [
      { fileId: a.id, fileName: 'Lindenhof · Bakery orders and pickup', runs: [{ title: 'Bigger headline on the start page', status: 'done' }, { title: 'More room for the portraits', status: 'stopped' }] },
      { fileId: b.id, fileName: 'Bogen Brand System', runs: [{ title: 'Tighter call bar spacing', status: 'running' }] },
    ] } });
    await wait(300); await shot(page, `${mode}-desktop-ended-note`); await checkHere(page, `${mode} ended note`, 1440);
    // An agent's call, and a missed one, with no call going on.
    await setCall(page, { ended: null });
    await setIncoming(page, { ringing: { id: 'i3', fileId: a.id, fileName: 'Lindenhof · Bakery orders and pickup', runId: 'r3', runner: 'claude', question: 'I found two headers on the start page. Should both get the same height?', at: Date.now() - 6_000, expiresAt: Date.now() + 24_000 } });
    await wait(300); await shot(page, `${mode}-desktop-incoming-no-call`);
    await setIncoming(page, { ringing: null, missed: { id: 'i3', fileId: a.id, fileName: 'Lindenhof · Bakery orders and pickup', runId: 'r3', runner: 'claude', question: 'Should both get the same height?', at: Date.now(), expiresAt: Date.now() } });
    await wait(300); await shot(page, `${mode}-desktop-missed-no-call`);
    await setIncoming(page, { missed: null });
    await setCall(page, { ended: null, active: true, startedAt: Date.now() - 95_000 });

    // Phone width: Home and the call's file.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await go(page, '#/');
    await scheme(page, mode);
    for (const [name, patch] of STATES.filter(([k]) => ['listening', 'you-speaking', 'voice-speaking', 'agent-working', 'muted', 'moved'].includes(k))) {
      // Each phone state on its own, not on top of the one before.
      await setCall(page, { fileId: '@a', fileName: 'Lindenhof · Bakery orders and pickup', turn: 'listening', speaking: null, working: false, activity: null, muted: false, followed: null, ...patch, error: null, errorKind: null, reconnecting: false }); await wait(250); await shot(page, `${mode}-phone-bar-${name}`); if (name === 'agent-working') await checkHere(page, `${mode} phone bar ${name}`, 390);
    }
    await setCall(page, { followed: null, fileId: '@a', fileName: 'Lindenhof · Bakery orders and pickup' });
    await setIncoming(page, { ringing: { id: 'i2', fileId: a.id, fileName: 'Lindenhof · Bakery orders and pickup', runId: 'r2', runner: 'claude', question: 'I found two headers on the start page. Should both get the same height?', at: Date.now() - 12_000, expiresAt: Date.now() + 18_000 } });
    await wait(300); await shot(page, `${mode}-phone-incoming`);
    await setIncoming(page, { ringing: null });
    await go(page, `#/file/${a.id}`);
    await scheme(page, mode);
    await wait(800); await shot(page, `${mode}-phone-in-file`);
    await setCall(page, { active: false, ended: { at: Date.now(), seconds: 312, fileId: a.id, fileName: 'Lindenhof · Bakery orders and pickup', note: [
      { fileId: a.id, fileName: 'Lindenhof · Bakery orders and pickup', runs: [{ title: 'Bigger headline on the start page', status: 'done' }] },
    ] } });
    await wait(300); await shot(page, `${mode}-phone-ended-note`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`${n} captures in ${out}`);
if (process.env.BOGEN_CHECKS) {
  console.log(`checks: ${checked} states, design_lint hard ${hardTotal}, a11y ${a11yTotal}`);
  for (const f of findings) console.log(`   ${f}`);
}
process.exit(0);
