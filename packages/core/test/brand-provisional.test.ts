import { describe, expect, it } from 'vitest';
import { BogenDoc, Y, applyBrandTokens, brandTokens, confirmBrandItems, emptyBrand, markBrandDoc, provisionalBrandTokens, readBrand, upsertBrandItem } from '../src/index.ts';

/** The Loam seed library brand from the brand asset test: every value an agent's suggestion, nothing confirmed. */
function loam() {
  const doc = new BogenDoc(new Y.Doc());
  markBrandDoc(doc);
  for (const [name, role, value, token] of [['Kraft', 'ground', '#e7d6b8', 'kraft'], ['Loam', 'ink', '#3b2a1e', 'loam'], ['Pea', 'accent', '#7fa53a', 'pea'], ['Stamp blue', 'action', '#2f4fa3', 'stamp']]) {
    upsertBrandItem(doc, 'colors', { name, role, value, token, suggested: true });
  }
  upsertBrandItem(doc, 'families', { family: 'Young Serif', role: 'display', fallback: 'serif', weights: [400], license: 'OFL', assets: [], token: 'font-display', suggested: true });
  upsertBrandItem(doc, 'spacing', { name: 'M', value: 24, token: 'space-m', suggested: true });
  return doc;
}

describe('provisional brand tokens', () => {
  it('gives a file linked to an all-suggestions brand its tokens, marked provisional', () => {
    const brand = loam();
    const data = readBrand(brand);
    expect(brandTokens(data)).toEqual([]);
    expect(provisionalBrandTokens(data).map((t) => t.name)).toEqual(['font-display', 'kraft', 'loam', 'pea', 'space-m', 'stamp']);
    const file = new BogenDoc(new Y.Doc());
    const out = applyBrandTokens(file, data);
    expect(out.provisional.sort()).toEqual(['font-display', 'kraft', 'loam', 'pea', 'space-m', 'stamp']);
    expect(file.getTokens().find((t) => t.name === 'kraft')?.value).toBe('#e7d6b8');
  });

  it('never overwrites a token the file had before, and drops provisional ones when the suggestion goes', () => {
    const brand = loam();
    const file = new BogenDoc(new Y.Doc());
    file.setToken('pea', 'color', '#00ff00');
    applyBrandTokens(file, readBrand(brand));
    expect(file.getTokens().find((t) => t.name === 'pea')?.value).toBe('#00ff00');
    const stamp = readBrand(brand).colors.find((c) => c.token === 'stamp')!;
    const data = readBrand(brand);
    data.colors = data.colors.filter((c) => c.id !== stamp.id);
    const again = applyBrandTokens(file, data);
    expect(again.removed).toContain('stamp');
    expect(file.getTokens().some((t) => t.name === 'pea')).toBe(true);
  });

  it('keeps the token when the suggestion is confirmed', () => {
    const brand = loam();
    const file = new BogenDoc(new Y.Doc());
    applyBrandTokens(file, readBrand(brand));
    confirmBrandItems(brand, null);
    const out = applyBrandTokens(file, readBrand(brand));
    expect(out.provisional).toEqual([]);
    expect(out.removed).toEqual([]);
    expect(file.getTokens().find((t) => t.name === 'kraft')?.value).toBe('#e7d6b8');
  });

  it('an empty brand gives nothing', () => {
    expect(provisionalBrandTokens(emptyBrand())).toEqual([]);
  });
});
