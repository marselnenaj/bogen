import { parseDocument } from 'htmlparser2';
import { isTag, isText, type ChildNode, type Element } from 'domhandler';
import { kebabCss, parseStyle } from './css.ts';
import { getModes, getTextStyles, type TextStyle } from './design-system.ts';
import type { BogenDoc, BogenNode, Token } from './doc.ts';
import { sanitizeSvgMarkup } from './html-import.ts';
import { getVariables, readProtoState, type FileVariable, type ProtoAction, type ProtoCondition } from './prototype.ts';
import { textRuns } from './rich-text.ts';
import { EXACT_ENUMS, EXACT_LENGTHS, EXACT_NUMERIC, EXACT_PROP_TYPES, EXACT_PROPS, EXACT_STYLES, EXACT_TAGS } from './exact-vocab.ts';

/**
 * Experimental: a layer as an Exact app (https://github.com/expo/exact), whose interface language is Contract. The
 * view tree comes from the layers, their CSS becomes Contract's style attributes (which are CSS's own names), the
 * file's tokens an `app.tamber` design, its text styles Contract `style` blocks, and simple prototype interactions
 * state and actions. What Contract cannot say is left out where it would be, with a comment there and an entry in
 * `dropped`, never silently.
 *
 * Exact is pre-1.0 and changes daily, so this is written against one commit of it, EXACT_COMMIT, and its
 * vocabulary (exact-vocab.ts). The output is the user's.
 */

/** The commit of github.com/expo/exact that this export was written and checked against. */
export const EXACT_COMMIT = '57c86055b5c4c41ef7db310fdaf63bc7900963a7';
export const EXACT_COMMIT_DATE = '2026-11-10';

/** Something of the design that the app does not have, or has only approximately. */
export interface ExactDrop {
  layer: string;
  name: string;
  /** A CSS property in kebab case, or what kind of thing it was, such as `::before` or `interaction`. */
  what: string;
  value?: string;
  reason: string;
  /** Written in a nearby form rather than left out. */
  approximated?: boolean;
}

/** A picture the app needs under `assets/`: the export copies `src` (a `bogen-asset:` name or a `data:` URL) to `path`. */
export interface ExactAsset { path: string; src: string }

export interface ExactApp {
  /** A folder name for the app: lowercase and hyphenated, as `exact new` wants. */
  name: string;
  title: string;
  /** Text files by path: app.contract, app.ts, app.json, app.test.contract and, when the design uses tokens, app.tamber. */
  files: Record<string, string>;
  assets: ExactAsset[];
  dropped: ExactDrop[];
  notes: string[];
  commit: string;
}

const CONTRACT_RESERVED = new Set(['when', 'if', 'else', 'for', 'in', 'match', 'case', 'as', 'fn', 'and', 'or', 'not', 'true', 'false', 'none', 'some',
  'component', 'font', 'shape', 'style', 'from', 'state', 'derive', 'resource', 'mutation', 'action', 'task', 'mount', 'view', 'props', 'provide', 'inject', 'slot', 'children', 'key', 'queue', 'refresh', 'writes', 'test', 'expect', 'send', 'let']);
/** What Contract's formatter wraps at (contract fmt). */
const WIDTH = 100;
const PX = /^(-?(?:\d+\.?\d*|\.\d+))px$/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;
const VAR = /var\(\s*--([\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g;
const HEADING = /^h([1-6])$/;
const HEADING_EM: Record<string, number> = { h1: 2, h2: 1.5, h3: 1.17, h4: 1, h5: 0.83, h6: 0.67 };
const POSITION = ['position', 'left', 'top', 'right', 'bottom'];
/** Layer tags that are Contract tags of the same meaning. The rest are boxes. */
const SAME_TAGS = new Set(['section', 'header', 'footer', 'nav', 'article', 'aside', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'dl', 'dt', 'dd', 'hr']);
const SVG_TAGS = new Set(['svg', 'g', 'path', 'polyline', 'polygon', 'circle', 'ellipse', 'line', 'rect', 'defs', 'symbol', 'use', 'clipPath', 'marker', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'stop', 'text', 'tspan', 'filter']);
const MOTION = /^(animation|transition)(-|$)/;
const CSS_WIDE = /^(inherit|initial|unset|revert|revert-layer)$/;

// Names and literals

function words(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function pascal(text: string, fallback: string): string {
  const out = words(text).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
  return /^[A-Z]/.test(out) ? out : `${fallback}${out}`;
}

function camel(text: string, fallback: string): string {
  const parts = words(text);
  const out = parts.map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1) : w[0]!.toLowerCase() + w.slice(1))).join('');
  const safe = /^[a-z_]/i.test(out) ? out : `${fallback}${out}`;
  return CONTRACT_RESERVED.has(safe) ? `${safe}Value` : safe;
}

function kebab(text: string): string {
  return words(text).join('-').toLowerCase();
}

/** A Contract string literal: JavaScript's escapes for quotes, backslashes and line ends, and `\u{…}` for the other controls. */
export function contractString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) out += `\\u{${code.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

/** A line comment: one physical line. */
function comment(text: string): string {
  return `// ${text.replace(/\s+/g, ' ').trim()}`;
}

/** An element as Contract writes it, wrapped the way `contract fmt` wraps a long head: the first attribute stays, each other gets a line. */
function elementLines(indent: number, head: string, attrs: string[]): string[] {
  const pad = '  '.repeat(indent);
  const one = [head, ...attrs].join(' ');
  if (pad.length + one.length <= WIDTH || attrs.length < 2) return [`${pad}${one}`];
  const inner = '  '.repeat(indent + 1);
  return [`${pad}${head} ${attrs[0]}`, ...attrs.slice(1).map((a) => `${inner}${a}`)];
}

// The export

interface Ctx {
  doc: BogenDoc;
  root: string;
  dropped: ExactDrop[];
  notes: Set<string>;
  assets: Map<string, ExactAsset>;
  /** Tokens written into app.tamber, by name, and the ones that are inlined instead. */
  designTokens: Map<string, Token>;
  inlinedTokens: Map<string, Token>;
  usedTokens: Set<string>;
  /** Font families the app names, to say they are not bundled. */
  families: Set<string>;
  textStyles: Map<string, TextStyle>;
  styleNames: Map<string, string>;
  usedStyles: Set<string>;
  testIds: Set<string>;
  testIdOf: Map<string, string>;
  /** Presses that add to a number, and the texts that show a variable: what the generated test can check. */
  increments: { layer: string; variable: string; by: number }[];
  shownBy: Map<string, string>;
  firstText?: { testId: string; text: string };
  variables: Map<string, FileVariable & { slot: string }>;
  /** Layers shown and hidden by interactions: the bool state that holds whether each shows. */
  visibility: Map<string, string>;
  usedVariables: Set<string>;
  actions: string[];
  usedNames: Set<string>;
  dark?: string;
}

