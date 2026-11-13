import { newId, type BogenDoc, type BogenNode } from './doc.ts';
import { setLayerText } from './text-model.ts';
import { MAX_DIRECTION_LANES } from './run-limits.ts';
import { cleanVariation, type Variation } from './variations.ts';

const DECISION_PREFIX = 'proposal-decision:';
const MAX_DECISIONS = 500;
export interface ProposalDecision { source: string; decision: 'accepted' | 'discarded'; at: number }

/** A small synced receipt distinguishes a person's decision from coincidentally identical content. */
export function proposalDecision(doc: BogenDoc, id: string): ProposalDecision | undefined {
  const receipt = doc.meta.get(DECISION_PREFIX + id) as Partial<ProposalDecision> | undefined;
  return typeof receipt?.source === 'string' && (receipt.decision === 'accepted' || receipt.decision === 'discarded') && typeof receipt.at === 'number'
    ? receipt as ProposalDecision : undefined;
}

function rememberDecision(doc: BogenDoc, id: string, source: string, decision: ProposalDecision['decision']): void {
  doc.meta.set(DECISION_PREFIX + id, { source, decision, at: Date.now() } satisfies ProposalDecision);
  const receipts = [...doc.meta.keys()].filter(key => key.startsWith(DECISION_PREFIX))
    .map(key => ({ key, at: proposalDecision(doc, key.slice(DECISION_PREFIX.length))?.at ?? 0 }));
  if (receipts.length <= MAX_DECISIONS) return;
  receipts.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  for (const { key } of receipts.slice(0, receipts.length - MAX_DECISIONS)) doc.meta.delete(key);
}

/**
 * A proposal is a copy of a layer, next to it on the page, marked as such. An agent changes the copy with its
 * usual tools, and a person decides. Accepting puts the copy's content into the original layer, which keeps its
 * id, its place and any thread pinned to it, and happens in one transaction, so it is one undo step.
 */

/** Stored on the copy itself, so that undo, sync and deleting the layer all treat it as part of the layer. */
export interface ProposalMark {
  /** The layer this would replace. */
  of: string;
  /** Who made it. */
  by: string;
  note?: string;
  /** Directions made together share this, and accepting one discards the others. */
  group?: string;
  /** The size given at creation, so that accepting does not turn it into a change. */
  placed?: { width?: string; height?: string };
  at: number;
  /** Set on the copies of a race: which race and lane, and the lane's colour on the canvas. */
  race?: ProposalRace;
  /** Every layer of the copy to the layer of the original it was copied from, complete. Missing on older proposals. */
  map?: Record<string, string>;
  /** A fingerprint of every original layer at the moment of copying, to tell what changed on each side since. */
  base?: Record<string, string>;
  /** The revision this copy belongs to, when it was made as part of one. */
  revision?: string;
  /** How far it may go from the original, and which aspects it changes while the rest stays. */
  variation?: Variation;
}

export interface ProposalRace { id: string; lane: string; color: string }

function readRace(raw: unknown): ProposalRace | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  // The colour reaches CSS, and the mark may come from another device.
  return typeof r.id === 'string' && typeof r.lane === 'string' && typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? { id: r.id, lane: r.lane, color: r.color } : undefined;
}

export function proposalMark(doc: BogenDoc, id: string): ProposalMark | undefined {
  const mark = doc.nodes.get(id)?.get('proposal');
  return mark && typeof mark === 'object' ? mark as ProposalMark : undefined;
}

export interface ProposalInfo {
  id: string;
  of: string;
  by: string;
  note?: string;
  group?: string;
  at: number;
  name: string;
  pageId?: string;
  /** False when the layer it would replace is gone. Such a proposal can only be discarded. */
  sourceExists: boolean;
  race?: ProposalRace;
  variation?: Variation;
}

/** Where a layer sits in its parent, as opposed to what it looks like. These stay the original's when accepting. */
const PLACEMENT = new Set(['position', 'left', 'top', 'right', 'bottom', 'inset', 'zIndex', 'margin', 'marginLeft', 'marginRight', 'marginTop', 'marginBottom', 'alignSelf', 'justifySelf', 'gridArea', 'gridColumn', 'gridRow', 'order', 'translate']);

export interface Rect { x: number; y: number; w: number; h: number }

