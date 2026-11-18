import {
  PATTERN_DEFAULTS, confirmed, contrastRatio, luminance, normalizeColor, normalizePatternSpec, renderPattern,
  type BrandColor, type BrandLogo, type PatternSpec,
} from '@bogen/core';
import { BrandKit, DONT, SPECIMEN, formatDate, h, t, type Style, type TemplateEnv, type TypeRole } from './kit.ts';
import type { BoardPlan } from './types.ts';

/**
 * A brand presented the way an agency reveals one: a 16:9 deck with an arc (where it started, the insight, the idea,
 * the identity, the brand in the world, why it works, what happens next) and the applications it shows as boards of
 * their own, which the deck places as tiles and mockups. What follows from the brand's data is drawn here and looks
 * finished without an agent: the logo suite and its clear space, the misuse grid made from the real logo, colour
 * with its values and every contrast pair, the type specimen and scale, the grid, the graphic device. What needs
 * judgement comes from the story an agent writes: the insight, the idea, a reason on every identity slide, display
 * lines, the photography rule, the hero and the close. A slide whose story is missing is left out and named, never
 * filled with a placeholder.
 */

export const SLIDE_ATTR = 'data-bogen-slide';

export type SlideTemplate = 'hero' | 'statement' | 'object' | 'specimen' | 'spec' | 'pair' | 'grid-9' | 'wall' | 'evidence' | 'divider' | 'application';
export interface SlideMeta {
  n: number;
  key: string;
  template: SlideTemplate;
  kind: 'narrative' | 'identity' | 'system' | 'world' | 'divider' | 'application';
  bleed?: boolean;
  dense?: boolean;
  shot?: 'close' | 'distance';
  rationale?: boolean;
  photo?: boolean;
  /** The brand's colour that carries the slide. */
  ground?: string;
  /** For applications: the form the board takes (see BOARD_LAYOUTS) and the set it belongs to, such as post. */
  layout?: BoardLayout;
  set?: string;
}

/** The forms an application board can take. Each has one loud thing. */
export const BOARD_LAYOUTS = ['photo', 'split', 'number', 'quote', 'figure', 'type', 'details'] as const;
export type BoardLayout = (typeof BOARD_LAYOUTS)[number];

export interface BrandStory {
  date?: string;
  started_from?: string;
  /** An image of the mark before, a bogen-asset src. */
  old_logo?: string;
  insight?: string;
  /** Two to six words. */
  idea?: string;
  idea_line?: string;
  /** One line each, why the brand is so: logo, logo_story, colour, type, device, photography, voice, motion, applications. */
  rationale?: Partial<Record<'logo' | 'logo_story' | 'colour' | 'type' | 'device' | 'photography' | 'voice' | 'motion' | 'applications', string>>;
  /** Display lines in the brand's voice, for the specimen and the posters. */
  display_lines?: string[];
  /** The colour that carries the brand, by token, name or role. */
  hero_colour?: string;
  photos?: string[];
  photo_treatment?: 'duotone' | 'mono' | 'none';
  photo_crop?: '1:1' | '4:5' | '3:2' | '16:9';
  photo_rule?: string;
  voice?: { principles?: { name: string; line: string }[]; in_voice?: string; out_of_voice?: string };
  motion_rule?: string;
  social?: { posts?: { headline: string; caption: string; layout?: BoardLayout }[]; stories?: string[] };
  /** The one number that matters, with its line, for boards in the number form: such as 400, "seeds came back". */
  numbers?: { value: string; line: string }[];
  /** People in their own words, for boards in the quote form. Real quotes only. */
  quotes?: { text: string; by: string }[];
  /** Facts of the product, label and value, for boards in the details form. */
  facts?: { label: string; value: string }[];
  app?: { name?: string; screens?: string[] };
  campaign_lines?: string[];
  contact?: { name?: string; role?: string; email?: string; phone?: string; address?: string; web?: string };
  email?: { subject: string; headline: string; body: string; action: string };
  sign_line?: string;
  /** The scene the hero application stands in: billboard, poster-wall or hanging-sign. */
  hero_scene?: string;
  proof_points?: string[];
  next_steps?: { when: string; what: string }[];
  close?: string;
}

/** A design placed into a frame of a slide after the boards exist: as a scaled tile, or on a mockup scene. */
export type Placement = { layer: string; board: string; scene?: string };

export interface PresentationPlan {
  page: string;
  boards: BoardPlan[];
  /** Boards that are applications, by name: they become components so slides can show them. */
  apps: string[];
  placements: Placement[];
  /** Pattern layers by name, with the rule each draws, so they stay editable as patterns. */
  devices: { layer: string; spec: PatternSpec }[];
  skipped: { slide: string; needs: string }[];
  gaps: string[];
}

const W = 1920;
const H = 1080;
const MIN = 18;

type Ctx = {
  k: BrandKit;
  s: BrandStory;
  plan: PresentationPlan;
  device: PatternSpec;
  hero: BrandColor | null;
  base: BrandColor | null;
  dark: BrandColor | null;
  light: BrandColor | null;
  n: number;
  uid: number;
  /** How many numbers, quotes and photos the boards have used so far, so sets do not repeat one another. */
  used?: { number: number; quote: number; photo: number };
};

const name = (c: Ctx, prefix: string) => `${prefix} ${++c.uid}`;

export function deviceSpec(k: BrandKit, gaps: string[]): PatternSpec {
  const stored = confirmed(k.data.devices ?? [])[0] ?? (k.data.devices ?? [])[0];
  if (stored) {
    try {
      return normalizePatternSpec(JSON.parse(stored.spec) as Partial<PatternSpec>);
    } catch { /* falls through */ }
  }
  gaps.push('The brand has no graphic device yet, so its accent is set as plain cells. Add one with brand_update section devices, then run this again.');
  return normalizePatternSpec({ ...PATTERN_DEFAULTS, cell: 'square', fill: 'gradient', angle: 90, invert: true, threshold: 0.4, roughness: 0.3, colors: [k.c(k.accent())] });
}

