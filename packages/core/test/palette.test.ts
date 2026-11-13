import { describe, expect, it } from 'vitest';
import { contrastRatio, dominantColours, paletteFromImage, palettesFromSeed, palettesFromSubject, type Palette } from '../src/index.ts';

const inks = (p: Palette) => p.pairs.filter((x) => x.fg.includes('ink'));

describe('palettes with roles', () => {
  it('builds six harmonies around a seed, tinted and readable, light and dark', () => {
    for (const dark of [false, true]) for (const seed of ['#2f8fa6', '#d6402b', '#f2c70f', '#888888', '#6b4a9e']) {
      const out = palettesFromSeed(seed, { dark });
      expect(out.map((p) => p.id.replace('-dark', ''))).toEqual(['analogous', 'complementary', 'split', 'triadic', 'warm-cold', 'tinted']);
      for (const p of out) {
        const roles = p.colours.map((c) => c.role);
        for (const role of ['ground', 'surface', 'ink', 'ink-muted', 'action', 'action-ink'] as const) expect(roles, `${seed} ${p.id}`).toContain(role);
        // Every text pair passes body-text contrast, including the text on the action colour.
        for (const x of inks(p)) expect(x.wcag, `${seed} ${p.id} ${x.fg}/${x.bg}`).toBeGreaterThanOrEqual(4.5);
        // Neutrals carry the seed's hue: a tinted ground, not a plain grey or white.
        const ground = p.colours.find((c) => c.role === 'ground')!;
        if (seed !== '#888888') expect(ground.oklch[1], `${seed} ${p.id}`).toBeGreaterThan(0.005);
        expect(p.tokens.map((t) => t.name)).toEqual(p.colours.map((c) => c.token));
        expect(p.contrast).toMatch(/hue|light|warm|complementary|saturation|extension/);
      }
      expect(out.find((p) => p.id.startsWith('triadic'))!.colours.filter((c) => c.role === 'support')).toHaveLength(2);
    }
    expect(palettesFromSeed('#2f8fa6', { prefix: 'brand-' })[0]!.tokens[0]!.name).toBe('brand-ground');
    expect(() => palettesFromSeed('not a colour')).toThrow('Not a colour');
    // Deterministic.
    expect(JSON.stringify(palettesFromSeed('#2f8fa6'))).toBe(JSON.stringify(palettesFromSeed('#2f8fa6')));
  });

  it('finds subject palettes by the words of the brief, each readable and with more than one hue', () => {
    expect(palettesFromSubject('A timetable for a swimming school')[0]!.id).toBe('swimming-pool');
    expect(palettesFromSubject('Invoices for a tax adviser')[0]!.id).toBe('ledger');
    expect(palettesFromSubject('qqq')).toHaveLength(4);
    for (const words of ['swim', 'forest', 'night', 'zine', 'clinic', 'legal', 'bike', 'bakery', 'weather', 'code']) {
      const p = palettesFromSubject(words)[0]!;
      for (const x of inks(p)) expect(x.wcag, `${p.id} ${x.fg}/${x.bg}`).toBeGreaterThanOrEqual(4.5);
      const hues = new Set(p.colours.filter((c) => c.oklch[1] >= 0.06).map((c) => Math.round(c.oklch[2] / 40)));
      expect(hues.size, p.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('reads the dominant colours and accents of a picture, the same way every time', () => {
    // Two thirds sea blue, a quarter sand, a little red buoy.
    const w = 60, h = 60, px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const rgb = x > 50 && y > 50 ? [210, 40, 30] : y < 40 ? [30, 90, 150] : [220, 200, 160];
      px.set([...rgb, 255], i);
    }
    const found = dominantColours(px, 4);
    expect(found[0]!.share).toBeGreaterThan(0.6);
    expect(contrastRatio(found[0]!.hex, '#1e5a96')).toBeLessThan(1.2);
    const [main, ...rest] = paletteFromImage(px);
    expect(main!.source).toBe('image');
    expect(contrastRatio(main!.colours.find((c) => c.role === 'action')!.hex, '#d2281e')).toBeLessThan(1.6);
    for (const x of inks(main!)) expect(x.wcag).toBeGreaterThanOrEqual(4.5);
    expect(rest.length).toBeGreaterThan(0);
    expect(JSON.stringify(paletteFromImage(px))).toBe(JSON.stringify(paletteFromImage(px)));
  });
});
