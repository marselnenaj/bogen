import { afterEach, describe, expect, it } from 'vitest';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

describe('tokens_rename', () => {
  it('renames a token with every reference, reports a dry run first, and refuses a taken name', async () => {
    const h = await startServer();
    harnesses.push(h);
    const client = await connectAgent(h.base, 'claude');
    const file = await call(client, 'file_create', { name: 'Rename' });
    await call(client, 'tokens_set', { tokens: [{ name: 'ink', kind: 'color', value: '#111' }, { name: 'paper', kind: 'color', value: '#fff' }] });
    const board = await call(client, 'artboard_create', { name: 'A', width: 400 });
    await call(client, 'html_write', { target_id: board.id, html: '<div style="color:var(--ink);border:1px solid var(--ink, #000)"><p style="color:var(--ink)">Hi</p></div>' });

    const dry = await call(client, 'tokens_rename', { from: '--ink', to: 'text', dry_run: true });
    expect(dry).toMatchObject({ from: 'ink', to: 'text', dry_run: true, layers: 2, references: 3 });

    const done = await call(client, 'tokens_rename', { from: 'ink', to: 'text' });
    expect(done).toMatchObject({ layers: 2, references: 3, dry_run: false });
    const code = await call(client, 'code_get', { node_id: board.id });
    expect(JSON.stringify(code)).not.toMatch(/--ink\b/);
    expect(JSON.stringify(code)).toContain('var(--text');

    await expect(call(client, 'tokens_rename', { from: 'text', to: 'paper' })).rejects.toThrow(/already/);
    void file;
    await client.close();
  });
});

describe('a brand that renames a token', () => {
  it('renames it in linked files when it is applied, with the layers that use it', async () => {
    const h = await startServer();
    harnesses.push(h);
    const client = await connectAgent(h.base, 'claude');
    const { id } = await call(client, 'brand_create', { name: 'Renames' });
    const added = await call(client, 'brand_update', { brand_id: id, confirmed: true, items: [{ section: 'colors', name: 'Ink', role: 'text', value: '#101010', token: 'ink' }] });
    const linked = await call(client, 'file_create', { name: 'Linked' });
    await call(client, 'brand_link', { brand_id: id, file_id: linked.id });
    await call(client, 'brand_apply', { brand_id: id });
    const board = await call(client, 'artboard_create', { file_id: linked.id, name: 'A', width: 400 });
    await call(client, 'html_write', { file_id: linked.id, target_id: board.id, html: '<p style="color:var(--ink)">Hi</p>' });

    const ink = added.updated[0].id as string;
    await call(client, 'brand_update', { brand_id: id, confirmed: true, items: [{ section: 'colors', id: ink, token: 'text' }] });
    const impact = await call(client, 'brand_impact', { brand_id: id });
    expect(impact.files[0].token_renames).toEqual([{ from: 'ink', to: 'text' }]);

    await call(client, 'brand_apply', { brand_id: id });
    const tokens = JSON.stringify(await call(client, 'tokens_get', { file_id: linked.id }));
    expect(tokens).toContain('text');
    expect(tokens).not.toMatch(/"ink"/);
    const code = JSON.stringify(await call(client, 'code_get', { file_id: linked.id, node_id: board.id }));
    expect(code).toContain('var(--text)');
    await client.close();
  });
});
