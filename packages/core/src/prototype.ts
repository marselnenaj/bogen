import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { BogenDoc, type BogenNode, type LayerProto, type ProtoTransition } from './doc.ts';
import { kebabCss } from './css.ts';
import { setInstanceProps, variantAxes } from './components.ts';
import { exportDocument, type HtmlOptions } from './render.ts';

/**
 * Prototypes with state. A file has variables (boolean, number or text); a layer's `proto` says what
 * happens on click, hover or submit, when it shows, which variant it takes and which variable a form
 * field is bound to. Preview mode runs it, and `exportPrototype` writes it as one static HTML file with
 * one small script: the only place Bogen ever writes a script.
 *
 * Everything here is read from documents that come from other people, so it is cleaned on the way out
 * and the script only ever touches the page it is in.
 */

export type VariableType = 'boolean' | 'number' | 'text';
export type VariableValue = boolean | number | string;
export interface FileVariable { name: string; type: VariableType; value: VariableValue; description?: string }

export type ProtoTrigger = 'click' | 'hover' | 'submit';
export const PROTO_TRIGGERS: readonly ProtoTrigger[] = ['click', 'hover', 'submit'];

export type ProtoAction =
  | { type: 'set'; variable: string; value: VariableValue }
  | { type: 'toggle'; variable: string }
  | { type: 'increment'; variable: string; by?: number }
  | { type: 'show' | 'hide' | 'toggle-visibility'; target: string }
  | { type: 'set-variant'; target: string; value: string }
  | { type: 'navigate'; to: string; transition?: ProtoTransition; duration?: number }
  | { type: 'back' };
export type ProtoActionType = ProtoAction['type'];
export const PROTO_ACTION_TYPES: readonly ProtoActionType[] = ['set', 'toggle', 'increment', 'show', 'hide', 'toggle-visibility', 'set-variant', 'navigate', 'back'];

export interface ProtoInteraction { trigger: ProtoTrigger; actions: ProtoAction[] }

export type ConditionOp = 'is' | 'not' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'empty' | 'filled';
export const CONDITION_OPS: readonly ConditionOp[] = ['is', 'not', 'gt', 'lt', 'gte', 'lte', 'contains', 'empty', 'filled'];
export interface ProtoCondition { variable: string; op: ConditionOp; value?: VariableValue }

/** What a prototype adds to a layer's `proto`. Older readers keep `link`, `transition`, `duration` and `hover`. */
export interface ProtoState {
  interactions?: ProtoInteraction[];
  /** Shown only while this holds. */
  showWhen?: ProtoCondition;
  /** On an instance: the variant axis that follows a variable, by value. */
  variantFrom?: { prop: string; variable: string };
  /** On a form field: the variable it reads and writes. */
  bind?: string;
  /** On a text layer: shows the variable's value. */
  textFrom?: string;
}

const NAME = /^[a-zA-Z_][\w-]{0,63}$/;
const ID = /^[\w/-]{1,200}$/;
const MAX_TEXT = 2000;
const MAX_ACTIONS = 20;
const MAX_INTERACTIONS = 8;

export const isVariableName = (name: string): boolean => NAME.test(name);

// Variables

function variablesMap(doc: BogenDoc): Y.Map<Y.Map<unknown>> {
  return doc.variables;
}

/** A value as the type wants it, or null when it cannot be one. */
export function coerceVariable(type: VariableType, value: unknown): VariableValue | null {
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0' || value === '') return false;
    return null;
  }
  if (type === 'number') {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'string') return value.slice(0, MAX_TEXT);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

const DEFAULTS: Record<VariableType, VariableValue> = { boolean: false, number: 0, text: '' };

export function getVariables(doc: BogenDoc): FileVariable[] {
  const out: (FileVariable & { order: string })[] = [];
  variablesMap(doc).forEach((m, name) => {
    if (!(m instanceof Y.Map) || !NAME.test(name)) return;
    const type = m.get('type');
    if (type !== 'boolean' && type !== 'number' && type !== 'text') return;
    const value = coerceVariable(type, m.get('value')) ?? DEFAULTS[type];
    const description = m.get('description');
    out.push({ name, type, value, order: String(m.get('order') ?? ''), ...(typeof description === 'string' && description ? { description: description.slice(0, 300) } : {}) });
  });
  return out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.name < b.name ? -1 : 1)).map(({ order: _order, ...v }) => v);
}

