import { describe, expect, it } from 'vitest';
import type { BogenNode } from '@bogen/core';
import { canDeferArtboard } from '../src/canvas/artboard-loading.ts';

const board: BogenNode = { id: 'board', parent: 'page', type: 'frame', tag: 'div', name: 'Screen', order: 'a', artboard: true, style: { width: '448px', height: '997px', overflow: 'hidden' } };

describe('artboards whose contents can be deferred without changing layout', () => {
  it('allows fixed, clipped screens, including token dimensions', () => {
    expect(canDeferArtboard(board, new Map())).toBe(true);
    expect(canDeferArtboard({ ...board, style: { ...board.style, width: 'var(--container)' } }, new Map([['container', 'var(--phone-width)'], ['phone-width', '448px']]))).toBe(true);
  });

  it('keeps content-dependent sizes and overflowing children fully rendered', () => {
    const unsafe: Record<string, string>[] = [{ height: 'auto' }, { width: '100%' }, { overflow: 'visible' }, { width: 'min-content' }, { height: '0px' }, { minHeight: 'max-content' }, { display: 'contents' }, { transform: 'rotate(15deg)' }, { rotate: '15deg' }, { scale: '1.2' }];
    for (const style of unsafe) {
      expect(canDeferArtboard({ ...board, style: { ...board.style, ...style } }, new Map())).toBe(false);
    }
    expect(canDeferArtboard({ ...board, artboard: false }, new Map())).toBe(false);
    expect(canDeferArtboard({ ...board, rules: { '@media (max-width: 600px)': { height: 'auto' } } }, new Map())).toBe(false);
  });

  it('rejects missing, cyclic or non-size tokens', () => {
    const tokenBoard = { ...board, style: { ...board.style, width: 'var(--container)' } };
    for (const tokens of [new Map(), new Map([['container', 'auto']]), new Map([['container', 'var(--other)'], ['other', 'var(--container)']])]) {
      expect(canDeferArtboard(tokenBoard, tokens)).toBe(false);
    }
  });
});

import { estimatedArtboardHeight, canvasLayerBudget, nearestArtboards } from '../src/canvas/artboard-loading.ts';
describe('bounded content-dependent screen loading', () => {
  it('estimates only independent absolute clipped hug screens, without changing their document styles', () => {
    const hug = { ...board, style: { ...board.style, position: 'absolute', height: 'fit-content' } };
    expect(estimatedArtboardHeight(hug, new Map())).toBe(448 * 9 / 16);
    expect(hug.style.height).toBe('fit-content');
    expect(estimatedArtboardHeight({ ...hug, style: { ...hug.style, position: 'relative' } }, new Map())).toBeUndefined();
    expect(estimatedArtboardHeight({ ...hug, style: { ...hug.style, overflow: 'visible' } }, new Map())).toBeUndefined();
    expect(estimatedArtboardHeight({ ...hug, rules: { ':hover': { height: 'auto' } } }, new Map())).toBeUndefined();
  });
  it('bounds overview DOM and prioritizes closer screens with stable active ties', () => {
    const screens = Array.from({ length: 30 }, (_, i) => ({ id: i, distance: i * 50, active: false, cost: 200 }));
    expect(nearestArtboards(screens, 1200).map(s => s.id)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(nearestArtboards(screens, 600).map(s => s.id)).toEqual([0, 1, 2]);
    expect(nearestArtboards([{ id: 'heavy', distance: 0, active: false, cost: 5000 }], 1800)).toEqual([]);
    expect(canvasLayerBudget(8)).toBeGreaterThan(canvasLayerBudget(4));
    expect(nearestArtboards([{ id: 'new', distance: 2, active: false, cost: 1 }, { id: 'kept', distance: 3, active: true, cost: 1 }], 1)[0]?.id).toBe('kept');
  });
});

import { artboardProxyStyle } from '../src/canvas/artboard-proxy.ts';
it('drops expensive root paint assets only in a local proxy while preserving geometry and original design', () => {
  const original = { position: 'absolute', left: '200px', top: '120px', width: '1440px', height: 'fit-content', transform: 'rotate(15deg)', borderWidth: '2px', background: 'url(bogen-asset:wallpaper.png) center/cover', backgroundImage: 'var(--wallpaper)', filter: 'blur(20px)', backdropFilter: 'blur(12px)', boxShadow: '0 0 100px #000', maskImage: 'url(bogen-asset:mask.svg)', animation: 'pulse 1s infinite' };
  const proxy = artboardProxyStyle(original, 800);
  expect(proxy).toMatchObject({ position: original.position, left: original.left, top: original.top, width: original.width, height: '800px', transform: original.transform, borderWidth: original.borderWidth });
  expect(JSON.stringify(proxy)).not.toContain('bogen-asset:');
  expect(proxy.filter).toBeUndefined(); expect(proxy.animation).toBeUndefined();
  expect(original.height).toBe('fit-content'); expect(original.background).toContain('wallpaper');
});
