import { branchContent, currentBranchId, designHash, docToContent, getDesignBranch, listDesignBranches, MAIN_BRANCH } from '@bogen/core';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type Harness } from './helpers.ts';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const HOUR = 3_600_000;

/** A legacy copy of Tokyo Night Custom, made before themes had one project, last changed an hour ago. */
async function copy(harness: Harness, accent: string, options: { comment?: string; target?: 'desktop' | 'mobile' } = {}) {
  const entry = harness.server.createFile('Tokyo Night Custom · Omarchy theme');
  const room = await harness.server.rooms.get(entry.id);
  const page = room.doc.getPages()[0]!.id;
  let layer = '';
  room.doc.transact(() => {
    room.doc.setToken('omarchy-accent', 'color', accent);
    room.doc.meta.set('omarchyTheme', { name: 'Tokyo Night Custom', format: 2, target: options.target ?? 'desktop', from: 'tokyo-night' });
    layer = room.doc.insert(page, { type: 'frame', tag: 'main', name: `Background ${accent}`, artboard: true, style: { width: '100px', height: '100px' } });
  });
  if (options.comment) room.doc.addThread({ pageId: page, nodeId: layer, x: 0, y: 0, author: 'Mara', text: options.comment });
  await harness.server.storage.flushDoc(entry.id);
  harness.server.storage.update(entry.id, { updatedAt: Date.now() - HOUR });
  return { id: entry.id, room, layer };
}

