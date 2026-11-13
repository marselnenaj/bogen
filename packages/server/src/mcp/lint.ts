import { craftFindings, exampleKindOf, previewsSystem, colorAlpha, contrastRatio, flattenColor, normalizeCssValue, normalizeColor, proposalMark, ruleValues, type BogenDoc, type BogenNode, type Token, type TokenKind } from '@bogen/core';
import type { Renderer, Target } from '../render.ts';
import { rulePairs } from '../rule-contrast.ts';
import { confirmed, declaredLanguageOf, exampleLine, itemsForLanguage, judgeCopy, voiceFindings, voiceProfile, type BrandData } from '@bogen/core';
import { copyIssues, type AvoidWord } from './copy-check.ts';

export type LintRule = 'contrast' | 'token' | 'grid' | 'overflow' | 'alt' | 'small-text' | 'target' | 'repeated' | 'spacing' | 'hierarchy' | 'copy' | 'craft';
/**
 * A style to set on the layer, or in one of its blocks (`::before`, `@media (...)`, `:focus-visible`) when `block` says
 * which. Safe ones change nothing a person would notice, so `design_lint` with fix applies them.
 */
export interface LintFix { style: Record<string, string>; safe: boolean; block?: string }
/** `check` names the craft check, such as `glow` or `primary-actions`, and `criterion` the rubric criterion it counts against. */
/**
 * `severity` hard: an objective defect (contrast is reported as its own rule): text that overflows or is clipped by more
 * than 2px, text unreadable where it is seen, placeholder copy. design_verify does not count a rubric as scored while one
 * stands. advisory: a choice that often reads as default, with `why`; it never blocks and never caps a score.
 */
export interface LintIssue { rule: LintRule; nodeId: string; name: string; message: string; fix?: LintFix; check?: string; criterion?: string; severity?: 'hard' | 'advisory'; why?: string }

const GRID_PROPS = ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'paddingInline', 'paddingBlock', 'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'marginInline', 'marginBlock', 'gap', 'rowGap', 'columnGap'];
const GRID = 4;
const MIN_TEXT_PX = 12;
/** WCAG 2.2 target size, level AA. */
const MIN_TARGET_PX = 24;

function offGrid(value: string): number[] {
  return [...value.matchAll(/(-?\d*\.?\d+)px/g)].map((m) => Math.abs(Number(m[1]))).filter((n) => n > 2 && n % GRID !== 0);
}

/** The token kinds a property can take. A value that equals a token of another kind is a coincidence: 16px of type is not 16px of space. */
function tokenKinds(prop: string): TokenKind[] {
  if (/color$/i.test(prop) || prop === 'background' || prop === 'fill' || prop === 'stroke') return ['color'];
  if (/radius$/i.test(prop)) return ['radius'];
  if (/^(padding|margin|gap|rowGap|columnGap)/.test(prop)) return ['spacing'];
  if (/^(min|max)?(width|height|Width|Height)$/.test(prop) || prop === 'flexBasis') return ['container'];
  const type: Record<string, TokenKind> = { fontFamily: 'font-family', fontWeight: 'font-weight', fontSize: 'font-size', lineHeight: 'line-height', letterSpacing: 'letter-spacing' };
  return type[prop] ? [type[prop]] : [];
}

