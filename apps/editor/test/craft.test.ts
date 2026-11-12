import { describe, expect, it } from 'vitest';
import { fuzzyMatch } from '../src/lib/fuzzy.ts';
import { findLayers, filteredRows, matchesQuery, parseLayerQuery } from '../src/panels/layer-filter.ts';
import { detectH, detectV, isConstrained, patchH, patchV, positionPatch } from '../src/lib/constraints.ts';
import { groupOf, groupStyle } from '../src/lib/style-groups.ts';
import { animationEnd, parseAnimations, parseKeyframes, printAnimations, printKeyframes } from '../src/lib/motion.ts';
import { angleBetween, dragLinearEnd, linearAt, linearLine, linearPoint, parseRadial, printRadial, radialAt, radialPoint } from '../src/canvas/gradient-geom.ts';
import { boxIntersectsRect, freeSpot } from '../src/canvas/geometry.ts';
import { snapHandlePoint } from '../src/canvas/snap.ts';
import { planShaders } from '../src/canvas/shader-budget.ts';
import { ellipsePath, fitRadii, multiplyM, parseTransformAttr, roundedRectPath, transformPaths } from '../src/lib/shape-paths.ts';
import { filesIn, folderTree, joinPath, nextSelection, parentOf, sortFiles } from '../src/home/folders.ts';
import { cleanHover, interactionCss, linkTarget, neighbour } from '../src/preview/preview-model.ts';
import { mentionAt } from '../src/panels/mention.ts';
import { overlapping, removable } from '../src/ops/simplify-rules.ts';
import { splitTitle } from '../src/ui/tooltip-text.ts';
import type { BogenNode } from '@bogen/core';

const node = (id: string, patch: Partial<BogenNode> = {}): BogenNode => ({ id, type: 'frame', name: id, parent: 'page', order: 'a', tag: 'div', style: {}, ...patch });

describe('fuzzy', () => {
  it('finds letters in order and not out of order', () => {
    expect(fuzzyMatch('zmfit', 'Zoom to fit')).not.toBeNull();
    expect(fuzzyMatch('tifz', 'Zoom to fit')).toBeNull();
  });
  it('prefers a run at the start over scattered letters', () => {
    expect(fuzzyMatch('zoom', 'Zoom in')!.score).toBeGreaterThan(fuzzyMatch('zoom', 'A Zebra of Odd Moves')!.score);
  });
  it('reports what matched, for highlighting', () => {
    expect(fuzzyMatch('zoo', 'Zoom')!.indices).toEqual([0, 1, 2]);
  });
  it('an empty query matches everything', () => {
    expect(fuzzyMatch(' ', 'x')).toEqual({ score: 0, indices: [] });
  });
});

describe('layer search', () => {
  const nodes = new Map<string, BogenNode>([
    ['a', node('a', { artboard: true, name: 'Board' })],
    ['b', node('b', { parent: 'a', type: 'text', name: 'Label', text: 'Pricing page' })],
    ['c', node('c', { parent: 'a', name: 'Frame', hidden: true })],
  ]);
  const kids: Record<string, string[]> = { page: ['a'], a: ['b', 'c'] };
  const tree = { nodes, children: (id: string) => kids[id] ?? [] };
  it('looks in names and text', () => {
    expect(findLayers(tree, 'page', parseLayerQuery('pricing'))).toEqual(['b']);
    expect(findLayers(tree, 'page', parseLayerQuery('board'))).toEqual(['a']);
  });
  it('narrows by type, also typed in the field', () => {
    expect(parseLayerQuery('type:text foo').kind).toBe('text');
    expect(findLayers(tree, 'page', parseLayerQuery('', 'artboard'))).toEqual(['a']);
    expect(matchesQuery(nodes.get('c')!, parseLayerQuery('is:hidden'))).toBe(true);
  });
  it('can skip hidden layers', () => {
    expect(findLayers(tree, 'page', parseLayerQuery('frame'), true)).toEqual([]);
  });
  it('keeps parents of matches as context', () => {
    const rows = filteredRows(tree, 'page', parseLayerQuery('pricing'), (_, k) => k);
    expect(rows).toEqual([{ id: 'a', depth: 0, match: false }, { id: 'b', depth: 1, match: true }]);
  });
});