export function listProposals(doc: BogenDoc, pageId?: string): ProposalInfo[] {
  const out: ProposalInfo[] = [];
  doc.nodes.forEach((m, id) => {
    const mark = proposalMark(doc, id);
    if (!mark) return;
    const page = doc.pageOf(id);
    if (pageId && page !== pageId) return;
    const race = readRace(mark.race);
    const variation = cleanVariation(mark.variation);
    out.push({ id, of: mark.of, by: mark.by, ...(mark.note ? { note: mark.note } : {}), ...(mark.group ? { group: mark.group } : {}), at: mark.at, name: String(m.get('name') ?? ''), ...(page ? { pageId: page } : {}), sourceExists: doc.nodes.has(mark.of), ...(race ? { race } : {}), ...(variation ? { variation } : {}) });
  });
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const PX = /^(-?\d+(?:\.\d+)?)px$/;

/** Reads a top-level layer's box from its style, for when no renderer has measured it. */
export function rectFromStyle(node: BogenNode): Rect {
  const num = (v: string | undefined, fallback: number) => {
    const m = PX.exec(v ?? '');
    return m ? Number(m[1]) : fallback;
  };
  return { x: num(node.style.left, 0), y: num(node.style.top, 0), w: num(node.style.width, node.artboard ? 1440 : 320), h: num(node.style.height, 900) };
}

export interface ProposalOptions {
  by: string;
  /** Per copy, who works in it, when that differs from `by`, and the race it belongs to. */
  lanes?: { by: string; race: ProposalRace }[];
  /** One copy per entry: a label for each, shown on the canvas. */
  notes?: (string | undefined)[];
  count?: number;
  /** The layer's box on the page, from a renderer when there is one. */
  rect?: Rect;
  /** Other boxes on the page, which the copies stay clear of. */
  others?: Rect[];
  gap?: number;
  origin?: unknown;
  /** The revision these copies belong to. */
  revision?: string;
  /** The range and aspects of these copies, kept on each. */
  variation?: Variation;
}

/** Child by child, the layers of `to` that stand for the layers of `from`: copy id to original id. Instances keep their insides. */
export function pairLayers(doc: BogenDoc, from: string, to: string, out: Record<string, string> = {}): Record<string, string> {
  const a = doc.rawChildren(from);
  const b = doc.rawChildren(to);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    out[b[i]!.id] = a[i]!.id;
    pairLayers(doc, a[i]!.id, b[i]!.id, out);
  }
  return out;
}

/** Reconcile stored layers, including slot content. Instance views are not writable document layers. */
function storedDescendants(doc: BogenDoc, id: string): BogenNode[] {
  const out: BogenNode[] = [];
  const walk = (parent: string) => {
    for (const child of doc.rawChildren(parent)) {
      out.push(child);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}

/** FNV-1a, 32 bits: a short fingerprint, enough to tell whether a layer changed. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** What a layer looks like and says, without where it is or what it is called: the parts a person edits. */
export function layerFingerprint(doc: BogenDoc, id: string): string {
  const n = doc.rawNode(id);
  if (!n) return 'gone';
  const sorted = (o: object | undefined) => (o ? Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1))) : undefined);
  return hash(JSON.stringify([n.type, n.tag, sorted(n.style), n.text ?? null, n.spans ?? null, n.src ?? null, n.svg ?? null, sorted(n.attrs), n.hidden ?? false, n.rules ?? null,
    n.instanceOf ?? null, sorted(n.props), sorted(n.overrides), n.textStyle ?? null, n.mode ?? null, n.proto ?? null, n.slotName ?? null]));
}

