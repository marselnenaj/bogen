import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDataSource, type BogenDoc } from '@bogen/core';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

const PRODUCTS = [
  { name: 'Lamp', image: 'https://example.com/lamp.png', inStock: true, tier: 'gold' },
  { name: 'Chair', image: 'https://example.com/chair.png', inStock: false, tier: 'silver' },
];

describe('designs from data over MCP and HTTP', () => {
  let h: Harness;
  let agent: Awaited<ReturnType<typeof connectAgent>>;
  let local: Server;
  let localUrl: string;
  let doc: BogenDoc;
  let grid: string;
  let card: string;
  let silver: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'data-agent');
    const file = await call(agent, 'file_create', { name: 'Shop' });
    doc = (await h.server.rooms.get(file.id)).doc;
    const board = await call(agent, 'artboard_create', { name: 'Shop', width: 800, height: 600 });
    await call(agent, 'html_write', { target_id: board.id, html: '<span data-name="Gold" style="color:gold">Gold</span><span data-name="Silver" style="color:silver">Silver</span>' });
    const [goldNode, silverNode] = doc.getChildren(board.id);
    await call(agent, 'component_create', { node_ids: [goldNode!.id], name: 'Badge', variant_set: 'Badge', variant: { tier: 'gold' } });
    await call(agent, 'component_create', { node_ids: [silverNode!.id], name: 'Badge', variant_set: 'Badge', variant: { tier: 'silver' } });
    silver = silverNode!.id;
    await call(agent, 'html_write', { target_id: board.id, html: '<div data-name="Grid" style="display:flex;gap:8px"><article data-name="Card" style="width:120px"><h3>Name</h3><img src="https://example.com/x.png" alt="" style="width:20px;height:20px"><span data-name="Stock">In stock</span></article></div>' });
    grid = doc.getChildren(board.id).find((n) => n.name === 'Grid')!.id;
    card = doc.getChildren(grid)[0]!.id;
    await call(agent, 'instance_create', { component: 'Badge', parent_id: card, variant: { tier: 'gold' } });
    local = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ items: [{ name: 'Local lamp', tier: 'gold' }] })));
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
    localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}/items.json`;
  }, 30_000);

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
    local.close();
  });

  const parts = (copy: string) => doc.getChildren(copy);

  it('binds layers to fields and repeats a data source as a list', async () => {
    const source = await call(agent, 'data_source_set', { name: 'Products', data: JSON.stringify(PRODUCTS) });
    expect(source).toMatchObject({ name: 'Products', records: 2, fields: ['name', 'image', 'inStock', 'tier'] });
    const [title, photo, stock, badge] = doc.getChildren(card).map((n) => n.id);
    await call(agent, 'layer_bind', { node_id: title, text: 'name' });
    await call(agent, 'layer_bind', { node_id: photo, src: 'image', attrs: { alt: 'name' } });
    await call(agent, 'layer_bind', { node_id: stock, visible: 'inStock' });
    const bound = await call(agent, 'layer_bind', { node_id: badge, variant: { tier: 'tier' } });
    expect(bound.bindings.variant).toEqual({ tier: 'tier' });
    const out = await call(agent, 'layer_repeat', { node_id: card, source: 'Products' });
    expect(out).toMatchObject({ copies: 2, missing: [], source: { kind: 'source' } });
    const [lamp, chair] = out.ids as string[];
    expect(parts(lamp!)[0]!.text).toBe('Lamp');
    expect(parts(lamp!)[1]!.src).toBe('https://example.com/lamp.png');
    expect(parts(chair!)[2]!.hidden).toBe(true);
    expect(parts(chair!)[3]!.instanceOf).toBe(silver);
    const list = await call(agent, 'data_source_list', {});
    expect(list.sources[0]).toMatchObject({ name: 'Products', templates: [card] });
    expect(await call<string>(agent, 'guide_get', { topic: 'data' })).toContain('layer_bind');
  });

  it('binds one record, and goes back to the list', async () => {
    const one = await call(agent, 'layer_repeat', { node_id: card, source: 'Products', record: 1 });
    expect(one.copies).toBe(1);
    expect(parts(one.ids[0])[0]!.text).toBe('Chair');
    // Running again without arguments keeps the source and the record.
    const again = await call(agent, 'layer_repeat', { node_id: card });
    expect(again).toMatchObject({ copies: 1, source: { kind: 'source', record: 1 } });
    const all = await call(agent, 'layer_repeat', { node_id: card, record: null });
    expect(all.copies).toBe(2);
  });

  it('refreshes every template when the source changes, as one undo step', async () => {
    const out = await call(agent, 'data_source_set', { name: 'Products', data: 'name,image,inStock,tier\nSofa,https://example.com/s.png,yes,gold\nBed,https://example.com/b.png,yes,gold\nRug,https://example.com/r.png,,silver\n' });
    expect(out.reran).toEqual([{ template: card, copies: 3, missing: [] }]);
    expect(doc.getChildren(grid).length).toBe(4);
    expect(parts(doc.getChildren(grid)[3]!.id)[2]!.hidden).toBe(true);
    const refreshed = await call(agent, 'data_source_refresh', { source: 'products' });
    expect(refreshed.reran[0].copies).toBe(3);
    await call(agent, 'agent_undo', {});
    expect(doc.getChildren(grid).length).toBe(4);
  });

  it('never lets an agent reach this computer\'s network', async () => {
    for (const url of [localUrl, 'http://localhost:1/x.json', 'http://192.168.1.1/x.json']) {
      const set = await callRaw(agent, 'data_source_set', { name: 'Local', url });
      expect(set.isError).toBe(true);
      expect(set.content[0]!.text).toMatch(/private/);
      expect(set.content[0]!.text).toContain('An agent only reaches public addresses');
      const repeat = await callRaw(agent, 'layer_repeat', { node_id: card, url });
      expect(repeat.isError).toBe(true);
    }
    // A source a person allowed on this computer is theirs to refresh.
    doc.transact(() => setDataSource(doc, { name: 'Dev server', kind: 'url', url: localUrl, records: [{ name: 'x' }], allowLocal: true }));
    const refresh = await callRaw(agent, 'data_source_refresh', { source: 'Dev server' });
    expect(refresh.isError).toBe(true);
    expect(refresh.content[0]!.text).toContain('only a person at this computer refreshes');
  });

  it('reaches this computer\'s network over HTTP only when asked, and only from this computer', async () => {
    const post = (body: object, headers: Record<string, string> = {}) => fetch(`${h.base}/api/data/fetch`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const refused = await post({ url: localUrl });
    expect(refused.status).toBe(400);
    expect((await refused.json() as { error: string }).error).toMatch(/private/);
    const allowed = await post({ url: localUrl, allowLocal: true });
    expect(allowed.status).toBe(200);
    expect((await allowed.json() as { records: unknown[] }).records).toEqual([{ name: 'Local lamp', tier: 'gold' }]);
    // Through a proxy, the request is not this computer's own.
    const proxied = await post({ url: localUrl, allowLocal: true }, { 'X-Forwarded-For': '203.0.113.9' });
    expect(proxied.status).toBe(403);
  });

  it('refuses a field name that is not one, and an inner layer of an instance', async () => {
    const title = doc.getChildren(card)[0]!.id;
    expect((await callRaw(agent, 'layer_bind', { node_id: title, text: 'a; b' })).content[0]!.text).toContain('not a field name');
    const badge = doc.getChildren(card)[3]!;
    const inner = doc.getChildren(badge.id)[0];
    if (inner) expect((await callRaw(agent, 'layer_bind', { node_id: inner.id, visible: 'x' })).content[0]!.text).toMatch(/inside an instance/);
  });
});
