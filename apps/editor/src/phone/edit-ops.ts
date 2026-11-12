import { applyTextStyle, confirmed, familyStack, type BrandData, type NodeType, type TextStyle, type Token } from '@bogen/core';
import { session } from '../doc/session.ts';
import { printFills } from '../lib/fills.ts';

/**
 * What the Edit sheet on the phone can change, and how that becomes a style patch. The values come only
 * from the file's design system: colour tokens and the brand's palette, its text styles and type scale, and
 * its spacing tokens. The writing goes the way the inspector's does, through `session().tx`, so that every
 * change is one step of this person's undo and syncs like any other edit, offline included.
 */

const VAR = /^var\(\s*--([\w-]+)\s*(?:,\s*(.+))?\)$/;

/** A value with its `var(--token)` worked out, through tokens that refer to other tokens. */
export function resolveValue(value: string, tokens: readonly Token[], depth = 0): string {
  const m = VAR.exec(value.trim());
  if (!m || depth > 8) return value;
  const t = tokens.find((x) => x.name === m[1]);
  if (t) return resolveValue(t.value, tokens, depth + 1);
  return m[2] ? resolveValue(m[2], tokens, depth + 1) : value;
}

function pxOf(value: string | undefined, tokens: readonly Token[]): number | undefined {
  if (!value) return undefined;
  const n = parseFloat(resolveValue(value, tokens));
  return Number.isFinite(n) ? n : undefined;
}

// Colour

export interface Swatch { key: string; label: string; css: string; color: string }

/** The brand's palette in its order, then the other colour tokens of the file. As tokens where there is one. */
export function colorSwatches(tokens: readonly Token[], brand: BrandData | null): Swatch[] {
  const names = new Set(tokens.map((t) => t.name));
  const seen = new Set<string>();
  const out: Swatch[] = [];
  for (const c of confirmed(brand?.colors ?? [])) {
    const key = c.token && names.has(c.token) ? c.token : c.value;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const css = names.has(key) ? `var(--${key})` : c.value;
    out.push({ key, label: c.name || key, css, color: resolveValue(css, tokens) });
  }
  for (const t of tokens) {
    if (t.kind !== 'color' || seen.has(t.name)) continue;
    seen.add(t.name);
    out.push({ key: t.name, label: t.name, css: `var(--${t.name})`, color: resolveValue(t.value, tokens) });
  }
  return out;
}

/** The colour a fill change writes: the text colour of a text layer, the background of anything else. */
export function fillTarget(type: NodeType): 'color' | 'background' {
  return type === 'text' ? 'color' : 'background';
}

