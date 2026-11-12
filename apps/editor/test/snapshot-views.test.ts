import { describe, expect, it } from 'vitest';
import { BogenDoc, createComponent, createInstance, setSlot } from '@bogen/core';
import { Snapshot } from '../src/doc/snapshot.ts';

function setup() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  const main = doc.insert(page, { type: 'frame', name: 'Card', style: { position: 'absolute', left: '0px', top: '0px', width: '100px' }, children: [
    { type: 'text', tag: 'p', name: 'Title', text: 'Title', style: {} },
    { type: 'text', tag: 'p', name: 'Body', text: 'Body', style: {} },
  ] });
  createComponent(doc, main);
  const [title, body] = doc.rawKids(main) as [string, string];
  return { doc, page, main, title, body, snap: new Snapshot(doc) };
}

describe('views inside instances in the editor snapshot', () => {
  it('reads and lists them, by the same ids as core', () => {
    const { doc, page, main, title, snap } = setup();
    const a = createInstance(doc, main, page, { style: { position: 'absolute', left: '200px', top: '0px' } });
    expect(snap.children(a)).toEqual(doc.getChildren(a).map((c) => c.id));
    expect(snap.nodes.get(`${a}/${title}`)?.text).toBe('Title');
    expect(snap.nodes.has(`${a}/${title}`)).toBe(true);
    expect(snap.nodes.has(`${a}/nope`)).toBe(false);
    expect(snap.nodes.get(a)?.style.width).toBe('100px');
    expect(snap.nodes.stored(a)?.style.width).toBeUndefined();
    expect(snap.ancestors(`${a}/${title}`)).toEqual([a]);
    expect(snap.pageOf(`${a}/${title}`)).toBe(page);
    expect([...snap.nodes.values()].some((n) => n.id.includes('/'))).toBe(false);
  });

  it('tells only those who read what changed, and keeps the identity of the rest', () => {
    const { doc, page, main, title, body, snap } = setup();
    const a = createInstance(doc, main, page);
    const b = createInstance(doc, main, page);
    const seen: string[] = [];
    for (const id of [`${a}/${title}`, `${a}/${body}`, `${b}/${title}`, a]) snap.subscribeNode(id, () => seen.push(id));
    const bodyBefore = snap.node(`${a}/${body}`);
    snap.node(`${a}/${title}`);
    snap.node(`${b}/${title}`);
    snap.node(a);
    doc.updateFields(title, { text: 'New' });
    expect(seen.sort()).toEqual([`${a}/${title}`, `${b}/${title}`].sort());
    expect(snap.node(`${a}/${title}`)?.text).toBe('New');
    expect(snap.node(`${a}/${body}`)).toBe(bodyBefore);
    seen.length = 0;
    doc.updateStyle(main, { width: '120px' });
    expect(seen).toEqual([a]);
    expect(snap.node(a)?.style.width).toBe('120px');
  });

  it('an override reaches one instance, and a stored node change the rest of its views', () => {
    const { doc, page, main, title, snap } = setup();
    const a = createInstance(doc, main, page);
    const b = createInstance(doc, main, page);
    const seen: string[] = [];
    for (const id of [`${a}/${title}`, `${b}/${title}`]) {
      snap.node(id);
      snap.subscribeNode(id, () => seen.push(id));
    }
    doc.updateFields(`${a}/${title}`, { text: 'Own' });
    expect(seen).toEqual([`${a}/${title}`]);
    expect(snap.node(`${a}/${title}`)?.text).toBe('Own');
    expect(snap.node(`${b}/${title}`)?.text).toBe('Title');
  });

  it('children of a view follow structure changes in the main and tell who listens', () => {
    const { doc, page, main, title, snap } = setup();
    const a = createInstance(doc, main, page);
    let told = 0;
    snap.children(a);
    snap.subscribeChildren(a, () => told++);
    const before = snap.structureVersion;
    const added = doc.insert(main, { type: 'text', tag: 'p', name: 'Extra', text: 'Extra' });
    expect(told).toBe(1);
    expect(snap.children(a)).toContain(`${a}/${added}`);
    expect(snap.structureVersion).toBeGreaterThan(before);
    doc.delete([title]);
    expect(snap.children(a)).not.toContain(`${a}/${title}`);
    expect(snap.nodes.has(`${a}/${title}`)).toBe(false);
  });

  it('a fill shows under its slot, and its parent says so', () => {
    const { doc, page, main, body, snap } = setup();
    doc.updateFields(body, {});
    const frame = doc.insert(main, { type: 'frame', name: 'Slot', style: {} });
    setSlot(doc, frame, 'content');
    const a = createInstance(doc, main, page);
    expect(snap.children(`${a}/${frame}`)).toEqual([]);
    const fill = doc.insert(`${a}/${frame}`, { type: 'text', tag: 'p', name: 'Mine', text: 'Mine' });
    expect(snap.children(`${a}/${frame}`)).toEqual([fill]);
    expect(snap.nodes.get(fill)?.parent).toBe(`${a}/${frame}`);
    expect(snap.children(a)).not.toContain(fill);
    expect(snap.ancestors(fill)).toEqual([`${a}/${frame}`, a]);
    doc.delete([fill]);
    expect(snap.children(`${a}/${frame}`)).toEqual([]);
  });

  it('undoing a delete of a main brings back views', () => {
    const { doc, page, main, title, snap } = setup();
    const a = createInstance(doc, main, page);
    expect(snap.nodes.get(`${a}/${title}`)?.text).toBe('Title');
    doc.delete([main]);
    expect(snap.nodes.stored(a)?.instanceOf).toBeUndefined();
    expect(snap.mains.has(main)).toBe(false);
    expect(snap.children(a).length).toBe(2);
    expect(snap.children(a).every((c) => !c.includes('/'))).toBe(true);
  });

  it('500 instances: one main edit recomputes in a few ms, and old views do not pile up', () => {
    const { doc, page, main, title, snap } = setup();
    const ids: string[] = [];
    doc.transact(() => {
      for (let i = 0; i < 500; i++) ids.push(createInstance(doc, main, page, { style: { position: 'absolute', left: `${i}px`, top: '0px' } }));
    });
    let told = 0;
    for (const id of ids) {
      for (const kid of snap.children(id)) {
        snap.node(kid);
        snap.subscribeNode(kid, () => told++);
      }
      snap.node(id);
    }
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      doc.updateFields(title, { text: `T${i}` });
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[10]!;
    console.log(`snapshot: median ${median.toFixed(2)} ms per main edit with 500 instances, worst ${times.at(-1)!.toFixed(2)} ms`);
    expect(told).toBe(20 * 500);
    expect(median).toBeLessThan(50);
    expect(snap.node(`${ids[499]}/${title}`)?.text).toBe('T19');
  });
});