/** Creates or changes a variable. Its value is coerced to its type; a type change keeps what still fits. */
export function setVariable(doc: BogenDoc, input: { name: string; type?: VariableType; value?: unknown; description?: string; rename?: string }, origin?: unknown): FileVariable {
  if (!NAME.test(input.name)) throw new Error(`"${input.name}" is not a valid variable name. Start with a letter and use letters, digits, - and _.`);
  const map = variablesMap(doc);
  const existing = map.get(input.name);
  const type = input.type ?? (existing?.get('type') as VariableType | undefined) ?? (typeof input.value === 'boolean' ? 'boolean' : typeof input.value === 'number' ? 'number' : 'text');
  if (type !== 'boolean' && type !== 'number' && type !== 'text') throw new Error('type is boolean, number or text.');
  const given = input.value !== undefined ? coerceVariable(type, input.value) : null;
  if (input.value !== undefined && given === null) throw new Error(`${JSON.stringify(input.value)} is not a ${type}.`);
  const value = given ?? coerceVariable(type, existing?.get('value')) ?? DEFAULTS[type];
  const name = input.rename ?? input.name;
  if (!NAME.test(name)) throw new Error(`"${name}" is not a valid variable name.`);
  if (name !== input.name && map.has(name)) throw new Error(`There is already a variable called ${name}.`);
  doc.transact(() => {
    let m = existing;
    const order = (m?.get('order') as string | undefined) ?? generateKeyBetween(lastOrder(map), null);
    if (name !== input.name) {
      map.delete(input.name);
      m = undefined;
    }
    if (!m) {
      m = new Y.Map<unknown>();
      map.set(name, m);
    }
    m.set('type', type);
    m.set('value', value);
    m.set('order', order);
    if (input.description !== undefined) {
      if (input.description) m.set('description', input.description.slice(0, 300));
      else m.delete('description');
    }
  }, origin);
  return getVariables(doc).find((v) => v.name === name)!;
}

function lastOrder(map: Y.Map<Y.Map<unknown>>): string | null {
  let last: string | null = null;
  map.forEach((m) => {
    const o = m instanceof Y.Map ? m.get('order') : undefined;
    if (typeof o === 'string' && (last === null || o > last)) last = o;
  });
  return last;
}

export function deleteVariable(doc: BogenDoc, name: string, origin?: unknown): void {
  doc.transact(() => variablesMap(doc).delete(name), origin);
}

// Cleaning what is stored

function cleanValue(v: unknown): VariableValue | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return v.slice(0, MAX_TEXT);
  return undefined;
}

const TRANSITIONS = new Set<ProtoTransition>(['none', 'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down']);

function clampMs(ms: unknown, fallback: number): number {
  const n = Number(ms);
  return Number.isFinite(n) ? Math.max(0, Math.min(5000, Math.round(n))) : fallback;
}

export function cleanAction(a: unknown): ProtoAction | null {
  if (!a || typeof a !== 'object') return null;
  const r = a as Record<string, unknown>;
  const variable = typeof r.variable === 'string' && NAME.test(r.variable) ? r.variable : null;
  const target = typeof r.target === 'string' && ID.test(r.target) ? r.target : null;
  switch (r.type) {
    case 'set': {
      const value = cleanValue(r.value);
      return variable && value !== undefined ? { type: 'set', variable, value } : null;
    }
    case 'toggle': return variable ? { type: 'toggle', variable } : null;
    case 'increment': {
      const by = Number(r.by ?? 1);
      return variable ? { type: 'increment', variable, ...(Number.isFinite(by) && by !== 1 ? { by } : {}) } : null;
    }
    case 'show': case 'hide': case 'toggle-visibility': return target ? { type: r.type, target } : null;
    case 'set-variant': return target && typeof r.value === 'string' && r.value.length <= 200 ? { type: 'set-variant', target, value: r.value } : null;
    case 'navigate': {
      const to = typeof r.to === 'string' && ID.test(r.to) ? r.to : null;
      const transition = typeof r.transition === 'string' && TRANSITIONS.has(r.transition as ProtoTransition) ? r.transition as ProtoTransition : undefined;
      return to ? { type: 'navigate', to, ...(transition ? { transition } : {}), ...(r.duration !== undefined ? { duration: clampMs(r.duration, 300) } : {}) } : null;
    }
    case 'back': return { type: 'back' };
    default: return null;
  }
}

export function cleanCondition(c: unknown): ProtoCondition | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const r = c as Record<string, unknown>;
  if (typeof r.variable !== 'string' || !NAME.test(r.variable) || !CONDITION_OPS.includes(r.op as ConditionOp)) return undefined;
  const value = cleanValue(r.value);
  return { variable: r.variable, op: r.op as ConditionOp, ...(value !== undefined ? { value } : {}) };
}

