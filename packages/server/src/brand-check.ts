import {
  bindingBrand, contentLanguageOf, declaredLanguageOf, exampleLine, itemsForLanguage, judgeCopy, voiceFindings, voiceProfile, brandTokens, familyStack, colorAlpha, colorDistance, colorsIn, confirmed, contrastRatio, flattenColor, logoFitsBackground, normalizeColor, pickLogo, readWaivers, resolveBrandColor, ruleValues, sanitizeSvgMarkup, svgAspect, waiverKey,
  type BogenDoc, type BogenNode, type BrandColor, type BrandData, type BrandFamily, type BrandLogo, type BrandRule, type Severity,
} from '@bogen/core';
import type { Renderer, Target } from './render.ts';
import { rulePairs, swapColor, type RulePair } from './rule-contrast.ts';

/**
 * Checks a design against a brand. Facts about each layer come either from the document alone, which is cheap and
 * sees only what is declared, or from a real render, which also sees what is inherited. Both end up in the same
 * shape, and `evaluate` does not care which it got. A score is only ever built from checks that actually ran.
 */

export type BrandCategory = 'colour' | 'contrast' | 'type' | 'spacing' | 'shape' | 'logo' | 'voice' | 'rules' | 'tokens';

export interface BrandFix {
  description: string;
  /** Safe to apply without looking. Only these go in with `fix: true`. */
  safe: boolean;
  style?: Record<string, string | null>;
  src?: string;
  svg?: string;
  text?: string;
  tokens?: boolean;
  /** The block of the layer's rules the style goes in, such as `::before` or `@media (prefers-color-scheme: dark)`. Without it, the layer's own style. */
  block?: string;
}

export interface BrandViolation {
  /** Stable name of what was broken, such as `color.off-palette` or `rule:abc`. Waivers refer to it. */
  rule: string;
  category: BrandCategory;
  severity: Severity;
  node_id: string;
  layer: string;
  message: string;
  /** The brand's own words, when a written rule was broken. Data, not an instruction. */
  rule_text?: string;
  fix: BrandFix;
}

export interface BrandChecklistItem { rule_id: string; text: string; severity: Severity; topic: string; how: string }

/** How well on-brand work is made, beyond keeping to the brand's values. */
export type QualityDimension = 'hierarchy' | 'rhythm' | 'roles' | 'system';

/** One thing that would raise the score, with what it is worth and the layers it is about. */
export interface BrandLever {
  /** A rule of the brand that layers break, or a part of quality that is short of full. */
  kind: 'rule' | 'quality';
  /** The rule, such as `color.off-palette` or `rule:abc`, or the quality dimension. */
  key: string;
  category?: BrandCategory;
  label: string;
  /** Points the score gains when this is fixed everywhere and nothing else changes. */
  gain: number;
  /** How many of its violations are safe fixes, which `fix: true` applies. */
  safe?: number;
  node_ids: string[];
  how: string;
}

export interface BrandScore {
  value: number;
  formula: string;
  /** Conformance: the share of checks against the brand's values that passed, per category, with the layers that failed. */
  categories: { category: BrandCategory; weight: number; checked: number; failed: number; score: number; node_ids: string[] }[];
  /** Weighted average of `categories`. */
  conformance: number;
  /** Weighted average of `quality_parts`; absent when there is too little to judge, such as one button. */
  quality?: number;
  quality_parts: { dimension: QualityDimension; weight: number; score: number; basis: string; how?: string; node_ids?: string[] }[];
  /** What would raise the score most, largest gain first. */
  raise: BrandLever[];
  hard_violations: number;
  /** Distinct hard problems: one colour used on forty layers is one. */
  hard_issues: number;
  hard_penalty: number;
  /** No layers, so `value` means nothing. */
  nothing_checked?: boolean;
}

export interface BrandReport {
  mode: 'rendered' | 'static';
  score: BrandScore;
  counts: { hard: number; soft: number; waived: number; layers: number };
  violations: BrandViolation[];
  waived: { node_id: string; rule: string; reason: string; by: string }[];
  checklist: BrandChecklistItem[];
  /** What was skipped and why, so that nobody takes silence for a pass. */
  not_checked: string[];
}

interface LayerFacts {
  node: BogenNode;
  hasText: boolean;
  text?: string;
  /** Text colour as hex. */
  color?: string;
  /** The solid colour behind this layer. Null when an image or gradient is there, and undefined when unknown. */
  backdrop?: string | null;
  backgrounds: string[];
  borders: string[];
  /** Colours in vector markup and effects. */
  drawn: { prop: string; color: string }[];
  gradient: boolean;
  shadow: boolean;
  glow: boolean;
  family?: string;
  weight?: number;
  size?: number;
  tracking?: number;
  uppercase: boolean;
  spacing: { prop: string; value: number }[];
  radius: number[];
  box?: { x: number; y: number; w: number; h: number };
  objectFit?: string;
  /** The artboard this layer is on, which stands in for the viewport of fluid values. */
  viewport: LengthContext;
  /** Size or spacing declared in viewport units: a render at another width says nothing about them. */
  fluid: { size: boolean; spacing: boolean };
  /** Colour, font or size given through a token of the brand, out of how many were declared at all. */
  tokenUse: { declared: number; branded: number };
  /** Colours and fonts in the layer's pseudo-elements and conditional blocks, which no render at one width or state shows. */
  ruleColors: { block: string; prop: string; color: string; value: string }[];
  ruleFamilies: { block: string; family: string }[];
  /** Text colour and background under each pseudo-element with words and each condition that changes them. */
  rulePairs: RulePair[];
}

// ---------------------------------------------------------------- reading a layer from the document

const VAR = /var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;

export function resolveVars(value: string, tokens: Map<string, string>): string {
  let out = value;
  for (let i = 0; i < 6 && out.includes('var('); i++) out = out.replace(VAR, (_, name: string, fallback?: string) => tokens.get(name) ?? fallback ?? '');
  return out;
}

/** What relative lengths are measured against: the artboard stands in for the viewport. */
export interface LengthContext { vw: number; vh: number; rem?: number; em?: number }

/** The browser viewport the renderer lays pages out in. Viewport units in a render resolve against this. */
const RENDER_VIEWPORT = { vw: 1440, vh: 900 };
const BASE_CONTEXT: LengthContext = { ...RENDER_VIEWPORT, rem: 16, em: 16 };

const UNIT = /^(-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?)(px|rem|em|vw|vh|svh|lvh|dvh|svw|lvw|dvw|vmin|vmax|pt|%)?/i;

/**
 * A CSS length in px, with viewport units taken from `ctx`: px, rem, em, pt, vw, vh and their s/l/d forms, vmin and
 * vmax, inside calc(), min(), max() and clamp(). env() counts as 0, as it does outside a notched phone. Null for what
 * cannot be known without a browser, such as % or a keyword.
 */
