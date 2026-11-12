/**
 * Pull requests, Storybook and token sync in a real browser against a real server from source. The repository
 * is a fixture with a bare repository as its remote, and `claude` and `gh` are stand-ins first on PATH: nothing
 * reaches a network. Imports the fixture's stories from Assets, pulls and pushes tokens from the Tokens panel,
 * and makes a pull request from a selected layer through the preview and its confirmation.
 *
 * Run: npm run build --workspace @bogen/editor && npx tsx apps/editor/test/e2e/code-pulls.ts
 * Screenshots: E2E_SHOTS=/path.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { makeRepoFixture } from '../../../../packages/server/test/repo-fixture.ts';

const SHOTS = process.env.E2E_SHOTS ?? resolve(import.meta.dirname, '../../screenshots/code-pulls');
const STORIES = resolve(import.meta.dirname, '../../../../packages/server/test/fixtures/storybook-project');
mkdirSync(SHOTS, { recursive: true });

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failures.push(`${name}: ${JSON.stringify(detail)}`);
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errors: string[] = [];

async function until(what: string, fn: () => Promise<boolean> | boolean, timeout = 15000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await Promise.resolve().then(fn).catch(() => false)) return true;
    await sleep(60);
  }
  console.log(`  timed out waiting for: ${what}`);
  return false;
}

/** The Storybook fixture's files, so that one repository has stories, a hero and tokens. */
function storyFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[relative(STORIES, abs)] = readFileSync(abs, 'utf8');
    }
  };
  walk(STORIES);
  return out;
}

async function click(page: Page, testId: string): Promise<void> {
  await (await page.waitForSelector(`[data-testid="${testId}"]`, { timeout: 15000 }))!.click();
}

