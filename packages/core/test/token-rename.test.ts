import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  BogenDoc, acceptLibraryUpdates, applyTokenRenames, brandTokenRenames, createComponent, createInstance, emptyBrand, getTextStyles, libraryInfo, libraryTokenRenames, linkLibrary, patchRules,
  previewTokenRename, publishLibrary, readPublished, renameToken, resolveRenames, setTextStyle, tokenRenames, type BrandData,
} from '../src/index.ts';

function fresh() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  return { doc, page: doc.getPages()[0]!.id };
}

describe('renaming a token', () => {
  it('follows every var() reference in the file, as one undo step', () => {
    const { doc, page } = fresh();
    doc.setToken('ink', 'color', '#111');
    doc.setToken('inkish', 'color', '#222');
    doc.setToken('alias', 'color', 'var(--ink)');
    const card = doc.insert(page, {
      type: 'frame', name: 'Card', style: { color: 'var(--ink)', borderColor: 'var( --ink , #000)', background: 'var(--inkish)' },
      attrs: { fill: 'var(--ink)' },
      children: [{ type: 'text', name: 'T', text: 'Hello there', spans: [{ start: 0, end: 5, style: { color: 'var(--ink)' } }] }],
    });
    const text = doc.rawKids(card)[0]!;
    patchRules(doc.nodes.get(card)!, ':hover', { color: 'var(--ink)' });
    createComponent(doc, card);
    const inst = createInstance(doc, card, page);
    doc.updateStyle(`${inst}/${text}`, { color: 'var(--ink)' });
    setTextStyle(doc, 'Body', { fontFamily: 'var(--ink)' });
    doc.meta.set('keyframes', ['@keyframes pulse{from{color:var(--ink)}to{color:red}}']);

    const preview = previewTokenRename(doc, 'ink', 'text');
    expect(preview.references).toBeGreaterThan(5);
    expect(doc.tokens.has('ink')).toBe(true);

    const undo = new Y.UndoManager([doc.nodes, doc.tokens, doc.textStyles, doc.meta], { trackedOrigins: new Set(['me']) });
    const report = renameToken(doc, 'ink', 'text', 'me');
    expect(report.references).toBe(preview.references);
    expect(report.components).toBeGreaterThan(0);
    const n = doc.getNode(card)!;
    expect(n.style.color).toBe('var(--text)');
    expect(n.style.borderColor).toBe('var(--text , #000)');
    // A longer name that only begins with the old one stays.
    expect(n.style.background).toBe('var(--inkish)');
    expect(n.attrs?.fill).toBe('var(--text)');
    expect(n.rules?.[':hover']?.color).toBe('var(--text)');
    expect(doc.getNode(text)!.spans?.[0]?.style?.color).toBe('var(--text)');
    expect(doc.getNode(`${inst}/${text}`)?.style.color).toBe('var(--text)');
    expect(getTextStyles(doc)[0]!.style.fontFamily).toBe('var(--text)');
    expect(doc.getTokens().find((t) => t.name === 'alias')!.value).toBe('var(--text)');
    expect((doc.meta.get('keyframes') as string[])[0]).toContain('var(--text)');
    expect(tokenRenames(doc).map((r) => [r.from, r.to])).toEqual([['ink', 'text']]);

    undo.undo();
    expect(doc.tokens.has('ink')).toBe(true);
    expect(doc.tokens.has('text')).toBe(false);
    expect(doc.getNode(card)!.style.color).toBe('var(--ink)');
  });

  it('refuses a name that is taken, and one that is no token name', () => {
    const { doc } = fresh();
    doc.setToken('a', 'color', '#111');
    doc.setToken('b', 'color', '#222');
    expect(() => renameToken(doc, 'a', 'b')).toThrow(/already/);
    expect(() => renameToken(doc, 'a', '1 x')).toThrow(/cannot name/);
    expect(() => renameToken(doc, 'nope', 'c')).toThrow(/no token/);
  });

  it('folds chains of renames', () => {
    const map = resolveRenames([{ from: 'a', to: 'b', at: 1 }, { from: 'b', to: 'c', at: 2 }, { from: 'x', to: 'y', at: 3 }, { from: 'y', to: 'x', at: 4 }]);
    expect(map.get('a')).toBe('c');
    expect(map.get('b')).toBe('c');
    expect(map.has('x')).toBe(false);
    expect([...resolveRenames([{ from: 'a', to: 'b', at: 1 }, { from: 'b', to: 'c', at: 2 }], 1)]).toEqual([['b', 'c']]);
  });

  it('moves references onto a token the file has already when a rename arrives from elsewhere', () => {
    const { doc, page } = fresh();
    doc.setToken('old', 'color', '#111');
    doc.setToken('new', 'color', '#999');
    const id = doc.insert(page, { type: 'frame', style: { color: 'var(--old)' } });
    applyTokenRenames(doc, new Map([['old', 'new'], ['missing', 'x']]));
    expect(doc.tokens.has('old')).toBe(false);
    expect(doc.getTokens().find((t) => t.name === 'new')!.value).toBe('#999');
    expect(doc.getNode(id)!.style.color).toBe('var(--new)');
    expect(tokenRenames(doc)).toEqual([]);
  });
});

