import { describe, expect, it } from 'vitest';
import { applyContent, applyPlan, BogenDoc, diffEncoded, diffText, docToContent, encodeKey, exportDocument, MARK_KEY, mapOffset, nodeToHtml, planRevert, repairMirror, RICH_KEY, toJsx, Y, type ChangeOp, type TextSpan } from '../src/index.ts';

function fresh(): { doc: BogenDoc; page: string } {
  const doc = new BogenDoc(new Y.Doc());
  doc.ensureFirstPage();
  return { doc, page: doc.getPages()[0]!.id };
}

function peerOf(doc: BogenDoc): BogenDoc {
  const peer = new BogenDoc(new Y.Doc());
  Y.applyUpdate(peer.y, Y.encodeStateAsUpdate(doc.y));
  return peer;
}

function sync(a: BogenDoc, b: BogenDoc): void {
  Y.applyUpdate(b.y, Y.encodeStateAsUpdate(a.y, Y.encodeStateVector(b.y)));
  Y.applyUpdate(a.y, Y.encodeStateAsUpdate(b.y, Y.encodeStateVector(a.y)));
}

const raw = (doc: BogenDoc, id: string) => doc.nodes.get(id)!;

/** What a build from before this reads and writes: plain `text` and `spans` on the layer's map. */
const old = {
  read: (doc: BogenDoc, id: string) => ({ text: raw(doc, id).get('text'), spans: raw(doc, id).get('spans') as TextSpan[] | undefined }),
  write: (doc: BogenDoc, id: string, patch: { text?: string; spans?: TextSpan[] | undefined }) => doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) raw(doc, id).delete(k);
      else raw(doc, id).set(k, v);
    }
  }),
  insert: (doc: BogenDoc, page: string, text: string, spans?: TextSpan[]) => {
    const id = 'old' + Math.random().toString(36).slice(2, 8);
    doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('type', 'text');
      m.set('name', 'Old');
      m.set('parent', page);
      m.set('order', 'a0');
      m.set('tag', 'p');
      m.set('style', new Y.Map<string>());
      m.set('text', text);
      if (spans?.length) m.set('spans', spans);
      doc.nodes.set(id, m);
    });
    return id;
  },
};

const bold = (start: number, end: number): TextSpan => ({ start, end, style: { fontWeight: '700' } });

