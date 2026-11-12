import { describe, expect, it } from 'vitest';
import { attachType, isImageAttachment, layerChips, movable, stepLines, undoWords } from '../src/panels/collab-words.ts';

const HASH = 'a'.repeat(64);

describe('files on a comment', () => {
  it('takes images, PDFs and text files, by type or by name, and nothing else', () => {
    expect(attachType({ type: 'image/png', name: 'shot.png' })).toBe('image/png');
    expect(attachType({ type: 'application/pdf', name: 'brief.pdf' })).toBe('application/pdf');
    // Browsers often give Markdown and CSV no type.
    expect(attachType({ type: '', name: 'notes.MD' })).toBe('text/markdown');
    expect(attachType({ type: '', name: 'table.csv' })).toBe('text/csv');
    expect(attachType({ type: 'text/html', name: 'page.html' })).toBeNull();
    expect(attachType({ type: 'application/zip', name: 'all.zip' })).toBeNull();
  });

  it('tells pictures from files by the stored name', () => {
    expect(isImageAttachment(`bogen-asset:${HASH}.png`)).toBe(true);
    expect(isImageAttachment(`bogen-asset:${HASH}.svg`)).toBe(true);
    expect(isImageAttachment(`bogen-asset:${HASH}.pdf`)).toBe(false);
    expect(isImageAttachment('https://example.com/x.png')).toBe(false);
  });
});

describe('steps under a thread', () => {
  it('reads as words, folds repeats into a count, and keeps the newest', () => {
    const steps = ['context_get', 'layer_tree', 'layer_style', 'layer_style', 'layer_style', 'canvas_screenshot'].map((tool) => ({ tool }));
    expect(stepLines(steps)).toEqual([
      { text: 'Looked at the file', count: 1 }, { text: 'Read the layers', count: 1 }, { text: 'Changed styles', count: 3 }, { text: 'Looked at it', count: 1 },
    ]);
    expect(stepLines(steps, 2).map((l) => l.text)).toEqual(['Changed styles', 'Looked at it']);
    expect(stepLines([])).toEqual([]);
  });
});

describe('what a run changed', () => {
  it('says what undo did, including what stayed', () => {
    expect(undoWords({ reverted: 3, clean: true, conflicts: [], changes: ['a'] })).toBe('Taken back.');
    expect(undoWords({ reverted: 2, clean: false, conflicts: [{ what: 'Hero', field: 'style.padding', reason: 'changed since' }], changes: ['a'] })).toBe('Taken back, except one value someone changed since: Hero padding.');
    expect(undoWords({ reverted: 0, clean: false, conflicts: [{ what: 'A', reason: 'x' }, { what: 'B', reason: 'x' }], changes: ['a'] })).toBe('Nothing could be taken back: 2 values were changed since.');
  });

  it('shows the first layers by name and counts the rest', () => {
    const layers = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, name: `Layer ${i}` }));
    const { shown, more } = layerChips(layers);
    expect(shown.map((l) => l.name)).toEqual(['Layer 0', 'Layer 1', 'Layer 2', 'Layer 3', 'Layer 4', 'Layer 5']);
    expect(more).toBe(3);
    expect(layerChips(layers.slice(0, 2)).more).toBe(0);
  });
});

describe('the queue', () => {
  it('moves only waiting comments, in their order', () => {
    const row = (id: string, kind: 'running' | 'comment' | 'race') => ({ id, kind, fileId: 'f', fileName: 'F', runner: 'claude', title: '', at: 0 });
    expect(movable([row('r', 'running'), row('c1', 'comment'), row('l', 'race'), row('c2', 'comment')])).toEqual(['c1', 'c2']);
  });
});