/** The prototype part of a layer's `proto`, cleaned. */
export function readProtoState(proto: LayerProto | undefined): ProtoState {
  const p = (proto ?? {}) as LayerProto & Record<string, unknown>;
  const out: ProtoState = {};
  if (Array.isArray(p.interactions)) {
    const list: ProtoInteraction[] = [];
    for (const i of p.interactions.slice(0, MAX_INTERACTIONS) as unknown[]) {
      if (!i || typeof i !== 'object') continue;
      const trigger = (i as Record<string, unknown>).trigger;
      const actions = (i as Record<string, unknown>).actions;
      if (!PROTO_TRIGGERS.includes(trigger as ProtoTrigger) || !Array.isArray(actions)) continue;
      list.push({ trigger: trigger as ProtoTrigger, actions: actions.slice(0, MAX_ACTIONS).flatMap((a) => cleanAction(a) ?? []) });
    }
    if (list.length) out.interactions = list;
  }
  const showWhen = cleanCondition(p.showWhen);
  if (showWhen) out.showWhen = showWhen;
  const vf = p.variantFrom as Record<string, unknown> | undefined;
  if (vf && typeof vf.prop === 'string' && vf.prop.length <= 100 && typeof vf.variable === 'string' && NAME.test(vf.variable)) out.variantFrom = { prop: vf.prop, variable: vf.variable };
  if (typeof p.bind === 'string' && NAME.test(p.bind)) out.bind = p.bind;
  if (typeof p.textFrom === 'string' && NAME.test(p.textFrom)) out.textFrom = p.textFrom;
  return out;
}

export function hasProtoState(proto: LayerProto | undefined): boolean {
  return Object.keys(readProtoState(proto)).length > 0;
}

// The model a prototype runs on

export interface ProtoLayerModel {
  on?: Partial<Record<ProtoTrigger, ProtoAction[]>>;
  showWhen?: ProtoCondition;
  /** Stored hidden, and the display it has when shown. */
  hidden?: boolean;
  display?: string;
  /** An instance whose variant can change: the axis, its values, and the value it starts with. */
  variant?: { prop: string; values: string[]; initial: string; variable?: string; alts?: Record<string, string> };
  bind?: { variable: string; kind: 'checkbox' | 'number' | 'text' };
  textFrom?: string;
  /** Another variant of this instance, written out for the export. It shows when the state picks it. */
  altOf?: string;
}

export interface ProtoModel {
  variables: Record<string, { type: VariableType; value: VariableValue }>;
  screens: string[];
  start: string;
  layers: Record<string, ProtoLayerModel>;
}

function fieldKind(n: BogenNode): 'checkbox' | 'number' | 'text' {
  const type = (n.attrs?.type ?? '').toLowerCase();
  if (n.tag === 'input' && (type === 'checkbox' || type === 'radio')) return 'checkbox';
  if (n.tag === 'input' && (type === 'number' || type === 'range')) return 'number';
  return 'text';
}

/** Every artboard in the order preview mode goes through them, on every page. */
export function protoScreens(doc: BogenDoc): string[] {
  const out: string[] = [];
  for (const p of doc.getPages()) {
    const kids = doc.getChildren(p.id).filter((n) => !n.hidden);
    const boards = kids.filter((n) => n.artboard);
    for (const n of boards.length ? boards : kids.filter((k) => k.type === 'frame')) out.push(n.id);
  }
  return out;
}

/**
 * The prototype of some screens as plain data: variables with their starting values, and per layer
 * what it does. Links to artboards outside `screens` are left out.
 */
