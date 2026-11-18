import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brandMarkdown, brandSheetHtml, readBrand, sanitizeSvgMarkup } from '@bogen/core';
import type { Rgba } from '../src/image-raster.ts';
import { applyTreatment, coerceTreatmentParams, oklab, sortInks, TREATMENT_DEFAULTS, type TreatmentParams } from '../src/image-treatment.ts';
import { resolveInk } from '../src/mcp/tools-treatment.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/** A test photo: a dark disc (the subject) on a light, slightly warm backdrop, with a green band at the bottom. */
function photo(w = 120, h = 80): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inDisc = (x - w / 2) ** 2 + (y - h / 2.5) ** 2 < (h / 4) ** 2;
      const c = inDisc ? [40, 30, 25] : y > h * 0.8 ? [60, 150, 60] : [235, 228, 210];
      data[i] = c[0]!; data[i + 1] = c[1]!; data[i + 2] = c[2]!; data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function pngOf(img: Rgba): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < img.height; y++) rows.push(Buffer.concat([Buffer.from([0]), Buffer.from(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4))]));
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const params = (p: Partial<TreatmentParams>): TreatmentParams => ({ ...TREATMENT_DEFAULTS, ...p });
const DARK = { color: '#1f2a1c', token: 'ink' };
const GREEN = { color: '#6f9a2c', token: 'pea' };
const KRAFT = { color: '#e8dcc2', token: 'kraft' };

describe('treatments', () => {
  it('sorts inks dark to light and reads lightness in OKLab', () => {
    expect(sortInks([KRAFT, DARK, GREEN]).map((i) => i.token)).toEqual(['ink', 'pea', 'kraft']);
    expect(oklab(255, 255, 255)[0]).toBeCloseTo(1, 3);
    expect(oklab(0, 0, 0)[0]).toBeCloseTo(0, 3);
  });

  it('draws halftone dots where the photo is dark, as one path per ink with token fills, the same every time', () => {
    const input = { image: photo(), params: params({ mode: 'halftone', grid: 8 }), inks: [DARK], ground: KRAFT, width: 240 };
    const a = applyTreatment(input, { svg: true });
    const b = applyTreatment(input, { svg: true });
    if (a.kind !== 'svg' || b.kind !== 'svg') throw new Error('expected svg');
    expect(a.svg).toBe(b.svg);
    expect([a.width, a.height]).toEqual([240, 160]);
    expect(a.svg).toContain('fill="var(--kraft, #e8dcc2)"');
    expect(a.svg.match(/<path /g)).toHaveLength(1);
    expect(a.svg).toContain('fill="var(--ink, #1f2a1c)"');
    expect(sanitizeSvgMarkup(a.svg)).toBe(a.svg);
    expect(a.shapes).toBeGreaterThan(50);
    // The raster of the same treatment is dark in the disc and kraft on the backdrop.
    const r = applyTreatment(input, { svg: false });
    if (r.kind !== 'raster') throw new Error('expected raster');
    const px = (x: number, y: number) => [...r.rgba.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3)];
    const centre = px(120, 64), corner = px(6, 6);
    expect(centre[0]!).toBeLessThan(120);
    expect(corner).toEqual([232, 220, 194]);
  });

  it('puts the light parts in shapes on a dark ground', () => {
    const light = applyTreatment({ image: photo(), params: params({ mode: 'mosaic', grid: 10, sparse: 1, minSize: 0.3 }), inks: [KRAFT], ground: DARK, width: 200 }, { svg: false });
    if (light.kind !== 'raster') throw new Error('expected raster');
    const at = (x: number, y: number) => light.rgba[(y * light.width + x) * 4]!;
    // The dark disc dissolves into the ground; the light backdrop stays as kraft pixels.
    expect(at(100, 53)).toBe(0x1f);
    expect(at(15, 15)).toBe(0xe8);
  });

  it('gives each colour region its own ink, and leaves out the backdrop', () => {
    const out = applyTreatment({ image: photo(), params: params({ mode: 'posterize', inkBy: 'region', drop: 'border', tolerance: 0.1 }), inks: [DARK, GREEN], width: 120 }, { svg: false });
    if (out.kind !== 'raster') throw new Error('expected raster');
    const at = (x: number, y: number) => [...out.rgba.subarray((y * 120 + x) * 4, (y * 120 + x) * 4 + 4)];
    expect(at(60, 32)).toEqual([0x1f, 0x2a, 0x1c, 255]);
    expect(at(60, 75)).toEqual([0x6f, 0x9a, 0x2c, 255]);
    expect(at(5, 5)[3]).toBe(0);
  });

  it('dithers to the inks only, ordered and by error diffusion, and as SVG runs', () => {
    for (const dither of ['bayer4', 'bayer8', 'floyd-steinberg', 'atkinson'] as const) {
      const out = applyTreatment({ image: photo(), params: params({ mode: 'dither', grid: 2, dither }), inks: [DARK, GREEN, KRAFT], width: 120 }, { svg: false });
      if (out.kind !== 'raster') throw new Error('expected raster');
      const seen = new Set<string>();
      for (let i = 0; i < out.rgba.length; i += 4) seen.add(`${out.rgba[i]},${out.rgba[i + 1]},${out.rgba[i + 2]}`);
      expect([...seen].every((c) => ['31,42,28', '111,154,44', '232,220,194'].includes(c))).toBe(true);
    }
    const svg = applyTreatment({ image: photo(), params: params({ mode: 'dither', grid: 4 }), inks: [DARK, KRAFT], width: 120 }, { svg: true });
    expect(svg.kind).toBe('svg');
  });

  it('ramps duotone through the inks, and refuses SVG for pixel modes and bad colours', () => {
    const out = applyTreatment({ image: photo(), params: params({ mode: 'duotone' }), inks: [DARK, KRAFT], width: 60 }, { svg: false });
    if (out.kind !== 'raster') throw new Error('expected raster');
    expect(out.height).toBe(40);
    expect(() => applyTreatment({ image: photo(), params: params({ mode: 'duotone' }), inks: [DARK], width: 60 }, { svg: true })).toThrow(/gives pixels/);
    expect(() => applyTreatment({ image: photo(), params: params({ mode: 'halftone' }), inks: [{ color: 'red' }], width: 60 }, { svg: true })).toThrow(/#rrggbb/);
    expect(() => applyTreatment({ image: photo(), params: params({ mode: 'halftone', grid: 1 }), inks: [DARK], width: 4000 }, { svg: true })).toThrow(/larger grid/);
  });

  it('thins cells toward a side with falloff, and reads presets within limits', () => {
    const count = (falloff: TreatmentParams['falloff']) => {
      const r = applyTreatment({ image: photo(), params: params({ mode: 'mosaic', grid: 6, falloff, falloffAmount: 1 }), inks: [DARK, GREEN, KRAFT], width: 240 }, { svg: true });
      return r.kind === 'svg' ? r.shapes : 0;
    };
    expect(count('bottom')).toBeLessThan(count('none') * 0.75);
    const p = coerceTreatmentParams({ mode: 'bogus', grid: 9999, inkBy: 'region', seed: -3, extra: 'x' });
    expect(p).toMatchObject({ mode: 'halftone', grid: 400, inkBy: 'region', seed: 0 });
    expect(p).not.toHaveProperty('extra');
  });

  it('resolves inks from the brand, tokens and CSS colours', () => {
    const tokens = new Map([['ground', '#f0ead8']]);
    expect(resolveInk('var(--ground)', null, tokens)).toEqual({ color: '#f0ead8', token: 'ground' });
    expect(resolveInk('#123456', null, tokens)).toEqual({ color: '#123456' });
    expect(() => resolveInk('sunshine', null, tokens)).toThrow(/not a colour/);
  });
});

