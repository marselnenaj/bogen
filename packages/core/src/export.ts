import type { BogenDoc, BogenNode } from './doc.ts';
import { fluidPageStyle, jsxBooleanAttr, renderSpec, type AssetResolver } from './render.ts';
import { cleanRuleStyle, colorSchemeOf, layerRulesCss, orderedBlocks, ruleScopeClass, type LayerRules, type RuleAt } from './layer-rules.ts';
import { kebabCss } from './css.ts';
import type { TextRun } from './rich-text.ts';
import { getTextStyles } from './design-system.ts';
import { codeUsageJsx, withCodeImports } from './code-components.ts';
import { FRAMER_IMPORT, motionHandoff, withMotionConfig, type MotionHandoff, type MotionLayer, type MotionMode } from './motion.ts';
import { BIND_VARIANT, BIND_VISIBLE, dataDeclarations, fieldAccess, placeholderExpr, placeholderJsx, repeatPlan, type RepeatPlan } from './repeat.ts';

export type JsxMode = 'inline' | 'tailwind';

const ATTR_RENAMES: Record<string, string> = { class: 'className', for: 'htmlFor', colspan: 'colSpan', rowspan: 'rowSpan', autoplay: 'autoPlay', playsinline: 'playsInline', datetime: 'dateTime', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', minlength: 'minLength', autocomplete: 'autoComplete', inputmode: 'inputMode', enterkeyhint: 'enterKeyHint', spellcheck: 'spellCheck', fetchpriority: 'fetchPriority', popovertarget: 'popoverTarget', popovertargetaction: 'popoverTargetAction' };
const VOID = new Set(['img', 'input', 'hr', 'br', 'video', 'iframe']);

function jsString(text: string): string {
  return JSON.stringify(text);
}

function jsxText(text: string): string {
  if (!/[{}<>&]/.test(text) && !text.includes('\n')) return text;
  return text.split('\n').map((line) => `{${jsString(line)}}`).join('<br />');
}

const SPACING: Record<string, string> = { padding: 'p', paddingTop: 'pt', paddingRight: 'pr', paddingBottom: 'pb', paddingLeft: 'pl', paddingInline: 'px', paddingBlock: 'py', margin: 'm', marginTop: 'mt', marginRight: 'mr', marginBottom: 'mb', marginLeft: 'ml', marginInline: 'mx', marginBlock: 'my', gap: 'gap', rowGap: 'gap-y', columnGap: 'gap-x', width: 'w', height: 'h', minWidth: 'min-w', minHeight: 'min-h', maxWidth: 'max-w', maxHeight: 'max-h', top: 'top', right: 'right', bottom: 'bottom', left: 'left' };
const KEYWORDS: Record<string, Record<string, string>> = {
  display: { flex: 'flex', grid: 'grid', block: 'block', 'inline-flex': 'inline-flex', 'inline-block': 'inline-block', inline: 'inline', none: 'hidden', 'inline-grid': 'inline-grid' },
  flexDirection: { row: 'flex-row', column: 'flex-col', 'row-reverse': 'flex-row-reverse', 'column-reverse': 'flex-col-reverse' },
  flexWrap: { wrap: 'flex-wrap', nowrap: 'flex-nowrap', 'wrap-reverse': 'flex-wrap-reverse' },
  alignItems: { center: 'items-center', 'flex-start': 'items-start', 'flex-end': 'items-end', stretch: 'items-stretch', baseline: 'items-baseline', start: 'items-start', end: 'items-end' },
  justifyContent: { center: 'justify-center', 'flex-start': 'justify-start', 'flex-end': 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly', start: 'justify-start', end: 'justify-end' },
  position: { absolute: 'absolute', relative: 'relative', fixed: 'fixed', sticky: 'sticky', static: 'static' },
  overflow: { hidden: 'overflow-hidden', auto: 'overflow-auto', scroll: 'overflow-scroll', visible: 'overflow-visible', clip: 'overflow-clip' },
  textAlign: { left: 'text-left', center: 'text-center', right: 'text-right', justify: 'text-justify', start: 'text-start', end: 'text-end' },
  fontStyle: { italic: 'italic', normal: 'not-italic' },
  textTransform: { uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', none: 'normal-case' },
  textDecoration: { underline: 'underline', none: 'no-underline', 'line-through': 'line-through' },
  objectFit: { cover: 'object-cover', contain: 'object-contain', fill: 'object-fill', none: 'object-none' },
  whiteSpace: { nowrap: 'whitespace-nowrap', normal: 'whitespace-normal', pre: 'whitespace-pre', 'pre-wrap': 'whitespace-pre-wrap' },
  cursor: { pointer: 'cursor-pointer' },
};
const ARBITRARY: Record<string, string> = { backgroundColor: 'bg', color: 'text', borderRadius: 'rounded', fontSize: 'text', fontWeight: 'font', lineHeight: 'leading', letterSpacing: 'tracking', opacity: 'opacity', zIndex: 'z', borderColor: 'border', borderWidth: 'border', flexGrow: 'grow', flexShrink: 'shrink', flexBasis: 'basis', aspectRatio: 'aspect' };
const VAR = /^var\(--([\w-]+)\)$/;

/** A value inside `[...]`. Tailwind reads `_` as a space, so a real underscore is escaped first. */
function arbitrary(value: string): string {
  return value.replace(/_/g, '\\_').replace(/\s+/g, '_');
}

/** `(--name)` for a token and `[value]` otherwise, with a type hint such as `length` when one is given. */
function tailwindValue(value: string, hint?: string): string {
  const v = VAR.exec(value);
  if (v) return hint ? `(${hint}:--${v[1]})` : `(--${v[1]})`;
  return hint ? `[${hint}:${arbitrary(value)}]` : `[${arbitrary(value)}]`;
}

function spacingValue(prefix: string, value: string): string | null {
  if (value === '100%') return `${prefix}-full`;
  if (value === 'auto') return `${prefix}-auto`;
  if (value === 'fit-content') return `${prefix}-fit`;
  if (value === 'min-content') return `${prefix}-min`;
  if (value === 'max-content') return `${prefix}-max`;
  if (value === '0' || value === '0px') return `${prefix}-0`;
  const negative = value.startsWith('-');
  return `${negative ? '-' : ''}${prefix}-${tailwindValue(negative ? value.slice(1) : value)}`;
}

/** Tailwind classes for a style. Anything without a clean utility stays in `rest`. */
export function styleToTailwind(style: Record<string, string>): { classes: string[]; rest: Record<string, string> } {
  const classes: string[] = [];
  const rest: Record<string, string> = {};
  for (const [key, value] of Object.entries(style)) {
    const keyword = KEYWORDS[key]?.[value];
    const spacing = SPACING[key];
    const prefix = ARBITRARY[key];
    if (keyword) classes.push(keyword);
    else if (spacing) {
      const c = spacingValue(spacing, value);
      if (c) classes.push(c);
      else rest[key] = value;
    } else if (key === 'flexGrow' && value === '1') classes.push('grow');
    else if (prefix) {
      // text-, border- and font- take more than one kind of value, and Tailwind guesses which from the value:
      // text-(--size) is a colour to it and font-[bold] a family. These say which they mean.
      if (key === 'fontSize') classes.push(`text-${tailwindValue(value, 'length')}`);
      else if (key === 'color') classes.push(`text-${VAR.test(value) ? tailwindValue(value) : tailwindValue(value, 'color')}`);
      else if (key === 'borderWidth') classes.push(`border-${tailwindValue(value, 'length')}`);
      else if (key === 'borderColor') classes.push(`border-${tailwindValue(value, 'color')}`);
      else if (key === 'fontWeight') classes.push(`font-${VAR.test(value) || /^\d+$/.test(value) ? tailwindValue(value) : tailwindValue(value, 'weight')}`);
      else classes.push(`${prefix}-${tailwindValue(value)}`);
    } else if (key === 'fontFamily') classes.push(`font-${VAR.test(value) ? tailwindValue(value, 'family-name') : `[family-name:${arbitrary(value.replace(/["']/g, ''))}]`}`);
    else if (key === 'boxShadow') classes.push(`shadow-[${arbitrary(value)}]`);
    else rest[key] = value;
  }
  return { classes, rest };
}

/** What a browser gives headings, which Tailwind's preflight takes away (`font-size: inherit; font-weight: inherit`). */
const HEADING_SIZES: Record<string, string> = { h1: '2em', h2: '1.5em', h3: '1.17em', h4: '1em', h5: '0.83em', h6: '0.67em' };

/**
 * Classes that keep a layer as the canvas draws it in a project with Tailwind's preflight, which the
 * canvas does not have: the root gets back the browser's `line-height: normal` (preflight sets 1.5 on
 * html), a heading its size and weight, and `small` its size, where neither the layer nor its text
 * style says them.
 */
export function preflightClasses(doc: BogenDoc, node: BogenNode, style: Record<string, string>, root: boolean): string[] {
  const out: string[] = [];
  const own = node.textStyle ? getTextStyles(doc).find((s) => s.key === node.textStyle)?.style ?? {} : {};
  const says = (prop: string) => style[prop] !== undefined || own[prop] !== undefined;
  if (root && !says('lineHeight')) out.push('leading-[normal]');
  const size = HEADING_SIZES[node.tag];
  if (size && node.type === 'text') {
    if (!says('fontSize')) out.push(`text-[length:${size}]`);
    if (!says('fontWeight')) out.push('font-[weight:bold]');
  }
  // Preflight makes small 80%; a browser makes it `smaller`.
  if (node.tag === 'small' && !says('fontSize')) out.push('text-[length:smaller]');
  return out;
}

const PSEUDO_VARIANTS: Record<string, string> = { '::before': 'before', '::after': 'after', '::marker': 'marker', '::placeholder': 'placeholder', '::selection': 'selection', '::first-letter': 'first-letter', '::first-line': 'first-line' };
const STATE_VARIANTS: Record<string, string> = { ':hover': 'hover', ':focus': 'focus', ':focus-visible': 'focus-visible', ':focus-within': 'focus-within', ':active': 'active', '[open]': 'open' };

/** The Tailwind variant that says the same as an at-rule, or null. */
function atVariant(at: RuleAt): string | null {
  const q = at.query.trim();
  // A token in a query is resolved by Bogen's own CSS; Tailwind cannot do that.
  if (/var\(|[[\]'"_]/.test(q)) return null;
  const width = /^\((min|max)-width:\s*([\d.]+(?:px|rem|em))\)$/.exec(q);
  // Tailwind's min-[x] is width >= x, as min-width is. Its max-[x] is width < x and leaves out x itself,
  // which max-width keeps, so every other query is written as an arbitrary variant of itself.
  if (width?.[1] === 'min') return at.kind === 'container' ? `@min-[${width[2]}]${at.name ? `/${at.name}` : ''}` : `min-[${width[2]}]`;
  if (at.kind === 'container') return at.name ? `[@container_${at.name}_${arbitrary(q)}]` : `[@container${q.startsWith('(') ? '' : '_'}${arbitrary(q)}]`;
  if (colorSchemeOf(q) === 'dark') return 'dark';
  if (/^\(prefers-reduced-motion:\s*reduce\)$/.test(q)) return 'motion-reduce';
  if (/^\(prefers-reduced-motion:\s*no-preference\)$/.test(q)) return 'motion-safe';
  if (q === 'print') return 'print';
  return `[@media${q.startsWith('(') ? '' : '_'}${arbitrary(q)}]`;
}

/**
 * A layer's rules as Tailwind classes with variants, such as `before:content-['+']` or `@max-[560px]:hidden`,
 * where a variant says the same. A block no variant can say stays for a style sheet, in `rest`. A property
 * the layer also has inline gets `!`, as the inline value would win otherwise.
 */
export function rulesToTailwind(rules: LayerRules | undefined, inline: Record<string, string> = {}): { classes: string[]; rest: LayerRules } {
  const classes: string[] = [];
  const rest: LayerRules = {};
  for (const block of orderedBlocks(rules ?? {})) {
    const style = cleanRuleStyle(rules![block.key] ?? {});
    const variants: string[] = [];
    const at = block.at ? atVariant(block.at) : '';
    if (at === null || block.state?.parent) {
      rest[block.key] = style;
      continue;
    }
    if (at) variants.push(at);
    if (block.state) variants.push(STATE_VARIANTS[block.state.name]!);
    if (block.pseudo) variants.push(PSEUDO_VARIANTS[block.pseudo]!);
    const left: Record<string, string> = {};
    for (const [prop, value] of Object.entries(style)) {
      if (/[[\]`]/.test(value)) {
        left[prop] = value;
        continue;
      }
      let cls: string | undefined;
      if (prop === 'content') {
        const text = /^"([^"']*)"$/.exec(value);
        cls = text ? `content-['${arbitrary(text[1]!)}']` : /'/.test(value) ? undefined : `content-[${arbitrary(value)}]`;
      } else {
        const tw = styleToTailwind({ [prop]: value });
        cls = tw.classes.length === 1 ? tw.classes[0] : /'/.test(value) ? undefined : `[${kebabCss(prop)}:${arbitrary(value)}]`;
      }
      if (!cls) left[prop] = value;
      else classes.push(`${variants.join(':')}:${cls}${prop in inline ? '!' : ''}`);
    }
    if (Object.keys(left).length) rest[block.key] = left;
  }
  return { classes, rest };
}

/**
 * What a layer's rules become in JSX: class names to add and the CSS they need. With Tailwind, what a
 * variant can say is a class; the rest, and everything in inline mode, is CSS for a style element,
 * written for the layer's scope class, which is dropped when no CSS is left for it.
 */
export function jsxRules(node: BogenNode, mode: JsxMode, inline: Record<string, string>): { classes: string[]; dropScope: boolean; css: string } {
  if (!node.rules || node.hidden) return { classes: [], dropScope: false, css: '' };
  if (mode === 'inline') return { classes: [], dropScope: false, css: layerRulesCss(node.id, node.rules) };
  const { classes, rest } = rulesToTailwind(node.rules, inline);
  const css = layerRulesCss(node.id, rest);
  return { classes, dropScope: !css, css };
}

/** Takes the scope class out of a class list and adds others. */
export function withRuleClasses(className: string | undefined, id: string, rules: { classes: string[]; dropScope: boolean }): string | undefined {
  const scope = ruleScopeClass(id);
  const list = (className ?? '').split(/\s+/).filter((c) => c && !(rules.dropScope && c === scope));
  list.push(...rules.classes);
  return list.length ? list.join(' ') : undefined;
}

/** Wraps a component's markup with the style element its rules need. */
export function withRulesStyle(jsx: string, css: string[], depth: number): string {
  const text = [...new Set(css.filter(Boolean))].join('\n');
  if (!text) return jsx;
  const pad = '  '.repeat(depth);
  return `${pad}<>\n${pad}  <style>{${jsString(text)}}</style>\n${jsx.replace(/^/gm, '  ')}\n${pad}</>`;
}

function pascal(name: string): string {
  const parts = name.replace(/[^\w\s-]/g, ' ').split(/[\s_-]+/).filter(Boolean);
  const out = parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
  return /^[A-Z]/.test(out) ? out : `Layer${out}`;
}

function styleLiteral(style: Record<string, string>, expressions: Record<string, string> = {}): string {
  const entries = [...Object.entries(style).map(([k, v]) => [k, jsString(v)] as const), ...Object.entries(expressions)].map(([k, v]) => {
    const key = /^[a-zA-Z]\w*$/.test(k) ? k : jsString(k);
    return `${key}: ${v}`;
  });
  return `{{ ${entries.join(', ')} }}`;
}

/** Code export of designs with live data: the plan of the file's repeats, the templates used, and the record in scope. */
export interface JsxData {
  plan: RepeatPlan;
  used: Set<string>;
  item?: string;
  /** The key expression for the root of a mapped template. */
  key?: string;
  /** A template, shown in code although it is hidden on the canvas. */
  unhide?: string;
}

/** Where a data-bound layer reads its values while code is written for it. */
function boundLayer(node: BogenNode, item: string | undefined): { node: BogenNode; src?: string; attrs: Record<string, string>; style: Record<string, string>; text?: string; visible?: string } {
  const out = { node, attrs: {} as Record<string, string>, style: {} as Record<string, string> } as ReturnType<typeof boundLayer>;
  if (!item) return out;
  const marks = (v: string | undefined) => Boolean(v && v.includes('{{'));
  let shown: BogenNode = node;
  if (marks(node.src)) {
    out.src = placeholderExpr(node.src!, item);
    shown = { ...shown, src: '#' };
  }
  const style: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.style)) if (marks(v)) out.style[k] = placeholderExpr(v, item); else style[k] = v;
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.attrs ?? {})) {
    if (k === BIND_VISIBLE) out.visible = fieldAccess(item, v.trim());
    else if (marks(v)) out.attrs[k] = placeholderExpr(v, item);
    else attrs[k] = v;
  }
  if (node.type === 'text' && marks(node.text) && !node.spans?.length) out.text = placeholderJsx(node.text!, item);
  out.node = { ...shown, style, attrs };
  return out;
}

/** One range of a rich text layer. Plain runs stay bare text between the others. */
function runToJsx(run: TextRun, mode: JsxMode): string {
  const props: string[] = [];
  if (run.href) props.push(`href=${jsString(run.href)}`);
  if (mode === 'tailwind') {
    const { classes, rest } = styleToTailwind(run.style);
    if (classes.length) props.push(`className=${jsString(classes.join(' '))}`);
    if (Object.keys(rest).length) props.push(`style=${styleLiteral(rest)}`);
  } else if (Object.keys(run.style).length) props.push(`style=${styleLiteral(run.style)}`);
  const body = run.text.split('\n').map((line) => (/[{}<>&]/.test(line) || /^\s|\s$/.test(line) ? `{${jsString(line)}}` : line)).join('<br />');
  if (!props.length) return body;
  const tag = run.href ? 'a' : 'span';
  return `<${tag} ${props.join(' ')}>${body}</${tag}>`;
}

/**
 * What motion handoff does to one element: its moving properties leave the inline style, it takes the
 * class that carries them, and with Framer Motion it becomes `motion.<tag>` with its props.
 */
export function applyMotion(node: BogenNode, moving: MotionLayer | undefined, tag: string, style: Record<string, string>, attrs: Record<string, string>): { node: BogenNode; tag: string; props: string[] } {
  if (!moving) return { node, tag, props: [] };
  for (const k of moving.strip) delete style[k];
  if (moving.className) attrs.class = [attrs.class, moving.className].filter(Boolean).join(' ');
  let rules = node.rules;
  if (rules && moving.dropBlocks?.length) {
    rules = Object.fromEntries(Object.entries(rules).filter(([k]) => !moving.dropBlocks!.includes(k)));
    if (!Object.keys(rules).length) rules = undefined;
  }
  const next = rules === node.rules ? node : { ...node, ...(rules ? { rules } : { rules: undefined }) };
  return { node: next, tag: moving.framer ? `motion.${tag}` : tag, props: moving.framer ?? [] };
}

function nodeToJsx(doc: BogenDoc, raw: BogenNode, mode: JsxMode, resolve: AssetResolver | undefined, depth: number, isRoot: boolean, css: string[], data?: JsxData, key?: string, motion?: MotionHandoff): string {
  if (raw.code) return codeUsageJsx(raw.code, '  '.repeat(depth));
  const bound = boundLayer(raw, data?.item);
  const given = bound.node;
  const spec = renderSpec(given, resolve);
  delete spec.attrs[BIND_VISIBLE];
  delete spec.attrs[BIND_VARIANT];
  if (bound.src) delete spec.attrs.src;
  for (const k of Object.keys(bound.attrs)) delete spec.attrs[k];
  const pad = '  '.repeat(depth);
  const style = { ...spec.style };
  if (isRoot) for (const k of ['position', 'left', 'top', 'right', 'bottom']) delete style[k];
  if (isRoot) {
    // A page handed to code is as wide as the window, up to its design width.
    const fluid = fluidPageStyle(given, style);
    for (const k of Object.keys(style)) if (!(k in fluid)) delete style[k];
    Object.assign(style, fluid);
  }
  const moved = applyMotion(given, motion?.layers.get(given.id), spec.tag, style, spec.attrs);
  const node = moved.node;
  spec.tag = moved.tag;
  const rules = jsxRules(node, mode, mode === 'tailwind' ? styleToTailwind(style).rest : style);
  if (node.rules || given.rules) {
    css.push(rules.css);
    const className = withRuleClasses(spec.attrs.class, node.id, node.rules ? rules : { classes: [], dropScope: true });
    if (className) spec.attrs.class = className;
    else delete spec.attrs.class;
  }
  const props: string[] = key ? [`key={${key}}`] : [];
  for (const [k, v] of Object.entries(spec.attrs)) {
    const name = ATTR_RENAMES[k] ?? k;
    const bare = v === '' ? jsxBooleanAttr(k) : null;
    props.push(v === '' && !bare ? name : `${name}=${jsString(bare ?? v)}`);
  }
  for (const [k, v] of Object.entries(bound.attrs)) props.push(`${ATTR_RENAMES[k] ?? k}={${v}}`);
  if (bound.src) props.push(`src={${bound.src}}`);
  if (mode === 'tailwind') {
    const { classes, rest } = styleToTailwind(style);
    classes.push(...preflightClasses(doc, node, style, isRoot));
    // A text style's class comes through the attributes, and one element takes one className.
    const named = props.findIndex((p) => p.startsWith('className='));
    const own = named >= 0 ? [JSON.parse(props.splice(named, 1)[0]!.slice('className='.length)) as string] : [];
    if (classes.length || own.length) props.push(`className=${jsString([...own, ...classes].join(' '))}`);
    if (Object.keys(rest).length || Object.keys(bound.style).length) props.push(`style=${styleLiteral(rest, bound.style)}`);
  } else if (Object.keys(style).length || Object.keys(bound.style).length) props.push(`style=${styleLiteral(style, bound.style)}`);
  props.push(...moved.props);
  const open = `${pad}<${spec.tag}${props.length ? ` ${props.join(' ')}` : ''}`;
  const out = (() => {
    if (bound.text !== undefined) return `${open}>${bound.text}</${spec.tag}>`;
    if (spec.runs) return `${open}>${spec.runs.map((r) => runToJsx(r, mode)).join('')}</${spec.tag}>`;
    if (spec.html !== undefined) return `${open} dangerouslySetInnerHTML={{ __html: ${jsString(spec.html)} }} />`;
    if (VOID.has(spec.tag)) return `${open} />`;
    if (spec.text !== undefined) return `${open}>${jsxText(spec.text)}</${spec.tag}>`;
    const children = doc.getChildren(node.id).filter((c) => !data?.plan.copies.has(c.id));
    if (!children.length) return `${open} />`;
    return `${open}>\n${children.map((c) => childJsx(doc, c, mode, resolve, depth + 1, css, data, motion)).join('\n')}\n${pad}</${spec.tag}>`;
  })();
  if (bound.visible) return `${pad}{${bound.visible} && (\n${out.replace(/^/gm, '  ')}\n${pad})}`;
  return out;
}

/** A child, or for a repeat's template the code that maps its data. Its copies are the data, so they stay out. */
function childJsx(doc: BogenDoc, child: BogenNode, mode: JsxMode, resolve: AssetResolver | undefined, depth: number, css: string[], data: JsxData | undefined, motion?: MotionHandoff): string {
  const t = data && !data.item ? data.plan.templates.get(child.id) : undefined;
  if (!data || !t) return nodeToJsx(doc, child, mode, resolve, depth, false, css, data, undefined, motion);
  data.used.add(child.id);
  const shown = { ...child, hidden: false };
  const pad = '  '.repeat(depth);
  if (t.single) return nodeToJsx(doc, shown, mode, resolve, depth, false, css, { ...data, item: t.list }, undefined, motion);
  return `${pad}{${t.list}.map((item, i) => (\n${nodeToJsx(doc, shown, mode, resolve, depth + 1, false, css, { ...data, item: 'item' }, 'i', motion)}\n${pad}))}`;
}

/**
 * A layer as a React component, with inline styles or Tailwind classes. Motion stays inline by default;
 * `css` moves it to classes in the component's style element, and `framer` writes Framer Motion props.
 */
export function toJsx(doc: BogenDoc, id: string, mode: JsxMode = 'tailwind', resolve?: AssetResolver, motionMode: MotionMode = 'inline'): string {
  const node = doc.getNode(id);
  if (!node) throw new Error(`No layer with id ${id}.`);
  const css: string[] = [];
  const motion = motionHandoff(doc, [id], motionMode);
  const data: JsxData = { plan: repeatPlan(doc), used: new Set() };
  const jsx = nodeToJsx(doc, node, mode, resolve, 2, true, css, data, undefined, motion);
  if (motion.css) css.push(motion.css);
  const framer = motion.mode === 'framer' && motion.layers.size > 0;
  const declarations = dataDeclarations(data.plan, data.used);
  const body = withRulesStyle(jsx, css, 2);
  const code = withCodeImports(doc, id, `${declarations ? `${declarations}\n\n` : ''}export function ${pascal(node.name)}() {\n  return (\n${framer ? withMotionConfig(body, 2) : body}\n  );\n}\n`);
  return framer ? `${FRAMER_IMPORT}\n${code.startsWith('import') ? '' : '\n'}${code}` : code;
}
