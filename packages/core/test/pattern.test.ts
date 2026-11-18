import { describe, expect, it } from 'vitest';
import { PATTERN_DEFAULTS, decodeField, encodeField, normalizePatternSpec, patternValues, readPatternSpec, renderPattern, safePatternColor } from '../src/index.ts';

const spec = (p: Partial<typeof PATTERN_DEFAULTS>) => normalizePatternSpec({ ...PATTERN_DEFAULTS, roughness: 0, ...p });

describe('pattern layers', () => {
  it('fills a gradient from one side, more cells where the value is high', () => {
    const s = spec({ columns: 10, rows: 2, fill: 'gradient', angle: 0, threshold: 0.5, colors: ['var(--pea)'] });
    const v = patternValues(s);
    expect(v[0]).toBeLessThan(0.1);
    expect(v[9]).toBeGreaterThan(0.9);
    const out = renderPattern(s);
    expect(out.filled).toBe(10);
    expect(out.svg).toContain('style="fill:var(--pea)"');
    expect(out.svg).toContain('viewBox="0 0 10 2"');
  });

  it('splits values into one group per tone, lowest first', () => {
    const out = renderPattern(spec({ columns: 20, rows: 1, threshold: 0, colors: ['var(--a)', 'var(--b)'] }));
    expect(out.tones).toEqual([10, 10]);
  });

  it('is the same for the same seed and different for another', () => {
    const a = renderPattern(spec({ fill: 'noise', seed: 3 }));
    const b = renderPattern(spec({ fill: 'noise', seed: 3 }));
    const c = renderPattern(spec({ fill: 'noise', seed: 4 }));
    expect(a.svg).toBe(b.svg);
    expect(a.svg).not.toBe(c.svg);
  });

  it('uses a sampled field for image and text fills, and round-trips it', () => {
    const field = new Float32Array([0, 1, 1, 0]);
    const s = spec({ columns: 2, rows: 2, fill: 'text', threshold: 0.5 });
    expect(renderPattern(s, field).filled).toBe(2);
    expect(decodeField(encodeField(field), 4)).toEqual(field);
    expect(decodeField(encodeField(field), 5)).toBeNull();
  });

  it('grows cells with their value for a halftone', () => {
    const out = renderPattern(spec({ columns: 4, rows: 1, cell: 'circle', threshold: 0, sizeByValue: true, minSize: 0.2, gap: 0 }));
    const radii = [...out.svg.matchAll(/r="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(radii[0]).toBeLessThan(radii[3]!);
  });

  it('keeps only safe colours and path data, and caps the grid', () => {
    expect(safePatternColor('var(--kraft)')).toBe('var(--kraft)');
    expect(safePatternColor('#7fa53a')).toBe('#7fa53a');
    expect(safePatternColor('red;background:url(x)')).toBeNull();
    const out = renderPattern(spec({ columns: 1, rows: 1, fill: 'solid', cell: 'custom', path: 'M0 0L1 0L1 1Z"/><script>x</script>', colors: ['red;x:url(y)'] }));
    expect(out.svg).not.toContain('<script');
    expect(out.svg).toContain('fill:currentColor');
    expect(() => normalizePatternSpec({ columns: 400, rows: 400 })).toThrow(/at most/);
  });

  it('reads a stored spec leniently', () => {
    expect(readPatternSpec('{"columns":12,"cell":"nope"}')).toMatchObject({ columns: 12, cell: 'square' });
    expect(readPatternSpec('not json')).toBeNull();
  });
});

describe('pattern registers', () => {
  it('forms a figure and a bar chart from the same cells', () => {
    const fig = renderPattern(spec({ columns: 40, rows: 20, fill: 'figure', figure: 'mountain', threshold: 0.5 }));
    expect(fig.filled).toBeGreaterThan(100);
    expect(fig.filled).toBeLessThan(700);
    const bars = renderPattern(spec({ columns: 10, rows: 10, fill: 'bars', values: [0.2, 1], threshold: 0.5, roughness: 0 }));
    // Bar one: two rows of five columns less the gap column; bar two: all ten rows.
    expect(bars.filled).toBe(4 * 2 + 4 * 10);
    expect(normalizePatternSpec({ fill: 'figure', figure: 'nope' as never }).figure).toBeUndefined();
  });
});
