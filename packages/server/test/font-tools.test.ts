import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as opentype from 'opentype.js';
import { getFontFaces, getGlyphFonts } from '@bogen/core';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

let h: Harness;
beforeAll(async () => { h = await startServer(); });
afterAll(async () => { await h.cleanup(); });

const H = 'M60 100H180V420H420V100H540V800H420V530H180V800H60Z';
const O = 'M50 94H560V806H50ZM170 214H440V686H170Z';
const A = 'M20 800L240 100H380L600 800H470L420 640H200L150 800ZM235 530H385L310 290Z';
const V = 'M20 100H150L310 640L470 100H600L380 800H240Z';

function fontFile(dir: string, license: string, copyright: string, family: string): string {
  const path = new opentype.Path();
  path.moveTo(50, 0); path.lineTo(50, 700); path.lineTo(450, 700); path.lineTo(450, 0); path.close();
  const f = new opentype.Font({
    familyName: family, styleName: 'Regular', unitsPerEm: 1000, ascender: 760, descender: -240, license, copyright,
    glyphs: [new opentype.Glyph({ name: '.notdef', advanceWidth: 500, path: new opentype.Path() }), new opentype.Glyph({ name: 'H', unicode: 0x48, advanceWidth: 520, path })],
  });
  const file = join(dir, `${family.replace(/\s/g, '')}.otf`);
  writeFileSync(file, Buffer.from(f.toArrayBuffer()));
  return file;
}