export function protoModel(doc: BogenDoc, screens: string[], start?: string): ProtoModel {
  const variables: ProtoModel['variables'] = {};
  for (const v of getVariables(doc)) variables[v.name] = { type: v.type, value: v.value };
  const layers: ProtoModel['layers'] = {};
  const isScreen = new Set(screens);
  const variantTargets = new Map<string, string | undefined>();
  const visibilityTargets = new Set<string>();
  const visit = (n: BogenNode) => {
    const state = readProtoState(n.proto);
    const entry: ProtoLayerModel = {};
    const on: Partial<Record<ProtoTrigger, ProtoAction[]>> = {};
    for (const i of state.interactions ?? []) {
      const actions = i.actions.filter((a) => a.type !== 'navigate' || isScreen.has(a.to));
      if (actions.length) (on[i.trigger] ??= []).push(...actions);
      for (const a of actions) {
        if (a.type === 'set-variant' && !variantTargets.has(a.target)) variantTargets.set(a.target, undefined);
        if (a.type === 'show' || a.type === 'hide' || a.type === 'toggle-visibility') visibilityTargets.add(a.target);
      }
    }
    // A plain link from before prototypes had state is a click that navigates.
    if (!on.click && n.proto?.link && isScreen.has(n.proto.link)) on.click = [{ type: 'navigate', to: n.proto.link, transition: n.proto.transition ?? 'fade', duration: clampMs(n.proto.duration, 300) }];
    if (Object.keys(on).length) entry.on = on;
    if (state.showWhen) {
      entry.showWhen = state.showWhen;
      visibilityTargets.add(n.id);
    }
    if (state.variantFrom) variantTargets.set(n.id, state.variantFrom.prop);
    if (state.bind && /^(input|textarea|select)$/.test(n.tag)) entry.bind = { variable: state.bind, kind: fieldKind(n) };
    if (state.textFrom && n.type === 'text') entry.textFrom = state.textFrom;
    if (Object.keys(entry).length) layers[n.id] = entry;
    for (const c of doc.getChildren(n.id)) visit(c);
  };
  for (const id of screens) {
    const n = doc.getNode(id);
    if (n) visit(n);
  }
  for (const id of visibilityTargets) {
    const n = doc.getNode(id);
    if (!n) continue;
    const entry = (layers[id] ??= {});
    if (n.hidden) entry.hidden = true;
    entry.display = n.style.display && n.style.display !== 'none' ? n.style.display : '';
  }
  for (const [id, wanted] of variantTargets) {
    const n = doc.getNode(id);
    const main = n?.instanceOf !== undefined ? doc.getNode(n.instanceOf) : undefined;
    const set = main?.component?.set;
    if (!n || !main || !set) continue;
    const axes = variantAxes(doc.source, set);
    const state = readProtoState(n.proto);
    const axis = axes.find((a) => a.axis === (wanted ?? state.variantFrom?.prop)) ?? axes.find((a) => a.values.length > 1) ?? axes[0];
    if (!axis) continue;
    const initial = main.component?.variant?.[axis.axis] ?? axis.values[0]!;
    const entry = (layers[id] ??= {});
    entry.variant = { prop: axis.axis, values: axis.values, initial, ...(state.variantFrom && state.variantFrom.prop === axis.axis ? { variable: state.variantFrom.variable } : {}) };
  }
  const first = start && isScreen.has(start) ? start : screens[0] ?? '';
  return { variables, screens, start: first, layers };
}

/**
 * The state machine. Self-contained on purpose: the export writes its source text into the page, so
 * it may use nothing from outside this function. Preview mode and tests call the same code.
 */
