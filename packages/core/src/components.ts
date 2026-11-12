import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import type { BogenDoc, BogenNode, ComponentDef, ComponentProp, NewNode, PropValue, PropTarget } from './doc.ts';
import { setLayerText } from './text-model.ts';
import { readHandoff, type CodeHandoff } from './handoff.ts';
import { parseBlock, rulesToYMap, type LayerRules } from './layer-rules.ts';

/**
 * Components are not copies. A main is an ordinary layer tree with a `component` field, and an
 * instance is one stored layer that points at it. Everything inside an instance is a view computed
 * from the main and the instance's overrides, so a main edit reaches all instances by construction,
 * also on other pages and other devices, and there is nothing to keep in step.
 *
 * Views have an id of their own: `<instance>/<layer in its main>`, and for an instance inside a main
 * `<instance>/<nested instance>/<layer in that main>`. Layer ids never contain a slash.
 *
 * Overrides live on the outermost instance as one flat map, `<path>#<field>`, so that two people
 * changing different things merge. Slot contents are real layers whose parent is the instance.
 */
export interface NodeSource {
  /** The layer as stored. */
  raw(id: string): BogenNode | undefined;
  /** Stored children in paint order, including what fills an instance's slots. */
  rawKids(id: string): readonly string[];
  /** Every layer with a `component` field. */
  mainIds(): readonly string[];
  /** Counts views made since the last change. False once a document has asked for too many. */
  spend?(count: number): boolean;
  /** Where views can be kept while nothing changes. Their readers do not change them. */
  memo?(): Map<string, BogenNode | undefined> | undefined;
}

const MAX_DEPTH = 8;
const ROOT_SLOT = '.';
const SIDES = ['left', 'top', 'right', 'bottom'];
/** What an instance keeps to itself instead of taking from its main. */
const OWN_ONLY = new Set(['position', ...SIDES]);

export const isVirtualId = (id: string): boolean => id.includes('/');
export const ownerOf = (id: string): string => (isVirtualId(id) ? id.slice(0, id.indexOf('/')) : id);
const pathOf = (id: string): string => (isVirtualId(id) ? id.slice(id.indexOf('/') + 1) : '');
const lastOf = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
const parentPrefix = (id: string): string => id.slice(0, id.lastIndexOf('/'));

/** The key of one override. Fields: text, src, svg, tag, name, hidden, locked, textStyle, mode, instanceOf, style.<prop>, attr.<name>, prop.<name>, code.<prop>, rule.<prop>.<block>. */
export function overrideKey(path: string, field: string): string {
  return `${path}#${field}`;
}

function splitKey(key: string): { path: string; field: string } {
  const at = key.lastIndexOf('#');
  return at < 0 ? { path: '', field: key } : { path: key.slice(0, at), field: key.slice(at + 1) };
}

const FIELD = /^(?:text|src|svg|tag|name|hidden|locked|textStyle|mode|instanceOf|visible|style\.-{0,2}[a-zA-Z][\w-]*|attr\.[a-zA-Z][\w:-]*|prop\.[a-zA-Z_][\w-]*|code\.[A-Za-z_$][\w$-]*|rule\.-{0,2}[a-zA-Z][\w-]*\..+)$/;

/** The override field of one property of one block of rules. A property has no dot, so the first one after it splits them. */
export function ruleOverrideField(block: string, prop: string): string {
  return `rule.${prop}.${block}`;
}

/** Stored fields are never trusted: a field that is not one of these does nothing. */
function applyField(node: BogenNode, field: string, value: PropValue): void {
  if (!FIELD.test(field)) return;
  if (field.startsWith('style.')) {
    const prop = field.slice(6);
    if (value === '' || value === false) delete node.style[prop];
    else node.style[prop] = String(value);
    return;
  }
  if (field.startsWith('rule.')) {
    const dot = field.indexOf('.', 5);
    const prop = field.slice(5, dot);
    const block = parseBlock(field.slice(dot + 1));
    if (!block || typeof value !== 'string') return;
    const rules: LayerRules = { ...(node.rules ?? {}) };
    const style = { ...(rules[block.key] ?? {}) };
    if (value === '') delete style[prop];
    else style[prop] = value;
    if (Object.keys(style).length) rules[block.key] = style;
    else delete rules[block.key];
    if (Object.keys(rules).length) node.rules = rules;
    else delete node.rules;
    return;
  }
  if (field.startsWith('attr.')) {
    const attrs = { ...(node.attrs ?? {}) };
    const name = field.slice(5);
    if (value === '' && attrs[name] === undefined) return;
    if (value === false) delete attrs[name];
    else attrs[name] = String(value);
    node.attrs = attrs;
    return;
  }
  if (field.startsWith('prop.')) {
    node.props = { ...(node.props ?? {}), [field.slice(5)]: value };
    return;
  }
  // A prop of a code component: what the person's own component gets, such as its variant.
  if (field.startsWith('code.')) {
    const name = field.slice(5);
    if (node.code && name !== '__proto__') node.code = { ...node.code, props: { ...node.code.props, [name]: value } };
    return;
  }
  switch (field) {
    case 'hidden':
      if (value) node.hidden = true;
      else delete node.hidden;
      return;
    case 'visible':
      if (value) delete node.hidden;
      else node.hidden = true;
      return;
    case 'locked':
      if (value) node.locked = true;
      else delete node.locked;
      return;
    case 'textStyle':
    case 'mode':
      if (value) node[field] = String(value);
      else delete node[field];
      return;
    case 'text':
      node.text = String(value);
      // Ranges refer to the text as it was; an override of the words starts them over.
      delete (node as { spans?: unknown }).spans;
      return;
    case 'src':
    case 'svg':
    case 'tag':
    case 'name':
    case 'instanceOf':
      node[field] = String(value);
      return;
    default:
  }
}

function applyOverrides(node: BogenNode, overrides: Record<string, PropValue> | undefined, path: string): void {
  if (!overrides) return;
  const prefix = `${path}#`;
  for (const key in overrides) {
    if (key.startsWith(prefix) && key.indexOf('#') === path.length) applyField(node, key.slice(prefix.length), overrides[key]!);
  }
}

function applyProps(node: BogenNode, instanceProps: Record<string, PropValue> | undefined, def: ComponentDef | undefined, path: string): void {
  if (!instanceProps || !def?.props) return;
  for (const prop of def.props) {
    const value = instanceProps[prop.name];
    // A prop nobody set leaves the main's own value, so that editing the main keeps reaching here.
    if (value === undefined) continue;
    for (const target of prop.targets ?? []) if (target.path === path) applyField(node, target.field, value);
  }
}

