import { converter, parse } from 'culori';
import { getTextStyles } from './design-system.ts';
import type { BogenDoc, BogenNode } from './doc.ts';
import { FRAME_PRESETS } from './frame-presets.ts';
import { COUNTER_EXAMPLE_ATTR } from './html-import.ts';
import { readProject } from './project-kind.ts';
import { clampAt } from './web-design.ts';

/**
 * Craft checks that need only the document: the habits that make a design read as generated or unfinished, each
 * with a definition that can be tested. They are warnings to weigh, never proof of taste. `design_lint` reports
 * them as `craft` issues, `design_review` as observations, and `design_verify` holds the rubric scores against them.
 */

/** The rubric criterion a finding counts against. */
export type CraftCriterion = 'hierarchy' | 'type' | 'spacing' | 'colour' | 'content' | 'craft' | 'originality' | 'fit';
export type CraftRule =
  | 'font-families' | 'decorative-mono' | 'type-scale' | 'loud-type' | 'heavy-type' | 'all-caps' | 'eyebrow' | 'centred'
  | 'boxes' | 'nested-boxes' | 'glow' | 'tilt' | 'window-chrome' | 'pattern-background' | 'default-gradient' | 'gradient-text'
  | 'primary-actions' | 'text-on-image' | 'viewing-size';
export interface CraftFinding { rule: CraftRule; criterion: CraftCriterion; nodeId: string; layers: string[]; message: string; numbers?: Record<string, number> }

export const CRAFT_CRITERION: Record<CraftRule, CraftCriterion> = {
  'font-families': 'type', 'decorative-mono': 'type', 'type-scale': 'type', 'all-caps': 'type',
  'loud-type': 'hierarchy', 'heavy-type': 'hierarchy', 'primary-actions': 'hierarchy', centred: 'hierarchy',
  eyebrow: 'originality', glow: 'originality', tilt: 'originality', 'window-chrome': 'originality', 'pattern-background': 'originality', 'default-gradient': 'originality', 'gradient-text': 'originality',
  boxes: 'craft', 'nested-boxes': 'craft', 'text-on-image': 'craft', 'viewing-size': 'craft',
};

/** The numbers the rules use, in one place so that the guidance and the tests quote the same ones. */
export const CRAFT_LIMITS = {
  families: 2,
  /** Text at this share of the largest size or more is as loud as the loudest. */
  loudShare: 0.85, loudMinPx: 28, loudMax: 3,
  heavyWeight: 600, heavyShare: 0.66, heavyMinTexts: 8,
  /** A literal size this close to a step of the type scale, without being on it, cannot be told from it. */
  scaleNear: 0.08,
  capsMinLayers: 3, capsMaxChars: 30,
  eyebrowMaxPx: 14, eyebrowMaxChars: 40, eyebrowMin: 2,
  centredShare: 0.7, centredMinTexts: 6,
  boxesMin: 6, boxesShare: 0.5, nestedMin: 2,
  /** The hue range, in degrees, of the gradient that runs from blue through violet to pink. */
  gradientHues: [200, 340],
  glowBlurPx: 8, tiltMinDeg: 0.5, tiltMaxDeg: 30, dotMaxPx: 16, tileMaxPx: 64,
  /** The width a fixed format is really seen at, and the smallest text that still reads there. */
  socialViewPx: 390, slideViewPx: 960, minSeenPx: 9,
} as const;

/**
 * What a template marks a layer as with `data-brand-example`, from the layer up: `dont`, a deliberate wrong example,
 * which every check leaves out as brand_check does; `specimen`, a part shown to document it (each button variant, each
 * step of a type scale, a character set), which is held to every rule except those about composing one screen
 * (`SPECIMEN_EXEMPT`). Only templates can write the mark: html_write and layer_attrs drop it.
 */
export type ExampleKind = 'dont' | 'specimen';
export function exampleKindOf(doc: BogenDoc, id: string): ExampleKind | undefined {
  let specimen = false;
  for (const a of [id, ...doc.ancestors(id)]) {
    const v = doc.getNode(a)?.attrs?.[COUNTER_EXAMPLE_ATTR];
    if (v === 'dont') return 'dont';
    if (v === 'specimen') specimen = true;
  }
  return specimen ? 'specimen' : undefined;
}

/**
 * The rules about composing one screen: one primary action, grouping without a box around every group, one loud
 * message. A specimen sheet shows parts side by side on purpose, so these do not count what is inside a specimen.
 */
