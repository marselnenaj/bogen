import { describe, expect, it } from 'vitest';
import {
  BogenDoc, brandCounts, brandSuggestions, brandVersions, confirmSuggestions, dismissSuggestions, markBrandDoc, markBrandFields, publishBrandVersion, readBrand, setBrandField, upsertBrandItem, Y,
} from '../src/index.ts';

/** A brand with a published version, then what an extraction and an agent leave behind as suggestions. */
function setup() {
  const doc = new BogenDoc(new Y.Doc());
  markBrandDoc(doc);
  const ink = upsertBrandItem(doc, 'colors', { name: 'Ink', role: 'text', value: '#101010', token: 'ink' });
  const hero = upsertBrandItem(doc, 'typeScale', { name: 'Hero', size: 108, weight: 900, lineHeight: '0.9', token: 'text-hero' });
  upsertBrandItem(doc, 'spacing', { name: 'm', value: 16, token: 'space-m' });
  setBrandField(doc, 'tone', 'Plain.');
  publishBrandVersion(doc, { by: 'test' });
  // An agent corrects a confirmed size: an edit.
  upsertBrandItem(doc, 'typeScale', { id: hero, size: 96, suggested: true, note: 'Measured on the live site.' });
  // An extraction finds Ink again, a hair different, and a new colour.
  const ink2 = upsertBrandItem(doc, 'colors', { name: 'Ink', role: 'text', value: '#111111', token: 'ink', suggested: true, source: 'capture:https://example.com' });
  const red = upsertBrandItem(doc, 'colors', { name: 'Red', role: 'accent', value: '#e03010', token: 'red', suggested: true, source: 'capture:https://example.com' });
  setBrandField(doc, 'tone', 'Plain and short.');
  markBrandFields(doc, ['tone'], true);
  return { doc, ink, ink2, red, hero };
}