/** Makes copies to the right of the layer, side by side, in one transaction. Returns their ids. */
export function createProposals(doc: BogenDoc, sourceId: string, options: ProposalOptions): string[] {
  const source = doc.getNode(sourceId);
  if (!source) throw new Error(`No layer with id ${sourceId}.`);
  const already = proposalMark(doc, sourceId);
  if (already) throw new Error(`Layer ${sourceId} is a proposal itself. Change it directly, or make another proposal of the original ${already.of}.`);
  const pageId = doc.pageOf(sourceId);
  if (!pageId) throw new Error(`Layer ${sourceId} is not on a page.`);
  const count = options.count ?? options.notes?.length ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_DIRECTION_LANES) throw new Error(`Make between 1 and ${MAX_DIRECTION_LANES} proposals at a time.`);
  const gap = options.gap ?? 80;
  const box = options.rect ?? rectFromStyle(source);
  const others = options.others ?? doc.getChildren(pageId).filter((n) => n.id !== sourceId).map(rectFromStyle);
  const group = count > 1 ? newId(8) : undefined;
  const ids: string[] = [];
  let x = box.x + box.w + gap;
  const at = Date.now();
  doc.transact(() => {
    for (let i = 0; i < count; i++) {
      // Past anything that is already there, so nothing lands on top of other work.
      for (let spot: Rect = { x, y: box.y, w: box.w, h: box.h }, hit = others.find((o) => overlaps(spot, o)); hit; spot = { ...spot, x }, hit = others.find((o) => overlaps(spot, o))) x = hit.x + hit.w + gap;
      const spec = doc.toSpec(sourceId);
      const width = `${Math.round(box.w)}px`;
      const height = source.style.height ? `${Math.round(box.h)}px` : undefined;
      const style: Record<string, string> = { ...spec.style, position: 'absolute', left: `${Math.round(x)}px`, top: `${Math.round(box.y)}px`, width };
      if (height) style.height = height;
      for (const key of PLACEMENT) if (!['position', 'left', 'top'].includes(key)) delete style[key];
      const note = options.notes?.[i];
      const id = doc.insert(pageId, { ...spec, style, name: `${source.name} proposal${count > 1 ? ` ${i + 1}` : ''}`, artboard: source.artboard ?? true });
      const lane = options.lanes?.[i];
      // The copy and the original have the same shape, so walking both side by side pairs every layer. Complete, with
      // no cap: accepting relies on it to keep the original's ids.
      doc.invalidate();
      const map = pairLayers(doc, sourceId, id);
      const base: Record<string, string> = { [sourceId]: layerFingerprint(doc, sourceId) };
      for (const orig of Object.values(map)) base[orig] = layerFingerprint(doc, orig);
      // The copy's own root as it was made, so that an untouched draft can be told from a worked one.
      base[id] = layerFingerprint(doc, id);
      const mark: ProposalMark = {
        of: sourceId, by: lane?.by ?? options.by, at: at + i, placed: { width, ...(height ? { height } : {}) }, ...(note ? { note } : {}), ...(group ? { group } : {}), ...(lane ? { race: lane.race } : {}),
        map, base, ...(options.revision ? { revision: options.revision } : {}), ...(options.variation ? { variation: { range: options.variation.range, vary: [...options.variation.vary] } } : {}),
      };
      doc.nodes.get(id)!.set('proposal', mark);
      ids.push(id);
      others.push({ x, y: box.y, w: box.w, h: box.h });
      x += box.w + gap;
    }
  }, options.origin);
  return ids;
}

function markOf(doc: BogenDoc, id: string): ProposalMark {
  const mark = proposalMark(doc, id);
  if (!mark) throw new Error(`Layer ${id} is not a proposal.`);
  return mark;
}

/** The other directions made together with this one. */
export function proposalSiblings(doc: BogenDoc, id: string): string[] {
  const { group } = markOf(doc, id);
  if (!group) return [];
  return listProposals(doc).filter((p) => p.group === group && p.id !== id).map((p) => p.id);
}

export type ConflictKind = 'changed-both' | 'deleted-in-original' | 'deleted-in-proposal' | 'added-under-removed';

export interface ProposalConflict {
  kind: ConflictKind;
  /** The original layer, by its id, which accepting keeps. */
  original: string;
  /** Its copy in the proposal, when there is one. */
  copy?: string;
  name: string;
}

export type ConflictChoice = 'proposal' | 'original';
export type ConflictResolution = ConflictChoice | Record<string, ConflictChoice>;

export class ProposalConflictError extends Error {
  constructor(readonly conflicts: ProposalConflict[]) {
    super(`${conflicts.length} layer${conflicts.length === 1 ? ' was' : 's were'} changed in the original since the proposal was made, and differ from the proposal: ${conflicts.slice(0, 5).map((c) => `"${c.name}" (${c.kind})`).join(', ')}${conflicts.length > 5 ? ', …' : ''}. Pick for each whether the proposal or the original wins.`);
    this.name = 'ProposalConflictError';
  }
}

/**
 * What changed on both sides since the copy was made: a layer the person edited in the original that the proposal
 * edited too (and differently), one deleted on one side and changed on the other, or one added in the original under a
 * layer the proposal removes. Layers changed on one side only are not conflicts: that side's version is kept.
 */