export function protoMachine() {
  type V = boolean | number | string;
  type Cond = { variable: string; op: string; value?: V };
  type Act = { type: string; variable?: string; value?: V; by?: number; target?: string; to?: string; transition?: string; duration?: number };
  type Layer = { on?: Record<string, Act[]>; showWhen?: Cond; hidden?: boolean; display?: string; altOf?: string; variant?: { prop: string; values: string[]; initial: string; variable?: string; alts?: Record<string, string> }; bind?: { variable: string; kind: string }; textFrom?: string };
  type Model = { variables: Record<string, { type: string; value: V }>; screens: string[]; start: string; layers: Record<string, Layer> };
  type State = { vars: Record<string, V>; visible: Record<string, boolean>; variants: Record<string, string>; screen: string; history: string[] };
  type Nav = { to: string; transition: string; duration: number; back?: boolean };

  function coerce(type: string, v: unknown): V {
    if (type === 'boolean') return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
    if (type === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      return isFinite(n) ? n : 0;
    }
    return v === undefined || v === null ? '' : String(v);
  }
  function holds(c: Cond, vars: Record<string, V>): boolean {
    const v = vars[c.variable];
    const w = c.value;
    switch (c.op) {
      case 'is': return w === undefined ? Boolean(v) : String(v) === String(w);
      case 'not': return w === undefined ? !v : String(v) !== String(w);
      case 'gt': return Number(v) > Number(w);
      case 'lt': return Number(v) < Number(w);
      case 'gte': return Number(v) >= Number(w);
      case 'lte': return Number(v) <= Number(w);
      case 'contains': return String(v ?? '').toLowerCase().indexOf(String(w ?? '').toLowerCase()) >= 0;
      case 'empty': return v === undefined || v === '' || v === 0 || v === false;
      case 'filled': return !(v === undefined || v === '' || v === 0 || v === false);
      default: return false;
    }
  }
  function init(model: Model, start?: string): State {
    const vars: Record<string, V> = {};
    for (const k in model.variables) vars[k] = model.variables[k]!.value;
    const screen = start && model.screens.indexOf(start) >= 0 ? start : model.start;
    return { vars, visible: {}, variants: {}, screen, history: [] };
  }
  function visible(model: Model, state: State, id: string): boolean {
    if (id in state.visible) return state.visible[id]!;
    const l = model.layers[id];
    if (l && l.showWhen) return holds(l.showWhen, state.vars);
    return !(l && l.hidden);
  }
  function variant(model: Model, state: State, id: string): string | undefined {
    const v = model.layers[id] && model.layers[id]!.variant;
    if (!v) return undefined;
    if (id in state.variants) return state.variants[id];
    if (v.variable !== undefined) {
      const value = String(state.vars[v.variable]);
      if (v.values.indexOf(value) >= 0) return value;
    }
    return v.initial;
  }
  /** The layer that answers a trigger: the first in the chain, from the one under the pointer outwards. */
  function handler(model: Model, chain: string[], trigger: string): string | null {
    for (const id of chain) {
      const l = model.layers[id];
      if (l && l.on && l.on[trigger] && l.on[trigger]!.length) return id;
    }
    return null;
  }
  function copy(state: State): State {
    return { vars: Object.assign({}, state.vars), visible: Object.assign({}, state.visible), variants: Object.assign({}, state.variants), screen: state.screen, history: state.history.slice() };
  }
  function run(model: Model, before: State, actions: Act[]): { state: State; nav: Nav | null } {
    const state = copy(before);
    let nav: Nav | null = null;
    for (const a of actions) {
      const type = a.variable && model.variables[a.variable] ? model.variables[a.variable]!.type : 'text';
      if (a.type === 'set' && a.variable && model.variables[a.variable]) state.vars[a.variable] = coerce(type, a.value);
      else if (a.type === 'toggle' && a.variable && model.variables[a.variable]) state.vars[a.variable] = type === 'number' ? (Number(state.vars[a.variable]) ? 0 : 1) : type === 'boolean' ? !state.vars[a.variable] : state.vars[a.variable] ? '' : 'on';
      else if (a.type === 'increment' && a.variable && type === 'number') state.vars[a.variable] = Number(state.vars[a.variable]) + (typeof a.by === 'number' ? a.by : 1);
      else if ((a.type === 'show' || a.type === 'hide' || a.type === 'toggle-visibility') && a.target) state.visible[a.target] = a.type === 'show' ? true : a.type === 'hide' ? false : !visible(model, state, a.target);
      else if (a.type === 'set-variant' && a.target && model.layers[a.target] && model.layers[a.target]!.variant && model.layers[a.target]!.variant!.values.indexOf(String(a.value)) >= 0) state.variants[a.target] = String(a.value);
      else if (a.type === 'navigate' && a.to && model.screens.indexOf(a.to) >= 0 && a.to !== state.screen) {
        state.history.push(state.screen);
        state.screen = a.to;
        nav = { to: a.to, transition: a.transition || 'fade', duration: typeof a.duration === 'number' ? a.duration : 300 };
      } else if (a.type === 'back' && state.history.length) {
        state.screen = state.history.pop()!;
        nav = { to: state.screen, transition: 'fade', duration: 200, back: true };
      }
    }
    return { state, nav };
  }
  /** One trigger on a layer and the layers around it. Hover is handled by `enter` and `leave`. */
  function dispatch(model: Model, state: State, chain: string[], trigger: 'click' | 'submit'): { state: State; nav: Nav | null; handled: string | null } {
    const id = handler(model, chain, trigger);
    if (!id) return { state, nav: null, handled: null };
    const out = run(model, state, model.layers[id]!.on![trigger]!);
    return { state: out.state, nav: out.nav, handled: id };
  }
  type Saved = { id: string; vars: Record<string, V | undefined>; visible: Record<string, boolean | undefined>; variants: Record<string, string | undefined> };
  /** The pointer came over a layer with hover actions. What they changed comes back on `leave`. */
  function enter(model: Model, state: State, id: string): { state: State; saved: Saved; nav: Nav | null } {
    const actions = (model.layers[id] && model.layers[id]!.on && model.layers[id]!.on!.hover) || [];
    const out = run(model, state, actions);
    const saved: Saved = { id, vars: {}, visible: {}, variants: {} };
    for (const k in out.state.vars) if (out.state.vars[k] !== state.vars[k]) saved.vars[k] = state.vars[k];
    for (const k in out.state.visible) if (out.state.visible[k] !== state.visible[k]) saved.visible[k] = state.visible[k];
    for (const k in out.state.variants) if (out.state.variants[k] !== state.variants[k]) saved.variants[k] = state.variants[k];
    return { state: out.state, saved, nav: out.nav };
  }
  function leave(state: State, saved: Saved): State {
    const next = copy(state);
    for (const k in saved.vars) { if (saved.vars[k] === undefined) delete next.vars[k]; else next.vars[k] = saved.vars[k]!; }
    for (const k in saved.visible) { if (saved.visible[k] === undefined) delete next.visible[k]; else next.visible[k] = saved.visible[k]!; }
    for (const k in saved.variants) { if (saved.variants[k] === undefined) delete next.variants[k]; else next.variants[k] = saved.variants[k]!; }
    return next;
  }
  /** A person typed into or ticked a bound field. */
  function field(model: Model, state: State, id: string, raw: unknown): State {
    const b = model.layers[id] && model.layers[id]!.bind;
    if (!b || !model.variables[b.variable]) return state;
    const next = copy(state);
    next.vars[b.variable] = coerce(model.variables[b.variable]!.type, raw);
    return next;
  }
  /** The text a layer bound with textFrom shows. */
  function text(model: Model, state: State, id: string): string | undefined {
    const l = model.layers[id];
    if (!l || !l.textFrom || !(l.textFrom in state.vars)) return undefined;
    return String(state.vars[l.textFrom]);
  }
  return { coerce, holds, init, visible, variant, handler, dispatch, enter, leave, field, text };
}

