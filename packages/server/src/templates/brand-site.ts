import { contrastRatio, luminance, normalizeColor, normalizePatternSpec, renderPattern, type BrandColor, type PatternSpec } from '@bogen/core';
import { BrandKit, DONT, SPECIMEN, formatDate, h, t, type Style, type TemplateEnv } from './kit.ts';
import { colourFacts, deviceSpec, type BrandStory, type Placement } from './brand-presentation.ts';
import type { BoardPlan } from './types.ts';

/**
 * A brand's guidelines as a website: the living source a team and its agents work from, drawn from the brand's
 * data. Chapters with a nav, version and changelog; colour with its roles, values to copy, the share each colour
 * really has across the brand's applications (measured, not estimated) and every contrast pair including the ones
 * that fail; tokens to copy in five formats; type with a tester; the logo with its clear space and construction;
 * the device as a rule; photography; voice; live applications; motion that moves; and a "so not" in each chapter.
 *
 * On the canvas it is one long artboard. Published, a small script of the site itself (brand-site.js, no inline
 * script) makes the copy buttons copy and the tester's controls work; without it everything still reads.
 * No two neighbouring chapters open the same way.
 */

export const BRAND_SITE_ATTR = 'data-bogen-brand-site';
export const SITE_WIDTH = 1440;
const NAV = 248;
const PAD = 64;
const MAIN = SITE_WIDTH - NAV;
const INNER = MAIN - PAD * 2;

export type SiteOpener = 'split' | 'bleed' | 'measure' | 'tester' | 'rule' | 'gallery' | 'quote' | 'wall' | 'motion' | 'list';

export interface SiteInput {
  story: BrandStory & {
    /** One headline per chapter in the brand's voice, such as colour: "Mostly kraft. Shoot only where something grows." */
    chapters?: Partial<Record<'idea' | 'logo' | 'colour' | 'type' | 'device' | 'photography' | 'voice' | 'applications' | 'motion' | 'downloads', string>>;
  };
  /** Share of each colour across the brand's applications, measured from their pixels. */
  share?: { token: string; name: string; hex: string; share: number }[];
  shareSource?: string;
  versions?: { n: number; at: number; note: string }[];
  /** The brand's application boards in this file, shown live, with their size. */
  applications?: { id: string; width: number; height: number }[];
  /** The keyframes the motion chapter plays, by name, already in the file. */
  motion?: { name: string; duration: number; easing: string; stagger: number };
}

export interface SitePlan {
  board: BoardPlan;
  placements: Placement[];
  devices: { layer: string; spec: PatternSpec }[];
  openers: SiteOpener[];
  gaps: string[];
}

