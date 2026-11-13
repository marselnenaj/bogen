import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sanitizeSvgMarkup, type BogenDoc } from '@bogen/core';
import { decodePng, downscale, imageSize } from '../src/image-raster.ts';
import { findBrowser } from '../src/render.ts';
import { vectorizeBytes } from '../src/vectorize.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

type Px = [number, number, number, number];

/** A PNG with each row under another filter, so that decoding them all is tried. */
function png(width: number, height: number, pixel: (x: number, y: number) => Px, kind: 'rgba' | 'palette' | 'gray' = 'rgba'): Buffer {
  const palette: Px[] = [];
  const channels = kind === 'rgba' ? 4 : 1;
  const stride = width * channels;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      if (kind === 'rgba') line.set(p, x * 4);
      else if (kind === 'gray') line[x] = p[0];
      else {
        let i = palette.findIndex((q) => q.every((v, k) => v === p[k]));
        if (i < 0) i = palette.push(p) - 1;
        line[x] = i;
      }
    }
    const filter = y % 5;
    const out = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels]! : 0;
      const up = prev[i]!;
      const corner = i >= channels ? prev[i - channels]! : 0;
      const pa = Math.abs(up - corner), pb = Math.abs(left - corner), pc = Math.abs(left + up - 2 * corner);
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      const pred = [0, left, up, (left + up) >> 1, paeth][filter]!;
      out[i] = (line[i]! - pred) & 0xff;
    }
    rows.push(Buffer.concat([Buffer.from([filter]), out]));
    prev = line;
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = kind === 'rgba' ? 6 : kind === 'gray' ? 0 : 3;
  const extra = kind === 'palette' ? [chunk('PLTE', Buffer.from(palette.flatMap((p) => p.slice(0, 3)))), chunk('tRNS', Buffer.from(palette.map((p) => p[3])))] : [];
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** Three flat areas, a red left half and a blue and a white quarter, with a transparent corner. */
const flag = (x: number, y: number, w = 64, h = 48): Px => (x < 6 && y < 6 ? [0, 0, 0, 0] : x < w / 2 ? [220, 30, 30, 255] : y < h / 2 ? [30, 60, 220, 255] : [250, 250, 250, 255]);

describe('raster helpers', () => {
  it('decodes PNG of every filter, with a palette and in grey', () => {
    for (const kind of ['rgba', 'palette', 'gray'] as const) {
      const img = decodePng(png(20, 12, (x, y) => flag(x, y, 20, 12), kind));
      expect([img.width, img.height]).toEqual([20, 12]);
      const at = (x: number, y: number) => [...img.data.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 4)];
      if (kind === 'gray') expect(at(15, 10)).toEqual([250, 250, 250, 255]);
      else {
        expect(at(8, 8)).toEqual([220, 30, 30, 255]);
        expect(at(15, 2)).toEqual([30, 60, 220, 255]);
        expect(at(1, 1)[3]).toBe(0);
      }
    }
    expect(() => decodePng(Buffer.from('not a png'))).toThrow();
  });

  it('reads sizes from headers, and scales down by area', () => {
    expect(imageSize(png(30, 7, () => [0, 0, 0, 255]))).toEqual({ width: 30, height: 7 });
    // A JPEG start with an APP0 segment and then a baseline frame of 640 by 480.
    const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc000110801e002800301220002110103110100', 'hex');
    expect(imageSize(jpeg)).toEqual({ width: 640, height: 480 });
    expect(imageSize(Buffer.from('nothing'))).toBeNull();
    const big = decodePng(png(100, 50, flag));
    const small = downscale(big, 1250);
    expect([small.width, small.height]).toEqual([50, 25]);
  });
});

describe('vectorize', () => {
  it('traces a PNG into a valid, sanitized SVG with paths', async () => {
    const out = await vectorizeBytes(png(64, 48, flag), undefined, { colors: 4 });
    expect(out.svg.startsWith('<svg')).toBe(true);
    expect(out.svg).toContain('viewBox="0 0 64 48"');
    expect(out.paths).toBeGreaterThanOrEqual(3);
    expect([out.width, out.height]).toEqual([64, 48]);
    // Sanitized already: a second pass changes nothing, and nothing in it can run.
    expect(sanitizeSvgMarkup(out.svg)).toBe(out.svg);
    expect(out.svg).not.toMatch(/<script|\son\w+=|javascript:|<foreignObject/i);
    expect(out.svg).toMatch(/fill="rgb\(220,30,30\)"/);
    // The transparent corner is no shape of its own.
    expect(out.svg).not.toMatch(/opacity="0"/);
  });

  it('keeps to the number of colours, and refuses what is no image', async () => {
    const noisy = png(48, 48, (x, y) => [(x * 37 + y * 11) % 256, (x * 7 + y * 53) % 256, (x * y) % 256, 255]);
    const two = await vectorizeBytes(noisy, undefined, { colors: 2, detail: 'low' });
    expect(two.colors).toBeLessThanOrEqual(2);
    const eight = await vectorizeBytes(noisy, undefined, { colors: 8, detail: 'high' });
    expect(eight.colors).toBeLessThanOrEqual(8);
    expect(eight.colors).toBeGreaterThan(two.colors);
    await expect(vectorizeBytes(Buffer.from('<svg onload="x()"></svg>'), undefined)).rejects.toThrow(/Only PNG/);
  });
});

