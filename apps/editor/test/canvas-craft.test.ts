import { describe, expect, it } from 'vitest';
import { spaceDeltas, spacingOf } from '../src/canvas/geometry.ts';
import { snapMove } from '../src/canvas/snap.ts';
import { withTokenValues } from '../src/lib/token-color.ts';

const box = (x: number, y: number, w = 100, h = 50) => ({ x, y, w, h });

describe('spacing between layers', () => {
  it('reads the gaps in order along an axis, and refuses overlaps', () => {
    expect(spacingOf([box(240, 0), box(0, 0), box(120, 0)], 'x')).toEqual({ order: [1, 2, 0], gaps: [20, 20] });
    expect(spacingOf([box(0, 0), box(50, 0)], 'x')).toBeNull();
    expect(spacingOf([box(0, 0), box(0, 70)], 'y')).toEqual({ order: [0, 1], gaps: [20] });
    expect(spacingOf([box(0, 0)], 'x')).toBeNull();
  });

  it('moves everything after the first to leave the gap asked for', () => {
    const boxes = [box(0, 0), box(130, 10), box(300, 0, 40)];
    expect(spaceDeltas(boxes, 'x', 8)).toEqual([{ x: 0, y: 0 }, { x: -22, y: 0 }, { x: -84, y: 0 }]);
    expect(spaceDeltas([box(0, 0), box(50, 0)], 'x', 8)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  });
});

describe('snapping to layout grid columns', () => {
  it('snaps a moved box to the edge of a column given as a target', () => {
    // A column from 365 to 695 over the frame; the box comes to rest 3px short of it.
    const r = snapMove(box(362, 300, 200, 100), [box(365, 0, 330, 900)], { threshold: 6, pixel: true });
    expect(r.dx).toBe(3);
  });
});

describe('token colours in swatches', () => {
  const tokens = [
    { name: 'brand', kind: 'color' as const, value: '#ff3366' },
    { name: 'surface', kind: 'color' as const, value: 'var(--brand)' },
    { name: 'loop', kind: 'color' as const, value: 'var(--loop)' },
  ];
  it('replaces tokens with their values, through aliases and inside gradients', () => {
    expect(withTokenValues('var(--surface)', tokens)).toBe('#ff3366');
    expect(withTokenValues('linear-gradient(90deg, var(--brand) 0%, rgb(0 0 0) 100%)', tokens)).toBe('linear-gradient(90deg, #ff3366 0%, rgb(0 0 0) 100%)');
    expect(withTokenValues('var(--missing, rgb(1, 2, 3))', tokens)).toBe('rgb(1, 2, 3)');
    expect(withTokenValues('var(--missing)', tokens)).toBe('var(--missing)');
    expect(withTokenValues('#fff', tokens)).toBe('#fff');
    // A token that names itself stops instead of looping.
    expect(withTokenValues('var(--loop)', tokens)).toBe('var(--loop)');
  });
});
