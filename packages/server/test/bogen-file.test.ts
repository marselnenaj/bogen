import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BogenDoc, brandLinkOf, isBrandDoc, markBrandDoc, setBrandField, setBrandLink, Y } from '@bogen/core';
import { packBogenFile, unpackBogenFile } from '../src/bogen-file.ts';

const LOGO = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="5"/></svg>');
const PHOTO = Buffer.from('not really a png, but bytes all the same');
const nameOf = (bytes: Buffer, ext: string) => `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
const LOGO_NAME = nameOf(LOGO, 'svg');
const PHOTO_NAME = nameOf(PHOTO, 'png');
const store = new Map([[LOGO_NAME, LOGO], [PHOTO_NAME, PHOTO]]);
const readAsset = async (name: string) => (store.has(name) ? { bytes: store.get(name)! } : null);

function brandState(): Uint8Array {
  const doc = new BogenDoc(new Y.Doc());
  markBrandDoc(doc);
  doc.createPage('Examples');
  setBrandField(doc, 'name', 'Acme');
  doc.y.getMap('brandItems').set('logo1', new Y.Map(Object.entries({ section: 'logos', name: 'Mark', asset: `bogen-asset:${LOGO_NAME}` })));
  return Y.encodeStateAsUpdate(doc.y);
}

function fileState(brandId: string | null): Uint8Array {
  const doc = new BogenDoc(new Y.Doc());
  const page = doc.createPage('Page 1');
  doc.insert(page, { type: 'image', name: 'Photo', src: `bogen-asset:${PHOTO_NAME}`, style: { width: '10px', height: '10px' } } as never);
  if (brandId) setBrandLink(doc, { id: brandId, version: 'v1', at: 1 });
  return Y.encodeStateAsUpdate(doc.y);
}

function read(state: Uint8Array): BogenDoc {
  const doc = new BogenDoc(new Y.Doc());
  Y.applyUpdate(doc.y, state);
  return doc;
}

/** Format 1 as Bogen wrote it before brands travelled: magic, state, then name and bytes of each asset. */
function oldFormat(state: Uint8Array, assets: [string, Buffer][]): Buffer {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return Buffer.concat([Buffer.from('BOGEN\x01\n', 'latin1'), u32(state.length), Buffer.from(state), ...assets.flatMap(([n, b]) => [u32(n.length), Buffer.from(n, 'latin1'), u32(b.length), b])]);
}

describe('.bogen files', () => {
  it('a file with no brand is format 1, byte for byte as before', async () => {
    const state = fileState(null);
    const packed = await packBogenFile(state, readAsset);
    expect(packed.subarray(0, 7).toString('latin1')).toBe('BOGEN\x01\n');
    expect(packed.equals(oldFormat(state, [[PHOTO_NAME, PHOTO]]))).toBe(true);
    const out = unpackBogenFile(packed);
    expect(out.format).toBe(1);
    expect(out.brand).toBeNull();
    expect(out.assets.map((a) => a.name)).toEqual([PHOTO_NAME]);
  });

  it('carries the linked brand and its assets in format 2, and gives both back', async () => {
    const brand = brandState();
    const packed = await packBogenFile(fileState('acme1234'), readAsset, { brand: { id: 'acme1234', name: 'Acme', state: brand } });
    expect(packed.subarray(0, 7).toString('latin1')).toBe('BOGEN\x02\n');
    const out = unpackBogenFile(packed);
    expect(out.format).toBe(2);
    expect(out.brand?.id).toBe('acme1234');
    expect(out.brand?.name).toBe('Acme');
    expect(isBrandDoc(read(out.brand!.state))).toBe(true);
    expect(brandLinkOf(read(out.state))?.id).toBe('acme1234');
    expect(out.assets.map((a) => a.name).sort()).toEqual([LOGO_NAME, PHOTO_NAME].sort());
  });

  it('an asset both use travels once', async () => {
    const doc = read(fileState('acme1234'));
    doc.insert(doc.getPages()[0]!.id, { type: 'image', name: 'Logo', src: `bogen-asset:${LOGO_NAME}`, style: {} } as never);
    const out = unpackBogenFile(await packBogenFile(Y.encodeStateAsUpdate(doc.y), readAsset, { brand: { id: 'acme1234', name: 'Acme', state: brandState() } }));
    expect(out.assets.filter((a) => a.name === LOGO_NAME)).toHaveLength(1);
  });

  it('a brand on its own has an empty design', async () => {
    const out = unpackBogenFile(await packBogenFile(new Uint8Array(), readAsset, { brand: { id: 'acme1234', name: 'Acme', state: brandState() } }));
    expect(out.state.length).toBe(0);
    expect(out.brand?.id).toBe('acme1234');
    expect(out.assets.map((a) => a.name)).toEqual([LOGO_NAME]);
  });

  it('reads files written before brands travelled, a brand among them', () => {
    const design = unpackBogenFile(oldFormat(fileState('acme1234'), [[PHOTO_NAME, PHOTO]]));
    expect(design.format).toBe(1);
    expect(design.brand).toBeNull();
    expect(brandLinkOf(read(design.state))?.id).toBe('acme1234');
    const brand = unpackBogenFile(oldFormat(brandState(), [[LOGO_NAME, LOGO]]));
    expect(isBrandDoc(read(brand.state))).toBe(true);
  });

  it('refuses a newer format with a request to update, and damaged brands', async () => {
    const packed = await packBogenFile(fileState('acme1234'), readAsset, { brand: { id: 'acme1234', name: 'Acme', state: brandState() } });
    const newer = Buffer.from(packed);
    newer[5] = 3;
    expect(() => unpackBogenFile(newer)).toThrow(/newer version of Bogen/);
    expect(() => unpackBogenFile(Buffer.from('{"not":"bogen"}'))).toThrow(/not a Bogen file/);
    // A design document where the brand should be.
    await expect(packBogenFile(fileState('acme1234'), readAsset, { brand: { id: 'acme1234', name: 'Acme', state: fileState(null) } }).then(unpackBogenFile)).rejects.toThrow(/damaged brand/);
    // A brand the file does not link to.
    await expect(packBogenFile(fileState('other123'), readAsset, { brand: { id: 'acme1234', name: 'Acme', state: brandState() } }).then(unpackBogenFile)).rejects.toThrow(/damaged/);
    expect(() => unpackBogenFile(packed.subarray(0, packed.length - 3))).toThrow(/truncated|damaged/);
  });
});
