import { addCritique, BogenDoc, type CritiqueRecord } from '@bogen/core';
import { describe, expect, it } from 'vitest';
import { appBoardOf, appIssuesFrom, appReview, type AppEl } from '../src/mcp/app-checks.ts';
import { critiqueGate } from '../src/design-quality.ts';

/** An artboard and the rendered layers the probe would report, without a browser. */
function setup(name = 'Today (iOS)', width = 393, height = 852) {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  const board = doc.insert(page, { type: 'frame', tag: 'main', name, artboard: true, style: { width: `${width}px`, height: `${height}px`, display: 'flex', flexDirection: 'column' } });
  return { doc, page, board };
}

const BASE: Omit<AppEl, 'id' | 'parent' | 'x' | 'y' | 'w' | 'h'> = {
  tag: 'div', role: '', display: 'block', position: 'static', flexDirection: 'row', alignItems: 'normal', alignSelf: 'auto', justifyContent: 'normal',
  textAlign: 'start', autoMargin: false, pad: [0, 0, 0, 0], box: false, text: '', fontSize: 17, inline: false, floating: false, svg: false,
};
const el = (id: string, parent: string, x: number, y: number, w: number, h: number, more: Partial<AppEl> = {}): AppEl => ({ ...BASE, id, parent, x, y, w, h, ...more });
const column = { display: 'flex', flexDirection: 'column', alignItems: 'stretch' } as const;

describe('app checks', () => {
  it('knows a phone app artboard and its platform from names, kits and width', () => {
    const { doc, board } = setup('Today (iOS)');
    expect(appBoardOf(doc, board)).toMatchObject({ platform: 'ios', statusBar: 54, homeIndicator: 34, target: 44 });
    const android = setup('Today', 412, 915);
    expect(appBoardOf(android.doc, android.board)).toMatchObject({ platform: 'android', statusBar: 24, target: 48 });
    expect(appBoardOf(android.doc, android.board, { fileName: 'Pantry (iOS)' })?.platform).toBe('ios');
    const web = setup('Landing', 1440, 900);
    expect(appBoardOf(web.doc, web.board)).toBeNull();
  });

  it('marks words and controls in the status bar and the home indicator strip as hard, once per edge', () => {
    const { doc, board } = setup();
    const b = appBoardOf(doc, board)!;
    const els = [
      el('status', board, 0, 0, 393, 54, { ...column }), el('time', 'status', 40, 16, 40, 22, { text: '9:41' }),
      el('body', board, 0, 54, 393, 798, { ...column, pad: [0, 16, 0, 16] }),
      el('pill', 'body', 16, 40, 120, 30, { text: 'Power is out', box: true }),
      el('restore', 'body', 40, 812, 70, 16, { tag: 'a', text: 'Restore' }),
      el('terms', 'body', 140, 812, 50, 16, { tag: 'a', text: 'Terms' }),
    ];
    const issues = appIssuesFrom(doc, b, els, { hasKit: true });
    const safe = issues.filter((i) => i.check === 'safe-area');
    expect(safe).toHaveLength(2);
    expect(safe.every((i) => i.severity === 'hard')).toBe(true);
    expect(safe[0]!.message).toContain('"Power is out"');
    expect(safe[1]!.message).toContain('restore "Restore", terms "Terms"');
    // The time is the status bar itself.
    expect(safe.some((i) => i.message.includes('9:41'))).toBe(false);
    // Small links: under the WCAG minimum is hard.
    expect(issues.filter((i) => i.check === 'target-minimum').map((i) => i.nodeId)).toEqual(['restore', 'terms']);
  });

  it('finds edges and gaps that slip by 1 to 3px, and leaves values at the end of a row alone', () => {
    const { doc, board } = setup();
    const b = appBoardOf(doc, board)!;
    const els = [
      el('body', board, 0, 54, 393, 700, { ...column, pad: [0, 16, 0, 16] }),
      el('h1', 'body', 16, 60, 361, 41, { text: 'Today', fontSize: 34 }),
      el('card-a', 'body', 16, 117, 361, 80, { ...column, box: true, pad: [16, 16, 16, 16] }),
      el('a-title', 'card-a', 32, 133, 329, 22, { text: 'Water' }),
      el('card-b', 'body', 16, 213, 361, 80, { ...column, box: true, pad: [16, 16, 16, 18] }),
      el('b-title', 'card-b', 34, 229, 327, 22, { text: 'Food' }),
      el('card-c', 'body', 16, 307, 361, 80, { ...column, box: true, pad: [16, 16, 16, 16] }),
      el('c-title', 'card-c', 32, 323, 329, 22, { text: 'Light' }),
      // A row whose value sits wherever its text ends.
      el('row', 'body', 16, 403, 361, 44, { display: 'flex', justifyContent: 'space-between' }),
      el('label', 'row', 16, 414, 100, 22, { text: 'Days covered' }),
      el('value', 'row', 335, 414, 42, 22, { text: '9 days' }),
    ];
    const issues = appIssuesFrom(doc, b, els, { hasKit: true });
    const edges = issues.filter((i) => i.check === 'edge-slip');
    expect(edges.map((i) => i.nodeId)).toEqual(['b-title']);
    expect(edges[0]!.severity).toBe('hard');
    expect(edges[0]!.message).toContain('x=34px');
    expect(issues.find((i) => i.check === 'padding-slip')?.nodeId).toBe('card-b');
    // 16, 16 then 14: the 14 is the slip.
    const gaps = issues.filter((i) => i.check === 'gap-slip');
    expect(gaps.map((i) => i.nodeId)).toEqual(['card-c']);
    expect(gaps[0]!.message).toContain('14px');
  });

  it('keeps optical padding over display type, hairline gaps and a decided two-step rhythm', () => {
    const { doc, board } = setup();
    const b = appBoardOf(doc, board)!;
    const els = [
      el('body', board, 0, 54, 393, 700, { ...column, pad: [0, 16, 0, 16] }),
      el('hero', 'body', 16, 60, 361, 140, { ...column, box: true, pad: [12, 16, 16, 16] }),
      el('figure', 'hero', 32, 72, 200, 96, { text: 'Rung 4', fontSize: 80 }),
      el('r1', 'body', 16, 216, 361, 44, { box: true }), el('r2', 'body', 16, 261, 361, 44, { box: true }), el('r3', 'body', 16, 306, 361, 44, { box: true }),
      el('s1', 'body', 16, 374, 361, 44, { box: true }), el('s2', 'body', 16, 426, 361, 44, { box: true }), el('s3', 'body', 16, 478, 361, 44, { box: true }),
    ];
    const issues = appIssuesFrom(doc, b, els, { hasKit: true });
    expect(issues.filter((i) => i.severity === 'hard')).toEqual([]);
  });

  it('gives the platform conventions as advice with numbers: targets, the tab bar, a hole, no kit', () => {
    const { doc, board } = setup();
    const b = appBoardOf(doc, board)!;
    const tab = (i: number) => [
      el(`t${i}`, 'tabs', i * 98, 754, 98, 64, { ...column }),
      el(`i${i}`, `t${i}`, i * 98 + 37, 760, 24, 24, { svg: true }),
      el(`l${i}`, `t${i}`, i * 98 + 30, 790, 40, 16, { text: `Tab ${i}`, fontSize: 12 }),
    ];
    const els = [
      el('body', board, 0, 54, 393, 700, { ...column, pad: [24, 16, 24, 16] }),
      el('title', 'body', 16, 78, 361, 34, { text: 'Camera is off', fontSize: 28 }),
      el('text', 'body', 16, 124, 361, 44, { text: 'Turn on the camera in Settings to judge reps.' }),
      el('actions', 'body', 16, 600, 361, 50, { ...column }),
      el('open', 'actions', 16, 600, 361, 50, { tag: 'button', text: 'Open Settings', box: true }),
      el('chip', 'body', 16, 180, 60, 30, { tag: 'button', text: 'Log', box: true }),
      el('tabbar', board, 0, 754, 393, 98, { ...column, box: true }),
      el('tabs', 'tabbar', 0, 754, 393, 64, { display: 'flex' }),
      ...tab(0), ...tab(1), ...tab(2), ...tab(3),
    ];
    const issues = appIssuesFrom(doc, b, els, { hasKit: false });
    const by = (check: string) => issues.filter((i) => i.check === check);
    expect(by('platform-target').map((i) => i.nodeId)).toEqual(['chip']);
    expect(by('tab-bar')[0]!.message).toContain('98px tall');
    expect(by('platform-kit')[0]!.message).toContain('kit_use ionic-ios');
    expect(issues.filter((i) => ['platform-target', 'tab-bar', 'platform-kit', 'empty-band'].includes(i.check!)).every((i) => i.severity === 'advisory' && i.why)).toBe(true);
  });
});

