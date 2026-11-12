/**
 * Getting work in and out, through the real UI: real mouse and keyboard, a real server from source.
 * Run: npx tsx apps/editor/test/e2e/transfer.ts <built editor folder> [screenshot folder]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import puppeteer, { type Page } from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '../../../..');
const editorDir = resolve(process.argv[2] ?? resolve(ROOT, 'apps/editor/dist'));
const SHOTS = resolve(process.argv[3] ?? mkdtempSync(join(tmpdir(), 'bogen-e2e-shots-')));
mkdirSync(SHOTS, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'bogen-e2e-'));
const downloads = mkdtempSync(join(tmpdir(), 'bogen-e2e-dl-'));
const PORT = 28000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ok = 0;
let bad = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (pass) ok++; else bad++;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${!pass && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};

const FIXTURE = readFileSync(resolve(ROOT, 'packages/server/test/fixtures/figma/file.json'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
const figmaApi = createServer((req, res) => {
  const url = req.url ?? '';
  const port = (figmaApi.address() as AddressInfo).port;
  if (url.startsWith('/download/')) return void res.writeHead(200, { 'Content-Type': url.endsWith('.svg') ? 'image/svg+xml' : 'image/png' }).end(url.endsWith('.svg') ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M0 0L40 0L40 40Z" fill="white"/></svg>' : PNG);
  if (req.headers['x-figma-token'] !== 'e2e-token') return void res.writeHead(403).end('{}');
  if (url.includes('/images') && url.startsWith('/v1/files')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ meta: { images: { 'img-photo-ref': `http://127.0.0.1:${port}/download/p.png` } } }));
  if (url.startsWith('/v1/files')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(FIXTURE);
  if (url.startsWith('/v1/images')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ images: { '1:7': `http://127.0.0.1:${port}/download/i.svg` } }));
  res.writeHead(404).end('{}');
});

const json = async (path: string, init?: RequestInit) => (await (await fetch(`${base}${path}`, init)).json()) as any;
const post = (path: string, body: unknown) => json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function testid(page: Page, id: string) {
  return (await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 8000 }))!;
}
const click = async (page: Page, id: string) => (await testid(page, id)).click();
const count = (page: Page, id: string) => page.$$eval(`[data-testid="${id}"]`, (els) => els.length);
const until = async (fn: () => Promise<boolean> | boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(40);
  }
  return false;
};
const text = (page: Page, id: string) => page.$eval(`[data-testid="${id}"]`, (el) => el.textContent ?? '');

/** Clicks an action button on a row, which shows on hover. */
async function rowAction(page: Page, rowSelector: string, action: string) {
  const row = await page.waitForSelector(rowSelector, { timeout: 8000 });
  await row!.hover();
  const button = await row!.$(`[data-testid="${action}"]`);
  await button!.click();
}

