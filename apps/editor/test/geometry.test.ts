import { describe, expect, it } from 'vitest';
import { aabb, alignDeltas, apply, corners, distributeDeltas, fitRect, handleCursor, insertionIndex, insertionIndexWrapped, invert, linearOf, matRotation, measureBetween, multiply, nextZoomStop, normalizeDeg, resizeBox, rotateTo, rotation, scaleInto, screenToWorld, unionRects, worldToScreen, zoomAt } from '../src/canvas/geometry.ts';
import { guidesFor, snapMove, snapResize } from '../src/canvas/snap.ts';
import { arcToCubics, boundsOf, nearestOnPath, parseD, pathToD, simplify, smoothPath, splitSegment, translatePaths } from '../src/canvas/path.ts';
import { evalExpression, parseFeatures, parseFilters, parseShadows, parseSides, paddingOf, printFeatures, printFilters, printShadows, printSides, radiiOf, splitTopLevel } from '../src/lib/css-values.ts';
import { parseFills, parseFillLayer, printFills } from '../src/lib/fills.ts';
import { detectFormat, formatColor, hsvaFromOklch, oklchParts, parseToHsva, varName } from '../src/lib/color.ts';
import { parseColorList, parseShaderAttrs, presetToAttrs } from '../src/lib/shaders.ts';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('matrices', () => {
  it('inverts a rotation', () => {
    const m = rotation(33);
    const v = apply(invert(m), apply(m, { x: 3, y: 4 }));
    close(v.x, 3);
    close(v.y, 4);
  });

  it('reads rotation from each way of writing it', () => {
    close(matRotation(linearOf({ rotate: '30deg' })), 30);
    close(matRotation(linearOf({ transform: 'rotate(45deg)' })), 45);
    close(matRotation(linearOf({ rotate: '0.25turn' })), 90);
    close(matRotation(linearOf({ transform: 'matrix(0, 1, -1, 0, 10, 20)' })), 90);
    close(matRotation(multiply(rotation(10), rotation(20))), 30);
  });

  it('reads flips', () => {
    const m = linearOf({ scale: '-1 1' });
    expect(m.a).toBe(-1);
    expect(m.d).toBe(1);
    expect(linearOf({ transform: 'scaleY(-1)' }).d).toBe(-1);
  });

  it('normalizes angles into (-180, 180]', () => {
    expect(normalizeDeg(190)).toBe(-170);
    expect(normalizeDeg(-190)).toBe(170);
    expect(normalizeDeg(180)).toBe(180);
    expect(normalizeDeg(-180)).toBe(180);
    expect(normalizeDeg(720)).toBe(0);
  });
});

describe('resize', () => {
  const box = { x: 100, y: 100, w: 200, h: 100, rot: 0 };

  it('moves only the dragged sides', () => {
    expect(resizeBox(box, 'se', { x: 10, y: 20 })).toEqual({ x: 100, y: 100, w: 210, h: 120, rot: 0 });
    expect(resizeBox(box, 'nw', { x: 10, y: 20 })).toEqual({ x: 110, y: 120, w: 190, h: 80, rot: 0 });
    expect(resizeBox(box, 'e', { x: 10, y: 20 })).toEqual({ x: 100, y: 100, w: 210, h: 100, rot: 0 });
    expect(resizeBox(box, 'n', { x: 10, y: 20 })).toEqual({ x: 100, y: 120, w: 200, h: 80, rot: 0 });
  });

  it('keeps the ratio with shift', () => {
    const r = resizeBox(box, 'se', { x: 100, y: 0 }, { keepRatio: true });
    close(r.w / r.h, 2);
    close(r.w, 300);
    const edge = resizeBox(box, 'e', { x: 100, y: 0 }, { keepRatio: true });
    close(edge.h, 150);
  });

  it('grows from the centre with alt', () => {
    const r = resizeBox(box, 'se', { x: 10, y: 10 }, { fromCentre: true });
    expect(r).toEqual({ x: 90, y: 90, w: 220, h: 120, rot: 0 });
  });

  it('holds the opposite corner of a rotated box', () => {
    const rotated = { x: 100, y: 100, w: 200, h: 100, rot: 90 };
    const before = corners(rotated);
    const r = resizeBox(rotated, 'se', { x: -20, y: 30 });
    const after = corners(r);
    close(before[0]!.x, after[0]!.x, 1e-6);
    close(before[0]!.y, after[0]!.y, 1e-6);
    close(r.w, 230);
    close(r.h, 120);
  });

  it('holds the opposite corner at any angle', () => {
    for (const rot of [15, 37, 123, -60]) {
      const b = { x: 10, y: 20, w: 120, h: 80, rot };
      const nw0 = corners(b)[0]!;
      const nw1 = corners(resizeBox(b, 'se', { x: 13, y: -7 }))[0]!;
      close(nw0.x, nw1.x, 1e-6);
      close(nw0.y, nw1.y, 1e-6);
    }
  });

  it('does not go below the minimum size', () => {
    const r = resizeBox(box, 'se', { x: -1000, y: -1000 });
    expect(r.w).toBe(1);
    expect(r.h).toBe(1);
  });

  it('scales children with the group', () => {
    const child = scaleInto({ x: 150, y: 150, w: 50, h: 25 }, { x: 100, y: 100, w: 200, h: 100 }, { x: 0, y: 0, w: 400, h: 200 });
    expect(child).toEqual({ x: 100, y: 100, w: 100, h: 50 });
  });

  it('turns cursors with the box', () => {
    expect(handleCursor('e', 0)).toBe('ew-resize');
    expect(handleCursor('e', 90)).toBe('ns-resize');
    expect(handleCursor('se', 0)).toBe('nwse-resize');
    expect(handleCursor('se', 90)).toBe('nesw-resize');
  });
});

