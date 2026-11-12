import * as Y from 'yjs';
import { labelChange } from './changes.ts';
import { applyContent, assertContent, docToContent, type ContentNode, type DesignContent } from './content.ts';
import type { BogenDoc } from './doc.ts';
import { newId } from './doc.ts';

/**
 * Branches inside one file: named versions of the whole design that live in the same document, never as files of
 * their own. A branch holds everything a version of a design is: its pages and layers, components, tokens, modes,
 * text styles, keyframes and the file's records in meta (an Omarchy theme's palette, name, displays and wallpapers,
 * for instance). Assets are shared by their content address, so a branch costs no copy of a picture.
 *
 * One branch is checked out at a time: the document's live design is that branch, so every tool, the editor, sync,
 * export and render work on it as they work on any file. Every other branch is kept as a snapshot of its content in
 * the root map `designBranches`, which `docToContent` and `applyContent` never touch (content.ts), so commits,
 * restores and design folders hold the checked-out design only and cannot clobber the branches. Snapshots are stored
 * once per content hash: a branch made a moment ago costs nothing until it differs.
 *
 * "main" is the primary version. A branch has a parent (main, or another branch) and the parent's content at the time
 * it started (its base), so merging it back is a three-way merge that keeps what either side changed alone and asks
 * about what both changed. Only a person merges or discards: agents create branches and work in them.
 *
 * Kind-neutral on purpose: Omarchy themes are the first user, Mac themes and other designs can use the same model.
 */

export const BRANCHES_ROOT = 'designBranches';
export const MAIN_BRANCH = 'main';
/** Open branches a file can have besides main. Past that, the person merges or discards one first. */
export const MAX_OPEN_BRANCHES = 12;
/** Decided branches whose content is kept for restore. Older ones keep their record, not their snapshots. */
export const MAX_DECIDED_KEPT = 8;

export type BranchStatus = 'open' | 'merged' | 'discarded';

export interface DesignBranch {
  id: string;
  name: string;
  /** The branch it started from and merges back into; null for main. */
  parent: string | null;
  status: BranchStatus;
  by: string;
  at: number;
  updatedAt?: number;
  /** Snapshot hash of the parent's content when this branch started. */
  base?: string;
  /** Snapshot hash of this branch's content while it is not checked out. */
  head?: string;
  /** What it is for, in the words of whoever started it. */
  note?: string;
  /** The conversation that works in it, so that the next message continues it. */
  conversation?: string;
  /** A history commit taken before it started, as a way back outside the file. */
  checkpoint?: string;
  /** For a branch imported from another file: where it came from, kept for good. */
  imported?: { fileId: string; name: string; at: number };
  decidedAt?: number;
  decidedBy?: string;
  /** After a merge: the parent's content before it, so that the person can undo the merge. */
  mergeUndo?: string;
  /** After a merge: the hash of the merged content, so that an undo only runs while nothing changed since. */
  mergedHash?: string;
  /** Its snapshots were let go after it was decided long ago; the record stays, and `archivedAs` holds the content. */
  pruned?: boolean;
  /**
   * Updates from a replica that did not see a checkout, kept as they came where part of them could not be laid onto
   * this branch (text typed against the checkout, kinds of values not read back). In the document, so that they sync
   * and go with a download; the person applies or dismisses them.
   */
  held?: HeldUpdate[];
  /** A recovery branch: edits from this replica that could not go to the branch they were made on. */
  recoveryOf?: string;
  /** Order of starting, for a stable list when two start within one millisecond. */
  seq?: number;
  /** A named History commit that holds this branch's content for good. Only then may its snapshots be let go. */
  archivedAs?: string;
}

/**
 * A replica's update kept as it came, by reference: the update itself is a content-addressed asset (`asset`, a
 * bogen-asset src), so the document holds only this record however large the update is, and the bytes travel like
 * pictures do (sync, .bogen). `assets` names the pictures the update refers to, which may be named nowhere else.
 */
export interface HeldUpdate { id: string; at: number; from: string; source: string; bytes: number; layers: string[]; asset: string; assets?: string[]; path?: string }
/** Held updates a branch keeps before the person has looked at them. Past that, further ones are refused before they change anything. */
export const MAX_HELD = 64;

export type BranchSide = 'branch' | 'primary';
export type BranchResolution = BranchSide | Record<string, BranchSide>;

export interface BranchConflict {
  /** Stable key, used to resolve this one conflict: `token:--x`, `node:<id>`, `meta:<key>`, … */
  key: string;
  kind: 'token' | 'node' | 'page' | 'setting' | 'keyframes' | 'interaction' | 'repeat';
  /** What a person reads: the token, layer or setting. */
  label: string;
  /** What happened on each side, briefly. */
  primary: 'changed' | 'removed' | 'added';
  branch: 'changed' | 'removed' | 'added';
}

export class BranchConflictError extends Error {
  constructor(readonly conflicts: BranchConflict[]) {
    super(`Both the branch and its parent changed ${conflicts.length === 1 ? 'one thing' : `${conflicts.length} things`} differently: ${conflicts.slice(0, 5).map((c) => c.label).join(', ')}${conflicts.length > 5 ? ', …' : ''}. Nothing was merged. Choose for each which side wins, or one side for all.`);
  }
}

const root = (doc: BogenDoc): Y.Map<unknown> => doc.y.getMap<unknown>(BRANCHES_ROOT);
const recordKey = (id: string) => `b:${id}`;
const blobKey = (hash: string) => `blob:${hash}`;

/** A short content hash that works in the browser and on the server alike: FNV-1a twice, with the length. */
export function contentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (i & 0xff), 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}${text.length.toString(36)}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** JSON with every object's keys in order, so that the same content always reads the same, however it was built. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** The hash a branch's content is stored and compared under. */
export function designHash(content: DesignContent): string {
  return contentHash(canonicalJson(content));
}

function mainRecord(): DesignBranch {
  return { id: MAIN_BRANCH, name: 'Main', parent: null, status: 'open', by: '', at: 0 };
}

function readRecord(doc: BogenDoc, id: string): DesignBranch | undefined {
  const raw = root(doc).get(recordKey(id)) as DesignBranch | undefined;
  if (raw && typeof raw === 'object' && typeof raw.id === 'string' && typeof raw.name === 'string') return raw;
  return id === MAIN_BRANCH ? mainRecord() : undefined;
}

function nextSeq(doc: BogenDoc): number {
  let max = 0;
  root(doc).forEach((v, k) => { if (k.startsWith('b:')) max = Math.max(max, (v as DesignBranch).seq ?? 0); });
  return max + 1;
}