describe('constraints', () => {
  it('reads what a style is pinned to', () => {
    expect(detectH({ left: '1px' })).toBe('left');
    expect(detectH({ right: '1px' })).toBe('right');
    expect(detectH({ left: '1px', right: '1px' })).toBe('both');
    expect(detectH({ left: 'calc(50% + 3px)' })).toBe('center');
    expect(detectH({ left: '10%' })).toBe('scale');
    expect(detectV({ top: '1px', bottom: '2px' })).toBe('both');
    expect(isConstrained({ left: '1px', top: '2px' })).toBe(false);
  });
  it('writes CSS that puts the layer where it was', () => {
    expect(patchH('right', 100, 200, 800)).toEqual({ left: null, right: '500px', width: '200px' });
    expect(patchH('both', 100, 200, 800)).toEqual({ left: '100px', right: '500px', width: null });
    expect(patchH('center', 100, 200, 800)).toEqual({ left: 'calc(50% + -300px)', right: null, width: '200px' });
    expect(patchV('scale', 60, 30, 600)).toEqual({ top: '10%', bottom: null, height: '5%' });
  });
  it('a move stays in the terms of the constraint', () => {
    expect(positionPatch({ right: '500px', top: '10px' }, 120, 30, 200, 100, 800, 600)).toEqual({ left: null, right: '480px', width: '200px', top: '30px', bottom: null });
    expect(positionPatch({ left: '1px', top: '2px' }, 5, 6, 10, 10, 100, 100)).toEqual({ left: '5px', right: null, top: '6px', bottom: null });
  });
});

describe('other styles', () => {
  it('sorts properties into groups', () => {
    expect(groupOf('paddingTop')).toBe('Spacing');
    expect(groupOf('textShadow')).toBe('Effects');
    expect(groupOf('color')).toBe('Typography');
    expect(groupOf('--x')).toBe('Variables');
    expect(groupOf('somethingNew')).toBe('Other');
  });
  it('folds four sides into one row', () => {
    const groups = groupStyle({ paddingTop: '8px', paddingRight: '12px', paddingBottom: '8px', paddingLeft: '12px', color: 'red' });
    const row = groups.find((g) => g.title === 'Spacing')!.rows[0]!;
    expect(row).toMatchObject({ key: 'padding', value: '8px 12px', sources: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] });
  });
  it('leaves three sides as they are', () => {
    const rows = groupStyle({ marginTop: '1px', marginLeft: '2px', marginRight: '3px' }).flatMap((g) => g.rows);
    expect(rows.map((r) => r.key).sort()).toEqual(['marginLeft', 'marginRight', 'marginTop']);
  });
  it('knows what is only the default', () => {
    expect(groupStyle({ opacity: '1', zIndex: 'auto', color: 'red' }).flatMap((g) => g.rows).filter((r) => r.quiet).map((r) => r.key).sort()).toEqual(['opacity', 'zIndex']);
  });
});

describe('motion', () => {
  it('parses and prints keyframes', () => {
    const k = parseKeyframes('@keyframes a{from{opacity:0}50%,60%{opacity:.5}to{opacity:1;scale:2;}}')!;
    expect(k.stops.map((s) => s.offset)).toEqual([0, 50, 60, 100]);
    expect(printKeyframes(k)).toBe('@keyframes a{0%{opacity:0}50%{opacity:.5}60%{opacity:.5}100%{opacity:1;scale:2}}');
    expect(parseKeyframes('body{}')).toBeNull();
  });
  it('reads the shorthand, in any order', () => {
    expect(parseAnimations({ animation: 'spin 2s linear 500ms infinite alternate both' })).toEqual([{ name: 'spin', duration: 2000, delay: 500, easing: 'linear', iterations: 'infinite', direction: 'alternate', fill: 'both' }]);
    expect(parseAnimations({ animation: 'a 1s, b 2s' }).map((a) => a.name)).toEqual(['a', 'b']);
    expect(parseAnimations({ animation: 'none' })).toEqual([]);
  });
  it('reads longhands, and writes them back without a shorthand', () => {
    const list = parseAnimations({ animationName: 'a, b', animationDuration: '1s', animationIterationCount: '2, infinite' });
    expect(list.map((a) => a.iterations)).toEqual([2, 'infinite']);
    const out = printAnimations(list);
    expect(out.animation).toBeNull();
    expect(out.animationName).toBe('a, b');
    expect(out.animationIterationCount).toBe('2, infinite');
    expect(printAnimations([]).animationName).toBeNull();
  });
  it('an endless animation counts once on the timeline', () => {
    expect(animationEnd({ delay: 100, duration: 200, iterations: 'infinite' })).toBe(300);
    expect(animationEnd({ delay: 100, duration: 200, iterations: 3 })).toBe(700);
  });
});