/** Checks that need only the document. */
export function staticIssues(doc: BogenDoc, nodes: BogenNode[]): LintIssue[] {
  const byValue = new Map<string, string>();
  for (const t of doc.getTokens()) {
    const v = t.value.trim().toLowerCase();
    const key = `${t.kind}:${v}`;
    if (v && v !== '0' && v !== '0px' && !byValue.has(key)) byValue.set(key, t.name);
  }
  const spacing = spacingIssues(doc, nodes);
  // Off the file's own scale says more than off the 4px grid, so a value gets one of the two.
  const offScale = new Set(spacing.filter((i) => i.prop).map((i) => `${i.nodeId}:${i.prop}`));
  const out: LintIssue[] = [...repeatedSubtrees(doc, nodes), ...spacing.map(({ prop: _prop, ...issue }) => issue), ...ruleContrastIssues(doc, nodes)];
  // A theme file draws the system's screens at the sizes its configuration sets, which are not on a 4px grid.
  const grid = !previewsSystem(doc);
  for (const n of nodes) {
    // What is inside an instance is reported on its main, once.
    if (n.virtual && !n.instanceOf) continue;
    if (n.type === 'image' && n.attrs?.alt === undefined) out.push({ rule: 'alt', nodeId: n.id, name: n.name, message: 'The image has no alt text. Set it with layer_attrs, using an empty alt only if it is decorative.' });
    // Pseudo-elements and conditional blocks hold colours and sizes too, said with the block they are in.
    const values = [...Object.entries(n.style).map(([prop, value]) => ({ prop, value, where: '', block: '' })), ...ruleValues(n.rules).map((r) => ({ prop: r.prop, value: r.value, where: ` in ${r.block}`, block: r.block }))];
    for (const { prop, value, where, block } of values) {
      if (prop === 'left' || prop === 'top') continue;
      const token = tokenKinds(prop).map((kind) => byValue.get(`${kind}:${value.trim().toLowerCase()}`)).find(Boolean);
      // The same value by name: nothing moves, so it is safe in a block too, where it goes into that block.
      if (token) out.push({ rule: 'token', nodeId: n.id, name: n.name, message: `${prop}${where} is ${value}, which equals the token --${token}. Use var(--${token}).`, ...(n.virtual ? {} : { fix: { style: { [prop]: `var(--${token})` }, safe: true, ...(block ? { block } : {}) } }) });
      if (grid && GRID_PROPS.includes(prop) && !(where === '' && offScale.has(`${n.id}:${prop}`))) {
        const bad = offGrid(value);
        if (bad.length) out.push({ rule: 'grid', nodeId: n.id, name: n.name, message: `${prop}${where} is ${value}, off the ${GRID}px grid (${bad.map((b) => `${b}px`).join(', ')}).` });
      }
    }
  }
  return out;
}

/**
 * WCAG contrast of text under a condition, such as a dark mode block, a container query or a hover state, worked out
 * from the styles, since a render at one width, scheme and state does not show it. Pseudo-elements are measured in the
 * render instead. The fix goes into the block, with the file's colour token that reads best there.
 */
function ruleContrastIssues(doc: BogenDoc, nodes: BogenNode[]): LintIssue[] {
  const out: LintIssue[] = [];
  const tokens = new Map(doc.getTokens().map((t) => [t.name, t.value]));
  const resolved = (value: string, depth = 0): string => (depth < 6 ? value.replace(/var\(\s*--([\w-]+)[^)]*\)/g, (_, name: string) => resolved(tokens.get(name) ?? '', depth + 1)) : value);
  const colours = doc.getTokens().filter((t) => t.kind === 'color').flatMap((t) => {
    const hex = normalizeColor(resolved(t.value));
    return hex && colorAlpha(hex) >= 1 ? [{ name: t.name, hex }] : [];
  });
  for (const n of nodes) {
    if (n.virtual && !n.instanceOf) continue;
    for (const p of rulePairs(doc, n, tokens)) {
      if (p.content || !p.color || !p.backdrop) continue;
      const fg = colorAlpha(p.color) < 1 ? flattenColor(p.color, p.backdrop) : p.color;
      const ratio = contrastRatio(fg, p.backdrop);
      const size = p.size ?? 16;
      const large = size >= 24 || (size >= 18.66 && (p.weight ?? 400) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio >= need) continue;
      const best = colours.filter((c) => contrastRatio(c.hex, p.backdrop!) >= need).sort((a, b) => contrastRatio(b.hex, p.backdrop!) - contrastRatio(a.hex, p.backdrop!))[0];
      out.push({
        rule: 'contrast', nodeId: n.id, name: n.name,
        message: `In ${p.block}, text contrast is ${ratio.toFixed(2)}:1, under WCAG AA ${need}:1 for ${large ? 'large' : 'normal'} text (${p.color} on ${p.backdrop}, worked out from the styles).${best ? ` var(--${best.name}) reaches ${contrastRatio(best.hex, p.backdrop).toFixed(2)}:1 there.` : ''}`,
        ...(best && !n.virtual ? { fix: { style: { color: `var(--${best.name})` }, safe: false, block: p.block } } : {}),
      });
    }
  }
  return out;
}

const SPACING_PROPS = ['gap', 'rowGap', 'columnGap', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'paddingInline', 'paddingBlock'];
/** What siblings of one kind are compared by: their gaps, paddings and the margins that space them apart. */
const RHYTHM_PROPS = [...SPACING_PROPS, 'marginTop', 'marginBottom', 'marginLeft', 'marginRight'];
/** A snap this small, or an outlier this close to its siblings, is not something a person would see. */
const SAFE_SNAP_PX = 2;
const SAFE_RHYTHM_PX = 4;
const ROOT_PX = 16;

