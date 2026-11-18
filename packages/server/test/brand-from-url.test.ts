import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importHtml, readBrand } from '@bogen/core';
import { startServer, type Harness } from './helpers.ts';

let h: Harness;
beforeAll(async () => { h = await startServer({ thumbnails: false }); });
afterAll(async () => { await h.cleanup(); });

const post = (path: string, body: unknown) => fetch(`${h.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function until(id: string) {
  for (let i = 0; i < 200; i++) {
    const job = await (await fetch(`${h.base}/api/brands/jobs/${id}`)).json() as { state: string };
    if (job.state !== 'running') return job as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('The job did not end.');
}

describe('a brand from a website address', () => {
  it('captures, reads and saves everything as suggestions in a new draft brand', async () => {
    // The page as the capture would place it; the network is not used in tests.
    h.server.capturePageInto = async (fileId) => {
      const room = await h.server.brands.room(fileId);
      const doc = room.doc;
      const pageId = doc.createPage('Reference');
      const node = importHtml(`<main style="width:1440px;height:900px;background:#f4f2ec;font-family:Georgia, serif"><h1 style="color:#c23b22;font-size:64px">Kiln</h1><p style="color:#1c1c1a;font-size:18px">Pots for daily use.</p><a style="background:#c23b22;color:#ffffff;padding:12px 16px">Shop</a></main>`).nodes[0]!;
      const nodeId = doc.insert(pageId, node);
      return { nodeId, pageId, title: 'Kiln', layers: 4 } as never;
    };
    const res = await post('/api/brands/from-url', { url: 'https://kiln.example/' });
    expect(res.status).toBe(202);
    const started = await res.json() as { id: string; brandId: string; brandName: string };
    expect(started.brandName).toBe('kiln.example');
    const job = await until(started.id);
    expect(['ready', 'partial']).toContain(job.state);
    const data = readBrand((await h.server.brands.read(started.brandId)).room.doc);
    expect(data.colors.length).toBeGreaterThan(0);
    // Nothing binds until the person confirms it.
    expect(data.colors.every((c) => c.suggested)).toBe(true);
    expect(data.artboards[0]).toMatchObject({ suggested: true, source: 'capture:https://kiln.example/' });
  }, 60_000);

  it('removes the brand it made when the page cannot be loaded, and keeps the message', async () => {
    h.server.capturePageInto = async () => { throw new Error('Could not load https://gone.example/: 404'); };
    const before = (await h.server.brands.list()).length;
    const started = await (await post('/api/brands/from-url', { url: 'https://gone.example/' })).json() as { id: string; brandId: string };
    const job = await until(started.id);
    expect(job).toMatchObject({ state: 'failed', error: 'Could not load https://gone.example/: 404' });
    expect((await h.server.brands.list()).length).toBe(before);
  });

  it('refuses what is not a website address', async () => {
    expect((await post('/api/brands/from-url', { url: 'file:///etc/passwd' })).status).toBe(400);
    expect((await post('/api/brands/from-url', { url: 'not a url' })).status).toBe(400);
    expect((await fetch(`${h.base}/api/brands/jobs/nope`)).status).toBe(404);
  });
});
