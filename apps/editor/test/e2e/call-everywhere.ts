/**
 * A call that goes with the person, through the real editor and a real server in a temporary BOGEN_HOME, in
 * secure-chromium with its sandbox on and a made-up microphone. The speech parts are answered in the page (the
 * models are not needed to show where the call is), and nothing leaves the machine:
 *
 * - a call started in file A keeps going on the home screen and in file B, where the bar says it belongs to A;
 * - Back to the call opens A with the full call panel, the same call (its start time unchanged);
 * - an agent's call rings in the dock when agent calls are on, and Decline ends it on the server;
 * - hanging up from the bar leaves a short "Call ended" note.
 * - what the call remembers shows in its settings and can be forgotten;
 * - with "moves with the file you open" on, opening file B takes the call there, with a tone and the bar naming B;
 * - a call that ran requests ends with a note of the files and requests, which stays until closed;
 * - no tooltip comes up over the card when it opens under the pointer, and the chat's header does not move;
 * - the bar sits on the content column and the page keeps room for it, so its last row scrolls clear of it;
 * - the tab's phone mark follows the call's file when the call moves;
 * - one voice and one call (the live report of 2026-11-17, "two agents talk at once" after opening another file): the
 *   talking layer's first sentence and the rest are said one after the other, never over each other, with a file
 *   loaded behind another tab, after following the editor and after a move by voice; a run working when the call moves
 *   finishes in its file and shows as "Finishing in" it, not as a second agent; a request said after the move waits for
 *   it and then runs once, in the new file; a second window that opens a call takes it over, the first goes quiet and
 *   does not close the server's call, and the server knows exactly one call;
 * - every state, in dark and light, card and bar: the title never contradicts the state, Mute, More and End are the
 *   same elements throughout (disabled, never gone), nothing but End and errors takes the danger hue, and axe finds
 *   nothing.
 *
 *   (cd apps/editor && npx vite build)
 *   node --import tsx apps/editor/test/e2e/call-everywhere.ts
 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { writeFakeClis } from '../../../../packages/server/test/fake-cli.ts';
import { freshPage, launch } from './craft-harness.ts';

const root = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-call-everywhere-'));
const shots = process.env.BOGEN_SHOTS ?? join(root, 'shots');
const bin = join(root, 'bin');
for (const d of [shots, bin]) mkdirSync(d, { recursive: true });
writeFakeClis(bin, join(root, 'cli.log'));
process.env.PATH = `${bin}:${process.env.PATH}`;

const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false });
server.runs.beforeFinish = undefined;
await server.listen();
const base = server.localUrl();
const browser = await launch(Number(new URL(base).port), { fakeMedia: true });

let passed = 0;
const failures: string[] = [];
const errors: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`pass  ${name}`); } else { failures.push(name); console.log(`FAIL  ${name}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* between states */ }
    await wait(60);
  }
  return false;
}
const exists = (page: Page, sel: string) => page.$(sel).then(Boolean);
const text = (page: Page, sel: string) => page.$eval(sel, (e) => (e as HTMLElement).innerText).catch(() => '');
const attr = (page: Page, sel: string, name: string) => page.$eval(sel, (e, n) => e.getAttribute(n), name).catch(() => null);
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
/** axe-core over the dock: WCAG 2.2 A and AA, contrast included. Returns the rule ids that fail, with their count. */
async function axe(page: Page): Promise<string[]> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe.run(
      { include: [['[data-testid="calldock"]']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((v) => `${v.id} x${v.nodes.length}`);
  });
}
/** axe-core over one part of the page, WCAG 2.2 A and AA. */
async function axeOn(page: Page, selector: string): Promise<string[]> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(axeSource);
  return page.evaluate(async (sel) => {
    const r = await (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe.run(
      { include: [[sel]] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((v) => `${v.id} x${v.nodes.length}`);
  }, selector);
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) });

/** A second of silence as WAV, for the voice. */
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

/** The call's speech, answered in the page: ready in both languages, a silent voice, nothing heard. */
const STATUS = {
  voices: [{ id: 'v-en', language: 'en', name: 'Test voice', licence: 'test', bytes: 1, installed: true, preferred: true }, { id: 'v-de', language: 'de', name: 'Teststimme', licence: 'test', bytes: 1, installed: true, preferred: true }],
  listen: { installed: true, bytes: 1, licence: 'test', voxtype: false, ffmpeg: true, engine: 'parakeet' },
  installing: [], ready: { de: true, en: true }, talk: { gpu: false, models: [], claude: false, auto: 'rules' },
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

const a = server.storage.create('Trauermusik Wien');
const b = server.storage.create('Sprechstunde');
for (const entry of [a, b]) {
  const room = await server.rooms.get(entry.id);
  room.doc.insert(room.doc.getPages()[0]!.id, { type: 'frame', name: 'Home', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '800px', height: '500px', background: '#f4f2ec' } });
  room.doc.invalidate();
}