export function cssLength(value: string, ctx: LengthContext = BASE_CONTEXT): number | null {
  const src = value.trim().toLowerCase();
  let at = 0;
  type V = { n: number; len: boolean };
  const fail = (): never => { throw new Error('not a length'); };
  const space = () => { while (src[at] === ' ' || src[at] === '\t' || src[at] === '\n') at++; };
  const unit = (n: number, u: string | undefined): V => {
    switch (u) {
      case undefined: return { n, len: false };
      case 'px': return { n, len: true };
      case 'rem': return { n: n * (ctx.rem ?? 16), len: true };
      case 'em': return { n: n * (ctx.em ?? ctx.rem ?? 16), len: true };
      case 'pt': return { n: (n * 4) / 3, len: true };
      case 'vw': case 'svw': case 'lvw': case 'dvw': return { n: (n * ctx.vw) / 100, len: true };
      case 'vh': case 'svh': case 'lvh': case 'dvh': return { n: (n * ctx.vh) / 100, len: true };
      case 'vmin': return { n: (n * Math.min(ctx.vw, ctx.vh)) / 100, len: true };
      case 'vmax': return { n: (n * Math.max(ctx.vw, ctx.vh)) / 100, len: true };
      default: return fail();
    }
  };
  const args = (): V[] => {
    const out: V[] = [];
    for (;;) {
      out.push(sum());
      space();
      if (src[at] === ',') { at++; continue; }
      if (src[at] === ')') { at++; return out; }
      return fail();
    }
  };
  const factor = (): V => {
    space();
    if (src[at] === '-' && !/[\d.]/.test(src[at + 1] ?? '')) { at++; const v = factor(); return { n: -v.n, len: v.len }; }
    if (src[at] === '+') at++;
    if (src[at] === '(') { at++; const v = sum(); space(); if (src[at++] !== ')') fail(); return v; }
    const fn = /^([a-z-]+)\(/.exec(src.slice(at));
    if (fn) {
      at += fn[0].length;
      if (fn[1] === 'env') {
        let depth = 1;
        while (at < src.length && depth) { if (src[at] === '(') depth++; else if (src[at] === ')') depth--; at++; }
        return { n: 0, len: true };
      }
      const list = args();
      const lengths = list.every((v) => v.len || v.n === 0);
      switch (fn[1]) {
        case 'calc': return list.length === 1 ? list[0]! : fail();
        case 'min': return { n: Math.min(...list.map((v) => v.n)), len: lengths };
        case 'max': return { n: Math.max(...list.map((v) => v.n)), len: lengths };
        case 'clamp': return list.length === 3 ? { n: Math.max(list[0]!.n, Math.min(list[1]!.n, list[2]!.n)), len: lengths } : fail();
        default: return fail();
      }
    }
    const m = UNIT.exec(src.slice(at));
    if (!m) return fail();
    at += m[0].length;
    if (m[2] === '%') return fail();
    return unit(Number(m[1]), m[2]);
  };
  const product = (): V => {
    let v = factor();
    for (;;) {
      space();
      const op = src[at];
      if (op !== '*' && op !== '/') return v;
      at++;
      const w = factor();
      if (op === '*') v = { n: v.n * w.n, len: v.len || w.len };
      else { if (w.len || w.n === 0) fail(); v = { n: v.n / w.n, len: v.len }; }
    }
  };
  const sum = (): V => {
    let v = product();
    for (;;) {
      space();
      const op = src[at];
      // In calc() a + or - needs space around it, which also keeps "-2px" a number.
      if ((op !== '+' && op !== '-') || src[at + 1] !== ' ') return v;
      at++;
      const w = product();
      v = { n: op === '+' ? v.n + w.n : v.n - w.n, len: v.len || w.len };
    }
  };
  try {
    const v = sum();
    space();
    if (at !== src.length) return null;
    // A bare number is taken as px, as documents written by hand sometimes have it.
    if (!v.len && v.n !== 0 && !/^-?(?:\d+\.?\d*|\.\d+)$/.test(src)) return null;
    return Number.isFinite(v.n) ? Math.round(v.n * 1000) / 1000 : null;
  } catch {
    return null;
  }
}

const VIEWPORT_UNITS = /\d(?:s|l|d)?v(?:w|h|min|max)\b/;

/** Whether a value changes with the viewport, so that a render at another width says nothing about it. */
export function isFluid(value: string): boolean {
  return VIEWPORT_UNITS.test(value);
}

function pxOf(value: string, ctx?: LengthContext): number | null {
  return cssLength(value, ctx);
}

/** Splits a shorthand into its parts, keeping what is inside brackets together. */
function splitTop(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** The lengths in a shorthand. Anything that is not a length is left out, since it is not known without a browser. */
function pxList(value: string, ctx?: LengthContext): number[] {
  return splitTop(value).flatMap((part) => {
    const n = pxOf(part, ctx);
    return n === null ? [] : [n];
  });
}

/**
 * Fluid values a brand states in words: clamp(), min(), max() and calc() expressions, "3vw between 16px and 48px",
 * and a bare "9.4vw". Brands of fluid sites hold what these come to at one width, and say the rest in notes.
 */
export function fluidExpressions(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  let rest = text;
  for (;;) {
    const m = /\b(?:clamp|min|max|calc)\(/i.exec(rest);
    if (!m) break;
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < rest.length; end++) {
      if (rest[end] === '(') depth++;
      else if (rest[end] === ')' && --depth === 0) break;
    }
    const expr = rest.slice(m.index, end + 1);
    if (cssLength(expr) !== null) out.push(expr);
    rest = `${rest.slice(0, m.index)} ${rest.slice(end + 1)}`;
  }
  rest = rest.replace(/(\d*\.?\d+)vw\s+(?:between|from)\s+(\d*\.?\d+)px\s+(?:and|to)\s+(\d*\.?\d+)px/gi, (_, v: string, lo: string, hi: string) => {
    out.push(`clamp(${lo}px, ${v}vw, ${hi}px)`);
    return ' ';
  });
  for (const m of rest.matchAll(/(?<![\w.])(\d*\.?\d+)(vw|vh)\b/gi)) out.push(`${m[1]}${m[2]!.toLowerCase()}`);
  return out;
}

/** Fixed steps, and fluid ones from the brand's notes as they come out at this viewport. */
function stepsAt(fixed: number[], fluid: string[], ctx: LengthContext): number[] {
  const out = new Set(fixed);
  for (const expr of fluid) {
    const v = cssLength(expr, ctx);
    if (v !== null && v > 0) out.add(Math.round(v * 100) / 100);
  }
  return [...out];
}

function firstFamily(value: string): string {
  return (value.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}

const SPACING_PROPS = ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'paddingInline', 'paddingBlock', 'gap', 'rowGap', 'columnGap', 'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'marginInline', 'marginBlock'];
const RADIUS_PROPS = ['borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'];
const BORDER_PROPS = ['border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outline', 'outlineColor'];

function hasBlur(shadow: string): boolean {
  return /\d(px|rem|em)?\s+\d*\.?\d+(px|rem|em)?\s+[1-9]/.test(shadow) || /\bblur\(/.test(shadow);
}

const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
/** Path data that is only separate straight segments, each a move and one line. */
const SEGMENTS = new RegExp(String.raw`^(?:\s*[Mm]\s*${NUM}[\s,]*${NUM}\s*(?:[Ll]\s*${NUM}[\s,]*${NUM}|[HhVv]\s*${NUM})\s*)+$`);
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'text', 'tspan', 'use']);

/**
 * Colours a drawing shows. What a mask or a definition holds only cuts shapes out or is used elsewhere. A fill or
 * stroke on a group or the root only shows through a shape that sets none of its own, which matters for captured
 * markup, whose root carries the browser's defaults; and a stop colour only paints on a gradient stop.
 */
export function svgColors(svg: string): { prop: string; color: string }[] {
  const markup = svg.replace(/<(mask|defs|clipPath)\b[\s\S]*?<\/\1>/gi, '');
  const own = (attrs: string, prop: string): string | undefined => {
    const style = /\bstyle\s*=\s*"([^"]*)"|\bstyle\s*=\s*'([^']*)'/i.exec(attrs);
    const inStyle = style ? new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(style[1] ?? style[2] ?? '') : null;
    if (inStyle) return inStyle[1]!.trim();
    const attr = new RegExp(`(?:^|\\s)${prop}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs.replace(/\bstyle\s*=\s*("[^"]*"|'[^']*')/gi, ''));
    return attr?.[1]?.trim();
  };
  const elements = [...markup.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>/g)].map((m) => ({ tag: m[1]!.toLowerCase(), attrs: m[2]! }));
  const shapes = elements.filter((e) => SHAPES.has(e.tag));
  // A line, or a path that is one straight segment, encloses nothing, so a fill does not show on it.
  const flat = (e: { tag: string; attrs: string }) => e.tag === 'line' || (e.tag === 'path' && SEGMENTS.test(/\bd\s*=\s*["']([^"']*)["']/.exec(e.attrs)?.[1] ?? 'x'));
  const bare = { fill: shapes.some((e) => own(e.attrs, 'fill') === undefined && !flat(e)), stroke: shapes.some((e) => own(e.attrs, 'stroke') === undefined) };
  const out: { prop: string; color: string }[] = [];
  for (const e of elements) {
    const shape = SHAPES.has(e.tag);
    for (const prop of ['fill', 'stroke', 'stop-color'] as const) {
      if (prop === 'stop-color' ? e.tag !== 'stop' : !shape && !bare[prop]) continue;
      if (prop === 'fill' && flat(e)) continue;
      const value = own(e.attrs, prop);
      const color = value ? normalizeColor(value) : null;
      if (color) out.push({ prop, color });
    }
  }
  return out;
}

/** What the document says about a layer, with tokens resolved. */
function staticFacts(doc: BogenDoc, node: BogenNode, tokens: Map<string, string>, viewport: LengthContext = BASE_CONTEXT, brandTokenNames: Set<string> = new Set()): LayerFacts {
  const s: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.style)) s[k] = resolveVars(v, tokens);
  const tokenUse = { declared: 0, branded: 0 };
  for (const prop of ['color', 'backgroundColor', 'background', 'fontFamily', 'fontSize', 'borderColor']) {
    const raw = node.style[prop];
    if (!raw || /^(?:inherit|transparent|none|currentcolor)$/i.test(raw.trim())) continue;
    tokenUse.declared++;
    const used = [...raw.matchAll(/var\(\s*--([\w-]+)/g)].map((m) => m[1]!);
    if (used.some((t) => brandTokenNames.has(t))) tokenUse.branded++;
  }
  const backgrounds: string[] = [];
  const bgValue = `${s.background ?? ''} ${s.backgroundColor ?? ''}`.trim();
  const gradient = /gradient\(/i.test(`${s.background ?? ''} ${s.backgroundImage ?? ''}`);
  if (!gradient) backgrounds.push(...colorsIn(bgValue.replace(/url\([^)]*\)/g, '')));
  const borders = BORDER_PROPS.flatMap((p) => (s[p] ? colorsIn(s[p]!) : []));
  const shadowText = `${s.boxShadow ?? ''} ${s.textShadow ?? ''}`.trim();
  const shadow = Boolean(shadowText && !/^none(\s+none)?$/.test(shadowText)) || /drop-shadow\(/.test(s.filter ?? '');
  const glow = (shadow && hasBlur(shadowText)) || /(drop-shadow|blur)\(/.test(`${s.filter ?? ''} ${s.backdropFilter ?? ''}`);
  const drawn: { prop: string; color: string }[] = [];
  if (node.type === 'svg' && node.svg) drawn.push(...svgColors(node.svg));
  if (node.type === 'shader') for (const part of (node.attrs?.colors ?? '').split(',')) {
    const color = normalizeColor(part.trim());
    if (color) drawn.push({ prop: 'shader', color });
  }
  const size = s.fontSize ? pxOf(s.fontSize, { ...viewport, em: 16 }) ?? undefined : undefined;
  const own = { ...viewport, em: size ?? 16 };
  const spacing = SPACING_PROPS.flatMap((prop) => (s[prop] ? pxList(s[prop]!, own).map((value) => ({ prop, value })) : []));
  const radius = RADIUS_PROPS.flatMap((prop) => (s[prop] ? pxList(s[prop]!, own) : []));
  const hasText = Boolean(node.text?.trim());
  const weight = s.fontWeight ? (s.fontWeight === 'bold' ? 700 : s.fontWeight === 'normal' ? 400 : Number(s.fontWeight) || undefined) : undefined;
  const tracking = s.letterSpacing ? pxOf(s.letterSpacing, own) ?? undefined : undefined;
  const fluid = { size: isFluid(s.fontSize ?? ''), spacing: SPACING_PROPS.some((p) => isFluid(s[p] ?? '')) };

  const ruleColors: LayerFacts['ruleColors'] = [];
  const ruleFamilies: LayerFacts['ruleFamilies'] = [];
  for (const r of ruleValues(node.rules)) {
    const value = resolveVars(r.value, tokens);
    if (r.prop === 'fontFamily' || r.prop === 'font') {
      // In the shorthand the family comes after the size, which has a unit: `500 .75rem/1 Archivo`.
      const family = r.prop === 'font' ? /(?:^|\s)[\d.]+(?:px|r?em|%|pt|vw|vh|ch)(?:\/\S+)?\s+(.+)$/.exec(value)?.[1] : value;
      if (family && !/^var\(/.test(family)) ruleFamilies.push({ block: r.block, family: firstFamily(family) });
    } else if (/color$|^background$|^border|^outline|^fill$|^stroke$|shadow$/i.test(r.prop) && !/gradient\(|url\(/i.test(value)) {
      for (const color of colorsIn(value)) ruleColors.push({ block: r.block, prop: r.prop, color, value: r.value });
    }
  }

  const facts: LayerFacts = {
    ruleColors, ruleFamilies, rulePairs: rulePairs(doc, node, tokens),
    node, hasText, ...(node.text ? { text: node.text } : {}), backgrounds, borders, drawn, gradient, shadow, glow,
    uppercase: s.textTransform === 'uppercase', spacing, radius,
    ...(s.fontFamily ? { family: firstFamily(s.fontFamily) } : {}), ...(weight ? { weight } : {}), ...(size ? { size } : {}), ...(tracking !== undefined ? { tracking } : {}),
    ...(s.objectFit ? { objectFit: s.objectFit } : {}),
    viewport, fluid, tokenUse,
  };
  const w = s.width ? pxOf(s.width, own) : null;
  const h = s.height ? pxOf(s.height, own) : null;
  if (w !== null && h !== null) facts.box = { x: 0, y: 0, w, h };
  else if (w !== null) facts.box = { x: 0, y: 0, w, h: 0 };

  // What a layer inherits is known only as far as its ancestors declare it.
  let cur: BogenNode | undefined = node;
  let color: string | undefined;
  let backdrop: string | null | undefined;
  const veils: string[] = [];
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const st = cur.style;
    if (color === undefined && st.color) color = normalizeColor(resolveVars(st.color, tokens)) ?? undefined;
    if (backdrop === undefined) {
      const bg = resolveVars(`${st.background ?? ''} ${st.backgroundColor ?? ''}`, tokens);
      if (/gradient\(|url\(/i.test(`${bg} ${st.backgroundImage ?? ''}`)) backdrop = null;
      else {
        const found = colorsIn(bg)[0];
        if (found) {
          if (colorAlpha(found) >= 1) backdrop = veils.reduceRight((under, top) => flattenColor(top, under), found);
          else veils.push(found);
        }
      }
    }
    cur = doc.getNode(cur.parent);
  }
  if (hasText && color) facts.color = color;
  if (backdrop !== undefined) facts.backdrop = backdrop;
  return facts;
}

// ---------------------------------------------------------------- reading a layer from a render

interface Rendered {
  id: string; c: string; bb: string | null; bg: string; bo: string[]; ff: string; fw: number; fs: number; ls: number; tt: string; pad: number[]; gap: number[]; rad: number[];
  sh: boolean; gl: boolean; gr: boolean; x: number; y: number; w: number; h: number; hasText: boolean; of: string;
  /** Pseudo-elements that show words, as they rendered. */
  ps: { block: string; c: string; bb: string | null; fs: number; fw: number }[];
}

/** Runs in the page, so it can only use its argument. */
function renderedProbe(arg: { ids: string[] }): Rendered[] {
  const wanted = new Set(arg.ids);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const hexPair = (n: number) => n.toString(16).padStart(2, '0');
  const rgba = (css: string): [number, number, number, number] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
  };
  const hex = (c: number[]) => `#${hexPair(Math.round(c[0]!))}${hexPair(Math.round(c[1]!))}${hexPair(Math.round(c[2]!))}${(c[3] ?? 1) < 1 ? hexPair(Math.round((c[3] ?? 1) * 255)) : ''}`;
  const over = (top: number[], bottom: number[]) => {
    const a = top[3] ?? 1;
    return [top[0]! * a + bottom[0]! * (1 - a), top[1]! * a + bottom[1]! * (1 - a), top[2]! * a + bottom[2]! * (1 - a), 1];
  };
  const backdropRgb = (el: Element): number[] | null => {
    const layers: number[][] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      const style = getComputedStyle(cur);
      if (style.backgroundImage !== 'none') return null;
      if (cur.querySelector(':scope > [data-shader], :scope > video')) return null;
      const color = rgba(style.backgroundColor);
      if (color[3] > 0) {
        layers.push(color);
        if (color[3] >= 1) break;
      }
    }
    let base = [255, 255, 255, 1];
    for (const layer of layers.reverse()) base = over(layer, base);
    return base;
  };
  const backdrop = (el: Element): string | null => {
    const base = backdropRgb(el);
    return base ? hex(base) : null;
  };
  // The words a ::before or ::after puts in, with what they are drawn in and on.
  const pseudos = (el: Element, seen: number): Rendered['ps'] => {
    const found: Rendered['ps'] = [];
    for (const block of ['::before', '::after']) {
      const ps = getComputedStyle(el, block);
      const words = /^"((?:\\.|[^"])*)"$/.exec(ps.content ?? '');
      if (!words || !/[\p{L}\p{N}]/u.test(words[1]!) || ps.display === 'none' || ps.visibility === 'hidden') continue;
      const under = backdropRgb(el);
      const own = rgba(ps.backgroundColor);
      const bb = ps.backgroundImage !== 'none' ? null : under && (own[3] > 0 ? over(own, under) : under);
      const fg = rgba(ps.color);
      fg[3] *= Number(ps.opacity) * seen;
      found.push({ block, c: hex(bb ? over(fg, bb) : fg), bb: bb ? hex(bb) : null, fs: px(ps.fontSize), fw: Number(ps.fontWeight) || 400 });
    }
    return found;
  };
  const px = (v: string) => Number.parseFloat(v) || 0;
  const out: Rendered[] = [];
  const texts: [Rendered, HTMLElement][] = [];
  for (const el of document.querySelectorAll<HTMLElement>('[data-bogen-id]')) {
    const id = el.dataset.bogenId!;
    if (!wanted.has(id)) continue;
    const s = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (s.display === 'none' || s.visibility === 'hidden' || !box.width || !box.height) continue;
    // Something fully transparent shows nothing, such as a state an animation reveals later.
    let seen = 1;
    for (let cur: Element | null = el; cur && seen > 0; cur = cur.parentElement) seen *= Number(getComputedStyle(cur).opacity);
    if (seen <= 0.02) continue;
    const hasText = [...el.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent?.trim());
    const borders = ['Top', 'Right', 'Bottom', 'Left'].flatMap((side) => {
      const st = s as unknown as Record<string, string>;
      return px(st[`border${side}Width`]!) > 0 && st[`border${side}Style`] !== 'none' ? [st[`border${side}Color`]!] : [];
    });
    const shadowText = s.boxShadow !== 'none' ? s.boxShadow : '';
    const textShadow = s.textShadow !== 'none' ? s.textShadow : '';
    const blurred = (v: string) => /\s[1-9][\d.]*px\s+[-\d.]+px$|\s[1-9][\d.]*px\s+[-\d.]+px,/.test(v);
    const bgColor = rgba(s.backgroundColor);
    out.push({
      id, c: hasText ? hex(rgba(s.color)) : '', bb: backdrop(el), bg: bgColor[3] > 0 ? hex(bgColor) : '', bo: [...new Set(borders.map((b) => hex(rgba(b))))],
      ff: s.fontFamily, fw: Number(s.fontWeight) || 400, fs: px(s.fontSize), ls: s.letterSpacing === 'normal' ? 0 : px(s.letterSpacing), tt: s.textTransform,
      pad: [px(s.paddingTop), px(s.paddingRight), px(s.paddingBottom), px(s.paddingLeft)],
      gap: s.display.includes('flex') || s.display.includes('grid') ? [px(s.rowGap), px(s.columnGap)] : [],
      rad: [px(s.borderTopLeftRadius), px(s.borderTopRightRadius), px(s.borderBottomLeftRadius), px(s.borderBottomRightRadius)],
      sh: Boolean(shadowText || textShadow) || /drop-shadow/.test(s.filter),
      gl: blurred(shadowText) || blurred(textShadow) || /(drop-shadow|blur)\(/.test(`${s.filter} ${(s as unknown as { backdropFilter?: string }).backdropFilter ?? ''}`),
      gr: /gradient\(/.test(s.backgroundImage), x: box.x, y: box.y, w: box.width, h: box.height, hasText, of: s.objectFit, ps: pseudos(el, seen),
    });
    if (hasText) texts.push([out.at(-1)!, el]);
  }
  // Text over a drawing or a picture that is not its ancestor, such as words on an illustration behind them, has no
  // backdrop of one colour. Only hit testing sees that, and only on screen, so each text is scrolled to first.
  for (const [entry, el] of texts) {
    if (entry.bb === null) continue;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    for (const under of document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)) {
      if (under === el || el.contains(under)) continue;
      // An ancestor with a background of its own hides what is under it; a clear one does not.
      if (under.contains(el)) {
        if (rgba(getComputedStyle(under).backgroundColor)[3] > 0) break;
        continue;
      }
      if (under.closest('svg') || /^(IMG|VIDEO|CANVAS|IFRAME)$/.test(under.tagName) || getComputedStyle(under).backgroundImage !== 'none') {
        entry.bb = null;
        break;
      }
    }
  }
  return out;
}

