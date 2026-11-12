import * as Y from 'yjs';
import { kebabCss } from './css.ts';

/**
 * Pseudo-elements and conditional styles of a layer: `::before` and `::after`, and style that applies
 * only under a condition, such as `@container (max-width: 560px)`, `@media (max-width: 760px)` or
 * `:hover`. A layer's own style stays its inline style; these are what an inline style cannot say.
 *
 * Stored on the layer's map as `rules`: one flat map of `<block>#<property>` to a value, the shape
 * overrides have, so that two people changing different blocks, or different properties of one
 * block, merge. A block key reads like CSS, at-rule first, then a state, then a pseudo-element:
 *
 *   ::before
 *   :hover
 *   parent[open]::after
 *   @container (max-width: 560px) ::after
 *   @media (max-width: 760px) :hover
 *
 * Every piece of a block comes from a short list or passes a strict check, and the selector is
 * always made here from the layer's own id, so stored rules cannot reach past their layer.
 */

/** Property name (camelCase, or a custom property) to value. */
export type RuleStyle = Record<string, string>;
/** Block key to its declarations. */
export type LayerRules = Record<string, RuleStyle>;

export const PSEUDO_ELEMENTS = ['::before', '::after', '::marker', '::placeholder', '::selection', '::first-letter', '::first-line'] as const;
export type PseudoElement = (typeof PSEUDO_ELEMENTS)[number];
/** States a block can depend on. `[open]` is a details element that is open. */
export const RULE_STATES = [':hover', ':focus', ':focus-visible', ':focus-within', ':active', '[open]'] as const;
export type RuleState = (typeof RULE_STATES)[number];
/** States that need a pointer or a keyboard. The canvas leaves these out outside preview mode. */
export const POINTER_STATES = new Set<string>([':hover', ':focus', ':focus-visible', ':focus-within', ':active']);

export interface RuleAt { kind: 'media' | 'container'; name?: string; query: string }
export interface RuleBlock {
  key: string;
  at?: RuleAt;
  state?: { name: RuleState; parent: boolean };
  pseudo?: PseudoElement;
}

const MAX_QUERY = 300;
const MAX_VALUE = 2000;
const NAME = /^[a-zA-Z_][\w-]*$/;
const RESERVED_NAMES = new Set(['not', 'and', 'or', 'none', 'only']);
// Media and container queries: features, numbers, units, ratios, ranges and var() of a token.
const QUERY_CHARS = /^[\w\s().,:<>=/+*%-]+$/;

function balanced(text: string): boolean {
  let depth = 0;
  for (const c of text) {
    if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** The same query however it was spaced, so that one condition is one block. */
function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*:\s*/g, ': ').replace(/\s*,\s*/g, ', ');
}