describe('rotate', () => {
  it('turns by the angle swept around the centre', () => {
    const c = { x: 0, y: 0 };
    close(rotateTo(0, c, { x: 10, y: 0 }, { x: 0, y: 10 }), 90);
    close(rotateTo(20, c, { x: 10, y: 0 }, { x: 0, y: 10 }), 110);
  });

  it('steps with shift', () => {
    close(rotateTo(0, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 3 }, 15), 15);
  });

  it('bounds of a rotated box', () => {
    const r = aabb({ x: 0, y: 0, w: 100, h: 50, rot: 90 });
    close(r.w, 50);
    close(r.h, 100);
    close(r.x, 25);
    close(r.y, -25);
  });
});

describe('camera', () => {
  it('converts both ways', () => {
    const c = { x: 40, y: -20, z: 2 };
    const w = screenToWorld(c, worldToScreen(c, { x: 5, y: 7 }));
    expect(w).toEqual({ x: 5, y: 7 });
  });

  it('keeps the point under the pointer while zooming', () => {
    const c = { x: 40, y: -20, z: 2 };
    const anchor = { x: 300, y: 200 };
    const before = screenToWorld(c, anchor);
    const after = screenToWorld(zoomAt(c, 5, anchor), anchor);
    close(before.x, after.x);
    close(before.y, after.y);
  });

  it('fits a rectangle in the middle', () => {
    const f = fitRect({ x: 100, y: 100, w: 400, h: 200 }, 800, 600, 0, 10);
    expect(f.z).toBe(2);
    expect(worldToScreen(f, { x: 300, y: 200 })).toEqual({ x: 400, y: 300 });
  });

  it('steps through zoom stops', () => {
    expect(nextZoomStop(1, 1)).toBe(1.5);
    expect(nextZoomStop(1, -1)).toBe(0.75);
    expect(nextZoomStop(1.2, 1)).toBe(1.5);
    expect(nextZoomStop(1.2, -1)).toBe(1);
  });
});

describe('insertion', () => {
  const rects = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 }, { x: 40, y: 0, w: 10, h: 10 }];

  it('finds the slot along an axis', () => {
    expect(insertionIndex(rects, { x: -5, y: 0 }, 'x')).toBe(0);
    expect(insertionIndex(rects, { x: 22, y: 0 }, 'x')).toBe(1);
    expect(insertionIndex(rects, { x: 27, y: 0 }, 'x')).toBe(2);
    expect(insertionIndex(rects, { x: 99, y: 0 }, 'x')).toBe(3);
  });

  it('finds the row first when wrapping', () => {
    const grid = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 }, { x: 0, y: 20, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 }];
    expect(insertionIndexWrapped(grid, { x: 22, y: 3 }, 'x')).toBe(1);
    expect(insertionIndexWrapped(grid, { x: 22, y: 25 }, 'x')).toBe(3);
    expect(insertionIndexWrapped(grid, { x: 29, y: 25 }, 'x')).toBe(4);
    expect(insertionIndexWrapped([], { x: 0, y: 0 }, 'x')).toBe(0);
  });
});