function mergeRendered(facts: LayerFacts, r: Rendered): LayerFacts {
  const margin = facts.spacing.filter((s) => s.prop.startsWith('margin'));
  // The renderer lays out at its own viewport, so what viewport units come to on an artboard of another width is
  // what the document says, worked out at the artboard's width.
  const elsewhere = Math.abs(facts.viewport.vw - RENDER_VIEWPORT.vw) > 1;
  const ownSize = elsewhere && facts.fluid.size && facts.size !== undefined;
  const ownSpacing = elsewhere && facts.fluid.spacing;
  // A pseudo-element as it rendered beats what the styles say about it; a condition takes what it does not set from the render.
  const pairs = facts.rulePairs.flatMap((p): RulePair[] => {
    const shown = r.ps.find((x) => x.block === p.block);
    if (shown) return [{ ...p, color: shown.c, backdrop: shown.bb, size: shown.fs, weight: shown.fw }];
    if (p.block === '::before' || p.block === '::after') return [];
    return [{ ...p, ...(!p.sets.color && r.c ? { color: r.c } : {}), ...(!p.sets.backdrop ? { backdrop: r.bb } : {}) }];
  });
  return {
    ...facts,
    rulePairs: pairs,
    hasText: r.hasText || facts.hasText,
    ...(r.c ? { color: r.c } : {}),
    backdrop: r.bb,
    backgrounds: r.bg ? [r.bg] : [],
    borders: r.bo,
    gradient: r.gr,
    shadow: r.sh,
    glow: r.gl,
    family: firstFamily(r.ff),
    weight: r.fw,
    size: ownSize ? facts.size! : r.fs,
    tracking: r.ls,
    uppercase: r.tt === 'uppercase',
    spacing: ownSpacing ? facts.spacing : [
      ...r.pad.filter((v) => v > 0).map((value) => ({ prop: 'padding', value })),
      ...r.gap.filter((v) => v > 0).map((value) => ({ prop: 'gap', value })),
      // A computed margin also holds what `auto` came to, so only declared margins say anything.
      ...margin,
    ],
    radius: r.rad,
    box: { x: r.x, y: r.y, w: r.w, h: r.h },
    objectFit: r.of,
  };
}

// ---------------------------------------------------------------- what is being checked

export type Scope = { nodeId: string } | { pageId: string } | { file: true };

export function layersIn(doc: BogenDoc, scope: Scope): BogenNode[] {
  let nodes: BogenNode[] = [];
  if ('nodeId' in scope) {
    const node = doc.getNode(scope.nodeId);
    if (!node) throw new Error(`No layer with id ${scope.nodeId}. Call layer_tree to see what exists.`);
    nodes = [node, ...doc.descendants(scope.nodeId)];
  } else if ('pageId' in scope) nodes = doc.descendants(scope.pageId);
  else for (const p of doc.getPages()) nodes.push(...doc.descendants(p.id));
  // A hidden layer shows nothing, and neither does anything inside it.
  const hidden = new Set(nodes.filter((n) => n.hidden).map((n) => n.id));
  return nodes.filter((n) => !hidden.has(n.id) && !doc.ancestors(n.id).some((a) => hidden.has(a)));
}

function tokenMap(doc: BogenDoc): Map<string, string> {
  return new Map(doc.getTokens().map((t) => [t.name, t.value]));
}

/** Tokens of this file that stand for the brand: the brand's own names, and others holding exactly a brand value. */
function brandTokenNames(data: BrandData, tokens: Map<string, string>): Set<string> {
  const brand = brandTokens(data);
  const norm = (v: string) => normalizeColor(v) ?? v.trim().toLowerCase().replace(/\s+/g, ' ');
  const values = new Set(brand.map((t) => norm(t.value)));
  const out = new Set(brand.map((t) => t.name));
  for (const [name, value] of tokens) if (values.has(norm(resolveVars(value, tokens)))) out.add(name);
  return out;
}

/** The top-level layer each layer sits in, whose size stands in for the viewport of fluid values. */
function viewports(doc: BogenDoc, measured: Map<string, number> = new Map()): (node: BogenNode) => LengthContext {
  const cache = new Map<string, LengthContext>();
  const topOf = (node: BogenNode): BogenNode => {
    let cur = node;
    for (let i = 0; i < 2000; i++) {
      const up = doc.getNode(cur.parent);
      if (!up) return cur;
      cur = up;
    }
    return cur;
  };
  return (node) => {
    const top = topOf(node);
    let ctx = cache.get(top.id);
    if (!ctx) {
      // The height of an artboard is what its content made it, so viewport heights stay those of the renderer.
      const w = measured.get(top.id) ?? cssLength(top.style.width ?? '') ?? RENDER_VIEWPORT.vw;
      ctx = { vw: w > 0 ? w : RENDER_VIEWPORT.vw, vh: RENDER_VIEWPORT.vh, rem: 16, em: 16 };
      cache.set(top.id, ctx);
    }
    return ctx;
  };
}

