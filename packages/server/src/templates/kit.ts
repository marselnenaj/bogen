import {
  CRAFT_LIMITS, confirmed, contrastRatio, escapeAttr, escapeHtml, familyStack, luminance, normalizeColor, pairingTable, resolveBrandColor,
  type BrandColor, type BrandData, type BrandFamily, type BrandLogo, type BrandTypeStep, svgAspect, sanitizeSvgMarkup, logoFitsBackground,
} from '@bogen/core';

/**
 * What every template builds from: the brand, and what the file it lands in already has. Templates only read this, and
 * return HTML with the brand's tokens in it. Values the brand does not have stay out: a gap becomes a quiet note.
 */
export interface TemplateEnv {
  data: BrandData;
  /** Token names the file holds, so that a value goes in as var(--name) only where that resolves. */
  tokens: Set<string>;
  /** Components the file already has, by name or variant set. */
  components: Set<string>;
  version: number | null;
  date: Date;
}

/** Marks a layer as a deliberate example of what not to do. brand_check leaves it out of the score, and says so. */
export const DONT = { 'data-brand-example': 'dont' } as const;
/**
 * Marks a layer as a specimen: parts shown to document them, such as every button variant or every step of a scale.
 * brand_check holds it to the brand as usual; the craft checks leave out only the rules about composing one screen
 * (one primary action, boxes in boxes, one loud line, how many sizes), and the copy check its punctuation and glyphs.
 */
export const SPECIMEN = { 'data-brand-example': 'specimen' } as const;

// ---------------------------------------------------------------- markup

export type Style = Record<string, string | number | undefined | false>;
type Child = string | false | null | undefined;

export function css(style: Style): string {
  return Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== false && v !== '')
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`)
    .join(';');
}

/** One element. Children are markup already; text goes through `t`. */
export function h(tag: string, style: Style, children: Child | Child[] = [], attrs: Record<string, string | undefined> = {}): string {
  const list = Array.isArray(children) ? children : [children];
  const attr = Object.entries(attrs).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}="${escapeAttr(v!)}"`).join('');
  const style$ = css(style);
  return `<${tag}${style$ ? ` style="${escapeAttr(style$)}"` : ''}${attr}>${list.filter(Boolean).join('')}</${tag}>`;
}

export function t(value: string): string {
  return escapeHtml(value);
}

// ---------------------------------------------------------------- the brand, read for layout

export interface TypeRole {
  /** Font size as the file should hold it: the step's token, or px. */
  size: string;
  px: number;
  family: string;
  weight: number;
  lineHeight: string;
  tracking?: string;
  step?: BrandTypeStep;
}

export interface Scheme {
  bg: BrandColor | null;
  fg: BrandColor | null;
  muted: BrandColor | null;
  line: BrandColor | null;
}

/** Layout steps for the document itself when a brand has no spacing scale yet. They are not brand values and are never shown as such. */
const FALLBACK_SPACING = [4, 8, 12, 16, 24, 32, 48, 64, 96];
const FALLBACK_SIZES = [96, 64, 40, 28, 22, 18, 15, 13];
const NEUTRAL_LIGHT = '#ffffff';
const NEUTRAL_DARK = '#111111';

export class BrandKit {
  readonly data: BrandData;
  readonly colors: BrandColor[];
  readonly name: string;

  constructor(readonly env: TemplateEnv) {
    this.data = env.data;
    // Suggestions are shown too, so that a brand being built can be seen; only confirmed ones have tokens.
    this.colors = env.data.colors;
    this.name = env.data.fields.name || 'Brand';
  }

  // ---- colour

  /** A colour as the file should hold it. */
  c(color: BrandColor | null | undefined, fallback = NEUTRAL_DARK): string {
    if (!color) return fallback;
    return !color.suggested && this.env.tokens.has(color.token) ? `var(--${color.token})` : color.value;
  }

  private role(c: BrandColor): string {
    return `${c.role} ${c.name}`.toLowerCase();
  }