try {
  const page = await freshPage(browser);
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setRequestInterception(true);
  page.on('request', speech);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${base}/#/file/${a.id}`);
  await page.waitForSelector('[data-testid="editor"]', { timeout: 20_000 });
  await page.click('[data-testid="prompt-toggle"]');
  await page.waitForSelector('[data-testid="chat-call"]', { timeout: 10_000 });
  await page.evaluate(() => fetch('/api/call/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'length', value: 'short', text: 'Sprich kürzer.' }) }));
  const headBefore = await page.$eval('.chat-head', (e) => e.getBoundingClientRect().top);
  await page.click('[data-testid="chat-call"]');
  check('the call opens its panel in file A', await until(() => exists(page, '[data-testid="call-panel"]')));
  // The card opens under the chat's header: the header, and the pointer on its call button, stay where they were.
  check('the chat\'s header does not move when the call opens', (await page.$eval('.chat-head', (e) => e.getBoundingClientRect().top)) === headBefore);
  check('its call button becomes the call\'s live mark', await exists(page, '[data-testid="chat-call-live"]'));
  await wait(900);
  check('no tooltip comes up over the card as it opens under the resting pointer', !(await page.evaluate(() => Boolean(document.querySelector('[data-testid="tooltip"]')?.isConnected))));
  // The panel is the strip and the last line; everything else is in Call settings, from More.
  check('the panel holds only Mute, More and End as controls', await until(async () => (await page.$$eval('[data-testid="call-panel"] .call-controls button', (b) => b.length)) === 3), await page.$$eval('[data-testid="call-panel"] .call-controls button', (b) => b.map((x) => x.getAttribute('aria-label'))));
  check('and the chat under it drops its first suggestions during the call', !(await exists(page, '.chat-starter')) && (await exists(page, '.chat-empty.is-call')));
  check('no settings in the panel itself', !(await exists(page, '[data-testid="call-panel"] select')) && !(await exists(page, '[data-testid="call-panel"] [data-testid="call-follow"]')));
  await page.click('[data-testid="call-more"]');
  check('More opens a menu', await until(() => exists(page, '[data-testid="call-menu-settings"]')));
  await page.click('[data-testid="call-menu-settings"]');
  check('Call settings open from it', await until(() => exists(page, '[data-testid="call-settings"]')));
  check('its settings list what the call remembers', await until(async () => /Short answers|Kurze Antworten/.test(await text(page, '[data-testid="call-remembered"]'))), await text(page, '[data-testid="call-remembered"]'));
  await page.click('[data-testid="call-forget-all"]');
  check('Forget all empties it, here and on the server', await until(async () => /Nothing yet/.test(await text(page, '[data-testid="call-remembered"]'))) && (await page.evaluate(() => fetch('/api/call/preferences').then((r) => r.json()))).items.length === 0);
  check('the call moves with the file by default', (await attr(page, '[data-testid="call-follow"]', 'aria-checked')) === 'true');
  // First the call stays in its file: the bar elsewhere names it.
  await page.click('[data-testid="call-follow"]');
  check('the settings dialog has no accessibility findings', (await axeOn(page, '[data-testid="call-settings"]')).length === 0, await axeOn(page, '[data-testid="call-settings"]'));
  await shot(page, '00-call-settings');
  await page.keyboard.press('Escape');
  check('Escape closes Call settings', await until(async () => !(await exists(page, '[data-testid="call-settings"]'))));
  check('the call panel has no accessibility findings', (await axeOn(page, '[data-testid="call-panel"]')).length === 0, await axeOn(page, '[data-testid="call-panel"]'));
  check('and the bar does not repeat it there', !(await exists(page, '[data-testid="callbar"]')));
  check('the call starts listening', await until(async () => (await text(page, '[data-testid="call-turn"]')).length > 0, 10_000));
  await wait(600);
  const startedIn = await page.evaluate(() => document.querySelector('[data-testid="call-panel"] [data-testid="call-clock"]')?.textContent ?? '');

  // Home
  await page.evaluate(() => { location.hash = '#/'; });
  check('on the home screen the call bar shows', await until(() => exists(page, '[data-testid="callbar"]')));
  check('it belongs to file A', (await attr(page, '[data-testid="callbar"]', 'data-file')) === a.id);
  check('it says the call is on', /Listening|Connecting|Muted|is speaking|is working|You are speaking/.test(await text(page, '[data-testid="callbar-title"]')), await text(page, '[data-testid="callbar-title"]'));
  check('and where requests go', (await text(page, '[data-testid="callbar-sub"]')).includes('Trauermusik Wien'), await text(page, '[data-testid="callbar-sub"]'));
  check('the page\'s list ends above the bar, so nothing scrolls under it', await page.evaluate(() => document.documentElement.classList.contains('has-calldock') && document.querySelector('.home-body')!.getBoundingClientRect().bottom <= document.querySelector('[data-testid="calldock"]')!.getBoundingClientRect().top));
  await wait(1200);
  const cover = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.home-body')!;
    body.scrollTop = body.scrollHeight;
    const dock = document.querySelector('[data-testid="calldock"]')!.getBoundingClientRect();
    const col = body.getBoundingClientRect();
    let bottom = 0;
    for (const e of body.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.height > 0 && r.width > 0 && getComputedStyle(e).visibility !== 'hidden') bottom = Math.max(bottom, r.bottom); }
    const out = { last: Math.round(bottom), dockTop: Math.round(dock.top), dockMid: Math.round(dock.left + dock.width / 2), colMid: Math.round(col.left + col.width / 2) };
    body.scrollTop = 0;
    return out;
  });
  check('scrolled to its end, the page\'s last row is clear of the bar', cover.last <= cover.dockTop, cover);
  check('the bar is centred on the content column, not the window', Math.abs(cover.dockMid - cover.colMid) <= 2, cover);
  await wait(2500);
  const barClock = await text(page, '[data-testid="callbar"] [data-testid="call-clock"]');
  check('the bar\'s clock runs with the call', /^\d+:\d\d$/.test(barClock) && barClock !== '0:00', barClock);
  check('the bar has no accessibility findings (axe, WCAG 2.2 AA)', (await axe(page)).length === 0, await axe(page));
  await shot(page, '01-home-with-call');

  // File B
  await page.evaluate((id) => { location.hash = `#/file/${id}`; }, b.id);
  await page.waitForSelector('[data-testid="editor"]', { timeout: 20_000 });
  check('in file B the bar names the call\'s own file', await until(async () => (await text(page, '[data-testid="callbar-sub"]')).includes('Trauermusik Wien')), await text(page, '[data-testid="callbar-sub"]'));
  check('and file B has no call panel of its own', !(await exists(page, '[data-testid="call-panel"]')));
  await shot(page, '02-other-file');

  // Back to the call
  await page.click('[data-testid="callbar-back"]');
  check('Back to the call opens file A', await until(() => page.evaluate((id) => location.hash === `#/file/${id}`, a.id)));
  check('with the full call panel', await until(() => exists(page, '[data-testid="call-panel"]'), 15_000));
  const later = await page.evaluate(() => document.querySelector('[data-testid="call-panel"] [data-testid="call-clock"]')?.textContent ?? '');
  check('it is the same call, its clock went on', later !== '' && later >= startedIn, { startedIn, later });

  // A request typed in the call's file during the call is one of the call's, for its end note.
  await page.$eval('[data-testid="prompt-input"]', (el, v) => {
    const area = el as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, v as string);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }, 'Make the header taller');
  await page.focus('[data-testid="prompt-input"]');
  await page.keyboard.press('Enter');
  check('the request runs and ends', await until(async () => (await text(page, '[data-testid="prompt-messages"]')).includes('Done.'), 20_000));
  await wait(2500);

  // Moving with the person: on, then file B opened from the address.
  await page.click('[data-testid="call-more"]');
  await page.waitForSelector('[data-testid="call-menu-follow"]');
  await page.click('[data-testid="call-menu-follow"]');
  // The made-up microphone beeps every second, which the call hears as someone talking, and a call never moves
  // in the middle of a sentence. Muted, it hears nothing, as when the person opens a file in silence.
  await page.click('[data-testid="call-mute"]');
  await page.evaluate((id) => { location.hash = `#/file/${id}`; }, b.id);
  await page.waitForSelector('[data-testid="editor"]', { timeout: 20_000 });
  check('the call goes along to file B', await until(async () => (await attr(page, '[data-testid="callbar"]', 'data-file')) === b.id, 15_000), await attr(page, '[data-testid="callbar"]', 'data-file'));
  check('and the bar says it moved, naming the file', /Call moved/.test(await text(page, '[data-testid="callbar-title"]')) && (await text(page, '[data-testid="callbar-sub"]')).includes('Sprechstunde'), [await text(page, '[data-testid="callbar-title"]'), await text(page, '[data-testid="callbar-sub"]')]);
  check('the bar\'s clock keeps running when the call moves', /^\d+:\d\d$/.test(await text(page, '[data-testid="callbar"] [data-testid="call-clock"]')));
  check('the phone mark moves to file B\'s tab', await until(async () => await exists(page, `[data-testid="filetab"][data-file="${b.id}"] [data-mark="call"]`) && !(await exists(page, `[data-testid="filetab"][data-file="${a.id}"] [data-mark="call"]`))));
  check('the moved bar has no accessibility findings', (await axe(page)).length === 0, await axe(page));
  await shot(page, '02b-moved');
  check('then it shows the call as usual', await until(async () => !/^Call moved/.test(await text(page, '[data-testid="callbar-title"]')), 8000));
  await page.click('[data-testid="callbar-mute"]');

  // Incoming: agent calls on, a run that ended on a question rings in the dock, Decline ends it.
  await page.evaluate(() => fetch('/api/call/incoming/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) }));
  await page.evaluate(() => { location.hash = '#/'; });
  await until(() => exists(page, '[data-testid="callbar"]'));
  const rang = await server.incomingCalls.runEnded({ runId: 'r1', fileId: b.id, runner: 'claude', status: 'done', origin: 'prompt', reply: 'Ich habe zwei Kopfzeilen gefunden.\n\nSoll ich beide gleich hoch machen?' });
  check('the server rings for a question', Boolean(rang));
  check('the incoming call shows with its question', await until(async () => (await text(page, '[data-testid="incoming-call"]')).includes('Soll ich beide gleich hoch machen?')));
  check('the incoming call has no accessibility findings', (await axe(page)).length === 0, await axe(page));
  await shot(page, '03-incoming-during-call');
  await page.click('[data-testid="incoming-decline"]');
  check('Decline takes it away', await until(async () => !(await exists(page, '[data-testid="incoming-call"]'))));
  check('and ends it on the server', await until(() => server.incomingCalls.current.ringing === null));

  // Hang up from the bar.
  await page.click('[data-testid="callbar-end"]');
  check('hanging up leaves a short note', await until(() => exists(page, '[data-testid="callbar-ended"]')));
  const note = await text(page, '[data-testid="call-note"]');
  check('which lists the file the call changed and its request', note.includes('Trauermusik Wien') && note.includes('Make the header taller'), note);
  check('and not the file it only moved to', !note.includes('Sprechstunde'), note);
  await wait(9000);
  check('a note of what changed stays until it is closed', await exists(page, '[data-testid="call-note"]'));
  check('the ended note has no accessibility findings', (await axe(page)).length === 0, await axe(page));
  await shot(page, '04-ended');

  // Phone width: the bar fits, with targets of 44px.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.click('[data-testid="callbar-again"]');
  check('Call again starts a call in file A from home', await until(() => exists(page, '[data-testid="callbar"]')));
  await wait(400);
  const fit = await page.evaluate(() => { const r = document.querySelector('[data-testid="callbar"]')!.getBoundingClientRect(); const end = document.querySelector('[data-testid="callbar-end"]')!.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth, end: end.height }; });
  check('at phone width the bar stays inside the screen', fit.left >= 0 && fit.right <= fit.width, fit);
  check('with 44px targets', fit.end >= 44, fit);
  check('at phone width neither', (await axe(page)).length === 0, await axe(page));
  await shot(page, '05-phone');
  // The light theme.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.evaluate(() => { try { localStorage.setItem('bogen-settings', JSON.stringify({ appearance: 'light' })); } catch { /* none */ } });
  await wait(300);
  check('in the light theme neither', (await axe(page)).length === 0, await axe(page));
  await shot(page, '06-phone-light');
  await page.click('[data-testid="callbar-end"]');



  // One voice and one call. The speech parts are answered in the page again, now with a talking layer that writes
  // each turn the way Claude Code does: the first sentence as soon as it is written, then the whole answer.
  const TALK_STATUS = { ...STATUS, talk: { gpu: false, models: [], claude: true, auto: 'claude' } };
  interface Stand { heard: string[]; turns: string[]; says: number; listens: number; ends: number; calls: string[] }
  const stand = (): Stand => ({ heard: [], turns: [], says: 0, listens: 0, ends: 0, calls: [] });
  const json = (o: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  const talking = (st: Stand) => (req: HTTPRequest) => {
    const url = req.url();
    if (url.includes('/api/call/status')) return void req.respond(json(TALK_STATUS));
    // The voice takes a moment to make each line, as Piper does: the next line comes while one is being made.
    if (url.includes('/api/call/say')) { st.says++; return void setTimeout(() => void req.respond({ status: 200, contentType: 'audio/wav', body: wav }).catch(() => undefined), 350); }
    if (url.includes('/api/call/listen')) { st.listens++; return void req.respond(json({ text: st.heard.shift() ?? '' })); }
    if (url.includes('/api/call/talk')) {
      const body = JSON.parse(req.postData() ?? '{}') as { warm?: boolean; kind?: string; call?: string };
      // The real server keeps the call; the rules stand in for its talking layer.
      if (body.warm) { if (body.call) st.calls.push(body.call); return void req.continue({ postData: JSON.stringify({ ...body, choice: 'rules' }) }); }
      if (body.kind === 'turn') {
        const whole = st.turns.shift() ?? '@listen\n';
        const first = /^(@[^\n]*\n[^.!?]*[.!?])/.exec(whole)?.[1] ?? whole;
        return void req.respond({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ soFar: first })}\n${JSON.stringify({ text: whole })}\n` });
      }
      return void req.respond(json({ text: null }));
    }
    if (url.includes('/api/call/end')) { st.ends++; return void req.continue(); }
    req.continue();
  };
  /** Counts the voice's clips that play at the same moment. */
  const VOICE_WATCH = `(() => { const v = { now: 0, max: 0, starts: 0 }; window.__voices = v; const P = HTMLMediaElement.prototype; const play = P.play;
    P.play = function () { if (!this.__watched) { this.__watched = true; let on = false;
      this.addEventListener('playing', () => { if (!on) { on = true; v.now++; v.starts++; v.max = Math.max(v.max, v.now); } });
      const off = () => { if (on) { on = false; v.now--; } };
      this.addEventListener('ended', off); this.addEventListener('pause', off); this.addEventListener('error', off); }
      return play.call(this); }; })();`;
  const voices = (p: Page) => p.evaluate(() => ({ ...(window as unknown as { __voices: { now: number; max: number; starts: number } }).__voices }));
  const callOf = (p: Page) => p.evaluate(() => {
    const c = (window as unknown as { __bogenCall: { get: () => Record<string, unknown> } }).__bogenCall.get();
    return { active: c.active as boolean, fileId: c.fileId as string | null, working: c.working as boolean, runFile: c.runFile as string | null, muted: c.muted as boolean, connecting: c.connecting as boolean, follow: c.follow as boolean, followed: c.followed as { runIn: string | null } | null };
  });
  const serverCall = async () => ((await (await fetch(`${base}/api/call/status`)).json()) as { call: { id: string } | null }).call;
  const runsIn = (p: Page, fileId: string) => p.evaluate((id) => fetch(`/api/runs?fileId=${id}`).then((r) => r.json()), fileId) as Promise<{ id: string; prompt: string; status: string }[]>;
  const mute = async (p: Page, on: boolean) => {
    if ((await callOf(p)).muted === on) return;
    const sel = (await exists(p, '[data-testid="call-panel"]')) ? '[data-testid="call-mute"]' : '[data-testid="callbar-mute"]';
    await p.click(sel);
    await until(async () => (await callOf(p)).muted === on, 3000);
  };
  /**
   * The person says `words`, and the talking layer answers with `turn`. The microphone's part goes through the call's
   * test door (the made-up microphone's beeps are too short to count as speech); from there it is the real call:
   * hearing, the brain, the talking layer, the voice.
   */
  const speak = async (p: Page, st: Stand, words: string, turn: string) => {
    st.heard.push(words);
    st.turns.push(turn);
    const spoke = await p.evaluate(() => (window as unknown as { __bogenCall: { utter: (ms?: number) => boolean } }).__bogenCall.utter(900));
    return spoke && await until(() => st.heard.length === 0, 12_000);
  };
  const typeRequest = async (p: Page, words: string) => {
    await p.$eval('[data-testid="prompt-input"]', (el, v) => {
      const area = el as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, v as string);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }, words);
    await p.focus('[data-testid="prompt-input"]');
    await p.keyboard.press('Enter');
  };
  const openWindow = async (st: Stand) => {
    const p = await freshPage(browser);
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.evaluateOnNewDocument(VOICE_WATCH);
    await p.setRequestInterception(true);
    p.on('request', talking(st));
    await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    return p;
  };
  const callIn = async (p: Page) => {
    if (!(await exists(p, '[data-testid="chat-call"]'))) await p.click('[data-testid="prompt-toggle"]');
    await p.waitForSelector('[data-testid="chat-call"]', { timeout: 10_000 });
    await p.click('[data-testid="chat-call"]');
    return until(async () => { const c = await callOf(p); return c.active && !c.connecting; }, 15_000);
  };

  const st1 = stand();
  const w1 = await openWindow(st1);
  // File B is opened first and left: it stays loaded behind A's tab, with its own session.
  await w1.goto(`${base}/#/file/${b.id}`);
  await w1.waitForSelector('[data-testid="editor"]', { timeout: 20_000 });
  await w1.evaluate((id) => { location.hash = `#/file/${id}`; }, a.id);
  await until(() => w1.evaluate((id) => document.querySelector('[data-testid="editor"]') !== null && location.hash === `#/file/${id}`, a.id));
  await wait(800);
  check('one voice: file B stays open as a tab behind A', await exists(w1, `[data-testid="filetab"][data-file="${b.id}"]`));
  check('one voice: the call starts in A', await callIn(w1));
  await w1.evaluate(() => { const c = (window as unknown as { __bogenCall: { get: () => { follow: boolean }; set: (p: unknown) => void } }).__bogenCall; if (!c.get().follow) c.set({ follow: true }); });
  check('the server knows exactly this one call', await until(async () => (await serverCall())?.id === st1.calls.at(-1)), [await serverCall(), st1.calls]);
  check('with a file loaded behind another tab, a turn is heard once', await speak(w1, st1, 'Are you with me?', "@answer\nYes, I'm with you. We're in Trauermusik Wien.") && st1.listens >= 1);
  check('and both of its sentences are said', await until(async () => { const v = await voices(w1); return v.starts >= 2 && v.now === 0; }, 12_000), await voices(w1));
  check('one after the other, never two voices at once', (await voices(w1)).max === 1, await voices(w1));

  // A run working when the call follows the editor to B.
  await typeRequest(w1, 'Shorten the footer FAKE{"tools":[{"name":"layer_tree"},{"name":"layer_tree"},{"name":"layer_tree"},{"name":"layer_tree"},{"name":"layer_tree"},{"name":"layer_tree"},{"name":"layer_tree"}],"delayMs":2200}');
  check('a request typed in the call\'s file is the call\'s run', await until(async () => (await callOf(w1)).working, 10_000));
  // Opened in silence: a call never moves in the middle of a sentence.
  await mute(w1, true);
  await w1.evaluate((id) => { location.hash = `#/file/${id}`; }, b.id);
  check('following the editor, the call moves to B while the run works in A', await until(async () => (await callOf(w1)).fileId === b.id, 15_000), await callOf(w1));
  const moved = await callOf(w1);
  check('it says the run finishes in A', moved.followed?.runIn === 'Trauermusik Wien' && moved.runFile === 'Trauermusik Wien', moved);
  const footer = async () => [...await runsIn(w1, a.id), ...await runsIn(w1, b.id)].filter((r) => r.prompt.includes('Shorten the footer'));
  check('the request runs once, in A', (await footer()).length === 1 && (await runsIn(w1, b.id)).length === 0, await footer());
  await mute(w1, false);
  const callTitle = () => text(w1, '[data-testid="call-panel"] [data-testid="call-turn"], [data-testid="callbar-title"]');
  const finishing = await until(async () => /^Finishing in Trauermusik Wien$/.test(await callTitle()), 9000);
  check('after the move it shows as finishing in A, not as an agent working in B', finishing, await callTitle());
  check('and the bar does not put A\'s step next to B\'s name', !(await exists(w1, '[data-testid="callbar-sub"]')) || !/·/.test(await text(w1, '[data-testid="callbar-sub"]')), await text(w1, '[data-testid="callbar-sub"]'));
  await shot(w1, '07-finishing-in-other-file');

  // A request said in B while A's run finishes: it waits, then runs once, in B.
  await speak(w1, st1, 'Make the title in this file bigger.', '@agent goal: Make the title bigger\nOkay, I will make the title bigger.');
  await wait(1500);
  check('a request said meanwhile does not go to A\'s run, and starts nothing yet', (await runsIn(w1, b.id)).length === 0 && (await footer()).length === 1, await runsIn(w1, b.id));
  check('once A\'s run is done, it runs in B', await until(async () => (await runsIn(w1, b.id)).length === 1, 40_000), await runsIn(w1, b.id));
  await wait(2500);
  check('exactly once: one run per request, in the file it was said in', (await runsIn(w1, b.id)).length === 1 && (await footer()).length === 1, [await runsIn(w1, b.id), await footer()]);
  check('and the call\'s run is in its own file again', await until(async () => (await callOf(w1)).runFile === null, 20_000), await callOf(w1));

  // A move by voice, while the editor stays in B.
  const before = (await runsIn(w1, a.id)).length + (await runsIn(w1, b.id)).length;
  await until(async () => !(await callOf(w1)).working, 20_000);
  check('the call moves by voice', await speak(w1, st1, 'Switch to Trauermusik Wien.', "@switch Trauermusik Wien\nWe're in Trauermusik Wien now. What should change?") && await until(async () => (await callOf(w1)).fileId === a.id, 10_000), await callOf(w1));
  await wait(2500);
  check('the open editor does not pull it back', (await callOf(w1)).fileId === a.id, await callOf(w1));
  check('a move starts no run', (await runsIn(w1, a.id)).length + (await runsIn(w1, b.id)).length === before);
  check('its two sentences are said one after the other too', await until(async () => (await voices(w1)).now === 0, 12_000) && (await voices(w1)).max === 1 && (await voices(w1)).starts >= 4, await voices(w1));

  // A second window opens a call: one call per browser, the newest.
  const st2 = stand();
  const w2 = await openWindow(st2);
  // In A: the first window shows B, and a file is open in one window at a time.
  await w2.goto(`${base}/#/file/${a.id}`);
  await w2.waitForSelector('[data-testid="editor"]', { timeout: 20_000 });
  const endsBefore = st1.ends;
  check('a call opens in a second window', await callIn(w2));
  check('the first window hands its call on', await until(async () => !(await callOf(w1)).active, 8000), await callOf(w1));
  await wait(800);
  check('without closing the server\'s call, which is the new one', st1.ends === endsBefore && (await serverCall())?.id === st2.calls.at(-1), { ends: st1.ends - endsBefore, call: await serverCall(), calls: st2.calls });
  const listened = st1.listens;
  check('only the new window hears', await speak(w2, st2, 'Can you hear me?', "@answer\nYes, I can hear you. We're in Trauermusik Wien.") && st1.listens === listened);
  check('and only one voice answers', await until(async () => (await voices(w2)).starts >= 2 && (await voices(w2)).now === 0, 12_000) && (await voices(w2)).max === 1 && (await voices(w1)).now === 0, [await voices(w2), await voices(w1)]);
  await w2.click('[data-testid="call-hangup"], [data-testid="callbar-end"]').catch(async () => w2.click('[data-testid="callbar-end"]'));
  check('ending it ends the server\'s call', await until(async () => (await serverCall()) === null, 8000), await serverCall());
  await w1.close();
  await w2.close();

  // Every state through the call's test door, with no microphone, so nothing else moves it: the card in the call's
  // file and the bar on Home, in dark and in light.
  const sw = await freshPage(browser);
  sw.on('pageerror', (e) => errors.push(String(e)));
  await sw.setRequestInterception(true);
  sw.on('request', speech);
  await sw.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await sw.goto(`${base}/#/file/${a.id}`);
  await sw.waitForSelector('[data-testid="editor"]', { timeout: 20_000 });
  if (!(await exists(sw, '[data-testid="chat-call"]'))) await sw.click('[data-testid="prompt-toggle"]');
  await sw.waitForSelector('[data-testid="chat-call"]', { timeout: 10_000 });
  const door = (patch: Record<string, unknown>) => sw.evaluate((x) => (window as unknown as { __bogenCall: { set: (p: unknown) => void } }).__bogenCall.set(x), patch);
  const said = (who: 'you' | 'agent', words: string) => ({ who, text: words, at: Date.now() });
  const STATES: { name: string; patch: Record<string, unknown>; look: string; title: RegExp }[] = [
    { name: 'connecting', patch: { connecting: true }, look: 'connecting', title: /^Connecting…$/ },
    { name: 'listening', patch: { connecting: false }, look: 'listening', title: /^Listening$/ },
    { name: 'you', patch: { turn: 'hearing', captions: [said('you', 'Make the header taller')] }, look: 'you', title: /^You are speaking$/ },
    { name: 'agent', patch: { turn: 'speaking', speaking: 'A taller header. Starting now.', captions: [said('you', 'Make the header taller'), said('agent', 'A taller header. Starting now.')] }, look: 'agent', title: /^Claude is speaking$/ },
    { name: 'working', patch: { turn: 'listening', speaking: null, working: true, activity: 'Drawing' }, look: 'working', title: /^Claude is working$/ },
    { name: 'finishing elsewhere', patch: { runFile: 'Bogen Brand System' }, look: 'working', title: /^Finishing in Bogen Brand System$/ },
    { name: 'muted', patch: { muted: true, runFile: null }, look: 'muted', title: /^Muted$/ },
    { name: 'moved', patch: { muted: false, working: false, activity: null, followed: { at: Date.now(), name: 'Trauermusik Wien', runIn: null } }, look: 'moved', title: /^Call moved$/ },
    { name: 'reconnecting', patch: { followed: null, reconnecting: true }, look: 'reconnecting', title: /^Reconnecting…$/ },
    { name: 'mic blocked', patch: { reconnecting: false, error: 'The microphone is blocked for Bogen. Allow it in the browser to talk.', errorKind: 'mic' }, look: 'error', title: /^Microphone blocked$/ },
    { name: 'other error', patch: { error: 'The voice did not load.', errorKind: 'other' }, look: 'error', title: /^That did not work$/ },
    { name: 'setup', patch: { error: null, errorKind: null, status: { ...STATUS, ready: { de: false, en: false }, listen: { ...STATUS.listen, installed: false, bytes: 640_000_000 } } }, look: 'setup', title: /^One download needed$/ },
    { name: 'back to listening', patch: { status: STATUS }, look: 'listening', title: /^Listening$/ },
  ];
  /** Words that say the call is live and hearing, which a problem state must never show. */
  const LIVE_WORDS = /Listening|You are speaking|is speaking|is working|Connecting/;
  /** Colours in the call's parts whose hue is the danger hue, outside End and errors, as "where: colour". */
  const dangerHues = () => sw.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--ui-danger)';
    document.body.appendChild(probe);
    const danger = getComputedStyle(probe).color;
    probe.remove();
    const parse = (c: string): number[] | null => {
      let m = /rgba?\(([^)]+)\)/.exec(c);
      if (m) { const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0]! / 255, p[1]! / 255, p[2]! / 255, p[3] ?? 1]; }
      m = /color\(srgb ([^)]+)\)/.exec(c);
      if (m) { const p = m[1]!.split(/[\s/]+/).filter(Boolean).map(Number); return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]; }
      return null;
    };
    const hsl = (c: number[]) => {
      const [r, g, b] = c as [number, number, number];
      const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
      if (d < 1e-6) return { h: 0, s: 0 };
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
      return { h, s: d / (1 - Math.abs(2 * l - 1)) };
    };
    const D = hsl(parse(danger)!);
    const near = (c: string) => {
      const v = parse(c);
      if (!v || v[3]! < 0.2) return false;
      const x = hsl(v);
      const dh = Math.min(Math.abs(x.h - D.h), 360 - Math.abs(x.h - D.h));
      return x.s >= 0.3 && dh < 20;
    };
    const bad: string[] = [];
    for (const root of document.querySelectorAll('[data-testid="call-panel"], [data-testid="calldock"], [data-mark="call"], [data-testid="chat-call-live"]')) {
      for (const el of [root, ...root.querySelectorAll('*')]) {
        if (el.closest('.call-end, [role="alert"], .call-orb.is-error')) continue;
        for (const pseudo of [null, '::before', '::after']) {
          const cs = getComputedStyle(el, pseudo);
          if (pseudo && (cs.content === 'none' || cs.content === 'normal')) continue;
          const own = !pseudo && (el instanceof SVGElement || [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()));
          const values = [own ? cs.color : '', cs.backgroundColor, parseFloat(cs.borderTopWidth) > 0 ? cs.borderTopColor : '', ...(cs.boxShadow.match(/rgba?\([^)]+\)|color\(srgb [^)]+\)/g) ?? [])];
          for (const v of values) if (v && near(v)) bad.push(`${el.getAttribute('data-testid') ?? el.className.toString()}${pseudo ?? ''}: ${v}`);
        }
      }
    }
    return bad;
  });
  const KEEP: Record<'panel' | 'bar', string[]> = { panel: ['call-mute', 'call-more', 'call-hangup'], bar: ['callbar-mute', 'callbar-more', 'callbar-end'] };
  const keep = (where: 'panel' | 'bar') => sw.evaluate((ids) => { for (const id of ids) (document.querySelector(`[data-testid="${id}"]`) as unknown as { __kept?: boolean } | null)!.__kept = true; }, KEEP[where]);
  const kept = (where: 'panel' | 'bar') => sw.evaluate((ids) => ids.filter((id) => !(document.querySelector(`[data-testid="${id}"]`) as unknown as { __kept?: boolean } | null)?.__kept), KEEP[where]);
  for (const mode of ['dark', 'light'] as const) {
    await sw.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    for (const where of ['panel', 'bar'] as const) {
      await sw.evaluate((h) => { location.hash = h; }, where === 'panel' ? `#/file/${a.id}` : '#/');
      await door({ active: true, fileId: a.id, fileName: 'Trauermusik Wien', startedAt: Date.now() - 65_000, status: STATUS, language: 'en', connecting: false, turn: 'listening', captions: [], muted: false, error: null, errorKind: null, speaking: null, working: false, activity: null, followed: null, reconnecting: false, ended: null });
      const box = where === 'panel' ? '[data-testid="call-panel"]' : '[data-testid="callbar"]';
      const titleSel = where === 'panel' ? '[data-testid="call-turn"]' : '[data-testid="callbar-title"]';
      if (!(await until(() => exists(sw, box), 15_000))) { check(`${mode} ${where}: shows`, false); continue; }
      await wait(400);
      await keep(where);
      const wrong: string[] = [], gone: string[] = [], hues: string[] = [], found: string[] = [];
      for (const st of STATES) {
        await door(st.patch);
        await wait(120);
        const look = await attr(sw, box, 'data-look');
        const title = await text(sw, titleSel);
        const whole = await text(sw, box);
        const clock = await sw.$eval(`${box} [data-testid="call-clock"]`, (e) => getComputedStyle(e).visibility !== 'hidden' && (e.textContent ?? '') !== '').catch(() => false);
        const problem = st.look === 'error' || st.look === 'setup';
        // The clock shows while the call is connected and live: not before it connects, not during a problem.
        const clockDue = !problem && st.look !== 'connecting';
        if (look !== st.look || !st.title.test(title) || (problem && LIVE_WORDS.test(whole)) || clock !== clockDue) wrong.push(`${st.name}: look ${look}, "${title}", clock ${clock}${problem && LIVE_WORDS.test(whole) ? `, live words in "${whole.replace(/\s+/g, ' ')}"` : ''}`);
        gone.push(...(await kept(where)).map((id) => `${st.name}: ${id}`));
        hues.push(...(await dangerHues()).map((x) => `${st.name}: ${x}`));
        const v = await axeOn(sw, where === 'panel' ? box : '[data-testid="calldock"]');
        found.push(...v.map((x) => `${st.name}: ${x}`));
      }
      check(`${mode} ${where}: no title or word contradicts the state`, !wrong.length, wrong);
      check(`${mode} ${where}: Mute, More and End are the same elements in every state`, !gone.length, gone);
      check(`${mode} ${where}: nothing but End and errors takes the danger hue`, !hues.length, hues.slice(0, 8));
      check(`${mode} ${where}: axe finds nothing in any state`, !found.length, found.slice(0, 8));
    }
  }
  await door({ active: false });
  await sw.close();

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
