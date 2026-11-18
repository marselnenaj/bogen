import { describe, expect, it } from 'vitest';
import { BOARD_LAYOUTS, cellFigure, fitDisplay, layoutViolations, pickLayouts } from '../src/templates/brand-presentation.ts';
import { oklch, tokenExports } from '../src/templates/brand-site.ts';
import { autoFit } from '../src/mcp/tools-mockup.ts';
import { meshAspect, mockupChildren, type MockupConfig } from '@bogen/core';

describe('board forms', () => {
  it('never repeats a form next to itself and uses one at most three times in nine', () => {
    const out = pickLayouts(9, () => true);
    expect(layoutViolations(out)).toEqual([]);
    expect(new Set(out).size).toBeGreaterThanOrEqual(5);
  });
  it('keeps the rule when only a few forms are possible, and honours a wish that keeps it', () => {
    const out = pickLayouts(9, (l) => l === 'type' || l === 'figure' || l === 'photo', ['photo', 'photo']);
    expect(out[0]).toBe('photo');
    expect(out[1]).not.toBe('photo');
    expect(layoutViolations(out)).toEqual([]);
  });
  it('uses the one number and quotes only as often as the story has them', () => {
    const out = pickLayouts(9, (l, _i, before) => (l === 'number' ? before.filter((x) => x === 'number').length < 1 : l !== 'quote'));
    expect(out.filter((x) => x === 'number')).toHaveLength(1);
    expect(out).not.toContain('quote');
  });
  it('reports repeats in a set', () => {
    expect(layoutViolations(['type', 'type'])).toEqual([{ index: 1, rule: 'adjacent' }]);
    expect(layoutViolations(['type', 'photo', 'type', 'photo', 'type', 'figure', 'type']).map((v) => v.rule)).toEqual(['nine']);
  });
  it('sizes a display line so its longest word fits', () => {
    const px = fitDisplay('Borrow a season.', 360, 400, 200);
    expect(px * 7 * 0.62).toBeLessThanOrEqual(360);
    expect(fitDisplay('Hi', 1000, 1000, 120)).toBe(120);
  });
  it('draws a number in cells, lit for the value and faint for the grid', () => {
    const svg = cellFigure('400', 10, '#c7dc6a', '#333');
    expect(svg).toMatch(/aria-label="400"/);
    expect((svg.match(/<circle/g) ?? []).length).toBe(3 * 35);
    expect(BOARD_LAYOUTS).toHaveLength(7);
  });
});

describe('mockups that never cut type', () => {
  const mesh = { top: [[0, 0], [200, 0]], bottom: [[0, 100], [200, 100]] } as MockupConfig['mesh'];
  it('covers when the shapes match and contains when they differ', () => {
    expect(autoFit(2, meshAspect(mesh))).toBe('cover');
    expect(autoFit(0.7, meshAspect(mesh))).toBe('contain');
  });
  it('shows the whole design with contain, with bands in its ground', () => {
    const cfg: MockupConfig = { source: 'src1234567', sourceWidth: 700, sourceHeight: 1000, scene: 'photo', width: 200, height: 100, mesh, blend: 'multiply', shading: 0, fit: 'contain', ground: '#e8dcc2' };
    const kids = mockupChildren(cfg, null);
    const print = kids.find((k) => k.name === 'Surface')!.children![0]!;
    expect(print.style!.backgroundColor).toBe('#e8dcc2');
    // The window is wider than the design, so the design sits inside it at a positive offset.
    expect(Number.parseFloat(print.children![0]!.style!.left!)).toBeGreaterThan(0);
    expect(Number.parseFloat(print.style!.height!)).toBe(1000);
  });
});

describe('brand site values', () => {
  it('writes OKLCH for a hex colour', () => {
    expect(oklch('#ffffff')).toBe('oklch(100.0% 0.000 0.0)');
    expect(oklch('#ff0000')).toBe('oklch(62.8% 0.258 29.2)');
  });
  it('exports the tokens in five formats', () => {
    const out = tokenExports(new Map([['stamp', '#2b3cae'], ['space-md', '32px']]), [{ id: 'a', name: 'Stamp', role: 'link', value: '#2b3cae', token: 'stamp' }]);
    expect(out.CSS).toContain('--stamp: #2b3cae;');
    expect(JSON.parse(out.JSON)).toEqual({ 'space-md': '32px', stamp: '#2b3cae' });
    expect(out.Tailwind).toContain("'stamp': 'var(--stamp)'");
    expect(out.Swift).toContain('static let stamp = Color(red: 0.169, green: 0.235, blue: 0.682)');
    expect(out.Kotlin).toContain('val stamp = Color(0xFF2B3CAE)');
  });
});