function device(c: Ctx, w: number, h: number, patch: Partial<PatternSpec> = {}, style: Style = {}): string {
  const cell = Math.max(8, Math.round(Math.max(w, h) / (c.device.columns > 0 ? Math.max(c.device.columns, 24) : 32)));
  const spec = normalizePatternSpec({ ...c.device, columns: Math.max(1, Math.round(w / cell)), rows: Math.max(1, Math.round(h / cell)), ...patch });
  const layer = name(c, 'Graphic device');
  c.plan.devices.push({ layer, spec });
  const svg = renderPattern(spec).svg.replace(/^<svg\b/, `<svg data-name="${layer}" aria-hidden="true" style="display:block;width:${w}px;height:${h}px;flex:none;${Object.entries(style).map(([a, b]) => `${a.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${b}`).join(';')}"`);
  return svg;
}

function role(c: Ctx, px: number, family: 'display' | 'body' | 'mono' = 'body', weight?: number): TypeRole {
  return c.k.sized(px, family, weight, MIN);
}

function txt(c: Ctx, tag: string, px: number, value: string, style: Style = {}, family: 'display' | 'body' | 'mono' = 'body', layer?: string, weight?: number): string {
  return h(tag, { ...c.k.font(role(c, px, family, weight)), ...style }, t(value), layer ? { 'data-name': layer } : {});
}

function inks(c: Ctx, ground: BrandColor | null) {
  return c.k.paint(c.k.scheme(ground));
}

/** One slide: its ground, its chrome (the brand's name and the chapter), and what it shows. */
function slide(c: Ctx, key: string, label: string, ground: BrandColor | null, body: string, meta: Omit<SlideMeta, 'n' | 'key'>, opts: { chrome?: boolean; pad?: boolean } = {}): void {
  const p = inks(c, ground);
  c.n++;
  const chrome = opts.chrome !== false;
  const pad = c.k.space(96);
  const top = chrome ? h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', position: 'relative', zIndex: 2 }, [
    txt(c, 'p', 22, c.k.name, { color: p.fg }, 'body', 'Brand', 700),
    txt(c, 'p', 22, label, { color: p.muted }, 'body', 'Chapter'),
  ], { 'data-name': 'Chrome' }) : '';
  const inner = opts.pad === false ? body : h('div', { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', position: 'relative' }, body, { 'data-name': 'Content' });
  c.plan.boards.push({
    name: `${String(c.n).padStart(2, '0')} ${label}`, width: W, height: H, background: c.k.c(ground, '#ffffff'), color: p.fg, font: c.k.stack(c.k.family('body')),
    attrs: { [SLIDE_ATTR]: JSON.stringify({ n: c.n, key, ...meta, ...(ground ? { ground: ground.token } : {}) } satisfies SlideMeta) },
    steps: [{ html: opts.pad === false ? h('div', { position: 'relative', width: `${W}px`, height: `${H}px`, overflow: 'hidden', display: 'flex', flexDirection: 'column' }, [inner, chrome ? h('div', { position: 'absolute', left: pad, right: pad, top: c.k.space(64) }, top) : '']) : h('div', { display: 'flex', flexDirection: 'column', gap: c.k.space(48), width: `${W}px`, height: `${H}px`, padding: `${c.k.space(64)} ${pad} ${pad}`, boxSizing: 'border-box', overflow: 'hidden' }, [top, inner], { 'data-name': 'Slide' }) }],
  });
}

function why(c: Ctx, key: keyof NonNullable<BrandStory['rationale']>, ground: BrandColor | null): string {
  const line = c.s.rationale?.[key];
  if (!line) {
    c.plan.gaps.push(`No reason for the ${key.replace('_', ' ')} slide: give story.rationale.${key}, one line on why it is so.`);
    return '';
  }
  const p = inks(c, ground);
  return h('div', { display: 'flex', gap: c.k.space(16), alignItems: 'baseline', maxWidth: '1100px', marginTop: 'auto' }, [
    txt(c, 'p', 22, 'Why', { color: p.muted, flex: 'none' }, 'body', 'Why label', 700),
    txt(c, 'p', 30, line, { color: p.fg }, 'body', 'Rationale'),
  ], { 'data-name': 'Why' });
}

function skip(c: Ctx, slide: string, needs: string): void {
  c.plan.skipped.push({ slide, needs });
}

function place(c: Ctx, board: string, w: number, h2: number, scene?: string, style: Style = {}, attrs: Record<string, string> = {}): string {
  const layer = `Place ${++c.uid}: ${board}${scene ? ` on ${scene}` : ''}`;
  c.plan.placements.push({ layer, board, ...(scene ? { scene } : {}) });
  return h('div', { position: 'relative', width: `${w}px`, height: `${h2}px`, flex: 'none', overflow: 'hidden', ...style }, [], { 'data-name': layer, ...attrs });
}

function logoOn(c: Ctx, ground: BrandColor | null, width: number, style: Style = {}): string {
  const logo = c.k.logoFor(ground) ?? c.k.logos()[0];
  if (logo) return c.k.logo(logo, width, style);
  c.plan.gaps.push('The brand has no logo, so its name stands in. Add one with brand_asset_add kind logo (text_outline makes a wordmark).');
  return txt(c, 'p', Math.round(width / 4), c.k.name, { color: inks(c, ground).fg, ...style }, 'display', 'Name', 700);
}

/** A photo in the brand's one treatment and crop. */
function photo(c: Ctx, src: string, w: number, h2: number, style: Style = {}): string {
  const mode = c.s.photo_treatment ?? 'duotone';
  const img = (extra: Style) => h('img', { position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%', objectFit: 'cover', ...extra }, [], { src, alt: '' });
  if (mode === 'none') return h('div', { position: 'relative', width: `${w}px`, height: `${h2}px`, overflow: 'hidden', flex: 'none', ...style }, img({}), { 'data-name': 'Photo' });
  if (mode === 'mono') return h('div', { position: 'relative', width: `${w}px`, height: `${h2}px`, overflow: 'hidden', flex: 'none', ...style }, img({ filter: 'grayscale(1) contrast(1.1)' }), { 'data-name': 'Photo' });
  return h('div', { position: 'relative', width: `${w}px`, height: `${h2}px`, overflow: 'hidden', flex: 'none', backgroundColor: c.k.c(c.dark), isolation: 'isolate', ...style }, [
    img({ filter: 'grayscale(1) contrast(1.15)', mixBlendMode: 'screen' }),
    h('div', { position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%', backgroundColor: c.k.c(c.base ?? c.light), mixBlendMode: 'multiply' }, [], { 'data-name': 'Tone' }),
  ], { 'data-name': 'Photo' });
}

const cropRatio = (crop: BrandStory['photo_crop']) => ({ '1:1': 1, '4:5': 0.8, '3:2': 1.5, '16:9': 16 / 9 })[crop ?? '4:5'];

function rgb(hex: string): [number, number, number] {
  const v = normalizeColor(hex) ?? '#000000';
  return [1, 3, 5].map((i) => Number.parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
}

function cmyk(hex: string): string {
  const [r, g, b] = rgb(hex).map((x) => x / 255) as [number, number, number];
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return '0 0 0 100';
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k].map((x) => Math.round(x * 100)).join(' ');
}

// ---------------------------------------------------------------- applications

function appBoard(c: Ctx, boardName: string, w: number, h2: number, ground: BrandColor | null, html: string, extra: Partial<SlideMeta> = {}): string {
  const p = inks(c, ground);
  c.plan.apps.push(boardName);
  c.plan.boards.push({ name: boardName, width: w, height: h2, background: c.k.c(ground, '#ffffff'), color: p.fg, font: c.k.stack(c.k.family('body')), attrs: { [SLIDE_ATTR]: JSON.stringify({ n: 0, key: boardName, template: 'application', kind: 'application', ...extra } satisfies SlideMeta) }, steps: [{ html }] });
  return boardName;
}

/** The largest display size at which a line fits a box: its longest word on one line, and all of it in the height. */
export function fitDisplay(text: string, width: number, height: number, max: number, min = MIN): number {
  const words = text.split(/\s+/).filter(Boolean);
  const longest = Math.max(1, ...words.map((w) => w.length));
  const chars = Math.max(1, text.length);
  // Young Serif and most display faces average about 0.56 em a character; 0.62 keeps the longest word safe.
  const byWord = width / (longest * 0.62);
  const byArea = Math.sqrt((width * height) / (chars * 0.56 * 1.05));
  return Math.max(min, Math.floor(Math.min(max, byWord, byArea)));
}

/**
 * Picks a form per board so that a set reads as a system rather than one board repeated: never the form of the board
 * before, and at most three of one form in any nine (a feed's grid). A board's own wish wins when it keeps the rule.
 */
export function pickLayouts(count: number, can: (layout: BoardLayout, i: number, before: readonly BoardLayout[]) => boolean, wanted: (BoardLayout | undefined)[] = [], order: readonly BoardLayout[] = BOARD_LAYOUTS): BoardLayout[] {
  const out: BoardLayout[] = [];
  const able = (l: BoardLayout, i: number) => can(l, i, out);
  const ok = (l: BoardLayout, i: number) => able(l, i) && out[i - 1] !== l && out.slice(Math.max(0, i - 8), i).filter((x) => x === l).length < 3;
  for (let i = 0; i < count; i++) {
    const wish = wanted[i];
    if (wish && ok(wish, i)) { out.push(wish); continue; }
    const rotated = [...order.slice(i % order.length), ...order.slice(0, i % order.length)];
    out.push(rotated.find((l) => ok(l, i)) ?? rotated.find((l) => able(l, i) && out[i - 1] !== l) ?? 'type');
  }
  return out;
}

/** Layout rule violations in an ordered set of boards: the same form twice in a row, or more than three in nine. */
export function layoutViolations(layouts: (string | undefined)[]): { index: number; rule: 'adjacent' | 'nine' }[] {
  const out: { index: number; rule: 'adjacent' | 'nine' }[] = [];
  layouts.forEach((l, i) => {
    if (!l) return;
    if (layouts[i - 1] === l) out.push({ index: i, rule: 'adjacent' });
    else if (layouts.slice(Math.max(0, i - 8), i + 1).filter((x) => x === l).length > 3) out.push({ index: i, rule: 'nine' });
  });
  return out;
}

const GLYPHS: Record<string, string[]> = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], 1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00110', '01000', '10000', '11111'], 3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], 5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'], 7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'], 9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'], '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'], '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'], ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  k: ['10000', '10000', '10010', '10100', '11000', '10100', '10010'], h: ['10000', '10000', '10110', '11001', '10001', '10001', '10001'],
};

/** A number drawn in the device's cells, on a 5 by 7 grid per character: lit cells are the value, faint ones keep the grid. */
export function cellFigure(value: string, cell: number, on: string, off: string, shape: 'circle' | 'square' = 'circle'): string {
  const chars = [...value].filter((ch) => GLYPHS[ch.toLowerCase()]);
  const cells: string[] = [];
  chars.forEach((ch, k) => {
    const g = GLYPHS[ch.toLowerCase()]!;
    g.forEach((row, j) => [...row].forEach((b, i) => {
      const x = (k * 6 + i) * cell;
      const y = j * cell;
      const fill = b === '1' ? on : off;
      cells.push(shape === 'circle' ? `<circle cx="${x + cell / 2}" cy="${y + cell / 2}" r="${(cell * 0.42).toFixed(1)}" fill="${fill}"/>` : `<rect x="${x + cell * 0.08}" y="${y + cell * 0.08}" width="${cell * 0.84}" height="${cell * 0.84}" fill="${fill}"/>`);
    }));
  });
  const w = Math.max(1, chars.length * 6 - 1) * cell;
  return `<svg viewBox="0 0 ${w} ${7 * cell}" width="${w}" height="${7 * cell}" role="img" aria-label="${value.replace(/"/g, '')}" style="display:block;flex:none">${cells.join('')}</svg>`;
}

type BoardContent = { headline: string; photo?: string; number?: { value: string; line: string }; quote?: { text: string; by: string }; facts?: { label: string; value: string }[]; note?: string };

/** The brand colour that stands out most on a ground: the hero first when it holds 3:1, else the strongest. */
function standout(c: Ctx, ground: BrandColor | null): BrandColor | null {
  const on = ground?.value ?? '#ffffff';
  const pool = [c.hero, c.k.secondAccent(), c.k.accent(), c.light, c.dark].filter((x): x is BrandColor => Boolean(x) && x!.id !== ground?.id);
  return pool.find((x) => contrastRatio(x.value, on) >= 3) ?? pool.sort((a, b) => contrastRatio(b.value, on) - contrastRatio(a.value, on))[0] ?? null;
}