describe('align and distribute', () => {
  const boxes = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 30, y: 5, w: 10, h: 20 }, { x: 100, y: 50, w: 20, h: 10 }];

  it('aligns to the group', () => {
    expect(alignDeltas(boxes, 'left').map((d) => d.x)).toEqual([0, -30, -100]);
    expect(alignDeltas(boxes, 'right').map((d) => d.x)).toEqual([110, 80, 0]);
    expect(alignDeltas(boxes, 'bottom').map((d) => d.y)).toEqual([50, 35, 0]);
    expect(alignDeltas(boxes, 'hcenter').map((d) => d.x)).toEqual([55, 25, -50]);
  });

  it('aligns to a given parent', () => {
    expect(alignDeltas([{ x: 10, y: 0, w: 10, h: 10 }], 'hcenter', { x: 0, y: 0, w: 100, h: 100 })[0]!.x).toBe(35);
  });

  it('evens out the gaps', () => {
    const d = distributeDeltas(boxes, 'x');
    const after = boxes.map((b, i) => b.x + d[i]!.x);
    const gap1 = after[1]! - (after[0]! + 10);
    const gap2 = after[2]! - (after[1]! + 10);
    close(gap1, gap2);
    expect(after[0]).toBe(0);
    expect(after[2]).toBe(100);
  });

  it('leaves fewer than three alone', () => {
    expect(distributeDeltas(boxes.slice(0, 2), 'x')).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  });
});

describe('measure', () => {
  it('gives the gap between separate boxes', () => {
    const m = measureBetween({ x: 0, y: 0, w: 10, h: 10 }, { x: 30, y: 0, w: 10, h: 10 });
    expect(m).toHaveLength(1);
    expect(m[0]!.distance).toBe(20);
    expect(m[0]!.axis).toBe('x');
  });

  it('gives all four insets inside a parent', () => {
    const m = measureBetween({ x: 10, y: 20, w: 10, h: 10 }, { x: 0, y: 0, w: 100, h: 100 });
    expect(m.map((x) => x.distance).sort((a, b) => a - b)).toEqual([10, 20, 70, 80]);
  });

  it('gives both axes on a diagonal', () => {
    const m = measureBetween({ x: 0, y: 0, w: 10, h: 10 }, { x: 30, y: 50, w: 10, h: 10 });
    expect(m.map((x) => x.axis).sort()).toEqual(['x', 'y']);
  });
});

describe('snapping', () => {
  const others = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 0, w: 100, h: 100 }];

  it('snaps edges within the threshold', () => {
    const r = snapMove({ x: 103, y: 200, w: 50, h: 50 }, others, { threshold: 5 });
    expect(r.dx).toBe(-3);
  });

  it('does nothing beyond the threshold', () => {
    const r = snapMove({ x: 123, y: 200, w: 50, h: 50 }, others, { threshold: 5 });
    expect(r.dx).toBe(0);
    expect(r.guides).toHaveLength(0);
  });

  it('snaps centres to centres', () => {
    const r = snapMove({ x: 27, y: 300, w: 50, h: 50 }, others, { threshold: 5 });
    expect(r.dx).toBe(-2);
    expect(r.guides.some((g) => g.axis === 'x' && g.at === 50)).toBe(true);
  });

  it('rounds to whole pixels when nothing snaps', () => {
    const r = snapMove({ x: 150.4, y: 300.7, w: 10, h: 10 }, [], { threshold: 5, pixel: true });
    close(r.dx, -0.4);
    close(r.dy, 0.3);
  });

  it('draws a guide across everything on the line', () => {
    const g = guidesFor({ x: 0, y: 300, w: 50, h: 50 }, others);
    const line = g.find((x) => x.axis === 'x' && x.at === 0)!;
    expect(line.from).toBe(0);
    expect(line.to).toBe(350);
  });

  it('repeats the gap between neighbours', () => {
    const row = [{ x: 0, y: 0, w: 50, h: 50 }, { x: 70, y: 0, w: 50, h: 50 }];
    const r = snapMove({ x: 138, y: 0, w: 50, h: 50 }, row, { threshold: 5 });
    expect(r.dx).toBe(2);
    expect(r.gaps).toHaveLength(2);
    expect(r.gaps[0]!.size).toBe(20);
  });

  it('centres between two neighbours', () => {
    const row = [{ x: 0, y: 0, w: 50, h: 50 }, { x: 150, y: 0, w: 50, h: 50 }];
    const r = snapMove({ x: 73, y: 0, w: 50, h: 50 }, row, { threshold: 5 });
    expect(r.dx).toBe(2);
    expect(r.gaps[0]!.size).toBe(r.gaps[1]!.size);
  });

  it('honours the shift axis lock', () => {
    const r = snapMove({ x: 103, y: 3, w: 50, h: 50 }, others, { threshold: 5, lockX: true });
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(-3);
  });

  it('snaps the dragged edge of a resize only', () => {
    const r = snapResize({ x: 110, y: 10, w: 87, h: 20 }, { r: true }, others, 5);
    expect(r.box.x).toBe(110);
    expect(r.box.w).toBe(90);
  });

  it('snaps the left edge keeping the right one', () => {
    const r = snapResize({ x: 103, y: 10, w: 50, h: 20 }, { l: true }, others, 5);
    expect(r.box.x).toBe(100);
    expect(r.box.w).toBe(53);
  });
});