export function proposalConflicts(doc: BogenDoc, id: string): ProposalConflict[] {
  const mark = markOf(doc, id);
  if (!mark.map || !mark.base) return [];
  const out: ProposalConflict[] = [];
  const copyOf = new Map(Object.entries(mark.map).map(([c, o]) => [o, c]));
  for (const [copy, original] of Object.entries(mark.map)) {
    const base = mark.base[original];
    const o = doc.rawNode(original);
    const c = doc.rawNode(copy);
    const oChanged = !o || layerFingerprint(doc, original) !== base || !doc.ancestors(original).includes(mark.of);
    const cChanged = !c || layerFingerprint(doc, copy) !== base;
    if (!oChanged || !cChanged) continue;
    if (o && c && layerFingerprint(doc, original) === layerFingerprint(doc, copy)) continue;
    out.push({ kind: !o || !doc.ancestors(original).includes(mark.of) ? 'deleted-in-original' : !c ? 'deleted-in-proposal' : 'changed-both', original, ...(c ? { copy } : {}), name: (o ?? c)?.name ?? original });
  }
  // Layers the person added to the original after the copy was made, under a layer the proposal took away.
  for (const n of storedDescendants(doc, mark.of)) {
    if (mark.base[n.id] !== undefined) continue;
    const parentCopy = copyOf.get(n.parent);
    if (n.parent !== mark.of && parentCopy && !doc.rawNode(parentCopy) && !out.some((c) => c.original === n.parent)) out.push({ kind: 'added-under-removed', original: n.id, name: n.name });
  }
  return out;
}

const choose = (resolution: ConflictResolution | undefined, original: string): ConflictChoice | undefined => (typeof resolution === 'string' ? resolution : resolution?.[original]);

/**
 * Puts the proposal into the original, keeping the original's ids: each original layer takes its copy's content and
 * place, layers new in the proposal move over with their own ids, and layers the proposal removed go. So comments,
 * prototype links and selections on the original stay attached, and links or threads made on the copy are moved to the
 * original. Edits made to the original meanwhile are kept where the proposal left that layer alone; where both sides
 * changed one, it throws `ProposalConflictError` until `resolve` says which wins. One transaction, one undo step.
 */