  kind(c: BrandColor): 'line' | 'muted' | 'link' | 'accent' | 'bg' | 'fg' | 'other' {
    const r = this.role(c);
    if (/\b(lines?|rules?|borders?|dividers?|strokes?|hairlines?)\b/.test(r)) return 'line';
    if (/\b(muted|dim|subtle|quiet|caption|secondary text|tertiary)\b/.test(r)) return 'muted';
    if (/\b(links?|cta)\b/.test(r)) return 'link';
    if (/\b(primary|accent|brand|highlight|signal|action)\b/.test(r)) return 'accent';
    if (/\b(background|surface|canvas|page|base|ground|backdrop)\b/.test(r)) return 'bg';
    if (/\b(text|ink|foreground|copy|body)\b/.test(r)) return 'fg';
    return 'other';
  }

  /** Whether the brand lets this colour carry text on that one. `large` is display-sized text. */
  canText(fg: BrandColor, bg: BrandColor, large = false): boolean {
    if (fg.id === bg.id) return false;
    const contrast = contrastRatio(fg.value, bg.value);
    const need = large ? Math.min(3, this.data.fields.minContrast) : this.data.fields.minContrast;
    if (contrast < need) return false;
    const pairs = confirmed(this.data.pairings).length ? confirmed(this.data.pairings) : this.data.pairings;
    const listed = pairs.find((p) => resolveBrandColor(this.data, p.fg)?.id === fg.id && resolveBrandColor(this.data, p.bg)?.id === bg.id);
    if (listed) return listed.verdict === 'allow';
    return this.data.fields.pairingDefault !== 'forbid';
  }

  /** The best colour for text on a background, by the brand's pairs and contrast, neutrals first. */
  textOn(bg: BrandColor | null, large = false): BrandColor | null {
    if (!bg) return null;
    const ok = this.colors.filter((c) => this.canText(c, bg, large));
    const rank = (c: BrandColor) => (['fg', 'bg'].includes(this.kind(c)) ? 2 : this.kind(c) === 'other' ? 1 : 0) * 100 + contrastRatio(c.value, bg.value);
    return ok.sort((a, b) => rank(b) - rank(a))[0] ?? null;
  }

  /** The neutrals: what pages and text are made of. */
  neutrals(): BrandColor[] {
    const marked = this.colors.filter((c) => ['bg', 'fg'].includes(this.kind(c)));
    if (marked.length >= 2) return marked;
    const plain = this.colors.filter((c) => this.kind(c) === 'other' && chromaOf(c.value) < 0.08);
    return [...marked, ...plain];
  }

  /** The page colour the brand names first, else its lightest neutral. */
  base(): BrandColor | null {
    return this.colors.find((c) => this.kind(c) === 'bg') ?? [...this.neutrals()].sort((a, b) => luminance(b.value) - luminance(a.value))[0] ?? this.colors[0] ?? null;
  }

  /** The neutral furthest from the base, for a band that sets a board apart. */
  alternate(): BrandColor | null {
    const base = this.base();
    if (!base) return null;
    const options = this.neutrals().filter((c) => c.id !== base.id && this.textOn(c));
    return options.sort((a, b) => Math.abs(luminance(b.value) - luminance(base.value)) - Math.abs(luminance(a.value) - luminance(base.value)))[0] ?? null;
  }

  accent(): BrandColor | null {
    const byRole = (re: RegExp) => this.colors.find((c) => re.test(c.role.toLowerCase()));
    return byRole(/\b(primary|brand)\b/) ?? byRole(/\baccent\b/) ?? [...this.colors].filter((c) => chromaOf(c.value) >= 0.08).sort((a, b) => chromaOf(b.value) - chromaOf(a.value))[0] ?? null;
  }

  secondAccent(): BrandColor | null {
    const first = this.accent();
    return this.colors.find((c) => c.id !== first?.id && this.kind(c) === 'accent') ?? null;
  }