function saveRecord(doc: BogenDoc, rec: DesignBranch): void {
  // Undefined fields are left out, so that the stored record stays plain JSON.
  root(doc).set(recordKey(rec.id), JSON.parse(JSON.stringify(rec)) as DesignBranch);
}

/** Whether this file has any branch besides main, open or decided. */
export function hasDesignBranches(doc: BogenDoc): boolean {
  for (const key of root(doc).keys()) if (key.startsWith('b:') && key !== recordKey(MAIN_BRANCH)) return true;
  return false;
}

export function currentBranchId(doc: BogenDoc): string {
  const id = root(doc).get('current');
  return typeof id === 'string' && readRecord(doc, id)?.status === 'open' ? id : MAIN_BRANCH;
}

/** Main first, then the others in the order they started. */
export function listDesignBranches(doc: BogenDoc): DesignBranch[] {
  const out: DesignBranch[] = [];
  root(doc).forEach((value, key) => {
    if (!key.startsWith('b:')) return;
    const rec = value as DesignBranch;
    if (rec && typeof rec.id === 'string' && rec.id !== MAIN_BRANCH) out.push(rec);
  });
  return [readRecord(doc, MAIN_BRANCH)!, ...out.sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id))];
}

export function getDesignBranch(doc: BogenDoc, id: string): DesignBranch {
  const rec = readRecord(doc, id);
  if (!rec) throw new Error(`No branch ${id} in this file. design_branch_list shows them.`);
  return rec;
}

function putBlob(doc: BogenDoc, content: DesignContent): string {
  const text = canonicalJson(content);
  let hash = contentHash(text);
  const map = root(doc);
  // Two different contents with one hash are next to impossible; should it happen, the second gets its own key.
  for (let n = 2; map.has(blobKey(hash)) && map.get(blobKey(hash)) !== text; n++) hash = `${contentHash(text)}-${n}`;
  if (!map.has(blobKey(hash))) map.set(blobKey(hash), text);
  return hash;
}

function readBlob(doc: BogenDoc, hash: string | undefined, what: string): DesignContent {
  const text = hash ? root(doc).get(blobKey(hash)) : undefined;
  if (typeof text !== 'string') throw new Error(`The saved content of ${what} is not in this file any more.`);
  const content = JSON.parse(text) as unknown;
  assertContent(content);
  return content;
}

/** The content of a branch: the live design when it is checked out, else its snapshot. */
export function branchContent(doc: BogenDoc, id: string): DesignContent {
  const rec = getDesignBranch(doc, id);
  if (currentBranchId(doc) === id) return docToContent(doc);
  if (id === MAIN_BRANCH && !rec.head) return docToContent(doc);
  return readBlob(doc, rec.head, `the branch "${rec.name}"`);
}

/** The hash of what a branch holds now, for telling whether it changed. */
export function branchHash(doc: BogenDoc, id: string): string {
  const rec = getDesignBranch(doc, id);
  if (currentBranchId(doc) === id || (id === MAIN_BRANCH && !rec.head)) return designHash(docToContent(doc));
  return rec.head!.replace(/-\d+$/, '');
}

/** Whether a branch differs from where it started. */
export function branchChanged(doc: BogenDoc, id: string): boolean {
  const rec = getDesignBranch(doc, id);
  if (!rec.base) return false;
  return branchHash(doc, id) !== rec.base.replace(/-\d+$/, '');
}

/**
 * Whether a branch differs from where it started in anything besides one meta key: the key is read as it was in the
 * branch's base for the comparison. Reads only; nothing in the document changes, not even for a moment. Used for a
 * language version whose run set the branch's language and then failed (run-intent.ts on the server).
 */
export function branchChangedBesidesMeta(doc: BogenDoc, id: string, key: string): boolean {
  const rec = getDesignBranch(doc, id);
  if (!rec.base) return false;
  let base: DesignContent;
  try {
    base = readBlob(doc, rec.base, `the start of "${rec.name}"`);
  } catch {
    return branchChanged(doc, id);
  }
  const now = JSON.parse(JSON.stringify(branchContent(doc, id))) as DesignContent;
  const was = base.extra?.meta?.[key];
  const meta = { ...(now.extra?.meta ?? {}) };
  if (was === undefined) delete meta[key];
  else meta[key] = was;
  const extra = { ...(now.extra ?? {}) };
  if (Object.keys(meta).length) extra.meta = meta;
  else delete extra.meta;
  const { extra: _extra, ...rest } = now;
  const compared: DesignContent = Object.keys(extra).length ? { ...rest, extra } : rest;
  return designHash(compared) !== rec.base.replace(/-\d+$/, '');
}

/** Lets go of snapshots nothing refers to, and of the snapshots of branches decided long ago. */
function collect(doc: BogenDoc): void {
  const map = root(doc);
  const all = listDesignBranches(doc);
  // Only a branch whose content is kept elsewhere for good (a named commit in the file's History) lets go of its
  // snapshots. Anything else, imported work above all, stays however old it is.
  const decided = all.filter((b) => b.status !== 'open' && !b.pruned).sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
  for (const old of decided.slice(MAX_DECIDED_KEPT).filter((b) => b.archivedAs)) {
    const { head: _h, base: _b, mergeUndo: _u, ...rest } = old;
    saveRecord(doc, { ...rest, pruned: true });
  }
  const used = new Set<string>();
  for (const b of listDesignBranches(doc)) for (const h of [b.head, b.base, b.mergeUndo]) if (h) used.add(blobKey(h));
  for (const key of [...map.keys()]) if (key.startsWith('blob:') && !used.has(key)) map.delete(key);
}

function cleanName(name: string): string {
  const out = name.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!out) throw new Error('A branch needs a name the person can read, such as "Warmer night".');
  return out;
}

export interface CreateBranchInput {
  name: string;
  by: string;
  /** The branch to start from. The checked-out one when left out. */
  from?: string;
  /** Check the new branch out, so that the next edits land in it. */
  checkout?: boolean;
  note?: string;
  conversation?: string;
  checkpoint?: string;
  /** Content of its own, for a version imported from another file; otherwise it starts as its parent. */
  content?: DesignContent;
  imported?: DesignBranch['imported'];
}

/**
 * Starts a branch. An open branch of the same name from the same parent is returned rather than made twice, so that
 * a retry or a second agent asking for "Warmer night" lands in the same one.
 */
