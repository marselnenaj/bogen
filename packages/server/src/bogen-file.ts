import { createHash } from 'node:crypto';
import { assertBrandShape, brandAssets, brandLinkOf, branchAssetNames, BogenDoc, fontFaceAssets, isBrandDoc, Y } from '@bogen/core';

/**
 * A `.bogen` file: binary, so that desktop MIME sniffing can tell it from JSON.
 *
 * Format 1, `BOGEN\x01\n`: the Y.Doc state, then every asset the design uses, each checked against the content hash
 * in its name. A file with no brand to carry is still written this way, byte for byte, so older Bogen opens it.
 *
 * Format 2, `BOGEN\x02\n`: a JSON manifest, the file's state (empty for a brand on its own), the state of the brand it
 * links to, then the assets of both, once each. The brand is not an optional section of format 1 because format 1
 * readers take everything after the state as assets, so anything added there reads as a damaged image. A version
 * byte they do not know is at least refused at the start. Versions above 2 are refused here with a request to update.
 */
const MAGIC_HEAD = Buffer.from('BOGEN', 'latin1');
const MAGIC_V1 = Buffer.from('BOGEN\x01\n', 'latin1');
const MAGIC_V2 = Buffer.from('BOGEN\x02\n', 'latin1');
const MAGIC_LENGTH = MAGIC_V1.length;
const ASSET_NAME = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;
const BRAND_ID = /^[0-9a-z]{4,40}$/;
const MAX_MANIFEST = 64 * 1024;

/** A brand inside a `.bogen` file: its id on the device it came from, its name, and its whole document. */
export interface CarriedBrand { id: string; name: string; state: Uint8Array }

export interface BogenFileContents {
  format: 1 | 2;
  /** The design's state. Empty when the file is a brand on its own. */
  state: Uint8Array;
  brand: CarriedBrand | null;
  assets: { name: string; bytes: Uint8Array }[];
}

