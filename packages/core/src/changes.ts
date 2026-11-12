import * as Y from 'yjs';
import type { BogenDoc } from './doc.ts';
import { plainTextFields, RICH_KEY, setLayerText } from './text-model.ts';

/**
 * Changes as data: what a transaction did to a document, at the level of single fields, in a form that
 * can be stored, sent to another device and turned around later. A change records the value before and
 * the value after. Reverting it means: where a field still holds the value after, put the value before
 * back. Where it holds something else, somebody has changed it since, and that is reported, never
 * overwritten.
 *
 * A document is read as roots (`nodes`, `tokens`, `comments`, `meta`, brand maps) holding keys. Inside a
 * key, nested maps are walked and everything else is a value, so a new field or a new map is covered
 * without this file knowing about it.
 */
export type Encoded = unknown;

export interface ChangeOp {
  /** root, key, then fields inside: `['nodes', id, 'style', 'color']`. */
  p: string[];
  /** The value before. Absent: it did not exist. */
  b?: Encoded;
  /** The value after. Absent: it no longer exists. */
  a?: Encoded;
  /** Instead of `a` for something big that was added: enough to tell whether it has changed since. */
  ah?: string;
}

export interface ChangeLabel { n: string; label: string; revertOf?: string[]; restoreOf?: string }

/**
 * Root maps a change never records: derived data with no meaning of its own, and the snapshots of a file's branches,
 * whose switching is recorded as the change of the design it makes.
 */
export const UNTRACKED_ROOTS = new Set(['interactionStates', 'designBranches']);
/** Where a client says what its transaction is. Same update, so it cannot get separated from the change. */
export const LABEL_KEY = 'changeLabel';

const BIG_VALUE = 512;

export function encodeValue(value: unknown): Encoded {
  if (value instanceof Y.Map) {
    // A text layer is recorded by what it shows. Its CRDT text is how it merges, not part of the design.
    const plain = plainTextFields(value);
    const out: Record<string, unknown> = {};
    for (const key of [...new Set([...value.keys(), ...Object.keys(plain ?? {})])].sort()) {
      const v = plain && key in plain ? plain[key] : encodeValue(value.get(key));
      if (v !== undefined) out[key] = v;
    }
    return { $map: out };
  }
  if (value instanceof Y.Array) return { $array: value.toArray().map(encodeValue) };
  return value;
}

export function decodeValue(value: Encoded): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.$map && typeof record.$map === 'object') {
      const map = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(record.$map as Record<string, unknown>)) map.set(k, decodeValue(v));
      return map;
    }
    if (Array.isArray(record.$array)) {
      const list = new Y.Array<unknown>();
      list.push(record.$array.map(decodeValue));
      return list;
    }
  }
  return value;
}

function isMapValue(value: Encoded): value is { $map: Record<string, Encoded> } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof (value as { $map?: unknown }).$map === 'object' && (value as { $map?: unknown }).$map !== null;
}

function same(a: Encoded, b: Encoded): boolean {
  return a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));
}

