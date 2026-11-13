import * as Y from 'yjs';
import { createComponent, enclosingMain, instancesOf, listMains, materialize, ownerOf } from './components.ts';
import { getTextStyles, setTextStyle, TEXT_STYLE_PROPS, type TextStyle } from './design-system.ts';
import { normalizeRules, readNestedRules, type LayerRules } from './layer-rules.ts';
import type { BogenDoc, ComponentDef, NewNode, NodeType, PropValue, Token, TokenKind } from './doc.ts';
import { readHandoff } from './handoff.ts';
import { applyTokenRenames, cleanTokenRenames, resolveRenames, tokenRenames, type TokenRename, type TokenRenameReport } from './token-rename.ts';

/**
 * Shared libraries. A file or a brand publishes its components: a copy of each main's tree, with
 * its own ids, goes into the document's `libraryPublished` map, so that it travels with the file to
 * every device. A file that links the library keeps its own copy of what it uses, under a parent
 * that is no page (`lib:<library>`), with ids made from the library's id and the layer's, so that
 * every device and every paste arrives at the same ids. Instances point at that copy with the usual
 * `instanceOf`, so they render with no library around, overrides keep pointing at the same layers
 * after an update, and the component resolver needs nothing new. An update replaces the copy only
 * when someone accepts it.
 */

export interface LibraryInfo {
  name: string; description?: string; version: number; publishedAt: number; by?: string;
  /** Tokens the library renamed, so that files using it can follow (token-rename.ts). */
  renames?: TokenRename[];
}
/** `renamesAt`: the newest library rename this file has taken over, or was linked after. */
export interface LibraryLink { id: string; name: string; kind?: 'file' | 'brand'; linkedAt: number; by?: string; renamesAt?: number }

/** One layer of a published component, with the library's own ids. */
export interface LibraryTree {
  id: string;
  type: NodeType;
  name?: string;
  tag?: string;
  style?: Record<string, string>;
  text?: string;
  src?: string;
  svg?: string;
  attrs?: Record<string, string>;
  spans?: NewNode['spans'];
  hidden?: boolean;
  instanceOf?: string;
  props?: Record<string, PropValue>;
  overrides?: Record<string, PropValue>;
  slotName?: string;
  slot?: string;
  mode?: string;
  textStyle?: string;
  rules?: LayerRules;
  component?: ComponentDef;
  children?: LibraryTree[];
}

export interface PublishedComponent {
  /** The main's id in the library. */
  main: string;
  name: string;
  description?: string;
  set?: string;
  variant?: Record<string, string>;
  tree: LibraryTree;
  /** Other published mains its tree shows. */
  needs: string[];
  tokens: Token[];
  textStyles: TextStyle[];
  hash: string;
  version: number;
  at: number;
}

/** Stored on the root of a library copy in a file that uses it. */
export interface CachedMeta { lib: string; main: string; name: string; version: number; hash: string; at: number; removed?: boolean }

/** A library copy as real layers, ids already this file's. What the clipboard carries. */
export interface CachedTree extends NewNode {
  fixedId: string;
  component?: ComponentDef;
  children?: CachedTree[];
}

export interface LibraryClip { link: LibraryLink; roots: { meta: CachedMeta; tree: CachedTree; tokens: Token[]; textStyles: TextStyle[] }[] }

export interface LibraryUpdate { lib: string; main: string; id: string; name: string; status: 'new' | 'changed' | 'removed'; from?: number; to?: number; instances: number }

const PARENT_PREFIX = 'lib:';
const MAX_TREE = 20_000;
const NODE_TYPES = new Set<NodeType>(['frame', 'text', 'image', 'svg', 'shader', 'video', 'embed']);
const SIDES = ['left', 'top', 'right', 'bottom'];
const LAYER_ID = /^[\w-]{1,64}$/;

export const libraryParent = (libId: string): string => `${PARENT_PREFIX}${libId}`;
export const isLibraryParent = (parent: string | undefined): boolean => !!parent && parent.startsWith(PARENT_PREFIX);

function publishedMap(doc: BogenDoc): Y.Map<unknown> {
  return doc.y.getMap('libraryPublished');
}

function linksMap(doc: BogenDoc): Y.Map<unknown> {
  return doc.y.getMap('libraries');
}

