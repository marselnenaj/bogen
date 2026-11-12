import { describe, expect, it } from 'vitest';
import { BogenDoc, Y, brandOriginOf, brandVersions, makeBrandCopy, markBrandDoc, markBrandFields, publishBrandVersion, readBrand, setBrandField, upsertBrandItem } from '../src/index.ts';

function brandDoc(): BogenDoc {
  const doc = new BogenDoc(new Y.Doc());
  markBrandDoc(doc);
  return doc;
}

describe('a duplicated brand', () => {
  it('starts with no versions of its own, says where it came from, and keeps what binds', () => {
    const doc = brandDoc();
    setBrandField(doc, 'name', 'Acme');
    setBrandField(doc, 'minContrast', 7);
    setBrandField(doc, 'defaultAt', 5);
    publishBrandVersion(doc, { by: 'owner' });
    publishBrandVersion(doc, { by: 'owner', note: 'Second' });
    // An agent proposes a lower contrast: it does not bind, the published 7 does.
    setBrandField(doc, 'minContrast', 3);
    markBrandFields(doc, ['minContrast'], true);
    upsertBrandItem(doc, 'colors', { name: 'Ink', value: '#111111', suggested: true });
    const copy = new BogenDoc(new Y.Doc());
    Y.applyUpdate(copy.y, Y.encodeStateAsUpdate(doc.y));
    makeBrandCopy(copy, { id: 'acme0001', name: 'Acme', version: 2, at: 1 }, 'Acme copy');
    const data = readBrand(copy);
    expect(brandVersions(copy)).toEqual([]);
    expect(brandOriginOf(copy)).toEqual({ id: 'acme0001', name: 'Acme', version: 2, at: 1 });
    expect(data.fields).toMatchObject({ name: 'Acme copy', minContrast: 7, defaultAt: 0 });
    expect(data.suggestedFields).toEqual([]);
    expect(data.colors[0]!.suggested).toBe(true);
    // The original is as it was.
    expect(brandVersions(doc)).toHaveLength(2);
    expect(readBrand(doc).fields.minContrast).toBe(3);
    expect(brandOriginOf(doc)).toBeNull();
  });
});