/** One application board in one of the forms. w by h2 pixels; every form keeps its type inside a safe area. */
function formBoard(c: Ctx, boardName: string, w: number, h2: number, ground: BrandColor | null, layout: BoardLayout, content: BoardContent, set: string): string {
  const k = c.k;
  const p = inks(c, ground);
  // Margins and gaps on the brand's spacing scale, so every board keeps to it.
  const pad = k.spacePx(Math.round(Math.min(w, h2) * 0.075));
  const inner = w - pad * 2;
  const logoW = Math.round(w * 0.2);
  const frame = (style: Style, children: string[]) => h('div', { display: 'flex', flexDirection: 'column', width: `${w}px`, height: `${h2}px`, overflow: 'hidden', boxSizing: 'border-box', position: 'relative', ...style }, children);
  const line = (text: string, px: number, color: string, extra: Style = {}, layer = 'Line') => h('h2', { ...k.font(k.sized(px, 'display')), color, maxWidth: `${inner}px`, ...extra }, t(text), { 'data-name': layer });
  let html: string;
  if (layout === 'photo' && content.photo) {
    // The picture fills the board; the line sits on a band of the ground, so it never lands on a busy part.
    const band = Math.round(h2 * 0.36);
    const px = fitDisplay(content.headline, inner, band - pad * 1.6, Math.round(w * 0.1));
    html = frame({ backgroundColor: k.c(ground) }, [
      h('div', { position: 'absolute', left: '0px', top: '0px', width: `${w}px`, height: `${h2 - band}px` }, photo(c, content.photo, w, h2 - band)),
      h('div', { position: 'absolute', left: '0px', bottom: '0px', width: `${w}px`, height: `${band}px`, padding: `${k.space(Math.round(pad * 0.7))} ${k.space(pad)}`, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: k.space(Math.round(pad * 0.3)), backgroundColor: k.c(ground) }, [
        logoOn(c, ground, logoW),
        line(content.headline, px, p.fg),
      ], { 'data-name': 'Safe area' }),
    ]);
  } else if (layout === 'split' && content.photo) {
    const top = Math.round(h2 * 0.5);
    const px = fitDisplay(content.headline, inner, top - pad * 2.4, Math.round(w * 0.11));
    html = frame({}, [
      h('div', { display: 'flex', flexDirection: 'column', gap: k.space(Math.round(pad * 0.5)), padding: k.space(pad), height: `${top}px`, boxSizing: 'border-box' }, [logoOn(c, ground, logoW), line(content.headline, px, p.fg)], { 'data-name': 'Safe area' }),
      photo(c, content.photo, w, h2 - top),
    ]);
  } else if (layout === 'number' && content.number) {
    const digits = [...content.number.value].filter((ch) => GLYPHS[ch.toLowerCase()]).length || 1;
    const cell = Math.max(6, Math.floor(inner / (digits * 6 - 1)));
    const dark = luminance(k.c(ground, '#ffffff')) < 0.4;
    const lit = standout(c, ground);
    html = frame({ padding: k.space(pad), justifyContent: 'space-between' }, [
      logoOn(c, ground, logoW),
      h('div', { display: 'flex', flexDirection: 'column', gap: k.space(Math.round(pad * 0.4)) }, [
        cellFigure(content.number.value, cell, k.c(lit), dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)'),
        txt(c, 'p', Math.max(MIN, Math.round(w * 0.028)), content.number.line, { color: p.fg, maxWidth: `${Math.round(inner * 0.85)}px` }, 'body', 'Number line'),
      ], { 'data-name': 'The one number' }),
    ]);
  } else if (layout === 'quote' && content.quote) {
    const px = fitDisplay(content.quote.text, inner, h2 * 0.5, Math.round(w * 0.075));
    html = frame({ padding: k.space(pad), justifyContent: 'space-between' }, [
      txt(c, 'p', Math.round(w * 0.16), '\u201c', { color: k.c(standout(c, ground)), lineHeight: '0.6', height: `${Math.round(w * 0.08)}px` }, 'display', 'Quote mark'),
      h('blockquote', { ...k.font(k.sized(px, 'display')), color: p.fg, margin: '0px', maxWidth: `${inner}px` }, t(content.quote.text), { 'data-name': 'Quote' }),
      h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }, [txt(c, 'p', Math.max(MIN, Math.round(w * 0.022)), content.quote.by, { color: p.fg }, 'body', 'Who'), logoOn(c, ground, Math.round(logoW * 0.8))]),
    ]);
  } else if (layout === 'details' && content.facts?.length) {
    const facts = content.facts.slice(0, 4);
    const cellBg = c.light && c.light.id !== ground?.id ? c.light : c.base;
    const cp = inks(c, cellBg);
    html = frame({ padding: k.space(pad), gap: k.space(Math.round(pad * 0.5)) }, [
      logoOn(c, ground, logoW),
      h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: k.space(Math.max(6, Math.round(pad * 0.15))), flex: '1' }, facts.map((f) => h('div', { display: 'flex', flexDirection: 'column', gap: '6px', padding: k.space(Math.round(pad * 0.5)), backgroundColor: k.c(cellBg), boxSizing: 'border-box' }, [
        txt(c, 'p', Math.max(MIN, Math.round(w * 0.02)), f.label, { color: cp.muted }, 'body', 'Label'),
        txt(c, 'p', fitDisplay(f.value, inner / 2 - pad, h2 * 0.18, Math.round(w * 0.05)), f.value, { color: cp.fg }, 'display', 'Value'),
      ], { 'data-name': `Fact ${f.label}` })), { 'data-name': 'Facts' }),
      txt(c, 'p', Math.max(MIN, Math.round(w * 0.024)), content.headline, { color: p.fg }, 'body', 'Line'),
    ]);
  } else if (layout === 'figure') {
    const px = fitDisplay(content.headline, inner, h2 * 0.3, Math.round(w * 0.1));
    const figures = ['hill', 'wave', 'mountain', 'tower', 'sun'] as const;
    html = frame({}, [
      h('div', { display: 'flex', flexDirection: 'column', gap: k.space(Math.round(pad * 0.5)), padding: k.space(pad) }, [
        h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }, [logoOn(c, ground, logoW), content.note ? txt(c, 'p', Math.max(MIN, Math.round(w * 0.022)), content.note, { color: p.muted }, 'body', 'Note') : '']),
        line(content.headline, px, p.fg),
      ], { 'data-name': 'Safe area' }),
      h('div', { marginTop: 'auto', display: 'flex' }, device(c, w, Math.round(h2 * 0.48), { fill: 'figure', figure: figures[c.uid % figures.length] })),
    ]);
  } else {
    // Type only: the line as large as the board takes.
    const px = fitDisplay(content.headline, inner, h2 * 0.62, Math.round(w * 0.2));
    html = frame({ padding: k.space(pad), justifyContent: 'flex-end', gap: k.space(Math.round(pad * 0.6)) }, [
      line(content.headline, px, p.fg, { letterSpacing: '-0.02em', lineHeight: '0.92' }),
      logoOn(c, ground, logoW),
    ]);
  }
  return appBoard(c, boardName, w, h2, ground, html, { layout, set });
}

/** Grounds for a set, rotating through the brand's main colours so neighbours differ. */
function groundsFor(c: Ctx, n: number): (BrandColor | null)[] {
  const pool = [c.hero ?? c.base, c.base, c.k.alternate() ?? c.dark, c.dark, c.k.secondAccent()].filter((g, i, a): g is BrandColor => Boolean(g) && a.findIndex((x) => x?.id === g!.id) === i);
  return Array.from({ length: n }, (_, i) => pool[i % Math.max(1, pool.length)] ?? null);
}

/** A set of boards in varied forms: posts, stories or posters. */
function formSet(c: Ctx, set: string, prefix: string, w: number, h2: number, items: { headline: string; layout?: BoardLayout }[]): string[] {
  const s = c.s;
  const photos = s.photos ?? [];
  const used = (before: readonly BoardLayout[], l: BoardLayout) => before.filter((x) => x === l).length;
  const layouts = pickLayouts(items.length, (l, _i, before) => (
    l === 'photo' || l === 'split' ? photos.length > 0
      : l === 'number' ? used(before, 'number') < (s.numbers?.length ?? 0)
        : l === 'quote' ? used(before, 'quote') < (s.quotes?.length ?? 0)
          : l === 'details' ? (s.facts?.length ?? 0) >= 2 && used(before, 'details') < 1
            : true
  ), items.map((x) => x.layout));
  const grounds = groundsFor(c, items.length);
  const u = (c.used ??= { number: 0, quote: 0, photo: 0 });
  return items.map((item, i) => {
    const chosen = layouts[i]!;
    const content: BoardContent = { headline: item.headline };
    if (chosen === 'photo' || chosen === 'split') content.photo = photos[u.photo++ % photos.length];
    if (chosen === 'number') content.number = s.numbers![u.number++ % s.numbers!.length];
    if (chosen === 'quote') content.quote = s.quotes![u.quote++ % s.quotes!.length];
    if (chosen === 'details') content.facts = s.facts;
    if (chosen === 'figure') content.note = s.next_steps?.[i % (s.next_steps.length || 1)]?.when;
    return formBoard(c, `${prefix} ${i + 1}`, w, h2, grounds[i]!, chosen, content, set);
  });
}

