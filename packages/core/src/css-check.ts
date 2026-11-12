import { parse as parseColor } from 'culori';
import { kebabCss } from './css.ts';
import type { NewNode } from './doc.ts';
import data from './css-properties.json';

/**
 * A check of single declarations for what a browser would drop: a property it does not know, or a value of the wrong
 * kind for the properties agents write most. Conservative on purpose: what it cannot judge without a browser, such
 * as a shorthand or anything with var(), passes.
 */

const KNOWN = new Set(data.properties);
const GLOBAL = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const DIMENSION = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]+)$/i;
const LENGTH_UNITS = new Set(['px', 'em', 'rem', '%', 'vw', 'vh', 'vmin', 'vmax', 'vi', 'vb', 'svw', 'svh', 'lvw', 'lvh', 'dvw', 'dvh', 'svi', 'svb', 'lvi', 'lvb', 'dvi', 'dvb', 'ch', 'ex', 'cap', 'ic', 'lh', 'rlh', 'rex', 'rch', 'ric', 'rcap', 'cm', 'mm', 'q', 'in', 'pt', 'pc', 'cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax']);

/** Splits a value at top-level spaces, commas and slashes, keeping functions and strings whole. */
function tokens(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  const flush = () => {
    if (cur) out.push(cur);
    cur = '';
  };
  for (const c of value.trim()) {
    if (quote) {
      cur += c;
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '(') {
      depth++;
      cur += c;
    } else if (c === ')') {
      depth--;
      cur += c;
    } else if (depth === 0 && /\s/.test(c)) flush();
    else if (depth === 0 && (c === ',' || c === '/')) {
      flush();
      out.push(c);
    } else cur += c;
  }
  flush();
  return out;
}

