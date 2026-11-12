import { acceptProposal, BogenDoc, createProposals, listRevisions, ProposalConflictError, proposalConflicts } from '@bogen/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/** An artboard with a heading, a paragraph and a button, as a person would have it. */
function page(doc: BogenDoc) {
  doc.ensureFirstPage();
  const pageId = doc.getPages()[0]!.id;
  const board = doc.insert(pageId, { type: 'frame', name: 'Landing', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '1200px', height: '800px' } });
  const [heading, para, button] = doc.insertMany(board, [
    { type: 'text', name: 'Heading', tag: 'h1', text: 'Hello', style: { fontSize: '48px' } },
    { type: 'text', name: 'Intro', tag: 'p', text: 'We make chairs.', style: { fontSize: '18px' } },
    { type: 'frame', name: 'Button', tag: 'a', style: { background: '#111111', padding: '12px 20px' }, attrs: { href: '#buy' } },
  ]) as [string, string, string];
  doc.invalidate();
  return { pageId, board, heading, para, button };
}

describe('accepting keeps the original\'s ids and the person\'s edits', () => {
  it('keeps a comment and a manual text edit on the original that the proposal left alone (the reproduced loss)', () => {
    const doc = new BogenDoc();
    const p = page(doc);
    const thread = doc.addThread({ pageId: p.pageId, nodeId: p.heading, x: 0, y: 0, author: 'Lena', text: 'Shorter?' });
    const [copy] = createProposals(doc, p.board, { by: 'claude' });
    doc.invalidate();
    const map = Object.fromEntries(Object.entries(listMap(doc, copy!)).map(([c, o]) => [o, c]));
    // Meanwhile the person types in the original; the agent restyles the button in the copy.
    doc.editText(p.heading, 'Hello', 'Hello there');
    doc.updateStyle(map[p.button]!, { background: '#b4410c' });
    doc.invalidate();
    expect(proposalConflicts(doc, copy!)).toEqual([]);
    const out = acceptProposal(doc, copy!);
    doc.invalidate();
    // The same layers, by id: the comment is still on the heading, and the heading still says what the person typed.
    expect(doc.getNode(p.heading)?.text).toBe('Hello there');
    expect(out.kept).toContain(p.heading);
    expect(doc.getComments().find((t) => t.id === thread)?.nodeId).toBe(p.heading);
    expect(doc.getNode(p.button)?.style.background).toBe('#b4410c');
    expect(doc.getChildren(p.board).map((n) => n.id)).toEqual([p.heading, p.para, p.button]);
    expect(doc.getNode(copy!)).toBeUndefined();
  });

  it('stops on a layer changed on both sides and applies the chosen side, keeping its id', () => {
    const doc = new BogenDoc();
    const p = page(doc);
    const [copy] = createProposals(doc, p.board, { by: 'claude' });
    doc.invalidate();
    const map = Object.fromEntries(Object.entries(listMap(doc, copy!)).map(([c, o]) => [o, c]));
    doc.editText(p.para, 'We make chairs.', 'We make oak chairs.');
    doc.editText(map[p.para]!, 'We make chairs.', 'Chairs, made in Graz.');
    doc.invalidate();
    let caught: unknown;
    try {
      acceptProposal(doc, copy!);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProposalConflictError);
    expect((caught as ProposalConflictError).conflicts).toEqual([{ kind: 'changed-both', original: p.para, copy: map[p.para], name: 'Intro' }]);
    // Nothing was applied by the refused attempt.
    expect(doc.getNode(copy!)).toBeTruthy();
    expect(doc.getNode(p.para)?.text).toBe('We make oak chairs.');
    acceptProposal(doc, copy!, undefined, { [p.para]: 'proposal' });
    doc.invalidate();
    expect(doc.getNode(p.para)?.text).toBe('Chairs, made in Graz.');
  });

  it('moves layers new in the proposal over with their ids and removes the ones it deleted', () => {
    const doc = new BogenDoc();
    const p = page(doc);
    const [copy] = createProposals(doc, p.board, { by: 'claude' });
    doc.invalidate();
    const map = Object.fromEntries(Object.entries(listMap(doc, copy!)).map(([c, o]) => [o, c]));
    const added = doc.insert(copy!, { type: 'text', name: 'Proof', text: 'Since 1987' });
    doc.delete([map[p.button]!]);
    doc.invalidate();
    acceptProposal(doc, copy!);
    doc.invalidate();
    expect(doc.getChildren(p.board).map((n) => n.id)).toEqual([p.heading, p.para, added]);
    expect(doc.getNode(p.button)).toBeUndefined();
  });

  it('maps every layer of a large artboard, past the old 200', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const pageId = doc.getPages()[0]!.id;
    const board = doc.insert(pageId, { type: 'frame', name: 'Big', artboard: true, style: { width: '1000px', height: '1000px' } });
    doc.insertMany(board, Array.from({ length: 220 }, (_, i) => ({ type: 'text' as const, name: `Row ${i}`, text: `Row ${i}` })));
    doc.invalidate();
    const [copy] = createProposals(doc, board, { by: 'claude' });
    doc.invalidate();
    expect(Object.keys(listMap(doc, copy!))).toHaveLength(220);
  });
});

function listMap(doc: BogenDoc, copy: string): Record<string, string> {
  return (doc.nodes.get(copy)!.get('proposal') as { map: Record<string, string> }).map;
}