export type ProtoMachine = ReturnType<typeof protoMachine>;
export type ProtoRunState = ReturnType<ProtoMachine['init']>;

// Hover styles from before prototypes had state

const UNSAFE = /url\(|expression\s*\(|javascript:|@import|[;{}<>\\]/i;

/** Only what is safe in a style element survives; stored fields are never trusted. */
export function cleanHover(hover: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!hover || typeof hover !== 'object') return out;
  for (const [k, v] of Object.entries(hover as Record<string, unknown>)) {
    if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(k) && typeof v === 'string' && v && v.length <= 300 && !UNSAFE.test(v)) out[k] = v;
  }
  return out;
}

const PLAIN_ID = /^[\w-]+$/;

/** Real CSS for hover overrides and pointers on layers that do something: they have to beat inline styles, hence `!important`. */
export function protoInteractionCss(nodes: Iterable<BogenNode>, within = ''): string {
  const rules: string[] = [];
  for (const n of nodes) {
    if (!n.proto || !PLAIN_ID.test(n.id)) continue;
    const sel = `${within}[data-bogen-id="${n.id}"]`;
    const hover = cleanHover(n.proto.hover);
    const entries = Object.entries(hover);
    if (entries.length) {
      const ms = clampMs(n.proto.duration ?? 150, 300);
      rules.push(`${sel}{transition:${entries.map(([k]) => `${kebabCss(k)} ${ms}ms ease`).join(',')}}`);
      rules.push(`${sel}:hover{${entries.map(([k, v]) => `${kebabCss(k)}:${v} !important`).join(';')}}`);
    }
    if (n.proto.link || readProtoState(n.proto).interactions?.some((i) => i.trigger === 'click')) rules.push(`${sel}{cursor:pointer}`);
  }
  return rules.join('\n');
}

// Export

/**
 * Runs the machine on a page: shows one screen at a time, answers clicks, hovers, submits and typing,
 * and shows and hides layers as the state says. Self-contained for the same reason as `protoMachine`:
 * the export writes its source text. It reads and writes only this document, and asks no network.
 */
