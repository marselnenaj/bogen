import * as Y from 'yjs';
import { CONTENT_LANGUAGE_KEY } from './content-language.ts';
import { LABEL_KEY } from './changes.ts';
import { BogenDoc } from './doc.ts';
import { liveRich, MARK_KEY, plainTextFields, readLayerText, RICH_KEY, setLayerText } from './text-model.ts';
import { addFontFaces, getFontFaces, type StoredFontFace } from './font-faces.ts';
import { getInteractionRecords, setInteractionRecord, type InteractionRecord } from './interaction-states.ts';
import type { RepeatBinding } from './repeat.ts';

/**
 * A document as plain data, without its CRDT history. Versions and design folders both use this, and
 * applying it to a live document changes only what differs, in one transaction, so it is one undo step
 * and merges with whatever anyone else is doing.
 *
 * Layers keep every field they have, including ones this file has never heard of, and nested maps stay
 * maps (`{"$map": {...}}`), so a field added tomorrow survives a round trip. Comments are a conversation
 * and not part of the design, so they stay out of it.
 */
export interface ContentNode {
  id: string;
  parent: string;
  order: string;
  type: string;
  name: string;
  tag: string;
  style: Record<string, string>;
  [field: string]: unknown;
}

export interface ContentPage { id: string; name: string; order: string; [field: string]: unknown }
export interface ContentToken { name: string; kind: string; value: string; [field: string]: unknown }

export interface DesignContent {
  format: 1;
  pages: ContentPage[];
  /** Parents before children, siblings in paint order. Layers no page reaches are left out. */
  nodes: ContentNode[];
  tokens: ContentToken[];
  keyframes: string[];
  fontFaces: StoredFontFace[];
  interactionStates: (InteractionRecord & { artboardId: string })[];
  /** Live-data templates and their copies, by template id. */
  repeats?: Record<string, RepeatBinding>;
  /** Other document-wide maps, by name: theme modes, text styles and whatever comes next. */
  extra?: Record<string, Record<string, unknown>>;
}

/**
 * Maps this file reads and writes by its own rules. Anything else in the document goes through `extra`. The branches
 * of a file (design-branches.ts) hold versions of the design itself, so a version never contains them and applying
 * one never touches them.
 */
const OWN_MAPS = new Set(['nodes', 'pages', 'tokens', 'comments', 'fontFaces', 'interactionStates', 'repeats', 'designBranches', 'translationMemory']);

/** The comment threads as they were, for a commit's record. Restoring a commit leaves comments alone. */
export function commentsToContent(doc: BogenDoc): Record<string, unknown> {
  return encodeFields(doc.comments as unknown as Y.Map<unknown>);
}

function encode(value: unknown): unknown {
  if (value instanceof Y.Map) {
    const out: Record<string, unknown> = {};
    for (const key of [...value.keys()].sort()) out[key] = encode(value.get(key));
    return { $map: out };
  }
  if (value instanceof Y.Array) return { $array: value.toArray().map(encode) };
  return value;
}

function decode(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.$map && typeof record.$map === 'object') {
      const map = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(record.$map as Record<string, unknown>)) map.set(k, decode(v));
      return map;
    }
    if (Array.isArray(record.$array)) {
      const list = new Y.Array<unknown>();
      list.push(record.$array.map(decode));
      return list;
    }
  }
  return value;
}

function encodeFields(m: Y.Map<unknown>, skip: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of m.keys()) if (!skip.includes(key)) out[key] = encode(m.get(key));
  // A text layer is kept as what it shows. Its CRDT text is how it merges, not part of the design.
  const plain = plainTextFields(m);
  for (const [key, value] of Object.entries(plain ?? {})) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Sets fields on a map where they differ, and removes the ones the target does not have. */
function syncFields(m: Y.Map<unknown>, target: Record<string, unknown>, skip: string[] = []): void {
  for (const key of [...m.keys()]) if (!skip.includes(key) && !(key in target)) m.delete(key);
  for (const [key, value] of Object.entries(target)) {
    if (value === undefined || skip.includes(key)) continue;
    if (!same(encode(m.get(key)), value)) m.set(key, decode(value));
  }
}

function collectNodes(doc: BogenDoc, parent: string, out: ContentNode[]): void {
  for (const child of doc.rawChildren(parent)) {
    const m = doc.nodes.get(child.id)!;
    const style = m.get('style');
    out.push({ ...encodeFields(m, ['style']), id: child.id, style: style instanceof Y.Map ? style.toJSON() as Record<string, string> : {} } as ContentNode);
    collectNodes(doc, child.id, out);
  }
}