describe('revisions over MCP', () => {
  let h: Harness | undefined;
  afterEach(async () => { vi.restoreAllMocks(); await h?.cleanup(); h = undefined; });

  async function fileWithPage() {
    const file = h!.server.storage.create('Shop');
    const room = await h!.server.rooms.get(file.id);
    const p = page(room.doc);
    const second = room.doc.insert(p.pageId, { type: 'frame', name: 'Pricing', artboard: true, style: { position: 'absolute', left: '1400px', top: '0px', width: '1200px', height: '800px' } });
    room.doc.invalidate();
    return { file, room, ...p, second };
  }

  it('"make it again" revises the whole page in place: no new page, originals refused, a commit first', async () => {
    h = await startServer();
    const f = await fileWithPage();
    vi.spyOn(h.server.runs, 'conversationOf').mockReturnValue('chat-1');
    // Two runs going on this file, as the server's runs would be: a session that names a run needs one.
    vi.spyOn(h.server.runs, 'bindingOf').mockImplementation((id) => (id === 'run1' || id === 'run2' ? { fileId: f.file.id } : undefined));
    const agent = await connectAgent(h.base, 'claude', { 'x-bogen-run': 'run1', 'x-bogen-file': f.file.id });
    const pagesBefore = f.room.doc.getPages().length;
    const rev = await call(agent, 'revision_start', { intent: 'revise', name: 'Calmer landing', file_id: f.file.id });
    expect(rev.artboards.map((a: any) => a.original)).toEqual([f.board, f.second]);
    expect(rev.checkpoint).toBeTruthy();
    expect(f.room.doc.getPages()).toHaveLength(pagesBefore);
    const copyHeading = rev.artboards[0].layers[f.heading];
    // Writing to the original is refused and leaves it as it was, with the copy's id in the message.
    const refused = await callRaw(agent, 'layer_text', { node_id: f.heading, text: 'Hi', file_id: f.file.id });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain(copyHeading);
    expect(f.room.doc.getNode(f.heading)?.text).toBe('Hello');
    const page2 = await callRaw(agent, 'page_create', { name: 'Landing v2', file_id: f.file.id });
    expect(page2.isError).toBe(true);
    expect(f.room.doc.getPages()).toHaveLength(pagesBefore);
    await call(agent, 'layer_text', { node_id: copyHeading, text: 'Good chairs', file_id: f.file.id });
    await agent.close();

    // The next message in the same conversation, a new run: it continues on the open draft without being told.
    const next = await connectAgent(h.base, 'claude', { 'x-bogen-run': 'run2', 'x-bogen-file': f.file.id });
    const listed = await call(next, 'revision_list', { file_id: f.file.id });
    expect(listed.current).toBe(rev.id);
    expect((await callRaw(next, 'layer_style', { node_ids: [f.para], style: { color: 'red' }, file_id: f.file.id })).isError).toBe(true);
    await call(next, 'layer_style', { node_ids: [rev.artboards[0].layers[f.para]], style: { color: '#333333' }, file_id: f.file.id });

    const accepted = await call(next, 'revision_accept', { revision_id: rev.id, file_id: f.file.id });
    expect(accepted.accepted).toBe(rev.id);
    f.room.doc.invalidate();
    expect(f.room.doc.getNode(f.heading)?.text).toBe('Good chairs');
    expect(f.room.doc.getNode(f.para)?.style.color).toBe('#333333');
    expect(listRevisions(f.room.doc).map((r) => r.status)).toEqual(['accepted']);
    // Decided: the conversation is free again, and the originals are writable.
    await call(next, 'layer_text', { node_id: f.heading, text: 'Good chairs, since 1987', file_id: f.file.id });
    await next.close();
  }, 30_000);

  it('makes a new page only when asked for one, and discarding keeps the record and its commit', async () => {
    h = await startServer();
    const f = await fileWithPage();
    const agent = await connectAgent(h.base, 'claude');
    const before = f.room.doc.getPages().length;
    const made = await call(agent, 'revision_start', { intent: 'new_page', name: 'Checkout', file_id: f.file.id });
    expect(f.room.doc.getPages()).toHaveLength(before + 1);
    expect(made.intent).toBe('new_page');
    const alt = await call(agent, 'revision_start', { intent: 'alternative', name: 'Bolder', node_ids: [f.board], file_id: f.file.id });
    const copy = alt.artboards[0].copy;
    expect(f.room.doc.getNode(copy)).toBeTruthy();
    const gone = await call(agent, 'revision_discard', { revision_id: alt.id, file_id: f.file.id });
    expect(gone.checkpoint).toBeTruthy();
    expect(f.room.doc.getNode(copy)).toBeUndefined();
    expect(listRevisions(f.room.doc).find((r) => r.id === alt.id)?.status).toBe('discarded');
    await agent.close();
  }, 30_000);

  it('returns every layer of a 220-layer artboard from proposal_create', async () => {
    h = await startServer();
    const file = h.server.storage.create('Big');
    const room = await h.server.rooms.get(file.id);
    const pageId = room.doc.getPages()[0]!.id;
    const board = room.doc.insert(pageId, { type: 'frame', name: 'Big', artboard: true, style: { width: '1000px', height: '1000px' } });
    room.doc.insertMany(board, Array.from({ length: 220 }, (_, i) => ({ type: 'text' as const, name: `Row ${i}`, text: `Row ${i}` })));
    const agent = await connectAgent(h.base, 'claude');
    const out = await call(agent, 'proposal_create', { node_id: board, file_id: file.id });
    expect(Object.keys(out.proposals[0].layers)).toHaveLength(220);
    await agent.close();
  }, 30_000);
});
