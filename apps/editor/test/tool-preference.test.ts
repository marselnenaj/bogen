import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it('restores a valid tool and persists an explicit choice', async () => {
  const data = new Map([['bogen-tool', 'hand']]);
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k), setItem: (k: string, v: string) => data.set(k, v) });
  const p = await import('../src/state/tool-preference.ts');
  expect(p.rememberedTool()).toBe('hand');p.rememberTool('zoom');expect(data.get('bogen-tool')).toBe('zoom');
  vi.resetModules();expect((await import('../src/state/tool-preference.ts')).rememberedTool()).toBe('zoom');
});
it('ignores an unknown stored tool and works when storage is unavailable', async () => {
  vi.stubGlobal('localStorage', { getItem: () => 'unknown-tool', setItem: () => { throw Error('private mode'); } });
  const p = await import('../src/state/tool-preference.ts');expect(p.rememberedTool()).toBe('move');
  p.rememberTool('hand');expect(p.rememberedTool()).toBe('hand');
});
