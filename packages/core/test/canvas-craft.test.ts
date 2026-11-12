import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  BogenDoc, bulkRename, cleanLayoutGrids, defaultLayoutGrid, describeLayoutGrid, exportDocument, findText, framePreset, gridLines, layoutGridTracks,
  matchingLayers, matchOffsets, presetOfSize, replaceText,
} from '../src/index.ts';

function fresh(): { doc: BogenDoc; page: string } {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  return { doc, page: doc.getPages()[0]!.id };
}

describe('layout grids', () => {
  it('lays out stretched columns between the margins', () => {
    const tracks = layoutGridTracks({ kind: 'columns', count: 12, gutter: 24, margin: 80, align: 'stretch' }, { w: 1440, h: 900 });
    expect(tracks).toHaveLength(12);
    expect(tracks[0]!.start).toBe(80);
    const last = tracks.at(-1)!;
    expect(last.start + last.size).toBeCloseTo(1360, 6);
    expect(tracks[1]!.start - (tracks[0]!.start + tracks[0]!.size)).toBeCloseTo(24, 6);
  });

  it('places fixed tracks at the start, centre and end', () => {
    const base = { kind: 'rows' as const, count: 3, gutter: 10, size: 50, margin: 20 };
    expect(layoutGridTracks({ ...base, align: 'start' }, { w: 100, h: 400 }).map((t) => t.start)).toEqual([20, 80, 140]);
    expect(layoutGridTracks({ ...base, align: 'end' }, { w: 100, h: 400 }).map((t) => t.start)).toEqual([210, 270, 330]);
    expect(layoutGridTracks({ ...base, align: 'center' }, { w: 100, h: 400 }).map((t) => t.start)).toEqual([115, 175, 235]);
    expect(layoutGridTracks({ ...base, align: 'center' }, { w: 100, h: 400 })[0]!.axis).toBe('y');
  });

  it('draws a square grid only while it helps', () => {
    expect(gridLines({ kind: 'grid', size: 100 }, { w: 300, h: 200 })).toEqual({ x: [100, 200], y: [100] });
    expect(gridLines({ kind: 'grid', size: 1 }, { w: 5000, h: 5000 })).toEqual({ x: [], y: [] });
  });

  it('cleans what arrives from elsewhere', () => {
    expect(cleanLayoutGrids([{ kind: 'columns', count: 1e6, gutter: -5, color: 'red;background:url(x)' }, { kind: 'nope' }, 'x'])).toEqual([{ kind: 'columns', count: 200, gutter: 0, margin: 0, align: 'stretch' }]);
    expect(cleanLayoutGrids([])).toBeUndefined();
    expect(cleanLayoutGrids('x')).toBeUndefined();
    expect(cleanLayoutGrids(Array.from({ length: 20 }, () => ({ kind: 'grid', size: 8 })))).toHaveLength(8);
  });

  it('undoes a change to a grid back to the grid before', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'frame', artboard: true });
    const undo = new Y.UndoManager(doc.nodes, { trackedOrigins: new Set(['me']), captureTimeout: 0 });
    doc.transact(() => doc.updateFields(id, { layoutGrids: [{ kind: 'columns', count: 12 }] }), 'me');
    doc.transact(() => doc.updateFields(id, { layoutGrids: [{ kind: 'columns', count: 6 }] }), 'me');
    undo.undo();
    expect(doc.getNode(id)!.layoutGrids![0]!.count).toBe(12);
  });

  it('suits the default to the width', () => {
    expect(defaultLayoutGrid('columns', 1440).count).toBe(12);
    expect(defaultLayoutGrid('columns', 768).count).toBe(8);
    expect(defaultLayoutGrid('columns', 390).count).toBe(4);
    expect(describeLayoutGrid(defaultLayoutGrid('columns', 1440))).toBe('12 columns, gutter 24, margin 80');
  });

  it('is stored on the layer, synced, undone, kept by copies and left out of exports', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'frame', name: 'Board', artboard: true, style: { width: '1440px', height: '900px' } });
    const undo = new Y.UndoManager(doc.nodes, { trackedOrigins: new Set(['me']) });
    doc.updateFields(id, { layoutGrids: [defaultLayoutGrid('columns', 1440)] }, 'me');
    expect(doc.getNode(id)!.layoutGrids).toEqual([{ kind: 'columns', count: 12, gutter: 24, margin: 80, align: 'stretch' }]);
    // Another device sees it.
    const other = new BogenDoc(new Y.Doc());
    Y.applyUpdate(other.y, Y.encodeStateAsUpdate(doc.y));
    expect(other.getNode(id)!.layoutGrids?.[0]!.count).toBe(12);
    // Duplicates and copies keep it.
    const [copy] = doc.duplicate([id]);
    expect(doc.getNode(copy!)!.layoutGrids).toHaveLength(1);
    // No export writes it.
    expect(exportDocument(doc, [id])).not.toMatch(/layoutGrid|columns|gutter/);
    undo.undo();
    expect(doc.getNode(id)!.layoutGrids).toBeUndefined();
    // An empty list is none.
    doc.updateFields(id, { layoutGrids: [{ kind: 'grid', size: 8 }] });
    doc.updateFields(id, { layoutGrids: [] });
    expect(doc.nodes.get(id)!.has('layoutGrids')).toBe(false);
  });
});