/** A length in px, through tokens by name. Null for what only a browser can work out (calc, %, vw...). */
function lengthPx(value: string, tokens: Map<string, Token>, depth = 0): number | null {
  const v = value.trim().toLowerCase();
  if (v === '0') return 0;
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em)$/.exec(v);
  if (m) return Number(m[1]) * (m[2] === 'px' ? 1 : ROOT_PX);
  const ref = /^var\(\s*--([\w-]+)\s*(?:,[^)]*)?\)$/.exec(v);
  const token = ref ? tokens.get(ref[1]!) : undefined;
  return token && depth < 4 ? lengthPx(token.value, tokens, depth + 1) : null;
}

/** The parts of a shorthand such as `padding: 8px 16px`, or null when one is not a plain length. */
function lengthParts(value: string, tokens: Map<string, Token>): { raw: string; px: number }[] | null {
  const parts = value.trim().split(/\s+(?![^(]*\))/);
  const out = parts.map((raw) => ({ raw, px: lengthPx(raw, tokens) }));
  return out.every((p) => p.px !== null) ? (out as { raw: string; px: number }[]) : null;
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

/** The columns of a grid template: one per track, repeat(4, 1fr) as four, auto-fill and auto-fit as "auto". */
function gridTracks(template: string | undefined): string {
  const v = template?.trim() ?? '';
  if (!v || v === 'none') return '1';
  if (/repeat\(\s*auto-(?:fill|fit)/.test(v)) return 'auto';
  let count = 0, depth = 0, token = '';
  const flush = () => {
    const m = /^repeat\(\s*(\d+)\s*,(.*)\)$/.exec(token);
    if (m) count += Number(m[1]) * Math.max(1, gridTracks(m[2]) === 'auto' ? 1 : Number(gridTracks(m[2])));
    else if (token && !/^\[.*\]$/.test(token)) count++;
    token = '';
  };
  for (const c of v) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (/\s/.test(c) && depth === 0) flush();
    else token += c;
  }
  flush();
  return String(count);
}

/**
 * What a sibling is, for spacing rhythm: its type, tag and component, and how it lays out what it holds (a flex row,
 * a flex column, a grid of so many columns, or plain flow). Three cards are alike; a two-column block beside a column
 * of buttons is not, even when both are divs, and their gaps say nothing about each other.
 */
function siblingKind(n: BogenNode): string {
  const display = n.style.display ?? '';
  const layout = n.type !== 'frame' ? ''
    : /flex/.test(display) ? `flex ${/column/.test(n.style.flexDirection ?? '') ? 'column' : 'row'}`
    : /grid/.test(display) ? `grid ${gridTracks(n.style.gridTemplateColumns)}`
    : 'flow';
  return `${n.type}<${n.tag}>${n.instanceOf ?? ''}|${layout}`;
}

/**
 * Spacing rhythm: gaps and paddings off the file's spacing tokens, with the nearest step as the fix, and siblings of
 * one kind (three cards, five rows) whose spacing differs from what most of them use.
 */
function spacingIssues(doc: BogenDoc, nodes: BogenNode[]): (LintIssue & { prop?: string })[] {
  const tokens = new Map(doc.getTokens().map((t) => [t.name, t]));
  const scale = doc.getTokens().filter((t) => t.kind === 'spacing').flatMap((t) => {
    const v = lengthPx(t.value, tokens);
    return v !== null && v > 0 ? [{ name: t.name, px: v }] : [];
  }).sort((a, b) => a.px - b.px);
  const out: (LintIssue & { prop?: string })[] = [];
  const own = nodes.filter((n) => !n.virtual);

  // A scale of one is a value, not a rhythm.
  if (scale.length >= 2) {
    const nearest = (v: number) => scale.reduce((a, b) => (Math.abs(b.px - v) < Math.abs(a.px - v) ? b : a));
    const steps = scale.map((t) => `--${t.name} ${px(t.px)}`).join(', ');
    for (const n of own) {
      for (const prop of SPACING_PROPS) {
        const value = n.style[prop];
        if (!value || /var\(/.test(value)) continue;
        const parts = lengthParts(value, tokens);
        if (!parts) continue;
        const off = parts.filter((p) => Math.abs(p.px) > 2 && !scale.some((t) => Math.abs(t.px - Math.abs(p.px)) < 0.5));
        if (!off.length) continue;
        const snapped = parts.map((p) => {
          if (p.px === 0) return { text: '0', diff: 0 };
          const t = nearest(Math.abs(p.px));
          return { text: p.px < 0 ? `calc(-1 * var(--${t.name}))` : `var(--${t.name})`, diff: Math.abs(t.px - Math.abs(p.px)) };
        });
        const fixValue = snapped.map((p) => p.text).join(' ');
        const safe = snapped.every((p) => p.diff <= SAFE_SNAP_PX);
        out.push({
          rule: 'spacing', nodeId: n.id, name: n.name, prop,
          message: `${prop} is ${value}, off the file's spacing scale (${steps}). Use ${fixValue}${safe ? '' : ', or add a token if this step is meant'}.`,
          fix: { style: { [prop]: fixValue }, safe },
        });
      }
    }
  }

  // Siblings of the same kind (see siblingKind) should be spaced alike. Only an outlier against a clear majority is reported.
  const byParent = new Map<string, BogenNode[]>();
  for (const n of own) {
    if (n.style.position === 'absolute' || n.style.position === 'fixed') continue;
    const list = byParent.get(n.parent) ?? [];
    list.push(n);
    byParent.set(n.parent, list);
  }
  for (const siblings of byParent.values()) {
    const kinds = new Map<string, BogenNode[]>();
    for (const n of siblings) {
      const key = siblingKind(n);
      kinds.set(key, [...(kinds.get(key) ?? []), n]);
    }
    for (const group of kinds.values()) {
      if (group.length < 3) continue;
      for (const prop of RHYTHM_PROPS) {
        const valued = group.filter((n) => n.style[prop] !== undefined);
        if (valued.length < 3) continue;
        const counts = new Map<string, BogenNode[]>();
        for (const n of valued) {
          const key = normalizeCssValue(n.style[prop]!);
          counts.set(key, [...(counts.get(key) ?? []), n]);
        }
        const major = [...counts.values()].reduce((a, b) => (b.length > a.length ? b : a));
        const outliers = valued.filter((n) => !major.includes(n));
        if (major.length < 2 || major.length * 2 <= valued.length || !outliers.length || outliers.length * 3 > valued.length) continue;
        const want = major[0]!.style[prop]!;
        const wantParts = lengthParts(want, tokens);
        for (const n of outliers) {
          const have = lengthParts(n.style[prop]!, tokens);
          const close = !!wantParts && !!have && have.length === wantParts.length && have.every((p, i) => Math.abs(p.px - wantParts[i]!.px) <= SAFE_RHYTHM_PX);
          out.push({
            rule: 'spacing', nodeId: n.id, name: n.name,
            message: `${prop} is ${n.style[prop]}, where ${major.length} of its ${valued.length - 1} siblings of the same kind use ${want} (${major.slice(0, 4).map((m) => m.id).join(', ')}). Make it ${want}, or make the difference bigger if it is meant.`,
            fix: { style: { [prop]: want }, safe: close },
          });
        }
      }
    }
  }
  return out;
}

/** Text as it rendered, for the type hierarchy. */
interface TextFact { id: string; size: number; tag: string; chars: number }
const MAX_TYPE_SIZES = 6;
const HEADING = /^h([1-6])$/;

/**
 * Type hierarchy per artboard: headings that are not larger than the body text, a heading level larger than one above
 * it, and more distinct sizes than a hierarchy needs.
 */
function hierarchyIssues(doc: BogenDoc, texts: TextFact[], names: Map<string, string>): LintIssue[] {
  const out: LintIssue[] = [];
  const byBoard = new Map<string, TextFact[]>();
  for (const t of texts) {
    // The artboard, or the outermost layer checked when that is only part of one.
    const root = [t.id, ...doc.ancestors(t.id)].filter((a) => names.has(a)).at(-1) ?? t.id;
    byBoard.set(root, [...(byBoard.get(root) ?? []), t]);
  }
  const tokens = new Map(doc.getTokens().map((t) => [t.name, t]));
  const sizeTokens = doc.getTokens().filter((t) => t.kind === 'font-size').flatMap((t) => {
    const v = lengthPx(t.value, tokens);
    return v ? [{ name: t.name, px: v }] : [];
  }).sort((a, b) => a.px - b.px);
  const round = (n: number) => Math.round(n * 2) / 2;
  const nameOf = (id: string) => names.get(id) ?? doc.getNode(id)?.name ?? '';
  for (const [root, list] of byBoard) {
    // The body is the size most of the words are set in, headings aside.
    const weights = new Map<number, number>();
    for (const t of list) if (!HEADING.test(t.tag)) weights.set(round(t.size), (weights.get(round(t.size)) ?? 0) + t.chars);
    const bodyEntry = [...weights.entries()].reduce<[number, number] | null>((a, b) => (!a || b[1] > a[1] ? b : a), null);
    const body = bodyEntry && bodyEntry[1] >= 20 ? bodyEntry[0] : null;
    const headings = list.filter((t) => HEADING.test(t.tag)).map((t) => ({ ...t, level: Number(HEADING.exec(t.tag)![1]) }));
    for (const h of headings) {
      if (body !== null && h.size <= body + 0.5) {
        const target = Math.round(body * 1.25);
        const token = sizeTokens.find((t) => t.px >= target);
        const value = token ? `var(--${token.name})` : `${target}px`;
        out.push({ rule: 'hierarchy', nodeId: h.id, name: nameOf(h.id), message: `This ${h.tag} is ${px(h.size)}, no larger than the body text at ${px(body)}, so it does not read as a heading. Make it ${value}${token ? ` (${px(token.px)})` : ''} or larger, or use a body tag if it is not a heading.`, fix: { style: { fontSize: value }, safe: false } });
        continue;
      }
      // The most important heading it outgrows says the most.
      const above = headings.filter((o) => o.level < h.level && o.size < h.size - 0.5).sort((x, y) => x.level - y.level || x.size - y.size)[0];
      if (above) out.push({ rule: 'hierarchy', nodeId: h.id, name: nameOf(h.id), message: `This ${h.tag} is ${px(h.size)}, larger than the ${above.tag} "${nameOf(above.id).slice(0, 40)}" (${above.id}) at ${px(above.size)}. Levels should get smaller from h1 to h6: swap the tags or the sizes.` });
    }
    // A specimen shows a scale's steps on purpose, so they are not the artboard's sizes; nor is a counter-example.
    const counted = list.filter((t) => !exampleKindOf(doc, t.id));
    const sizes = [...new Set(counted.map((t) => round(t.size)))].sort((a, b) => a - b);
    if (sizes.length > MAX_TYPE_SIZES) {
      const uses = (size: number) => counted.filter((t) => round(t.size) === size);
      // Neighbours within 10% are hard to tell apart. Each run of them goes into its most used size, or the token's.
      const runs: number[][] = [];
      for (const size of sizes) {
        const run = runs.at(-1);
        if (run && size / run.at(-1)! <= 1.1) run.push(size);
        else runs.push([size]);
      }
      const near = runs.filter((r) => r.length > 1).map((run) => {
        const into = [...run].sort((a, b) => uses(b).length - uses(a).length || Number(sizeTokens.some((t) => t.px === b)) - Number(sizeTokens.some((t) => t.px === a)) || b - a)[0]!;
        const from = run.filter((x) => x !== into);
        return `${from.map(px).join(' and ')} into ${px(into)} (${from.flatMap((x) => uses(x).map((t) => t.id)).slice(0, 6).join(', ')})`;
      });
      out.push({ rule: 'hierarchy', nodeId: root, name: nameOf(root), message: `This artboard uses ${sizes.length} font sizes (${sizes.join(', ')}px). ${MAX_TYPE_SIZES} or fewer make a clear hierarchy${near.length ? `; merge ${near.slice(0, 4).join('; ')}` : '; merge the ones that are close'}${sizeTokens.length ? ', using the font-size tokens' : ''}.` });
    }
  }
  return out;
}

/** Layers with at least this many descendants are worth a component when they repeat. */
const MIN_REPEATED_LAYERS = 2;
/** A structure this big that appears twice anywhere is a copy, not a coincidence of layout. */
const LARGE_REPEAT = 6;

/**
 * Finds layers that are the same but for their words and images: what an agent wrote three times
 * instead of making a component. Only the outermost of a repeat is reported.
 */
function repeatedSubtrees(doc: BogenDoc, nodes: BogenNode[]): LintIssue[] {
  const groups = new Map<string, { nodes: BogenNode[]; size: number }>();
  const signature = (n: BogenNode): { key: string; size: number } | null => {
    // Instances are the answer, not the problem. A proposal is a copy on purpose, kept until it is decided.
    if (n.instanceOf !== undefined || n.virtual || n.component || proposalMark(doc, n.id)) return null;
    const kids = doc.getChildren(n.id).map(signature);
    if (kids.some((k) => k === null)) return null;
    const style = Object.entries(n.style).filter(([k]) => !['left', 'top', 'right', 'bottom', 'position', 'zIndex'].includes(k)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}:${v}`).join(';') + (n.rules ? JSON.stringify(n.rules) : '');
    const size = 1 + kids.reduce((sum, k) => sum + k!.size, 0);
    const key = `${n.type}<${n.tag}>{${style}}[${kids.map((k) => k!.key).join(',')}]`;
    if (kids.length) {
      const group = groups.get(key) ?? { nodes: [], size };
      group.nodes.push(n);
      groups.set(key, group);
    }
    return { key, size };
  };
  const inScope = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const parent = doc.getNode(n.parent);
    // Only starting points: the walk itself sees everything below.
    if (!parent || !inScope.has(parent.id)) signature(n);
  }
  // Two small blocks of the same shape in different places, such as a heading over a line of text, share a layout
  // and nothing else. A real repeat sits side by side (cards, rows, swatches), comes three times or more, or is big.
  const real = (g: { nodes: BogenNode[]; size: number }) => {
    if (g.nodes.length < 2 || g.size <= MIN_REPEATED_LAYERS) return false;
    return g.nodes.length >= 3 || g.size >= LARGE_REPEAT || new Set(g.nodes.map((n) => n.parent)).size < g.nodes.length;
  };
  const repeated = [...groups.values()].filter(real);
  const covered = new Set(repeated.flatMap((g) => g.nodes.map((n) => n.id)));
  const out: LintIssue[] = [];
  for (const group of repeated.sort((a, b) => b.size * b.nodes.length - a.size * a.nodes.length)) {
    // A card repeated three times repeats its title too. The card is the one to fix.
    if (group.nodes.every((n) => doc.ancestors(n.id).some((a) => covered.has(a)))) continue;
    const first = group.nodes[0]!;
    const others = group.nodes.slice(1).map((n) => n.id);
    out.push({ rule: 'repeated', nodeId: first.id, name: first.name, message: `${group.nodes.length} layers share this structure of ${group.size} layers (${first.id}, ${others.slice(0, 8).join(', ')}${others.length > 8 ? ', ...' : ''}). Make one a component with component_create and put instances in the others' place, with props for what differs.` });
  }
  return out;
}

interface ProbeIssue { rule: 'contrast' | 'overflow' | 'small-text' | 'target'; id: string; message: string }

/** Runs in the page, so it can only use its argument. */
function probe(arg: { ids: string[]; minText: number; minTarget: number }): { issues: ProbeIssue[]; texts: TextFact[] } {
  const wanted = new Set(arg.ids);
  const out: ProbeIssue[] = [];
  const texts: TextFact[] = [];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // The browser parses every CSS colour syntax. A pixel gives the sRGB result. A big page has few colours and
  // thousands of layers, so each is parsed once, and each element's backdrop and opacity are worked out once.
  const colours = new Map<string, [number, number, number, number]>();
  const rgba = (css: string): [number, number, number, number] => {
    const known = colours.get(css);
    if (known) return [...known];
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const out: [number, number, number, number] = [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    colours.set(css, out);
    return [...out];
  };
  const over = (top: number[], bottom: number[]): [number, number, number] => {
    const a = top[3]!;
    return [top[0]! * a + bottom[0]! * (1 - a), top[1]! * a + bottom[1]! * (1 - a), top[2]! * a + bottom[2]! * (1 - a)];
  };
  const luminance = (c: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
  };
  /** The solid colour behind an element, or null if an image, gradient or shader is in the way: its own background over its parent's backdrop. */
  const backdrops = new Map<Element, [number, number, number] | null>();
  const backdrop = (el: Element): [number, number, number] | null => {
    if (backdrops.has(el)) return backdrops.get(el)!;
    const style = getComputedStyle(el);
    let out: [number, number, number] | null = null;
    if (style.backgroundImage === 'none' && !el.querySelector(':scope > [data-shader], :scope > img, :scope > video')) {
      const color = rgba(style.backgroundColor);
      if (color[3] >= 1) out = over(color, [255, 255, 255]);
      else {
        const below = el.parentElement ? backdrop(el.parentElement) : [255, 255, 255] as [number, number, number];
        out = below && (color[3] > 0 ? over(color, below) : below);
      }
    }
    backdrops.set(el, out);
    return out;
  };
  const opacities = new Map<Element, number>();
  const opacity = (el: Element | null): number => {
    if (!el) return 1;
    let known = opacities.get(el);
    if (known === undefined) {
      known = Number(getComputedStyle(el).opacity) * opacity(el.parentElement);
      opacities.set(el, known);
    }
    return known;
  };

  for (const el of document.querySelectorAll<HTMLElement>('[data-bogen-id]')) {
    const id = el.dataset.bogenId!;
    if (!wanted.has(id)) continue;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || !box.width) continue;

    // A link inside a line of text is exempt in WCAG, as it has the text around it.
    if ((el.tagName === 'BUTTON' || el.tagName === 'A') && style.display !== 'inline' && (box.width < arg.minTarget || box.height < arg.minTarget)) {
      out.push({ rule: 'target', id, message: `This ${el.tagName === 'A' ? 'link' : 'button'} is ${Math.round(box.width)}x${Math.round(box.height)}px, under the ${arg.minTarget}px that people can reliably hit.` });
    }

    const hasText = [...el.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent?.trim());
    if (hasText) {
      texts.push({ id, size: Number.parseFloat(style.fontSize), tag: el.tagName.toLowerCase(), chars: (el.textContent ?? '').trim().length });
      if (Number.parseFloat(style.fontSize) < arg.minText) out.push({ rule: 'small-text', id, message: `The text is ${style.fontSize}, under ${arg.minText}px.` });
      const back = backdrop(el);
      if (back) {
        const fg = rgba(style.color);
        fg[3] *= opacity(el);
        const text = over(fg, back);
        const [hi, lo] = [luminance(text), luminance(back)].sort((a, b) => b - a) as [number, number];
        const ratio = (hi + 0.05) / (lo + 0.05);
        const size = Number.parseFloat(style.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
        const need = large ? 3 : 4.5;
        if (ratio < need) out.push({ rule: 'contrast', id, message: `Text contrast is ${ratio.toFixed(2)}:1, under WCAG AA ${need}:1 for ${large ? 'large' : 'normal'} text (${size}px).` });
      }
      if (el.scrollWidth > el.clientWidth + 1 && style.overflowX !== 'visible') out.push({ rule: 'overflow', id, message: 'The text is cut off by its own box.' });
    }

    // Words a ::before or ::after puts in are text too, drawn in their own colour and maybe on their own background.
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      const words = /^"((?:\\.|[^"])*)"$/.exec(ps.content ?? '');
      if (!words || !/[\p{L}\p{N}]/u.test(words[1]!) || ps.display === 'none' || ps.visibility === 'hidden') continue;
      const under = backdrop(el);
      if (!under || ps.backgroundImage !== 'none') continue;
      const own = rgba(ps.backgroundColor);
      const back = own[3] > 0 ? over(own, under) : under;
      const fg = rgba(ps.color);
      fg[3] *= Number(ps.opacity) * opacity(el);
      const text = over(fg, back);
      const [hi, lo] = [luminance(text), luminance(back)].sort((a, b) => b - a) as [number, number];
      const ratio = (hi + 0.05) / (lo + 0.05);
      const size = Number.parseFloat(ps.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(ps.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need) out.push({ rule: 'contrast', id, message: `The words "${words[1]!.slice(0, 30)}" in ${pseudo} have a contrast of ${ratio.toFixed(2)}:1, under WCAG AA ${need}:1 for ${large ? 'large' : 'normal'} text (${size}px). Set their colour with layer_style pseudo ${pseudo.slice(2)}.` });
    }

    const parent = el.parentElement;
    if (!parent?.dataset.bogenId) continue;
    const absolute = style.position === 'absolute' || style.position === 'fixed';
    const parentStyle = getComputedStyle(parent);
    const clips = parentStyle.overflowX !== 'visible' || parentStyle.overflowY !== 'visible';
    // A bleeding absolute layer is usually on purpose, unless the parent cuts it off.
    if (absolute && !clips) continue;
    const p = parent.getBoundingClientRect();
    const sides = ([['left', p.left - box.left], ['right', box.right - p.right], ['top', p.top - box.top], ['bottom', box.bottom - p.bottom]] as const).filter(([, d]) => d > 1);
    if (sides.length) {
      const detail = sides.map(([side, d]) => `${Math.round(d)}px on the ${side}`).join(', ');
      out.push({ rule: 'overflow', id, message: `${clips ? 'Clipped by' : 'Overflows'} its parent by ${detail}.` });
    }
  }
  return { issues: out, texts };
}