export function protoPlayer(model: ProtoModel, m: ProtoMachine): void {
  const doc = document;
  const els: Record<string, HTMLElement[]> = {};
  const index = () => {
    for (const k in els) delete els[k];
    doc.querySelectorAll<HTMLElement>('[data-bogen-id]').forEach((el) => {
      const id = el.getAttribute('data-bogen-id')!;
      (els[id] = els[id] || []).push(el);
    });
  };
  index();
  const fromHash = decodeURIComponent((location.hash || '').slice(1));
  let state = m.init(model, fromHash);
  let current: string | null = null;
  const chain = (start: EventTarget | null): string[] => {
    const out: string[] = [];
    let el = start instanceof Element ? start.closest('[data-bogen-id]') : null;
    while (el) {
      out.push(el.getAttribute('data-bogen-id')!);
      el = el.parentElement ? el.parentElement.closest('[data-bogen-id]') : null;
    }
    return out;
  };
  const show = (id: string, on: boolean) => {
    const l = model.layers[id];
    for (const el of els[id] || []) {
      el.classList.toggle('bgp-off', !on);
      if (on && l && l.hidden) el.style.display = l.display || '';
    }
  };
  const apply = (nav?: { to: string; transition: string; duration: number; back?: boolean } | null) => {
    for (const id in model.layers) {
      const l = model.layers[id]!;
      if (!l.altOf && (l.showWhen || l.hidden || id in state.visible)) show(id, m.visible(model, state, id));
    }
    for (const id in model.layers) {
      const l = model.layers[id]!;
      if (l.variant && l.variant.alts) {
        const value = m.variant(model, state, id);
        const on = m.visible(model, state, id);
        for (const v in l.variant.alts) show(l.variant.alts[v]!, v === value && on);
      }
      if (l.bind) {
        const value = state.vars[l.bind.variable];
        for (const el of els[id] || []) {
          const field = el as HTMLInputElement;
          if (l.bind.kind === 'checkbox') field.checked = Boolean(value);
          else if (doc.activeElement !== el && field.value !== String(value ?? '')) field.value = String(value ?? '');
        }
      }
      const text = m.text(model, state, id);
      if (text !== undefined) for (const el of els[id] || []) if (el.textContent !== text) el.textContent = text;
    }
    if (current !== state.screen) {
      for (const s of model.screens) if (s !== state.screen) for (const el of els[s] || []) el.classList.add('bgp-off');
      for (const el of els[state.screen] || []) {
        el.classList.remove('bgp-off');
        if (nav && nav.transition !== 'none' && nav.duration > 0) {
          const name = nav.back ? 'bgp-fade' : `bgp-${nav.transition}`;
          el.style.setProperty('--bgp-ms', `${nav.duration}ms`);
          el.classList.remove('bgp-enter');
          void el.offsetWidth;
          el.setAttribute('data-bgp-anim', name);
          el.classList.add('bgp-enter');
        }
      }
      current = state.screen;
      try { history.replaceState(null, '', `#${encodeURIComponent(state.screen)}`); } catch { /* A file opened from disk may refuse it. */ }
      scrollTo(0, 0);
    }
    doc.documentElement.setAttribute('data-bgp-screen', state.screen);
  };
  doc.addEventListener('click', (e) => {
    const out = m.dispatch(model, state, chain(e.target), 'click');
    if (!out.handled) return;
    const target = e.target instanceof Element ? e.target.closest('a,button') : null;
    if (target) e.preventDefault();
    state = out.state;
    apply(out.nav);
  });
  doc.addEventListener('submit', (e) => {
    // Nothing ever leaves this page: a form only runs its prototype.
    e.preventDefault();
    const out = m.dispatch(model, state, chain(e.target), 'submit');
    state = out.state;
    apply(out.nav);
  });
  const onField = (e: Event) => {
    const el = e.target instanceof HTMLElement ? e.target.closest('[data-bogen-id]') : null;
    const id = el && el.getAttribute('data-bogen-id');
    if (!id || !model.layers[id] || !model.layers[id]!.bind) return;
    const field = el as HTMLInputElement;
    state = m.field(model, state, id, model.layers[id]!.bind!.kind === 'checkbox' ? field.checked : field.value);
    apply(null);
  };
  doc.addEventListener('input', onField);
  doc.addEventListener('change', onField);
  for (const id in model.layers) {
    if (!model.layers[id]!.on || !model.layers[id]!.on!.hover) continue;
    for (const el of els[id] || []) {
      let saved: ReturnType<ProtoMachine['enter']>['saved'] | null = null;
      el.addEventListener('mouseenter', () => {
        const out = m.enter(model, state, id);
        saved = out.saved;
        state = out.state;
        apply(out.nav);
      });
      el.addEventListener('mouseleave', () => {
        if (!saved) return;
        state = m.leave(state, saved);
        saved = null;
        apply(null);
      });
    }
  }
  apply(null);
  doc.documentElement.classList.add('bgp-ready');
}

/** The CSS a prototype page needs: one screen at a time, centred, and the screen transitions. */
function playerCss(model: ProtoModel): string {
  const screens = model.screens.filter((s) => PLAIN_ID.test(s));
  const all = screens.map((s) => `[data-bogen-id="${s}"]`).join(',');
  const later = screens.filter((s) => s !== model.start).map((s) => `html:not(.bgp-ready) [data-bogen-id="${s}"]`).join(',');
  return [
    'html,body{min-height:100%}',
    all ? `${all}{position:relative!important;left:auto!important;top:auto!important;margin-left:auto!important;margin-right:auto!important}` : '',
    later ? `${later}{display:none!important}` : '',
    '.bgp-off{display:none!important}',
    '@keyframes bgp-fade{from{opacity:0}}@keyframes bgp-slide-left{from{transform:translateX(40px);opacity:0}}@keyframes bgp-slide-right{from{transform:translateX(-40px);opacity:0}}@keyframes bgp-slide-up{from{transform:translateY(40px);opacity:0}}@keyframes bgp-slide-down{from{transform:translateY(-40px);opacity:0}}',
    '@media (prefers-reduced-motion: no-preference){.bgp-enter{animation:var(--bgp-anim-name,bgp-fade) var(--bgp-ms,300ms) cubic-bezier(.2,.8,.2,1) both}' + ['fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down'].map((t) => `.bgp-enter[data-bgp-anim="bgp-${t}"]{--bgp-anim-name:bgp-${t}}`).join('') + '}',
  ].filter(Boolean).join('\n');
}

