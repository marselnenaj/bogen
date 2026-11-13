import { describe, expect, it } from 'vitest';
import * as opentype from 'opentype.js';
import { decompress } from 'woff2-encoder';
import {
  BogenDoc, compileGlyphPage, createGlyphFontPage, getFontFaces, getGlyphFont, glyphCells, glyphFontHash, parseD, relayoutGlyphCells, setGlyphFont, writeGlyph,
  type GlyphFont,
} from '@bogen/core';
import { compileGlyphFont, openLicenseOf, readSourceFont, recordBuild, renameProblem, reservedFontNames, withSfntTables } from '../src/glyph-font-build.ts';

/** Cell coordinates: y down, 0 on the ascender line (800), baseline at 800, cap height at 100. */
const H = 'M60 100H180V420H420V100H540V800H420V530H180V800H60Z';
const O_OUTER = 'M50 94H560V806H50Z';
const O_INNER = 'M170 214H440V686H170Z';
const A = 'M20 800L240 100H380L600 800H470L420 640H200L150 800ZM235 530H385L310 290Z';
const V = 'M20 100H150L310 640L470 100H600L380 800H240Z';
const PERIOD = 'M60 680H180V800H60Z';

function sampleDoc(): { doc: BogenDoc; font: GlyphFont } {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  let font!: GlyphFont;
  doc.transact(() => {
    font = createGlyphFontPage(doc, { id: 'f1', family: 'Test Slab', style: 'Bold', weight: 700, designer: 'A Tester', license: 'SIL Open Font License 1.1', kerning: [{ left: 'A', right: 'V', value: -60 }, { left: 'V', right: 'A', value: -55 }] });
    writeGlyph(doc, font, { name: 'H', unicodes: [0x48], advance: 600, paths: parseD(H) });
    writeGlyph(doc, font, { name: 'O', unicodes: [0x4f], advance: 610, paths: [...parseD(O_OUTER), ...parseD(O_INNER)], fillRule: 'evenodd' });
    writeGlyph(doc, font, { name: 'A', unicodes: [0x41], advance: 620, paths: parseD(A), fillRule: 'evenodd' });
    writeGlyph(doc, font, { name: 'V', unicodes: [0x56], advance: 620, paths: parseD(V) });
    writeGlyph(doc, font, { name: 'period', unicodes: [0x2e], advance: 240, paths: parseD(PERIOD) });
    writeGlyph(doc, font, { name: 'space', unicodes: [0x20], advance: 250 });
  });
  return { doc, font: getGlyphFont(doc, font.id)! };
}

const parseBytes = (bytes: Uint8Array) => opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
const name = (f: opentype.Font, key: string) => f.names.windows?.[key]?.en ?? f.names.macintosh?.[key]?.en;

