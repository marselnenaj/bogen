import { describe, expect, it } from 'vitest';
import { aspectFor } from '../src/lib/image-generate.ts';

describe('the first guess of a shape', () => {
  it('is the shape nearest to the box the picture goes into', () => {
    expect(aspectFor(1200, 520)).toBe('wide');
    expect(aspectFor(600, 400)).toBe('landscape');
    expect(aspectFor(400, 400)).toBe('square');
    expect(aspectFor(400, 620)).toBe('portrait');
    expect(aspectFor(390, 844)).toBe('tall');
    expect(aspectFor(0, 0)).toBe('landscape');
  });
});