describe('unionRects', () => {
  it('covers all, and is null for nothing', () => {
    expect(unionRects([])).toBeNull();
    expect(unionRects([{ x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: 5, w: 1, h: 1 }])).toEqual({ x: 0, y: 0, w: 6, h: 6 });
  });
});

describe('paths', () => {
  it('round trips lines and curves', () => {
    const d = 'M0 0L10 0C10 5 15 10 20 10Z';
    const parsed = parseD(d);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.closed).toBe(true);
    expect(parsed[0]!.points).toHaveLength(3);
    expect(pathToD(parsed)).toContain('C10 5 15 10 20 10');
  });

  it('reads relative commands, H and V', () => {
    const parsed = parseD('m10 10h5v5l-5 0');
    expect(parsed[0]!.points.map((p) => [p.x, p.y])).toEqual([[10, 10], [15, 10], [15, 15], [10, 15]]);
  });

  it('turns quadratics and arcs into cubics', () => {
    const q = parseD('M0 0Q10 10 20 0');
    expect(q[0]!.points[0]!.hx2).toBeCloseTo(6.667, 2);
    const a = parseD('M0 0A10 10 0 0 1 20 0');
    expect(a[0]!.points.at(-1)!.x).toBeCloseTo(20, 5);
    expect(arcToCubics(0, 0, 0, 0, 0, false, false, 5, 5)).toHaveLength(1);
  });

  it('reads implicit repeats after M as lines', () => {
    expect(parseD('M0 0 10 0 10 10')[0]!.points).toHaveLength(3);
  });

  it('bounds follow the curve rather than its handles', () => {
    const b = boundsOf(parseD('M0 0C0 100 100 100 100 0'));
    expect(b.w).toBeCloseTo(100, 5);
    expect(b.h).toBeLessThan(76);
    expect(b.h).toBeGreaterThan(70);
  });

  it('translates with handles', () => {
    const t = translatePaths(parseD('M0 0C1 1 2 2 3 3'), 10, 20);
    expect(t[0]!.points[0]!.hx2).toBe(11);
    expect(t[0]!.points[1]!.hy1).toBe(22);
  });

  it('simplifies a straight line to its ends', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i * 2 }));
    expect(simplify(pts, 0.5)).toHaveLength(2);
  });

  it('keeps corners when simplifying', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 0.5)).toHaveLength(3);
  });

  it('smooths through every point', () => {
    const s = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]);
    expect(s.points).toHaveLength(3);
    expect(s.points[1]!.hx1).toBeDefined();
    expect(s.points[1]!.x).toBe(10);
  });

  it('splits a segment on the curve', () => {
    const [a, b] = parseD('M0 0C0 10 10 10 10 0')[0]!.points as [never, never];
    const { mid } = splitSegment(a, b, 0.5);
    expect(mid.x).toBeCloseTo(5, 5);
    expect(mid.y).toBeCloseTo(7.5, 5);
  });

  it('finds the nearest segment', () => {
    const found = nearestOnPath(parseD('M0 0L10 0L10 10'), { x: 10.5, y: 5 })!;
    expect(found.seg).toBe(1);
    expect(found.dist).toBeLessThan(1);
  });
});