/** A 53-bit hash, the same in Node and the browser. */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The id a library layer has in every file that uses it. */
export function libraryLayerId(libId: string, layerId: string): string {
  return `l${hash53(`${libId}:${layerId}`).toString(36).padStart(11, '0')}`;
}

function mapPath(libId: string, path: string): string {
  return path.split('/').map((seg) => (seg === '' || seg === '.' ? seg : libraryLayerId(libId, seg))).join('/');
}

function mapKey(libId: string, key: string): string {
  const at = key.lastIndexOf('#');
  return at < 0 ? key : `${mapPath(libId, key.slice(0, at))}${key.slice(at)}`;
}

// Publishing

export function libraryInfo(doc: BogenDoc): LibraryInfo | undefined {
  const v = doc.meta.get('library');
  if (!v || typeof v !== 'object') return undefined;
  const info = v as Partial<LibraryInfo>;
  if (typeof info.name !== 'string') return undefined;
  const renames = Array.isArray(info.renames) ? cleanTokenRenames(info.renames) : [];
  return { name: info.name, version: Number(info.version) || 0, publishedAt: Number(info.publishedAt) || 0, ...(typeof info.description === 'string' ? { description: info.description } : {}), ...(typeof info.by === 'string' ? { by: info.by } : {}), ...(renames.length ? { renames } : {}) };
}

/** Mains a file can publish: on a page, not inside another main, and not a copy from another library. */
export function publishableMains(doc: BogenDoc) {
  return listMains(doc.source).filter((m) => !isLibraryParent(m.parent) && doc.pageOf(m.id) !== undefined && enclosingMain(doc, m.parent) === undefined);
}

const VAR_REF = /var\(\s*--([\w-]+)/g;

function referencedTokens(doc: BogenDoc, trees: LibraryTree[]): { tokens: Token[]; textStyles: TextStyle[] } {
  const names = new Set<string>();
  const styles = new Set<string>();
  const scan = (text: string) => { for (const m of text.matchAll(VAR_REF)) names.add(m[1]!); };
  const walk = (t: LibraryTree) => {
    for (const v of Object.values(t.style ?? {})) scan(v);
    for (const s of t.spans ?? []) for (const v of Object.values(s.style ?? {})) scan(v);
    for (const [k, v] of Object.entries(t.overrides ?? {})) if (k.includes('#style.') && typeof v === 'string') scan(v);
    if (t.textStyle) styles.add(t.textStyle);
    t.children?.forEach(walk);
  };
  trees.forEach(walk);
  const textStyles = getTextStyles(doc).filter((s) => styles.has(s.key));
  for (const s of textStyles) for (const v of Object.values(s.style)) scan(v);
  const all = new Map(doc.getTokens().map((t) => [t.name, t]));
  const out: Token[] = [];
  // Aliases: a token that reads another brings that one too.
  const queue = [...names];
  const seen = new Set<string>();
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const token = all.get(name);
    if (!token) continue;
    out.push(token);
    for (const v of [token.value, ...Object.values(token.modes ?? {})]) for (const m of v.matchAll(VAR_REF)) queue.push(m[1]!);
  }
  return { tokens: out.sort((a, b) => (a.name < b.name ? -1 : 1)), textStyles };
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/** The tree of a main as the library publishes it. */
export function libraryTreeOf(doc: BogenDoc, mainId: string, publishable: Set<string>): { tree: LibraryTree; needs: string[] } {
  const needs = new Set<string>();
  let count = 0;
  const inTree = new Set<string>();
  const collect = (id: string) => { inTree.add(id); for (const k of doc.rawKids(id)) collect(k); };
  collect(mainId);
  // An instance of something the library does not publish arrives as the layers it shows.
  const flat = (spec: NewNode, seed: string): LibraryTree => {
    if (++count > MAX_TREE) throw new Error('This component is too big to publish.');
    const { children, materialized: _m, fixedId: _f, instanceRef: _i, slotRef: _s, artboard: _a, proto: _p, ...rest } = spec;
    return clean({ ...rest, id: libraryLayerId('flat', seed), ...(children?.length ? { children: children.map((c, i) => flat(c, `${seed}.${i}`)) } : {}) }) as LibraryTree;
  };
  const walk = (id: string, spec: NewNode): LibraryTree => {
    if (++count > MAX_TREE) throw new Error('This component is too big to publish.');
    const raw = doc.rawNode(id)!;
    if (raw.instanceOf !== undefined && !publishable.has(raw.instanceOf) && !inTree.has(raw.instanceOf)) {
      return flat({ ...materialize(doc, id), ...(raw.slot !== undefined ? { slot: raw.slot } : {}) }, id);
    }
    if (raw.instanceOf !== undefined && publishable.has(raw.instanceOf) && !inTree.has(raw.instanceOf)) needs.add(raw.instanceOf);
    const kids = doc.rawKids(id);
    const { children, materialized: _m, fixedId: _f, instanceRef: _i, slotRef: _s, artboard: _a, proto: _p, ...rest } = spec;
    const node: LibraryTree = clean({ ...rest, id, ...(raw.component ? { component: raw.component } : {}) }) as LibraryTree;
    if (children?.length) node.children = children.map((c, i) => walk(kids[i]!, c));
    return node;
  };
  const tree = walk(mainId, doc.toSpec(mainId));
  // Where the main sits on its page is not part of it.
  const style = { ...(tree.style ?? {}) };
  for (const side of SIDES) delete style[side];
  if (style.position) style.position = 'relative';
  tree.style = style;
  return { tree, needs: [...needs].sort() };
}

/** What publishing would write now, without writing it. */
export function currentLibrary(doc: BogenDoc): Omit<PublishedComponent, 'version' | 'at'>[] {
  const mains = publishableMains(doc);
  const ids = new Set(mains.map((m) => m.id));
  return mains.map((m) => {
    const { tree, needs } = libraryTreeOf(doc, m.id, ids);
    const { tokens, textStyles } = referencedTokens(doc, [tree]);
    const c = m.component!;
    const body = { name: m.name, description: c.description, set: c.set, variant: c.variant, tree, needs, ...(c.handoff ? { handoff: c.handoff } : {}) };
    // Tokens belong to the file that uses them: a copy only adds those it lacks, so they are no update.
    return clean({ main: m.id, ...body, tokens, textStyles, hash: hash53(stable(body)).toString(36) });
  });
}

export function readPublished(doc: BogenDoc): PublishedComponent[] {
  const out: PublishedComponent[] = [];
  publishedMap(doc).forEach((value, key) => {
    const entry = cleanPublished(key, value);
    if (entry) out.push(entry);
  });
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.main < b.main ? -1 : 1));
}