function drop(ctx: Ctx, node: BogenNode, what: string, reason: string, value?: string, approximated = false): void {
  ctx.dropped.push({ layer: node.id, name: node.name, what, ...(value !== undefined ? { value: value.slice(0, 200) } : {}), reason, ...(approximated ? { approximated } : {}) });
}

function uniqueName(ctx: Ctx, base: string): string {
  let name = base;
  for (let i = 2; ctx.usedNames.has(name); i++) name = `${base}${i}`;
  ctx.usedNames.add(name);
  return name;
}

function testIdFor(ctx: Ctx, node: BogenNode): string {
  if (node.id === ctx.root) return 'screen';
  const base = kebab(node.name) || node.type;
  let id = base;
  for (let i = 2; ctx.testIds.has(id); i++) id = `${base}-${i}`;
  ctx.testIds.add(id);
  ctx.testIdOf.set(node.id, id);
  return id;
}

// Tokens

const COLOR_VALUE = /^(#[0-9a-f]{3,8}|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([^;{}]*\)|[a-z]+)$/i;
const LENGTH_VALUE = /^(0|-?(\d+\.?\d*|\.\d+)(px|rem|em))$/;

function familyValue(value: string): string | null {
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: string[] = [];
  for (const p of parts) {
    if (/^"[^"]+"$/.test(p)) out.push(p);
    else if (/^'[^']+'$/.test(p)) out.push(`"${p.slice(1, -1)}"`);
    else if (/^[\w-]+$/.test(p)) out.push(p);
    else if (/^[\w -]+$/.test(p)) out.push(`"${p}"`);
    else return null;
  }
  return out.join(', ');
}

/** A Bogen token as an app.tamber line, or null when Tamber would refuse its value: then uses of it are written with the value itself. */
function tamberLine(token: Token, dark: string | undefined): string | null {
  const value = token.value.trim();
  if (!value || value.includes('var(') || /[;{}]/.test(value)) return null;
  switch (token.kind) {
    case 'color': {
      if (!COLOR_VALUE.test(value)) return null;
      const night = dark ? token.modes?.[dark]?.trim() : undefined;
      if (night && night !== value && COLOR_VALUE.test(night) && !night.includes('var(')) return `${token.name}: color = light-dark(${value}, ${night})`;
      return `${token.name}: color = ${value}  scheme=fixed`;
    }
    case 'font-family': {
      const family = familyValue(value);
      return family ? `${token.name}: family = ${family}` : null;
    }
    case 'font-weight':
      return /^\d{1,4}$/.test(value) ? `${token.name}: number = ${value}` : null;
    case 'line-height':
      if (NUMBER.test(value)) return `${token.name}: number = ${value}`;
      return LENGTH_VALUE.test(value) ? `${token.name}: length = ${value}` : null;
    default:
      return LENGTH_VALUE.test(value) ? `${token.name}: length = ${value}` : null;
  }
}

/** Replaces the custom properties of a value: a token in app.tamber stays a `var()`, any other token is written as its value. */
function resolveVars(ctx: Ctx, node: BogenNode, prop: string, value: string, depth = 0): string | null {
  if (!value.includes('var(')) return value;
  let failed = false;
  const out = value.replace(VAR, (_all, name: string, fallback: string | undefined) => {
    if (ctx.designTokens.has(name)) {
      ctx.usedTokens.add(name);
      return `var(--${name})`;
    }
    const inline = ctx.inlinedTokens.get(name);
    if (inline) {
      if (!ctx.dropped.some((d) => d.what === `--${name}`)) drop(ctx, node, `--${name}`, 'This token\'s value is not one an app.tamber token can hold, so its value is written where it is used.', inline.value, true);
      return inline.value;
    }
    if (fallback !== undefined) return fallback.trim();
    failed = true;
    return '';
  });
  if (failed) {
    drop(ctx, node, prop, 'It names a custom property that is not one of the file\'s tokens.', value);
    return null;
  }
  return depth < 3 && out.includes('var(') && out !== value ? resolveVars(ctx, node, prop, out, depth + 1) : out;
}

// Styles

type Written = [prop: string, value: string];

/** One CSS declaration as Contract attributes: none when Contract has no such property or value, and then it is in `dropped`. */
function styleAttrs(ctx: Ctx, node: BogenNode, cssProp: string, raw: string): Written[] {
  const prop = kebabCss(cssProp);
  let value = raw.replace(/\s*!important\s*$/i, '').trim();
  if (!value) return [];
  if (prop.startsWith('--')) {
    drop(ctx, node, prop, 'A custom property on a layer is not part of Contract; tokens go to app.tamber.', value);
    return [];
  }
  if (MOTION.test(prop)) {
    drop(ctx, node, prop, 'Motion is not exported to Exact yet. Contract has transitions and keyframes of its own.', value);
    return [];
  }
  if (CSS_WIDE.test(value)) {
    drop(ctx, node, prop, 'Contract has no CSS-wide keywords such as inherit or initial.', value);
    return [];
  }
  if (/url\(/i.test(value)) {
    drop(ctx, node, prop, 'Contract takes no url() in a style: a picture is an image layer.', value);
    return [];
  }
  const resolved = resolveVars(ctx, node, prop, value);
  if (resolved === null) return [];
  value = resolved;
  const plain = !value.includes('var(');
  const split = (v: string) => v.split(/\s+/).filter(Boolean);

  switch (prop) {
    case 'background': {
      if (/gradient\(/.test(value)) return styleAttrs(ctx, node, 'background-image', value);
      if (COLOR_VALUE.test(value) || /^var\(/.test(value)) return styleAttrs(ctx, node, 'background-color', value);
      drop(ctx, node, prop, 'Contract refuses the background shorthand; only a colour or gradients are written.', value);
      return [];
    }
    case 'padding-inline': case 'padding-block': case 'margin-inline': case 'margin-block': {
      const [kind, axis] = prop.split('-') as [string, string];
      const [a, b = a] = split(value);
      const sides = axis === 'inline' ? ['left', 'right'] : ['top', 'bottom'];
      return [...styleAttrs(ctx, node, `${kind}-${sides[0]}`, a!), ...styleAttrs(ctx, node, `${kind}-${sides[1]}`, b!)];
    }
    case 'padding-inline-start': case 'padding-inline-end': case 'margin-inline-start': case 'margin-inline-end':
      return styleAttrs(ctx, node, prop.replace(/-inline-start$/, '-left').replace(/-inline-end$/, '-right'), value);
    case 'padding-block-start': case 'padding-block-end': case 'margin-block-start': case 'margin-block-end':
      return styleAttrs(ctx, node, prop.replace(/-block-start$/, '-top').replace(/-block-end$/, '-bottom'), value);
    case 'place-items': case 'place-content': {
      const [a, b = a] = split(value);
      const part = prop.slice('place-'.length);
      return [...styleAttrs(ctx, node, `align-${part}`, a!), ...styleAttrs(ctx, node, `justify-${part}`, b!)];
    }
    case 'flex-flow': {
      const out: Written[] = [];
      for (const v of split(value)) out.push(...styleAttrs(ctx, node, /wrap/.test(v) ? 'flex-wrap' : 'flex-direction', v));
      return out;
    }
    case 'display': {
      const map: Record<string, string> = { 'inline-flex': 'flex', 'inline-grid': 'grid', 'inline-block': 'block', inline: 'block', 'flow-root': 'block', 'list-item': 'block' };
      if (map[value]) {
        drop(ctx, node, prop, `Contract has block, flex, grid and none: written as ${map[value]}.`, value, true);
        value = map[value]!;
      }
      break;
    }
    case 'position':
      if (value === 'fixed') {
        drop(ctx, node, prop, 'Contract has no fixed position: written as absolute.', value, true);
        value = 'absolute';
      }
      break;
    case 'font-weight':
      if (value === 'bold') value = '700';
      else if (value === 'normal') value = '400';
      break;
    case 'line-height': {
      const pct = /^(\d+\.?\d*)%$/.exec(value);
      if (pct) value = String(Math.round(Number(pct[1]) * 100) / 10_000);
      if (plain && !NUMBER.test(value) && !/^(normal|\d+\.?\d*(px|rem|em))$/.test(value)) {
        drop(ctx, node, prop, 'A line height in Contract is a number, a px, rem or em length, or normal.', value);
        return [];
      }
      return [[prop, NUMBER.test(value) ? value : contractString(value)]];
    }
    case 'font-size': {
      const clamp = /^clamp\(\s*([^,]+),/.exec(value);
      if (clamp && /^\d+\.?\d*(px|rem|em)$/.test(clamp[1]!.trim())) {
        drop(ctx, node, prop, 'Contract\'s font-size takes no clamp(): written as its smallest size.', value, true);
        value = clamp[1]!.trim();
      }
      if (plain && !/^(\d+\.?\d*(px|rem|em)?)$/.test(value)) {
        drop(ctx, node, prop, 'A font-size in Contract is a number or a px, rem or em length.', value);
        return [];
      }
      break;
    }
    case 'letter-spacing':
      if (value === 'normal') value = '0';
      break;
    case 'opacity': {
      const pct = /^(\d+\.?\d*)%$/.exec(value);
      if (pct) value = String(Number(pct[1]) / 100);
      break;
    }
    case 'font-family': {
      const family = plain ? familyValue(value) : value;
      if (!family) {
        drop(ctx, node, prop, 'This font stack could not be written.', value);
        return [];
      }
      if (plain) for (const f of family.split(',')) ctx.families.add(f.trim().replace(/^"|"$/g, ''));
      return [[prop, contractString(family)]];
    }
    case 'gap': case 'row-gap': case 'column-gap':
      if (plain && split(value).some((v) => /%/.test(v))) {
        drop(ctx, node, prop, 'A gap in Contract is a length, not a percentage.', value);
        return [];
      }
      break;
  }

  if (!EXACT_STYLES.has(prop)) {
    drop(ctx, node, prop, 'Contract has no such property.', value);
    return [];
  }
  const allowed = EXACT_ENUMS[prop];
  if (allowed && plain) {
    const parts = prop === 'overflow' || prop === 'overscroll-behavior' ? split(value) : [value];
    if (!parts.every((p) => allowed.includes(p))) {
      drop(ctx, node, prop, `Contract takes ${allowed.join(', ')} here.`, value);
      return [];
    }
  }
  if (prop === 'flex' && NUMBER.test(value)) return [[prop, String(Number(value))]];
  if (plain && (EXACT_NUMERIC.has(prop) || EXACT_LENGTHS.has(prop))) {
    const px = PX.exec(value);
    if (px) return [[prop, String(Number(px[1]))]];
    if (NUMBER.test(value)) return [[prop, String(Number(value))]];
  }
  return [[prop, contractString(value)]];
}

/** The resolved value of an inherited property: the layer's, else its nearest ancestor's within the export. */
function inherited(ctx: Ctx, node: BogenNode, prop: string): string | undefined {
  for (let cur: BogenNode | undefined = node; cur; cur = cur.id === ctx.root ? undefined : ctx.doc.getNode(cur.parent)) {
    const own = cur.style[prop];
    if (own) return own;
    const ts = cur.textStyle ? ctx.textStyles.get(cur.textStyle)?.style[prop] : undefined;
    if (ts) return ts;
  }
  return undefined;
}

function pxOf(ctx: Ctx, node: BogenNode, value: string | undefined): number | undefined {
  if (!value) return undefined;
  const px = PX.exec(value.trim());
  if (px) return Number(px[1]);
  const m = /^var\(--([\w-]+)\)$/.exec(value.trim());
  if (m) return pxOf(ctx, node, ctx.doc.getTokens().find((t) => t.name === m[1])?.value);
  return undefined;
}

/** A layer's style as attributes, with what the canvas assumes and Exact does not: border-box sizing, no link colour, heading sizes. */
function boxAttrs(ctx: Ctx, node: BogenNode, style: Record<string, string>, opts: { root?: boolean; heading?: string; link?: boolean } = {}): string[] {
  const out: Written[] = [];
  const s = { ...style };
  if (opts.root) for (const k of POSITION) delete s[k];
  if (opts.heading) {
    // A heading's size and weight on the canvas are the browser's defaults, which Contract's headings do not share.
    if (!s.fontSize && !(node.textStyle && ctx.textStyles.get(node.textStyle)?.style.fontSize)) {
      const parent = node.id === ctx.root ? undefined : ctx.doc.getNode(node.parent);
      const base = (parent ? pxOf(ctx, parent, inherited(ctx, parent, 'fontSize')) : undefined) ?? 16;
      s.fontSize = `${Math.round(base * HEADING_EM[opts.heading]! * 100) / 100}px`;
    }
    if (!s.fontWeight && !(node.textStyle && ctx.textStyles.get(node.textStyle)?.style.fontWeight)) s.fontWeight = '700';
  }
  if (opts.link) {
    if (!s.color) s.color = inherited(ctx, node, 'color') ?? 'CanvasText';
    if (!s.textDecoration && !s.textDecorationLine) s.textDecorationLine = 'none';
  }
  for (const [k, v] of Object.entries(s)) out.push(...styleAttrs(ctx, node, k, v));
  const has = (p: RegExp) => out.some(([k]) => p.test(k));
  // Bogen lays everything out border-box; a bare Contract node is content-box, as CSS's is.
  if (node.type !== 'text' && !s.boxSizing && has(/^(padding|border(-(top|right|bottom|left))?(-width)?$)/) && has(/^(width|height|min-|max-|flex$|flex-basis)/)) out.push(['box-sizing', '"border-box"']);
  return out.map(([k, v]) => `${k}=${v}`);
}

// Interactions

function variableLiteral(v: FileVariable | undefined, value: unknown): string | null {
  if (!v) return null;
  if (v.type === 'boolean') return value === true || value === 'true' ? 'true' : 'false';
  if (v.type === 'number') return Number.isFinite(Number(value)) ? String(Number(value)) : null;
  return contractString(String(value ?? ''));
}

function useVariable(ctx: Ctx, name: string): (FileVariable & { slot: string }) | undefined {
  const v = ctx.variables.get(name);
  if (v) ctx.usedVariables.add(name);
  return v;
}

function conditionExpr(ctx: Ctx, c: ProtoCondition): string | null {
  const v = useVariable(ctx, c.variable);
  if (!v) return null;
  const lit = variableLiteral(v, c.value);
  switch (c.op) {
    case 'is': return v.type === 'boolean' ? (lit === 'true' ? v.slot : `not ${v.slot}`) : lit && `${v.slot} == ${lit}`;
    case 'not': return v.type === 'boolean' ? (lit === 'true' ? `not ${v.slot}` : v.slot) : lit && `${v.slot} != ${lit}`;
    case 'gt': return v.type === 'number' && lit ? `${v.slot} > ${lit}` : null;
    case 'lt': return v.type === 'number' && lit ? `${v.slot} < ${lit}` : null;
    case 'gte': return v.type === 'number' && lit ? `${v.slot} >= ${lit}` : null;
    case 'lte': return v.type === 'number' && lit ? `${v.slot} <= ${lit}` : null;
    case 'contains': return v.type === 'text' && lit ? `${v.slot}.includes(${lit})` : null;
    case 'empty': return v.type === 'text' ? `${v.slot}.isEmpty()` : null;
    case 'filled': return v.type === 'text' ? `not ${v.slot}.isEmpty()` : null;
  }
  return null;
}

/** A click's actions as one Contract action, or null when none of them can be one. */
function clickAction(ctx: Ctx, node: BogenNode, actions: ProtoAction[]): string | null {
  const body: string[] = [];
  const assigned = new Set<string>();
  for (const a of actions) {
    let line: string | null = null;
    if (a.type === 'set' || a.type === 'toggle' || a.type === 'increment') {
      const v = useVariable(ctx, a.variable);
      if (v) {
        if (a.type === 'set') line = variableLiteral(v, a.value) && `${v.slot} = ${variableLiteral(v, a.value)}`;
        else if (a.type === 'toggle' && v.type === 'boolean') line = `${v.slot} = not ${v.slot}`;
        else if (a.type === 'increment' && v.type === 'number') {
          const by = Number.isFinite(a.by) ? a.by! : 1;
          line = `${v.slot} = ${v.slot} + ${by}`;
          ctx.increments.push({ layer: node.id, variable: v.name, by });
        }
      }
    } else if (a.type === 'show' || a.type === 'hide' || a.type === 'toggle-visibility') {
      const slot = ctx.visibility.get(a.target);
      if (slot) line = `${slot} = ${a.type === 'show' ? 'true' : a.type === 'hide' ? 'false' : `not ${slot}`}`;
    }
    // An action's writes land when it ends, so a second write to one state would be refused.
    const target = line?.split(' = ')[0];
    if (line && target && !assigned.has(target)) {
      assigned.add(target);
      body.push(`    ${line}`);
    } else drop(ctx, node, 'interaction', a.type === 'navigate' || a.type === 'back' ? 'Moving between screens is not exported yet: each artboard is its own app.' : a.type === 'set-variant' ? 'Variants are not exported to Exact yet.' : 'This action could not be written as a Contract assignment.', a.type);
  }
  if (!body.length) return null;
  const name = uniqueName(ctx, camel(`press ${node.name}`, 'press'));
  ctx.actions.push(`  action ${name}`, ...body);
  return name;
}

function interactionAttrs(ctx: Ctx, node: BogenNode, pressable = node.type === 'frame'): string[] {
  const proto = readProtoState(node.proto);
  const out: string[] = [];
  for (const i of proto.interactions ?? []) {
    if (i.trigger !== 'click') {
      drop(ctx, node, 'interaction', `A ${i.trigger} interaction is not exported yet; clicks are.`, i.trigger);
      continue;
    }
    if (!pressable) {
      drop(ctx, node, 'interaction', 'Only a frame, a button or a link takes a press in this export; put the click on the frame around it.', i.trigger);
      continue;
    }
    if (out.some((a) => a.startsWith('press='))) {
      drop(ctx, node, 'interaction', 'A layer gets one press: only its first click interaction is written.', i.trigger);
      continue;
    }
    const name = clickAction(ctx, node, i.actions);
    if (name) out.push(`press=${name}`);
  }
  if (node.proto?.link) drop(ctx, node, 'interaction', 'Links between artboards are not exported yet: each artboard is its own app.', node.proto.link);
  if (node.proto?.hover && Object.keys(node.proto.hover).length) drop(ctx, node, 'interaction', 'Hover styles are not exported yet.', JSON.stringify(node.proto.hover));
  if (proto.variantFrom) drop(ctx, node, 'interaction', 'A variant that follows a variable is not exported yet.', proto.variantFrom.variable);
  return out;
}

// Layers

function emitChildren(ctx: Ctx, node: BogenNode, indent: number): string[] {
  return ctx.doc.getChildren(node.id).flatMap((c) => emit(ctx, c, indent));
}

/** A layer and what is inside it, under the conditions that decide whether it shows. */
function emit(ctx: Ctx, node: BogenNode, indent: number): string[] {
  const conditions: string[] = [];
  const slot = ctx.visibility.get(node.id);
  const proto = readProtoState(node.proto);
  if (slot) conditions.push(slot);
  // A condition decides whether a layer shows, hidden or not, as in the prototype.
  else if (node.hidden && !proto.showWhen) {
    drop(ctx, node, 'layer', 'Hidden layers are left out.');
    return [`${'  '.repeat(indent)}${comment(`Left out: hidden layer "${node.name}"`)}`];
  }
  if (proto.showWhen) {
    const expr = conditionExpr(ctx, proto.showWhen);
    if (expr) conditions.push(expr);
    else drop(ctx, node, 'interaction', 'This show condition could not be written; the layer always shows.', JSON.stringify(proto.showWhen));
  }
  if (!conditions.length) return emitLayer(ctx, node, indent);
  const pad = '  '.repeat(indent);
  return [`${pad}if ${conditions.map((c) => (conditions.length > 1 && /\s/.test(c) ? `(${c})` : c)).join(' and ')}`, ...emitLayer(ctx, node, indent + 1)];
}

function emitLayer(ctx: Ctx, node: BogenNode, indent: number, root = false): string[] {
  const pad = '  '.repeat(indent);
  const notes = (n: number) => ctx.dropped.slice(n).filter((d) => d.layer === node.id && !d.approximated).map((d) => d.what);
  const before = ctx.dropped.length;
  let lines: string[];
  switch (node.type) {
    case 'text': lines = emitText(ctx, node, indent, root); break;
    case 'image': lines = emitImage(ctx, node, indent, root); break;
    case 'svg': lines = emitSvg(ctx, node, indent, root); break;
    case 'frame': lines = emitFrame(ctx, node, indent, root); break;
    default:
      drop(ctx, node, 'layer', node.type === 'embed' ? 'Embedded pages and code components have no Contract form.' : node.type === 'shader' ? 'Shaders are not exported to Exact; Exact has a GPU module of its own.' : 'Videos are not exported to Exact yet.');
      return [`${pad}${comment(`Left out: ${node.type} layer "${node.name}"`)}`];
  }
  const lost = [...new Set(notes(before))];
  return lost.length ? [`${pad}${comment(`Left out of "${node.name}": ${lost.join(', ')}`)}`, ...lines] : lines;
}

function frameTag(ctx: Ctx, node: BogenNode, style: Record<string, string>): { tag: string; style: Record<string, string>; extra: string[] } {
  const s = { ...style };
  const extra: string[] = [];
  const tag = node.tag.toLowerCase();
  const display = s.display?.replace(/^inline-/, '');
  const direction = s.flexDirection ?? 'row';
  let out = 'view';
  if (tag === 'button') {
    out = 'button';
    extra.push('appearance="none"');
  } else if (tag === 'a') {
    out = 'link';
    const href = node.attrs?.href;
    if (href) extra.push(`href=${contractString(href)}`);
  } else if (SAME_TAGS.has(tag)) {
    out = tag;
    if (tag === 'header') extra.push('appearance="none"');
  } else if (display === 'flex' && (direction === 'row' || direction === 'column')) {
    if (s.display !== 'flex') drop(ctx, node, 'display', 'Contract has block, flex, grid and none: written as flex.', s.display, true);
    out = direction;
    delete s.display;
    delete s.flexDirection;
  } else if (tag === 'form') drop(ctx, node, 'form', 'Contract has no form: a field\'s submit acts instead.', undefined, true);
  return { tag: out, style: s, extra };
}

function emitFrame(ctx: Ctx, node: BogenNode, indent: number, root: boolean): string[] {
  const tag = node.tag.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return emitField(ctx, node, indent, root);
  if (tag === 'select') {
    drop(ctx, node, 'layer', 'A select is not exported yet; Contract has select and option.');
    return [`${'  '.repeat(indent)}${comment(`Left out: select "${node.name}"`)}`];
  }
  for (const [block] of Object.entries(node.rules ?? {})) drop(ctx, node, block, 'Pseudo-elements, states and conditional styles are not exported yet.');
  const { tag: t, style, extra } = frameTag(ctx, node, node.style);
  const attrs = [...extra, ...interactionAttrs(ctx, node)];
  if (root || t === 'button' || t === 'link' || attrs.some((a) => a.startsWith('press='))) attrs.unshift(`testId="${testIdFor(ctx, node)}"`);
  const aria = node.attrs?.['aria-label'];
  if (aria) attrs.push(`aria-label=${contractString(aria)}`);
  if (node.textStyle) drop(ctx, node, 'text style', 'A text style on a frame is not exported; set it on its text layers.', node.textStyle);
  attrs.push(...boxAttrs(ctx, node, style, { root, link: t === 'link' }));
  if (tag === 'hr') return elementLines(indent, 'hr', attrs);
  const children = emitChildren(ctx, node, indent + 1);
  return [...elementLines(indent, t, attrs), ...children];
}

function emitField(ctx: Ctx, node: BogenNode, indent: number, root: boolean): string[] {
  const tag = node.tag.toLowerCase() === 'textarea' ? 'textarea' : 'input';
  const attrs = [`testId="${testIdFor(ctx, node)}"`];
  const a = node.attrs ?? {};
  const type = a.type ?? 'text';
  if (tag === 'input' && ['text', 'email', 'password', 'search', 'tel', 'url', 'number', 'checkbox'].includes(type)) {
    if (type !== 'text') attrs.push(`type=${contractString(type)}`);
  } else if (tag === 'input') drop(ctx, node, 'type', 'This input type is written as a text field.', type, true);
  if (a.placeholder) attrs.push(`placeholder=${contractString(a.placeholder)}`);
  attrs.push(`aria-label=${contractString(a['aria-label'] ?? a.placeholder ?? node.name)}`);
  const bind = readProtoState(node.proto).bind;
  const v = bind ? useVariable(ctx, bind) : undefined;
  if (v && ((v.type === 'text' && type !== 'checkbox') || (v.type === 'boolean' && type === 'checkbox'))) {
    const setter = uniqueName(ctx, camel(`set ${v.name}`, 'set'));
    ctx.actions.push(`  action ${setter}(value: ${v.type === 'text' ? 'string' : 'bool'})`, `    ${v.slot} = value`);
    attrs.push(type === 'checkbox' ? `checked=${v.slot}` : `value=${v.slot}`, `${type === 'checkbox' ? 'change' : 'input'}=${setter}`);
  } else {
    if (bind) drop(ctx, node, 'interaction', 'This field\'s variable is not text (or a checkbox\'s bool), so it is not bound.', bind);
    if (a.value) attrs.push(`value=${contractString(a.value)}`);
  }
  attrs.push(...boxAttrs(ctx, node, node.style, { root }));
  return elementLines(indent, tag, attrs);
}

function textStyleClass(ctx: Ctx, node: BogenNode): string[] {
  const name = node.textStyle ? ctx.styleNames.get(node.textStyle) : undefined;
  if (!name) return [];
  ctx.usedStyles.add(node.textStyle!);
  return [`class=${name}`];
}

/** A text layer's words: a string, a variable it shows, or a paragraph of runs. Returns the head and the run lines. */
function textBody(ctx: Ctx, node: BogenNode, testId: string, indent: number): { head: string; runs: string[] } {
  const proto = readProtoState(node.proto);
  const bound = proto.textFrom ? useVariable(ctx, proto.textFrom) : undefined;
  if (bound) {
    ctx.shownBy.set(bound.name, testId);
    return { head: `text ${bound.type === 'text' ? bound.slot : `\`\${${bound.slot}}\``}`, runs: [] };
  }
  const text = node.text ?? '';
  const runs = node.spans?.length ? textRuns(text, node.spans) : [];
  if (runs.length > 1 || runs.some((r) => r.href || Object.keys(r.style).length)) {
    // A paragraph of runs: each run is a text of its own inside it.
    const lines: string[] = [];
    for (const run of runs) {
      const runAttrs: string[] = [];
      if (run.href) runAttrs.push(`href=${contractString(run.href)}`);
      for (const [k, v] of Object.entries(run.style)) runAttrs.push(...styleAttrs(ctx, node, k, v).map(([p, val]) => `${p}=${val}`));
      lines.push(...elementLines(indent + 1, `text ${contractString(run.text)}`, runAttrs));
    }
    return { head: 'text', runs: lines };
  }
  // The test reads a plain text: a paragraph of runs has no text of its own in every reader.
  if (!ctx.firstText && text.trim()) ctx.firstText = { testId, text };
  return { head: `text ${contractString(text)}`, runs: [] };
}

function emitText(ctx: Ctx, node: BogenNode, indent: number, root: boolean): string[] {
  const tag = node.tag.toLowerCase();
  const heading = HEADING.test(tag) ? tag : undefined;
  for (const [block] of Object.entries(node.rules ?? {})) drop(ctx, node, block, 'Pseudo-elements, states and conditional styles are not exported yet.');
  const style = { ...node.style };
  // The canvas writes text with its line breaks kept.
  if (!style.whiteSpace && (node.text ?? '').includes('\n')) style.whiteSpace = 'pre-wrap';
  if (tag === 'button' || tag === 'a') {
    // A text layer that is a button or a link: the control, its look and its press, around the text.
    const testId = testIdFor(ctx, node);
    const attrs = [`testId="${testId}"`, tag === 'button' ? 'appearance="none"' : '', tag === 'a' && node.attrs?.href ? `href=${contractString(node.attrs.href)}` : '', ...interactionAttrs(ctx, node, true), ...textStyleClass(ctx, node), ...boxAttrs(ctx, node, style, { root, link: tag === 'a' })].filter(Boolean);
    const label = `${testId}-label`;
    ctx.testIds.add(label);
    const body = textBody(ctx, node, label, indent + 1);
    return [...elementLines(indent, tag === 'button' ? 'button' : 'link', attrs), ...elementLines(indent + 1, body.head, [`testId="${label}"`]), ...body.runs];
  }
  const testId = testIdFor(ctx, node);
  const attrs = [`testId="${testId}"`, ...(heading ? ['role="heading"', `aria-level=${heading.slice(1)}`] : []), ...textStyleClass(ctx, node), ...boxAttrs(ctx, node, style, { root, ...(heading ? { heading } : {}) }), ...interactionAttrs(ctx, node)];
  const body = textBody(ctx, node, testId, indent);
  return [...elementLines(indent, body.head, attrs), ...body.runs];
}

function assetPath(ctx: Ctx, node: BogenNode, src: string): string | null {
  const known = ctx.assets.get(src);
  if (known) return known.path;
  let path: string;
  if (src.startsWith('bogen-asset:')) {
    const name = src.slice('bogen-asset:'.length).replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '');
    path = `assets/${name || `image-${ctx.assets.size + 1}`}`;
  } else if (src.startsWith('data:image/')) {
    const ext = /^data:image\/(png|jpeg|jpg|webp|gif)[;,]/.exec(src)?.[1]?.replace('jpeg', 'jpg');
    if (!ext) return null;
    path = `assets/image-${ctx.assets.size + 1}.${ext}`;
  } else return null;
  for (let i = 2; [...ctx.assets.values()].some((a) => a.path === path); i++) path = path.replace(/(-\d+)?(\.\w+)?$/, (_m, _n, ext = '') => `-${i}${ext}`);
  ctx.assets.set(src, { path, src });
  return path;
}

function emitImage(ctx: Ctx, node: BogenNode, indent: number, root: boolean): string[] {
  const src = node.src ?? '';
  const style = { ...node.style };
  if (!src) {
    drop(ctx, node, 'image', 'This image has no picture yet: it is an empty box of its size.', undefined, true);
    return elementLines(indent, 'view', [`testId="${testIdFor(ctx, node)}"`, ...boxAttrs(ctx, node, { backgroundColor: 'rgba(0, 0, 0, 0.06)', ...style }, { root })]);
  }
  let where: string | null;
  if (/^https:\/\//.test(src)) {
    where = src;
    ctx.notes.add('Remote images are loaded from their URL when the app runs.');
  } else where = assetPath(ctx, node, src);
  if (!where) {
    drop(ctx, node, 'image', 'This picture\'s source cannot be copied into the app.', src.slice(0, 80));
    return [`${'  '.repeat(indent)}${comment(`Left out: image "${node.name}"`)}`];
  }
  if (node.attrs?.['data-crop']) drop(ctx, node, 'crop', 'Image crops are not exported: the whole picture is shown with its object-fit.', node.attrs['data-crop']);
  if (!style.objectFit) style.objectFit = 'cover';
  const attrs = [`testId="${testIdFor(ctx, node)}"`];
  if (node.attrs?.alt) attrs.push(`alt=${contractString(node.attrs.alt)}`);
  attrs.push(...interactionAttrs(ctx, node), ...boxAttrs(ctx, node, style, { root }));
  return elementLines(indent, `image ${contractString(where)}`, attrs);
}

// SVG

function svgAttrs(ctx: Ctx, node: BogenNode, el: Element): string[] {
  const out: string[] = [];
  for (const [name, raw] of Object.entries(el.attribs)) {
    const value = raw.trim();
    if (name === 'xmlns' || name.startsWith('xmlns:') || name.startsWith('data-') || name === 'class' || name === 'version') continue;
    if (name === 'style') {
      for (const [k, v] of Object.entries(parseStyle(value))) out.push(...styleAttrs(ctx, node, k, v).map(([p, val]) => `${p}=${val}`));
      continue;
    }
    if (name.includes(':')) {
      drop(ctx, node, `svg ${name}`, 'Namespaced SVG attributes are not part of Contract.', value);
      continue;
    }
    if (name === 'id') {
      if (/^[A-Za-z][\w-]*$/.test(value)) out.push(`id=${contractString(value)}`);
      continue;
    }
    if (EXACT_STYLES.has(name)) {
      out.push(...styleAttrs(ctx, node, name, value).map(([p, val]) => `${p}=${val}`));
      continue;
    }
    if (!EXACT_PROPS.has(name)) {
      drop(ctx, node, `svg ${name}`, 'Contract has no such SVG attribute.', value);
      continue;
    }
    const type = EXACT_PROP_TYPES[name];
    if (type === 'bool') out.push(`${name}=${value === 'false' ? 'false' : 'true'}`);
    else if (type && NUMBER.test(value)) out.push(`${name}=${Number(value)}`);
    else out.push(`${name}=${contractString(value)}`);
  }
  return out;
}

function svgElement(ctx: Ctx, node: BogenNode, el: Element, indent: number): string[] {
  if (!SVG_TAGS.has(el.name) || !EXACT_TAGS.has(el.name)) {
    drop(ctx, node, `svg <${el.name}>`, 'Contract has no such SVG element.');
    return [];
  }
  const kids = el.children.filter((c): c is Element => isTag(c));
  const words = el.children.filter((c) => isText(c)).map((c) => (c as unknown as { data: string }).data).join('').replace(/\s+/g, ' ').trim();
  const head = (el.name === 'text' || el.name === 'tspan') && words ? `${el.name} ${contractString(words)}` : el.name;
  return [...elementLines(indent, head, svgAttrs(ctx, node, el)), ...kids.flatMap((k) => svgElement(ctx, node, k, indent + 1))];
}

function emitSvg(ctx: Ctx, node: BogenNode, indent: number, root: boolean): string[] {
  const markup = sanitizeSvgMarkup(node.svg ?? '', node.id);
  const svg = parseDocument(markup, { xmlMode: true }).children.find((c: ChildNode): c is Element => isTag(c) && c.name === 'svg');
  if (!svg) {
    drop(ctx, node, 'layer', 'This SVG layer has no markup that could be read.');
    return [`${'  '.repeat(indent)}${comment(`Left out: svg "${node.name}"`)}`];
  }
  const own = svgAttrs(ctx, node, svg).filter((a) => !/^(width|height)=/.test(a));
  const attrs = [`testId="${testIdFor(ctx, node)}"`, ...own, ...interactionAttrs(ctx, node), ...boxAttrs(ctx, node, node.style, { root })];
  const aria = node.attrs?.['aria-label'];
  if (aria) attrs.push(`aria-label=${contractString(aria)}`);
  const kids = svg.children.filter((c): c is Element => isTag(c));
  return [...elementLines(indent, 'svg', attrs), ...kids.flatMap((k) => svgElement(ctx, node, k, indent + 1))];
}

// The app

function collectTargets(ctx: Ctx, id: string): void {
  for (const n of [ctx.doc.getNode(id)!, ...ctx.doc.descendants(id)]) {
    for (const i of readProtoState(n.proto).interactions ?? []) {
      for (const a of i.actions) {
        if ((a.type === 'show' || a.type === 'hide' || a.type === 'toggle-visibility') && !ctx.visibility.has(a.target)) {
          const target = ctx.doc.getNode(a.target);
          if (target && a.target !== ctx.root && ctx.doc.ancestors(a.target).includes(ctx.root)) ctx.visibility.set(a.target, uniqueName(ctx, camel(`${target.name} shown`, 'shown')));
        }
      }
    }
  }
}

function slugOf(title: string): string {
  const slug = kebab(title).replace(/^[^a-z]+/, '');
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(slug) && !/-(web|apple|linux|gpu)$/.test(slug) ? slug : `bogen-${slug || 'app'}`.replace(/-+$/, '');
}

/** A layer as a runnable minimal Exact app. Experimental: see the module comment. */
export function toExactApp(doc: BogenDoc, rootId: string, options: { title?: string } = {}): ExactApp {
  const root = doc.getNode(rootId);
  if (!root) throw new Error(`No layer with id ${rootId}.`);
  const title = (options.title ?? root.name).trim() || 'Bogen screen';
  const modes = getModes(doc);
  const dark = modes.find((m) => !m.base && /dark|night/i.test(m.name))?.name;
  const ctx: Ctx = {
    doc, root: rootId, dropped: [], notes: new Set(), assets: new Map(), designTokens: new Map(), inlinedTokens: new Map(), usedTokens: new Set(), families: new Set(),
    textStyles: new Map(getTextStyles(doc).map((t) => [t.key, t])), styleNames: new Map(), usedStyles: new Set(), testIds: new Set(['screen']), testIdOf: new Map(), increments: [], shownBy: new Map(),
    variables: new Map(), usedVariables: new Set(), visibility: new Map(), actions: [], usedNames: new Set(), ...(dark ? { dark } : {}),
  };
  const component = pascal(title, 'Screen');
  ctx.usedNames.add(component);
  const tamberLines = new Map<string, string>();
  for (const token of doc.getTokens()) {
    const line = tamberLine(token, dark);
    if (line) {
      ctx.designTokens.set(token.name, token);
      tamberLines.set(token.name, line);
    } else ctx.inlinedTokens.set(token.name, token);
  }
  for (const ts of ctx.textStyles.values()) ctx.styleNames.set(ts.key, uniqueName(ctx, `${pascal(ts.name, 'Text')}Text`));
  for (const v of getVariables(doc)) ctx.variables.set(v.name, { ...v, slot: uniqueName(ctx, camel(v.name, 'v')) });
  collectTargets(ctx, rootId);

  // The design keeps its own colours, so the platform's unsaid ones follow the light scheme the canvas draws in.
  const scheme = dark ? [] : ['color-scheme="light"'];
  // The artboard's fixed size becomes its most width and least height, so the screen fits a smaller window and scrolls.
  const fixed = (k: string) => PX.exec(root.style[k] ?? '')?.[1];
  const width = fixed('width');
  const height = fixed('height');
  const rootStyle = { ...root.style };
  if (width) Object.assign(rootStyle, { width: '100%', maxWidth: root.style.maxWidth ?? `${width}px`, marginLeft: root.style.marginLeft ?? 'auto', marginRight: root.style.marginRight ?? 'auto' });
  if (height) {
    delete rootStyle.height;
    rootStyle.minHeight = root.style.minHeight ?? `${height}px`;
  }
  if (width || height) ctx.notes.add(`The layer's ${[width && `width (${width}px) is its max-width`, height && `height (${height}px) its min-height`].filter(Boolean).join(' and ')}, so the screen fits other windows.`);
  const view = emitLayer(ctx, { ...root, style: rootStyle }, 4, true);

  const lines: string[] = [
    comment(`${title}: exported from Bogen as an Exact app (experimental).`),
    comment(`Written against Exact ${EXACT_COMMIT.slice(0, 12)} (${EXACT_COMMIT_DATE}); Exact changes daily, so a newer`),
    comment('compiler may refuse something here: `bun exact.mjs contract build app.contract --json` says what.'),
  ];
  const usedStyles = [...ctx.usedStyles].map((k) => ctx.textStyles.get(k)!);
  for (const ts of usedStyles) {
    const decls: string[] = [];
    const fake = { ...root, id: `textStyle:${ts.key}`, name: `text style ${ts.name}` };
    for (const [k, v] of Object.entries(ts.style)) for (const [p, val] of styleAttrs(ctx, fake, k, v)) decls.push(`  ${p}=${val}`);
    lines.push('', `style ${ctx.styleNames.get(ts.key)}`, ...decls);
  }
  lines.push('', `component ${component}`);
  const usedVars = [...ctx.variables.values()].filter((v) => ctx.usedVariables.has(v.name));
  for (const v of usedVars) lines.push(`  state ${v.slot} = ${variableLiteral(v, v.value)}`);
  for (const [id, slot] of ctx.visibility) lines.push(`  state ${slot} = ${doc.getNode(id)?.hidden ? 'false' : 'true'}`);
  lines.push(...ctx.actions);
  // The window around the screen takes the screen's own background.
  const ground = root.style.backgroundColor ? styleAttrs(ctx, root, 'background-color', root.style.backgroundColor).map(([k, v]) => `${k}=${v}`) : [];
  lines.push('  view', ...elementLines(2, 'main', ['testId="app"', 'width="100%"', 'height="100%"', ...scheme, ...ground]), '      scroll height="100%"', ...view, '');
  const contract = lines.join('\n');

  const tamber = ctx.usedTokens.size
    ? ['tamber brand', '', comment(`The tokens of the Bogen file that ${title} uses.`), 'theme', ...[...ctx.usedTokens].sort().map((n) => `  ${tamberLines.get(n)}`), ''].join('\n')
    : '';
  if (modes.length > 1) {
    const other = modes.filter((m) => !m.base && m.name !== dark).map((m) => m.name);
    if (dark) ctx.notes.add(`The ${dark} mode is each colour token's dark side, through light-dark().`);
    if (other.length) ctx.dropped.push({ layer: rootId, name: root.name, what: 'modes', value: other.join(', '), reason: 'Only the base mode and a dark mode are exported. Tamber has axes for modes a person picks.' });
  }
  for (const t of ctx.usedTokens) {
    const token = ctx.designTokens.get(t);
    if (token?.kind === 'font-family') for (const f of familyValue(token.value)?.split(',') ?? []) ctx.families.add(f.trim().replace(/^"|"$/g, ''));
  }
  const named = [...ctx.families].filter((f) => f && !/^(serif|sans-serif|monospace|system-ui|cursive|ui-sans-serif|ui-serif|ui-monospace)$/.test(f));
  if (named.length) ctx.notes.add(`Fonts are named, not bundled: ${named.join(', ')}. Declare each with a font block and its files under assets/ to ship it.`);

  const slug = slugOf(title);
  const id = `com.example.${slug.replace(/-/g, '')}`;
  const app = {
    name: title, short_name: title, id, start_url: '/', display: 'standalone',
    app: { id, name: title },
    host: { web: {} },
    deploy: { store: { web: '0' } },
  };
  const test = ctx.firstText
    ? ['test "the screen shows its text"', '  expect tree has "screen"', `  expect text "${ctx.firstText.testId}" == ${contractString(ctx.firstText.text)}`, '']
    : ['test "the screen is there"', '  expect tree has "screen"', ''];
  // A press that counts, where a text shows the count: tap it once.
  for (const inc of ctx.increments) {
    const shown = ctx.shownBy.get(inc.variable);
    const press = ctx.testIdOf.get(inc.layer) ?? (inc.layer === rootId ? 'screen' : undefined);
    const start = Number(ctx.variables.get(inc.variable)?.value);
    const next = start + inc.by;
    if (!shown || !press || !Number.isInteger(next)) continue;
    test.push(`test "${press.replace(/"/g, '')} adds ${inc.by}"`, `  tap "${press}"`, `  expect text "${shown}" == "${next}"`, '');
    break;
  }
  const ts = [
    comment(`${title}: the app's data. The exported screen asks for none yet: add a source here and a`),
    comment('`resource` in app.contract when it needs some. `bun exact.mjs contract types app.contract -o app.contract.d.ts`'),
    comment('writes the types this file imports.'),
    "import type { Answer, Sources } from './app.contract.d.ts';",
    '',
    "export const grants = '';",
    '',
    'const sources: Sources = {};',
    '',
    'export const answer: Answer = (source, args, store, storage, native) =>',
    '  sources[source](args, store, storage, native);',
    '',
  ].join('\n');
  return {
    name: slug,
    title,
    files: {
      'app.contract': contract,
      'app.ts': ts,
      'app.json': `${JSON.stringify(app, null, 2)}\n`,
      'app.test.contract': test.join('\n'),
      ...(tamber ? { 'app.tamber': tamber } : {}),
    },
    assets: [...ctx.assets.values()],
    dropped: ctx.dropped,
    notes: [...ctx.notes],
    commit: EXACT_COMMIT,
  };
}

/**
 * The app as one text: each file under a header comment, then what was left out. What `code_get` and the Code tab
 * show. `resolve` turns a picture's source into where to fetch it, such as Bogen's asset URL.
 */
export function exactAppText(app: ExactApp, resolve?: (src: string) => string): string {
  const parts = [
    `// Exact app "${app.title}" (experimental, written against Exact ${app.commit.slice(0, 12)}). Save each file below in a folder named ${app.name}.`,
  ];
  for (const [path, text] of Object.entries(app.files)) parts.push(`// ---- ${path}\n${text.trimEnd()}`);
  if (app.assets.length) parts.push(`// ---- assets: copy each picture to its path\n${app.assets.map((a) => `// ${a.path} from ${a.src.startsWith('data:') ? 'an inline picture in the design' : (resolve ?? ((x: string) => x))(a.src)}`).join('\n')}`);
  const lost = app.dropped.filter((d) => !d.approximated);
  const near = app.dropped.filter((d) => d.approximated);
  const line = (d: ExactDrop) => `//   ${d.name} (${d.layer}): ${d.what}${d.value ? ` ${JSON.stringify(d.value)}` : ''}. ${d.reason}`;
  if (lost.length) parts.push(`// ---- left out (${lost.length})\n${lost.map(line).join('\n')}`);
  if (near.length) parts.push(`// ---- written approximately (${near.length})\n${near.map(line).join('\n')}`);
  if (app.notes.length) parts.push(`// ---- notes\n${app.notes.map((n) => `//   ${n}`).join('\n')}`);
  return `${parts.join('\n\n')}\n`;
}