describe('image_treatment', () => {
  let h: Harness;
  let fileId: string;
  let imageId: string;
  let brandId: string;
  let src: string;
  let photoId: string;

  beforeAll(async () => {
    h = await startServer();
    const agent = await connectAgent(h.base, 'treatment-agent');
    fileId = (await call(agent, 'file_create', { name: 'Treatments' })).id;
    brandId = (await call(agent, 'brand_create', { name: 'Loam' })).id;
    await call(agent, 'brand_update', {
      brand_id: brandId, confirmed: true,
      items: [{ section: 'colors', name: 'Kraft', role: 'ground', value: '#e8dcc2', token: 'kraft' }, { section: 'colors', name: 'Earth', role: 'ink', value: '#2a2019', token: 'earth' }, { section: 'colors', name: 'Pea', role: 'accent', value: '#6f9a2c', token: 'pea' }],
    });
    await call(agent, 'brand_link', { brand_id: brandId, file_id: fileId });
    src = (await call(agent, 'asset_upload', { data_base64: pngOf(photo()).toString('base64'), mime_type: 'image/png' })).src;
    const board = await call(agent, 'artboard_create', { name: 'Board', width: 800, height: 400 });
    imageId = (await call(agent, 'html_write', { target_id: board.id, html: `<img src="${src}" alt="A pea" style="position:absolute;left:20px;top:20px;width:240px;height:160px">` })).ids[0];
    await agent.close();
  }, 60_000);

  afterAll(() => h.cleanup());

  it('makes an SVG beside the photo in brand colours, saves it as a preset, and applies the preset to another photo', async () => {
    const agent = await connectAgent(h.base, 'treatment-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const out = await call(agent, 'image_treatment', { node_id: imageId, mode: 'halftone', inks: ['Earth', 'pea'], ground: 'ground', settings: { grid: 8, inkBy: 'region' }, save_preset: { name: 'Seed tray' } });
    const doc = (await h.server.rooms.get(fileId)).doc;
    const node = doc.getNode(out.id)!;
    expect(node.type).toBe('svg');
    expect(node.svg).toContain('var(--earth, #2a2019)');
    expect(node.svg).toContain('var(--kraft, #e8dcc2)');
    expect(node.style).toMatchObject({ position: 'absolute', left: '284px', width: '240px', height: '160px' });
    expect(node.attrs).toMatchObject({ 'aria-label': 'A pea', role: 'img' });
    expect(out.saved_preset).toMatchObject({ brand_id: brandId, suggested: true });

    const brand = readBrand((await h.server.brands.read(brandId)).room.doc);
    expect(brand.treatments).toHaveLength(1);
    const preset = brand.treatments[0]!;
    expect(preset).toMatchObject({ name: 'Seed tray', mode: 'halftone', inks: ['Earth', 'pea'], ground: 'ground', output: 'svg', before: src, suggested: true });
    expect(preset.params).toMatchObject({ grid: 8, inkBy: 'region' });
    expect(preset.after).toMatch(/^bogen-asset:[a-f0-9]{64}\.png$/);
    expect(brandMarkdown(brand)).toMatch(/## Image treatment[\s\S]*Seed tray \(suggestion\) \| halftone/);
    expect(brandSheetHtml(brand)).toContain('Imagery and icons');
    expect(brandSheetHtml(brand)).toContain('Seed tray');

    const again = await call(agent, 'image_treatment', { node_id: imageId, preset: 'seed tray', output: 'raster', replace: true });
    const raster = doc.getNode(again.id)!;
    expect(raster.type).toBe('image');
    expect(raster.src).toMatch(/^bogen-asset:/);
    expect(raster.style).toMatchObject({ left: '20px' });
    expect(doc.getNode(imageId)).toBeUndefined();
    photoId = again.id;
    await agent.close();
  }, 60_000);

  it('vectorizes to the brand palette only, with token fills', async () => {
    const agent = await connectAgent(h.base, 'treatment-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const out = await call(agent, 'image_vectorize', { node_id: photoId, palette: 'brand', detail: 'low' });
    const doc = (await h.server.rooms.get(fileId)).doc;
    const fills = new Set([...doc.getNode(out.id)!.svg!.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]));
    expect(fills.size).toBeGreaterThan(0);
    for (const f of fills) expect(['var(--kraft, #e8dcc2)', 'var(--earth, #2a2019)', 'var(--pea, #6f9a2c)']).toContain(f);
    await agent.close();
  }, 60_000);

  it('gives the photos of a brand presentation the brand\'s saved treatment', async () => {
    const agent = await connectAgent(h.base, 'treatment-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const story = { idea: 'Borrow a season.', photos: [src, src, src], photo_preset: 'Seed tray', photo_rule: 'Real plots and hands from the neighbourhood.', rationale: { photography: 'Printed in the library\'s own inks.' } };
    const out = await call(agent, 'brand_presentation', { story, output: 'deck' });
    const doc = (await h.server.rooms.get(fileId)).doc;
    const srcs = doc.getChildren(out.outputs[0].page_id).flatMap((b) => doc.descendants(b.id)).map((n) => n.src ?? '').filter((s) => s.startsWith('bogen-asset:'));
    expect(out.outputs[0].skipped.map((s: { slide: string }) => s.slide)).not.toContain('Photography');
    expect(srcs.length).toBeGreaterThan(0);
    expect(srcs).not.toContain(src);
    const r = await callRaw(agent, 'brand_presentation', { story: { ...story, photo_preset: 'nope' }, output: 'deck' });
    expect(r.isError).toBe(true);
    await agent.close();
  }, 120_000);

  it('says what is wrong: no image, no mode, unknown preset, unknown colour, unknown setting', async () => {
    const agent = await connectAgent(h.base, 'treatment-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const image = { id: photoId };
    const err = async (args: Record<string, unknown>) => {
      const r = await callRaw(agent, 'image_treatment', { node_id: image.id, ...args });
      expect(r.isError).toBe(true);
      return (r.content as { text: string }[]).map((c) => c.text).join('');
    };
    expect(await err({})).toMatch(/Give mode/);
    expect(await err({ preset: 'nope' })).toMatch(/has: Seed tray/);
    expect(await err({ mode: 'halftone', inks: ['sunshine'] })).toMatch(/Kraft, Earth, Pea/);
    expect(await err({ mode: 'duotone', inks: ['Earth'], output: 'svg' })).toMatch(/gives pixels/);
    expect(await err({ mode: 'halftone', inks: ['Earth'], settings: { size: 3 } })).toMatch(/size|Unrecognized/i);
    await agent.close();
  }, 60_000);
});

