import { brandBookMap, initializeBrandBook } from '@bogen/core';
import {
  addFontFaces, applyBrandTokens, applyTokenRenames, brandTokenRenames, bindingBrand, BRANCHES_ROOT, brandBrief, brandLanguages, contentLanguageOf, resolveContentLanguage, brandCounts, brandFieldsMap, brandItemsMap, BRAND_NOTICE, brandLinkOf, brandSheetHtml, brandSummary, brandVersionHead, brandVersions, brandVersionsMap, BogenDoc, colorsIn, confirmed, diffBrand,
  familyStack, getFontFaces, type StoredFontFace, importHtml, isBrandDoc, makeBrandCopy, markBrandDoc, newId, normalizeColor, publishBrandVersion, readBrand, readProject, setBrandField, setBrandLink, Y, type BrandChange, type BrandData, type BrandVersion,
} from '@bogen/core';
import type { RunEnd, RunRequest } from './agents.ts';
import { checkRendered, reportLine, resolveVars, type BrandReport } from './brand-check.ts';
import { trendOf, worstLayers, type ScoreHistory, type WorstLayer } from './brand-scores.ts';
import type { EventHub } from './events.ts';
import type { FileEvents } from './file-events.ts';
import type { PeerManager } from './peers.ts';
import type { Renderer } from './render.ts';
import type { FileEntry, Storage } from './storage.ts';
import type { Room, Rooms } from './sync.ts';
import { themeIndexOf } from './theme-projects.ts';
import { atomicWrite, errorMessage, HttpError } from './util.ts';

const CHANGE_SETTLE_MS = 300;
const BRIEF_LIMIT = 16_000;
/** Agent-like origin, so that "apply to linked files" is one undoable step per file, undone like an agent's. */
export const BRAND_ACTOR = 'brand';
const BRAND_ORIGIN = `agent:${BRAND_ACTOR}`;

export interface BrandListItem {
  id: string;
  name: string;
  updatedAt: number;
  positioning: string;
  colors: string[];
  isDefault: boolean;
  linkedFiles: number;
  version: number;
  suggestions: number;
  draft: boolean;
}

export interface BrandNote {
  id: string;
  name?: string;
  version?: number;
  update_available?: boolean;
  missing?: boolean;
  summary: string;
  notice?: string;
}

/** What became of a brand that arrived with a file. */
export interface BrandTransfer {
  id: string;
  name: string;
  /** created: it was not here and is now. kept: one with this id was here, and stays as it was. */
  status: 'created' | 'kept';
  /** The id it had where it came from, when it had to take a new one here. */
  previous_id?: string;
  version_here: number;
  version_in_file: number;
  /** Kept, and the brand that came is not the same as the one here. */
  differs: boolean;
  message: string;
}

export interface LayerImpact { id: string; name: string; prop: string; from: string; to: string }
export interface BrandDrift {
  brand_id: string;
  brand_name: string;
  at: number;
  /** The mean score of the linked files that have something drawn; null when none has. */
  summary: number | null;
  /** Worst file first. */
  files: { file_id: string; file_name: string; score: number | null; hard: number; soft: number; layers: number; worst: WorstLayer[]; trend: ReturnType<typeof trendOf>; top?: { label: string; gain: number }[] }[];
  trend: ReturnType<typeof trendOf>;
  history: { at: number; score: number }[];
}
export interface FileImpact { file_id: string; file_name: string; from_version: number | null; layers: LayerImpact[]; layer_count: number; tokens: { name: string; from: string | null; to: string }[]; token_renames?: { from: string; to: string }[] }

interface Deps {
  storage: Storage;
  rooms: Rooms;
  hub: EventHub;
  fileEvents: FileEvents;
  renderer: Renderer;
  scores: ScoreHistory;
  peers: () => PeerManager;
  forgetFile: (id: string) => void;
}

function keyOfRoom(room: Room): string {
  return room.id;
}

/** Brands are files of their own kind: this is everything that knows the difference. */
export class Brands {
  private listeners = new Set<(id: string) => void>();
  private timers = new Map<string, NodeJS.Timeout>();
  private heads = new Map<string, string>();
  private reports = new Map<string, BrandReport & { at: number; runId?: string }>();
  private closed = false;

