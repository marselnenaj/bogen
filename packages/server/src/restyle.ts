import { bindingFields, brandLinkOf, colorAlpha, confirmed, contrastRatio, familyStack, luminance, normalizeColor, type BrandColor, type BrandData, type BrandFamily, type NewNode } from '@bogen/core';
import { capturePage } from './capture.ts';
import { checkRendered, resolveVars } from './brand-check.ts';
import { replaceValue, type Replacement } from './brand-store.ts';
import type { BogenServer } from './http/server.ts';
import { agentOrigin } from './sync.ts';

/**
 * "Like this site, but in our brand": a live page captured, then redrawn in a brand. Its colours go onto the brand's
 * palette by lightness and by what they do, its fonts onto the brand's families, its sizes and spacing onto the
 * brand's scales, through the same replacement that brand_apply uses for literal values. Text and images become
 * placeholders unless the person keeps them, since the page's content is not theirs to reuse.
 */
export const RESTYLE_NOTICE = 'This is for structure and inspiration. The layout comes from another site, and you need the right to use any of its content you keep, such as text, images or logos.';

export interface RestyleOptions {
  url: string;
  brandId?: string;
  fileId?: string;
  pageId?: string;
  width?: number;
  height?: number;
  colorScheme?: 'light' | 'dark';
  keepText?: boolean;
  keepImages?: boolean;
  name?: string;
  allowLocal: boolean;
  /** Who does it: an agent's name, or `restyle` for the person in the editor. Its undo takes it back. */
  actor: string;
}

export interface ColorMove { from: string; to: string; name: string; role: 'text' | 'surface' | 'border' | 'accent' | 'other'; uses: number }

export interface RestyleReport {
  colors: ColorMove[];
  fonts: { from: string; to: string }[];
  font_sizes: number;
  weights: number;
  spacing: number;
  radius: number;
  shadows_removed: number;
  gradients_removed: number;
  texts_replaced: number;
  images_replaced: number;
  /** Texts given another palette colour, because the one they were mapped to did not stand out from what is behind. */
  contrast_fixed: number;
  notes: string[];
}

const NEUTRAL_CHROMA = 0.15;
const TEXT_PROPS = new Set(['color', 'WebkitTextFillColor', 'WebkitTextStrokeColor', 'textDecorationColor', 'caretColor']);
const SURFACE_PROPS = new Set(['backgroundColor', 'background', 'backgroundImage']);
const COLOR_PROP = /^(color|background|backgroundColor|backgroundImage|border|border\w*Color|border(Top|Right|Bottom|Left)|outline|outlineColor|boxShadow|textShadow|textDecorationColor|WebkitTextFillColor|WebkitTextStrokeColor|caretColor|fill|stroke|columnRuleColor)$/;
const SPACING_PROPS = ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap', 'rowGap', 'columnGap', 'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft'];
const RADIUS_PROPS = ['borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'];
const MEDIA_PROPS = ['backgroundImage', 'maskImage', 'WebkitMaskImage', 'listStyleImage', 'borderImageSource'] as const;
const MONO = /mono|code|consol|courier|menlo/i;
const HEADING = /^h[1-6]$/;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^()]*\)/g;
const FILLER = ['Placeholder', 'text', 'for', 'the', 'structure', 'only', 'replace', 'it', 'with', 'your', 'own', 'words'];

function chroma(hex: string): number {
  const n = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  return Math.max(...n) - Math.min(...n);
}

/** Lightness that follows the eye more than WCAG luminance does. */
const light = (hex: string) => Math.cbrt(luminance(hex));

function walk(node: NewNode, fn: (n: NewNode, parent: NewNode | null) => void, parent: NewNode | null = null): void {
  fn(node, parent);
  for (const c of node.children ?? []) walk(c, fn, node);
}