/** Top-level layers of these layers, to measure their width in a render. */
function topIds(doc: BogenDoc, nodes: BogenNode[]): string[] {
  const out = new Set<string>();
  for (const n of nodes) {
    let cur = n;
    for (let i = 0; i < 2000; i++) {
      const up = doc.getNode(cur.parent);
      if (!up) break;
      cur = up;
    }
    out.add(cur.id);
  }
  return [...out];
}

// ---------------------------------------------------------------- the checks

const NEAR_COLOR = 4;
/** A colour this close to one of the palette is a shade of it: still reported, at half the cost. */
const SHADE_COLOR = 6;
const PALETTE_COLOR = 2.5;
const ASPECT_TOLERANCE = 0.03;
const SIZE_TOLERANCE = 0.6;
const SPACING_TOLERANCE = 0.5;
/** A size or gap this close to a step reads as that step, though it is not exactly it: half the credit, and still reported. */
const NEAR_SIZE = 0.08;
const NEAR_SPACING = 0.12;
const NEAR_SPACING_PX = 1.5;
const SAFE_SNAP_PX = 1;
const MONO = /mono|code|consol|courier|menlo/i;

const WEIGHTS: Record<BrandCategory, number> = { colour: 25, contrast: 10, type: 20, spacing: 10, shape: 10, logo: 5, voice: 10, rules: 10, tokens: 5 };

interface Tally { checked: Map<BrandCategory, number>; failed: Map<BrandCategory, number>; lost: Map<BrandCategory, number> }

const round2 = (n: number) => Math.round(n * 100) / 100;

function nearest<T>(items: T[], distance: (item: T) => number): { item: T; distance: number } | null {
  let best: { item: T; distance: number } | null = null;
  for (const item of items) {
    const d = distance(item);
    if (!best || d < best.distance) best = { item, distance: d };
  }
  return best;
}

function roleFamily(data: BrandData, facts: LayerFacts): BrandFamily | undefined {
  const families = confirmed(data.families);
  const byRole = (re: RegExp) => families.find((f) => re.test(f.role));
  if (['code', 'pre', 'kbd', 'samp'].includes(facts.node.tag) || MONO.test(facts.family ?? '')) return byRole(/mono|code/i) ?? byRole(/body|text/i) ?? families[0];
  const display = /^h[1-3]$/.test(facts.node.tag) || (facts.size ?? 0) >= 28;
  return (display ? byRole(/display|head/i) : byRole(/body|text/i)) ?? families[0];
}

function wordRegex(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu');
}

function normalizedSvg(markup: string): string {
  return sanitizeSvgMarkup(markup).replace(/\s+/g, '');
}