export function createDesignBranch(doc: BogenDoc, input: CreateBranchInput, origin?: unknown): { branch: DesignBranch; reused: boolean } {
  const name = cleanName(input.name);
  const from = input.from ?? currentBranchId(doc);
  const parent = getDesignBranch(doc, from);
  if (parent.status !== 'open') throw new Error(`The branch "${parent.name}" was ${parent.status}; start from an open one.`);
  const open = listDesignBranches(doc).filter((b) => b.status === 'open' && b.id !== MAIN_BRANCH);
  // Names are unique among a file's open branches: the same name is the same branch, wherever it started.
  const same = !input.content ? open.find((b) => (!input.from || b.parent === from) && b.name.toLowerCase() === name.toLowerCase()) : undefined;
  if (same) {
    if (input.checkout) switchDesignBranch(doc, same.id, origin);
    return { branch: getDesignBranch(doc, same.id), reused: true };
  }
  if (open.length >= MAX_OPEN_BRANCHES) throw new Error(`This file has ${open.length} open branches already. Nothing was made: the person merges or discards one first.`);
  const id = `br${newId(8)}`;
  doc.transact(() => {
    const parentContent = branchContent(doc, from);
    const base = putBlob(doc, parentContent);
    const head = input.content ? putBlob(doc, input.content) : base;
    if (!root(doc).has(recordKey(MAIN_BRANCH))) saveRecord(doc, mainRecord());
    saveRecord(doc, {
      id, name, parent: from, status: 'open', by: input.by, at: Date.now(), seq: nextSeq(doc), base, head,
      ...(input.note ? { note: input.note.slice(0, 500) } : {}), ...(input.conversation ? { conversation: input.conversation } : {}),
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}), ...(input.imported ? { imported: input.imported } : {}),
    });
    if (input.checkout) switchDesignBranch(doc, id, origin);
  }, origin);
  return { branch: getDesignBranch(doc, id), reused: false };
}

/**
 * Checks out a branch: what is live now is kept as the snapshot of the branch it belongs to, and the branch's own
 * content becomes the live design. One transaction; nothing of either is lost.
 */
export function switchDesignBranch(doc: BogenDoc, id: string, origin?: unknown): DesignBranch {
  const target = getDesignBranch(doc, id);
  if (target.status !== 'open') throw new Error(`The branch "${target.name}" was ${target.status}. Restore it first.`);
  const current = currentBranchId(doc);
  if (current === id) return target;
  doc.transact(() => {
    stampCheckout(doc, id);
    const leaving = getDesignBranch(doc, current);
    const content = id === MAIN_BRANCH && !target.head ? docToContent(doc) : readBlob(doc, target.head, `the branch "${target.name}"`);
    saveRecord(doc, { ...leaving, head: putBlob(doc, docToContent(doc)), updatedAt: Date.now() });
    applyContent(doc, content);
    const { head: _head, ...rest } = getDesignBranch(doc, id);
    saveRecord(doc, rest);
    root(doc).set('current', id);
    labelChange(doc, { label: `Switched to the branch "${target.name}"` });
    collect(doc);
  }, origin);
  return getDesignBranch(doc, id);
}

export function renameDesignBranch(doc: BogenDoc, id: string, name: string, origin?: unknown): DesignBranch {
  const rec = getDesignBranch(doc, id);
  doc.transact(() => saveRecord(doc, { ...rec, name: cleanName(name), updatedAt: Date.now() }), origin);
  return getDesignBranch(doc, id);
}

// ---------------------------------------------------------------- three-way merge

type Keyed = Map<string, string>;

const keyed = <T>(items: readonly T[] | undefined, key: (t: T) => string): Keyed => new Map((items ?? []).map((t) => [key(t), canonicalJson(t)]));
const keyedRecord = (record: Record<string, unknown> | undefined): Keyed => new Map(Object.entries(record ?? {}).map(([k, v]) => [k, canonicalJson(v)]));

interface MergeOutcome { content: DesignContent; conflicts: BranchConflict[] }

function side(base: string | undefined, value: string | undefined): 'changed' | 'removed' | 'added' {
  if (base === undefined) return 'added';
  return value === undefined ? 'removed' : 'changed';
}

const byOrder = (a: { order: string; id: string }, b: { order: string; id: string }) => (a.order !== b.order ? (a.order < b.order ? -1 : 1) : a.id.localeCompare(b.id));

/** Pages in order, and layers parents before children, siblings in their order, as content keeps them. Unreachable layers are left out. */
function orderTree(pages: DesignContent['pages'], nodes: Iterable<ContentNode>): { pages: DesignContent['pages']; nodes: ContentNode[]; placed: Set<string> } {
  const kids = new Map<string, ContentNode[]>();
  for (const n of nodes) {
    const list = kids.get(n.parent) ?? [];
    list.push(n);
    kids.set(n.parent, list);
  }
  for (const list of kids.values()) list.sort(byOrder);
  const ordered: ContentNode[] = [];
  const placed = new Set<string>();
  const walk = (parent: string) => {
    for (const n of kids.get(parent) ?? []) {
      if (placed.has(n.id)) continue;
      placed.add(n.id);
      ordered.push(n);
      walk(n.id);
    }
  };
  const sorted = [...pages].sort(byOrder);
  for (const p of sorted) walk(p.id);
  for (const parent of [...kids.keys()].filter((k) => k.startsWith('lib:')).sort()) walk(parent);
  return { pages: sorted, nodes: ordered, placed };
}

/**
 * Merges what a branch changed into its parent's content. `base` is the parent when the branch started, `primary` the
 * parent now, `branch` the branch now. Tokens by name, layers and pages by id, settings by map and key: a change on
 * one side alone is taken, the same change on both is one change, and a different change on both is a conflict,
 * settled only by `resolve`.
 */
