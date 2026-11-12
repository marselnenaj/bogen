import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { readCodeRef, writeCodeRef, type CodeRef } from './code-components.ts';
import { editLayerText, formatLayerText, initLayerText, readLayerText, setLayerText } from './text-model.ts';
import { insertTarget, isVirtualId, materialize, ownerOf, patchInstanceStyle, patchViewFields, patchViewRules, patchViewStyle, releaseMains, resolveChildren, resolveNode, type NodeSource } from './components.ts';
import { readHandoff, type CodeHandoff } from './handoff.ts';
import { deleteRuleBlock, normalizeRules, patchRules, readRules, rulesToYMap, type LayerRules } from './layer-rules.ts';
import type { ProtoState } from './prototype.ts';
import { cleanLayoutGrids, type LayoutGrid } from './layout-grids.ts';

export type NodeType = 'frame' | 'text' | 'image' | 'svg' | 'shader' | 'video' | 'embed';
export type Style = Record<string, string>;

/** Plain read-only view of one layer. `style` uses camelCase CSS property names. */
export interface BogenNode {
  id: string;
  type: NodeType;
  name: string;
  /** A node id, or a page id for top-level layers. */
  parent: string;
  order: string;
  /** HTML element written on export and render, e.g. `section`, `h1`, `button`. */
  tag: string;
  style: Style;
  /** Text content for text layers. */
  text?: string;
  /** Asset or remote URL for image, video and embed layers. */
  src?: string;
  /** Sanitized markup for svg layers. */
  svg?: string;
  /** Effect parameters for shader layers, other HTML attributes for the rest. */
  attrs?: Record<string, string>;
  artboard?: boolean;
  hidden?: boolean;
  locked?: boolean;
  /** Text layers: ranges of `text` that look different or link somewhere. Additive: plain text has none. */
  spans?: TextSpan[];
  /** What this layer does in preview mode. Never part of an export. */
  proto?: LayerProto;
  /** On an instance: the main it shows. Everything inside it is then computed, not stored. */
  instanceOf?: string;
  /** On an instance: values of the main's props. */
  props?: Record<string, PropValue>;
  /** On an instance: `<path>#<field>` to a value. See components.ts. */
  overrides?: Record<string, PropValue>;
  /** Makes a layer a main, from which instances are made. */
  component?: ComponentDef;
  /** On a frame in a main: instances can fill it. */
  slotName?: string;
  /** On a layer whose parent is an instance: the slot it fills. */
  slot?: string;
  /** The theme mode this layer and everything in it use. */
  mode?: string;
  /** The key of a text style. */
  textStyle?: string;
  /** Only on views into an instance, which are not stored as themselves. */
  virtual?: { owner: string; path: string; source: string; mains: readonly string[] };
  /** On an embed: a component from the person's repository, rendered in a sandboxed frame. See code-components.ts. */
  code?: CodeRef;
  /** Pseudo-elements and conditional styles, by block such as `::before` or `@container (max-width: 560px)`. See layer-rules.ts. */
  rules?: LayerRules;
  /** On a frame: columns, rows or a grid drawn over it on the canvas. Never part of an export. See layout-grids.ts. */
  layoutGrids?: LayoutGrid[];
}

export type PropValue = string | boolean;
/** What a prop drives: a layer in the main, by path, and one of its fields. */
export interface PropTarget { path: string; field: string }
export interface ComponentProp { name: string; type: 'text' | 'boolean' | 'variant' | 'image'; default?: PropValue; options?: string[]; targets?: PropTarget[] }
export interface ComponentDef { description?: string; set?: string; variant?: Record<string, string>; props?: ComponentProp[]; /** The component in code it stands for. See handoff.ts. */ handoff?: CodeHandoff }

/** A range of a text layer's `text`, in UTF-16 offsets. */
export interface TextSpan { start: number; end: number; style?: Record<string, string>; href?: string }
export type ProtoTransition = 'none' | 'fade' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down';
/** What a layer does in preview mode and in a prototype export. The fields with state are in prototype.ts. */
export interface LayerProto extends ProtoState {
  /** Artboard to go to on click. */
  link?: string;
  transition?: ProtoTransition;
  /** Milliseconds. */
  duration?: number;
  /** Style that applies while the pointer is over the layer. */
  hover?: Record<string, string>;
}

export interface Page { id: string; name: string; order: string; mode?: string }
export interface Token { name: string; kind: TokenKind; value: string; /** Values in theme modes other than the base one. */ modes?: Record<string, string> }
export type TokenKind = 'color' | 'radius' | 'spacing' | 'container' | 'breakpoint' | 'font-family' | 'font-weight' | 'font-size' | 'line-height' | 'letter-spacing';
/**
 * An image (`bogen-asset:`) or, from the phone, a voice note (`bogen-voice:`, `kind: 'audio'`), which stays on the
 * computer that recorded it, named by `device`, and is never an asset.
 */