  constructor(private readonly deps: Deps) {}

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }

  /** Hears every change to any brand. */
  onChange(fn: (id: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------------------------------------------------------------- keeping the index right

  /** Called for each room as it loads. A document says what it is, whatever any index or peer claims. */
  watch(room: Room): void {
    const { doc } = room;
    const { storage } = this.deps;
    const classify = () => {
      const entry = storage.get(room.id);
      if (!entry) return;
      const kind = isBrandDoc(doc) ? 'brand' as const : undefined;
      const brandId = kind ? undefined : brandLinkOf(doc)?.id;
      const project = readProject(doc, Boolean(kind));
      // A theme's identity and branches, for finding its project and listing the library without loading it.
      const theme = kind ? undefined : themeIndexOf(doc, entry.theme);
      if (entry.kind !== kind || entry.brandId !== brandId || JSON.stringify(entry.project) !== JSON.stringify(project) || JSON.stringify(entry.theme) !== JSON.stringify(theme)) {
        storage.update(room.id, { kind, brandId, project, theme });
        this.deps.hub.broadcast({ t: 'files' });
      }
    };
    classify();
    doc.meta.observe(classify);
    room.cleanups.push(() => doc.meta.unobserve(classify));
    // A branch checked out, started or renamed moves the theme index's branch fields at once.
    const branches = doc.y.getMap(BRANCHES_ROOT);
    branches.observe(classify);
    room.cleanups.push(() => branches.unobserve(classify));
    // What a file is a design for can also follow from its artboards (a page marked as a web page). Reading that is
    // cheap (the meta and each page's first level), and done once edits have paused, not on every keystroke.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(settle);
      settle = setTimeout(classify, 1500);
      settle.unref?.();
    };
    doc.y.on('update', onUpdate);
    room.cleanups.push(() => { clearTimeout(settle); doc.y.off('update', onUpdate); });
    this.heads.set(room.id, brandVersionHead(doc)?.id ?? '');
    // For every room: a file may turn out to be a brand once the rest of its state arrives.
    const changed = () => {
      if (isBrandDoc(doc)) this.changed(room);
    };
    const fields = brandFieldsMap(doc);
    const items = brandItemsMap(doc);
    const versions = brandVersionsMap(doc);
    const book = brandBookMap(doc);
    book.observeDeep(changed);
    fields.observeDeep(changed);
    items.observeDeep(changed);
    versions.observeDeep(changed);
    room.cleanups.push(() => {
      book.unobserveDeep(changed);
      fields.unobserveDeep(changed);
      items.unobserveDeep(changed);
      versions.unobserveDeep(changed);
    });
  }

  /** A burst of edits is one notice. Linked files and their agents hear about it through the event log. */
  private changed(room: Room): void {
    const id = keyOfRoom(room);
    if (this.timers.has(id) || this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const live = this.deps.rooms.peek(id);
      this.deps.hub.broadcast({ t: 'brand', id });
      for (const fn of this.listeners) fn(id);
      if (!live) return;
      const head = brandVersionHead(live.doc);
      const published = (head?.id ?? '') !== (this.heads.get(id) ?? '');
      this.heads.set(id, head?.id ?? '');
      for (const file of this.linkedEntries(id)) {
        this.deps.fileEvents.append(file.id, 'brand_changed', { source: 'system' }, { brand_id: id, published, ...(head ? { version: head.n } : {}), note: published ? 'A new brand version is out. Call brand_impact to see what it changes here, and brand_apply to take it over if the person wants that.' : 'The brand has unpublished edits. Read it again with brand_get before your next write.' });
      }
    }, CHANGE_SETTLE_MS);
    timer.unref();
    this.timers.set(id, timer);
  }

  /** Reads what a stored file is, without loading it into a room. For files that arrive by import or from a peer. */
  async classify(id: string): Promise<void> {
    const { storage, rooms } = this.deps;
    const live = rooms.peek(id);
    const state = live ? Y.encodeStateAsUpdate(live.doc.y) : await storage.readDoc(id);
    if (!state) return;
    const probe = new BogenDoc(new Y.Doc());
    try {
      Y.applyUpdate(probe.y, state);
      const kind = isBrandDoc(probe) ? 'brand' as const : undefined;
      const brandId = kind ? undefined : brandLinkOf(probe)?.id;
      const project = readProject(probe, Boolean(kind));
      const entry = storage.get(id);
      const theme = kind || !entry ? undefined : themeIndexOf(probe, entry.theme);
      if (entry && (entry.kind !== kind || entry.brandId !== brandId || JSON.stringify(entry.project) !== JSON.stringify(project) || JSON.stringify(entry.theme) !== JSON.stringify(theme))) {
        storage.update(id, { kind, brandId, project, theme });
        this.deps.hub.broadcast({ t: 'files' });
        if (kind) this.deps.hub.broadcast({ t: 'brand', id });
      }
    } catch (e) {
      console.error(`bogen: could not read ${id}: ${errorMessage(e)}`);
    } finally {
      probe.y.destroy();
    }
  }

  // ---------------------------------------------------------------- the brand as an object

  /** Loads what is not loaded, which is few and cheap. */
  async list(): Promise<BrandListItem[]> {
    const out: BrandListItem[] = [];
    const defaultId = await this.defaultBrandId();
    for (const entry of this.deps.storage.listBrands()) {
      try {
        const room = await this.deps.rooms.get(entry.id);
        out.push({ ...this.itemFromDoc(entry, room.doc), isDefault: entry.id === defaultId });
      } catch (e) {
        console.error(`bogen: brand ${entry.id} could not be read: ${errorMessage(e)}`);
      }
    }
    return out;
  }

  private itemFromEntry(entry: FileEntry): BrandListItem {
    return { id: entry.id, name: entry.name, updatedAt: entry.updatedAt, positioning: '', colors: [], isDefault: false, linkedFiles: this.linkedEntries(entry.id).length, version: 0, suggestions: 0, draft: false };
  }

  private itemFromDoc(entry: FileEntry, doc: BogenDoc): BrandListItem {
    const data = readBrand(doc);
    const head = brandVersionHead(doc);
    const latest = head ? brandVersions(doc).at(-1) : undefined;
    return {
      id: entry.id, name: entry.name, updatedAt: entry.updatedAt, positioning: data.fields.positioning, colors: data.colors.slice(0, 8).map((c) => c.value),
      isDefault: data.fields.defaultAt > 0, linkedFiles: this.linkedEntries(entry.id).length, version: head?.n ?? 0, suggestions: brandCounts(data).suggestions,
      draft: latest ? diffBrand(latest.data, data).length > 0 : false,
    };
  }

  linkedEntries(brandId: string): FileEntry[] {
    return this.deps.storage.list().filter((f) => f.brandId === brandId);
  }

  /** The state is written before the file is listed, so a paired device asking for it right away finds all of it. */
  async create(name: string, by: string): Promise<FileEntry> {
    const clean = name.trim().slice(0, 200) || 'New brand';
    const id = newId();
    const doc = new BogenDoc(new Y.Doc());
    try {
      doc.transact(() => {
        markBrandDoc(doc);
        doc.createPage('Examples');
        setBrandField(doc, 'name', clean);
        initializeBrandBook(doc);
      }, `person:${by}`);
      await atomicWrite(this.deps.storage.docPath(id), Y.encodeStateAsUpdate(doc.y));
    } finally {
      doc.y.destroy();
    }
    const entry = this.deps.storage.create(clean, id, 'brand');
    this.deps.hub.broadcast({ t: 'files' });
    this.deps.hub.broadcast({ t: 'brand', id });
    return entry;
  }

  /**
   * A brand that arrived in a `.bogen` file or a design folder. One with this id here already stays exactly as it is,
   * and the result says whether the one that came differs from it. Otherwise it is added under its own id, so that a
   * file linked to it finds it and paired devices see one brand, not two. Only an id that this device knows as deleted
   * (here or on a paired device) or as something else gets a new one, as the old would be deleted again at the next sync.
   */
  async adopt(carried: { id: string | null; name: string; doc: BogenDoc }, origin: unknown): Promise<BrandTransfer> {
    const { storage, rooms, hub } = this.deps;
    const data = readBrand(carried.doc);
    const inFile = brandVersionHead(carried.doc)?.n ?? 0;
    const name = (data.fields.name || carried.name).trim().slice(0, 200) || 'Imported brand';
    const existing = carried.id ? storage.get(carried.id) : undefined;
    if (carried.id && existing?.kind === 'brand') {
      const room = await rooms.get(carried.id);
      const here = brandVersionHead(room.doc)?.n ?? 0;
      const differs = diffBrand(readBrand(room.doc), data).some((c) => !(c.section === 'fields' && c.id === 'name'));
      const message = !differs
        ? `The brand "${existing.name}" is on this device already, the same as in the file.`
        : `The brand "${existing.name}" is on this device already and was kept as it is. The file came with ${inFile !== here ? `version ${inFile} of it, and this device has version ${here}` : 'changes to it that this device does not have'}. Compare the two before you take anything over.`;
      return { id: carried.id, name: existing.name, status: 'kept', version_here: here, version_in_file: inFile, differs, message };
    }
    const deleted = carried.id ? this.deps.peers().wasDeleted(carried.id) : false;
    const id = carried.id && !existing && !deleted ? carried.id : newId();
    // Which brand is the default is this device's choice: one that arrives does not take it from a brand already set.
    if (data.fields.defaultAt > 0 && (await this.defaultBrandId())) setBrandField(carried.doc, 'defaultAt', 0, origin);
    // Another import of the same brand, or a paired device, may have listed it while the default was looked up.
    if (storage.get(id)) return this.adopt(carried, origin);
    await atomicWrite(storage.docPath(id), Y.encodeStateAsUpdate(carried.doc.y));
    storage.create(name, id, 'brand');
    hub.broadcast({ t: 'files' });
    hub.broadcast({ t: 'brand', id });
    const twin = storage.listBrands().some((b) => b.id !== id && b.name === name);
    const message = [
      `Added the brand "${name}" to this device.`,
      ...(carried.id && id !== carried.id ? [deleted ? 'A brand with its id was deleted on this device or a paired one, so it was added under a new id.' : 'Its id is taken here, so it was added under a new id.'] : []),
      ...(twin ? [`Another brand on this device is also called "${name}". They are separate brands.`] : []),
    ].join(' ');
    return { id, name, status: 'created', ...(carried.id && id !== carried.id ? { previous_id: carried.id } : {}), version_here: inFile, version_in_file: inFile, differs: false, message };
  }

  requireBrand(id: string): FileEntry {
    const entry = this.deps.storage.get(id);
    if (!entry || entry.kind !== 'brand') throw new HttpError(404, `No brand with id ${id}. Call brand_list to see what exists.`);
    return entry;
  }

  async room(id: string): Promise<Room> {
    this.requireBrand(id);
    return this.deps.rooms.get(id);
  }

  async read(id: string): Promise<{ entry: FileEntry; room: Room; data: BrandData }> {
    const entry = this.requireBrand(id);
    const room = await this.deps.rooms.get(id);
    return { entry, room, data: readBrand(room.doc) };
  }

  /** Returns the name as stored: trimmed, and never empty. */
  async rename(id: string, name: string, origin: unknown): Promise<string> {
    const room = await this.room(id);
    const clean = name.trim().slice(0, 200);
    if (!clean) throw new HttpError(400, 'A brand needs a name with something in it.');
    this.deps.storage.update(id, { name: clean, updatedAt: Date.now() });
    setBrandField(room.doc, 'name', clean, origin);
    this.deps.hub.broadcast({ t: 'files' });
    return clean;
  }

  /**
   * A copy that goes its own way, as a new brand: it starts at version 0 as a draft with no versions of its own, it is
   * not the default, no file links to it, and it records which brand and version it came from.
   */
  async duplicate(id: string, origin: unknown): Promise<FileEntry> {
    const { entry, room, data } = await this.read(id);
    const copyId = newId();
    const copy = new BogenDoc(new Y.Doc());
    try {
      Y.applyUpdate(copy.y, Y.encodeStateAsUpdate(room.doc.y));
      const from = { id, name: data.fields.name || entry.name, version: brandVersionHead(room.doc)?.n ?? 0, at: Date.now() };
      makeBrandCopy(copy, from, `${data.fields.name || entry.name} copy`, origin);
      await atomicWrite(this.deps.storage.docPath(copyId), Y.encodeStateAsUpdate(copy.y));
    } finally {
      copy.y.destroy();
    }
    const created = this.deps.storage.create(`${entry.name} copy`, copyId, 'brand');
    this.deps.hub.broadcast({ t: 'files' });
    this.deps.hub.broadcast({ t: 'brand', id: copyId });
    return created;
  }

  /** The same way a file goes: a tombstone for other devices, so the delete syncs. Linked files keep working, and say the brand is gone. */
  async delete(id: string): Promise<{ deleted: string; linked_files: number; files?: { id: string; name: string }[]; next?: string }> {
    const entry = this.requireBrand(id);
    const files = this.linkedEntries(id).map((f) => ({ id: f.id, name: f.name }));
    const linked = files.length;
    await this.deps.peers().recordDelete(id);
    this.deps.rooms.drop(id);
    this.deps.forgetFile(id);
    await this.deps.storage.remove(id);
    this.deps.hub.broadcast({ t: 'files' });
    this.deps.hub.broadcast({ t: 'brand', id });
    return {
      deleted: entry.name, linked_files: linked,
      // The files keep their link, so that a brand that comes back from another device is theirs again. Until then they say it is gone.
      ...(linked ? { files: files.slice(0, 50), next: 'These files still point at the deleted brand and keep its tokens. Their brand check cannot run until each is linked to another brand, or unlinked with brand_link and brand_id null.' } : {}),
    };
  }

  // ---------------------------------------------------------------- default brand

  /** The brand set as default last. It is stored in the brand, so that it syncs like everything else about it. */
  async defaultBrandId(): Promise<string | null> {
    let best: { id: string; at: number } | null = null;
    for (const entry of this.deps.storage.listBrands()) {
      const room = await this.deps.rooms.get(entry.id).catch(() => null);
      if (!room) continue;
      const at = readBrand(room.doc).fields.defaultAt;
      if (at > 0 && (!best || at > best.at || (at === best.at && entry.id > best.id))) best = { id: entry.id, at };
    }
    return best?.id ?? null;
  }

  async setDefault(id: string | null, origin: unknown): Promise<void> {
    if (id) this.requireBrand(id);
    for (const entry of this.deps.storage.listBrands()) {
      const room = await this.deps.rooms.get(entry.id).catch(() => null);
      if (!room) continue;
      const at = entry.id === id ? Date.now() : 0;
      if (readBrand(room.doc).fields.defaultAt !== at) setBrandField(room.doc, 'defaultAt', at, origin);
    }
  }

  /** A new file takes the default brand, if there is one. Old files and homes without brands are not touched. */
  async applyDefault(fileId: string, origin: unknown): Promise<void> {
    if (!this.deps.storage.listBrands().length) return;
    const brandId = await this.defaultBrandId();
    if (brandId) await this.link(fileId, brandId, origin);
  }

  // ---------------------------------------------------------------- links

  async link(fileId: string, brandId: string | null, origin: unknown): Promise<{ brand_id: string | null; tokens_set: string[] }> {
    const { storage, rooms } = this.deps;
    const entry = storage.get(fileId);
    if (!entry) throw new HttpError(404, `No file with id ${fileId}.`);
    if (entry.kind === 'brand') throw new HttpError(400, 'That is a brand. Link design files to brands.');
    const room = await rooms.get(fileId);
    if (!brandId) {
      setBrandLink(room.doc, null, origin);
      return { brand_id: null, tokens_set: [] };
    }
    const { room: brandRoom, data } = await this.read(brandId);
    // A first version gives every file something to compare with later.
    const head = brandVersionHead(brandRoom.doc) ?? publishBrandVersion(brandRoom.doc, { note: 'First linked', by: 'Bogen' }, origin);
    const faces = this.faceSubset(brandRoom.doc, data);
    let tokens: string[] = [];
    room.doc.transact(() => {
      setBrandLink(room.doc, { id: brandId, version: head.id, at: Date.now() });
      tokens = applyBrandTokens(room.doc, data).set;
      if (faces.length) addFontFaces(room.doc, faces);
    }, origin);
    return { brand_id: brandId, tokens_set: tokens };
  }

  /** The hosted font files for this brand's families, so that a linked file draws them like the brand does. */
  private faceSubset(brandDoc: BogenDoc, data: BrandData): StoredFontFace[] {
    const wanted = new Set(confirmed(data.families).map((f) => f.family.toLowerCase()));
    const faces = getFontFaces(brandDoc).filter((f) => wanted.has(f.family.toLowerCase()));
    // Files a person gave the brand count just as much as what a capture brought along.
    for (const family of confirmed(data.families)) {
      const weights = family.weights.length ? `${Math.min(...family.weights)} ${Math.max(...family.weights)}` : undefined;
      for (const src of family.assets) {
        if (/\.(woff2|woff|ttf|otf)$/.test(src) && !faces.some((f) => f.src === src)) faces.push({ family: family.family, src, ...(weights ? { weight: weights } : {}), display: 'swap' });
      }
    }
    return faces;
  }

  /** The brand a file links to, read now. `missing` means that the link points at something not on this device. */
  async forRoom(room: Room): Promise<{ link: { id: string; version: string; at: number }; data: BrandData | null; doc: BogenDoc | null; entry: FileEntry | null } | null> {
    const link = brandLinkOf(room.doc);
    if (!link) return null;
    const entry = this.deps.storage.get(link.id);
    if (!entry || entry.kind !== 'brand') return { link, data: null, doc: null, entry: null };
    const brand = await this.deps.rooms.get(link.id).catch(() => null);
    if (!brand) return { link, data: null, doc: null, entry: null };
    return { link, data: readBrand(brand.doc), doc: brand.doc, entry };
  }

  /** The font a new artboard starts with in a linked file. Three real runs fell back to Times New Roman without it. */
  async bodyFont(room: Room): Promise<string | null> {
    const found = await this.forRoom(room);
    if (!found?.data) return null;
    const families = confirmed(found.data.families);
    const family = families.find((f) => /body|text/i.test(f.role)) ?? families[0];
    if (!family) return null;
    return room.doc.tokens.has(family.token) ? `var(--${family.token})` : familyStack(family);
  }

  /** The short form for a tool result. Small on purpose, whatever the size of the brand. */
  async note(room: Room): Promise<BrandNote | null> {
    const found = await this.forRoom(room);
    if (!found) return null;
    if (!found.data || !found.doc) return { id: found.link.id, missing: true, summary: 'This file links to a brand that is not on this device. It may still be syncing, or it was deleted. Say so to the person rather than inventing a style.' };
    const head = brandVersionHead(found.doc);
    const update = Boolean(head && head.id !== found.link.version);
    return {
      id: found.link.id, name: found.data.fields.name || found.entry?.name, ...(head ? { version: head.n } : {}), ...(update ? { update_available: true } : {}),
      summary: brandSummary(found.data, head ? { version: head.n } : {}), notice: BRAND_NOTICE,
    };
  }

  // ---------------------------------------------------------------- runs

  /** Every way of starting a run passes through here, so that none of them can forget the brand. */
  async prepareRun(req: RunRequest): Promise<RunRequest> {
    const room = await this.deps.rooms.get(req.fileId).catch(() => null);
    if (!room) return req;
    const found = await this.forRoom(room);
    if (!found) return req;
    if (!found.data || !found.doc) return { ...req, brand: `This file links to a brand that is not on this device (id ${found.link.id}). Tell the person, and do not invent a style for it.` };
    const head = brandVersionHead(found.doc);
    // Which of its languages the run writes in: the request's, else the file's, else the brand's primary.
    const langs = brandLanguages(found.data);
    const design = resolveContentLanguage({ run: req.language ?? null, file: contentLanguageOf(room.doc), brand: langs.inferred ? null : langs.primary });
    const info = { id: found.link.id, ...(head ? { version: head.n } : {}), writeIn: design ? { tag: design.tag, source: design.source } : null };
    let brief = brandBrief(found.data, info);
    if (brief.length > BRIEF_LIMIT) {
      const lean: BrandData = { ...found.data, voiceExamples: [], artboards: [], rules: found.data.rules.filter((r) => r.severity === 'hard') };
      brief = `${brandBrief(lean, info)}\nThis brand is large, so examples and soft rules are left out here. Read them with brand_get.`;
    }
    return { ...req, brand: brief };
  }

  /** After a run: the score, for its output and the Agents tab. It only reads, and never starts anything. */
  async runEnded(end: RunEnd): Promise<void> {
    // A critique changed nothing, so a score would only repeat the one before it.
    if (this.closed || end.review === 'critique') return;
    const room = await this.deps.rooms.get(end.fileId).catch(() => null);
    if (!room) return;
    const found = await this.forRoom(room);
    if (!found?.data) return;
    try {
      // The language the run wrote in, which may be its own for this one request rather than the file's.
      const report = await checkRendered(room.doc, found.data, this.deps.renderer, { file: true }, end.language ? { contentLanguage: end.language.tag } : {});
      if (this.closed) return;
      this.reports.set(end.fileId, { ...report, at: Date.now(), runId: end.runId });
      await this.deps.scores.record(found.link.id, end.fileId, report, `run:${end.runner}`).catch(() => {});
      const text = reportLine(report);
      this.deps.hub.broadcast({ t: 'agent', runId: end.runId, fileId: end.fileId, kind: 'text', text: `\n${text}` });
      this.deps.hub.broadcast({ t: 'brand-report', fileId: end.fileId, runId: end.runId, runner: end.runner, score: report.score.value, hard: report.counts.hard, soft: report.counts.soft, waived: report.counts.waived, checklist: report.checklist.length, text, violations: report.violations.slice(0, 40).map((v) => ({ node_id: v.node_id, layer: v.layer, rule: v.rule, severity: v.severity, message: v.message })) });
      this.deps.fileEvents.append(end.fileId, 'brand_checked', { source: 'system' }, { run_id: end.runId, score: report.score.value, hard: report.counts.hard, soft: report.counts.soft, checklist: report.checklist.length });
    } catch (e) {
      console.error(`bogen: no brand check after run ${end.runId}: ${errorMessage(e)}`);
    }
  }

  lastReport(fileId: string): (BrandReport & { at: number; runId?: string }) | undefined {
    return this.reports.get(fileId);
  }

  /** Keeps a whole-file check of a linked file in the brand's score history. */
  async recordCheck(room: Room, report: BrandReport, by: string): Promise<void> {
    const link = brandLinkOf(room.doc);
    if (!link || this.deps.storage.get(link.id)?.kind !== 'brand') return;
    await this.deps.scores.record(link.id, room.id, report, by).catch((e) => console.error(`bogen: brand score not kept: ${errorMessage(e)}`));
  }

  /**
   * Brand drift across files: every linked file checked as a whole, its worst layers, and a summary score, the mean of
   * the files that have something drawn. Each check goes into the history, so that the brand panel shows a trend.
   */
  async drift(brandId: string, by: string, options: { worst?: number; fileIds?: string[] } = {}): Promise<BrandDrift> {
    const { data, entry } = await this.read(brandId);
    const files: BrandDrift['files'] = [];
    const before = await this.deps.scores.read(brandId);
    for (const file of this.linkedEntries(brandId)) {
      if (options.fileIds && !options.fileIds.includes(file.id)) continue;
      const room = await this.deps.rooms.get(file.id).catch(() => null);
      if (!room || brandLinkOf(room.doc)?.id !== brandId) continue;
      const report = await checkRendered(room.doc, data, this.deps.renderer, { file: true });
      if (report.score.nothing_checked) {
        files.push({ file_id: file.id, file_name: file.name, score: null, hard: 0, soft: 0, layers: 0, worst: [], trend: trendOf(before.files[file.id] ?? []) });
        continue;
      }
      await this.deps.scores.record(brandId, file.id, report, by);
      this.reports.set(file.id, { ...report, at: Date.now() });
      const history = [...(before.files[file.id] ?? []), { at: Date.now(), score: report.score.value }];
      files.push({
        file_id: file.id, file_name: file.name, score: report.score.value, hard: report.counts.hard, soft: report.counts.soft, layers: report.counts.layers,
        worst: worstLayers(room.doc, report.violations, options.worst ?? 5), trend: trendOf(history), top: report.score.raise.slice(0, 3).map((l) => ({ label: l.label, gain: l.gain })),
      });
    }
    const scored = files.filter((f) => f.score !== null);
    const summary = scored.length ? Math.round(scored.reduce((a, f) => a + f.score!, 0) / scored.length) : null;
    const at = Date.now();
    if (summary !== null && !options.fileIds) await this.deps.scores.recordSummary(brandId, { at, score: summary, files: scored.length, hard: scored.reduce((a, f) => a + f.hard, 0), soft: scored.reduce((a, f) => a + f.soft, 0) });
    const after = await this.deps.scores.read(brandId);
    this.deps.hub.broadcast({ t: 'brand', id: brandId });
    return {
      brand_id: brandId, brand_name: data.fields.name || entry.name, at, summary, files: files.sort((a, b) => (a.score ?? 101) - (b.score ?? 101)),
      trend: trendOf(after.summary), history: after.summary.slice(-30).map((p) => ({ at: p.at, score: p.score })),
    };
  }

  // ---------------------------------------------------------------- versions and change

  async publish(id: string, info: { note?: string; by: string }, origin: unknown): Promise<BrandVersion> {
    const { room } = await this.read(id);
    return publishBrandVersion(room.doc, info, origin);
  }

  async diff(id: string, fromId?: string, toId?: string): Promise<{ from: number | 'current'; to: number | 'current'; changes: BrandChange[] }> {
    const { room, data } = await this.read(id);
    const versions = brandVersions(room.doc);
    const find = (key: string | undefined, fallback: BrandVersion | 'current' | undefined): BrandVersion | 'current' | undefined => {
      if (key === undefined) return fallback;
      if (key === 'current') return 'current';
      const n = Number(key);
      return versions.find((v) => v.id === key || (Number.isInteger(n) && v.n === n));
    };
    const a = find(fromId, versions.at(-1));
    const b = find(toId, 'current');
    if (a === undefined) throw new HttpError(400, versions.length ? `No version "${fromId}".` : 'This brand has no versions yet. Call brand_publish first.');
    if (b === undefined) throw new HttpError(400, `No version "${toId}".`);
    return {
      from: a === 'current' ? 'current' : a.n, to: b === 'current' ? 'current' : b.n,
      changes: diffBrand(a === 'current' ? data : a.data, b === 'current' ? data : b.data),
    };
  }

  /** What taking over the current brand would change in one file. Only looks. */
  private impactOn(doc: BogenDoc, entry: FileEntry, from: BrandVersion | undefined, to: BrandData): FileImpact {
    const replace = from ? replacements(from.data, to) : new Map<string, Replacement>();
    const tokensNow = new Map(doc.getTokens().map((t) => [t.name, t.value]));
    const tokenChanges = brandTokensDiff(tokensNow, to);
    const layers: LayerImpact[] = [];
    if (replace.size || tokenChanges.length) {
      const changedTokens = new Map(tokenChanges.map((t) => [t.name, t]));
      doc.nodes.forEach((_, id) => {
        const node = doc.getNode(id);
        if (!node) return;
        for (const [prop, value] of Object.entries(node.style)) {
          const viaToken = /var\(\s*--([\w-]+)/.exec(value)?.[1];
          if (viaToken && changedTokens.has(viaToken)) {
            layers.push({ id, name: node.name, prop, from: changedTokens.get(viaToken)!.from ?? value, to: changedTokens.get(viaToken)!.to });
            continue;
          }
          const replaced = replaceValue(prop, value, replace, tokensNow);
          if (replaced !== null) layers.push({ id, name: node.name, prop, from: value, to: replaced });
        }
      });
    }
    const renames = from ? [...brandTokenRenames(from.data, to)].filter(([old]) => doc.tokens.has(old)).map(([old, now]) => ({ from: old, to: now })) : [];
    return { file_id: entry.id, file_name: entry.name, from_version: from?.n ?? null, layer_count: new Set(layers.map((l) => l.id)).size, layers: layers.slice(0, 200), tokens: tokenChanges, ...(renames.length ? { token_renames: renames } : {}) };
  }

  /** Which linked files and layers a change touches, whether it is published yet or not. */
  async impact(id: string): Promise<{ brand_id: string; draft_changes: number; files: FileImpact[] }> {
    const { room, data } = await this.read(id);
    const versions = brandVersions(room.doc);
    const files: FileImpact[] = [];
    for (const entry of this.linkedEntries(id)) {
      const file = await this.deps.rooms.get(entry.id).catch(() => null);
      if (!file) continue;
      const link = brandLinkOf(file.doc);
      if (link?.id !== id) continue;
      files.push(this.impactOn(file.doc, entry, versions.find((v) => v.id === link.version), data));
    }
    const head = versions.at(-1);
    return { brand_id: id, draft_changes: head ? diffBrand(head.data, data).length : 0, files };
  }

  /**
   * Takes the current brand over into linked files, publishing it first if it has unpublished edits. Each file gets
   * one undoable step, attributed to `brand`, which `POST /api/agents/undo` takes back like any agent's.
   */
  async apply(id: string, fileIds: string[] | null, by: string, origin: unknown): Promise<{ version: number; files: { file_id: string; file_name: string; layers: number; tokens: number }[]; skipped?: { file_id: string; why: string }[]; note?: string }> {
    const { room, data } = await this.read(id);
    const before = brandVersions(room.doc);
    const latest = before.at(-1);
    const linked = this.linkedEntries(id);
    // Files that were asked for and are not this brand's: said, rather than passed over.
    const skipped = (fileIds ?? []).filter((f) => !linked.some((e) => e.id === f)).map((f) => ({ file_id: f, why: this.deps.storage.get(f) ? 'This file is not linked to this brand.' : 'There is no file with this id.' }));
    if (!linked.some((e) => !fileIds || fileIds.includes(e.id))) {
      // With no file to carry it into, nothing is published either: a version is not a side effect of an empty apply.
      return { version: latest?.n ?? 0, files: [], ...(skipped.length ? { skipped } : {}), note: fileIds ? 'None of these files is linked to this brand, so nothing was applied or published.' : 'No files link to this brand yet, so nothing was applied or published.' };
    }
    // A version records what binds, so a field that is still a suggestion is no reason for a new one.
    const head = !latest || diffBrand(latest.data, bindingBrand(data)).length ? publishBrandVersion(room.doc, { by, note: 'Applied to linked files' }, origin) : latest;
    const faces = this.faceSubset(room.doc, data);
    const out: { file_id: string; file_name: string; layers: number; tokens: number }[] = [];
    for (const entry of this.linkedEntries(id)) {
      if (fileIds && !fileIds.includes(entry.id)) continue;
      const file = await this.deps.rooms.get(entry.id).catch(() => null);
      if (!file) continue;
      const link = brandLinkOf(file.doc);
      if (link?.id !== id) continue;
      const from = before.find((v) => v.id === link.version);
      const replace = from ? replacements(from.data, data) : new Map<string, Replacement>();
      const tokensNow = new Map(file.doc.getTokens().map((t) => [t.name, t.value]));
      file.undoManagerFor(BRAND_ACTOR);
      let layers = 0;
      let tokens = 0;
      file.doc.transact(() => {
        file.doc.nodes.forEach((_, nodeId) => {
          const node = file.doc.getNode(nodeId);
          if (!node) return;
          const patch: Record<string, string> = {};
          for (const [prop, value] of Object.entries(node.style)) {
            const replaced = replaceValue(prop, value, replace, tokensNow);
            if (replaced !== null) patch[prop] = replaced;
          }
          if (Object.keys(patch).length) {
            file.doc.updateStyle(nodeId, patch);
            layers++;
          }
        });
        // A token the brand renamed is renamed here first, with every reference, so that no layer keeps the old name.
        if (from) applyTokenRenames(file.doc, brandTokenRenames(from.data, data));
        const result = applyBrandTokens(file.doc, data);
        tokens = result.set.length + result.removed.length;
        if (faces.length) addFontFaces(file.doc, faces);
        setBrandLink(file.doc, { id, version: head.id, at: Date.now() });
      }, BRAND_ORIGIN);
      out.push({ file_id: entry.id, file_name: entry.name, layers, tokens });
    }
    return { version: head.n, files: out, ...(skipped.length ? { skipped } : {}) };
  }

  /** The rendered sheet as a throwaway document: one artboard, built from the data and nothing else. */
  sheetDoc(data: BrandData, brandDoc: BogenDoc): { doc: BogenDoc; rootId: string } {
    const doc = new BogenDoc(new Y.Doc());
    doc.ensureFirstPage('Sheet');
    const pageId = doc.getPages()[0]!.id;
    const { nodes } = importHtml(brandSheetHtml(data));
    const root = nodes[0];
    if (!root) throw new Error('The sheet came out empty.');
    root.style = { ...root.style, position: 'absolute', left: '0px', top: '0px' };
    const rootId = doc.insert(pageId, root);
    addFontFaces(doc, getFontFaces(brandDoc));
    return { doc, rootId };
  }
}

