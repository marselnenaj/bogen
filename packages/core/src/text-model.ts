import * as Y from 'yjs';
import type { TextSpan } from './doc.ts';
import { normalizeSpans, SPAN_STYLE_KEYS, textRuns } from './rich-text.ts';

/**
 * The text of a text layer as a CRDT, so that two people typing in one paragraph both keep their words.
 *
 * A layer's map holds a `Y.Text` under `rich`, with the look of its ranges as formatting attributes: one per
 * style property in `SPAN_STYLE_KEYS`, and `href`. Every write through here also puts what the text now
 * shows into `text` and `spans`, the fields older builds read and write, and a mark: a fingerprint of those
 * two values. The mark tells who wrote last:
 *
 * - It matches `text` and `spans`: they were written together with the `Y.Text`, which is the truth. When
 *   two devices typed at once, the `Y.Text` holds both edits while the copy holds one side, until the next
 *   write or a server puts the merged text there (`repairMirror`).
 * - It does not: something that does not know about the `Y.Text` wrote `text` or `spans` since (an older
 *   build, a revert, a raw copy). Those values show, as they did before, and the next edit here first brings
 *   the `Y.Text` to them and then goes on merging.
 *
 * A layer stored before this has neither; it reads as it always did and gets its `Y.Text` on its first
 * edit. Plain copies of a document (`encodeValue`, `docToContent`) never hold the `Y.Text` or the mark,
 * only what shows, so commits, design folders and change logs look exactly as they did.
 */
export const RICH_KEY = 'rich';
export const MARK_KEY = 'richMark';

const KNOWN_ATTRS: readonly string[] = [...SPAN_STYLE_KEYS, 'href'];

interface TextState {
  text: string;
  spans: TextSpan[];
  /** The `Y.Text`'s own length, which also counts embeds, which a string cannot hold. */
  size: number;
}

export interface TextChange { at: number; remove: number; insert: string }

const states = new WeakMap<Y.Text, TextState>();
const hooked = new WeakSet<Y.Doc>();

function forget(tr: Y.Transaction): void {
  tr.changed.forEach((_, type) => { if (type instanceof Y.Text) states.delete(type); });
}

function stateOf(t: Y.Text): TextState {
  const doc = t.doc;
  // Inside a transaction a text can change between two reads, and nothing says so until it ends.
  const open = !doc || doc._transaction !== null;
  const known = open ? undefined : states.get(t);
  if (known) return known;
  const state: TextState = { ...fromDelta(t.toDelta()), size: t.length };
  if (!open && doc) {
    if (!hooked.has(doc)) {
      hooked.add(doc);
      doc.on('beforeObserverCalls', forget);
      doc.on('afterTransaction', forget);
    }
    states.set(t, state);
  }
  return state;
}

function fromDelta(delta: unknown): { text: string; spans: TextSpan[] } {
  let text = '';
  const raw: TextSpan[] = [];
  for (const op of delta as { insert?: unknown; attributes?: Record<string, unknown> }[]) {
    if (typeof op.insert !== 'string') continue;
    const start = text.length;
    text += op.insert;
    const a = op.attributes;
    if (!a) continue;
    const style: Record<string, string> = {};
    // In the order the attributes come, which is the order they were first given in.
    for (const [key, value] of Object.entries(a)) if (key !== 'href' && typeof value === 'string') style[key] = value;
    raw.push({ start, end: text.length, style, ...(typeof a.href === 'string' ? { href: a.href } : {}) });
  }
  return { text, spans: normalizeSpans(raw, text.length) };
}

/**
 * What a layer's `Y.Text` showed at a snapshot. Needs a document that keeps deleted content (`gc: false`), or
 * what was deleted since is missing.
 */
export function richTextAt(t: Y.Text, snapshot: Y.Snapshot): { text: string; spans: TextSpan[] } {
  return fromDelta(t.toDelta(snapshot));
}