describe('expressions', () => {
  it('does arithmetic', () => {
    expect(evalExpression('12+8')).toBe(20);
    expect(evalExpression('100/4')).toBe(25);
    expect(evalExpression('(4+4)*2')).toBe(16);
    expect(evalExpression('2^3')).toBe(8);
    expect(evalExpression('2*3+1')).toBe(7);
    expect(evalExpression('-5+10')).toBe(5);
    expect(evalExpression('10px + 5')).toBe(15);
  });

  it('works on the current value', () => {
    expect(evalExpression('+8', 10)).toBe(18);
    expect(evalExpression('*2', 10)).toBe(20);
    expect(evalExpression('/2', 10)).toBe(5);
    expect(evalExpression('-3', 10)).toBe(-3);
  });

  it('refuses what is not a number', () => {
    expect(evalExpression('auto')).toBeNull();
    expect(evalExpression('50%x')).toBeNull();
    expect(evalExpression('alert(1)')).toBeNull();
    expect(evalExpression('')).toBeNull();
    expect(evalExpression('1/0')).toBeNull();
  });

  it('reads percent as a fraction', () => {
    expect(evalExpression('50%*200')).toBe(100);
  });
});

describe('css values', () => {
  it('splits at the top level only', () => {
    expect(splitTopLevel('a, rgba(0,0,0,1), "x,y"')).toEqual(['a', 'rgba(0,0,0,1)', '"x,y"']);
    expect(splitTopLevel('1px solid rgb(0 0 0)', ' ')).toEqual(['1px', 'solid', 'rgb(0 0 0)']);
  });

  it('reads box shorthands', () => {
    expect(parseSides('1px 2px')).toEqual({ top: '1px', right: '2px', bottom: '1px', left: '2px' });
    expect(parseSides('1px 2px 3px')).toEqual({ top: '1px', right: '2px', bottom: '3px', left: '2px' });
    expect(printSides({ top: '1px', right: '2px', bottom: '1px', left: '2px' })).toBe('1px 2px');
    expect(printSides({ top: '1px', right: '1px', bottom: '1px', left: '1px' })).toBe('1px');
  });

  it('lets longhands win over shorthands for padding and radius', () => {
    expect(paddingOf({ padding: '10px', paddingLeft: '4px' })).toEqual({ top: 10, right: 10, bottom: 10, left: 4 });
    expect(paddingOf({ paddingInline: '8px', paddingBlock: '2px' })).toEqual({ top: 2, right: 8, bottom: 2, left: 8 });
    expect(radiiOf({ borderRadius: '4px', borderTopLeftRadius: '9px' })[0]).toBe('9px');
  });

  it('round trips shadows', () => {
    const list = parseShadows('inset 0px 1px 2px 3px rgba(0, 0, 0, 0.5), 4px 5px 6px #fff');
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ inset: true, x: 0, y: 1, blur: 2, spread: 3, color: 'rgba(0, 0, 0, 0.5)' });
    expect(list[1]).toMatchObject({ inset: false, x: 4, y: 5, blur: 6, spread: 0, color: '#fff' });
    expect(parseShadows(printShadows(list))).toEqual(list);
    expect(parseShadows('none')).toEqual([]);
  });

  it('round trips filters', () => {
    const list = parseFilters('blur(4px) brightness(1.2) hue-rotate(30deg)');
    expect(list[1]).toEqual({ fn: 'brightness', value: 120, unit: '%' });
    expect(printFilters(list)).toBe('blur(4px) brightness(120%) hue-rotate(30deg)');
  });

  it('round trips OpenType features', () => {
    const f = parseFeatures('"liga" 0, "tnum" on, "ss01"');
    expect(f).toEqual({ liga: '0', tnum: 'on', ss01: '1' });
    expect(printFeatures({ tnum: '1' })).toBe('"tnum" 1');
  });
});