function parseAt(text: string): RuleAt | null {
  const m = /^@(media|container)\b\s*(.*)$/is.exec(text.trim());
  if (!m) return null;
  const kind = m[1]!.toLowerCase() as RuleAt['kind'];
  let rest = m[2]!.trim();
  let name: string | undefined;
  if (kind === 'container') {
    const named = /^([a-zA-Z_][\w-]*)\s+(?=\(|not\b)/.exec(rest);
    if (named && !RESERVED_NAMES.has(named[1]!.toLowerCase())) {
      name = named[1]!;
      rest = rest.slice(named[0].length);
    }
  }
  const query = normalizeQuery(rest);
  if (!query || query.length > MAX_QUERY || !QUERY_CHARS.test(query) || !balanced(query) || /<\/|<!/.test(query)) return null;
  // A container query is always about a feature; a media query can also be a media type such as print.
  if (kind === 'container' && !query.includes('(')) return null;
  return { kind, ...(name ? { name } : {}), query };
}

function atText(at: RuleAt): string {
  return `@${at.kind} ${at.name ? `${at.name} ` : ''}${at.query}`;
}

/** The key of a block, from its parts. */
export function blockKeyOf(block: Omit<RuleBlock, 'key'>): string {
  const state = block.state ? `${block.state.parent ? 'parent' : ''}${block.state.name}` : '';
  const tail = `${state}${block.pseudo ?? ''}`;
  return [block.at ? atText(block.at) : '', tail].filter(Boolean).join(' ');
}

const blockCache = new Map<string, RuleBlock | null>();

/**
 * Reads a block key or a `when` as people write it: `::before`, `:hover`, `parent[open]::after`,
 * `@container card (max-width: 560px) ::after`. Null when it is not one this model knows.
 */
export function parseBlock(text: string): RuleBlock | null {
  const cached = blockCache.get(text);
  if (cached !== undefined) return cached;
  const block = parseBlockText(text);
  if (blockCache.size > 5000) blockCache.clear();
  blockCache.set(text, block);
  return block;
}

function parseBlockText(text: string): RuleBlock | null {
  let rest = text.trim();
  if (!rest || rest.length > MAX_QUERY + 60) return null;
  const parts: Omit<RuleBlock, 'key'> = {};
  const pseudo = /::?([a-z-]+)$/.exec(rest);
  if (pseudo && (pseudo[0].startsWith('::') || pseudo[1] === 'before' || pseudo[1] === 'after')) {
    const name = `::${pseudo[1]}` as PseudoElement;
    if (PSEUDO_ELEMENTS.includes(name)) {
      parts.pseudo = name;
      rest = rest.slice(0, -pseudo[0].length).trimEnd();
    } else if (pseudo[0].startsWith('::')) return null;
  }
  const state = /(?:^|[\s)])(parent)?(:[a-z-]+|\[open\])$/.exec(rest);
  if (state) {
    const name = state[2] as RuleState;
    if (!RULE_STATES.includes(name)) return null;
    parts.state = { name, parent: Boolean(state[1]) };
    rest = rest.slice(0, rest.length - state[2]!.length - (state[1]?.length ?? 0)).trimEnd();
  }
  if (rest) {
    const at = parseAt(rest);
    if (!at) return null;
    parts.at = at;
  }
  if (!parts.at && !parts.state && !parts.pseudo) return null;
  return { key: blockKeyOf(parts), ...parts };
}

/** A block key from the `when` and `pseudo` a tool or a person gives, or an error that says why not. */
export function blockKey(when: string | undefined, pseudo: string | undefined): { key: string } | { error: string } {
  const p = pseudo?.trim() ? (pseudo.trim().startsWith(':') ? pseudo.trim().replace(/^:(?!:)/, '::') : `::${pseudo.trim()}`) : '';
  if (p && !PSEUDO_ELEMENTS.includes(p as PseudoElement)) return { error: `${pseudo} is not a pseudo-element Bogen keeps. Use one of ${PSEUDO_ELEMENTS.join(', ')}.` };
  const w = when?.trim() ?? '';
  if (!w && !p) return { error: 'Give a pseudo-element, a condition, or both. Without them it is the layer\'s own style: leave out pseudo and when.' };
  if (w && /::/.test(w)) return { error: 'Put the pseudo-element in pseudo, not in when.' };
  const block = parseBlock([w, p].filter(Boolean).join(' '));
  if (!block) {
    return { error: `"${w}" is not a condition Bogen can store. Use @media (…), @container [name] (…), a state (${RULE_STATES.join(', ')}), parent plus a state such as parent:hover or parent[open], or an at-rule followed by a state. Queries may use features, numbers, units, ranges such as (width < 560px) and var(--a-breakpoint-token).` };
  }
  return { key: block.key };
}

const PROP = /^(?:--[a-zA-Z0-9_-]+|-?[a-zA-Z][a-zA-Z0-9]*)$/;

/**
 * A declaration value that is safe to place in a style element, or null. These rules leave the
 * layer's inline style behind, so a value must not be able to end its block, open another, or close
 * the style element; beyond that it is held to what an inline style may hold.
 */
