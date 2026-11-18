import { describe, expect, it } from 'vitest';
import { breakLines, placeWords, routeFlows, ScreenIndex, type Box, type FlowRoute, type Pt } from '../src/canvas/flow-layout.ts';

const phone = (i: number, row = 0): Box => ({ x: 80 + i * 486, y: 196 + row * 1000, w: 390, h: 844 });
const inside = (p: Pt, b: Box) => p.x > b.x + 0.5 && p.x < b.x + b.w - 0.5 && p.y > b.y + 0.5 && p.y < b.y + b.h - 0.5;
/** Points along every stretch of a route, a unit apart. */
function along(r: FlowRoute): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < r.points.length; i++) {
    const a = r.points[i - 1]!; const b = r.points[i]!; const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
    for (let k = 0; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / (n || 1), y: a.y + ((b.y - a.y) * k) / (n || 1) });
  }
  return out;
}
const orthogonal = (r: FlowRoute) => r.points.slice(1).every((q, i) => q.x === r.points[i]!.x || q.y === r.points[i]!.y);

describe('routes between screens', () => {
  const row = [0, 1, 2, 3].map(i => phone(i));
  const below = [0, 1].map(i => phone(i, 1));
  const all = [...row, ...below];
  const boxes = new Map(all.map((b, i) => [`s${i}`, b]));

  it('joins neighbours with a straight line between facing sides', () => {
    const [r] = routeFlows([{ from: 's0', to: 's1', label: 'Next' }], boxes, all);
    expect(r!.routed).toBe(true);
    expect(r!.points).toEqual([{ x: 470, y: 618 }, { x: 566, y: 618 }]);
    expect(r!.tip.angle).toBe(0);
  });

  it('goes round a screen that stands between, never across it', () => {
    const [r] = routeFlows([{ from: 's0', to: 's2', label: 'Skip' }], boxes, all);
    expect(r!.routed).toBe(true);
    expect(orthogonal(r!)).toBe(true);
    expect(along(r!).some(p => inside(p, row[1]!))).toBe(false);
  });

  it('drops to the next row through the gap between the rows', () => {
    const [r] = routeFlows([{ from: 's3', to: 's4', label: 'Account' }], boxes, all);
    expect(orthogonal(r!)).toBe(true);
    for (const b of all) expect(along(r!).some(p => inside(p, b))).toBe(false);
    // It leaves through the bottom and arrives from above.
    expect(r!.points[0]!.y).toBe(row[3]!.y + row[3]!.h);
    expect(r!.tip.y).toBe(below[0]!.y);
    expect(r!.tip.angle).toBe(90);
  });

  it('keeps two connections between the same screens apart', () => {
    const [a, b] = routeFlows([{ from: 's1', to: 's2', label: 'Check' }, { from: 's2', to: 's1', label: 'Back' }], boxes, all);
    expect(a!.points[0]!.y).not.toBe(b!.points[0]!.y);
    expect(Math.abs(a!.points[0]!.y - b!.points[1]!.y)).toBeGreaterThanOrEqual(12);
  });

  it('keeps parallel stretches through one gap apart', () => {
    const routes = routeFlows([{ from: 's0', to: 's2', label: 'Skip' }, { from: 's3', to: 's4', label: 'Account' }], boxes, all);
    const flat = routes.map(r => r.points.slice(1, -1).filter((p, i, a) => i + 1 < a.length && a[i + 1]!.y === p.y).map(p => p.y));
    for (const y of flat[0]!) for (const y2 of flat[1]!) expect(Math.abs(y - y2)).not.toBeLessThan(6);
  });

  it('keeps a line that arrives from above clear of the screen\'s name, or comes in from the side', () => {
    // The name of the screen below fills 60% of its width at the farthest zoom names show at.
    const names = new Map(all.map(b => [b, b.x + b.w * 0.6]));
    const [r] = routeFlows([{ from: 's3', to: 's4', label: 'Account' }], boxes, all, { names });
    const tip = r!.tip;
    if (tip.angle === 90) expect(tip.x).toBeGreaterThan(below[0]!.x + below[0]!.w * 0.6);
    else expect([0, 180]).toContain(Math.round(Math.abs(tip.angle)));
    // And nothing runs through a name band.
    const band = (b: Box) => ({ x: b.x, y: b.y - 105, w: b.w * 0.6, h: 105 });
    for (const b of all) expect(along(r!).some(p => inside(p, band(b)))).toBe(false);
  });

  it('keeps every line its own, also lines that leave the same screen', () => {
    const routes = routeFlows([{ from: 's0', to: 's2', label: 'A' }, { from: 's0', to: 's3', label: 'B' }, { from: 's1', to: 's3', label: 'C' }], boxes, all);
    const runs = routes.map(r => r.points.slice(1, -1).find((p, i, a) => i + 1 < a.length && a[i + 1]!.y === p.y)?.y);
    for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) expect(Math.abs(runs[i]! - runs[j]!)).toBeGreaterThanOrEqual(6);
  });

  it('keeps lines apart on the screen when routing for a far zoom', () => {
    const routes = routeFlows([{ from: 's0', to: 's2', label: 'A' }, { from: 's1', to: 's3', label: 'C' }], boxes, all, { zoom: 0.3 });
    const runs = routes.map(r => r.points.slice(1, -1).find((p, i, a) => i + 1 < a.length && a[i + 1]!.y === p.y)?.y);
    // At least five screen pixels apart at 30%.
    expect(Math.abs(runs[0]! - runs[1]!) * 0.3).toBeGreaterThanOrEqual(5);
  });

  it('routes a hundred connections among two hundred screens quickly', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ x: (i % 20) * 486, y: Math.floor(i / 20) * 1100, w: 390, h: 844 }));
    const map = new Map(many.map((b, i) => [`m${i}`, b]));
    const conns = Array.from({ length: 100 }, (_, i) => ({ from: `m${i * 2}`, to: `m${(i * 2 + 3) % 200}`, label: `Step ${i}` }));
    const t0 = performance.now();
    const routes = routeFlows(conns, map, many);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(routes.every(r => r.routed)).toBe(true);
  });
});

