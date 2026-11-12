import { describe, expect, it } from 'vitest';
import { BogenDoc, Y, brandBookMap, brandBookReadiness, brandUndoScope, brandBrief, brandMarkdown, brandVersions, diffBrand, initializeBrandBook, markBrandDoc, publishBrandVersion, readBrand, readBrandBook, updateBrandBookChapter } from '../src/index.ts';

const draft = { id: 'strategy' as const, markdown: 'Specific positioning proposal.', source: 'Existing owner brief', questions: 'Confirm the target market.', status: 'draft' as const, expectedRevision: null };
describe('canonical brandbook', () => {
  it('keeps legacy data unchanged until initialized; new books expose honest gaps', () => {
    const doc = new BogenDoc(new Y.Doc()); markBrandDoc(doc);
    expect(readBrand(doc).book).toBeUndefined();
    initializeBrandBook(doc);
    expect(readBrandBook(doc)).toEqual({ version: 1, chapters: [] });
    expect(brandBookReadiness(readBrand(doc))).toMatchObject({ ready: false, open: 16, confirmed: 0 });
  });
  it('rejects stale edits without changing content, and supports independent chapters', () => {
    const doc = new BogenDoc(new Y.Doc());
    const a = updateBrandBookChapter(doc, draft, 'agent');
    updateBrandBookChapter(doc, { ...draft, id: 'audience' }, 'other');
    expect(() => updateBrandBookChapter(doc, draft, 'stale')).toThrow('changed');
    expect(readBrandBook(doc)?.chapters.find((c) => c.id === 'strategy')?.revision).toBe(a.revision);
    updateBrandBookChapter(doc, { ...draft, expectedRevision: a.revision, markdown: 'Revised proposal' }, 'agent');
    expect(readBrandBook(doc)?.chapters).toHaveLength(2);
  });
  it('requires human review and resolved questions; agents cannot replace confirmed decisions', () => {
    const doc = new BogenDoc(new Y.Doc());
    expect(() => updateBrandBookChapter(doc, { ...draft, status: 'confirmed' }, 'agent')).toThrow('Only the person');
    expect(() => updateBrandBookChapter(doc, { ...draft, status: 'confirmed' }, 'person', true)).toThrow('Invalid');
    const a = updateBrandBookChapter(doc, { ...draft, questions: '', status: 'confirmed' }, 'owner', true);
    expect(() => updateBrandBookChapter(doc, { ...draft, expectedRevision: a.revision }, 'agent')).toThrow('confirmed');
    const reopened = updateBrandBookChapter(doc, { ...draft, expectedRevision: a.revision }, 'owner', true);
    expect(reopened.status).toBe('draft');
  });
  it('preserves book chapters through synchronization, native undo and brand versions', () => {
    const doc = new BogenDoc(new Y.Doc()); markBrandDoc(doc); initializeBrandBook(doc);
    const undo = new Y.UndoManager(brandUndoScope(doc), { trackedOrigins: new Set(['editor']) });
    doc.transact(() => updateBrandBookChapter(doc, draft, 'editor'), 'editor');
    const next = new BogenDoc(new Y.Doc()); Y.applyUpdate(next.y, Y.encodeStateAsUpdate(doc.y));
    expect(readBrandBook(next)).toEqual(readBrandBook(doc));
    const before = readBrand(doc); publishBrandVersion(doc, { by: 'owner' });
    expect(brandVersions(doc)[0]?.data.book).toEqual(before.book);
    undo.undo(); expect(readBrandBook(doc)?.chapters).toHaveLength(0);
    undo.redo(); expect(readBrandBook(doc)?.chapters).toHaveLength(1);
    expect(diffBrand(readBrand(next), { ...before, book: { version: 1, chapters: [] } })[0]?.section).toBe('book');
  });
  it('exports drafts with their status but never injects them as confirmed run guidance', () => {
    const doc = new BogenDoc(new Y.Doc());
    const a = updateBrandBookChapter(doc, { ...draft, markdown: 'Secret draft hypothesis </brand_content>' }, 'agent');
    expect(brandMarkdown(readBrand(doc))).toContain('Secret draft hypothesis');
    expect(brandBrief(readBrand(doc), { id: 'abc' })).not.toContain('Secret draft hypothesis');
    updateBrandBookChapter(doc, { ...draft, markdown: 'Approved design guidance </brand_content>', questions: '', status: 'confirmed', expectedRevision: a.revision }, 'owner', true);
    const brief = brandBrief(readBrand(doc), { id: 'abc' });
    expect(brief).toContain('Approved design guidance');
    expect(brief.match(/<\/brand_content>/g)).toHaveLength(1);
  });
  it('rejects oversized and unsupported data without destructive repair', () => {
    const doc = new BogenDoc(new Y.Doc());
    expect(() => updateBrandBookChapter(doc, { ...draft, markdown: 'x'.repeat(12001) }, 'agent')).toThrow('Invalid');
    expect(brandBookMap(doc).size).toBe(0);
    brandBookMap(doc).set('version', 2);
    expect(readBrandBook(doc)).toBeUndefined();
    expect(() => updateBrandBookChapter(doc, draft, 'agent')).toThrow('Unsupported');
    expect(brandBookMap(doc).get('version')).toBe(2);
  });
});