function within(src: NodeSource, id: string, root: string): boolean {
  let cur = src.raw(id);
  for (let i = 0; cur && i < 2000; i++) {
    if (cur.parent === root) return true;
    cur = src.raw(cur.parent);
  }
  return false;
}

/** Main's look under the instance's own values. The instance decides where it sits. */
function mergeMain(node: BogenNode, main: BogenNode): void {
  const style: Record<string, string> = {};
  for (const key in main.style) if (!OWN_ONLY.has(key)) style[key] = main.style[key]!;
  const pos = main.style.position;
  // Absolute children of the main still need a box to sit in.
  if (pos === 'absolute' || pos === 'fixed' || pos === 'relative' || pos === 'sticky') style.position = 'relative';
  for (const key in node.style) {
    const value = node.style[key]!;
    if (value === '') delete style[key];
    else style[key] = value;
  }
  node.style = style;
  node.type = main.type;
  node.tag = main.tag;
  if (main.text !== undefined) node.text = main.text;
  if (main.spans) (node as { spans?: unknown }).spans = main.spans;
  if (main.src !== undefined) node.src = main.src;
  if (main.svg !== undefined) node.svg = main.svg;
  // A main that is a code component shows the same component in every instance.
  if (main.code) node.code = { ...main.code, props: { ...main.code.props } };
  if (main.attrs || node.attrs) node.attrs = { ...(main.attrs ?? {}), ...(node.attrs ?? {}) };
  if (node.textStyle === undefined && main.textStyle !== undefined) node.textStyle = main.textStyle;
  if (node.mode === undefined && main.mode !== undefined) node.mode = main.mode;
  if (main.slotName !== undefined) node.slotName = main.slotName;
  // Blocks merge per property, the instance's own on top, as its style does.
  if (main.rules || node.rules) {
    const rules: LayerRules = {};
    for (const source of [main.rules, node.rules]) for (const [block, style] of Object.entries(source ?? {})) rules[block] = { ...rules[block], ...style };
    node.rules = rules;
  }
}

function chainOf(node: BogenNode | undefined): readonly string[] {
  return node?.virtual?.mains ?? [];
}

/** A fill sits under the slot it fills, whatever its stored parent says. */
function fillParent(raw: BogenNode, prefix: string): string {
  const at = prefix ? `${prefix}/${raw.parent}` : raw.parent;
  return raw.slot === ROOT_SLOT ? at : `${at}/${raw.slot}`;
}

function slotExists(src: NodeSource, raw: BogenNode, prefix: string): boolean {
  const parent = fillParent(raw, prefix);
  return raw.slot === ROOT_SLOT ? resolveNode(src, parent)?.slotName !== undefined : resolveNode(src, parent)?.slotName !== undefined;
}

/** A layer as it renders: stored layers unchanged, instances with their main, views with overrides. */
export function resolveNode(src: NodeSource, id: string): BogenNode | undefined {
  return resolve(src, id, false);
}

function resolve(src: NodeSource, id: string, withoutOwner: boolean): BogenNode | undefined {
  if (withoutOwner) return compute(src, id, true);
  const memo = src.memo?.();
  if (!memo) return compute(src, id, false);
  if (memo.has(id)) return memo.get(id);
  const node = compute(src, id, false);
  memo.set(id, node);
  return node;
}

function compute(src: NodeSource, id: string, withoutOwner: boolean): BogenNode | undefined {
  if (!isVirtualId(id)) {
    const raw = src.raw(id);
    if (!raw) return undefined;
    if (raw.instanceOf === undefined) {
      if (raw.slot === undefined) return raw;
      return slotExists(src, raw, '') ? { ...raw, parent: fillParent(raw, '') } : raw;
    }
    const node: BogenNode = { ...raw, style: { ...raw.style } };
    const main = src.raw(raw.instanceOf);
    if (main && main.instanceOf === undefined) {
      mergeMain(node, main);
      if (!withoutOwner) {
        applyProps(node, raw.props, main.component, '');
        applyOverrides(node, raw.overrides, '');
      }
    }
    delete node.overrides;
    node.overrides = raw.overrides;
    node.virtual = { owner: id, path: '', source: id, mains: [raw.instanceOf] };
    if (raw.slot !== undefined && slotExists(src, raw, '')) node.parent = fillParent(raw, '');
    return node;
  }

  const segments = id.split('/');
  if (segments.length > MAX_DEPTH) return undefined;
  const source = segments[segments.length - 1]!;
  const raw = src.raw(source);
  if (!raw) return undefined;
  const ownerId = parentPrefix(id);
  const owner = resolve(src, ownerId, false);
  if (!owner || owner.instanceOf === undefined || !within(src, source, owner.instanceOf)) return undefined;

  const parent = raw.slot !== undefined
    ? fillParent(raw, ownerId)
    : raw.parent === owner.instanceOf ? ownerId : `${ownerId}/${raw.parent}`;
  const node: BogenNode = { ...raw, id, parent, style: { ...raw.style } };
  delete node.component;
  const chain = chainOf(owner);

  // First what decides which main a nested instance shows, and with which props.
  const levels: { instance: BogenNode; stored: BogenNode; path: string }[] = [];
  for (let i = segments.length - 2; i >= 0; i--) {
    const instanceId = segments.slice(0, i + 1).join('/');
    const instance = i === segments.length - 2 ? owner : resolve(src, instanceId, false);
    const stored = src.raw(segments[i]!);
    if (!instance || !stored) return undefined;
    levels.push({ instance, stored, path: segments.slice(i + 1).join('/') });
  }
  if (raw.instanceOf !== undefined) {
    for (const level of levels) {
      if (withoutOwner && level.instance.id === segments[0]) continue;
      const nested: BogenNode = { ...node, style: {} };
      applyProps(nested, level.instance.props, src.raw(level.instance.instanceOf ?? '')?.component, level.path);
      applyOverrides(nested, level.stored.overrides, level.path);
      if (nested.instanceOf !== undefined) node.instanceOf = nested.instanceOf;
      if (nested.props) node.props = nested.props;
    }
    const main = src.raw(node.instanceOf!);
    if (main && main.instanceOf === undefined) {
      mergeMain(node, main);
      applyProps(node, node.props, main.component, '');
      applyOverrides(node, raw.overrides, '');
    }
  }
  for (const level of levels) {
    if (withoutOwner && level.instance.id === segments[0]) continue;
    applyProps(node, level.instance.props, src.raw(level.instance.instanceOf ?? '')?.component, level.path);
    applyOverrides(node, level.stored.overrides, level.path);
  }
  node.virtual = { owner: segments[0]!, path: pathOf(id), source, mains: node.instanceOf !== undefined ? [...chain, node.instanceOf] : chain };
  return node;
}

