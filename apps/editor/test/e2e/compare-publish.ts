/**
 * The visual compare of a branch before it merges (side by side with scrolling together, overlay, swipe, difference)
 * and the check in the Publish dialog, in a real editor against a real server, with screenshots.
 * Run: BOGEN_EDITOR_DIR=<built editor> SHOT_DIR=$TMPDIR/compare-shots npx tsx apps/editor/test/e2e/compare-publish.ts
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket as NodeWs } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { BogenDoc, Y } from '@bogen/core';
import { freshPage, launch, sleep, startRealServer } from './craft-harness.ts';
import { watchErrors } from './harness.ts';

const SHOTS = process.env.SHOT_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'compare-shots');
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const server = await startRealServer({ editorDir: process.env.BOGEN_EDITOR_DIR });
  const browser = await launch(server.port);
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`${server.base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return res.json() as Promise<any>;
  };
  const { id } = await api('/api/files', 'POST', { name: 'Compare and publish' });
  const y = new Y.Doc();
  const provider = new WebsocketProvider(`${server.base.replace('http', 'ws')}/sync`, id, y, { WebSocketPolyfill: NodeWs as never, disableBc: true });
  provider.awareness.setLocalState(null);
  await new Promise<void>((ok) => provider.on('sync', (s: boolean) => { if (s) ok(); }));
  const doc = new BogenDoc(y);
  const pageId = doc.getPages()[0]!.id;
  // A tall web page, so that the two sides scroll, with a link to an anchor that is not there and an image with no size.
  const hero = doc.insert(pageId, {
    type: 'frame', name: 'Home', artboard: true, attrs: { 'data-web': 'page' },
    style: { position: 'absolute', left: '0px', top: '0px', width: '720px', height: '2200px', backgroundColor: '#f4f2ec', display: 'flex', flexDirection: 'column', gap: '24px', padding: '48px' },
    children: [
      { type: 'text', tag: 'h1', name: 'Title', text: 'Night trains across Europe', style: { fontSize: '56px', color: '#0e0e0c', margin: '0px' } },
      { type: 'text', tag: 'a', name: 'Prices link', text: 'See the prices', attrs: { href: '#pricing' }, style: { color: '#2b3df2', fontSize: '20px' } },
      { type: 'image', tag: 'img', name: 'Photo', src: PIXEL, attrs: { alt: 'A sleeping compartment' }, style: { width: '100%', backgroundColor: '#c9c6bb' } },
      { type: 'frame', name: 'Block', style: { height: '1400px', backgroundColor: '#ebe8df' } },
      { type: 'text', tag: 'p', name: 'Footer', text: 'Since 1998', style: { fontSize: '18px', color: '#5f5d55' } },
    ],
  } as never);
  doc.insert(pageId, { type: 'frame', name: 'About', artboard: true, style: { position: 'absolute', left: '800px', top: '0px', width: '400px', height: '300px', backgroundColor: '#ffffff' }, children: [{ type: 'text', name: 'Line', text: 'About us', style: { fontSize: '24px' } }] } as never);
  await sleep(400);
  const branch = (await api(`/api/files/${id}/design-branches`, 'POST', { name: 'Darker hero', checkout: true })).branch.id as string;
  await sleep(600);
  const title = doc.getChildren(hero)[0]!.id;
  doc.updateStyle(hero, { backgroundColor: '#141413' });
  doc.updateStyle(title, { color: '#f4f2ec' });
  doc.updateFields(title, { text: 'Night trains, after dark' });
  await sleep(600);
  await api(`/api/files/${id}/design-branches/${branch}/switch`, 'POST', { by: 'person' });
  await sleep(600);

  const page = await freshPage(browser);
  const errors: string[] = [];
  watchErrors(page, errors);
  let failed = 0;
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (!ok) failed++;
    console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 600)}` : ''}`);
  };
  const shot = async (name: string) => {
    const path = join(SHOTS, `${name}.png`);
    await page.screenshot({ path });
    console.log(`      ${path}`);
  };
  try {
    await page.goto(`${server.base}/#/file/${id}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 20000 });
    await page.click('[data-testid="branch-menu"]');
    await page.waitForSelector(`[data-branch-id="${branch}"] [data-testid="branch-merge"]`, { timeout: 10000 });
    await page.click(`[data-branch-id="${branch}"] [data-testid="branch-merge"]`);
    await page.waitForSelector('[data-testid="branch-merge-screen"]', { timeout: 15000 });
    const listed = await page.$$eval('[data-testid="branch-merge-screen"]', (els) => els.map((e) => [e.querySelector('.db-name')?.textContent, (e as HTMLElement).dataset.change]));
    check('the merge preview lists the one screen that changes', JSON.stringify(listed) === JSON.stringify([['Home', 'changed']]), listed);
    await shot('merge-preview');

    await page.click('[data-testid="branch-merge-compare"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="history-side-image"]').length === 2, { timeout: 30000 });
    await sleep(300);
    const percent = await page.$eval('[data-testid="compare-percent"]', (e) => e.textContent ?? '');
    check('side by side shows both sides and how much differs', /\d+(\.\d+)?%/.test(percent), percent);
    // Scrolling one side scrolls the other.
    await page.$eval('[data-testid="compare-pane-0"]', (e) => { e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event('scroll')); });
    await sleep(200);
    const follow = await page.$eval('[data-testid="compare-pane-1"]', (e) => ({ top: e.scrollTop, can: e.scrollHeight - e.clientHeight }));
    check('scroll together moves the other side', follow.can > 0 && follow.top > follow.can * 0.8, follow);
    await page.$eval('[data-testid="compare-pane-0"]', (e) => { e.scrollTop = 0; e.dispatchEvent(new Event('scroll')); });
    await sleep(200);
    await shot('compare-side-by-side');

    await page.click('[data-testid="compare-mode-overlay"]');
    await page.waitForSelector('[data-testid="compare-tint"]', { timeout: 5000 });
    await shot('compare-overlay');

    await page.click('[data-testid="compare-mode-swipe"]');
    await page.waitForSelector('[data-testid="compare-split"]', { timeout: 5000 });
    await page.$eval('[data-testid="compare-split"]', (e) => {
      const input = e as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '35');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(200);
    const clip = await page.$eval('.compare-swipe .compare-over', (e) => (e as HTMLElement).style.clipPath);
    check('the swipe follows its slider', clip.includes('35%'), clip);
    await shot('compare-swipe');

    await page.click('[data-testid="compare-mode-diff"]');
    await page.waitForSelector('[data-testid="compare-diff-image"]', { timeout: 5000 });
    await shot('compare-difference');
    await page.click('[data-testid="history-preview-exit"]');
    await sleep(300);
    check('back to the canvas', !(await page.$('[data-testid="history-stage"]')));

    // The Publish dialog checks the page before anything goes out, and only warns.
    await page.keyboard.press('Escape');
    await page.click('[data-testid="tab-export"]');
    await page.waitForSelector('[data-testid="export-open-publish"]', { timeout: 10000 });
    await page.click('[data-testid="export-open-publish"]');
    await page.waitForSelector('[data-testid="publish-check-summary"]', { timeout: 60000 });
    const gate = await page.$eval('[data-testid="publish-check"]', (e) => ({ errors: Number((e as HTMLElement).dataset.errors), warnings: Number((e as HTMLElement).dataset.warnings), checks: [...e.querySelectorAll('[data-testid="publish-check-finding"]')].map((f) => `${(f as HTMLElement).dataset.level}:${(f as HTMLElement).dataset.check}`) }));
    check('the check names the missing language and the broken anchor as problems', gate.checks.includes('error:lang') && gate.checks.includes('error:anchor'), gate);
    check('and the rest as warnings', gate.checks.includes('warning:description') && gate.checks.includes('warning:og-image'), gate);
    await page.click('[data-testid="publish-prepare"]');
    await page.waitForFunction(() => /anyway/.test(document.querySelector('[data-testid="publish-run"]')?.textContent ?? ''), { timeout: 60000 });
    const button = await page.$eval('[data-testid="publish-run"]', (e) => ({ text: e.textContent, disabled: (e as HTMLButtonElement).disabled }));
    check('the person can publish anyway', /anyway/.test(button.text ?? '') && !button.disabled, button);
    await shot('publish-check');
  } finally {
    check('no page errors', errors.length === 0, errors);
    if (failed) await page.screenshot({ path: join(SHOTS, 'compare-publish-fail.png') }).catch(() => {});
    provider.destroy();
    await browser.close();
    await server.close();
    process.exit(failed ? 1 : 0);
  }
}

void main();