/** Components whose current look differs from what was published, and those not published yet. */
export function unpublishedChanges(doc: BogenDoc): { main: string; name: string; status: 'new' | 'changed' | 'removed' }[] {
  const published = new Map(readPublished(doc).map((p) => [p.main, p]));
  const now = currentLibrary(doc);
  const out: { main: string; name: string; status: 'new' | 'changed' | 'removed' }[] = [];
  for (const c of now) {
    const before = published.get(c.main);
    if (!before) out.push({ main: c.main, name: c.name, status: 'new' });
    else if (before.hash !== c.hash) out.push({ main: c.main, name: c.name, status: 'changed' });
    published.delete(c.main);
  }
  for (const p of published.values()) out.push({ main: p.main, name: p.name, status: 'removed' });
  return out;
}

/** Publishes every component of the file. Unchanged ones keep their version. */
export function publishLibrary(doc: BogenDoc, options: { name?: string; description?: string; by?: string } = {}, origin?: unknown) {
  const now = Date.now();
  const before = new Map(readPublished(doc).map((p) => [p.main, p]));
  const current = currentLibrary(doc);
  if (!current.length && !before.size) throw new Error('This file has no components on its pages to publish. Make some with component_create first.');
  const changed: { main: string; name: string; version: number }[] = [];
  let unchanged = 0;
  const previous = libraryInfo(doc);
  const name = options.name?.trim() || previous?.name || String(doc.meta.get('name') ?? '') || 'Library';
  doc.transact(() => {
    const map = publishedMap(doc);
    for (const c of current) {
      const old = before.get(c.main);
      before.delete(c.main);
      if (old && old.hash === c.hash) {
        unchanged++;
        continue;
      }
      const version = (old?.version ?? 0) + 1;
      map.set(c.main, { ...c, version, at: now });
      changed.push({ main: c.main, name: c.name, version });
    }
    for (const gone of before.keys()) map.delete(gone);
    const renames = tokenRenames(doc);
    const renamed = (renames.at(-1)?.at ?? 0) !== (previous?.renames?.at(-1)?.at ?? 0);
    const moved = changed.length || before.size || renamed;
    const info: LibraryInfo = clean({ name, description: options.description ?? previous?.description, version: (previous?.version ?? 0) + (moved ? 1 : 0), publishedAt: moved ? now : previous?.publishedAt ?? now, by: options.by, renames: renames.length ? renames : undefined });
    doc.meta.set('library', info);
  }, origin);
  return { info: libraryInfo(doc)!, changed, removed: [...before.values()].map((p) => ({ main: p.main, name: p.name })), unchanged };
}