/** What an instance's slot holds, outermost instance first. */
function fillsAt(src: NodeSource, id: string, isRoot: boolean): readonly string[] {
  const segments = id.split('/');
  const levels = isRoot ? segments.length : segments.length - 1;
  for (let i = 0; i < levels; i++) {
    const rest = segments.slice(i + 1);
    const key = isRoot ? [...rest, ROOT_SLOT].join('/') : rest.join('/');
    const fills = src.rawKids(segments[i]!).filter((k) => src.raw(k)?.slot === key);
    if (fills.length) return i === 0 ? fills : fills.map((f) => `${segments.slice(0, i).join('/')}/${f}`);
  }
  return [];
}

const NOTHING: readonly string[] = Object.freeze([]);

/** Children as they render. Pages and plain layers answer from storage, without allocating. */
export function resolveChildren(src: NodeSource, id: string): readonly string[] {
  if (!isVirtualId(id)) {
    const raw = src.raw(id);
    if (!raw || raw.instanceOf === undefined) return src.rawKids(id);
  }
  const node = resolveNode(src, id);
  if (!node) return NOTHING;
  let out: readonly string[];
  if (node.instanceOf !== undefined) {
    const main = src.raw(node.instanceOf);
    const chain = node.virtual?.mains ?? [];
    // The main the instance shows is last in its own chain, so a repeat earlier on is a cycle.
    if (!main || main.instanceOf !== undefined || chain.indexOf(node.instanceOf) !== chain.length - 1) return NOTHING;
    if (id.split('/').length >= MAX_DEPTH) return NOTHING;
    const fills = main.slotName !== undefined ? fillsAt(src, id, true) : NOTHING;
    out = fills.length ? fills : src.rawKids(main.id).map((k) => `${id}/${k}`);
  } else {
    const source = lastOf(id);
    const fills = node.slotName !== undefined ? fillsAt(src, id, false) : NOTHING;
    const prefix = parentPrefix(id);
    out = fills.length ? fills : src.rawKids(source).map((k) => `${prefix}/${k}`);
  }
  // A document can nest instances so that they multiply. It renders up to here.
  if (src.spend && !src.spend(out.length)) return NOTHING;
  return out;
}

/** Every slot an instance of this main can fill. `path` is what a fill stores as its `slot`. */
export function slotsOf(src: NodeSource, mainId: string, prefix = '', seen: string[] = []): { path: string; name: string }[] {
  const main = src.raw(mainId);
  if (!main || seen.includes(mainId) || seen.length >= MAX_DEPTH) return [];
  const chain = [...seen, mainId];
  const out: { path: string; name: string }[] = [];
  const join = (p: string) => (prefix ? `${prefix}/${p}` : p);
  if (main.slotName !== undefined) out.push({ path: join(ROOT_SLOT), name: main.slotName });
  const walk = (parent: string) => {
    for (const kid of src.rawKids(parent)) {
      const n = src.raw(kid);
      if (!n) continue;
      if (n.instanceOf !== undefined) {
        out.push(...slotsOf(src, n.instanceOf, join(kid), chain));
        continue;
      }
      if (n.slotName !== undefined) out.push({ path: join(kid), name: n.slotName });
      walk(kid);
    }
  };
  walk(mainId);
  return out;
}

/** Where a layer put into `parent` really goes: a plain frame, or the slot of an instance. */
export function insertTarget(src: NodeSource, parent: string): { parent: string; slot?: string } {
  const isView = isVirtualId(parent);
  const node = resolveNode(src, parent);
  if (!isView && node?.instanceOf === undefined) return { parent };
  if (!node) throw new Error(`No layer with id ${parent}.`);
  const owner = ownerOf(parent);
  const path = pathOf(parent);
  if (isView && node.instanceOf === undefined) {
    if (node.slotName !== undefined) return { parent: owner, slot: path };
    throw new Error(`Layer ${parent} is inside an instance, and only its slots take layers. Edit the main ${node.virtual?.mains.at(-1) ?? ''}, or call instance_detach first.`);
  }
  const slots = slotsOf(src, node.instanceOf!);
  if (!slots.length) throw new Error(`Layer ${parent} is an instance whose main has no slot, so it cannot hold layers. Mark a frame in the main with component_update slots, or call instance_detach first.`);
  if (slots.length > 1) throw new Error(`Layer ${parent} has several slots: ${slots.map((s) => s.name).join(', ')}. Name the one you mean.`);
  return { parent: owner, slot: path ? `${path}/${slots[0]!.path}` : slots[0]!.path };
}

// Reading components

export interface VariantOption { axis: string; values: string[] }

export function listMains(src: NodeSource): BogenNode[] {
  return src.mainIds().flatMap((id) => src.raw(id) ?? []);
}

/** Members of a variant set, the first one made first: that is the default. */
export function setMembers(src: NodeSource, set: string): BogenNode[] {
  return listMains(src).filter((m) => m.component?.set === set).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
}

/** Axes of a variant set, each with its values in the order they first appear. */
export function variantAxes(src: NodeSource, set: string | undefined): VariantOption[] {
  if (!set) return [];
  const axes = new Map<string, string[]>();
  for (const member of setMembers(src, set)) {
    for (const [axis, value] of Object.entries(member.component?.variant ?? {})) {
      const values = axes.get(axis) ?? [];
      if (!values.includes(value)) values.push(value);
      axes.set(axis, values);
    }
  }
  return [...axes].map(([axis, values]) => ({ axis, values }));
}

/** Finds a main by id, by name, or by set name with variant values. */
export function findMain(src: NodeSource, ref: string, variant?: Record<string, string>): BogenNode | undefined {
  const byId = src.raw(ref);
  if (byId?.component) return byId;
  const mains = listMains(src);
  const members = mains.filter((m) => m.component?.set === ref);
  if (members.length) {
    if (variant) {
      const scored = members.map((m) => ({ m, score: Object.entries(variant).filter(([k, v]) => m.component?.variant?.[k] === v).length }));
      scored.sort((a, b) => b.score - a.score);
      return scored[0]!.m;
    }
    return members[0];
  }
  const lower = ref.trim().toLowerCase();
  return mains.find((m) => m.name === ref) ?? mains.find((m) => m.name.toLowerCase() === lower);
}

export interface InstanceControl {
  name: string;
  type: 'text' | 'boolean' | 'variant' | 'image';
  value: PropValue;
  /** What an instance shows when the prop is not set. */
  fallback: PropValue;
  isSet: boolean;
  options?: string[];
}

