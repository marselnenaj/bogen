// Web design craft, as data: fluid type and spacing scales, auto-fit grids, container queries made from media queries,
// a font audit, the keyboard focus order of a page, a measured design review, and stress content for previews. Pure:
// no browser. The server's tools put these to work and render what needs rendering.

import { craftFindings, exampleKindOf, previewsSystem } from './design-craft.ts';
import { blockKeyOf, parseBlock } from './layer-rules.ts';
import { BogenDoc, type BogenNode, type NewNode } from './doc.ts';
import { getFontFaces } from './font-faces.ts';
import { getTextStyles } from './design-system.ts';
import * as Y from 'yjs';

// ---------------------------------------------------------------- fluid values

const round = (n: number, places = 4) => Number(n.toFixed(places));

/**
 * A size that grows from `min` px at a `fromVw` px wide viewport to `max` px at `toVw`, in rem so that the reader's
 * own font size still scales it: `clamp(1rem, 0.8696rem + 0.5797vw, 1.25rem)`. Equal ends give a plain rem.
 */
export function fluidClamp(min: number, max: number, fromVw = 360, toVw = 1280, root = 16): string {
  if (min === max) return `${round(min / root)}rem`;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const slope = (max - min) / (toVw - fromVw);
  const intercept = round((min - slope * fromVw) / root);
  const vw = round(slope * 100);
  const middle = `${intercept}rem ${vw < 0 ? '-' : '+'} ${Math.abs(vw)}vw`;
  return `clamp(${round(lo / root)}rem, ${middle}, ${round(hi / root)}rem)`;
}

/** The px a clamp() from `fluidClamp` gives at a viewport width, to check a scale without a browser. */
export function clampAt(value: string, vw: number, root = 16): number | null {
  const m = /^clamp\((-?[\d.]+)rem,\s*(-?[\d.]+)rem\s*([+-])\s*([\d.]+)vw,\s*(-?[\d.]+)rem\)$/.exec(value.trim());
  if (!m) {
    const plain = /^([\d.]+)rem$/.exec(value.trim());
    return plain ? Number(plain[1]) * root : null;
  }
  const [lo, b, sign, v, hi] = [Number(m[1]) * root, Number(m[2]) * root, m[3], Number(m[4]), Number(m[5]) * root];
  const mid = b + ((sign === '-' ? -1 : 1) * v * vw) / 100;
  return Math.min(hi, Math.max(lo, mid));
}

export interface TypeRole {
  /** Token and text style name: display, h1, h2, h3, body, small. */
  role: string;
  tag: string;
  step: number;
  lineHeight: number;
  letterSpacing?: string;
  weight: string;
}

/** Roles a website's type needs, by step on the scale from the body size. Headings tighten; small text loosens. */
export const TYPE_ROLES: readonly TypeRole[] = [
  { role: 'display', tag: 'h1', step: 5, lineHeight: 1.02, letterSpacing: '-0.02em', weight: '600' },
  { role: 'h1', tag: 'h1', step: 4, lineHeight: 1.08, letterSpacing: '-0.015em', weight: '600' },
  { role: 'h2', tag: 'h2', step: 3, lineHeight: 1.15, letterSpacing: '-0.01em', weight: '600' },
  { role: 'h3', tag: 'h3', step: 1.5, lineHeight: 1.3, weight: '600' },
  { role: 'lead', tag: 'p', step: 0.75, lineHeight: 1.5, weight: '400' },
  { role: 'body', tag: 'p', step: 0, lineHeight: 1.6, weight: '400' },
  { role: 'small', tag: 'p', step: -1, lineHeight: 1.5, letterSpacing: '0.005em', weight: '400' },
];

export interface ScaleInput {
  /** Body size at the small and the large viewport, px. Default 16 and 18. */
  body?: [number, number];
  /** Ratio between steps at the small and the large viewport. A wider ratio on large screens gives headings room. */
  ratio?: [number, number];
  /** Viewport range, px. Default 360 to 1280. */
  viewport?: [number, number];
  /** Spacing base at the small and large viewport, px. Default 16 and 20. */
  space?: [number, number];
  /** Prefix for the token names. Default "type" and "space". */
  font?: string;
}

export interface ScaleToken { name: string; kind: 'font-size' | 'line-height' | 'letter-spacing' | 'spacing'; value: string }

/**
 * A fluid type scale and a fluid spacing scale as tokens, and text styles that use them: one source for every
 * breakpoint, so a heading never needs a separate @media size. Values are clamp() in rem and export unchanged.
 */
