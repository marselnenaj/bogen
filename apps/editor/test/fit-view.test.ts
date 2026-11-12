import { describe, expect, it } from 'vitest';
import { boardInView, FIT_MARGIN, fitScreenCamera, fitWidthCamera } from '../src/ops/fit-view.ts';

const area = { x: 0, y: 0, w: 1000, h: 600 };

describe('fitting the screen you work on', () => {
  it('shows a whole artboard centred with a margin, never past 200 % for a small one', () => {
    const c = fitScreenCamera({ x: 2000, y: 0, w: 1440, h: 900 }, area);
    expect(c.z).toBeCloseTo((600 - 2 * FIT_MARGIN) / 900, 5);
    // Its centre lands on the area's centre.
    expect(c.x + (2000 + 720) * c.z).toBeCloseTo(500, 5);
    expect(c.y + 450 * c.z).toBeCloseTo(300, 5);
    expect(fitScreenCamera({ x: 0, y: 0, w: 100, h: 100 }, area).z).toBe(2);
  });

  it('keeps clear of a drawer or the prompt over the canvas', () => {
    // A 300 px drawer on the left: the board is centred in what is left.
    const c = fitScreenCamera({ x: 0, y: 0, w: 390, h: 844 }, { x: 300, y: 0, w: 700, h: 600 });
    expect(c.x + 195 * c.z).toBeCloseTo(650, 5);
  });

  it('fills the width of a tall page and starts at its top, or keeps the place on it', () => {
    const page = { x: 0, y: 0, w: 1440, h: 6000 };
    const top = fitWidthCamera(page, area);
    expect(top.z).toBeCloseTo((1000 - 2 * FIT_MARGIN) / 1440, 5);
    expect(top.y).toBeCloseTo(FIT_MARGIN, 5);
    // Refitting halfway down keeps that world y at the top of the canvas.
    const mid = fitWidthCamera(page, area, 3000);
    expect(-mid.y / mid.z).toBeCloseTo(3000, 5);
    // Never beyond the page's end.
    const end = fitWidthCamera(page, area, 99999);
    expect(-end.y / end.z).toBeLessThan(6000);
  });

  it('picks the artboard most in view among many, then the nearest', () => {
    const boards = Array.from({ length: 116 }, (_, i) => ({ id: `b${i}`, rect: { x: i * 1600, y: 0, w: 1440, h: 900 } }));
    expect(boardInView(boards, { x: 1600 * 40 + 200, y: 100, w: 1000, h: 600 })).toBe('b40');
    expect(boardInView(boards, { x: 1600 * 40 + 1300, y: 100, w: 600, h: 600 })).toBe('b41');
    expect(boardInView(boards, { x: -5000, y: 0, w: 100, h: 100 })).toBe('b0');
    expect(boardInView([], area)).toBeNull();
  });
});
