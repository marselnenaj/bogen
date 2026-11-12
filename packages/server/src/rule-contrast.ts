import { colorAlpha, colorsIn, flattenColor, normalizeColor, parseBlock, type BogenDoc, type BogenNode } from '@bogen/core';

/**
 * Text colour and background under a layer's pseudo-elements and conditional blocks, worked out from its styles.
 *
 * A render at one width, in one colour scheme and with nothing hovered sees none of `@media (prefers-color-scheme: dark)`,
 * `@container (max-width: 560px)` or `:hover`, and a probe of an element does not see the words its `::before` puts
 * in. These are what each block makes of the text: its colour as it inherits, the solid colour behind it as the chain
 * of backgrounds paints it, and its size, so that a check can measure them like any other text.
 */

export interface RulePair {
  /** The block key, such as `::before` or `@media (prefers-color-scheme: dark)`. */
  block: string;
  /** The words a pseudo-element shows, when it is one. */
  content?: string;
  /** Text colour as hex, or undefined when nothing in the chain sets one. */
  color?: string;
  /** Solid colour behind it; null for an image or gradient; undefined when unknown. */
  backdrop?: string | null;
  size?: number;
  weight?: number;
  /** Whether the block itself, on the layer or an ancestor, set the colour or the background. What it did not set is as the layer has it. */
  sets: { color: boolean; backdrop: boolean };
}

const VAR = /var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;

function resolve(value: string, tokens: Map<string, string>): string {
  let out = value;
  for (let i = 0; i < 6 && out.includes('var('); i++) out = out.replace(VAR, (_, name: string, fallback?: string) => tokens.get(name) ?? fallback ?? '');
  return out;
}

/** The words of a `content` value, when it shows words: a quoted string with a letter or digit in it. */
export function pseudoWords(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const m = /^\s*(["'])((?:\\.|(?!\1).)*)\1\s*$/.exec(content);
  if (!m) return undefined;
  const words = m[2]!.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/\\(.)/g, '$1');
  return /[\p{L}\p{N}]/u.test(words) ? words : undefined;
}

function px(value: string | undefined, tokens: Map<string, string>): number | undefined {
  if (!value) return undefined;
  const v = resolve(value, tokens).trim().toLowerCase();
  const m = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : n;
}

function weightOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (value === 'bold') return 700;
  if (value === 'normal') return 400;
  return Number(value) || undefined;
}

