import { describe, expect, it } from 'vitest';
import { BogenDoc, changedScreens, createDesignBranch, docToContent, previewMergeContent, switchDesignBranch } from '../src/index.ts';

function fileWithScreens() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  doc.setToken('accent', 'color', '#2b3df2');
  doc.setToken('ink', 'color', '#111');
  const board = (name: string, left: number, color: string) => doc.insert(page, { type: 'frame', name, artboard: true, style: { position: 'absolute', left: `${left}px`, top: '0px', width: '300px', height: '200px' }, children: [{ type: 'text', name: 'Title', text: name, style: { color } }] });
  const hero = board('Hero', 0, 'var(--ink)');
  const pricing = board('Pricing', 400, 'var(--accent)');
  const about = board('About', 800, '#000');
  return { doc, page, hero, pricing, about };
}

describe('the merge preview', () => {
  it('lists the screens a merge changes in the parent, without merging', () => {
    const { doc, page, hero, pricing, about } = fileWithScreens();
    const { branch } = createDesignBranch(doc, { name: 'Warmer', by: 'claude', checkout: true });
    doc.updateFields(doc.getChildren(hero)[0]!.id, { text: 'A warmer hero' });
    doc.setToken('accent', 'color', '#ff6600');
    doc.delete([about]);
    doc.insert(page, { type: 'frame', name: 'Contact', artboard: true, style: { position: 'absolute', left: '1200px', top: '0px', width: '300px', height: '200px' } });
    switchDesignBranch(doc, 'main');
    const mainBefore = JSON.stringify(docToContent(doc));

    const { before, after, conflicts, into } = previewMergeContent(doc, branch.id);
    expect(into.id).toBe('main');
    expect(conflicts).toEqual([]);
    const screens = changedScreens(before, after);
    // In page order; Contact took the place About had, so those two tie on order and go by id.
    expect(screens.slice(0, 2).map((s) => [s.name, s.change])).toEqual([['Hero', 'changed'], ['Pricing', 'changed']]);
    expect(screens.slice(2).map((s) => [s.name, s.change]).sort()).toEqual([['About', 'removed'], ['Contact', 'added']]);
    // Pricing changed only through its token.
    expect(screens.find((s) => s.id === pricing)!.layers).toBe(0);
    expect(screens.find((s) => s.id === hero)!.layers).toBe(1);
    // Nothing was merged.
    expect(JSON.stringify(docToContent(doc))).toBe(mainBefore);
  });

  it('finds no screens when the branch changed nothing', () => {
    const { doc } = fileWithScreens();
    const { branch } = createDesignBranch(doc, { name: 'Same', by: 'claude', checkout: false });
    const { before, after } = previewMergeContent(doc, branch.id);
    expect(changedScreens(before, after)).toEqual([]);
  });
});