function balanced(value: string): boolean {
  let depth = 0;
  let quote = '';
  for (const c of value) {
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0 && !quote;
}

const isFunction = (t: string) => /^[a-z-]+\(.*\)$/is.test(t);

type Kind = 'length' | 'color' | 'number' | 'weight' | 'keyword';
interface Rule { kind: Kind; max?: number; keywords?: string[]; slash?: boolean; negative?: boolean; percent?: boolean }

const SIZE = ['auto', 'fit-content', 'min-content', 'max-content', 'stretch', '-webkit-fill-available'];
const ALIGN = ['normal', 'stretch', 'center', 'start', 'end', 'flex-start', 'flex-end', 'self-start', 'self-end', 'left', 'right', 'baseline', 'first', 'last', 'safe', 'unsafe', 'space-between', 'space-around', 'space-evenly', 'anchor-center'];

const RULES: Record<string, Rule> = {};
const rule = (props: string[], r: Rule) => { for (const p of props) RULES[p] = r; };
rule(['width', 'height', 'minWidth', 'minHeight', 'blockSize', 'inlineSize', 'minBlockSize', 'minInlineSize'], { kind: 'length', keywords: SIZE });
rule(['maxWidth', 'maxHeight', 'maxBlockSize', 'maxInlineSize'], { kind: 'length', keywords: [...SIZE, 'none'] });
rule(['top', 'right', 'bottom', 'left'], { kind: 'length', keywords: ['auto'], negative: true });
rule(['inset', 'margin', 'marginInline', 'marginBlock'], { kind: 'length', max: 4, keywords: ['auto'], negative: true });
rule(['marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'marginInlineStart', 'marginInlineEnd', 'marginBlockStart', 'marginBlockEnd'], { kind: 'length', keywords: ['auto'], negative: true });
rule(['padding', 'paddingInline', 'paddingBlock'], { kind: 'length', max: 4 });
rule(['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'paddingInlineStart', 'paddingInlineEnd', 'paddingBlockStart', 'paddingBlockEnd'], { kind: 'length' });
rule(['gap'], { kind: 'length', max: 2, keywords: ['normal'], negative: true });
rule(['rowGap', 'columnGap'], { kind: 'length', keywords: ['normal'], negative: true });
rule(['borderRadius'], { kind: 'length', max: 4, slash: true });
rule(['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'], { kind: 'length', max: 2 });
rule(['borderWidth'], { kind: 'length', max: 4, keywords: ['thin', 'medium', 'thick'] });
rule(['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'outlineWidth'], { kind: 'length', keywords: ['thin', 'medium', 'thick'] });
rule(['outlineOffset', 'textIndent'], { kind: 'length', negative: true });
rule(['letterSpacing', 'wordSpacing'], { kind: 'length', keywords: ['normal'], negative: true });
rule(['fontSize'], { kind: 'length', keywords: ['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large', 'smaller', 'larger', 'math'] });
rule(['flexBasis'], { kind: 'length', keywords: [...SIZE, 'content'] });
rule(['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor', 'textDecorationColor', 'caretColor', 'accentColor', 'columnRuleColor'], { kind: 'color', keywords: ['auto', 'invert'] });
rule(['borderColor'], { kind: 'color', max: 4 });
rule(['opacity'], { kind: 'number', percent: true });
rule(['flexGrow', 'flexShrink', 'order'], { kind: 'number' });
rule(['zIndex'], { kind: 'number', keywords: ['auto'] });
rule(['fontWeight'], { kind: 'weight' });
rule(['display'], { kind: 'keyword', max: 3, keywords: ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'flow-root', 'none', 'contents', 'table', 'table-row', 'table-cell', 'table-column', 'table-row-group', 'table-header-group', 'table-footer-group', 'table-column-group', 'table-caption', 'inline-table', 'list-item', 'flow', 'run-in', 'ruby', 'ruby-text', 'math', '-webkit-box', '-webkit-inline-box', 'masonry', 'inline-masonry'] });
rule(['position'], { kind: 'keyword', keywords: ['static', 'relative', 'absolute', 'fixed', 'sticky'] });
rule(['flexDirection'], { kind: 'keyword', keywords: ['row', 'row-reverse', 'column', 'column-reverse'] });
rule(['flexWrap'], { kind: 'keyword', keywords: ['nowrap', 'wrap', 'wrap-reverse'] });
rule(['justifyContent', 'alignItems', 'alignSelf', 'alignContent', 'justifyItems', 'justifySelf', 'placeItems', 'placeContent', 'placeSelf'], { kind: 'keyword', max: 4, keywords: [...ALIGN, 'auto', 'legacy'] });
rule(['textAlign'], { kind: 'keyword', keywords: ['left', 'right', 'center', 'justify', 'start', 'end', 'match-parent', '-webkit-center', '-webkit-left', '-webkit-right'] });
rule(['overflow'], { kind: 'keyword', max: 2, keywords: ['visible', 'hidden', 'clip', 'scroll', 'auto', 'overlay'] });
rule(['overflowX', 'overflowY'], { kind: 'keyword', keywords: ['visible', 'hidden', 'clip', 'scroll', 'auto', 'overlay'] });
rule(['boxSizing'], { kind: 'keyword', keywords: ['content-box', 'border-box'] });
rule(['visibility'], { kind: 'keyword', keywords: ['visible', 'hidden', 'collapse'] });
rule(['whiteSpace'], { kind: 'keyword', max: 2, keywords: ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces', 'collapse', 'preserve', 'preserve-breaks', 'preserve-spaces', 'wrap', 'balance', 'pretty', 'stable'] });
rule(['textTransform'], { kind: 'keyword', max: 3, keywords: ['none', 'capitalize', 'uppercase', 'lowercase', 'full-width', 'full-size-kana', 'math-auto'] });
rule(['fontStyle'], { kind: 'keyword', max: 2, keywords: ['normal', 'italic', 'oblique'] });
rule(['objectFit'], { kind: 'keyword', keywords: ['fill', 'contain', 'cover', 'none', 'scale-down'] });

const WEIGHTS = new Set(['normal', 'bold', 'bolder', 'lighter']);

function lengthToken(t: string, r: Rule): string | null {
  if (t === '0' || r.keywords?.includes(t) || isFunction(t)) return null;
  if (NUMBER.test(t)) return `${t} needs a unit, such as ${t}px`;
  const m = DIMENSION.exec(t);
  if (!m) return `${t} is not a length`;
  if (!LENGTH_UNITS.has(m[2]!.toLowerCase())) return `${m[2]} is not a unit of length`;
  if (!r.negative && Number(m[1]) < 0) return `${t} cannot be negative`;
  return null;
}

function colorToken(t: string, r: Rule): string | null {
  const lower = t.toLowerCase();
  if (lower === 'currentcolor' || lower === 'transparent' || r.keywords?.includes(lower)) return null;
  // Mixes, light-dark() and relative colours are for a browser to resolve.
  if (/^(color-mix|light-dark|contrast-color|-webkit-)/.test(lower) || /\bfrom\b/.test(lower)) return null;
  return parseColor(t) ? null : `${t} is not a colour`;
}

/** Why a browser would drop this declaration, or null if it would keep it (or this cannot tell). Takes camelCase names. */
export function cssDeclarationProblem(prop: string, value: string): string | null {
  if (prop.startsWith('--')) return null;
  const name = kebabCss(prop);
  if (!/^-(webkit|moz|ms|o)-/.test(name) && !KNOWN.has(name)) return 'not a CSS property';
  const v = value.trim();
  if (!v) return 'an empty value';
  if (!balanced(v)) return 'an unclosed bracket or quote';
  const lower = v.toLowerCase();
  // A {{field}} of live data (layer_repeat) is only a value once a record fills it in.
  if (GLOBAL.has(lower) || /\b(var|env|attr|if)\(/i.test(v) || /\{\{/.test(v)) return null;
  const r = RULES[prop];
  if (!r) return null;
  const parts = tokens(v);
  for (const t of parts) {
    if (t === '/' && r.slash) continue;
    if (t === ',' || t === '/') return `${t} does not belong in ${name}`;
    let problem: string | null = null;
    if (r.kind === 'length') problem = lengthToken(t.toLowerCase(), r);
    else if (r.kind === 'color') problem = colorToken(t, r);
    else if (r.kind === 'number') problem = NUMBER.test(t) || (r.percent && NUMBER.test(t.replace(/%$/, ''))) || r.keywords?.includes(t.toLowerCase()) || isFunction(t) ? null : `${t} is not a number`;
    else if (r.kind === 'weight') problem = WEIGHTS.has(t.toLowerCase()) || isFunction(t) || (NUMBER.test(t) && Number(t) >= 1 && Number(t) <= 1000) ? null : `${t} is not a font weight: use 100 to 900, normal or bold`;
    else if (!r.keywords!.includes(t.toLowerCase())) problem = `${t} is not a value of ${name}`;
    if (problem) return problem;
  }
  if (r.slash ? parts.filter((p) => p !== '/').length > r.max! * 2 || parts.filter((p) => p === '/').length > 1 : parts.length > (r.max ?? 1)) return `too many values for ${name}`;
  return null;
}

/** Takes out of a style what a browser would drop, and says what went and why. */
export function dropInvalidDeclarations(style: Record<string, string>, where: string): string[] {
  const out: string[] = [];
  for (const [prop, value] of Object.entries(style)) {
    const problem = cssDeclarationProblem(prop, value);
    if (!problem) continue;
    delete style[prop];
    out.push(`${kebabCss(prop)}: ${value} on ${where} (${problem})`);
  }
  return out;
}

/** The same for layers about to be written, their own styles and their pseudo-element and condition blocks. */
export function dropInvalidCss(specs: NewNode[]): string[] {
  const out: string[] = [];
  const walk = (spec: NewNode) => {
    const where = `<${spec.tag ?? spec.type}>${spec.name ? ` "${spec.name.slice(0, 40)}"` : ''}`;
    if (spec.style) out.push(...dropInvalidDeclarations(spec.style, where));
    for (const [block, style] of Object.entries(spec.rules ?? {})) {
      out.push(...dropInvalidDeclarations(style, `${where} ${block}`));
      if (!Object.keys(style).length) delete spec.rules![block];
    }
    for (const child of spec.children ?? []) walk(child);
  };
  for (const spec of specs) walk(spec);
  return out;
}
