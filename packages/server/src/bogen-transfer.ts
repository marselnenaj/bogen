import { BogenDoc, brandLinkOf, brandVersionHead, docFromContent, isBrandDoc, newId, readBrand, setBrandLink, Y, type DesignContent } from '@bogen/core';
import { packBogenFile, unpackBogenFile } from './bogen-file.ts';
import type { BrandTransfer } from './brand-store.ts';
import type { BogenServer } from './http/server.ts';
import { Storage } from './storage.ts';
import { atomicWrite, HttpError } from './util.ts';

/**
 * Getting a design and its brand out as one `.bogen` file, and back in on another device: the one place that knows
 * what travels, used by the editor's download, the MCP tools and the CLI alike.
 */

type App = Pick<BogenServer, 'storage' | 'rooms' | 'brands' | 'hub'>;

/** What a written `.bogen` file holds of a brand. */
export interface ExportedBrand {
  included: boolean;
  id: string;
  name?: string;
  version?: number;
  /** Why it is not in the file: the person left it out, or it is not on this device. */
  why?: 'left out' | 'not on this device';
}

export interface BogenExport { bytes: Buffer; name: string; kind: 'file' | 'brand'; brand: ExportedBrand | null }

export interface BogenImport {
  file?: { id: string; name: string };
  brand?: BrandTransfer;
}

async function currentState(app: App, id: string): Promise<Uint8Array | null> {
  const live = app.rooms.peek(id);
  if (live) return Y.encodeStateAsUpdate(live.doc.y);
  await app.storage.flushDoc(id);
  return app.storage.readDoc(id);
}

function load(state: Uint8Array): BogenDoc {
  const doc = new BogenDoc(new Y.Doc());
  if (state.length) Y.applyUpdate(doc.y, state);
  return doc;
}

/** A brand's name and version for a note, read from its document. */
function brandFacts(state: Uint8Array, fallback: string): { name: string; version: number } {
  const doc = load(state);
  try {
    return { name: readBrand(doc).fields.name || fallback, version: brandVersionHead(doc)?.n ?? 0 };
  } finally {
    doc.y.destroy();
  }
}

/**
 * A file with the brand it links to (unless `brand` is false), or a brand on its own. A file whose brand is not on
 * this device goes without it, and says so.
 */
export async function exportBogen(app: App, id: string, options: { brand?: boolean } = {}): Promise<BogenExport> {
  const entry = app.storage.get(id);
  if (!entry) throw new HttpError(404, `No file with id ${id}.`);
  const state = (await currentState(app, id)) ?? new Uint8Array();
  const readAsset = (name: string) => app.storage.readAsset(name);
  if (entry.kind === 'brand') {
    const facts = brandFacts(state, entry.name);
    const bytes = await packBogenFile(new Uint8Array(), readAsset, { brand: { id, name: facts.name, state } });
    return { bytes, name: entry.name, kind: 'brand', brand: { included: true, id, ...facts } };
  }
  const doc = load(state);
  const link = brandLinkOf(doc);
  doc.y.destroy();
  if (!link) return { bytes: await packBogenFile(state, readAsset), name: entry.name, kind: 'file', brand: null };
  const brandEntry = app.storage.get(link.id);
  const brandState = brandEntry?.kind === 'brand' ? await currentState(app, link.id) : null;
  if (options.brand === false || !brandState?.length) {
    const why = options.brand === false ? 'left out' : 'not on this device';
    return { bytes: await packBogenFile(state, readAsset), name: entry.name, kind: 'file', brand: { included: false, id: link.id, ...(brandEntry ? { name: brandEntry.name } : {}), why } };
  }
  const facts = brandFacts(brandState, brandEntry!.name);
  const bytes = await packBogenFile(state, readAsset, { brand: { id: link.id, name: facts.name, state: brandState } });
  return { bytes, name: entry.name, kind: 'file', brand: { included: true, id: link.id, ...facts } };
}

/** One sentence on what happened to the brand on the way out, for the CLI and the MCP tools. */
export function exportNote(out: BogenExport): string | undefined {
  const b = out.brand;
  if (!b) return undefined;
  if (b.included) return out.kind === 'brand' ? `The brand "${b.name}" on its own, version ${b.version}.` : `With its brand "${b.name}", version ${b.version}.`;
  return b.why === 'left out' ? 'Without its brand, as asked. On another device it links to a brand that is not there.' : 'Without its brand, which is not on this device. On another device it links to a brand that is not there either.';
}