export function mergeDesignContent(base: DesignContent, primary: DesignContent, branch: DesignContent, resolve?: BranchResolution): MergeOutcome {
  const conflicts: BranchConflict[] = [];
  const choose = (key: string): BranchSide | undefined => (typeof resolve === 'string' ? resolve : resolve?.[key]);
  const names = new Map<string, string>();
  for (const n of [...base.nodes, ...primary.nodes, ...branch.nodes]) names.set(n.id, n.name || n.type);
  const pageNames = new Map<string, string>();
  for (const p of [...base.pages, ...primary.pages, ...branch.pages]) pageNames.set(p.id, p.name);

  const merge3 = (kind: BranchConflict['kind'], prefix: string, b: Keyed, o: Keyed, t: Keyed, label: (k: string) => string): Keyed => {
    const out: Keyed = new Map();
    for (const k of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
      const vb = b.get(k);
      const vo = o.get(k);
      const vt = t.get(k);
      let pick: string | undefined;
      if (vo === vt) pick = vo;
      else if (vo === vb) pick = vt;
      else if (vt === vb) pick = vo;
      else {
        const key = `${prefix}:${k}`;
        const chosen = choose(key);
        if (!chosen) {
          conflicts.push({ key, kind, label: label(k), primary: side(vb, vo), branch: side(vb, vt) });
          pick = vo;
        } else pick = chosen === 'branch' ? vt : vo;
      }
      if (pick !== undefined) out.set(k, pick);
    }
    return out;
  };

  const tokens = merge3('token', 'token', keyed(base.tokens, (t) => t.name), keyed(primary.tokens, (t) => t.name), keyed(branch.tokens, (t) => t.name), (k) => `token ${k}`);
  const pages = merge3('page', 'page', keyed(base.pages, (p) => p.id), keyed(primary.pages, (p) => p.id), keyed(branch.pages, (p) => p.id), (k) => `page "${pageNames.get(k) ?? k}"`);
  const nodes = merge3('node', 'node', keyed(base.nodes, (n) => n.id), keyed(primary.nodes, (n) => n.id), keyed(branch.nodes, (n) => n.id), (k) => `layer "${names.get(k) ?? k}"`);
  const interactions = merge3('interaction', 'interaction', keyed(base.interactionStates, (i) => i.artboardId), keyed(primary.interactionStates, (i) => i.artboardId), keyed(branch.interactionStates, (i) => i.artboardId), (k) => `interaction states of "${names.get(k) ?? k}"`);
  const repeats = merge3('repeat', 'repeat', keyedRecord(base.repeats), keyedRecord(primary.repeats), keyedRecord(branch.repeats), (k) => `live data of "${names.get(k) ?? k}"`);
  const keyframes = merge3('keyframes', 'keyframes', keyedRecord({ all: base.keyframes ?? [] }), keyedRecord({ all: primary.keyframes ?? [] }), keyedRecord({ all: branch.keyframes ?? [] }), () => 'keyframes');
  const extraNames = new Set([...Object.keys(base.extra ?? {}), ...Object.keys(primary.extra ?? {}), ...Object.keys(branch.extra ?? {})]);
  const extra: Record<string, Record<string, unknown>> = {};
  for (const map of extraNames) {
    const of = (c: DesignContent) => keyedRecord(c.extra?.[map]);
    const merged = merge3('setting', `${map}`, of(base), of(primary), of(branch), (k) => (map === 'meta' ? `file setting "${k}"` : `${map} "${k}"`));
    if (merged.size) extra[map] = Object.fromEntries([...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, JSON.parse(v) as unknown]));
  }

  // Layers whose parent went on one side while the other side added or kept something inside: a conflict of its own,
  // since keeping the layer means keeping its parent.
  const pageIds = new Set(pages.keys());
  const nodeMap = new Map([...nodes.entries()].map(([k, v]) => [k, JSON.parse(v) as ContentNode]));
  const fromSides = new Map<string, ContentNode>();
  for (const n of [...base.nodes, ...primary.nodes, ...branch.nodes]) fromSides.set(n.id, n);
  const reaches = (id: string, seen = new Set<string>()): boolean => {
    const n = nodeMap.get(id);
    if (!n || seen.has(id)) return false;
    seen.add(id);
    return pageIds.has(n.parent) || n.parent.startsWith('lib:') || reaches(n.parent, seen);
  };
  for (const [id, n] of [...nodeMap]) {
    if (reaches(id)) continue;
    const key = `orphan:${id}`;
    const chosen = choose(key);
    if (chosen === 'branch') {
      // Keep it, with its ancestors as the branch (or the base) had them.
      let parent = n.parent;
      const branchNodes = new Map(branch.nodes.map((x) => [x.id, x]));
      const baseNodes = new Map(base.nodes.map((x) => [x.id, x]));
      while (!pageIds.has(parent) && !parent.startsWith('lib:') && !nodeMap.has(parent)) {
        const up = branchNodes.get(parent) ?? baseNodes.get(parent);
        if (!up) break;
        nodeMap.set(up.id, up);
        parent = up.parent;
      }
      if (!pageIds.has(parent) && !parent.startsWith('lib:') && !nodeMap.has(parent)) nodeMap.delete(id);
    } else if (chosen === 'primary') nodeMap.delete(id);
    else {
      const parentGone = !nodeMap.has(n.parent);
      if (parentGone) conflicts.push({ key, kind: 'node', label: `layer "${n.name || n.type}" inside "${fromSides.get(n.parent)?.name ?? names.get(n.parent) ?? pageNames.get(n.parent) ?? n.parent}", which the other side removed`, primary: 'removed', branch: 'changed' });
      nodeMap.delete(id);
    }
  }
  const pageList = [...pages.values()].map((v) => JSON.parse(v) as DesignContent['pages'][number]);
  const { pages: sortedPages, nodes: ordered, placed } = orderTree(pageList, nodeMap.values());
  const fonts = new Map<string, DesignContent['fontFaces'][number]>();
  for (const f of [...primary.fontFaces, ...branch.fontFaces]) fonts.set(canonicalJson(f), f);
  const repeatOut = Object.fromEntries([...repeats.entries()].filter(([k]) => placed.has(k)).map(([k, v]) => [k, JSON.parse(v)]));
  const content: DesignContent = {
    format: 1,
    pages: sortedPages.length ? sortedPages : primary.pages,
    nodes: ordered,
    tokens: [...tokens.values()].map((v) => JSON.parse(v) as DesignContent['tokens'][number]).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    keyframes: JSON.parse(keyframes.get('all') ?? '[]') as string[],
    fontFaces: [...fonts.values()],
    interactionStates: [...interactions.values()].map((v) => JSON.parse(v) as DesignContent['interactionStates'][number]).filter((i) => placed.has(i.artboardId)),
    ...(Object.keys(repeatOut).length ? { repeats: repeatOut } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
  return { content, conflicts };
}

/** What merging a branch would do, without doing it: its conflicts, and whether its parent changed since it started. */
export function previewMerge(doc: BogenDoc, id: string): { branch: DesignBranch; into: DesignBranch; conflicts: BranchConflict[]; parentChanged: boolean; branchChanged: boolean } {
  const rec = getDesignBranch(doc, id);
  if (!rec.parent || rec.status !== 'open') throw new Error(rec.parent ? `The branch "${rec.name}" was ${rec.status} already.` : 'Main has nothing to merge into.');
  const into = getDesignBranch(doc, rec.parent);
  if (into.status !== 'open') throw new Error(`"${rec.name}" started from "${into.name}", which was ${into.status}. Restore it first, or merge into main by hand.`);
  const base = readBlob(doc, rec.base, `where "${rec.name}" started`);
  const { conflicts } = mergeDesignContent(base, branchContent(doc, into.id), branchContent(doc, id));
  return { branch: rec, into, conflicts, parentChanged: branchHash(doc, into.id) !== rec.base!.replace(/-\d+$/, ''), branchChanged: branchChanged(doc, id) };
}

/**
 * The person's decision: the branch goes into its parent, which is then checked out. Conflicts stop it unless
 * `resolve` settles every one. One transaction; the parent's content before it is kept so that `undoMerge` can go back.
 */
export function mergeDesignBranch(doc: BogenDoc, id: string, options: { by: string; resolve?: BranchResolution }, origin?: unknown): { branch: DesignBranch; into: DesignBranch } {
  const rec = getDesignBranch(doc, id);
  if (!rec.parent || rec.status !== 'open') throw new Error(rec.parent ? `The branch "${rec.name}" was ${rec.status} already.` : 'Main has nothing to merge into.');
  const into = getDesignBranch(doc, rec.parent);
  if (into.status !== 'open') throw new Error(`"${rec.name}" started from "${into.name}", which was ${into.status}.`);
  const base = readBlob(doc, rec.base, `where "${rec.name}" started`);
  const primary = branchContent(doc, into.id);
  const theirs = branchContent(doc, id);
  const { content, conflicts } = mergeDesignContent(base, primary, theirs, options.resolve);
  if (conflicts.length) throw new BranchConflictError(conflicts);
  doc.transact(() => {
    const before = putBlob(doc, primary);
    const kept = putBlob(doc, theirs);
    const current = currentBranchId(doc);
    let mergedHash: string;
    if (current === into.id || current === id) {
      if (current !== into.id) stampCheckout(doc, into.id);
      applyContent(doc, content);
      const { head: _h, ...rest } = getDesignBranch(doc, into.id);
      saveRecord(doc, { ...rest, updatedAt: Date.now() });
      root(doc).set('current', into.id);
      mergedHash = designHash(docToContent(doc));
    } else {
      const head = putBlob(doc, content);
      saveRecord(doc, { ...getDesignBranch(doc, into.id), head, updatedAt: Date.now() });
      mergedHash = head.replace(/-\d+$/, '');
    }
    saveRecord(doc, { ...getDesignBranch(doc, id), status: 'merged', head: kept, mergeUndo: before, mergedHash, decidedAt: Date.now(), decidedBy: options.by });
    labelChange(doc, { label: `Merged the branch "${rec.name}" into "${into.name}"` });
    collect(doc);
  }, origin);
  return { branch: getDesignBranch(doc, id), into: getDesignBranch(doc, into.id) };
}

/** Takes a merge back while its parent is as the merge left it: the parent returns to before, the branch opens again. */
export function undoMerge(doc: BogenDoc, id: string, origin?: unknown): DesignBranch {
  const rec = getDesignBranch(doc, id);
  if (rec.status !== 'merged' || !rec.mergeUndo || !rec.parent) throw new Error(`The branch "${rec.name}" has no merge to take back.`);
  const into = getDesignBranch(doc, rec.parent);
  if (branchHash(doc, into.id) !== rec.mergedHash) throw new Error(`"${into.name}" changed after the merge, so it cannot simply go back. Use the file's History to restore the commit taken before the merge.`);
  const before = readBlob(doc, rec.mergeUndo, `"${into.name}" before the merge`);
  doc.transact(() => {
    if (currentBranchId(doc) === into.id) {
      stampCheckout(doc, into.id);
      applyContent(doc, before);
    }
    else saveRecord(doc, { ...getDesignBranch(doc, into.id), head: putBlob(doc, before) });
    const { mergeUndo: _u, mergedHash: _m, decidedAt: _d, decidedBy: _b, ...rest } = getDesignBranch(doc, id);
    saveRecord(doc, { ...rest, status: 'open', updatedAt: Date.now() });
    labelChange(doc, { label: `Took back the merge of "${rec.name}"` });
    collect(doc);
  }, origin);
  return getDesignBranch(doc, id);
}

/** The person's decision: the branch is set aside. Its content stays for a while, so that it can be restored. */
export function discardDesignBranch(doc: BogenDoc, id: string, by: string, origin?: unknown): DesignBranch {
  const rec = getDesignBranch(doc, id);
  if (id === MAIN_BRANCH) throw new Error('Main cannot be discarded.');
  if (rec.status !== 'open') throw new Error(`The branch "${rec.name}" was ${rec.status} already.`);
  if (listDesignBranches(doc).some((b) => b.status === 'open' && b.parent === id)) throw new Error(`Other branches started from "${rec.name}". Merge or discard those first.`);
  doc.transact(() => {
    if (currentBranchId(doc) === id) switchDesignBranch(doc, rec.parent ?? MAIN_BRANCH, origin);
    saveRecord(doc, { ...getDesignBranch(doc, id), status: 'discarded', decidedAt: Date.now(), decidedBy: by });
    collect(doc);
  }, origin);
  return getDesignBranch(doc, id);
}

/** Opens a discarded branch again, with the content it had. */
export function restoreDesignBranch(doc: BogenDoc, id: string, origin?: unknown): DesignBranch {
  const rec = getDesignBranch(doc, id);
  if (rec.status !== 'discarded') throw new Error(`The branch "${rec.name}" is ${rec.status}, not discarded.`);
  if (rec.pruned || !rec.head) throw new Error(`The content of "${rec.name}" was let go; look for it in the file's History.`);
  doc.transact(() => {
    const { decidedAt: _d, decidedBy: _b, ...rest } = rec;
    saveRecord(doc, { ...rest, status: 'open', parent: rec.parent && getDesignBranch(doc, rec.parent).status === 'open' ? rec.parent : MAIN_BRANCH, updatedAt: Date.now() });
  }, origin);
  return getDesignBranch(doc, id);
}

/** A branch as a person or an agent reads it. */
export function describeBranch(doc: BogenDoc, b: DesignBranch): { id: string; name: string; parent: string | null; status: BranchStatus; current: boolean; changed: boolean; by: string; at: string | null; note?: string; imported?: DesignBranch['imported']; canRestore?: boolean; held?: { id: string; at: string; from: string; bytes: number; layers: string[]; inFile: boolean; path?: string }[] } {
  const current = currentBranchId(doc) === b.id;
  let changed = false;
  try {
    changed = b.status === 'open' && b.id !== MAIN_BRANCH ? branchChanged(doc, b.id) : false;
  } catch {
    changed = false;
  }
  return {
    id: b.id, name: b.name, parent: b.parent, status: b.status, current, changed, by: b.by, at: b.at ? new Date(b.at).toISOString() : null,
    ...(b.note ? { note: b.note } : {}), ...(b.imported ? { imported: b.imported } : {}),
    ...(b.status === 'discarded' ? { canRestore: Boolean(b.head && !b.pruned) } : {}),
    ...(b.held?.length ? { held: b.held.map((h) => ({ id: h.id, at: new Date(h.at).toISOString(), from: h.from, bytes: h.bytes, layers: h.layers, inFile: Boolean(h.asset), ...(h.path ? { path: h.path } : {}) })) } : {}),
  };
}

/** Records that the content of a branch is kept in History for good, so that its snapshots may go when it is old. */
export function markBranchArchived(doc: BogenDoc, id: string, commitId: string, origin?: unknown): void {
  doc.transact(() => saveRecord(doc, { ...getDesignBranch(doc, id), archivedAs: commitId }), origin);
}

/** Every asset a branch's snapshots use, so that a download, a sync or a clean-up of assets keeps them too. */
export function branchAssetNames(doc: BogenDoc): string[] {
  const out = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(/bogen-asset:([0-9a-f]{64}\.[a-z0-9]{1,8})/g)) out.add(m[1]!);
  };
  root(doc).forEach((value, key) => {
    if (key.startsWith('blob:') && typeof value === 'string') scan(value);
    // A held update may be the only place a picture is named: its bytes are a Yjs update, whose strings read as text.
    if (key.startsWith('b:')) {
      for (const held of (value as DesignBranch).held ?? []) {
        scan(held.asset ?? '');
        for (const a of held.assets ?? []) out.add(a);
      }
    }
  });
  return [...out];
}


