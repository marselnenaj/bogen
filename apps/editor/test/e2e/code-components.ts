/**
 * Code components in a real browser against a real server from source: link the fixture project
 * (Vite + React + Tailwind 4) in the Assets panel, place its Button, see it rendered by the project's own
 * code and CSS in a sandboxed frame, change a prop in the inspector, and check the frame cannot reach
 * the editor.
 *
 * Run: npx tsx apps/editor/test/e2e/code-components.ts
 * With a built editor from elsewhere: BOGEN_EDITOR_DIR=/path/to/dist. Screenshots: E2E_SHOTS=/path.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer, { type Frame, type Page } from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';

const SHOTS = process.env.E2E_SHOTS ?? resolve(import.meta.dirname, '../../screenshots/code-components');
const FIXTURE = resolve(import.meta.dirname, '../../../../packages/server/test/fixtures/code-project');
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

async function until(what: string, fn: () => Promise<boolean> | boolean, timeout = 10000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await Promise.resolve().then(fn).catch(() => false)) return true;
    await sleep(40);
  }
  console.log(`  timed out waiting for: ${what}`);
  return false;
}

function codeFrame(page: Page): Frame | undefined {
  return page.frames().find((f) => f.url().includes('/api/code/'));
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'bogen-code-e2e-'));
  const server = new BogenServer({ home, port: 0, exportDir: join(home, 'exports') });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: process.env.BOGEN_BROWSER ?? '/usr/bin/chromium', headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'bogen-code-profile-')), args: ['--no-sandbox', '--window-size=1500,960', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 960 } });
  try {
    const base = server.localUrl();
    const fileId = ((await (await fetch(`${base}/api/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Code' }) })).json()) as { id: string }).id;
    const room = await server.rooms.get(fileId);
    const page = await browser.newPage();
    await page.evaluateOnNewDocument('window.__name = (f) => f');
    page.on('pageerror', (e) => errors.push(`pageerror: ${(e as Error).message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/fonts\.g|net::ERR|Failed to load resource|WebSocket connection/.test(m.text())) errors.push(`console: ${m.text()}`);
    });
    await page.goto(`${base}/#/file/${fileId}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 20000 });
    await sleep(300);

    await (await page.waitForSelector('[data-testid="tab-assets"]'))!.click();
    await (await page.waitForSelector('[data-testid="code-link-dir"]'))!.click();
    await page.keyboard.type(FIXTURE);
    await (await page.waitForSelector('[data-testid="code-link"]'))!.click();
    check('linking lists the project\'s components', await until('code assets', async () => (await page.$$('[data-testid="code-asset"]')).length === 4), (await page.$$('[data-testid="code-asset"]')).length);
    check('the file records the link', (room.doc.meta.get('codeProject') as { name?: string } | undefined)?.name === 'code-components-fixture');
    await page.screenshot({ path: resolve(SHOTS, 'assets.png') as `${string}.png` });

    await (await page.waitForSelector('[data-testid="code-asset"][data-name="Button"]'))!.click();
    const placed = await until('a code layer in the document', () => [...room.doc.nodes.keys()].some((id) => room.doc.getNode(id)?.code));
    const id = [...room.doc.nodes.keys()].find((k) => room.doc.getNode(k)?.code) ?? '';
    check('clicking places a code component layer', placed);
    const node = room.doc.getNode(id);
    check('it starts with its name as children, measured', node?.code?.props.children === 'Button' && node.style.height === '40px', node?.style);
    check('the canvas shows it in a sandboxed frame', await until('iframe', async () => (await page.$(`iframe[data-bogen-id="${id}"][sandbox="allow-scripts"]`)) !== null));
    const bg = async () => (await codeFrame(page)?.evaluate(() => { const b = document.querySelector('button'); return b ? getComputedStyle(b).backgroundColor : ''; })) ?? '';
    check('rendered by the project\'s code with its Tailwind theme', await until('brand background', async () => (await bg()) === 'rgb(229, 72, 77)'), await bg());
    await page.screenshot({ path: resolve(SHOTS, 'placed.png') as `${string}.png` });

    check('the inspector shows its props', await until('code section', async () => (await page.$('[data-testid="code-section"]')) !== null));
    await page.select('[data-testid="code-prop-variant"]', 'outline');
    check('a prop set in the inspector reaches the document', await until('variant in doc', () => room.doc.getNode(id)?.code?.props.variant === 'outline'), room.doc.getNode(id)?.code?.props);
    check('and the frame draws the new variant', await until('outline background', async () => (await bg()) === 'rgb(255, 255, 255)'), await bg());
    await page.screenshot({ path: resolve(SHOTS, 'outline.png') as `${string}.png` });

    check('no errors in the page', errors.length === 0, errors);

    // What follows provokes CSP reports on purpose.
    const frame = codeFrame(page)!;
    const reach = await frame.evaluate(async () => {
      const out: Record<string, string> = {};
      try { out.parent = String(parent.document.title); } catch { out.parent = 'blocked'; }
      try { out.storage = String(localStorage.length); } catch { out.storage = 'blocked'; }
      try { await fetch('/api/files'); out.fetch = 'reached'; } catch { out.fetch = 'blocked'; }
      out.origin = String(origin);
      return out;
    });
    check('the frame cannot reach the editor, its storage or the API', reach.parent === 'blocked' && reach.storage === 'blocked' && reach.fetch === 'blocked' && reach.origin === 'null', reach);
  } finally {
    await browser.close();
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

await main();