/** The shapes of a drawing, which stay the same when markup is captured from a page or written out again. */
function svgShapes(markup: string): string[] {
  return [...markup.matchAll(/\bd\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!.replace(/[\s,]+/g, ' ').trim()).filter((d) => d.length >= 12);
}

/**
 * The brand logo a layer shows: the same file or markup, or a drawing holding all of a logo's shapes, as a page
 * captured with Capture has it. Of variants that look the same, the one meant for this background.
 */
function logoOf(data: BrandData, node: BogenNode, backdrop?: string | null): BrandLogo | undefined {
  let found: BrandLogo[] = [];
  if (node.type === 'image' && node.src) found = data.logos.filter((l) => l.asset && l.asset === node.src);
  else if (node.type === 'svg' && node.svg) {
    const key = normalizedSvg(node.svg);
    found = data.logos.filter((l) => l.svg && normalizedSvg(l.svg) === key);
    if (!found.length) {
      const have = new Set(svgShapes(node.svg));
      found = data.logos.filter((l) => {
        const shapes = l.svg ? svgShapes(l.svg) : [];
        return shapes.length > 0 && shapes.every((d) => have.has(d));
      });
    }
  }
  if (found.length > 1 && backdrop) return found.find((l) => logoFitsBackground(data, l.background, backdrop)) ?? found[0];
  return found[0];
}

const LOGO_NAME = /\b(logo|logotype|logomark|wordmark)\b/i;

function looksLikeLogo(node: BogenNode): boolean {
  if (node.type !== 'image' && node.type !== 'svg') return false;
  return LOGO_NAME.test(node.name) || LOGO_NAME.test(node.attrs?.alt ?? '') || LOGO_NAME.test(node.attrs?.['aria-label'] ?? '');
}

function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length >= 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

/** Compares one list of facts with a brand, and reports what broke. It reads no renderer, so it stays cheap. */
/** Marks a frame as a deliberate example of what not to do, such as the wrong pairs in a brand guideline. */
export const COUNTER_EXAMPLE = { attr: 'data-brand-example', value: 'dont' } as const;

/** Whether a layer sits inside a counter-example, which a check leaves out and reports as left out. */
export function inCounterExample(doc: BogenDoc, id: string): boolean {
  return [id, ...doc.ancestors(id)].some((a) => doc.getNode(a)?.attrs?.[COUNTER_EXAMPLE.attr] === COUNTER_EXAMPLE.value);
}

export function evaluate(doc: BogenDoc, data: BrandData, allFacts: LayerFacts[], options: { fileLevel: boolean; mode: 'rendered' | 'static'; /** The design language this check judges, when a run wrote in another than the file's. */ contentLanguage?: string | null }): BrandReport {
  // What a person or template shows as wrong on purpose is not held to the brand, and the report says how much that is.
  const facts = allFacts.filter((f) => !inCounterExample(doc, f.node.id));
  const skipped = allFacts.length - facts.length;
  const tally: Tally = { checked: new Map(), failed: new Map(), lost: new Map() };
  const hardIssues = new Map<string, number>();
  const hardLayers = new Set<string>();
  // What each violation cost, in the order of `violations`, so that the score can say what fixing a kind of them is worth.
  const costs: ViolationCost[] = [];
  const count = (category: BrandCategory) => tally.checked.set(category, (tally.checked.get(category) ?? 0) + 1);
  const violations: BrandViolation[] = [];
  const waivers = new Map(readWaivers(doc).map((w) => [waiverKey(w.nodeId, w.rule), w]));
  const waived: BrandReport['waived'] = [];
  const notChecked: string[] = [];
  const tokens = tokenMap(doc);
  // `credit` is what a near miss still earns; `issue` says which repeats are one decision, such as one colour.
  const add = (facts: LayerFacts | null, category: BrandCategory, rule: string, severity: Severity, message: string, fix: BrandFix, ruleText?: string, extra: { credit?: number; issue?: string } = {}) => {
    const nodeId = facts?.node.id ?? '';
    const waiver = nodeId ? waivers.get(waiverKey(nodeId, rule)) : undefined;
    if (waiver) {
      waived.push({ node_id: nodeId, rule, reason: waiver.reason, by: waiver.by });
      return;
    }
    tally.failed.set(category, (tally.failed.get(category) ?? 0) + 1);
    tally.lost.set(category, (tally.lost.get(category) ?? 0) + 1 - (extra.credit ?? 0));
    const issue = severity === 'hard' ? `${rule}|${extra.issue ?? message}` : undefined;
    if (issue) {
      hardIssues.set(issue, Math.max(hardIssues.get(issue) ?? 0, 1 - (extra.credit ?? 0)));
      if (nodeId) hardLayers.add(nodeId);
    }
    costs.push({ lost: 1 - (extra.credit ?? 0), ...(issue ? { issue } : {}) });
    violations.push({ rule, category, severity, node_id: nodeId, layer: facts?.node.name ?? '', message, ...(ruleText ? { rule_text: ruleText } : {}), fix });
  };

  // What binds: confirmed values. Suggestions are allowed to appear, but they cannot be broken.
  const palette = confirmed(data.colors);
  // A colour's value in a theme mode belongs to the palette too.
  const allColors = data.colors.flatMap((c) => [c, ...Object.values(c.modes ?? {}).map((value) => ({ ...c, value }))]);
  const families = confirmed(data.families);
  const allFamilies = data.families;
  const scale = confirmed(data.typeScale);
  const spacingScale = confirmed(data.spacing).map((s) => s.value);
  const radiusScale = confirmed(data.radius).map((s) => s.value);
  const fixedSizes = data.typeScale.map((t) => t.size);
  const fluidSizes = data.typeScale.flatMap((t) => fluidExpressions(t.note ?? ''));
  const fixedSpacing = data.spacing.map((s) => s.value);
  const fluidSpacing = [...data.spacing.flatMap((s) => fluidExpressions(s.note ?? '')), ...fluidExpressions(data.fields.layoutNotes ?? '')];
  // Steps come out per artboard width, and a page has few of those.
  const atWidth = new Map<number, { sizes: number[]; spacing: number[] }>();
  const stepsFor = (f: LayerFacts) => {
    const key = Math.round(f.viewport.vw);
    let steps = atWidth.get(key);
    if (!steps) {
      steps = { sizes: stepsAt(fixedSizes, fluidSizes, f.viewport), spacing: stepsAt(fixedSpacing, fluidSpacing, f.viewport) };
      atWidth.set(key, steps);
    }
    return steps;
  };
  const allowedRadius = data.radius.map((s) => s.value);
  const weights = new Set<number>([...data.typeScale.map((t) => t.weight).filter(Boolean), ...data.families.flatMap((f) => f.weights)]);
  const avoid = confirmed(data.words).filter((w) => w.use === 'avoid');
  const rules = confirmed(data.rules).filter((r) => !r.flagged);
  // Copy is judged in the brand language it is written in: what its layer or artboard declares (lang), else the
  // design's language, else what its words say, else the brand's primary. Words and text rules follow that language.
  const profile = voiceProfile(data, { contentLanguage: options.contentLanguage ?? contentLanguageOf(doc) });
  const declared = new Map<string, string | null>();
  const declaredOf = (id: string) => {
    if (!declared.has(id)) declared.set(id, declaredLanguageOf(doc, id));
    return declared.get(id)!;
  };
  const spokenIn = (f: LayerFacts) => judgeCopy(profile, { text: f.text ?? '', lang: declaredOf(f.node.id) }).spoken;
  const textRules = new Map<string | null, BrandRule[]>();
  const textRulesFor = (spoken: string | null) => {
    if (!textRules.has(spoken)) textRules.set(spoken, itemsForLanguage(rules.filter((r) => r.check?.type === 'forbid-text'), profile.languages, spoken, { fallback: false }));
    return textRules.get(spoken)!;
  };
  const avoidIn = new Map<string | null, typeof avoid>();
  const avoidFor = (spoken: string | null) => {
    if (!avoidIn.has(spoken)) avoidIn.set(spoken, itemsForLanguage(avoid, profile.languages, spoken));
    return avoidIn.get(spoken)!;
  };
  const logos = confirmed(data.logos);
  const pairing = confirmed(data.pairings);

  const colorRef = (hex: string, prop: string): Record<string, string> => {
    const c = palette.find((p) => p.value === hex);
    return { [prop]: c && tokens.has(c.token) ? `var(--${c.token})` : hex };
  };
  const checkColor = (f: LayerFacts, value: string, prop: string, styleProp: string | null, rule?: { block: string; raw: string }) => {
    if (!palette.length) return;
    count('colour');
    const alpha = colorAlpha(value);
    if (alpha <= 0) return;
    const base = value.length === 9 ? value.slice(0, 7) : value;
    const known = nearest(allColors, (c) => colorDistance(c.value, base));
    if (known && known.distance <= PALETTE_COLOR) return;
    const best = nearest(palette, (c) => colorDistance(c.value, base))!;
    const near = best.distance <= NEAR_COLOR;
    const shade = best.distance <= SHADE_COLOR;
    // In a block, the colour is swapped inside the value it sits in, so that a border keeps its width.
    let style: Record<string, string> | undefined;
    if (rule && styleProp) {
      const swapped = swapColor(rule.raw, base, colorRef(best.item.value, 'value').value!);
      if (swapped) style = { [styleProp]: swapped };
    } else if (styleProp) style = colorRef(best.item.value, styleProp);
    const fix: BrandFix = {
      description: near ? `Snap ${value} to ${best.item.name} (${best.item.value})${rule ? ` in ${rule.block}` : ''}.` : `Use a colour of the palette${rule ? ` in ${rule.block}` : ''}. The closest is ${best.item.name} (${best.item.value}), but look before you pick.`,
      safe: near && style !== undefined,
      ...(style ? { style } : {}),
      ...(rule && style ? { block: rule.block } : {}),
      ...(!styleProp && f.node.svg ? { svg: `${value}=>${best.item.value}` } : {}),
    };
    add(f, 'colour', 'color.off-palette', data.fields.offPalette, `${prop} is ${value}, which is not in the palette${near ? `, but very close to ${best.item.name}` : shade ? `, but a shade of ${best.item.name}` : ''}.`, fix, undefined, { issue: base, ...(shade ? { credit: 0.5 } : {}) });
  };

  const distinctFamilies = new Set<string>();
  const onPalette = (hex: string) => {
    const hit = nearest(allColors, (c) => colorDistance(c.value, hex));
    return hit && hit.distance <= PALETTE_COLOR ? hit.item : undefined;
  };

  for (const f of facts) {
    const { node } = f;
    const logo = logoOf(data, node, f.backdrop);

    // Colours. An image placeholder draws itself in a tint of the text colour, which is not a colour of its own.
    const placeholder = node.type === 'image' && !node.src;
    if (!logo) {
      for (const bg of placeholder && !node.style.backgroundColor && !node.style.background ? [] : f.backgrounds) {
        const prop = /^(?:#|rgb|hsl|[a-z]+$)/i.test(node.style.background ?? '') && !node.style.backgroundColor ? 'background' : 'backgroundColor';
        checkColor(f, bg, 'Background', prop);
      }
      for (const b of placeholder && !Object.keys(node.style).some((k) => k.startsWith('border')) ? [] : f.borders) checkColor(f, b, 'Border', 'borderColor');
      for (const d of f.drawn) checkColor(f, d.color, `Vector ${d.prop}`, null);
      // A safe fix goes into the block the colour is in.
      for (const r of f.ruleColors) checkColor(f, r.color, `${r.prop} in ${r.block}`, r.prop, { block: r.block, raw: r.value });
    }
    for (const r of f.ruleFamilies) {
      if (!families.length) break;
      distinctFamilies.add(r.family.toLowerCase());
      count('type');
      if (!allFamilies.some((b) => b.family.toLowerCase() === r.family.toLowerCase())) {
        const target = roleFamily(data, f);
        add(f, 'type', 'type.off-brand-font', 'hard', `The font in ${r.block} is ${r.family}, which is not a brand font.`, { description: `${target ? `Use ${target.family}` : 'Use a brand font'} there, with layer_style and its pseudo or when.`, safe: false }, undefined, { issue: r.family.toLowerCase() });
      }
    }

    // A placeholder's label is Bogen's, not the design's words.
    if (f.hasText && !placeholder) {
      if (f.color) checkColor(f, f.color, 'Text colour', 'color');

      // Pairing and contrast
      if (f.color && f.backdrop) {
        const fgHex = colorAlpha(f.color) < 1 ? flattenColor(f.color, f.backdrop) : f.color;
        const fg = onPalette(f.color.length === 9 ? f.color.slice(0, 7) : f.color);
        const bg = onPalette(f.backdrop);
        if (fg && bg && pairing.length) {
          count('colour');
          const listed = pairing.find((p) => resolveBrandColor(data, p.fg)?.id === fg.id && resolveBrandColor(data, p.bg)?.id === bg.id);
          if (listed?.verdict === 'forbid' || (!listed && data.fields.pairingDefault === 'forbid' && fg.id !== bg.id)) {
            const allowed = pairing.filter((p) => p.verdict === 'allow' && resolveBrandColor(data, p.bg)?.id === bg.id).map((p) => resolveBrandColor(data, p.fg)).filter(Boolean);
            const alt = allowed[0];
            add(f, 'colour', 'color.forbidden-pair', 'hard', `${fg.name} on ${bg.name} is not an allowed pair${listed?.note ? `: ${listed.note}` : ''}.`, {
              description: alt ? `Use ${alt.name} on ${bg.name}, which is allowed.` : `Pick a pair the brand allows; none is listed for ${bg.name}.`,
              safe: false, ...(alt ? { style: colorRef(alt.value, 'color') } : {}),
            });
          }
        }
        count('contrast');
        const ratio = contrastRatio(fgHex, f.backdrop);
        const large = (f.size ?? 0) >= 24 || ((f.size ?? 0) >= 18.66 && (f.weight ?? 400) >= 700);
        const need = large ? Math.min(3, data.fields.minContrast) : data.fields.minContrast;
        if (ratio < need) {
          const better = nearest(palette.filter((c) => contrastRatio(c.value, f.backdrop!) >= need), (c) => colorDistance(c.value, fgHex));
          add(f, 'contrast', 'color.contrast', ratio < 3 ? 'hard' : 'soft', `Text contrast is ${ratio}:1, under ${need}:1 for ${large ? 'large' : 'normal'} text.`, {
            description: better ? `Use ${better.item.name}, which reaches ${contrastRatio(better.item.value, f.backdrop)}:1 here.` : 'No colour of the palette reaches that here, so change the background.',
            safe: false, ...(better ? { style: colorRef(better.item.value, 'color') } : {}),
          }, undefined, { issue: `${fgHex} on ${f.backdrop}` });
        }
      } else if (f.backdrop === null) notChecked.push(`contrast of "${node.name.slice(0, 40)}": the text sits on an image or gradient. Look at it in a screenshot.`);

      // Typography
      if (f.family !== undefined) {
        distinctFamilies.add(f.family.toLowerCase());
        if (families.length) {
          count('type');
          const known = allFamilies.some((b) => b.family.toLowerCase() === f.family!.toLowerCase());
          if (!known) {
            const target = roleFamily(data, f);
            add(f, 'type', 'type.off-brand-font', 'hard', `The font is ${f.family}, which is not a brand font.`, {
              description: target ? `Use ${target.family}.` : 'Use a brand font.', safe: Boolean(target),
              ...(target ? { style: { fontFamily: tokens.has(target.token) ? `var(--${target.token})` : familyStack(target) } } : {}),
            }, undefined, { issue: f.family.toLowerCase() });
          }
        }
      }
      const sizes = stepsFor(f).sizes;
      if (f.size !== undefined && sizes.length) {
        count('type');
        const fit = nearest(sizes, (s) => Math.abs(s - f.size!))!;
        if (fit.distance > Math.max(SIZE_TOLERANCE, fit.item * 0.02) && scale.length) {
          const step = scale.find((t) => t.size === fit.item);
          const near = fit.distance <= fit.item * NEAR_SIZE;
          const where = f.fluid.size ? ` at ${Math.round(f.viewport.vw)}px wide` : '';
          add(f, 'type', 'type.size-off-scale', 'soft', `The size is ${round2(f.size)}px${where}, which is not on the type scale. The closest step is ${round2(fit.item)}px${near ? ', and it is near' : ''}.`, {
            description: `Use ${round2(fit.item)}px.`, safe: fit.distance <= SAFE_SNAP_PX && !f.fluid.size,
            style: { fontSize: step && tokens.has(step.token) ? `var(--${step.token})` : `${round2(fit.item)}px` },
          }, undefined, { credit: near ? 0.5 : 0 });
        }
      }
      if (f.weight !== undefined && weights.size) {
        count('type');
        // One family may be listed once per role, such as display and body, each with its own weights.
        const own = allFamilies.filter((b) => b.family.toLowerCase() === f.family?.toLowerCase()).flatMap((b) => b.weights);
        const allowed = own.length ? [...new Set(own)] : [...weights];
        if (!allowed.includes(f.weight)) {
          const fit = nearest(allowed, (w) => Math.abs(w - f.weight!))!;
          add(f, 'type', 'type.weight-off-scale', 'soft', `The weight is ${f.weight}, and the brand uses ${[...allowed].sort((a, b) => a - b).join(', ')}.`, { description: `Use ${fit.item}.`, safe: fit.distance <= 100, style: { fontWeight: String(fit.item) } });
        }
      }

      // Voice
      if (f.text) {
        for (const word of avoidFor(spokenIn(f))) {
          count('voice');
          if (wordRegex(word.word).test(f.text)) {
            add(f, 'voice', 'voice.avoid-word', word.severity, `The text says "${word.word}", which the brand avoids.`, {
              description: word.instead ? `Say "${word.instead}".` : 'Rewrite the sentence without it.', safe: false,
              ...(word.instead ? { text: f.text.replace(new RegExp(word.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), word.instead) } : {}),
            });
          }
        }
      }
    }

    // Contrast inside pseudo-elements and conditions, which no render at one width, scheme and state shows.
    if (!placeholder && !logo) {
      for (const p of f.rulePairs) {
        if (!p.color || p.backdrop === undefined) continue;
        const what = p.content ? `The words "${p.content.slice(0, 30)}" in ${p.block}` : `In ${p.block}, the text`;
        if (p.backdrop === null) {
          notChecked.push(`contrast of "${node.name.slice(0, 40)}" in ${p.block}: it sits on an image or gradient there. Look at it in a screenshot.`);
          continue;
        }
        count('contrast');
        const fg = colorAlpha(p.color) < 1 ? flattenColor(p.color, p.backdrop) : p.color;
        const ratio = contrastRatio(fg, p.backdrop);
        const size = p.size ?? f.size ?? 0;
        const large = size >= 24 || (size >= 18.66 && (p.weight ?? f.weight ?? 400) >= 700);
        const need = large ? Math.min(3, data.fields.minContrast) : data.fields.minContrast;
        if (ratio >= need) continue;
        const better = nearest(palette.filter((c) => contrastRatio(c.value, p.backdrop!) >= need), (c) => colorDistance(c.value, fg));
        add(f, 'contrast', 'color.contrast', ratio < 3 ? 'hard' : 'soft', `${what} has a contrast of ${ratio}:1, under ${need}:1 for ${large ? 'large' : 'normal'} text.`, {
          description: better ? `Use ${better.item.name} in ${p.block}, which reaches ${contrastRatio(better.item.value, p.backdrop)}:1 there.` : `No colour of the palette reaches that there, so change the background in ${p.block}.`,
          safe: false, ...(better ? { style: colorRef(better.item.value, 'color'), block: p.block } : {}),
        }, undefined, { issue: `${fg} on ${p.backdrop} in ${p.block}` });
      }
    }

    // Spacing and shape. A logo's margin is its clear space, not spacing.
    if (!logo && spacingScale.length) {
      const seen = new Set<string>();
      const allowedSpacing = stepsFor(f).spacing;
      for (const s of f.spacing) {
        if (s.value === 0) continue;
        const key = `${s.prop}:${s.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        count('spacing');
        const fit = nearest(allowedSpacing, (v) => Math.abs(v - Math.abs(s.value)))!;
        if (fit.distance > Math.max(SPACING_TOLERANCE, fit.item * 0.02)) {
          const near = fit.distance <= Math.max(NEAR_SPACING_PX, fit.item * NEAR_SPACING);
          const single = Boolean(node.style[s.prop]) && pxList(node.style[s.prop]!).length === 1 && !f.fluid.spacing;
          add(f, 'spacing', 'layout.spacing-off-scale', 'soft', `${s.prop} is ${round2(s.value)}px${f.fluid.spacing ? ` at ${Math.round(f.viewport.vw)}px wide` : ''}, which is not on the spacing scale. The closest step is ${round2(fit.item)}px${near ? ', and it is near' : ''}.`, {
            description: `Use ${round2(fit.item)}px.`, safe: fit.distance <= SAFE_SNAP_PX && single,
            ...(single ? { style: { [s.prop]: `${round2(fit.item)}px` } } : {}),
          }, undefined, { credit: near ? 0.5 : 0 });
        }
      }
    }
    if (radiusScale.length) {
      const seen = new Set<number>();
      for (const r of f.radius) {
        if (r === 0 || seen.has(r)) continue;
        seen.add(r);
        count('shape');
        const fit = nearest([...allowedRadius, 0], (v) => Math.abs(v - r))!;
        if (fit.distance > SPACING_TOLERANCE) add(f, 'shape', 'layout.radius-off-scale', 'soft', `The radius is ${r}px, and the brand uses ${[...new Set(allowedRadius)].join(', ')}px.`, { description: `Use ${fit.item}px.`, safe: fit.distance <= SAFE_SNAP_PX, style: { borderRadius: `${fit.item}px` } });
      }
    } else if (data.fields.gradients === 'none' || data.fields.shadows === 'none') count('shape');
    if (data.fields.shadows === 'none') {
      count('shape');
      if (f.shadow) add(f, 'shape', 'layout.shadow', 'hard', 'This layer has a shadow, and the brand has none.', { description: 'Remove the shadow.', safe: true, style: { boxShadow: null, textShadow: null, ...(node.style.filter?.includes('drop-shadow') ? { filter: null } : {}) } });
    }
    if (data.fields.gradients === 'none') {
      count('shape');
      if (f.gradient) add(f, 'shape', 'layout.gradient', 'hard', 'This layer has a gradient, and the brand uses flat colour only.', { description: 'Fill it with a flat colour of the palette.', safe: false });
    }

    // Logos
    if (logo) {
      count('logo');
      if (f.backdrop && !logoFitsBackground(data, logo.background, f.backdrop)) {
        const right = pickLogo(data, f.backdrop);
        add(f, 'logo', 'logo.wrong-background', 'hard', `The logo "${logo.name}" is meant for a ${resolveBrandColor(data, logo.background)?.name ?? logo.background} background, and this one is ${f.backdrop}.`, {
          description: right ? `Use the variant "${right.name}".` : 'No variant of the logo fits this background, so change the background.',
          safe: Boolean(right?.asset && node.type === 'image'), ...(right?.asset && node.type === 'image' ? { src: right.asset } : {}),
        });
      }
      if (f.backdrop === null) notChecked.push(`background of the logo "${node.name.slice(0, 40)}": it sits on an image or gradient. Look at it in a screenshot.`);
      if (f.box && logo.minWidth && f.box.w && f.box.w < logo.minWidth - SIZE_TOLERANCE) {
        add(f, 'logo', 'logo.too-small', 'hard', `The logo is ${Math.round(f.box.w)}px wide, under its minimum of ${logo.minWidth}px.`, { description: `Make it ${logo.minWidth}px wide.`, safe: true, style: { width: `${logo.minWidth}px`, height: 'auto' } });
      }
      const aspect = logo.aspect ?? (logo.svg ? svgAspect(logo.svg) : undefined);
      // A drawing with a viewBox keeps its ratio inside any box, unless it says preserveAspectRatio="none".
      const keepsRatio = node.type === 'svg' ? !/preserveAspectRatio\s*=\s*["']\s*none/i.test(node.svg ?? '') : /contain|scale-down/.test(f.objectFit ?? '');
      if (aspect && f.box?.h && f.box.w && !keepsRatio) {
        const actual = f.box.w / f.box.h;
        if (Math.abs(actual - aspect) / aspect > ASPECT_TOLERANCE) add(f, 'logo', 'logo.distorted', 'hard', `The logo is stretched: ${actual.toFixed(2)}:1, and it should be ${aspect.toFixed(2)}:1.`, { description: 'Keep its ratio.', safe: true, style: { height: 'auto' } });
      }
      if (logo.clearSpace && f.box && options.mode === 'rendered') {
        const crowded = facts.find((o) => o !== f && o.node.parent === node.parent && o.box && o.box.w && o.box.h && Math.max(o.box.x - (f.box!.x + f.box!.w), f.box!.x - (o.box.x + o.box.w), o.box.y - (f.box!.y + f.box!.h), f.box!.y - (o.box.y + o.box.h)) < logo.clearSpace);
        if (crowded) add(f, 'logo', 'logo.clear-space', 'soft', `"${crowded.node.name.slice(0, 40)}" is inside the logo's clear space of ${logo.clearSpace}px.`, { description: `Keep ${logo.clearSpace}px around the logo.`, safe: false });
      }
    } else if (logos.length && looksLikeLogo(node)) {
      count('logo');
      add(f, 'logo', 'logo.unofficial', 'hard', `"${node.name.slice(0, 40)}" looks like a logo, but it is not one of the brand's.`, { description: 'Replace it with brand_asset_use, which picks the variant for the background.', safe: false });
    }

    // Written rules that a machine can check
    for (const rule of rules) {
      if (!rule.check) continue;
      const broke = (message: string, fix: BrandFix) => add(f, 'rules', `rule:${rule.id}`, rule.severity, message, fix, rule.text);
      switch (rule.check.type) {
        case 'no-gradient':
          count('rules');
          if (f.gradient) broke('This layer has a gradient.', { description: 'Fill it with a flat colour of the palette.', safe: false });
          break;
        case 'no-shadow':
          count('rules');
          if (f.shadow) broke('This layer has a shadow.', { description: 'Remove the shadow.', safe: true, style: { boxShadow: null, textShadow: null } });
          break;
        case 'no-glow':
          count('rules');
          if (f.glow) broke('This layer has a glow or blur.', { description: 'Remove the blur.', safe: false });
          break;
        case 'no-uppercase':
          if (f.hasText) {
            count('rules');
            if (f.uppercase || (f.text && isAllCaps(f.text))) broke('This text is set in all caps.', { description: 'Set it in normal case.', safe: f.uppercase, ...(f.uppercase ? { style: { textTransform: null } } : {}) });
          }
          break;
        case 'require-text':
          break;
        case 'forbid-text':
          // Text a rule forbids is forbidden in the rule's language: a German word may be fine in an English sentence.
          if (f.text && textRulesFor(spokenIn(f)).includes(rule)) {
            count('rules');
            if (f.text.toLowerCase().includes(rule.check.value.toLowerCase())) broke(`The text contains "${rule.check.value}".`, { description: 'Rewrite it.', safe: false });
          }
          break;
        case 'forbid-style': {
          count('rules');
          const prop = rule.check.prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
          const value = node.style[prop];
          if (value && resolveVars(value, tokens).toLowerCase().includes(rule.check.value.toLowerCase())) broke(`${rule.check.prop} contains "${rule.check.value}".`, { description: `Remove ${rule.check.prop}.`, safe: false });
          break;
        }
        case 'max-families':
          break;
      }
    }
  }

  // The measurable voice: address, lengths, numbers, the brand's spelling of its terms, and text it requires.
  const texts = facts.filter((f) => f.hasText && f.text && !(f.node.type === 'image' && !f.node.src) && !logoOf(data, f.node, f.backdrop)).map((f) => ({ id: f.node.id, name: f.node.name, tag: f.node.tag, text: f.text!, lang: declaredOf(f.node.id) }));
  const measures = [profile.address, profile.sentenceWords, profile.paragraphSentences, profile.headingWords, profile.numberFormat].filter(Boolean).length + (profile.terms.length ? 1 : 0);
  for (let i = 0; i < texts.length * measures; i++) count('voice');
  for (let i = 0; i < profile.required.length && texts.length; i++) count('voice');
  const byId = new Map(facts.map((f) => [f.node.id, f]));
  for (const v of voiceFindings(data, texts, { profile, scopeName: options.fileLevel ? 'file' : 'part' })) {
    add(v.node_id ? byId.get(v.node_id) ?? null : null, 'voice', v.rule, v.severity, `${v.message}${exampleLine(v.example)}`, { description: v.how, safe: false, ...(v.text ? { text: v.text } : {}) }, undefined, { issue: `${v.rule}|${v.quote}` });
  }

  // Rules about the file as a whole
  for (const rule of rules) {
    if (rule.check?.type !== 'max-families') continue;
    count('rules');
    if (distinctFamilies.size > rule.check.value) add(null, 'rules', `rule:${rule.id}`, rule.severity, `This uses ${distinctFamilies.size} font families: ${[...distinctFamilies].join(', ')}.`, { description: `Keep it to ${rule.check.value}.`, safe: false }, rule.text);
  }
  if (options.fileLevel) {
    for (const t of brandTokens(data)) {
      count('tokens');
      const have = tokens.get(t.name);
      if (have === undefined) add(null, 'tokens', 'tokens.missing', 'soft', `The brand token --${t.name} is missing from this file.`, { description: 'Bring the brand tokens into the file.', safe: true, tokens: true });
      else if (have !== t.value) add(null, 'tokens', 'tokens.drift', 'hard', `--${t.name} is ${have} here, and the brand says ${t.value}. The brand is the source of tokens.`, { description: `Set it back to ${t.value}.`, safe: true, tokens: true });
    }
  }

  const checklist: BrandChecklistItem[] = rules.filter((r) => !r.check).map((r: BrandRule) => ({ rule_id: r.id, text: r.text, severity: r.severity, topic: r.topic, how: 'No machine can check this. Look at a canvas_screenshot and judge it yourself.' }));
  const unconfirmed = [
    !palette.length && allColors.length ? 'colours: only suggestions so far' : '',
    !families.length && allFamilies.length ? 'fonts: only suggestions so far' : '',
    !palette.length && !allColors.length ? 'colours: the brand has none' : '',
    !families.length && !allFamilies.length ? 'fonts: the brand has none' : '',
    options.mode === 'static' ? 'This looked only at what the document declares, without rendering: inherited values and real sizes were not seen.' : '',
  ].filter(Boolean);
  const quality = qualityOf(doc, data, facts, { onPalette, palette, logos: (f) => logoOf(data, f.node, f.backdrop) });
  const score = scoreOf(tally, violations, quality, { issues: [...hardIssues.values()].reduce((a, b) => a + b, 0), count: hardIssues.size, layers: hardLayers.size, of: facts.length });
  explainScore(score, tally, violations, costs, quality, facts.length, (id) => data.rules.find((r) => `rule:${r.id}` === id)?.text);
  if (!facts.length && !violations.length) {
    // Nothing drawn is not a perfect score.
    score.value = 0;
    score.nothing_checked = true;
    score.formula = 'Nothing was checked: there are no visible layers here.';
    return { mode: options.mode, score, counts: { hard: 0, soft: 0, waived: 0, layers: 0 }, violations, waived, checklist, not_checked: ['There are no visible layers here, so nothing was checked.'] };
  }
  return {
    mode: options.mode, score,
    counts: { hard: violations.filter((v) => v.severity === 'hard').length, soft: violations.filter((v) => v.severity === 'soft').length, waived: waived.length, layers: facts.length },
    violations, waived, checklist, not_checked: [...new Set(notChecked)].slice(0, 20).concat(unconfirmed, skipped ? [`${skipped} layer${skipped === 1 ? '' : 's'} inside counter-examples (${COUNTER_EXAMPLE.attr}="${COUNTER_EXAMPLE.value}"), shown on purpose as what not to do.`] : []),
  };
}

const QUALITY_WEIGHTS: Record<QualityDimension, number> = { hierarchy: 30, rhythm: 25, roles: 25, system: 20 };
/** How much of the score is quality. The rest is conformance, so that keeping to the brand still matters most. */
const QUALITY_SHARE = 0.4;
const PENALTY_PER_ISSUE = 2;
const PENALTY_FOR_SHARE = 30;
const MAX_PENALTY = 25;

/** Groups values that read as the same step: each group starts at its smallest value and holds what is within `within` of it. */
function levels(values: { v: number; w: number }[], within: number): { v: number; w: number; uses: number }[] {
  const out: { v: number; w: number; uses: number }[] = [];
  for (const { v, w } of [...values].sort((a, b) => a.v - b.v)) {
    const last = out.at(-1);
    if (last && v <= last.v * (1 + within)) {
      last.w += w;
      last.uses++;
    } else out.push({ v, w, uses: 1 });
  }
  return out;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function chroma(hex: string): number {
  const n = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  return Math.max(...n) - Math.min(...n);
}

/**
 * Whether on-brand work is also well made, as far as a machine can tell from the layers: a type hierarchy, a spacing
 * rhythm, the palette's roles in use, and the brand's own tokens, logo and components. Each part only counts when
 * there is enough to judge it.
 */
function qualityOf(doc: BogenDoc, data: BrandData, facts: LayerFacts[], brand: { onPalette: (hex: string) => BrandColor | undefined; palette: BrandColor[]; logos: (f: LayerFacts) => BrandLogo | undefined }): BrandScore['quality_parts'] {
  const out: BrandScore['quality_parts'] = [];
  const pct = (n: number) => Math.round(clamp01(n) * 100);

  // Hierarchy: several sizes, and the largest clearly above the size most of the words are in.
  const text = facts.filter((f) => f.hasText && f.text && f.size);
  if (text.length >= 4) {
    const steps = levels(text.map((f) => ({ v: f.size!, w: Math.min(400, f.text!.trim().length) })), 0.06);
    const body = steps.reduce((a, b) => (b.w > a.w ? b : a));
    const ratio = steps.at(-1)!.v / body.v;
    const score = pct(0.5 * clamp01((steps.length - 1) / 3) + 0.5 * clamp01((ratio - 1) / 1.5));
    const top = steps.at(-1)!.v;
    const how = [steps.length < 4 ? `use at least four sizes of the type scale (${steps.length} now)` : '', ratio < 2.5 ? `make the largest text at least 2.5x the body size of ${round2(body.v)}px (${round2(ratio)}x now)` : ''].filter(Boolean).join(', and ');
    out.push({ dimension: 'hierarchy', weight: QUALITY_WEIGHTS.hierarchy, score, basis: `${steps.length} sizes; the largest is ${round2(ratio)}x the body size of ${round2(body.v)}px.`, ...(how ? { how: `${how[0]!.toUpperCase()}${how.slice(1)}.` } : {}), node_ids: text.filter((f) => /^h[1-3]$/.test(f.node.tag) || f.size! >= top).map((f) => f.node.id).slice(0, MAX_NODE_IDS) });
  }

  // Rhythm: a few spacing steps used again and again, from tight to loose.
  const gaps = facts.flatMap((f) => [...new Set(f.spacing.filter((s) => s.value > 0 && !s.prop.startsWith('margin')).map((s) => s.value))].map((v) => ({ v, w: 1 })));
  if (gaps.length >= 4) {
    const steps = levels(gaps, 0.1);
    const repeated = steps.filter((l) => l.uses >= 2);
    const used = repeated.length ? repeated : steps.slice(0, 1);
    const range = used.at(-1)!.v / used[0]!.v;
    const stray = steps.length ? (steps.length - repeated.length) / steps.length : 0;
    const score = pct((0.5 * clamp01((used.length - 1) / 3) + 0.5 * clamp01(Math.log(range) / Math.log(6))) * (1 - 0.5 * stray));
    const once = steps.filter((l) => l.uses < 2);
    const odd = (v: number) => once.some((l) => v >= l.v && v <= l.v * 1.1);
    const how = [once.length ? `space with steps used again and again: ${once.length} ${once.length === 1 ? 'value is' : 'values are'} used only once (${once.slice(0, 4).map((l) => `${round2(l.v)}px`).join(', ')})` : '', used.length < 4 ? `use at least four steps, from tight to loose (${used.length} now)` : '', range < 6 ? `spread the steps from tight to loose, the largest at least 6x the smallest (${round2(range)}x now)` : ''].filter(Boolean).join('; ');
    out.push({ dimension: 'rhythm', weight: QUALITY_WEIGHTS.rhythm, score, basis: `${used.length} spacing steps used more than once, from ${round2(used[0]!.v)}px to ${round2(used.at(-1)!.v)}px; ${steps.length - repeated.length} used only once.`, ...(how ? { how: `${how[0]!.toUpperCase()}${how.slice(1)}.` } : {}), node_ids: facts.filter((f) => f.spacing.some((s) => s.value > 0 && !s.prop.startsWith('margin') && odd(s.value))).map((f) => f.node.id).slice(0, MAX_NODE_IDS) });
  }

  // Roles: the brand's accent shows, several palette colours carry the design, and the accent does not drown it.
  if (brand.palette.length >= 2) {
    const used = new Map<string, number>();
    let coloured = 0;
    let backgrounds = 0;
    let accentBackgrounds = 0;
    const accentFilled: string[] = [];
    const accents = brand.palette.filter((c) => /primary|accent|brand|highlight|signal|action|cta/i.test(c.role));
    const accentIds = new Set((accents.length ? accents : [brand.palette.reduce((a, b) => (chroma(b.value) > chroma(a.value) ? b : a))]).map((c) => c.id));
    for (const f of facts) {
      const colours = [...f.backgrounds, ...f.borders, ...f.drawn.map((d) => d.color), ...(f.hasText && f.color ? [f.color] : [])];
      for (const c of colours) {
        if (colorAlpha(c) <= 0) continue;
        coloured++;
        const hit = brand.onPalette(c.length === 9 ? c.slice(0, 7) : c);
        if (hit) used.set(hit.id, (used.get(hit.id) ?? 0) + 1);
      }
      for (const c of f.backgrounds) {
        backgrounds++;
        const hit = brand.onPalette(c.length === 9 ? c.slice(0, 7) : c);
        if (hit && accentIds.has(hit.id)) {
          accentBackgrounds++;
          accentFilled.push(f.node.id);
        }
      }
    }
    if (coloured >= 3) {
      const accent = [...accentIds].some((id) => used.has(id)) ? 1 : 0;
      const variety = clamp01(used.size / Math.min(4, brand.palette.length));
      const share = backgrounds ? accentBackgrounds / backgrounds : 0;
      const restraint = share <= 0.6 ? 1 : clamp01((1 - share) / 0.4);
      const how = [!accent ? 'let the brand\'s accent show, on the main action or a mark' : '', variety < 1 ? `carry the design with more of the palette (${used.size} of ${Math.min(4, brand.palette.length)} colours)` : '', restraint < 1 ? `keep the accent under 60% of backgrounds (${Math.round(share * 100)}% now)` : ''].filter(Boolean).join('; ');
      out.push({ dimension: 'roles', weight: QUALITY_WEIGHTS.roles, score: pct(0.45 * accent + 0.35 * variety + 0.2 * restraint), basis: `${used.size} palette colours in use; the accent ${accent ? 'shows' : 'does not show'}${backgrounds ? `, and fills ${Math.round(share * 100)}% of backgrounds` : ''}.`, ...(how ? { how: `${how[0]!.toUpperCase()}${how.slice(1)}.` } : {}), node_ids: restraint < 1 ? accentFilled.slice(0, MAX_NODE_IDS) : [] });
    }
  }

  // System: brand tokens rather than literal values, and on something page-sized the logo and the components.
  const parts: { name: string; value: number }[] = [];
  const declared = facts.reduce((a, f) => a + f.tokenUse.declared, 0);
  if (declared >= 5) parts.push({ name: 'tokens', value: facts.reduce((a, f) => a + f.tokenUse.branded, 0) / declared });
  const pageSized = facts.length >= 20;
  if (pageSized && confirmed(data.logos).length) parts.push({ name: 'logo', value: facts.some((f) => brand.logos(f)) ? 1 : 0 });
  if (pageSized && (doc.source.mainIds().length || facts.some((f) => f.node.instanceOf !== undefined))) parts.push({ name: 'components', value: facts.some((f) => f.node.instanceOf !== undefined) ? 1 : 0 });
  if (parts.length) {
    const score = pct(parts.reduce((a, p) => a + p.value, 0) / parts.length);
    const how = parts.filter((p) => p.value < 1).map((p) => (p.name === 'tokens' ? 'write colours, fonts and sizes as the brand\'s tokens, var(--name)' : p.name === 'logo' ? 'place the brand\'s logo with brand_asset_use' : 'make what repeats a component, and place instances')).join('; ');
    const literal = facts.filter((f) => f.tokenUse.declared > f.tokenUse.branded).map((f) => f.node.id);
    out.push({ dimension: 'system', weight: QUALITY_WEIGHTS.system, score, basis: parts.map((p) => (p.name === 'tokens' ? `${Math.round(p.value * 100)}% of colours, fonts and sizes through brand tokens` : `${p.name} ${p.value ? 'used' : 'not used'}`)).join('; ') + '.', ...(how ? { how: `${how[0]!.toUpperCase()}${how.slice(1)}.` } : {}), node_ids: literal.slice(0, MAX_NODE_IDS) });
  }
  return out;
}

function scoreOf(tally: Tally, violations: BrandViolation[], quality: BrandScore['quality_parts'], hard: { issues: number; count: number; layers: number; of: number }): BrandScore {
  const categories: BrandScore['categories'] = [];
  let total = 0;
  let weight = 0;
  for (const category of Object.keys(WEIGHTS) as BrandCategory[]) {
    const checked = tally.checked.get(category) ?? 0;
    if (!checked) continue;
    const failed = Math.min(checked, tally.failed.get(category) ?? 0);
    const lost = Math.min(checked, tally.lost.get(category) ?? 0);
    const value = Math.round(((checked - lost) / checked) * 100);
    categories.push({ category, weight: WEIGHTS[category], checked, failed, score: value, node_ids: [] });
    total += value * WEIGHTS[category];
    weight += WEIGHTS[category];
  }
  const conformance = weight ? total / weight : 100;
  const qualityWeight = quality.reduce((a, q) => a + q.weight, 0);
  const qualityValue = qualityWeight ? quality.reduce((a, q) => a + q.score * q.weight, 0) / qualityWeight : undefined;
  const base = qualityValue === undefined ? conformance : (1 - QUALITY_SHARE) * conformance + QUALITY_SHARE * qualityValue;
  const share = hard.of ? hard.layers / hard.of : 0;
  const penalty = Math.min(MAX_PENALTY, Math.round(hard.issues * PENALTY_PER_ISSUE + share * PENALTY_FOR_SHARE));
  const hardCount = violations.filter((v) => v.severity === 'hard').length;
  const parts = quality.map((q) => `${q.dimension} ${q.score}`).join(', ');
  return {
    value: Math.max(0, Math.round(base - penalty)),
    formula: `Conformance: each category scores the share of its checks that passed, a near miss counting half, and their weighted average is ${weight ? Math.round(conformance) : 'nothing checked, 100'}. `
      + (qualityValue === undefined ? 'Quality: too little here to judge, so the score is conformance alone' : `Quality: ${parts}, weighted average ${Math.round(qualityValue)}. The score is ${Math.round((1 - QUALITY_SHARE) * 100)}% conformance and ${Math.round(QUALITY_SHARE * 100)}% quality (${Math.round(base)})`)
      + `, less ${PENALTY_PER_ISSUE} per distinct open hard problem (half for a near shade) and up to ${PENALTY_FOR_SHARE} for the share of layers with one, at most ${MAX_PENALTY} (${penalty}: ${hard.count} problems on ${hard.layers} of ${hard.of} layers). Waived layers do not count. Checklist items are not in the score, because no machine checked them.`,
    categories, conformance: Math.round(conformance), ...(qualityValue === undefined ? {} : { quality: Math.round(qualityValue) }), quality_parts: quality, raise: [],
    hard_violations: hardCount, hard_issues: hard.count, hard_penalty: penalty,
  };
}

interface ViolationCost { lost: number; issue?: string }

const RULE_LABELS: Record<string, [string, string]> = {
  'color.off-palette': ['Colours off the palette', 'Use the palette\'s colours, through their tokens.'],
  'color.forbidden-pair': ['Pairs the brand forbids', 'Put text on a background the brand allows it on.'],
  'color.contrast': ['Text contrast', 'Use a palette colour that reaches the brand\'s minimum contrast on that background.'],
  'type.off-brand-font': ['Fonts that are not the brand\'s', 'Set the brand\'s families, through their tokens.'],
  'type.size-off-scale': ['Sizes off the type scale', 'Use the steps of the type scale.'],
  'type.weight-off-scale': ['Weights the brand does not use', 'Use the weights the brand lists for the family.'],
  'layout.spacing-off-scale': ['Spacing off the scale', 'Use the steps of the spacing scale.'],
  'layout.radius-off-scale': ['Corners off the radius scale', 'Use the brand\'s radii.'],
  'layout.shadow': ['Shadows', 'Remove them: the brand has none.'],
  'layout.gradient': ['Gradients', 'Fill with a flat colour of the palette.'],
  'logo.wrong-background': ['Logo on the wrong background', 'Use the variant made for that background.'],
  'logo.too-small': ['Logo under its minimum width', 'Make it at least its minimum width.'],
  'logo.distorted': ['Stretched logo', 'Keep its ratio.'],
  'logo.clear-space': ['Crowded logo', 'Keep its clear space free.'],
  'logo.unofficial': ['Logos that are not the brand\'s', 'Replace them with brand_asset_use.'],
  'voice.avoid-word': ['Words the brand avoids', 'Say what the brand says instead.'],
  'tokens.missing': ['Brand tokens missing from the file', 'Bring the brand tokens in: a safe fix.'],
  'tokens.drift': ['Tokens that drifted from the brand', 'Set them back to the brand\'s values: a safe fix.'],
};

const MAX_LEVERS = 8;
const MAX_NODE_IDS = 40;

/**
 * Fills in what the score is made of: the layers behind each category, and what would raise it most. A rule's gain is
 * the score worked out again as if none of its violations were there, with the penalty for hard problems that would go
 * with them; a quality part's gain is the score with that part at full marks.
 */
function explainScore(score: BrandScore, tally: Tally, violations: BrandViolation[], costs: ViolationCost[], quality: BrandScore['quality_parts'], layerCount: number, ruleText: (rule: string) => string | undefined): void {
  const ids = (list: BrandViolation[]) => [...new Set(list.map((v) => v.node_id).filter(Boolean))];
  for (const c of score.categories) c.node_ids = ids(violations.filter((v) => v.category === c.category)).slice(0, MAX_NODE_IDS);
  const hardAt = (skip: Set<number>) => {
    const issues = new Map<string, number>();
    const layers = new Set<string>();
    costs.forEach((cost, i) => {
      if (!cost.issue || skip.has(i)) return;
      issues.set(cost.issue, Math.max(issues.get(cost.issue) ?? 0, cost.lost));
      if (violations[i]!.node_id) layers.add(violations[i]!.node_id);
    });
    return { issues: [...issues.values()].reduce((a, b) => a + b, 0), count: issues.size, layers: layers.size, of: layerCount };
  };
  const levers: BrandLever[] = [];
  const byRule = new Map<string, number[]>();
  violations.forEach((v, i) => byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), i]));
  for (const [rule, list] of byRule) {
    const skip = new Set(list);
    const sim: Tally = { checked: tally.checked, failed: new Map(tally.failed), lost: new Map(tally.lost) };
    for (const i of list) {
      const cat = violations[i]!.category;
      sim.failed.set(cat, (sim.failed.get(cat) ?? 0) - 1);
      sim.lost.set(cat, (sim.lost.get(cat) ?? 0) - costs[i]!.lost);
    }
    const gain = scoreOf(sim, [], quality, hardAt(skip)).value - score.value;
    if (gain <= 0) continue;
    const own = list.map((i) => violations[i]!);
    const label = RULE_LABELS[rule] ?? [rule.startsWith('rule:') ? `Rule: ${(ruleText(rule) ?? rule).slice(0, 80)}` : rule, own[0]!.fix.description];
    const safe = own.filter((v) => v.fix.safe).length;
    levers.push({ kind: 'rule', key: rule, category: own[0]!.category, label: label[0], gain, ...(safe ? { safe } : {}), node_ids: ids(own).slice(0, MAX_NODE_IDS), how: `${own.length} ${own.length === 1 ? 'violation' : 'violations'}. ${label[1]}${safe ? ` ${safe === own.length ? 'All are' : `${safe} are`} safe fixes.` : ''}` });
  }
  const hardNow = hardAt(new Set());
  for (const part of quality) {
    if (part.score >= 100) continue;
    const full = quality.map((q) => (q === part ? { ...q, score: 100 } : q));
    const gain = scoreOf(tally, [], full, hardNow).value - score.value;
    if (gain <= 0) continue;
    levers.push({ kind: 'quality', key: part.dimension, label: QUALITY_LABELS[part.dimension], gain, node_ids: part.node_ids ?? [], how: part.how ?? part.basis });
  }
  score.raise = levers.sort((a, b) => b.gain - a.gain || b.node_ids.length - a.node_ids.length).slice(0, MAX_LEVERS);
}