// ---------------------------------------------------------------- checkouts and replicas that did not see them

/**
 * Where each checkout happened, in the document's own causal order: the replica that switched and its clock just
 * before. Another replica has seen a checkout exactly when its state vector reaches past that clock, so a device that
 * comes back after editing offline can be told apart from one that edited the branch it sees now.
 */
export interface CheckoutStamp { branch: string; epoch: string; client: number; clock: number; at: number }
const MAX_STAMPS = 32;

function stampCheckout(doc: BogenDoc, branch: string): void {
  const map = root(doc);
  const stamp: CheckoutStamp = { branch, epoch: newId(8), client: doc.y.clientID, clock: Y.getState(doc.y.store, doc.y.clientID), at: Date.now() };
  const list = (Array.isArray(map.get('checkouts')) ? map.get('checkouts') as CheckoutStamp[] : []).slice(-(MAX_STAMPS - 1));
  map.set('checkouts', [...list, stamp]);
}

export function checkoutStamps(doc: BogenDoc): CheckoutStamp[] {
  const raw = root(doc).get('checkouts');
  return Array.isArray(raw) ? (raw as CheckoutStamp[]).filter((s) => s && typeof s.branch === 'string' && typeof s.client === 'number') : [];
}

/** The latest checkout's epoch: changes on every switch, also back to a branch checked out before. */
export function checkoutEpoch(doc: BogenDoc): string {
  return checkoutStamps(doc).at(-1)?.epoch ?? 'initial';
}

