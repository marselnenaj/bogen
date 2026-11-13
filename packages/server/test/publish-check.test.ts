import { crc32, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

/** A real, plain PNG of a size. */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('publish_check', () => {
  it('checks a page offline, calls only breakage an error, and web_page_set fills the head', async () => {
    const h = await startServer({ publishFetch: null });
    harnesses.push(h);
    const agent = await connectAgent(h.base, 'claude');
    const file = await call(agent, 'file_create', { name: 'Trains' });
    const board = await call(agent, 'artboard_create', { name: 'Night trains', width: 1200 });
    const picture = await call(agent, 'asset_upload', { data_base64: makePng(40, 20).toString('base64'), mime_type: 'image/png' });
    await call(agent, 'html_write', { target_id: board.id, html: `<main><h1>Night trains</h1><a href="#prices">Prices</a><img alt="Compartment" src="${picture.src}" style="width:100%"></main>` });

    const first = await call(agent, 'publish_check', { node_id: board.id, summaries: false });
    expect(first.checked).toMatchObject({ version: null, offline_build: true, node_id: board.id });
    expect(first.findings.filter((f: { level: string }) => f.level === 'error').map((f: { check: string }) => f.check).sort()).toEqual(['anchor', 'lang']);
    expect(first.findings.map((f: { check: string }) => f.check)).toEqual(expect.arrayContaining(['description', 'canonical', 'og-image', 'favicon']));
    // Publishing reads the picture's own size, so the box is reserved: no image-size warning.
    expect(first.findings.map((f: { check: string }) => f.check)).not.toContain('image-size');
    expect(first.headline).toMatch(/2 problems/);

    const og = await call(agent, 'asset_upload', { data_base64: makePng(1200, 630).toString('base64'), mime_type: 'image/png' });
    const set = await call(agent, 'web_page_set', {
      node_id: board.id, description: 'Sleeper trains from Vienna to eleven cities, with prices and timetables for every night.',
      lang: 'de-at', canonical: 'https://trains.example/', og_image: og.src, favicon: picture.src,
    });
    expect(set).toMatchObject({ lang: 'de-AT', canonical: 'https://trains.example/', title: 'Night trains' });
    await expect(call(agent, 'web_page_set', { node_id: board.id, canonical: 'trains.example' })).rejects.toThrow(/full address/);
    await expect(call(agent, 'web_page_set', { node_id: board.id, lang: 'klingon!' })).rejects.toThrow(/language tag/);

    const second = await call(agent, 'publish_check', { node_id: board.id, summaries: false });
    expect(second.findings.filter((f: { level: string }) => f.level !== 'note').map((f: { check: string }) => f.check)).toEqual(['anchor']);
    expect(second.pages[0]).toMatchObject({ lang: 'de-AT', canonical: 'https://trains.example/', ogImage: expect.stringMatching(/^https:\/\/trains\.example\/assets\/.+\.png$/) });

    // A hidden picture adds no file to the site, also now that published images get their size.
    const secret = await call(agent, 'asset_upload', { data_base64: makePng(30, 30).toString('base64'), mime_type: 'image/png' });
    const hidden = (await call(agent, 'html_write', { target_id: board.id, html: `<img alt="Draft" src="${secret.src}">` })).ids[0];
    await call(agent, 'layer_set_flags', { node_ids: [hidden], hidden: true });

    // The same through the editor's route, with summaries, for a prepared version too.
    const prepared = await call(agent, 'publish_prepare', { node_id: board.id });
    const files = await (await fetch(`${h.base}/api/publish/versions/${prepared.version_id}/files`)).json() as { path: string }[];
    expect(files.filter((f) => f.path.startsWith('assets/'))).toHaveLength(2);
    const res = await fetch(`${h.base}/api/publish/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: prepared.version_id }) });
    expect(res.status).toBe(200);
    const routed = await res.json();
    expect(routed.checked).toMatchObject({ version: prepared.version_id, offline_build: false });
    expect(routed.counts.errors).toBe(1);
    expect(routed.summaries.a11y).toHaveProperty('issues');
    expect(routed.summaries.responsive).toHaveProperty('widths');
    expect(routed.summaries.brand).toEqual({ skipped: 'The file links no brand.' });
    void file;
    await agent.close();
  }, 60_000);
});
