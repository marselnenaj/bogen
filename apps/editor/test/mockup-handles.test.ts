import { describe, expect, it } from 'vitest';
import { cornerPoint, moveCorner } from '../src/canvas/MockupHandles.tsx';

describe('mockup corner handles', () => {
  const flat = { top: [[0, 0], [100, 0]], bottom: [[0, 50], [100, 50]] } as const;
  it('moves one corner of a flat print and leaves the others', () => {
    const m = moveCorner({ top: [...flat.top], bottom: [...flat.bottom] } as never, 'tr', 10, -5);
    expect(cornerPoint(m, 'tr')).toEqual([110, -5]);
    expect(cornerPoint(m, 'tl')).toEqual([0, 0]);
    expect(cornerPoint(m, 'br')).toEqual([100, 50]);
  });
  it('moves the points of a cloth mesh in proportion, so its curve keeps its shape', () => {
    const mesh = { top: [[0, 0], [50, 10], [100, 0]], bottom: [[0, 60], [50, 70], [100, 60]] } as never;
    const m = moveCorner(mesh, 'bl', -20, 10);
    expect(m.bottom).toEqual([[-20, 70], [40, 75], [100, 60]]);
    expect(m.top).toEqual([[0, 0], [50, 10], [100, 0]]);
  });
});
