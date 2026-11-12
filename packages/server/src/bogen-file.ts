import { createHash } from 'node:crypto';
import { assertBrandShape, brandAssets, branchAssetNames, BogenDoc, fontFaceAssets, Y } from '@bogen/core';

/**
 * A `.bogen` file: magic, then the Y.Doc state, then every asset the design uses, each checked
 * against the content hash in its name. Binary so that desktop MIME sniffing can tell it from JSON.
 */
const MAGIC = Buffer.from('BOGEN\x01\n', 'latin1');
const ASSET_NAME = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;

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

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

export async function packBogenFile(state: Uint8Array, readAsset: (name: string) => Promise<{ bytes: Uint8Array } | null>): Promise<Buffer> {
  const doc = new BogenDoc(new Y.Doc());
  if (state.length) Y.applyUpdate(doc.y, state);
  const parts: Buffer[] = [MAGIC, u32(state.length), Buffer.from(state)];
  for (const name of usedAssets(doc)) {
    const asset = await readAsset(name);
    if (!asset) continue;
    const nameBytes = Buffer.from(name, 'latin1');
    parts.push(u32(nameBytes.length), nameBytes, u32(asset.bytes.length), Buffer.from(asset.bytes));
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

export function unpackBogenFile(raw: Uint8Array): { state: Uint8Array; assets: { name: string; bytes: Uint8Array }[] } {
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (buf.length < MAGIC.length + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This is not a Bogen file.');
  let at = MAGIC.length;
  const take = (n: number): Buffer => {
    if (n < 0 || at + n > buf.length) throw new Error('This file is truncated.');
    const out = buf.subarray(at, at + n);
    at += n;
    return out;
  };
  const state = take(take(4).readUInt32BE());
  const doc = new BogenDoc(new Y.Doc());
  try {
    Y.applyUpdate(doc.y, state);
  } catch {
    throw new Error('This file is damaged.');
  }
  assertWellFormed(doc);
  const assets: { name: string; bytes: Uint8Array }[] = [];
  while (at < buf.length) {
    const name = take(take(4).readUInt32BE()).toString('latin1');
    const bytes = take(take(4).readUInt32BE());
    if (!ASSET_NAME.test(name) || createHash('sha256').update(bytes).digest('hex') !== name.split('.')[0]) throw new Error('This file has a damaged image or video.');
    assets.push({ name, bytes });
  }
  return { state: Uint8Array.from(state), assets };
}
