import { afterEach, describe, expect, it } from 'vitest';
import { call, connectAgent, startServer, until, type Harness } from './helpers.ts';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const HOUR = 3_600_000;

/** A copy of one Omarchy theme, as legacy installs made several, last changed an hour ago. */
async function themeCopy(harness: Harness, accent: string) {
  const entry = harness.server.createFile('Tokyo Night Custom · Omarchy theme');
  const room = await harness.server.rooms.get(entry.id);
  const page = room.doc.getPages()[0]!.id;
  room.doc.transact(() => {
    room.doc.setToken('omarchy-accent', 'color', accent);
    room.doc.meta.set('omarchyTheme', { name: 'Tokyo Night Custom', format: 2, target: 'desktop', from: 'tokyo-night' });
    room.doc.insert(page, { type: 'frame', tag: 'main', name: `Background ${accent}`, artboard: true, style: { width: '100px', height: '100px' } });
  });
  await harness.server.storage.flushDoc(entry.id);
  harness.server.storage.update(entry.id, { updatedAt: Date.now() - HOUR });
  return entry.id;
}

const post = (path: string, body: unknown) => fetch(`${h!.base}/api/omarchy/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() as any }));

describe('the files an agent is offered when nobody has the editor open', () => {
  it('lists one canonical theme project, not its kept source copies, like file_list; the current file stays as it is', async () => {
    h = await startServer();
    const main = await themeCopy(h, '#7aa2f7');
    const a = await themeCopy(h, '#ff9e64');
    const b = await themeCopy(h, '#9ece6a');
    const plan = await post('consolidate/plan', { target: main, sources: [a, b] });
    expect(plan.status).toBe(200);
    const done = await post('consolidate', { target: main, sources: [a, b], plan_hash: plan.body.plan_hash });
    expect(done.status).toBe(200);
    // A file of its own, and a draft that came from a theme project that is no longer here: both stay files.
    const ordinary = h.server.createFile('Pricing page').id;
    const draft = await themeCopy(h, '#bb9af7');
    (await h.server.rooms.get(draft)).doc.meta.set('consolidatedInto', { fileId: 'gone-project', branchId: 'b1', at: Date.now() });
    await h.server.storage.flushDoc(draft);
    await until(() => [a, b].every((id) => h!.server.storage.get(id)?.theme?.consolidatedInto?.fileId === main), 4000);

    const agent = await connectAgent(h.base, 'context-check');
    const listed = await call<{ id: string; kept_copies?: { id: string }[] }[]>(agent, 'file_list');
    const context = await call<{ editorOpen: boolean; currentFile: { id: string } | null; files: { id: string }[] }>(agent, 'context_get');
    expect(context.editorOpen).toBe(false);
    const ids = context.files.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining([main, ordinary, draft]));
    expect(ids).not.toContain(a);
    expect(ids).not.toContain(b);
    // The same files as file_list, in its order.
    expect(ids).toEqual(listed.map((f) => f.id).slice(0, 10));
    expect(listed.find((f) => f.id === main)?.kept_copies?.map((c) => c.id).sort()).toEqual([a, b].sort());
    // The copies are still real files, there when asked for.
    const all = await call<{ id: string }[]>(agent, 'file_list', { include_copies: true });
    expect(all.map((f) => f.id)).toEqual(expect.arrayContaining([a, b]));

    // An agent at work on a kept copy still sees that file as its current one.
    await call(agent, 'file_open', { file_id: a });
    const working = await call<{ currentFile: { id: string } | null; files: { id: string }[] }>(agent, 'context_get');
    expect(working.currentFile?.id).toBe(a);
    expect(working.files.map((f) => f.id)).not.toContain(a);
    await agent.close();
  });
});