/** Stops offering the file's components. Files that use them keep their copies. */
export function unpublishLibrary(doc: BogenDoc, origin?: unknown): void {
  doc.transact(() => {
    const map = publishedMap(doc);
    for (const key of [...map.keys()]) map.delete(key);
    doc.meta.delete('library');
  }, origin);
}

// Reading untrusted entries: a library arrives from other devices and other people.

function strRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === 'string' && k !== '__proto__') out[k] = x;
  return out;
}

function valueRecord(v: unknown): Record<string, PropValue> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, PropValue> = {};
  for (const [k, x] of Object.entries(v)) if ((typeof x === 'string' || typeof x === 'boolean') && k !== '__proto__') out[k] = x;
  return out;
}

function cleanTree(v: unknown, budget: { left: number }, depth = 0): LibraryTree | undefined {
  if (!v || typeof v !== 'object' || depth > 64 || --budget.left < 0) return undefined;
  const t = v as Record<string, unknown>;
  if (typeof t.id !== 'string' || !LAYER_ID.test(t.id) || !NODE_TYPES.has(t.type as NodeType)) return undefined;
  const out: LibraryTree = { id: t.id, type: t.type as NodeType };
  for (const key of ['name', 'tag', 'text', 'src', 'svg', 'instanceOf', 'slotName', 'slot', 'mode', 'textStyle'] as const) if (typeof t[key] === 'string') out[key] = t[key] as string;
  if (t.hidden === true) out.hidden = true;
  const style = strRecord(t.style);
  if (style) out.style = style;
  const attrs = strRecord(t.attrs);
  if (attrs) out.attrs = attrs;
  const rules = normalizeRules(readNestedRules(t.rules));
  if (rules) out.rules = rules;
  const props = valueRecord(t.props);
  if (props) out.props = props;
  const overrides = valueRecord(t.overrides);
  if (overrides) out.overrides = overrides;
  if (Array.isArray(t.spans)) out.spans = (t.spans as unknown[]).filter((s): s is NonNullable<NewNode['spans']>[number] => !!s && typeof s === 'object' && Number.isFinite((s as { start: number }).start) && Number.isFinite((s as { end: number }).end));
  if (t.component && typeof t.component === 'object') {
    const c = t.component as Record<string, unknown>;
    out.component = clean({
      description: typeof c.description === 'string' ? c.description : undefined,
      set: typeof c.set === 'string' ? c.set : undefined,
      variant: strRecord(c.variant),
      props: Array.isArray(c.props) ? (c.props as ComponentDef['props'])!.filter((p) => p && typeof p.name === 'string' && ['text', 'boolean', 'variant', 'image'].includes(p.type)) : [],
      handoff: readHandoff(c.handoff),
    });
  }
  if (Array.isArray(t.children)) {
    const kids: LibraryTree[] = [];
    for (const c of t.children) {
      const k = cleanTree(c, budget, depth + 1);
      if (!k) return undefined;
      kids.push(k);
    }
    if (kids.length) out.children = kids;
  }
  return out;
}

const TOKEN_KINDS = new Set<TokenKind>(['color', 'radius', 'spacing', 'container', 'breakpoint', 'font-family', 'font-weight', 'font-size', 'line-height', 'letter-spacing']);

function cleanTokens(v: unknown): Token[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((t) => (t && typeof t.name === 'string' && /^[a-zA-Z_][\w-]*$/.test(t.name) && typeof t.value === 'string' && TOKEN_KINDS.has(t.kind)
    ? [clean({ name: t.name, kind: t.kind as TokenKind, value: t.value, modes: strRecord(t.modes) })]
    : []));
}

function cleanTextStyles(v: unknown): TextStyle[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((s) => (s && typeof s.key === 'string' && typeof s.name === 'string' ? [{ key: s.key, name: s.name, style: Object.fromEntries(Object.entries(strRecord(s.style) ?? {}).filter(([k]) => (TEXT_STYLE_PROPS as readonly string[]).includes(k))) }] : []));
}

