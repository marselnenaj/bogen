import { deflateSync, crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PATTERN_ATTR, PATTERN_FIELD_ATTR, readPatternSpec } from '@bogen/core';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/** An unfiltered RGBA PNG. */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) line.set(pixel(x, y), 1 + x * 4);
    rows.push(line);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

describe('pattern_set', () => {
  let h: Harness;
  let fileId: string;
  beforeAll(async () => {
    h = await startServer();
    const agent = await connectAgent(h.base, 'pattern-agent');
    fileId = (await call(agent, 'file_create', { name: 'Patterns' })).id;
    await agent.close();
  }, 60_000);
  afterAll(() => h.cleanup());

  it('draws a gradient device in tokens, stores its fields, and changes only what is passed', async () => {
    const agent = await connectAgent(h.base, 'pattern-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const board = await call(agent, 'artboard_create', { name: 'Poster', width: 960, height: 540 });
    const made = await call(agent, 'pattern_set', { parent_id: board.id, columns: 32, rows: 18, cell: 'circle', fill: 'gradient', angle: 90, threshold: 0.5, colors: ['var(--pea)', 'var(--loam)'], width: 960 });
    expect(made.filled).toBeGreaterThan(0);
    const doc = (await h.server.rooms.get(fileId)).doc;
    let node = doc.getNode(made.id)!;
    expect(node.type).toBe('svg');
    expect(node.svg).toContain('var(--pea)');
    expect(node.style.height).toBe('540px');
    expect(readPatternSpec(node.attrs?.[PATTERN_ATTR])).toMatchObject({ columns: 32, cell: 'circle', angle: 90 });
    await call(agent, 'pattern_set', { node_id: made.id, cell: 'square', seed: 9 });
    node = doc.getNode(made.id)!;
    expect(readPatternSpec(node.attrs?.[PATTERN_ATTR])).toMatchObject({ columns: 32, cell: 'square', angle: 90, seed: 9 });
    expect(node.svg).toContain('<rect');
    await agent.close();
  });

  it('samples an image into a field and keeps it when only the look changes', async () => {
    const agent = await connectAgent(h.base, 'pattern-agent');
    await call(agent, 'file_open', { file_id: fileId });
    // Dark on the left half, white on the right.
    const src = (await call(agent, 'asset_upload', { data_base64: png(40, 20, (x) => (x < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255])).toString('base64'), mime_type: 'image/png' })).src;
    const made = await call(agent, 'pattern_set', { columns: 10, rows: 5, fill: 'image', image: src, threshold: 0.5, roughness: 0, x: 0, y: 600 });
    expect(made.filled).toBe(25);
    const doc = (await h.server.rooms.get(fileId)).doc;
    const field = doc.getNode(made.id)!.attrs?.[PATTERN_FIELD_ATTR];
    expect(field).toBeTruthy();
    const again = await call(agent, 'pattern_set', { node_id: made.id, invert: true });
    expect(again.filled).toBe(25);
    expect(doc.getNode(made.id)!.attrs?.[PATTERN_FIELD_ATTR]).toBe(field);
    await agent.close();
  });

  it('starts from a graphic device of the linked brand', async () => {
    const agent = await connectAgent(h.base, 'pattern-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const brand = await call(agent, 'brand_create', { name: 'Loam' });
    await call(agent, 'brand_update', { brand_id: brand.id, items: [{ section: 'devices', name: 'Seed tray', spec: { columns: 24, rows: 6, cell: 'circle', fill: 'gradient', angle: 90, invert: true, colors: ['var(--pea)'] }, use: 'Bottom band of posters' }], confirmed: true });
    await call(agent, 'brand_link', { brand_id: brand.id, file_id: fileId });
    const got = await call(agent, 'brand_get', { brand_id: brand.id });
    expect(JSON.stringify(got.brand.graphic_devices)).toContain('Seed tray');
    const made = await call(agent, 'pattern_set', { preset: 'seed tray', x: 0, y: 900, width: 480 });
    const doc = (await h.server.rooms.get(fileId)).doc;
    expect(readPatternSpec(doc.getNode(made.id)!.attrs?.[PATTERN_ATTR])).toMatchObject({ columns: 24, rows: 6, invert: true });
    expect((await callRaw(agent, 'pattern_set', { preset: 'nope' })).isError).toBe(true);
    await agent.close();
  });
});
