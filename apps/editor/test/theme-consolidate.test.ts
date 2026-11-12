import { describe, expect, it } from 'vitest';
import { canConfirm, canReview, importCount, MAX_SOURCES, pickOrder, sourcesFor, startPick, statsOf, type ConsolidationPlan, type PlanFile, type PlanSource } from '../src/lib/theme-consolidate.ts';
import { groupCopies, type ThemeProject } from '../src/lib/theme-library.ts';
import { heldLines } from '../src/lib/design-branches-api.ts';

const file = (file_id: string, patch: Partial<PlanFile> = {}): PlanFile => ({
  file_id, name: 'Tokyo Night Custom', theme: { name: 'Tokyo Night Custom', target: 'desktop' }, updatedAt: 0, layers: 933, tokens: 71, comments: 0, assets: 10, hash: file_id, active: false, ...patch,
});
const source = (file_id: string, action: PlanSource['action'], patch: Partial<PlanSource> = {}): PlanSource => ({ ...file(file_id), action, ...patch });
const plan = (patch: Partial<ConsolidationPlan> = {}): ConsolidationPlan => ({
  target: file('vk', { active: true, layers: 946 }), sources: [source('j5', 'import', { branchName: 'Tokyo Night Custom (j5)' }), source('6n', 'skip', { reason: 'identical', identicalTo: 'j5' })],
  problems: [], ok: true, plan_hash: 'h1', note: 'Sources stay as they are.', ...patch,
});

describe('bringing copies of a theme together', () => {
  const copies = [{ file_id: 'vk', updatedAt: 1 }, { file_id: 'j5', updatedAt: 9 }, { file_id: '6n', updatedAt: 5 }, { file_id: '1q', updatedAt: 3 }];
  const ids = copies.map((c) => c.file_id);

  it('starts with no copy picked, and lists them in an order that says nothing about which to keep', () => {
    expect(startPick()).toEqual({ step: 'pick', target: null });
    // By file id: not the newest (j5) first, not the one in use first.
    expect(pickOrder(copies).map((c) => c.file_id)).toEqual(['1q', '6n', 'j5', 'vk']);
    expect(copies.map((c) => c.file_id)).toEqual(['vk', 'j5', '6n', '1q']);
  });

  it('reviews only once a copy is picked, with the other copies as sources', () => {
    expect(canReview(ids, null)).toBe(false);
    expect(canReview(ids, 'elsewhere')).toBe(false);
    expect(canReview(ids, '6n')).toBe(true);
    expect(sourcesFor(ids, '6n')).toEqual(['vk', 'j5', '1q']);
    expect(sourcesFor([...ids, 'vk'], 'j5')).toEqual(['vk', '6n', '1q']);
    expect(canReview(['vk'], 'vk')).toBe(false);
  });

  it('takes at most eleven copies besides the kept one', () => {
    const many = Array.from({ length: MAX_SOURCES + 2 }, (_, i) => `f${i}`);
    expect(canReview(many.slice(0, MAX_SOURCES + 1), 'f0')).toBe(true);
    expect(canReview(many, 'f0')).toBe(false);
  });

  it('confirms only a sound plan without problems that brings something in', () => {
    expect(canConfirm(null)).toBe(false);
    expect(canConfirm(plan())).toBe(true);
    expect(importCount(plan())).toBe(1);
    expect(canConfirm(plan({ ok: false }))).toBe(false);
    expect(canConfirm(plan({ problems: ['vktenhezqv is being edited right now'] }))).toBe(false);
    expect(canConfirm(plan({ plan_hash: '' }))).toBe(false);
    expect(canConfirm(plan({ sources: [source('j5', 'skip', { reason: 'already imported' })] }))).toBe(false);
  });

  it('reads the facts of every copy from one plan, whichever copy it was asked about', () => {
    const stats = statsOf(plan());
    expect([...stats.keys()].sort()).toEqual(['6n', 'j5', 'vk']);
    expect(stats.get('vk')).toMatchObject({ active: true, layers: 946, tokens: 71 });
    expect(statsOf(null).size).toBe(0);
  });

  it('takes every copy of the group, also those Home\'s filters leave out', () => {
    const p = (file_id: string, patch: Partial<ThemeProject> = {}): ThemeProject => ({ file_id, file_name: file_id, name: file_id, slug: null, target: 'desktop', updatedAt: 0, status: 'draft', branch: { current: 'main', open: [] }, ...patch });
    const projects = [p('vk'), p('j5', { folder: 'Archive' }), p('lift'), p('x', { group: 'tokyo' })];
    expect(groupCopies(projects, { key: 'tokyo', label: 'Tokyo Night Custom', file_ids: ['vk', 'j5'], reason: '' }).map((c) => c.file_id)).toEqual(['vk', 'j5', 'x']);
  });
});

describe('held-back updates on a branch', () => {
  it('read as one line per device, in the order they came', () => {
    const h = (from: string, at: number) => ({ id: `${from}${at}`, at: new Date(Date.UTC(2026, 10, 6, 0, 0, at)).toISOString(), from, bytes: 10, layers: [], inFile: true });
    expect(heldLines(undefined)).toEqual([]);
    expect(heldLines([h('MacBook', 3), h('Phone', 1), h('MacBook', 2)])).toEqual([{ from: 'Phone', count: 1 }, { from: 'MacBook', count: 2 }]);
  });
});