export function fluidScale(input: ScaleInput = {}): { tokens: ScaleToken[]; styles: { key: string; name: string; style: Record<string, string> }[]; at: Record<string, [number, number]> } {
  const [b0, b1] = input.body ?? [16, 18];
  const [r0, r1] = input.ratio ?? [1.2, 1.25];
  const [v0, v1] = input.viewport ?? [360, 1280];
  const [s0, s1] = input.space ?? [16, 20];
  const font = input.font ?? 'type';
  const tokens: ScaleToken[] = [];
  const styles: { key: string; name: string; style: Record<string, string> }[] = [];
  const at: Record<string, [number, number]> = {};
  for (const r of TYPE_ROLES) {
    const lo = Math.round(b0 * r0 ** r.step * 10) / 10;
    const hi = Math.round(b1 * r1 ** r.step * 10) / 10;
    at[r.role] = [lo, hi];
    const name = `${font}-${r.role}`;
    tokens.push({ name, kind: 'font-size', value: fluidClamp(lo, hi, v0, v1) });
    tokens.push({ name: `${name}-leading`, kind: 'line-height', value: String(r.lineHeight) });
    if (r.letterSpacing) tokens.push({ name: `${name}-tracking`, kind: 'letter-spacing', value: r.letterSpacing });
    styles.push({
      key: r.role, name: r.role === 'display' ? 'Display' : r.role === 'lead' ? 'Lead' : r.role === 'body' ? 'Body' : r.role === 'small' ? 'Small' : r.role.toUpperCase(),
      style: { fontSize: `var(--${name})`, lineHeight: `var(--${name}-leading)`, fontWeight: r.weight, ...(r.letterSpacing ? { letterSpacing: `var(--${name}-tracking)` } : {}) },
    });
  }
  // Space: a step ladder on the base, each step fluid, so section padding and gaps scale with the type.
  const steps: [string, number][] = [['3xs', 0.25], ['2xs', 0.5], ['xs', 0.75], ['s', 1], ['m', 1.5], ['l', 2], ['xl', 3], ['2xl', 4], ['3xl', 6]];
  for (const [step, k] of steps) {
    const lo = Math.round(s0 * k);
    const hi = Math.round(s1 * k);
    at[`space-${step}`] = [lo, hi];
    tokens.push({ name: `space-${step}`, kind: 'spacing', value: fluidClamp(lo, hi, v0, v1) });
  }
  return { tokens, styles, at };
}

// ---------------------------------------------------------------- grids and containers

/**
 * A grid that fits as many columns of at least `min` as there is room for, and never overflows a narrow screen:
 * `min(…, 100%)` lets the single column shrink below `min` on a phone. `fill` keeps empty tracks; `fit` stretches.
 */
export function autoGrid(min: string, gap: string, mode: 'fit' | 'fill' = 'fit', max = '1fr'): Record<string, string> {
  return { display: 'grid', gridTemplateColumns: `repeat(auto-${mode}, minmax(min(${min}, 100%), ${max}))`, gap };
}

export interface ContainerChange { id: string; from: string; to: string }

export interface NarrowChange { id: string; key: string; props: Record<string, string> }

/**
 * A narrow version of what is inside a container. A container query reaches only the container's descendants, never
 * the container itself, so the condition goes on the layouts inside it: rows stack and grids drop to one column when
 * the container is at most `width` wide. Stops at nested containers, which answer to their own width. Returns the
 * blocks to write, or none when nothing inside lays out side by side.
 */
export function containerNarrowPlan(doc: BogenDoc, containerId: string, name: string, width: number): NarrowChange[] {
  const container = doc.getNode(containerId);
  if (!container) throw new Error(`No layer with id ${containerId}.`);
  const key = blockKeyOf({ at: { kind: 'container', name, query: `(max-width: ${Math.round(width)}px)` } });
  const out: NarrowChange[] = [];
  const visit = (id: string) => {
    for (const n of doc.getChildren(id)) {
      const display = n.style.display ?? '';
      if (/flex$/.test(display) && !/^column/.test(n.style.flexDirection ?? '')) out.push({ id: n.id, key, props: { flexDirection: 'column', alignItems: 'stretch' } });
      else if (/grid$/.test(display) && (n.style.gridTemplateColumns ?? '').trim() && !/^(1fr|none|minmax\(0,\s*1fr\))$/.test(n.style.gridTemplateColumns!.trim())) out.push({ id: n.id, key, props: { gridTemplateColumns: 'minmax(0, 1fr)' } });
      if (n.style.containerType !== 'inline-size' && n.style.containerType !== 'size') visit(n.id);
    }
  };
  visit(containerId);
  return out;
}

/**
 * Makes a component respond to the width it is given instead of the page's. A container query only reaches the
 * container's descendants, never the container itself, so the container is the component's parent: the slot it sits
 * in, such as a sidebar or a column. Every `@media (max-width|min-width: N)` block on the component and inside it then
 * becomes `@container name (…)`, with N scaled by how wide that slot is relative to the page it was designed in, and
 * the component's own layout (a row that stacks) changes with it. Returns what changed; writes nothing itself.
 */
