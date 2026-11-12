import { readBrand } from './brand.ts';
import type { BogenDoc, BogenNode, NewNode } from './doc.ts';
import { getTextStyles } from './design-system.ts';
import { splitCssList } from './css.ts';
import { blockKey, parseBlock } from './layer-rules.ts';

/**
 * Responsive variants of an artboard: from a wide design, what it becomes at narrower widths. Either as
 * `@media (max-width: …)` blocks on the same layers, which is what code wants, or as linked artboards next
 * to it that the same call updates again later. Pure rules over stored styles; the server lays the result
 * out afterwards to say what still sticks out.
 *
 * What it does, per layer: flex rows wrap or stack, grids lose columns, type steps down the type scale,
 * padding and gap step down the spacing scale, images keep their aspect ratio, fixed widths give way, and
 * a navigation row collapses to a menu button.
 */

export type ResponsiveMethod = 'rules' | 'artboards';

export interface ResponsiveOptions {
  /** Target widths, narrower than the artboard. Default 768 and 390. */
  widths?: number[];
  method?: ResponsiveMethod;
}

/** One target width and the media query that carries it. */
export interface ResponsiveStep { width: number; query: string; block: string }

export interface ResponsiveChange { id: string; width: number; style: Record<string, string>; why: string[] }

export interface ResponsivePlan {
  source: number;
  steps: ResponsiveStep[];
  /** Per width, what changes on which layer. Narrower widths add to wider ones, as the cascade does. */
  changes: ResponsiveChange[];
  /** Navigation rows that collapse, by width: the row to hide, and where the menu button goes. */
  menus: { width: number; links: string; parent: string; index: number }[];
  notes: string[];
}

export interface ResponsiveResult {
  method: ResponsiveMethod;
  steps: ResponsiveStep[];
  /** For linked artboards: the artboard per width. For rules, the source for every width. */
  artboards: { width: number; id: string; updated: boolean }[];
  layers: number;
  menuButtons: string[];
  notes: string[];
}

const DEFAULT_WIDTHS = [768, 390];
const TYPE_SCALE = [12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72, 96, 128];
const SPACE_SCALE = [0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 160];
const MIN_TYPE = 16;
const LINK_FIELD = 'responsive';
/** Marks a menu button this made, so that running it again replaces it. */
const MENU_FIELD = 'responsiveMenu';

interface Step { px: number; token?: string }

class Values {
  private tokens: Map<string, string>;
  readonly type: Step[];
  readonly space: Step[];
  readonly breakpoints: Step[];

  constructor(doc: BogenDoc) {
    const all = doc.getTokens();
    this.tokens = new Map(all.map((t) => [t.name, t.value]));
    const brand = readBrand(doc);
    const scale = (kind: string, extra: Step[], fallback: number[]): Step[] => {
      const steps = new Map<number, Step>();
      for (const s of extra) if (!steps.has(s.px)) steps.set(s.px, s);
      for (const t of all) {
        if (t.kind !== kind) continue;
        const px = this.px(`var(--${t.name})`);
        if (px !== undefined && px >= 0 && !steps.get(px)?.token) steps.set(px, { px, token: t.name });
      }
      const list = [...steps.values()].sort((a, b) => a.px - b.px);
      return list.length >= 3 ? list : fallback.map((px) => ({ px }));
    };
    const brandType = brand.typeScale.filter((t) => !t.suggested && t.size > 0).map((t) => ({ px: t.size, ...(this.tokens.has(t.token) ? { token: t.token } : {}) }));
    for (const s of getTextStyles(doc)) {
      const px = this.px(s.style.fontSize ?? '');
      if (px) brandType.push({ px });
    }
    this.type = scale('font-size', brandType, TYPE_SCALE);
    const brandSpace = brand.spacing.filter((s) => !s.suggested && s.value >= 0).map((s) => ({ px: s.value, ...(this.tokens.has(s.token) ? { token: s.token } : {}) }));
    this.space = scale('spacing', brandSpace, SPACE_SCALE);
    this.breakpoints = all.filter((t) => t.kind === 'breakpoint').flatMap((t) => {
      const px = this.px(`var(--${t.name})`);
      return px ? [{ px, token: t.name }] : [];
    });
  }