/** The fill a layer has now, as written. */
export function currentFill(node: { type: NodeType; style: Record<string, string> }): string | undefined {
  if (node.type === 'text') return node.style.color;
  return node.style.backgroundColor ?? (node.style.background && !/gradient|url\(/.test(node.style.background) ? node.style.background : undefined);
}

/** Whether a swatch is the fill a layer has, by token or by the colour it comes to. */
export function isCurrentSwatch(swatch: Swatch, current: string | undefined, tokens: readonly Token[]): boolean {
  if (!current) return false;
  if (current.replace(/\s/g, '') === swatch.css.replace(/\s/g, '')) return true;
  return !VAR.test(current) && resolveValue(current, tokens).toLowerCase() === swatch.color.toLowerCase();
}

// Spacing and size

export interface SpaceStep { css: string; px: number; label: string }

const FALLBACK_SPACING = [4, 8, 12, 16, 24, 32, 48, 64];

/** Zero, then the spacing tokens from small to large. A file without any gets a plain 4 and 8 px scale. */
export function spacingScale(tokens: readonly Token[]): SpaceStep[] {
  const steps = tokens.filter((t) => t.kind === 'spacing').flatMap((t) => {
    const px = pxOf(t.value, tokens);
    return px === undefined ? [] : [{ css: `var(--${t.name})`, px, label: t.name }];
  });
  const list = steps.length ? steps : FALLBACK_SPACING.map((px) => ({ css: `${px}px`, px, label: `${px}` }));
  const sorted = [...list].sort((a, b) => a.px - b.px).filter((s, i, all) => s.px > 0 && (i === 0 || all[i - 1]!.px !== s.px));
  return [{ css: '0px', px: 0, label: '0' }, ...sorted];
}

/** One step up or down the scale from what a layer has now. Null at either end. */
export function stepSpacing(scale: readonly SpaceStep[], current: { css?: string | undefined; px: number }, dir: 1 | -1): SpaceStep | null {
  const exact = current.css ? scale.findIndex((s) => s.css.replace(/\s/g, '') === current.css!.replace(/\s/g, '')) : -1;
  if (exact >= 0) return scale[exact + dir] ?? null;
  if (dir > 0) return scale.find((s) => s.px > current.px + 0.5) ?? null;
  return [...scale].reverse().find((s) => s.px < current.px - 0.5) ?? null;
}

/** The label of a spacing value: its token, or its size. */
export function spacingLabel(scale: readonly SpaceStep[], current: { css?: string | undefined; px: number }): string {
  const hit = current.css ? scale.find((s) => s.css.replace(/\s/g, '') === current.css!.replace(/\s/g, '')) : undefined;
  return hit ? (hit.px ? `${hit.label} · ${hit.px}` : '0') : `${Math.round(current.px)}`;
}

/** The grid width and height step on: the smallest spacing token from 4 px, or 8. */
export function sizeUnit(tokens: readonly Token[]): number {
  const sizes = spacingScale(tokens).map((s) => s.px).filter((px) => px >= 4);
  return sizes.length && tokens.some((t) => t.kind === 'spacing') ? sizes[0]! : 8;
}

/** The next width or height on that grid, up or down. Never below one unit. */
export function stepSize(px: number, dir: 1 | -1, unit: number): number {
  const next = dir > 0 ? (Math.floor(px / unit + 1e-6) + 1) * unit : (Math.ceil(px / unit - 1e-6) - 1) * unit;
  return Math.max(unit, next);
}

// Type

export interface TypeOption {
  key: string;
  label: string;
  /** Size in px and weight, for the row. */
  size?: number;
  weight?: string;
  /** A text style of the file. */
  textStyle?: string;
  /** Or a step of the brand's type scale that has no text style here. */
  patch?: Record<string, string>;
}

/** The file's text styles, then the steps of the brand's type scale that the file has no text style for. */
export function typeOptions(textStyles: readonly TextStyle[], brand: BrandData | null, tokens: readonly Token[]): TypeOption[] {
  const out: TypeOption[] = textStyles.map((t) => ({
    key: `style:${t.key}`, label: t.name, textStyle: t.key,
    ...(pxOf(t.style.fontSize, tokens) !== undefined ? { size: Math.round(pxOf(t.style.fontSize, tokens)!) } : {}),
    ...(t.style.fontWeight ? { weight: resolveValue(t.style.fontWeight, tokens) } : {}),
  }));
  const names = new Set(textStyles.map((t) => t.name.trim().toLowerCase()));
  const tokenNames = new Set(tokens.map((t) => t.name));
  for (const step of confirmed(brand?.typeScale ?? [])) {
    if (names.has(step.name.trim().toLowerCase())) continue;
    const family = brand!.families.find((f) => f.id === step.family || f.family === step.family);
    const patch: Record<string, string> = { fontSize: step.token && tokenNames.has(step.token) ? `var(--${step.token})` : `${step.size}px` };
    if (family) patch.fontFamily = family.token && tokenNames.has(family.token) ? `var(--${family.token})` : familyStack(family);
    if (step.weight) patch.fontWeight = String(step.weight);
    if (step.lineHeight) patch.lineHeight = step.lineHeight;
    if (step.tracking) patch.letterSpacing = step.tracking;
    out.push({ key: `step:${step.id}`, label: step.name, size: step.size, ...(step.weight ? { weight: String(step.weight) } : {}), patch });
  }
  return out;
}

/** "112 · 900" */
export function typeDetail(o: Pick<TypeOption, 'size' | 'weight'>): string {
  return [o.size !== undefined ? String(o.size) : '', o.weight ?? ''].filter(Boolean).join(' · ');
}

// The mapping

export type PhoneEdit =
  /** A fill from the palette, or none. */
  | { kind: 'fill'; css: string | null }
  /** The text colour, of a text layer or of what is inside a frame. */
  | { kind: 'color'; css: string }
  | { kind: 'size'; axis: 'width' | 'height'; px: number }
  | { kind: 'padding'; css: string }
  | { kind: 'gap'; css: string }
  | { kind: 'type'; option: TypeOption };

/**
 * The style patch of one change to one layer, the same keys the inspector writes: a solid fill through
 * `printFills`, so that gradients and images it replaces are cleared; padding and gap as one value, with
 * the per-side ones cleared. Null when the change is not a style patch (a text style is applied as such).
 */
export function editPatch(node: { type: NodeType }, edit: PhoneEdit): Record<string, string | null> | null {
  switch (edit.kind) {
    case 'fill':
      if (node.type === 'text') return { color: edit.css };
      return printFills(edit.css ? [{ kind: 'solid', color: edit.css }] : []);
    case 'color': return { color: edit.css };
    case 'size': return { [edit.axis]: `${Math.max(1, Math.round(edit.px))}px` };
    case 'padding': return { padding: edit.css, paddingTop: null, paddingRight: null, paddingBottom: null, paddingLeft: null };
    case 'gap': return { gap: edit.css, rowGap: null, columnGap: null };
    case 'type': return edit.option.patch ? { ...edit.option.patch } : null;
  }
}

/** Applies a change to layers: one transaction, so one undo step. */
export function applyPhoneEdit(ids: readonly string[], edit: PhoneEdit): void {
  const s = session();
  s.tx(() => {
    for (const id of ids) {
      const n = s.snap.nodes.get(id);
      if (!n) continue;
      if (edit.kind === 'type') {
        if (edit.option.textStyle) {
          applyTextStyle(s.doc, id, edit.option.textStyle);
          continue;
        }
        if (n.textStyle) applyTextStyle(s.doc, id, null);
      }
      const patch = editPatch(n, edit);
      if (patch) s.doc.updateStyle(id, patch);
    }
  });
}
