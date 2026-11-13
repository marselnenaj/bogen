import type { BogenDoc, BogenNode } from './doc.ts';

/**
 * Variations of a design: how far a set of proposals or the lanes of a race may go (the range), and which aspects
 * they change while the rest stays as it is (vary). These are Bogen's own words for it. The range and the aspects
 * go to the agent as a brief, are kept on each copy, and what a copy changed outside its aspects is measured, so an
 * agent can see that it kept the rest fixed, and fix it when it did not.
 */

export const VARIATION_RANGES = ['refine', 'explore', 'reimagine'] as const;
export type VariationRange = (typeof VARIATION_RANGES)[number];
export const VARIATION_ASPECTS = ['layout', 'colour', 'type', 'copy'] as const;
export type VariationAspect = (typeof VARIATION_ASPECTS)[number];

export interface Variation {
  range: VariationRange;
  /** What may change. Empty or left out: everything may. */
  vary: VariationAspect[];
}

const RANGE_WORDS: Record<VariationRange, string> = {
  refine: 'Refine: small, careful changes. Keep the structure and the idea; make it tighter, clearer and better crafted. A person should recognise the same design, improved.',
  explore: 'Explore: clearly different takes, each a credible direction a designer would show, within the brand and the content.',
  reimagine: 'Reimagine: start the varied aspects over. A new composition or treatment, keeping only what the content means and the brand.',
};

const ASPECT_WORDS: Record<VariationAspect, string> = {
  layout: 'layout (structure, order, sizes, spacing, alignment, grid and flex)',
  colour: 'colour (fills, text colours, borders, shadows, gradients)',
  type: 'type (font families, sizes, weights, line height, letter spacing, case)',
  copy: 'copy (the words in text layers, image alt text)',
};

/** Every aspect the variation keeps as it is. */
export function heldAspects(variation: Pick<Variation, 'vary'>): VariationAspect[] {
  if (!variation.vary.length) return [];
  return VARIATION_ASPECTS.filter((a) => !variation.vary.includes(a));
}

/** A variation from loose input: an unknown range is explore, unknown aspects are dropped, the order is fixed. */
export function cleanVariation(input: { range?: unknown; vary?: unknown } | undefined): Variation | undefined {
  if (!input) return undefined;
  const range = VARIATION_RANGES.includes(input.range as VariationRange) ? input.range as VariationRange : 'explore';
  const asked = Array.isArray(input.vary) ? input.vary : [];
  const vary = VARIATION_ASPECTS.filter((a) => asked.includes(a));
  return { range, vary: vary.length === VARIATION_ASPECTS.length ? [] : vary };
}

/** The brief for a run or a tool result, in a few plain lines. */
export function variationBrief(variation: Variation, count = 1): string[] {
  const held = heldAspects(variation);
  const lines = [RANGE_WORDS[variation.range]];
  if (variation.vary.length) {
    lines.push(`Vary only ${variation.vary.map((a) => ASPECT_WORDS[a]).join('; ')}.`);
    lines.push(`Hold fixed ${held.map((a) => ASPECT_WORDS[a]).join('; ')}: keep those values exactly as the original has them, also where you would change them otherwise.`);
  } else {
    lines.push('Any aspect may change: layout, colour, type and copy.');
  }
  if (count > 1) lines.push(`Make the ${count} copies differ from each other in what they vary, not only from the original.`);
  return lines;
}

/** A label for a copy, as the canvas shows it: "Explore: layout". */
export function variationNote(variation: Variation): string {
  const range = variation.range[0]!.toUpperCase() + variation.range.slice(1);
  return variation.vary.length ? `${range}: ${variation.vary.join(', ')}` : range;
}

