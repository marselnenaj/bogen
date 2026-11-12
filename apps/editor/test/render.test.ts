import { describe, expect, it } from 'vitest';
import { BogenDoc, nodeToHtml, renderSpec } from '@bogen/core';
import { resolveAsset } from '../src/lib/api.ts';

describe('asset urls in css values', () => {
  it('resolves bogen-asset inside style values when a resolver is given', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const id = doc.insert(doc.getPages()[0]!.id, { type: 'frame', style: { backgroundImage: 'url("bogen-asset:a.png"), linear-gradient(red, blue)' } });
    const n = doc.getNode(id)!;
    expect(renderSpec(n, resolveAsset).style.backgroundImage).toBe('url("/assets/a.png"), linear-gradient(red, blue)');
    expect(nodeToHtml(doc, id, { resolve: resolveAsset })).toContain('/assets/a.png');
  });

  it('leaves them alone without a resolver', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const id = doc.insert(doc.getPages()[0]!.id, { type: 'frame', style: { backgroundImage: 'url("bogen-asset:a.png")' } });
    expect(renderSpec(doc.getNode(id)!).style.backgroundImage).toBe('url("bogen-asset:a.png")');
  });
});