describe('reviewing suggestions', () => {
  it('replaces the actual logo artwork and shows it in the diff', () => {
    const doc = new BogenDoc(new Y.Doc());
    markBrandDoc(doc);
    const oldAsset = `bogen-asset:${'a'.repeat(64)}.png`;
    const newAsset = `bogen-asset:${'b'.repeat(64)}.png`;
    const original = upsertBrandItem(doc, 'logos', { name: 'Mark', asset: oldAsset, svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10" /></svg>' });
    upsertBrandItem(doc, 'logos', { name: 'Mark', asset: newAsset, suggested: true, source: 'file:new-logo' });
    const rows = brandSuggestions(readBrand(doc));
    expect(rows[0]).toMatchObject({ status: 'replaces', target: original });
    expect(rows[0]!.changes).toContainEqual({ field: 'asset', from: oldAsset, to: newAsset });
    expect(rows[0]!.changes.some((c) => c.field === 'svg' && c.from && !c.to)).toBe(true);
    confirmSuggestions(doc, rows);
    expect(readBrand(doc).logos).toEqual([expect.objectContaining({ id: original, asset: newAsset, source: 'file:new-logo' })]);
    expect(readBrand(doc).logos[0]!.svg).toBeUndefined();
  });

  it('keeps distinct examples that only have bad copy as new suggestions', () => {
    const doc = new BogenDoc(new Y.Doc());
    markBrandDoc(doc);
    upsertBrandItem(doc, 'voiceExamples', { bad: 'First phrase' });
    upsertBrandItem(doc, 'voiceExamples', { bad: 'Different phrase', suggested: true });
    expect(brandSuggestions(readBrand(doc))[0]!.status).toBe('new');
  });

  it('lists each suggestion beside what binds now, field by field, with its source', () => {
    const { doc, ink, ink2, red, hero } = setup();
    const rows = brandSuggestions(readBrand(doc), brandVersions(doc).at(-1)!.data);
    expect(rows.map((r) => [r.key, r.status])).toEqual([['field:tone', 'edit'], [ink2, 'replaces'], [red, 'new'], [hero, 'edit']]);
    expect(rows[0]!.changes).toEqual([{ field: 'tone', from: 'Plain.', to: 'Plain and short.' }]);
    const again = rows.find((r) => r.key === ink2)!;
    expect(again).toMatchObject({ target: ink, source: 'capture:https://example.com', changes: [{ field: 'value', from: '#101010', to: '#111111' }] });
    expect(rows.find((r) => r.key === red)!.changes.map((c) => [c.field, c.from, c.to])).toEqual([['value', null, '#e03010'], ['name', null, 'Red'], ['role', null, 'accent'], ['token', null, 'red']]);
    expect(rows.find((r) => r.key === hero)).toMatchObject({ note: 'Measured on the live site.', changes: [{ field: 'size', from: '108', to: '96' }] });
  });

  it('confirming binds a new value, keeps an edit, and writes a second take into the value it replaces', () => {
    const { doc, ink, ink2, red, hero } = setup();
    const rows = brandSuggestions(readBrand(doc), brandVersions(doc).at(-1)!.data);
    expect(confirmSuggestions(doc, rows)).toBe(4);
    const data = readBrand(doc);
    expect(brandCounts(data).suggestions).toBe(0);
    // No duplicate Ink: the confirmed one took the suggested value.
    expect(data.colors.map((c) => [c.id, c.value])).toEqual([[ink, '#111111'], [red, '#e03010']]);
    expect(data.colors.some((c) => c.id === ink2)).toBe(false);
    expect(data.typeScale.find((t) => t.id === hero)!.size).toBe(96);
    expect(data.fields.tone).toBe('Plain and short.');
  });

  it('dismissing removes what is new and puts the last version\'s value back for an edit', () => {
    const { doc, ink, red, hero } = setup();
    const previous = brandVersions(doc).at(-1)!.data;
    const rows = brandSuggestions(readBrand(doc), previous);
    expect(dismissSuggestions(doc, rows, previous)).toBe(4);
    const data = readBrand(doc);
    expect(brandCounts(data).suggestions).toBe(0);
    expect(data.colors.map((c) => [c.id, c.value])).toEqual([[ink, '#101010']]);
    expect(data.colors.some((c) => c.id === red)).toBe(false);
    const step = data.typeScale.find((t) => t.id === hero)!;
    expect(step.size).toBe(108);
    // What the suggestion added goes with it.
    expect(step.note).toBeUndefined();
    expect(step.suggested).toBeUndefined();
    expect(data.fields.tone).toBe('Plain.');
  });

  it('one action is one undo step', () => {
    const { doc } = setup();
    const undo = new Y.UndoManager([doc.y.getMap('brandFields'), doc.y.getMap('brandItems')], { trackedOrigins: new Set(['person']) });
    const rows = brandSuggestions(readBrand(doc), brandVersions(doc).at(-1)!.data);
    confirmSuggestions(doc, rows, 'person');
    expect(brandCounts(readBrand(doc)).suggestions).toBe(0);
    undo.undo();
    expect(brandCounts(readBrand(doc)).suggestions).toBe(4);
  });
});

describe('a field that is still a suggestion', () => {
  it('binds at the value of the latest version, or the default, until it is confirmed or dismissed', async () => {
    const { bindingBrand, bindingFields, brandCompact, brandTokens, BRAND_FIELD_DEFAULTS } = await import('../src/index.ts');
    const doc = new BogenDoc(new Y.Doc());
    markBrandDoc(doc);
    setBrandField(doc, 'name', 'Acme');
    setBrandField(doc, 'minContrast', 7);
    // No version yet: a suggestion falls back to the default, and the name is not a rule.
    setBrandField(doc, 'gradients', 'none');
    setBrandField(doc, 'name', 'Acme Tools');
    markBrandFields(doc, ['gradients', 'name'], true);
    expect(readBrand(doc).fields.gradients).toBe('none');
    expect(bindingFields(readBrand(doc))).toMatchObject({ gradients: BRAND_FIELD_DEFAULTS.gradients, name: 'Acme Tools', minContrast: 7 });

    // A version records what binds, so publishing never confirms a suggestion by the back door.
    const version = publishBrandVersion(doc, { by: 'test' });
    expect(version.data.fields.gradients).toBe('any');
    expect(version.data.suggestedFields).toEqual([]);
    expect(brandVersions(doc).at(-1)!.data.fields).toMatchObject({ gradients: 'any', minContrast: 7 });

    setBrandField(doc, 'minContrast', 3);
    setBrandField(doc, 'container', 1200);
    markBrandFields(doc, ['minContrast', 'container'], true);
    const data = readBrand(doc);
    expect(data.priorFields).toMatchObject({ minContrast: 7, gradients: 'any', container: 0 });
    expect(bindingFields(data)).toMatchObject({ minContrast: 7, gradients: 'any', container: 0 });
    expect(bindingBrand(bindingBrand(data)).fields).toEqual(bindingFields(data));
    expect(brandCompact(data)).toMatchObject({ gradients: 'allowed', pairs: { min_contrast: 7 } });
    expect(brandTokens(data).some((t) => t.name === 'container')).toBe(false);
    // With nothing suggested it is the same object: nothing to pay for.
    const plain = readBrand(Object.assign(new BogenDoc(new Y.Doc())));
    expect(bindingBrand(plain)).toBe(plain);

    // Dismissing puts back exactly what was binding, and confirming makes the new value bind.
    const rows = brandSuggestions(data, brandVersions(doc).at(-1)!.data);
    dismissSuggestions(doc, rows.filter((r) => r.key === 'field:minContrast'), brandVersions(doc).at(-1)!.data);
    expect(readBrand(doc).fields.minContrast).toBe(7);
    confirmSuggestions(doc, rows.filter((r) => r.key === 'field:container'));
    expect(bindingFields(readBrand(doc)).container).toBe(1200);
    expect(brandTokens(readBrand(doc)).find((t) => t.name === 'container')?.value).toBe('1200px');
  });
});