function rootMaps(doc: BogenDoc): [string, Y.Map<unknown>][] {
  const out: [string, Y.Map<unknown>][] = [];
  for (const name of doc.y.share.keys()) {
    if (OWN_MAPS.has(name)) continue;
    try {
      out.push([name, doc.y.getMap(name)]);
    } catch {
      // A shared type that is not a map. Nothing here writes one, so nothing here reads it either.
    }
  }
  return out;
}

export function docToContent(doc: BogenDoc): DesignContent {
  const pages: ContentPage[] = doc.getPages().map((p) => ({ ...encodeFields(doc.pages.get(p.id)!), id: p.id, name: p.name, order: p.order }));
  const nodes: ContentNode[] = [];
  for (const page of pages) collectNodes(doc, page.id, nodes);
  // Copies of shared library components sit under a parent that is no page (library.ts).
  const libraries = new Set<string>();
  doc.nodes.forEach((m) => {
    const parent = m.get('parent');
    if (typeof parent === 'string' && parent.startsWith('lib:')) libraries.add(parent);
  });
  for (const parent of [...libraries].sort()) collectNodes(doc, parent, nodes);
  const tokens: ContentToken[] = [];
  doc.tokens.forEach((m, name) => tokens.push({ ...encodeFields(m), name } as ContentToken));
  tokens.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const keyframes = doc.meta.get('keyframes');
  const repeats = doc.y.getMap('repeats').toJSON() as Record<string, RepeatBinding>;
  const extra: Record<string, Record<string, unknown>> = {};
  for (const [name, map] of rootMaps(doc)) {
    const fields = encodeFields(map, name === 'meta' ? ['keyframes', LABEL_KEY] : []);
    const keys = Object.keys(fields).sort();
    if (keys.length) extra[name] = Object.fromEntries(keys.map((k) => [k, fields[k]]));
  }
  return {
    format: 1,
    pages,
    nodes,
    tokens,
    keyframes: Array.isArray(keyframes) ? keyframes.filter((k): k is string => typeof k === 'string') : [],
    fontFaces: getFontFaces(doc),
    interactionStates: getInteractionRecords(doc),
    ...(Object.keys(repeats).length ? { repeats } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

/** Rejects anything that would make a broken document. The values themselves are sanitized at render. */
export function assertContent(value: unknown): asserts value is DesignContent {
  const c = value as DesignContent;
  const bad = (what: string): never => {
    throw new Error(`This design is damaged: ${what}.`);
  };
  if (!c || typeof c !== 'object') bad('it is not an object');
  if (!Array.isArray(c.pages) || !c.pages.length) bad('it has no pages');
  if (!Array.isArray(c.nodes) || !Array.isArray(c.tokens)) bad('layers or tokens are missing');
  const ids = new Set<string>();
  for (const p of c.pages) {
    if (typeof p?.id !== 'string' || !p.id || typeof p.name !== 'string' || typeof p.order !== 'string') bad('a page has no id, name or order');
    if (ids.has(p.id)) bad(`page id ${p.id} appears twice`);
    ids.add(p.id);
  }
  for (const n of c.nodes) {
    if (typeof n?.id !== 'string' || !n.id || typeof n.parent !== 'string' || typeof n.order !== 'string' || typeof n.type !== 'string') bad('a layer has no id, parent, order or type');
    if (!n.style || typeof n.style !== 'object' || Array.isArray(n.style)) bad(`layer ${n.id} has no style`);
    if (ids.has(n.id)) bad(`id ${n.id} appears twice`);
    // A shared library's copy hangs off its library, which is not a page (library.ts).
    if (!ids.has(n.parent) && !n.parent.startsWith('lib:')) bad(`layer ${n.id} comes before its parent ${n.parent}`);
    ids.add(n.id);
  }
  for (const t of c.tokens) if (typeof t?.name !== 'string' || typeof t.value !== 'string' || typeof t.kind !== 'string') bad('a token has no name, kind or value');
}

function writeStyle(style: Y.Map<string>, target: Record<string, string>): void {
  for (const key of [...style.keys()]) if (!(key in target)) style.delete(key);
  for (const [key, value] of Object.entries(target)) {
    if (typeof value === 'string' && style.get(key) !== value) style.set(key, value);
  }
}

/** Makes the document's design equal the content, touching only what differs. Fonts are only ever added. */
export function applyContent(doc: BogenDoc, content: DesignContent, origin?: unknown): void {
  assertContent(content);
  doc.transact(() => {
    const pageIds = new Set(content.pages.map((p) => p.id));
    const nodeIds = new Set(content.nodes.map((n) => n.id));
    for (const page of content.pages) {
      const { id, ...fields } = page;
      let m = doc.pages.get(id);
      if (!m) {
        m = new Y.Map<unknown>();
        doc.pages.set(id, m);
      }
      syncFields(m, fields);
    }
    for (const node of content.nodes) {
      const { id, style, ...fields } = node;
      let m = doc.nodes.get(id);
      if (!m) {
        m = new Y.Map<unknown>();
        m.set('style', new Y.Map<string>());
        doc.nodes.set(id, m);
      }
      const live = liveRich(m);
      if (live) {
        const { text, spans, ...rest } = fields;
        syncFields(m, rest, ['style', 'text', 'spans', RICH_KEY, MARK_KEY]);
        const shown = readLayerText(m);
        if (shown.text !== text || !same(shown.spans ?? [], spans ?? [])) setLayerText(m, typeof text === 'string' ? text : '', spans ?? []);
      } else syncFields(m, fields, ['style', RICH_KEY, MARK_KEY]);
      const liveStyle = m.get('style');
      if (liveStyle instanceof Y.Map) writeStyle(liveStyle as Y.Map<string>, style);
      else {
        const fresh = new Y.Map<string>();
        m.set('style', fresh);
        writeStyle(fresh, style);
      }
    }
    for (const id of [...doc.nodes.keys()]) if (!nodeIds.has(id)) doc.nodes.delete(id);
    for (const id of [...doc.pages.keys()]) if (!pageIds.has(id)) doc.pages.delete(id);

    const tokenNames = new Set(content.tokens.map((t) => t.name));
    for (const name of [...doc.tokens.keys()]) if (!tokenNames.has(name)) doc.tokens.delete(name);
    for (const { name, ...fields } of content.tokens) {
      let m = doc.tokens.get(name);
      if (!m) {
        m = new Y.Map<unknown>();
        doc.tokens.set(name, m);
      }
      syncFields(m, fields);
    }
    const keyframes = content.keyframes ?? [];
    if (!same(doc.meta.get('keyframes') ?? [], keyframes)) {
      if (keyframes.length) doc.meta.set('keyframes', keyframes);
      else doc.meta.delete('keyframes');
    }
    for (const [name, fields] of Object.entries(content.extra ?? {})) {
      if (OWN_MAPS.has(name) || !fields || typeof fields !== 'object') continue;
      syncFields(doc.y.getMap(name), fields, name === 'meta' ? ['keyframes', LABEL_KEY] : []);
    }
    for (const [name, map] of rootMaps(doc)) {
      if (name !== 'meta' && !(content.extra && name in content.extra)) for (const key of [...map.keys()]) map.delete(key);
    }
    // A design whose meta holds nothing else has no meta in its content at all, and then the loop above leaves meta
    // as it was. Its design language must still go: else a language version's language stays on main after a checkout.
    if (!(content.extra?.meta && CONTENT_LANGUAGE_KEY in content.extra.meta) && doc.meta.has(CONTENT_LANGUAGE_KEY)) doc.meta.delete(CONTENT_LANGUAGE_KEY);
    // Canvas maps belong to the checked-out content too; an unplanned Main must not inherit a branch's map.
    for (const key of [...doc.meta.keys()]) if ((key.startsWith('canvasPlan:') || key === 'canvasCover') && !(content.extra?.meta && key in content.extra.meta)) doc.meta.delete(key);
    addFontFaces(doc, content.fontFaces ?? []);
    for (const record of content.interactionStates ?? []) {
      if (doc.nodes.has(record.artboardId)) setInteractionRecord(doc, record.artboardId, { url: record.url, rules: record.rules });
    }
    const repeatMap = doc.y.getMap('repeats');
    for (const [id, binding] of Object.entries(content.repeats ?? {})) {
      if (doc.nodes.has(id) && !same(repeatMap.get(id), binding)) repeatMap.set(id, binding);
    }
  }, origin);
}

/** A private document holding the content, for previews and exports. */
export function docFromContent(content: DesignContent): BogenDoc {
  const doc = new BogenDoc(new Y.Doc());
  applyContent(doc, content);
  return doc;
}

/** How much a version differs from now, for showing before restoring. */
export function contentDelta(from: DesignContent, to: DesignContent): { added: number; removed: number; changed: number } {
  const before = new Map(from.nodes.map((n) => [n.id, JSON.stringify(n)]));
  let added = 0;
  let changed = 0;
  const seen = new Set<string>();
  for (const node of to.nodes) {
    seen.add(node.id);
    const old = before.get(node.id);
    if (old === undefined) added++;
    else if (old !== JSON.stringify(node)) changed++;
  }
  return { added, changed, removed: from.nodes.filter((n) => !seen.has(n.id)).length };
}