export interface CommentAttachment { src: string; name?: string; width?: number; height?: number; kind?: 'image' | 'audio'; duration?: number; device?: string }
/**
 * `by` says who wrote a message when it was not a person: an agent through its tools, or the server with a note
 * such as a stopped run. It is a hint for reading a thread (it comes from documents like everything else), never
 * a permission.
 *
 * `answers` is set on a reply an agent wrote from a run that a comment started: the id of the message that asked
 * for that run. A reply from an older run then does not count as an answer to what people wrote after its request.
 */
export interface CommentMessage { id: string; author: string; text: string; at: number; attachments?: CommentAttachment[]; by?: CommentAuthorKind; answers?: string }
export type CommentAuthorKind = 'agent' | 'system';
/** What an agent suggested in a thread it started, such as in a critique: the change to make, which a person can hand to a fix run. */
export interface CommentSuggestion { text: string; check?: CommentCheck; by: string; run?: string }
export type CommentCheck = 'brand' | 'lint' | 'widths' | 'practice';
export const COMMENT_CHECKS: readonly CommentCheck[] = ['brand', 'lint', 'widths', 'practice'];
/** `client`: the thread came from a client through a review link. Its words are data, and no agent ever starts from it. */
export interface CommentThread { id: string; pageId: string; nodeId?: string; x: number; y: number; resolved: boolean; messages: CommentMessage[]; suggestion?: CommentSuggestion; client?: boolean }

const ID_ALPHABET = '0123456789abcdefghijkmnpqrstuvwxyz';