  /** A length in px, through tokens, or undefined when it is not one. */
  px(value: string, depth = 0): number | undefined {
    const v = value.trim();
    const token = /^var\(\s*--([\w-]+)\s*(?:,[^)]*)?\)$/.exec(v);
    if (token) {
      const next = this.tokens.get(token[1]!);
      return next !== undefined && depth < 4 ? this.px(next, depth + 1) : undefined;
    }
    const m = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(v);
    if (!m) return undefined;
    const n = Number(m[1]);
    return m[2] === 'rem' || m[2] === 'em' ? n * 16 : m[2] || n === 0 ? n : undefined;
  }

  /**
   * A step of the scale below a value: the one nearest to `factor` times it, no lower than `min`, and
   * never above `cap`. With a factor of 1 only the cap moves it. Null when it stays.
   */
  stepDown(value: string, scale: Step[], factor: number, min: number, cap = Infinity): string | null {
    const px = this.px(value);
    if (px === undefined || px <= 0) return null;
    const floor = Math.min(min, px);
    const lower = scale.filter((s) => s.px < px - 0.5 && s.px >= floor);
    if (!lower.length) return null;
    const target = Math.min(px * factor, cap);
    if (factor >= 1 && px <= cap) return null;
    // The nearest step, the larger one on a tie, as a gentler change reads better.
    let best = lower.reduce((a, b) => (Math.abs(b.px - target) <= Math.abs(a.px - target) ? b : a));
    if (best.px > cap) best = [...lower].reverse().find((s) => s.px <= cap) ?? lower[0]!;
    return best.token ? `var(--${best.token})` : `${best.px}px`;
  }
}

/** Where each target width's rules start applying: midway to the next wider width, or a breakpoint token there. */
export function responsiveSteps(source: number, widths: number[], breakpoints: Step[] = []): ResponsiveStep[] {
  const sorted = [...new Set(widths.map((w) => Math.round(w)))].filter((w) => w >= 200 && w < source).sort((a, b) => b - a);
  const out: ResponsiveStep[] = [];
  let wider = source;
  for (const width of sorted) {
    const middle = (width + wider) / 2;
    const token = breakpoints.filter((b) => b.px >= width && b.px < wider).sort((a, b) => Math.abs(a.px - middle) - Math.abs(b.px - middle))[0];
    const at = token ? token.px : Math.round(middle / 8) * 8;
    const query = `(max-width: ${token ? `var(--${token.token})` : `${at}px`})`;
    const key = blockKey(`@media ${query}`, undefined);
    if ('key' in key) out.push({ width, query, block: key.key });
    wider = width;
  }
  return out;
}

const INLINE_TAGS = new Set(['a', 'button', 'span', 'img', 'svg', 'small', 'strong', 'em', 'label', 'li', 'code', 'kbd', 'time', 'abbr']);

function isInlineish(n: BogenNode, kids: (id: string) => BogenNode[]): boolean {
  if (n.type === 'svg' || n.type === 'image') return true;
  if (n.type === 'text') return (n.text ?? '').length <= 40;
  if (INLINE_TAGS.has(n.tag)) return kids(n.id).every((k) => k.type !== 'frame' || INLINE_TAGS.has(k.tag));
  return false;
}

function isLink(n: BogenNode): boolean {
  return n.tag === 'a' || Boolean(n.attrs?.href) || n.proto?.link !== undefined || n.tag === 'li' && n.type === 'text';
}