function brandTokensDiff(now: Map<string, string>, data: BrandData): { name: string; from: string | null; to: string }[] {
  const out: { name: string; from: string | null; to: string }[] = [];
  for (const c of confirmed(data.colors)) if (now.get(c.token) !== c.value) out.push({ name: c.token, from: now.get(c.token) ?? null, to: c.value });
  for (const f of confirmed(data.families)) {
    const stack = familyStack(f);
    if (now.get(f.token) !== stack) out.push({ name: f.token, from: now.get(f.token) ?? null, to: stack });
  }
  for (const t of confirmed(data.typeScale)) if (now.get(t.token) !== `${t.size}px`) out.push({ name: t.token, from: now.get(t.token) ?? null, to: `${t.size}px` });
  for (const s of confirmed(data.spacing)) if (now.get(s.token) !== `${s.value}px`) out.push({ name: s.token, from: now.get(s.token) ?? null, to: `${s.value}px` });
  for (const r of confirmed(data.radius)) if (now.get(r.token) !== `${r.value}px`) out.push({ name: r.token, from: now.get(r.token) ?? null, to: `${r.value}px` });
  return out;
}

export interface Replacement { kind: 'color' | 'font'; to: string }

/** What became what between two versions, for values that layers hold literally. Tokens update on their own. */
function replacements(from: BrandData, to: BrandData): Map<string, Replacement> {
  const out = new Map<string, Replacement>();
  const next = new Map(to.colors.map((c) => [c.id, c]));
  for (const c of from.colors) {
    const n = next.get(c.id);
    if (n && n.value !== c.value) out.set(`color:${c.value}`, { kind: 'color', to: n.value });
  }
  const nextFamilies = new Map(to.families.map((f) => [f.id, f]));
  for (const f of from.families) {
    const n = nextFamilies.get(f.id);
    if (n && n.family !== f.family) out.set(`font:${f.family.toLowerCase()}`, { kind: 'font', to: familyStack(n) });
  }
  return out;
}