/**
 * What a replica with this state vector last saw checked out, and whether it missed a later checkout. Its own edits
 * made since were made on `known`, whatever is live now.
 */
export function checkoutSeenBy(doc: BogenDoc, remoteSv: Map<number, number>): { stale: boolean; known: string; latest: string } {
  const stamps = checkoutStamps(doc);
  const latest = currentBranchId(doc);
  const seen = (s: CheckoutStamp) => (remoteSv.get(s.client) ?? 0) > s.clock;
  if (!stamps.length) return { stale: false, known: latest, latest };
  const newestSeen = [...stamps].reverse().find(seen);
  const known = newestSeen?.branch ?? MAIN_BRANCH;
  return { stale: !seen(stamps.at(-1)!) && known !== latest, known, latest };
}

/** One field-level difference between two versions of a design. */
export type DesignOp =
  | { k: 'token'; name: string; value: DesignContent['tokens'][number] | null }
  | { k: 'page'; id: string; value: DesignContent['pages'][number] | null }
  | { k: 'node'; id: string; value: ContentNode | null }
  | { k: 'fields'; id: string; set: Record<string, unknown>; unset: string[]; style: Record<string, string>; unstyle: string[] }
  | { k: 'extra'; map: string; key: string; value: unknown }
  | { k: 'keyframes'; value: string[] }
  | { k: 'interaction'; id: string; value: DesignContent['interactionStates'][number] | null }
  | { k: 'tokenField'; name: string; field: string; value: unknown }
  | { k: 'repeat'; id: string; value: unknown }
  | { k: 'font'; value: DesignContent['fontFaces'][number] };