/** The one script a prototype page carries, as text. */
export function protoScript(model: ProtoModel): string {
  // JSON can hold `</script>` and line separators, which would end the element or a line early.
  const data = JSON.stringify(model).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  // Build tools name functions through a helper; the page has none, so it gets one that does nothing.
  return `(function(){"use strict";var __name=function(f){return f};var run=function(){(${protoPlayer.toString()})(${data},(${protoMachine.toString()})())};if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",run);else run()})();`;
}

/** No network for the page's script, no form that posts anywhere, nothing that loads code. */
export const PROTOTYPE_CSP = "connect-src 'none'; form-action 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; base-uri 'none'; manifest-src 'none'";

/** A plain copy of a document that can be changed freely without touching the original. */
function scratchCopy(doc: BogenDoc): BogenDoc {
  const y = new Y.Doc();
  Y.applyUpdate(y, Y.encodeStateAsUpdate(doc.y));
  return new BogenDoc(y);
}

/** The screens a prototype of these roots needs: the roots, and every artboard they lead to. */
export function protoReach(doc: BogenDoc, roots: string[]): string[] {
  const all = new Set(protoScreens(doc));
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = roots.filter((r) => doc.getNode(r));
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const visit = (n: BogenNode) => {
      const targets = [n.proto?.link, ...(readProtoState(n.proto).interactions ?? []).flatMap((i) => i.actions.map((a) => (a.type === 'navigate' ? a.to : undefined)))];
      for (const t of targets) if (t && all.has(t) && !seen.has(t)) queue.push(t);
      for (const c of doc.getChildren(n.id)) visit(c);
    };
    const node = doc.getNode(id);
    if (node) visit(node);
  }
  return out;
}

export interface PrototypeExport { html: string; model: ProtoModel; script: string }

/**
 * A static, clickable HTML file of a prototype: the screens, everything the prototype can show,
 * and one small self-contained script. Instances whose variant can change are written once per
 * variant, and the script shows the one the state picks.
 */
export function exportPrototype(doc: BogenDoc, roots: string[], options: Omit<HtmlOptions, 'ids'> & { title?: string; extraHead?: string; background?: string; start?: string } = {}): PrototypeExport {
  const copy = scratchCopy(doc);
  const screens = protoReach(copy, roots);
  if (!screens.length) throw new Error('Nothing to export: give an artboard of this file.');
  const base = protoModel(copy, screens, options.start);
  // Every other value of a variant that can change is an instance of its own, next to the first one.
  copy.transact(() => {
    for (const [id, layer] of Object.entries(base.layers)) {
      if (!layer.variant || id.includes('/')) continue;
      const node = copy.getNode(id);
      if (!node) continue;
      const alts: Record<string, string> = { [layer.variant.initial]: id };
      const siblings = copy.getChildren(node.parent);
      let at = siblings.findIndex((s) => s.id === id) + 1;
      for (const value of layer.variant.values) {
        if (value === layer.variant.initial) continue;
        const spec = copy.toSpec(id);
        const alt = copy.insert(node.parent, { ...spec, name: `${node.name} (${value})` }, at++);
        setInstanceProps(copy, alt, { [layer.variant.prop]: value });
        copy.updateFields(alt, { hidden: true });
        alts[value] = alt;
      }
      layer.variant.alts = alts;
    }
  });
  const model = protoModel(copy, screens, options.start);
  for (const [id, layer] of Object.entries(base.layers)) {
    const v = model.layers[id]?.variant ?? layer.variant;
    if (v && layer.variant?.alts) (model.layers[id] ??= {}).variant = { ...v, alts: layer.variant.alts };
    for (const alt of Object.values(layer.variant?.alts ?? {})) {
      if (alt === id) continue;
      const own = copy.getNode(alt)?.style.display;
      model.layers[alt] = { ...model.layers[alt], hidden: true, display: own && own !== 'none' ? own : '', altOf: id };
      delete model.layers[alt]!.variant;
    }
  }
  const nodes: BogenNode[] = [];
  for (const s of screens) {
    const n = copy.getNode(s);
    if (n) nodes.push(n, ...copy.descendants(s));
  }
  const script = protoScript(model);
  const head = [
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta http-equiv="Content-Security-Policy" content="${PROTOTYPE_CSP}">`,
    `<style>${playerCss(model)}\n${protoInteractionCss(nodes)}</style>`,
    options.extraHead ?? '',
    `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`,
  ].join('');
  const html = exportDocument(copy, screens, { ...options, ids: true, extraHead: head, title: options.title ?? 'Prototype' });
  copy.y.destroy();
  return { html, model, script };
}