function defaultOf(src: NodeSource, mainId: string, prop: ComponentProp): PropValue {
  const target = prop.targets?.[0];
  if (target) {
    const main = src.raw(mainId);
    const layer = target.path === '' ? main : src.raw(target.path.split('/').at(-1)!);
    if (target.field === 'text' && layer?.text !== undefined) return layer.text;
    if (target.field === 'src' && layer?.src !== undefined) return layer.src;
    if (target.field === 'visible') return !layer?.hidden;
    if (target.field === 'hidden') return Boolean(layer?.hidden);
  }
  return prop.default ?? (prop.type === 'boolean' ? false : '');
}

/** The controls an inspector shows for an instance: its variant axes, then its props. */
export function instanceControls(src: NodeSource, id: string): InstanceControl[] {
  const node = resolveNode(src, id);
  if (!node?.instanceOf) return [];
  const main = src.raw(node.instanceOf);
  if (!main?.component) return [];
  const out: InstanceControl[] = [];
  for (const { axis, values } of variantAxes(src, main.component.set)) {
    const value = main.component.variant?.[axis] ?? values[0]!;
    out.push({ name: axis, type: 'variant', value, fallback: value, isSet: true, options: values });
  }
  for (const prop of main.component.props ?? []) {
    const fallback = defaultOf(src, main.id, prop);
    const current = node.props?.[prop.name];
    out.push({ name: prop.name, type: prop.type === 'variant' ? 'variant' : prop.type, value: current ?? fallback, fallback, isSet: current !== undefined, ...(prop.options ? { options: prop.options } : {}) });
  }
  return out;
}

export interface OverrideEntry {
  /** Stored key, for `resetOverride`. */
  key: string;
  /** The layer it is on, as a view id. */
  layer: string;
  layerName: string;
  field: string;
  value: string;
}

/** What an instance changes compared with its main. For a view: what its owner changes on it. */
export function listOverrides(src: NodeSource, id: string): OverrideEntry[] {
  const owner = ownerOf(id);
  const stored = src.raw(owner);
  if (!stored?.instanceOf) return [];
  const main = src.raw(stored.instanceOf);
  const only = pathOf(id);
  const out: OverrideEntry[] = [];
  const name = (layer: string) => resolveNode(src, layer)?.name ?? '';
  const covers = (path: string) => !only || path === only || path.startsWith(`${only}/`);
  if (!only) {
    for (const [prop, value] of Object.entries(stored.style)) {
      if (OWN_ONLY.has(prop)) continue;
      if (main?.style[prop] === value) continue;
      out.push({ key: `own:${prop}`, layer: owner, layerName: stored.name, field: `style.${prop}`, value: value === '' ? 'removed' : value });
    }
  }
  for (const [key, value] of Object.entries(stored.overrides ?? {})) {
    const { path, field } = splitKey(key);
    if (!covers(path)) continue;
    const layer = path ? `${owner}/${path}` : owner;
    out.push({ key, layer, layerName: name(layer), field, value: value === '' ? 'removed' : String(value) });
  }
  for (const kid of src.rawKids(owner)) {
    const fill = src.raw(kid);
    if (fill?.slot === undefined) continue;
    const slotPath = fill.slot === ROOT_SLOT ? '' : fill.slot;
    if (!covers(slotPath)) continue;
    out.push({ key: `fill:${kid}`, layer: kid, layerName: fill.name, field: 'slot', value: slotPath ? (name(`${owner}/${slotPath}`) || slotPath) : (main?.slotName ?? 'content') });
  }
  return out;
}

// Writing

function needMap(doc: BogenDoc, id: string): Y.Map<unknown> {
  const m = doc.nodes.get(id);
  if (!m) throw new Error(`No layer with id ${id}.`);
  return m;
}

function nestedMap(m: Y.Map<unknown>, field: string): Y.Map<PropValue> {
  let map = m.get(field) as Y.Map<PropValue> | undefined;
  if (!(map instanceof Y.Map)) {
    map = new Y.Map<PropValue>();
    m.set(field, map);
  }
  return map;
}

/**
 * Patches a layer's style through an instance. Equal to what it would show anyway removes the
 * override, so that "overridden" stays what people expect, and a value set to null is hidden.
 */
export function patchViewStyle(doc: BogenDoc, id: string, patch: Record<string, string | null>): void {
  const src = doc.source;
  const owner = ownerOf(id);
  const overrides = nestedMap(needMap(doc, owner), 'overrides');
  const base = resolve(src, id, true);
  if (!base) throw new Error(`No layer with id ${id}.`);
  const path = pathOf(id);
  for (const [prop, value] of Object.entries(patch)) {
    const key = overrideKey(path, `style.${prop}`);
    const wanted = value ?? '';
    const baseline = base.style[prop];
    if (wanted === '' ? baseline === undefined : wanted === baseline) {
      if (overrides.has(key)) overrides.delete(key);
    } else if (overrides.get(key) !== wanted) overrides.set(key, wanted);
  }
}

/**
 * Patches one block of a layer's rules through an instance, as overrides on its owner, also for the
 * instance itself. Equal to what it shows anyway removes the override; null hides a property it has.
 */
export function patchViewRules(doc: BogenDoc, id: string, block: string, patch: Record<string, string | null>): void {
  const owner = ownerOf(id);
  const overrides = nestedMap(needMap(doc, owner), 'overrides');
  const base = resolve(doc.source, id, true);
  if (!base) throw new Error(`No layer with id ${id}.`);
  const path = pathOf(id);
  for (const [prop, value] of Object.entries(patch)) {
    const key = overrideKey(path, ruleOverrideField(block, prop));
    const wanted = value ?? '';
    const baseline = base.rules?.[block]?.[prop];
    if (wanted === '' ? baseline === undefined : wanted === baseline) {
      if (overrides.has(key)) overrides.delete(key);
    } else if (overrides.get(key) !== wanted) overrides.set(key, wanted);
  }
}

/** The own style of an instance. Absent means the main's value, and '' means none at all. */
export function patchInstanceStyle(doc: BogenDoc, id: string, patch: Record<string, string | null>): void {
  const m = needMap(doc, id);
  const style = m.get('style') as Y.Map<string>;
  const main = doc.source.raw(String(m.get('instanceOf')));
  for (const [prop, value] of Object.entries(patch)) {
    const inherited = OWN_ONLY.has(prop) ? undefined : main?.style[prop];
    if (value === null || value === '') {
      if (inherited !== undefined) style.set(prop, '');
      else style.delete(prop);
    } else if (value === inherited) style.delete(prop);
    else if (style.get(prop) !== value) style.set(prop, value);
  }
}

