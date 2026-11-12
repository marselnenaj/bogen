import { describe, expect, it } from 'vitest';
import { classifyPress, DOUBLE_TAP_DIST, DOUBLE_TAP_MS, isDoubleTap, LONG_PRESS_MS, pinchCamera, TOUCH_SLOP } from '../src/canvas/touch.ts';
import { MAX_ZOOM, MIN_ZOOM, screenToWorld } from '../src/canvas/geometry.ts';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('pinch', () => {
  const start = { x: 40, y: -20, z: 1.5 };

  it('zooms by the spread of the fingers around their midpoint', () => {
    const a0 = { x: 100, y: 200 };
    const b0 = { x: 200, y: 200 };
    const c = pinchCamera(start, a0, b0, { x: 50, y: 200 }, { x: 250, y: 200 });
    close(c.z, 3);
    const before = screenToWorld(start, { x: 150, y: 200 });
    const after = screenToWorld(c, { x: 150, y: 200 });
    close(after.x, before.x);
    close(after.y, before.y);
  });

  it('pans with the midpoint when the fingers move together', () => {
    const c = pinchCamera(start, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 130, y: 60 }, { x: 230, y: 60 });
    close(c.z, start.z);
    close(c.x, start.x + 30);
    close(c.y, start.y - 40);
  });

  it('keeps the world point under the fingers while zooming and panning at once', () => {
    const a0 = { x: 10, y: 10 };
    const b0 = { x: 110, y: 60 };
    const a1 = { x: 300, y: 400 };
    const b1 = { x: 340, y: 420 };
    const c = pinchCamera(start, a0, b0, a1, b1);
    const was = screenToWorld(start, { x: 60, y: 35 });
    const now = screenToWorld(c, { x: 320, y: 410 });
    close(now.x, was.x);
    close(now.y, was.y);
  });

  it('stays within the wheel zoom limits', () => {
    const a0 = { x: 0, y: 0 };
    const b0 = { x: 100, y: 0 };
    expect(pinchCamera({ x: 0, y: 0, z: 200 }, a0, b0, a0, { x: 1000, y: 0 }).z).toBe(MAX_ZOOM);
    expect(pinchCamera({ x: 0, y: 0, z: 0.03 }, a0, b0, a0, { x: 10, y: 0 }).z).toBe(MIN_ZOOM);
  });

  it('survives fingers that land on the same spot', () => {
    const c = pinchCamera(start, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 6, y: 5 });
    expect(Number.isFinite(c.z) && Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true);
  });
});

describe('press', () => {
  it('is a tap while short and within the slop', () => {
    expect(classifyPress(120, 0)).toBe('tap');
    expect(classifyPress(120, TOUCH_SLOP)).toBe('tap');
  });

  it('is a drag once it travels past the slop, however long it took', () => {
    expect(classifyPress(50, TOUCH_SLOP + 1)).toBe('drag');
    expect(classifyPress(LONG_PRESS_MS * 2, TOUCH_SLOP + 1)).toBe('drag');
  });

  it('is a long press when held still', () => {
    expect(classifyPress(LONG_PRESS_MS, 3)).toBe('long-press');
    expect(classifyPress(LONG_PRESS_MS - 1, 3)).toBe('tap');
  });
});

describe('double tap', () => {
  const first = { t: 1000, x: 100, y: 100 };

  it('needs a tap before it', () => {
    expect(isDoubleTap(null, first)).toBe(false);
  });

  it('is a second press soon and close by', () => {
    expect(isDoubleTap(first, { t: 1000 + DOUBLE_TAP_MS, x: 110, y: 95 })).toBe(true);
    expect(isDoubleTap(first, { t: 1000 + DOUBLE_TAP_MS + 1, x: 100, y: 100 })).toBe(false);
    expect(isDoubleTap(first, { t: 1100, x: 100 + DOUBLE_TAP_DIST + 1, y: 100 })).toBe(false);
  });

  it('ignores a press that came before the tap', () => {
    expect(isDoubleTap(first, { t: 900, x: 100, y: 100 })).toBe(false);
  });
});

describe('what one finger moves', () => {
  it('starts on view, switches to move, tells listeners and stays put on a repeat', async () => {
    const { getDragMode, onDragMode, setDragMode } = await import('../src/canvas/touch.ts');
    expect(getDragMode()).toBe('view');
    let calls = 0;
    const off = onDragMode(() => calls++);
    setDragMode('move');
    setDragMode('move');
    expect(getDragMode()).toBe('move');
    expect(calls).toBe(1);
    off();
    setDragMode('view');
    expect(calls).toBe(1);
  });
});
