import { getModes, getTextStyles, keyframesCss, resolveChildren, resolveNode, type BogenDoc, type BogenNode, type CommentThread, type NodeSource, type Page, type TextStyle, type ThemeMode, type Token } from '@bogen/core';

type Listener = () => void;

function compareOrder(a: BogenNode, b: BogenNode): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

function sameRecord(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

function sameNode(a: BogenNode, b: BogenNode): boolean {
  return a.type === b.type && a.name === b.name && a.parent === b.parent && a.order === b.order && a.tag === b.tag
    && a.text === b.text && a.src === b.src && a.svg === b.svg && a.artboard === b.artboard && a.hidden === b.hidden && a.locked === b.locked && a.spans === b.spans && a.proto === b.proto
    && sameRecord(a.style, b.style) && sameRecord(a.attrs, b.attrs)
    && a.instanceOf === b.instanceOf && a.slot === b.slot && a.slotName === b.slotName && a.mode === b.mode && a.textStyle === b.textStyle
    && sameValues(a.overrides, b.overrides) && sameValues(a.props, b.props) && JSON.stringify(a.component) === JSON.stringify(b.component)
    && JSON.stringify(a.code) === JSON.stringify(b.code) && JSON.stringify(a.rules) === JSON.stringify(b.rules) && JSON.stringify(a.layoutGrids) === JSON.stringify(b.layoutGrids);
}

function sameValues(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/** Layers by id. Reading gives what renders, also for ids inside an instance; iterating gives what is stored. */
class NodeMap extends Map<string, BogenNode> {
  view: (id: string) => BogenNode | undefined = () => undefined;

  override get(id: string): BogenNode | undefined {
    const stored = super.get(id);
    if (stored ? stored.instanceOf === undefined && stored.slot === undefined : !id.includes('/')) return stored;
    return this.view(id);
  }

  override has(id: string): boolean {
    return super.has(id) || (id.includes('/') && this.view(id) !== undefined);
  }

  stored(id: string): BogenNode | undefined {
    return super.get(id);
  }
}

const EMPTY: readonly string[] = Object.freeze([]);

/**
 * What renders differently in this view without ever being stored: preview mode's prototype state.
 * Kept as intent rather than as a copy of the layer, so that edits arriving meanwhile still show.
 */
export interface LocalView { hidden?: boolean; /** The display a shown layer gets when its style says none. */ display?: string; instanceOf?: string; text?: string }

function withLocal(n: BogenNode, v: LocalView): BogenNode {
  const out: BogenNode = { ...n };
  if (v.hidden !== undefined) out.hidden = v.hidden;
  if (v.hidden === false && n.style.display === 'none') {
    const { display: _display, ...rest } = n.style;
    out.style = v.display ? { ...rest, display: v.display } : rest;
  }
  if (v.instanceOf !== undefined && n.instanceOf !== undefined) out.instanceOf = v.instanceOf;
  if (v.text !== undefined && n.type === 'text') {
    out.text = v.text;
    delete out.spans;
  }
  return out;
}

/**
 * An immutable plain view of a BogenDoc. Each Y update touches only the nodes it changed, and only
 * subscribers of those ids hear about it, which is what keeps 5,000 layers cheap to edit.
 */
export class Snapshot {
  readonly nodes = new NodeMap();
  private readonly kids = new Map<string, readonly string[]>();
  private readonly frozen = new Map<string, BogenNode>();
  pages: Page[] = [];
  tokens: Token[] = [];
  comments: CommentThread[] = [];
  keyframes = '';
  modes: ThemeMode[] = [];
  textStyles: TextStyle[] = [];
  /** Every layer that is a main. */
  readonly mains = new Set<string>();
  // What renders inside instances is computed once and kept, with what it was computed from, so that
  // a main edit recomputes only what read that main and tells only those it changed for.
  private readonly views = new Map<string, BogenNode | null>();
  private readonly viewKids = new Map<string, readonly string[]>();
  private readonly dependents = new Map<string, Set<string>>();
  private readonly dependencies = new Map<string, Set<string>>();
  private tracking: Set<string> | null = null;
  private spent = 0;
  private local = new Map<string, LocalView>();
  readonly source: NodeSource = {
    raw: (id) => {
      this.tracking?.add(id);
      return this.nodes.stored(id);
    },
    rawKids: (id) => {
      this.tracking?.add(id);
      return this.kids.get(id) ?? EMPTY;
    },
    mainIds: () => [...this.mains],
    // Past this a canvas is unusable as DOM anyway, and a hostile file should not take the tab down.
    spend: (count) => (this.spent += count) <= 150_000,
  };
  /** Bumps on any change. */
  version = 0;
  /** Bumps when layers are added, removed, moved or reordered. */
  structureVersion = 0;

  private nodeListeners = new Map<string, Set<Listener>>();
  private childListeners = new Map<string, Set<Listener>>();
  private listeners = new Set<Listener>();
  private structureListeners = new Set<Listener>();
  private cleanup: (() => void)[] = [];
  /** Called with every node that changed, for side effects like loading fonts. */
  onNodeChanged?: (n: BogenNode) => void;

  constructor(private doc: BogenDoc) {
    const onNodes = (events: { path: (string | number)[]; target: unknown; changes: { keys: Map<string, unknown> } }[]) => {
      const dirty = new Set<string>();
      for (const ev of events) {
        if (ev.path.length) dirty.add(String(ev.path[0]));
        else for (const key of ev.changes.keys.keys()) dirty.add(key);
      }
      this.applyDirty(dirty);
    };
    doc.nodes.observeDeep(onNodes as never);
    this.cleanup.push(() => doc.nodes.unobserveDeep(onNodes as never));

    const onPages = () => { this.pages = doc.getPages(); this.bump(); };
    doc.pages.observeDeep(onPages);
    this.cleanup.push(() => doc.pages.unobserveDeep(onPages));

    const onTokens = () => { this.tokens = doc.getTokens(); this.bump(); };
    doc.tokens.observeDeep(onTokens);
    this.cleanup.push(() => doc.tokens.unobserveDeep(onTokens));

    const onComments = () => { this.comments = doc.getComments(); this.bump(); };
    doc.comments.observeDeep(onComments);
    this.cleanup.push(() => doc.comments.unobserveDeep(onComments));

    const onMeta = () => {
      this.keyframes = keyframesCss(doc);
      this.bump();
    };
    doc.meta.observe(onMeta);
    this.cleanup.push(() => doc.meta.unobserve(onMeta));

    const onModes = () => { this.modes = getModes(doc); this.bump(); };
    doc.modes.observeDeep(onModes);
    this.cleanup.push(() => doc.modes.unobserveDeep(onModes));

    const onTextStyles = () => { this.textStyles = getTextStyles(doc); this.bump(); };
    doc.textStyles.observeDeep(onTextStyles);
    this.cleanup.push(() => doc.textStyles.unobserveDeep(onTextStyles));

    this.nodes.view = (id) => this.viewOf(id);

    // Whatever is already in the doc.
    const all = new Set<string>();
    doc.nodes.forEach((_, id) => all.add(id));
    if (all.size) this.applyDirty(all);
    this.pages = doc.getPages();
    this.tokens = doc.getTokens();
    this.comments = doc.getComments();
    this.modes = getModes(doc);
    this.textStyles = getTextStyles(doc);
    onMeta();
  }

  destroy(): void {
    for (const c of this.cleanup) c();
  }

  private applyDirty(dirty: Set<string>): void {
    const dirtyParents = new Set<string>();
    const changed: string[] = [];
    for (const id of dirty) {
      const old = this.nodes.stored(id);
      const raw = this.doc.rawNode(id);
      const view = raw && this.local.get(id);
      const next = raw && view ? withLocal(raw, view) : raw;
      if (!next) {
        if (old) {
          this.nodes.delete(id);
          this.mains.delete(id);
          dirtyParents.add(old.parent);
          changed.push(id);
        }
        continue;
      }
      if (old && sameNode(old, next)) continue;
      this.nodes.set(id, next);
      if (next.component) this.mains.add(id);
      else this.mains.delete(id);
      changed.push(id);
      if (!old) dirtyParents.add(next.parent);
      else if (old.parent !== next.parent || old.order !== next.order) {
        dirtyParents.add(old.parent);
        dirtyParents.add(next.parent);
      }
      this.onNodeChanged?.(next);
    }
    if (!changed.length) return;
    if (dirtyParents.size) this.rebuildChildren(dirtyParents, dirty);
    const views = this.refreshViews(changed, dirtyParents);
    const structural = dirtyParents.size > 0 || views.kids.length > 0;
    this.version++;
    if (structural) this.structureVersion++;
    for (const id of changed) this.nodeListeners.get(id)?.forEach((l) => l());
    for (const id of views.nodes) this.nodeListeners.get(id)?.forEach((l) => l());
    for (const p of dirtyParents) this.childListeners.get(p)?.forEach((l) => l());
    for (const id of views.kids) this.childListeners.get(id)?.forEach((l) => l());
    if (structural) this.structureListeners.forEach((l) => l());
    this.listeners.forEach((l) => l());
  }

  private rebuildChildren(parents: Set<string>, dirty: Set<string>): void {
    if (parents.size > 8 || dirty.size > 64) {
      // Bulk load: one pass over everything beats one pass per parent.
      const index = new Map<string, BogenNode[]>();
      for (const n of this.nodes.values()) {
        const list = index.get(n.parent);
        if (list) list.push(n);
        else index.set(n.parent, [n]);
      }
      for (const p of parents) if (!index.has(p)) this.kids.delete(p);
      for (const [p, list] of index) {
        const ids = list.sort(compareOrder).map((n) => n.id);
        const old = this.kids.get(p);
        if (!old || old.length !== ids.length || old.some((id, i) => id !== ids[i])) {
          this.kids.set(p, ids);
          parents.add(p);
        }
      }
      return;
    }
    for (const p of parents) {
      const current = new Set(this.kids.get(p) ?? []);
      for (const id of dirty) {
        const n = this.nodes.stored(id);
        if (n?.parent === p) current.add(id);
        else current.delete(id);
      }
      const list: BogenNode[] = [];
      for (const id of current) {
        const n = this.nodes.stored(id);
        if (n) list.push(n);
      }
      list.sort(compareOrder);
      if (list.length) this.kids.set(p, list.map((n) => n.id));
      else this.kids.delete(p);
    }
  }

  private track(view: string, deps: Set<string>): void {
    let known = this.dependencies.get(view);
    if (!known) this.dependencies.set(view, (known = new Set()));
    for (const dep of deps) {
      known.add(dep);
      let set = this.dependents.get(dep);
      if (!set) this.dependents.set(dep, (set = new Set()));
      set.add(view);
    }
  }

  private viewOf(id: string): BogenNode | undefined {
    const known = this.views.get(id);
    if (known !== undefined) return known ?? undefined;
    const deps = new Set<string>();
    this.tracking = deps;
    const node = resolveNode(this.source, id);
    this.tracking = null;
    this.views.set(id, node ?? null);
    this.track(id, deps);
    return node;
  }

  private kidsOfView(id: string): readonly string[] {
    const known = this.viewKids.get(id);
    if (known) return known;
    const deps = new Set<string>();
    this.tracking = deps;
    const kids = resolveChildren(this.source, id);
    this.tracking = null;
    this.viewKids.set(id, kids);
    this.track(id, deps);
    return kids;
  }

  /** Recomputes what read a stored layer that changed, and says for which of it the result differs. */
  private refreshViews(changed: string[], parents: Set<string>): { nodes: string[]; kids: string[] } {
    const nodes: string[] = [];
    const kids: string[] = [];
    const touched = new Set<string>();
    for (const id of changed) this.dependents.get(id)?.forEach((v) => touched.add(v));
    for (const id of parents) this.dependents.get(id)?.forEach((v) => touched.add(v));
    if (!touched.size) return { nodes, kids };
    const before = new Map<string, { node?: BogenNode | null | undefined; kids?: readonly string[] | undefined }>();
    for (const view of touched) {
      before.set(view, { node: this.views.get(view), kids: this.viewKids.get(view) });
      this.views.delete(view);
      const list = this.viewKids.get(view);
      if (list) this.spent -= list.length;
      this.viewKids.delete(view);
      for (const dep of this.dependencies.get(view) ?? []) this.dependents.get(dep)?.delete(view);
      this.dependencies.delete(view);
    }
    for (const [view, old] of before) {
      if (old.node !== undefined) {
        const next = this.viewOf(view);
        if (old.node && next && sameNode(old.node, next)) this.views.set(view, old.node);
        else if (old.node || next) nodes.push(view);
      }
      if (old.kids) {
        const next = this.kidsOfView(view);
        if (next.length === old.kids.length && next.every((k, i) => k === old.kids![i])) this.viewKids.set(view, old.kids);
        else kids.push(view);
      }
    }
    return { nodes, kids };
  }

  /** Replaces what renders differently here without being stored, and re-renders what that touches. */
  setLocal(next: Map<string, LocalView>): void {
    const dirty = new Set([...this.local.keys(), ...next.keys()]);
    this.local = next;
    if (dirty.size) this.applyDirty(dirty);
  }

  private bump(): void {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  // Reads

  node(id: string): BogenNode | undefined {
    return this.frozen.get(id) ?? this.nodes.get(id);
  }

  /** Children as they render. Inside an instance these are computed. */
  children(parent: string): readonly string[] {
    if (!parent.includes('/') && this.nodes.stored(parent)?.instanceOf === undefined) return this.kids.get(parent) ?? EMPTY;
    return this.kidsOfView(parent);
  }

  parentOf(id: string): string | undefined {
    return this.nodes.get(id)?.parent;
  }

  /** Ancestor node ids, nearest first, not including pages. */
  ancestors(id: string): string[] {
    const out: string[] = [];
    let cur = this.nodes.get(id);
    const seen = new Set([id]);
    while (cur && this.nodes.has(cur.parent) && !seen.has(cur.parent)) {
      seen.add(cur.parent);
      out.push(cur.parent);
      cur = this.nodes.get(cur.parent);
    }
    return out;
  }

  pageOf(id: string): string | undefined {
    const anc = this.ancestors(id);
    const top = this.nodes.get(anc.at(-1) ?? id);
    return top?.parent;
  }

  isHidden(id: string): boolean {
    let cur = this.nodes.get(id);
    while (cur) {
      if (cur.hidden) return true;
      cur = this.nodes.get(cur.parent);
    }
    return false;
  }

  isLocked(id: string): boolean {
    let cur = this.nodes.get(id);
    while (cur) {
      if (cur.locked) return true;
      cur = this.nodes.get(cur.parent);
    }
    return false;
  }

  /** While a text layer is being typed in, its view keeps the value it had when editing began. */
  freeze(id: string): void {
    const n = this.nodes.get(id);
    if (n) this.frozen.set(id, n);
  }

  thaw(id: string): void {
    if (this.frozen.delete(id)) this.nodeListeners.get(id)?.forEach((l) => l());
  }

  // Subscriptions

  subscribeNode(id: string, fn: Listener): () => void {
    return addTo(this.nodeListeners, id, fn);
  }

  subscribeChildren(id: string, fn: Listener): () => void {
    return addTo(this.childListeners, id, fn);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribeStructure(fn: Listener): () => void {
    this.structureListeners.add(fn);
    return () => this.structureListeners.delete(fn);
  }
}

function addTo(map: Map<string, Set<Listener>>, key: string, fn: Listener): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) map.delete(key);
  };
}
