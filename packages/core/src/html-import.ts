import { parseDocument } from 'htmlparser2';
import { is as matches, selectAll } from 'css-select';
import render from 'dom-serializer';
import { Element, Text, isTag, isText, type ChildNode } from 'domhandler';
import { camelCss, parseStyle, styleToCss } from './css.ts';
import type { NewNode, NodeType, TextSpan } from './doc.ts';
import { nameFromClass, nameSpecTree } from './layer-names.ts';
import { cleanSpanStyle, normalizeSpans } from './rich-text.ts';
import { cleanRuleStyle, parseBlock, PSEUDO_ELEMENTS, type LayerRules } from './layer-rules.ts';

const SKIPPED = new Set(['script', 'noscript', 'template', 'meta', 'link', 'title', 'head', 'base', 'object', 'applet']);
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'del', 'dfn', 'em', 'i', 'ins', 'kbd', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr']);
const VOID_FORM = new Set(['input', 'select', 'textarea', 'progress', 'meter']);
export const KEPT_ATTRS = new Set(['alt', 'href', 'target', 'rel', 'type', 'placeholder', 'value', 'for', 'aria-label', 'role', 'title', 'colspan', 'rowspan', 'poster', 'loop', 'muted', 'autoplay', 'controls', 'datetime', 'open', 'data-crop', 'data-bind-visible', 'data-bind-variant']);

const NAME = /^[A-Za-z][\w-]{0,100}$/;
const NUMBER = /^-?\d{1,6}(\.\d{1,4})?$/;
/**
 * Attributes a real website needs for structure, forms, images and accessible behaviour without script: anchors and
 * labels (`id`, `aria-*`), the popover API for menus and dialogs, exclusive `<details name>` for tabs and accordions,
 * focus order, form constraints, and image loading. Each is checked by value; none can run code or load anything.
 */