export function mediaToContainerPlan(doc: BogenDoc, rootId: string, name: string, slotWidth: number, pageWidth: number): { containerId: string; containerStyle: Record<string, string>; changes: ContainerChange[]; skipped: string[] } {
  const root = doc.getNode(rootId);
  if (!root) throw new Error(`No layer with id ${rootId}.`);
  const parent = doc.getNode(root.parent);
  if (!parent) throw new Error(`${root.name} has no parent layer to be its container: a container query reads an ancestor's width. Wrap it in a frame first.`);
  const ratio = pageWidth > 0 && slotWidth > 0 ? slotWidth / pageWidth : 1;
  const changes: ContainerChange[] = [];
  const skipped: string[] = [];
  for (const n of [root, ...doc.descendants(rootId)]) {
    for (const key of Object.keys(n.rules ?? {})) {
      const block = parseBlock(key);
      if (!block?.at || block.at.kind !== 'media') continue;
      const q = block.at.query;
      if (!/^\(\s*(max|min)-width\s*:\s*\d+(\.\d+)?px\s*\)(\s+and\s+\(\s*(max|min)-width\s*:\s*\d+(\.\d+)?px\s*\))?$/.test(q)) {
        skipped.push(`${n.id}: @media ${q} is not a plain width query; left as it is.`);
        continue;
      }
      const query = q.replace(/(\d+(\.\d+)?)px/g, (_m, v: string) => `${Math.round(Number(v) * ratio)}px`);
      const to = blockKeyOf({ ...block, at: { kind: 'container', name, query } });
      changes.push({ id: n.id, from: key, to });
    }
  }
  return { containerId: parent.id, containerStyle: { containerType: 'inline-size', containerName: name }, changes, skipped };
}

// ---------------------------------------------------------------- fonts

export interface FontFinding { family: string; severity: 'problem' | 'note'; message: string; layers: string[] }

const GENERIC = /^(serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|math|emoji)$/i;
const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');

/**
 * Which families, weights and styles a page uses against what it can really show. Uploaded or captured faces are
 * known exactly; Google families load through Bogen's own request (weights 100–900, italic only at 400 and 700), so an
 * italic 600 there is drawn by the browser slanting the upright. Stacks without a generic fallback, families a layer
 * names that nothing provides, and more families or weights than a page reads well are reported with their layers.
 */
export function fontAudit(doc: BogenDoc, rootIds: string[], options: { google?: ReadonlySet<string> } = {}): { families: { family: string; source: 'hosted' | 'google' | 'unknown'; weights: string[]; italic: string[]; layers: number }[]; findings: FontFinding[] } {
  const faces = getFontFaces(doc);
  const hosted = new Map<string, { weights: Set<string>; italic: Set<string> }>();
  for (const f of faces) {
    const key = f.family.toLowerCase();
    if (!hosted.has(key)) hosted.set(key, { weights: new Set(), italic: new Set() });
    const entry = hosted.get(key)!;
    const weights = (f.weight ?? '400').split(/\s+/);
    // A variable face's range "100 900" covers every weight between.
    const span = weights.length === 2 ? [Number(weights[0]), Number(weights[1])] : null;
    const add = (w: string) => (/italic|oblique/.test(f.style ?? '') ? entry.italic : entry.weights).add(w);
    if (span && span.every(Number.isFinite)) for (let w = 100; w <= 900; w += 100) { if (w >= span[0]! && w <= span[1]!) add(String(w)); }
    else add(weights[0]!);
  }
  const uses = new Map<string, { weights: Map<string, Set<string>>; italic: Map<string, Set<string>>; stacks: Map<string, Set<string>> }>();
  const textStyles = new Map(getTextStyles(doc).map((s) => [s.key, s.style]));
  const visit = (n: BogenNode, inherited: Record<string, string>) => {
    const ts = n.textStyle ? textStyles.get(n.textStyle) ?? {} : {};
    const own = { ...ts, ...n.style };
    const style = { fontFamily: own.fontFamily ?? inherited.fontFamily ?? '', fontWeight: own.fontWeight ?? inherited.fontWeight ?? '400', fontStyle: own.fontStyle ?? inherited.fontStyle ?? 'normal' };
    const hasText = n.type === 'text' && Boolean(n.text?.trim());
    if (hasText && style.fontFamily && !style.fontFamily.startsWith('var(')) {
      const stack = style.fontFamily;
      const family = unquote(stack.split(',')[0]!);
      if (!uses.has(family)) uses.set(family, { weights: new Map(), italic: new Map(), stacks: new Map() });
      const u = uses.get(family)!;
      const weight = ({ normal: '400', bold: '700' } as Record<string, string>)[style.fontWeight] ?? style.fontWeight;
      const bucket = /italic|oblique/.test(style.fontStyle) ? u.italic : u.weights;
      if (!bucket.has(weight)) bucket.set(weight, new Set());
      bucket.get(weight)!.add(n.id);
      if (!u.stacks.has(stack)) u.stacks.set(stack, new Set());
      u.stacks.get(stack)!.add(n.id);
    }
    for (const c of doc.getChildren(n.id)) visit(c, style);
  };
  for (const id of rootIds) {
    const n = doc.getNode(id);
    if (n) visit(n, {});
  }
  const findings: FontFinding[] = [];
  const families: ReturnType<typeof fontAudit>['families'] = [];
  for (const [family, u] of uses) {
    const key = family.toLowerCase();
    const h = hosted.get(key);
    const source: 'hosted' | 'google' | 'unknown' = h ? 'hosted' : options.google?.has(family) ? 'google' : GENERIC.test(family) ? 'hosted' : 'unknown';
    const layerCount = new Set([...u.weights.values(), ...u.italic.values()].flatMap((s) => [...s])).size;
    families.push({ family, source, weights: [...u.weights.keys()].sort(), italic: [...u.italic.keys()].sort(), layers: layerCount });
    for (const [stack, ids] of u.stacks) {
      const generic = stack.split(',').map(unquote).some((p) => GENERIC.test(p));
      if (!generic && !GENERIC.test(family)) findings.push({ family, severity: 'problem', message: `"${stack}" ends without a generic family, so a failed load falls back to the browser default. Add a fallback such as ", ${/mono|code/i.test(family) ? 'ui-monospace, monospace' : /serif|garamond|caslon|baskerville|lora|merriweather/i.test(family) ? 'Georgia, serif' : 'system-ui, sans-serif'}".`, layers: [...ids].slice(0, 20) });
    }
    if (source === 'unknown') findings.push({ family, severity: 'problem', message: `Nothing provides ${family}: it is not uploaded or captured, and not a Google family Bogen knows. Visitors without it installed see the fallback.`, layers: [...new Set([...u.weights.values()].flatMap((s) => [...s]))].slice(0, 20) });
    if (h) {
      for (const [w, ids] of u.weights) if (!h.weights.has(w)) findings.push({ family, severity: 'problem', message: `${family} ${w} is used but no ${w} face is uploaded: the browser fakes it from ${[...h.weights].join(', ') || 'another weight'}.`, layers: [...ids].slice(0, 20) });
      for (const [w, ids] of u.italic) if (!h.italic.has(w)) findings.push({ family, severity: 'problem', message: `${family} italic ${w} is used but there is no italic face: the browser slants the upright, which looks wrong in most families.`, layers: [...ids].slice(0, 20) });
    } else if (source === 'google') {
      for (const [w, ids] of u.italic) if (w !== '400' && w !== '700') findings.push({ family, severity: 'problem', message: `${family} italic ${w}: Bogen loads Google italics at 400 and 700 only, so this one is synthesized. Use 400 or 700, or upload the face.`, layers: [...ids].slice(0, 20) });
    }
    const weights = new Set([...u.weights.keys(), ...u.italic.keys()]);
    if (weights.size > 4) findings.push({ family, severity: 'note', message: `${weights.size} weights of ${family} (${[...weights].sort().join(', ')}). Three or four read as a system; more usually means sizes are doing a weight's job.`, layers: [] });
  }
  if (uses.size > 3) findings.push({ family: '*', severity: 'note', message: `${uses.size} families on one page (${[...uses.keys()].join(', ')}). Two, three at most, keep a voice.`, layers: [] });
  return { families, findings };
}

