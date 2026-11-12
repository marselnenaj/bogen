import { describe, expect, it } from 'vitest';
import { catalogsToLoad } from '../src/panels/run-catalogs.ts';

describe('which runner catalogs a picker asks for', () => {
  it('asks for the lanes\' runners that have none yet, once each, and nothing before settings arrived', () => {
    const loaded = { claude: {}, codex: {} };
    expect(catalogsToLoad(undefined, ['opencode'], new Set())).toEqual([]);
    // A race of Claude, OpenCode and OpenCode: one request, for OpenCode.
    expect(catalogsToLoad(loaded, ['claude', 'opencode', 'opencode'], new Set())).toEqual(['opencode']);
    // Not again while one is on its way, nor once it is there.
    expect(catalogsToLoad(loaded, ['opencode'], new Set(['opencode']))).toEqual([]);
    expect(catalogsToLoad({ ...loaded, opencode: {} }, ['opencode'], new Set())).toEqual([]);
    // No runner Bogen does not know, and only the ones shown: never every runner.
    expect(catalogsToLoad(loaded, ['nobody', 'claude'], new Set())).toEqual([]);
  });
});