const OWN_FIELDS = new Set(['name', 'hidden', 'locked', 'artboard', 'mode', 'textStyle', 'slot', 'proto', 'layoutGrids']);

/** Fields of an instance or of a view into one: its own where it has them, overrides otherwise. */
export function patchViewFields(doc: BogenDoc, id: string, patch: Record<string, unknown>): void {
  const src = doc.source;
  const owner = ownerOf(id);
  const m = needMap(doc, owner);
  const virtual = isVirtualId(id);
  const path = pathOf(id);
  const overrides = nestedMap(m, 'overrides');
  const base = resolve(src, id, true);
  if (!base) throw new Error(`No layer with id ${id}.`);
  const write = (field: string, value: PropValue | undefined, baseline: PropValue | undefined) => {
    const key = overrideKey(path, field);
    const same = value === baseline || (value === undefined && (baseline === undefined || baseline === false));
    if (same) {
      if (overrides.has(key)) overrides.delete(key);
    } else {
      const stored = value ?? (typeof baseline === 'boolean' ? false : '');
      if (overrides.get(key) !== stored) overrides.set(key, stored);
    }
  };
  for (const [field, value] of Object.entries(patch)) {
    if (!virtual && OWN_FIELDS.has(field)) {
      if (value === undefined) m.delete(field);
      else m.set(field, value);
      continue;
    }
    if (field === 'artboard' || field === 'slot') continue;
    if (field === 'attrs') {
      const next = (value ?? {}) as Record<string, string>;
      const before = base.attrs ?? {};
      const earlier = [...overrides.keys()].filter((k) => k.startsWith(overrideKey(path, 'attr.'))).map((k) => k.slice(overrideKey(path, 'attr.').length));
      for (const name of new Set([...Object.keys(next), ...Object.keys(before), ...earlier])) {
        const wanted = next[name];
        const key = overrideKey(path, `attr.${name}`);
        if (wanted === before[name]) {
          if (overrides.has(key)) overrides.delete(key);
        } else overrides.set(key, wanted ?? false);
      }
      continue;
    }
    write(field, value as PropValue | undefined, (base as unknown as Record<string, PropValue | undefined>)[field]);
  }
}

/** Takes back one override, by the key `listOverrides` gave. */
export function resetOverride(doc: BogenDoc, id: string, key: string, origin?: unknown): void {
  const owner = ownerOf(id);
  const m = needMap(doc, owner);
  doc.transact(() => {
    if (key.startsWith('own:')) (m.get('style') as Y.Map<string>).delete(key.slice(4));
    else if (key.startsWith('fill:')) doc.delete([key.slice(5)]);
    else (m.get('overrides') as Y.Map<PropValue> | undefined)?.delete(key);
  }, origin);
}

/** Back to the main. The variant, position and name stay, as they are what an instance is for. */
export function resetAllOverrides(doc: BogenDoc, id: string, origin?: unknown): void {
  const owner = ownerOf(id);
  const stored = doc.source.raw(owner);
  if (!stored?.instanceOf) throw new Error(`Layer ${id} is not part of an instance.`);
  doc.transact(() => {
    for (const entry of listOverrides(doc.source, id)) resetOverride(doc, id, entry.key);
    if (!isVirtualId(id)) {
      const props = doc.nodes.get(owner)?.get('props');
      if (props instanceof Y.Map) for (const k of [...props.keys()]) props.delete(k);
    }
  }, origin);
}

function namePath(src: NodeSource, id: string, root: string): string[] | null {
  const out: string[] = [];
  let cur = src.raw(id);
  for (let i = 0; cur && i < 200; i++) {
    const siblings = src.rawKids(cur.parent).filter((k) => src.raw(k)?.name === cur!.name);
    out.unshift(`${cur.name}#${siblings.indexOf(cur.id)}`);
    if (cur.parent === root) return out;
    cur = src.raw(cur.parent);
  }
  return null;
}

function findByNamePath(src: NodeSource, root: string, path: string[]): string | null {
  let at = root;
  for (const part of path) {
    const hash = part.lastIndexOf('#');
    const name = part.slice(0, hash);
    const index = Number(part.slice(hash + 1));
    const next = src.rawKids(at).filter((k) => src.raw(k)?.name === name)[index];
    if (!next) return null;
    at = next;
  }
  return at;
}

/** Overrides follow a layer of the same name when an instance moves to another main. */
function retarget(doc: BogenDoc, id: string, next: string): void {
  const src = doc.source;
  const m = needMap(doc, id);
  const prev = String(m.get('instanceOf'));
  const moved = (path: string): string | null => {
    const head = path.split('/')[0]!;
    if (head === '.' || !head) return path;
    const names = namePath(src, head, prev);
    const found = names && findByNamePath(src, next, names);
    return found ? [found, ...path.split('/').slice(1)].join('/') : null;
  };
  const overrides = m.get('overrides');
  if (overrides instanceof Y.Map) {
    for (const [key, value] of [...overrides.entries()] as [string, PropValue][]) {
      const { path, field } = splitKey(key);
      if (!path) continue;
      const to = moved(path);
      if (to && to !== path) {
        overrides.delete(key);
        overrides.set(overrideKey(to, field), value);
      }
    }
  }
  for (const kid of [...src.rawKids(id)]) {
    const fill = doc.nodes.get(kid);
    const slot = fill?.get('slot');
    if (typeof slot !== 'string' || slot === ROOT_SLOT) continue;
    const to = moved(slot);
    if (to && to !== slot) fill!.set('slot', to);
  }
  m.set('instanceOf', next);
  if (doc.source.raw(next)?.tag) m.set('tag', doc.source.raw(next)!.tag);
}