describe('text that merges', () => {
  it('finds the one stretch that changed, without splitting a pair', () => {
    expect(diffText('Hello world', 'Hello brave world')).toEqual({ at: 6, remove: 0, insert: 'brave ' });
    expect(diffText('abc', 'abc')).toBeNull();
    expect(diffText('a😀b', 'a😃b')).toEqual({ at: 1, remove: 2, insert: '😃' });
    expect(mapOffset({ at: 2, remove: 1, insert: 'xyz' }, 5)).toBe(7);
    expect(mapOffset({ at: 2, remove: 1, insert: 'xyz' }, 1)).toBe(1);
  });

  it('keeps both edits when two docs change one layer at once', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'text', text: 'Hello world' });
    const peer = peerOf(doc);
    doc.updateFields(id, { text: 'Hello brave world' });
    peer.updateFields(id, { text: 'Hello world!' });
    sync(doc, peer);
    expect(doc.getNode(id)!.text).toBe('Hello brave world!');
    expect(peer.getNode(id)!.text).toBe('Hello brave world!');
  });

  it('applies an edit made against an older base on top of what arrived since', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'text', text: 'one two' });
    const peer = peerOf(doc);
    peer.updateFields(id, { text: 'zero one two' });
    sync(doc, peer);
    // The editor still shows "one two" and the person typed " three" at the end.
    const after = doc.editText(id, 'one two', 'one two three');
    expect(after).toBe('zero one two three');
    sync(doc, peer);
    expect(peer.getNode(id)!.text).toBe('zero one two three');
  });

  it('moves ranges with inserts and deletes, also from another doc', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'text', text: 'Hello world', spans: [bold(6, 11)] });
    const peer = peerOf(doc);
    peer.updateFields(id, { text: 'Oh, Hello world' });
    sync(doc, peer);
    expect(doc.getNode(id)!.spans).toEqual([bold(10, 15)]);
    doc.updateFields(id, { text: 'Oh, world' });
    sync(doc, peer);
    expect(peer.getNode(id)!.spans).toEqual([bold(4, 9)]);
    // Typing at the end of a range extends it, as in any editor.
    doc.editText(id, 'Oh, world', 'Oh, worlds');
    expect(doc.getNode(id)!.spans).toEqual([bold(4, 10)]);
  });

  it('merges formatting of different properties on overlapping ranges', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'text', text: 'abcdefgh' });
    const peer = peerOf(doc);
    doc.formatText(id, 0, 5, { fontWeight: '700' });
    peer.formatText(id, 3, 8, { color: 'red' });
    sync(doc, peer);
    const want = [bold(0, 3), { start: 3, end: 5, style: { fontWeight: '700', color: 'red' } }, { start: 5, end: 8, style: { color: 'red' } }];
    expect(doc.getNode(id)!.spans).toEqual(want);
    expect(peer.getNode(id)!.spans).toEqual(want);
    doc.formatText(id, 0, 8, { fontWeight: null }, 'https://a.b/');
    expect(doc.getNode(id)!.spans).toEqual([{ start: 0, end: 3, href: 'https://a.b/' }, { start: 3, end: 8, style: { color: 'red' }, href: 'https://a.b/' }]);
  });

  it('sets spans exactly through updateFields, and clears them', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'text', text: 'Hi there', spans: [{ start: 3, end: 8, style: { color: 'red' }, href: 'https://a.b/' }] });
    doc.updateFields(id, { spans: [bold(0, 2)] });
    expect(doc.getNode(id)!.spans).toEqual([bold(0, 2)]);
    doc.updateFields(id, { spans: undefined });
    expect(doc.getNode(id)!.spans).toBeUndefined();
  });

  it('undoes only its own typing', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'text', text: 'Hello' });
    const peer = peerOf(doc);
    const undo = new Y.UndoManager([doc.nodes], { trackedOrigins: new Set(['me']), captureTimeout: 0 });
    doc.updateFields(id, { text: 'Hello there' }, 'me');
    peer.updateFields(id, { text: 'Oh Hello' });
    sync(doc, peer);
    expect(doc.getNode(id)!.text).toBe('Oh Hello there');
    undo.undo();
    expect(doc.getNode(id)!.text).toBe('Oh Hello');
    undo.redo();
    expect(doc.getNode(id)!.text).toBe('Oh Hello there');
    // After a merge the copy for older builds holds one side until a server repairs it; then an undo keeps it exact.
    doc.transact(() => repairMirror(raw(doc, id)));
    expect(raw(doc, id).get('text')).toBe('Oh Hello there');
    const solo = new Y.UndoManager([doc.nodes], { trackedOrigins: new Set(['solo']), captureTimeout: 0 });
    doc.updateFields(id, { text: 'Bye' }, 'solo');
    solo.undo();
    expect(doc.getNode(id)!.text).toBe('Oh Hello there');
    expect(raw(doc, id).get('text')).toBe('Oh Hello there');
  });
});

