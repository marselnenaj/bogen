import { describe, expect, it } from 'vitest';
import {
  BogenDoc, Y, brandEditionFileOf, brandEditionParts, changedEditionParts, EDITION_PARTS, markBrandDoc, readBrand, readBrandEdition,
  setBrandEditionFile, setBrandField, upsertBrandItem, writeBrandEdition,
} from '../src/index.ts';

function brandDoc(): BogenDoc {
  const doc = new BogenDoc(new Y.Doc());
  markBrandDoc(doc);
  setBrandField(doc, 'name', 'Kiln');
  upsertBrandItem(doc, 'colors', { id: 'c1', name: 'Clay', value: '#b5562f', role: 'accent' });
  upsertBrandItem(doc, 'words', { id: 'w1', word: 'artisanal', use: 'avoid', severity: 'soft' });
  return doc;
}

describe('a designed edition of a brand book', () => {
  it('fingerprints each part of the brand and names only the parts that changed since', () => {
    const doc = brandDoc();
    const then = brandEditionParts(readBrand(doc));
    expect(Object.keys(then)).toEqual([...EDITION_PARTS]);
    expect(changedEditionParts({ parts: then }, readBrand(doc))).toEqual([]);
    upsertBrandItem(doc, 'colors', { id: 'c1', name: 'Clay', value: '#a14b28', role: 'accent' });
    upsertBrandItem(doc, 'rules', { text: 'Never set the mark on a photo.', kind: 'dont', severity: 'hard', topic: 'logo' });
    expect(changedEditionParts({ parts: then }, readBrand(doc))).toEqual(['logo', 'colour']);
  });

  it('ignores what changes by itself, such as how often an item was used', () => {
    const doc = brandDoc();
    const then = brandEditionParts(readBrand(doc));
    const data = readBrand(doc);
    const used = { ...data, colors: data.colors.map((c) => ({ ...c, usage: 12, source: 'capture' })) };
    expect(changedEditionParts({ parts: then }, used)).toEqual([]);
  });

  it('keeps its record on the file and the newest edition on the brand, and refuses a record that does not hold together', () => {
    const brand = brandDoc();
    const file = new BogenDoc(new Y.Doc());
    file.ensureFirstPage('Brand book');
    const pageId = file.getPages()[0]!.id;
    const parts = brandEditionParts(readBrand(brand));
    writeBrandEdition(file, { brandId: 'kiln00001', brandName: 'Kiln', at: 5, parts, pageId, runId: 'r1', pending: { runId: 'r2', parts, at: 6 } });
    expect(readBrandEdition(file)).toEqual({ brandId: 'kiln00001', brandName: 'Kiln', at: 5, parts, pageId, runId: 'r1', pending: { runId: 'r2', parts, at: 6 } });
    file.meta.set('brandEdition', { brandId: 'kiln00001', parts: { colour: 'nothex' }, pageId });
    expect(readBrandEdition(file)).toBeNull();
    expect(brandEditionFileOf(brand)).toBeNull();
    setBrandEditionFile(brand, 'file00001');
    expect(brandEditionFileOf(brand)).toBe('file00001');
  });
});