/** Sets props on an instance or on an instance nested in one. A variant value switches the main. */
export function setInstanceProps(doc: BogenDoc, id: string, patch: Record<string, PropValue | null>, origin?: unknown): void {
  const src = doc.source;
  const node = resolveNode(src, id);
  if (!node?.instanceOf) throw new Error(`Layer ${id} is not an instance.`);
  const main = src.raw(node.instanceOf);
  const axes = new Set(variantAxes(src, main?.component?.set).map((a) => a.axis));
  const virtual = isVirtualId(id);
  const owner = needMap(doc, ownerOf(id));
  const path = pathOf(id);
  const known = new Set((main?.component?.props ?? []).map((p) => p.name));
  doc.transact(() => {
    const variant: Record<string, string> = { ...(main?.component?.variant ?? {}) };
    let switched = false;
    for (const [name, value] of Object.entries(patch)) {
      if (axes.has(name)) {
        if (value === null) continue;
        if (variant[name] !== String(value)) switched = true;
        variant[name] = String(value);
        continue;
      }
      if (!known.has(name)) throw new Error(`The component "${main?.name}" has no prop "${name}". It has: ${[...axes, ...known].join(', ') || 'none'}.`);
      if (virtual) {
        const overrides = nestedMap(owner, 'overrides');
        const key = overrideKey(path, `prop.${name}`);
        if (value === null) overrides.delete(key);
        else overrides.set(key, value);
      } else {
        const props = nestedMap(owner, 'props');
        if (value === null) props.delete(name);
        else props.set(name, value);
      }
    }
    if (!switched) return;
    const set = main!.component!.set!;
    const member = setMembers(src, set).find((m) => Object.keys(variant).every((k) => m.component?.variant?.[k] === variant[k]));
    if (!member) throw new Error(`The variant set "${set}" has no member with ${Object.entries(variant).map(([k, v]) => `${k}=${v}`).join(', ')}.`);
    if (member.id === node.instanceOf) return;
    if (virtual) nestedMap(owner, 'overrides').set(overrideKey(path, 'instanceOf'), member.id);
    else retarget(doc, id, member.id);
  }, origin);
}

/** Field values an agent or panel writes for an override, in the fields the resolver understands. */
export function setOverride(doc: BogenDoc, id: string, field: string, value: PropValue | null, origin?: unknown): void {
  if (!FIELD.test(field)) throw new Error(`"${field}" cannot be overridden. Use text, src, hidden, style.<property> or attr.<name>.`);
  if (!ownerOf(id) || !doc.source.raw(ownerOf(id))?.instanceOf) throw new Error(`Layer ${id} is not part of an instance.`);
  doc.transact(() => {
    if (field.startsWith('style.')) doc.updateStyle(id, { [field.slice(6)]: value === null ? null : String(value) });
    else if (field.startsWith('prop.')) setInstanceProps(doc, id, { [field.slice(5)]: value });
    else if (field.startsWith('code.')) {
      const overrides = nestedMap(needMap(doc, ownerOf(id)), 'overrides');
      const key = overrideKey(pathOf(id), field);
      if (value === null) overrides.delete(key);
      else overrides.set(key, value);
    } else if (field.startsWith('attr.')) {
      const name = field.slice(5);
      const attrs = { ...(doc.getNode(id)?.attrs ?? {}) };
      if (value === null) delete attrs[name];
      else attrs[name] = String(value);
      doc.updateFields(id, { attrs });
    } else if (field === 'visible') doc.updateFields(id, { hidden: value === false ? true : undefined });
    else doc.updateFields(id, { [field]: value === null ? undefined : value } as never);
  }, origin);
}

export interface ComponentOptions {
  name?: string;
  description?: string;
  set?: string;
  variant?: Record<string, string>;
  props?: ComponentProp[];
  /** null takes it away. */
  handoff?: CodeHandoff | null;
}

const PROP_NAME = /^[a-zA-Z_][\w-]*$/;
const TARGET_FIELD = /^(?:text|src|hidden|visible|style\.-{0,2}[a-zA-Z][\w-]*|attr\.[a-zA-Z][\w:-]*|prop\.[a-zA-Z_][\w-]*|code\.[A-Za-z_$][\w$-]*)$/;

function cleanProp(prop: ComponentProp): ComponentProp {
  if (!PROP_NAME.test(prop.name)) throw new Error(`"${prop.name}" is not a valid prop name. Use letters, digits, - and _.`);
  for (const t of prop.targets ?? []) if (!TARGET_FIELD.test(t.field)) throw new Error(`A prop cannot drive "${t.field}". Use text, src, hidden, visible, style.<property>, attr.<name>, prop.<name> or code.<prop>.`);
  return {
    name: prop.name, type: prop.type,
    ...(prop.default !== undefined ? { default: prop.default } : {}),
    ...(prop.options ? { options: prop.options } : {}),
    ...(prop.targets ? { targets: prop.targets } : {}),
  };
}

function writeComponent(doc: BogenDoc, id: string, options: ComponentOptions): void {
  const m = needMap(doc, id);
  let def = m.get('component') as Y.Map<unknown> | undefined;
  if (!(def instanceof Y.Map)) {
    def = new Y.Map<unknown>();
    def.set('props', new Y.Map<unknown>());
    m.set('component', def);
  }
  if (options.name !== undefined) m.set('name', options.name);
  if (options.description !== undefined) {
    if (options.description) def.set('description', options.description);
    else def.delete('description');
  }
  if (options.set !== undefined) {
    if (options.set) def.set('set', options.set);
    else def.delete('set');
  }
  if (options.variant !== undefined) def.set('variant', options.variant);
  if (options.handoff === null) def.delete('handoff');
  else if (options.handoff) {
    const clean = readHandoff(options.handoff);
    if (!clean) throw new Error('That handoff is not valid: it needs from (a module such as @/components/ui/button) and name (a component such as Button), and a usage of tags and quoted attributes only.');
    def.set('handoff', clean);
  }
  if (options.props) {
    let props = def.get('props') as Y.Map<unknown> | undefined;
    if (!(props instanceof Y.Map)) {
      props = new Y.Map<unknown>();
      def.set('props', props);
    }
    const seen = new Set(options.props.map((p) => p.name));
    for (const key of [...props.keys()]) if (!seen.has(key)) props.delete(key);
    options.props.forEach((prop, order) => props!.set(prop.name, { ...cleanProp(prop), order }));
  }
}

/** Marks a layer as a main, in place: it stays where it is and goes on being edited there. */
export function createComponent(doc: BogenDoc, id: string, options: ComponentOptions = {}, origin?: unknown): string {
  if (isVirtualId(id)) throw new Error(`Layer ${id} is inside an instance. Edit its main, or call instance_detach first.`);
  const node = doc.source.raw(id);
  if (!node) throw new Error(`No layer with id ${id}.`);
  if (node.instanceOf !== undefined) throw new Error(`Layer ${id} is already an instance. Wrap it in a frame first, and make that a component.`);
  doc.transact(() => writeComponent(doc, id, options), origin);
  return id;
}

export function updateComponent(doc: BogenDoc, id: string, options: ComponentOptions, origin?: unknown): void {
  if (!doc.source.raw(id)?.component) throw new Error(`Layer ${id} is not a component. Call component_list.`);
  doc.transact(() => writeComponent(doc, id, options), origin);
}