const firstFamily = (value: string) => (value.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');

function colorRole(prop: string): ColorMove['role'] {
  if (TEXT_PROPS.has(prop)) return 'text';
  if (SURFACE_PROPS.has(prop)) return 'surface';
  if (/^border|^outline|^columnRule/.test(prop)) return 'border';
  return 'other';
}

const ROLE_WORDS: Record<string, RegExp> = {
  text: /text|ink|fg|foreground|body|copy/i,
  surface: /background|surface|paper|bg|canvas|base|page/i,
  border: /border|line|rule|divider|stroke|outline/i,
  accent: /primary|accent|brand|action|cta|highlight|link/i,
};

/** Which palette colour each colour of the page becomes. Lightness keeps light things light and dark things dark. */
export function planColors(uses: Map<string, Record<ColorMove['role'], number>>, palette: BrandColor[]): Map<string, BrandColor> {
  const out = new Map<string, BrandColor>();
  if (!palette.length) return out;
  const neutrals = palette.filter((c) => chroma(c.value) < NEUTRAL_CHROMA);
  const accents = palette.filter((c) => chroma(c.value) >= NEUTRAL_CHROMA).sort((a, b) => Number(ROLE_WORDS.accent!.test(b.role)) - Number(ROLE_WORDS.accent!.test(a.role)));
  const total = (u: Record<string, number>) => Object.values(u).reduce((a, b) => a + b, 0);
  const main = (u: Record<ColorMove['role'], number>) => (Object.entries(u).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other') as ColorMove['role'];
  const source = [...uses.entries()];
  const sourceNeutral = source.filter(([hex]) => chroma(hex) < NEUTRAL_CHROMA || !accents.length);
  const sourceAccent = source.filter(([hex]) => chroma(hex) >= NEUTRAL_CHROMA && accents.length).sort((a, b) => total(b[1]) - total(a[1]));

  const greys = neutrals.length ? neutrals : palette;
  // Shadows and drawings do not set the range: a black shadow would make the darkest text look grey.
  const ranged = sourceNeutral.filter(([, u]) => u.text + u.surface + u.border > 0);
  const range = (ranged.length ? ranged : sourceNeutral).map(([h]) => light(h));
  const lo = Math.min(...range);
  const hi = Math.max(...range);
  const blo = Math.min(...greys.map((c) => light(c.value)));
  const bhi = Math.max(...greys.map((c) => light(c.value)));
  for (const [hex, u] of sourceNeutral) {
    // The page's range of greys laid onto the brand's, so that its darkest is the brand's darkest.
    const t = hi - lo > 0.05 ? Math.max(0, Math.min(1, (light(hex) - lo) / (hi - lo))) : light(hex) > 0.5 ? 1 : 0;
    const target = blo + t * (bhi - blo);
    const role = main(u);
    const words = ROLE_WORDS[role];
    let best = greys[0]!;
    let bestScore = Infinity;
    for (const c of greys) {
      const score = Math.abs(light(c.value) - target) + (words && !words.test(c.role) ? 0.06 : 0);
      if (score < bestScore) {
        best = c;
        bestScore = score;
      }
    }
    out.set(hex, best);
  }
  // The page's most used accent becomes the brand's main one, the next the next.
  sourceAccent.forEach(([hex], i) => out.set(hex, accents[i % accents.length]!));
  return out;
}

function nearestStep(n: number, steps: number[]): number {
  let best = steps[0]!;
  for (const s of steps) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  return best;
}

function placeholderText(text: string): string {
  if (!/[\p{L}\p{N}]/u.test(text)) return text;
  const want = Math.max(4, text.trim().length);
  const words: string[] = [];
  for (let i = 0; words.join(' ').length < want - 3; i++) words.push(FILLER[i % FILLER.length]!);
  if (!words.length) words.push(FILLER[0]!);
  const out = words.join(' ').toLowerCase();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** The brand's families for headings, body text and code. */
function familiesOf(data: BrandData): { body?: BrandFamily; heading?: BrandFamily; mono?: BrandFamily } {
  const list = confirmed(data.families).length ? confirmed(data.families) : data.families;
  const mono = list.find((f) => MONO.test(f.role) || MONO.test(f.family));
  const heading = list.find((f) => /display|heading|head|title/i.test(f.role));
  const body = list.find((f) => f !== mono && /body|text|copy|base|ui|sans|serif/i.test(f.role)) ?? list.find((f) => f !== mono && f !== heading) ?? heading;
  return { body, heading: heading ?? body, mono: mono ?? body };
}

/**
 * Redraws a captured tree in a brand, in place. `tokens` are the file's, so that values refer to the brand's tokens
 * when the file has them.
 */
export function restyleTree(root: NewNode, data: BrandData, tokens: Map<string, string>, options: { keepText: boolean; keepImages: boolean }): RestyleReport {
  const report: RestyleReport = { colors: [], fonts: [], font_sizes: 0, weights: 0, spacing: 0, radius: 0, shadows_removed: 0, gradients_removed: 0, texts_replaced: 0, images_replaced: 0, contrast_fixed: 0, notes: [] };
  const palette = confirmed(data.colors).length ? confirmed(data.colors) : data.colors;
  const ref = (token: string, value: string) => (tokens.has(token) ? `var(--${token})` : value);

  // What each colour of the page does, and how often.
  const uses = new Map<string, Record<ColorMove['role'], number>>();
  const count = (hex: string, role: ColorMove['role'], n = 1) => {
    const key = hex.slice(0, 7);
    const u = uses.get(key) ?? { text: 0, surface: 0, border: 0, accent: 0, other: 0 };
    u[role] += n;
    uses.set(key, u);
  };
  walk(root, (n) => {
    for (const [prop, value] of Object.entries(n.style ?? {})) {
      if (!COLOR_PROP.test(prop) || value.includes('var(')) continue;
      for (const m of value.matchAll(COLOR_LITERAL)) {
        const hex = normalizeColor(m[0]);
        if (hex && !(hex.length === 9 && hex.endsWith('00'))) count(hex, colorRole(prop), n === root && prop === 'backgroundColor' ? 5 : 1);
      }
    }
    if (n.svg) for (const m of n.svg.matchAll(COLOR_LITERAL)) {
      const hex = normalizeColor(m[0]);
      if (hex) count(hex, 'other');
    }
  });
  const plan = planColors(uses, palette);
  if (!palette.length) report.notes.push('The brand has no colours, so colours stay as they were.');
  const replace = new Map<string, Replacement>();
  for (const [hex, c] of plan) {
    replace.set(`color:${hex}`, { kind: 'color', to: ref(c.token, c.value) });
    const u = uses.get(hex)!;
    const role = chroma(hex) >= NEUTRAL_CHROMA && chroma(c.value) >= NEUTRAL_CHROMA ? 'accent' : (Object.entries(u).sort((a, b) => b[1] - a[1])[0]![0] as ColorMove['role']);
    report.colors.push({ from: hex, to: c.value, name: c.name, role, uses: Object.values(u).reduce((a, b) => a + b, 0) });
  }
  report.colors.sort((a, b) => b.uses - a.uses);

  // Fonts: what headings use becomes the brand's heading family, code its mono, the rest its body family.
  const fam = familiesOf(data);
  if (!fam.body) report.notes.push('The brand has no font families, so fonts stay as they were.');
  const contexts = new Map<string, Set<'heading' | 'mono' | 'body'>>();
  walk(root, (n) => {
    const value = n.style?.fontFamily;
    if (!value || value.includes('var(')) return;
    const first = firstFamily(value);
    const set = contexts.get(first.toLowerCase()) ?? new Set();
    set.add(MONO.test(value) || /^(code|pre|kbd|samp)$/.test(n.tag ?? '') ? 'mono' : HEADING.test(n.tag ?? '') ? 'heading' : 'body');
    contexts.set(first.toLowerCase(), set);
  });
  const familyRef = (f: BrandFamily) => ref(f.token, familyStack(f));
  for (const [first, set] of contexts) {
    const target = set.has('mono') && set.size === 1 ? fam.mono : set.has('heading') && set.size === 1 ? fam.heading : fam.body;
    if (!target) continue;
    replace.set(`font:${first}`, { kind: 'font', to: familyRef(target) });
    report.fonts.push({ from: first, to: target.family });
  }

  const scale = confirmed(data.typeScale).length ? confirmed(data.typeScale) : data.typeScale;
  const weights = [...new Set([...scale.map((t) => t.weight), ...(fam.body?.weights ?? []), ...(fam.heading?.weights ?? [])].filter(Boolean))];
  const spacing = (confirmed(data.spacing).length ? confirmed(data.spacing) : data.spacing).filter((s) => s.value > 0);
  const spacingSteps = spacing.map((s) => s.value);
  const radius = confirmed(data.radius).length ? confirmed(data.radius) : data.radius;
  const maxSpace = spacingSteps.length ? Math.max(...spacingSteps) : 0;
  const lengthRef = (n: number, list: { value: number; token: string }[]) => {
    const step = list.find((s) => s.value === Math.abs(n));
    const v = step ? ref(step.token, `${step.value}px`) : `${Math.abs(n)}px`;
    return n < 0 ? (v.startsWith('var(') ? `calc(${v} * -1)` : `-${v}`) : v;
  };
  const snapLengths = (value: string, steps: number[], list: { value: number; token: string }[]) => value.replace(/(-?\d*\.?\d+)px/g, (m, num: string) => {
    const n = Number.parseFloat(num);
    if (!n) return m;
    return lengthRef(Math.sign(n) * nearestStep(Math.abs(n), steps), list);
  });

  walk(root, (n) => {
    const style = n.style ?? {};
    const patch: Record<string, string | null> = {};
    for (const [prop, value] of Object.entries(style)) {
      const replaced = replaceValue(prop, value, replace, tokens);
      if (replaced !== null) patch[prop] = replaced;
    }
    if (HEADING.test(n.tag ?? '') && fam.heading && fam.heading !== fam.body) patch.fontFamily = familyRef(fam.heading);
    if (bindingFields(data).shadows === 'none') {
      for (const p of ['boxShadow', 'textShadow']) if (style[p] && style[p] !== 'none') { patch[p] = null; report.shadows_removed++; }
    }
    if (bindingFields(data).gradients === 'none') {
      for (const p of ['backgroundImage', 'background']) if (style[p]?.includes('gradient(')) { patch[p] = null; report.gradients_removed++; }
    }
    if (scale.length && /^\d*\.?\d+px$/.test(style.fontSize ?? '')) {
      const size = Number.parseFloat(style.fontSize!);
      const step = scale.reduce((a, b) => (Math.abs(b.size - size) < Math.abs(a.size - size) ? b : a));
      patch.fontSize = ref(step.token, `${step.size}px`);
      report.font_sizes++;
    }
    if (weights.length && /^\d+$/.test(style.fontWeight ?? '')) {
      const w = nearestStep(Number(style.fontWeight), weights);
      if (w !== Number(style.fontWeight)) { patch.fontWeight = String(w); report.weights++; }
    }
    if (spacingSteps.length) {
      for (const p of SPACING_PROPS) {
        const value = style[p];
        if (!value || value.includes('var(') || !/\dpx/.test(value)) continue;
        let next = snapLengths(value, spacingSteps, spacing);
        // Margins that centre a box at the captured width centre it at any width.
        if (p === 'margin') {
          const parts = value.trim().split(/\s+/);
          const [, r, , l] = parts.length === 4 ? parts : parts.length === 2 ? [parts[0], parts[1], parts[0], parts[1]] : [];
          if (r && r === l && Number.parseFloat(r) > maxSpace) {
            const snapped = next.trim().split(/\s+/);
            next = parts.length === 2 ? `${snapped[0]} auto` : `${snapped[0]} auto ${snapped[2]} auto`;
          }
        }
        if (next !== value) { patch[p] = next; report.spacing++; }
      }
      if (style.marginLeft && style.marginLeft === style.marginRight && Number.parseFloat(style.marginLeft) > maxSpace) {
        patch.marginLeft = 'auto';
        patch.marginRight = 'auto';
      }
    }
    if (radius.length) {
      for (const p of RADIUS_PROPS) {
        const value = style[p];
        if (!value || value.includes('var(') || !/^[\d.\spx]+$/.test(value)) continue;
        if (value.split(/\s+/).some((v) => Number.parseFloat(v) >= 999)) continue;
        const next = snapLengths(value, radius.map((r) => r.value), radius);
        if (next !== value) { patch[p] = next; report.radius++; }
      }
    }
    if (n.svg && plan.size) {
      n.svg = n.svg.replace(COLOR_LITERAL, (m) => {
        const hex = normalizeColor(m);
        const c = hex ? plan.get(hex.slice(0, 7)) : undefined;
        return c ? c.value : m;
      });
    }
    if (Object.keys(patch).length) {
      const next: Record<string, string> = { ...style };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      n.style = next;
    }
  });

  if (!options.keepText) {
    walk(root, (n) => {
      if (n.attrs) {
        const attrs = { ...n.attrs };
        if (attrs.alt) attrs.alt = 'Image';
        if (attrs.placeholder) attrs.placeholder = 'Placeholder';
        if (attrs.href) attrs.href = '#';
        for (const k of ['title', 'aria-label', 'value', 'datetime']) delete attrs[k];
        n.attrs = attrs;
      }
      if (n.type === 'text' && n.text) {
        const next = placeholderText(n.text);
        if (next !== n.text) {
          n.text = next;
          delete n.spans;
          n.name = next.slice(0, 40);
          report.texts_replaced++;
        }
      } else if (n.type === 'frame' && n.name) {
        // Names that came from the page's words.
        const prefix = /^([A-Z][\w ]{0,20}): .+/.exec(n.name);
        if (prefix) n.name = prefix[1];
      }
    });
  }
  if (!options.keepImages) {
    walk(root, (n) => {
      if (n.type === 'image' || n.type === 'video' || n.type === 'embed' || n.type === 'svg') {
        const kind = n.type === 'video' ? 'Video' : n.type === 'svg' ? 'Graphic' : n.type === 'embed' ? 'Embed' : 'Image';
        n.type = 'image';
        n.tag = 'img';
        delete n.src;
        delete n.svg;
        n.attrs = { alt: kind };
        n.name = kind;
        report.images_replaced++;
      }
      for (const p of MEDIA_PROPS) {
        const value = n.style?.[p];
        if (!value?.includes('url(')) continue;
        const rest = value.split(/,(?![^()]*\))/).map((v) => v.trim()).filter((v) => !v.startsWith('url('));
        if (rest.length) n.style![p] = rest.join(', ');
        else delete n.style![p];
        report.images_replaced++;
      }
    });
  }
  report.contrast_fixed = keepContrast(root, palette, tokens, ref);
  return report;
}

/**
 * Two colours of the page can land on one palette colour, or a light accent on a dark one, so text can end up on a
 * background it no longer stands out from. Such text takes the palette colour that reads best there. Text over a
 * drawing or a picture is left alone, since what is behind it is not known here; brand_check does not measure it either.
 */
function keepContrast(root: NewNode, palette: BrandColor[], tokens: Map<string, string>, ref: (token: string, value: string) => string): number {
  if (palette.length < 2) return 0;
  const resolve = (value: string | undefined): string | null => {
    if (!value) return null;
    const v = resolveVars(value, tokens);
    const hex = normalizeColor(v);
    return hex && colorAlpha(v) >= 0.99 ? hex.slice(0, 7) : null;
  };
  const sizeOf = (n: NewNode) => Number.parseFloat(resolveVars(n.style?.fontSize ?? '', tokens)) || 16;
  const backdrop = (n: NewNode) => (n.type === 'svg' || n.type === 'video' || n.type === 'embed' || (n.type === 'image' && Boolean(n.src))) && /absolute|fixed/.test(n.style?.position ?? '');
  const pictured = (n: NewNode) => /url\(|gradient\(/.test(`${n.style?.backgroundImage ?? ''} ${n.style?.background ?? ''}`);
  let fixed = 0;
  // -webkit-text-fill-color paints over color, and both are inherited.
  const visit = (n: NewNode, color: string | null, fill: string | null, bg: string | null) => {
    const own = resolve(n.style?.backgroundColor) ?? resolve(n.style?.background);
    const behind = pictured(n) ? null : own ?? bg;
    let fg = n.style?.color ? resolve(n.style.color) : color;
    let paint = n.style?.WebkitTextFillColor ? resolve(n.style.WebkitTextFillColor) : fill;
    const shown = paint ?? fg;
    if (n.type === 'text' && shown && behind) {
      const need = sizeOf(n) >= 24 ? 3 : 4.5;
      if (contrastRatio(shown, behind) < need) {
        const best = [...palette].sort((a, b) => contrastRatio(b.value, behind) - contrastRatio(a.value, behind))[0]!;
        if (contrastRatio(best.value, behind) > contrastRatio(shown, behind)) {
          const value = ref(best.token, best.value);
          n.style = { ...n.style, color: value, ...(paint ? { WebkitTextFillColor: value } : {}) };
          fg = best.value;
          if (paint) paint = best.value;
          fixed++;
        }
      }
    }
    const covered = (n.children ?? []).some(backdrop);
    for (const c of n.children ?? []) visit(c, fg, paint, covered ? null : behind);
  };
  visit(root, resolve(root.style?.color) ?? '#000000', resolve(root.style?.WebkitTextFillColor), resolve(root.style?.backgroundColor) ?? '#ffffff');
  return fixed;
}

export interface RestyleResult {
  file_id: string;
  created_file: boolean;
  linked: boolean;
  node_id: string;
  page_id: string;
  brand: { id: string; name: string };
  layers: number;
  kept: { text: boolean; images: boolean };
  restyle: RestyleReport;
  check: { score: number; hard: number; soft: number; violations: { node_id: string; rule: string; severity: string; message: string; fix: string }[]; checklist: number; not_checked: string[] };
  notice: string;
}

/** Page variables a capture refers to, written out, so that every colour is a literal the brand can replace. */
function inlineVars(root: NewNode, vars: Map<string, string>, keep: Map<string, string>): void {
  walk(root, (n) => {
    for (const [k, v] of Object.entries(n.style ?? {})) {
      if (!v.includes('var(')) continue;
      const names = [...v.matchAll(/var\(\s*--([\w-]+)/g)].map((m) => m[1]!);
      if (names.every((name) => keep.has(name))) continue;
      n.style![k] = resolveVars(v, vars);
    }
  });
}

/** Captures a page into a file and redraws it in a brand, then checks it against that brand. */
export async function restyleSite(app: BogenServer, options: RestyleOptions): Promise<RestyleResult> {
  const brandId = options.brandId ?? (options.fileId ? await (async () => brandLinkOf((await app.rooms.get(options.fileId!)).doc)?.id)() : undefined) ?? await app.brands.defaultBrandId();
  if (!brandId) throw new Error('Say which brand: there is no brand linked here and no default brand.');
  const { data, entry: brandEntry } = await app.brands.read(brandId);
  const host = new URL(options.url).hostname;
  const origin = agentOrigin(options.actor);

  // A file that follows another brand keeps it: the restyle goes into a new file of its own.
  let fileId = options.fileId;
  let created = false;
  if (fileId) {
    const link = brandLinkOf((await app.rooms.get(fileId)).doc);
    if (link && link.id !== brandId) fileId = undefined;
  }
  if (!fileId) {
    fileId = app.createFile(`${host} in ${brandEntry.name}`).id;
    created = true;
  }
  const room = await app.rooms.get(fileId);
  const { doc } = room;
  let linked = false;
  if (brandLinkOf(doc)?.id !== brandId) {
    await app.brands.link(fileId, brandId, origin);
    linked = true;
  }

  const keepText = Boolean(options.keepText);
  const keepImages = Boolean(options.keepImages);
  const capture = await capturePage(app.renderer, app.storage, doc, {
    url: options.url, width: options.width ?? 1440, height: options.height ?? 900, ...(options.colorScheme ? { colorScheme: options.colorScheme } : {}),
    allowLocal: options.allowLocal, captureFonts: false, media: keepImages,
  });
  const tokens = new Map(doc.getTokens().map((t) => [t.name, t.value]));
  inlineVars(capture.root, new Map(capture.tokens.map((t) => [t.name, t.value])), tokens);
  capture.tokens = [];
  capture.rules = [];
  capture.title = '';
  const restyle = restyleTree(capture.root, data, tokens, { keepText, keepImages });

  const pageId = options.pageId ?? doc.getPages()[0]!.id;
  if (!doc.pages.has(pageId)) throw new Error(`No page with id ${pageId}.`);
  room.undoManagerFor(options.actor);
  const { nodeId } = app.placeCapture(fileId, doc, capture, { name: options.name ?? `${host}, in ${brandEntry.name}`, pageId, url: options.url }, origin);

  const report = await checkRendered(doc, data, app.renderer, { nodeId });
  const ordered = [...report.violations].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'hard' ? -1 : 1));
  return {
    file_id: fileId, created_file: created, linked, node_id: nodeId, page_id: pageId, brand: { id: brandId, name: brandEntry.name },
    layers: capture.stats.layers, kept: { text: keepText, images: keepImages }, restyle,
    check: {
      score: report.score.value, hard: report.counts.hard, soft: report.counts.soft,
      violations: ordered.slice(0, 20).map((v) => ({ node_id: v.node_id, rule: v.rule, severity: v.severity, message: v.message, fix: v.fix.description })),
      checklist: report.checklist.length, not_checked: report.not_checked,
    },
    notice: RESTYLE_NOTICE,
  };
}