describe('design_review on an app screen', () => {
  it('says the platform, whether a kit is linked, and asks for five sizes', () => {
    const { doc, board } = setup();
    const [platform, scale] = appReview(doc, board, 7)!;
    expect(platform!.message).toContain('393x852 iPhone');
    expect(platform!.message).toContain('kit_use ionic-ios');
    expect(scale!.message).toContain('7 font sizes');
    expect(appReview(doc, board, 5)).toHaveLength(1);
    const web = setup('Landing', 1440, 900);
    expect(appReview(web.doc, web.board, 9)).toBeNull();
  });
});

describe('the done-step of an app screen', () => {
  it('reports scores and objective defects without demanding another review', () => {
    const { doc, board } = setup();
    expect(critiqueGate(doc, board, true).state).toBe('missing');
    expect(critiqueGate(doc, board, true).next).toContain('At most one');
    expect(critiqueGate(doc, board, false).state).toBe('unavailable');
    const record = (round: number, score: number, defects: number, maxRounds = 3) => ({
      id: `r${round}${score}`, at: Date.now() + round, screens: [{ id: board, name: 'Today' }], series: 'abcdefabcdef', round, maxRounds, reviewer: 'Fable', score,
      dimensions: {}, verdict: '', defects: Array.from({ length: defects }, (_, i) => ({ screens: [1], kind: 'layout', title: `d${i}`, evidence: 'e', fix: 'f' })), taste: [], keep: [], ruleFindings: 0, durationMs: 1,
    });
    const add = (r: ReturnType<typeof record>) => addCritique(doc, r as unknown as CritiqueRecord);
    add(record(1, 6.5, 4));
    expect(critiqueGate(doc, board, true)).toMatchObject({ state: 'reviewed', score: 6.5, defects: 4 });
    expect(critiqueGate(doc, board, true).open?.map((d) => d.title)).toEqual(['d0', 'd1', 'd2', 'd3']);
    add(record(2, 8.2, 2));
    expect(critiqueGate(doc, board, true)).toMatchObject({ state: 'reviewed', score: 8.2, defects: 2 });
    expect(critiqueGate(doc, board, true).next).toContain('report any still open');
    expect(critiqueGate(doc, board, true).next).toContain('Do not re-review');
    add(record(3, 7, 1));
    expect(critiqueGate(doc, board, true)).toMatchObject({ state: 'reviewed', score: 7 });
  });
});