function columnCount(template: string): { count: number; auto?: { kind: string; min: string } } | null {
  const t = template.trim();
  const rep = /^repeat\(\s*(\d+|auto-fit|auto-fill)\s*,\s*(.+)\)$/.exec(t);
  if (rep) {
    if (/^\d+$/.test(rep[1]!)) return { count: Number(rep[1]) };
    const min = /^minmax\(\s*([^,]+?)\s*,/.exec(rep[2]!.trim());
    return min ? { count: 0, auto: { kind: rep[1]!, min: min[1]! } } : null;
  }
  if (/repeat\(/.test(t) || !t || t === 'none') return null;
  return { count: splitCssList(t, ' ').filter((p) => !/^\[.*\]$/.test(p)).length };
}

interface Ctx {
  doc: BogenDoc;
  values: Values;
  width: number;
  ratio: number;
  root: string;
  method: ResponsiveMethod;
  /** What a wider step already changed, by layer. */
  before: Map<string, Record<string, string>>;
  out: Map<string, { style: Record<string, string>; why: Set<string> }>;
  menus: ResponsivePlan['menus'];
  notes: Set<string>;
  kids: (id: string) => BogenNode[];
}

function set(ctx: Ctx, id: string, prop: string, value: string, why: string): void {
  const node = ctx.doc.getNode(id);
  const current = ctx.before.get(id)?.[prop] ?? node?.style[prop];
  if (current === value) return;
  let entry = ctx.out.get(id);
  if (!entry) ctx.out.set(id, (entry = { style: {}, why: new Set() }));
  entry.style[prop] = value;
  entry.why.add(why);
}

/** The value a layer has at this step so far: what a wider step set, or its own. */
function styleAt(ctx: Ctx, n: BogenNode, prop: string): string | undefined {
  return ctx.out.get(n.id)?.style[prop] ?? ctx.before.get(n.id)?.[prop] ?? n.style[prop];
}

const PHONE = 0.4;
const TABLET = 0.75;

/** How far type steps down at a width: large type most, body text not at all. */
function typeFactor(ctx: Ctx, px: number): number {
  if (ctx.ratio <= PHONE) return px >= 40 ? 0.66 : px >= 22 ? 0.8 : 1;
  if (ctx.ratio <= TABLET) return px >= 32 ? 0.84 : 1;
  return px >= 56 ? 0.9 : 1;
}

function spaceFactor(ctx: Ctx, px: number): number {
  if (ctx.ratio <= PHONE) return px >= 48 ? 0.5 : px >= 20 ? 0.67 : 1;
  if (ctx.ratio <= TABLET) return px >= 32 ? 0.75 : 1;
  return px >= 64 ? 0.85 : 1;
}

function deriveType(ctx: Ctx, n: BogenNode): void {
  const size = n.style.fontSize ?? (n.textStyle ? getTextStyles(ctx.doc).find((s) => s.key === n.textStyle)?.style.fontSize : undefined);
  if (n.type === 'text' && n.style.whiteSpace === 'nowrap' && (n.text ?? '').length > 24) set(ctx, n.id, 'whiteSpace', 'normal', 'long text wraps');
  if (!size) return;
  const px = ctx.values.px(size);
  if (!px) return;
  const factor = typeFactor(ctx, px);
  if (factor >= 1) return;
  const next = ctx.values.stepDown(size, ctx.values.type, factor, MIN_TYPE);
  if (!next) return;
  set(ctx, n.id, 'fontSize', next, 'type steps down the scale');
  const line = n.style.lineHeight;
  const linePx = line && /px$|rem$/.test(line.trim()) ? ctx.values.px(line) : undefined;
  const nextPx = ctx.values.px(next);
  if (linePx && nextPx) set(ctx, n.id, 'lineHeight', `${Math.round((linePx * nextPx) / px)}px`, 'type steps down the scale');
}

const PADDING_SIDES: Record<string, 'inline' | 'block'> = { paddingLeft: 'inline', paddingRight: 'inline', paddingInline: 'inline', paddingTop: 'block', paddingBottom: 'block', paddingBlock: 'block' };

function deriveSpacing(ctx: Ctx, n: BogenNode): void {
  const inlineCap = Math.max(16, ctx.width * 0.065);
  const blockCap = Math.max(24, ctx.width * 0.16);
  const step = (value: string, cap: number) => {
    const px = ctx.values.px(value);
    if (px === undefined) return null;
    return ctx.values.stepDown(value, ctx.values.space, spaceFactor(ctx, px), 0, cap);
  };
  const padding = n.style.padding;
  if (padding) {
    const parts = splitCssList(padding, ' ');
    if (parts.length >= 1 && parts.length <= 4) {
      const full = [parts[0]!, parts[1] ?? parts[0]!, parts[2] ?? parts[0]!, parts[3] ?? parts[1] ?? parts[0]!];
      const next = full.map((p, i) => step(p, i % 2 ? inlineCap : blockCap) ?? p);
      if (next.some((p, i) => p !== full[i])) {
        const [t, r, b, l] = next as [string, string, string, string];
        const short = t === b && r === l ? (t === r ? t : `${t} ${r}`) : r === l ? `${t} ${r} ${b}` : `${t} ${r} ${b} ${l}`;
        set(ctx, n.id, 'padding', short, 'padding steps down the spacing scale');
      }
    }
  }
  for (const [prop, side] of Object.entries(PADDING_SIDES)) {
    const v = n.style[prop];
    if (!v || splitCssList(v, ' ').length !== 1) continue;
    const next = step(v, side === 'inline' ? inlineCap : blockCap);
    if (next) set(ctx, n.id, prop, next, 'padding steps down the spacing scale');
  }
  for (const prop of ['gap', 'rowGap', 'columnGap']) {
    const v = n.style[prop];
    if (!v) continue;
    const parts = splitCssList(v, ' ');
    const next = parts.map((p) => step(p, Math.max(16, ctx.width * 0.08)) ?? p);
    if (next.some((p, i) => p !== parts[i])) set(ctx, n.id, prop, next.join(' '), 'gap steps down the spacing scale');
  }
}

function deriveSize(ctx: Ctx, n: BogenNode, parent: BogenNode | undefined): void {
  const available = ctx.width - 32;
  const width = ctx.values.px(n.style.width ?? '');
  const height = ctx.values.px(n.style.height ?? '');
  const media = n.type === 'image' || n.type === 'video' || n.tag === 'img' || n.tag === 'video';
  if (media && width && height) {
    set(ctx, n.id, 'aspectRatio', `${Math.round(width)} / ${Math.round(height)}`, 'images keep their aspect ratio');
    set(ctx, n.id, 'height', 'auto', 'images keep their aspect ratio');
    if (!n.style.maxWidth) set(ctx, n.id, 'maxWidth', '100%', 'images keep their aspect ratio');
  }
  if (width && width > available && n.style.position !== 'absolute' && n.style.position !== 'fixed') {
    set(ctx, n.id, 'width', '100%', 'a fixed width gives way');
    if (!n.style.maxWidth && !media) set(ctx, n.id, 'maxWidth', `${Math.round(width)}px`, 'a fixed width gives way');
  }
  const minWidth = ctx.values.px(n.style.minWidth ?? '');
  if (minWidth && minWidth > available * 0.6) set(ctx, n.id, 'minWidth', '0', 'a fixed width gives way');
  if (!media && n.type === 'frame' && height && ctx.kids(n.id).length && n.style.position !== 'absolute') {
    set(ctx, n.id, 'height', 'auto', 'content decides the height');
    if (height > 120 && !n.style.minHeight) set(ctx, n.id, 'minHeight', `${Math.round(Math.max(height * ctx.ratio, Math.min(height, 240)))}px`, 'content decides the height');
  }
  if (n.style.position === 'absolute') {
    const left = ctx.values.px(n.style.left ?? '');
    if ((left && left + (width ?? 0) > ctx.width) || (width && width > available)) ctx.notes.add(`"${n.name}" is placed absolutely and goes past ${ctx.width}: check it by hand.`);
  }
  void parent;
}

function isNav(n: BogenNode): boolean {
  return n.tag === 'nav' || /\bnav(igation)?\b|\bmenu\b/i.test(n.name);
}

/** A row of three or more links, which becomes a menu button. */
function linksRow(ctx: Ctx, n: BogenNode): boolean {
  const display = styleAt(ctx, n, 'display');
  if (display !== 'flex' && display !== 'inline-flex') return false;
  const kids = ctx.kids(n.id).filter((k) => !k.hidden);
  if (kids.length < 3) return false;
  const links = kids.filter((k) => isLink(k) || ctx.kids(k.id).some(isLink));
  return links.length >= 3 && links.length >= kids.length - 1;
}

function deriveNav(ctx: Ctx, n: BogenNode, inNav: boolean): boolean {
  if (!(inNav || isNav(n)) || !linksRow(ctx, n)) return false;
  const count = ctx.kids(n.id).length;
  // On a phone every navigation row collapses; on a tablet only a long one.
  if (ctx.ratio > PHONE && count < 6) return false;
  if (ctx.before.get(n.id)?.display === 'none') return true;
  const parent = ctx.doc.getNode(n.parent);
  if (!parent || n.id === ctx.root) return false;
  set(ctx, n.id, 'display', 'none', 'navigation collapses to a menu button');
  // The menu button goes last in the bar, where people look for it.
  ctx.menus.push({ width: ctx.width, links: n.id, parent: parent.id, index: ctx.kids(parent.id).length });
  return true;
}

function deriveFlex(ctx: Ctx, n: BogenNode): void {
  const display = n.style.display;
  if (display !== 'flex' && display !== 'inline-flex') return;
  const direction = styleAt(ctx, n, 'flexDirection') ?? 'row';
  if (direction.startsWith('column')) return;
  const kids = ctx.kids(n.id).filter((k) => !k.hidden && k.style.position !== 'absolute');
  if (kids.length < 2) return;
  // A bar of a header or a navigation stays a row: it wraps, and its links fold into a menu on a phone.
  const bar = n.tag === 'header' || isNav(n) || kids.some((k) => isNav(k) || linksRow(ctx, k));
  const inline = bar || kids.every((k) => isInlineish(k, ctx.kids));
  if (inline) {
    if (styleAt(ctx, n, 'flexWrap') !== 'wrap') set(ctx, n.id, 'flexWrap', 'wrap', 'flex rows wrap');
    return;
  }
  const fixed = kids.reduce((sum, k) => sum + (ctx.values.px(k.style.width ?? '') ?? ctx.values.px(k.style.flexBasis ?? '') ?? 0), 0);
  const gap = ctx.values.px(n.style.columnGap ?? n.style.gap ?? '') ?? 0;
  const needs = fixed + gap * (kids.length - 1);
  if (ctx.ratio <= PHONE || (kids.length === 2 && needs > ctx.width)) {
    set(ctx, n.id, 'flexDirection', direction === 'row-reverse' ? 'column-reverse' : 'column', 'flex rows stack');
    if (n.style.flexWrap) set(ctx, n.id, 'flexWrap', 'nowrap', 'flex rows stack');
    const align = n.style.alignItems;
    if (align && align !== 'stretch' && n.style.justifyContent !== 'center') set(ctx, n.id, 'alignItems', 'stretch', 'flex rows stack');
    for (const k of kids) {
      const before = ctx.before.get(k.id);
      if (before?.flex || ctx.values.px(k.style.flexBasis ?? '') || (k.style.flex && /\d+px/.test(k.style.flex))) set(ctx, k.id, 'flex', '0 0 auto', 'flex rows stack');
    }
    return;
  }
  if (kids.length >= 3) {
    set(ctx, n.id, 'flexWrap', 'wrap', 'flex rows wrap');
    const basis = Math.round(Math.max(200, (ctx.width - 32 - gap) / 2 - gap));
    for (const k of kids) {
      set(ctx, k.id, 'flex', `1 1 ${basis}px`, 'flex rows wrap');
      set(ctx, k.id, 'minWidth', '0', 'flex rows wrap');
    }
    return;
  }
  for (const k of kids) if (!k.style.minWidth) set(ctx, k.id, 'minWidth', '0', 'flex rows shrink');
}

function deriveGrid(ctx: Ctx, n: BogenNode): void {
  if (n.style.display !== 'grid' && n.style.display !== 'inline-grid') return;
  if (n.style.gridTemplateAreas && n.style.gridTemplateAreas !== 'none') {
    ctx.notes.add(`"${n.name}" uses grid areas: set its narrow layout by hand.`);
    return;
  }
  const template = n.style.gridTemplateColumns;
  if (!template) return;
  const cols = columnCount(template);
  if (!cols) return;
  if (cols.auto) {
    const min = ctx.values.px(cols.auto.min);
    if (min && min > ctx.width - 32) set(ctx, n.id, 'gridTemplateColumns', `repeat(${cols.auto.kind}, minmax(min(${cols.auto.min}, 100%), 1fr))`, 'grids lose columns');
    return;
  }
  if (cols.count < 2) return;
  const target = ctx.ratio <= PHONE ? (cols.count >= 5 ? 2 : 1) : ctx.ratio <= TABLET ? (cols.count >= 3 ? Math.min(3, Math.ceil(cols.count / 2)) : cols.count) : Math.min(cols.count, Math.max(2, cols.count - 1));
  if (target >= cols.count) return;
  set(ctx, n.id, 'gridTemplateColumns', target === 1 ? '1fr' : `repeat(${target}, minmax(0, 1fr))`, 'grids lose columns');
  for (const k of ctx.kids(n.id)) {
    for (const prop of ['gridColumn', 'gridColumnStart', 'gridColumnEnd']) {
      const v = k.style[prop];
      if (!v) continue;
      const span = /span\s+(\d+)/.exec(v);
      const next = target === 1 ? 'auto' : span ? `span ${Math.min(target, Number(span[1]))}` : 'auto';
      if (next !== v) set(ctx, k.id, prop, next, 'grids lose columns');
    }
  }
}

function walk(ctx: Ctx, id: string, inNav: boolean): void {
  const n = ctx.doc.getNode(id);
  // A menu button this made earlier goes away when it runs again.
  if (!n || n.hidden || ctx.doc.nodes.get(id)?.get(MENU_FIELD)) return;
  const root = id === ctx.root;
  const parent = root ? undefined : ctx.doc.getNode(n.parent);
  // The artboard's own media blocks are read at its stored width, so in rules it keeps its style.
  const own = !root || ctx.method === 'artboards';
  const collapsed = !root && deriveNav(ctx, n, inNav);
  if (own) {
    if (n.type === 'text' || n.style.fontSize) deriveType(ctx, n);
    deriveSpacing(ctx, n);
    if (!root) deriveSize(ctx, n, parent);
  } else if (ctx.values.px(n.style.padding ?? '') || n.style.paddingLeft) ctx.notes.add('The artboard\'s own padding stays: media blocks on an artboard read its stored width. Move the padding into a section if it should step down.');
  if (collapsed) return;
  deriveFlex(ctx, n);
  deriveGrid(ctx, n);
  for (const k of ctx.kids(id)) walk(ctx, k.id, inNav || isNav(n));
}

/** What an artboard becomes at each width, without writing anything. */
export function planResponsive(doc: BogenDoc, rootId: string, options: ResponsiveOptions = {}): ResponsivePlan {
  const root = doc.getNode(rootId);
  if (!root) throw new Error(`No layer with id ${rootId}.`);
  const values = new Values(doc);
  const source = values.px(root.style.width ?? '');
  if (!source) throw new Error(`"${root.name}" has no fixed width to start from. Give the artboard a width such as 1440px first.`);
  const method = options.method ?? 'rules';
  const steps = responsiveSteps(source, options.widths?.length ? options.widths : DEFAULT_WIDTHS, values.breakpoints);
  if (!steps.length) throw new Error(`Give widths narrower than the artboard, which is ${source} wide.`);
  // A menu button this made earlier is not part of the design it reads: running again replaces it.
  const kids = (id: string) => doc.getChildren(id).filter((k) => !doc.nodes.get(k.id)?.get(MENU_FIELD));
  const changes: ResponsiveChange[] = [];
  const menus: ResponsivePlan['menus'] = [];
  const notes = new Set<string>();
  const before = new Map<string, Record<string, string>>();
  for (const step of steps) {
    const ctx: Ctx = { doc, values, width: step.width, ratio: step.width / source, root: rootId, method, before, out: new Map(), menus, notes, kids };
    walk(ctx, rootId, false);
    for (const [id, entry] of ctx.out) {
      changes.push({ id, width: step.width, style: entry.style, why: [...entry.why] });
      before.set(id, { ...before.get(id), ...entry.style });
    }
  }
  return { source, steps, changes, menus, notes: [...notes] };
}

// The Lucide menu icon, written out: the icon set is its own entry point that the editor loads late.
const MENU_ICON: NewNode = {
  type: 'svg', tag: 'svg', name: 'menu', style: { width: '22px', height: '22px', flexShrink: '0' },
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/></svg>',
};

function menuButton(hidden: boolean): NewNode {
  return {
    type: 'frame', tag: 'button', name: 'Menu button',
    attrs: { type: 'button', 'aria-label': 'Menu' },
    style: { display: hidden ? 'none' : 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '40px', height: '40px', flexShrink: '0' },
    children: [MENU_ICON],
  };
}

/** The linked artboard of a source at a width, if one was made. */
export function responsiveLink(doc: BogenDoc, id: string): { source: string; width: number } | null {
  const v = doc.nodes.get(id)?.get(LINK_FIELD);
  if (!v || typeof v !== 'object') return null;
  const { source, width } = v as Record<string, unknown>;
  return typeof source === 'string' && typeof width === 'number' ? { source, width } : null;
}

/** Artboards made from this one with `method: 'artboards'`, by width. */
export function linkedArtboards(doc: BogenDoc, sourceId: string): { id: string; width: number }[] {
  const out: { id: string; width: number }[] = [];
  doc.nodes.forEach((_, id) => {
    const link = responsiveLink(doc, id);
    if (link?.source === sourceId) out.push({ id, width: link.width });
  });
  return out.sort((a, b) => b.width - a.width);
}

/** Pairs every layer of a tree with the same layer of a copy of it, by place. */
function pairTrees(doc: BogenDoc, a: string, b: string, out = new Map<string, string>()): Map<string, string> {
  out.set(a, b);
  const ka = doc.getChildren(a);
  const kb = doc.getChildren(b);
  ka.forEach((k, i) => { if (kb[i]) pairTrees(doc, k.id, kb[i]!.id, out); });
  return out;
}

/**
 * Writes the variants. With `rules`, one media block per width on the layers that change. With
 * `artboards`, one artboard per width beside the source, with the changes in their own style, linked so
 * that calling this again rebuilds them from the source. One transaction, so one undo step.
 */
export function applyResponsive(doc: BogenDoc, rootId: string, options: ResponsiveOptions = {}, origin?: unknown): ResponsiveResult & { plan: ResponsivePlan } {
  const root = doc.getNode(rootId);
  if (!root) throw new Error(`No layer with id ${rootId}.`);
  if (responsiveLink(doc, rootId)) throw new Error(`"${root.name}" is a responsive variant of another artboard. Make variants from the source, ${responsiveLink(doc, rootId)!.source}.`);
  const method = options.method ?? 'rules';
  const plan = planResponsive(doc, rootId, { ...options, method });
  const menuButtons: string[] = [];
  const artboards: ResponsiveResult['artboards'] = [];
  const touched = new Set<string>();
  doc.transact(() => {
    if (method === 'rules') {
      // The blocks this tool wrote before go first, so that running it again gives the same result.
      const ours = new Set(plan.steps.map((s) => s.block));
      for (const n of [root, ...doc.descendants(rootId)]) {
        for (const block of Object.keys(n.rules ?? {})) if (ours.has(parseBlock(block)?.key ?? '')) doc.deleteRules(n.id, block);
      }
      for (const old of doc.descendants(rootId)) if (doc.nodes.get(old.id)?.get(MENU_FIELD)) doc.delete([old.id]);
      for (const change of plan.changes) {
        const step = plan.steps.find((s) => s.width === change.width)!;
        doc.updateRules(change.id, step.block, change.style);
        touched.add(change.id);
      }
      const added = new Map<string, string>();
      for (const menu of plan.menus) {
        const step = plan.steps.find((s) => s.width === menu.width)!;
        let id = added.get(menu.links);
        if (!id) {
          id = doc.insert(menu.parent, menuButton(true), menu.index);
          doc.nodes.get(id)?.set(MENU_FIELD, true);
          added.set(menu.links, id);
          menuButtons.push(id);
        }
        doc.updateRules(id, step.block, { display: 'inline-flex' });
      }
      artboards.push(...plan.steps.map((s) => ({ width: s.width, id: rootId, updated: true })));
      return;
    }
    const page = doc.pageOf(rootId);
    if (!page || root.parent !== page) throw new Error('Linked artboards are made from a top-level artboard.');
    const existing = linkedArtboards(doc, rootId);
    const left = doc.getNode(rootId)!;
    let x = (parseFloat(left.style.left ?? '0') || 0) + (parseFloat(left.style.width ?? '0') || 0) + 120;
    const top = left.style.top ?? '0px';
    for (const step of plan.steps) {
      const old = existing.find((e) => e.width === step.width);
      const oldNode = old ? doc.getNode(old.id) : undefined;
      const spec = doc.toSpec(rootId);
      const style: Record<string, string> = { ...spec.style, width: `${step.width}px`, left: oldNode?.style.left ?? `${Math.round(x)}px`, top: oldNode?.style.top ?? top };
      if (/^\d/.test(style.height ?? '')) style.height = 'fit-content';
      if (old) doc.delete([old.id]);
      const id = doc.insert(page, { ...spec, style, name: oldNode?.name ?? `${root.name} ${step.width}`, ...(old ? { fixedId: old.id } : {}) });
      // What children a layer has is read from a cache that the end of a transaction renews.
      doc.invalidate();
      doc.nodes.get(id)!.set(LINK_FIELD, { source: rootId, width: step.width });
      artboards.push({ width: step.width, id, updated: Boolean(old) });
      if (!oldNode) x += step.width + 120;
      const pairs = pairTrees(doc, rootId, id);
      // Each artboard takes every step down to its own width, as the cascade would.
      const merged = new Map<string, Record<string, string>>();
      for (const change of plan.changes) {
        if (change.width < step.width) continue;
        const target = pairs.get(change.id);
        if (target) merged.set(target, { ...merged.get(target), ...change.style });
      }
      for (const [target, patch] of merged) {
        doc.updateStyle(target, patch);
        touched.add(target);
      }
      for (const menu of plan.menus) {
        if (menu.width < step.width) continue;
        const parent = pairs.get(menu.parent);
        if (!parent || menuButtons.some((b) => doc.getNode(b)?.parent === parent)) continue;
        menuButtons.push(doc.insert(parent, menuButton(false), menu.index));
      }
    }
  }, origin);
  return { method, steps: plan.steps, artboards, layers: touched.size, menuButtons, notes: plan.notes, plan };
}
