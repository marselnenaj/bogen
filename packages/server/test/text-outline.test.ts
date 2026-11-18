/// <reference path="../src/opentype.d.ts" />
import * as opentype from 'opentype.js';
import { describe, expect, it } from 'vitest';
import { BogenDoc, Y, addFontFaces } from '@bogen/core';
import { fontFor, googleFaces, outlineText, parseFont, pickFaces, type OutlineStyle } from '../src/text-outline.ts';

const ot = ((opentype as unknown as { Font?: unknown }).Font ? opentype : (opentype as unknown as { default: typeof opentype }).default);

/** A font of squares: A 600 wide, B 500, with a kerning pair A-B of -100, at 1000 units per em. */
function squares(): Uint8Array {
  const box = (w: number) => {
    const p = new ot.Path();
    p.moveTo(50, 0); p.lineTo(w - 50, 0); p.lineTo(w - 50, 700); p.lineTo(50, 700); p.close();
    return p;
  };
  const glyphs = [
    new ot.Glyph({ name: '.notdef', advanceWidth: 500, path: new ot.Path() }),
    new ot.Glyph({ name: 'space', unicode: 32, advanceWidth: 250, path: new ot.Path() }),
    new ot.Glyph({ name: 'A', unicode: 65, advanceWidth: 600, path: box(600) }),
    new ot.Glyph({ name: 'B', unicode: 66, advanceWidth: 500, path: box(500) }),
  ];
  const font = new ot.Font({ familyName: 'Squares', styleName: 'Regular', unitsPerEm: 1000, ascender: 800, descender: -200, glyphs });
  return new Uint8Array(font.toArrayBuffer());
}

const base: OutlineStyle = { family: 'Squares', fontSize: 100, weight: 400, italic: false, letterSpacing: 0, lineHeight: null, align: 'left', transform: 'none', kerning: true };

describe('text_outline geometry', () => {
  it('sets a line with the font\'s advances and crops to the ink', async () => {
    const font = await parseFont(squares());
    const out = outlineText(font, 'AB', { ...base, kerning: false });
    // A from 5 to 55, B from 60+5 to 60+45: ink 5..105 wide 100, cap 70 tall.
    expect(out.width).toBe(100);
    expect(out.height).toBe(70);
    expect(out.svg).toContain('fill="currentColor"');
    expect(out.missing).toEqual([]);
  });

  it('adds letter-spacing after every letter, as CSS does, and keeps the line box with bounds text', async () => {
    const font = await parseFont(squares());
    const spaced = outlineText(font, 'AB', { ...base, kerning: false, letterSpacing: 10 }, 'text');
    // Advances 60 + 50 plus 2 x 10 of tracking; height is ascent + descent = 100.
    expect(spaced.width).toBe(130);
    expect(spaced.height).toBe(100);
  });

  it('applies the font\'s kerning unless font-kerning is none', async () => {
    const font = await parseFont(squares());
    // opentype.js writes no kerning, so the pair goes onto the parsed font, where a kern table would put it.
    (font as unknown as { kerningPairs: Record<string, number> }).kerningPairs = { '2,3': -100 };
    const kerned = outlineText(font, 'AB', base, 'text');
    const plain = outlineText(font, 'AB', { ...base, kerning: false }, 'text');
    expect(plain.width - kerned.width).toBeCloseTo(10, 5);
  });

  it('sets lines on the line height and aligns them, uppercases, and names missing glyphs', async () => {
    const font = await parseFont(squares());
    const out = outlineText(font, 'ab\nb?', { ...base, kerning: false, lineHeight: 120, align: 'center', transform: 'uppercase' }, 'text');
    expect(out.lines).toBe(2);
    expect(out.height).toBe(240);
    expect(out.missing).toEqual(['?']);
  });
});

describe('the font a text layer is drawn with', () => {
  it('prefers a stored face of the family, at the nearest weight and the right style', () => {
    const faces = [
      { family: 'Young Serif', src: 'bogen-asset:a.woff2', weight: '700' },
      { family: 'Young Serif', src: 'bogen-asset:b.woff2', weight: '400' },
      { family: 'Young Serif', src: 'bogen-asset:c.woff2', weight: '400', style: 'italic' },
      { family: 'Other', src: 'bogen-asset:d.woff2', weight: '400' },
    ];
    expect(pickFaces(faces, 'young serif', 400, false, 'Loam')[0]!.src).toBe('bogen-asset:b.woff2');
    expect(pickFaces(faces, 'Young Serif', 400, true, 'Loam')[0]!.src).toBe('bogen-asset:c.woff2');
    expect(pickFaces(faces, 'Young Serif', 650, false, 'Loam')[0]!.src).toBe('bogen-asset:a.woff2');
  });

  it('takes the subset whose unicode-range holds the text', () => {
    const faces = [
      { family: 'X', src: 'u:cyr', unicodeRange: 'U+0400-045F' },
      { family: 'X', src: 'u:latin', unicodeRange: 'U+0000-00FF, U+0131' },
    ];
    expect(pickFaces(faces, 'X', 400, false, 'Seed')[0]!.src).toBe('u:latin');
  });

  it('reads the faces of a Google Fonts stylesheet', () => {
    const css = `/* latin */\n@font-face {\n  font-family: 'Young Serif';\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/youngserif/v2/abc.woff2) format('woff2');\n  unicode-range: U+0000-00FF, U+0131;\n}`;
    expect(googleFaces(css, 'Young Serif')).toEqual([{ url: 'https://fonts.gstatic.com/s/youngserif/v2/abc.woff2', weight: '400', style: 'normal', unicodeRange: 'U+0000-00FF, U+0131' }]);
  });

  it('reads a stored face first and only then asks Google Fonts', async () => {
    const doc = new BogenDoc(new Y.Doc());
    addFontFaces(doc, [{ family: 'Squares', src: 'bogen-asset:sq.ttf', weight: '400' }]);
    const bytes = squares();
    const got = await fontFor(doc, { storage: { readAsset: async (n: string) => (n === 'sq.ttf' ? { bytes, mime: 'font/ttf' } : null) } as never }, 'Squares', 400, false, 'AB');
    expect(got.source).toContain("file's font");
    const fetched: string[] = [];
    await expect(fontFor(doc, { storage: { readAsset: async () => null } as never, fetch: async (u) => { fetched.push(u); throw new Error('offline'); } }, 'Young Serif', 400, false, 'Loam')).rejects.toThrow(/not on Google Fonts/);
    expect(fetched[0]).toContain('css2?family=Young+Serif:ital,wght@0,400');
  });
});

describe('pattern fields from text and images', () => {
  it('marks the cells under the letters', async () => {
    const { textField, imageField } = await import('../src/pattern-sample.ts');
    const font = await parseFont(squares());
    const f = textField(font, 'A', 10, 10, { fill: 1 });
    // One square letter fills the grid when fitted to it, apart from nothing.
    expect(f[55]).toBe(1);
    const two = textField(font, 'A A', 30, 10, { fill: 1 });
    // The gap between the two squares stays empty.
    expect(two[5 * 30 + 15]).toBe(0);
    expect(two[5 * 30 + 8]).toBeGreaterThan(0.5);
    const img = { width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]) };
    const dark = Array.from(imageField(img, 2, 1));
    expect(dark[0]).toBeCloseTo(1, 6);
    expect(dark[1]).toBeCloseTo(0, 6);
  });
});