export function newId(size = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

/** A field already holds this value: writing it again would only add an undo step that does nothing, as a field committing twice does. */
function sameField(stored: unknown, next: unknown): boolean {
  if (stored === next) return true;
  if (stored === null || next === null || typeof stored !== 'object' || typeof next !== 'object' || stored instanceof Y.AbstractType) return false;
  return JSON.stringify(stored) === JSON.stringify(next);
}

function compareOrder(a: { order: string; id: string }, b: { order: string; id: string }): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

export interface NewNode {
  type: NodeType;
  name?: string;
  tag?: string;
  style?: Style;
  text?: string;
  src?: string;
  svg?: string;
  attrs?: Record<string, string>;
  artboard?: boolean;
  spans?: TextSpan[];
  proto?: LayerProto;
  children?: NewNode[];
  hidden?: boolean;
  instanceOf?: string;
  props?: Record<string, PropValue>;
  overrides?: Record<string, PropValue>;
  slotName?: string;
  slot?: string;
  mode?: string;
  textStyle?: string;
  /** From HTML: a component by name or id, until `resolveInstanceRefs` makes it `instanceOf`. */
  instanceRef?: string;
  /** From HTML: the slot of the parent instance, by name. */
  slotRef?: string;
  /** Used instead when `instanceOf` is not in this file, such as after pasting from another. */
  materialized?: NewNode;
  /** Only for library copies (library.ts): the id this layer gets, the same on every device. */
  fixedId?: string;
  code?: CodeRef;
  rules?: LayerRules;
  layoutGrids?: LayoutGrid[];
}

const DEFAULT_NAMES: Record<NodeType, string> = { frame: 'Frame', text: 'Text', image: 'Image', svg: 'Vector', shader: 'Shader', video: 'Video', embed: 'Embed' };

/**
 * One design file. All writes go through `transact`, so each call is one undo step and one
 * network update. Pass an `origin` such as `agent:claude` to attribute a change to an actor.
 */
export class BogenDoc {
  readonly y: Y.Doc;
  readonly nodes: Y.Map<Y.Map<unknown>>;
  readonly pages: Y.Map<Y.Map<unknown>>;
  readonly tokens: Y.Map<Y.Map<unknown>>;
  readonly comments: Y.Map<Y.Map<unknown>>;
  readonly meta: Y.Map<unknown>;
  /** Theme modes by name. */
  readonly modes: Y.Map<Y.Map<unknown>>;
  /** Text styles by key. */
  readonly textStyles: Y.Map<Y.Map<unknown>>;
  /** Prototype variables by name. See prototype.ts. */
  readonly variables: Y.Map<Y.Map<unknown>>;
  /** Child ids by parent, in order. Built from parent and order alone: reading every layer whole after each write cost more than the write in a big file. */
  private childIndex: Map<string, readonly string[]> | null = null;
  private childNodes = new Map<string, BogenNode[]>();
  private rawCache = new Map<string, BogenNode>();
  private viewCache = new Map<string, readonly string[]>();
  private views = 0;
  /** What the component resolver reads. Stored layers only. */
  readonly source: NodeSource = {
    raw: (id) => this.rawNode(id),
    rawKids: (id) => this.rawKids(id),
    mainIds: () => {
      const out: string[] = [];
      this.nodes.forEach((m, id) => { if (m.get('component') !== undefined) out.push(id); });
      return out;
    },
    spend: (count) => (this.views += count) <= MAX_VIEWS,
    memo: () => (this.y._transaction ? undefined : this.nodeMemo),
  };
  private nodeMemo = new Map<string, BogenNode | undefined>();

  constructor(y: Y.Doc = new Y.Doc()) {
    this.y = y;
    this.nodes = y.getMap('nodes');
    this.pages = y.getMap('pages');
    this.tokens = y.getMap('tokens');
    this.comments = y.getMap('comments');
    this.meta = y.getMap('meta');
    this.modes = y.getMap('modes');
    this.textStyles = y.getMap('textStyles');
    this.variables = y.getMap('variables');
    const forget = () => {
      this.invalidate();
      this.views = 0;
    };
    // Observers run after the transaction has ended and before it says so, and they read too.
    y.on('beforeObserverCalls', forget);
    y.on('afterTransaction', forget);
  }

  transact<T>(fn: () => T, origin: unknown = null): T {
    return this.y.transact(fn, origin);
  }

  /** Adds the first page to an empty document. Only ever call this on the server. */
  ensureFirstPage(name = 'Page 1'): void {
    if (this.pages.size === 0) this.createPage(name);
  }

  // Reads

  /** A layer as it renders. An instance comes with its main applied, and ids inside one work too. */
  getNode(id: string): BogenNode | undefined {
    if (isVirtualId(id)) return resolveNode(this.source, id);
    const m = this.nodes.get(id);
    if (!m) return undefined;
    return m.get('instanceOf') !== undefined || m.get('slot') !== undefined ? resolveNode(this.source, id) : readNode(id, m);
  }

  /** Forgets what was read so far. For a reader inside a transaction that just wrote layers. */
  invalidate(): void {
    this.childIndex = null;
    this.childNodes.clear();
    this.rawCache.clear();
    this.viewCache.clear();
    this.nodeMemo.clear();
  }

  /** A layer as stored, without its main. Shared: do not change what this returns. */
  rawNode(id: string): BogenNode | undefined {
    // Inside a transaction what was read can change before the transaction ends.
    const open = this.y._transaction !== null;
    const known = open ? undefined : this.rawCache.get(id);
    if (known) return known;
    const m = this.nodes.get(id);
    if (!m) return undefined;
    const n = readNode(id, m);
    if (!open) this.rawCache.set(id, n);
    return n;
  }

  rawKids(id: string): readonly string[] {
    if (!this.childIndex) {
      const index = new Map<string, { id: string; order: string }[]>();
      this.nodes.forEach((m, id) => {
        const parent = String(m.get('parent'));
        const entry = { id, order: String(m.get('order')) };
        const list = index.get(parent);
        if (list) list.push(entry);
        else index.set(parent, [entry]);
      });
      this.childIndex = new Map([...index].map(([parent, list]) => [parent, list.sort(compareOrder).map((e) => e.id)]));
    }
    return this.childIndex.get(id) ?? [];
  }

  getPages(): Page[] {
    const out: Page[] = [];
    this.pages.forEach((m, id) => {
      const mode = m.get('mode');
      out.push({ id, name: String(m.get('name') ?? ''), order: String(m.get('order') ?? ''), ...(typeof mode === 'string' ? { mode } : {}) });
    });
    return out.sort(compareOrder);
  }

  /** Children as they render, in paint order. Layers whose parent is gone are not returned. */
  getChildren(parent: string): BogenNode[] {
    if (isVirtualId(parent) || this.nodes.get(parent)?.get('instanceOf') !== undefined) {
      let kids = this.viewCache.get(parent);
      if (!kids) {
        kids = resolveChildren(this.source, parent);
        if (!this.y._transaction) this.viewCache.set(parent, kids);
      }
      return kids.flatMap((id) => this.getNode(id) ?? []);
    }
    const list = this.rawChildren(parent);
    return list.some((n) => n.instanceOf !== undefined) ? list.flatMap((n) => this.getNode(n.id) ?? []) : list;
  }

  /** Children as stored: for an instance that is what fills its slots. */
  rawChildren(parent: string): BogenNode[] {
    let list = this.childNodes.get(parent);
    if (!list) {
      list = this.rawKids(parent).flatMap((id) => this.rawNode(id) ?? []);
      this.childNodes.set(parent, list);
    }
    return list;
  }

  /** The page a node lives on. Undefined when the node is orphaned or caught in a parent cycle. */
  pageOf(id: string): string | undefined {
    const seen = new Set<string>();
    let current = ownerOf(id);
    while (!seen.has(current)) {
      seen.add(current);
      if (this.pages.has(current)) return current;
      const n = this.nodes.get(current);
      if (!n) return undefined;
      current = String(n.get('parent'));
    }
    return undefined;
  }

  ancestors(id: string): string[] {
    const out: string[] = [];
    if (isVirtualId(id)) {
      for (let cur = this.getNode(id); cur && (this.nodes.has(cur.parent) || isVirtualId(cur.parent)); cur = this.getNode(cur.parent)) out.push(cur.parent);
      return out;
    }
    const seen = new Set<string>([id]);
    let n = this.nodes.get(id);
    while (n) {
      const p = String(n.get('parent'));
      if (seen.has(p) || !this.nodes.has(p)) break;
      seen.add(p);
      out.push(p);
      n = this.nodes.get(p);
    }
    return out;
  }

  descendants(id: string): BogenNode[] {
    const out: BogenNode[] = [];
    const walk = (p: string) => {
      for (const c of this.getChildren(p)) {
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }

  getTokens(): Token[] {
    const out: Token[] = [];
    this.tokens.forEach((m, name) => {
      const token: Token = { name, kind: m.get('kind') as TokenKind, value: String(m.get('value')) };
      for (const key of m.keys()) {
        if (!key.startsWith('mode:')) continue;
        const value = m.get(key);
        if (typeof value === 'string') (token.modes ??= {})[key.slice(5)] = value;
      }
      out.push(token);
    });
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  getComments(): CommentThread[] {
    const out: CommentThread[] = [];
    this.comments.forEach((m, id) => out.push(readThread(id, m)));
    return out;
  }

  // Pages

  createPage(name: string, origin?: unknown): string {
    const id = newId();
    const pages = this.getPages();
    this.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('name', name);
      m.set('order', generateKeyBetween(pages.at(-1)?.order ?? null, null));
      this.pages.set(id, m);
    }, origin);
    return id;
  }

  renamePage(id: string, name: string, origin?: unknown): void {
    this.transact(() => this.pages.get(id)?.set('name', name), origin);
  }

  deletePage(id: string, origin?: unknown): void {
    if (this.pages.size <= 1) throw new Error('A file needs at least one page.');
    this.transact(() => {
      const gone = new Set<string>();
      const walk = (p: string) => { for (const c of this.rawKids(p)) { gone.add(c); walk(c); } };
      walk(id);
      releaseMains(this, gone);
      for (const c of this.rawChildren(id)) this.deleteOne(c.id);
      this.pages.delete(id);
    }, origin);
  }

  movePage(id: string, index: number, origin?: unknown): void {
    const rest = this.getPages().filter((p) => p.id !== id);
    const clamped = Math.max(0, Math.min(index, rest.length));
    const order = generateKeyBetween(rest[clamped - 1]?.order ?? null, rest[clamped]?.order ?? null);
    this.transact(() => this.pages.get(id)?.set('order', order), origin);
  }

  // Layers

  private assertParent(parent: string): void {
    if (this.pages.has(parent)) return;
    const n = this.rawNode(parent);
    if (!n) throw new Error(`No page or layer with id ${parent}.`);
    if (n.type !== 'frame') throw new Error(`Layer ${parent} is a ${n.type} and cannot hold children.`);
  }

  /** Inserts a layer tree under `parent` at `index` (default: on top). Returns the root id. */
  insert(parent: string, spec: NewNode, index?: number, origin?: unknown): string {
    return this.insertMany(parent, [spec], index, origin)[0]!;
  }

  /** Stored children of a parent as seen from one slot, or all of them. */
  private siblingsIn(target: { parent: string; slot?: string }): BogenNode[] {
    const all = this.rawChildren(target.parent);
    return target.slot === undefined ? all : all.filter((n) => n.slot === target.slot);
  }

  insertMany(parent: string, specs: NewNode[], index?: number, origin?: unknown): string[] {
    const place = this.pages.has(parent) ? { parent } : insertTarget(this.source, parent);
    this.assertParent(place.parent);
    const siblings = this.siblingsIn(place);
    const at = index === undefined ? siblings.length : Math.max(0, Math.min(index, siblings.length));
    let before = siblings[at - 1]?.order ?? null;
    const after = siblings[at]?.order ?? null;
    const ids: string[] = [];
    this.transact(() => {
      for (const spec of specs) {
        const order = generateKeyBetween(before, after);
        before = order;
        ids.push(this.writeTree(place.parent, place.slot === undefined ? spec : { ...spec, slot: place.slot }, order));
      }
    }, origin);
    return ids;
  }

  /** Writes a tree as it is. Most callers want `insert`. */
  writeTree(parent: string, given: NewNode, order: string): string {
    // An instance copied from another file arrives as what it looked like.
    const spec = given.instanceOf !== undefined && !this.nodes.has(given.instanceOf) && given.materialized ? { ...given.materialized, ...(given.style ? { style: { ...given.materialized.style, ...given.style } } : {}), ...(given.slot !== undefined ? { slot: given.slot } : {}) } : given;
    const id = given.fixedId ?? newId();
    const m = new Y.Map<unknown>();
    m.set('type', spec.type);
    m.set('name', spec.name ?? DEFAULT_NAMES[spec.type]);
    m.set('parent', parent);
    m.set('order', order);
    m.set('tag', spec.tag ?? (spec.type === 'text' ? 'p' : 'div'));
    const style = new Y.Map<string>();
    for (const [k, v] of Object.entries(spec.style ?? {})) style.set(k, v);
    m.set('style', style);
    // A text layer's words are a CRDT text, so that edits from two sides merge. Written once the map is in the document.
    const rich = spec.type === 'text' && spec.text !== undefined && spec.instanceOf === undefined;
    if (spec.text !== undefined && !rich) m.set('text', spec.text);
    if (spec.src !== undefined) m.set('src', spec.src);
    if (spec.svg !== undefined) m.set('svg', spec.svg);
    if (spec.attrs) m.set('attrs', spec.attrs);
    if (spec.artboard) m.set('artboard', true);
    if (spec.spans?.length && !rich) m.set('spans', spec.spans);
    if (spec.proto) m.set('proto', spec.proto);
    if (spec.hidden) m.set('hidden', true);
    if (spec.instanceOf !== undefined) {
      m.set('instanceOf', spec.instanceOf);
      // Made here and not on first use: two people's first override must not replace each other's map.
      const props = new Y.Map<PropValue>();
      for (const [k, v] of Object.entries(spec.props ?? {})) props.set(k, v);
      m.set('props', props);
      const overrides = new Y.Map<PropValue>();
      for (const [k, v] of Object.entries(spec.overrides ?? {})) overrides.set(k, v);
      m.set('overrides', overrides);
    }
    if (spec.slotName !== undefined) m.set('slotName', spec.slotName);
    if (spec.slot !== undefined) m.set('slot', spec.slot);
    if (spec.mode) m.set('mode', spec.mode);
    if (spec.textStyle) m.set('textStyle', spec.textStyle);
    const grids = cleanLayoutGrids(spec.layoutGrids);
    if (grids) m.set('layoutGrids', grids);
    if (spec.code) writeCodeRef(m, spec.code);
    const rules = normalizeRules(spec.rules);
    if (rules) m.set('rules', rulesToYMap(rules));
    this.nodes.set(id, m);
    if (rich) initLayerText(m, spec.text!, spec.spans);
    let previous: string | null = null;
    for (const child of spec.children ?? []) {
      previous = generateKeyBetween(previous, null);
      this.writeTree(id, child, previous);
    }
    return id;
  }

  private need(id: string): Y.Map<unknown> {
    const m = this.nodes.get(id);
    if (!m) throw new Error(`No layer with id ${id}.`);
    return m;
  }

  /** Merges styles. An empty string or null removes the property. */
  updateStyle(id: string, patch: Record<string, string | null>, origin?: unknown): void {
    if (isVirtualId(id)) return this.transact(() => patchViewStyle(this, id, patch), origin);
    const m = this.need(id);
    if (m.get('instanceOf') !== undefined) return this.transact(() => patchInstanceStyle(this, id, patch), origin);
    this.transact(() => {
      const style = m.get('style') as Y.Map<string>;
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') style.delete(k);
        else if (style.get(k) !== v) style.set(k, v);
      }
    }, origin);
  }

  /**
   * Merges declarations into one block of a layer's rules, such as `::before` or `@media (max-width: 760px)`.
   * The block must be a key from `blockKey`. Null or '' removes a property. On an instance or inside one,
   * it is an override.
   */
  updateRules(id: string, block: string, patch: Record<string, string | null>, origin?: unknown): void {
    if (isVirtualId(id) || this.need(id).get('instanceOf') !== undefined) return this.transact(() => patchViewRules(this, id, block, patch), origin);
    const m = this.need(id);
    this.transact(() => patchRules(m, block, patch), origin);
  }

  /** Removes a whole block of a layer's rules. */
  deleteRules(id: string, block: string, origin?: unknown): void {
    const props = Object.keys(this.getNode(id)?.rules?.[block] ?? {});
    if (isVirtualId(id) || this.need(id).get('instanceOf') !== undefined) return this.transact(() => patchViewRules(this, id, block, Object.fromEntries(props.map((p) => [p, null]))), origin);
    const m = this.need(id);
    this.transact(() => deleteRuleBlock(m, block), origin);
  }

  /** Sets top-level fields of a layer. `undefined` removes a field. */
  updateFields(id: string, patch: Partial<Pick<BogenNode, 'name' | 'tag' | 'text' | 'src' | 'svg' | 'attrs' | 'hidden' | 'locked' | 'artboard' | 'spans' | 'proto' | 'textStyle' | 'mode' | 'slotName' | 'layoutGrids'>>, origin?: unknown): void {
    // Grids are a plain list: only what is one goes in, and an empty list is none.
    if ('layoutGrids' in patch) patch = { ...patch, layoutGrids: cleanLayoutGrids(patch.layoutGrids) };
    if (isVirtualId(id)) return this.transact(() => patchViewFields(this, id, patch), origin);
    const m = this.need(id);
    if (m.get('instanceOf') !== undefined) return this.transact(() => patchViewFields(this, id, patch), origin);
    this.transact(() => {
      // Text goes in as the stretch that changed, so that it merges with others typing; without spans, ranges follow it.
      const textual = m.get('type') === 'text' && ('text' in patch || 'spans' in patch);
      if (textual) setLayerText(m, 'text' in patch ? patch.text ?? '' : undefined, 'spans' in patch ? patch.spans ?? [] : undefined);
      for (const [k, v] of Object.entries(patch)) {
        if (textual && (k === 'text' || k === 'spans')) continue;
        if (v === undefined) {
          if (m.has(k)) m.delete(k);
        } else if (!sameField(m.get(k), v)) m.set(k, v);
      }
    }, origin);
  }

  /**
   * Applies one writer's edit of a text layer: from the text it last saw to what it has now, on top of what
   * others changed in between. Returns what the layer shows afterwards.
   */
  editText(id: string, base: string, next: string, origin?: unknown): string {
    const m = this.nodes.get(id);
    if (!m || m.get('type') !== 'text' || m.get('instanceOf') !== undefined) {
      this.updateFields(id, { text: next }, origin);
      return this.getNode(id)?.text ?? next;
    }
    return this.transact(() => editLayerText(m, base, next), origin);
  }

  /** Styles a range of a text layer's text, in UTF-16 offsets. A null value clears a property; `href` null removes a link. */
  formatText(id: string, start: number, end: number, patch: Record<string, string | null>, href?: string | null, origin?: unknown): void {
    const m = this.need(id);
    if (m.get('type') !== 'text' || m.get('instanceOf') !== undefined) throw new Error(`Layer ${id} is not a text layer of its own.`);
    this.transact(() => formatLayerText(m, start, end, patch, href), origin);
  }

  /** Moves layers under `parent` at `index`, keeping their relative order. */
  move(ids: string[], parent: string, index?: number, origin?: unknown): void {
    const place = this.pages.has(parent) ? { parent } : insertTarget(this.source, parent);
    this.assertParent(place.parent);
    for (const id of ids) {
      if (isVirtualId(id)) throw new Error(`Layer ${id} is inside an instance and keeps its place there. Edit the main, or call instance_detach first.`);
      this.need(id);
      if (id === parent || this.ancestors(parent).includes(id)) throw new Error(`Layer ${id} cannot move into itself.`);
    }
    const moving = new Set(ids);
    const siblings = this.siblingsIn(place);
    const target = index === undefined ? siblings.length : Math.max(0, Math.min(index, siblings.length));
    const left = siblings.slice(0, target).filter((s) => !moving.has(s.id)).at(-1)?.order ?? null;
    const right = siblings.slice(target).find((s) => !moving.has(s.id))?.order ?? null;
    this.transact(() => {
      let before = left;
      for (const id of ids) {
        const order = generateKeyBetween(before, right);
        before = order;
        const m = this.nodes.get(id)!;
        if (m.get('parent') !== place.parent) m.set('parent', place.parent);
        if (place.slot !== undefined) { if (m.get('slot') !== place.slot) m.set('slot', place.slot); }
        else if (m.has('slot')) m.delete('slot');
        m.set('order', order);
      }
    }, origin);
  }

  private deleteOne(id: string): void {
    for (const c of this.rawChildren(id)) this.deleteOne(c.id);
    this.nodes.delete(id);
  }

  /** A layer inside an instance cannot leave it, so deleting one hides it there. */
  delete(ids: string[], origin?: unknown): void {
    this.transact(() => {
      const gone = new Set<string>();
      const walk = (p: string) => { for (const c of this.rawKids(p)) if (!gone.has(c)) { gone.add(c); walk(c); } };
      for (const id of ids) {
        if (isVirtualId(id)) patchViewFields(this, id, { hidden: true });
        else if (this.nodes.has(id)) { gone.add(id); walk(id); }
      }
      releaseMains(this, gone);
      for (const id of gone) this.nodes.delete(id);
    }, origin);
  }

  /** The tree under a layer as a spec that `insert` accepts. */
  toSpec(id: string): NewNode {
    if (isVirtualId(id)) return materialize(this, id);
    const m = this.nodes.get(id);
    if (!m) throw new Error(`No layer with id ${id}.`);
    const n = readNode(id, m);
    const children = this.rawChildren(id).map((c) => this.toSpec(c.id));
    return {
      ...(n.instanceOf !== undefined ? { instanceOf: n.instanceOf, props: n.props ?? {}, overrides: n.overrides ?? {} } : {}),
      ...(n.slotName !== undefined ? { slotName: n.slotName } : {}),
      ...(n.slot !== undefined ? { slot: n.slot } : {}),
      ...(n.mode ? { mode: n.mode } : {}),
      ...(n.textStyle ? { textStyle: n.textStyle } : {}),
      ...(n.code ? { code: n.code } : {}),
      ...(n.rules ? { rules: n.rules } : {}),
      ...(n.layoutGrids ? { layoutGrids: n.layoutGrids } : {}),
      type: n.type, name: n.name, tag: n.tag, style: n.style, text: n.text, src: n.src, svg: n.svg, attrs: n.attrs, artboard: n.artboard, spans: n.spans, proto: n.proto,
      ...(children.length ? { children } : {}),
    };
  }

  /** Duplicates each layer right above its original. Returns the new ids in input order. */
  duplicate(ids: string[], origin?: unknown): string[] {
    const out: string[] = [];
    this.transact(() => {
      // Copying a layer inside an instance means copying the instance.
      for (const id of new Set(ids.map(ownerOf))) {
        const n = this.getNode(id);
        if (!n) throw new Error(`No layer with id ${id}.`);
        const index = this.getChildren(n.parent).findIndex((c) => c.id === id);
        out.push(this.insert(n.parent, this.toSpec(id), index + 1));
      }
    }, origin);
    return out;
  }

  // Tokens

  setToken(name: string, kind: TokenKind, value: string, origin?: unknown): void {
    if (!/^[a-zA-Z_][\w-]*$/.test(name)) throw new Error(`"${name}" is not a valid token name. Use letters, digits, - and _.`);
    this.transact(() => {
      let m = this.tokens.get(name);
      if (!m) {
        m = new Y.Map();
        this.tokens.set(name, m);
      }
      m.set('kind', kind);
      m.set('value', value);
    }, origin);
  }

  deleteToken(name: string, origin?: unknown): void {
    this.transact(() => this.tokens.delete(name), origin);
  }

  // Comments

  addThread(thread: { pageId: string; nodeId?: string; x: number; y: number; author: string; text: string; attachments?: CommentAttachment[]; suggestion?: CommentSuggestion; client?: boolean; by?: CommentAuthorKind }, origin?: unknown): string {
    const id = newId();
    this.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('pageId', thread.pageId);
      if (thread.nodeId) m.set('nodeId', thread.nodeId);
      m.set('x', thread.x);
      m.set('y', thread.y);
      m.set('resolved', false);
      if (thread.client) m.set('client', true);
      const messages = new Y.Array<CommentMessage>();
      messages.push([{ id: newId(), author: thread.author, text: thread.text, at: Date.now(), ...(thread.attachments?.length ? { attachments: thread.attachments } : {}), ...(thread.by ? { by: thread.by } : {}) }]);
      m.set('messages', messages);
      if (thread.suggestion) m.set('suggestion', { ...thread.suggestion, text: thread.suggestion.text.slice(0, 2000) });
      this.comments.set(id, m);
    }, origin);
    return id;
  }

  replyThread(id: string, author: string, text: string, origin?: unknown, attachments?: CommentAttachment[], by?: CommentAuthorKind, answers?: string): void {
    const m = this.comments.get(id);
    if (!m) throw new Error(`No comment thread with id ${id}.`);
    this.transact(() => (m.get('messages') as Y.Array<CommentMessage>).push([{ id: newId(), author, text, at: Date.now(), ...(attachments?.length ? { attachments } : {}), ...(by ? { by } : {}), ...(answers ? { answers } : {}) }]), origin);
  }

  setThreadResolved(id: string, resolved: boolean, origin?: unknown): void {
    const m = this.comments.get(id);
    if (!m) throw new Error(`No comment thread with id ${id}.`);
    this.transact(() => m.set('resolved', resolved), origin);
  }

  deleteThread(id: string, origin?: unknown): void {
    this.transact(() => this.comments.delete(id), origin);
  }
}

