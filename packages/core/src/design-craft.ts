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
  | 'primary-actions' | 'text-on-image' | 'viewing-size'
  | 'caps-label' | 'grotesk-mono' | 'house-palette' | 'ruled-rows' | 'split-sections' | 'stat-row' | 'meta-dots' | 'no-visual' | 'no-picture' | 'one-hue';
/**
 * `hard`: an objective defect, text nobody can read where it is seen. It keeps the rubric from counting as scored until
 * it is fixed. `advisory`: a choice that often reads as default. It never blocks and never caps a score; it says why
 * it is often generic, and the agent keeps it when its direction has a reason (`kept` in design_verify).
 */
export type CraftSeverity = 'hard' | 'advisory';
export interface CraftFinding { rule: CraftRule; criterion: CraftCriterion; severity: CraftSeverity; nodeId: string; layers: string[]; message: string; why: string; numbers?: Record<string, number> }

export const CRAFT_CRITERION: Record<CraftRule, CraftCriterion> = {
  'font-families': 'type', 'decorative-mono': 'type', 'type-scale': 'type', 'all-caps': 'type',
  'loud-type': 'hierarchy', 'heavy-type': 'hierarchy', 'primary-actions': 'hierarchy', centred: 'hierarchy',
  eyebrow: 'originality', glow: 'originality', tilt: 'originality', 'window-chrome': 'originality', 'pattern-background': 'originality', 'default-gradient': 'originality', 'gradient-text': 'originality',
  boxes: 'craft', 'nested-boxes': 'craft', 'text-on-image': 'craft', 'viewing-size': 'craft',
  'caps-label': 'type', 'grotesk-mono': 'originality', 'house-palette': 'colour', 'ruled-rows': 'originality', 'split-sections': 'originality', 'stat-row': 'originality', 'meta-dots': 'content', 'no-visual': 'fit', 'no-picture': 'fit', 'one-hue': 'colour',
};

/** The objective defects among the craft checks: text that cannot be read where it is seen. Everything else is advisory. */
export const CRAFT_HARD: readonly CraftRule[] = ['text-on-image', 'viewing-size'];