const QUALITY_LABELS: Record<QualityDimension, string> = { hierarchy: 'Type hierarchy', rhythm: 'Spacing rhythm', roles: 'Palette roles', system: 'Brand tokens, logo and components' };

// ---------------------------------------------------------------- running a check

/** Only what the document declares. For use on every write. */
export function checkStatic(doc: BogenDoc, brand: BrandData, nodes: BogenNode[], fileLevel = false): BrandReport {
  const data = bindingBrand(brand);
  const tokens = tokenMap(doc);
  const names = brandTokenNames(data, tokens);
  const viewportOf = viewports(doc);
  return evaluate(doc, data, nodes.map((n) => staticFacts(doc, n, tokens, viewportOf(n), names)), { fileLevel, mode: 'static' });
}

/** With a real render, page by page. Falls back to what the document declares when no browser can be started. */
export async function checkRendered(doc: BogenDoc, brand: BrandData, renderer: Renderer, scope: Scope, options: { tokens?: boolean; contentLanguage?: string | null } = {}): Promise<BrandReport> {
  // What is still a suggestion binds nobody: fields like items.
  const data = bindingBrand(brand);
  const nodes = layersIn(doc, scope);
  const tokens = tokenMap(doc);
  const fileLevel = 'file' in scope && options.tokens !== false;
  if (!nodes.length) return evaluate(doc, data, [], { fileLevel, mode: 'rendered', contentLanguage: options.contentLanguage ?? null });
  const byPage = new Map<string, BogenNode[]>();
  for (const n of nodes) {
    const page = doc.pageOf(n.id);
    if (!page) continue;
    const list = byPage.get(page);
    if (list) list.push(n);
    else byPage.set(page, [n]);
  }
  const facts: LayerFacts[] = [];
  const names = brandTokenNames(data, tokens);
  try {
    for (const [pageId, list] of byPage) {
      const target: Target = 'nodeId' in scope ? { nodeIds: [scope.nodeId] } : { pageId };
      const tops = topIds(doc, list);
      const rendered = await renderer.probe(doc, target, renderedProbe, { ids: [...new Set([...list.map((n) => n.id), ...tops])] });
      const seen = new Map(rendered.map((r) => [r.id, r]));
      const viewportOf = viewports(doc, new Map(tops.flatMap((id) => (seen.get(id) ? [[id, seen.get(id)!.w] as [string, number]] : []))));
      for (const n of list) {
        const r = seen.get(n.id);
        // Not in the render means no box: nothing of it can be seen, so nothing of it can be off brand.
        if (r) facts.push(mergeRendered(staticFacts(doc, n, tokens, viewportOf(n), names), r));
      }
    }
    return evaluate(doc, data, facts, { fileLevel, mode: 'rendered', contentLanguage: options.contentLanguage ?? null });
  } catch (e) {
    const report = checkStatic(doc, data, nodes, fileLevel);
    report.not_checked.push(`Rendering failed (${(e as Error).message}).`);
    return report;
  }
}

