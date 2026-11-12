import { clampAt, type BogenNode } from '@bogen/core';
import { describe, expect, it } from 'vitest';
import { breakpointKey, inheritedAt, nodeAt, overridesAt, styleAt } from '../src/ops/breakpoints.ts';
import { gridModeOf } from '../src/panels/inspector/ResponsiveControls.tsx';
import { charsPerLine, fluidStart } from '../src/panels/inspector/Typography.tsx';
import { isVectorSrc, resolutionAdvice } from '../src/panels/inspector/Media.tsx';

const layer = (style: Record<string, string>, rules: Record<string, Record<string, string>> = {}): BogenNode =>
  ({ id: 'h', type: 'text', name: 'Heading', tag: 'h1', parent: 'p', style, rules } as unknown as BogenNode);

describe('editing at a breakpoint', () => {
  const h = layer({ fontSize: '64px', color: '#111' }, {
    '@media (max-width: 1024px)': { fontSize: '48px' },
    '@media (max-width: 390px)': { fontSize: '32px', textAlign: 'left' },
    '@media (min-width: 1600px)': { fontSize: '80px' },
    '@media (max-width: 390px) :hover': { color: 'red' },
  });

  it('shows the layer as the cascade resolves it at each width', () => {
    expect(styleAt(h, 1440).fontSize).toBe('64px');
    expect(styleAt(h, 1700).fontSize).toBe('80px');
    expect(styleAt(h, 800).fontSize).toBe('48px');
    expect(styleAt(h, 390)).toMatchObject({ fontSize: '32px', textAlign: 'left', color: '#111' });
    // A state block is not what the layer is at that width.
    expect(styleAt(h, 390).color).toBe('#111');
    expect(nodeAt(h, null)).toBe(h);
  });

  it('tells an override from what it inherits, and from where', () => {
    expect(overridesAt(h, 390)).toEqual({ fontSize: '32px', textAlign: 'left' });
    expect(overridesAt(h, 768)).toEqual({});
    // Resetting 390's font size brings back 1024's, not the base.
    expect(inheritedAt(h, 390, 'fontSize')).toEqual({ value: '48px', from: '≤ 1024' });
    expect(inheritedAt(h, 390, 'textAlign')).toEqual({ value: undefined, from: 'base' });
    expect(inheritedAt(h, 1024, 'fontSize')).toEqual({ value: '64px', from: 'base' });
    expect(breakpointKey(390)).toBe('@media (max-width: 390px)');
  });
});

describe('fluid sizes and grid modes', () => {
  it('starts type a little smaller on a phone and space in proportion', () => {
    expect(fluidStart(48, 'type')).toBe(37);
    expect(fluidStart(12, 'type')).toBe(10);
    expect(fluidStart(8, 'type')).toBe(8);
    // A 4 px gap is 2 px on a phone, never more than it was.
    expect(fluidStart(4, 'space')).toBe(2);
    expect(fluidStart(32, 'space')).toBe(16);
    expect(clampAt('clamp(0.125rem, 0.0761rem + 0.2174vw, 0.25rem)', 360)).toBeCloseTo(2, 0);
  });

  it('reads the grid mode back from what it wrote and what people type', () => {
    expect(gridModeOf('repeat(auto-fit, minmax(min(16rem, 100%), 1fr))')).toEqual({ mode: 'fit', min: '16rem' });
    expect(gridModeOf('repeat(auto-fill, minmax(240px, 1fr))')).toEqual({ mode: 'fill', min: '240px' });
    expect(gridModeOf('repeat(3, minmax(0, 1fr))').mode).toBe('fixed');
    expect(gridModeOf(undefined).mode).toBe('fixed');
  });
});

describe('image resolution and line length', () => {
  it('says when a picture is soft on 2x screens, blurry, or far heavier than needed', () => {
    expect(resolutionAdvice({ width: 1600, height: 900 }, 800).level).toBe('ok');
    expect(resolutionAdvice({ width: 1000, height: 600 }, 800)).toMatchObject({ level: 'soft' });
    expect(resolutionAdvice({ width: 600, height: 400 }, 800).text).toMatch(/blurry on every screen/);
    expect(resolutionAdvice({ width: 6000, height: 4000 }, 400)).toMatchObject({ level: 'heavy' });
    expect(resolutionAdvice({ width: 600, height: 400 }, 800, `bogen-asset:${'a'.repeat(64)}.png`).level).toBe('soft');
  });

  it('never calls a vector image blurry or heavy', () => {
    expect(resolutionAdvice({ width: 24, height: 24 }, 800, `bogen-asset:${'a'.repeat(64)}.svg`).level).toBe('vector');
    expect(resolutionAdvice({ width: 6000, height: 6000 }, 100, 'data:image/svg+xml;utf8,<svg/>').level).toBe('vector');
    expect(isVectorSrc('https://example.com/logo.SVG?v=2')).toBe(true);
    expect(isVectorSrc(`bogen-asset:${'a'.repeat(64)}.webp`)).toBe(false);
  });

  it('counts characters per line from width and letter width', () => {
    expect(charsPerLine(720, 8)).toBe(90);
    expect(charsPerLine(520, 8)).toBe(65);
  });
});
