import { afterEach, describe, expect, it } from 'vitest';
import { nodeToHtml } from '@bogen/core';
import { call, callRaw, connectAgent, startServer, until, type Harness } from './helpers.ts';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function start(options: Parameters<typeof startServer>[0] = {}): Promise<Harness> {
  const h = await startServer(options);
  harnesses.push(h);
  return h;
}

async function rest<T = any>(base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json' }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

type Agent = Awaited<ReturnType<typeof connectAgent>>;

/** A file with a Button component, published as the library "Kit". */
async function kit(agent: Agent) {
  const { id } = await call(agent, 'file_create', { name: 'Kit source' });
  const { ids } = await call(agent, 'html_write', { file_id: id, html: '<button data-name="Button" style="display:inline-flex;padding:8px 16px;background:#123456;color:#ffffff"><span data-name="Label">Buy</span></button>' });
  const made = await call(agent, 'component_create', { file_id: id, node_ids: [ids[0]], name: 'Button', props: [{ name: 'label', type: 'text', target: 'Label' }] });
  const published = await call(agent, 'library_publish', { file_id: id, name: 'Kit' });
  expect(published.changed.map((c: { name: string }) => c.name)).toEqual(['Button']);
  return { id: id as string, main: made.id as string };
}

describe('shared libraries over MCP', () => {
  it('links a library, places a linked instance, and takes a published change with overrides kept', async () => {
    const h = await start();
    const agent = await connectAgent(h.base, 'claude');
    const lib = await kit(agent);
    const { id: fileId } = await call(agent, 'file_create', { name: 'App' });
    const listed = await call(agent, 'library_list', { file_id: fileId });
    expect(listed.available.map((l: { name: string }) => l.name)).toEqual(['Kit']);

    const inst = await call(agent, 'instance_create', { file_id: fileId, component: 'Button', library: 'Kit', props: { label: 'Order' }, x: 0, y: 0 });
    const room = await h.server.rooms.get(fileId);
    expect(nodeToHtml(room.doc, inst.id)).toContain('Order');
    const got = await call(agent, 'component_get', { file_id: fileId, component: inst.component });
    expect(got.library.id).toBe(lib.id);
    const edit = await callRaw(agent, 'layer_style', { file_id: fileId, node_ids: [inst.component], style: { color: 'red' } });
    expect(edit.isError).toBe(true);
    expect(edit.content[0]!.text).toMatch(/shared library/);
    const label = room.doc.getChildren(inst.id)[0]!.id;
    await call(agent, 'layer_style', { file_id: fileId, node_ids: [label], style: { color: '#00ff00' } });

    // An edit to the library's main is offered only once published.
    await call(agent, 'layer_style', { file_id: lib.id, node_ids: [lib.main], style: { 'border-radius': '999px' } });
    const hint = await call(agent, 'component_update', { file_id: lib.id, component: 'Button', description: 'Primary' });
    expect(hint.library).toMatch(/library_publish/);
    expect((await call(agent, 'library_updates', { file_id: fileId })).libraries[0].updates).toEqual([]);
    await call(agent, 'library_publish', { file_id: lib.id });
    const updates = await call(agent, 'library_updates', { file_id: fileId });
    expect(updates.libraries[0].updates).toMatchObject([{ name: 'Button', status: 'changed', from: 1, to: 2, instances: 1 }]);
    const http = await rest(h.base, `/api/files/${fileId}/libraries`);
    expect(http.linked[0]).toMatchObject({ name: 'Kit', missing: false });
    expect(http.linked[0].updates).toHaveLength(1);
    expect((await rest(h.base, `/api/libraries/${lib.id}`)).published[0].version).toBe(2);

    const accepted = await call(agent, 'library_accept', { file_id: fileId });
    expect(accepted.results[0].accepted[0]).toMatchObject({ name: 'Button', from: 1, to: 2 });
    expect(accepted.results[0].overrides).toEqual({ kept: 1, orphaned: 0 });
    const html = nodeToHtml(room.doc, inst.id);
    expect(html).toContain('999px');
    expect(html).toContain('Order');
    expect(html).toContain('#00ff00');
    // One undo step takes the update back.
    await call(agent, 'agent_undo', { file_id: fileId });
    expect(nodeToHtml(room.doc, inst.id)).not.toContain('999px');
    expect(nodeToHtml(room.doc, inst.id)).toContain('Order');

    // A brand publishes its components too, and a file that uses the brand sees it marked.
    const { id: brand } = await call(agent, 'brand_create', { name: 'House' });
    const page = (await h.server.rooms.get(brand)).doc.getPages()[0]!.id;
    const card = await call(agent, 'html_write', { file_id: brand, target_id: page, html: '<div data-name="Card" style="padding:24px;background:#fff">Card</div>' });
    await call(agent, 'component_create', { file_id: brand, node_ids: card.ids, name: 'Card' });
    await call(agent, 'library_publish', { file_id: brand });
    await call(agent, 'brand_link', { brand_id: brand, file_id: fileId });
    const after = await call(agent, 'library_list', { file_id: fileId });
    expect(after.available).toMatchObject([{ name: 'House', kind: 'brand', brand: true }]);
    const missing = await callRaw(agent, 'instance_create', { file_id: fileId, component: 'Nope', library: 'House' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain('Card');
    await agent.close();
  }, 60_000);
});

describe('libraries across devices', () => {
  async function pair(a: Harness, b: Harness): Promise<void> {
    const { token, url } = await rest(a.base, '/api/peers/pair', { method: 'POST', body: { insecure: true } });
    await rest(b.base, '/api/peers', { method: 'POST', body: { url, token, insecure: true } });
  }

  it('a library made on one device is linked and updated on the other, and instances survive its loss', async () => {
    const a = await start({ insecureAllowAnyHost: true, peerCatchUpMs: 200 });
    const b = await start({ insecureAllowAnyHost: true, peerCatchUpMs: 200 });
    await pair(a, b);
    const agentA = await connectAgent(a.base, 'claude');
    const agentB = await connectAgent(b.base, 'claude');
    const lib = await kit(agentA);
    await until(async () => (await rest<any[]>(b.base, '/api/libraries')).some((l) => l.id === lib.id), 10_000);

    // Linked and placed on B, the file shows on A too, from its own copy.
    const { id: fileId } = await call(agentB, 'file_create', { name: 'On B' });
    const inst = await call(agentB, 'instance_create', { file_id: fileId, component: 'Button', library: lib.id, x: 0, y: 0 });
    await until(async () => Boolean(a.server.storage.get(fileId)) && nodeToHtml((await a.server.rooms.get(fileId)).doc, inst.id).includes('Buy'), 10_000);

    // A publishes a change; B sees it once the library has synced, and the acceptance travels back.
    await call(agentA, 'layer_style', { file_id: lib.id, node_ids: [lib.main], style: { 'border-radius': '999px' } });
    await call(agentA, 'library_publish', { file_id: lib.id });
    await until(async () => (await call(agentB, 'library_updates', { file_id: fileId })).libraries[0].updates.length === 1, 10_000);
    await call(agentB, 'library_accept', { file_id: fileId });
    await until(async () => nodeToHtml((await a.server.rooms.get(fileId)).doc, inst.id).includes('999px'), 10_000);

    // The library goes away: instances keep their look, and the link says it is missing.
    await rest(a.base, `/api/files/${lib.id}`, { method: 'DELETE' });
    await until(async () => !b.server.storage.get(lib.id), 10_000);
    const status = await rest(b.base, `/api/files/${fileId}/libraries`);
    expect(status.linked[0]).toMatchObject({ id: lib.id, missing: true });
    expect(nodeToHtml((await b.server.rooms.get(fileId)).doc, inst.id)).toContain('999px');
    await agentA.close();
    await agentB.close();
  }, 90_000);
});
