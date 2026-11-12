import { describe, expect, it } from 'vitest';
import { emptyBrand, type BrandData, type Token } from '@bogen/core';
import {
  boardAt, classifySwipe, fitBoardCamera, resizePhoneCamera, keyboardInset, layerGlyph, layerRows, openFor, orderBoards, sheetRelease, stepBoard, toggleSheet, zoomStep, type BoardBox, type LayerLike,
} from '../src/phone/file-state.ts';
import {
  colorSwatches, currentFill, editPatch, isCurrentSwatch, resolveValue, sizeUnit, spacingLabel, spacingScale, stepSize, stepSpacing, typeDetail, typeOptions,
} from '../src/phone/edit-ops.ts';
import { MAX_ZOOM, MIN_ZOOM } from '../src/canvas/geometry.ts';
import { conflictsFor, usePhoneSync } from '../src/doc/phone-link.ts';

const board = (id: string, x: number, y: number, w: number, h: number): BoardBox => ({ id, name: id, x, y, w, h });

describe('boards of a page', () => {
  // Two rows of the Phone page, out of order, and a wide board on its own row below.
  const boards = [board('b2', 500, 0, 393, 852), board('c1', 0, 1000, 393, 852), board('b1', 0, 20, 393, 852), board('wide', 0, 2000, 1440, 900), board('c2', 500, 990, 393, 852)];

  it('come in reading order: rows from the top, each from the left', () => {
    expect(orderBoards(boards).map((b) => b.id)).toEqual(['b1', 'b2', 'c1', 'c2', 'wide']);
  });

  it('step forwards and backwards, and stop at either end', () => {
    const ordered = orderBoards(boards);
    expect(stepBoard(ordered, 'b2', 1)).toBe('c1');
    expect(stepBoard(ordered, 'b2', -1)).toBe('b1');
    expect(stepBoard(ordered, 'b1', -1)).toBeNull();
    expect(stepBoard(ordered, 'wide', 1)).toBeNull();
    expect(stepBoard(ordered, null, 1)).toBe('b1');
    expect(stepBoard([], null, 1)).toBeNull();
  });

  it('know which one is in view: the most of it, or the nearest', () => {
    expect(boardAt(boards, { x: 450, y: 100, w: 393, h: 500 })).toBe('b2');
    expect(boardAt(boards, { x: 0, y: 1400, w: 393, h: 300 })).toBe('c1');
    // Between boards, nothing overlaps: the nearest middle wins.
    expect(boardAt(boards, { x: 380, y: 3100, w: 100, h: 100 })).toBe('wide');
    expect(boardAt([], { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });

  it('fit across the screen, from the top when taller than it', () => {
    const tall = fitBoardCamera({ x: 100, y: 200, w: 390, h: 3000 }, 393, 600, 16);
    expect(tall.z).toBeCloseTo(361 / 390);
    expect(tall.x + 100 * tall.z).toBeCloseTo(16);
    expect(tall.y + 200 * tall.z).toBeCloseTo(16);
    const short = fitBoardCamera({ x: 0, y: 0, w: 1440, h: 300 }, 393, 600, 16);
    expect(short.y + 150 * short.z).toBeCloseTo(300);
    // A small board is not blown up past 2x.
    expect(fitBoardCamera({ x: 0, y: 0, w: 40, h: 40 }, 393, 600).z).toBe(2);
  });

  it('take a quick sideways flick as a step, and nothing else', () => {
    expect(classifySwipe({ dx: -120, dy: 10, ms: 180 })).toBe(1);
    expect(classifySwipe({ dx: 120, dy: -20, ms: 180 })).toBe(-1);
    expect(classifySwipe({ dx: -40, dy: 0, ms: 100 })).toBeNull();
    expect(classifySwipe({ dx: -120, dy: 90, ms: 180 })).toBeNull();
    expect(classifySwipe({ dx: -200, dy: 0, ms: 900 })).toBeNull();
  });

  it('zoom in steps, inside the limits', () => {
    expect(zoomStep(1, 1)).toBeCloseTo(1.5);
    expect(zoomStep(1, -1)).toBeCloseTo(1 / 1.5);
    expect(zoomStep(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(zoomStep(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});

describe('sheets', () => {
  it('open from their tool and close from it again, or switch', () => {
    expect(toggleSheet(null, 'layers')).toBe('layers');
    expect(toggleSheet('layers', 'layers')).toBeNull();
    expect(toggleSheet('layers', 'edit')).toBe('edit');
    expect(toggleSheet('pages', 'pages')).toBeNull();
  });

  it('close when pulled far enough or flicked down, and stay otherwise', () => {
    expect(sheetRelease(160, 0.1, 382)).toBe('close');
    expect(sheetRelease(60, 0.1, 382)).toBe('stay');
    expect(sheetRelease(40, 0.9, 382)).toBe('close');
    expect(sheetRelease(10, 2, 382)).toBe('stay');
    expect(sheetRelease(-50, 3, 382)).toBe('stay');
    // A short sheet needs less.
    expect(sheetRelease(70, 0, 200)).toBe('close');
  });

  it('know the keyboard from the visual viewport, and not a pinch of the page', () => {
    expect(keyboardInset(852, { height: 852 })).toBe(0);
    expect(keyboardInset(852, { height: 516 })).toBe(336);
    expect(keyboardInset(852, { height: 800 })).toBe(0);
    expect(keyboardInset(852, { height: 400, scale: 2 })).toBe(0);
  });
});

describe('the layer list', () => {
  const nodes: Record<string, LayerLike & { parent: string; kids: string[] }> = {
    board: { id: 'board', name: 'Landing 390', type: 'frame', artboard: true, parent: 'page', kids: ['bar', 'hero', 'steps'] },
    bar: { id: 'bar', name: 'Bar', type: 'frame', parent: 'board', kids: ['logo'] },
    logo: { id: 'logo', name: 'Bogen', type: 'text', parent: 'bar', kids: [] },
    hero: { id: 'hero', name: 'Hero', type: 'frame', parent: 'board', kids: ['headline', 'lead'] },
    headline: { id: 'headline', name: 'Headline', type: 'text', parent: 'hero', kids: [] },
    lead: { id: 'lead', name: 'Lead', type: 'text', parent: 'hero', kids: [] },
    steps: { id: 'steps', name: 'Steps', type: 'frame', parent: 'board', kids: [] },
  };
  const get = (id: string) => nodes[id];
  const kids = (id: string) => nodes[id]?.kids ?? [];
  const parent = (id: string) => nodes[id]?.parent;

  it('shows the board and its layers, and opens the branch of the selection', () => {
    const rows = layerRows('board', get, kids, openFor('hero', parent, 'board'));
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.name}`)).toEqual(['Landing 390', '  Bar', '  Hero', '    Headline', '    Lead', '  Steps']);
    expect(rows[0]).toMatchObject({ board: true, open: true });
    expect(rows.find((r) => r.id === 'bar')).toMatchObject({ open: false, hasKids: true });
  });

  it('opens every level down to a deep selection', () => {
    const rows = layerRows('board', get, kids, openFor('logo', parent, 'board'));
    expect(rows.map((r) => r.id)).toEqual(['board', 'bar', 'logo', 'hero', 'steps']);
  });

  it('stops a long list', () => {
    expect(layerRows('board', get, kids, openFor('lead', parent, 'board'), 3)).toHaveLength(3);
  });

  it('marks the kind of layer', () => {
    expect(layerGlyph({ type: 'frame', board: true })).toBe('#');
    expect(layerGlyph({ type: 'text', board: false })).toBe('T');
    expect(layerGlyph({ type: 'frame', board: false })).toBe('▢');
  });
});

const TOKENS: Token[] = [
  { name: 'blue', kind: 'color', value: '#2b3df2' },
  { name: 'ink', kind: 'color', value: '#0e0e0c' },
  { name: 'paper', kind: 'color', value: '#f4f2ec' },
  { name: 'accent', kind: 'color', value: 'var(--blue)' },
  { name: 'space-s', kind: 'spacing', value: '16px' },
  { name: 'space-xs', kind: 'spacing', value: '8px' },
  { name: 'space-m', kind: 'spacing', value: '24px' },
  { name: 'text-hero', kind: 'font-size', value: '112px' },
];

function brand(): BrandData {
  const b = emptyBrand();
  b.colors = [
    { id: 'c1', name: 'Paper', role: 'background', value: '#f4f2ec', token: 'paper' },
    { id: 'c2', name: 'Ink', role: 'text', value: '#0e0e0c', token: 'ink' },
    { id: 'c3', name: 'Signal', role: 'accent', value: '#ff0000', token: 'signal' },
    { id: 'c4', name: 'Maybe', role: 'other', value: '#00ff00', token: 'maybe', suggested: true },
  ];
  b.families = [{ id: 'f1', family: 'Archivo', role: 'display', fallback: 'sans-serif', weights: [400, 900], license: 'OFL', assets: [], token: 'sans' }];
  b.typeScale = [
    { id: 't1', name: 'Hero', role: 'display', size: 112, lineHeight: '0.9', weight: 900, tracking: '-0.04em', family: 'f1', token: 'text-hero' },
    { id: 't2', name: 'Caption', role: 'small', size: 13, lineHeight: '1.3', weight: 400, tracking: '', family: 'f1', token: 'text-caption' },
  ];
  return b;
}

describe('colours on the phone', () => {
  it('come from the brand in its order, then the other colour tokens, as tokens where there is one', () => {
    const swatches = colorSwatches(TOKENS, brand());
    expect(swatches.map((s) => s.key)).toEqual(['paper', 'ink', '#ff0000', 'blue', 'accent']);
    expect(swatches[0]).toMatchObject({ label: 'Paper', css: 'var(--paper)', color: '#f4f2ec' });
    // A brand colour without a token in this file is written as its value.
    expect(swatches[2]).toMatchObject({ css: '#ff0000' });
    // A token that points at another shows the colour it comes to.
    expect(swatches[4]).toMatchObject({ css: 'var(--accent)', color: '#2b3df2' });
    expect(colorSwatches([], null)).toEqual([]);
  });

  it('know the current one by token or by value', () => {
    const [paper] = colorSwatches(TOKENS, brand());
    expect(isCurrentSwatch(paper!, 'var(--paper)', TOKENS)).toBe(true);
    expect(isCurrentSwatch(paper!, '#F4F2EC', TOKENS)).toBe(true);
    expect(isCurrentSwatch(paper!, 'var(--ink)', TOKENS)).toBe(false);
    expect(isCurrentSwatch(paper!, undefined, TOKENS)).toBe(false);
    expect(currentFill({ type: 'frame', style: { backgroundColor: 'var(--blue)' } })).toBe('var(--blue)');
    expect(currentFill({ type: 'frame', style: { background: 'linear-gradient(red, blue)' } })).toBeUndefined();
    expect(currentFill({ type: 'text', style: { color: 'var(--ink)' } })).toBe('var(--ink)');
  });

  it('resolves token chains, and leaves other values alone', () => {
    expect(resolveValue('var(--accent)', TOKENS)).toBe('#2b3df2');
    expect(resolveValue('var(--missing, 4px)', TOKENS)).toBe('4px');
    expect(resolveValue('12px', TOKENS)).toBe('12px');
  });
});

describe('the edit ops mapping', () => {
  it('writes a fill as the inspector does, and text colour on text', () => {
    expect(editPatch({ type: 'frame' }, { kind: 'fill', css: 'var(--blue)' })).toEqual({ background: null, backgroundColor: 'var(--blue)', backgroundImage: null, backgroundSize: null, backgroundPosition: null, backgroundRepeat: null });
    expect(editPatch({ type: 'frame' }, { kind: 'fill', css: null })).toEqual({ background: null, backgroundColor: null, backgroundImage: null, backgroundSize: null, backgroundPosition: null, backgroundRepeat: null });
    expect(editPatch({ type: 'text' }, { kind: 'fill', css: 'var(--ink)' })).toEqual({ color: 'var(--ink)' });
    expect(editPatch({ type: 'frame' }, { kind: 'color', css: 'var(--paper)' })).toEqual({ color: 'var(--paper)' });
  });

  it('writes sizes in whole pixels, and padding and gap as one value', () => {
    expect(editPatch({ type: 'frame' }, { kind: 'size', axis: 'width', px: 390.4 })).toEqual({ width: '390px' });
    expect(editPatch({ type: 'frame' }, { kind: 'size', axis: 'height', px: 0 })).toEqual({ height: '1px' });
    expect(editPatch({ type: 'frame' }, { kind: 'padding', css: 'var(--space-s)' })).toEqual({ padding: 'var(--space-s)', paddingTop: null, paddingRight: null, paddingBottom: null, paddingLeft: null });
    expect(editPatch({ type: 'frame' }, { kind: 'gap', css: 'var(--space-xs)' })).toEqual({ gap: 'var(--space-xs)', rowGap: null, columnGap: null });
  });

  it('leaves a text style to applyTextStyle, and writes a type step of the brand as styles', () => {
    expect(editPatch({ type: 'text' }, { kind: 'type', option: { key: 'style:hero', label: 'Hero', textStyle: 'hero' } })).toBeNull();
    const caption = typeOptions([], brand(), TOKENS).find((o) => o.label === 'Caption')!;
    expect(editPatch({ type: 'text' }, { kind: 'type', option: caption })).toEqual({ fontSize: '13px', fontWeight: '400', lineHeight: '1.3', fontFamily: 'Archivo, sans-serif' });
  });
});

describe('spacing and size steps', () => {
  const scale = spacingScale(TOKENS);

  it('are zero and the spacing tokens, small to large', () => {
    expect(scale.map((s) => s.css)).toEqual(['0px', 'var(--space-xs)', 'var(--space-s)', 'var(--space-m)']);
    expect(spacingScale([]).map((s) => s.px)).toEqual([0, 4, 8, 12, 16, 24, 32, 48, 64]);
  });

  it('step from a token, or from a plain value to the next token past it', () => {
    expect(stepSpacing(scale, { css: 'var(--space-s)', px: 16 }, 1)?.css).toBe('var(--space-m)');
    expect(stepSpacing(scale, { css: 'var(--space-s)', px: 16 }, -1)?.css).toBe('var(--space-xs)');
    expect(stepSpacing(scale, { css: 'var(--space-m)', px: 24 }, 1)).toBeNull();
    expect(stepSpacing(scale, { css: '12px', px: 12 }, 1)?.css).toBe('var(--space-s)');
    expect(stepSpacing(scale, { css: '12px', px: 12 }, -1)?.css).toBe('var(--space-xs)');
    expect(stepSpacing(scale, { px: 0 }, -1)).toBeNull();
    expect(spacingLabel(scale, { css: 'var(--space-s)', px: 16 })).toBe('space-s · 16');
    expect(spacingLabel(scale, { css: '13px', px: 13 })).toBe('13');
  });

  it('snap sizes to the smallest spacing token', () => {
    expect(sizeUnit(TOKENS)).toBe(8);
    expect(sizeUnit([])).toBe(8);
    expect(stepSize(390, 1, 8)).toBe(392);
    expect(stepSize(390, -1, 8)).toBe(384);
    expect(stepSize(392, 1, 8)).toBe(400);
    expect(stepSize(8, -1, 8)).toBe(8);
  });
});

describe('type on the phone', () => {
  it('lists the text styles, then brand steps that have none, with size and weight', () => {
    const options = typeOptions([{ key: 'hero', name: 'Hero', style: { fontSize: 'var(--text-hero)', fontWeight: '900' } }], brand(), TOKENS);
    expect(options.map((o) => o.label)).toEqual(['Hero', 'Caption']);
    expect(options[0]).toMatchObject({ textStyle: 'hero', size: 112, weight: '900' });
    expect(typeDetail(options[0]!)).toBe('112 · 900');
    // The brand's step for Hero is the text style already, so it is not listed twice.
    expect(options.filter((o) => o.label === 'Hero')).toHaveLength(1);
  });
});

describe('conflict notes on an open file', () => {
  // React's useSyncExternalStore compares snapshots with Object.is; a fresh [] for each read never settles and the
  // phone app went blank with "Maximum update depth exceeded" on the computer's own address, where no file is synced.
  it('reads the same empty list every time for another file or none, so the store snapshot settles', () => {
    const select = conflictsFor('file-a');
    usePhoneSync.getState().set({ fileId: null, conflicts: [] });
    const first = select(usePhoneSync.getState());
    expect(select(usePhoneSync.getState())).toBe(first);
    expect(first).toEqual([]);
    usePhoneSync.getState().set({ fileId: 'file-b', conflicts: [{ id: 'c1' } as never] });
    expect(select(usePhoneSync.getState())).toBe(first);
    expect(conflictsFor('file-c')(usePhoneSync.getState())).toBe(first);
  });

  it('gives the file its own conflicts, the same list until they change', () => {
    const list = [{ id: 'c1' } as never];
    usePhoneSync.getState().set({ fileId: 'file-a', conflicts: list });
    const select = conflictsFor('file-a');
    expect(select(usePhoneSync.getState())).toBe(list);
    expect(select(usePhoneSync.getState())).toBe(select(usePhoneSync.getState()));
    usePhoneSync.getState().set({ fileId: null, conflicts: [] });
  });
});


describe('continuous phone canvas resizing', () => {
  const before = { width: 390, height: 640 }, wide = { width: 900, height: 620 };
  const tall = { x: 100, y: 200, w: 390, h: 2600 };
  it('keeps a fitted board fitted when the workspace opens and closes', () => {
    const initial = fitBoardCamera(tall, before.width, before.height, 16);
    const opened = resizePhoneCamera(initial, before, wide, tall);
    expect(opened).toEqual(fitBoardCamera(tall, wide.width, wide.height, 16));
    expect(resizePhoneCamera(opened, wide, before, tall)).toEqual(initial);
  });
  it('retains reading position for a vertically scrolled width-fitted board', () => {
    const initial = { ...fitBoardCamera(tall, before.width, before.height, 16), y: -650 };
    const after = resizePhoneCamera(initial, before, wide, tall);
    expect((16 - after.y) / after.z).toBeCloseTo((16 - initial.y) / initial.z);
    expect(after.z).toBe(fitBoardCamera(tall, wide.width, wide.height, 16).z);
  });
  it('preserves manual zoom and the world center through compact, expanded and split-view sizes', () => {
    const initial = { x: -530, y: -820, z: 3.5 };
    let camera = initial, size = before;
    for (const next of [wide, { width: 440, height: 620 }, { width: 620, height: 900 }, before]) {
      const world = { x: (size.width / 2 - camera.x) / camera.z, y: (size.height / 2 - camera.y) / camera.z };
      camera = resizePhoneCamera(camera, size, next, tall);
      expect(camera.z).toBe(3.5);expect((next.width / 2 - camera.x) / camera.z).toBeCloseTo(world.x);expect((next.height / 2 - camera.y) / camera.z).toBeCloseTo(world.y);size = next;
    }
    expect(camera).toEqual(initial);
  });
  it('keeps the selected content reachable above a keyboard without changing a manual zoom', () => {
    const current = { x: -100, y: -100, z: 2.5 }, small = { width: 390, height: 180 }, selection = { x: 80, y: 900, w: 100, h: 30 };
    const next = resizePhoneCamera(current, before, small, null, selection);
    expect(next.z).toBe(current.z);expect((selection.y+selection.h/2)*next.z+next.y).toBeCloseTo(small.height/2);
  });
  it('ignores transient zero/invalid geometry while a scene changes displays', () => {
    const current = { x: 0, y: 0, z: 1 };
    expect(resizePhoneCamera(current, before, { width: 0, height: 800 }, tall)).toBe(current);
    expect(resizePhoneCamera(current, before, { width: NaN, height: 800 }, tall)).toBe(current);
  });
});