/** A short fingerprint of a value. Not for security: it only tells a value from what it has become. */
export function fingerprint(value: Encoded): string {
  const text = JSON.stringify(value) ?? '';
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2166136261);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}:${text.length}`;
}

/** The field-level difference of two encoded values, in the order they appear. */
export function diffEncoded(path: string[], before: Encoded, after: Encoded, out: ChangeOp[]): void {
  if (same(before, after)) return;
  if (before === undefined && after === undefined) return;
  if (isMapValue(before) && isMapValue(after)) {
    const keys = new Set([...Object.keys(before.$map), ...Object.keys(after.$map)]);
    for (const key of [...keys].sort()) diffEncoded([...path, key], before.$map[key], after.$map[key], out);
    return;
  }
  const op: ChangeOp = { p: path };
  if (before !== undefined) op.b = before;
  if (after !== undefined) {
    // A whole layer that was added can be big. Taking it away only needs to know it is still as it was.
    if (before === undefined && isMapValue(after) && (JSON.stringify(after).length > BIG_VALUE)) op.ah = fingerprint(after);
    else op.a = after;
  }
  out.push(op);
}

/** Every root map's name in a document. */
export function rootNames(doc: BogenDoc): string[] {
  const out: string[] = [];
  for (const name of doc.y.share.keys()) {
    if (UNTRACKED_ROOTS.has(name)) continue;
    try {
      doc.y.getMap(name);
      out.push(name);
    } catch {
      // Not a map. Nothing in Bogen writes one.
    }
  }
  return out;
}

export function encodeKey(doc: BogenDoc, root: string, key: string): Encoded {
  const map = doc.y.getMap(root);
  return map.has(key) ? encodeValue(map.get(key)) : undefined;
}

/** Root and key of each thing a transaction touched. */
export function dirtyKeys(tx: Y.Transaction): { root: string; key: string }[] {
  const out = new Map<string, { root: string; key: string }>();
  const add = (root: string, key: string) => out.set(`${root}\u0000${key}`, { root, key });
  tx.changed.forEach((keys, type) => {
    let current: Y.AbstractType<Y.YEvent<any>> = type as never;
    let topKey: string | null = null;
    while (current._item) {
      topKey = current._item.parentSub;
      current = current._item.parent as Y.AbstractType<Y.YEvent<any>>;
    }
    let root: string;
    try {
      root = Y.findRootTypeKey(current);
    } catch {
      return;
    }
    if (topKey !== null) add(root, topKey);
    else keys.forEach((k) => { if (k !== null) add(root, k); });
  });
  return [...out.values()];
}

export interface PlanOp { p: string[]; v?: Encoded; del?: boolean }
export interface RevertConflict {
  change: string;
  /** Which layer or thing, in words. */
  what: string;
  field: string;
  reason: string;
  /** What the change would put back, and what is there now. */
  wanted?: Encoded;
  now?: Encoded;
  layerId?: string;
}

export interface RevertPlan {
  ops: PlanOp[];
  conflicts: RevertConflict[];
  /** Fields turned back. */
  reverted: number;
  /** Fields that already held the old value. */
  unchanged: number;
  layers: string[];
  /** True when every field could be turned back. */
  clean: boolean;
}

export interface RevertableChange { id: string; ops?: ChangeOp[]; thinned?: boolean; summary?: string }

const TOP = (root: string, key: string) => `${root}\u0000${key}`;

export function readPath(tree: Encoded, rest: string[]): Encoded {
  let current = tree;
  for (const key of rest) {
    if (!isMapValue(current)) return undefined;
    current = current.$map[key];
  }
  return current;
}

export function cloneEncoded(value: Encoded): Encoded {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Writes into a private copy. A path through something that is gone cannot be written, and says so. */
export function writePath(tree: Encoded, rest: string[], value: Encoded): { tree: Encoded; ok: boolean } {
  if (!rest.length) return { tree: value, ok: true };
  if (!isMapValue(tree)) return { tree, ok: false };
  let current = tree;
  for (const key of rest.slice(0, -1)) {
    const next = current.$map[key];
    if (!isMapValue(next)) return { tree, ok: false };
    current = next;
  }
  const last = rest.at(-1)!;
  if (value === undefined) delete current.$map[last];
  else current.$map[last] = value;
  return { tree, ok: true };
}

function pretty(op: ChangeOp, describe: (id: string) => string): { what: string; field: string; layerId?: string } {
  const [root, key, ...rest] = op.p;
  if (root === 'nodes') return { what: describe(key!), field: rest.join('.') || 'the whole layer', layerId: key };
  if (root === 'tokens') return { what: `Token ${key}`, field: rest.join('.') || 'the whole token' };
  if (root === 'pages') return { what: `Page ${describe(key!)}`, field: rest.join('.') || 'the whole page' };
  if (root === 'comments') return { what: 'A comment thread', field: rest.join('.') || 'the whole thread' };
  return { what: `${root} ${key ?? ''}`.trim(), field: rest.join('.') };
}

/**
 * Works out what reverting these changes takes, newest first, without touching the document. Each field
 * is turned back only if it still holds what the change left there, so a run that changed a colour twice
 * unwinds through both steps, and an edit somebody made since then stops it for that field alone.
 */
export function planRevert(doc: BogenDoc, changes: RevertableChange[]): RevertPlan {
  const state = new Map<string, Encoded>();
  const read = (root: string, key: string): Encoded => {
    const id = TOP(root, key);
    if (!state.has(id)) state.set(id, cloneEncoded(encodeKey(doc, root, key)));
    return state.get(id);
  };
  const conflicts: RevertConflict[] = [];
  const seenConflict = new Set<string>();
  let reverted = 0;
  let unchanged = 0;
  const describe = (id: string): string => {
    const value = (state.has(TOP('nodes', id)) ? state.get(TOP('nodes', id)) : encodeKey(doc, 'nodes', id)) as { $map?: { name?: string } } | undefined;
    if (value?.$map?.name) return `"${value.$map.name}"`;
    const page = doc.pages.get(id);
    return page ? `"${String(page.get('name'))}"` : `Layer ${id}`;
  };
  const report = (change: string, op: ChangeOp, reason: string, now?: Encoded) => {
    const key = op.p.join('\u0000');
    if (seenConflict.has(key)) return;
    seenConflict.add(key);
    const where = pretty(op, describe);
    conflicts.push({ change, ...where, reason, wanted: op.b, now });
  };
  const created = new Map<string, { change: string; op: ChangeOp }>();
  const removedTop = new Map<string, { change: string; op: ChangeOp }>();
  // What each change would do, kept so that a later check can take it back.
  const before = new Map<string, Encoded>();

  for (const change of changes) {
    if (!change.ops) {
      conflicts.push({ change: change.id, what: change.summary ?? 'This change', field: '', reason: 'It is too old: its details were thinned out, so only the record that it happened is left.' });
      continue;
    }
    for (const op of [...change.ops].reverse()) {
      const [root, key, ...rest] = op.p;
      if (!root || key === undefined) continue;
      if (root === 'meta' && key === LABEL_KEY) continue;
      const top = read(root, key);
      const current = rest.length ? readPath(top, rest) : top;
      const holdsAfter = op.ah !== undefined ? current !== undefined && fingerprint(current) === op.ah : same(current, op.a) || (current === undefined && op.a === undefined);
      if (!holdsAfter) {
        if (same(current, op.b) || (current === undefined && op.b === undefined)) {
          unchanged++;
          continue;
        }
        report(change.id, op, op.a === undefined && op.ah === undefined ? 'It was put back in another way since then.' : current === undefined ? 'It has been removed since then.' : 'It was changed again later.', current);
        continue;
      }
      const topId = TOP(root, key);
      if (!before.has(topId)) before.set(topId, cloneEncoded(top));
      const written = writePath(top, rest, cloneEncoded(op.b));
      if (!written.ok) {
        report(change.id, op, 'What it belongs to is gone.', current);
        continue;
      }
      state.set(topId, written.tree);
      reverted++;
      if (!rest.length && op.b === undefined) created.set(topId, { change: change.id, op });
      if (!rest.length && op.a === undefined) removedTop.set(topId, { change: change.id, op });
    }
  }

  // The tree has to stay a tree: nothing may lose its parent.
  const parentOf = (id: string): string | undefined => {
    const value = (state.has(TOP('nodes', id)) ? state.get(TOP('nodes', id)) : encodeKey(doc, 'nodes', id)) as { $map?: { parent?: string } } | undefined;
    return value?.$map?.parent;
  };
  const exists = (id: string): boolean => {
    if (state.has(TOP('nodes', id))) return state.get(TOP('nodes', id)) !== undefined;
    if (doc.nodes.has(id)) return true;
    if (state.has(TOP('pages', id))) return state.get(TOP('pages', id)) !== undefined;
    return doc.pages.has(id);
  };
  const putBack = (topId: string, change: string, op: ChangeOp, reason: string) => {
    state.set(topId, before.get(topId));
    report(change, op, reason, before.get(topId));
    reverted--;
  };
  for (let round = 0; round < 8; round++) {
    let changed = false;
    // Taking something away that now has children somebody else added.
    for (const [topId, { change, op }] of created) {
      if (state.get(topId) !== undefined) continue;
      const [, id] = op.p;
      const kept: string[] = [];
      for (const other of new Set([...doc.nodes.keys(), ...[...state.keys()].filter((k) => k.startsWith('nodes\u0000')).map((k) => k.slice(6))])) {
        if (other !== id && exists(other) && parentOf(other) === id) kept.push(other);
      }
      if (kept.length) {
        putBack(topId, change, op, `Layers were added inside it later (${kept.slice(0, 3).map(describe).join(', ')}), so it stays.`);
        changed = true;
      }
    }
    // Bringing something back, or moving it, under a parent that is not there.
    for (const topId of state.keys()) {
      if (!topId.startsWith('nodes\u0000')) continue;
      const id = topId.slice(6);
      const value = state.get(topId) as { $map?: { parent?: string } } | undefined;
      const parent = value?.$map?.parent;
      if (!parent || exists(parent) || !before.has(topId)) continue;
      const source = removedTop.get(topId);
      const [change, op] = source ? [source.change, source.op] : [changes[0]?.id ?? '', { p: ['nodes', id, 'parent'] } as ChangeOp];
      putBack(topId, change, op, 'The frame or page it was in is gone.');
      changed = true;
    }
    if (!changed) break;
  }

  const ops: PlanOp[] = [];
  const layers = new Set<string>();
  for (const [topId, value] of state) {
    const [root, key] = topId.split('\u0000') as [string, string];
    const diff: ChangeOp[] = [];
    diffEncoded([root, key], encodeKey(doc, root, key), value, diff);
    for (const d of diff) {
      // `ah` stands in for a value only when it was added. Here the value itself is wanted.
      const target = readPath(value, d.p.slice(2));
      ops.push(target === undefined ? { p: d.p, del: true } : { p: d.p, v: target });
    }
    if (diff.length && root === 'nodes') layers.add(key);
  }
  return { ops, conflicts, reverted: Math.max(0, reverted), unchanged, layers: [...layers], clean: conflicts.length === 0 };
}

/** Carries out a plan. Call inside a transaction with the origin that should get the credit. */
export function applyPlan(doc: BogenDoc, ops: PlanOp[]): void {
  for (const op of ops) {
    const [root, ...rest] = op.p;
    if (!root || !rest.length) continue;
    let map: Y.Map<unknown> = doc.y.getMap(root);
    let reachable = true;
    for (const key of rest.slice(0, -1)) {
      const next = map.get(key);
      if (!(next instanceof Y.Map)) {
        reachable = false;
        break;
      }
      map = next as Y.Map<unknown>;
    }
    if (!reachable) continue;
    const last = rest.at(-1)!;
    // Text goes back as a change to the CRDT text, so the layer keeps merging with others typing.
    if (root === 'nodes' && rest.length === 2 && (last === 'text' || last === 'spans') && map.get(RICH_KEY) instanceof Y.Text) {
      if (last === 'text') setLayerText(map, op.del || typeof op.v !== 'string' ? '' : op.v);
      else setLayerText(map, undefined, op.del ? [] : op.v);
      continue;
    }
    if (op.del) map.delete(last);
    else map.set(last, decodeValue(op.v));
  }
}

/** Says what the transaction is, inside the same update. A nonce tells a new label from an undone one. */
export function labelChange(doc: BogenDoc, label: Omit<ChangeLabel, 'n'>): void {
  doc.meta.set(LABEL_KEY, { ...label, n: crypto.randomUUID() });
}

/** Words for a change, for lists. */
export function summarizeOps(ops: ChangeOp[], names: (id: string) => string | undefined): { summary: string; layers: string[]; fields: string[] } {
  const created = new Set<string>();
  const removed = new Set<string>();
  const changed = new Set<string>();
  const fields = new Set<string>();
  const other = new Map<string, number>();
  for (const op of ops) {
    const [root, key, ...rest] = op.p;
    if (!key) continue;
    if (root === 'meta' && key === LABEL_KEY) continue;
    if (root === 'nodes') {
      if (!rest.length && op.b === undefined) created.add(key);
      else if (!rest.length && op.a === undefined && op.ah === undefined) removed.add(key);
      else {
        changed.add(key);
        if (rest.length) fields.add(rest.join('.'));
      }
    } else {
      const label = root === 'tokens' ? 'tokens' : root === 'pages' ? 'pages' : root === 'comments' ? 'comments' : root === 'meta' && key === 'keyframes' ? 'keyframes' : root === 'fontFaces' ? 'fonts' : root === 'meta' ? 'file settings' : root === 'repeats' ? 'data bindings' : root!;
      other.set(label, (other.get(label) ?? 0) + 1);
    }
  }
  const named = (ids: Set<string>) => {
    const list = [...ids];
    const first = list.flatMap((id) => names(id) ?? []).slice(0, 2).map((n) => `"${n.replace(/\s+/g, ' ').slice(0, 32)}"`);
    return first.length ? `${first.join(', ')}${list.length > first.length ? ` and ${list.length - first.length} more` : ''}` : `${list.length} layer${list.length === 1 ? '' : 's'}`;
  };
  const parts: string[] = [];
  if (created.size) parts.push(`Added ${named(created)}`);
  if (removed.size) parts.push(`Removed ${named(removed)}`);
  if (changed.size) {
    const shown = [...fields];
    parts.push(`Changed ${shown.slice(0, 3).join(', ')}${shown.length > 3 ? ` and ${shown.length - 3} more` : ''}${shown.length ? ' on ' : ''}${named(changed)}`);
  }
  for (const [label, count] of other) parts.push(`Changed ${label}${count > 1 && label !== 'comments' ? ` (${count})` : ''}`);
  return { summary: parts.join('. ') || 'No visible change', layers: [...new Set([...created, ...removed, ...changed])], fields: [...fields] };
}