function backgroundOf(style: Record<string, string> | undefined, tokens: Map<string, string>): string | null | undefined {
  if (!style) return undefined;
  const raw = `${style.background ?? ''} ${style.backgroundColor ?? ''}`.trim();
  if (!raw && !style.backgroundImage) return undefined;
  const value = resolve(raw, tokens);
  if (/gradient\(|url\(/i.test(`${value} ${style.backgroundImage ?? ''}`)) return null;
  return colorsIn(value)[0];
}

/** The key without its pseudo-element: the condition a block depends on, or '' for none. */
function conditionOf(key: string): string {
  const block = parseBlock(key);
  if (!block) return '';
  const pseudo = block.pseudo ?? '';
  return pseudo ? key.slice(0, key.length - pseudo.length).trim() : key;
}

/**
 * Every pseudo-element with words, and every condition that changes a text layer's colour or what is behind it, as the
 * pair of colours it gives. Conditions on an ancestor count, such as a dark mode block on the artboard; a pair the same
 * as the layer's own is left out, since the layer's own check sees it already.
 */
export function rulePairs(doc: BogenDoc, node: BogenNode, tokens: Map<string, string>): RulePair[] {
  const chain: BogenNode[] = [node];
  for (const id of doc.ancestors(node.id)) {
    const up = doc.getNode(id);
    if (up) chain.push(up);
  }
  const hasText = Boolean(node.text?.trim());
  // Which blocks to look at: pseudo-elements of this layer, and conditions anywhere up the chain.
  const keys = new Set<string>();
  for (const [i, n] of chain.entries()) {
    for (const [key, style] of Object.entries(n.rules ?? {})) {
      const block = parseBlock(key);
      if (!block) continue;
      if (block.pseudo) {
        if (i === 0 && (block.pseudo === '::before' || block.pseudo === '::after')) keys.add(key);
        continue;
      }
      if (!hasText) continue;
      if (style.color || style.background || style.backgroundColor || (i === 0 && (style.fontSize || style.opacity))) keys.add(key);
    }
  }
  const out: RulePair[] = [];
  for (const key of keys) {
    const block = parseBlock(key)!;
    const condition = conditionOf(key);
    const own = node.rules?.[key];
    let content: string | undefined;
    if (block.pseudo) {
      // A conditional pseudo-element shows the words of the plain one unless it says other words.
      content = pseudoWords(own?.content ?? node.rules?.[block.pseudo]?.content);
      if (!content) continue;
    }
    // Under a condition, each layer up the chain uses its block for that condition before its own style.
    const at = (n: BogenNode, prop: string): { value: string; fromBlock: boolean } | undefined => {
      const inBlock = condition ? n.rules?.[condition]?.[prop] : undefined;
      if (inBlock) return { value: inBlock, fromBlock: true };
      const plain = n.style[prop];
      return plain ? { value: plain, fromBlock: false } : undefined;
    };
    let color: string | undefined;
    let colorSet = false;
    const ownColor = own?.color;
    if (ownColor) {
      color = normalizeColor(resolve(ownColor, tokens)) ?? undefined;
      colorSet = true;
    } else {
      for (const n of chain) {
        const c = at(n, 'color');
        if (!c) continue;
        color = normalizeColor(resolve(c.value, tokens)) ?? undefined;
        colorSet = c.fromBlock;
        break;
      }
    }
    const opacity = Number(own?.opacity ?? (condition ? node.rules?.[condition]?.opacity : undefined) ?? '');
    if (color && Number.isFinite(opacity) && opacity > 0 && opacity < 1) {
      const a = colorAlpha(color) * opacity;
      color = `${color.slice(0, 7)}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
      colorSet = true;
    }

    // What paints behind: the pseudo-element's own background first, then the chain's.
    let backdrop: string | null | undefined;
    let backdropSet = false;
    const veils: string[] = [];
    const layers: { style: Record<string, string> | undefined; fromBlock: boolean }[] = [];
    if (block.pseudo) layers.push({ style: own, fromBlock: true });
    for (const n of chain) {
      const inBlock = condition ? n.rules?.[condition] : undefined;
      const blockBg = backgroundOf(inBlock, tokens);
      layers.push(blockBg !== undefined ? { style: inBlock, fromBlock: true } : { style: n.style, fromBlock: false });
    }
    for (const layer of layers) {
      const bg = backgroundOf(layer.style, tokens);
      if (bg === undefined) continue;
      if (layer.fromBlock) backdropSet = true;
      if (bg === null) {
        backdrop = null;
        break;
      }
      if (colorAlpha(bg) >= 1) {
        backdrop = veils.reduceRight((under, top) => flattenColor(top, under), bg);
        break;
      }
      veils.push(bg);
    }
    if (!colorSet && !backdropSet && !block.pseudo) continue;
    const size = px(own?.fontSize ?? (condition ? node.rules?.[condition]?.fontSize : undefined) ?? node.style.fontSize, tokens);
    const weight = weightOf(own?.fontWeight ?? node.style.fontWeight);
    out.push({
      block: key, ...(content ? { content } : {}), ...(color ? { color } : {}), ...(backdrop !== undefined ? { backdrop } : {}),
      ...(size ? { size } : {}), ...(weight ? { weight } : {}), sets: { color: colorSet, backdrop: backdropSet },
    });
  }
  return out;
}

/** A style value with one colour in it swapped for another, keeping the rest, such as the width of a border. */
export function swapColor(value: string, fromHex: string, to: string): string | null {
  let changed = false;
  const out = value.replace(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\([^()]*\)|\b[a-zA-Z]{3,}\b/g, (m) => {
    const hex = normalizeColor(m);
    if (!hex || hex.slice(0, 7) !== fromHex.slice(0, 7)) return m;
    changed = true;
    return to;
  });
  return changed ? out : null;
}
