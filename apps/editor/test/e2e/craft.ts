/**
 * Real mouse and keyboard against a real server from source, in a temp BOGEN_HOME on a spare port.
 * Run: BOGEN_EDITOR_DIR=<built editor> npx tsx apps/editor/test/e2e/craft.ts [section...]
 */
import { WebSocket as NodeWs } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import type { Browser, Page } from 'puppeteer-core';
import { BogenDoc, Y } from '@bogen/core';
import { freshPage, launch, sleep, startRealServer, type RealServer } from './craft-harness.ts';
import { watchErrors } from './harness.ts';
import { sections } from './craft-sections.ts';
import { figmaSections } from './craft-figma.ts';

const more = [...sections, ...figmaSections];

export interface T {
  server: RealServer;
  browser: Browser;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  newFile: (name?: string) => Promise<{ fileId: string; doc: BogenDoc; pageId: string; close: () => void }>;
  open: (fileId: string, hash?: string) => Promise<{ page: Page; errors: string[] }>;
}

let passed = 0;
const failures: string[] = [];
const check: T['check'] = (name, ok, detail) => {
  if (ok) passed++;
  else failures.push(`${name}: ${detail === undefined ? '' : typeof detail === 'object' ? JSON.stringify(detail) : String(detail)}`);
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${typeof detail === 'object' ? JSON.stringify(detail).slice(0, 400) : String(detail)}` : ''}`);
};

async function main(): Promise<void> {
  const server = await startRealServer({ editorDir: process.env.BOGEN_EDITOR_DIR });
  const browser = await launch(server.port);
  const peers: WebsocketProvider[] = [];
  const t: T = {
    server, browser, check,
    newFile: async (name = 'Test') => {
      const res = await fetch(`${server.base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const { id } = (await res.json()) as { id: string };
      const y = new Y.Doc();
      const provider = new WebsocketProvider(`${server.base.replace('http', 'ws')}/sync`, id, y, { WebSocketPolyfill: NodeWs as never, disableBc: true });
      provider.awareness.setLocalState(null);
      peers.push(provider);
      await new Promise<void>((ok) => provider.on('sync', (s: boolean) => { if (s) ok(); }));
      const doc = new BogenDoc(y);
      return { fileId: id, doc, pageId: doc.getPages()[0]!.id, close: () => provider.destroy() };
    },
    open: async (fileId, hash) => {
      const page = await freshPage(browser);
      const errors: string[] = [];
      watchErrors(page, errors);
      await page.goto(`${server.base}/${hash ?? `#/file/${fileId}`}`);
      if (!hash) await page.waitForSelector('[data-testid="canvas"]', { timeout: 20000 });
      await sleep(200);
      return { page, errors };
    },
  };
  const only = process.argv.slice(2);
  try {
    for (const [name, fn] of more) {
      if (only.length && !only.includes(name)) continue;
      console.log(`\n== ${name}`);
      try {
        await fn(t);
      } catch (err) {
        check(`${name}: finished without throwing`, false, (err as Error).stack);
        const pages = await browser.pages();
        await pages.at(-1)?.screenshot({ path: `${import.meta.dirname}/../../screenshots/crash-craft-${name}.png` }).catch(() => {});
      }
    }
  } finally {
    console.log(`\n${passed}/${passed + failures.length} checks passed`);
    for (const f of failures) console.log(`  FAIL ${f.slice(0, 500)}`);
    for (const p of peers) p.destroy();
    await browser.close();
    await server.close();
    process.exit(failures.length ? 1 : 0);
  }
}

void main();