/**
 * The craft checks of each artboard or outermost layer in scope: the habits that make work read as generated or
 * unfinished (see `craftFindings`). They need no render, so they also run where no browser can start.
 */
export function craftIssues(doc: BogenDoc, nodes: BogenNode[]): LintIssue[] {
  const inScope = new Set(nodes.map((n) => n.id));
  const out: LintIssue[] = [];
  for (const root of nodes.filter((n) => !inScope.has(n.parent) && !n.virtual && !n.hidden)) {
    for (const f of craftFindings(doc, root.id)) {
      out.push({ rule: 'craft', check: f.rule, criterion: f.criterion, severity: f.severity, ...(f.severity === 'advisory' ? { why: f.why } : {}), nodeId: f.nodeId, name: doc.getNode(f.nodeId)?.name ?? '', message: f.message });
    }
  }
  return out;
}

/** Every issue in the layers, rendered where it has to be. */
export async function lintIssues(doc: BogenDoc, renderer: Renderer, target: Target, nodes: BogenNode[], options: { avoid?: AvoidWord[]; brand?: BrandData; contentLanguage?: string | null } = {}): Promise<LintIssue[]> {
  const names = new Map(nodes.map((n) => [n.id, n.name]));
  // With a brand, each text layer is judged in the brand language it is written in, and gets that language's words.
  const brand = options.brand;
  const profile = brand ? voiceProfile(brand, { contentLanguage: options.contentLanguage ?? null }) : null;
  const langOf = (n: BogenNode) => declaredLanguageOf(doc, n.id);
  const brandAvoid = brand ? confirmed(brand.words).filter((w) => w.use === 'avoid') : [];
  const perLanguage = new Map<string | null, AvoidWord[]>();
  const avoidFor = (n: BogenNode): AvoidWord[] => {
    const spoken = judgeCopy(profile!, { text: n.text ?? '', lang: langOf(n) }).spoken;
    if (!perLanguage.has(spoken)) perLanguage.set(spoken, itemsForLanguage(brandAvoid, profile!.languages, spoken).map((w) => ({ word: w.word, ...(w.instead ? { instead: w.instead } : {}) })));
    return perLanguage.get(spoken)!;
  };
  const rendered = await renderer.probe(doc, target, probe, { ids: nodes.map((n) => n.id), minText: MIN_TEXT_PX, minTarget: MIN_TARGET_PX });
  return [
    // Overflow and clipping beyond 2px is a broken layout, not a matter of taste.
    ...rendered.issues.map((r) => ({ rule: r.rule, nodeId: r.id, name: names.get(r.id) ?? '', message: r.message, ...(r.rule === 'overflow' && overflowPx(r.message) > 2 ? { severity: 'hard' as const } : {}) })),
    // Few and about the whole artboard, so they come before the per-value findings that can fill a report.
    ...craftIssues(doc, nodes),
    ...staticIssues(doc, nodes),
    ...hierarchyIssues(doc, rendered.texts, names),
    ...copyIssues(nodes, profile ? avoidFor : options.avoid, { doc }).map((c) => ({ rule: 'copy' as const, nodeId: c.nodeId, name: c.name, message: c.message, ...(c.check === 'placeholder' ? { check: c.check, severity: 'hard' as const } : { ...(c.check ? { check: c.check } : {}), severity: 'advisory' as const, why: c.check === 'emoji' ? 'Emoji and arrow glyphs render differently on each platform and read as casual.' : 'Filler and hype words read as generated; the mechanism and the outcome convince more.' }) })),
    // The brand's measurable voice, when the file has a brand. A counter-example breaks it on purpose.
    ...(brand && profile ? voiceFindings(brand, nodes.filter((n) => !n.virtual && n.text?.trim() && exampleKindOf(doc, n.id) !== 'dont').map((n) => ({ id: n.id, name: n.name, tag: n.tag, text: n.text!, lang: langOf(n) })), { profile })
      .map((v) => ({ rule: 'copy' as const, nodeId: v.node_id, name: v.layer, message: `${v.message} ${v.how}${exampleLine(v.example)}` })) : []),
  ];
}