const WEB_ATTRS: Record<string, RegExp> = {
  id: NAME, name: NAME, form: NAME, list: NAME, popovertarget: NAME, headers: /^[A-Za-z][\w -]{0,200}$/,
  tabindex: /^-?\d{1,3}$/, popover: /^(|auto|manual|hint)$/, popovertargetaction: /^(show|hide|toggle)$/,
  loading: /^(lazy|eager)$/, decoding: /^(async|sync|auto)$/, fetchpriority: /^(high|low|auto)$/, width: /^\d{1,5}$/, height: /^\d{1,5}$/,
  lang: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/, dir: /^(ltr|rtl|auto)$/, scope: /^(row|col|rowgroup|colgroup)$/,
  required: /^(|required)$/, disabled: /^(|disabled)$/, readonly: /^(|readonly)$/, checked: /^(|checked)$/, selected: /^(|selected)$/, multiple: /^(|multiple)$/,
  reversed: /^(|reversed)$/, start: /^-?\d{1,6}$/, min: NUMBER, max: NUMBER, step: /^(any|\d{1,6}(\.\d{1,4})?)$/, minlength: /^\d{1,6}$/, maxlength: /^\d{1,6}$/,
  autocomplete: /^[a-z0-9 -]{1,60}$/, inputmode: /^(none|text|decimal|numeric|tel|search|email|url)$/, enterkeyhint: /^(enter|done|go|next|previous|search|send)$/,
  spellcheck: /^(true|false)$/, 'data-web': /^page$/, 'data-description': /^[^<>"]{1,300}$/, pattern: /^[^<>]{1,200}$/, accept: /^[\w.,+/* -]{1,200}$/, rows: /^\d{1,4}$/, cols: /^\d{1,4}$/, size: /^\d{1,4}$/,
};

/** Whether a layer may keep this attribute with this value. `aria-*` take any plain text. */
export function keptAttr(name: string, value = ''): boolean {
  if (KEPT_ATTRS.has(name)) return true;
  if (/^aria-[a-z]+$/.test(name)) return value.length <= 500 && !/[<>]/.test(value);
  const rule = WEB_ATTRS[name];
  return Boolean(rule?.test(value));
}

/** The names `keptAttr` takes, for messages. */
export const WEB_ATTR_NAMES: readonly string[] = Object.keys(WEB_ATTRS);
/**
 * Marks what a template shows rather than designs: `dont`, a deliberate wrong example in a brand guideline, and
 * `specimen`, a part shown to document it, such as every button variant or every step of a type scale. Only trusted
 * code such as a template may write it, so an agent cannot hide its own layers from a check.
 */
export const COUNTER_EXAMPLE_ATTR = 'data-brand-example';
export const BRAND_EXAMPLE_VALUES: readonly string[] = ['dont', 'specimen'];

const SAFE_URL = /^(https?:|data:image\/(?!svg)|data:video\/|bogen-asset:|\/|\.|#|mailto:|tel:)/i;

export function safeUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const trimmed = url.replace(/[\u0000- ]+/g, '');
  return SAFE_URL.test(trimmed) ? url.trim() : undefined;
}

function isSafeUrlValue(value: string): boolean {
  return !/expression\s*\(|javascript:|@import/i.test(value);
}

/** Names a shader must not pass on: its parameters become React props in the shader runtime. */
const SHADER_RESERVED = new Set(['style', 'class', 'classname', 'ref', 'key', 'children', 'dangerouslysetinnerhtml']);

export interface AttrVerdict {
  clean: Record<string, string>;
  rejected: { name: string; reason: string }[];
  /** On an svg layer: attributes for its root `<svg>` element, by their SVG names. */
  svg?: Record<string, string>;
}

/**
 * Attributes an svg layer's root `<svg>` may be given after the fact: geometry and presentation only.
 * SVG names are case-sensitive, so a name is looked up without case and stored as SVG spells it.
 * Size is not here: the layer's own width and height place it, and the svg fills the layer.
 */
const SVG_ROOT_ATTRS = new Map(['viewBox', 'preserveAspectRatio', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color', 'overflow', 'clip-rule', 'shape-rendering', 'vector-effect'].map((n) => [n.toLowerCase(), n]));
const SVG_VALUE: Record<string, RegExp> = {
  viewBox: /^\s*-?[\d.]+(?:e-?\d+)?(?:[\s,]+-?[\d.]+(?:e-?\d+)?){3}\s*$/i,
  preserveAspectRatio: /^\s*(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:\s+(?:meet|slice))?\s*$/,
};
// Numbers, keywords, colours and a reference to a gradient in the same SVG; nothing that reaches out.
const SVG_PLAIN_VALUE = /^(?:[\w\s.,#%()+-]|url\(#[\w-]+\))*$/;

/** The SVG name for an attribute an svg layer's root may take, or undefined. */
export function svgRootAttr(name: string): string | undefined {
  return SVG_ROOT_ATTRS.get(name.toLowerCase());
}

/** Sets or removes (null) attributes on the root `<svg>` of stored markup, and sanitizes the result. */
export function setSvgRootAttrs(markup: string, attrs: Record<string, string | null>): string {
  const root = parseDocument(markup, { xmlMode: true }).children.find((c): c is Element => isTag(c) && c.name.toLowerCase() === 'svg');
  if (!root) return sanitizeSvgMarkup(markup);
  for (const [name, value] of Object.entries(attrs)) {
    const key = svgRootAttr(name);
    if (!key) continue;
    for (const k of Object.keys(root.attribs)) if (k.toLowerCase() === key.toLowerCase()) delete root.attribs[k];
    if (value !== null) root.attribs[key] = value;
  }
  return sanitizeSvg(root);
}

/**
 * The attribute rules `renderSpec` applies to stored documents, for checking a write up front: a
 * caller learns what would be dropped at render time instead of storing it.
 */
export function checkAttrs(type: NodeType, attrs: Record<string, string>): AttrVerdict {
  const clean: Record<string, string> = {};
  const svg: Record<string, string> = {};
  const rejected: AttrVerdict['rejected'] = [];
  for (const [name, value] of Object.entries(attrs)) {
    const refuse = (reason: string) => rejected.push({ name, reason });
    if (/^on/i.test(name)) refuse('Event handlers are not allowed. Designs are static HTML and CSS.');
    else if (!isSafeUrlValue(value)) refuse('The value contains something that could run code.');
    else if (type === 'shader') {
      if (!/^[a-zA-Z][\w-]*$/.test(name) || SHADER_RESERVED.has(name.toLowerCase())) refuse('This is not a shader parameter.');
      else if (name === 'image' && !safeUrl(value)) refuse('This URL scheme is not allowed.');
      else clean[name] = value;
    } else if (type === 'svg' && !KEPT_ATTRS.has(name) && svgRootAttr(name)) {
      const key = svgRootAttr(name)!;
      const pattern = SVG_VALUE[key];
      if (value.length > 500 || (pattern ? !pattern.test(value) : !SVG_PLAIN_VALUE.test(value)) || /url\(/i.test(value.replace(/url\(#[\w-]+\)/g, ''))) refuse(`This is not a ${key} value.`);
      else svg[key] = value;
    } else if (type === 'svg' && (name === 'width' || name === 'height')) {
      // Kept for images and media; on an svg layer it would land on the wrapper and size nothing.
      refuse(`An svg layer is sized by its own width and height. Size it with layer_style, such as {"${name}":"24px"}.`);
    } else if (!keptAttr(name, value)) refuse(WEB_ATTRS[name] ? `${value} is not a value ${name} takes here.` : `Only these attributes are kept: ${[...KEPT_ATTRS, ...WEB_ATTR_NAMES].join(', ')}, and aria-*${type === 'svg' ? `, and on the svg itself ${[...SVG_ROOT_ATTRS.values()].join(', ')}. Size it with layer_style` : ''}.`);
    else if ((name === 'href' || name === 'poster') && !safeUrl(value)) refuse('This URL scheme is not allowed. Use http, https, mailto, tel, a path, or an anchor.');
    else clean[name] = value;
  }
  return { clean, rejected, ...(Object.keys(svg).length ? { svg } : {}) };
}

const KEYFRAMES = /^@(?:-webkit-)?keyframes\s+["']?([\w-]+)["']?\s*\{([\s\S]*)\}$/i;

/** The name of a well-formed `@keyframes` block, or null. Documents can come from other people, and this text goes into a style element. */
export function keyframesName(block: string): string | null {
  const match = KEYFRAMES.exec(block.trim());
  if (!match) return null;
  const body = match[2]!;
  if (/[<@\\]/.test(body) || !isSafeUrlValue(body)) return null;
  let depth = 0;
  for (const c of body) {
    if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return null;
    if (depth > 1) return null;
  }
  return depth === 0 ? match[1]! : null;
}

export { agentMentions } from './runners.ts';

const SVG_ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath', 'defs', 'use', 'symbol', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'filter', 'image', 'marker', 'title', 'desc', 'style', 'animate', 'animatetransform', 'animatemotion', 'mpath', 'switch', 'view', 'a', 'metadata']);

function allowedSvgElement(el: Element): boolean {
  const name = el.name.toLowerCase();
  if (name.startsWith('fe')) return true;
  if (!SVG_ELEMENTS.has(name)) return false;
  // Animating a link target to a script URL gets past attribute checks.
  return !(name.startsWith('animate') && /href/i.test(el.attribs.attributeName ?? el.attribs.attributename ?? ''));
}

function cleanSvg(el: Element): void {
  // Only elements and text survive. Comments and CDATA parse differently under the XML parser
  // used here and the HTML parser that later reads the output, which is how sanitizers get bypassed.
  el.children = el.children.filter((c) => (isTag(c) ? allowedSvgElement(c) : isText(c)));
  if (el.name.toLowerCase() === 'style') {
    for (const c of el.children) if (isText(c) && /@import|expression\s*\(|javascript:|<\//i.test(c.data)) c.data = '';
    el.children = el.children.filter(isText);
  }
  for (const name of Object.keys(el.attribs)) {
    const value = el.attribs[name] ?? '';
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) delete el.attribs[name];
    else if ((lower === 'href' || lower === 'xlink:href') && !value.trim().startsWith('#') && !/^data:image\/(?!svg)/i.test(value.trim())) delete el.attribs[name];
    else if (!isSafeUrlValue(value)) delete el.attribs[name];
  }
  for (const c of el.children) if (isTag(c)) cleanSvg(c);
}

/** Removes scripts, event handlers, and unsafe references from inline SVG. */
export function sanitizeSvg(el: Element, layerScope?: string): string {
  const clone = el.cloneNode(true) as Element;
  cleanSvg(clone);
  // Authored collection artwork opts in: each component instance needs its own paint definitions.
  // A hidden earlier instance must not own the pattern/gradient another instance renders with.
  if (layerScope && clone.attribs['data-bogen-scope'] === 'layer') {
    delete clone.attribs['data-bogen-scope'];
    const prefix = `bogen-${layerScope.replace(/[^a-zA-Z0-9-]/g, (c) => `_${c.codePointAt(0)!.toString(16)}_`)}-`;
    const elements: Element[] = [];
    const visit = (node: Element) => { elements.push(node); for (const child of node.children) if (isTag(child)) visit(child); };
    visit(clone);
    const ids = new Map(elements.filter((node) => node.attribs.id).map((node) => [node.attribs.id!, prefix + node.attribs.id!]));
    const urls = (value: string) => value.replace(/url\(\s*(["']?)#([^\s)"']+)\1\s*\)/g, (all, _quote, id: string) => ids.has(id) ? `url(#${ids.get(id)})` : all);
    for (const node of elements) {
      for (const [name, value] of Object.entries(node.attribs)) {
        if (name === 'id') node.attribs[name] = ids.get(value) ?? value;
        else if ((name === 'href' || name === 'xlink:href') && value.startsWith('#') && ids.has(value.slice(1))) node.attribs[name] = '#' + ids.get(value.slice(1));
        else if (name === 'aria-labelledby' || name === 'aria-describedby') node.attribs[name] = value.replace(/\S+/g, (id) => ids.get(id) ?? id);
        else node.attribs[name] = urls(value);
      }
      if (node.name.toLowerCase() === 'style') for (const child of node.children) if (isText(child)) child.data = urls(child.data);
    }
  }
  return render(clone, { xmlMode: true, selfClosingTags: true });
}

const svgCache = new Map<string, string>();

/** Sanitizes stored markup. Documents can come from other people, so storage is not trusted. */
export function sanitizeSvgMarkup(markup: string, layerScope?: string): string {
  // Unmarked SVG still shares one cache entry across all layers, as it did before.
  const scope = layerScope && markup.includes('data-bogen-scope') ? layerScope : undefined;
  const cacheKey = JSON.stringify([scope ?? null, markup]);
  const cached = svgCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const root = parseDocument(markup, { xmlMode: true }).children.find((c): c is Element => isTag(c) && c.name.toLowerCase() === 'svg');
  const clean = root ? sanitizeSvg(root, scope) : '';
  if (svgCache.size > 2000) svgCache.clear();
  svgCache.set(cacheKey, clean);
  return clean;
}

const BLOCKED_TAGS = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'html', 'head', 'body', 'title', 'template', 'noscript', 'svg', 'math', 'portal', 'slot', 'dialog']);

/** The element a stored tag may become. Anything unknown or active falls back to a div. */
export function safeTag(tag: string): string {
  const t = tag.toLowerCase();
  return /^[a-z][a-z0-9]*$/.test(t) && !BLOCKED_TAGS.has(t) ? t : 'div';
}

interface Rule {
  selector: string;
  style: Record<string, string>;
  specificity: number;
  index: number;
  /** The `@media` or `@container` the rule sits in. */
  at?: string;
}

function specificityOf(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const tags = (selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+(\([^)]*\))?/g, ' ').match(/[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 10000 + classes * 100 + tags;
}

/** Selectors split at commas that are not inside parentheses or brackets, as in `:is(h1, h2) a`. */
function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(prelude.slice(start, i));
      start = i + 1;
    }
  }
  out.push(prelude.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * Rules of a style sheet, with the `@media` or `@container` each one sits in. `@supports` and `@layer`
 * are read through, as the browsers a design is for support what they ask about. A condition inside
 * another condition is more than a layer can hold, and is left out.
 */
function parseRules(css: string, start: number, at?: string): { rules: Rule[]; keyframes: string[]; dropped: string[] } {
  const rules: Rule[] = [];
  const keyframes: string[] = [];
  const dropped: string[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  let index = start;
  while (i < clean.length) {
    const open = clean.indexOf('{', i);
    if (open < 0) break;
    // A statement such as @import or @charset ends at its semicolon and has no block.
    let prelude = clean.slice(i, open).trim();
    const statement = prelude.lastIndexOf(';');
    if (statement >= 0) prelude = prelude.slice(statement + 1).trim();
    let depth = 1;
    let j = open + 1;
    while (j < clean.length && depth > 0) {
      if (clean[j] === '{') depth++;
      else if (clean[j] === '}') depth--;
      j++;
    }
    const body = clean.slice(open + 1, j - 1);
    if (/^@(-webkit-)?keyframes\b/i.test(prelude)) {
      if (!at) keyframes.push(`${prelude}{${body}}`);
    } else if (/^@(media|container)\b/i.test(prelude)) {
      if (at) dropped.push(`${at} ${prelude}`);
      else {
        const inner = parseRules(body, index, prelude.replace(/\s+/g, ' '));
        rules.push(...inner.rules);
        dropped.push(...inner.dropped);
        index += inner.rules.length;
      }
    } else if (/^@(supports|layer)\b/i.test(prelude) && !/\bnot\b/i.test(prelude)) {
      const inner = parseRules(body, index, at);
      rules.push(...inner.rules);
      keyframes.push(...inner.keyframes);
      dropped.push(...inner.dropped);
      index += inner.rules.length;
    } else if (!prelude.startsWith('@')) {
      const style = parseStyle(body);
      for (const selector of splitSelectors(prelude)) {
        if (/:(visited|link|target)\b/.test(selector)) continue;
        rules.push({ selector, style, specificity: specificityOf(selector), index: index++, ...(at ? { at } : {}) });
      }
    }
    i = j;
  }
  return { rules, keyframes, dropped };
}

const STATE_TOKEN = /:(?:hover|focus-visible|focus-within|focus|active)(?![\w-])|\[open\]/g;
const PSEUDO_AT_END = /::?([a-z-]+)$/;

/** A selector as the parts a layer's rules hold: what it matches without its state, which state on which element, and which pseudo-element. */
interface SplitSelector { base: string; pseudo?: string; state?: { name: string; parent: boolean; compound: string; descendant: boolean } }

function splitSelector(selector: string): SplitSelector | null {
  let rest = selector.trim();
  let pseudo: string | undefined;
  const end = PSEUDO_AT_END.exec(rest);
  if (end && (end[0].startsWith('::') || end[1] === 'before' || end[1] === 'after')) {
    pseudo = `::${end[1]}`;
    if (!(PSEUDO_ELEMENTS as readonly string[]).includes(pseudo)) return null;
    rest = rest.slice(0, -end[0].length);
  }
  if (rest.includes('::')) return null;
  // Compounds and the combinators between them, outside parentheses and brackets.
  const compounds: string[] = [];
  const combinators: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && /[\s>+~]/.test(c)) {
      let j = i;
      let comb = ' ';
      while (j < rest.length && /[\s>+~]/.test(rest[j]!)) {
        if (!/\s/.test(rest[j]!)) comb = rest[j]!;
        j++;
      }
      if (current) {
        compounds.push(current);
        combinators.push(comb);
      } else if (comb !== ' ' && compounds.length) combinators[combinators.length - 1] = comb;
      current = '';
      i = j - 1;
      continue;
    }
    current += c;
  }
  if (current) compounds.push(current);
  else combinators.pop();
  if (!compounds.length) {
    if (!pseudo) return null;
    compounds.push('*');
  }
  let state: SplitSelector['state'];
  for (let k = 0; k < compounds.length; k++) {
    const compound = compounds[k]!;
    // A state inside :not() or :has() is not one a layer can hold.
    const outside = compound.replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '()');
    const found = outside.match(STATE_TOKEN) ?? [];
    if (/:(?:hover|focus|active)/.test(compound) && found.length === 0) return null;
    if (!found.length) continue;
    if (found.length > 1 || state) return null;
    const isLast = k === compounds.length - 1;
    const isParent = k === compounds.length - 2 && (combinators[k] === ' ' || combinators[k] === '>');
    if (!isLast && !isParent) return null;
    const without = compound.replace(found[0]!, '') || '*';
    compounds[k] = without;
    state = { name: found[0]!, parent: !isLast, compound: without, descendant: !isLast && combinators[k] === ' ' };
  }
  // `[open] > .x` asks nothing of the parent but its state, so the element may also be at the top of the fragment.
  const first = state?.parent && state.compound === '*' && !state.descendant && compounds.length === 2 ? 1 : 0;
  let base = compounds[first]!;
  for (let k = first + 1; k < compounds.length; k++) base += `${combinators[k - 1] === ' ' ? ' ' : ` ${combinators[k - 1]} `}${compounds[k]}`;
  if (!pseudo && !state) return { base };
  return { base, ...(pseudo ? { pseudo } : {}), ...(state ? { state } : {}) };
}

/** `attr(name)` of an attribute a layer does not keep becomes its text now, as it would read in the browser. */
function resolveAttrs(value: string, el: Element): string {
  return value.replace(/attr\(\s*([\w-]+)\s*\)/g, (whole, name: string) => (KEPT_ATTRS.has(name) ? whole : JSON.stringify(el.attribs[name] ?? '')));
}

export interface ImportResult {
  nodes: NewNode[];
  /** `@keyframes` blocks found in style sheets. */
  keyframes: string[];
  /** Style rules a layer cannot hold, such as a condition inside a condition or a state two levels up. */
  droppedRules: string[];
}

// HTML collapses only ASCII white space: a no-break space (`&nbsp;`) is content and stays.
const hasContent = (n: ChildNode) => !isText(n) || /[^ \t\n\r\f]/.test(n.data);

function collapse(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, ' ');
}

const trimSpace = (text: string) => text.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');

/**
 * How an element treats its white space: `collapse` as HTML does by default, `pre` keeps every space and line break
 * (pre, pre-wrap, break-spaces), `lines` keeps line breaks and collapses the rest (pre-line). Inherited, like the property.
 */
type Spacing = 'collapse' | 'pre' | 'lines';
const PRE_TAGS = new Set(['pre', 'textarea', 'listing', 'xmp', 'plaintext']);

function spacingOf(style: Record<string, string>, tag: string, inherited: Spacing): Spacing {
  const value = (style.whiteSpace ?? style.whiteSpaceCollapse ?? '').trim().toLowerCase();
  if (/^(pre|pre-wrap|break-spaces)$|preserve(?!-breaks)|break-spaces/.test(value)) return 'pre';
  if (/^pre-line$|preserve-breaks/.test(value)) return 'lines';
  if (/^(normal|nowrap)$|^collapse/.test(value)) return 'collapse';
  return PRE_TAGS.has(tag) ? 'pre' : inherited;
}

/** White space the way the element shows it. */
function spaceText(text: string, spacing: Spacing): string {
  if (spacing === 'pre') return text.replace(/\r\n?/g, '\n');
  if (spacing === 'lines') return text.replace(/\r\n?/g, '\n').replace(/[ \t\r\f]+/g, ' ').replace(/ ?\n ?/g, '\n');
  return collapse(text);
}

/** What inline tags mean as range styles. Anything else inline is kept as plain text. */
const INLINE_STYLE: Record<string, Record<string, string>> = {
  b: { fontWeight: '700' }, strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' }, i: { fontStyle: 'italic' }, cite: { fontStyle: 'italic' }, dfn: { fontStyle: 'italic' }, var: { fontStyle: 'italic' },
  u: { textDecorationLine: 'underline' }, ins: { textDecorationLine: 'underline' }, s: { textDecorationLine: 'line-through' }, del: { textDecorationLine: 'line-through' },
  code: { fontFamily: 'monospace' }, kbd: { fontFamily: 'monospace' },
};

/** An inline element's own style as range styles, or null when it does more than a range can (padding, a border, display...). */
function runStyle(style: Record<string, string>): Record<string, string> | null {
  const own = { ...style };
  if (own.textDecoration && /^(none|underline|line-through|overline)( (underline|line-through|overline))*$/.test(own.textDecoration.trim())) {
    own.textDecorationLine ??= own.textDecoration.trim();
    delete own.textDecoration;
  }
  const clean = cleanSpanStyle(own);
  return Object.keys(clean).length === Object.keys(own).length ? clean : null;
}

function inlineText(nodes: ChildNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (isText(n)) out += collapse(n.data);
    else if (isTag(n)) out += n.name === 'br' ? '\n' : inlineText(n.children);
  }
  return out;
}

function decode(text: string): string {
  return text;
}

/** Turns HTML into layer specs. Keeps semantic tags, so export stays meaningful. */
export function importHtml(html: string, options: { counterExamples?: boolean } = {}): ImportResult {
  const dom = parseDocument(html, { decodeEntities: true, recognizeSelfClosing: true, lowerCaseTags: true, lowerCaseAttributeNames: false });
  const applied = new Map<Element, { style: Record<string, string>; weight: Map<string, number> }>();
  // Pseudo-elements, conditions and states, per element and block, the way the layer will hold them.
  const blocks = new Map<Element, Map<string, Record<string, string>>>();
  const keyframes: string[] = [];
  const droppedRules: string[] = [];
  const rules: Rule[] = [];
  for (const el of selectAll('style', dom.children) as Element[]) {
    const parsed = parseRules(inlineText(el.children), rules.length);
    rules.push(...parsed.rules);
    keyframes.push(...parsed.keyframes);
    droppedRules.push(...parsed.dropped);
  }
  rules.sort((a, b) => a.specificity - b.specificity || a.index - b.index);
  for (const rule of rules) {
    const split = splitSelector(rule.selector);
    if (!split) {
      droppedRules.push(rule.selector);
      continue;
    }
    let block: string | undefined;
    if (rule.at || split.pseudo || split.state) {
      // `*::before` or `:focus-visible` on everything is a page's reset, which the canvas has already; on every layer it is noise.
      if (/^[\s*>+~]*$/.test(split.base) && (split.pseudo || split.state)) continue;
      const state = split.state ? `${split.state.parent ? 'parent' : ''}${split.state.name}` : '';
      block = parseBlock([rule.at ?? '', `${state}${split.pseudo ?? ''}`].filter(Boolean).join(' '))?.key;
      if (!block) {
        droppedRules.push(`${rule.at ? `${rule.at} ` : ''}${rule.selector}`);
        continue;
      }
    }
    let matched: Element[];
    try {
      matched = selectAll(split.base, dom.children) as Element[];
    } catch {
      continue;
    }
    for (const el of matched) {
      if (!block) {
        const entry = applied.get(el) ?? { style: {}, weight: new Map() };
        Object.assign(entry.style, rule.style);
        applied.set(el, entry);
        continue;
      }
      // A state on an ancestor further up than the parent would change what it means.
      if (split.state?.descendant) {
        const parent = el.parent;
        try {
          if (!parent || !isTag(parent) || !matches(parent as Element, split.state.compound)) continue;
        } catch {
          continue;
        }
      }
      const own = blocks.get(el) ?? new Map<string, Record<string, string>>();
      const style = own.get(block) ?? {};
      for (const [k, v] of Object.entries(rule.style)) style[k] = k === 'content' ? resolveAttrs(v, el) : v;
      own.set(block, style);
      blocks.set(el, own);
    }
  }

  const rulesOf = (el: Element): LayerRules | undefined => {
    const own = blocks.get(el);
    if (!own) return undefined;
    const out: LayerRules = {};
    for (const [key, style] of own) {
      const clean = cleanRuleStyle(style);
      if (Object.keys(clean).length) out[key] = clean;
    }
    return Object.keys(out).length ? out : undefined;
  };

  const styleOf = (el: Element): Record<string, string> => {
    const merged = { ...(applied.get(el)?.style ?? {}), ...parseStyle(el.attribs.style ?? '') };
    for (const [k, v] of Object.entries(merged)) if (!isSafeUrlValue(v)) delete merged[k];
    return merged;
  };

  const attrsOf = (el: Element): Record<string, string> | undefined => {
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(el.attribs)) {
      if (k === COUNTER_EXAMPLE_ATTR && options.counterExamples && BRAND_EXAMPLE_VALUES.includes(v)) attrs[k] = v;
      if (!keptAttr(k, v)) continue;
      if (k === 'href') {
        const safe = safeUrl(v);
        if (safe) attrs[k] = safe;
      } else attrs[k] = v;
    }
    return Object.keys(attrs).length ? attrs : undefined;
  };

  const nameOf = (el: Element, fallback: string): string => {
    return el.attribs['data-name'] ?? el.attribs['aria-label'] ?? fallback;
  };

  // Inline markup a text layer can hold as ranges: a bold word, a link, a coloured phrase.
  const isRun = (n: ChildNode): boolean => {
    if (!isTag(n) || n.name === 'br') return true;
    // An element with a pseudo-element or a condition needs a layer of its own to hold them, and so does one whose
    // attributes say something a text range cannot carry: an id to link to, aria-current, a tab stop.
    const meaningful = Object.keys(n.attribs).some((k) => k !== 'href' && k !== 'target' && k !== 'rel' && k !== 'title' && k !== 'style' && k !== 'class' && k !== 'data-name' && keptAttr(k, n.attribs[k]));
    return INLINE.has(n.name) && !blocks.has(n) && !meaningful && runStyle(styleOf(n)) !== null && n.children.every(isRun);
  };

  /** Text and ranges of inline content, with white space collapsed the way a browser does. */
  const inlineContent = (nodes: ChildNode[], spacing: Spacing = 'collapse', tag = ''): { text: string; spans: TextSpan[] } => {
    const runs: { style: Record<string, string>; href?: string }[] = [{ style: {} }];
    let text = '';
    const owner: number[] = [];
    const put = (ch: string, run: number) => {
      const last = text.at(-1);
      if (spacing !== 'pre') {
        if (ch === ' ' && (last === undefined || last === ' ' || last === '\n')) return;
        if (ch === '\n' && last === ' ') { text = text.slice(0, -1); owner.pop(); }
      }
      text += ch;
      owner.push(run);
    };
    const walk = (list: ChildNode[], run: number) => {
      for (const n of list) {
        if (isText(n)) {
          const data = spaceText(n.data, spacing);
          for (let i = 0; i < data.length; i++) put(data[i]!, run);
        } else if (isTag(n)) {
          if (n.name === 'br') { put('\n', run); continue; }
          const parent = runs[run]!;
          const href = n.name === 'a' ? safeUrl(n.attribs.href) ?? parent.href : parent.href;
          runs.push({ style: { ...parent.style, ...INLINE_STYLE[n.name], ...runStyle(styleOf(n)) }, ...(href ? { href } : {}) });
          walk(n.children, runs.length - 1);
        }
      }
    };
    walk(nodes, 0);
    // Preformatted text keeps its spaces at both ends. HTML drops the line break right after <pre>, and one at the
    // end shows nothing.
    const start = spacing === 'pre' ? (PRE_TAGS.has(tag) && text.startsWith('\n') ? 1 : 0) : text.length - text.replace(/^\n+/, '').length;
    const end = spacing === 'pre' ? Math.max(start, text.endsWith('\n') ? text.length - 1 : text.length) : text.replace(/[ \n]+$/, '').length;
    const spans: TextSpan[] = [];
    for (let i = start; i < end; i++) {
      const run = runs[owner[i]!]!;
      if (!Object.keys(run.style).length && !run.href) continue;
      const last = spans.at(-1);
      if (last && last.end === i - start && owner[i - 1] === owner[i]) last.end++;
      else spans.push({ start: i - start, end: i - start + 1, style: run.style, ...(run.href ? { href: run.href } : {}) });
    }
    const out = text.slice(start, end);
    return { text: out, spans: normalizeSpans(spans, out.length) };
  };

  const textLayer = (data: string, spaceBefore = false, spaceAfter = false, spacing: Spacing = 'collapse'): NewNode[] => {
    if (spacing === 'pre') {
      // Between boxes, a run of white space alone is only the markup's indentation.
      if (!/[^ \t\n\r\f]/.test(data)) return [];
      const text = spaceText(data, 'pre');
      return [{ type: 'text', tag: 'span', name: text.trim().slice(0, 40), text }];
    }
    const text = trimSpace(spaceText(data, spacing));
    if (!text) return [];
    // Next to an inline sibling, the space is what keeps two words apart.
    const full = `${spaceBefore && /^[ \t\n\r\f]/.test(data) ? ' ' : ''}${text}${spaceAfter && /[ \t\n\r\f]$/.test(data) ? ' ' : ''}`;
    return [{ type: 'text', tag: 'span', name: text.slice(0, 40), text: decode(full) }];
  };
  const inlineTag = (n: ChildNode | undefined) => !!n && isTag(n) && INLINE.has(n.name) && n.name !== 'br';

  const given = new WeakSet<NewNode>();
  const convert = (node: ChildNode, spacing: Spacing = 'collapse'): NewNode[] => {
    const out = convertOne(node, spacing);
    const rules = isTag(node) && out.length === 1 && node.name !== 'html' && node.name !== 'body' ? rulesOf(node) : undefined;
    if (rules) out[0]!.rules = rules;
    return out;
  };
  const convertOne = (node: ChildNode, inherited: Spacing): NewNode[] => {
    if (isText(node)) return textLayer(node.data, false, false, inherited);
    if (!isTag(node)) return [];
    const el = node;
    const tag = el.name.toLowerCase();
    if (tag === 'style' || SKIPPED.has(tag)) return [];
    const style = styleOf(el);
    const spacing = spacingOf(style, tag, inherited);
    if (tag === 'html' || tag === 'body') return el.children.flatMap((c) => convert(c, spacing));

    const attrs = attrsOf(el);

    if (tag === 'svg') {
      for (const key of ['width', 'height'] as const) {
        const v = el.attribs[key];
        if (v && !style[key]) style[key] = /^[\d.]+$/.test(v) ? `${v}px` : v;
      }
      // The layer around it is what sits in the layout. Placed twice, a vector ends up in the wrong spot.
      const own = parseStyle(el.attribs.style ?? '');
      for (const key of ['position', 'left', 'top', 'right', 'bottom', 'inset', 'margin', 'marginLeft', 'marginRight', 'marginTop', 'marginBottom', 'transform', 'translate', 'rotate', 'scale', 'zIndex', 'opacity']) delete own[key];
      if (own.width) own.width = '100%';
      if (own.height) own.height = '100%';
      const inner = styleToCss(own);
      if (inner) el.attribs.style = inner;
      else delete el.attribs.style;
      return [{ type: 'svg', tag: 'svg', name: nameOf(el, 'Vector'), style, svg: sanitizeSvg(el) }];
    }
    if (tag === 'img') {
      const src = safeUrl(el.attribs.src) ?? (/^\{\{\s*[\w.$-]+\s*\}\}$/.test(el.attribs.src ?? '') ? el.attribs.src : undefined);
      for (const key of ['width', 'height'] as const) {
        const v = el.attribs[key];
        if (v && !style[key]) style[key] = /^[\d.]+$/.test(v) ? `${v}px` : v;
      }
      return [{ type: 'image', tag: 'img', name: nameOf(el, el.attribs.alt || 'Image'), style, ...(src ? { src } : {}), ...(attrs ? { attrs } : {}) }];
    }
    if (tag === 'video') {
      const src = safeUrl(el.attribs.src ?? (el.children.find((c) => isTag(c) && c.name === 'source') as Element | undefined)?.attribs.src);
      return [{ type: 'video', tag: 'video', name: nameOf(el, 'Video'), style, ...(src ? { src } : {}), ...(attrs ? { attrs } : {}) }];
    }
    if (tag === 'iframe') {
      const src = safeUrl(el.attribs.src);
      return [{ type: 'embed', tag: 'iframe', name: nameOf(el, 'Embed'), style, ...(src ? { src } : {}) }];
    }
    if (tag === 'x-shader') {
      const { style: _ignored, 'data-name': _name, ...params } = el.attribs;
      return [{ type: 'shader', tag: 'div', name: nameOf(el, params.type ?? 'Shader'), style, attrs: params }];
    }
    if (tag === 'x-instance') {
      // Which component it means is settled when it is written to a file: see resolveInstanceRefs.
      const props: Record<string, string> = {};
      for (const [k, v] of Object.entries(el.attribs)) if (k.startsWith('prop-')) props[k.slice(5)] = v;
      const kids = el.children.flatMap((c) => {
        const out = convert(c, spacing);
        const slot = isTag(c) ? c.attribs.slot : undefined;
        return slot ? out.map((n) => ({ ...n, slotRef: slot })) : out;
      });
      return [{ type: 'frame', tag: 'div', name: el.attribs['data-name'] ?? 'Instance', style, instanceRef: el.attribs.component ?? '', props, ...(kids.length ? { children: kids } : {}) }];
    }
    if (VOID_FORM.has(tag) || tag === 'hr') {
      return [{ type: 'frame', tag, name: nameOf(el, tag), style, ...(attrs ? { attrs } : {}) }];
    }

    const children = el.children.filter(hasContent);
    // A lone styled child stays a layer of its own; mixed with text, it becomes a range.
    const lone = children.length === 1 && isTag(children[0]!) && Object.keys(styleOf(children[0] as Element)).length > 0;
    const onlyInline = !lone && children.every(isRun);
    // Children of a flex or grid container are boxes, even when their tags are inline.
    const laysOutChildren = /flex|grid/.test(style.display ?? '') && children.some(isTag);
    if (children.length > 0 && onlyInline && !laysOutChildren) {
      const { text, spans } = inlineContent(el.children, spacing, tag);
      // A text layer wraps unless told otherwise, and <pre> does not.
      if (spacing === 'pre' && !style.whiteSpace && !style.whiteSpaceCollapse && (tag === 'pre' || tag === 'listing' || tag === 'xmp')) style.whiteSpace = 'pre';
      return [{ type: 'text', tag, name: nameOf(el, text.trim().slice(0, 40)), style, text, ...(spans.length ? { spans } : {}), ...(attrs ? { attrs } : {}), ...(el.attribs['text-style'] ? { textStyle: el.attribs['text-style'] } : {}) }];
    }

    const kids = el.children.flatMap((c, i) => (isText(c) && !laysOutChildren ? textLayer(c.data, inlineTag(el.children[i - 1]), inlineTag(el.children[i + 1]), spacing) : convert(c, spacing)));
    const frame: NewNode = { type: 'frame', tag, name: nameOf(el, nameFromClass(el.attribs.class) ?? FRAME_NAMES[tag] ?? 'Frame'), style, ...(attrs ? { attrs } : {}), ...(el.attribs['data-slot'] !== undefined ? { slotName: el.attribs['data-slot'] || 'content' } : {}), children: kids };
    if (el.attribs['data-name'] ?? el.attribs['aria-label']) given.add(frame);
    return [frame];
  };

  return { nodes: dom.children.flatMap((c) => convert(c)).map((n) => nameSpecTree(n, false, given)), keyframes, droppedRules };
}

const FRAME_NAMES: Record<string, string> = { nav: 'Navigation', header: 'Header', footer: 'Footer', section: 'Section', main: 'Main', aside: 'Sidebar', article: 'Article', ul: 'List', ol: 'List', li: 'Item', button: 'Button', a: 'Link', form: 'Form', table: 'Table' };

export { camelCss, Text };