/** How many layers inside instances a document may ask for before it stops expanding. */
const MAX_VIEWS = 200_000;

/** Values of a nested map, only strings and booleans. Documents can come from other people. */
function readValues(v: unknown): Record<string, PropValue> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, PropValue> = {};
  const add = (value: unknown, key: string) => { if ((typeof value === 'string' || typeof value === 'boolean') && key !== '__proto__') out[key] = value; };
  if (v instanceof Y.Map) v.forEach(add);
  else for (const [key, value] of Object.entries(v)) add(value, key);
  return out;
}

function readComponent(v: unknown): ComponentDef | undefined {
  if (!(v instanceof Y.Map)) return undefined;
  const def: ComponentDef = {};
  const description = v.get('description');
  if (typeof description === 'string') def.description = description;
  const set = v.get('set');
  if (typeof set === 'string' && set) def.set = set;
  const variant = v.get('variant');
  if (variant && typeof variant === 'object') def.variant = Object.fromEntries(Object.entries(variant).filter((e): e is [string, string] => typeof e[1] === 'string'));
  const props = v.get('props');
  const list: (ComponentProp & { order?: number })[] = [];
  if (props instanceof Y.Map) {
    props.forEach((value: unknown, name: string) => {
      if (value && typeof value === 'object' && ['text', 'boolean', 'variant', 'image'].includes((value as ComponentProp).type)) list.push({ ...(value as ComponentProp), name });
    });
  }
  def.props = list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(({ order: _order, ...p }) => p);
  const handoff = readHandoff(v.get('handoff'));
  if (handoff) def.handoff = handoff;
  return def;
}

