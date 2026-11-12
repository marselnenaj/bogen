import { describe, expect, it } from 'vitest';
import { CANVAS_MIN, chromeLayout, FILE_NAME_MIN, fitToolbar, toolbarLevel, toolbarNeed, type ChromeInput, type ToolbarContent, type ToolbarLevel } from '../src/state/chrome-layout.ts';

const at = (width: number, height: number, scale = 1, leftWidth = 248, rightWidth = 280): ChromeInput => ({ width, height, scale, leftWidth, rightWidth });
const canvas = (l: ReturnType<typeof chromeLayout>, width: number) => width - (l.left === 'docked' ? l.leftPx : 0) - (l.right === 'docked' ? l.rightPx : 0);

describe('the editor chrome at each window size', () => {
  it('keeps both panels at their chosen widths where they leave the canvas room', () => {
    for (const [w, h] of [[1440, 900], [1728, 1117], [1280, 720], [1024, 640], [1280, 500]] as const) {
      const l = chromeLayout(at(w, h));
      expect(l).toMatchObject({ mode: 'wide', left: 'docked', right: 'docked', leftPx: 248, rightPx: 280 });
      expect(canvas(l, w)).toBeGreaterThanOrEqual(CANVAS_MIN);
    }
  });

  it('at 860 × 540 keeps the inspector beside a usable canvas and moves layers into a drawer', () => {
    const l = chromeLayout(at(860, 540));
    expect(l).toMatchObject({ mode: 'compact', left: 'drawer', right: 'docked', rightPx: 280, short: true, toolbar: 'compact' });
    expect(canvas(l, 860)).toBe(580);
  });

  it('at 640 × 480 narrows the inspector to leave the canvas its minimum, or moves both into drawers', () => {
    const l = chromeLayout(at(640, 480));
    expect(l).toMatchObject({ mode: 'compact', right: 'docked', rightPx: 280, toolbar: 'mini', short: true });
    expect(canvas(l, 640)).toBe(CANVAS_MIN);
    const tiny = chromeLayout(at(520, 480));
    expect(tiny).toMatchObject({ mode: 'narrow', left: 'drawer', right: 'drawer' });
    expect(tiny.leftPx).toBeLessThanOrEqual(520 - 40);
  });

  it('counts the UI scale honestly: the same window has less room at 1.25 and 1.5', () => {
    expect(chromeLayout(at(1024, 640, 1)).mode).toBe('wide');
    // 1.25: 310 + 350 px of panels still leave 364 px of canvas; 1.5 does not.
    expect(chromeLayout(at(1024, 640, 1.25))).toMatchObject({ mode: 'wide', short: true });
    expect(chromeLayout(at(1024, 640, 1.5))).toMatchObject({ mode: 'compact', rightPx: 420 });
    const big = chromeLayout(at(640, 480, 1.5));
    expect(big.mode).toBe('narrow');
    expect(big.toolbar).toBe('micro');
    // 1440 px at 1.5 is a 960 px toolbar.
    expect(chromeLayout(at(1440, 900, 1.5)).toolbar).toBe('tight');
  });

  it('never changes the widths a person chose; it only draws them narrower or as drawers', () => {
    const input = at(760, 540, 1, 300, 480);
    const l = chromeLayout(input);
    expect(l).toMatchObject({ mode: 'compact', rightPx: 760 - CANVAS_MIN });
    expect(input).toMatchObject({ leftWidth: 300, rightWidth: 480 });
    // Wide again, both come back at their own widths.
    expect(chromeLayout({ ...input, width: 1600 })).toMatchObject({ mode: 'wide', leftPx: 300, rightPx: 480 });
  });

  it('shows less of the toolbar as it narrows, by its width at the UI scale', () => {
    expect([1440, 1120, 1024, 900, 860, 700, 640, 560, 480].map(toolbarLevel)).toEqual(['full', 'full', 'tight', 'tight', 'compact', 'compact', 'mini', 'mini', 'micro']);
  });

  it('fits the toolbar to what it holds: branches, a synced device, people and drawers move tools into menus first', () => {
    const none: ToolbarContent = { leftDrawer: false, rightDrawer: false, sync: false, peers: 0, following: false, branchNamed: false };
    const busy: ToolbarContent = { leftDrawer: true, rightDrawer: true, sync: true, peers: 2, following: true, branchNamed: true };
    // Nothing extra: the window's own level, as before.
    for (const w of [1440, 1120, 1024, 900, 860, 700, 640, 560, 480, 300]) expect(fitToolbar(w, none)).toBe(toolbarLevel(w));
    // A long branch and a synced device at 1280: the view buttons move into More, the branch keeps its name.
    expect(fitToolbar(1280, { ...none, sync: true, peers: 1, branchNamed: true })).toBe('tight');
    expect(fitToolbar(1280, { ...none, peers: 1, branchNamed: true })).toBe('full');
    // Never fuller than the window's level.
    expect(fitToolbar(2000, none, 'compact')).toBe('compact');
    // Everything at once in a 430 px window at 1.5 (287 UI px): the smallest level, and it fits.
    expect(fitToolbar(430 / 1.5, busy)).toBe('micro');
    // Following someone too: the pill is Stop following in More there, so the smallest level still fits.
    expect(toolbarNeed('micro', busy)).toBeLessThanOrEqual(430 / 1.5);
    expect(toolbarNeed('micro', busy)).toBe(toolbarNeed('micro', { ...busy, following: false }));
    expect(toolbarNeed('mini', busy)).toBeGreaterThan(toolbarNeed('mini', { ...busy, following: false }));
  });

  it('leaves the file name its minimum at every level it picks, for the supported window sizes', () => {
    const levels: ToolbarLevel[] = ['full', 'tight', 'compact', 'mini', 'micro'];
    for (const w of [1280, 1024, 860, 700, 640, 520, 430]) for (const scale of [1, 1.25, 1.5]) for (const sync of [false, true]) for (const branchNamed of [false, true]) {
      const ui = w / scale;
      const l = chromeLayout(at(w, 720, scale, 300, 320));
      const c: ToolbarContent = { leftDrawer: l.left === 'drawer', rightDrawer: l.right === 'drawer', sync, peers: 2, following: sync, branchNamed };
      const level = fitToolbar(ui, c, l.toolbar);
      expect(levels.indexOf(level)).toBeGreaterThanOrEqual(levels.indexOf(l.toolbar));
      // What is left for the name beyond its minimum is never negative.
      expect(ui - toolbarNeed(level, c), `${w}@${scale} ${level}`).toBeGreaterThanOrEqual(0);
      expect(FILE_NAME_MIN[level]).toBeGreaterThanOrEqual(72);
    }
  });
});
