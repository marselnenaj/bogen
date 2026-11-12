import { afterEach, describe, expect, it, vi } from 'vitest';
import { BogenDoc } from '@bogen/core';
import type { Page } from 'puppeteer-core';
import { Renderer } from '../src/render.ts';
import { pngStats, startServer, until, type Harness } from './helpers.ts';

describe('large-file rendering stays within the requested work', () => {
  let h: Harness | undefined;
  afterEach(async () => { vi.restoreAllMocks(); await h?.cleanup(); h = undefined; });

  it('never allocates a full-resolution surface just to measure a small preview', async () => {
    const renderer = new Renderer(async () => null);
    const doc = new BogenDoc();
    const page = doc.createPage('Large');
    const id = doc.insert(page, { type: 'frame', name: 'Large', artboard: true, style: { width: '20000px', height: '20000px', backgroundColor: '#336699' } });
    try {
      const viewports: { width: number; height: number; deviceScaleFactor?: number }[] = [];
      await renderer.withBrowser(async (browser) => {
        const probe = await browser.newPage();
        const prototype = Object.getPrototypeOf(probe) as Pick<Page, 'setViewport'>;
        const original = prototype.setViewport;
        vi.spyOn(prototype, 'setViewport').mockImplementation(function (this: unknown, viewport) {
          if (viewport) viewports.push(viewport);
          return original.call(this, viewport);
        });
        await probe.close();
        const shot = await renderer.screenshot(doc, { nodeIds: [id] }, { maxDimension: 480 });
        expect([shot.width, shot.height]).toEqual([480, 480]);
        const stats = await pngStats(shot.bytes);
        expect([stats.width, stats.height, stats.distinctColors]).toEqual([480, 480, 1]);
      });
      expect(viewports.length).toBeGreaterThan(1);
      for (const v of viewports) expect(v.width * v.height * (v.deviceScaleFactor ?? 1) ** 2).toBeLessThanOrEqual(2048 ** 2);
    } finally { await renderer.close(); doc.y.destroy(); }
  }, 30_000);

  it('renders large-file covers one at a time and coalesces repeated requests', async () => {
    h = await startServer({ thumbnails: true, thumbnailDelayMs: 10 });
    let active = 0, peak = 0;
    // Install before creating files: under CPU contention a thumbnail may start between room loads.
    const spy = vi.spyOn(h.server.renderer, 'screenshot').mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 60));
      active--;
      return { bytes: new Uint8Array([1, 2, 3]), mime: 'image/webp', width: 222, height: 480, scale: 1, format: 'webp' };
    });
    const files: { id: string; cover: string }[] = [];
    for (let f = 0; f < 3; f++) {
      const file = h.server.storage.create(`Screens ${f}`);
      const room = await h.server.rooms.get(file.id);
      const page = room.doc.getPages()[0]!.id;
      let cover = '';
      room.doc.transact(() => {
        for (let i = 0; i < 24; i++) {
          const id = room.doc.insert(page, { type: 'frame', name: `Screen ${i}`, artboard: true, style: { width: '390px', height: '844px', position: 'absolute', left: `${i * 1200}px` } });
          if (!i) cover = id;
        }
      });
      room.doc.invalidate();
      cover = room.doc.getChildren(page).find((n) => n.artboard)!.id;
      files.push({ id: file.id, cover });
    }
    await until(() => files.every((f) => Boolean(h!.server.storage.get(f.id)?.thumbnail)), 5000);
    expect(peak).toBe(1);
    expect(spy).toHaveBeenCalledTimes(3);
    for (const file of files) expect(spy.mock.calls.some(([, target]) => target.nodeIds?.[0] === file.cover && !target.pageId)).toBe(true);
  });
});