export function acceptProposal(doc: BogenDoc, id: string, origin?: unknown, resolve?: ConflictResolution): { sourceId: string; discarded: string[]; kept: string[]; moved: string[] } {
  const mark = markOf(doc, id);
  if (!mark.map || !mark.base) return { ...acceptByReplacing(doc, id, origin), kept: [], moved: [] };
  const source = doc.getNode(mark.of);
  if (!source) throw new Error(`The layer this proposal would replace is gone. Discard it, or keep it by moving its content.`);
  const conflicts = proposalConflicts(doc, id);
  const open = conflicts.filter((c) => !choose(resolve, c.original));
  if (open.length) throw new ProposalConflictError(open);
  const map = { ...mark.map, [id]: mark.of };
  const copyOf = new Map(Object.entries(map).map(([c, o]) => [o, c]));
  const decided = new Map(conflicts.map((c) => [c.original, choose(resolve, c.original)!]));
  // Everything is read before writing: the caches only refresh between transactions.
  const copyLayers = [id, ...storedDescendants(doc, id).map((n) => n.id)];
  const plan = copyLayers.map((c) => ({ c, node: doc.rawNode(c)!, original: map[c], parent: doc.rawNode(c)!.parent, order: String(doc.nodes.get(c)?.get('order') ?? '') }));
  const originals = [mark.of, ...storedDescendants(doc, mark.of).map((n) => n.id)];
  const siblings = proposalSiblings(doc, id);
  const siblingLayers = siblings.flatMap((s) => [s, ...storedDescendants(doc, s).map((n) => n.id)]);
  const fp = new Map(plan.filter((p) => p.original).map((p) => [p.c, layerFingerprint(doc, p.c)]));
  const fpOriginal = new Map(originals.map((o) => [o, layerFingerprint(doc, o)]));
  const kept: string[] = [];
  const moved: string[] = [];
  /** Where a layer of the copy goes: under the original of its parent, or under a layer that moves over itself. */
  const target = (copyParent: string) => map[copyParent] ?? copyParent;
  doc.transact(() => {
    for (const p of plan) {
      const o = p.original;
      if (p.c === id) {
        transferContent(doc, mark.of, p.node, mark, true);
        continue;
      }
      const choice = o ? decided.get(o) : undefined;
      if (o && doc.nodes.has(o) && doc.ancestors(o).concat([o]).includes(mark.of)) {
        const copyChanged = fp.get(p.c) !== mark.base![o];
        const origChanged = fpOriginal.get(o) !== mark.base![o];
        // The person's own edit stays where the proposal did not touch the layer, or where they chose the original.
        if (choice === 'original' || (origChanged && !copyChanged)) kept.push(o);
        else if (copyChanged) transferContent(doc, o, p.node, mark, false);
        const m = doc.nodes.get(o)!;
        if (m.get('parent') !== target(p.parent)) m.set('parent', target(p.parent));
        if (p.order && m.get('order') !== p.order) m.set('order', p.order);
        continue;
      }
      if (o && choice === 'original') continue;
      // New in the proposal, or its original is gone and the proposal won: the copy's layer moves over with its id.
      const m = doc.nodes.get(p.c)!;
      if (copyOf.has(p.parent) || map[p.parent]) m.set('parent', target(p.parent));
      moved.push(p.c);
    }
    // Original layers the proposal removed, unless the person changed them meanwhile and chose to keep them.
    for (const o of originals) {
      if (o === mark.of || !doc.nodes.has(o)) continue;
      const c = copyOf.get(o);
      const inBase = mark.base![o] !== undefined;
      const removedInProposal = inBase && (!c || !copyLayers.includes(c));
      const added = !inBase;
      const conflict = decided.get(o);
      if (removedInProposal && conflict !== 'original') deleteTree(doc, o);
      if (added && conflict === 'proposal') deleteTree(doc, o);
    }
    // Threads and prototype links made on the copy now point at the layers that remain.
    const remap = (target0: string) => map[target0] ?? target0;
    doc.comments.forEach((thread) => {
      const nodeId = thread.get('nodeId');
      if (typeof nodeId === 'string' && map[nodeId] && doc.nodes.has(map[nodeId]!)) thread.set('nodeId', map[nodeId]);
    });
    doc.nodes.forEach((m) => {
      const proto = m.get('proto') as { link?: string } | undefined;
      if (proto?.link && map[proto.link]) m.set('proto', { ...proto, link: remap(proto.link) });
    });
    // The copy's own layers whose content went to an original, and the other directions.
    for (const p of plan) if (p.original && !moved.includes(p.c) && doc.nodes.has(p.c)) doc.nodes.delete(p.c);
    for (const layer of siblingLayers) doc.nodes.delete(layer);
    rememberDecision(doc, id, mark.of, 'accepted');
    for (const sibling of siblings) rememberDecision(doc, sibling, mark.of, 'discarded');
  }, origin);
  return { sourceId: mark.of, discarded: siblings, kept, moved };
}

function deleteTree(doc: BogenDoc, id: string): void {
  for (const n of storedDescendants(doc, id)) doc.nodes.delete(n.id);
  doc.nodes.delete(id);
}

/** A copy layer's content into an original layer: style, rules, text and fields. Placement stays the original's on the root. */
function transferContent(doc: BogenDoc, targetId: string, copy: BogenNode, mark: ProposalMark, root: boolean): void {
  const target = doc.nodes.get(targetId)!;
  const current = doc.rawNode(targetId)!;
  const patch: Record<string, string | null> = {};
  for (const key of Object.keys(current.style)) if (!(key in copy.style) && !(root && PLACEMENT.has(key))) patch[key] = null;
  for (const [key, value] of Object.entries(copy.style)) {
    if (root && PLACEMENT.has(key)) continue;
    // The copy got a fixed size so that it could stand alone. Unless that size was changed, the original keeps its own.
    if (root && (key === 'width' || key === 'height') && mark.placed?.[key] === value) {
      delete patch[key];
      continue;
    }
    if (current.style[key] !== value) patch[key] = value;
  }
  if (root && mark.placed?.height && !copy.style.height && current.style.height) patch.height = null;
  if (Object.keys(patch).length) doc.updateStyle(targetId, patch);
  // Rules: every block of the copy, and none the copy dropped.
  for (const block of Object.keys(current.rules ?? {})) if (!copy.rules?.[block]) doc.deleteRules(targetId, block);
  for (const [block, props] of Object.entries(copy.rules ?? {})) {
    const before = current.rules?.[block] ?? {};
    const next: Record<string, string | null> = { ...Object.fromEntries(Object.keys(before).filter((k) => !(k in props)).map((k) => [k, null])), ...props };
    doc.updateRules(targetId, block, next);
  }
  // Text goes in as what changed, with the copy's ranges, so it merges with anyone typing in the original.
  const rich = target.get('type') === 'text' && target.get('instanceOf') === undefined;
  if (rich && (copy.text ?? '') !== (current.text ?? '')) setLayerText(target, copy.text ?? '', copy.spans ?? []);
  for (const key of ['tag', 'src', 'svg', 'attrs', 'hidden', 'textStyle', 'mode', ...(root ? [] : ['name']), ...(rich ? [] : ['text', 'spans'])] as const) {
    const value = (copy as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(value) === JSON.stringify((current as unknown as Record<string, unknown>)[key])) continue;
    if (value === undefined || value === false) target.delete(key);
    else target.set(key, value);
  }
  if (copy.instanceOf !== undefined && copy.instanceOf === current.instanceOf) {
    for (const field of ['props', 'overrides'] as const) {
      const to = target.get(field) as { forEach: (f: (v: unknown, k: string) => void) => void; set: (k: string, v: unknown) => void; delete: (k: string) => void } | undefined;
      const from = (copy as unknown as Record<string, Record<string, unknown> | undefined>)[field] ?? {};
      if (!to) continue;
      const keys: string[] = [];
      to.forEach((_v, k) => keys.push(k));
      for (const k of keys) if (!(k in from)) to.delete(k);
      for (const [k, v] of Object.entries(from)) to.set(k, v);
    }
  }
}