/** The px of an overflow finding, as its message says it: "Overflows its parent by 3px on the right." */
function overflowPx(message: string): number {
  return Math.max(0, ...[...message.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])));
}

export interface LintReport { total: number; counts: Record<string, number>; hard: number; issues: LintIssue[]; skippedOnImagesNote?: string; next?: string }

export function lintReport(issues: LintIssue[], nodes: BogenNode[]): LintReport {
  const counts: Record<string, number> = { contrast: 0, overflow: 0, token: 0, grid: 0, alt: 0, 'small-text': 0, target: 0, repeated: 0, spacing: 0, hierarchy: 0, copy: 0, craft: 0 };
  for (const issue of issues) counts[issue.rule]!++;
  // The generated look first: those are what keep a review from passing.
  const hard = issues.filter((i) => i.severity === 'hard');
  const ordered = [...hard, ...issues.filter((i) => i.severity !== 'hard')];
  return {
    total: issues.length, counts, hard: hard.length, issues: ordered.slice(0, 100),
    ...(hard.length ? { next: `${hard.length} hard ${hard.length === 1 ? 'finding is an objective defect' : 'findings are objective defects'} (overflow, unreadable text, placeholder copy): fix ${hard.length === 1 ? 'it' : 'them'} before design_verify. Advisory findings say why a choice often reads as default; keep one when your direction has a reason, and say so in design_verify kept.` } : {}),
    ...(nodes.some((n) => n.type === 'shader' || n.type === 'image' || n.style.backgroundImage) ? { skippedOnImagesNote: 'Contrast is not measured for text over images, gradients or shaders. Check those in a screenshot.' } : {}),
  };
}