/**
 * A style value with the colours and the font family that `replace` names swapped, keyed `color:#rrggbb` and
 * `font:<first family in lower case>`. A translucent colour stays as translucent, and a transparent one is left alone.
 */
export function replaceValue(prop: string, value: string, replace: Map<string, Replacement>, tokens: Map<string, string>): string | null {
  if (!replace.size || value.includes('var(')) return null;
  if (prop === 'fontFamily') {
    const first = (value.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
    return replace.get(`font:${first}`)?.to ?? null;
  }
  const resolved = resolveVars(value, tokens);
  const colors = colorsIn(resolved);
  if (!colors.length) return null;
  let out = resolved;
  let changed = false;
  for (const m of resolved.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\([^()]*\)|\b[a-zA-Z]{3,}\b/g)) {
    const hex = normalizeColor(m[0]);
    if (!hex) continue;
    const alpha = hex.length === 9 ? Number.parseInt(hex.slice(7), 16) / 255 : 1;
    if (alpha === 0) continue;
    const r = replace.get(`color:${hex.slice(0, 7)}`);
    if (r) {
      out = out.replace(m[0], alpha < 1 ? `color-mix(in srgb, ${r.to} ${Math.round(alpha * 100)}%, transparent)` : r.to);
      changed = true;
    }
  }
  return changed ? out : null;
}