function cleanPublished(key: string, v: unknown): PublishedComponent | undefined {
  if (!v || typeof v !== 'object' || !LAYER_ID.test(key)) return undefined;
  const e = v as Record<string, unknown>;
  const tree = cleanTree(e.tree, { left: MAX_TREE });
  if (!tree || tree.id !== key || typeof e.hash !== 'string') return undefined;
  return clean({
    main: key, name: typeof e.name === 'string' ? e.name : 'Component', description: typeof e.description === 'string' ? e.description : undefined,
    set: typeof e.set === 'string' ? e.set : undefined, variant: strRecord(e.variant), tree,
    needs: Array.isArray(e.needs) ? e.needs.filter((n): n is string => typeof n === 'string' && LAYER_ID.test(n)) : [],
    tokens: cleanTokens(e.tokens), textStyles: cleanTextStyles(e.textStyles), hash: e.hash, version: Number(e.version) || 1, at: Number(e.at) || 0,
  });
}

// Using a library

export function libraryLinks(doc: BogenDoc): LibraryLink[] {
  const out: LibraryLink[] = [];
  linksMap(doc).forEach((v, id) => {
    if (!v || typeof v !== 'object') return;
    const l = v as Partial<LibraryLink>;
    out.push(clean({ id, name: typeof l.name === 'string' ? l.name : id, kind: l.kind === 'brand' ? 'brand' as const : 'file' as const, linkedAt: Number(l.linkedAt) || 0, by: typeof l.by === 'string' ? l.by : undefined, renamesAt: Number(l.renamesAt) || undefined }));
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function cachedMeta(doc: BogenDoc, id: string): CachedMeta | undefined {
  const v = doc.nodes.get(id)?.get('library');
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Partial<CachedMeta>;
  if (typeof m.lib !== 'string' || typeof m.main !== 'string') return undefined;
  return clean({ lib: m.lib, main: m.main, name: String(m.name ?? ''), version: Number(m.version) || 0, hash: String(m.hash ?? ''), at: Number(m.at) || 0, removed: m.removed === true ? true : undefined });
}

/** Library copies in this file, one per published main, optionally of one library. */
export function cachedMains(doc: BogenDoc, libId?: string): { id: string; meta: CachedMeta }[] {
  const out: { id: string; meta: CachedMeta }[] = [];
  doc.nodes.forEach((m, id) => {
    const parent = m.get('parent');
    if (typeof parent !== 'string' || !isLibraryParent(parent)) return;
    if (libId !== undefined && parent !== libraryParent(libId)) return;
    const meta = cachedMeta(doc, id);
    if (meta) out.push({ id, meta });
  });
  return out.sort((a, b) => a.meta.name.localeCompare(b.meta.name) || (a.id < b.id ? -1 : 1));
}

/** The library a layer's copy belongs to, if it is part of one. */
export function libraryOf(doc: BogenDoc, id: string): { root: string; meta: CachedMeta } | undefined {
  let cur = id;
  for (let i = 0; i < 2000; i++) {
    const m = doc.nodes.get(cur);
    if (!m) return undefined;
    const parent = String(m.get('parent'));
    if (isLibraryParent(parent)) {
      const meta = cachedMeta(doc, cur);
      return meta ? { root: cur, meta } : undefined;
    }
    cur = parent;
  }
  return undefined;
}

function subtreeIds(doc: BogenDoc, root: string): string[] {
  const byParent = new Map<string, string[]>();
  doc.nodes.forEach((m, id) => {
    const p = String(m.get('parent'));
    const list = byParent.get(p);
    if (list) list.push(id);
    else byParent.set(p, [id]);
  });
  const out: string[] = [];
  const walk = (id: string) => { out.push(id); for (const k of byParent.get(id) ?? []) walk(k); };
  if (doc.nodes.has(root)) walk(root);
  return out;
}

function toCached(libId: string, t: LibraryTree): CachedTree {
  const { id, component, children, overrides, instanceOf, slot, ...rest } = t;
  return clean({
    ...rest,
    fixedId: libraryLayerId(libId, id),
    instanceOf: instanceOf !== undefined ? libraryLayerId(libId, instanceOf) : undefined,
    slot: slot !== undefined ? mapPath(libId, slot) : undefined,
    overrides: overrides ? Object.fromEntries(Object.entries(overrides).map(([k, v]) => [mapKey(libId, k), v])) : undefined,
    component: component ? clean({ ...component, props: component.props?.map((p) => clean({ ...p, targets: p.targets?.map((tg) => ({ ...tg, path: tg.path ? mapPath(libId, tg.path) : tg.path })) })) }) : undefined,
    children: children?.map((c) => toCached(libId, c)),
  }) as CachedTree;
}

function addDesignSystem(doc: BogenDoc, tokens: Token[], textStyles: TextStyle[]): void {
  for (const t of tokens) {
    if (doc.tokens.has(t.name)) continue;
    doc.setToken(t.name, t.kind, t.value);
    const m = doc.tokens.get(t.name)!;
    for (const [mode, value] of Object.entries(t.modes ?? {})) m.set(`mode:${mode}`, value);
  }
  for (const s of textStyles) {
    if (doc.textStyles.has(s.key)) continue;
    try {
      setTextStyle(doc, s.name, s.style);
    } catch {
      // A style the library could hold and this file cannot is left out; layers keep their own values.
    }
  }
}

/** Writes a library copy, replacing an older one with the same ids. Inside the caller's transaction. */
function writeCached(doc: BogenDoc, libId: string, tree: CachedTree, meta: CachedMeta): void {
  for (const id of subtreeIds(doc, tree.fixedId)) doc.nodes.delete(id);
  doc.invalidate();
  doc.writeTree(libraryParent(libId), tree, 'a0');
  doc.invalidate();
  const mark = (t: CachedTree) => {
    if (t.component) {
      const c = t.component;
      createComponent(doc, t.fixedId, clean({ description: c.description, set: c.set, variant: c.variant, props: c.props ?? [], handoff: c.handoff }));
    }
    t.children?.forEach(mark);
  };
  mark(tree);
  doc.nodes.get(tree.fixedId)!.set('library', clean({ ...meta }));
  doc.invalidate();
}

function metaOf(libId: string, p: PublishedComponent): CachedMeta {
  return { lib: libId, main: p.main, name: p.name, version: p.version, hash: p.hash, at: p.at };
}

/** Links a library and copies all it publishes into the file. Returns the copies' ids by library main. */
export function linkLibrary(doc: BogenDoc, link: Omit<LibraryLink, 'linkedAt'>, published: PublishedComponent[], origin?: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  doc.transact(() => {
    // Renames made before linking are history: what the file takes now has the new names already.
    linksMap(doc).set(link.id, clean({ name: link.name, kind: link.kind, by: link.by, linkedAt: Date.now(), renamesAt: link.renamesAt }));
    for (const p of published) {
      const id = libraryLayerId(link.id, p.main);
      const have = cachedMeta(doc, id);
      if (!have || have.hash !== p.hash) {
        addDesignSystem(doc, p.tokens, p.textStyles);
        writeCached(doc, link.id, toCached(link.id, p.tree), metaOf(link.id, p));
      }
      out[p.main] = id;
    }
  }, origin);
  return out;
}

/** What a linked library has that this file's copies do not. */
export function libraryUpdates(doc: BogenDoc, libId: string, published: PublishedComponent[]): LibraryUpdate[] {
  const out: LibraryUpdate[] = [];
  const seen = new Set<string>();
  // Instances on pages: those inside other library copies are counted where those are used.
  const count = (id: string) => instancesOf(doc, id).filter((i) => doc.pageOf(i) !== undefined).length;
  for (const p of published) {
    const id = libraryLayerId(libId, p.main);
    seen.add(id);
    const have = cachedMeta(doc, id);
    if (!have) out.push({ lib: libId, main: p.main, id, name: p.name, status: 'new', to: p.version, instances: 0 });
    else if (have.hash !== p.hash) out.push({ lib: libId, main: p.main, id, name: p.name, status: 'changed', from: have.version, to: p.version, instances: count(id) });
  }
  for (const c of cachedMains(doc, libId)) {
    if (!seen.has(c.id) && !c.meta.removed) out.push({ lib: libId, main: c.meta.main, id: c.id, name: c.meta.name, status: 'removed', from: c.meta.version, instances: count(c.id) });
  }
  return out;
}

/**
 * Token renames the library made since this file last took them, as old name to new name, limited to tokens this
 * file has. They come as an update like a changed component: `acceptLibraryUpdates` takes them over.
 */
export function libraryTokenRenames(doc: BogenDoc, libId: string, info: LibraryInfo | undefined): { from: string; to: string }[] {
  const link = libraryLinks(doc).find((l) => l.id === libId);
  if (!link || !info?.renames?.length) return [];
  const since = link.renamesAt ?? link.linkedAt;
  return [...resolveRenames(info.renames, since)].filter(([from]) => doc.tokens.has(from)).map(([from, to]) => ({ from, to }));
}

/**
 * Takes a library's updates, all or the named ones (main ids, copy ids or names), with what they show
 * inside them. Overrides stay: they point at layers by ids that an update keeps. One transaction.
 */
export function acceptLibraryUpdates(doc: BogenDoc, libId: string, published: PublishedComponent[], only?: string[], origin?: unknown, info?: LibraryInfo) {
  const updates = libraryUpdates(doc, libId, published);
  const wanted = only?.length ? updates.filter((u) => only.includes(u.main) || only.includes(u.id) || only.includes(u.name)) : updates;
  const byMain = new Map(published.map((p) => [p.main, p]));
  const pending = new Map(updates.map((u) => [u.main, u]));
  const take = new Map<string, LibraryUpdate>();
  const add = (u: LibraryUpdate) => {
    if (take.has(u.main)) return;
    take.set(u.main, u);
    for (const need of byMain.get(u.main)?.needs ?? []) {
      const next = pending.get(need);
      if (next && next.status !== 'removed') add(next);
    }
  };
  wanted.forEach(add);
  let kept = 0;
  let orphaned = 0;
  const pendingRenames = only?.length ? [] : libraryTokenRenames(doc, libId, info);
  let renamed: TokenRenameReport[] = [];
  doc.transact(() => {
    if (info?.renames?.length && !only?.length) {
      // First, so that the components that arrive next find the file's references under the new names already.
      renamed = applyTokenRenames(doc, new Map(pendingRenames.map((r) => [r.from, r.to])));
      const raw = linksMap(doc).get(libId);
      if (raw && typeof raw === 'object') linksMap(doc).set(libId, { ...(raw as object), renamesAt: info.renames.at(-1)!.at });
    }
    for (const u of take.values()) {
      if (u.status === 'removed') {
        // Instances of a component the library dropped keep their copy, now marked as such.
        if (instancesOf(doc, u.id).length) doc.nodes.get(u.id)?.set('library', { ...cachedMeta(doc, u.id)!, removed: true });
        else for (const id of subtreeIds(doc, u.id)) doc.nodes.delete(id);
        continue;
      }
      const p = byMain.get(u.main)!;
      addDesignSystem(doc, p.tokens, p.textStyles);
      writeCached(doc, libId, toCached(libId, p.tree), metaOf(libId, p));
    }
    doc.invalidate();
    for (const u of take.values()) {
      if (u.status === 'removed') continue;
      for (const inst of instancesOf(doc, u.id)) {
        for (const key of Object.keys(doc.rawNode(inst)?.overrides ?? {})) {
          const head = key.slice(0, key.lastIndexOf('#')).split('/')[0] ?? '';
          if (!head || head === '.' || doc.nodes.has(head)) kept++;
          else orphaned++;
        }
      }
    }
  }, origin);
  return { accepted: [...take.values()], overrides: { kept, orphaned }, ...(renamed.length ? { renamed: renamed.map((r) => ({ from: r.from, to: r.to, references: r.references })) } : {}) };
}

/** Unlinks a library. Copies that instances still use stay, with what they need; the rest go. */
export function unlinkLibrary(doc: BogenDoc, libId: string, origin?: unknown): { kept: number; removed: number } {
  const copies = cachedMains(doc, libId);
  const used = new Set<string>();
  const visit = (id: string) => {
    if (used.has(id)) return;
    used.add(id);
    for (const n of subtreeIds(doc, id)) {
      const target = doc.nodes.get(n)?.get('instanceOf');
      if (typeof target === 'string' && copies.some((c) => c.id === target)) visit(target);
    }
  };
  for (const c of copies) {
    const outside = instancesOf(doc, c.id).some((i) => doc.pageOf(i) !== undefined);
    if (outside) visit(c.id);
  }
  let removed = 0;
  doc.transact(() => {
    linksMap(doc).delete(libId);
    for (const c of copies) {
      if (used.has(c.id)) continue;
      removed++;
      for (const id of subtreeIds(doc, c.id)) doc.nodes.delete(id);
    }
  }, origin);
  return { kept: used.size, removed };
}

// Clipboard

function cachedTreeOf(doc: BogenDoc, id: string, spec: NewNode = doc.toSpec(id)): CachedTree {
  const raw = doc.rawNode(id)!;
  const kids = doc.rawKids(id);
  const { children, ...rest } = spec;
  return clean({
    ...rest,
    fixedId: id,
    ...(raw.component ? { component: raw.component } : {}),
    ...(children?.length ? { children: children.map((c, i) => cachedTreeOf(doc, kids[i]!, c)) } : {}),
  }) as CachedTree;
}

/** The library copies that what is copied shows, so that a paste in another file stays linked. */
export function libraryClip(doc: BogenDoc, ids: string[]): LibraryClip[] {
  const roots = new Map<string, CachedMeta>();
  const visitTree = (id: string) => {
    for (const n of subtreeIds(doc, id)) {
      const target = doc.nodes.get(n)?.get('instanceOf');
      if (typeof target !== 'string') continue;
      const lib = libraryOf(doc, target);
      if (lib && !roots.has(lib.root)) {
        roots.set(lib.root, lib.meta);
        visitTree(lib.root);
      }
    }
  };
  for (const id of ids) visitTree(ownerOf(id));
  if (!roots.size) return [];
  const links = new Map(libraryLinks(doc).map((l) => [l.id, l]));
  const byLib = new Map<string, LibraryClip>();
  for (const [root, meta] of roots) {
    let clip = byLib.get(meta.lib);
    if (!clip) {
      clip = { link: links.get(meta.lib) ?? { id: meta.lib, name: meta.lib, linkedAt: 0 }, roots: [] };
      byLib.set(meta.lib, clip);
    }
    const tree = cachedTreeOf(doc, root);
    const { tokens, textStyles } = referencedTokens(doc, [tree as unknown as LibraryTree]);
    clip.roots.push({ meta, tree, tokens, textStyles });
  }
  return [...byLib.values()];
}

/** Writes what a clip from another file needs, unless this file has it already. Call inside a transaction. */
export function pasteLibraryClip(doc: BogenDoc, clips: unknown): void {
  if (!Array.isArray(clips)) return;
  for (const clip of clips as LibraryClip[]) {
    const libId = clip?.link?.id;
    if (typeof libId !== 'string' || !LAYER_ID.test(libId) || !Array.isArray(clip.roots)) continue;
    if (!linksMap(doc).has(libId)) linksMap(doc).set(libId, clean({ name: typeof clip.link.name === 'string' ? clip.link.name : libId, kind: clip.link.kind === 'brand' ? 'brand' : 'file', linkedAt: Date.now() }));
    for (const root of clip.roots) {
      const tree = root?.tree;
      if (!tree || typeof tree.fixedId !== 'string' || !LAYER_ID.test(tree.fixedId) || doc.nodes.has(tree.fixedId)) continue;
      // The ids are made from the library's own, so a copy here can only be the same one.
      const main = typeof root.meta?.main === 'string' ? root.meta.main : '';
      if (libraryLayerId(libId, main) !== tree.fixedId) continue;
      const checked = cleanTree(withIds(tree), { left: MAX_TREE });
      if (!checked) continue;
      addDesignSystem(doc, cleanTokens(root.tokens), cleanTextStyles(root.textStyles));
      writeCached(doc, libId, cachedFromChecked(checked), { lib: libId, main, name: String(root.meta.name ?? ''), version: Number(root.meta.version) || 0, hash: String(root.meta.hash ?? ''), at: Number(root.meta.at) || 0 });
    }
  }
}

function withIds(t: unknown, depth = 0): unknown {
  if (!t || typeof t !== 'object' || depth > 64) return t;
  const c = t as { fixedId?: unknown; children?: unknown };
  return { ...c, id: c.fixedId, ...(Array.isArray(c.children) ? { children: c.children.map((k) => withIds(k, depth + 1)) } : {}) };
}

/** A checked tree whose ids are already this file's. */
function cachedFromChecked(t: LibraryTree): CachedTree {
  const { id, children, ...rest } = t;
  return clean({ ...rest, fixedId: id, children: children?.map(cachedFromChecked) }) as CachedTree;
}