  scheme(bg: BrandColor | null): Scheme {
    const fg = this.textOn(bg);
    const muted = bg ? this.colors.filter((c) => this.kind(c) === 'muted' && this.canText(c, bg)).sort((a, b) => contrastRatio(a.value, bg.value) - contrastRatio(b.value, bg.value))[0] ?? null : null;
    const lines = this.colors.filter((c) => this.kind(c) === 'line' && c.id !== bg?.id);
    const line = bg && lines.length ? lines.sort((a, b) => Math.abs(luminance(a.value) - luminance(bg.value)) - Math.abs(luminance(b.value) - luminance(bg.value)))[0]! : null;
    return { bg, fg, muted: muted ?? fg, line: line ?? muted ?? fg };
  }

  /** Text colour, background and so on as CSS values for a scheme. */
  paint(s: Scheme): { bg: string; fg: string; muted: string; line: string } {
    const dark = s.bg ? luminance(s.bg.value) < 0.4 : false;
    return { bg: this.c(s.bg, NEUTRAL_LIGHT), fg: this.c(s.fg, dark ? NEUTRAL_LIGHT : NEUTRAL_DARK), muted: this.c(s.muted, dark ? NEUTRAL_LIGHT : NEUTRAL_DARK), line: this.c(s.line, dark ? NEUTRAL_LIGHT : NEUTRAL_DARK) };
  }

  /** A palette colour by id, name, role or token, or a background keyword such as light or dark. */
  colorFor(spec: string): BrandColor | null {
    const s = spec.trim().toLowerCase();
    if (s === 'light') return [...this.neutrals()].sort((a, b) => luminance(b.value) - luminance(a.value))[0] ?? null;
    if (s === 'dark') return [...this.neutrals()].sort((a, b) => luminance(a.value) - luminance(b.value))[0] ?? null;
    if (s === 'any' || !s) return this.base();
    return resolveBrandColor(this.data, spec) ?? null;
  }

  pairs() {
    return pairingTable(this.data);
  }

  // ---- type

  families(): BrandFamily[] {
    return this.data.families;
  }

  family(role: 'display' | 'body' | 'mono'): BrandFamily | undefined {
    const fams = this.data.families;
    const has = (re: RegExp) => fams.find((f) => re.test(f.role.toLowerCase()));
    if (role === 'mono') return has(/\b(mono|code)\b/);
    const notMono = fams.filter((f) => !/\b(mono|code)\b/.test(f.role.toLowerCase()));
    if (role === 'display') return has(/\b(display|head|title)/) ?? has(/\bbrand\b/) ?? notMono[0] ?? fams[0];
    return has(/\b(body|text|copy|ui)\b/) ?? notMono[0] ?? fams[0];
  }

  stack(f: BrandFamily | undefined): string {
    if (!f) return 'system-ui, sans-serif';
    return !f.suggested && this.env.tokens.has(f.token) ? `var(--${f.token})` : familyStack(f);
  }

  /**
   * The family a step is set in. One family listed for two roles, such as Archivo for display at 800 and 900 and for
   * body at 400, is the entry whose weights have the step's, so that body text does not come out at 800.
   */
  private familyOf(step: BrandTypeStep): BrandFamily | undefined {
    const same = this.data.families.filter((f) => f.id === step.family || f.family === step.family);
    if (same.length <= 1) return same[0];
    const weight = step.weight || 400;
    return same.find((f) => f.weights.includes(weight))
      ?? (weight < 600 ? same.find((f) => /\b(body|text|copy|ui)\b/.test(f.role.toLowerCase())) : same.find((f) => /\b(display|head|title)/.test(f.role.toLowerCase())))
      ?? same[0];
  }

  private isMono(step: BrandTypeStep): boolean {
    const f = this.familyOf(step);
    return Boolean(f && /\b(mono|code)\b/.test(f.role.toLowerCase())) || /\b(code|mono)\b/.test(`${step.name} ${step.role}`.toLowerCase());
  }

  steps(): BrandTypeStep[] {
    return [...this.data.typeScale].sort((a, b) => b.size - a.size);
  }