describe('image tools', () => {
  let h: Harness;
  let fileId: string;
  let doc: BogenDoc;
  let src: string;
  let imageId: string;

  beforeAll(async () => {
    h = await startServer();
    const agent = await connectAgent(h.base, 'images-agent');
    fileId = (await call(agent, 'file_create', { name: 'Images' })).id;
    src = (await call(agent, 'asset_upload', { data_base64: png(120, 60, (x, y) => flag(x, y, 120, 60)).toString('base64'), mime_type: 'image/png' })).src;
    const board = await call(agent, 'artboard_create', { name: 'Board', width: 600, height: 400 });
    const written = await call(agent, 'html_write', { target_id: board.id, html: `<img src="${src}" alt="Flag" style="position:absolute;left:20px;top:20px;width:240px;height:120px">` });
    imageId = written.ids[0];
    doc = (await h.server.rooms.get(fileId)).doc;
    await agent.close();
  }, 60_000);

  afterAll(() => h.cleanup());

  it('suggests palettes with roles and contrast from a subject, a seed and a stored image, ready for tokens_set', async () => {
    const agent = await connectAgent(h.base, 'palette-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const fromImage = await call(agent, 'palette_suggest', { image: imageId });
    expect(fromImage.palettes[0].source).toBe('image');
    expect((await call(agent, 'palette_suggest', { image: src })).palettes[0].tokens).toEqual(fromImage.palettes[0].tokens);
    const mixed = await call(agent, 'palette_suggest', { subject: 'swimming school', seed: '#2f8fa6', dark: true, prefix: 'x-' });
    expect(mixed.palettes.map((p: any) => p.source)).toEqual(expect.arrayContaining(['seed', 'subject']));
    for (const p of mixed.palettes) for (const pair of p.pairs.filter((x: any) => x.fg.includes('ink'))) expect(pair.wcag).toBeGreaterThanOrEqual(4.5);
    const tokens = mixed.palettes[0].tokens;
    expect(tokens[0].name).toBe('x-ground');
    await call(agent, 'tokens_set', { tokens });
    expect((await h.server.rooms.get(fileId)).doc.getTokens().some((t) => t.name === 'x-ground')).toBe(true);
    expect((await callRaw(agent, 'palette_suggest', {})).isError).toBe(true);
    await agent.close();
  });

  it('points tokens_set at palette_suggest when a session sets colours without it, once it has not been asked', async () => {
    const agent = await connectAgent(h.base, 'colour-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const colours = [{ name: 'c-ground', kind: 'color', value: '#f6f6f6' }, { name: 'c-action', kind: 'color', value: '#2563eb' }];
    expect((await call(agent, 'tokens_set', { tokens: colours })).next).toContain('palette_suggest');
    // One colour, or other kinds, need no palette.
    expect((await call(agent, 'tokens_set', { tokens: [{ name: 'c-one', kind: 'color', value: '#111111' }] })).next).toBeUndefined();
    expect((await call(agent, 'tokens_set', { tokens: [{ name: 's-1', kind: 'spacing', value: '8px' }, { name: 's-2', kind: 'spacing', value: '16px' }] })).next).toBeUndefined();
    await call(agent, 'palette_suggest', { seed: '#2563eb' });
    expect((await call(agent, 'tokens_set', { tokens: colours })).next).toBeUndefined();
    await agent.close();
  });

  it('crops to a preset and makes the height follow', async () => {
    const agent = await connectAgent(h.base, 'crop-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const out = await call(agent, 'image_crop', { node_id: imageId, aspect: '1:1' });
    expect(out.crop).toBe('0.25 0 0.5 1');
    expect(out.height).toBe('240px');
    expect(out.image).toEqual({ width: 120, height: 60 });
    expect(doc.getNode(imageId)!.attrs?.['data-crop']).toBe('0.25 0 0.5 1');
    const free = await call(agent, 'image_crop', { node_id: imageId, crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, fit_height: false });
    expect(free.crop).toBe('0 0 0.5 0.5');
    const wrong = await callRaw(agent, 'image_crop', { node_id: imageId, crop: { x: 0.8, y: 0, w: 0.5, h: 1 } });
    expect(wrong.isError).toBe(true);
    await call(agent, 'image_crop', { node_id: imageId, reset: true });
    expect(doc.getNode(imageId)!.attrs?.['data-crop']).toBeUndefined();
    await call(agent, 'image_crop', { node_id: imageId, crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } });
    await agent.close();
  });

  it('sets filters and keeps others', async () => {
    const agent = await connectAgent(h.base, 'filter-agent');
    await call(agent, 'file_open', { file_id: fileId });
    await call(agent, 'layer_style', { node_ids: [imageId], style: { filter: 'drop-shadow(0 0 2px rgb(0 0 0))' } });
    const out = await call(agent, 'image_filter', { node_id: imageId, brightness: 120, grayscale: 30 });
    expect(out.filter).toBe('drop-shadow(0 0 2px rgb(0 0 0)) brightness(120%) grayscale(30%)');
    expect(out.saturation).toBe(100);
    const reset = await call(agent, 'image_filter', { node_id: imageId, reset: true });
    expect(reset.filter).toBe('drop-shadow(0 0 2px rgb(0 0 0))');
    await call(agent, 'image_filter', { node_id: imageId, contrast: 80, blur: 1 });
    expect(doc.getNode(imageId)!.style.filter).toBe('drop-shadow(0 0 2px rgb(0 0 0)) contrast(80%) blur(1px)');
    await agent.close();
  });

  it('vectorizes a stored image next to it, and only stored images', async () => {
    const agent = await connectAgent(h.base, 'vector-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const out = await call(agent, 'image_vectorize', { node_id: imageId, colors: 4, detail: 'medium' });
    const node = doc.getNode(out.id)!;
    expect(node.type).toBe('svg');
    expect(node.name).toBe(`${doc.getNode(imageId)!.name} (vector)`);
    expect(node.svg).toContain('<path');
    expect(sanitizeSvgMarkup(node.svg!)).toBe(node.svg);
    expect(node.style).toMatchObject({ position: 'absolute', left: '284px', top: '20px', width: '240px', height: '120px' });
    expect(out.colors).toBeLessThanOrEqual(4);
    const res = await fetch(`${h.base}/api/assets/vectorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ src, colors: 3 }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { svg: string }).svg).toContain('<path');
    const outside = await fetch(`${h.base}/api/assets/vectorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ src: 'http://127.0.0.1:1/secret.png' }) });
    expect(outside.status).toBe(400);
    expect(await outside.text()).toMatch(/stored in Bogen/);
    await agent.close();
  }, 60_000);

  it.skipIf(!findBrowser())('keeps crop and filters in PNG and SVG exports', async () => {
    const svg = await fetch(`${h.base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeIds: [imageId], format: 'svg' }) });
    expect(svg.status).toBe(200);
    const text = await svg.text();
    // A filter other than blur goes over as HTML in the SVG, with its CSS, crop included.
    expect(text).toMatch(/background-size: ?200% 200%|<image[^>]*clip-path/);
    const shot = await fetch(`${h.base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeIds: [imageId], format: 'png' }) });
    expect(shot.status).toBe(200);
    const pixels = decodePng(new Uint8Array(await shot.arrayBuffer()));
    // The crop shows the blue quarter only: no red in the middle of it.
    const i = (Math.floor(pixels.height / 2) * pixels.width + Math.floor(pixels.width / 2)) * 4;
    const [r, , b] = [...pixels.data.subarray(i, i + 3)];
    expect(b!).toBeGreaterThan(r!);
  }, 60_000);

  it.skipIf(!findBrowser())('vectorizes a JPEG, decoded in the renderer', async () => {
    const res = await fetch(`${h.base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeIds: [imageId], format: 'jpg' }) });
    const jpeg = new Uint8Array(await res.arrayBuffer());
    expect(imageSize(jpeg)).toBeTruthy();
    const out = await vectorizeBytes(jpeg, h.server.renderer, { colors: 3, detail: 'low' });
    expect(out.svg).toContain('<path');
    expect(out.colors).toBeLessThanOrEqual(3);
    expect([out.width, out.height]).toEqual([imageSize(jpeg)!.width, imageSize(jpeg)!.height]);
  }, 60_000);

  it.skipIf(!findBrowser())('draws a cropped image natively in a vector SVG', async () => {
    const agent = await connectAgent(h.base, 'vector-export-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const board = await call(agent, 'artboard_create', { name: 'Plain', width: 300, height: 300, x: 1200 });
    const written = await call(agent, 'html_write', { target_id: board.id, html: `<img src="${src}" data-crop="0.5 0 0.5 0.5" style="width:120px;height:60px;filter:blur(1px)">` });
    const res = await fetch(`${h.base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeIds: [written.ids[0]], format: 'svg' }) });
    const text = await res.text();
    expect(text).toMatch(/<image[^>]*x="-?[\d.]+"[^>]*width="240"[^>]*height="120"[^>]*clip-path/);
    await agent.close();
  }, 60_000);
});
