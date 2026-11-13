/**
 * Leaving the preview and its full-screen present mode must bring the editor back, every time.
 * Run: BOGEN_EDITOR_DIR=<built editor> npx tsx apps/editor/test/e2e/preview-exit.ts
 */
import { WebSocket as NodeWs } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { BogenDoc, Y } from '@bogen/core';
import { freshPage, launch, sleep, startRealServer } from './craft-harness.ts';
import { watchErrors } from './harness.ts';

const ROUNDS = Number(process.env.ROUNDS ?? 8);

async function main(): Promise<void> {
  const server = await startRealServer({ editorDir: process.env.BOGEN_EDITOR_DIR });
  const browser = await launch(server.port);
  const res = await fetch(`${server.base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Preview exit' }) });
  const { id } = (await res.json()) as { id: string };
  const y = new Y.Doc();
  const provider = new WebsocketProvider(`${server.base.replace('http', 'ws')}/sync`, id, y, { WebSocketPolyfill: NodeWs as never, disableBc: true });
  provider.awareness.setLocalState(null);
  await new Promise<void>((ok) => provider.on('sync', (s: boolean) => { if (s) ok(); }));
  const doc = new BogenDoc(y);
  const pageId = doc.getPages()[0]!.id;
  for (let i = 0; i < 3; i++) {
    const board = doc.insert(pageId, { type: 'frame', name: `Screen ${i + 1}`, artboard: true, style: { position: 'absolute', left: `${i * 500}px`, top: '0px', width: '400px', height: '300px', backgroundColor: '#ffffff', overflow: 'hidden' } });
    doc.insert(board, { type: 'text', name: 'Title', text: `Screen ${i + 1}`, style: { position: 'absolute', left: '20px', top: '20px', fontSize: '24px', color: '#111' }, ...(process.env.NO_RULES ? {} : { rules: { ':hover': { color: '#2b3df2' } } }) } as never);
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
    await page.goto(`${server.base}/#/file/${id}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 20000 });
    const ways = ['esc-esc', 'f-then-back', 'present-button-then-close', 'fullscreen-exit-then-back'] as const;
    for (let r = 0; r < ROUNDS; r++) {
      const way = ways[r % ways.length]!;
      await page.evaluate((h) => { location.hash = h; }, `#/file/${id}/preview`);
      await page.waitForSelector('[data-testid="preview-frame"]', { timeout: 10000 });
      if (way === 'present-button-then-close') await page.click('[data-testid="preview-present"]');
      else await page.keyboard.press('f');
      await sleep(250);
      const inFs = await page.evaluate(() => !!document.fullscreenElement);
      await page.keyboard.press('ArrowRight');
      await sleep(250);
      if (way === 'fullscreen-exit-then-back') await page.evaluate(() => document.exitFullscreen().catch(() => {}));
      else if (way === 'f-then-back') await page.keyboard.press('f');
      else await page.keyboard.press('Escape');
      await sleep(250);
      if (way === 'present-button-then-close') await page.click('[data-testid="preview-bar"] a[aria-label="Close preview"]');
      else await page.keyboard.press('Escape');
      const back = await page.waitForSelector('[data-testid="canvas"]', { timeout: 8000 }).then(() => true, () => false);
      await sleep(400);
      const root = await page.evaluate(() => ({ hash: location.hash, kids: document.getElementById('root')?.childElementCount ?? -1, boards: document.querySelectorAll('[data-artboard], .artboard').length, text: document.body.innerText.slice(0, 120) }));
      check(`round ${r + 1} (${way}, fullscreen ${inFs}): editor back`, back && root.kids > 0, { root, errors: errors.slice() });
    }
  } finally {
    check('no page errors', errors.length === 0, errors);
    if (failed) await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/preview-exit-fail.png` }).catch(() => {});
    provider.destroy();
    await browser.close();
    await server.close();
    process.exit(failed ? 1 : 0);
  }
}

void main();