function hash(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2166136261);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}:${value.length}`;
}

function markOf(text: unknown, spans: unknown): string {
  return `1:${hash(JSON.stringify([text ?? null, spans ?? null]))}`;
}

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The layer's `Y.Text` when it is what shows: nothing has written `text` or `spans` past it. Undoing an edit
 * that someone else's edit overwrote at the same time can leave the copy or the mark with no value at all;
 * nothing else removes them, so the `Y.Text` is what shows then too.
 */
export function liveRich(m: Y.Map<unknown>): Y.Text | null {
  const t = m.get(RICH_KEY);
  if (!(t instanceof Y.Text)) return null;
  const mark = m.get(MARK_KEY);
  const text = m.get('text');
  if (mark === undefined || typeof text !== 'string') return t;
  return mark === markOf(text, m.get('spans')) ? t : null;
}

/** What a layer shows: from its `Y.Text`, or from `text` and `spans` as stored. Spans as stored are not cleaned. */
export function readLayerText(m: Y.Map<unknown>): { text?: string; spans?: unknown } {
  const live = liveRich(m);
  if (live) {
    const s = stateOf(live);
    return { text: s.text, spans: s.spans };
  }
  const text = m.get('text');
  return { ...(typeof text === 'string' ? { text } : {}), spans: m.get('spans') };
}

/**
 * Fields of a layer as plain data, where they differ from the stored values: what it shows as `text` and
 * `spans` (left out when there are none), and no `Y.Text` or mark. Null for a layer that has never had
 * either, which stays exactly as stored.
 */
export function plainTextFields(m: Y.Map<unknown>): Record<string, unknown> | null {
  if (!m.has(RICH_KEY) && !m.has(MARK_KEY)) return null;
  const { text, spans } = readLayerText(m);
  return { [RICH_KEY]: undefined, [MARK_KEY]: undefined, text, spans: Array.isArray(spans) && spans.length ? spans : undefined };
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The one stretch that differs between two strings, by common start and end. Never splits a surrogate pair. */
export function diffText(before: string, after: string): TextChange | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  if (p > 0 && isHigh(before.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  if (s > 0 && isLow(before.charCodeAt(before.length - s))) s--;
  return { at: p, remove: before.length - p - s, insert: after.slice(p, after.length - s) };
}

/** Where an offset in the text before a change is after it. Inside what was replaced, it goes to the end of the new part. */
export function mapOffset(change: TextChange | null, at: number): number {
  if (!change || at <= change.at) return at;
  if (at >= change.at + change.remove) return at - change.remove + change.insert.length;
  return change.at + change.insert.length;
}

function attrsAt(spans: TextSpan[], at: number): Record<string, string> {
  const s = spans.find((x) => x.start <= at && x.end > at);
  return s ? { ...s.style, ...(s.href ? { href: s.href } : {}) } : {};
}

function fill(t: Y.Text, text: string, spans: unknown): void {
  let at = 0;
  for (const run of textRuns(text, spans)) {
    if (!run.text) continue;
    t.insert(at, run.text, { ...run.style, ...(run.href ? { href: run.href } : {}) });
    at += run.text.length;
  }
}

function applyChange(t: Y.Text, now: TextState, change: TextChange): void {
  if (change.remove) t.delete(change.at, change.remove);
  if (!change.insert) return;
  // Typing takes the look of the character before it. At the very start there is none, so it takes the next one's.
  if (change.at === 0 && now.text.length > change.remove) t.insert(0, change.insert, attrsAt(now.spans, change.remove));
  else t.insert(change.at, change.insert);
}

/** Sets the look of every character to what `spans` say, touching only what differs and only the attributes this build knows. */
function applySpans(t: Y.Text, spans: unknown): void {
  const now = stateOf(t);
  const want = normalizeSpans(spans, now.text.length);
  const cuts = new Set<number>([0, now.text.length]);
  for (const s of [...now.spans, ...want]) { cuts.add(s.start); cuts.add(s.end); }
  const points = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b <= a) continue;
    const cur = attrsAt(now.spans, a);
    const next = attrsAt(want, a);
    const patch: Record<string, string | null> = {};
    for (const key of KNOWN_ATTRS) if (cur[key] !== next[key]) patch[key] = next[key] ?? null;
    if (Object.keys(patch).length) t.format(a, b - a, patch);
  }
}

function rebuild(t: Y.Text, text: string, spans: unknown): void {
  if (t.length) t.delete(0, t.length);
  fill(t, text, spans);
}

/**
 * The layer's `Y.Text`, brought to what the layer shows. Made on a layer's first edit here; brought up to
 * date in place, so that others typing into it keep merging, when something wrote `text` or `spans` past it.
 * Call inside a transaction, on a map that is in a document.
 */
function ensureRich(m: Y.Map<unknown>): Y.Text {
  const live = liveRich(m);
  if (live) {
    const s = stateOf(live);
    if (s.size !== s.text.length) rebuild(live, s.text, s.spans);
    return live;
  }
  const raw = m.get('text');
  const text = typeof raw === 'string' ? raw : '';
  const spans = m.get('spans');
  const existing = m.get(RICH_KEY);
  if (existing instanceof Y.Text) {
    const s = stateOf(existing);
    if (s.size !== s.text.length) rebuild(existing, text, spans);
    else {
      const change = diffText(s.text, text);
      if (change) applyChange(existing, s, change);
      applySpans(existing, spans);
    }
    return existing;
  }
  const t = new Y.Text();
  m.set(RICH_KEY, t);
  fill(t, text, spans);
  return t;
}

/** Puts what the `Y.Text` shows where older builds read it, with the mark. All three together, or nothing. */
function writeMirror(m: Y.Map<unknown>, t: Y.Text): void {
  const s = stateOf(t);
  const mark = markOf(s.text, s.spans);
  if (m.get('text') === s.text && m.get(MARK_KEY) === mark && sameJson(m.get('spans'), s.spans)) return;
  m.set('text', s.text);
  m.set('spans', s.spans);
  m.set(MARK_KEY, mark);
}

/**
 * Gives a layer a new `Y.Text` with this text, in place of the one it had, and the copy for older builds with it.
 * This settles a sync conflict: edits from two devices that merged into an unreadable text are dropped as a
 * whole. Two devices that settle the same conflict at once each put their own new `Y.Text` there, the
 * layer's map keeps one of them, and since both hold the same text it appears once. Typing goes on merging
 * per character in the new one. Call inside a transaction.
 */
export function replaceLayerText(m: Y.Map<unknown>, text: string, spans: unknown): void {
  const t = new Y.Text();
  m.set(RICH_KEY, t);
  fill(t, text, spans);
  const s = stateOf(t);
  // Written even when equal, so that this write comes after both sides' and the other device sees it was settled.
  m.set('text', s.text);
  m.set('spans', s.spans);
  m.set(MARK_KEY, markOf(s.text, s.spans));
}

/** Gives a new layer its text. Call inside a transaction, after the map is in the document. */
export function initLayerText(m: Y.Map<unknown>, text: string, spans: unknown): void {
  const t = new Y.Text();
  m.set(RICH_KEY, t);
  fill(t, text, spans);
  writeMirror(m, t);
}

/**
 * Sets a layer's text, its spans or both, changing only the stretch that differs, so that it merges with
 * what others do at the same time. Without spans, ranges follow the edit. Call inside a transaction.
 */
export function setLayerText(m: Y.Map<unknown>, text: string | undefined, spans?: unknown): void {
  const t = ensureRich(m);
  if (text !== undefined) {
    const now = stateOf(t);
    const change = diffText(now.text, text);
    if (change) applyChange(t, now, change);
  }
  if (spans !== undefined) applySpans(t, spans);
  writeMirror(m, t);
}

/**
 * Applies what one writer changed, from the text it last saw (`base`) to what it has now (`next`), on top of
 * whatever arrived in between. Returns what the layer shows afterwards. Call inside a transaction.
 */
export function editLayerText(m: Y.Map<unknown>, base: string, next: string): string {
  const t = ensureRich(m);
  const now = stateOf(t);
  const local = diffText(base, next);
  if (local) {
    const remote = now.text === base ? null : diffText(base, now.text);
    const at = Math.min(mapOffset(remote, local.at), now.text.length);
    const end = local.remove ? Math.min(Math.max(at, mapOffset(remote, local.at + local.remove)), now.text.length) : at;
    applyChange(t, now, { at, remove: end - at, insert: local.insert });
  }
  writeMirror(m, t);
  return stateOf(t).text;
}

/** Styles a range; a null or empty value clears a property, `href` null removes a link. Call inside a transaction. */
export function formatLayerText(m: Y.Map<unknown>, start: number, end: number, patch: Record<string, string | null>, href?: string | null): void {
  const t = ensureRich(m);
  const length = stateOf(t).text.length;
  const a = Math.max(0, Math.min(start, end, length));
  const b = Math.min(length, Math.max(start, end));
  const attrs: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(patch)) if (KNOWN_ATTRS.includes(key) && key !== 'href') attrs[key] = value || null;
  if (href !== undefined) attrs.href = href || null;
  if (b > a && Object.keys(attrs).length) t.format(a, b - a, attrs);
  writeMirror(m, t);
}

/** Layers whose `Y.Text` a transaction changed. */
export function textLayersChanged(nodes: Y.Map<unknown>, tr: Y.Transaction): Y.Map<unknown>[] {
  const out = new Set<Y.Map<unknown>>();
  tr.changed.forEach((_, type) => {
    if (!(type instanceof Y.Text) || type._item?.parentSub !== RICH_KEY) return;
    const m = type._item.parent;
    if (m instanceof Y.Map && m._item?.parent === nodes && !m._item.deleted) out.add(m as Y.Map<unknown>);
  });
  return [...out];
}

/**
 * After edits from two sides merged inside a layer's `Y.Text`, `text` and `spans` hold one side's version.
 * Puts the merged one there, for older builds. Every device that does this writes the same values.
 */
export function repairMirror(m: Y.Map<unknown>): boolean {
  if (m._item?.deleted) return false;
  const t = liveRich(m);
  if (!t) return false;
  const s = stateOf(t);
  if (m.get('text') === s.text && sameJson(m.get('spans'), s.spans)) return false;
  writeMirror(m, t);
  return true;
}