// ---------------------------------------------------------------- keyboard focus

export interface FocusStop { id: string; name: string; tag: string; tabindex?: number; reason: string }
export interface FocusIssue { id: string; message: string }

const NATIVE_FOCUS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);

function accessibleName(doc: BogenDoc, n: BogenNode): string {
  const label = n.attrs?.['aria-label'] ?? n.attrs?.title;
  if (label?.trim()) return label.trim();
  const texts = [n, ...doc.descendants(n.id)].map((d) => (d.type === 'text' ? d.text ?? '' : d.attrs?.alt ?? '')).join(' ').replace(/\s+/g, ' ').trim();
  return texts;
}

/**
 * The order a keyboard visits a page in: links with an href, buttons, fields, summaries, popover triggers and anything
 * with tabindex ≥ 0, in document order with positive tabindex first, as browsers do. Issues: positive tabindex,
 * stops without a name, links without href, tabindex on something that is not interactive, popover and label
 * targets that do not exist, and rows or columns whose visual order is reversed against the order a keyboard takes.
 */
export function focusOrder(doc: BogenDoc, rootId: string): { stops: FocusStop[]; issues: FocusIssue[]; popovers: Record<string, FocusStop[]> } {
  const root = doc.getNode(rootId);
  if (!root) throw new Error(`No layer with id ${rootId}.`);
  const all = [root, ...doc.descendants(rootId)].filter((n) => !n.hidden && n.style.display !== 'none' && n.style.visibility !== 'hidden');
  const hiddenIds = new Set([root, ...doc.descendants(rootId)].filter((n) => n.hidden || n.style.display === 'none').flatMap((n) => [n.id, ...doc.descendants(n.id).map((d) => d.id)]));
  // A closed popover's contents are not reachable until its trigger opens it: listed apart, not in the page's order.
  const popovers = [root, ...doc.descendants(rootId)].filter((n) => n.attrs?.popover !== undefined && !hiddenIds.has(n.id));
  const inPopover = new Map<string, string>();
  for (const p of popovers) for (const d of doc.descendants(p.id)) inPopover.set(d.id, p.attrs?.id ?? p.id);
  const ids = new Set(all.map((n) => n.attrs?.id).filter(Boolean));
  const issues: FocusIssue[] = [];
  const positive: FocusStop[] = [];
  const normal: FocusStop[] = [];
  const popoverStops: Record<string, FocusStop[]> = {};
  for (const n of all) {
    if (hiddenIds.has(n.id)) continue;
    const tag = n.tag.toLowerCase();
    const raw = n.attrs?.tabindex;
    const tabindex = raw !== undefined ? Number(raw) : undefined;
    const href = n.attrs?.href;
    let reason = '';
    if (tag === 'a' && href) reason = 'link';
    else if (tag === 'a' && !href) issues.push({ id: n.id, message: `"${accessibleName(doc, n).slice(0, 40) || n.name}" is an <a> without href: it is not focusable and not a link. Give it an href, or make it a <button>.` });
    else if (tag === 'button' || n.attrs?.popovertarget) reason = n.attrs?.popovertarget ? 'popover trigger' : 'button';
    else if (['input', 'select', 'textarea'].includes(tag) && n.attrs?.type !== 'hidden' && n.attrs?.disabled === undefined) reason = 'field';
    else if (tag === 'summary') reason = 'disclosure';
    if (tabindex !== undefined && tabindex >= 0 && !reason) {
      reason = 'tabindex';
      if (!n.attrs?.role) issues.push({ id: n.id, message: `${n.name} has tabindex but no role: a screen reader announces it as nothing. Use a real button or link, or add a role.` });
    }
    if (tabindex !== undefined && tabindex < 0 && NATIVE_FOCUS.has(tag)) continue;
    if (!reason) continue;
    const name = accessibleName(doc, n);
    if (!name && tag !== 'input' && tag !== 'select' && tag !== 'textarea') issues.push({ id: n.id, message: `This ${reason} has no name: no text, aria-label or alt inside. A keyboard user hears only "${reason}".` });
    const target = n.attrs?.popovertarget;
    if (target && !ids.has(target)) issues.push({ id: n.id, message: `popovertarget="${target}" names no element with that id on this page, so the button does nothing.` });
    const stop: FocusStop = { id: n.id, name: name.slice(0, 80), tag, ...(tabindex !== undefined ? { tabindex } : {}), reason };
    const popover = inPopover.get(n.id);
    if (popover) {
      (popoverStops[popover] ??= []).push(stop);
      continue;
    }
    if (tabindex !== undefined && tabindex > 0) {
      positive.push(stop);
      issues.push({ id: n.id, message: `tabindex="${tabindex}" moves this ahead of everything else on the page. Use 0 and put it where it belongs in the markup.` });
    } else normal.push(stop);
  }
  for (const n of all) {
    const forId = n.attrs?.for;
    if (n.tag === 'label' && forId && !ids.has(forId)) issues.push({ id: n.id, message: `label for="${forId}" points at no field with that id.` });
    const dir = n.style.flexDirection;
    const focusInside = [...positive, ...normal].filter((s) => doc.ancestors(s.id).includes(n.id));
    if ((dir === 'row-reverse' || dir === 'column-reverse') && focusInside.length > 1) issues.push({ id: n.id, message: `${n.name} is ${dir}: what comes first on screen comes last for the keyboard. Reorder the markup instead.` });
    if (n.style.order && n.style.order !== '0' && [...positive, ...normal].some((s) => s.id === n.id || doc.ancestors(s.id).includes(n.id))) issues.push({ id: n.id, message: `${n.name} has order: ${n.style.order}, so it sits elsewhere on screen than in the focus order.` });
  }
  positive.sort((a, b) => (a.tabindex ?? 0) - (b.tabindex ?? 0));
  return { stops: [...positive, ...normal], issues, popovers: popoverStops };
}