/** sRGB hex to OKLCH, as `oklch(L C H)` with L in percent. */
export function oklch(hex: string): string {
  const v = normalizeColor(hex) ?? '#000000';
  const lin = [1, 3, 5].map((i) => {
    const c = Number.parseInt(v.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  const H = C < 0.0001 ? 0 : (Math.atan2(B, A) * 180 / Math.PI + 360) % 360;
  return `oklch(${(L * 100).toFixed(1)}% ${C.toFixed(3)} ${H.toFixed(1)})`;
}

/** The brand's tokens as files: CSS, JSON, Tailwind, Swift and Kotlin. */
export function tokenExports(tokens: Map<string, string>, colors: BrandColor[]): Record<'CSS' | 'JSON' | 'Tailwind' | 'Swift' | 'Kotlin', string> {
  const entries = [...tokens.entries()].sort(([a], [b]) => a.localeCompare(b));
  const camel = (n: string) => n.replace(/-([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());
  const hexes = colors.map((c) => [c.token, normalizeColor(c.value) ?? c.value] as const).filter(([, v]) => /^#[0-9a-f]{6}$/i.test(v));
  const rgb = (hx: string) => [1, 3, 5].map((i) => (Number.parseInt(hx.slice(i, i + 2), 16) / 255).toFixed(3));
  return {
    CSS: `:root {\n${entries.map(([n, v]) => `  --${n}: ${v};`).join('\n')}\n}`,
    JSON: JSON.stringify(Object.fromEntries(entries), null, 2),
    Tailwind: `// tailwind.config.js\nexport default {\n  theme: { extend: { colors: {\n${hexes.map(([n]) => `    '${n}': 'var(--${n})',`).join('\n')}\n  } } },\n};`,
    Swift: `import SwiftUI\n\nextension Color {\n${hexes.map(([n, v]) => { const [r, g, b] = rgb(v); return `  static let ${camel(n)} = Color(red: ${r}, green: ${g}, blue: ${b})`; }).join('\n')}\n}`,
    Kotlin: `import androidx.compose.ui.graphics.Color\n\nobject BrandColors {\n${hexes.map(([n, v]) => `  val ${camel(n)} = Color(0xFF${v.slice(1).toUpperCase()})`).join('\n')}\n}`,
  };
}

export function buildBrandSite(env: TemplateEnv, input: SiteInput): SitePlan {
  const k = new BrandKit(env);
  const s = input.story;
  const gaps: string[] = [];
  const placements: Placement[] = [];
  const devices: SitePlan['devices'] = [];
  const openers: SiteOpener[] = [];
  const spec = deviceSpec(k, gaps);
  let uid = 0;
  const byLum = [...k.colors].sort((a, b) => luminance(a.value) - luminance(b.value));
  const base = k.base();
  const dark = byLum[0] ?? null;
  const light = byLum.at(-1) ?? null;
  const hero = (s.hero_colour ? k.colorFor(s.hero_colour) : null) ?? k.accent();
  const P = (g: BrandColor | null) => k.paint(k.scheme(g));
  const pb = P(base);
  const txt = (tag: string, px: number, value: string, style: Style = {}, family: 'display' | 'body' | 'mono' = 'body', layer?: string, weight?: number) => h(tag, { ...k.font(k.sized(px, family, weight, 13)), ...style }, t(value), layer ? { 'data-name': layer } : {});
  const device = (w: number, hgt: number, patch: Partial<PatternSpec> = {}) => {
    const cell = Math.max(8, Math.round(Math.max(w, hgt) / 40));
    const sp = normalizePatternSpec({ ...spec, columns: Math.max(1, Math.round(w / cell)), rows: Math.max(1, Math.round(hgt / cell)), ...patch });
    const layer = `Graphic device ${++uid}`;
    devices.push({ layer, spec: sp });
    return renderPattern(sp).svg.replace(/^<svg\b/, `<svg data-name="${layer}" aria-hidden="true" style="display:block;width:${w}px;height:${hgt}px;flex:none"`);
  };
  const logo = (ground: BrandColor | null, width: number, style: Style = {}) => {
    const l = k.logoFor(ground) ?? k.logos()[0];
    return l ? k.logo(l, width, style) : txt('p', Math.round(width / 4), k.name, { color: P(ground).fg, ...style }, 'display', 'Name', 700);
  };
  const place = (board: string, w: number, hgt: number, style: Style = {}) => {
    const layer = `Place ${++uid}: ${board}`;
    placements.push({ layer, board });
    return h('div', { position: 'relative', width: `${w}px`, height: `${hgt}px`, flex: 'none', overflow: 'hidden', ...style }, [], { 'data-name': layer });
  };
  const head = (key: keyof NonNullable<SiteInput['story']['chapters']>, fallback?: string) => {
    const line = s.chapters?.[key] ?? fallback;
    if (!line) gaps.push(`No headline for the ${key} chapter: give story.chapters.${key}, one line in the brand's voice.`);
    return line ?? key[0]!.toUpperCase() + key.slice(1);
  };
  const chapterLabel = (n: number, name: string, ground: BrandColor | null) => txt('p', 15, `${String(n).padStart(2, '0')} ${name}`, { color: P(ground).muted }, 'body', 'Chapter');
  const section = (id: string, ground: BrandColor | null, opener: SiteOpener, children: string[], style: Style = {}) => {
    openers.push(opener);
    return h('section', { display: 'flex', flexDirection: 'column', gap: k.space(28), padding: `${k.space(72)} ${k.space(PAD)}`, backgroundColor: k.c(ground, '#ffffff'), color: P(ground).fg, borderBottom: `1px solid ${pb.line}`, ...style }, children, { id, 'aria-labelledby': `${id}-title`, 'data-name': `Chapter ${id}` });
  };
  const so = (items: { label: string; body: string }[], ground: BrandColor | null) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12) }, [
    txt('h3', 15, 'So not', { color: P(ground).muted }, 'body', 'So not', 700),
    h('div', { display: 'grid', gridTemplateColumns: `repeat(${Math.min(4, items.length)}, 1fr)`, gap: k.space(8) }, items.map((it) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12), padding: k.space(20), backgroundColor: k.c(light, '#f4f4f4'), minWidth: '0' }, [
      h('div', { minHeight: '96px', display: 'flex', alignItems: 'center', overflow: 'hidden' }, it.body),
      txt('p', 15, it.label, { color: P(light).fg }, 'body', 'Why not'),
    ], { ...DONT, 'data-name': `So not: ${it.label}` }))),
  ], { 'data-name': 'So not' });
  const copy = (value: string, label: string, ground: BrandColor | null, shown = label) => h('button', { ...k.font(k.sized(14, 'mono', undefined, 13)), color: P(ground).fg, background: 'transparent', border: `1px solid ${P(ground).line}`, borderRadius: k.roundRadius(), padding: `${k.space(6)} ${k.space(12)}`, cursor: 'pointer', textAlign: 'left', minHeight: '32px' }, t(shown), { type: 'button', value, 'aria-label': `Copy ${label}`, title: `Copy ${label}` });

  const version = input.versions?.at(-1)?.n ?? env.version ?? 1;
  const date = formatDate(input.versions?.at(-1) ? new Date(input.versions.at(-1)!.at) : env.date);
  const chapters = ['Idea', 'Logo', 'Colour', 'Type', 'Device', 'Photography', 'Voice', 'Applications', 'Motion', 'Downloads'];
  const ids = chapters.map((c) => c.toLowerCase());

  // ---- nav
  const nav = h('nav', { width: `${NAV}px`, flex: 'none', boxSizing: 'border-box', padding: `${k.space(40)} ${k.space(28)}`, display: 'flex', flexDirection: 'column', gap: k.space(4), borderRight: `1px solid ${pb.line}`, position: 'sticky', top: '0px', alignSelf: 'flex-start', maxHeight: '100vh', overflow: 'auto' }, [
    logo(base, 120),
    txt('p', 14, `Brand guidelines, version ${version}, ${date}`, { color: pb.muted, marginTop: k.space(8), marginBottom: k.space(24) }, 'body', 'Version'),
    ...chapters.map((c, i) => h('a', { ...k.font(k.sized(15, 'body', undefined, 13)), color: pb.fg, textDecoration: 'none', display: 'flex', gap: k.space(12), padding: `${k.space(6)} 0px`, minHeight: '24px' }, [h('span', { color: pb.muted, width: '22px', fontVariantNumeric: 'tabular-nums' }, String(i + 1).padStart(2, '0')), h('span', {}, t(c))], { href: `#${ids[i]}` })),
    ...(input.versions?.length ? [
      txt('h2', 14, 'Changes', { color: pb.fg, marginTop: k.space(28) }, 'body', 'Changes title', 700),
      ...input.versions.slice(-4).reverse().map((v) => txt('p', 13, `v${v.n}, ${formatDate(new Date(v.at))}${v.note ? `: ${v.note}` : ''}`, { color: pb.muted }, 'body', 'Change')),
    ] : []),
  ], { 'aria-label': 'Chapters', 'data-name': 'Nav' });

  const out: string[] = [];

  // 01 Idea: split, the idea large, the device beside it, and the book's facts.
  const facts = [[ids.length, 'chapters'], [k.colors.length, 'colours'], [k.families().length, k.families().length === 1 ? 'typeface' : 'typefaces'], [input.applications?.length ?? 0, 'applications']] as const;
  out.push(section('idea', base, 'split', [
    h('div', { display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: k.space(48), alignItems: 'end', minHeight: '520px' }, [
      h('div', { display: 'flex', flexDirection: 'column', gap: k.space(28) }, [
        chapterLabel(1, 'Idea', base),
        h('h1', { ...k.font(k.sized(Math.min(128, Math.floor(INNER * 0.55 / Math.max(6, Math.max(...head('idea', s.idea).split(' ').map((w) => w.length)) * 0.6))), 'display')), color: pb.fg, letterSpacing: '-0.02em' }, t(head('idea', s.idea)), { id: 'idea-title', 'data-name': 'Idea' }),
        s.idea_line ? txt('p', 22, s.idea_line, { color: pb.muted, maxWidth: '560px' }, 'body', 'Idea line') : '',
        h('p', { ...k.font(k.sized(15, 'body', undefined, 13)), color: pb.fg }, facts.map(([n, l]) => `${n} ${l}`).join(' · '), { 'data-name': 'Facts' }),
      ]),
      h('div', { backgroundColor: k.c(dark), height: '480px', overflow: 'hidden', display: 'flex', alignItems: 'flex-end' }, device(Math.round(INNER * 0.44), 480, { fill: 'figure', figure: 'hill' })),
    ]),
    s.insight ? txt('p', 28, s.insight, { color: pb.fg, maxWidth: '900px', borderTop: `1px solid ${pb.line}`, paddingTop: k.space(24) }, 'display', 'Insight') : '',
  ]));

  // 02 Logo: full bleed on the hero colour, with construction to switch on and off.
  const lg = k.logoFor(hero) ?? k.logos()[0];
  const ph = P(hero);
  if (lg) {
    const lw = 560;
    const lh = Math.round(lw / k.aspect(lg));
    // The brand states clear space for the logo at its smallest size; it scales with the logo, and is drawn at most
    // the logo's height so the overlay stays readable.
    const atMin = lg.minWidth ? lg.minWidth / k.aspect(lg) : lh;
    const clear = Math.round(Math.min(lh, lg.clearSpace ? (lg.clearSpace / Math.max(1, atMin)) * lh : lh * 0.5));
    out.push(section('logo', hero, 'bleed', [
      h('div', { display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: k.space(48), alignItems: 'center' }, [
        h('div', { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', height: `${lh + clear * 2 + 80}px`, border: `1px dashed ${ph.line}` }, [
          k.logo(lg, lw),
          h('div', { position: 'absolute', left: '50%', top: '50%', width: `${lw + clear * 2}px`, height: `${lh + clear * 2}px`, marginLeft: `-${(lw + clear * 2) / 2}px`, marginTop: `-${(lh + clear * 2) / 2}px`, border: `1px solid ${k.c(k.secondAccent() ?? light)}`, boxSizing: 'border-box', pointerEvents: 'none' }, [], { id: 'logo-clear', 'data-name': 'Clear space' }),
          h('div', { position: 'absolute', left: '50%', top: '50%', width: `${lw}px`, height: `${lh}px`, marginLeft: `-${lw / 2}px`, marginTop: `-${lh / 2}px`, backgroundImage: `linear-gradient(${ph.line} 1px, transparent 1px), linear-gradient(90deg, ${ph.line} 1px, transparent 1px)`, backgroundSize: `${Math.max(8, Math.round(lh / 4))}px ${Math.max(8, Math.round(lh / 4))}px`, opacity: '0.5', pointerEvents: 'none' }, [], { id: 'logo-grid', 'data-name': 'Construction grid' }),
        ], { ...SPECIMEN, 'data-name': 'Logo with construction' }),
        h('div', { display: 'flex', flexDirection: 'column', gap: k.space(20) }, [
          chapterLabel(2, 'Logo', hero),
          txt('h2', 48, head('logo', s.rationale?.logo), { color: ph.fg }, 'display', 'Logo headline'),
          h('div', { display: 'flex', gap: k.space(8), flexWrap: 'wrap' }, [['Clear space', 'logo-clear'], ['Construction grid', 'logo-grid']].map(([label, target]) => h('label', { ...k.font(k.sized(14, 'body', undefined, 13)), color: ph.fg, border: `1px solid ${ph.line}`, borderRadius: k.roundRadius(), padding: `${k.space(6)} ${k.space(12)}`, display: 'flex', gap: k.space(8), alignItems: 'center', minHeight: '32px' }, [h('input', {}, [], { type: 'checkbox', checked: 'checked', 'aria-controls': target }), h('span', {}, t(label!))]))),
          txt('p', 16, `Clear space: ${clear} px around the mark at this size, the same share at every size. Smallest: ${lg.minWidth || 24} px on screen.`, { color: ph.fg }, 'body', 'Logo rules'),
          h('div', { display: 'flex', gap: k.space(24), alignItems: 'flex-end' }, [lg.minWidth || 24, 64, 120].map((w) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(6) }, [k.logo(lg, w), txt('p', 13, `${w} px`, { color: ph.muted, fontVariantNumeric: 'tabular-nums' }, 'mono', 'Size')]))),
        ]),
      ]),
      h('div', { display: 'grid', gridTemplateColumns: `repeat(${Math.min(4, k.logos().length + 2)}, 1fr)`, gap: k.space(8) }, [
        ...k.logos().slice(0, 2).map((l) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(8), padding: k.space(24), backgroundColor: k.c(k.colorFor(l.background) ?? base) }, [k.logo(l, 200), txt('p', 13, l.name, { color: P(k.colorFor(l.background) ?? base).muted }, 'body', 'Lockup')])),
        h('div', { display: 'flex', flexDirection: 'column', gap: k.space(8), padding: k.space(24), backgroundColor: k.c(light) }, [k.logo(lg, 200, { filter: 'brightness(0)' }), txt('p', 13, 'Mono, on light', { color: P(light).muted }, 'body', 'Lockup')]),
        h('div', { display: 'flex', flexDirection: 'column', gap: k.space(8), padding: k.space(24), backgroundColor: k.c(dark) }, [k.logo(lg, 200, { filter: 'brightness(0) invert(1)' }), txt('p', 13, 'Reversed, on dark', { color: P(dark).muted }, 'body', 'Lockup')]),
      ], { 'data-name': 'Lockups' }),
      (() => {
        // The don'ts sit on light cells, so they use the logo made for a light ground.
        const ll = k.logoFor(light) ?? lg;
        return so([
          { label: 'Stretched', body: k.logo(ll, 150, { transform: 'scaleX(1.45)', transformOrigin: 'left' }) },
          { label: 'Turned', body: k.logo(ll, 150, { transform: 'rotate(-10deg)' }) },
          { label: 'Recoloured', body: k.logo(ll, 150, { filter: 'hue-rotate(150deg) saturate(3) brightness(1.6)' }) },
          { label: 'With an effect the brand does not have', body: k.logo(ll, 150, { filter: 'drop-shadow(4px 6px 4px rgba(0,0,0,.45))' }) },
        ], hero);
      })(),
    ]));
  } else gaps.push('The brand has no logo: the logo chapter is left out. Add one with brand_asset_add kind logo.');

  // 03 Colour: the measured share opens it.
  const cf = colourFacts(k);
  const share = input.share?.filter((x) => x.share > 0.004) ?? [];
  if (!share.length) gaps.push('No measured share of colour: render the brand\'s applications first (brand_presentation), then run brand_site again.');
  const topShare = share.slice().sort((a, b) => b.share - a.share);
  const exports = tokenExports(env.tokenValues ?? new Map(), k.colors);
  out.push(section('colour', base, 'measure', [
    chapterLabel(3, 'Colour', base),
    share.length ? h('div', { display: 'flex', height: '120px', border: `1px solid ${pb.line}` }, share.map((x) => h('div', { flex: String(Math.max(0.5, Math.round(x.share * 1000) / 10)), backgroundColor: k.colors.find((c) => c.token === x.token) ? k.c(k.colors.find((c) => c.token === x.token)) : x.hex }, [], { title: `${x.name} ${(x.share * 100).toFixed(0)} %`, 'aria-label': `${x.name} ${(x.share * 100).toFixed(0)} percent`, role: 'img' })), { 'data-name': 'Share of colour' }) : '',
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: k.space(48) }, [
      txt('h2', 56, head('colour', s.rationale?.colour), { color: pb.fg, maxWidth: '640px' }, 'display', 'Colour headline'),
      share.length ? txt('p', 15, `Measured across ${input.shareSource ?? 'the brand\'s applications'}: ${topShare.slice(0, 3).map((x) => `${x.name} ${(x.share * 100).toFixed(0)} %`).join(', ')}. Keep the share, and the accent keeps meaning something.`, { color: pb.muted, maxWidth: '380px' }, 'body', 'Share note') : '',
    ]),
    h('div', { display: 'grid', gridTemplateColumns: `repeat(${Math.min(6, cf.length)}, 1fr)`, gap: k.space(8) }, cf.slice(0, 12).map((f, i) => {
      const col = k.colors[i]!;
      const pc = P(col);
      const pantone = col.note && /pantone|pms/i.test(col.note) ? col.note : null;
      return h('div', { display: 'flex', flexDirection: 'column', gap: k.space(4), padding: k.space(16), minHeight: '220px', backgroundColor: k.c(col), border: base && contrastRatio(col.value, base.value) < 1.25 ? `1px solid ${pb.line}` : 'none', minWidth: '0' }, [
        txt('p', 17, f.name, { color: pc.fg }, 'body', 'Name', 700),
        txt('p', 13, f.role || 'Colour', { color: pc.fg, marginBottom: 'auto' }, 'body', 'Role'),
        copy(f.hex, `${f.name} HEX`, col, f.hex),
        copy(`rgb(${f.rgb.split(' ').join(', ')})`, `${f.name} RGB`, col, `RGB ${f.rgb}`),
        copy(oklch(f.hex), `${f.name} OKLCH`, col, oklch(f.hex).replace('oklch', 'OKLCH ')),
        txt('p', 13, `CMYK ${f.cmyk}`, { color: pc.fg, fontVariantNumeric: 'tabular-nums' }, 'mono', 'CMYK'),
        txt('p', 13, pantone ?? 'Pantone not set', { color: pc.fg }, 'mono', 'Pantone'),
      ], { 'data-name': `Colour ${f.name}` });
    }), { 'data-name': 'Swatches' }),
    txt('h3', 20, 'Every pair, including the ones that fail', { color: pb.fg, marginTop: k.space(16) }, 'body', 'Pairs title', 700),
    (() => {
      const list = k.colors.slice(0, 7);
      const min = k.data.fields.minContrast || 4.5;
      return h('div', { display: 'grid', gridTemplateColumns: `120px repeat(${list.length}, 1fr)`, gap: k.space(4) }, [
        txt('p', 13, 'Text on', { color: pb.muted }),
        ...list.map((bg) => txt('p', 13, bg.name, { color: pb.muted }, 'body', 'Ground')),
        ...list.flatMap((fg) => [
          txt('p', 14, fg.name, { color: pb.fg, alignSelf: 'center' }, 'body', 'Text colour', 700),
          ...list.map((bg) => {
            const ratio = Math.round(contrastRatio(fg.value, bg.value) * 10) / 10;
            const pass = fg.id !== bg.id && ratio >= min;
            return h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '72px', backgroundColor: k.c(bg) }, fg.id === bg.id ? '' : [
              h('p', { ...k.font(k.sized(22, 'display', 700, 13)), color: k.c(fg), textDecoration: pass ? 'none' : 'line-through' }, 'Aa'),
              h('p', { ...k.font(k.sized(13, 'mono', undefined, 13)), color: pass ? k.c(fg) : P(bg).fg, fontVariantNumeric: 'tabular-nums' }, `${ratio}:1${pass ? '' : ' no'}`),
            ], pass ? { 'data-name': 'Pair' } : { ...DONT, 'data-name': 'Failing pair' });
          }),
        ]),
      ], { 'data-name': 'Contrast matrix' });
    })(),
    h('div', { display: 'flex', gap: k.space(8), flexWrap: 'wrap', alignItems: 'center' }, [txt('p', 15, 'Tokens for developers', { color: pb.fg, marginRight: '8px' }, 'body', 'Tokens label', 700), ...(Object.entries(exports) as [string, string][]).map(([fmt, text]) => copy(text, `tokens as ${fmt}`, base, fmt))], { 'data-name': 'Token export' }),
  ]));

  // 04 Type: the tester opens it.
  const fams = k.families();
  const sample = s.display_lines?.[0] ?? s.idea ?? k.name;
  const steps = k.steps().slice(0, 7);
  out.push(section('type', light ?? base, 'tester', [
    h('div', { display: 'flex', gap: k.space(16), alignItems: 'center', flexWrap: 'wrap' }, [
      chapterLabel(4, 'Type', light ?? base),
      h('div', { display: 'flex', gap: k.space(4), marginLeft: 'auto' }, fams.slice(0, 3).map((f, i) => h('label', { ...k.font(k.sized(14, 'body', undefined, 13)), color: P(light).fg, border: `1px solid ${P(light).line}`, borderRadius: k.roundRadius(), padding: `${k.space(6)} ${k.space(12)}`, display: 'flex', gap: k.space(8), alignItems: 'center', minHeight: '32px' }, [h('input', {}, [], { type: 'radio', name: 'face', value: k.stack(f), 'aria-controls': 'type-sample', ...(i === 0 ? { checked: 'checked' } : {}) }), h('span', {}, t(f.family))])), { role: 'radiogroup', 'aria-label': 'Typeface' }),
      h('label', { ...k.font(k.sized(14, 'body', undefined, 13)), color: P(light).muted, display: 'flex', gap: k.space(10), alignItems: 'center' }, [h('span', {}, 'Size'), h('input', { width: '200px' }, [], { type: 'range', min: '16', max: '200', value: '120', 'aria-label': 'Size', 'aria-controls': 'type-sample' })]),
    ]),
    h('p', { ...k.font(k.sized(120, 'display')), color: P(light).fg, letterSpacing: '-0.02em', overflowWrap: 'anywhere' }, t(sample), { id: 'type-sample', 'data-name': 'Type sample' }),
    txt('h2', 28, head('type', s.rationale?.type), { color: P(light).fg, maxWidth: '760px' }, 'body', 'Type headline'),
    h('div', { display: 'grid', gridTemplateColumns: '160px 1fr 240px' }, steps.flatMap((st) => [
      txt('p', 13, st.name, { color: P(light).muted, padding: `${k.space(12)} 0px`, borderTop: `1px solid ${P(light).line}` }, 'mono', 'Step'),
      h('p', { ...k.font(k.sized(Math.min(st.size, 48), st.size >= 40 ? 'display' : 'body')), color: P(light).fg, padding: `${k.space(6)} 0px`, borderTop: `1px solid ${P(light).line}` }, t(s.campaign_lines?.[0] ?? sample)),
      txt('p', 13, `${st.size} px${st.weight ? ` · ${st.weight}` : ''}${st.lineHeight ? ` · ${st.lineHeight}` : ''}${st.tracking ? ` · ${st.tracking}` : ''}`, { color: P(light).muted, padding: `${k.space(12)} 0px`, borderTop: `1px solid ${P(light).line}`, fontVariantNumeric: 'tabular-nums' }, 'mono', 'Values'),
    ]), { 'data-name': 'Type scale' }),
    txt('p', 14, fams.map((f) => `${f.family}${f.license ? `, ${f.license}` : ''}`).join(' · '), { color: P(light).muted }, 'body', 'Licences'),
  ]));

  // 05 Device: the rule, in three registers.
  out.push(section('device', dark, 'rule', [
    chapterLabel(5, 'Device', dark),
    txt('h2', 48, head('device', s.rationale?.device), { color: P(dark).fg, maxWidth: '760px' }, 'display', 'Device headline'),
    h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: k.space(8) }, [
      ['As texture', {}], ['As a figure', { fill: 'figure', figure: 'mountain' }], ['As a chart', { fill: 'bars', values: [0.3, 0.45, 0.4, 0.6, 0.75, 0.7, 0.9] }],
    ].map(([label, patch]) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(10) }, [h('div', { height: '260px', overflow: 'hidden', backgroundColor: k.c(base) }, device(Math.floor((INNER - 16) / 3), 260, patch as Partial<PatternSpec>)), txt('p', 14, label as string, { color: P(dark).muted }, 'body', 'Register')]))),
    txt('p', 15, `Rule: ${spec.cell} cells on a ${spec.columns} by ${spec.rows} grid, filled by ${spec.fill}${spec.figure ? ` (${spec.figure})` : ''}, gap ${Math.round(spec.gap * 100)} %, in ${spec.colors.length} tones.`, { color: P(dark).fg }, 'mono', 'Device rule'),
  ]));

  // 06 Photography: a gallery.
  const photos = s.photos ?? [];
  if (photos.length) {
    out.push(section('photography', base, 'gallery', [
      h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: k.space(48) }, [h('div', { display: 'flex', flexDirection: 'column', gap: k.space(16) }, [chapterLabel(6, 'Photography', base), txt('h2', 48, head('photography', s.photo_rule), { color: pb.fg, maxWidth: '720px' }, 'display', 'Photography headline')])]),
      h('div', { display: 'grid', gridTemplateColumns: photos.length >= 3 ? '2fr 1fr 1fr' : `repeat(${photos.length}, 1fr)`, gap: k.space(8) }, photos.slice(0, 3).map((src, i) => h('img', { width: '100%', height: i === 0 ? '420px' : '420px', objectFit: 'cover', display: 'block' }, [], { src, alt: '' }))),
      s.photo_rule ? txt('p', 18, s.photo_rule, { color: pb.fg, maxWidth: '760px' }, 'body', 'Photo rule') : '',
      so([{ label: 'An untreated stock photo with a person posing', body: h('div', { width: '100%', height: '96px', background: 'linear-gradient(135deg,#9cc4e4,#f3c6d3)' }) }, { label: 'A second treatment beside the first', body: photos[0] ? h('img', { width: '100%', height: '96px', objectFit: 'cover', filter: 'sepia(1) saturate(3)' }, [], { src: photos[0], alt: '' }) : '' }], base),
    ]));
  } else gaps.push('No photos: the photography chapter is left out. Pass story.photos, treated with the brand\'s preset.');

  // 07 Voice: one large line in voice, with its opposite.
  const pr = s.voice?.principles ?? [];
  out.push(section('voice', hero, 'quote', [
    chapterLabel(7, 'Voice', hero),
    s.voice?.in_voice ? txt('blockquote', 64, s.voice.in_voice, { color: ph.fg, margin: '0px', maxWidth: '980px' }, 'display', 'In voice') : txt('h2', 48, head('voice'), { color: ph.fg }, 'display', 'Voice headline'),
    pr.length ? h('div', { display: 'grid', gridTemplateColumns: `repeat(${Math.min(3, pr.length)}, 1fr)`, gap: k.space(32) }, pr.slice(0, 3).map((x) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(8), borderTop: `2px solid ${ph.fg}`, paddingTop: k.space(16) }, [txt('h3', 26, x.name, { color: ph.fg }, 'display', 'Principle'), txt('p', 16, x.line, { color: ph.fg }, 'body', 'Principle line')]))) : '',
    s.voice?.out_of_voice ? so([{ label: 'Not our voice', body: txt('p', 20, s.voice.out_of_voice, { color: P(light).fg, textDecoration: 'line-through' }, 'body', 'Out of voice') }], hero) : '',
  ]));
  if (!pr.length) gaps.push('No voice principles: give story.voice.principles.');

  // 08 Applications: the real boards, live.
  const apps = input.applications ?? [];
  if (apps.length) {
    out.push(section('applications', dark, 'wall', [
      chapterLabel(8, 'Applications', dark),
      txt('h2', 48, head('applications', s.rationale?.applications), { color: P(dark).fg, maxWidth: '760px' }, 'display', 'Applications headline'),
      h('div', { display: 'flex', gap: k.space(12), overflowX: 'auto', paddingBottom: k.space(8), alignItems: 'flex-start' }, apps.slice(0, 12).map((a) => place(a.id, Math.round(360 * (a.width / Math.max(1, a.height))), 360)), { 'data-name': 'Live applications', role: 'region', 'aria-label': 'Applications, scroll sideways', tabindex: '0' }),
    ]));
  } else gaps.push('No applications in this file yet: run brand_presentation first, so the site shows the real boards.');

  // 09 Motion: cells that fill, playing the brand's keyframes.
  const mo = input.motion;
  out.push(section('motion', base, 'motion', [
    chapterLabel(9, 'Motion', base),
    txt('h2', 48, head('motion', s.motion_rule), { color: pb.fg, maxWidth: '760px' }, 'display', 'Motion headline'),
    h('div', { display: 'flex', gap: k.space(10), alignItems: 'flex-end', height: '160px' }, Array.from({ length: 14 }, (_, i) => h('div', {
      width: '48px', height: `${40 + Math.round(100 * Math.sin((i / 13) * Math.PI))}px`, borderRadius: spec.cell === 'circle' ? '999px' : '2px', backgroundColor: k.c(i % 4 === 3 ? k.secondAccent() ?? hero : hero),
      ...(mo ? { animationName: mo.name, animationDuration: `${mo.duration}ms`, animationTimingFunction: mo.easing, animationDelay: `-${(14 - i) * mo.stagger * 3}ms`, animationFillMode: 'both', animationIterationCount: 'infinite', animationDirection: 'alternate', transformOrigin: 'bottom' } : {}),
    }, [], { 'data-name': `Cell ${i + 1}` })), { 'data-name': 'Motion sample', role: 'img', 'aria-label': 'Cells fill from the bottom, one after another' }),
    mo ? h('div', { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: k.space(8) }, [['Duration', `${mo.duration} ms`], ['Easing', mo.easing], ['Stagger', `${mo.stagger} ms per cell`], ['Reduced motion', 'Shown filled, no movement']].map(([a, b]) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(4), borderTop: `1px solid ${pb.line}`, paddingTop: k.space(12) }, [txt('p', 13, a!, { color: pb.muted }, 'body', 'Motion fact'), txt('p', 18, b!, { color: pb.fg }, 'mono', 'Motion value')]))) : '',
  ]));

  // 10 Downloads: what the kit holds, in a list.
  out.push(section('downloads', light ?? base, 'list', [
    chapterLabel(10, 'Downloads', light ?? base),
    txt('h2', 40, head('downloads', 'Everything to make it yourself.'), { color: P(light).fg }, 'display', 'Downloads headline'),
    h('div', { display: 'flex', flexDirection: 'column' }, [
      ...k.logos().map((l) => h('div', { display: 'flex', alignItems: 'center', gap: k.space(24), padding: `${k.space(14)} 0px`, borderTop: `1px solid ${P(light).line}` }, [h('div', { padding: k.space(12), backgroundColor: k.c(k.colorFor(l.background) ?? light), flex: 'none' }, k.logo(l, 96)), txt('p', 16, `${l.name}, for ${l.background || 'any'} grounds`, { color: P(light).fg, flex: '1' }, 'body', 'Kit item'), txt('p', 13, l.asset ? 'Image, right-click to save' : 'SVG', { color: P(light).muted }, 'mono', 'Kit format')])),
      ...(Object.keys(exports) as string[]).map((fmt) => h('div', { display: 'flex', alignItems: 'center', gap: k.space(24), padding: `${k.space(14)} 0px`, borderTop: `1px solid ${P(light).line}` }, [txt('p', 16, `Tokens as ${fmt}`, { color: P(light).fg, flex: '1' }, 'body', 'Kit item'), copy((exports as Record<string, string>)[fmt]!, `tokens as ${fmt}`, light, 'Copy')])),
      ...fams.map((f) => h('div', { display: 'flex', alignItems: 'center', gap: k.space(24), padding: `${k.space(14)} 0px`, borderTop: `1px solid ${P(light).line}` }, [txt('p', 16, `${f.family}`, { color: P(light).fg, flex: '1' }, 'body', 'Kit item'), txt('p', 13, f.license ?? 'Licence not stated', { color: P(light).muted }, 'mono', 'Kit format')])),
    ], { 'data-name': 'Kit' }),
  ]));

  const board: BoardPlan = {
    name: `${k.name} · Brand site`, tag: 'div', width: SITE_WIDTH, background: k.c(base, '#ffffff'), color: pb.fg, font: k.stack(k.family('body')),
    attrs: { [BRAND_SITE_ATTR]: JSON.stringify({ version, openers }) },
    steps: [{ html: h('div', { display: 'flex', width: `${SITE_WIDTH}px`, alignItems: 'flex-start' }, [nav, h('main', { display: 'flex', flexDirection: 'column', width: `${MAIN}px`, minWidth: '0' }, out, { 'data-name': 'Chapters' })]) }],
  };
  return { board, placements, devices, openers, gaps };
}
