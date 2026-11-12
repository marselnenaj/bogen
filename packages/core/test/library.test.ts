import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  BogenDoc, acceptLibraryUpdates, applyContent, docFromContent, docToContent, cachedMains, clipSpec, createComponent, createInstance, libraryClip, libraryLayerId, libraryLinks, libraryUpdates, linkLibrary, nodeToHtml,
  pasteLibraryClip, publishLibrary, readPublished, setOverride, unlinkLibrary, unpublishedChanges,
} from '../src/index.ts';

function fresh() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  return { doc, page: doc.getPages()[0]!.id };
}

/** A library file with a Button and a Card that shows a Button. */
function library() {
  const { doc, page } = fresh();
  doc.setToken('brand', 'color', '#ff0044');
  const button = doc.insert(page, {
    type: 'frame', tag: 'button', name: 'Button', style: { position: 'absolute', left: '300px', top: '20px', padding: '8px', backgroundColor: 'var(--brand)' },
    children: [{ type: 'text', tag: 'span', name: 'Label', text: 'Buy', style: { color: 'rgb(255, 255, 255)' } }],
  });
  const label = doc.rawKids(button)[0]!;
  createComponent(doc, button, { props: [{ name: 'label', type: 'text', targets: [{ path: label, field: 'text' }] }] });
  const card = doc.insert(page, { type: 'frame', name: 'Card', style: { position: 'absolute', left: '0px', top: '0px', padding: '16px' }, children: [{ type: 'text', name: 'Title', text: 'Hello' }] });
  createComponent(doc, card);
  createInstance(doc, button, card);
  return { doc, page, button, label, card };
}

function consumer() {
  return fresh();
}