/** The brand first, so that the file links to it under the id it has here. */
async function adoptInto(app: App, state: Uint8Array | null, carried: { id: string | null; name: string; doc: BogenDoc }, origin: unknown): Promise<{ state: Uint8Array | null; brand: BrandTransfer }> {
  const brand = await app.brands.adopt(carried, origin);
  if (!state || !carried.id || brand.id === carried.id) return { state, brand };
  const doc = load(state);
  try {
    const link = brandLinkOf(doc);
    if (link) setBrandLink(doc, { ...link, id: brand.id }, origin);
    return { state: Y.encodeStateAsUpdate(doc.y), brand };
  } finally {
    doc.y.destroy();
  }
}

async function listFile(app: App, state: Uint8Array, name: string): Promise<{ id: string; name: string }> {
  const id = newId();
  await atomicWrite(app.storage.docPath(id), state);
  const entry = app.storage.create(name, id);
  await app.brands.classify(id);
  return { id: entry.id, name: entry.name };
}

/** A `.bogen` file of any format, with or without a brand, or a brand on its own. */
export async function importBogen(app: App, raw: Uint8Array, name: string, origin: unknown = 'import'): Promise<BogenImport> {
  let parsed;
  try {
    parsed = unpackBogenFile(raw);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  for (const asset of parsed.assets) await app.storage.putAsset(asset.bytes, Storage.mimeOf(asset.name));
  const clean = name.replace(/\.bogen$/i, '').trim().slice(0, 200);
  let state: Uint8Array | null = parsed.state.length ? parsed.state : null;
  const out: BogenImport = {};
  let carried: { id: string | null; name: string; doc: BogenDoc } | null = parsed.brand ? { id: parsed.brand.id, name: parsed.brand.name, doc: load(parsed.brand.state) } : null;
  if (!carried && state) {
    // A brand downloaded by an older Bogen: format 1, with the brand as the document. It has no id to keep.
    const doc = load(state);
    if (isBrandDoc(doc)) {
      carried = { id: null, name: clean, doc };
      state = null;
    } else doc.y.destroy();
  }
  if (carried) {
    try {
      const adopted = await adoptInto(app, state, carried, origin);
      state = adopted.state;
      out.brand = adopted.brand;
    } finally {
      carried.doc.y.destroy();
    }
  }
  if (state) out.file = await listFile(app, state, clean || 'Imported file');
  app.hub.broadcast({ t: 'files' });
  return out;
}

/** A design folder's brand, written as a design folder of its own inside it. Its id is the one the file links to. */
export async function importFolderBrand(app: App, content: DesignContent, brand: { name: string; content: DesignContent }, origin: unknown = 'import'): Promise<{ content: DesignContent; brand: BrandTransfer }> {
  const link = content.extra?.meta?.brandLink as { id?: unknown } | undefined;
  const id = typeof link?.id === 'string' ? link.id : null;
  if (!id) throw new HttpError(400, 'The folder has a brand, but the design does not link to one.');
  const doc = docFromContent(brand.content);
  try {
    if (!isBrandDoc(doc)) throw new HttpError(400, 'The brand folder does not hold a brand.');
    const adopted = await app.brands.adopt({ id, name: brand.name, doc }, origin);
    if (adopted.id === id) return { content, brand: adopted };
    const meta = { ...content.extra!.meta!, brandLink: { ...(content.extra!.meta!.brandLink as object), id: adopted.id } };
    return { content: { ...content, extra: { ...content.extra, meta } }, brand: adopted };
  } finally {
    doc.y.destroy();
  }
}

/** The brand of a file for its design folder, or why there is none. */
export async function folderBrand(app: App, doc: BogenDoc, want: boolean): Promise<{ id: string; name: string; doc: BogenDoc } | ExportedBrand | null> {
  const link = brandLinkOf(doc);
  if (!link) return null;
  const entry = app.storage.get(link.id);
  if (!want) return { included: false, id: link.id, ...(entry ? { name: entry.name } : {}), why: 'left out' };
  if (entry?.kind !== 'brand') return { included: false, id: link.id, why: 'not on this device' };
  const room = await app.rooms.get(link.id);
  return { id: link.id, name: entry.name, doc: room.doc };
}