describe('fills', () => {
  it('reads a solid', () => {
    expect(parseFills({ backgroundColor: '#fff' })).toEqual([{ kind: 'solid', color: '#fff' }]);
    expect(parseFills({ background: 'red' })).toEqual([{ kind: 'solid', color: 'red' }]);
  });

  it('reads gradients, with stops placed like CSS places them', () => {
    const f = parseFillLayer('linear-gradient(90deg, red, blue 50%, green)')!;
    expect(f).toEqual({ kind: 'linear', angle: 90, stops: [{ color: 'red', at: 0 }, { color: 'blue', at: 50 }, { color: 'green', at: 100 }] });
    expect(parseFillLayer('linear-gradient(to right, red, blue)')).toMatchObject({ angle: 90 });
    expect(parseFillLayer('linear-gradient(red, blue)')).toMatchObject({ angle: 180 });
    expect(parseFillLayer('radial-gradient(circle at center, red 0%, blue 100%)')).toMatchObject({ kind: 'radial', shape: 'circle at center' });
    expect(parseFillLayer('conic-gradient(from 45deg, red, blue)')).toMatchObject({ kind: 'conic', angle: 45 });
  });

  it('keeps commas in colours inside stops', () => {
    const f = parseFillLayer('linear-gradient(rgba(0,0,0,0.5) 0%, rgb(255,255,255) 100%)')!;
    expect(f).toMatchObject({ stops: [{ color: 'rgba(0,0,0,0.5)', at: 0 }, { color: 'rgb(255,255,255)', at: 100 }] });
  });

  it('prints the bottom solid as background-color and the rest as layers', () => {
    const patch = printFills([{ kind: 'linear', angle: 0, stops: [{ color: 'red', at: 0 }, { color: 'blue', at: 100 }] }, { kind: 'solid', color: '#000' }]);
    expect(patch.backgroundColor).toBe('#000');
    expect(patch.backgroundImage).toBe('linear-gradient(0deg, red 0%, blue 100%)');
    expect(patch.background).toBeNull();
  });

  it('round trips several layers', () => {
    const fills = [
      { kind: 'solid' as const, color: '#00000033' },
      { kind: 'image' as const, url: 'bogen-asset:a.png', size: 'cover', position: 'center', repeat: 'no-repeat' },
      { kind: 'radial' as const, shape: 'circle', stops: [{ color: 'red', at: 0 }, { color: 'blue', at: 100 }] },
      { kind: 'solid' as const, color: '#fff' },
    ];
    const printed = printFills(fills);
    const style: Record<string, string> = {};
    for (const [k, v] of Object.entries(printed)) if (v) style[k] = v;
    expect(parseFills(style)).toEqual(fills);
  });

  it('removes everything when empty', () => {
    const p = printFills([]);
    expect(Object.values(p).every((v) => v === null)).toBe(true);
  });
});

describe('colour', () => {
  it('parses and formats hex', () => {
    expect(formatColor(parseToHsva('#ff3366')!, 'hex')).toBe('#ff3366');
    expect(formatColor({ ...parseToHsva('#ff3366')!, a: 0.5 }, 'hex')).toBe('#ff336680');
  });

  it('formats OKLCH and P3', () => {
    const h = parseToHsva('#ff3366')!;
    expect(formatColor(h, 'oklch')).toMatch(/^oklch\(/);
    expect(formatColor(h, 'p3')).toMatch(/^color\(display-p3 /);
    expect(formatColor({ ...h, a: 0.5 }, 'oklch')).toContain('/ 0.5');
  });

  it('keeps a colour through OKLCH', () => {
    const h = parseToHsva('#336699')!;
    const o = oklchParts(h);
    const back = hsvaFromOklch(o.l, o.c, o.h, 1);
    expect(formatColor(back, 'hex')).toBe('#336699');
  });

  it('knows the format of a value', () => {
    expect(detectFormat('#fff')).toBe('hex');
    expect(detectFormat('oklch(50% 0.1 20)')).toBe('oklch');
    expect(detectFormat('color(display-p3 1 0 0)')).toBe('p3');
    expect(parseToHsva('not a colour')).toBeNull();
    expect(varName('var(--brand)')).toBe('brand');
  });
});

describe('shader attributes', () => {
  it('turns document strings into typed params', () => {
    expect(parseShaderAttrs({ type: 'x', speed: '1.5', on: 'true', fit: 'cover', colors: '["#fff","#000"]' })).toEqual({ speed: 1.5, on: true, fit: 'cover', colors: ['#fff', '#000'] });
  });

  it('reads colour lists in either form', () => {
    expect(parseColorList('#fff, rgb(0, 0, 0)')).toEqual(['#fff', 'rgb(0, 0, 0)']);
    expect(parseColorList('["#fff"]')).toEqual(['#fff']);
  });

  it('writes presets as strings', () => {
    expect(presetToAttrs('waves', { name: 'A', params: { speed: 1, colors: ['#fff'] } })).toEqual({ type: 'waves', speed: '1', colors: '["#fff"]' });
  });
});