function buildApps(c: Ctx): { posters: string[]; social: string[]; stories: string[]; icon?: string; ooh: string[]; print: string[]; merch?: string; sign?: string; email?: string } {
  const s = c.s;
  const lines = [...(s.campaign_lines ?? []), ...(s.display_lines ?? [])];
  const photos = s.photos ?? [];
  const alt = c.k.alternate() ?? c.dark;
  const out: ReturnType<typeof buildApps> = { posters: [], social: [], stories: [], ooh: [], print: [] };
  if (lines.length) {
    out.posters.push(...formSet(c, 'poster', 'App · Poster A2', 1190, 1684, lines.slice(0, 2).map((headline, i) => ({ headline, layout: i === 0 && photos.length ? 'photo' as const : 'type' as const }))));
    out.ooh.push(appBoard(c, 'App · 48-sheet', 1760, 800, c.hero ?? c.base, h('div', { display: 'flex', width: '1760px', height: '800px', overflow: 'hidden' }, [
      h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '64px', width: '1100px', boxSizing: 'border-box' }, [
        h('h1', { ...c.k.font(c.k.sized(120, 'display')), color: inks(c, c.hero ?? c.base).fg }, t(lines[0]!), { 'data-name': 'Line' }),
        logoOn(c, c.hero ?? c.base, 220),
      ]),
      photos[1] ? photo(c, photos[1], 660, 800) : device(c, 660, 800),
    ])));
    out.ooh.push(...formSet(c, 'ooh', 'App · 6-sheet', 1200, 1800, [{ headline: lines[1] ?? lines[0]!, layout: photos.length ? 'split' : 'figure' }]));
    out.ooh.push(...formSet(c, 'ooh', 'App · Digital 9:16', 1080, 1920, [{ headline: lines[2] ?? lines[0]!, layout: s.numbers?.length ? 'number' : 'type' }]));
  }
  const posts = (s.social?.posts ?? []).slice(0, 9);
  out.social.push(...formSet(c, 'post', 'App · Post', 1080, 1350, posts));
  const stories = (s.social?.stories ?? []).slice(0, 3);
  out.stories.push(...formSet(c, 'story', 'App · Story', 1080, 1920, stories.map((headline, i) => ({ headline, layout: (['figure', 'photo', 'quote'] as const)[i] }))));
  const icon = c.k.logos().slice().sort((a, b) => Math.abs(c.k.aspect(a) - 1) - Math.abs(c.k.aspect(b) - 1))[0];
  if (icon || c.hero) {
    // The mark on the hero colour, with the device rising from the bottom edge; nothing cut by the icon's corners.
    // On the ground its logo is made for, so the icon keeps the logo's own rule.
    const iconGround = (icon && c.k.colorFor(icon.background)) || c.hero || c.base;
    out.icon = appBoard(c, 'App · Icon 1024', 1024, 1024, iconGround, h('div', { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '1024px', height: '1024px', position: 'relative', overflow: 'hidden' }, [
      h('div', { position: 'absolute', left: '0px', bottom: '0px' }, device(c, 1024, 320, { fill: 'figure', figure: 'hill' })),
      icon ? c.k.logo(icon, 560, { position: 'relative', marginTop: '-120px' }) : txt(c, 'p', 520, c.k.name.slice(0, 1), { color: inks(c, iconGround).fg, position: 'relative' }, 'display', 'Initial', 700),
    ]));
  }
  const ct = s.contact;
  if (ct && (ct.email || ct.address || ct.web)) {
    const p = inks(c, c.base);
    const lineOf = (v?: string, l?: string) => (v ? txt(c, 'p', 22, v, { color: p.fg }, 'body', l) : '');
    out.print.push(appBoard(c, 'App · Letterhead', 1240, 1754, c.base, h('div', { display: 'flex', flexDirection: 'column', width: '1240px', height: '1754px', padding: '96px', boxSizing: 'border-box', position: 'relative', overflow: 'hidden' }, [
      h('div', { display: 'flex', justifyContent: 'space-between' }, [logoOn(c, c.base, 260), h('div', { display: 'flex', flexDirection: 'column', gap: '4px', textAlign: 'right' }, [lineOf(ct.address, 'Address'), lineOf(ct.web, 'Web'), lineOf(ct.email, 'Email')])]),
      h('div', { position: 'absolute', left: '0px', bottom: '0px' }, device(c, 1240, 160)),
    ])));
    out.print.push(appBoard(c, 'App · Card', 1050, 600, c.hero ?? c.base, h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: '1050px', height: '600px', padding: '72px', boxSizing: 'border-box', overflow: 'hidden' }, [
      logoOn(c, c.hero ?? c.base, 240),
      h('div', { display: 'flex', flexDirection: 'column', gap: '6px' }, [ct.name ? txt(c, 'p', 40, ct.name, { color: inks(c, c.hero ?? c.base).fg }, 'display', 'Name', 700) : '', ct.role ? txt(c, 'p', 24, ct.role, { color: inks(c, c.hero ?? c.base).muted }, 'body', 'Role') : '', ct.email ? txt(c, 'p', 24, ct.email, { color: inks(c, c.hero ?? c.base).fg }, 'body', 'Email') : '']),
    ])));
  }
  if (s.email) {
    const p = inks(c, c.base);
    out.email = appBoard(c, 'App · Email', 600, 1100, c.base, h('div', { display: 'flex', flexDirection: 'column', width: '600px', height: '1100px', overflow: 'hidden' }, [
      h('div', { padding: '32px 40px', backgroundColor: c.k.c(c.hero ?? c.base) }, logoOn(c, c.hero ?? c.base, 140)),
      photos[3] ? photo(c, photos[3], 600, 340) : device(c, 600, 200),
      h('div', { display: 'flex', flexDirection: 'column', gap: '20px', padding: '40px' }, [
        txt(c, 'p', 18, s.email.subject, { color: p.muted }, 'body', 'Subject'),
        txt(c, 'h1', 44, s.email.headline, { color: p.fg }, 'display', 'Headline', 700),
        txt(c, 'p', 20, s.email.body, { color: p.fg }, 'body', 'Body'),
        h('a', { ...c.k.font(role(c, 20, 'body', 700)), color: inks(c, c.hero).fg, backgroundColor: c.k.c(c.hero), padding: '14px 24px', borderRadius: c.k.roundRadius(), alignSelf: 'flex-start', textDecoration: 'none' }, t(s.email.action), { href: '#', 'data-name': 'Action' }),
      ]),
    ]));
  }
  out.merch = appBoard(c, 'App · Merch print', 1000, 1000, c.base, h('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '48px', width: '1000px', height: '1000px', overflow: 'hidden' }, [
    logoOn(c, c.base, 520),
    device(c, 640, 220, { fill: 'figure', figure: 'hill' }),
  ]));
  out.sign = appBoard(c, 'App · Sign', 1250, 1000, c.hero ?? c.base, h('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '40px', width: '1250px', height: '1000px', overflow: 'hidden' }, [
    logoOn(c, c.hero ?? c.base, 620),
    s.sign_line ? txt(c, 'p', 56, s.sign_line, { color: inks(c, c.hero ?? c.base).fg }, 'display', 'Sign line') : '',
  ]));
  return out;
}

/**
 * The system at scale as a board of its own: every application of the brand tiled in its own ratio, and the graphic
 * device at three scales (favicon, card, full bleed). It is an application too, so the deck's slide shows it and a
 * person can open and change it. Rows are packed to a common height so tiles keep their ratio.
 */
export const WALL_BOARD = 'App · System wall';
function buildWall(c: Ctx, names: string[]): string | undefined {
  const tiles = names.map((n) => c.plan.boards.find((b) => b.name === n)).filter((b): b is BoardPlan => Boolean(b));
  if (tiles.length < 6) return undefined;
  const WW = 3200;
  const gap = 32;
  const pad = 64;
  const rowH = [620, 440, 360];
  const rows: { h: number; items: { name: string; w: number }[] }[] = [];
  let i = 0;
  let r = 0;
  while (i < tiles.length) {
    const hgt = rowH[r % rowH.length]!;
    const items: { name: string; w: number }[] = [];
    let used = 0;
    while (i < tiles.length) {
      const b = tiles[i]!;
      const w = Math.round(hgt * (b.width / (b.height ?? b.width)));
      if (items.length && used + w + gap > WW - pad * 2) break;
      items.push({ name: b.name, w });
      used += w + gap;
      i++;
    }
    rows.push({ h: hgt, items });
    r++;
  }
  const dark = c.dark;
  const p = inks(c, dark);
  const scales = h('div', { display: 'flex', gap: `${gap}px`, alignItems: 'flex-end' }, [
    h('div', { display: 'flex', flexDirection: 'column', gap: '12px' }, [h('div', { width: '64px', height: '64px', overflow: 'hidden', backgroundColor: c.k.c(c.hero ?? c.base) }, device(c, 64, 64)), txt(c, 'p', 22, 'Favicon, 64 px', { color: p.muted }, 'body', 'Scale')], { 'data-name': 'Device as favicon' }),
    h('div', { display: 'flex', flexDirection: 'column', gap: '12px' }, [h('div', { width: '480px', height: '300px', overflow: 'hidden', backgroundColor: c.k.c(c.base) }, device(c, 480, 300, { fill: 'figure', figure: 'hill' })), txt(c, 'p', 22, 'Card, 480 px', { color: p.muted }, 'body', 'Scale')], { 'data-name': 'Device as card' }),
    h('div', { display: 'flex', flexDirection: 'column', gap: '12px', flex: '1' }, [h('div', { height: '300px', overflow: 'hidden', backgroundColor: c.k.c(c.hero ?? c.base) }, device(c, WW - pad * 2 - 480 - 64 - gap * 2, 300)), txt(c, 'p', 22, 'Full bleed', { color: p.muted }, 'body', 'Scale')], { 'data-name': 'Device full bleed' }),
  ], { 'data-name': 'Device at three scales' });
  const height = pad * 2 + rows.reduce((sum, row) => sum + row.h + gap, 0) + 380;
  return appBoard(c, WALL_BOARD, WW, height, dark, h('div', { display: 'flex', flexDirection: 'column', gap: `${gap}px`, padding: `${pad}px`, width: `${WW}px`, boxSizing: 'border-box' }, [
    // Tiles are previews of boards that are checked at their own size, so they are marked as shown, not designed.
    ...rows.map((row, k) => h('div', { display: 'flex', gap: `${gap}px`, height: `${row.h}px` }, row.items.map((it) => place(c, it.name, it.w, row.h, undefined, {}, { ...SPECIMEN })), { 'data-name': `Row ${k + 1}` })),
    scales,
  ]), { set: 'wall' });
}

