import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BogenDoc, fontLinks } from '../src/index.ts';

/** Two replicas, so that changes also arrive the way another device sends them. */
function pair() {
  const a = new BogenDoc();
  a.ensureFirstPage();
  const page = a.getPages()[0]!.id;
  const board = a.insert(page, { type: 'frame', name: 'Board', artboard: true, style: { width: '400px' } });
  const kids = a.insertMany(board, [
    { type: 'text', name: 'One', text: 'First' },
    { type: 'frame', name: 'Two', style: { padding: '8px' } },
    { type: 'text', name: 'Three', text: 'Third' },
  ]);
  const b = new BogenDoc();
  Y.applyUpdate(b.y, Y.encodeStateAsUpdate(a.y));
  a.y.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'b') Y.applyUpdate(b.y, u, 'a'); });
  b.y.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'a') Y.applyUpdate(a.y, u, 'b'); });
  return { a, b, page, board, kids };
}

const names = (doc: BogenDoc, parent: string) => doc.getChildren(parent).map((n) => n.name);

describe('what a document remembers between reads', () => {
  it('keeps layers an edit did not touch, and reads the touched one again', () => {
    const { a, b, board, kids } = pair();
    const untouched = b.rawNode(kids[2]!);
    expect(names(b, board)).toEqual(['One', 'Two', 'Three']);
    a.updateFields(kids[0]!, { name: 'Renamed' });
    expect(b.rawNode(kids[2]!)).toBe(untouched);
    expect(b.getNode(kids[0]!)?.name).toBe('Renamed');
    expect(names(b, board)).toEqual(['Renamed', 'Two', 'Three']);
  });

  it('sees nested changes: a style value and the words of a text layer', () => {
    const { a, b, board, kids } = pair();
    expect(b.getChildren(board)[1]?.style.padding).toBe('8px');
    a.updateStyle(kids[1]!, { padding: '16px' });
    expect(b.getChildren(board)[1]?.style.padding).toBe('16px');
    expect(b.rawNode(kids[1]!)?.style.padding).toBe('16px');
    expect(b.getChildren(board)[0]?.text).toBe('First');
    a.editText(kids[0]!, 'First', 'First words');
    expect(b.getChildren(board)[0]?.text).toBe('First words');
  });

  it('sees layers move, arrive and go', () => {
    const { a, b, page, board, kids } = pair();
    expect(names(b, board)).toEqual(['One', 'Two', 'Three']);
    a.move([kids[2]!], board, 0);
    expect(names(b, board)).toEqual(['Three', 'One', 'Two']);
    a.move([kids[0]!], kids[1]!);
    expect(names(b, board)).toEqual(['Three', 'Two']);
    expect(names(b, kids[1]!)).toEqual(['One']);
    a.insert(board, { type: 'text', name: 'Four', text: 'x' });
    expect(names(b, board)).toEqual(['Three', 'Two', 'Four']);
    a.delete([kids[2]!]);
    expect(names(b, board)).toEqual(['Two', 'Four']);
    expect(b.getNode(kids[2]!)).toBeUndefined();
    expect(b.rawKids(page)).toEqual([board]);
  });

  it('sees a change to pages and tokens too', () => {
    const { a, b, board } = pair();
    names(b, board);
    a.setToken('brand', 'color', '#ff0000');
    a.createPage('Second');
    expect(b.getPages().map((p) => p.name)).toContain('Second');
    expect(names(b, board)).toEqual(['One', 'Two', 'Three']);
  });

  it('reads correctly inside its own transaction after a write', () => {
    const { a, board, kids } = pair();
    names(a, board);
    a.transact(() => {
      a.updateFields(kids[0]!, { name: 'Inside' });
      a.invalidate();
      expect(a.getChildren(board)[0]?.name).toBe('Inside');
    });
    expect(a.getChildren(board)[0]?.name).toBe('Inside');
  });

  it('keeps a value computed from the whole file until the file changes', () => {
    const { a, b, board, kids } = pair();
    let runs = 0;
    const count = () => b.memo('count', () => { runs++; return b.nodes.size; });
    expect(count()).toBe(4);
    expect(count()).toBe(4);
    expect(runs).toBe(1);
    a.updateFields(kids[0]!, { name: 'Changed' });
    expect(count()).toBe(4);
    expect(runs).toBe(2);
    expect(fontLinks(b)).toEqual([]);
    a.updateStyle(board, { fontFamily: '"Archivo", sans-serif' });
    expect(fontLinks(b)).toEqual(['Archivo']);
  });
});