export function cleanRuleValue(value: string): string | null {
  const v = value.replace(/[\r\n\f]+/g, ' ').replace(/\s*!important\s*$/i, '').trim();
  if (!v || v.length > MAX_VALUE) return null;
  if (/<\/|<!|-->|expression\s*\(|javascript:|@import/i.test(v)) return null;
  let quote = '';
  let depth = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c === '\\') {
      // An escape at the very end would swallow what follows the value.
      if (i === v.length - 1) return null;
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return null;
    else if (c === '{' || c === '}' || (c === ';' && depth === 0)) return null;
  }
  return quote || depth ? null : v;
}

export function cleanRuleProp(prop: string): string | null {
  return PROP.test(prop) && prop !== '__proto__' ? prop : null;
}

/** Declarations of one block that pass the checks above, in a stable order. */
export function cleanRuleStyle(style: RuleStyle): RuleStyle {
  const out: RuleStyle = {};
  for (const key of Object.keys(style).sort()) {
    const prop = cleanRuleProp(key);
    const value = typeof style[key] === 'string' ? cleanRuleValue(style[key]) : null;
    if (prop && value) out[prop] = value;
  }
  return out;
}

// Storage

/** `<block>#<property>`. A block never contains `#`, so the last one splits them. */
export function ruleField(block: string, prop: string): string {
  return `${block}#${prop}`;
}

export function splitRuleField(field: string): { block: string; prop: string } | null {
  const at = field.lastIndexOf('#');
  if (at <= 0 || at === field.length - 1) return null;
  return { block: field.slice(0, at), prop: field.slice(at + 1) };
}

/** Rules of a layer from what is stored: a flat Y.Map or a plain object of the same shape. Only strings are kept. */
export function readRules(v: unknown): LayerRules | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: LayerRules = {};
  const add = (value: unknown, field: string) => {
    if (typeof value !== 'string' || !value) return;
    const split = splitRuleField(field);
    if (!split || split.prop === '__proto__' || split.block === '__proto__') return;
    (out[split.block] ??= {})[split.prop] = value;
  };
  if (v instanceof Y.Map) v.forEach(add);
  else if (!Array.isArray(v)) for (const [field, value] of Object.entries(v)) add(value, field);
  return Object.keys(out).length ? out : undefined;
}

/** Rules in their nested form, block to declarations, from data that arrived from elsewhere. Only strings are kept. */
export function readNestedRules(v: unknown): LayerRules | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: LayerRules = {};
  for (const [block, style] of Object.entries(v)) {
    if (block === '__proto__' || !style || typeof style !== 'object' || Array.isArray(style)) continue;
    for (const [prop, value] of Object.entries(style)) if (typeof value === 'string' && value && prop !== '__proto__') (out[block] ??= {})[prop] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The flat form of nested rules, as stored. */
export function flattenRules(rules: LayerRules): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [block, style] of Object.entries(rules)) for (const [prop, value] of Object.entries(style)) out[ruleField(block, prop)] = value;
  return out;
}