describe('text stored by older builds', () => {
  const spans = [{ start: 3, end: 8, style: { color: 'red', fontSize: '20px' }, href: 'https://a.b/' }];

  it('reads, renders and exports exactly as before, and writes nothing on its own', () => {
    const { doc, page } = fresh();
    const id = old.insert(doc, page, 'Hi there', spans);
    const before = Y.encodeStateVector(doc.y);
    const n = doc.getNode(id)!;
    expect(n.text).toBe('Hi there');
    expect(n.spans).toBe(raw(doc, id).get('spans'));
    expect(docToContent(doc).nodes.find((x) => x.id === id)).toEqual({ id, parent: page, order: 'a0', type: 'text', name: 'Old', tag: 'p', style: {}, text: 'Hi there', spans });
    expect(Y.encodeStateVector(doc.y)).toEqual(before);

    // The same layer written by this build renders the same everywhere.
    const made = doc.insert(page, { type: 'text', tag: 'p', name: 'Old', text: 'Hi there', spans });
    expect(nodeToHtml(doc, made)).toBe(nodeToHtml(doc, id));
    expect(exportDocument(doc, [made]).replaceAll(made, 'X')).toBe(exportDocument(doc, [id]).replaceAll(id, 'X'));
    expect(toJsx(doc, made, 'inline')).toBe(toJsx(doc, id, 'inline'));
    expect(toJsx(doc, made, 'tailwind')).toBe(toJsx(doc, id, 'tailwind'));
    const plain = (x: string) => { const { id: _id, order: _order, ...rest } = docToContent(doc).nodes.find((c) => c.id === x)!; return rest; };
    expect(plain(made)).toEqual(plain(id));
  });

  it('migrates on the first edit, keeping its ranges in place', () => {
    const { doc, page } = fresh();
    const id = old.insert(doc, page, 'Hi there', spans);
    const html = nodeToHtml(doc, id);
    doc.updateFields(id, { tag: 'p' });
    expect(raw(doc, id).has(RICH_KEY)).toBe(false);
    doc.updateFields(id, { text: 'Oh hi there' });
    expect(raw(doc, id).get(RICH_KEY)).toBeInstanceOf(Y.Text);
    expect(doc.getNode(id)!.spans).toEqual([{ ...spans[0], start: 6, end: 11 }]);
    doc.updateFields(id, { text: 'Hi there' });
    expect(nodeToHtml(doc, id)).toBe(html);
    // A layer that is now new-shape still merges.
    const peer = peerOf(doc);
    doc.updateFields(id, { text: 'Hi there!' });
    peer.updateFields(id, { text: 'Hi you there' });
    sync(doc, peer);
    expect(doc.getNode(id)!.text).toBe('Hi you there!');
  });

  it('an older peer sees new text, and its own edits win over the merged text as they always did', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'text', text: 'Hello world', spans: [bold(6, 11)] });
    const older = peerOf(doc);
    expect(old.read(older, id)).toEqual({ text: 'Hello world', spans: [bold(6, 11)] });

    // The older build replaces the whole value, with its own idea of where the ranges went.
    old.write(older, id, { text: 'Hello big world', spans: [bold(10, 15)] });
    sync(doc, older);
    expect(doc.getNode(id)!.text).toBe('Hello big world');
    expect(doc.getNode(id)!.spans).toEqual([bold(10, 15)]);

    // The next edit here starts from what the older build wrote, and the older build reads the result.
    doc.updateFields(id, { text: 'Hello big world!' });
    sync(doc, older);
    expect(old.read(older, id)).toEqual({ text: 'Hello big world!', spans: [bold(10, 16)] });

    // Ranges only, same text: still seen.
    old.write(older, id, { text: 'Hello big world!', spans: [bold(0, 5)] });
    sync(doc, older);
    expect(doc.getNode(id)!.spans).toEqual([bold(0, 5)]);
    old.write(older, id, { spans: undefined });
    sync(doc, older);
    expect(doc.getNode(id)!.spans).toBeUndefined();
    expect(doc.getNode(id)!.text).toBe('Hello big world!');
  });

  it('loses no text between an older peer and two newer ones that typed at once', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'text', text: 'one two' });
    const other = peerOf(doc);
    const older = peerOf(doc);
    doc.updateFields(id, { text: 'one and two' });
    other.updateFields(id, { text: 'one two three' });
    sync(doc, other);
    expect(doc.getNode(id)!.text).toBe('one and two three');
    // The plain copy holds one side until a server puts the merged text there.
    doc.transact(() => repairMirror(raw(doc, id)));
    other.transact(() => repairMirror(raw(other, id)));
    sync(doc, other);
    sync(doc, older);
    sync(other, older);
    expect(old.read(older, id).text).toBe('one and two three');
    expect(doc.getNode(id)!.text).toBe('one and two three');
    expect(raw(doc, id).get('text')).toBe('one and two three');
    expect(raw(other, id).get('text')).toBe('one and two three');
  });

  it('copies of a document hold what shows, and putting one back merges', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'text', text: 'Hello', spans: [bold(0, 5)] });
    const node = encodeKey(doc, 'nodes', id) as { $map: Record<string, unknown> };
    expect(Object.keys(node.$map)).not.toContain(RICH_KEY);
    expect(Object.keys(node.$map)).not.toContain(MARK_KEY);
    expect(node.$map.text).toBe('Hello');
    expect(node.$map.spans).toEqual([bold(0, 5)]);

    const saved = docToContent(doc);
    const peer = peerOf(doc);
    doc.updateFields(id, { text: 'Hello world' });
    peer.updateFields(id, { text: 'Oh Hello' });
    applyContent(doc, saved);
    expect(doc.getNode(id)!.text).toBe('Hello');
    expect(raw(doc, id).get(RICH_KEY)).toBeInstanceOf(Y.Text);
    sync(doc, peer);
    expect(doc.getNode(id)!.text).toBe('Oh Hello');
  });

  it('reverts a text change through the change log', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'text', text: 'Hello' });
    const before = encodeKey(doc, 'nodes', id);
    doc.updateFields(id, { text: 'Hello world', spans: [bold(0, 5)] });
    const ops: ChangeOp[] = [];
    diffEncoded(['nodes', id], before, encodeKey(doc, 'nodes', id), ops);
    expect(ops.map((op) => op.p.join('.')).sort()).toEqual([`nodes.${id}.spans`, `nodes.${id}.text`]);
    const plan = planRevert(doc, [{ id: 'c1', ops }]);
    expect(plan.clean).toBe(true);
    doc.transact(() => applyPlan(doc, plan.ops));
    expect(doc.getNode(id)!.text).toBe('Hello');
    expect(doc.getNode(id)!.spans).toBeUndefined();
    expect(raw(doc, id).get('text')).toBe('Hello');
  });
});