describe('token renames through a library', () => {
  afterEach(() => vi.useRealTimers());
  it('reaches a linked file as an update, and accepting renames its own references', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const lib = fresh();
    lib.doc.setToken('brand', 'color', '#ff0044');
    const button = lib.doc.insert(lib.page, { type: 'frame', tag: 'button', name: 'Button', style: { backgroundColor: 'var(--brand)' } });
    createComponent(lib.doc, button);
    publishLibrary(lib.doc, { name: 'UI' });

    const use = fresh();
    linkLibrary(use.doc, { id: 'libfile1', name: 'UI', kind: 'file' }, readPublished(lib.doc));
    const own = use.doc.insert(use.page, { type: 'frame', name: 'Own', style: { color: 'var(--brand)' } });
    expect(libraryTokenRenames(use.doc, 'libfile1', libraryInfo(lib.doc))).toEqual([]);

    vi.setSystemTime(2_000_000);
    renameToken(lib.doc, 'brand', 'accent');
    const out = publishLibrary(lib.doc);
    expect(out.info.renames?.map((r) => r.to)).toEqual(['accent']);
    expect(libraryTokenRenames(use.doc, 'libfile1', libraryInfo(lib.doc))).toEqual([{ from: 'brand', to: 'accent' }]);

    const done = acceptLibraryUpdates(use.doc, 'libfile1', readPublished(lib.doc), undefined, undefined, libraryInfo(lib.doc));
    // Its own layer and the library's copy of the button.
    expect(done.renamed).toEqual([{ from: 'brand', to: 'accent', references: 2 }]);
    expect(use.doc.tokens.has('brand')).toBe(false);
    expect(use.doc.tokens.has('accent')).toBe(true);
    expect(use.doc.getNode(own)!.style.color).toBe('var(--accent)');
    // Taken once: the next look finds nothing new.
    expect(libraryTokenRenames(use.doc, 'libfile1', libraryInfo(lib.doc))).toEqual([]);
  });
});

describe('token renames through a brand', () => {
  it('reads a renamed token from two brand versions', () => {
    const a: BrandData = emptyBrand();
    a.colors = [{ id: 'c1', name: 'Accent', value: '#2b3df2', token: 'blue' } as BrandData['colors'][number], { id: 'c2', name: 'Ink', value: '#111', token: 'ink', suggested: true } as BrandData['colors'][number]];
    const b: BrandData = { ...a, colors: [{ ...a.colors[0]!, token: 'accent' }, { ...a.colors[1]!, token: 'text' }] };
    expect([...brandTokenRenames(a, b)]).toEqual([['blue', 'accent']]);
  });
});