/** Blocks that parse, under their canonical keys. Two spellings of one condition become one block. */
export function normalizeRules(rules: LayerRules | undefined): LayerRules | undefined {
  if (!rules) return undefined;
  const out: LayerRules = {};
  for (const [key, style] of Object.entries(rules)) {
    const block = parseBlock(key);
    if (!block || !style || typeof style !== 'object') continue;
    Object.assign((out[block.key] ??= {}), style);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Merges a patch into one block of a layer's stored rules. Null or '' removes a property. The map is
 * made on first use, so two devices that both give an old layer its first rule while apart keep only
 * one side's map; after that every block and property merges on its own.
 */
export function patchRules(m: Y.Map<unknown>, block: string, patch: Record<string, string | null>): void {
  let map = m.get('rules');
  if (!(map instanceof Y.Map)) {
    map = new Y.Map<string>();
    m.set('rules', map);
  }
  const rules = map as Y.Map<string>;
  for (const [prop, value] of Object.entries(patch)) {
    const key = ruleField(block, prop);
    if (value === null || value === '') {
      if (rules.has(key)) rules.delete(key);
    } else if (rules.get(key) !== value) rules.set(key, value);
  }
}

/** Removes a whole block. */
export function deleteRuleBlock(m: Y.Map<unknown>, block: string): void {
  const map = m.get('rules');
  if (!(map instanceof Y.Map)) return;
  for (const key of [...map.keys()]) if (splitRuleField(key)?.block === block) map.delete(key);
}

export function rulesToYMap(rules: LayerRules): Y.Map<string> {
  const map = new Y.Map<string>();
  for (const [field, value] of Object.entries(flattenRules(rules))) map.set(field, value);
  return map;
}

// Reading conditions

const PX_PER_EM = 16;

function lengthPx(text: string): number | undefined {
  const m = /^(-?\d*\.?\d+)(px|em|rem)?$/.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === 'em' || m[2] === 'rem' ? n * PX_PER_EM : n;
}

/** Each comma-separated part of a media query, without `only`, `screen and` or `all and`, or null for a part about something else. */
function widthParts(query: string): string[][] | null {
  const out: string[][] = [];
  for (const raw of query.split(',')) {
    let part = raw.trim().replace(/^only\s+/i, '');
    part = part.replace(/^(screen|all)\s+and\s+/i, '');
    const features = part.split(/\s+and\s+/i).map((f) => f.trim());
    if (!features.length || !features.every((f) => /^\((?:(?:min-|max-)?width\s*:[^()]+|[^():]*\bwidth\b[^():]*)\)$/i.test(f) && !/height|aspect|orientation|device/i.test(f))) return null;
    out.push(features);
  }
  return out.length ? out : null;
}

/** A media query about the width only, as a container condition, or null. */
export function widthMediaAsContainer(query: string): string | null {
  const parts = widthParts(query);
  if (!parts) return null;
  const conditions = parts.map((features) => (features.length === 1 ? features[0]! : `(${features.join(' and ')})`));
  return conditions.length === 1 ? conditions[0]! : conditions.map((c) => (c.startsWith('((') ? c : `(${c})`)).join(' or ');
}

/** Whether a width-only media query holds at a width, or undefined when it cannot be told without a browser. */
export function evalWidthMedia(query: string, width: number): boolean | undefined {
  const parts = widthParts(query);
  if (!parts) return undefined;
  let any = false;
  for (const features of parts) {
    let all = true;
    for (const f of features) {
      const inner = f.slice(1, -1).trim();
      const plain = /^(min-|max-)?width\s*:\s*(.+)$/i.exec(inner);
      let holds: boolean | undefined;
      if (plain) {
        const n = lengthPx(plain[2]!);
        if (n === undefined) return undefined;
        holds = plain[1]?.toLowerCase() === 'min-' ? width >= n : plain[1]?.toLowerCase() === 'max-' ? width <= n : width === n;
      } else {
        const range = /^width\s*(<=|>=|<|>|=)\s*(.+)$/i.exec(inner) ?? /^(.+?)\s*(<=|>=|<|>|=)\s*width$/i.exec(inner);
        if (!range) return undefined;
        const flipped = !/^width/i.test(inner);
        const n = lengthPx(flipped ? range[1]! : range[2]!);
        if (n === undefined) return undefined;
        const op = flipped ? ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=' } as Record<string, string>)[range[2]!]! : range[1]!;
        holds = op === '<' ? width < n : op === '>' ? width > n : op === '<=' ? width <= n : op === '>=' ? width >= n : width === n;
      }
      if (!holds) all = false;
    }
    if (all) any = true;
  }
  return any;
}

/** `dark` or `light` for a media query that only asks for a colour scheme. */
export function colorSchemeOf(query: string): 'dark' | 'light' | null {
  const m = /^(?:(?:only\s+)?(?:screen|all)\s+and\s+)?\(prefers-color-scheme:\s*(dark|light)\)$/i.exec(query.trim());
  return m ? (m[1]!.toLowerCase() as 'dark' | 'light') : null;
}

/** The widths a block depends on, for ordering: wider `max-width` first, narrower `min-width` first. */
function orderOf(block: RuleBlock): [number, number, string] {
  const group = (block.at ? 1 : 0) + (block.state ? 2 : 0);
  let n = 0;
  if (block.at) {
    const max = /max-width\s*:\s*([\d.]+(?:px|em|rem)?)|width\s*<=?\s*([\d.]+(?:px|em|rem)?)/i.exec(block.at.query);
    const min = /min-width\s*:\s*([\d.]+(?:px|em|rem)?)|width\s*>=?\s*([\d.]+(?:px|em|rem)?)/i.exec(block.at.query);
    if (max) n = -(lengthPx(max[1] ?? max[2]!) ?? 0);
    else if (min) n = lengthPx(min[1] ?? min[2]!) ?? 0;
  }
  return [group, n, block.key];
}

/** Blocks in the order their CSS is written: plain pseudo-elements first, then conditions, the narrower one later so that it wins. */
export function orderedBlocks(rules: LayerRules): RuleBlock[] {
  const blocks = Object.keys(rules).flatMap((k) => parseBlock(k) ?? []);
  return blocks.sort((a, b) => {
    const x = orderOf(a);
    const y = orderOf(b);
    return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
  });
}

// Writing CSS

/** The class that carries a layer's rules. Ids come from peers too, so anything unusual is replaced. */
export function ruleScopeClass(id: string): string {
  return `bgn-${id.replace(/[^a-zA-Z0-9_-]/g, (c) => (c === '/' ? '_' : `-${c.charCodeAt(0).toString(16)}-`))}`;
}

/** The name an artboard's container has on the canvas and in screenshots, for media queries. */
export const ARTBOARD_CONTAINER = 'bogen-artboard';

export interface RulesCssOptions {
  /**
   * How media queries are read. `viewport` (exports, code) writes them as they are. `artboard` (canvas,
   * screenshots, video) reads width queries against the artboard, as a container query on it, and a
   * colour scheme query against the theme mode the layer is in, so that what an artboard shows does
   * not depend on the window it is seen in.
   */
  media?: 'viewport' | 'artboard';
  /** For `artboard`: the artboard the layer is in, with its own style, and whether it is the layer itself. */
  artboard?: { id: string; style: Record<string, string>; self: boolean };
  /** Goes before every selector, such as `.bogen-world `. */
  within?: string;
  /** Pointer and focus states: true everywhere (default), false never, or only inside this selector. */
  states?: boolean | string;
  /** Values of tokens, for `var(--name)` in a query, which CSS itself does not allow there. */
  token?: (name: string) => string | undefined;
}

const DEFINITE_WIDTH = /^-?[\d.]+(px|rem|em|vw|%)$/;

/** Whether an artboard's width stands on its own, so that it can be a container without collapsing. */
export function hasOwnWidth(style: Record<string, string>): boolean {
  return DEFINITE_WIDTH.test((style.width ?? '').trim());
}

/** The rule that makes an artboard a container for media queries, keeping its own container names. */
export function artboardContainerCss(id: string, style: Record<string, string>, within = ''): string {
  if (!/^[\w/:-]+$/.test(id) || !hasOwnWidth(style)) return '';
  const own = (style.containerName ?? '').split(/\s+/).filter((n) => NAME.test(n) && n !== ARTBOARD_CONTAINER && !RESERVED_NAMES.has(n));
  const type = /^(size|inline-size)$/.test((style.containerType ?? '').trim()) ? style.containerType!.trim() : 'inline-size';
  return `${within}[data-bogen-id="${id}"]{container-name:${[...own, ARTBOARD_CONTAINER].join(' ')} !important;container-type:${type} !important}`;
}

function resolveQuery(query: string, token: RulesCssOptions['token']): string | null {
  let missing = false;
  const out = query.replace(/var\(\s*--([\w-]+)\s*\)/g, (_, name: string) => {
    const value = token?.(name)?.trim();
    if (!value || !/^-?[\d.]+[a-z%]*$/i.test(value)) {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? null : out;
}

/**
 * The style sheet of one layer's rules. The one function every place that turns layers into HTML
 * uses: the canvas, screenshots, exports and code.
 */
export function layerRulesCss(id: string, rules: LayerRules | undefined, options: RulesCssOptions = {}): string {
  if (!rules) return '';
  const out: string[] = [];
  const scope = `.${ruleScopeClass(id)}`;
  const within = options.within ?? '';
  let container = false;
  for (const block of orderedBlocks(rules)) {
    const style = cleanRuleStyle(rules[block.key] ?? {});
    const entries = Object.entries(style);
    if (!entries.length) continue;
    const pointer = block.state ? POINTER_STATES.has(block.state.name) : false;
    if (pointer && options.states === false) continue;
    const prefix = pointer && typeof options.states === 'string' ? `${options.states} ` : within;
    let self = scope;
    let at = block.at ? { ...block.at } : undefined;
    if (at) {
      const query = resolveQuery(at.query, options.token);
      if (query === null) continue;
      at.query = query;
    }
    if (at?.kind === 'media' && options.media === 'artboard') {
      const scheme = colorSchemeOf(at.query);
      const asContainer = widthMediaAsContainer(at.query);
      if (scheme) {
        self += scheme === 'dark' ? ':where([data-mode="dark"], [data-mode="dark"] *)' : ':not([data-mode="dark"], [data-mode="dark"] *)';
        at = undefined;
      } else if (asContainer && options.artboard?.self) {
        // A container query cannot ask about the element itself, so the artboard's own blocks are read against its width.
        const width = lengthPx(options.artboard.style.width ?? '');
        const holds = width === undefined ? undefined : evalWidthMedia(at.query, width);
        if (!holds) continue;
        at = undefined;
      } else if (asContainer && options.artboard) {
        at = { kind: 'container', name: ARTBOARD_CONTAINER, query: asContainer };
        container = true;
      }
    }
    let selector: string;
    if (block.state?.parent) selector = `${prefix}${block.state.name === '[open]' ? '[open]' : `*${block.state.name}`} > ${self}`;
    else selector = `${prefix}${self}${block.state ? block.state.name : ''}`;
    if (block.pseudo) selector += block.pseudo;
    // Conditions have to beat the layer's inline style, which is where its own style lives.
    const important = block.at || block.state ? ' !important' : '';
    const body = `${selector}{${entries.map(([k, v]) => `${kebabCss(k)}:${v}${important}`).join(';')}}`;
    out.push(at ? `@${at.kind} ${at.name ? `${at.name} ` : ''}${at.query}{${body}}` : body);
  }
  if (container && options.artboard && !options.artboard.self) {
    const rule = artboardContainerCss(options.artboard.id, options.artboard.style, within);
    if (rule) out.unshift(rule);
  }
  const css = out.join('\n');
  // Everything above was checked piece by piece; this is the last line against closing the style element.
  return /<\/|<!/.test(css) ? '' : css;
}

/** Colours, fonts and other values inside a layer's rules, for checks that read styles. */
export function ruleValues(rules: LayerRules | undefined): { block: string; prop: string; value: string }[] {
  if (!rules) return [];
  return Object.entries(rules).flatMap(([block, style]) => Object.entries(style).map(([prop, value]) => ({ block, prop, value })));
}

/** One line per block, such as `::before {content:"+"; font-size:1.25rem}`, for outlines. */
export function rulesSummary(rules: LayerRules | undefined, max = 4): string[] {
  if (!rules) return [];
  const blocks = orderedBlocks(rules);
  const lines = blocks.slice(0, max).map((b) => {
    const decls = Object.entries(rules[b.key] ?? {});
    const text = decls.slice(0, 4).map(([k, v]) => `${kebabCss(k)}:${v.length > 30 ? `${v.slice(0, 30)}…` : v}`).join('; ');
    return `${b.key} {${text}${decls.length > 4 ? `; +${decls.length - 4}` : ''}}`;
  });
  if (blocks.length > max) lines.push(`+${blocks.length - max} more blocks`);
  return lines;
}