// ---------------------------------------------------------------- design review

/** `rule` names the craft check behind an observation, where one is: the same id `design_lint` reports it under. */
export interface ReviewObservation { aspect: 'hierarchy' | 'reading' | 'scale' | 'space' | 'colour' | 'pattern' | 'content'; message: string; layers: string[]; numbers?: Record<string, number | string>; rule?: string }

const px = (v: string | undefined) => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v?.trim() ?? '');
  return m ? Number(m[1]) : undefined;
};

/** Each var() in a value as what it gives: the file's token, or the fallback where the file has no such token. */
function resolveVars(value: string, tokens: Map<string, string>, depth = 0): string {
  if (depth > 5 || !value.includes('var(')) return value;
  return resolveVars(value.replace(/var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\((?:[^()]|\([^()]*\))*\))*))?\)/g, (m, name: string, fallback?: string) => tokens.get(name) ?? fallback?.trim() ?? m), tokens, depth + 1);
}

/** A value without its var() references, fallbacks and all: what is left was typed in. */
function withoutVars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (!value.startsWith('var(', i)) { out += value[i]; continue; }
    let depth = 0;
    for (; i < value.length; i++) {
      if (value[i] === '(') depth++;
      else if (value[i] === ')' && --depth === 0) break;
    }
  }
  return out;
}