describe('find and replace', () => {
  it('matches case, whole words and leaves nothing overlapping', () => {
    expect(matchOffsets('Book a book, notebook', { query: 'book' })).toEqual([0, 7, 17]);
    expect(matchOffsets('Book a book, notebook', { query: 'book', caseSensitive: true })).toEqual([7, 17]);
    expect(matchOffsets('Book a book, notebook', { query: 'book', wholeWord: true })).toEqual([0, 7]);
    expect(matchOffsets('aaaa', { query: 'aa' })).toEqual([0, 2]);
    expect(matchOffsets('a.b', { query: '.' })).toEqual([1]);
  });

  it('replaces across pages as one step, keeps ranges and skips locked and instance layers', () => {
    const { doc, page } = fresh();
    const p2 = doc.createPage('Two');
    const a = doc.insert(page, { type: 'text', text: 'Sign up today, sign up now', spans: [{ start: 15, end: 26, style: { fontWeight: '700' } }] });
    const b = doc.insert(p2, { type: 'text', text: 'Sign up' });
    const frame = doc.insert(page, { type: 'frame', name: 'Locked' });
    const c = doc.insert(frame, { type: 'text', text: 'sign up' });
    doc.updateFields(frame, { locked: true });
    expect(findText(doc, { query: 'sign up' }).map((h) => [h.id, h.at.length, h.locked])).toEqual([[a, 2, false], [c, 1, true], [b, 1, false]]);
    expect(findText(doc, { query: 'sign up' }, { pageId: p2 }).map((h) => h.id)).toEqual([b]);
    const undo = new Y.UndoManager(doc.nodes, { trackedOrigins: new Set(['me']) });
    const out = replaceText(doc, { query: 'sign up' }, 'Join', { origin: 'me' });
    expect(out).toEqual({ replaced: 3, layers: [a, b], skipped: [{ id: c, reason: 'locked' }] });
    expect(doc.getNode(a)!.text).toBe('Join today, Join now');
    // The bold range still covers "Join now".
    expect(doc.getNode(a)!.spans).toEqual([{ start: 12, end: 20, style: { fontWeight: '700' } }]);
    expect(doc.getNode(b)!.text).toBe('Join');
    expect(doc.getNode(c)!.text).toBe('sign up');
    undo.undo();
    expect(doc.getNode(a)!.text).toBe('Sign up today, sign up now');
    expect(doc.getNode(b)!.text).toBe('Sign up');
  });

  it('replaces only in the layers asked for', () => {
    const { doc, page } = fresh();
    const a = doc.insert(page, { type: 'text', text: 'one one' });
    const b = doc.insert(page, { type: 'text', text: 'one' });
    expect(replaceText(doc, { query: 'one' }, 'two', { only: [b] }).replaced).toBe(1);
    expect([doc.getNode(a)!.text, doc.getNode(b)!.text]).toEqual(['one one', 'two']);
  });
});

describe('bulk rename', () => {
  it('numbers, pads, counts down and keeps the old name with $&', () => {
    expect(bulkRename(['a', 'b', 'c'], { pattern: 'Card $n' })).toEqual(['Card 1', 'Card 2', 'Card 3']);
    expect(bulkRename(Array.from({ length: 10 }, () => 'x'), { pattern: '$nn' }).slice(0, 2)).toEqual(['01', '02']);
    expect(bulkRename(['a', 'b'], { pattern: '$N. $&', start: 5 })).toEqual(['6. a', '5. b']);
    expect(bulkRename(['Frame 12', 'frame'], { find: 'frame', replace: 'Card' })).toEqual(['Card 12', 'Card']);
    expect(bulkRename(['Frame', 'frame'], { find: 'frame', replace: 'Card', caseSensitive: true })).toEqual(['Frame', 'Card']);
    expect(bulkRename(['Keep'], { find: 'Keep', replace: '' })).toEqual(['Keep']);
    expect(bulkRename(['a'], { pattern: 'x'.repeat(300) })[0]).toHaveLength(200);
  });
});

describe('frame presets', () => {
  it('finds presets by name and size, in either orientation', () => {
    expect(framePreset('iphone 16 pro max')).toMatchObject({ w: 440, h: 956 });
    expect(framePreset('slide-16:9')).toMatchObject({ w: 1920, h: 1080 });
    expect(presetOfSize(852, 393)).toMatchObject({ preset: { name: 'Phone' }, landscape: true });
    expect(presetOfSize(1, 1)).toBeUndefined();
  });
});

describe('matching layers', () => {
  it('matches the look and shape, not the place or the words', () => {
    const { doc, page } = fresh();
    const board = doc.insert(page, { type: 'frame', name: 'Board' });
    const card = (x: number, title: string, color = '#fff') => doc.insert(board, { type: 'frame', name: `Card ${x}`, style: { left: `${x}px`, width: `${100 + x}px`, backgroundColor: color, borderRadius: '8px' }, children: [{ type: 'text', text: title, style: { fontSize: '16px' } }] });
    const a = card(0, 'One');
    const b = card(200, 'Two');
    card(400, 'Three', '#000');
    const d = doc.insert(board, { type: 'frame', name: 'Card 4', style: { backgroundColor: '#fff', borderRadius: '8px' } });
    expect(matchingLayers(doc, [a])).toEqual([a, b]);
    const titleA = doc.getChildren(a)[0]!.id;
    expect(matchingLayers(doc, [titleA])).toHaveLength(3);
    expect(matchingLayers(doc, [d])).toEqual([d]);
  });
});