const COLOUR = /^(color|background(Color|Image)?|border(Top|Right|Bottom|Left)?Color|border(Top|Right|Bottom|Left)?$|outline(Color)?|boxShadow|textShadow|textDecorationColor|accentColor|caretColor|fill|stroke|opacity|filter|backdropFilter|WebkitTextFillColor|WebkitTextStrokeColor|columnRuleColor)$/;
const TYPE = /^(font\w*|lineHeight|letterSpacing|wordSpacing|textTransform|textDecoration(Line|Style|Thickness)?|textAlign|textIndent|textWrap|whiteSpace|fontVariant\w*|WebkitFontSmoothing|hyphens)$/;

/** Which aspect a CSS property belongs to, in the camelCase the document keeps. Anything else is layout. */
export function aspectOfStyle(prop: string): VariationAspect {
  if (prop.startsWith('--')) return 'colour';
  if (COLOUR.test(prop)) return 'colour';
  if (TYPE.test(prop)) return 'type';
  return 'layout';
}

export interface VariationDrift {
  aspect: VariationAspect;
  /** The layer in the copy, and the one in the original it stands for. */
  copy: string;
  original?: string;
  name: string;
  detail: string;
}

/**
 * What a copy changed in the aspects it was asked to hold fixed, layer by layer against the original. A layer the
 * copy added or removed is a change of layout. At most `limit` findings.
 */
export function variationDrift(doc: BogenDoc, copyId: string, originalId: string, map: Record<string, string>, variation: Variation, limit = 20): VariationDrift[] {
  const held = new Set(heldAspects(variation));
  if (!held.size) return [];
  const out: VariationDrift[] = [];
  const add = (d: VariationDrift) => { if (out.length < limit) out.push(d); };
  const copies = [copyId, ...doc.descendants(copyId).map((n) => n.id)];
  const seen = new Set<string>();
  for (const id of copies) {
    const node = doc.getNode(id);
    if (!node) continue;
    const originalOf = id === copyId ? originalId : map[id];
    const original = originalOf ? doc.getNode(originalOf) : undefined;
    if (!original) {
      if (held.has('layout')) add({ aspect: 'layout', copy: id, name: node.name, detail: 'added in the copy' });
      if (held.has('copy') && node.text) add({ aspect: 'copy', copy: id, name: node.name, detail: `new text "${node.text.slice(0, 60)}"` });
      continue;
    }
    seen.add(original.id);
    compare(node, original, id === copyId, held, add);
  }
  if (held.has('layout')) {
    for (const n of doc.descendants(originalId)) if (!seen.has(n.id)) add({ aspect: 'layout', copy: '', original: n.id, name: n.name, detail: 'removed in the copy' });
  }
  return out;
}

const PLACEMENT = new Set(['position', 'left', 'top', 'right', 'bottom', 'zIndex', 'width', 'height']);

function compare(copy: BogenNode, original: BogenNode, root: boolean, held: Set<VariationAspect>, add: (d: VariationDrift) => void): void {
  const keys = new Set([...Object.keys(copy.style), ...Object.keys(original.style)]);
  for (const key of keys) {
    // The copy's own place on the canvas is not part of the design.
    if (root && PLACEMENT.has(key)) continue;
    const a = original.style[key];
    const b = copy.style[key];
    if (a === b) continue;
    const aspect = aspectOfStyle(key);
    if (held.has(aspect)) add({ aspect, copy: copy.id, original: original.id, name: copy.name, detail: `${key} ${a ?? 'unset'} -> ${b ?? 'unset'}` });
  }
  if (held.has('copy') && (copy.text ?? '') !== (original.text ?? '')) add({ aspect: 'copy', copy: copy.id, original: original.id, name: copy.name, detail: `text "${(original.text ?? '').slice(0, 40)}" -> "${(copy.text ?? '').slice(0, 40)}"` });
  if (held.has('copy') && (copy.attrs?.alt ?? '') !== (original.attrs?.alt ?? '')) add({ aspect: 'copy', copy: copy.id, original: original.id, name: copy.name, detail: 'alt text changed' });
  if (held.has('layout') && copy.tag !== original.tag) add({ aspect: 'layout', copy: copy.id, original: original.id, name: copy.name, detail: `<${original.tag}> -> <${copy.tag}>` });
}
