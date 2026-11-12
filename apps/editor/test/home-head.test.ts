import { describe, expect, it } from 'vitest';
import { homeHeadLevel, homeHeadNeed, type HomeHeadText } from '../src/home/head-fit.ts';

// Label widths in UI pixels, roughly as Source Sans draws them at 13 px.
const en: HomeHeadText = { brand: 40, live: 50, figma: 112, open: 34, newFile: 56, update: 0 };
// Tamil, the catalog with the longest header labels.
const ta: HomeHeadText = { brand: 40, live: 96, figma: 210, open: 64, newFile: 92, update: 0 };

describe("Home's header in a narrow window", () => {
  it('keeps every label where there is room, in English and in a long language', () => {
    expect(homeHeadLevel(1280, en)).toBe('full');
    expect(homeHeadLevel(1280, ta)).toBe('full');
  });

  it('moves Live site and the imports into More before the search gets small', () => {
    expect(homeHeadLevel(560, en)).toBe('menu');
    // The longer labels need the menu at a wider window.
    expect(homeHeadLevel(760, ta)).toBe('menu');
    expect(homeHeadLevel(760, en)).toBe('full');
  });

  it('makes New file its icon last, and fits a 430 px window at 1.5 (287 UI px)', () => {
    expect(homeHeadLevel(287, ta)).toBe('tight');
    expect(homeHeadNeed('tight', ta)).toBeLessThanOrEqual(287);
    expect(homeHeadNeed('menu', en)).toBeLessThan(homeHeadNeed('full', en));
  });

  it('counts the update note while there is one', () => {
    expect(homeHeadNeed('full', { ...en, update: 140 })).toBe(homeHeadNeed('full', en) + 140 + 12);
  });
});