/** Why an advisory finding often reads as default, in one line, so that the agent can weigh it against its direction. */
export const CRAFT_WHY: Record<CraftRule, string> = {
  'font-families': 'A third family rarely adds a voice; it usually blurs the two that are there.',
  'decorative-mono': 'Monospace on labels is the shorthand of generated product pages for "technical".',
  'grotesk-mono': 'One grotesk with monospace labels is the most common generated product-page pairing.',
  'type-scale': 'Sizes this close to a step read as slips rather than a second size.',
  'loud-type': 'When several texts are equally loud, none leads.',
  'heavy-type': 'Bold only reads as emphasis against regular text.',
  'all-caps': 'Capitals everywhere read as a template habit and slow reading.',
  'caps-label': 'A small tracked capital label over the heading is the eyebrow of generated pages.',
  eyebrow: 'A label that repeats its heading is template scaffolding.',
  centred: 'Centring everything removes the common edge that makes a page look structured.',
  'primary-actions': 'Two actions with the same fill leave the screen without one primary action.',
  boxes: 'A box around every group stops boxes from grouping anything.',
  'nested-boxes': 'Boxes inside boxes add edges without adding structure.',
  glow: 'Coloured glow is the default stand-in for art direction on dark pages.',
  tilt: 'Tilted cards and screenshots are a stock way to look dynamic.',
  'window-chrome': 'A drawn window frame is a stock way to say "product" without showing it.',
  'pattern-background': 'Dot and grid backgrounds are filler texture on generated pages.',
  'default-gradient': 'The blue-to-purple gradient is the default colour of generated pages.',
  'gradient-text': 'Gradient-filled headlines are a stock flourish that also costs contrast.',
  'house-palette': 'Cream with terracotta, and black with acid green, are the house palettes of generated pages.',
  'ruled-rows': 'Hairline-ruled rows in every section are the broadsheet default.',
  'split-sections': 'The same heading-left, paragraph-right split in every section is a template rhythm.',
  'stat-row': 'A strip of big figures over small labels is the stock way to look credible.',
  'meta-dots': 'Facts strung together with middle dots are template chrome.',
  'no-visual': 'A page of type and boxes alone often reads as a wireframe.',
  'no-picture': 'An ad without a picture rarely stops a scroll.',
  'one-hue': 'Neutrals and one accent is the default palette, not a decision.',
  'text-on-image': 'Contrast over a picture cannot be measured and changes across it.',
  'viewing-size': 'Text this small cannot be read at the size the piece is seen.',
};
export const craftSeverity = (rule: CraftRule): CraftSeverity => (CRAFT_HARD.includes(rule) ? 'hard' : 'advisory');

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
  /** A small capital label with added tracking: the eyebrow of generated pages. One is enough to be the look. */
  capsLabelMaxPx: 14, capsLabelTrackEm: 0.04,
  /** Monospace on this many texts outside code, most of them not code, next to a single grotesk. */
  groteskMonoMin: 3,
  /** Hairline rules that cut most sections into rows: the broadsheet default. */
  rulesMin: 12, ruledSectionsMin: 3, ruledShare: 0.5,
  /** Sections that all open with the same heading-left, paragraph-right split. */
  splitSectionsMin: 4, splitShare: 0.7,
  /** A row of big figures over small labels, and how much bigger a figure is than its label. */
  statMin: 3, statRatio: 1.75,
  /** Texts that join three or more facts with middle dots. */
  metaDotsMin: 3,
  /** A page of this many sections with no picture, drawing, video or shader this big. */
  pageSectionsMin: 4, visualMinPx: 160,
  /** A file of this many screens whose saturated colours all lie within this many degrees of hue. */
  oneHueBoards: 3, oneHueSpread: 30,
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
export const SYSTEM_PREVIEW_EXEMPT: readonly CraftRule[] = ['decorative-mono', 'grotesk-mono', 'no-visual', 'stat-row'];

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
/** Code and commands, without the figures: what a monospace face is for. */
const COMMAND_LIKE = /[{}()[\]=<>;$_\\/|`~#@]|--|\.\w{1,5}$|^(?:npm|npx|pnpm|yarn|bun|git|curl|brew|pip|cargo|docker|sudo|bogen) /u;
/** Grotesk and neo-grotesk faces, the usual partner of a monospace face on generated pages. */
const GROTESK = /grotesk|grotesque|\bsans\b|inter\b|helvetica|arial|geist|roboto|manrope|satoshi|s[oö]hne|suisse|figtree|outfit|sora\b|onest|neue|haas|aktiv|archivo|public sans|work sans|jakarta|instrument|switzer|general sans|sf pro|system-ui|-apple-system/i;
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
    system && SYSTEM_PREVIEW_EXEMPT.includes(rule) ? undefined : out.push({ rule, criterion: CRAFT_CRITERION[rule], severity: craftSeverity(rule), nodeId, layers: [...new Set(layerIds)].slice(0, 12), message, why: CRAFT_WHY[rule], ...(numbers ? { numbers } : {}) });

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
  // The pairing itself: one grotesk, and a monospace face on figures and labels rather than on code.
  const families = [...byFamily.values()];
  const monoFamily = families.find((f) => MONO.test(f.name));
  const readingFamily = families.find((f) => f !== monoFamily);
  const monoOutsideCode = texts.filter((n) => monoFamily?.ids.includes(n.id) && !CODE_TAGS.has(n.tag) && !ancestors(n).some((a) => CODE_TAGS.has(a.tag)));
  const codeShare = monoOutsideCode.filter((n) => COMMAND_LIKE.test(n.text!.trim())).length / Math.max(1, monoOutsideCode.length);
  const groteskMono = families.length === 2 && !!monoFamily && !!readingFamily && GROTESK.test(readingFamily.name) && monoOutsideCode.length >= L.groteskMonoMin && codeShare < 0.5;
  if (groteskMono) {
    add('grotesk-mono', monoOutsideCode[0]!.id, monoOutsideCode.map((n) => n.id),
      `The page pairs one grotesk (${readingFamily!.name}) with a monospace face (${monoFamily!.name}) on ${monoOutsideCode.length} labels and figures (${list(monoOutsideCode.map((n) => quote(n.text!)))}): the default look of generated product pages. Choose type for this subject instead: set figures in the reading face with tabular numbers (font-variant-numeric: tabular-nums), and keep monospace for code and commands, or pick a display face with a reason from the subject.`, { layers: monoOutsideCode.length });
  }
  if (monoDecor.length >= 2 && !groteskMono) {
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
  const capitals = (n: BogenNode) => {
    const text = n.text!.trim();
    const letters = text.replace(/[^\p{L}]/gu, '');
    if (letters.length < 4 || letters.toUpperCase() === letters.toLowerCase()) return false;
    if (inherited(n, 'textTransform') === 'uppercase') return true;
    return letters === letters.toUpperCase() && !(letters.length <= 5 && !/\s/.test(text));
  };
  // The small tracked capital label is its own finding, so that one layer is not reported as capitals and as an eyebrow too.
  const trackingEm = (n: BogenNode): number => {
    const v = inherited(n, 'letterSpacing');
    if (!v || v === 'normal') return 0;
    const m = /^(-?\d*\.?\d+)(em|px|rem)?$/.exec(v);
    if (!m) return 0;
    const value = Number(m[1]);
    return m[2] === 'em' ? value : (m[2] === 'rem' ? value * 16 : value) / (sizeOf(n) ?? 16);
  };
  const capsLabels = texts.filter((n) => composed(n) && capitals(n) && (sizeOf(n) ?? 16) <= L.capsLabelMaxPx && trackingEm(n) >= L.capsLabelTrackEm && n.text!.trim().length <= L.eyebrowMaxChars);
  if (capsLabels.length) {
    add('caps-label', capsLabels[0]!.id, capsLabels.map((n) => n.id),
      `${capsLabels.length} small ${capsLabels.length === 1 ? 'label is' : 'labels are'} set in letter-spaced capitals (${list(capsLabels.map((n) => quote(n.text!)))}), the eyebrow of generated pages. Delete the label where the heading already says it; otherwise set it in sentence case at body size without tracking, or make it real information such as a date or a status.`, { layers: capsLabels.length });
  }
  const labelled = new Set(capsLabels.map((n) => n.id));
  const caps = texts.filter((n) => !labelled.has(n.id) && capitals(n));
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
    if (!prev || prev.type !== 'text' || labelled.has(prev.id) || HEADING.test(prev.tag) || !prev.text?.trim() || prev.text.trim().length > L.eyebrowMaxChars) return [];
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
  // The house palettes: warm off-white with a red-orange action, near-black with an acid green one. A colour a brand set
  // (a token the brand wrote into the file) is the brand's choice, not a default.
  const brandSet = new Set<string>(((doc.meta.get('brandTokens') as unknown) as string[] | undefined) ?? []);
  const fromBrand = (n: BogenNode, prop: string) => [...((n.style as Record<string, string | undefined>)[prop] ?? '').matchAll(/var\(\s*--([\w-]+)/g)].some((m) => brandSet.has(m[1]!));
  const groundOf = (n: BogenNode) => ['backgroundColor', 'background'].map((p) => ({ p, c: coloursIn((own(n, p) ?? '').replace(/url\([^)]*\)/g, ''))[0] })).find((x) => x.c && x.c.alpha >= 0.9);
  const grounds = [root, ...doc.getChildren(root.id).filter((c) => visible.has(c.id))].map((n) => ({ n, g: groundOf(n) })).filter((x) => x.g);
  const ground = grounds[0];
  const fills = actionsOf(root);
  if (ground && !fromBrand(ground.n, ground.g!.p)) {
    const g = ground.g!.c!;
    const cream = g.l >= 0.88 && g.s >= 0.08 && g.h >= 25 && g.h <= 60;
    const night = g.l <= 0.12;
    const loud = fills.filter(({ n }) => {
      if (fromBrand(n, 'backgroundColor') || fromBrand(n, 'background')) return false;
      const c = coloursIn(own(n, 'backgroundColor') ?? own(n, 'background') ?? '')[0]!;
      return cream ? c.h <= 32 && c.s >= 0.45 && c.l >= 0.3 && c.l <= 0.7 : night ? c.h >= 65 && c.h <= 160 && c.s >= 0.6 && c.l >= 0.45 : false;
    });
    if (loud.length) add('house-palette', loud[0]!.n.id, [ground.n.id, ...loud.map((a) => a.n.id)],
      `The ground is ${cream ? 'warm off-white' : 'near-black'} (${own(ground.n, ground.g!.p)}) and the action is ${cream ? 'red-orange' : 'acid green'} (${quote(loud[0]!.label)}): the ${cream ? 'cream-and-terracotta' : 'black-and-acid'} house palette of generated pages. Take the palette from this subject instead: name four to six colours after its materials and places, and keep the accent for what needs action. Keep this pairing only when the brand sets it.`, { actions: loud.length });
  }
  // A whole file of screens in neutrals and one hue: the one-accent default, said once, on the file's first screen.
  // A brand's palette, a system preview and a file whose pictures bring their own colour decide otherwise.
  if (root.artboard && !system && !brandSet.size) {
    const boards = doc.getPages().flatMap((p) => doc.getChildren(p.id).filter((b) => b.artboard && !b.hidden));
    if (boards.length >= L.oneHueBoards && boards[0]!.id === root.id) {
      const all = boards.flatMap((b) => [b, ...doc.descendants(b.id)]).filter((n) => !n.hidden);
      if (!all.some((n) => n.type === 'image' || n.type === 'video' || n.type === 'shader' || /url\(/.test(background(n)))) {
        const hues = all.flatMap((n) => ['color', 'backgroundColor', 'background', 'borderColor', 'border', 'fill', 'stroke'].flatMap((p) => coloursIn((own(n, p) ?? '').replace(/url\([^)]*\)/g, '')))).filter((c) => chromatic(c, 0.3)).map((c) => c.h);
        const spread = (h: number[]) => h.length < 2 ? 0 : Math.max(...h.flatMap((a) => h.map((b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)))));
        if (spread(hues) <= L.oneHueSpread) add('one-hue', root.id, boards.map((b) => b.id),
          `All ${boards.length} screens of this file are neutrals${hues.length ? ` and one hue (around ${Math.round(hues[0]!)} degrees)` : ' only'}. One colour on grey is the default, not a decision: give the palette roles from the subject (a ground, an ink, two or three supporting colours with jobs, an action colour), tint the neutrals, and name the contrast that carries it; palette_suggest gives palettes with their contrast. Keep it this restrained only when the brief or the brand asks for it.`, { screens: boards.length, hues: hues.length ? 1 : 0 });
      }
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

  // ---- Composition: the page formulas that make every subject look alike.
  const kind = declaredKind(doc, root);
  // The sections of a page, below a wrapper such as <main> when everything sits in one.
  let body: BogenNode = root;
  for (let kids = doc.getChildren(body.id).filter((c) => visible.has(c.id) && c.type === 'frame'); kids.length === 1; kids = doc.getChildren(body.id).filter((c) => visible.has(c.id) && c.type === 'frame')) body = kids[0]!;
  const chrome = (n: BogenNode) => ['header', 'nav', 'footer'].includes(n.tag) || /^(header|footer|nav(igation)?|top ?bar|menu)\b/i.test(n.name);
  const pageSections = doc.getChildren(body.id).filter((c) => visible.has(c.id) && composed(c) && c.type === 'frame' && !chrome(c));
  const inside = (n: BogenNode) => [n, ...doc.descendants(n.id)].filter((d) => visible.has(d.id));
  const hairline = (v: string | undefined) => !!v && /solid|dashed|dotted/.test(v) && (lengths(v)[0] ?? 0) > 0 && (lengths(v)[0] ?? 0) <= 1.5;
  const ruleOf = (n: BogenNode) => composed(n) && !boxed(n) && (hairline(own(n, 'borderTop')) || hairline(own(n, 'borderBottom')) || hairline(own(n, 'borderBlockStart')) || hairline(own(n, 'borderBlockEnd')));
  const rulesBySection = pageSections.map((s) => inside(s).filter(ruleOf));
  const ruledSections = rulesBySection.filter((r) => r.length >= 2).length;
  const ruleCount = rulesBySection.reduce((sum, r) => sum + r.length, 0);
  if (kind !== 'dashboards' && ruleCount >= L.rulesMin && ruledSections >= L.ruledSectionsMin && ruledSections / pageSections.length > L.ruledShare) {
    add('ruled-rows', rulesBySection.find((r) => r.length >= 2)![0]!.id, rulesBySection.flat().map((n) => n.id),
      `${ruleCount} hairline rules cut ${ruledSections} of ${pageSections.length} sections into ruled rows, the broadsheet default of generated pages. Keep rules where a real table needs them; give the other sections the form their content has: a drawn diagram or curve, a product view at full size, a sequence as a timeline, a quote set large.`, { rules: ruleCount, sections: ruledSections });
  }
  const isRow = (n: BogenNode) => {
    const display = own(n, 'display');
    if (display === 'grid' || display === 'inline-grid') return splitTop((own(n, 'gridTemplateColumns') ?? '').replace(/\s+(?![^(]*\))/g, ',')).length === 2;
    return (display === 'flex' || display === 'inline-flex') && !/column/.test(own(n, 'flexDirection') ?? '');
  };
  const hasHeading = (n: BogenNode) => inside(n).some((d) => d.type === 'text' && /^h[12]$/.test(d.tag));
  const opensWithSplit = (section: BogenNode) => {
    for (const n of [section, ...doc.getChildren(section.id)].filter((d) => visible.has(d.id) && d.type === 'frame')) {
      const kids = doc.getChildren(n.id).filter((c) => visible.has(c.id));
      if (kids.length !== 2 || !isRow(n)) continue;
      const [a, b] = kids as [BogenNode, BogenNode];
      return (a.type === 'text' ? /^h[12]$/.test(a.tag) : hasHeading(a)) && !hasHeading(b) && inside(b).some((d) => d.type === 'text' && d.tag === 'p') && !inside(b).some(imageLike);
    }
    return false;
  };
  const splits = pageSections.filter(opensWithSplit);
  if (pageSections.length >= L.splitSectionsMin && splits.length >= L.splitSectionsMin && splits.length / pageSections.length >= L.splitShare) {
    add('split-sections', splits[0]!.id, splits.map((n) => n.id),
      `${splits.length} of ${pageSections.length} sections open with the same split, a heading on the left and a paragraph on the right (${list(splits.map((n) => quote(n.name)))}). One formula repeated down the page reads as a template: give each section the layout its content needs, and keep the split for one or two.`, { sections: splits.length, of: pageSections.length });
  }
  const FIGURE = /^[^\p{L}]*\d[^\p{L}]*\p{L}{0,3}$/u;
  const page = kind === 'websites' || (!kind && texts.some((n) => n.tag === 'h1'));
  // Step numbers (1, 2, 3) and times of a timeline count something in order: they are a sequence, not a stat strip.
  const sequence = (values: string[]) => values.every((v) => /:/.test(v)) || values.every((v, i) => /^0?\d+\.?$/.test(v) && Number.parseInt(v, 10) === Number.parseInt(values[0]!, 10) + i);
  const statRows = !page ? [] : layers.filter((n) => n.type === 'frame' && composed(n)).filter((row) => {
    const kids = doc.getChildren(row.id).filter((c) => visible.has(c.id) && c.type === 'frame');
    if (kids.length < L.statMin) return false;
    const figures: string[] = [];
    const stats = kids.filter((k) => {
      const t = inside(k).filter((d) => d.type === 'text' && d.text?.trim());
      const figure = t.find((d) => FIGURE.test(d.text!.trim()) && d.text!.trim().length <= 10);
      const label = t.find((d) => d !== figure && /\p{L}{3}/u.test(d.text!));
      if (figure) figures.push(figure.text!.trim());
      return !!figure && !!label && t.length <= 3 && (sizeOf(figure) ?? 16) >= (sizeOf(label) ?? 16) * L.statRatio;
    });
    return stats.length >= L.statMin && stats.length === kids.length && !sequence(figures);
  });
  if (statRows.length) {
    const figures = statRows.flatMap((r) => doc.getChildren(r.id)).flatMap((k) => inside(k).filter((d) => d.type === 'text' && FIGURE.test(d.text?.trim() ?? '')));
    add('stat-row', statRows[0]!.id, statRows.map((n) => n.id),
      `${statRows.length === 1 ? 'A row' : `${statRows.length} rows`} of big figures over small labels (${list(figures.map((n) => quote(n.text!)))}), the stat strip of generated pages. Put each figure where it explains something: in the sentence, chart or table it belongs to, with its unit and its source, or make one of them the point of its section.`, { rows: statRows.length });
  }
  const dotted = texts.filter((n) => composed(n) && (n.text!.match(/\s[·•]\s/g)?.length ?? 0) >= 2);
  if (dotted.length >= L.metaDotsMin) {
    add('meta-dots', dotted[0]!.id, dotted.map((n) => n.id),
      `${dotted.length} texts string facts together with middle dots (${list(dotted.map((n) => quote(n.text!)))}). A run of facts joined by dots is template chrome: give each fact its own place, label or column, or write the one that matters as words.`, { texts: dotted.length });
  }
  // A picture, a drawing, or a drawn product view: a surface of its own, sized, with the product's parts inside.
  const pictured = layers.some((n) => {
    if (imageLike(n) || /url\(/.test(background(n))) return true;
    const size = Math.max(...['width', 'height', 'minHeight'].map((k) => lengths(own(n, k) ?? '')[0] ?? 0));
    if (n.type === 'svg') return /%/.test(own(n, 'width') ?? '') || size >= L.visualMinPx;
    return n.type === 'frame' && n !== root && size >= L.visualMinPx && !!background(n) && inside(n).filter((d) => d.type === 'text').length >= 3;
  });
  const boardWidth = lengths(own(root, 'width') ?? '')[0] ?? 0;
  if (root.artboard && page && boardWidth >= 1024 && pageSections.length >= L.pageSectionsMin && !pictured) {
    add('no-visual', root.id, pageSections.map((n) => n.id),
      `${pageSections.length} sections and not one picture, drawing, product view, video or shader ${L.visualMinPx}px or larger: the page is type and boxes only. Show the product or its world: the real screen or output at a readable size, an inline SVG drawing of the object or mechanism, a chart of real data, or an image from your own image tool (asset_upload).`, { sections: pageSections.length });
  }

  const width = lengths(own(root, 'width') ?? '')[0], height = lengths(own(root, 'height') ?? '')[0];
  if (root.artboard && width) {
    const format = (group: string) => FRAME_PRESETS.some((p) => p.group === group && p.w === width && p.h === height);
    // What the board or file says it is decides. The size is a guess only where nothing says: 1080 x 1920 is a story
    // and a portrait monitor, 1920 x 1080 a slide and a desktop, and 1280 x 720 a thumbnail and a laptop, so a slide
    // also needs its name to say so.
    const slide = kind === 'pitch-decks' || (!kind && format('Slides') && /slide|deck|folie/i.test(root.name));
    const social = kind === 'social' || (!kind && format('Social') && width !== 1280);
    // An ad or social image an agent drew (nothing declares it; a template's share card declares itself and is
    // typographic by design) needs one picture: a photograph, video, shader or drawing across a good part of the frame.
    if (!kind && social && !system) {
      const big = (n: BogenNode) => ['width', 'height'].some((k) => {
        const v = own(n, k) ?? '';
        return /%/.test(v) ? Number.parseFloat(v) >= 40 : (lengths(v)[0] ?? 0) >= width * 0.4;
      });
      const picture = layers.some((n) => n !== root && ((imageLike(n) && (big(n) || own(n, 'position') === 'absolute')) || /url\(/.test(background(n)) || (n.type === 'svg' && big(n))));
      if (!picture && !/url\(/.test(background(root))) add('no-picture', root.id, [root.id],
        `This ${width} x ${height} ad or social image has no picture: no photograph, video, shader or drawing across ${Math.round(0.4 * 100)}% of the frame, so it is type and interface parts only. Find one real scene or object that is a metaphor for what the product does, make it with your own image tool (or an inline SVG drawing) and asset_upload it, let it fill the frame with one colour treatment (image_filter), set two to six words in its calm area, and put the brand inside the scene. Read design_knowledge action skill discipline social.`);
    }
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
