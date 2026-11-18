/**
 * Live updates: Home and the editor keep up with what agents do, through the real editor and real servers in
 * temporary BOGEN_HOMEs, in secure-chromium with its sandbox on. The agents are stand-ins; nothing leaves the machine.
 *
 * - The bug behind "Home no longer updates" and "I cannot follow the agent": `bogen mcp` in a sandbox with a network
 *   of its own (bubblewrap here, as an agent's sandbox) could not reach the server and started a second one on the
 *   same data folder. The agent's edits went there, out of sight of the person's editor, and the two servers lost
 *   each other's edits. Now it starts none and says why, and `bogen serve` refuses a folder another server serves;
 * - Home: an agent's edit moves its card first, says "Just now" and brings a new thumbnail, also after visiting a
 *   file and coming back with tabs open; the times move on with the clock; events missed while the events socket was
 *   down are read anew when it is back;
 * - the editor follows an agent at work: its avatar, its outlines, its layers as they come, view_focus, the
 *   recent-changes strip, the working mark on a tab that is not in view, and another person in the toolbar;
 * - Home's names carry no tooltip that only repeats them; a cut-off name shows in full on hover.
 *
 *   (cd apps/editor && npx vite build)
 *   node --import tsx apps/editor/test/e2e/live-follow.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Page } from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { fake, writeFakeClis } from '../../../../packages/server/test/fake-cli.ts';
import { freshPage, launch, startRealServer } from './craft-harness.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const root = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-live-follow-'));
const shots = process.env.BOGEN_SHOTS ?? join(root, 'shots');
const bin = join(root, 'bin');
for (const d of [shots, bin]) mkdirSync(d, { recursive: true });
writeFakeClis(bin, join(root, 'cli.log'));
process.env.PATH = `${bin}:${process.env.PATH}`;

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`pass  ${name}`); } else { failures.push(name); console.log(`FAIL  ${name}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* between states */ }
    await wait(80);
  }
  return false;
}
const exists = (page: Page, sel: string) => page.$(sel).then(Boolean);
const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) });