describe('gradient geometry', () => {
  it('matches how CSS draws a gradient line', () => {
    expect(linearLine(90, 400, 200).start.y).toBeCloseTo(100);
    expect(linearLine(90, 400, 200).length).toBeCloseTo(400);
    expect(linearLine(180, 400, 200).length).toBeCloseTo(200);
    // At 45 degrees the line reaches the corners' perpendicular: |w sin| + |h cos|.
    expect(linearLine(45, 100, 100).length).toBeCloseTo(141.42, 1);
    expect(linearAt(90, 400, 200, linearPoint(90, 400, 200, 25))).toBeCloseTo(25);
  });
  it('dragging an end keeps the other colour where it is on the layer', () => {
    const stops = [{ color: 'a', at: 0 }, { color: 'b', at: 50 }, { color: 'c', at: 100 }];
    const fixed = linearPoint(90, 400, 200, 0);
    const r = dragLinearEnd(90, stops, 400, 200, 2, { x: 200, y: 200 });
    // CSS keeps the line through the centre, so what stays is the colour at that point of the layer.
    expect(linearAt(r.angle, 400, 200, fixed)).toBeCloseTo(r.stops[0]!.at, 0);
    // The one in the middle stays halfway.
    expect((r.stops[1]!.at - r.stops[0]!.at) / (r.stops[2]!.at - r.stops[0]!.at)).toBeCloseTo(0.5, 1);
  });
  it('snaps the angle with shift', () => {
    expect(dragLinearEnd(90, [{ color: 'a', at: 0 }, { color: 'b', at: 100 }], 400, 200, 1, { x: 390, y: 110 }, 15).angle % 15).toBe(0);
  });
  it('angles read like CSS', () => {
    expect(angleBetween({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(90);
    expect(angleBetween({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(180);
    expect(angleBetween({ x: 0, y: 0 }, { x: 0, y: -10 })).toBeCloseTo(0);
  });
  it('sizes radial gradients as the browser does', () => {
    expect(parseRadial('circle', 300, 400).rx).toBeCloseTo(250);
    const e = parseRadial('ellipse at 25% 75%', 100, 100);
    expect(e.cx).toBe(25);
    expect(e.cy).toBe(75);
    expect(e.rx).toBeCloseTo(75 * Math.SQRT2);
    expect(parseRadial('circle 40px at center', 100, 100)).toMatchObject({ rx: 40, ry: 40, cx: 50, cy: 50 });
    expect(parseRadial('circle at top', 100, 200)).toMatchObject({ cx: 50, cy: 0 });
  });
  it('prints what it read', () => {
    expect(printRadial({ kind: 'circle', cx: 75, cy: 25, rx: 50, ry: 50 }, 100, 100)).toBe('circle 50px at 75% 25%');
    expect(printRadial({ kind: 'ellipse', cx: 50, cy: 50, rx: 10, ry: 20 }, 100, 100)).toBe('ellipse 10px 20px at 50% 50%');
    const r = { kind: 'circle' as const, cx: 10, cy: 10, rx: 100, ry: 100 };
    expect(radialAt(r, radialPoint(r, 30))).toBeCloseTo(30);
  });
});

describe('transforms on the canvas', () => {
  const diamond = { x: 0, y: 0, w: 100, h: 100, rot: 45 };
  it('a marquee in the empty corner of a rotated box misses it', () => {
    expect(boxIntersectsRect(diamond, { x: -20, y: -20, w: 20, h: 20 })).toBe(false);
  });
  it('and over its body hits it', () => {
    expect(boxIntersectsRect(diamond, { x: 40, y: 40, w: 20, h: 20 })).toBe(true);
    expect(boxIntersectsRect(diamond, { x: -30, y: 40, w: 15, h: 20 })).toBe(true);
  });
  it('snaps a corner on both axes', () => {
    const others = [{ x: 200, y: 300, w: 10, h: 10 }];
    const r = snapHandlePoint({ x: 198, y: 303 }, null, others, 6);
    expect(r.dx).toBe(2);
    expect(r.dy).toBe(2);
    expect(r.guides).toHaveLength(2);
  });
  it('snaps an edge along the way it can move', () => {
    const r = snapHandlePoint({ x: 198, y: 50 }, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, [{ x: 200, y: 900, w: 10, h: 10 }], 6);
    expect(50 + r.dy).toBeCloseTo(52);
    expect(198 + r.dx).toBeCloseTo(200);
  });
  it('does nothing with nothing near', () => {
    expect(snapHandlePoint({ x: 0, y: 0 }, null, [{ x: 500, y: 500, w: 1, h: 1 }], 6)).toEqual({ dx: 0, dy: 0, guides: [] });
  });
  it('finds a free spot along the row', () => {
    const box = { x: 0, y: 0, w: 100, h: 100 };
    expect(freeSpot(box, [], 16)).toEqual({ x: 0, y: 0 });
    expect(freeSpot(box, [{ x: 50, y: 50, w: 100, h: 100 }, { x: 160, y: 0, w: 50, h: 50 }], 16).x).toBe(226);
    expect(freeSpot(box, [{ x: 0, y: 500, w: 100, h: 100 }], 16).x).toBe(0);
  });
});

describe('shader budget', () => {
  const item = (id: string, patch = {}) => ({ id, visible: true, area: 100, selected: false, hasStill: true, ...patch });
  it('stays within the budget', () => {
    const items = Array.from({ length: 50 }, (_, i) => item(`s${i}`, { hasStill: false }));
    const plan = planShaders(items, 8);
    expect(plan.live.size).toBe(8);
    expect(plan.capture).not.toBeNull();
    expect(plan.live.has(plan.capture!)).toBe(true);
  });
  it('offscreen shaders never count', () => {
    expect(planShaders([item('a', { visible: false }), item('b')], 8).live).toEqual(new Set(['b']));
  });
  it('selected first, then largest', () => {
    const items = [item('small', { area: 1 }), item('big', { area: 1000 }), item('sel', { area: 2, selected: true }), item('mid', { area: 10 })];
    const live = planShaders(items, 3).live;
    expect(live.has('sel')).toBe(true);
    expect(live.has('big')).toBe(true);
    expect(live.has('small')).toBe(false);
  });
  it('nothing to capture when all have stills', () => {
    expect(planShaders(Array.from({ length: 20 }, (_, i) => item(`s${i}`)), 8).capture).toBeNull();
  });
});

describe('paths from shapes', () => {
  it('an ellipse is four curves on the box', () => {
    const e = ellipsePath(0, 0, 100, 50);
    expect(e.points).toHaveLength(4);
    expect(e.closed).toBe(true);
    expect(e.points[1]).toMatchObject({ x: 100, y: 25 });
  });
  it('a plain rectangle has no curves', () => {
    expect(roundedRectPath(0, 0, 10, 10).points.every((p) => p.hx1 === undefined)).toBe(true);
  });
  it('rounded corners shrink as CSS shrinks them', () => {
    expect(fitRadii([100, 100, 0, 0], 100, 100)[0]).toBe(50);
    expect(roundedRectPath(0, 0, 100, 100, [10, 10, 10, 10]).points).toHaveLength(8);
  });
  it('applies SVG transforms', () => {
    expect(parseTransformAttr('translate(10 20)')).toEqual([1, 0, 0, 1, 10, 20]);
    expect(multiplyM(parseTransformAttr('scale(2)'), parseTransformAttr('translate(1,1)'))).toEqual([2, 0, 0, 2, 2, 2]);
    const moved = transformPaths([{ closed: false, points: [{ x: 1, y: 1, hx2: 2, hy2: 2 }] }], [2, 0, 0, 2, 1, 1]);
    expect(moved[0]!.points[0]).toEqual({ x: 3, y: 3, hx2: 5, hy2: 5 });
  });
});

describe('home', () => {
  const files = [
    { id: '1', name: 'b10', updatedAt: 100, createdAt: 5, folder: 'A/B' },
    { id: '2', name: 'b2', updatedAt: 300, createdAt: 1 },
    { id: '3', name: 'A', updatedAt: 200, createdAt: 9, folder: 'A' },
  ];
  it('sorts', () => {
    expect(sortFiles(files, 'edited').map((f) => f.id)).toEqual(['2', '3', '1']);
    expect(sortFiles(files, 'name').map((f) => f.name)).toEqual(['A', 'b2', 'b10']);
    expect(sortFiles(files, 'created').map((f) => f.id)).toEqual(['3', '1', '2']);
  });
  it('builds a tree with counts, including empty folders', () => {
    const tree = folderTree(['A', 'A/B', 'A/Empty', 'Z'], files);
    expect(tree.map((n) => n.path)).toEqual(['A', 'Z']);
    expect(tree[0]!.count).toBe(2);
    expect(tree[0]!.children.map((n) => [n.path, n.count])).toEqual([['A/B', 1], ['A/Empty', 0]]);
  });
  it('makes folders for files it has no entry for', () => {
    expect(folderTree([], [{ id: '1', name: 'x', updatedAt: 0, folder: 'P/Q' }])[0]!.children[0]!.path).toBe('P/Q');
  });
  it('lists a folder, or everything, and search looks everywhere', () => {
    expect(filesIn(files, null, '').length).toBe(3);
    expect(filesIn(files, 'A', '').map((f) => f.id)).toEqual(['3']);
    expect(filesIn(files, '', '').map((f) => f.id)).toEqual(['2']);
    expect(filesIn(files, 'A', 'b10').map((f) => f.id)).toEqual(['1']);
  });
  it('paths', () => {
    expect(joinPath('', 'x')).toBe('x');
    expect(joinPath('a', 'b/c')).toBe('a/b-c');
    expect(parentOf('a/b')).toBe('a');
    expect(parentOf('a')).toBe('');
  });
  it('selects, toggles and takes ranges', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(nextSelection(order, [], 'b', null, false)).toEqual(['b']);
    expect(nextSelection(order, ['b'], 'b', 'b', false)).toEqual([]);
    expect(nextSelection(order, ['a'], 'c', 'a', true)).toEqual(['a', 'b', 'c']);
  });
});

describe('preview', () => {
  it('keeps only what is safe in a hover style', () => {
    expect(cleanHover({ color: 'red;}body{display:none', opacity: '.5', 'x}y': '1', backgroundImage: 'url(x)' })).toEqual({ opacity: '.5' });
    expect(cleanHover('nope')).toEqual({});
  });
  it('writes CSS strong enough to beat inline styles', () => {
    const css = interactionCss([node('a', { proto: { hover: { opacity: '.5', backgroundColor: 'red' }, duration: 100 } }), node('b', { proto: { link: 'a' } })]);
    expect(css).toContain('[data-bogen-id="a"]:hover{opacity:.5 !important;background-color:red !important}');
    expect(css).toContain('transition:opacity 100ms ease,background-color 100ms ease');
    expect(css).toContain('[data-bogen-id="b"]{cursor:pointer}');
  });
  it('a click finds the nearest link upward, to something that exists', () => {
    const nodes = new Map([['p', node('p', { proto: { link: 'x' } })], ['c', node('c', { parent: 'p' })], ['q', node('q', { proto: { link: 'gone' } })]]);
    const exists = (id: string) => id === 'x';
    expect(linkTarget('c', (id) => nodes.get(id), exists)?.link).toBe('x');
    expect(linkTarget('q', (id) => nodes.get(id), exists)).toBeNull();
  });
  it('goes through artboards in order', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    expect(neighbour(list, 'a', 1)).toBe('b');
    expect(neighbour(list, 'b', 1)).toBeNull();
    expect(neighbour(list, 'gone', 1)).toBe('a');
  });
});

describe('simplify styles', () => {
  it('leaves what places a layer, unless it says the default', () => {
    expect(removable('left', '10px')).toBe(false);
    expect(removable('left', 'auto')).toBe(true);
    expect(removable('width', '10px')).toBe(false);
    expect(removable('color', 'red')).toBe(true);
    expect(removable('--x', '1')).toBe(false);
    expect(removable('animationName', 'spin')).toBe(false);
  });
  it('knows shorthands and what they stand for', () => {
    expect(overlapping('padding', 'paddingLeft')).toBe(true);
    expect(overlapping('paddingLeft', 'padding')).toBe(true);
    expect(overlapping('background', 'backgroundColor')).toBe(true);
    expect(overlapping('borderRadius', 'borderTopLeftRadius')).toBe(true);
    expect(overlapping('borderWidth', 'borderTopWidth')).toBe(true);
    expect(overlapping('gap', 'rowGap')).toBe(true);
    expect(overlapping('font', 'lineHeight')).toBe(true);
    expect(overlapping('paddingLeft', 'paddingRight')).toBe(false);
    expect(overlapping('color', 'columnGap')).toBe(false);
    expect(overlapping('border', 'borderTopWidth')).toBe(true);
  });
});

describe('small pieces of text', () => {
  it('finds the mention at the caret', () => {
    expect(mentionAt('hi @cl', 6)).toEqual({ start: 3, query: 'cl' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('mail@x', 6)).toBeNull();
    expect(mentionAt('@cl done', 8)).toBeNull();
  });
  it('sets a shortcut apart in a tooltip', () => {
    expect(splitTitle('Zoom in (Ctrl+=)')).toEqual({ label: 'Zoom in', keys: 'Ctrl+=' });
    expect(splitTitle('Frame (F)')).toEqual({ label: 'Frame', keys: 'F' });
    expect(splitTitle('Rotate. Hold shift for 15 degree steps.').keys).toBeNull();
    expect(splitTitle('Not one (at all, really)').keys).toBeNull();
  });
});