// ---------------------------------------------------------------- the deck

export function buildReveal(env: TemplateEnv, story: BrandStory): PresentationPlan {
  const k = new BrandKit(env);
  const plan: PresentationPlan = { page: 'Brand presentation', boards: [], apps: [], placements: [], devices: [], skipped: [], gaps: [] };
  const colors = k.colors;
  const byLum = [...colors].sort((a, b) => luminance(a.value) - luminance(b.value));
  const hero = (story.hero_colour ? k.colorFor(story.hero_colour) : null) ?? k.accent();
  const c: Ctx = { k, s: story, plan, device: deviceSpec(k, plan.gaps), hero, base: k.base(), dark: byLum[0] ?? null, light: byLum.at(-1) ?? null, n: 0, uid: 0 };
  const apps = buildApps(c);
  const wallBoard = buildWall(c, [...plan.apps]);
  const boardsBefore = plan.boards.length;
  const slides: BoardPlan[] = [];
  const take = () => { slides.push(...plan.boards.splice(boardsBefore)); };
  const dark = c.dark;
  const base = c.base;
  const P = (g: BrandColor | null) => inks(c, g);

  // 1 Cover
  slide(c, 'cover', 'Brand presentation', hero, h('div', { display: 'flex', flexDirection: 'column', width: `${W}px`, height: `${H}px`, position: 'relative' }, [
    h('div', { position: 'absolute', left: '0px', bottom: '0px' }, device(c, W, 520)),
    h('div', { position: 'absolute', left: '96px', top: '320px', display: 'flex', flexDirection: 'column', gap: '40px' }, [
      logoOn(c, hero, 560),
      txt(c, 'p', 30, story.date ?? formatDate(env.date), { color: P(hero).fg }, 'body', 'Date'),
    ]),
  ]), { template: 'hero', kind: 'narrative', bleed: true, shot: 'distance' }, { pad: false });
  take();

  // 2 Where we started
  if (story.started_from) {
    slide(c, 'start', 'Where we started', base, h('div', { display: 'flex', flexDirection: 'column', gap: '64px', justifyContent: 'center', flex: '1' }, [
      txt(c, 'h1', 88, story.started_from, { color: P(base).fg, maxWidth: '1400px' }, 'display', 'Line'),
      story.old_logo ? h('div', { display: 'flex', alignItems: 'center', gap: '24px' }, [h('img', { width: '160px', height: '80px', objectFit: 'contain', opacity: '0.8' }, [], { src: story.old_logo, alt: 'The mark before' }), txt(c, 'p', 22, 'The mark before', { color: P(base).muted })]) : '',
    ]), { template: 'statement', kind: 'narrative' });
    take();
  } else skip(c, 'Where we started', 'story.started_from: one line on where the brand stood before');

  // 3 Insight
  if (story.insight) {
    slide(c, 'insight', 'Insight', dark, h('div', { display: 'flex', alignItems: 'center', flex: '1' }, txt(c, 'h1', 132, story.insight, { color: P(dark).fg, maxWidth: '1600px' }, 'display', 'Insight')), { template: 'statement', kind: 'narrative' });
    take();
  } else skip(c, 'Insight', 'story.insight: the one truth about the audience the brand answers');

  // 4 Idea
  if (story.idea) {
    slide(c, 'idea', 'The idea', base, h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '48px', flex: '1' }, [
      txt(c, 'h1', 220, story.idea, { color: P(base).fg, letterSpacing: '-0.02em', maxWidth: '1700px' }, 'display', 'Idea'),
      story.idea_line ? txt(c, 'p', 40, story.idea_line, { color: P(base).muted, maxWidth: '1100px' }, 'body', 'Idea line') : '',
    ]), { template: 'statement', kind: 'narrative' });
    take();
  } else skip(c, 'The idea', 'story.idea: the idea in two to six words, and story.idea_line');

  // 5 Divider
  const divider = (key: string, label: string, ground: BrandColor | null, figure?: PatternSpec['figure']) => {
    slide(c, key, label, ground, h('div', { display: 'flex', width: `${W}px`, height: `${H}px`, position: 'relative' }, [
      h('div', { position: 'absolute', right: '0px', top: '0px' }, device(c, 960, H, figure ? { fill: 'figure', figure } : { angle: 0 })),
      h('h1', { ...k.font(k.sized(160, 'display')), color: P(ground).fg, position: 'absolute', left: '96px', bottom: '96px' }, t(label), { 'data-name': 'Title' }),
    ]), { template: 'divider', kind: 'divider', bleed: true }, { pad: false });
    take();
  };
  divider('identity', 'Identity', dark, 'mountain');

  // 6 Logo alone
  slide(c, 'logo', 'Logo', base, h('div', { display: 'flex', flexDirection: 'column', flex: '1' }, [
    h('div', { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '1' }, logoOn(c, base, 760)),
    why(c, 'logo', base),
  ]), { template: 'object', kind: 'identity', rationale: Boolean(story.rationale?.logo), shot: 'close' });
  take();

  // 7 Logo story: construction over the real mark
  const logo = k.logoFor(base) ?? k.logos()[0];
  if (logo) {
    const lw = 900;
    const lh = Math.round(lw / k.aspect(logo));
    const clear = Math.round((logo.clearSpace || lh * 0.25) * (lw / Math.max(lw, logo.minWidth || lw)));
    const line = P(base).line;
    slide(c, 'logo-story', 'Logo story', base, h('div', { display: 'flex', flexDirection: 'column', flex: '1' }, [
      h('div', { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '1' }, h('div', { position: 'relative', padding: `${clear}px`, border: `2px dashed ${line}` }, [
        k.logo(logo, lw),
        h('div', { position: 'absolute', left: `${clear}px`, top: `${clear}px`, width: `${lw}px`, height: `${lh}px`, backgroundImage: `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`, backgroundSize: `${Math.round(lh / 4)}px ${Math.round(lh / 4)}px`, opacity: '0.35' }, [], { 'data-name': 'Construction grid' }),
      ], { 'data-name': 'Construction' })),
      why(c, 'logo_story', base),
    ]), { template: 'spec', kind: 'identity', rationale: Boolean(story.rationale?.logo_story) });
    take();
  }

  // 8 Logo system
  const logos = k.logos();
  if (logos.length) {
    const cell = (g: BrandColor | null, label: string, filter?: string, l?: BrandLogo) => h('div', { display: 'flex', flexDirection: 'column', gap: '16px', flex: '1', minWidth: '0' }, [
      h('div', { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '360px', backgroundColor: k.c(g, '#ffffff') }, (l ? k.logo(l, 300, filter ? { filter } : {}) : logoOn(c, g, 300, filter ? { filter } : {}))),
      txt(c, 'p', 22, label, { color: P(base).muted }),
    ], { 'data-name': label });
    const cells = [
      ...logos.slice(0, 3).map((l) => cell(k.colorFor(l.background) ?? base, l.name, undefined, l)),
      cell(c.light, 'Mono, on light', 'brightness(0)'),
      cell(dark, 'Reversed, on dark', 'brightness(0) invert(1)'),
    ].slice(0, 5);
    slide(c, 'logo-system', 'Logo system', base, h('div', { display: 'flex', flexDirection: 'column', gap: '48px', flex: '1' }, [
      h('div', { display: 'flex', gap: '24px', marginTop: '48px' }, cells, { 'data-name': 'Suite' }),
      why(c, 'logo', base),
    ]), { template: 'specimen', kind: 'system', rationale: Boolean(story.rationale?.logo), dense: true });
    take();
  }

  // 9 Colour
  const pal = colors.slice(0, 7);
  slide(c, 'colour', 'Colour', base, h('div', { display: 'flex', flexDirection: 'column', gap: '40px', flex: '1' }, [
    h('div', { display: 'flex', gap: '16px', height: '560px' }, pal.map((col) => h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: '8px', flex: col.id === hero?.id ? '2.4' : '1', minWidth: '0', backgroundColor: k.c(col), padding: '24px', boxSizing: 'border-box', ...(base && contrastRatio(col.value, base.value) < 1.25 ? { border: `1px solid ${P(base).line}` } : {}) }, [
      txt(c, 'p', 26, col.name, { color: P(col).fg }, 'body', 'Name', 700),
      txt(c, 'p', 20, col.role || 'Colour', { color: P(col).fg }, 'body', 'Role'),
      txt(c, 'p', 20, k.hex(col).toUpperCase(), { color: P(col).fg }, 'mono', 'Hex'),
    ], { 'data-name': `Swatch ${col.name}` })), { 'data-name': 'Palette' }),
    why(c, 'colour', base),
  ]), { template: 'specimen', kind: 'identity', rationale: Boolean(story.rationale?.colour) });
  take();

  // 10 Type
  const display = k.family('display');
  const steps = k.steps().slice(0, 6);
  const specimenLine = story.display_lines?.[0] ?? story.idea ?? k.name;
  slide(c, 'type', 'Type', base, h('div', { display: 'flex', flexDirection: 'column', gap: '40px', flex: '1' }, [
    h('div', { display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '64px', alignItems: 'end' }, [
      h('div', { display: 'flex', flexDirection: 'column', gap: '16px' }, [
        txt(c, 'p', 24, display ? `${display.family}${display.license ? `, ${display.license}` : ''}` : 'Display', { color: P(base).muted }, 'body', 'Family'),
        txt(c, 'h1', 128, specimenLine, { color: P(base).fg }, 'display', 'Specimen'),
      ]),
      h('div', { display: 'flex', flexDirection: 'column', gap: '10px' }, steps.map((st) => h('div', { display: 'flex', justifyContent: 'space-between', gap: '24px', borderTop: `1px solid ${P(base).line}`, paddingTop: '10px' }, [
        txt(c, 'p', 22, st.name, { color: P(base).fg }, 'body', 'Step', 700),
        txt(c, 'p', 22, `${st.size}px${st.weight ? ` · ${st.weight}` : ''}${st.lineHeight ? ` · ${st.lineHeight}` : ''}${st.tracking ? ` · ${st.tracking}` : ''}`, { color: P(base).muted, fontVariantNumeric: 'tabular-nums' }, 'mono', 'Values'),
      ], { 'data-name': `Step ${st.name}` })), { 'data-name': 'Scale' }),
    ]),
    why(c, 'type', base),
  ]), { template: 'specimen', kind: 'identity', rationale: Boolean(story.rationale?.type), shot: 'close' });
  take();

  // 11 Graphic device full bleed
  slide(c, 'device', 'Graphic device', dark, h('div', { display: 'flex', width: `${W}px`, height: `${H}px`, position: 'relative' }, [
    h('div', { position: 'absolute', left: '0px', top: '0px' }, device(c, W, H, { threshold: Math.max(0.2, c.device.threshold - 0.15) })),
    story.rationale?.device ? h('div', { position: 'absolute', left: '96px', bottom: '96px', maxWidth: '900px', padding: '32px', backgroundColor: k.c(dark) }, txt(c, 'p', 32, story.rationale.device, { color: P(dark).fg }, 'body', 'Rationale')) : '',
  ]), { template: 'hero', kind: 'identity', bleed: true, rationale: Boolean(story.rationale?.device) }, { pad: false });
  if (!story.rationale?.device) plan.gaps.push('No reason for the graphic device: give story.rationale.device.');
  take();

  // 12 Photography
  const photos = story.photos ?? [];
  if (photos.length >= 3) {
    const r = cropRatio(story.photo_crop);
    const count = Math.min(photos.length, r >= 1.4 ? 4 : 5);
    const gap = 16;
    const wEach = Math.floor((W - 192 - gap * (count - 1)) / count);
    slide(c, 'photography', 'Photography', base, h('div', { display: 'flex', flexDirection: 'column', gap: '40px', flex: '1' }, [
      h('div', { display: 'flex', gap: `${gap}px`, alignItems: 'flex-end' }, photos.slice(0, count).map((src) => photo(c, src, wEach, Math.min(620, Math.round(wEach / r))))),
      story.photo_rule ? txt(c, 'p', 30, story.photo_rule, { color: P(base).fg, maxWidth: '1100px' }, 'body', 'Crop rule') : '',
      why(c, 'photography', base),
    ]), { template: 'specimen', kind: 'identity', photo: true, rationale: Boolean(story.rationale?.photography), dense: true });
    take();
  } else skip(c, 'Photography', 'story.photos: three to six photos of the brand\'s world (asset_upload), with photo_crop and photo_rule');

  // 13 Voice
  const principles = story.voice?.principles ?? [];
  if (principles.length) {
    slide(c, 'voice', 'Voice', base, h('div', { display: 'flex', flexDirection: 'column', gap: '48px', flex: '1' }, [
      h('div', { display: 'grid', gridTemplateColumns: `repeat(${Math.min(3, principles.length)}, 1fr)`, gap: '48px' }, principles.slice(0, 3).map((pr) => h('div', { display: 'flex', flexDirection: 'column', gap: '16px', borderTop: `3px solid ${k.c(hero)}`, paddingTop: '24px' }, [
        txt(c, 'h2', 56, pr.name, { color: P(base).fg }, 'display', 'Principle'),
        txt(c, 'p', 26, pr.line, { color: P(base).muted }, 'body', 'Principle line'),
      ]))),
      story.voice?.in_voice && story.voice.out_of_voice ? h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '48px' }, [
        h('div', { display: 'flex', flexDirection: 'column', gap: '12px' }, [txt(c, 'p', 22, 'In our voice', { color: P(base).muted }, 'body', 'Label', 700), txt(c, 'p', 36, story.voice.in_voice, { color: P(base).fg }, 'body', 'In voice')]),
        h('div', { display: 'flex', flexDirection: 'column', gap: '12px', opacity: '0.7' }, [txt(c, 'p', 22, 'Not our voice', { color: P(base).muted }, 'body', 'Label', 700), txt(c, 'p', 36, story.voice.out_of_voice, { color: P(base).fg, textDecoration: 'line-through' }, 'body', 'Out of voice')], { ...DONT, 'data-name': 'Out of voice example' }),
      ]) : '',
      why(c, 'voice', base),
    ]), { template: 'evidence', kind: 'identity', rationale: Boolean(story.rationale?.voice) });
    take();
  } else skip(c, 'Voice', 'story.voice.principles: three principles, each a name and a line, plus in_voice and out_of_voice');

  // 14 Motion: six frames of the logo building from the device
  slide(c, 'motion', 'Motion', dark, h('div', { display: 'flex', flexDirection: 'column', gap: '40px', flex: '1' }, [
    h('div', { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '16px', marginTop: '40px' }, [0, 1, 2, 3, 4, 5].map((i) => h('div', { display: 'flex', flexDirection: 'column', gap: '12px' }, [
      h('div', { position: 'relative', width: '272px', height: '272px', overflow: 'hidden', backgroundColor: k.c(i < 4 ? dark : hero) }, [
        h('div', { position: 'absolute', left: '0px', top: '0px' }, device(c, 272, 272, { fill: 'radial', radius: 0.15 + i * 0.18, threshold: 0.3, roughness: 0.2 })),
        i >= 3 ? h('div', { position: 'absolute', left: '0px', top: '0px', width: '272px', height: '272px', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: String(Math.min(1, (i - 2) / 3)) }, logoOn(c, i < 4 ? dark : hero, 180)) : '',
      ]),
      txt(c, 'p', 20, `${i * 120} ms`, { color: P(dark).muted, fontVariantNumeric: 'tabular-nums' }, 'mono', 'Time'),
    ]))),
    story.motion_rule ? txt(c, 'p', 32, story.motion_rule, { color: P(dark).fg, maxWidth: '1100px' }, 'body', 'Motion rule') : '',
    why(c, 'motion', dark),
  ]), { template: 'spec', kind: 'identity', rationale: Boolean(story.rationale?.motion), dense: true });
  if (!story.motion_rule) plan.gaps.push('No motion rule: give story.motion_rule, how things move, one transition rule and the reduced-motion alternative.');
  take();

  // 15 Divider
  divider('world', 'In the world', hero, 'wave');

  // 16 Hero application full bleed
  const heroBoard = apps.ooh[0] ?? apps.posters[0] ?? apps.sign;
  if (heroBoard) {
    const scene = story.hero_scene ?? (apps.ooh[0] ? 'billboard' : 'poster-wall');
    slide(c, 'hero-app', 'Hero application', base, h('div', { width: `${W}px`, height: `${H}px`, display: 'flex' }, place(c, heroBoard, W, H, scene)), { template: 'hero', kind: 'world', bleed: true, shot: 'distance' }, { pad: false, chrome: false });
    take();
  }

  // 17 Social
  if (apps.social.length) {
    const tile = 220;
    slide(c, 'social', 'Social', base, h('div', { display: 'flex', gap: '64px', flex: '1', alignItems: 'flex-start', marginTop: '24px' }, [
      h('div', { display: 'grid', gridTemplateColumns: `repeat(3, ${tile}px)`, gap: '6px' }, apps.social.map((b) => place(c, b, tile, Math.round(tile * 1.25)))),
      h('div', { display: 'flex', gap: '24px' }, apps.stories.map((b) => place(c, b, 240, 427))),
      h('div', { display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '420px' }, (story.social?.posts ?? []).slice(0, 3).map((post) => txt(c, 'p', 22, post.caption, { color: P(base).muted }, 'body', 'Caption'))),
    ]), { template: 'grid-9', kind: 'world', dense: true });
    take();
  } else skip(c, 'Social', 'story.social.posts: up to nine posts, each a headline and its caption, and story.social.stories');

  // 18 Product: icon at sizes and screens
  if (apps.icon) {
    const screens = story.app?.screens ?? [];
    slide(c, 'product', 'Product', dark, h('div', { display: 'flex', gap: '96px', alignItems: 'center', flex: '1' }, [
      h('div', { display: 'flex', gap: '48px', alignItems: 'flex-end' }, [[360, '1024'], [180, '180'], [60, '60']].map(([size, label]) => h('div', { display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center' }, [
        place(c, apps.icon!, Number(size), Number(size), undefined, { borderRadius: `${Math.round(Number(size) * 0.22)}px` }),
        txt(c, 'p', 20, `${label} px`, { color: P(dark).muted, fontVariantNumeric: 'tabular-nums' }, 'mono', 'Size'),
      ]))),
      h('div', { display: 'flex', gap: '24px' }, screens.slice(0, 3).map((id) => place(c, id, 360, 270, 'phone'))),
    ]), { template: 'object', kind: 'world', shot: 'close' });
    if (!screens.length) plan.gaps.push('Product shows the app icon only: pass story.app.screens, ids of app screen artboards, to show them on phones.');
    take();
  }

  // 19 Out of home
  if (apps.ooh.length) {
    slide(c, 'ooh', 'Out of home', base, h('div', { display: 'flex', gap: '24px', alignItems: 'flex-end', flex: '1' }, [
      place(c, apps.ooh[0]!, 900, 675, 'billboard'),
      apps.ooh[1] ? place(c, apps.ooh[1], 560, 420, 'poster-wall') : '',
      apps.ooh[2] ? place(c, apps.ooh[2], 236, 420) : '',
    ]), { template: 'application', kind: 'world', shot: 'distance' });
    take();
  } else skip(c, 'Out of home', 'story.campaign_lines: two or three campaign lines in the brand\'s voice');

  // 20 Print and email
  if (apps.print.length || apps.email) {
    slide(c, 'print', 'Print and email', c.light, h('div', { display: 'flex', gap: '48px', alignItems: 'flex-end', flex: '1' }, [
      apps.print[0] ? place(c, apps.print[0], 500, 708, undefined, { border: `1px solid ${P(c.light).line}` }) : '',
      apps.print[1] ? place(c, apps.print[1], 420, 240) : '',
      apps.email ? place(c, apps.email, 400, 733, undefined, { border: `1px solid ${P(c.light).line}` }) : '',
    ]), { template: 'object', kind: 'world', shot: 'close' });
    take();
  } else skip(c, 'Print and email', 'story.contact (real address, web or email) and story.email (subject, headline, body, action)');

  // 21 Physical: one thing large and close, the rest beside it.
  if (apps.merch) {
    slide(c, 'physical', 'Things people carry', base, h('div', { display: 'flex', gap: '24px', flex: '1', alignItems: 'stretch', minHeight: '0' }, [
      place(c, apps.merch, 1160, 870, 'tote-bag'),
      h('div', { display: 'flex', flexDirection: 'column', gap: '24px' }, ['cap', 'packet', 'badge-lanyard'].map((scene) => place(c, apps.merch!, 360, 270, scene))),
    ]), { template: 'application', kind: 'world', shot: 'close' });
    take();
  }

  // 22 Environment
  if (apps.sign) {
    slide(c, 'environment', 'Places', base, h('div', { width: `${W}px`, height: `${H}px`, display: 'flex', overflow: 'hidden' }, place(c, apps.sign, W, H, 'hanging-sign')), { template: 'hero', kind: 'world', bleed: true, shot: 'close' }, { pad: false, chrome: false });
    take();
  }

  // 23 The system at scale: the wall board, shown whole.
  if (wallBoard) {
    const wb = plan.boards.find((b) => b.name === wallBoard)!;
    // The whole wall on the slide: as wide as fits under the slide's height, centred on the wall's own ground.
    const ratio = wb.width / (wb.height ?? wb.width);
    const ww = Math.min(W, Math.round(H * ratio));
    slide(c, 'wall', 'The system', dark, h('div', { width: `${W}px`, height: `${H}px`, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }, place(c, wallBoard, ww, Math.round(ww / ratio), undefined, {}, { ...SPECIMEN })), { template: 'wall', kind: 'world', dense: true, bleed: true }, { pad: false, chrome: false });
    take();
  }

  // 24 Why it works
  if (story.proof_points?.length) {
    slide(c, 'why', 'Why it works', base, h('div', { display: 'flex', flexDirection: 'column', gap: '64px', flex: '1', justifyContent: 'center' }, [
      txt(c, 'h1', 120, story.idea ?? '', { color: P(base).fg }, 'display', 'Idea'),
      h('div', { display: 'grid', gridTemplateColumns: `repeat(${Math.min(3, story.proof_points.length)}, 1fr)`, gap: '48px' }, story.proof_points.slice(0, 3).map((pt, i) => h('div', { display: 'flex', flexDirection: 'column', gap: '12px', borderTop: `3px solid ${k.c(hero)}`, paddingTop: '20px' }, [
        txt(c, 'p', 48, String(i + 1), { color: P(base).muted, fontVariantNumeric: 'tabular-nums' }, 'display', 'Number'),
        txt(c, 'p', 30, pt, { color: P(base).fg }, 'body', 'Proof'),
      ]))),
    ]), { template: 'evidence', kind: 'narrative' });
    take();
  } else skip(c, 'Why it works', 'story.proof_points: three reasons the idea works');

  // 25 Next steps
  if (story.next_steps?.length) {
    slide(c, 'next', 'Next steps', base, h('div', { display: 'flex', flexDirection: 'column', gap: '8px', flex: '1', justifyContent: 'center', maxWidth: '1400px' }, story.next_steps.slice(0, 6).map((st) => h('div', { display: 'grid', gridTemplateColumns: '320px 1fr', gap: '48px', padding: '28px 0', borderTop: `1px solid ${P(base).line}` }, [
      txt(c, 'p', 30, st.when, { color: P(base).muted, fontVariantNumeric: 'tabular-nums' }, 'body', 'When', 700),
      txt(c, 'p', 40, st.what, { color: P(base).fg }, 'display', 'What'),
    ]))), { template: 'evidence', kind: 'narrative' });
    take();
  } else skip(c, 'Next steps', 'story.next_steps: when and what, for the rollout');

  // 26 Close
  slide(c, 'close', 'Close', hero, h('div', { display: 'flex', flexDirection: 'column', width: `${W}px`, height: `${H}px`, position: 'relative' }, [
    h('div', { position: 'absolute', left: '0px', top: '0px' }, device(c, W, 360, { angle: 270 })),
    h('div', { position: 'absolute', left: '96px', bottom: '120px', display: 'flex', flexDirection: 'column', gap: '48px' }, [
      story.close ? txt(c, 'h1', 132, story.close, { color: P(hero).fg, maxWidth: '1500px' }, 'display', 'Close line') : '',
      logoOn(c, hero, 320),
    ]),
  ]), { template: 'hero', kind: 'narrative', bleed: true }, { pad: false, chrome: false });
  if (!story.close) plan.gaps.push('No closing line: give story.close.');
  take();

  // Slides first, then the applications they show, in a row of their own below.
  plan.boards = [...slides, ...plan.boards];
  return plan;
}