export const SPECIMEN_EXEMPT: readonly CraftRule[] = ['primary-actions', 'boxes', 'nested-boxes', 'loud-type'];

/**
 * Whether the file previews a system's own screens rather than pages: an Omarchy theme file, whose boards draw the
 * desktop, launcher, lock screen and phone shell as the system draws them. Read from what the file says it is
 * (`readProject`), never from a board's size or name.
 */
export function previewsSystem(doc: BogenDoc): boolean {
  return readProject(doc).type === 'omarchy-theme';
}

/**
 * The rules about a choice a system preview does not make. Its interface face is the system's: Omarchy sets its bar,
 * launcher and terminal in JetBrains Mono, so monospace there is the system, not decoration.
 */
export const SYSTEM_PREVIEW_EXEMPT: readonly CraftRule[] = ['decorative-mono'];

/** A text made only of private-use characters is an icon from an icon font (a Nerd Font glyph, a logo glyph), not type. */
export function isIconGlyph(text: string): boolean {
  return /\p{Co}/u.test(text) && /^[\p{Co}\s]+$/u.test(text);
}

/**
 * What an artboard says it is for: the discipline a template wrote on it, or `themes` for a board of a theme file.
 * `foundations`, the discipline of no particular medium, says nothing. Undefined when nothing says.
 */
export function declaredKind(doc: BogenDoc, board: BogenNode): string | undefined {
  const discipline = board.attrs?.['data-bogen-discipline'];
  if (discipline && discipline !== 'foundations') return discipline;
  return previewsSystem(doc) ? 'themes' : undefined;
}

