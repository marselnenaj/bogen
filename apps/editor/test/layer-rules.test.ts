import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('../src/doc/session.ts'); });

async function setup(overrides: Record<string, unknown> = {}) {
  let active: unknown = { snap: { subscribe: vi.fn(() => vi.fn()), tokens: [], nodes: new Map(), ...overrides } };
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++next, fn); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.doMock('../src/doc/session.ts', () => ({
    session: () => { if (!active) throw new Error('No file is open.'); return active; },
    maybeSession: () => active,
  }));
  const { showRules } = await import('../src/canvas/layer-rules.ts');
  return { showRules, frames, close: () => { active = null; } };
}

test('layer cleanup can follow the parent closing its file session', async () => {
  const { showRules, close, frames } = await setup();
  const remove = showRules('responsive-layer');
  expect(frames.size).toBe(1);
  close();
  expect(() => remove()).not.toThrow();
  expect(frames.size).toBe(0);
});

test('a pending style frame can land after its file has closed', async () => {
  const { showRules, close, frames } = await setup();
  const remove = showRules('responsive-layer');
  const render = [...frames.values()][0]!;
  close();
  expect(() => render(0)).not.toThrow();
  expect(() => remove()).not.toThrow();
});

test('a fluid preview evaluates root breakpoints against the viewport, while fixed artboards retain their width', async () => {
  const sheet = { dataset: {}, textContent: '' };
  vi.stubGlobal('document', { createElement: () => sheet, head: { append: vi.fn() } });
  const { showRules, frames } = await setup({
    nodes: new Map([['board', { id: 'board', style: { width: '1440px' }, rules: { '@media (max-width: 760px)': { '--bar': '48px' } } }]]),
    ancestors: () => [], isHidden: () => false,
  });
  const remove = showRules('board');
  [...frames.values()][0]!(0);
  expect(sheet.textContent).toContain('@media (max-width: 760px)');
  expect(sheet.textContent).toContain('.pv-world[data-fluid] .bgn-board{--bar:48px !important}');
  expect(sheet.textContent).not.toContain('.bogen-world:not([data-fluid]) .bgn-board{--bar:48px');
  remove();
});
