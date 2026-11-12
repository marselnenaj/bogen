import { describe, expect, it } from 'vitest';
import { BogenDoc, Y } from '@bogen/core';
import { assetNames } from '../src/doc/offline.ts';

describe('offline copies', () => {
  it('finds every asset a document names, wherever it is', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const page = doc.getPages()[0]!.id;
    const a = `${'a'.repeat(64)}.png`;
    const b = `${'b'.repeat(64)}.woff2`;
    doc.insert(page, { type: 'image', src: `bogen-asset:${a}`, style: { position: 'absolute', backgroundImage: `url("/assets/${b}")` } });
    expect(assetNames(Y.encodeStateAsUpdate(doc.y)).sort()).toEqual([a, b]);
    expect(assetNames(Y.encodeStateAsUpdate(new Y.Doc()))).toEqual([]);
  });
});
