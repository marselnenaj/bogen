import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Doc } from 'yjs';
import { BogenDoc } from '@bogen/core';
import { creditsText, readImageCredits, setImageCredit } from '../src/image-credits.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';
import { creditLine, freeLicense, fromCommons, fromOpenverse, imageById, plainText, searchImages } from '../src/image-search.ts';

const openverseHit = (over: Record<string, unknown> = {}) => ({
  id: '55517f52-28ec-4d58-8175-4c5b5a4e592e', title: 'pea pod', creator: 'issyeyre', license: 'by', license_version: '2.0', license_url: 'https://creativecommons.org/licenses/by/2.0/',
  foreign_landing_url: 'https://www.flickr.com/photos/x/5087110907', url: 'https://live.staticflickr.com/4147/5087110907.jpg', thumbnail: 'https://api.openverse.org/v1/images/x/thumb/', width: 500, height: 349, source: 'flickr', ...over,
});
const commonsPage = (over: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
  pageid: 151552451, index: 1, title: 'File:Green pea pods.jpg',
  imageinfo: [{
    mime: 'image/jpeg', url: 'https://upload.wikimedia.org/wikipedia/commons/9/91/Green_pea_pods.jpg', thumburl: 'https://upload.wikimedia.org/thumb/2400px.jpg', width: 3000, height: 3000,
    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Green_pea_pods.jpg',
    extmetadata: Object.fromEntries(Object.entries({ LicenseShortName: 'CC0', LicenseUrl: 'http://creativecommons.org/publicdomain/zero/1.0/', Artist: '<a href="//commons.wikimedia.org/wiki/User:F">Fumikas &amp; Co</a>', ObjectName: 'Green pea pods', ...meta }).map(([k, v]) => [k, { value: v }])),
    ...over,
  }],
});