async function main(): Promise<void> {
  const fx = makeRepoFixture({
    ...storyFiles(),
    'src/Hero.tsx': 'export function Hero() {\n  return <h1 style={{ color: \'#111111\' }}>Hello</h1>;\n}\n',
    'src/index.css': '@import "tailwindcss";\n\n:root {\n  --brand: #e5484d;\n  --surface: #ffffff;\n}\n',
  }, join(SHOTS, 'repos')); // Under this checkout, so that the stories' own build finds its React and Tailwind.
  const savedPath = process.env.PATH;
  process.env.PATH = `${fx.bin}:${savedPath}`;
  const home = mkdtempSync(join(tmpdir(), 'bogen-pulls-e2e-'));
  const server = new BogenServer({ home, port: 0, exportDir: join(home, 'exports'), storybookIntervalMs: 300 });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: process.env.BOGEN_BROWSER ?? '/usr/bin/chromium', headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'bogen-pulls-profile-')), args: ['--no-sandbox', '--window-size=1500,960', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 960 } });
  try {
    const base = server.localUrl();
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()) as Promise<{ id: string }>;
    const fileId = (await post('/api/files', { name: 'Landing' })).id;
    await post('/api/code/projects', { dir: fx.repo, fileId });
    const room = await server.rooms.get(fileId);
    const doc = room.doc;
    const pageId = doc.getPages()[0]?.id ?? doc.createPage('Page 1');
    const board = doc.insert(pageId, { type: 'frame', name: 'Hero', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '480px', padding: '24px', background: '#ffffff' } });
    const title = doc.insert(board, { type: 'text', tag: 'h1', name: 'Title', text: 'Hello', style: { color: '#111111', fontSize: '40px', margin: '0px' } });
    doc.setToken('brand', 'color', '#d93036');
    doc.setToken('accent', 'color', '#2563eb');
    await post(`/api/files/${fileId}/commits`, { message: 'Before', author: 'Test' });

    const page = await browser.newPage();
    await page.evaluateOnNewDocument('window.__name = (f) => f');
    page.on('pageerror', (e) => errors.push(`pageerror: ${(e as Error).message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/fonts\.g|net::ERR|Failed to load resource|WebSocket connection/.test(m.text())) errors.push(`console: ${m.text()}`);
    });
    await page.goto(`${base}/#/file/${fileId}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 20000 });
    await sleep(300);

    // Storybook, from Assets.
    await click(page, 'tab-assets');
    await click(page, 'code-stories-import');
    check('importing stories lays out a Storybook page', await until('storybook page', () => doc.getPages().some((p) => p.name === 'Storybook')));
    check('with a set per component', await until('sets', () => [...doc.nodes.keys()].filter((id) => doc.nodes.get(id)!.get('storybookSet')).length === 2));
    check('and says which file has a problem', await until('problem', async () => (await page.$$('[data-testid="code-stories-problem"]')).length === 1));
    await page.screenshot({ path: resolve(SHOTS, 'storybook.png') as `${string}.png` });
    // Back to the first page, where the hero is.
    await click(page, 'tab-layers');
    await (await page.waitForSelector('[data-testid="page-row"]'))!.click();

    // Tokens: the repository next to the file.
    await click(page, 'tab-tokens');
    await click(page, 'token-repo');
    check('the tokens dialog lists the repository next to the file', await until('rows', async () => (await page.$$('[data-testid="rt-row"]')).length === 3));
    const status = async (name: string) => page.$eval(`[data-testid="rt-row"][data-token="${name}"]`, (e) => e.getAttribute('data-status')).catch(() => null);
    check('changed, only in the file, only in the repository', (await status('brand')) === 'changed' && (await status('accent')) === 'file' && (await status('surface')) === 'repo');
    await page.screenshot({ path: resolve(SHOTS, 'tokens.png') as `${string}.png` });
    await click(page, 'rt-pick-brand');
    await click(page, 'rt-pull');
    check('pulling takes the repository\'s values into the file', await until('surface pulled', () => doc.getTokens().some((t) => t.name === 'surface' && t.value === '#ffffff')));
    check('and leaves unpicked ones alone', doc.getTokens().find((t) => t.name === 'brand')?.value === '#d93036');
    await until('reloaded', async () => (await status('surface')) === 'same');
    await click(page, 'rt-pick-brand');
    await click(page, 'rt-push');
    check('pushing tokens shows the pull request first', await until('draft ready', async () => (await page.$eval('[data-testid="pr-draft"]', (e) => e.getAttribute('data-status')).catch(() => '')) === 'ready'));
    check('with the token file in it', await until('files', async () => (await page.$$('[data-testid="pr-file"][data-path="src/index.css"]')).length === 1));
    check('and nothing pushed yet', fx.ghCalls().length === 0 && !fx.git(['ls-remote', '--heads', fx.remote]).includes('bogen/'));
    await page.screenshot({ path: resolve(SHOTS, 'tokens-pr.png') as `${string}.png` });
    await click(page, 'pr-discard');
    await until('dialog closed', async () => (await page.$('[data-testid="pr-dialog"]')) === null);

    // A design change, from the selection, against the last version: pushing tokens saved one.
    doc.updateStyle(title, { color: '#e11d48' });
    const box = await (await page.waitForSelector(`[data-bogen-id="${title}"]`))!.boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' });
    const items = await page.$$eval('.menu-item', (els) => els.map((e) => e.textContent ?? ''));
    check('the context menu offers a pull request in a linked file', items.some((t) => t.startsWith('Open a pull request')), items);
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.menu-item')].find((e) => e.textContent?.startsWith('Open a pull request'))?.click());
    await click(page, 'pr-source-selection');
    await click(page, 'pr-title');
    await page.keyboard.type('Red hero title');
    await page.screenshot({ path: resolve(SHOTS, 'start.png') as `${string}.png` });
    await click(page, 'pr-start');
    const ready = await until('ready', async () => (await page.$eval('[data-testid="pr-draft"]', (e) => e.getAttribute('data-status')).catch(() => '')) === 'ready', 60000);
    check('the run ends in a preview', ready, ready ? undefined : (await (await fetch(`${base}/api/code/pulls?fileId=${fileId}`)).json() as { drafts: { status: string; error?: string }[] }).drafts.map((d) => [d.status, d.error]));
    check('the preview shows the branch', (await page.$eval('[data-testid="pr-branch"]', (e) => e.textContent ?? '').catch(() => '')).startsWith('bogen/red-hero-title'));
    check('the code and both pictures', await until('files', async () => (await page.$$('[data-testid="pr-file"]')).length === 3));
    check('the pictures load', await until('images', async () => page.$$eval('.pr-picture img', (imgs) => imgs.length === 2 && imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0))));
    await click(page, 'pr-diff-toggle');
    check('the diff', (await page.$eval('[data-testid="pr-diff"]', (e) => e.textContent ?? '')).includes('+  return <h1 style={{ color: \'#e11d48\' }}>Hello</h1>;'));
    check('the description links back to the version', (await page.$eval('[data-testid="pr-body"]', (e) => (e as HTMLTextAreaElement).value)).includes(`/#/file/${fileId}?version=`));
    await page.screenshot({ path: resolve(SHOTS, 'preview.png') as `${string}.png`, fullPage: true });
    check('nothing has been pushed before the confirmation', fx.ghCalls().length === 0 && !fx.git(['ls-remote', '--heads', fx.remote]).includes('bogen/red-hero-title'));
    await click(page, 'pr-push');
    check('confirming pushes and opens it with gh', await until('opened', async () => (await page.$eval('[data-testid="pr-url"]', (e) => e.textContent ?? '').catch(() => '')).includes('https://github.com/acme/app/pull/42')));
    check('one gh call, on the branch', fx.ghCalls().length === 1 && fx.ghCalls()[0]!.args.includes('bogen/red-hero-title'), fx.ghCalls());
    check('the branch is on the remote', fx.git(['ls-remote', '--heads', fx.remote]).includes('refs/heads/bogen/red-hero-title'));
    await page.screenshot({ path: resolve(SHOTS, 'opened.png') as `${string}.png` });
    await click(page, 'pr-close');
    await click(page, 'tab-assets');
    check('the draft waits in Assets', await until('drafts', async () => (await page.$$('[data-testid="code-pull"][data-status="opened"]')).length === 1));

    // The link in the description opens that version.
    const url = (await (await fetch(`${base}/api/code/pulls?fileId=${fileId}`)).json() as { drafts: { version: { url: string } }[] }).drafts[0]!.version.url;
    await page.goto(url);
    await page.reload();
    check('the link back opens the version on the stage', await until('stage', async () => (await page.$('[data-testid="history-stage"]')) !== null));

    check('no errors in the page', errors.length === 0, errors);
  } finally {
    await browser.close();
    await server.close();
    process.env.PATH = savedPath;
    rmSync(home, { recursive: true, force: true });
    fx.cleanup();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

await main();