/** Puts the safe fixes into the document, in one transaction. Returns what was done. */
export function applySafeFixes(doc: BogenDoc, data: BrandData, violations: BrandViolation[], origin: unknown): { fixed: { node_id: string; rule: string; what: string }[] } {
  const fixed: { node_id: string; rule: string; what: string }[] = [];
  doc.transact(() => {
    let tokensDone = false;
    for (const v of violations) {
      if (!v.fix.safe) continue;
      if (v.fix.tokens) {
        if (tokensDone) continue;
        tokensDone = true;
        for (const t of brandTokens(data)) doc.setToken(t.name, t.kind, t.value);
        fixed.push({ node_id: '', rule: v.rule, what: 'Brought the brand tokens into the file.' });
        continue;
      }
      if (!v.node_id || !doc.getNode(v.node_id)) continue;
      const lockedBy = [v.node_id, ...doc.ancestors(v.node_id)].find((a) => doc.getNode(a)?.locked);
      if (lockedBy) continue;
      if (v.fix.style && v.fix.block) doc.updateRules(v.node_id, v.fix.block, v.fix.style);
      else if (v.fix.style) doc.updateStyle(v.node_id, v.fix.style);
      if (v.fix.src) doc.updateFields(v.node_id, { src: v.fix.src });
      fixed.push({ node_id: v.node_id, rule: v.rule, what: v.fix.description });
    }
  }, origin);
  return { fixed };
}

export function reportLine(report: BrandReport): string {
  if (report.score.nothing_checked) return 'Brand check: nothing is drawn in this file, so there is nothing to score.';
  return `Brand check: ${report.score.value}/100, ${report.counts.hard} hard and ${report.counts.soft} soft violations open${report.counts.waived ? `, ${report.counts.waived} waived` : ''}${report.checklist.length ? `, ${report.checklist.length} rules to judge by eye` : ''}.`;
}