/** What changed from `a` to `b`, layer fields one by one, so that it can be laid onto another version. */
export function designDiff(a: DesignContent, b: DesignContent): DesignOp[] {
  const ops: DesignOp[] = [];
  const same = (x: unknown, y: unknown) => canonicalJson(x) === canonicalJson(y);
  const byKey = <T>(xs: readonly T[], key: (t: T) => string) => new Map(xs.map((x) => [key(x), x]));
  const ta = byKey(a.tokens, (t) => t.name);
  const tb = byKey(b.tokens, (t) => t.name);
  for (const k of new Set([...ta.keys(), ...tb.keys()])) if (!same(ta.get(k), tb.get(k))) ops.push({ k: 'token', name: k, value: tb.get(k) ?? null });
  const pa = byKey(a.pages, (p) => p.id);
  const pb = byKey(b.pages, (p) => p.id);
  for (const k of new Set([...pa.keys(), ...pb.keys()])) if (!same(pa.get(k), pb.get(k))) ops.push({ k: 'page', id: k, value: pb.get(k) ?? null });
  const na = byKey(a.nodes, (n) => n.id);
  const nb = byKey(b.nodes, (n) => n.id);
  for (const k of new Set([...na.keys(), ...nb.keys()])) {
    const x = na.get(k);
    const y = nb.get(k);
    if (!x || !y) {
      if (x || y) ops.push({ k: 'node', id: k, value: y ?? null });
      continue;
    }
    if (same(x, y)) continue;
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (f === 'style' || f === 'id') continue;
      if (!(f in y)) unset.push(f);
      else if (!same(x[f], y[f])) set[f] = y[f];
    }
    const style: Record<string, string> = {};
    const unstyle: string[] = [];
    for (const s of new Set([...Object.keys(x.style), ...Object.keys(y.style)])) {
      if (!(s in y.style)) unstyle.push(s);
      else if (x.style[s] !== y.style[s]) style[s] = y.style[s]!;
    }
    ops.push({ k: 'fields', id: k, set, unset, style, unstyle });
  }
  for (const map of new Set([...Object.keys(a.extra ?? {}), ...Object.keys(b.extra ?? {})])) {
    const xa = a.extra?.[map] ?? {};
    const xb = b.extra?.[map] ?? {};
    for (const key of new Set([...Object.keys(xa), ...Object.keys(xb)])) if (!same(xa[key], xb[key])) ops.push({ k: 'extra', map, key, value: xb[key] });
  }
  if (!same(a.keyframes ?? [], b.keyframes ?? [])) ops.push({ k: 'keyframes', value: b.keyframes ?? [] });
  const ra = a.repeats ?? {};
  const rb = b.repeats ?? {};
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) if (!same(ra[k], rb[k])) ops.push({ k: 'repeat', id: k, value: rb[k] ?? null });
  // Fonts are only ever added (content.ts), so only new ones are a difference.
  const fa = new Set((a.fontFaces ?? []).map((f) => canonicalJson(f)));
  for (const f of b.fontFaces ?? []) if (!fa.has(canonicalJson(f))) ops.push({ k: 'font', value: f });
  const ia = byKey(a.interactionStates ?? [], (i) => i.artboardId);
  const ib = byKey(b.interactionStates ?? [], (i) => i.artboardId);
  for (const k of new Set([...ia.keys(), ...ib.keys()])) if (!same(ia.get(k), ib.get(k))) ops.push({ k: 'interaction', id: k, value: ib.get(k) ?? null });
  return ops;
}