/** A layer's font size in px where it can be read from styles: px, rem, or a clamp() at the given viewport width. */
function fontPx(n: BogenNode, textStyles: Map<string, Record<string, string>>, tokens: Map<string, string>, width: number): number | undefined {
  const raw = n.style.fontSize ?? (n.textStyle ? textStyles.get(n.textStyle)?.fontSize : undefined);
  if (!raw) return undefined;
  const value = resolveVars(raw, tokens).trim();
  return px(value) ?? (/^[\d.]+rem$/.test(value) ? Number(value.slice(0, -3)) * 16 : clampAt(value, width) ?? undefined);
}

/**
 * Measurements a designer looks at before calling a page done, as observations with numbers and layers, not
 * verdicts: the heading sizes and whether they step down, how many sizes and weights there are, line length and
 * leading of running text, spacing values off the scale, colours typed in instead of tokens, and the patterns that
 * make a page look generated (a row of identical icon cards, a small label over every heading, everything centred,
 * gradients, emoji). The agent judges them against what the page is for.
 */
export function designReview(doc: BogenDoc, rootId: string, viewportWidth = 1440): { observations: ReviewObservation[]; numbers: Record<string, number> } {
  const root = doc.getNode(rootId);
  if (!root) throw new Error(`No layer with id ${rootId}.`);
  const textStyles = new Map(getTextStyles(doc).map((s) => [s.key, s.style]));
  const tokens = new Map(doc.getTokens().map((t) => [t.name, t.value]));
  // A counter-example is wrong on purpose and left out; a specimen shows a scale's steps, so they are not the page's sizes.
  const kinds = new Map([root, ...doc.descendants(rootId)].map((n) => [n.id, exampleKindOf(doc, n.id)]));
  const layers = [root, ...doc.descendants(rootId)].filter((n) => !n.hidden && kinds.get(n.id) !== 'dont');
  const texts = layers.filter((n) => n.type === 'text' && n.text?.trim());
  const out: ReviewObservation[] = [];
  const headings = texts.filter((n) => /^h[1-6]$/.test(n.tag)).map((n) => ({ n, level: Number(n.tag[1]), size: fontPx(n, textStyles, tokens, viewportWidth) }));
  // A theme file previews the system's own screens: a desktop, a lock screen, a phone shell. It is not a document, so it
  // has no main heading; it takes its sizes from the system's configuration, not a 4px grid; and an app grid, a dock and
  // gradient wallpapers are the system's own, not a page's generic cards.
  const system = previewsSystem(doc);
  const h1 = headings.filter((h) => h.level === 1);
  if (h1.length !== 1 && !(system && !h1.length)) out.push({ aspect: 'hierarchy', message: h1.length ? `${h1.length} h1 headings: a page has one main heading.` : 'No h1: the page has no main heading for readers or search.', layers: h1.map((h) => h.n.id) });
  const byLevel = new Map<number, number[]>();
  for (const h of headings) if (h.size) byLevel.set(h.level, [...(byLevel.get(h.level) ?? []), h.size]);
  const levels = [...byLevel.keys()].sort();
  for (let i = 1; i < levels.length; i++) {
    const upper = Math.min(...byLevel.get(levels[i - 1]!)!);
    const lower = Math.max(...byLevel.get(levels[i]!)!);
    if (lower >= upper) out.push({ aspect: 'hierarchy', message: `h${levels[i]} (up to ${lower}px) is as large as or larger than h${levels[i - 1]} (from ${upper}px): the levels do not read as levels.`, layers: headings.filter((h) => h.level === levels[i]).map((h) => h.n.id), numbers: { upper, lower } });
    else if (upper / lower < 1.15) out.push({ aspect: 'scale', message: `h${levels[i - 1]} ${upper}px and h${levels[i]} ${lower}px differ by ${Math.round((upper / lower - 1) * 100)}%: too close to tell apart at a glance.`, layers: [], numbers: { ratio: round(upper / lower, 2) } });
  }
  const sizes = new Set(texts.filter((n) => kinds.get(n.id) !== 'specimen').map((n) => fontPx(n, textStyles, tokens, viewportWidth)).filter((s): s is number => Boolean(s)).map((s) => Math.round(s)));
  if (sizes.size > 7) out.push({ aspect: 'scale', message: `${sizes.size} different font sizes (${[...sizes].sort((a, b) => a - b).join(', ')}px). A scale of five or six reads as deliberate.`, layers: [], numbers: { sizes: sizes.size } });
  // Running text: width in characters and leading.
  for (const n of texts) {
    if (n.text!.length < 120 || /^h[1-6]$/.test(n.tag)) continue;
    const size = fontPx(n, textStyles, tokens, viewportWidth) ?? 16;
    const width = px(n.style.maxWidth) ?? px(n.style.width) ?? (n.style.maxWidth?.endsWith('ch') ? Number(n.style.maxWidth.slice(0, -2)) * size * 0.5 : undefined);
    const chars = width ? Math.round(width / (size * 0.5)) : undefined;
    if (!width) out.push({ aspect: 'reading', message: `"${n.text!.slice(0, 40)}…" has no width or max-width: on a wide screen its lines run the whole width. Around 60–75 characters (max-width: 65ch) reads best.`, layers: [n.id] });
    else if (chars && (chars > 85 || chars < 30)) out.push({ aspect: 'reading', message: `About ${chars} characters per line at ${size}px. ${chars > 85 ? 'Long lines make the eye lose its place; aim for 60–75.' : 'Very short lines break the text into fragments.'}`, layers: [n.id], numbers: { chars } });
    const lh = Number(resolveVars(n.style.lineHeight ?? '', tokens).trim());
    if (Number.isFinite(lh) && lh > 0 && lh < 1.35) out.push({ aspect: 'reading', message: `Line height ${lh} on running text: under about 1.4 paragraphs feel cramped.`, layers: [n.id], numbers: { lineHeight: lh } });
  }
  // Spacing values that are not on a 4px grid or a token.
  const offScale: string[] = [];
  for (const n of layers) for (const k of ['gap', 'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'marginTop', 'marginBottom', 'rowGap', 'columnGap'] as const) {
    const v = n.style[k];
    if (!v || v.includes('var(') || v.includes('clamp(')) continue;
    for (const part of v.split(/\s+/)) {
      const p = px(part);
      if (p !== undefined && p % 4 !== 0 && p > 2) offScale.push(n.id);
    }
  }
  if (offScale.length >= 3 && !system) out.push({ aspect: 'space', message: `${offScale.length} spacing values are off a 4px grid and not tokens: rhythm comes from few, repeated values.`, layers: [...new Set(offScale)].slice(0, 12), numbers: { count: offScale.length } });
  // Colours typed in. var(--ink, #1d1b19) is the token --ink, whatever its fallback says.
  const literal = (n: BogenNode, k: string) => withoutVars(n.style[k as 'color'] ?? '');
  const COLOUR_PROPS = ['color', 'backgroundColor', 'background', 'borderColor'];
  const typed = layers.filter((n) => COLOUR_PROPS.some((k) => /#[0-9a-f]{3,8}\b|rgb\(/i.test(literal(n, k))));
  const distinct = new Set(typed.flatMap((n) => COLOUR_PROPS.map((k) => literal(n, k).trim()).filter((v) => v && /#|rgb/.test(v))));
  if (distinct.size > 6) out.push({ aspect: 'colour', message: `${distinct.size} colours typed in on ${typed.length} layers instead of tokens. A restrained palette in tokens keeps the page coherent and themable.`, layers: typed.slice(0, 12).map((n) => n.id), numbers: { colours: distinct.size } });
  const gradients = layers.filter((n) => /gradient\(/.test(n.style.background ?? n.style.backgroundImage ?? ''));
  if (gradients.length >= 3 && !system) out.push({ aspect: 'pattern', message: `${gradients.length} gradient backgrounds. Used everywhere they stop meaning anything; keep one where it carries the subject.`, layers: gradients.map((n) => n.id).slice(0, 12) });
  // A row of three or more look-alike cards with an icon, a title and a line.
  for (const n of layers) {
    const kids = doc.getChildren(n.id).filter((c) => !c.hidden);
    if (kids.length < 3) continue;
    const shape = (c: BogenNode) => doc.getChildren(c.id).map((g) => `${g.type}:${g.tag}`).join(',');
    const first = shape(kids[0]!);
    const same = kids.every((k) => shape(k) === first && k.type === 'frame');
    const hasIcon = doc.getChildren(kids[0]!.id).some((g) => g.type === 'svg' || g.name.toLowerCase().includes('icon'));
    if (same && hasIcon && kids.length <= 6 && first.split(',').length <= 4 && !system) out.push({ aspect: 'pattern', message: `${kids.length} cards with the same icon-title-text shape side by side: the most generic layout there is. Consider what makes one of these matter more, or a list, a table, or real proof instead.`, layers: [n.id] });
  }
  // A small uppercase label over most headings.
  const eyebrows = headings.filter((h) => {
    const sibs = doc.getChildren(h.n.parent);
    const prev = sibs[sibs.findIndex((s) => s.id === h.n.id) - 1];
    return prev?.type === 'text' && (prev.style.textTransform === 'uppercase' || /^[A-Z0-9 ·/&-]{3,}$/.test(prev.text ?? '')) && (fontPx(prev, textStyles, tokens, viewportWidth) ?? 16) <= 14;
  });
  const sectionHeads = headings.filter((h) => h.level <= 2).length;
  if (sectionHeads >= 3 && eyebrows.length >= Math.ceil(sectionHeads * 0.6)) out.push({ aspect: 'pattern', message: `${eyebrows.length} of ${sectionHeads} section headings have a small uppercase label over them. Once is emphasis; on every section it is noise.`, layers: eyebrows.map((h) => h.n.id) });
  const centred = texts.filter((n) => n.style.textAlign === 'center');
  if (texts.length >= 6 && centred.length / texts.length > 0.7) out.push({ aspect: 'pattern', message: `${centred.length} of ${texts.length} text layers are centred. Long centred text is hard to read; a clear left edge gives the page structure.`, layers: [], numbers: { share: round(centred.length / texts.length, 2) } });
  // ©, ® and ™ count as pictographs in Unicode but are typography, not emoji.
  const emoji = texts.filter((n) => /\p{Extended_Pictographic}/u.test(n.text!.replace(/[©®™‼⁉↔-↙]/g, '')));
  if (emoji.length) out.push({ aspect: 'content', message: `${emoji.length} text layer${emoji.length === 1 ? ' uses' : 's use'} emoji as icons or decoration. Use real icons (icon_insert) or none.`, layers: emoji.map((n) => n.id).slice(0, 12) });
  const filler = texts.filter((n) => /lorem ipsum|dolor sit amet|your (company|product|tagline) here|placeholder text/i.test(n.text!));
  if (filler.length) out.push({ aspect: 'content', message: `${filler.length} layers hold placeholder copy. Real, specific words change how the layout works.`, layers: filler.map((n) => n.id) });
  const exclaim = texts.filter((n) => /!\s*$/.test(n.text!.trim()));
  if (exclaim.length >= 2) out.push({ aspect: 'content', message: `${exclaim.length} lines end in an exclamation mark. Confident copy does not need them.`, layers: exclaim.map((n) => n.id).slice(0, 8) });
  // The craft checks, which read inherited styles too. One that says what an observation above already says is left out.
  const said = { eyebrow: out.some((o) => o.message.includes('small uppercase label')), centred: out.some((o) => o.message.includes('text layers are centred')) };
  const aspects = { hierarchy: 'hierarchy', type: 'scale', spacing: 'space', colour: 'colour', content: 'content', craft: 'pattern', originality: 'pattern', fit: 'pattern' } as const;
  for (const f of craftFindings(doc, rootId, viewportWidth)) {
    if ((f.rule === 'eyebrow' && said.eyebrow) || (f.rule === 'centred' && said.centred)) continue;
    out.push({ aspect: aspects[f.criterion], rule: f.rule, message: f.message, layers: f.layers, ...(f.numbers ? { numbers: f.numbers } : {}) });
  }
  return { observations: out, numbers: { layers: layers.length, texts: texts.length, headings: headings.length, sizes: sizes.size, typedColours: distinct.size } };
}

// ---------------------------------------------------------------- stress content

export interface StressOptions {
  /** How much longer every text gets: 1.6 is about the growth from English to German. */
  textFactor?: number;
  /** Add an unbroken long word, as in German compounds and URLs. */
  longWords?: boolean;
  /** Images lose their source, as when a file fails to load. */
  missingImages?: boolean;
  /** Repeated items (lists, card rows) shown with one item and with twice as many. */
  emptyAndFull?: 'empty' | 'full';
}

const LONG_WORD = 'Datenschutzgrundverordnungskonformitätsprüfung';
const FILLER = ['for every order in the past twelve months', 'including the shipping and returns you asked about', 'which our team reviews by hand before it goes out', 'so nothing arrives late or in the wrong size'];

/**
 * A copy of the file with harder content, for a preview that changes nothing in the original: longer text (as
 * translation makes it), unbreakable words, images that fail to load, and lists with one item or twice as many.
 * The copy shares no state with the original; the caller renders it and throws it away.
 */
export function stressCopy(doc: BogenDoc, rootId: string, options: StressOptions = {}): { doc: BogenDoc; changed: number } {
  const copy = new BogenDoc();
  Y.applyUpdate(copy.y, Y.encodeStateAsUpdate(doc.y));
  const factor = Math.max(1, Math.min(4, options.textFactor ?? 1.6));
  let changed = 0;
  const layers = [rootId, ...copy.descendants(rootId).map((n) => n.id)];
  copy.transact(() => {
    for (const id of layers) {
      const n = copy.getNode(id);
      if (!n) continue;
      if (n.type === 'text' && n.text?.trim() && n.instanceOf === undefined) {
        let text = n.text;
        let i = 0;
        while (text.length < n.text.length * factor && i < 12) text += ` ${FILLER[i++ % FILLER.length]}`;
        if (options.longWords && text.length > 12) text = text.replace(/(\S+)$/, `${LONG_WORD} $1`);
        if (text !== n.text) {
          copy.updateFields(id, { text, spans: [] });
          changed++;
        }
      }
      if (options.missingImages && n.type === 'image' && n.src) {
        copy.updateFields(id, { src: '' });
        changed++;
      }
    }
    if (options.emptyAndFull) {
      for (const id of layers) {
        const kids = copy.getChildren(id).filter((c) => !c.hidden);
        if (kids.length < 3) continue;
        const shape = (c: BogenNode) => copy.getChildren(c.id).map((g) => g.type).join(',');
        if (!kids.every((k) => shape(k) === shape(kids[0]!))) continue;
        if (options.emptyAndFull === 'empty') copy.delete(kids.slice(1).map((k) => k.id));
        else for (const k of kids) copy.insert(id, copy.toSpec(k.id) as NewNode);
        changed++;
      }
    }
  });
  return { doc: copy, changed };
}