function readNode(id: string, m: Y.Map<unknown>): BogenNode {
  const style = m.get('style') as Y.Map<string> | undefined;
  const n: BogenNode = {
    id,
    type: m.get('type') as NodeType,
    name: String(m.get('name') ?? ''),
    parent: String(m.get('parent')),
    order: String(m.get('order')),
    tag: String(m.get('tag') ?? 'div'),
    style: style ? style.toJSON() : {},
  };
  const shown = readLayerText(m);
  if (typeof shown.text === 'string') n.text = shown.text;
  for (const key of ['src', 'svg'] as const) {
    const v = m.get(key);
    if (typeof v === 'string') n[key] = v;
  }
  const attrs = m.get('attrs');
  if (attrs) n.attrs = attrs as Record<string, string>;
  if (m.get('artboard')) n.artboard = true;
  if (m.get('hidden')) n.hidden = true;
  if (m.get('locked')) n.locked = true;
  if (Array.isArray(shown.spans) && shown.spans.length) n.spans = shown.spans as TextSpan[];
  const proto = m.get('proto');
  if (proto && typeof proto === 'object') n.proto = proto as LayerProto;
  const instanceOf = m.get('instanceOf');
  if (typeof instanceOf === 'string') {
    n.instanceOf = instanceOf;
    n.props = readValues(m.get('props')) ?? {};
    n.overrides = readValues(m.get('overrides')) ?? {};
  }
  const code = readCodeRef(m);
  if (code) n.code = code;
  const component = readComponent(m.get('component'));
  if (component) n.component = component;
  const rules = readRules(m.get('rules'));
  if (rules) n.rules = rules;
  const grids = cleanLayoutGrids(m.get('layoutGrids'));
  if (grids) n.layoutGrids = grids;
  for (const key of ['slotName', 'slot', 'mode', 'textStyle'] as const) {
    const v = m.get(key);
    if (typeof v === 'string') n[key] = v;
  }
  return n;
}

function readThread(id: string, m: Y.Map<unknown>): CommentThread {
  const nodeId = m.get('nodeId');
  return {
    id,
    pageId: String(m.get('pageId')),
    ...(typeof nodeId === 'string' ? { nodeId } : {}),
    x: Number(m.get('x')),
    y: Number(m.get('y')),
    resolved: Boolean(m.get('resolved')),
    messages: (m.get('messages') as Y.Array<CommentMessage>).toArray(),
    ...readSuggestion(m.get('suggestion')),
    ...(m.get('client') === true ? { client: true } : {}),
  };
}

/** Threads arrive from other devices, so a suggestion is only what it should be. */
function readSuggestion(raw: unknown): { suggestion?: CommentSuggestion } {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== 'string' || !r.text || typeof r.by !== 'string') return {};
  const check = COMMENT_CHECKS.find((c) => c === r.check);
  return { suggestion: { text: r.text.slice(0, 2000), by: r.by.slice(0, 80), ...(check ? { check } : {}), ...(typeof r.run === 'string' ? { run: r.run.slice(0, 40) } : {}) } };
}
