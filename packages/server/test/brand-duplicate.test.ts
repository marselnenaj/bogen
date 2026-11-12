import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

describe('a duplicated brand', () => {
  let h: Harness;
  let agent: Client;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'writer');
  });
  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('is a new brand at version 0 that says where it came from, and linked files stay with the original', async () => {
    const original = (await call(agent, 'brand_create', { name: 'Acme' })).id;
    await call(agent, 'brand_update', { brand_id: original, confirmed: true, fields: { language: 'de', minContrast: 7 } });
    const file = (await call(agent, 'file_create', { name: 'Linked' })).id;
    await call(agent, 'brand_link', { brand_id: original, file_id: file });
    await call(agent, 'brand_publish', { brand_id: original, note: 'Second' });
    // An agent's proposal: it binds nobody, so the copy keeps the published contrast.
    await call(agent, 'brand_update', { brand_id: original, fields: { minContrast: 3 } });

    const copy = await call(agent, 'brand_duplicate', { brand_id: original });
    expect(copy).toMatchObject({ name: 'Acme copy', version: 0, duplicated_from: { brand_id: original, name: 'Acme', version: 2 } });
    expect(await call(agent, 'brand_versions', { brand_id: copy.id })).toEqual([]);
    const read = await call(agent, 'brand_get', { brand_id: copy.id, raw: true });
    expect(read.version).toBeNull();
    expect(read.duplicated_from.note).toBe('Duplicated from Acme, version 2. It is a brand of its own: its versions start again, and files linked to Acme stay linked to it.');
    expect(read.raw.fields).toMatchObject({ minContrast: 7, language: 'de' });
    expect(read.raw.suggestedFields).toEqual([]);
    const full = await (await fetch(`${h.base}/api/brands/${copy.id}`)).json();
    expect(full).toMatchObject({ versions: [], draftChanges: 0, duplicatedFrom: { id: original, name: 'Acme', version: 2 } });
    // The original keeps its versions, its proposal and its file.
    expect(await call(agent, 'brand_versions', { brand_id: original })).toHaveLength(2);
    expect((await (await fetch(`${h.base}/api/files/${file}/brand`)).json()).link.id).toBe(original);
    const list = await call<any[]>(agent, 'brand_list');
    expect(list.find((b) => b.id === copy.id)).toMatchObject({ version: 0, linkedFiles: 0, isDefault: false });
    expect(list.find((b) => b.id === original)).toMatchObject({ version: 2, linkedFiles: 1 });
  });
});