/** Marks a frame inside a main as a slot, or with null as an ordinary frame again. */
export function setSlot(doc: BogenDoc, id: string, name: string | null, origin?: unknown): void {
  const m = needMap(doc, id);
  doc.transact(() => {
    if (name === null) m.delete('slotName');
    else m.set('slotName', name || 'content');
  }, origin);
}

/** The main a layer belongs to, if it is inside one or is one. */
export function enclosingMain(doc: BogenDoc, id: string): string | undefined {
  let cur = doc.source.raw(id);
  for (let i = 0; cur && i < 2000; i++) {
    if (cur.component) return cur.id;
    cur = doc.source.raw(cur.parent);
  }
  return undefined;
}

/** Whether a main shows up anywhere inside another, which would have it contain itself. */
function reaches(src: NodeSource, from: string, target: string, seen = new Set<string>()): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const visit = (id: string): boolean => {
    for (const kid of src.rawKids(id)) {
      const n = src.raw(kid);
      if (!n) continue;
      if (n.instanceOf !== undefined && reaches(src, n.instanceOf, target, seen)) return true;
      if (visit(kid)) return true;
    }
    return false;
  };
  return visit(from);
}

export interface InstanceOptions {
  index?: number;
  style?: Record<string, string>;
  props?: Record<string, PropValue>;
  overrides?: Record<string, PropValue>;
  name?: string;
  children?: NewNode[];
}

/** An instance, as a spec `insert` takes. */
export function instanceSpec(doc: BogenDoc, mainId: string, options: InstanceOptions = {}): NewNode {
  const main = doc.source.raw(mainId);
  if (!main?.component) throw new Error(`Layer ${mainId} is not a component. Call component_list.`);
  return {
    type: 'frame', tag: main.tag, name: options.name ?? main.name, instanceOf: mainId,
    ...(options.style ? { style: options.style } : {}),
    ...(options.props ? { props: options.props } : {}),
    ...(options.overrides ? { overrides: options.overrides } : {}),
    ...(options.children ? { children: options.children } : {}),
  };
}

export function createInstance(doc: BogenDoc, mainId: string, parent: string, options: InstanceOptions = {}, origin?: unknown): string {
  const src = doc.source;
  // Walk up from where it lands: an instance inside its own main never ends.
  const realParent = isVirtualId(parent) ? insertTarget(src, parent).parent : parent;
  const home = enclosingMain(doc, realParent);
  if (home && reaches(src, mainId, home)) throw new Error('This would put a component inside itself.');
  for (let cur = src.raw(realParent), i = 0; cur && i < 2000; i++, cur = src.raw(cur.parent)) {
    if (cur.id === mainId) throw new Error('This would put a component inside itself.');
  }
  return doc.insert(parent, instanceSpec(doc, mainId, options), options.index, origin);
}

function storedInstanceSpec(doc: BogenDoc, viewId: string, node: BogenNode): NewNode {
  // A nested instance stays linked: only the outermost one is what was detached.
  const stored = doc.source.raw(lastOf(viewId))!;
  const owner = doc.source.raw(ownerOf(viewId))!;
  const path = pathOf(viewId);
  const overrides: Record<string, PropValue> = { ...(stored.overrides ?? {}) };
  const style: Record<string, string> = { ...stored.style };
  for (const [key, value] of Object.entries(owner.overrides ?? {})) {
    const { path: p, field } = splitKey(key);
    if (p === path) {
      if (field.startsWith('style.')) style[field.slice(6)] = String(value);
      else if (field === 'name' || field === 'hidden' || field === 'instanceOf' || field.startsWith('prop.')) continue;
      else overrides[overrideKey('', field)] = value;
    } else if (p.startsWith(`${path}/`)) overrides[overrideKey(p.slice(path.length + 1), field)] = value;
  }
  return {
    type: 'frame', tag: node.tag, name: node.name, instanceOf: node.instanceOf!, style,
    ...(node.props ? { props: node.props } : {}),
    ...(Object.keys(overrides).length ? { overrides } : {}),
    ...(node.hidden ? { hidden: true } : {}),
    children: doc.source.rawKids(stored.id).flatMap((k) => (doc.source.raw(k)?.slot !== undefined ? [doc.toSpec(k)] : [])),
  };
}

/** The tree under a view as real layers, with what it shows now. */
export function materialize(doc: BogenDoc, id: string): NewNode {
  const node = doc.getNode(id);
  if (!node) throw new Error(`No layer with id ${id}.`);
  if (isVirtualId(id) && node.instanceOf !== undefined) return storedInstanceSpec(doc, id, node);
  const children = doc.getChildren(id).map((c) => (isVirtualId(c.id) ? materialize(doc, c.id) : doc.toSpec(c.id)));
  const { spans } = node as { spans?: unknown };
  return {
    type: node.type, name: node.name, tag: node.tag, style: { ...node.style },
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(spans ? { spans } as object : {}),
    ...(node.src !== undefined ? { src: node.src } : {}),
    ...(node.svg !== undefined ? { svg: node.svg } : {}),
    ...(node.attrs ? { attrs: node.attrs } : {}),
    ...(node.textStyle ? { textStyle: node.textStyle } : {}),
    ...(node.mode ? { mode: node.mode } : {}),
    ...(node.rules ? { rules: node.rules } : {}),
    ...(node.hidden ? { hidden: true } : {}),
    ...(children.length ? { children } : {}),
  };
}

function flattened(doc: BogenDoc, id: string): NewNode {
  const node = doc.getNode(id)!;
  const children = doc.getChildren(id).map((c) => flattened(doc, c.id));
  return {
    type: node.type, name: node.name, tag: node.tag, style: { ...node.style },
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(node.src !== undefined ? { src: node.src } : {}),
    ...(node.svg !== undefined ? { svg: node.svg } : {}),
    ...(node.attrs ? { attrs: node.attrs } : {}),
    ...(node.textStyle ? { textStyle: node.textStyle } : {}),
    ...(node.mode ? { mode: node.mode } : {}),
    ...(node.rules ? { rules: node.rules } : {}),
    ...(node.hidden ? { hidden: true } : {}),
    ...(children.length ? { children } : {}),
  };
}

/** A spec for the clipboard: it stays linked within a file, and looks the same in another one. */
export function clipSpec(doc: BogenDoc, id: string): NewNode {
  if (isVirtualId(id)) return flattened(doc, id);
  const kids = doc.rawKids(id).map((k) => clipSpec(doc, k));
  const spec = doc.toSpec(id);
  return {
    ...spec,
    ...(kids.length ? { children: kids } : {}),
    ...(spec.instanceOf !== undefined ? { materialized: flattened(doc, id) } : {}),
  };
}

