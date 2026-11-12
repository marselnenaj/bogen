import { describe, expect, it } from 'vitest';
import { BogenDoc, BUILTIN_CHECKS, deleteCheck, docFromContent, docToContent, getChecks, parseCheck, resolveCheck, setCheck, Y } from '../src/index.ts';

const button = { id: 'button-height', kind: 'geometry' as const, selector: 'button', property: 'height', operator: 'min' as const, value: 44 };
describe('saved design checks', () => {
  it('extends checks, overrides rules by id and rejects cycles and missing bases atomically', () => {
    const doc = new BogenDoc();
    setCheck(doc, { id: 'base', name: 'Base', extends: 'builtin:mobile', rules: [button] });
    setCheck(doc, { id: 'child', name: 'Child', extends: 'base', widths: [320], rules: [{ ...button, value: 48 }] });
    expect(resolveCheck(doc, 'child')).toMatchObject({ widths: [320], viewport_heights: [664, 760, 600], rules: [{ ...button, value: 48 }] });
    setCheck(doc, { id: 'child', name: 'Child', extends: 'base', rules: [{ ...button, enabled: false }] });
    expect(resolveCheck(doc, 'child').rules).toEqual([{ ...button, enabled: false }]);
    const before = getChecks(doc);
    expect(() => setCheck(doc, { id: 'base', name: 'Cycle', extends: 'child' })).toThrow('cycle');
    expect(() => setCheck(doc, { id: 'broken', name: 'Missing', extends: 'missing' })).toThrow('No check');
    expect(getChecks(doc)).toEqual(before);
    expect(() => deleteCheck(doc, 'base')).toThrow('Child extends');
    expect(() => setCheck(doc, { ...BUILTIN_CHECKS[0], name: 'Changed' })).toThrow('ids');
  });
  it('supports undo, concurrent checks, sync and content export without losing definitions', () => {
    const a = new BogenDoc(); a.ensureFirstPage();
    const b = new BogenDoc(); Y.applyUpdate(b.y, Y.encodeStateAsUpdate(a.y));
    const undo = new Y.UndoManager([a.meta], { trackedOrigins: new Set(['me']), captureTimeout: 0 });
    setCheck(a, { id: 'mine', name: 'Mine', rules: [button] }, 'me');
    setCheck(b, { id: 'other', name: 'Other', extends: 'builtin:lint' }, 'other');
    Y.applyUpdate(a.y, Y.encodeStateAsUpdate(b.y)); Y.applyUpdate(b.y, Y.encodeStateAsUpdate(a.y));
    expect(getChecks(a)).toHaveLength(2); expect(getChecks(b)).toEqual(getChecks(a));
    undo.undo(); expect(getChecks(a).map((c) => c.id)).toEqual(['other']);
    undo.redo(); expect(getChecks(a)).toHaveLength(2);
    const copy = docFromContent(JSON.parse(JSON.stringify(docToContent(a))));
    expect(getChecks(copy)).toEqual(getChecks(a));
    deleteCheck(a, 'mine', 'me'); expect(getChecks(a)).toHaveLength(1);
    undo.undo(); expect(getChecks(a)).toHaveLength(2);
  });
  it('validates portable definitions and allows meaningful empty attribute values', () => {
    expect(parseCheck({ id: 'alt', name: 'Decorative alt', rules: [{ id: 'alt', kind: 'attribute', selector: 'img', property: 'alt', operator: 'equals', value: '' }] }).rules![0]!.value).toBe('');
    for (const value of [
      { id: 'bad', name: 'Code', script: 'process.exit()' },
      { id: 'bad', name: 'Bad', viewport_heights: [600, 600] },
      { id: 'bad', name: 'Bad', tolerance: -1 },
      { id: 'bad', name: 'Bad', rules: [{ ...button, value: '44px' }] },
      { id: 'bad', name: 'Bad', rules: [button, button] },
    ]) expect(() => parseCheck(value)).toThrow();
  });
});