describe('shared libraries', () => {
  it('publishes components, links them into another file, and instances render from the copy', () => {
    const lib = library();
    const out = publishLibrary(lib.doc, { name: 'UI' });
    expect(out.changed.map((c) => c.name).sort()).toEqual(['Button', 'Card']);
    expect(readPublished(lib.doc).find((p) => p.main === lib.card)!.needs).toEqual([lib.button]);
    // Moving a main on its page is not a change of the component.
    lib.doc.updateStyle(lib.button, { left: '900px' });
    expect(unpublishedChanges(lib.doc)).toEqual([]);

    const use = consumer();
    const ids = linkLibrary(use.doc, { id: 'libfile1', name: 'UI', kind: 'file' }, readPublished(lib.doc));
    expect(ids[lib.button]).toBe(libraryLayerId('libfile1', lib.button));
    expect(libraryLinks(use.doc).map((l) => l.name)).toEqual(['UI']);
    expect(use.doc.tokens.has('brand')).toBe(true);
    const inst = createInstance(use.doc, ids[lib.card]!, use.page);
    const html = nodeToHtml(use.doc, inst);
    expect(html).toContain('Hello');
    expect(html).toContain('Buy');
    // The copies are on no page: nothing on the canvas but the instance.
    expect(use.doc.getChildren(use.page).map((n) => n.id)).toEqual([inst]);
    expect(use.doc.pageOf(ids[lib.card]!)).toBeUndefined();
  });

  it('offers an update when the library publishes again, and keeps overrides when it is accepted', () => {
    const lib = library();
    publishLibrary(lib.doc);
    const use = consumer();
    const ids = linkLibrary(use.doc, { id: 'libfile1', name: 'UI' }, readPublished(lib.doc));
    const inst = createInstance(use.doc, ids[lib.button]!, use.page);
    const labelView = `${inst}/${libraryLayerId('libfile1', lib.label)}`;
    setOverride(use.doc, labelView, 'text', 'Sale');
    setOverride(use.doc, labelView, 'style.color', 'rgb(0, 0, 0)');

    // An edit in the library that is not published yet is not offered.
    lib.doc.updateStyle(lib.button, { backgroundColor: 'rgb(1, 2, 3)', borderRadius: '99px' });
    lib.doc.insert(lib.button, { type: 'frame', name: 'Icon', style: { width: '8px', height: '8px' } });
    expect(unpublishedChanges(lib.doc).map((c) => c.name)).toEqual(['Button']);
    expect(libraryUpdates(use.doc, 'libfile1', readPublished(lib.doc))).toEqual([]);

    publishLibrary(lib.doc);
    const updates = libraryUpdates(use.doc, 'libfile1', readPublished(lib.doc));
    expect(updates.map((u) => [u.name, u.status, u.from, u.to, u.instances])).toEqual([['Button', 'changed', 1, 2, 1]]);
    // Nothing changes before it is accepted.
    expect(nodeToHtml(use.doc, inst)).not.toContain('99px');

    const done = acceptLibraryUpdates(use.doc, 'libfile1', readPublished(lib.doc));
    expect(done.accepted.map((u) => u.name)).toEqual(['Button']);
    expect(done.overrides).toEqual({ kept: 2, orphaned: 0 });
    const html = nodeToHtml(use.doc, inst);
    expect(html).toContain('99px');
    expect(html).toContain('Sale');
    expect(html).toContain('rgb(0, 0, 0)');
    expect(use.doc.getChildren(inst)).toHaveLength(2);
    expect(libraryUpdates(use.doc, 'libfile1', readPublished(lib.doc))).toEqual([]);
  });

  it('accepting a component brings the library components it shows along', () => {
    const lib = library();
    publishLibrary(lib.doc);
    const use = consumer();
    const ids = linkLibrary(use.doc, { id: 'libfile1', name: 'UI' }, readPublished(lib.doc));
    const inst = createInstance(use.doc, ids[lib.card]!, use.page);
    lib.doc.updateFields(lib.label, { text: 'Order' });
    publishLibrary(lib.doc);
    expect(libraryUpdates(use.doc, 'libfile1', readPublished(lib.doc)).map((u) => u.name)).toEqual(['Button']);
    acceptLibraryUpdates(use.doc, 'libfile1', readPublished(lib.doc), ['Card', 'Button']);
    expect(nodeToHtml(use.doc, inst)).toContain('Order');
  });

  it('renders on a second device from the synced copy, with no library there', () => {
    const lib = library();
    publishLibrary(lib.doc);
    const a = consumer();
    const ids = linkLibrary(a.doc, { id: 'libfile1', name: 'UI' }, readPublished(lib.doc));
    const inst = createInstance(a.doc, ids[lib.card]!, a.page);
    const b = new BogenDoc(new Y.Doc());
    Y.applyUpdate(b.y, Y.encodeStateAsUpdate(a.doc.y));
    expect(nodeToHtml(b, inst)).toContain('Buy');
    // Both devices accepting the same update at once end with one copy, the same on both.
    lib.doc.updateFields(lib.label, { text: 'Now' });
    publishLibrary(lib.doc);
    acceptLibraryUpdates(a.doc, 'libfile1', readPublished(lib.doc));
    acceptLibraryUpdates(b, 'libfile1', readPublished(lib.doc));
    Y.applyUpdate(b.y, Y.encodeStateAsUpdate(a.doc.y));
    Y.applyUpdate(a.doc.y, Y.encodeStateAsUpdate(b.y));
    expect(nodeToHtml(a.doc, inst)).toContain('Now');
    expect(nodeToHtml(b, inst)).toBe(nodeToHtml(a.doc, inst));
    expect(a.doc.nodes.size).toBe(b.nodes.size);
  });

  it('a copy pasted into another file stays linked to the library', () => {
    const lib = library();
    publishLibrary(lib.doc);
    const a = consumer();
    const ids = linkLibrary(a.doc, { id: 'libfile1', name: 'UI' }, readPublished(lib.doc));
    const inst = createInstance(a.doc, ids[lib.card]!, a.page);
    const spec = JSON.parse(JSON.stringify(clipSpec(a.doc, inst)));
    const clip = JSON.parse(JSON.stringify(libraryClip(a.doc, [inst])));
    expect(clip[0].roots.map((r: { meta: { name: string } }) => r.meta.name).sort()).toEqual(['Button', 'Card']);

    const c = consumer();
    let pasted = '';
    c.doc.transact(() => {
      pasteLibraryClip(c.doc, clip);
      pasted = c.doc.insert(c.page, spec);
    });
    expect(c.doc.rawNode(pasted)!.instanceOf).toBe(ids[lib.card]);
    expect(libraryLinks(c.doc).map((l) => l.id)).toEqual(['libfile1']);
    expect(nodeToHtml(c.doc, pasted)).toContain('Buy');
    lib.doc.updateFields(lib.label, { text: 'Later' });
    publishLibrary(lib.doc);
    expect(libraryUpdates(c.doc, 'libfile1', readPublished(lib.doc)).map((u) => u.name)).toEqual(['Button']);
    // Without the clip's library part the paste arrives as plain layers, as before.
    const d = consumer();
    const plain = d.doc.insert(d.page, spec);
    expect(d.doc.rawNode(plain)!.instanceOf).toBeUndefined();
  });

  it('library copies stay through a commit and a restore', () => {
    const lib = library();
    publishLibrary(lib.doc);
    const use = consumer();
    const ids = linkLibrary(use.doc, { id: 'libfile1', name: 'UI' }, readPublished(lib.doc));
    const inst = createInstance(use.doc, ids[lib.card]!, use.page);
    const content = JSON.parse(JSON.stringify(docToContent(use.doc)));
    expect(nodeToHtml(docFromContent(content), inst)).toContain('Buy');
    use.doc.insert(use.page, { type: 'frame', name: 'Later' });
    applyContent(use.doc, content);
    expect(nodeToHtml(use.doc, inst)).toContain('Buy');
    expect(libraryLinks(use.doc).map((l) => l.id)).toEqual(['libfile1']);
  });

  it('unlinking keeps the copies instances use and drops the rest', () => {
    const lib = library();
    publishLibrary(lib.doc);
    const use = consumer();
    const ids = linkLibrary(use.doc, { id: 'libfile1', name: 'UI' }, readPublished(lib.doc));
    createInstance(use.doc, ids[lib.card]!, use.page);
    expect(unlinkLibrary(use.doc, 'libfile1')).toEqual({ kept: 2, removed: 0 });
    const use2 = consumer();
    linkLibrary(use2.doc, { id: 'libfile1', name: 'UI' }, readPublished(lib.doc));
    expect(unlinkLibrary(use2.doc, 'libfile1')).toEqual({ kept: 0, removed: 2 });
    expect(cachedMains(use2.doc)).toEqual([]);
  });

  it('a removed library component stays for the instances that use it', () => {
    const lib = library();
    publishLibrary(lib.doc);
    const use = consumer();
    const ids = linkLibrary(use.doc, { id: 'libfile1', name: 'UI' }, readPublished(lib.doc));
    const inst = createInstance(use.doc, ids[lib.card]!, use.page);
    lib.doc.delete([lib.card]);
    publishLibrary(lib.doc);
    expect(libraryUpdates(use.doc, 'libfile1', readPublished(lib.doc)).map((u) => [u.name, u.status])).toEqual([['Card', 'removed']]);
    acceptLibraryUpdates(use.doc, 'libfile1', readPublished(lib.doc));
    expect(nodeToHtml(use.doc, inst)).toContain('Hello');
    expect(libraryUpdates(use.doc, 'libfile1', readPublished(lib.doc))).toEqual([]);
  });
});