describe('words at a zoom', () => {
  const row = [0, 1, 2].map(i => phone(i));
  const index = new ScreenIndex(row.map(box => ({ box, nameWidth: 80 })));
  const boxes = new Map(row.map((b, i) => [`s${i}`, b]));
  const routes = routeFlows([{ from: 's0', to: 's1', label: 'Open the invitation' }, { from: 's0', to: 's2', label: 'Skip when signed in' }], boxes, row);
  const words = (text: string) => text.split(' ').map(w => w.length * 6);
  const labels = routes.map(r => ({ key: r.label, route: r.points, words: words(r.label), space: 3, width: 0 }));
  const section = { id: 'a', box: { x: 16, y: 56, w: 1430, h: 1048 }, top: 196, titleWidth: 140, purposeWidth: 420, compactWidth: 120 };
  const lane = { key: 'a-0', section: 'a', box: { x: 80, y: 196, w: 1362, h: 844 }, width: 70 };

  it('wraps a label to fit a neighbour gap at full size', () => {
    const p = placeWords(1, index, [section], [lane], labels);
    const open = p.labels.get('Open the invitation')!;
    expect(open.lines.length).toBeGreaterThan(1);
    expect(open.width).toBeLessThanOrEqual(96);
    expect(p.lanes.get('a-0')).toBe(true);
    expect(p.sections.get('a')).toEqual({ lod: 'one', grow: 0, wide: false });
  });

  it('hides labels and lane names that no longer fit far out, but keeps the section title', () => {
    const p = placeWords(0.08, index, [section], [lane], labels);
    expect(p.labels.size).toBe(0);
    expect(p.lanes.get('a-0')).toBe(false);
    expect(['title', 'compact']).toContain(p.sections.get('a')!.lod);
    // This far out the screens' names are hidden, so the frame does not reach up for them.
    expect(p.sections.get('a')!.grow).toBe(0);
  });

  it('never places two words on top of each other', () => {
    for (const z of [0.08, 0.15, 0.3, 0.6, 1, 2]) {
      const p = placeWords(z, index, [section], [lane], labels);
      const rects = [...p.labels.values()].map(l => ({ x: l.x - l.width / 2 / z, y: l.y - l.height / 2 / z, w: l.width / z, h: l.height / z }));
      for (const r of rects) for (const s of row) expect(r.x < s.x + s.w && r.x + r.w > s.x && r.y < s.y + s.h && r.y + r.h > s.y).toBe(false);
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!; const b = rects[j]!;
        expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false);
      }
    }
  });

  it('breaks lines greedily and refuses a word wider than the line', () => {
    expect(breakLines([30, 20, 40], 4, 60)).toEqual([2, 1]);
    expect(breakLines([70], 4, 60)).toBeNull();
  });
});