/** Lays the differences onto another version. A field of a layer that version does not have is skipped and counted. */
export function applyDesignDiff(target: DesignContent, ops: readonly DesignOp[]): { content: DesignContent; skipped: number } {
  const c = JSON.parse(JSON.stringify(target)) as DesignContent;
  const tokens = new Map(c.tokens.map((t) => [t.name, t]));
  const pages = new Map(c.pages.map((p) => [p.id, p]));
  const nodes = new Map(c.nodes.map((n) => [n.id, n]));
  const interactions = new Map((c.interactionStates ?? []).map((i) => [i.artboardId, i]));
  const extra: Record<string, Record<string, unknown>> = c.extra ?? {};
  const repeats: Record<string, unknown> = { ...(c.repeats ?? {}) };
  const fonts = new Map((c.fontFaces ?? []).map((f) => [canonicalJson(f), f]));
  let skipped = 0;
  for (const op of ops) {
    if (op.k === 'token') op.value ? tokens.set(op.name, op.value) : tokens.delete(op.name);
    else if (op.k === 'page') op.value ? pages.set(op.id, op.value) : pages.delete(op.id);
    else if (op.k === 'node') op.value ? nodes.set(op.id, op.value) : nodes.delete(op.id);
    else if (op.k === 'fields') {
      const n = nodes.get(op.id);
      if (!n) {
        skipped++;
        continue;
      }
      const next: ContentNode = { ...n, ...op.set, style: { ...n.style, ...op.style } };
      for (const f of op.unset) delete next[f];
      for (const s of op.unstyle) delete next.style[s];
      nodes.set(op.id, next);
    } else if (op.k === 'extra') {
      const m = extra[op.map] ?? (extra[op.map] = {});
      if (op.value === undefined) delete m[op.key];
      else m[op.key] = op.value;
    } else if (op.k === 'keyframes') c.keyframes = op.value;
    else if (op.k === 'interaction') op.value ? interactions.set(op.id, op.value) : interactions.delete(op.id);
    else if (op.k === 'repeat') {
      if (op.value === null || op.value === undefined) delete repeats[op.id];
      else repeats[op.id] = op.value;
    } else if (op.k === 'font') fonts.set(canonicalJson(op.value), op.value);
    else if (op.k === 'tokenField') {
      const t = tokens.get(op.name);
      if (t) tokens.set(op.name, { ...t, [op.field]: op.value });
      else skipped++;
    }
  }
  const { pages: sorted, nodes: ordered, placed } = orderTree([...pages.values()], nodes.values());
  skipped += nodes.size - placed.size;
  const out: DesignContent = {
    ...c, pages: sorted.length ? sorted : c.pages, nodes: ordered, tokens: [...tokens.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    interactionStates: [...interactions.values()].filter((i) => placed.has(i.artboardId)),
    fontFaces: [...fonts.values()],
  };
  const keptRepeats = Object.fromEntries(Object.entries(repeats).filter(([k]) => placed.has(k))) as DesignContent['repeats'];
  if (keptRepeats && Object.keys(keptRepeats).length) out.repeats = keptRepeats;
  else delete out.repeats;
  if (Object.keys(extra).length) out.extra = extra;
  else delete out.extra;
  return { content: out, skipped };
}

/**
 * Edits a replica made while it had not seen the latest checkout were made on another branch than the one live now.
 * Given the design before and after such edits arrived, they are laid onto the branch the replica was on, which is
 * not checked out, and the live design gets back what it had, so that no palette or layer edit of one branch ends up
 * in another. When the replica's branch is not open any more, the edits go into one recovery branch per replica,
 * started from main, which later edits from the same replica join rather than adding more. Layers whose text the
 * replica typed into are left out of what is laid on (`unsafe`): a character merge against a checkout cannot be read
 * back reliably, and the caller keeps the raw update for those. Null when nothing of the design changed or the
 * replica was on the branch that is live now.
 */
export function divertStaleEdits(doc: BogenDoc, before: DesignContent, after: DesignContent, input: { known: string; from: string; source?: string; by: string; lost?: DesignOp[]; unsafe?: string[]; held?: HeldUpdate }, origin?: unknown): { branch: DesignBranch; skipped: number; routed: boolean; held: number } | null {
  if (input.known === currentBranchId(doc)) return null;
  const unsafe = new Set(input.unsafe ?? []);
  let held = 0;
  const ops = [...designDiff(before, after), ...(input.lost ?? [])].filter((op) => {
    if (!unsafe.size || (op.k !== 'node' && op.k !== 'fields') || !unsafe.has(op.id)) return true;
    held++;
    return false;
  });
  if (!ops.length && !held && !input.held) return null;
  const known = readRecord(doc, input.known);
  const from = input.from.slice(0, 40);
  // Recovery groups by the replica's stable identity; its name is only what a person reads.
  const source = (input.source ?? input.from).slice(0, 80);
  let out: { branch: DesignBranch; skipped: number; routed: boolean; held: number } | null = null;
  doc.transact(() => {
    let target: DesignBranch;
    let routed = true;
    if (known && known.status === 'open') target = known;
    else {
      routed = false;
      const existing = listDesignBranches(doc).find((b) => b.status === 'open' && b.recoveryOf === source);
      if (existing) target = existing;
      else {
        const id = `br${newId(8)}`;
        const base = putBlob(doc, branchContent(doc, MAIN_BRANCH));
        if (!root(doc).has(recordKey(MAIN_BRANCH))) saveRecord(doc, mainRecord());
        saveRecord(doc, {
          id, name: `Edits from ${from} while away`, parent: MAIN_BRANCH, status: 'open', by: input.by, at: Date.now(), seq: nextSeq(doc), base, head: base, recoveryOf: source,
          note: `Made by ${from} on "${known?.name ?? input.known}" before it saw a later checkout; that branch is not open any more, so they are kept here for the person to look at.`,
        });
        target = getDesignBranch(doc, id);
      }
    }
    const laid = applyDesignDiff(branchContent(doc, target.id), ops);
    const rec = getDesignBranch(doc, target.id);
    // What could not be laid on travels with the file, on the branch it belongs to, until the person looks at it.
    // Never trimmed: past MAX_HELD the caller refuses before anything changes (heldTarget).
    const heldList = input.held ? [...(rec.held ?? []).filter((h) => h.id !== input.held!.id), input.held] : rec.held;
    saveRecord(doc, { ...rec, head: putBlob(doc, laid.content), updatedAt: Date.now(), ...(heldList?.length ? { held: heldList } : {}) });
    // The live design returns to what it was, field by field, for what those edits touched.
    applyContent(doc, applyDesignDiff(docToContent(doc), designDiff(after, before)).content);
    labelChange(doc, { label: `Edits from ${from} went to "${target.name}", the branch they were made on` });
    collect(doc);
    out = { branch: getDesignBranch(doc, target.id), skipped: laid.skipped, routed, held };
  }, origin);
  return out;
}

/** The path of a shared type from its root: the root's name, then the keys down to it. */
function pathOf(type: Y.AbstractType<unknown>): string[] {
  const out: string[] = [];
  let t: Y.AbstractType<unknown> = type;
  while (t._item) {
    out.unshift(t._item.parentSub ?? '');
    t = t._item.parent as Y.AbstractType<unknown>;
  }
  out.unshift(Y.findRootTypeKey(t));
  return out;
}

/**
 * What an update did that the merged design does not show by itself, once it was applied to `doc`: values it set
 * that lost to a concurrent write (a replica that did not see a checkout wrote a field the checkout wrote too) and
 * layers whose text it typed into. Lost layer fields and styles, token fields and file settings come back as ops, so
 * that keeping the replica's edits apart does not lose the ones the merge order hid. Text typed into a layer merges
 * by character with the checkout's text and cannot be read back reliably, so those layers are named in `unsafe`;
 * so is a lost value of a kind not read here (a whole new object). The caller keeps the raw update for them.
 */
export function lostRemoteSets(doc: BogenDoc, update: Uint8Array): { ops: DesignOp[]; unsafe: string[]; unread: number } {
  const ops: DesignOp[] = [];
  const unsafe = new Set<string>();
  let unread = 0;
  const decoded = Y.decodeUpdate(update);
  for (const struct of decoded.structs) {
    if (!(struct instanceof Y.Item)) continue;
    let item: Y.Item;
    try {
      item = Y.getItem(doc.y.store, struct.id) as Y.Item;
    } catch {
      continue;
    }
    if (!item.parent) continue;
    const parentPath = pathOf(item.parent as Y.AbstractType<unknown>);
    // Characters of a layer's text (or any sequence inside a layer): merged, not lost, but not readable apart.
    if (item.parentSub === null) {
      if (parentPath[0] === 'nodes' && parentPath[1]) unsafe.add(parentPath[1]);
      continue;
    }
    if (!item.deleted || Y.isDeleted(decoded.ds, struct.id)) continue;
    const path = [...parentPath, item.parentSub];
    const [rootName, a, b, c] = path;
    // The losing value is gone from the merged document (garbage collected), but the update still carries it.
    if (!(struct.content instanceof Y.ContentAny)) {
      if (rootName === 'nodes' && a) unsafe.add(a);
      else unread++;
      continue;
    }
    const value = struct.content.getContent()[0];
    if (rootName === 'nodes' && a && b === 'style' && c && typeof value === 'string') ops.push({ k: 'fields', id: a, set: {}, unset: [], style: { [c]: value }, unstyle: [] });
    else if (rootName === 'nodes' && a && b && path.length === 3 && b !== 'style') ops.push({ k: 'fields', id: a, set: { [b]: value }, unset: [], style: {}, unstyle: [] });
    else if (rootName === 'tokens' && a && b && path.length === 3) ops.push({ k: 'tokenField', name: a, field: b, value });
    else if (rootName && !['nodes', 'tokens', 'pages', 'comments', BRANCHES_ROOT].includes(rootName) && a && a !== 'changeLabel' && path.length === 2) ops.push({ k: 'extra', map: rootName, key: a, value });
    else if (rootName !== 'comments' && rootName !== BRANCHES_ROOT) unread++;
  }
  return { ops, unsafe: [...unsafe], unread };
}

/** The person's choice: a held update was looked at (or applied by hand) and need not be kept in the file any more. */
export function dismissHeld(doc: BogenDoc, branchId: string, heldId: string, origin?: unknown): DesignBranch {
  const rec = getDesignBranch(doc, branchId);
  if (!rec.held?.some((h) => h.id === heldId)) throw new Error(`No held update ${heldId} on "${rec.name}".`);
  doc.transact(() => {
    const rest = rec.held!.filter((h) => h.id !== heldId);
    const { held: _h, ...base } = rec;
    saveRecord(doc, rest.length ? { ...base, held: rest } : base);
  }, origin);
  return getDesignBranch(doc, branchId);
}

/** The branch a stale update from this replica would go to, and how many updates it holds already: to refuse before anything changes. */
export function heldTarget(doc: BogenDoc, known: string, source: string): { branch: string | null; held: number } {
  const rec = readRecord(doc, known);
  const target = rec && rec.status === 'open' ? rec : listDesignBranches(doc).find((b) => b.status === 'open' && b.recoveryOf === source.slice(0, 80));
  return { branch: target?.id ?? null, held: target?.held?.length ?? 0 };
}