/** Turns an instance into ordinary layers that look the same. Nested instances stay instances. */
export function detachInstance(doc: BogenDoc, id: string, origin?: unknown): string {
  if (isVirtualId(id)) throw new Error(`Layer ${id} is inside an instance. Detach ${ownerOf(id)} first.`);
  const stored = doc.source.raw(id);
  if (!stored?.instanceOf) throw new Error(`Layer ${id} is not an instance.`);
  const spec = materialize(doc, id);
  const m = needMap(doc, id);
  doc.transact(() => {
    const style = m.get('style') as Y.Map<string>;
    for (const key of [...style.keys()]) if (!(key in (spec.style ?? {}))) style.delete(key);
    for (const [key, value] of Object.entries(spec.style ?? {})) if (style.get(key) !== value) style.set(key, value);
    m.delete('instanceOf');
    m.delete('props');
    m.delete('overrides');
    m.set('type', spec.type);
    m.set('tag', spec.tag ?? 'div');
    const textual = spec.type === 'text' && spec.text !== undefined;
    for (const field of ['text', 'src', 'svg', 'attrs', 'textStyle', 'mode', 'spans'] as const) {
      if (textual && (field === 'text' || field === 'spans')) continue;
      const value = (spec as unknown as Record<string, unknown>)[field];
      if (value === undefined) m.delete(field);
      else m.set(field, value);
    }
    if (textual) setLayerText(m, spec.text, spec.spans ?? []);
    if (spec.rules) m.set('rules', rulesToYMap(spec.rules));
    else m.delete('rules');
    doc.delete([...doc.source.rawKids(id)]);
    let previous: string | null = null;
    for (const child of spec.children ?? []) {
      previous = generateKeyBetween(previous, null);
      doc.writeTree(id, child, previous);
    }
  }, origin);
  return id;
}

/** All instances of a main that are stored, and how many views of it there are through nesting. */
export function instancesOf(doc: BogenDoc, mainId: string): string[] {
  const out: string[] = [];
  doc.nodes.forEach((m, id) => {
    if (m.get('instanceOf') === mainId) out.push(id);
  });
  return out;
}

/**
 * A deleted main leaves its instances looking as they did: to another member of its variant set if
 * there is one, else as ordinary layers. Called inside the delete's transaction, so undo brings both back.
 */
export function releaseMains(doc: BogenDoc, deleted: Set<string>): void {
  const src = doc.source;
  for (const id of deleted) {
    const main = src.raw(id);
    if (!main?.component) continue;
    const others = main.component.set ? setMembers(src, main.component.set).filter((m) => !deleted.has(m.id)) : [];
    for (const instance of instancesOf(doc, id)) {
      if (deleted.has(instance)) continue;
      if (others[0]) retarget(doc, instance, others[0].id);
      else detachInstance(doc, instance);
    }
  }
}

/** A copy of a main as another member of its variant set, next to it. */
export function addVariant(doc: BogenDoc, mainId: string, variant: Record<string, string>, options: { base?: Record<string, string>; left?: string } = {}, origin?: unknown): string {
  const main = doc.source.raw(mainId);
  if (!main?.component) throw new Error(`Layer ${mainId} is not a component.`);
  return doc.transact(() => {
    const set = main.component!.set ?? main.name;
    const first = main.component!.variant ?? options.base ?? Object.fromEntries(Object.keys(variant).map((k) => [k, 'default']));
    if (!main.component!.set || !main.component!.variant) writeComponent(doc, mainId, { set, variant: first });
    const [copy] = doc.duplicate([mainId]);
    doc.invalidate();
    const label = Object.values({ ...first, ...variant }).join(' ');
    // The copy has layers of its own, so what the props drive has to be found again in it.
    const props = (main.component!.props ?? []).map((prop) => ({
      ...prop,
      targets: prop.targets?.map((target) => {
        if (!target.path) return target;
        const [head, ...rest] = target.path.split('/');
        const names = namePath(doc.source, head!, mainId);
        const found = names && findByNamePath(doc.source, copy!, names);
        return found ? { ...target, path: [found, ...rest].join('/') } : target;
      }),
    }));
    writeComponent(doc, copy!, { set, variant: { ...first, ...variant }, name: `${set} / ${label}`, props });
    if (options.left) doc.updateStyle(copy!, { left: options.left });
    return copy!;
  }, origin);
}

/** Fills `instanceRef` and `slotRef` of specs from HTML, so that the instances point at real mains. */
export function resolveInstanceRefs(doc: BogenDoc, specs: NewNode[], strict = true): void {
  const src = doc.source;
  const visit = (spec: NewNode) => {
    for (const child of spec.children ?? []) visit(child);
    const ref = spec.instanceRef;
    if (!ref) return;
    delete spec.instanceRef;
    const variant = Object.fromEntries(Object.entries(spec.props ?? {}).map(([k, v]) => [k, String(v)]));
    const main = findMain(src, ref, variant);
    if (!main) {
      if (!strict) return;
      const known = listMains(src).map((m) => `${m.name} (${m.id})`).join(', ') || 'none yet; make one with component_create';
      throw new Error(`There is no component "${ref}". Components in this file: ${known}.`);
    }
    spec.instanceOf = main.id;
    spec.type = 'frame';
    spec.tag = main.tag;
    if (spec.name === 'Instance' || !spec.name) spec.name = main.name;
    const axes = new Set(variantAxes(src, main.component?.set).map((a) => a.axis));
    const known = new Set((main.component?.props ?? []).map((p) => p.name));
    const props: Record<string, PropValue> = {};
    for (const [name, value] of Object.entries(spec.props ?? {})) {
      if (axes.has(name)) continue;
      if (!known.has(name)) {
        if (!strict) continue;
        throw new Error(`The component "${main.name}" has no prop "${name}". It has: ${[...axes, ...known].join(', ') || 'none'}.`);
      }
      const type = main.component?.props?.find((p) => p.name === name)?.type;
      props[name] = type === 'boolean' ? value === true || value === 'true' || value === '' : value;
    }
    spec.props = props;
    const slots = slotsOf(src, main.id);
    for (const child of spec.children ?? []) {
      const want = child.slotRef;
      delete child.slotRef;
      const slot = want ? slots.find((s) => s.name === want) : slots[0];
      if (!slot) {
        if (!strict) continue;
        throw new Error(want ? `The component "${main.name}" has no slot "${want}". It has: ${slots.map((s) => s.name).join(', ') || 'none'}.` : `The component "${main.name}" has no slot, so its <x-instance> cannot have children.`);
      }
      child.slot = slot.path;
    }
  };
  specs.forEach(visit);
}

export type { PropTarget };