async function mcpClient(base: string, name: string): Promise<{ call: (tool: string, args: object) => Promise<any>; close: () => Promise<void> }> {
  const client = new Client({ name, version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return {
    call: async (tool, args) => {
      const r = await client.callTool({ name: tool, arguments: args as Record<string, unknown> });
      const text = (r.content as { text: string }[])[0]!.text;
      if (r.isError) throw new Error(text);
      try { return JSON.parse(text); } catch { return text; }
    },
    close: () => client.close(),
  };
}

/** The first page and a board on it, made by an agent so that the file has real content. */
async function seed(agent: Awaited<ReturnType<typeof mcpClient>>, name: string, far = false): Promise<{ id: string; page: string; near: string; far?: string }> {
  const file = await agent.call('file_create', { name });
  const opened = await agent.call('file_open', { file_id: file.id });
  const page = opened.pages[0].id as string;
  const near = await agent.call('artboard_create', { file_id: file.id, name: 'Near', width: 600, height: 400, x: 0, y: 0 });
  const out: { id: string; page: string; near: string; far?: string } = { id: file.id, page, near: near.id };
  if (far) out.far = (await agent.call('artboard_create', { file_id: file.id, name: 'Far corner', width: 400, height: 300, x: 9000, y: 7000 })).id;
  return out;
}

try {
  // ------------------------------------------------------------ one data folder, one server
  {
    const real = await startRealServer({ env: { PATH: process.env.PATH! } });
    const agent = await mcpClient(real.base, 'seed');
    const file = await seed(agent, 'Sandboxed edits');
    await agent.call('html_write', { file_id: file.id, html: '<p style="font-size:20px">Before</p>', mode: 'into', target_id: file.near });
    await agent.close();
    const page = await freshPage(await launch(real.port));
    // The person has the file open.
    await page.goto(`${real.base}/#/file/${file.id}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 30_000 });
    const onCanvas = (text: string) => page.evaluate((t) => (document.querySelector('.bogen-world')?.textContent ?? '').includes(t), text);

    const bwrap = spawnSync('bwrap', ['--version']).status === 0;
    check('bubblewrap is here to stand in for an agent sandbox', bwrap);
    if (bwrap) {
      // `bogen mcp` as an agent in a sandbox starts it: its own network and pids, the person's data folder.
      const sandbox = ['--unshare-net', '--unshare-pid', '--die-with-parent', '--dev-bind', '/', '/', '--proc', '/proc'];
      const mcp = spawn('bwrap', [...sandbox, process.execPath, '--import', 'tsx', 'packages/server/src/cli.ts', 'mcp'], {
        cwd: ROOT, env: { ...process.env, BOGEN_HOME: real.home, BOGEN_PORT: String(real.port) }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      mcp.stdout.on('data', (d: Buffer) => { out += d; });
      mcp.stderr.on('data', (d: Buffer) => { err += d; });
      const send = (o: object) => { try { mcp.stdin.write(`${JSON.stringify(o)}\n`); } catch { /* it ended */ } };
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sandboxed', version: '1' } } });
      await until(() => out.includes('"id":1') || mcp.exitCode !== null, 30_000);
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'html_write', arguments: { file_id: file.id, html: '<p>Written from the sandbox</p>', mode: 'into', target_id: file.near } } });
      await until(() => out.includes('"id":2') || mcp.exitCode !== null, 20_000);
      const wrote = /"id":2/.test(out) && !/"isError":true/.test(out.slice(out.indexOf('"id":2')));
      const log = existsSync(join(real.home, 'server.log')) ? readFileSync(join(real.home, 'server.log'), 'utf8') : '';
      check('a sandboxed bogen mcp starts no second server on the data folder', !/started by pid/.test(log), log.slice(-400));
      check('it tells the agent why, and that nothing was started', /cannot reach it/.test(err) && /No second server was started/.test(err), err.slice(-400));
      // An edit that did land (the old way) must have reached the person; it never did, which was the bug.
      const shown = wrote && await until(() => onCanvas('Written from the sandbox'), 5000);
      check('every edit an agent was told it made reaches the person watching', !wrote || shown, { wrote, shown });
      mcp.kill('SIGKILL');
    }

    // The same folder cannot be served twice, whoever asks.
    const second = spawnSync(process.execPath, ['--import', 'tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(real.port + 1)], {
      cwd: ROOT, env: { ...process.env, BOGEN_HOME: real.home }, encoding: 'utf8', timeout: 25_000,
    });
    check('bogen serve refuses a folder another server serves', second.status !== 0 && /already serves/.test(second.stderr), { status: second.status, signal: second.signal, stderr: second.stderr?.slice(-300) });
    await page.browser().close();
    await real.close();
  }

  // ------------------------------------------------------------ Home keeps up
  const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: true, thumbnailDelayMs: 300, thumbnailStartupMs: 0 });
  await server.listen();
  const base = server.localUrl();
  const sbrowser = await launch(Number(new URL(base).port));
  const agent = await mcpClient(base, 'drawer');
  const files = [];
  for (const name of ['Opening hours', 'Price list', 'Studio site', 'Menu card']) files.push(await seed(agent, name, true));
  // Older times, so that an edit visibly moves a card.
  files.forEach((f, i) => server.storage.update(f.id, { updatedAt: Date.now() - (i + 2) * 3_600_000 }));
  const [a, b, c, d] = files as [typeof files[0], typeof files[0], typeof files[0], typeof files[0]];
  const longName = 'A file with a name far too long to fit on its card in the grid of Home, so it is cut off';
  server.storage.update(d.id, { name: longName });

  const page = await freshPage(sbrowser);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // The events socket, so that the test can drop what it says, as a restart of the server does.
  await page.evaluateOnNewDocument(() => {
    const Native = window.WebSocket;
    const sockets: WebSocket[] = [];
    (window as unknown as { __eventSockets: WebSocket[] }).__eventSockets = sockets;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).endsWith('/events')) sockets.push(this);
      }
    } as typeof WebSocket;
  });
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${base}/#/`);
  await page.waitForSelector('[data-testid="file"]', { timeout: 30_000 });
  await wait(800);

  const first = (p: Page) => p.$eval('[data-testid="file"]', (e) => e.getAttribute('data-file-id')).catch(() => null);
  const timeOf = (p: Page, id: string) => p.$eval(`[data-testid="file"][data-file-id="${id}"] .file-time`, (e) => (e as HTMLElement).innerText).catch(() => '');
  const thumbOf = (p: Page, id: string) => p.$eval(`[data-testid="file"][data-file-id="${id}"] img`, (e) => (e as HTMLImageElement).getAttribute('src')).catch(() => null);
  async function editAndSee(label: string, f: typeof a, text: string) {
    const thumb = await thumbOf(page, f.id);
    await agent.call('html_write', { file_id: f.id, html: `<h2 style="font-size:40px;color:#b5562f">${text}</h2>`, mode: 'into', target_id: f.near });
    check(`${label}: the card comes first`, await until(async () => (await first(page)) === f.id, 8000), await first(page));
    check(`${label}: it says Just now`, await until(async () => /Just now/.test(await timeOf(page, f.id)), 4000), await timeOf(page, f.id));
    check(`${label}: its thumbnail is new`, await until(async () => { const now = await thumbOf(page, f.id); return Boolean(now) && now !== thumb; }, 20_000), { thumb, now: await thumbOf(page, f.id) });
  }
  await editAndSee('Home, fresh', b, 'Open late on Fridays');

  // A file visited as a tab, and back to Home.
  await page.evaluate((id) => { location.hash = `#/file/${id}`; }, c.id);
  await page.waitForSelector('[data-testid="canvas"]', { timeout: 30_000 });
  await wait(800);
  await page.click('[data-testid="filetab-home"]');
  await page.waitForSelector('[data-testid="file"]', { timeout: 20_000 });
  await editAndSee('Home after a tab, another file', a, 'Prices from May');
  await editAndSee('Home after a tab, the file of the tab', c, 'New studio photos');

  // The events socket goes quiet, as when the server restarts: nothing it says reaches Home for a while.
  await page.evaluate(() => {
    const ws = (window as unknown as { __eventSockets: WebSocket[] }).__eventSockets.at(-1)!;
    ws.onmessage = null;
  });
  // The time keeps up with the clock, with no event to re-render it.
  await page.evaluate(() => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + 7 * 60_000;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  check('the edited time moves on with the clock', await until(async () => /7 min ago/.test(await timeOf(page, c.id)), 4000), await timeOf(page, c.id));

  // Events lost while the socket was down are read anew when it is back.
  await agent.call('html_write', { file_id: d.id, html: '<p>Edited while the socket was down</p>', mode: 'into', target_id: d.near });
  await wait(2500);
  const missed = await first(page);
  await page.evaluate(() => (window as unknown as { __eventSockets: WebSocket[] }).__eventSockets.at(-1)!.close());
  check('an edit missed while the events socket was down shows once it is back', await until(async () => (await first(page)) === d.id, 8000), { missed, now: await first(page) });

  // Tooltips: a name that shows in full has none; a cut-off one shows in full on hover.
  const repeats = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.home-files [title], .home-recent [title]')]
    .filter((e) => (e.getAttribute('title') ?? '').trim() === e.innerText.trim()).map((e) => e.className));
  check('no Home tooltip only repeats what is written', repeats.length === 0, repeats);
  const hover = async (sel: string) => {
    await page.mouse.move(5, 5);
    await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' }));
    await wait(300);
    const box = (await (await page.$(sel))!.boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(box.x + 8, box.y + box.height / 2, { steps: 2 });
    await wait(800);
    return page.$eval('[data-testid="tooltip"]', (e) => (e as HTMLElement).innerText).catch(() => null);
  };
  check('a name that fits shows no tooltip', (await hover(`[data-testid="file"][data-file-id="${b.id}"] .file-title`)) === null);
  const cutTip = await hover(`[data-testid="file"][data-file-id="${d.id}"] .file-title`);
  check('a cut-off name shows in full on hover', cutTip === longName, cutTip);
  await page.mouse.move(5, 5);
  await shot(page, 'home');

  // ------------------------------------------------------------ following the agent in the editor
  await page.evaluate(() => { location.reload(); });
  await page.waitForSelector('[data-testid="file"]', { timeout: 20_000 });
  await page.evaluate((id) => { location.hash = `#/file/${id}`; }, b.id);
  await page.waitForSelector('[data-testid="canvas"]', { timeout: 30_000 });
  await page.evaluate((id) => { location.hash = `#/file/${id}`; }, a.id);
  await page.waitForSelector('[data-testid="canvas"]', { timeout: 30_000 });
  await until(() => page.evaluate((id) => location.hash === `#/file/${id}` && !document.querySelector('[data-testid="loading"]'), a.id), 20_000);
  await wait(1200);
  const visible = (id: string) => page.evaluate((nid) => {
    const el = document.querySelector(`[data-bogen-id="${nid}"]`);
    const stage = document.querySelector('[data-testid="canvas"]');
    if (!el || !stage) return false;
    const r = el.getBoundingClientRect();
    const v = stage.getBoundingClientRect();
    return r.width > 0 && r.right > v.left && r.left < v.right && r.bottom > v.top && r.top < v.bottom;
  }, id);
  const latest = () => page.$eval('[data-testid="recent-latest"]', (e) => (e as HTMLElement).innerText).catch(() => '');
  const latestBefore = await latest();

  const plan = { delayMs: 900, tools: [
    { name: 'html_write', args: { file_id: a.id, html: '<h3 style="font-size:32px">Followed one</h3>', mode: 'into', target_id: a.far } },
    { name: 'view_focus', args: { file_id: a.id, node_ids: [a.far], note: 'The far corner' } },
    { name: 'html_write', args: { file_id: a.id, html: '<h3 style="font-size:32px">Followed two</h3>', mode: 'into', target_id: a.far } },
    { name: 'html_write', args: { file_id: a.id, html: '<h3 style="font-size:32px">Followed three</h3>', mode: 'into', target_id: a.far } },
  ] };
  const run = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileId: a.id, nodeIds: [], prompt: `Fill the far corner ${fake(plan)}`, runner: 'claude' }) });
  check('the stand-in agent starts', run.ok, await run.clone().text());
  const seen = { avatar: false, outline: false, live: false, toast: '' };
  const end = Date.now() + 15_000;
  while (Date.now() < end && !(seen.avatar && seen.outline && seen.live && seen.toast)) {
    const s = await page.evaluate(() => ({
      avatar: [...document.querySelectorAll('[data-testid="peer"]')].some((e) => /claude/i.test(e.getAttribute('title') ?? '')),
      outline: Boolean(document.querySelector('[data-testid="agent-outline"]')),
      live: (document.querySelector('.bogen-world')?.textContent ?? '').includes('Followed one'),
      toast: document.querySelector('[data-testid="toast"]')?.textContent ?? '',
    }));
    seen.avatar ||= s.avatar; seen.outline ||= s.outline; seen.live ||= s.live; if (s.toast) seen.toast = s.toast;
    await wait(80);
  }
  check('the agent shows in the toolbar while it works', seen.avatar);
  check('its outlines show where it works', seen.outline);
  check('its layers appear as it makes them', seen.live);
  check('view_focus says what it shows', /The far corner/.test(seen.toast), seen.toast);
  check('and brings it into view', await until(() => visible(a.far!), 4000));
  check('every step lands, live', await until(() => page.evaluate(() => (document.querySelector('.bogen-world')?.textContent ?? '').includes('Followed three')), 15_000));
  check('the recent-changes strip names the latest change', await until(async () => (await latest()) !== latestBefore && /Far corner/.test(await latest()), 8000), { latestBefore, now: await latest() });
  await shot(page, 'following');

  // An agent in a file whose tab is not in view: its tab says so.
  const plan2 = { delayMs: 700, tools: [1, 2, 3, 4].map((n) => ({ name: 'html_write', args: { file_id: b.id, html: `<p>Background ${n}</p>`, mode: 'into', target_id: b.near } })) };
  await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileId: b.id, nodeIds: [], prompt: `Fill it ${fake(plan2)}`, runner: 'codex' }) });
  check('a tab not in view shows its agent at work', await until(() => exists(page, `[data-testid="filetab"][data-file="${b.id}"] [data-mark="working"]`), 8000));

  // Another person opens the file: they show here. Another person is another browser profile (a second window of this
  // one would be told the file is open in another window).
  const otherProfile = await sbrowser.createBrowserContext();
  const other = await otherProfile.newPage();
  await other.evaluateOnNewDocument('window.__name = (f) => f');
  const peersBefore = await page.$$eval('[data-testid="peer"]', (els) => els.length);
  await other.goto(`${base}/#/file/${a.id}`);
  await other.waitForSelector('[data-testid="canvas"]', { timeout: 30_000 });
  check('another person in the file shows in the toolbar', await until(async () => (await page.$$eval('[data-testid="peer"]', (els) => els.filter((e) => !/claude|codex/i.test(e.getAttribute('title') ?? '')).length)) > 0, 8000), { peersBefore });
  await other.close();
  await otherProfile.close();

  check('no page errors', errors.length === 0, errors);
  await agent.close();
  await sbrowser.close();
  await server.close();
} catch (e) {
  failures.push(String((e as Error).stack ?? e));
  console.log('FAIL ', e);
}

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `:\n  ${failures.join('\n  ')}` : ''}\nshots: ${shots}`);
process.exit(failures.length ? 1 : 0);
