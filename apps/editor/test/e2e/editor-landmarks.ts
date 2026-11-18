/**
 * The editor has one main landmark, the canvas stage. A design drawn on it adds none: artboards are regions named
 * after the board, and a main element inside a design is drawn as a plain box. The preview keeps the design's main.
 * Run: BOGEN_EDITOR_DIR=<built editor> npx tsx apps/editor/test/e2e/editor-landmarks.ts
 */
import { WebSocket as NodeWs } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { BogenDoc, Y } from '@bogen/core';
import type { Page } from 'puppeteer-core';
import { freshPage, launch, sleep, startRealServer } from './craft-harness.ts';
import { watchErrors } from './harness.ts';

type Landmark = { role: string; name: string };

/** Every landmark in the page's accessibility tree, with its accessible name. */
async function landmarks(page: Page): Promise<Landmark[]> {
  const cdp = await page.createCDPSession();
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: { role?: { value?: string }; name?: { value?: string }; ignored?: boolean }[] };
  await cdp.detach();
  const roles = new Set(['main', 'region', 'banner', 'contentinfo', 'navigation', 'complementary', 'form', 'search']);
  return nodes.filter((n) => !n.ignored && roles.has(n.role?.value ?? '')).map((n) => ({ role: n.role!.value!, name: n.name?.value ?? '' }));
}

async function main(): Promise<void> {
  const server = await startRealServer({ editorDir: process.env.BOGEN_EDITOR_DIR });
  const browser = await launch(server.port);
  const res = await fetch(`${server.base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Landmarks' }) });
  const { id } = (await res.json()) as { id: string };
  const y = new Y.Doc();
  const provider = new WebsocketProvider(`${server.base.replace('http', 'ws')}/sync`, id, y, { WebSocketPolyfill: NodeWs as never, disableBc: true });
  provider.awareness.setLocalState(null);
  await new Promise<void>((ok) => provider.on('sync', (s: boolean) => { if (s) ok(); }));
  const doc = new BogenDoc(y);
  const pageId = doc.getPages()[0]!.id;
  // Three boards made the way artboard_create makes them (a main element), the second with a page layout of its own.
  for (let i = 0; i < 3; i++) {
    const board = doc.insert(pageId, { type: 'frame', tag: 'main', name: `Screen ${i + 1}`, artboard: true, style: { position: 'absolute', left: `${i * 500}px`, top: '0px', width: '400px', height: '300px', backgroundColor: '#ffffff' } } as never);
    if (i === 1) {
      doc.insert(board, { type: 'frame', tag: 'header', name: 'Header', style: { height: '40px' } } as never);
      const inner = doc.insert(board, { type: 'frame', tag: 'main', name: 'Content', style: { height: '200px' } } as never);
      doc.insert(inner, { type: 'text', name: 'Title', text: 'Inside', style: { fontSize: '24px', color: '#111' } } as never);
    } else doc.insert(board, { type: 'text', name: 'Title', text: `Screen ${i + 1}`, style: { fontSize: '24px', color: '#111' } } as never);
  }
  await sleep(300);

  const page = await freshPage(browser);
  const errors: string[] = [];
  watchErrors(page, errors);
  let failed = 0;
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (!ok) failed++;
    console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 600)}` : ''}`);
  };
  try {
    await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bogen-language', 'en'); } catch { /* private mode */ } });
    await page.goto(`${server.base}/#/file/${id}`);
    await page.waitForSelector('[data-testid="canvas"] .bogen-world [data-bogen-id]', { timeout: 20000 });
    await sleep(800);
    const editor = await landmarks(page);
    const mains = editor.filter((l) => l.role === 'main');
    check('the editor has exactly one main landmark', mains.length === 1, editor);
    check('that main is the canvas stage', mains[0]?.name === 'Canvas', mains);
    const boards = editor.filter((l) => l.role === 'region' && /^Screen \d$/.test(l.name)).map((l) => l.name).sort();
    check('each artboard is a region named after the board', JSON.stringify(boards) === JSON.stringify(['Screen 1', 'Screen 2', 'Screen 3']), editor);
    check('a header inside a design is not the editor banner', editor.filter((l) => l.role === 'banner').length <= 1, editor);
    const dom = await page.evaluate(() => ({
      boards: [...document.querySelectorAll('.bogen-world > section[aria-roledescription]')].map((el) => el.getAttribute('aria-roledescription')),
      mainsInWorld: document.querySelectorAll('.bogen-world main, .bogen-world [role="main"]').length,
      marked: document.querySelectorAll('.bogen-world [data-bogen-tag="main"]').length,
    }));
    check('boards say they are artboards', dom.boards.length === 3 && dom.boards.every((d) => d === 'Artboard'), dom);
    check('no main element is drawn inside the canvas', dom.mainsInWorld === 0, dom);
    check('the design keeps what its boxes were', dom.marked === 4, dom);

    // The design's own markup is untouched: the preview shows the board as its page, with its main.
    await page.evaluate((h) => { location.hash = h; }, `#/file/${id}/preview`);
    await page.waitForSelector('[data-testid="preview-frame"]', { timeout: 10000 });
    await sleep(800);
    const preview = await landmarks(page);
    check('the preview keeps the design main', preview.some((l) => l.role === 'main'), preview);
    const code = await fetch(`${server.base}/api/files/${id}/content`).then((r) => r.ok ? r.text() : '');
    check('the stored design still says main', !code || code.includes('main'), code.slice(0, 200));
    check('no errors in the page', errors.length === 0, errors);
  } finally {
    provider.destroy();
    await browser.close();
    await server.close();
  }
  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log('all passed');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
