import { describe, expect, it } from 'vitest';
import { BogenDoc, Y, markBrandDoc, readBrand, upsertBrandItem } from '@bogen/core';
import { brandTokenNames } from '../src/brand-check.ts';

describe('brand_check system score with a brand of suggestions', () => {
  it('counts tokens named and valued like the suggestions as the brand\'s', () => {
    const brand = new BogenDoc(new Y.Doc());
    markBrandDoc(brand);
    upsertBrandItem(brand, 'colors', { name: 'Kraft', role: 'ground', value: '#e7d6b8', token: 'kraft', suggested: true });
    upsertBrandItem(brand, 'colors', { name: 'Pea', role: 'accent', value: '#7fa53a', token: 'pea', suggested: true });
    // The file wrote the tokens itself with tokens_set, as the gap test had to, one under another name.
    const names = brandTokenNames(readBrand(brand), new Map([['kraft', '#e7d6b8'], ['leaf', '#7FA53A'], ['other', '#123456']]));
    expect(names.has('kraft')).toBe(true);
    expect(names.has('leaf')).toBe(true);
    expect(names.has('other')).toBe(false);
  });
});