  /** A weight the family really has, as close as it gets to the one wanted. */
  weight(f: BrandFamily | undefined, wanted: number): number {
    const list = f?.weights.length ? f.weights : [];
    if (!list.length) return wanted;
    return list.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best));
  }

  private fromStep(step: BrandTypeStep, weight?: number): TypeRole {
    const fam = this.familyOf(step) ?? this.family(this.isMono(step) ? 'mono' : 'body');
    return {
      size: !step.suggested && this.env.tokens.has(step.token) ? `var(--${step.token})` : `${step.size}px`, px: step.size,
      family: this.stack(fam), weight: this.weight(fam, weight ?? (step.weight || 400)), lineHeight: step.lineHeight || (step.size >= 32 ? '1.05' : '1.4'),
      ...(step.tracking ? { tracking: step.tracking } : {}), step,
    };
  }

  private fallback(px: number, family: 'display' | 'body' | 'mono', weight: number): TypeRole {
    const fam = this.family(family) ?? this.family('body');
    return { size: `${px}px`, px, family: this.stack(fam), weight: this.weight(fam, weight), lineHeight: px >= 32 ? '1.05' : '1.4' };
  }

  /**
   * A step of the scale for a purpose. `near` is the size wanted; `max` keeps it inside what fits. Without a scale it
   * falls back to sizes for laying the document out, which say nothing about the brand.
   */
  type(purpose: 'hero' | 'headline' | 'heading' | 'subheading' | 'lead' | 'body' | 'small' | 'mono', max = Infinity): TypeRole {
    const all = this.steps();
    const text = all.filter((s) => !this.isMono(s));
    const fits = text.filter((s) => s.size <= max);
    const near = (px: number, list = fits) => [...list].sort((a, b) => Math.abs(a.size - px) - Math.abs(b.size - px))[0];
    const named = (re: RegExp) => fits.find((s) => re.test(`${s.name} ${s.role}`.toLowerCase()));
    let step: BrandTypeStep | undefined;
    switch (purpose) {
      case 'hero': step = fits[0]; break;
      case 'headline': step = fits[1] ?? fits[0]; break;
      case 'heading': step = near(48, fits.filter((s) => s.size >= 28)) ?? near(48); break;
      case 'subheading': step = near(30, fits.filter((s) => s.size >= 20 && s.size < (this.type('heading', max).px || Infinity))) ?? near(28); break;
      case 'lead': step = named(/\blead\b|\bintro/) ?? near(22, fits.filter((s) => s.size >= 18)); break;
      case 'body': step = named(/\bbody\b/) ?? near(17); break;
      case 'small': step = [...fits].reverse().find((s) => s.size >= 12) ?? near(14); break;
      // Code and labels read at text size: the mono step nearest 15px, not the largest one, which may be a display size.
      case 'mono': step = [...all.filter((s) => this.isMono(s) && s.size <= max)].sort((a, b) => Math.abs(a.size - 15) - Math.abs(b.size - 15))[0]; break;
    }
    if (purpose === 'mono' && !step) {
      // No step of its own: the mono family at the small size, or the small size itself.
      const small = this.type('small', max);
      const mono = this.family('mono');
      return mono ? { ...small, family: this.stack(mono), weight: this.weight(mono, 400) } : small;
    }
    if (step) return this.fromStep(step);
    const sizes = FALLBACK_SIZES.filter((s) => s <= max);
    const px = { hero: sizes[0], headline: sizes[1], heading: sizes[2], subheading: sizes[3], lead: sizes[4], body: sizes[5], small: sizes[6], mono: sizes[7] }[purpose] ?? 16;
    return this.fallback(px, purpose === 'hero' || purpose === 'headline' || purpose === 'heading' ? 'display' : purpose === 'mono' ? 'mono' : 'body', purpose === 'hero' || purpose === 'headline' || purpose === 'heading' ? 700 : 400);
  }

  /**
   * The step of the scale nearest to a size, for formats that need their own sizes, such as a slide at 1920 or a
   * store screenshot. A scale with nothing near falls back to the size itself, in the role's family. `min` is the
   * smallest size that still reads where the format is seen, such as 25px on a 1080 social image in a phone feed:
   * no step below it is chosen, and the fallback is never under it.
   */
  sized(px: number, family: 'display' | 'body' | 'mono' = 'body', weight?: number, min = 0): TypeRole {
    if (px < min) px = min;
    const list = this.steps().filter((s) => (family === 'mono' ? this.isMono(s) : !this.isMono(s)) && s.size >= min);
    const step = [...list].sort((a, b) => Math.abs(a.size - px) - Math.abs(b.size - px))[0];
    if (step && Math.abs(step.size - px) <= px * 0.3) {
      const role = this.fromStep(step, weight);
      if (family === 'display') return role;
      // Body and mono text take their own family and a reading weight, even when the nearest step is a heading's.
      const own = this.family(family) ?? this.family('body');
      // Running text keeps a reading leading, even on a display step set as tight as 0.9.
      return { ...role, family: this.stack(own), weight: this.weight(own, weight ?? 400), lineHeight: px >= 32 && Number(role.lineHeight) >= 1.3 ? role.lineHeight : '1.4' };
    }
    return this.fallback(px, family, weight ?? (family === 'display' ? 700 : 400));
  }

  /**
   * Sizes for a run of heading levels, largest first, each at least `ratio` under the one before, so that the levels
   * read as levels whatever the brand's scale holds: a step near the size wanted where there is one, else the size
   * itself. A scale made for slides or posters has no step for a page's h2, and two levels on one step look alike.
   * `above` is the running text's size, which the top level clears by `ratio`; `max` is the most that fits.
   */
  ladder(targets: number[], options: { family?: 'display' | 'body'; ratio?: number; above?: number; max?: number } = {}): TypeRole[] {
    const { family = 'display', ratio = 1.2, above = 0, max = Infinity } = options;
    const out: TypeRole[] = [];
    const list = this.steps().filter((s) => !this.isMono(s));
    for (const target of targets) {
      // The top level clears the running text by the same ratio, so that it is not as loud as the body.
      const floor = out.length ? 0 : above * ratio;
      const cap = Math.min(max, (out.at(-1)?.px ?? Infinity) / ratio);
      const want = Math.min(Math.max(target, floor), cap);
      const step = list.filter((s) => s.size <= cap && s.size >= floor).sort((a, b) => Math.abs(a.size - want) - Math.abs(b.size - want))[0];
      if (step && Math.abs(step.size - want) <= want * 0.3) {
        const role = this.fromStep(step);
        const own = this.family(family) ?? this.family('body');
        out.push(family === 'display' ? role : { ...role, family: this.stack(own), weight: this.weight(own, 700) });
        continue;
      }
      // A size of its own, kept clear of the steps above it so that it does not read as a slip beside one.
      let px = Math.floor(want);
      const beside = list.find((s) => s.size > px && (s.size - px) / s.size <= CRAFT_LIMITS.scaleNear);
      if (beside) px = Math.floor(beside.size / (1 + CRAFT_LIMITS.scaleNear + 0.01));
      out.push(this.fallback(px, family, 700));
    }
    return out;
  }

  /** A text style as CSS, optionally with a different weight the family has. */
  font(role: TypeRole, weight?: number): Style {
    return {
      margin: 0, fontFamily: role.family, fontSize: role.size, fontWeight: weight ? this.weightFor(role, weight) : role.weight, lineHeight: role.lineHeight,
      ...(role.tracking ? { letterSpacing: role.tracking } : {}),
    };
  }

  private weightFor(role: TypeRole, weight: number): number {
    const fam = role.step ? this.familyOf(role.step) : this.data.families.find((f) => role.family.includes(f.family) || role.family === `var(--${f.token})`);
    return this.weight(fam, weight);
  }

  // ---- spacing and shape

  private spacingSteps(): { value: number; token?: string }[] {
    const list = this.data.spacing.map((s) => ({ value: s.value, ...(!s.suggested && this.env.tokens.has(s.token) ? { token: s.token } : {}) })).filter((s) => s.value > 0);
    return list.length ? list : FALLBACK_SPACING.map((value) => ({ value }));
  }

  /** The step of the spacing scale nearest to what the layout wants, as a token where there is one. */
  space(px: number): string {
    const step = this.spacingSteps().reduce((best, s) => (Math.abs(s.value - px) < Math.abs(best.value - px) ? s : best));
    return step.token ? `var(--${step.token})` : `${step.value}px`;
  }

  spacePx(px: number): number {
    return this.spacingSteps().reduce((best, s) => (Math.abs(s.value - px) < Math.abs(best.value - px) ? s : best)).value;
  }

  /** The radius components use: the brand's smallest above zero, else its square one, else none. */
  radius(): string {
    const list = this.data.radius.filter((r) => r.value < 999).sort((a, b) => a.value - b.value);
    const r = list.find((x) => x.value > 0) ?? list[0];
    if (!r) return '0px';
    return !r.suggested && this.env.tokens.has(r.token) ? `var(--${r.token})` : `${r.value}px`;
  }

  /** The radius for pills, when the brand has a round one. */
  roundRadius(): string {
    const r = [...this.data.radius].sort((a, b) => b.value - a.value)[0];
    if (!r || r.value === 0) return this.radius();
    return !r.suggested && this.env.tokens.has(r.token) ? `var(--${r.token})` : `${r.value}px`;
  }

  // ---- logos

  logos(): BrandLogo[] {
    return confirmed(this.data.logos).length ? confirmed(this.data.logos) : this.data.logos;
  }

  /** The variant made for a background, as the brand picks it. */
  logoFor(bg: BrandColor | null): BrandLogo | undefined {
    const logos = this.logos();
    if (!bg) return logos[0];
    const s = (l: BrandLogo) => l.background.toLowerCase();
    const specific = logos.find((l) => !['any', 'light', 'dark'].includes(s(l)) && logoFitsBackground(this.data, l.background, bg.value));
    return specific ?? logos.find((l) => ['light', 'dark'].includes(s(l)) && logoFitsBackground(this.data, l.background, bg.value)) ?? logos.find((l) => s(l) === 'any');
  }

  aspect(logo: BrandLogo): number {
    return logo.aspect ?? (logo.svg ? svgAspect(logo.svg) : undefined) ?? 1;
  }

  /** A logo as a layer. Its margin is its clear space, the way brand_asset_use places one. */
  logo(logo: BrandLogo, width: number, extra: Style = {}, name?: string): string {
    const w = Math.max(width, logo.minWidth);
    const height = Math.round((w / this.aspect(logo)) * 100) / 100;
    const style: Style = { width: `${w}px`, height: `${height}px`, flex: 'none', objectFit: 'contain', ...extra };
    const label = name ?? `Logo: ${logo.name}`;
    if (logo.asset) return h('img', style, [], { src: logo.asset, alt: logo.name, 'data-name': label });
    const svg = sanitizeSvgMarkup(logo.svg ?? '');
    return svg.replace(/^<svg\b/, `<svg data-name="${escapeAttr(label)}" aria-label="${escapeAttr(logo.name)}" style="${escapeAttr(css(style))}"`);
  }

  // ---- words

  hex(c: BrandColor): string {
    return normalizeColor(c.value) ?? c.value;
  }
}

function chromaOf(hex: string): number {
  const v = normalizeColor(hex);
  if (!v) return 0;
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/**
 * The smallest text that still reads on a fixed format where it is really seen: a social image in a phone feed, a
 * slide on a shared screen. The same numbers design_lint's viewing-size check uses.
 */
export function seenMin(width: number, seen: 'social' | 'slide'): number {
  const at = seen === 'social' ? CRAFT_LIMITS.socialViewPx : CRAFT_LIMITS.slideViewPx;
  return at < width ? Math.ceil((CRAFT_LIMITS.minSeenPx * width) / at) : 0;
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