function usedAssets(doc: BogenDoc): string[] {
  const names = new Set<string>();
  const scan = (value: string | undefined) => {
    for (const m of value?.matchAll(/bogen-asset:([^"')\s]+)/g) ?? []) names.add(m[1]!);
  };
  doc.nodes.forEach((_, id) => {
    const n = doc.getNode(id);
    if (!n) return;
    scan(n.src);
    scan(n.svg);
    for (const v of Object.values(n.style)) scan(v);
    for (const v of Object.values(n.attrs ?? {})) scan(v);
    for (const v of Object.values(n.overrides ?? {})) if (typeof v === 'string') scan(v);
  });
  for (const name of fontFaceAssets(doc)) names.add(name);
  for (const name of brandAssets(doc)) names.add(name);
  // Branches that are not checked out hold their own pictures; the file carries them as well (design-branches.ts).
  for (const name of branchAssetNames(doc)) names.add(name);
  // Pictures and voice notes attached to comments are part of the conversation the file carries.
  scan(JSON.stringify(doc.comments.toJSON()));
  return [...names].filter((n) => ASSET_NAME.test(n));
}

function assetsOf(state: Uint8Array): string[] {
  const doc = new BogenDoc(new Y.Doc());
  try {
    if (state.length) Y.applyUpdate(doc.y, state);
    return usedAssets(doc);
  } finally {
    doc.y.destroy();
  }
}

function withLength(bytes: Buffer): Buffer[] {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return [length, bytes];
}

/**
 * Packs a design, and with `brand` the brand it links to as well, in format 2. An empty `state` with a brand is the
 * brand on its own. Without a brand the result is format 1, as it always was.
 */
export async function packBogenFile(state: Uint8Array, readAsset: (name: string) => Promise<{ bytes: Uint8Array } | null>, options: { brand?: CarriedBrand | null } = {}): Promise<Buffer> {
  const brand = options.brand ?? null;
  const names = new Set(assetsOf(state));
  if (brand) for (const name of assetsOf(brand.state)) names.add(name);
  const parts: Buffer[] = brand
    ? [MAGIC_V2, ...withLength(Buffer.from(JSON.stringify({ brand: { id: brand.id, name: brand.name } }), 'utf8')), ...withLength(Buffer.from(state)), ...withLength(Buffer.from(brand.state))]
    : [MAGIC_V1, ...withLength(Buffer.from(state))];
  for (const name of names) {
    const asset = await readAsset(name);
    if (!asset) continue;
    parts.push(...withLength(Buffer.from(name, 'latin1')), ...withLength(Buffer.from(asset.bytes)));
  }
  return Buffer.concat(parts);
}

/** Rejects anything whose shape would break readers later. The content itself is sanitized at render. */
export function assertWellFormed(doc: BogenDoc, { requirePage = true }: { requirePage?: boolean } = {}): void {
  const maps = [doc.nodes, doc.pages, doc.tokens, doc.comments, doc.modes, doc.textStyles, doc.variables];
  for (const map of maps) map.forEach((v) => {
    if (!(v instanceof Y.Map)) throw new Error('This file is damaged.');
  });
  doc.nodes.forEach((m) => {
    if (!(m.get('style') instanceof Y.Map) || typeof m.get('parent') !== 'string' || typeof m.get('type') !== 'string' || typeof m.get('order') !== 'string') throw new Error('This file is damaged.');
  });
  doc.comments.forEach((m) => {
    if (!(m.get('messages') instanceof Y.Array)) throw new Error('This file is damaged.');
  });
  assertBrandShape(doc);
  if (requirePage && doc.pages.size === 0) throw new Error('This file has no pages.');
}

/** Loads a state into a throwaway document and checks it; anything that does not load is `damaged`. */
function checkState(state: Uint8Array, damaged: string, check: (doc: BogenDoc) => void): void {
  const doc = new BogenDoc(new Y.Doc());
  try {
    try {
      Y.applyUpdate(doc.y, state);
    } catch {
      throw new Error(damaged);
    }
    check(doc);
  } finally {
    doc.y.destroy();
  }
}

export function unpackBogenFile(raw: Uint8Array): BogenFileContents {
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (buf.length < MAGIC_LENGTH + 4 || !buf.subarray(0, MAGIC_HEAD.length).equals(MAGIC_HEAD) || buf[MAGIC_LENGTH - 1] !== 0x0a) throw new Error('This is not a Bogen file.');
  const version = buf[MAGIC_HEAD.length]!;
  if (version > 2 && version < 0x20) throw new Error('This file was made by a newer version of Bogen. Update Bogen to open it.');
  if (version !== 1 && version !== 2) throw new Error('This is not a Bogen file.');
  let at = MAGIC_LENGTH;
  const take = (n: number): Buffer => {
    if (n < 0 || at + n > buf.length) throw new Error('This file is truncated.');
    const out = buf.subarray(at, at + n);
    at += n;
    return out;
  };
  const section = () => take(take(4).readUInt32BE());
  let brand: CarriedBrand | null = null;
  let state: Buffer;
  if (version === 1) {
    state = section();
    checkState(state, 'This file is damaged.', (doc) => assertWellFormed(doc));
  } else {
    const length = take(4).readUInt32BE();
    if (length > MAX_MANIFEST) throw new Error('This file is damaged.');
    let manifest: { brand?: { id?: unknown; name?: unknown } } | null;
    try {
      manifest = JSON.parse(take(length).toString('utf8')) as typeof manifest;
    } catch {
      throw new Error('This file is damaged.');
    }
    state = section();
    const brandState = section();
    const info = manifest?.brand;
    if (!info || typeof info.id !== 'string' || !BRAND_ID.test(info.id) || !brandState.length) throw new Error('This file has a damaged brand.');
    checkState(brandState, 'This file has a damaged brand.', (doc) => {
      try {
        assertWellFormed(doc, { requirePage: false });
      } catch {
        throw new Error('This file has a damaged brand.');
      }
      if (!isBrandDoc(doc)) throw new Error('This file has a damaged brand.');
    });
    if (state.length) {
      checkState(state, 'This file is damaged.', (doc) => {
        assertWellFormed(doc);
        // The brand a file carries is the one it links to, and no other.
        if (brandLinkOf(doc)?.id !== info.id) throw new Error('This file is damaged.');
      });
    }
    brand = { id: info.id, name: typeof info.name === 'string' ? info.name.slice(0, 200) : '', state: Uint8Array.from(brandState) };
  }
  const assets: { name: string; bytes: Uint8Array }[] = [];
  while (at < buf.length) {
    const name = section().toString('latin1');
    const bytes = section();
    if (!ASSET_NAME.test(name) || createHash('sha256').update(bytes).digest('hex') !== name.split('.')[0]) throw new Error('This file has a damaged image or video.');
    assets.push({ name, bytes });
  }
  return { format: version === 2 ? 2 : 1, state: Uint8Array.from(state), brand, assets };
}