async function main(): Promise<void> {
  await new Promise<void>((r) => figmaApi.listen(0, '127.0.0.1', r));
  const server = spawn('npx', ['tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BOGEN_HOME: home, BOGEN_WELCOME: '0', BOGEN_EDITOR_DIR: editorDir, BOGEN_FIGMA_API: `http://127.0.0.1:${(figmaApi.address() as AddressInfo).port}`, BOGEN_EXPORT_DIR: downloads },
  });
  server.stderr!.on('data', (d: Buffer) => { const t = String(d); if (!/ExperimentalWarning|trace-warnings/.test(t)) console.log(`[server] ${t.trim()}`); });
  try {
    await until(async () => (await fetch(`${base}/api/status`).catch(() => null))?.ok ?? false, 20000);
    const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--window-size=1500,960', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], defaultViewport: { width: 1500, height: 960 } });
    try {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument('window.__name = (f) => f');
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push((e as Error).message));
      const cdp = await page.createCDPSession();
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

      // Home: .bogen in and out.
      const made = await post('/api/files', { name: 'Round trip' });
      const agent = new Client({ name: 'claude', version: '1.0.0' });
      await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { 'X-Bogen-Agent': 'claude', 'X-Bogen-File': made.id } } }));
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const out = await agent.callTool({ name, arguments: args });
        const body = (out.content as { text?: string }[])[0]?.text ?? '';
        if (out.isError) throw new Error(`${name}: ${body}`);
        try { return JSON.parse(body); } catch { return body; }
      };
      const board = await call('artboard_create', { name: 'Board', width: 700, height: 500, background: '#f7f7f2' });
      await call('html_write', { target_id: board.id, html: '<h1 data-name="Title" style="position:absolute;left:40px;top:40px;font-size:48px;color:#111111;margin:0">Hello</h1><div data-name="Box" style="position:absolute;left:40px;top:140px;width:200px;height:120px;background-color:#3366ff"></div><div data-name="Grid" style="position:absolute;left:40px;top:300px;display:flex;gap:8px"><p data-name="Item {{name}}" style="padding:6px;background-color:{{color}}">{{name}}</p></div>' });
      await sleep(300);

      await page.goto(`${base}/#/`);
      await testid(page, 'home');
      const fileRow = await page.waitForSelector(`[data-file-id="${made.id}"]`);
      await fileRow!.hover();
      await (await fileRow!.$('[data-testid="file-menu"]'))!.click();
      await click(page, 'file-action-download');
      check('Download on the file menu saves a .bogen', await until(() => readdirSync(downloads).some((f) => f.endsWith('.bogen') && !f.endsWith('.crdownload'))));
      const bogenName = readdirSync(downloads).find((f) => f.endsWith('.bogen'))!;
      await page.screenshot({ path: join(SHOTS, 'home.png') as `${string}.png` });

      const input = await testid(page, 'home-open-input');
      await (input as never as { uploadFile: (p: string) => Promise<void> }).uploadFile(join(downloads, bogenName));
      check('Open imports a .bogen and opens it', await until(async () => /#\/file\//.test(page.url()) && !page.url().includes(made.id)));
      await testid(page, 'canvas');
      const before = (await json('/api/files')).length;
      await page.goto(`${base}/#/`);
      await testid(page, 'home');
      // A real browser-level drop of a file from outside.
      const drop = await page.$eval('[data-testid="home-drop"]', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + 100, y: r.top + 100 }; });
      const data = { items: [], files: [join(downloads, bogenName)], dragOperationsMask: 1 };
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: drop.x, y: drop.y, data });
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: drop.x, y: drop.y, data });
      await sleep(100);
      check('dragging a file over the home screen shows where it goes', (await count(page, 'home-drop-hint')) === 1);
      await page.screenshot({ path: join(SHOTS, 'home-drop.png') as `${string}.png` });
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: drop.x, y: drop.y, data });
      check('dropping a .bogen on the home screen imports it', await until(async () => (await json('/api/files')).length === before + 1));
      await until(() => /#\/file\//.test(page.url()));

      // Figma dialog against the stand-in.
      await page.goto(`${base}/#/`);
      await testid(page, 'home');
      await click(page, 'home-figma');
      await testid(page, 'figma-dialog');
      await page.screenshot({ path: join(SHOTS, 'figma-dialog.png') as `${string}.png` });
      await click(page, 'figma-url');
      await page.keyboard.type('https://www.figma.com/design/FIXTUREKEY123/My-File');
      await click(page, 'figma-token');
      await page.keyboard.type('wrong');
      await click(page, 'figma-run');
      check('a wrong Figma token says so in the dialog', await until(async () => (await count(page, 'figma-error')) === 1 && (await text(page, 'figma-error')).includes('refused')));
      await click(page, 'figma-token');
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
      await page.keyboard.type('e2e-token');
      await click(page, 'figma-save');
      await click(page, 'figma-run');
      await testid(page, 'figma-report');
      check('the Figma report lists what came over', (await text(page, 'figma-report')).includes('Not exact'));
      await page.screenshot({ path: join(SHOTS, 'figma-report.png') as `${string}.png` });
      const mode = statSync(join(home, 'config.json')).mode & 0o777;
      check('a remembered token lands in config.json at mode 600', mode === 0o600 && JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).figmaToken === 'e2e-token', mode.toString(8));
      await click(page, 'figma-open');
      await testid(page, 'canvas');
      await sleep(600);
      await page.screenshot({ path: join(SHOTS, 'figma-imported.png') as `${string}.png` });

      // The file, with a person and an agent.
      await page.goto(`${base}/#/file/${made.id}`);
      await testid(page, 'canvas');
      await sleep(500);
      const doc = await json(`/api/files/${made.id}/folder`);
      const idOf = (name: string) => doc.content.nodes.find((n: { name: string }) => n.name === name).id as string;
      const boxId = idOf('Box');
      const titleId = idOf('Title');
      const templateId = doc.content.nodes.find((n: { name: string }) => n.name.startsWith('Item')).id as string;

      await click(page, 'toolbar-history');
      await testid(page, 'history-panel');
      check('the active tab scrolls into view', await page.$eval('[data-testid="tab-history"]', (el) => { const r = el.getBoundingClientRect(); return r.right <= window.innerWidth + 1; }));
      await sleep(300);
      check('the timeline already shows what the agent did', (await count(page, 'history-change')) >= 2);

      // Ctrl+Alt+S focuses the message; Enter commits.
      await page.mouse.click(760, 520);
      await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.press('s'); await page.keyboard.up('Alt'); await page.keyboard.up('Control');
      await sleep(100);
      check('Ctrl+Alt+S puts the cursor in the commit message', await page.$eval('[data-testid="history-message"]', (el) => el === document.activeElement));
      await page.keyboard.type('First look');
      await page.keyboard.press('Enter');
      check('the person\'s commit shows in the list', await until(async () => (await page.$$eval('[data-testid="history-commit-row"]', (els) => els.map((e) => e.textContent ?? ''))).some((t) => t.includes('First look') && t.includes('Commit'))));
      const firstCommit = await page.$eval('[data-testid="history-commit-row"]', (el) => el.getAttribute('data-commit-id')!);

      // Three changes: agent, agent, agent. Then the middle one goes.
      await call('layer_style', { node_ids: [boxId], style: { backgroundColor: '#ff0000' } });
      await sleep(50);
      await call('layer_style', { node_ids: [boxId], style: { borderRadius: '30px' } });
      const middle = (await json(`/api/files/${made.id}/timeline?limit=1`))[0];
      await call('layer_text', { node_id: titleId, text: 'Changed title' });
      await until(async () => (await page.$(`[data-change-id="${middle.id}"]`)) !== null);
      await page.screenshot({ path: join(SHOTS, 'history-list.png') as `${string}.png` });
      await rowAction(page, `[data-change-id="${middle.id}"]`, 'history-revert');
      await testid(page, 'history-notice');
      check('revert says it worked', (await text(page, 'history-notice')).includes('Reverted'));
      const live = async () => (await json(`/api/files/${made.id}/folder`)).content.nodes as { id: string; text?: string; style: Record<string, string> }[];
      const boxNow = async () => (await live()).find((n) => n.id === boxId)!.style;
      check('the middle change is gone, what came after it stays', await until(async () => (await boxNow()).borderRadius === undefined) && (await boxNow()).backgroundColor === '#ff0000' && (await live()).find((n) => n.id === titleId)!.text === 'Changed title');
      await page.mouse.click(760, 520);
      await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
      check('Ctrl+Z takes a revert back', await until(async () => (await boxNow()).borderRadius === '30px'));
      await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
      await until(async () => (await boxNow()).borderRadius === undefined);

      // A conflict.
      await call('layer_style', { node_ids: [boxId], style: { opacity: '0.9' } });
      const change = (await json(`/api/files/${made.id}/timeline?limit=1`))[0];
      await call('layer_style', { node_ids: [boxId], style: { opacity: '0.5' } });
      await until(async () => (await page.$(`[data-change-id="${change.id}"]`)) !== null);
      await rowAction(page, `[data-change-id="${change.id}"]`, 'history-revert');
      await until(async () => (await count(page, 'history-conflict')) === 1);
      const conflict = await text(page, 'history-conflict');
      check('a conflict is shown plainly, and the later edit stays', conflict.includes('style.opacity') && conflict.includes('changed again') && (await boxNow()).opacity === '0.5', conflict);
      await page.screenshot({ path: join(SHOTS, 'history-conflict.png') as `${string}.png` });

      // Preview, compare, restore.
      await rowAction(page, `[data-commit-id="${firstCommit}"]`, 'history-preview');
      await testid(page, 'history-stage');
      await sleep(300);
      const previewed = await page.$eval('[data-testid="history-preview-canvas"]', (el) => el.textContent ?? '');
      check('preview shows the old version on the canvas', previewed.includes('Hello') && !previewed.includes('Changed title'));
      await page.screenshot({ path: join(SHOTS, 'history-preview.png') as `${string}.png` });
      await click(page, 'history-preview-exit');
      check('leaving the preview changes nothing', (await live()).find((n) => n.id === titleId)!.text === 'Changed title');

      await rowAction(page, `[data-commit-id="${firstCommit}"]`, 'history-compare');
      await testid(page, 'history-diff');
      const diffText = await text(page, 'history-diff');
      check('the diff names the layers and properties', diffText.includes('Box') && diffText.includes('style.backgroundColor') && diffText.includes('Title') && diffText.includes('text'), diffText);
      await click(page, 'history-diff-page');
      check('side by side shows before, after and difference', await until(async () => (await count(page, 'history-side-image')) === 3), await count(page, 'history-side-image'));
      await sleep(200);
      await page.screenshot({ path: join(SHOTS, 'history-compare.png') as `${string}.png` });
      await click(page, 'history-preview-exit');

      await rowAction(page, `[data-commit-id="${firstCommit}"]`, 'history-restore');
      check('restore brings the commit back', await until(async () => (await live()).find((n) => n.id === titleId)!.text === 'Hello' && (await boxNow()).backgroundColor === '#3366ff'));
      const commits = await json(`/api/files/${made.id}/commits`);
      check('restore committed what it replaced first', commits.some((c: { kind: string; message?: string }) => c.kind === 'restore' && c.message?.includes('First look')));
      await page.mouse.click(760, 520);
      await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
      check('restore is one Ctrl+Z', await until(async () => (await live()).find((n) => n.id === titleId)!.text === 'Changed title' && (await boxNow()).backgroundColor === '#ff0000'));

      // A branch: inside this file, never a file of its own.
      const filesBefore = (await json('/api/files')).length;
      await click(page, 'history-branches-toggle');
      await click(page, 'history-branch-name');
      await page.keyboard.type('Try it');
      await click(page, 'history-branch-create');
      check('a branch is made inside the file and checked out', await until(async () => {
        const summary = await json(`/api/files/${made.id}/design-branches`);
        return summary.current !== 'main' && summary.branches.some((b: { name: string }) => b.name === 'Try it');
      }));
      await page.screenshot({ path: join(SHOTS, 'history-branch.png') as `${string}.png` });
      check('the branch is no file of its own', (await json('/api/files')).length === filesBefore);
      check('the branch menu shows it', await until(async () => (await page.$eval('[data-testid="branch-menu"]', (el) => el.getAttribute('data-branch')).catch(() => 'main')) !== 'main'));
      // Discarding is the person's decision, with a confirmation, in the branch menu.
      await click(page, 'branch-menu');
      await rowAction(page, '[data-testid="branch-row"][data-branch-id]:not([data-branch-id="main"])', 'branch-discard');
      await click(page, 'branch-discard-yes');
      check('a discarded branch leaves main checked out', await until(async () => (await json(`/api/files/${made.id}/design-branches`)).current === 'main'));
      await page.keyboard.press('Escape');

      // Live data from the inspector.
      await click(page, 'tab-design');
      // The layer inside the flex frame, picked from the list of layers.
      const row = await page.evaluateHandle(() => [...document.querySelectorAll('[data-testid="layer-row"], .layer-row')].find((el) => el.textContent?.includes('Item {{name}}')) as HTMLElement);
      await (row.asElement() as never as { click: () => Promise<void> }).click();
      await sleep(150);
      const sectionToggle = await page.evaluateHandle(() => [...document.querySelectorAll('.section-toggle')].find((el) => el.closest('[data-section="Data"]')) as HTMLElement | undefined);
      if (sectionToggle.asElement()) await (sectionToggle.asElement() as never as { click: () => Promise<void> }).click();
      const hasRepeat = await until(async () => (await count(page, 'repeat-data')) === 1, 3000);
      check('a layer with placeholders offers Repeat with data', hasRepeat);
      if (hasRepeat) {
        await click(page, 'repeat-data');
        await page.keyboard.type('[{"name":"One","color":"#ffcc00"},{"name":"Two","color":"#00ccff"},{"name":"Three","color":"#ff99cc"}]');
        await page.screenshot({ path: join(SHOTS, 'repeat-section.png') as `${string}.png` });
        await click(page, 'repeat-run');
        check('three copies appear', await until(async () => (await live()).filter((n) => ['One', 'Two', 'Three'].includes(n.text ?? '')).length === 3), await text(page, 'repeat-note').catch(() => ''));
        await sleep(200);
        const lefts = await page.evaluate(() => [...document.querySelectorAll('.bogen-world p')].filter((el) => ['One', 'Two', 'Three'].includes(el.textContent ?? '')).map((el) => el.getBoundingClientRect().left));
        check('the flex parent lays the copies out side by side', lefts.length === 3 && lefts[0]! < lefts[1]! && lefts[1]! < lefts[2]!, lefts);
        await page.screenshot({ path: join(SHOTS, 'repeat-result.png') as `${string}.png` });
        await page.mouse.click(760, 900);
        await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
        check('one Ctrl+Z takes the copies back', await until(async () => (await live()).filter((n) => ['One', 'Two', 'Three'].includes(n.text ?? '')).length === 0));
      }

      // The Export panel, with the page as the target.
      await page.mouse.click(760, 920);
      await page.keyboard.press('Escape');
      await click(page, 'tab-export');
      await testid(page, 'export-panel');
      const pick = async (format: string) => page.select('[data-testid="export-format"] select, select[data-testid="export-format"]', format);
      const waitFile = (ext: string) => until(() => readdirSync(downloads).some((f) => f.endsWith(`.${ext}`) && statSync(join(downloads, f)).size > 0), 90_000);
      await pick('avif');
      await click(page, 'export-run');
      check('AVIF comes down from the Export panel', await waitFile('avif'));
      await pick('svg');
      await click(page, 'export-run');
      check('SVG comes down, with a report', await waitFile('svg') && await until(async () => (await count(page, 'export-report')) === 1));
      await page.screenshot({ path: join(SHOTS, 'export-svg.png') as `${string}.png` });
      await pick('webm');
      await sleep(50);
      await click(page, 'export-duration');
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
      await page.keyboard.type('1');
      await page.keyboard.press('Enter');
      await page.screenshot({ path: join(SHOTS, 'export-video.png') as `${string}.png` });
      await click(page, 'export-run');
      check('WebM comes down, and says what made it', await waitFile('webm') && await until(async () => (await text(page, 'export-report').catch(() => '')).includes('frames')));
      await click(page, 'export-set-ios');
      check('a preset set fills the rows', (await count(page, 'export-set-row')) === 3);
      await page.screenshot({ path: join(SHOTS, 'export-set.png') as `${string}.png` });
      await click(page, 'export-set-run');
      check('several sizes come down as one zip', await waitFile('zip'));

      check('no uncaught page errors', errors.length === 0, errors.slice(0, 3));
      await agent.close();
    } finally {
      await browser.close();
    }
  } finally {
    server.kill('SIGTERM');
    figmaApi.close();
    await sleep(600);
    rmSync(home, { recursive: true, force: true });
    rmSync(downloads, { recursive: true, force: true });
  }
  console.log(`\n${ok} passed, ${bad} failed. Screenshots in ${SHOTS}`);
  writeFileSync(join(SHOTS, 'result.txt'), `${ok} passed, ${bad} failed\n`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