const post = (path: string, body: unknown) => fetch(`${h!.base}/api/omarchy/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() as any }));

describe('bringing legacy copies of one theme together', () => {
  it('plans first, then makes every copy a branch with its design and comments, and leaves the copies as they were', async () => {
    h = await startServer();
    const main = await copy(h, '#7aa2f7');
    const a = await copy(h, '#ff9e64', { comment: 'Warmer, keep this one?' });
    const b = await copy(h, '#9ece6a');
    const c = await copy(h, '#7aa2f7');
    const files = h.server.storage.list().length;
    const designOf = (doc: typeof a.room.doc) => {
      const content = docToContent(doc);
      const { consolidatedInto: _mark, ...meta } = content.extra?.meta ?? {};
      return designHash({ ...content, extra: { ...content.extra, meta } });
    };
    const before = [a, b, c].map((x) => designOf(x.room.doc));

    const plan = await post('consolidate/plan', { target: main.id, sources: [a.id, b.id, c.id] });
    expect(plan.status).toBe(200);
    expect(plan.body.ok).toBe(true);
    expect(plan.body.sources.map((s: any) => s.action)).toEqual(['import', 'import', 'import']);
    expect(plan.body.sources[0].comments).toBe(1);
    // A plan changes nothing.
    expect(listDesignBranches(main.room.doc)).toHaveLength(1);

    const done = await post('consolidate', { target: main.id, sources: [a.id, b.id, c.id], plan_hash: plan.body.plan_hash });
    expect(done.status).toBe(200);
    expect(done.body.sources_kept).toBe(true);
    expect(done.body.imported).toHaveLength(3);
    // Main is still what it was and still checked out; each copy is a branch with its own palette and layers.
    expect(currentBranchId(main.room.doc)).toBe(MAIN_BRANCH);
    const branchA = getDesignBranch(main.room.doc, done.body.imported[0].branch_id);
    expect(branchA.imported?.fileId).toBe(a.id);
    expect(branchA.archivedAs).toBeTruthy();
    const contentA = branchContent(main.room.doc, branchA.id);
    expect(contentA.tokens.find((t) => t.name === 'omarchy-accent')?.value).toBe('#ff9e64');
    expect(contentA.nodes.some((n) => n.id === a.layer)).toBe(true);
    // Its comment came along, anchored to the same layer, marked with the branch, not resolved.
    const thread = main.room.doc.getComments().find((t) => t.nodeId === a.layer);
    expect(thread?.resolved).toBeFalsy();
    expect(main.room.doc.comments.get([...main.room.doc.comments.keys()].find((k) => k.startsWith(a.id))!)!.get('branch')).toBe(branchA.id);
    // No file was made, renamed or removed; the copies keep their design and only say where they went.
    expect(h.server.storage.list().length).toBe(files);
    expect([a, b, c].map((x) => designOf(x.room.doc))).toEqual(before);
    expect(a.room.doc.meta.get('consolidatedInto')).toMatchObject({ fileId: main.id, branchId: branchA.id });
    expect(h.server.storage.get(a.id)?.name).toBe('Tokyo Night Custom · Omarchy theme');
    // Its content is in the theme's History for good.
    expect(await h.server.commits.read(main.id, done.body.imported[0].history)).toBeTruthy();

    // Asking again imports nothing twice.
    for (const x of [main, a, b, c]) h.server.storage.update(x.id, { updatedAt: Date.now() - HOUR });
    const again = await post('consolidate/plan', { target: main.id, sources: [a.id, b.id, c.id] });
    expect(again.body.sources.map((s: any) => s.action)).toEqual(['skip', 'skip', 'skip']);
  });

  it('leaves a copy that is being worked on alone, and does nothing while the plan has a problem', async () => {
    h = await startServer();
    const main = await copy(h, '#7aa2f7');
    const a = await copy(h, '#ff9e64');
    const busy = await copy(h, '#9ece6a');
    busy.room.doc.setToken('omarchy-accent', 'color', '#000000');
    const mobile = await copy(h, '#bb9af7', { target: 'mobile' });
    const plan = await post('consolidate/plan', { target: main.id, sources: [a.id, busy.id, mobile.id] });
    expect(plan.body.ok).toBe(false);
    expect(plan.body.problems.join(' ')).toMatch(/being worked on/);
    expect(plan.body.problems.join(' ')).toMatch(/mobile theme/);
    const done = await post('consolidate', { target: main.id, sources: [a.id, busy.id, mobile.id], plan_hash: plan.body.plan_hash });
    expect(done.status).toBe(409);
    expect(listDesignBranches(main.room.doc)).toHaveLength(1);
  });

  it('refuses a plan that is out of date', async () => {
    h = await startServer();
    const main = await copy(h, '#7aa2f7');
    const a = await copy(h, '#ff9e64');
    const plan = await post('consolidate/plan', { target: main.id, sources: [a.id] });
    a.room.doc.setToken('omarchy-accent', 'color', '#111111');
    h.server.storage.update(a.id, { updatedAt: Date.now() - HOUR });
    const done = await post('consolidate', { target: main.id, sources: [a.id], plan_hash: plan.body.plan_hash });
    expect(done.status).toBe(409);
    expect(listDesignBranches(main.room.doc)).toHaveLength(1);
  });
});

describe('bringing comments in again', () => {
  it('never writes over a thread that gained replies or a resolution in the theme, and keeps the source\'s new reply too', async () => {
    h = await startServer();
    const main = await copy(h, '#7aa2f7');
    const a = await copy(h, '#ff9e64', { comment: 'Warmer?' });
    const plan = await post('consolidate/plan', { target: main.id, sources: [a.id] });
    const done = await post('consolidate', { target: main.id, sources: [a.id], plan_hash: plan.body.plan_hash });
    expect(done.status).toBe(200);
    const doc = main.room.doc;
    const key = [...doc.comments.keys()].find((k) => k.startsWith(a.id))!;
    // In the theme, the person answers and resolves the brought-in thread.
    doc.replyThread(key, 'Mara', 'Yes, this one.', undefined, [{ src: `bogen-asset:${'b'.repeat(64)}.png`, kind: 'image' }]);
    doc.setThreadResolved(key, true);
    // On the source, someone else answers the original thread.
    const sourceThread = a.room.doc.getComments()[0]!.id;
    a.room.doc.replyThread(sourceThread, 'Lena', 'Or cooler?');
    for (const x of [main, a]) h.server.storage.update(x.id, { updatedAt: Date.now() - HOUR });
    const again = await post('consolidate/plan', { target: main.id, sources: [a.id] });
    expect(again.body.sources[0].action).toBe('comments');
    const redo = await post('consolidate', { target: main.id, sources: [a.id], plan_hash: again.body.plan_hash });
    expect(redo.status).toBe(200);
    // The theme's own thread is as the person left it: their reply, its attachment, resolved.
    const mine = doc.getComments().find((t) => t.id === key)!;
    expect(mine.resolved).toBe(true);
    expect(mine.messages.map((m) => m.text)).toEqual(['Warmer?', 'Yes, this one.']);
    expect(mine.messages[1]!.attachments?.length).toBe(1);
    // The source's newer version came as a thread of its own, unresolved, with the new reply.
    const theirs = doc.getComments().filter((t) => t.id !== key && t.messages.some((m) => m.text === 'Or cooler?'));
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.resolved).toBe(false);
    expect(doc.comments.get(theirs[0]!.id)!.get('importedAs')).toBe(key);
    // No new branch was made for the same design.
    expect(listDesignBranches(doc).filter((b) => b.imported?.fileId === a.id)).toHaveLength(1);
  });
});