/** The colour data a guideline needs beyond the swatch: for the colour chapter of the book and the site. */
export function colourFacts(k: BrandKit): { name: string; role: string; hex: string; rgb: string; cmyk: string; token: string; pairs: { on: string; ratio: number; pass: boolean }[] }[] {
  return k.colors.map((col) => ({
    name: col.name, role: col.role, hex: k.hex(col).toUpperCase(), rgb: rgb(col.value).join(' '), cmyk: cmyk(col.value), token: col.token,
    pairs: k.colors.filter((o) => o.id !== col.id).map((o) => {
      const ratio = Math.round(contrastRatio(col.value, o.value) * 100) / 100;
      return { on: o.name, ratio, pass: ratio >= k.data.fields.minContrast };
    }),
  }));
}

export { SPECIMEN };

// ---------------------------------------------------------------- the guidelines book

const BW = 1600;
const BH = 1132;

/** One page of the book: an index tab of chapters on the left, the chapter on the right. */
function page(c: Ctx, chapter: string, title: string, intro: string | undefined, body: string, meta: Omit<SlideMeta, 'n' | 'key'>): void {
  const base = c.base;
  const p = inks(c, base);
  c.n++;
  const chapters = ['Logo', 'Colour', 'Type', 'Grid', 'Device', 'Imagery', 'Voice', 'Applications'];
  c.plan.boards.push({
    name: `Book ${String(c.n).padStart(2, '0')} ${title}`, width: BW, height: BH, background: c.k.c(base, '#ffffff'), color: p.fg, font: c.k.stack(c.k.family('body')),
    attrs: { [SLIDE_ATTR]: JSON.stringify({ n: c.n, key: `book-${chapter.toLowerCase()}`, ...meta } satisfies SlideMeta) },
    steps: [{ html: h('div', { display: 'grid', gridTemplateColumns: '200px 1fr', width: `${BW}px`, height: `${BH}px`, overflow: 'hidden' }, [
      h('nav', { display: 'flex', flexDirection: 'column', gap: '10px', padding: '56px 32px', borderRight: `1px solid ${p.line}` }, [
        txt(c, 'p', 16, c.k.name, { color: p.fg, marginBottom: '24px' }, 'body', 'Brand', 700),
        ...chapters.map((ch) => txt(c, 'p', 16, ch, { color: ch === chapter ? p.fg : p.muted, fontWeight: ch === chapter ? '700' : '400' }, 'body', 'Chapter')),
      ], { 'data-name': 'Index' }),
      h('div', { display: 'flex', flexDirection: 'column', gap: '32px', padding: '56px 64px', minWidth: '0' }, [
        h('header', { display: 'flex', flexDirection: 'column', gap: '12px' }, [
          txt(c, 'h1', 56, title, { color: p.fg }, 'display', 'Title'),
          intro ? txt(c, 'p', 20, intro, { color: p.muted, maxWidth: '760px' }, 'body', 'Intro') : '',
        ]),
        body,
      ], { 'data-name': 'Chapter' }),
    ]) }],
  });
}