const hsl = converter('hsl');
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'inherit', 'initial', 'unset', 'emoji', 'math']);
const MONO = /mono|courier|consolas|menlo|monaco|\bcode\b|iosevka|\bhack\b|inconsolata|terminal|typewriter/i;
const CODE_TAGS = new Set(['code', 'pre', 'kbd', 'samp', 'var', 'tt']);
/** Words that are code, a command or figures: where a monospace face does a job. */
const CODE_LIKE = /[{}()[\]=<>;$_\\/|`~#@]|--|^[\d\s.,:%+\-x×€£]+$|^(?:npm|npx|pnpm|yarn|bun|git|curl|brew|pip|cargo|docker|sudo|bogen) /u;
const HEADING = /^h[1-6]$/;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const quote = (text: string) => `"${text.replace(/\s+/g, ' ').trim().slice(0, 32)}"`;
const list = (items: string[], max = 3) => items.slice(0, max).join(', ') + (items.length > max ? ` and ${items.length - max} more` : '');

function splitTop(value: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(value.slice(start, i)); start = i + 1; }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Every colour written in a value: functions, hex and names. */
function coloursIn(value: string): { h: number; s: number; l: number; alpha: number }[] {
  const out: { h: number; s: number; l: number; alpha: number }[] = [];
  for (const m of value.matchAll(/(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^()]*\)|#[0-9a-f]{3,8}\b|\b[a-z]{3,20}\b/gi)) {
    const word = m[0];
    if (/^[a-z]+$/i.test(word) && /^(to|at|in|from|top|bottom|left|right|center|circle|ellipse|closest|farthest|side|corner|deg|px|inset|none|transparent|repeat|cover|contain|fixed|scroll|local|border|padding|content|box|text|url|var|linear|radial|conic|gradient|repeating)$/i.test(word)) continue;
    const c = parse(word);
    const v = c && hsl(c);
    if (v) out.push({ h: v.h ?? 0, s: v.s ?? 0, l: v.l ?? 0, alpha: c.alpha ?? 1 });
  }
  return out;
}
const chromatic = (c: { s: number; l: number; alpha: number }, minS = 0.35) => c.alpha > 0.15 && c.s >= minS && c.l > 0.15 && c.l < 0.9;

/** Lengths of a value in px, in order. A bare 0 counts. */
function lengths(value: string): number[] {
  return [...value.replace(/(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^()]*\)|#[0-9a-f]{3,8}\b/gi, ' ').matchAll(/(-?\d*\.?\d+)(px|rem|em)?(?![\w%.])/g)]
    .map((m) => Number(m[1]) * (m[2] === 'rem' || m[2] === 'em' ? 16 : 1));
}

/** What `craftFindings` reads for one artboard or layer. */
export function craftFindings(doc: BogenDoc, rootId: string, viewportWidth = 1440): CraftFinding[] {
  const root = doc.getNode(rootId);
  if (!root) throw new Error(`No layer with id ${rootId}.`);
  const L = CRAFT_LIMITS;
  const tokens = new Map(doc.getTokens().map((t) => [t.name, t.value]));
  const textStyles = new Map(getTextStyles(doc).map((s) => [s.key, s.style as Record<string, string>]));
  const resolve = (value: string, depth = 0): string => (depth > 5 || !value.includes('var(') ? value
    : resolve(value.replace(/var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_m, name: string, fallback?: string) => tokens.get(name) ?? fallback ?? ''), depth + 1));

  // Visible layers, top down. What sits under a hidden layer is not on the screen, and a counter-example is wrong on purpose.
  const layers: BogenNode[] = [];
  const parentOf = new Map<string, BogenNode>();
  const specimen = new Set<string>();
  const walk = (n: BogenNode, inSpecimen: boolean) => {
    if (n.hidden || n.style.display === 'none') return;
    const mark = n.attrs?.[COUNTER_EXAMPLE_ATTR];
    if (mark === 'dont') return;
    const shown = inSpecimen || mark === 'specimen';
    if (shown) specimen.add(n.id);
    layers.push(n);
    for (const c of doc.getChildren(n.id)) { parentOf.set(c.id, n); walk(c, shown); }
  };
  const rootKind = exampleKindOf(doc, root.id);
  if (rootKind === 'dont') return [];
  walk(root, rootKind === 'specimen');
  const visible = new Set(layers.map((n) => n.id));
  const composed = (n: BogenNode) => !specimen.has(n.id);
  const system = previewsSystem(doc);
  const ancestors = (n: BogenNode): BogenNode[] => {
    const out: BogenNode[] = [];
    for (let p = parentOf.get(n.id); p; p = parentOf.get(p.id)) out.push(p);
    return out;
  };
  const own = (n: BogenNode, prop: string): string | undefined => {
    const v = (n.style as Record<string, string | undefined>)[prop] ?? (n.textStyle ? textStyles.get(n.textStyle)?.[prop] : undefined);
    return v === undefined ? undefined : resolve(v).trim();
  };
  const inherited = (n: BogenNode, prop: string): string | undefined => {
    for (const layer of [n, ...ancestors(n)]) {
      const v = own(layer, prop);
      if (v && v !== 'inherit') return v;
    }
    // Above the root, so that a section checked on its own still knows the artboard's font.
    for (const id of doc.ancestors(root.id)) {
      const a = doc.getNode(id);
      const v = a && own(a, prop);
      if (v && v !== 'inherit') return v;
    }
    return undefined;
  };
  const sizeOf = (n: BogenNode): number | undefined => {
    const v = inherited(n, 'fontSize');
    if (!v) return HEADING.test(n.tag) ? undefined : 16;
    const m = /^(\d*\.?\d+)(px|rem)$/.exec(v);
    return m ? Number(m[1]) * (m[2] === 'px' ? 1 : 16) : clampAt(v, viewportWidth) ?? undefined;
  };
  const familyOf = (n: BogenNode): { name: string; mono: boolean } | undefined => {
    const stack = inherited(n, 'fontFamily');
    if (!stack) return undefined;
    const first = (splitTop(stack)[0] ?? '').replace(/^["']|["']$/g, '').trim();
    const key = first.toLowerCase();
    if (!key) return undefined;
    return { name: GENERIC.has(key) ? '' : first, mono: key === 'monospace' || key === 'ui-monospace' || (!GENERIC.has(key) && MONO.test(first)) };
  };
  const weightOf = (n: BogenNode): number => {
    const v = inherited(n, 'fontWeight');
    if (!v) return HEADING.test(n.tag) || n.tag === 'b' || n.tag === 'strong' ? 700 : 400;
    return v === 'bold' ? 700 : v === 'normal' ? 400 : Number(v) || 400;
  };
  const words = (n: BogenNode): string => (n.type === 'text' ? n.text ?? '' : doc.descendants(n.id).filter((d) => d.type === 'text').map((d) => d.text ?? '').join(' ')).replace(/\s+/g, ' ').trim();
  const background = (n: BogenNode): string => [own(n, 'background'), own(n, 'backgroundImage'), own(n, 'backgroundColor')].filter(Boolean).join(' ');

  const texts = layers.filter((n) => n.type === 'text' && n.text?.trim());
  const out: CraftFinding[] = [];
  const add = (rule: CraftRule, nodeId: string, layerIds: string[], message: string, numbers?: Record<string, number>) =>
    system && SYSTEM_PREVIEW_EXEMPT.includes(rule) ? undefined : out.push({ rule, criterion: CRAFT_CRITERION[rule], nodeId, layers: [...new Set(layerIds)].slice(0, 12), message, ...(numbers ? { numbers } : {}) });

  // ---- Type
  const byFamily = new Map<string, { name: string; ids: string[] }>();
  const monoDecor: BogenNode[] = [];
  for (const n of texts) {
    // An icon glyph is drawn, not set: its font is not a type family, and it is not monospace text.
    if (isIconGlyph(n.text!)) continue;
    const f = familyOf(n);
    if (!f) continue;
    if (f.name) {
      const entry = byFamily.get(f.name.toLowerCase()) ?? { name: f.name, ids: [] };
      entry.ids.push(n.id);
      byFamily.set(f.name.toLowerCase(), entry);
    }
    const code = CODE_TAGS.has(n.tag) || ancestors(n).some((a) => CODE_TAGS.has(a.tag));
    if (f.mono && !code && !CODE_LIKE.test(n.text!.trim())) monoDecor.push(n);
  }
  if (byFamily.size > L.families) {
    const used = [...byFamily.values()].sort((a, b) => b.ids.length - a.ids.length);
    const extra = used.slice(L.families);
    add('font-families', root.id, extra.flatMap((f) => f.ids),
      `${used.length} font families on one artboard (${used.map((f) => `${f.name} on ${f.ids.length}`).join(', ')}). ${L.families} are enough: one to read, at most one for display or code. Set the layers in ${list(extra.map((f) => f.name))} in one of the first two.`, { families: used.length });
  }
  if (monoDecor.length >= 2) {
    add('decorative-mono', monoDecor[0]!.id, monoDecor.map((n) => n.id),
      `${monoDecor.length} texts are set in a monospace face without being code, a command or figures (${list(monoDecor.map((n) => quote(n.text!)))}). Monospace as decoration is the most common generated look: set them in the reading face, and keep mono for code.`, { layers: monoDecor.length });
  }
  const scale = doc.getTokens().filter((t) => t.kind === 'font-size').flatMap((t) => {
    const v = resolve(t.value).trim();
    const m = /^(\d*\.?\d+)(px|rem)$/.exec(v);
    const px = m ? Number(m[1]) * (m[2] === 'px' ? 1 : 16) : clampAt(v, viewportWidth);
    return px ? [{ name: t.name, px }] : [];
  }).sort((a, b) => a.px - b.px);
  if (scale.length >= 3) {
    const off = new Map<number, string[]>();
    for (const n of texts) {
      const raw = (n.style as Record<string, string | undefined>).fontSize?.trim();
      const m = raw ? /^(\d*\.?\d+)(px|rem)$/.exec(raw) : null;
      if (!m) continue;
      const px = Number(m[1]) * (m[2] === 'px' ? 1 : 16);
      // On a step, or far enough from every step to be one of its own, is a choice. Next to a step is a slip.
      if (scale.some((t) => Math.abs(t.px - px) <= 0.5) || !scale.some((t) => Math.abs(t.px - px) / t.px <= L.scaleNear)) continue;
      off.set(px, [...(off.get(px) ?? []), n.id]);
    }
    if (off.size) {
      const sizes = [...off.entries()].sort((a, b) => b[1].length - a[1].length);
      const nearest = (px: number) => scale.reduce((a, b) => (Math.abs(b.px - px) < Math.abs(a.px - px) ? b : a));
      const count = sizes.reduce((sum, [, ids]) => sum + ids.length, 0);
      add('type-scale', sizes[0]![1][0]!, sizes.flatMap(([, ids]) => ids),
        `${count} text ${count === 1 ? 'layer uses a size' : 'layers use sizes'} next to a step of the file's type scale without being on it: ${list(sizes.map(([px, ids]) => `${round(px, 1)}px on ${ids.length}, beside var(--${nearest(px).name}) at ${round(nearest(px).px, 1)}px`), 4)}. Sizes this close cannot be told apart and read as slips: use the token.`, { layers: count, sizes: off.size });
    }
  }
  const caps = texts.filter((n) => {
    const text = n.text!.trim();
    const letters = text.replace(/[^\p{L}]/gu, '');
    if (letters.length < 4 || letters.toUpperCase() === letters.toLowerCase()) return false;
    if (inherited(n, 'textTransform') === 'uppercase') return true;
    return letters === letters.toUpperCase() && !(letters.length <= 5 && !/\s/.test(text));
  });
  const longCaps = caps.filter((n) => n.text!.trim().length > L.capsMaxChars);
  if (caps.length >= L.capsMinLayers || longCaps.length) {
    add('all-caps', (longCaps[0] ?? caps[0]!).id, caps.map((n) => n.id),
      `${caps.length} ${caps.length === 1 ? 'text is' : 'texts are'} set in capitals${longCaps.length ? `, ${longCaps.length} of them longer than ${L.capsMaxChars} characters` : ''} (${list(caps.map((n) => quote(n.text!)))}). Capitals read slowly and shout: use sentence case, and keep capitals for an acronym or one short label.`, { layers: caps.length, long: longCaps.length });
  }

  // ---- Hierarchy
  const sized = texts.map((n) => ({ n, size: sizeOf(n) })).filter((t): t is { n: BogenNode; size: number } => t.size !== undefined);
  // A scale specimen shows every step at its size: what is loud is counted on what is composed.
  const composedSized = sized.filter((t) => composed(t.n));
  const largest = Math.max(0, ...composedSized.map((t) => t.size));
  if (composedSized.length >= 5 && largest >= L.loudMinPx) {
    const loud = composedSized.filter((t) => t.size >= largest * L.loudShare);
    if (loud.length > L.loudMax) {
      add('loud-type', root.id, loud.map((t) => t.n.id),
        `${loud.length} texts are set at or near the largest size (${round(largest, 1)}px): ${list(loud.map((t) => quote(t.n.text!)))}. When everything is loud nothing leads. Keep that size for the one main message of a screen, at most ${L.loudMax} peaks on a long page, and step the others down by a quarter or more.`, { loud: loud.length, largest: round(largest, 1) });
    }
  }
  if (texts.length >= L.heavyMinTexts) {
    const total = texts.reduce((sum, n) => sum + n.text!.trim().length, 0);
    const heavy = texts.filter((n) => weightOf(n) >= L.heavyWeight);
    const share = heavy.reduce((sum, n) => sum + n.text!.trim().length, 0) / total;
    if (share > L.heavyShare) add('heavy-type', root.id, heavy.map((n) => n.id), `${Math.round(share * 100)}% of the words are set in weight ${L.heavyWeight} or heavier. Bold only works against regular: set running text in 400 and keep the heavy weight for headings and the one thing to notice.`, { share: round(share) });
  }
  const centred = texts.filter((n) => inherited(n, 'textAlign') === 'center');
  if (texts.length >= L.centredMinTexts && centred.length / texts.length > L.centredShare) {
    add('centred', root.id, centred.map((n) => n.id), `${centred.length} of ${texts.length} texts are centred. Centre one short statement at most; give the rest a common left edge, which is what makes a page look structured.`, { share: round(centred.length / texts.length) });
  }
  const sections = doc.getChildren(root.id).filter((c) => visible.has(c.id));
  const actionsOf = (scope: BogenNode) => [scope, ...doc.descendants(scope.id)].filter((n) => visible.has(n.id) && composed(n) && (n.tag === 'button' || n.tag === 'a')).flatMap((n) => {
    const fill = coloursIn(own(n, 'backgroundColor') ?? own(n, 'background') ?? '')[0];
    const label = words(n).toLowerCase();
    return fill && fill.alpha >= 0.5 && label ? [{ n, label, fill: `${Math.round(fill.h)}/${round(fill.s, 1)}/${round(fill.l, 1)}` }] : [];
  });
  for (const scope of sections.length >= 2 ? sections : [root]) {
    const byFill = new Map<string, { n: BogenNode; label: string }[]>();
    for (const a of actionsOf(scope)) byFill.set(a.fill, [...(byFill.get(a.fill) ?? []), a]);
    for (const group of byFill.values()) {
      const labels = [...new Set(group.map((a) => a.label))];
      if (labels.length < 2) continue;
      add('primary-actions', scope.id, group.map((a) => a.n.id),
        `${labels.length} different actions in "${scope.name}" share one filled style (${list(group.filter((a, i) => group.findIndex((b) => b.label === a.label) === i).map((a) => quote(words(a.n))), 4)}). A screen has one primary action: keep the fill for it, and make the others an outline or a text link.`, { actions: labels.length });
    }
  }

  // ---- The generated look
  const eyebrows = texts.filter((n) => HEADING.test(n.tag)).flatMap((h) => {
    const siblings = doc.getChildren(h.parent).filter((s) => visible.has(s.id));
    const prev = siblings[siblings.findIndex((s) => s.id === h.id) - 1];
    if (!prev || prev.type !== 'text' || HEADING.test(prev.tag) || !prev.text?.trim() || prev.text.trim().length > L.eyebrowMaxChars) return [];
    const size = sizeOf(prev) ?? 16;
    return size <= L.eyebrowMaxPx ? [prev] : [];
  });
  if (eyebrows.length >= L.eyebrowMin) {
    add('eyebrow', eyebrows[0]!.id, eyebrows.map((n) => n.id), `${eyebrows.length} headings have a small label above them (${list(eyebrows.map((n) => quote(n.text!)))}). The label over the heading is a template habit: delete it where the heading already says what the section is, and keep at most one that carries information.`, { labels: eyebrows.length });
  }
  const glow: BogenNode[] = [], tilted: { n: BogenNode; deg: number }[] = [], patterned: BogenNode[] = [], gradients: BogenNode[] = [], gradientText: BogenNode[] = [];
  for (const n of layers) {
    const shadows = [own(n, 'boxShadow'), own(n, 'textShadow'), ...[...(own(n, 'filter') ?? '').matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/g)].map((m) => m[1])].filter((v): v is string => !!v && v !== 'none').flatMap(splitTop);
    if (shadows.some((s) => (lengths(s)[2] ?? 0) >= L.glowBlurPx && coloursIn(s).some((c) => chromatic(c, 0.4)))) glow.push(n);

    // What carries words or a picture: a card, a screenshot, a label. A bare shape may be part of a drawing.
    if (n.type !== 'svg' && n !== root && (n.type !== 'frame' || doc.descendants(n.id).some((d) => d.type === 'text' || d.type === 'image' || d.type === 'video'))) {
      const turn = /rotate[Z]?\(\s*(-?\d*\.?\d+)(deg|turn|rad)\s*\)/.exec(own(n, 'transform') ?? '') ?? /^(-?\d*\.?\d+)(deg|turn|rad)$/.exec(own(n, 'rotate') ?? '');
      if (turn) {
        const deg = Math.abs(Number(turn[1]) * (turn[2] === 'turn' ? 360 : turn[2] === 'rad' ? 180 / Math.PI : 1)) % 360;
        const lean = Math.min(deg, 360 - deg);
        if (lean >= L.tiltMinDeg && lean <= L.tiltMaxDeg) tilted.push({ n, deg: round(lean, 1) });
      }
    }
    const bg = [own(n, 'background'), own(n, 'backgroundImage')].filter(Boolean).join(' ');
    if (/gradient\(/.test(bg)) {
      const tile = lengths(own(n, 'backgroundSize') ?? (/\/\s*([^,]+)/.exec(bg)?.[1] ?? ''));
      if (/repeating-radial-gradient\(/.test(bg) || (tile.length > 0 && tile.every((v) => v > 0 && v <= L.tileMaxPx))) patterned.push(n);
      else {
        // Two or more saturated stops, all between blue and pink, with a violet one and one that is not: not a single hue.
        const stops = [...bg.matchAll(/(?:linear|radial|conic)-gradient\(((?:[^()]|\([^()]*\))*)\)/g)].flatMap((m) => coloursIn(m[1]!)).filter((c) => chromatic(c));
        if (stops.length >= 2 && stops.every((c) => c.h >= L.gradientHues[0] && c.h <= L.gradientHues[1]) && stops.some((c) => c.h >= 255) && stops.some((c) => c.h < 255 || c.h > 285)) gradients.push(n);
      }
      if ((own(n, 'backgroundClip') ?? own(n, 'WebkitBackgroundClip') ?? own(n, 'webkitBackgroundClip')) === 'text') gradientText.push(n);
    }
  }
  if (glow.length) add('glow', glow[0]!.id, glow.map((n) => n.id), `${glow.length} ${glow.length === 1 ? 'layer has' : 'layers have'} a coloured glow (a shadow of ${L.glowBlurPx}px blur or more in a saturated colour: ${list(glow.map((n) => n.name))}). Glow stands in for art direction: remove it, and separate with a plain surface, a hairline or a neutral shadow.`, { layers: glow.length });
  if (tilted.length) add('tilt', tilted[0]!.n.id, tilted.map((t) => t.n.id), `${tilted.length} ${tilted.length === 1 ? 'layer is' : 'layers are'} tilted (${list(tilted.map((t) => `${t.n.name} by ${t.deg}deg`))}). Tilted cards and screenshots read as decoration: set them straight, unless the tilt is this brand's own idea.`, { layers: tilted.length });
  if (patterned.length) add('pattern-background', patterned[0]!.id, patterned.map((n) => n.id), `${patterned.length} ${patterned.length === 1 ? 'layer has' : 'layers have'} a dot or grid pattern as its background (${list(patterned.map((n) => n.name))}). It is filler texture: use a plain surface, or material that belongs to the subject.`, { layers: patterned.length });
  if (gradients.length) add('default-gradient', gradients[0]!.id, gradients.map((n) => n.id), `${gradients.length} ${gradients.length === 1 ? 'layer has' : 'layers have'} a blue-to-purple gradient (${list(gradients.map((n) => n.name))}), the default of generated pages. Use a solid colour from the palette; keep a gradient only when its colours are the brand's own.`, { layers: gradients.length });
  if (gradientText.length) add('gradient-text', gradientText[0]!.id, gradientText.map((n) => n.id), `${gradientText.length} ${gradientText.length === 1 ? 'text is' : 'texts are'} filled with a gradient (${list(gradientText.map((n) => quote(words(n))))}). Set the words in one solid colour that passes contrast.`, { layers: gradientText.length });
  for (const n of layers) {
    const dots = doc.getChildren(n.id).filter((c) => {
      if (c.type !== 'frame' || c.hidden || doc.getChildren(c.id).length) return false;
      const [w] = lengths(own(c, 'width') ?? ''), [h] = lengths(own(c, 'height') ?? '');
      const radius = own(c, 'borderRadius') ?? '';
      return w !== undefined && w === h && w > 0 && w <= L.dotMaxPx && (/%/.test(radius) ? Number.parseFloat(radius) >= 50 : (lengths(radius)[0] ?? 0) >= w / 2) && coloursIn(background(c)).length > 0;
    });
    if (dots.length === 3) add('window-chrome', n.id, dots.map((d) => d.id), `"${n.name}" has three small round dots in a row, the buttons of a drawn window. A drawn window frame around a mock-up is decoration: show the product's real screen at a size it can be read, with no frame around it.`);
  }

  // ---- Craft
  const boxed = (n: BogenNode) => {
    if (n === root || n.type !== 'frame' || ['button', 'a', 'input', 'select', 'textarea', 'table', 'td', 'th', 'tr'].includes(n.tag)) return false;
    const border = own(n, 'border') ?? '';
    const width = own(n, 'borderWidth') ?? '';
    const lined = (border && !/^(none|0(px)?)\b/.test(border) && !/\bnone\b/.test(border)) || (!!width && lengths(width).some((v) => v > 0) && own(n, 'borderStyle') !== 'none');
    const shadow = own(n, 'boxShadow');
    return lined || (!!shadow && shadow !== 'none');
  };
  const boxes = layers.filter((n) => composed(n) && boxed(n));
  // A group is a frame that holds words directly, or one that is drawn as a box.
  const groups = layers.filter((n) => n !== root && n.type === 'frame' && composed(n) && (boxes.includes(n) || doc.getChildren(n.id).some((c) => c.type === 'text')));
  const boxedGroups = boxes;
  if (boxedGroups.length >= L.boxesMin && boxedGroups.length / groups.length > L.boxesShare) {
    add('boxes', root.id, boxedGroups.map((n) => n.id), `${boxedGroups.length} of ${groups.length} groups sit in a bordered or shadowed box. When everything is a card nothing is grouped: take the box off most of them and let spacing and alignment do it, keeping a boundary only where it separates something a person has to tell apart.`, { boxes: boxedGroups.length, groups: groups.length });
  }
  const nested = boxes.filter((n) => ancestors(n).some((a) => boxes.includes(a)));
  if (nested.length >= L.nestedMin) add('nested-boxes', nested[0]!.id, nested.map((n) => n.id), `${nested.length} boxes sit inside another box (${list(nested.map((n) => n.name))}). Keep the outer boundary and separate the inner parts with space or a single hairline.`, { boxes: nested.length });

  const imageLike = (n: BogenNode) => n.type === 'image' || n.type === 'video' || n.type === 'shader';
  const out_of_flow = (n: BogenNode) => ['absolute', 'fixed'].includes(own(n, 'position') ?? '');
  const surface = (n: BogenNode) => !!own(n, 'backdropFilter') || coloursIn((own(n, 'backgroundColor') ?? '') + ' ' + (own(n, 'background') ?? '').replace(/url\([^)]*\)/g, '')).some((c) => c.alpha >= 0.4);
  const onImage = new Map<string, { holder: BogenNode; texts: BogenNode[] }>();
  for (const t of texts) {
    const chain = [t, ...ancestors(t)];
    for (let i = 1; i < chain.length; i++) {
      const holder = chain[i]!, branch = chain[i - 1]!;
      const bg = [own(holder, 'background'), own(holder, 'backgroundImage')].filter(Boolean).join(' ');
      const kids = doc.getChildren(holder.id).filter((c) => visible.has(c.id) && c.id !== branch.id);
      const behind = kids.filter((c) => imageLike(c) && (out_of_flow(c) || out_of_flow(branch)));
      if (!/url\(/.test(bg) && !behind.length) continue;
      const scrim = chain.slice(0, i).some(surface) || !!own(t, 'textShadow')?.replace('none', '')
        || /gradient\([^]*url\(/.test(bg) || kids.some((c) => !imageLike(c) && out_of_flow(c) && (surface(c) || /gradient\(/.test(background(c))));
      if (!scrim) {
        const entry = onImage.get(holder.id) ?? { holder, texts: [] };
        entry.texts.push(t);
        onImage.set(holder.id, entry);
      }
      break;
    }
  }
  for (const { holder, texts: over } of onImage.values()) {
    add('text-on-image', over[0]!.id, over.map((n) => n.id), `${over.length} ${over.length === 1 ? 'text sits' : 'texts sit'} directly on the image of "${holder.name}" with nothing between (${list(over.map((n) => quote(n.text!)))}). Contrast over a picture cannot be measured and changes across it: put a scrim between them (a layer or gradient of the background colour at 50% or more), or move the words onto a plain surface, then look at a screenshot.`, { texts: over.length });
  }

  const width = lengths(own(root, 'width') ?? '')[0], height = lengths(own(root, 'height') ?? '')[0];
  if (root.artboard && width) {
    const kind = declaredKind(doc, root);
    const format = (group: string) => FRAME_PRESETS.some((p) => p.group === group && p.w === width && p.h === height);
    // What the board or file says it is decides. The size is a guess only where nothing says: 1080 x 1920 is a story
    // and a portrait monitor, 1920 x 1080 a slide and a desktop, and 1280 x 720 a thumbnail and a laptop, so a slide
    // also needs its name to say so.
    const slide = kind === 'pitch-decks' || (!kind && format('Slides') && /slide|deck|folie/i.test(root.name));
    const social = kind === 'social' || (!kind && format('Social') && width !== 1280);
    const seenAt = social ? L.socialViewPx : slide ? L.slideViewPx : 0;
    if (seenAt && seenAt < width) {
      const need = Math.ceil((L.minSeenPx * width) / seenAt);
      const small = sized.filter((t) => t.size < need).sort((a, b) => a.size - b.size);
      if (small.length) {
        add('viewing-size', small[0]!.n.id, small.map((t) => t.n.id), `${small.length} ${small.length === 1 ? 'text is' : 'texts are'} under ${need}px on this ${width}px ${social ? 'social image' : 'slide'}. It is seen at about ${seenAt}px wide (${social ? 'a phone feed' : 'a shared screen or a laptop'}), where the smallest, ${round(small[0]!.size, 1)}px, shows at ${round((small[0]!.size * seenAt) / width, 1)}px. Set every text that has to be read at ${need}px or more, better a third larger, and cut words rather than shrink them.`, { texts: small.length, need, smallest: round(small[0]!.size, 1) });
      }
    }
  }
  return out;
}