describe('glyph page to font', () => {
  it('builds an OTF and a WOFF2 that read back with the same glyphs, advances, metrics, names and kerning', async () => {
    const { doc, font } = sampleDoc();
    const built = await compileGlyphFont(doc, font);
    expect(built.glyphs).toBe(7); // .notdef and six cells
    expect(built.kerning).toBe(2);

    const otf = parseBytes(built.otf);
    expect(otf.outlinesFormat).toBe('cff');
    expect(otf.glyphs.length).toBe(7);
    expect(otf.glyphs.get(0).name).toBe('.notdef');
    expect(otf.unitsPerEm).toBe(1000);
    expect(otf.ascender).toBe(800);
    expect(otf.descender).toBe(-200);
    expect(otf.tables.os2!.sCapHeight).toBe(700);
    expect(otf.tables.os2!.sxHeight).toBe(500);
    expect(otf.tables.os2!.usWeightClass).toBe(700);
    expect(name(otf, 'fontFamily')).toBe('Test Slab');
    expect(name(otf, 'fontSubfamily')).toBe('Bold');
    expect(name(otf, 'postScriptName')).toBe('TestSlab-Bold');
    expect(name(otf, 'designer')).toBe('A Tester');
    for (const [c, w] of [['H', 600], ['O', 610], ['A', 620], ['V', 620], ['.', 240], [' ', 250]] as const) expect(otf.charToGlyph(c).advanceWidth).toBe(w);
    const a = otf.charToGlyph('A'), v = otf.charToGlyph('V'), h = otf.charToGlyph('H');
    expect(otf.getKerningValue(a, v)).toBe(-60);
    expect(otf.getKerningValue(v, a)).toBe(-55);
    expect(otf.getKerningValue(h, a)).toBe(0);

    // The outline is where the cell drew it: H from x 60 to 540, baseline to cap height.
    const box = h.getBoundingBox();
    expect([box.x1, box.y1, box.x2, box.y2]).toEqual([60, 0, 540, 700]);

    // WOFF2 holds the same font.
    const back = await decompress(built.woff2);
    expect(back.length).toBe(built.otf.length);
    expect(parseBytes(back).glyphs.length).toBe(7);
    expect(built.woff2.length).toBeLessThan(built.otf.length);
  });

  it('keeps cells in the order they were written, with their guides locked', () => {
    const { doc, font } = sampleDoc();
    expect(glyphCells(doc, font).map((c) => c.name)).toEqual(['H', 'O', 'A', 'V', 'period', 'space']);
    for (const cell of glyphCells(doc, font)) expect(doc.getChildren(cell.id).find((n) => n.name === 'Guides')?.locked).toBe(true);
  });

  it('turns an even-odd counter into a hole, and says when a counter would fill in', () => {
    const { doc, font } = sampleDoc();
    const o = compileGlyphPage(doc, font).glyphs.find((g) => g.name === 'O')!;
    expect(o.contours).toHaveLength(2);
    expect(o.notes).toEqual([]);
    // Both drawn the same way and filled nonzero: the counter fills in.
    doc.transact(() => writeGlyph(doc, font, { name: 'O', unicodes: [0x4f], paths: [...parseD(O_OUTER), ...parseD(O_INNER)] }));
    const filled = compileGlyphPage(doc, font).glyphs.find((g) => g.name === 'O')!;
    expect(filled.notes.join(' ')).toMatch(/fills in/);
  });

  it('reads an outline the person moved and refitted, as the path tools leave it, the same as before', () => {
    const { doc, font } = sampleDoc();
    const cellId = compileGlyphPage(doc, font).glyphs.find((g) => g.name === 'H')!.cellId;
    const before = compileGlyphPage(doc, font).glyphs.find((g) => g.name === 'H')!.contours;
    const outline = doc.getChildren(cellId).find((n) => n.type === 'svg')!;
    // In px of the layer, with a tight viewBox and the layer moved to the outline's bounds (scale 0.2).
    const s = font.scale;
    const pts = parseD(H).map((p) => ({ ...p, points: p.points.map((q) => ({ x: q.x * s - 60 * s, y: q.y * s - 100 * s })) }));
    const dPx = pts.map((p) => `M${p.points.map((q) => `${q.x} ${q.y}`).join('L')}Z`).join('');
    doc.transact(() => {
      doc.updateFields(outline.id, { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${480 * s} ${700 * s}" width="100%" height="100%" preserveAspectRatio="none"><path d="${dPx}"/></svg>` });
      doc.updateStyle(outline.id, { left: `${60 * s}px`, top: `${100 * s}px`, width: `${480 * s}px`, height: `${700 * s}px` });
    });
    const after = compileGlyphPage(doc, font).glyphs.find((g) => g.name === 'H')!.contours;
    const round = (c: typeof before) => c.map((p) => p.points.map((q) => [Math.round(q.x), Math.round(q.y)]));
    expect(round(after)).toEqual(round(before));
  });

  it('records a build as a font face of the file, and sees changes since', async () => {
    const { doc, font } = sampleDoc();
    const built = await compileGlyphFont(doc, font);
    doc.transact(() => setGlyphFont(doc, recordBuild(doc, font, built, { otf: `bogen-asset:${'a'.repeat(64)}.otf`, woff2: `bogen-asset:${'b'.repeat(64)}.woff2` })));
    const faces = getFontFaces(doc);
    expect(faces).toEqual([expect.objectContaining({ family: 'Test Slab', weight: '700', style: 'normal', src: `bogen-asset:${'b'.repeat(64)}.woff2` })]);
    const now = getGlyphFont(doc, font.id)!;
    expect(now.build!.hash).toBe(glyphFontHash(doc, now));
    doc.transact(() => writeGlyph(doc, now, { name: 'H', unicodes: [0x48], advance: 640 }));
    expect(glyphFontHash(doc, now)).not.toBe(now.build!.hash);
  });

  it('keeps outlines on the baseline when the ascender changes', () => {
    const { doc, font } = sampleDoc();
    const before = compileGlyphPage(doc, font).glyphs.find((g) => g.name === 'H')!.contours;
    const after: GlyphFont = { ...font, metrics: { ...font.metrics, ascender: 900 } };
    doc.transact(() => {
      relayoutGlyphCells(doc, font, after);
      setGlyphFont(doc, after);
    });
    const moved = compileGlyphPage(doc, after).glyphs.find((g) => g.name === 'H')!.contours;
    expect(moved.map((c) => c.points.map((p) => [Math.round(p.x), Math.round(p.y)]))).toEqual(before.map((c) => c.points.map((p) => [Math.round(p.x), Math.round(p.y)])));
  });

  it('refuses a page without any outline', async () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    let font!: GlyphFont;
    doc.transact(() => {
      font = createGlyphFontPage(doc, { id: 'f2', family: 'Empty' });
      writeGlyph(doc, font, { name: 'space', unicodes: [0x20], advance: 250 });
    });
    await expect(compileGlyphFont(doc, font)).rejects.toThrow(/no glyph has an outline/);
  });

  it('writes tables into an SFNT with a valid directory', () => {
    const glyph = new opentype.Glyph({ name: '.notdef', advanceWidth: 500, path: new opentype.Path() });
    const f = new opentype.Font({ familyName: 'X', styleName: 'Regular', unitsPerEm: 1000, ascender: 800, descender: -200, glyphs: [glyph] });
    const bytes = new Uint8Array(f.toArrayBuffer());
    const more = withSfntTables(bytes, [{ tag: 'zzzz', data: Uint8Array.from([1, 2, 3]) }]);
    expect(() => parseBytes(more)).not.toThrow();
    const count = new DataView(more.buffer).getUint16(4);
    expect(count).toBe(new DataView(bytes.buffer).getUint16(4) + 1);
    // Tags stay sorted, so the new one is last; and the whole file sums to the magic number.
    expect(String.fromCharCode(...more.slice(12 + (count - 1) * 16, 12 + (count - 1) * 16 + 4))).toBe('zzzz');
    const padded = new Uint8Array(Math.ceil(more.length / 4) * 4);
    padded.set(more);
    const v = new DataView(padded.buffer);
    let sum = 0;
    for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
    expect(sum).toBe(0xb1b0afba);
  });
});

/** A small font file as a foundry would ship it, with the licence fields filled in. */
function sourceFont(license: string, copyright: string, family = 'Quirk Grotesk'): Uint8Array {
  const path = new opentype.Path();
  path.moveTo(50, 0); path.lineTo(50, 700); path.lineTo(450, 700); path.lineTo(450, 0); path.close();
  const glyphs = [
    new opentype.Glyph({ name: '.notdef', advanceWidth: 500, path: new opentype.Path() }),
    new opentype.Glyph({ name: 'H', unicode: 0x48, advanceWidth: 520, path }),
    new opentype.Glyph({ name: 'space', unicode: 0x20, advanceWidth: 230, path: new opentype.Path() }),
  ];
  const f = new opentype.Font({ familyName: family, styleName: 'Regular', unitsPerEm: 1000, ascender: 760, descender: -240, license, licenseURL: license.includes('Open Font') ? 'https://openfontlicense.org' : '', copyright, glyphs });
  return new Uint8Array(f.toArrayBuffer());
}

describe('starting from an open font', () => {
  it('reads the Reserved Font Names an OFL copyright line declares', () => {
    expect(reservedFontNames('Copyright 2020 The Quirk Project Authors, with Reserved Font Name "Quirk".')).toEqual(['Quirk']);
    expect(reservedFontNames('Copyright 2011 Foundry (foundry.example), with Reserved Font Names “Sans Fold” and “Fold”.')).toEqual(['Sans Fold', 'Fold']);
    expect(reservedFontNames('Copyright 2019 Someone, with Reserved Font Name Brisk.')).toEqual(['Brisk']);
    expect(reservedFontNames('Copyright 2020 Nobody reserves anything.')).toEqual([]);
  });

  it('refuses a derivative that keeps the name or a Reserved Font Name, and takes a new one', () => {
    expect(renameProblem('Quirk Grotesk', 'Quirk Grotesk', [])).toMatch(/name of its own/);
    expect(renameProblem('Quirk Display', 'Quirk Grotesk', ['Quirk'])).toMatch(/Reserved Font Name/);
    expect(renameProblem('QUIRK-mono', 'Quirk Grotesk', ['Quirk'])).toMatch(/Reserved Font Name/);
    expect(renameProblem('Paper Grotesk', 'Quirk Grotesk', ['Quirk'])).toBeNull();
  });

  it('takes a font only on the open licence the file itself states', async () => {
    const ofl = await readSourceFont(sourceFont('This Font Software is licensed under the SIL Open Font License, Version 1.1.', 'Copyright 2020 The Quirk Project Authors, with Reserved Font Name "Quirk".'));
    expect(ofl.family).toBe('Quirk Grotesk');
    expect(openLicenseOf(ofl)).toEqual({ license: 'OFL-1.1', reservedNames: ['Quirk'] });
    expect(ofl.metrics).toMatchObject({ unitsPerEm: 1000, ascender: 760, descender: -240 });
    expect(ofl.glyphs.map((g) => [g.name, g.advance])).toEqual([['space', 230], ['H', 520]]);
    expect(ofl.missing).toContain('A');

    const shut = await readSourceFont(sourceFont('All rights reserved. You may not modify this font.', 'Copyright 2024 Big Foundry Inc.', 'Brand Sans'));
    expect(() => openLicenseOf(shut)).toThrow(/does not say it is under an open licence/);
    const silent = await readSourceFont(sourceFont('', 'Copyright 2024 Someone', 'Mystery'));
    expect(() => openLicenseOf(silent)).toThrow(/names no licence/);
  });

  it('reads WOFF2 as well', async () => {
    const { compress } = await import('woff2-encoder');
    const woff2 = await compress(sourceFont('SIL Open Font License 1.1', 'Copyright 2020 Q'));
    const read = await readSourceFont(woff2, 'H');
    expect(read.glyphs).toHaveLength(1);
  });
});