/** Accepting a proposal from before ids were mapped: the original's children are replaced by the copy's. */
function acceptByReplacing(doc: BogenDoc, id: string, origin?: unknown): { sourceId: string; discarded: string[] } {
  const mark = markOf(doc, id);
  const source = doc.getNode(mark.of);
  if (!source) throw new Error(`The layer this proposal would replace is gone. Discard it, or keep it by moving its content.`);
  const copy = doc.getNode(id)!;
  // getChildren reads a cache that only refreshes between transactions, so everything is read first.
  const oldLayers = storedDescendants(doc, mark.of).map((n) => n.id);
  const newChildren = doc.rawChildren(id).map((n) => n.id);
  const siblings = proposalSiblings(doc, id);
  const siblingLayers = siblings.flatMap((s) => [s, ...storedDescendants(doc, s).map((n) => n.id)]);
  doc.transact(() => {
    for (const layer of oldLayers) doc.nodes.delete(layer);
    const target = doc.nodes.get(mark.of)!;
    for (const child of newChildren) {
      const m = doc.nodes.get(child)!;
      m.set('parent', mark.of);
    }
    const patch: Record<string, string | null> = {};
    for (const key of Object.keys(source.style)) if (!(key in copy.style) && !PLACEMENT.has(key)) patch[key] = null;
    for (const [key, value] of Object.entries(copy.style)) {
      if (PLACEMENT.has(key)) continue;
      // The copy got a fixed size so that it could stand alone. Unless that size was changed, the original keeps its own.
      if ((key === 'width' || key === 'height') && mark.placed?.[key] === value) continue;
      patch[key] = value;
    }
    if (mark.placed?.height && !copy.style.height && source.style.height) patch.height = null;
    doc.updateStyle(mark.of, patch);
    // Text goes in as what changed, with the copy's ranges, so it merges with anyone typing in the original.
    if (target.get('type') === 'text' && target.get('instanceOf') === undefined) setLayerText(target, copy.text ?? '', copy.spans ?? []);
    for (const key of ['tag', 'text', 'src', 'svg', 'attrs'] as const) {
      if (key === 'text' && target.get('type') === 'text' && target.get('instanceOf') === undefined) continue;
      const value = copy[key];
      if (value === undefined) target.delete(key);
      else target.set(key, value);
    }
    doc.nodes.delete(id);
    for (const layer of siblingLayers) doc.nodes.delete(layer);
    rememberDecision(doc, id, mark.of, 'accepted');
    for (const sibling of siblings) rememberDecision(doc, sibling, mark.of, 'discarded');
  }, origin);
  return { sourceId: mark.of, discarded: siblings };
}

/** Removes a proposal. The original was never touched. */
export function discardProposal(doc: BogenDoc, id: string, options: { group?: boolean; origin?: unknown } = {}): string[] {
  const mark = markOf(doc, id);
  const ids = [id, ...(options.group ? proposalSiblings(doc, id) : [])];
  doc.transact(() => {
    doc.delete(ids);
    for (const copy of ids) rememberDecision(doc, copy, mark.of, 'discarded');
  }, options.origin);
  return ids;
}