describe('font tools', () => {
  it('make a glyph page, write glyphs, kern, build a font the file uses, list it and set a specimen', async () => {
    const agent = await connectAgent(h.base, 'claude-code');
    const file = await call(agent, 'file_create', { name: 'Fonts' });
    const made = await call(agent, 'font_create', { family: 'Test Display', style: 'Bold', weight: 700, file_id: file.id });
    expect(made.y).toEqual({ ascender: 0, cap_height: 100, x_height: 300, baseline: 800, descender: 1000 });

    const set = await call(agent, 'font_glyphs_set', { glyphs: [
      { char: 'H', advance: 600, d: H }, { char: 'O', advance: 610, d: O, fill_rule: 'evenodd' }, { char: 'A', advance: 620, d: A, fill_rule: 'evenodd' },
      { char: 'V', advance: 620, d: V }, { char: ' ', advance: 250, d: '' },
    ] });
    expect(set.glyphs.map((g: { name: string }) => g.name)).toEqual(['H', 'O', 'A', 'V', 'space']);
    expect(set.glyphs[0].bounds).toEqual({ left: 60, right: 540, bottom: 0, top: 700, right_side_bearing: 60 });
    expect(set.glyphs[4].empty).toBe(true);
    // Same direction, nonzero: the counter would fill in, and the agent hears it.
    const filled = await call(agent, 'font_glyphs_set', { glyphs: [{ char: 'O', d: 'M50 94H560V806H50ZM170 214H440V686H170Z' }] });
    expect(filled.glyphs[0].notes.join(' ')).toMatch(/fills in/);
    await call(agent, 'font_glyphs_set', { glyphs: [{ char: 'O', d: O, fill_rule: 'evenodd' }] });

    await call(agent, 'font_kerning_set', { pairs: [{ left: 'A', right: 'V', value: -60 }, { left: 'V', right: 'A', value: -60 }] });
    const built = await call(agent, 'font_build', {});
    expect(built).toMatchObject({ family: 'Test Display', glyphs: 6, kerning_pairs: 2, css: 'font-family: "Test Display", sans-serif' });
    expect(built.woff2).toMatch(/^bogen-asset:[a-f0-9]{64}\.woff2$/);
    const otfBytes = (await h.server.storage.readAsset(built.otf.slice('bogen-asset:'.length)))!.bytes;
    const otf = opentype.parse(otfBytes.buffer.slice(otfBytes.byteOffset, otfBytes.byteOffset + otfBytes.byteLength) as ArrayBuffer);
    expect(otf.getKerningValue(otf.charToGlyph('A'), otf.charToGlyph('V'))).toBe(-60);

    const room = await h.server.rooms.get(file.id);
    expect(getFontFaces(room.doc)).toEqual([expect.objectContaining({ family: 'Test Display', weight: '700', src: built.woff2 })]);

    const list = await call(agent, 'fonts_made', {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ family: 'Test Display', glyphs: 5, drawn: 4, build: { current: true } });

    // A change after the build shows as not current, and the specimen builds again.
    await call(agent, 'font_glyphs_set', { glyphs: [{ char: 'H', advance: 640 }] });
    expect((await call(agent, 'fonts_made', {}))[0].build.current).toBe(false);
    const specimen = await call(agent, 'font_specimen', { words: 'HAVO' });
    expect(specimen.built).toBe(true);
    const tree = await call(agent, 'layer_tree', { node_id: specimen.id, depth: 3 });
    expect(tree).toMatch(/Test Display specimen/);
    expect(tree).toMatch(/Your words/);

    // The editor's Build font does the same, as the person's step.
    const font = getGlyphFonts(room.doc)[0]!;
    const res = await fetch(`${h.base}/api/files/${file.id}/glyph-fonts/${font.id}/build`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ family: 'Test Display', glyphs: 6 });

    // Undo takes the agent's last step back, the specimen here.
    await call(agent, 'agent_undo', {});
    expect(room.doc.getNode(specimen.id)).toBeUndefined();

    const guide = await call(agent, 'guide_get', { topic: 'fonts' });
    expect(guide).toMatch(/HOH/);
    await agent.close();
  });

  it('takes a glyph from a traced vector: the ink only, fitted to the cap height on the baseline', async () => {
    const agent = await connectAgent(h.base, 'claude-code');
    await call(agent, 'file_create', { name: 'Traced' });
    const board = await call(agent, 'artboard_create', { name: 'Drawing', width: 400, height: 400 });
    // As image_vectorize leaves it: the paper as a light shape behind the dark letter.
    const svg = await call(agent, 'html_write', { target_id: board.id, html: '<svg viewBox="0 0 200 300" style="width:200px;height:300px"><path d="M0 0H200V300H0Z" fill="#f4f2ec"/><path d="M40 20H90V280H40Z" fill="#111111"/></svg>' });
    const svgId = (svg.tree as string).match(/(\w+) svg/)?.[1];
    await call(agent, 'font_create', { family: 'Traced Hand' });
    const out = await call(agent, 'font_glyphs_set', { glyphs: [{ char: 'I', from_layer: svgId, side_bearing: 50 }] });
    expect(out.glyphs[0].bounds).toMatchObject({ left: 50, bottom: 0, top: 700 });
    // 50 wide in a 260 tall drawing, scaled to 700: about 135 units, with 50 either side.
    expect(out.glyphs[0].advance).toBe(Math.round((50 * 700) / 260 + 100));
    await agent.close();
  });

  it('gives a build to the linked brand as a suggested family, with its file', async () => {
    const agent = await connectAgent(h.base, 'claude-code');
    const file = await call(agent, 'file_create', { name: 'Branded' });
    const brand = await call(agent, 'brand_create', { name: 'Paper Co' });
    await call(agent, 'brand_link', { brand_id: brand.id, file_id: file.id });
    await call(agent, 'font_create', { family: 'Paper Mark', file_id: file.id });
    await call(agent, 'font_glyphs_set', { glyphs: [{ char: 'H', advance: 600, d: H }] });
    const built = await call(agent, 'font_build', { brand: true });
    expect(built.brand).toMatchObject({ added: true, brand_id: brand.id });
    const data = await call(agent, 'brand_get', { brand_id: brand.id, section: 'typography', raw: true });
    expect(JSON.stringify(data)).toContain('Paper Mark');
    const brandRoom = await h.server.rooms.get(brand.id);
    expect(getFontFaces(brandRoom.doc)).toEqual([expect.objectContaining({ family: 'Paper Mark', src: built.woff2 })]);
    await agent.close();
  });

  it('starts from an open font under a new name, and refuses a closed one or a reserved name', async () => {
    const agent = await connectAgent(h.base, 'claude-code');
    await call(agent, 'file_create', { name: 'Derived' });
    const dir = mkdtempSync(join(tmpdir(), 'bogen-font-src-'));
    const open = fontFile(dir, 'This Font Software is licensed under the SIL Open Font License, Version 1.1.', 'Copyright 2020 The Quirk Project Authors, with Reserved Font Name "Quirk".', 'Quirk Grotesk');
    const closed = fontFile(dir, 'All rights reserved.', 'Copyright 2024 Big Foundry Inc.', 'Brand Sans');

    const reserved = await callRaw(agent, 'font_create', { family: 'Quirk Display', from_font: { path: open } });
    expect(reserved.isError).toBe(true);
    expect(reserved.content[0]!.text).toMatch(/Reserved Font Name/);
    const same = await callRaw(agent, 'font_create', { family: 'Quirk Grotesk', from_font: { path: open } });
    expect(same.content[0]!.text).toMatch(/name of its own|Reserved/);
    const shut = await callRaw(agent, 'font_create', { family: 'Mine', from_font: { path: closed } });
    expect(shut.isError).toBe(true);
    expect(shut.content[0]!.text).toMatch(/does not say it is under an open licence/);

    const ok = await call(agent, 'font_create', { family: 'Paper Grotesk', from_font: { path: open, characters: 'HA' } });
    expect(ok).toMatchObject({ from: 'Quirk Grotesk', license: 'OFL-1.1', reserved_font_names: ['Quirk'], glyphs: 1, missing: 'A' });
    const text = await h.server.storage.readAsset(ok.license_text.slice('bogen-asset:'.length));
    const licence = Buffer.from(text!.bytes).toString('utf8');
    expect(licence).toMatch(/Reserved Font Name "Quirk"/);
    expect(licence).toMatch(/SIL OPEN FONT LICENSE Version 1.1/);
    const renamed = await callRaw(agent, 'font_update', { family: 'Quirk Paper' });
    expect(renamed.content[0]!.text).toMatch(/Reserved Font Name/);
    const built = await call(agent, 'font_build', {});
    const bytes = (await h.server.storage.readAsset(built.otf.slice('bogen-asset:'.length)))!.bytes;
    const otf = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(otf.names.windows?.fontFamily?.en).toBe('Paper Grotesk');
    expect(otf.names.windows?.license?.en).toMatch(/Open Font License/);
    expect(otf.names.windows?.copyright?.en).toMatch(/Quirk Project Authors/);
    expect(otf.charToGlyph('H').advanceWidth).toBe(520);
    await agent.close();
  });
});