describe('free image search', () => {
  it('keeps only licences that allow use in a design', () => {
    expect(['cc0', 'CC0 1.0', 'pdm', 'Public domain', 'by', 'CC BY 4.0', 'CC-BY-SA-3.0', 'by-sa'].map(freeLicense)).toEqual(['CC0', 'CC0', 'Public domain', 'Public domain', 'CC BY', 'CC BY', 'CC BY-SA', 'CC BY-SA']);
    for (const c of ['by-nc', 'CC BY-NC-SA 2.0', 'by-nd', 'GFDL', 'Fair use', '']) expect(freeLicense(c)).toBeNull();
  });

  it('reads Openverse and Commons results into one shape with a credit line', () => {
    const a = fromOpenverse(openverseHit())!;
    expect(a).toMatchObject({ id: 'openverse:55517f52-28ec-4d58-8175-4c5b5a4e592e', author: 'issyeyre', license: 'CC BY', licenseName: 'CC BY 2.0', via: 'flickr', width: 500 });
    expect(a.credit).toBe('"pea pod" by issyeyre, licensed under CC BY 2.0, https://www.flickr.com/photos/x/5087110907');
    expect(fromOpenverse(openverseHit({ license: 'by-nc' }))).toBeNull();
    expect(fromOpenverse(openverseHit({ url: 'javascript:alert(1)' }))).toBeNull();
    const b = fromCommons(commonsPage())!;
    expect(b).toMatchObject({ id: 'commons:151552451', title: 'Green pea pods', author: 'Fumikas & Co', license: 'CC0', source: 'https://commons.wikimedia.org/wiki/File:Green_pea_pods.jpg' });
    expect(b.credit).toBe('"Green pea pods" by Fumikas & Co, CC0, https://commons.wikimedia.org/wiki/File:Green_pea_pods.jpg');
    expect(fromCommons(commonsPage({ width: 6000 }))!.url).toBe('https://upload.wikimedia.org/thumb/2400px.jpg');
    expect(fromCommons(commonsPage({}, { LicenseShortName: 'CC BY-NC 4.0', License: 'cc-by-nc-4.0' }))).toBeNull();
    expect(fromCommons(commonsPage({ mime: 'image/svg+xml' }))).toBeNull();
    expect(plainText('<b>A</b>&nbsp;&lt;b&gt;')).toBe('A <b>');
    expect(creditLine({ title: 'T', author: '', licenseName: 'Public Domain Mark', license: 'Public domain', source: 'https://x' })).toBe('"T", Public Domain Mark, https://x');
  });

  it('asks both providers, interleaves them, counts what it left out and reports a provider that fails', async () => {
    const urls: string[] = [];
    const out = await searchImages('pea pod', { limit: 3 }, async (url) => {
      urls.push(url);
      if (url.includes('openverse')) return { results: [openverseHit(), openverseHit({ id: 'b', license: 'by-nc' }), openverseHit({ id: 'c', title: 'second' })] };
      throw new Error('down');
    });
    expect(urls[0]).toContain('license=cc0,pdm,by,by-sa');
    expect(urls[1]).toContain('gsrsearch=filetype%3Abitmap%20pea%20pod');
    expect(out.results.map((r) => r.title)).toEqual(['pea pod', 'second']);
    expect(out.skipped).toBe(1);
    expect(out.errors).toEqual(['commons.wikimedia.org: down']);
    const both = await searchImages('pea', { limit: 4 }, async (url) => (url.includes('openverse') ? { results: [openverseHit(), openverseHit({ id: 'c' })] } : { query: { pages: { a: commonsPage() } } }));
    expect(both.results.map((r) => r.provider)).toEqual(['openverse', 'commons', 'openverse']);
  });

  it('looks a result up again by id, so the licence comes from the provider', async () => {
    const seen: string[] = [];
    const got = await imageById('commons:151552451', async (url) => { seen.push(url); return { query: { pages: { a: commonsPage() } } }; });
    expect(seen[0]).toContain('pageids=151552451');
    expect(got.license).toBe('CC0');
    await expect(imageById('openverse:x', async () => openverseHit({ license: 'by-nd' }))).rejects.toThrow(/no longer/);
    await expect(imageById('flickr:1')).rejects.toThrow(/not an id/);
    await expect(imageById('commons:abc')).rejects.toThrow(/number/);
  });

  it('keeps credits in the file, and lists only those of images it uses', () => {
    const doc = new BogenDoc(new Doc());
    setImageCredit(doc, 'a'.repeat(64) + '.jpg', fromOpenverse(openverseHit())!);
    setImageCredit(doc, 'b'.repeat(64) + '.jpg', fromCommons(commonsPage())!);
    expect(readImageCredits(doc)).toHaveLength(2);
    const only = readImageCredits(doc, new Set(['b'.repeat(64) + '.jpg']));
    expect(only.map((c) => c.license)).toEqual(['CC0']);
    expect(creditsText(only)).toBe('Image credits\n- "Green pea pods" by Fumikas & Co, CC0, https://commons.wikimedia.org/wiki/File:Green_pea_pods.jpg');
    doc.y.getMap('imageCredits').set('junk', 42);
    expect(readImageCredits(doc)).toHaveLength(2);
  });
});

describe('image_credits', () => {
  let h: Harness;
  beforeAll(async () => { h = await startServer(); });
  afterAll(() => h.cleanup());

  it('lists the credit of an image the file uses, and not of one it no longer uses', async () => {
    const agent = await connectAgent(h.base, 'credit-agent');
    const fileId = (await call(agent, 'file_create', { name: 'Credits' })).id;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const { src } = await call(agent, 'asset_upload', { data_base64: png.toString('base64'), mime_type: 'image/png' });
    const board = await call(agent, 'artboard_create', { name: 'Board', width: 200, height: 200 });
    const img = (await call(agent, 'html_write', { target_id: board.id, html: `<img src="${src}" alt="Pea" style="width:100px;height:100px">` })).ids[0];
    const doc = (await h.server.rooms.get(fileId)).doc;
    setImageCredit(doc, src.slice('bogen-asset:'.length), fromOpenverse(openverseHit())!);
    const out = await call(agent, 'image_credits', { file_id: fileId });
    expect(out.credits).toHaveLength(1);
    expect(out.text).toContain('licensed under CC BY 2.0');
    expect(out.required).toMatch(/1 of these/);
    await call(agent, 'layer_delete', { node_ids: [img] });
    expect((await call(agent, 'image_credits', { file_id: fileId })).credits).toHaveLength(0);
    const bad = await callRaw(agent, 'asset_upload', { from_search: 'flickr:1' });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]!.text).toMatch(/not an id from image_search/);
    const two = await callRaw(agent, 'asset_upload', { from_search: 'commons:1', path: '/tmp/x.png' });
    expect((two.content as { text: string }[])[0]!.text).toMatch(/one of path, data_base64 or from_search/);
    await agent.close();
  }, 60_000);
});
