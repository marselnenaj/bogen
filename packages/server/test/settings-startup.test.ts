import { afterEach, expect, it, vi } from 'vitest';
import { startServer, type Harness } from './helpers.ts';
let h: Harness | undefined;
afterEach(async () => { await h?.cleanup(); vi.restoreAllMocks(); });
it('opening the editor settings snapshot never starts a model catalog, but an explicit picker still can', async () => {
  h = await startServer();
  const probe = vi.spyOn(h.server.runSettings, 'catalog').mockResolvedValue({ id: 'claude', models: [{ id: 'test-model', label: 'Account model' }], efforts: [], cheap: {}, source: 'cli', entry: 'catalog' });
  const fast = await fetch(h.base+'/api/run-settings?catalogs=loaded').then((r) => r.json());
  expect(fast.settings.runners.claude).toBeDefined();
  expect(fast.catalogs).toEqual({}); expect(probe).not.toHaveBeenCalled();
  const chosen = await fetch(h.base+'/api/run-settings/catalog/claude').then((r) => r.json());
  expect(chosen.models[0].label).toBe('Account model'); expect(probe).toHaveBeenCalledOnce();
});
