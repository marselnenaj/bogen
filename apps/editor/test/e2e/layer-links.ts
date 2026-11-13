/**
 * Layer deep links: `bogen open <file>#<layer>` and the link view_focus gives an agent open the file with that layer
 * selected and in view, also when the file is already open in the tab.
 * Run: BOGEN_EDITOR_DIR=<built editor> npx tsx apps/editor/test/e2e/layer-links.ts
 */
import { WebSocket as NodeWs } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Page } from 'puppeteer-core';
import { BogenDoc, Y } from '@bogen/core';
import { openTarget } from '../../../../packages/server/src/cli-transfer.ts';
import { freshPage, launch, sleep, startRealServer } from './craft-harness.ts';
import { watchErrors } from './harness.ts';

const selectedIds = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="layer-row"].is-selected')].map((e) => e.getAttribute('data-layer') ?? ''));

async function until(check: () => Promise<boolean>, ms = 10000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(100);
  }
  return false;
}

/** Whether the selection box is on screen, inside the canvas. */
async function selectionInView(page: Page): Promise<boolean> {
  const box = await (await page.$('[data-testid="selection-box"]'))?.boundingBox();
  const canvas = await (await page.$('[data-testid="canvas"]'))?.boundingBox();
  if (!box || !canvas) return false;
  return box.x >= canvas.x - 1 && box.y >= canvas.y - 1 && box.x + box.width <= canvas.x + canvas.width + 1 && box.y + box.height <= canvas.y + canvas.height + 1;
}

async function main(): Promise<void> {
  const server = await startRealServer({ editorDir: process.env.BOGEN_EDITOR_DIR });
  const browser = await launch(server.port);
  let failed = 0;
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (!ok) failed++;
    console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 600)}` : ''}`);
  };
  try {
    const res = await fetch(`${server.base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Layer links' }) });
    const { id } = (await res.json()) as { id: string };
    const y = new Y.Doc();
    const provider = new WebsocketProvider(`${server.base.replace('http', 'ws')}/sync`, id, y, { WebSocketPolyfill: NodeWs as never, disableBc: true });
    provider.awareness.setLocalState(null);
    await new Promise<void>((ok) => provider.on('sync', (s: boolean) => { if (s) ok(); }));
    const doc = new BogenDoc(y);
    const pageId = doc.getPages()[0]!.id;
    const home = doc.insert(pageId, { type: 'frame', name: 'Home', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '400px', height: '300px', backgroundColor: '#ffffff' } });
    doc.insert(home, { type: 'text', name: 'Title', text: 'Home', style: { position: 'absolute', left: '20px', top: '20px', fontSize: '24px', color: '#111' } } as never);
    // Far away from the first, so that showing it takes a move of the view.
    const pricing = doc.insert(pageId, { type: 'frame', name: 'Pricing', artboard: true, style: { position: 'absolute', left: '6000px', top: '3000px', width: '400px', height: '300px', backgroundColor: '#ffffff' } });
    const note = doc.insert(pricing, { type: 'text', name: 'Price note', text: 'Billed yearly', style: { position: 'absolute', left: '40px', top: '200px', fontSize: '16px', color: '#111' } } as never);
    await sleep(300);

    const page = await freshPage(browser);
    const errors: string[] = [];
    watchErrors(page, errors);

    // `bogen open "Layer links#Price note"`: the address the CLI opens, by file name and layer name.
    const byName = await openTarget({ url: server.base } as never, 'Layer links#Price note');
    check('bogen open makes a link by file and layer name', byName.hash === `#/file/${id}?layer=Price%20note`, byName);
    await page.goto(`${server.base}/${byName.hash}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 20000 });
    check('a layer named in the link is selected', await until(async () => (await selectedIds(page)).includes(note)), await selectedIds(page));
    check('and brought into view', await until(() => selectionInView(page)));
    await page.screenshot({ path: process.env.SHOT ?? '/dev/null' });

    // A link to another layer of the open file, by id: no reload, the selection and the view follow.
    const byId = await openTarget({ url: server.base } as never, `${id}#${home}`);
    await page.evaluate((h) => { location.hash = h; }, byId.hash);
    check('a layer id in a new link selects it in the open file', await until(async () => (await selectedIds(page)).join() === home), await selectedIds(page));
    check('and moves the view to it', await until(() => selectionInView(page)));

    // The link an agent gets from view_focus, while nobody has the file open in that session's eyes.
    const agent = new Client({ name: 'links-agent', version: '1' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`)));
    const focus = await agent.callTool({ name: 'selection_set', arguments: { file_id: id, node_ids: [note] } });
    const link = JSON.parse((focus.content as { text: string }[])[0]!.text).link as string;
    check('selection_set gives a link to the layer', link === `${server.base}/#/file/${id}?page=${encodeURIComponent(pageId)}&select=${note}`, link);
    const second = await freshPage(browser);
    await second.goto(link);
    await second.waitForSelector('[data-testid="canvas"]', { timeout: 20000 });
    check('the agent link opens with the layer selected', await until(async () => (await selectedIds(second)).includes(note)), await selectedIds(second));
    check('and in view', await until(() => selectionInView(second)));
    await agent.close();
    check('no page errors', errors.length === 0, errors);
    provider.destroy();
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
}

void main();