export function buildBook(env: TemplateEnv, story: BrandStory): PresentationPlan {
  const k = new BrandKit(env);
  const plan: PresentationPlan = { page: 'Brand guidelines', boards: [], apps: [], placements: [], devices: [], skipped: [], gaps: [] };
  const byLum = [...k.colors].sort((a, b) => luminance(a.value) - luminance(b.value));
  const hero = (story.hero_colour ? k.colorFor(story.hero_colour) : null) ?? k.accent();
  const c: Ctx = { k, s: story, plan, device: deviceSpec(k, plan.gaps), hero, base: k.base(), dark: byLum[0] ?? null, light: byLum.at(-1) ?? null, n: 0, uid: 0 };
  const base = c.base;
  const p = inks(c, base);
  const logo = k.logoFor(base) ?? k.logos()[0];

  if (logo) {
    const lw = 560;
    const lh = Math.round(lw / k.aspect(logo));
    const clear = Math.round(logo.clearSpace ? (logo.clearSpace * lw) / Math.max(logo.minWidth || lw, 1) : lh * 0.5);
    page(c, 'Logo', 'Clear space and size', `Keep ${logo.clearSpace ? `${logo.clearSpace}px` : 'the height of the mark'} free around the logo at every size, and never set it narrower than ${logo.minWidth ? `${logo.minWidth}px on screen (${Math.round((logo.minWidth / 96) * 25.4)} mm in print)` : 'its minimum width, which the brand has not set yet'}.`, h('div', { display: 'flex', gap: '64px', alignItems: 'center' }, [
      h('div', { position: 'relative', padding: `${clear}px`, backgroundImage: `repeating-linear-gradient(45deg, transparent 0 8px, ${p.line} 8px 9px)` }, [h('div', { backgroundColor: k.c(base, '#ffffff') }, k.logo(logo, lw))], { 'data-name': 'Clear space' }),
      h('div', { display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'flex-start' }, [
        txt(c, 'p', 18, 'Minimum width', { color: p.muted }, 'body', 'Label', 700),
        k.logo(logo, Math.max(logo.minWidth, 60)),
        txt(c, 'p', 18, logo.minWidth ? `${logo.minWidth} px` : 'not set', { color: p.fg, fontVariantNumeric: 'tabular-nums' }, 'mono', 'Min width'),
      ], { ...SPECIMEN, 'data-name': 'Minimum size' }),
    ]), { template: 'spec', kind: 'system', rationale: true });
    if (!logo.minWidth || !logo.clearSpace) plan.gaps.push('The logo has no minimum width or clear space: set them on the logo with brand_update.');
    // The misuse grid, made by doing the wrong thing to the real logo.
    const dont = (label: string, style: Style, ground: string) => h('div', { display: 'flex', flexDirection: 'column', gap: '10px' }, [
      h('div', { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '220px', background: ground, overflow: 'hidden' }, k.logo(logo, 240, style)),
      txt(c, 'p', 16, label, { color: p.fg }, 'body', 'Rule'),
    ], { ...DONT, 'data-name': `Do not: ${label}` });
    const near = k.colors.find((x) => x.id !== base?.id && contrastRatio(x.value, base?.value ?? '#ffffff') < 1.6);
    page(c, 'Logo', 'Do not', 'Each of these is the real logo, changed in a way the brand does not allow.', h('div', { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '24px' }, [
      dont('Do not stretch it', { transform: 'scaleX(1.45)' }, k.c(base, '#fff')),
      dont('Do not rotate it', { transform: 'rotate(-14deg)' }, k.c(base, '#fff')),
      dont('Do not recolour it', { filter: 'hue-rotate(150deg) saturate(2)' }, k.c(base, '#fff')),
      dont('Do not set it on a ground without contrast', { opacity: '0.9' }, k.c(near ?? base, '#eee')),
      dont('Do not set it on a busy ground', {}, `repeating-linear-gradient(60deg, ${k.c(hero)} 0 14px, ${k.c(c.light)} 14px 28px)`),
      dont('Do not add effects', { filter: 'drop-shadow(6px 8px 6px rgba(0,0,0,.45))' }, k.c(base, '#fff')),
    ]), { template: 'pair', kind: 'system', rationale: true, dense: true });
  } else plan.skipped.push({ slide: 'Logo pages', needs: 'a logo in the brand (brand_asset_add kind logo)' });

  const facts = colourFacts(k);
  page(c, 'Colour', 'Colour values', 'Screen values first. CMYK is computed for uncoated stock and is a start for your printer, not a match; Pantone is what the brand states.', h('div', { display: 'grid', gridTemplateColumns: `repeat(${Math.min(4, facts.length)}, 1fr)`, gap: '16px' }, facts.slice(0, 8).map((f, i) => {
    const col = k.colors[i]!;
    const note = col.note && /pantone|pms/i.test(col.note) ? col.note : 'Pantone not set';
    return h('div', { display: 'flex', flexDirection: 'column', gap: '6px' }, [
      h('div', { height: '160px', backgroundColor: k.c(col), ...(base && contrastRatio(col.value, base.value) < 1.25 ? { border: `1px solid ${p.line}` } : {}) }),
      txt(c, 'p', 18, f.name, { color: p.fg }, 'body', 'Name', 700),
      txt(c, 'p', 15, f.role || 'Colour', { color: p.muted }, 'body', 'Role'),
      ...[`HEX ${f.hex}`, `RGB ${f.rgb}`, `CMYK ${f.cmyk}`, note, `var(--${f.token})`].map((v) => txt(c, 'p', 15, v, { color: p.fg, fontVariantNumeric: 'tabular-nums' }, 'mono', 'Value')),
    ], { 'data-name': `Colour ${f.name}` });
  })), { template: 'specimen', kind: 'system', rationale: true, dense: true });

  const list = k.colors.slice(0, 7);
  page(c, 'Colour', 'Every pair', `Text on each colour, with its contrast. Pairs under ${k.data.fields.minContrast}:1 are crossed out: do not set text in them.`, h('div', { display: 'grid', gridTemplateColumns: `140px repeat(${list.length}, 1fr)`, gap: '4px' }, [
    h('div', {}, txt(c, 'p', 14, 'Text on', { color: p.muted })),
    ...list.map((bg) => txt(c, 'p', 14, bg.name, { color: p.muted }, 'body', 'Ground')),
    ...list.flatMap((fg) => [
      txt(c, 'p', 15, fg.name, { color: p.fg, alignSelf: 'center' }, 'body', 'Text colour', 700),
      ...list.map((bg) => {
        const ratio = Math.round(contrastRatio(fg.value, bg.value) * 10) / 10;
        const pass = fg.id !== bg.id && ratio >= k.data.fields.minContrast;
        return h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '84px', backgroundColor: k.c(bg) }, fg.id === bg.id ? '' : [
          h('p', { ...k.font(role(c, 24, 'display', 700)), color: k.c(fg), textDecoration: pass ? 'none' : 'line-through' }, 'Aa'),
          h('p', { ...k.font(role(c, 14, 'mono')), color: pass ? k.c(fg) : inks(c, bg).fg, fontVariantNumeric: 'tabular-nums' }, `${ratio}:1${pass ? '' : ' no'}`),
        ], pass ? { 'data-name': 'Pair' } : { ...DONT, 'data-name': 'Failing pair' });
      }),
    ]),
  ]), { template: 'pair', kind: 'system', rationale: true, dense: true });

  const steps = k.steps();
  page(c, 'Type', 'Type scale', `${k.families().map((f) => `${f.family} (${f.role}${f.license ? `, ${f.license}` : ''}, fallback ${f.fallback || 'system'})`).join('; ') || 'No families yet.'}`, h('div', { display: 'flex', flexDirection: 'column', gap: '6px' }, steps.slice(0, 8).map((st) => h('div', { display: 'grid', gridTemplateColumns: '1fr 360px', gap: '32px', alignItems: 'baseline', borderTop: `1px solid ${p.line}`, paddingTop: '8px' }, [
    h('p', { ...k.font(k.sized(Math.min(st.size, 96), /\bmono|code\b/i.test(st.role) ? 'mono' : st.size >= 28 ? 'display' : 'body', st.weight || undefined)), color: p.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, t(story.display_lines?.[0] ?? story.idea ?? k.name), { 'data-name': `Sample ${st.name}`, title: story.display_lines?.[0] ?? story.idea ?? k.name }),
    txt(c, 'p', 15, `${st.name} · ${st.size}px · ${st.weight || 400} · leading ${st.lineHeight || 'auto'} · tracking ${st.tracking || '0'}`, { color: p.muted, fontVariantNumeric: 'tabular-nums' }, 'mono', 'Values'),
  ]))), { template: 'specimen', kind: 'system', rationale: true, dense: true });

  const gap = k.spacePx(24);
  const margin = k.spacePx(96);
  page(c, 'Grid', 'Grid', `${k.data.fields.grid || '12 columns'} with ${gap}px gutters and ${margin}px margins at 1920, from the spacing scale: ${k.data.spacing.map((s) => s.value).join(', ') || 'not set yet'}.`, h('div', { position: 'relative', height: '640px', backgroundColor: k.c(c.light), padding: `0 ${Math.round(margin / 2)}px`, display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: `${Math.round(gap / 2)}px` }, Array.from({ length: 12 }, (_, i) => h('div', { backgroundColor: k.c(hero), opacity: '0.18' }, [], { 'data-name': `Column ${i + 1}` })), { ...SPECIMEN, 'data-name': 'Grid' }), { template: 'spec', kind: 'system', rationale: true });

  const dv = c.device;
  page(c, 'Device', 'Graphic device', `The rule: ${dv.cell} cells, ${dv.columns} by ${dv.rows} at full bleed, filled by ${dv.fill}${dv.figure ? ` (${dv.figure})` : ''} above ${dv.threshold}, roughness ${dv.roughness}, gap ${dv.gap}, in ${dv.colors.join(', ')}. The same rule is a texture, a figure and a chart.`, h('div', { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '16px', alignItems: 'end' }, [
    h('div', { backgroundColor: k.c(c.dark) }, device(c, 640, 400)),
    h('div', { backgroundColor: k.c(c.dark) }, device(c, 300, 300, { fill: 'figure', figure: 'mountain' })),
    h('div', { display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'flex-start' }, [
      h('div', { backgroundColor: k.c(c.dark) }, device(c, 300, 200, { fill: 'bars', values: [0.3, 0.55, 0.42, 0.8, 0.66], roughness: 0, threshold: 0.5 })),
      h('div', { backgroundColor: k.c(hero) }, device(c, 32, 32, { threshold: 0.3 })),
    ]),
  ]), { template: 'specimen', kind: 'system', rationale: true });

  return plan;
}
