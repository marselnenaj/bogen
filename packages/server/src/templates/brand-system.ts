import { contrastRatio, logoFitsBackground, type BrandColor, type BrandLogo, type BrandRule, type BrandRuleTopic } from '@bogen/core';
import { BrandKit, DONT, SPECIMEN, formatDate, h, t, type Scheme, type Style, type TemplateEnv, type TypeRole } from './kit.ts';
import type { BoardPlan, BoardStep, TemplateDef, TemplateOptions, TemplatePlan } from './types.ts';

const WIDTH = 1440;

const TOPIC_NAMES: Record<BrandRuleTopic, string> = { general: 'General', color: 'Colour', type: 'Type', layout: 'Layout', imagery: 'Imagery', iconography: 'Icons', logo: 'Logo', voice: 'Voice' };

/** What each board of the brand system is for, in the order they stand on the page. */
export const BRAND_SYSTEM_PARTS = [
  { key: 'cover', name: '1 Cover', size: '1440 wide, at least 900 high' },
  { key: 'logo', name: '2 Logo', size: '1440 wide, hugs content' },
  { key: 'colour', name: '3 Colour', size: '1440 wide, hugs content' },
  { key: 'type', name: '4 Type', size: '1440 wide, hugs content' },
  { key: 'layout', name: '5 Layout and spacing', size: '1440 wide, hugs content' },
  { key: 'components', name: '6 Components', size: '1440 wide, hugs content' },
  { key: 'voice', name: '7 Voice', size: '1440 wide, hugs content' },
] as const;

/** Shared pieces of one board: its colours, and the text styles it sets things in. */
class Board {
  readonly p: { bg: string; fg: string; muted: string; line: string };
  readonly pad: string;
  /** The sheet's title, its sub-headings and a heading inside a sample, a fifth apart at least, whatever the scale holds. */
  readonly levels: TypeRole[];

  constructor(readonly k: BrandKit, readonly scheme: Scheme, readonly gaps: string[]) {
    this.p = k.paint(scheme);
    this.pad = k.space(88);
    this.levels = k.ladder([48, 28, 22], { above: k.type('body').px });
  }

  title(text: string): string {
    // Each sheet is an artboard of its own, so its title is its h1.
    return h('h1', { ...this.k.font(this.levels[0]!), color: this.p.fg, maxWidth: '720px' }, t(text), { 'data-name': 'Title' });
  }

  /** The board's title on the left and, when there is one, a short line about it on the right. */
  header(title: string, intro?: string): string {
    return h('header', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: this.k.space(48), alignItems: 'end' }, [
      this.title(title),
      intro ? h('p', { ...this.k.font(this.k.type('body')), color: this.p.muted, maxWidth: '560px', justifySelf: 'end' }, t(intro), { 'data-name': 'Intro' }) : '',
    ], { 'data-name': 'Header' });
  }

  sub(text: string, style: Style = {}): string {
    return h('h2', { ...this.k.font(this.levels[1]!, 700), color: this.p.fg, ...style }, t(text), { 'data-name': text.slice(0, 40) });
  }

  label(text: string, style: Style = {}, name?: string): string {
    return h('p', { ...this.k.font(this.k.type('small'), 700), color: this.p.fg, ...style }, t(text), name ? { 'data-name': name } : {});
  }

  note(text: string, style: Style = {}, name?: string): string {
    return h('p', { ...this.k.font(this.k.type('small')), color: this.p.muted, maxWidth: '60ch', ...style }, t(text), name ? { 'data-name': name } : {});
  }

  code(text: string, style: Style = {}, name?: string): string {
    return h('p', { ...this.k.font(this.k.type('mono')), color: this.p.muted, ...style }, t(text), name ? { 'data-name': name } : {});
  }

  body(text: string, style: Style = {}): string {
    return h('p', { ...this.k.font(this.k.type('body')), color: this.p.fg, ...style }, t(text));
  }

  /** A gap in the brand: one quiet line that says how to fill it. */
  gap(text: string): string {
    this.gaps.push(text);
    return h('p', { ...this.k.font(this.k.type('small')), color: this.p.muted, borderTop: `1px solid ${this.p.line}`, paddingTop: this.k.space(12), maxWidth: '60ch' }, t(text), { 'data-name': 'Gap' });
  }

  section(name: string, children: string[], style: Style = {}): string {
    return h('section', { display: 'flex', flexDirection: 'column', gap: this.k.space(40), padding: this.pad, ...style }, children, { 'data-name': name });
  }

  board(name: string, steps: BoardStep[], extra: Partial<BoardPlan> = {}): BoardPlan {
    return { name, width: WIDTH, background: this.p.bg, color: this.p.fg, font: this.k.stack(this.k.family('body')), steps, ...extra };
  }

  /** A section in another colour, full bleed, for a change of pace inside a board. */
  band(scheme: Scheme): Board {
    return new Board(this.k, scheme, this.gaps);
  }
}

function sentence(list: string[]): string {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

function shortest(list: string[]): string | undefined {
  return [...list].filter(Boolean).sort((a, b) => a.length - b.length)[0];
}

// ---------------------------------------------------------------- 1 Cover

function cover(k: BrandKit, gaps: string[]): BoardPlan {
  const accent = k.accent();
  const onAccent = accent && k.textOn(accent) && k.textOn(accent, true) ? accent : null;
  const bg = onAccent ?? k.base();
  const b = new Board(k, k.scheme(bg), gaps);
  const logo = k.logoFor(bg);
  const f = k.data.fields;
  const version = k.env.version ? `Version ${k.env.version}, ${formatDate(k.env.date)}` : `Draft, ${formatDate(k.env.date)}`;
  const hero = k.type('hero', 220);
  const html = h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: k.space(88), padding: b.pad, minHeight: '900px', flex: '1 1 auto' }, [
    h('header', { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: k.space(24) }, [
      logo ? k.logo(logo, 96) : h('div', {}, [], { 'data-name': 'No logo' }),
      b.note(version, { color: b.p.fg }, 'Version'),
    ], { 'data-name': 'Top' }),
    h('div', { display: 'flex', flexDirection: 'column', gap: k.space(48) }, [
      h('h1', { ...k.font(hero), color: b.p.fg }, t(k.name), { 'data-name': 'Brand name' }),
      h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: k.space(48), alignItems: 'end', borderTop: `1px solid ${b.p.fg}`, paddingTop: k.space(24) }, [
        h('p', { ...k.font(k.type('heading')), color: b.p.fg }, t('Brand system'), { 'data-name': 'Document' }),
        f.positioning ? h('p', { ...k.font(k.type('lead')), color: b.p.fg, maxWidth: '620px' }, t(f.positioning), { 'data-name': 'Positioning' }) : b.gap('No positioning yet: add one line with brand_update (fields.positioning).'),
      ], { 'data-name': 'Bottom' }),
    ], { 'data-name': 'Title block' }),
  ], { 'data-name': 'Cover' });
  return b.board('1 Cover', [{ html }]);
}

// ---------------------------------------------------------------- 2 Logo

function logoBoard(k: BrandKit, gaps: string[]): BoardPlan {
  const base = k.base();
  const b = new Board(k, k.scheme(base), gaps);
  const logos = k.logos();
  const rules = k.data.rules.filter((r) => r.topic === 'logo' && !r.flagged);
  const doRule = rules.find((r) => r.kind === 'do');
  const intro = doRule?.text ?? (logos.length ? `${logos.length} ${logos.length === 1 ? 'variant' : 'variants'}, each drawn for its background. Use them as drawn.` : undefined);
  const parts: string[] = [b.header('Logo', intro)];
  if (!logos.length) {
    parts.push(b.gap('No logo yet: add one with brand_asset_add (kind logo, with its background, minimum width and clear space).'));
    return b.board('2 Logo', [{ html: b.section('Logo', parts) }]);
  }
  const bgOf = (l: BrandLogo) => k.colorFor(l.background) ?? base;
  const main = k.logoFor(base) ?? logos[0]!;
  const mainBg = bgOf(main);
  const stage = k.paint(k.scheme(mainBg));
  const wide = k.aspect(main) >= 2;
  parts.push(h('div', { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '560px', background: stage.bg, border: `1px solid ${b.p.line}` }, [k.logo(main, wide ? 640 : 320)], { 'data-name': 'Mark' }));

  // Every variant on the background it is drawn for. The first is larger, so the row has an order.
  const tile = (l: BrandLogo, i: number) => {
    const bg = bgOf(l);
    const paint = k.paint(k.scheme(bg));
    const forName = k.colorFor(l.background)?.name ?? l.background;
    const what = `For ${['any', 'light', 'dark'].includes(l.background.toLowerCase()) ? `${l.background.toLowerCase()} backgrounds` : forName}.${l.minWidth ? ` At least ${l.minWidth}px wide.` : ''}${l.clearSpace ? ` ${l.clearSpace}px clear space.` : ''}`;
    const lead = i === 0 && logos.length > 2;
    return h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12), gridColumn: lead ? 'span 2' : undefined, gridRow: lead && logos.length >= 4 ? 'span 2' : undefined }, [
      h('div', { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '240px', flex: '1 1 auto', background: paint.bg, border: `1px solid ${b.p.line}` }, [k.logo(l, Math.max(l.minWidth * 2, lead ? 200 : 112))], { 'data-name': 'Ground' }),
      b.label(l.name, {}, 'Name'),
      b.note(what, {}, 'Use'),
    ], { 'data-name': `Variant: ${l.name}` });
  };
  parts.push(h('div', { display: 'flex', flexDirection: 'column', gap: k.space(24) }, [
    b.sub('On every ground'),
    h('div', { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: k.space(24) }, logos.map(tile), { 'data-name': 'Variants' }),
  ], { 'data-name': 'Variants block' }));

  // Minimum size and clear space, at real size, once per distinct rule.
  const seen = new Set<string>();
  const sizes = logos.filter((l) => {
    const key = `${l.asset || l.svg?.length}|${l.minWidth}|${l.clearSpace}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return l.minWidth > 0 || l.clearSpace > 0;
  }).slice(0, 4);
  if (sizes.length) {
    parts.push(h('div', { display: 'grid', gridTemplateColumns: '1fr 2fr', gap: k.space(48) }, [
      h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12) }, [b.sub('Size and clear space'), b.note('Shown at real size. The dashed line is the clear space: nothing else goes inside it.')]),
      h('div', { display: 'flex', gap: k.space(24), flexWrap: 'wrap' }, sizes.map((l) => {
        const paint = k.paint(k.scheme(bgOf(l)));
        return h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12) }, [
          h('div', { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '200px', height: '160px', background: paint.bg, border: `1px solid ${b.p.line}` }, [
            h('div', { display: 'flex', border: `1px dashed ${paint.muted}` }, [k.logo(l, l.minWidth || 24, { margin: `${l.clearSpace}px` })], { 'data-name': 'Clear space' }),
          ], { 'data-name': 'Ground' }),
          b.label(l.minWidth ? `${l.minWidth}px minimum` : 'No minimum set', {}, 'Minimum'),
          b.note(l.clearSpace ? `${l.clearSpace}px clear space` : 'No clear space set', {}, 'Clear space'),
        ], { 'data-name': `Size: ${l.name}` });
      }), { 'data-name': 'Sizes' }),
    ], { 'data-name': 'Size block' }));
  }

  // What the mark never does, shown on purpose and left out of brand_check.
  const donts: string[] = [];
  const cell = (caption: string, ground: string, inner: string) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12) }, [
    h('div', { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', background: ground, border: `1px solid ${b.p.line}`, overflow: 'hidden' }, [inner], { 'data-name': 'Ground' }),
    b.note(caption, { color: b.p.fg }, 'Caption'),
  ], { 'data-name': `Don't: ${caption.slice(0, 40)}` });
  const w = 112;
  donts.push(cell('Don\'t stretch it.', stage.bg, k.logo(main, w, { transform: 'scale(1.9, 1)' }, 'Stretched logo')));
  donts.push(cell('Don\'t turn it.', stage.bg, k.logo(main, w, { transform: 'rotate(-14deg)' }, 'Turned logo')));
  const wrong = k.colors.find((c) => c.id !== mainBg?.id && !logoFitsBackground(k.data, main.background, c.value) && k.kind(c) === 'accent')
    ?? k.colors.find((c) => c.id !== mainBg?.id && !logoFitsBackground(k.data, main.background, c.value));
  if (wrong) donts.push(cell(`Don't put "${main.name}" on ${wrong.name}.`, k.c(wrong), k.logo(main, w, {}, 'Logo on the wrong ground')));
  if (main.minWidth > 8) donts.push(cell(`Don't set it under ${main.minWidth}px.`, stage.bg, k.logo({ ...main, minWidth: 0 }, Math.max(4, Math.round(main.minWidth / 2)), {}, 'Logo under its minimum')));
  const dontRules = rules.filter((r) => r.kind === 'dont');
  parts.push(h('div', { display: 'flex', flexDirection: 'column', gap: k.space(24) }, [
    b.sub('Never'),
    h('div', { display: 'grid', gridTemplateColumns: `repeat(${donts.length}, 1fr)`, gap: k.space(24) }, donts, { 'data-name': 'Donts', ...DONT }),
    ...dontRules.map((r) => b.body(r.text)),
  ], { 'data-name': 'Never block' }));
  return b.board('2 Logo', [{ html: b.section('Logo', parts, { gap: k.space(88) }) }]);
}

// ---------------------------------------------------------------- 3 Colour

function colourBoard(k: BrandKit, gaps: string[]): BoardPlan {
  const base = k.base();
  const b = new Board(k, k.scheme(base), gaps);
  const colors = k.colors;
  const f = k.data.fields;
  const intro = colors.length ? `${colors.length} colours. Text keeps a contrast of at least ${f.minContrast}:1${f.pairingDefault === 'forbid' ? ', and only the pairs listed below may meet' : ''}.` : undefined;
  const steps: BoardStep[] = [];
  const parts: string[] = [b.header('Colour', intro)];
  if (!colors.length) {
    parts.push(b.gap('No colours yet: add them with brand_update (colors, each with a name, role and value).'));
    return b.board('3 Colour', [{ html: b.section('Colour', parts) }]);
  }
  const core = colors.filter((c) => ['bg', 'fg', 'accent'].includes(k.kind(c))).slice(0, 4);
  const primaries = core.length >= 2 ? core : colors.slice(0, Math.min(4, colors.length));
  const rest = colors.filter((c) => !primaries.includes(c));

  const swatch = (c: BrandColor, i: number) => {
    // The name is set a level under the sheet's title; large-text contrast only where it is large text.
    const big = b.levels[1]!.px >= 24 ? k.textOn(c, true) : k.textOn(c);
    const small = k.textOn(c);
    const details = [b.code(`${k.hex(c)}  --${c.token}`, { color: small ? k.c(small) : b.p.muted }, 'Value'), c.role ? h('p', { ...k.font(k.type('small')), color: small ? k.c(small) : b.p.muted }, t(c.role), { 'data-name': 'Role' }) : ''];
    return h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12), gridColumn: i === 0 && primaries.length > 2 ? 'span 2' : undefined }, [
      h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '440px', padding: k.space(28), background: k.c(c), border: c.id === base?.id ? `1px solid ${b.p.line}` : undefined }, [
        big ? h('p', { ...k.font(b.levels[1]!), color: k.c(big) }, t(c.name), { 'data-name': 'Name' }) : h('div', {}, []),
        small ? h('div', { display: 'flex', flexDirection: 'column', gap: k.space(4) }, details, { 'data-name': 'Details' }) : '',
      ], { 'data-name': 'Fill' }),
      ...(big ? [] : [b.label(c.name, {}, 'Name')]),
      ...(small ? [] : details),
    ], { 'data-name': `Colour: ${c.name}` });
  };
  parts.push(h('div', { display: 'grid', gridTemplateColumns: `repeat(${primaries.length > 2 ? primaries.length + 1 : primaries.length}, 1fr)`, gap: k.space(24) }, primaries.map(swatch), { 'data-name': 'Primary colours' }));
  steps.push({ html: b.section('Colour', parts, { gap: k.space(48), paddingBottom: '0px' }) });

  // The rest as one component, so that a person changes how all of them look in one place.
  if (rest.length) {
    const chip = (c: BrandColor) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(8) }, [
      h('div', { height: '120px', background: k.c(c), border: `1px solid ${b.p.line}` }, [], { 'data-name': 'Chip' }),
      b.label(c.name, {}, 'Name'),
      b.code(`${k.hex(c)}  --${c.token}`, {}, 'Value'),
      b.note(c.role || ' ', {}, 'Role'),
    ], { 'data-name': 'Swatch' });
    steps.push({ html: b.section('Secondary colours', [b.sub('Supporting'), h('div', { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: k.space(24) }, [chip(rest[0]!)], { 'data-name': 'Swatches' })], { gap: k.space(48), paddingBottom: '0px' }) });
    steps.push({ component: { layer: 'Swatch', name: 'Swatch', description: 'A colour of the brand with its name, value, token and role.', props: [
      { name: 'name', type: 'text', target: 'Name' }, { name: 'value', type: 'text', target: 'Value' }, { name: 'role', type: 'text', target: 'Role' },
      { name: 'fill', type: 'text', target: 'Chip', field: 'style.background' },
    ] } });
    steps.push({ into: 'Swatches', html: rest.slice(1).map((c) => h('x-instance', {}, [], { component: 'Swatch', 'data-name': `Swatch: ${c.name}`, 'prop-name': c.name, 'prop-value': `${k.hex(c)}  --${c.token}`, 'prop-role': c.role || ' ', 'prop-fill': k.c(c) })).join('') });
  }

  // Pairs: allowed for text, allowed only for shapes, and never.
  const pairs = k.pairs();
  const band = b.band(k.scheme(k.alternate() ?? base));
  const forText = pairs.filter((p) => p.verdict === 'allow' && contrastRatio(p.fg.value, p.bg.value) >= Math.min(3, f.minContrast));
  // Where everything not forbidden is allowed, the pairs of the main colours that reach the contrast floor are right too.
  const computed = f.pairingDefault === 'allow' ? primaries.flatMap((bg) => colors.filter((fg) => k.canText(fg, bg) && !pairs.some((p) => p.fg.id === fg.id && p.bg.id === bg.id)).map((fg) => ({ id: `${fg.id}-${bg.id}`, fg, bg, verdict: 'allow' as const, contrast: contrastRatio(fg.value, bg.value), passes: true }))).slice(0, 12) : [];
  forText.push(...computed);
  if (!forText.length && !pairs.length) {
    steps.push({ html: b.section('Pairs', [b.sub('Pairs'), b.gap('No pairs yet: say which colours may meet with brand_update (pairings, fg and bg with allow or forbid).')], { gap: k.space(24) }) });
    return b.board('3 Colour', steps);
  }
  const forShapes = pairs.filter((p) => p.verdict === 'allow' && !forText.includes(p));
  const never = pairs.filter((p) => p.verdict === 'forbid');
  const sample = (fg: BrandColor, bg: BrandColor, text: boolean) => h('div', { display: 'flex', alignItems: 'flex-end', height: '120px', padding: k.space(20), background: k.c(bg), border: `1px solid ${band.p.line}` }, [
    text ? h('p', { ...k.font(b.levels[1]!), color: k.c(fg) }, 'Aa', { 'data-name': 'Sample' }) : h('div', { width: '48px', height: '48px', background: k.c(fg) }, [], { 'data-name': 'Shape' }),
  ], { 'data-name': 'Ground' });
  const pairCell = (p: (typeof pairs)[number], text: boolean, wrong = false) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(8) }, [
    sample(p.fg, p.bg, text),
    band.label(`${p.fg.name} on ${p.bg.name}`, {}, 'Pair'),
    band.code(`${p.contrast}:1${p.contrast < f.minContrast && text && !wrong ? ', large text only' : ''}`, {}, 'Contrast'),
    p.note ? band.note(p.note) : '',
  ], { 'data-name': `Pair: ${p.fg.name} on ${p.bg.name}` });
  const group = (title: string, note: string, cells: string[], attrs: Record<string, string> = {}) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(24) }, [
    h('div', { display: 'flex', flexDirection: 'column', gap: k.space(8) }, [band.sub(title), band.note(note)]),
    h('div', { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: k.space(24) }, cells, { 'data-name': `${title} pairs`, ...attrs }),
  ], { 'data-name': title });
  const groups = [
    forText.length ? group('Right', computed.length ? (pairs.length ? 'These may carry text: the pairs the brand lists, and the main colours that reach its contrast floor. Ratios are computed from the values.' : 'Worked out from the values: the brand allows what it does not forbid, and these reach its contrast floor.') : 'These may carry text. The ratio is computed from the two values.', forText.map((p) => pairCell(p, true))) : '',
    forShapes.length ? group('Shapes only', `Allowed together, but under 3:1: fine for shapes and fills, never for text.`, forShapes.map((p) => pairCell(p, false))) : '',
    never.length ? group('Wrong', 'Never put these together.', never.map((p) => pairCell(p, true, true)), DONT) : '',
  ];
  steps.push({ html: h('section', { display: 'flex', flexDirection: 'column', gap: k.space(48), padding: band.pad, background: band.p.bg, color: band.p.fg, marginTop: k.space(88) }, groups, { 'data-name': 'Pairs' }) });
  return b.board('3 Colour', steps);
}

// ---------------------------------------------------------------- 4 Type

function typeBoard(k: BrandKit, gaps: string[]): BoardPlan {
  const base = k.base();
  const b = new Board(k, k.scheme(base), gaps);
  const fams = k.families();
  const display = k.family('display');
  const roles = fams.map((f) => `${f.family} for ${f.role}`);
  const licence = k.data.fields.license || [...new Set(fams.map((f) => f.license).filter(Boolean))].join('. ');
  const intro = fams.length ? `${sentence(roles)}.${licence ? ` ${licence}` : ''}` : undefined;
  const parts: string[] = [b.header('Type', intro)];
  if (!fams.length) parts.push(b.gap('No fonts yet: add the families with brand_update (families, with role and weights) and their files with brand_asset_add.'));
  if (display) {
    const hero = k.type('hero', 220);
    const specimen = { ...k.font(hero), fontFamily: k.stack(display), fontWeight: k.weight(display, display.weights.length ? Math.max(...display.weights) : hero.weight) };
    parts.push(h('div', { display: 'flex', flexDirection: 'column', gap: k.space(40) }, [
      h('p', specimen, t(display.family), { 'data-name': 'Specimen' }),
      display.weights.length ? h('div', { display: 'flex', gap: k.space(48), flexWrap: 'wrap', borderTop: `1px solid ${b.p.line}`, paddingTop: k.space(24) }, display.weights.map((w) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(8) }, [
        h('p', { ...k.font(k.type('heading')), fontFamily: k.stack(display), fontWeight: w }, 'Aa', { 'data-name': 'Sample' }),
        b.code(String(w), {}, 'Weight'),
      ], { 'data-name': `Weight ${w}` })), { 'data-name': 'Weights' }) : '',
      h('p', { ...k.font(k.type('lead')), fontFamily: k.stack(display), color: b.p.muted, maxWidth: '980px' }, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 &amp;?!', { 'data-name': 'Characters' }),
    ], { 'data-name': `Family: ${display.family}`, ...SPECIMEN }));
  }
  const steps: BoardStep[] = [{ html: b.section('Type', parts, { gap: k.space(88) }) }];

  // The scale, every step at its real size.
  const scale = k.steps();
  const voice = k.data.voiceExamples.map((e) => e.good).filter(Boolean);
  const short = shortest(voice) ?? k.name;
  const long = k.data.fields.positioning || voice[0] || k.name;
  const rows = scale.map((s) => {
    const role = k.type('body');
    const fam = fams.find((x) => x.id === s.family || x.family === s.family);
    const meta = [`${s.size}px`, s.lineHeight, s.weight ? String(s.weight) : '', s.tracking].filter(Boolean).join(' / ');
    return h('div', { display: 'grid', gridTemplateColumns: '240px 1fr', gap: k.space(40), alignItems: 'baseline', borderTop: `1px solid ${b.p.line}`, paddingTop: k.space(20), paddingBottom: k.space(20) }, [
      h('div', { display: 'flex', flexDirection: 'column', gap: k.space(4) }, [b.label(s.name, {}, 'Name'), b.code(meta, {}, 'Values'), s.role ? b.note(s.role, {}, 'Role') : '']),
      h('p', {
        margin: 0, fontFamily: fam ? k.stack(fam) : role.family, fontSize: !s.suggested && k.env.tokens.has(s.token) ? `var(--${s.token})` : `${s.size}px`, fontWeight: s.weight ? k.weight(fam, s.weight) : undefined,
        lineHeight: s.lineHeight || undefined, letterSpacing: s.tracking || undefined, color: b.p.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, maxWidth: '60ch',
        // A step set as tight as a heading shows a heading's words; running text only on a reading leading.
      }, t(s.size >= 80 ? k.name : s.size >= 32 || Number(s.lineHeight) < 1.3 ? short : long), { 'data-name': 'Sample' }),
    ], { 'data-name': `Step: ${s.name}` });
  });
  steps.push({ html: b.section('Scale', [b.sub('Scale'), scale.length ? h('div', { display: 'flex', flexDirection: 'column' }, rows, { 'data-name': 'Steps', ...SPECIMEN }) : b.gap('No type scale yet: add steps with brand_update (typeScale, each with size, weight and line height).')], { gap: k.space(24), paddingTop: '0px' }) });

  // Other families on a band of their own.
  const others = fams.filter((x) => x.id !== display?.id);
  if (others.length) {
    const band = b.band(k.scheme(k.alternate() ?? base));
    steps.push({ html: h('section', { display: 'flex', flexDirection: 'column', gap: k.space(48), padding: band.pad, background: band.p.bg }, others.map((x) => {
      const mono = /\b(mono|code)\b/.test(x.role.toLowerCase());
      const sampleRole = k.type('lead');
      return h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: k.space(48), alignItems: 'end' }, [
        h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12) }, [
          h('p', { ...k.font(k.type('heading')), fontFamily: k.stack(x), fontWeight: k.weight(x, 700), color: band.p.fg }, t(x.family), { 'data-name': 'Family' }),
          band.note(`${x.role}${x.weights.length ? `. Weights ${x.weights.join(', ')}` : ''}${x.license ? `. ${x.license}` : ''}`),
        ]),
        h('p', { ...k.font(sampleRole), fontFamily: k.stack(x), color: band.p.fg }, 'ABCDEFGHIJKLM abcdefghijklm 0123456789 {} [] =&gt; $ _', { 'data-name': 'Characters' }),
      ], { 'data-name': `Family: ${x.family}`, ...SPECIMEN });
    }), { 'data-name': 'Other families' }) });
  }
  return b.board('4 Type', steps);
}

// ---------------------------------------------------------------- 5 Layout and spacing

function layoutBoard(k: BrandKit, gaps: string[]): BoardPlan {
  const base = k.base();
  const b = new Board(k, k.scheme(base), gaps);
  const f = k.data.fields;
  const accent = k.accent();
  const fill = accent ? k.c(accent) : b.p.fg;
  const spacing = [...k.data.spacing].sort((a, c) => a.value - c.value);
  const parts: string[] = [b.header('Layout and spacing', f.layoutNotes || undefined)];
  const tok = (token: string, suggested?: boolean) => (!suggested && k.env.tokens.has(token) ? `--${token}` : '');

  if (!spacing.length) parts.push(b.gap('No spacing scale yet: add the steps with brand_update (spacing, each a value in px).'));
  else {
    const total = spacing.reduce((a, s) => a + s.value, 0) + spacing.length * 24;
    const squares = total <= 1180 && spacing.every((s) => s.value <= 400);
    parts.push(h('div', squares ? { display: 'flex', alignItems: 'flex-end', gap: k.space(24), flexWrap: 'wrap' } : { display: 'flex', flexDirection: 'column', gap: k.space(12) }, spacing.map((s) => (squares
      ? h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12), alignItems: 'flex-start' }, [
        h('div', { width: `${s.value}px`, height: `${s.value}px`, background: fill, flex: 'none' }, [], { 'data-name': 'Size' }),
        b.label(`${s.value}`, {}, 'Value'), b.code(tok(s.token, s.suggested) || s.name, {}, 'Token'),
      ], { 'data-name': `Space ${s.name}` })
      : h('div', { display: 'grid', gridTemplateColumns: '160px 1fr', gap: k.space(24), alignItems: 'center' }, [
        b.code(`${s.value}px ${tok(s.token, s.suggested)}`, {}, 'Value'), h('div', { width: `${Math.min(s.value, 1100)}px`, height: '24px', background: fill }, [], { 'data-name': 'Size' }),
      ], { 'data-name': `Space ${s.name}` }))), { 'data-name': 'Spacing scale' }));
  }

  const radius = k.data.radius;
  const shapeFill = b.p.muted;
  const radiusCells = radius.map((r) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12) }, [
    h('div', { width: '160px', height: '160px', background: shapeFill, borderRadius: `${Math.min(r.value, 999)}px` }, [], { 'data-name': 'Shape' }),
    b.label(`${r.name}, ${r.value}px`, {}, 'Value'),
    tok(r.token, r.suggested) ? b.code(tok(r.token, r.suggested), {}, 'Token') : '',
    r.note ? b.note(r.note, { maxWidth: '360px' }, 'Note') : '',
  ], { 'data-name': `Radius ${r.name}` }));
  const facts: [string, string][] = [];
  if (f.container) facts.push(['Container', `${f.container}px${k.env.tokens.has('container') ? '  --container' : ''}`]);
  if (f.grid) facts.push(['Grid', f.grid]);
  facts.push(['Shadows', f.shadows === 'none' ? 'None' : 'Allowed']);
  facts.push(['Gradients', f.gradients === 'none' ? 'None' : 'Allowed']);
  const layoutRules = k.data.rules.filter((r) => r.topic === 'layout' && !r.flagged);
  parts.push(h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: k.space(88) }, [
    h('div', { display: 'flex', flexDirection: 'column', gap: k.space(24) }, [b.sub('Radius'), radius.length ? h('div', { display: 'flex', gap: k.space(40), flexWrap: 'wrap' }, radiusCells, { 'data-name': 'Radii' }) : b.gap('No radius yet: add it with brand_update (radius, a value in px; 0 for square).')], { 'data-name': 'Radius block' }),
    h('div', { display: 'flex', flexDirection: 'column', gap: k.space(24) }, [
      b.sub('Page'),
      h('div', { display: 'flex', flexDirection: 'column' }, facts.map(([key, value]) => h('div', { display: 'grid', gridTemplateColumns: '160px 1fr', gap: k.space(24), borderTop: `1px solid ${b.p.line}`, paddingTop: k.space(12), paddingBottom: k.space(12) }, [b.label(key), b.body(value)], { 'data-name': key })), { 'data-name': 'Facts' }),
      ...(f.container || f.grid ? [] : [b.gap('No container or grid yet: add them with brand_update (fields.container, fields.grid).')]),
      ...layoutRules.map((r) => b.body(`${r.text}${r.severity === 'soft' ? '' : ''}`, { color: b.p.fg })),
    ], { 'data-name': 'Page block' }),
  ], { 'data-name': 'Shape and page' }));

  // A grid, drawn when the brand states columns.
  const columns = Number(/(\d+)\s*-?\s*col/i.exec(f.grid)?.[1] ?? 0);
  if (columns > 0 && columns <= 24) {
    const gutter = Number(/(\d+)\s*px/i.exec(f.grid)?.[1] ?? 0);
    parts.push(h('div', { display: 'flex', flexDirection: 'column', gap: k.space(24) }, [
      b.sub('Grid'),
      h('div', { display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: `${gutter || 0}px`, height: '160px' }, Array.from({ length: columns }, () => h('div', { background: accent ? k.c(accent) : shapeFill }, [], { 'data-name': 'Column' })), { 'data-name': 'Columns' }),
      b.note(`${f.grid}${f.container ? `, inside a ${f.container}px container` : ''}.`),
    ], { 'data-name': 'Grid' }));
  }
  return b.board('5 Layout and spacing', [{ html: b.section('Layout', parts, { gap: k.space(88) }) }]);
}

// ---------------------------------------------------------------- 6 Components

function componentsBoard(k: BrandKit, gaps: string[]): BoardPlan {
  const base = k.base();
  const b = new Board(k, k.scheme(base), gaps);
  const parts = buttonParts(k, b.scheme);
  const steps: BoardStep[] = [];
  const accent = k.accent();
  const onAccent = accent ? k.textOn(accent) : null;
  const tag = (tone: 'accent' | 'neutral') => {
    const filled = tone === 'accent' && accent && onAccent;
    return h('div', { display: 'inline-flex', alignItems: 'center', padding: `${k.space(4)} ${k.space(12)}`, borderRadius: k.roundRadius(), background: filled ? k.c(accent) : 'transparent', border: `1px solid ${filled ? k.c(accent) : b.p.fg}`, alignSelf: 'flex-start' }, [
      h('span', { ...k.font(k.type('small'), 700), color: filled ? k.c(onAccent) : b.p.fg, whiteSpace: 'nowrap' }, tone === 'accent' ? 'New' : 'Tag', { 'data-name': 'Label' }),
    ], { 'data-name': `Tag / ${tone}` });
  };
  const field = h('div', { display: 'flex', flexDirection: 'column', gap: k.space(8), alignSelf: 'stretch' }, [
    h('span', { ...k.font(k.type('small'), 700), color: b.p.fg }, 'Label', { 'data-name': 'Label' }),
    h('div', { display: 'flex', alignItems: 'center', padding: `${k.space(12)} ${k.space(20)}`, border: `1px solid ${b.p.fg}`, borderRadius: k.radius() }, [
      h('span', { ...k.font(k.type('body')), color: b.p.muted, whiteSpace: 'nowrap' }, 'Placeholder', { 'data-name': 'Placeholder' }),
    ], { 'data-name': 'Box' }),
    h('span', { ...k.font(k.type('small')), color: b.p.muted }, 'Help text', { 'data-name': 'Hint' }),
  ], { 'data-name': 'Field' });
  const block = (name: string, children: string[], style: Style = {}) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(24), ...style }, children, { 'data-name': name });

  // The parts first, as mains; the composition at the top is filled with instances of them afterwards.
  steps.push({ html: b.section('Components', [
    b.header('Components', 'Built from the brand\'s own colours, type, spacing and radius. Edit a main below and every instance follows.'),
    h('div', { display: 'grid', gridTemplateColumns: '7fr 5fr', gap: k.space(88), alignItems: 'start', borderTop: `1px solid ${b.p.line}`, paddingTop: k.space(48) }, [
      h('div', { display: 'flex', flexDirection: 'column', gap: k.space(40) }, [], { 'data-name': 'Pitch' }),
      h('div', { display: 'flex', flexDirection: 'column', gap: k.space(24), padding: k.space(40), border: `1px solid ${b.p.line}`, borderRadius: k.radius() }, [], { 'data-name': 'Form' }),
    ], { 'data-name': 'In use', ...SPECIMEN }),
    block('Button block', [
      b.sub('Button'),
      h('div', { display: 'grid', gridTemplateColumns: 'repeat(3, max-content)', gap: `${k.space(40)} ${k.space(48)}`, alignItems: 'center' }, parts.mains, { 'data-name': 'Buttons', ...SPECIMEN }),
      b.note(parts.note),
    ]),
    h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: k.space(88) }, [
      block('Field block', [b.sub('Field'), h('div', { display: 'flex', flexDirection: 'column', width: '420px' }, [field], { 'data-name': 'Field holder', ...SPECIMEN })]),
      block('Tag block', [b.sub('Tag'), h('div', { display: 'flex', gap: k.space(12) }, [tag('accent'), tag('neutral')], { 'data-name': 'Tags', ...SPECIMEN })]),
    ], { 'data-name': 'Basics' }),
  ], { gap: k.space(88) }) });
  steps.push(...parts.defs);
  steps.push({ component: { layer: 'Field', name: 'Field', description: 'A labelled text field.', props: [{ name: 'label', type: 'text', target: 'Label' }, { name: 'placeholder', type: 'text', target: 'Placeholder' }, { name: 'hint', type: 'text', target: 'Hint' }] } });
  steps.push({ component: { layer: 'Tag / accent', name: 'Tag / accent', set: 'Tag', variant: { tone: 'accent' }, props: [{ name: 'label', type: 'text', target: 'Label' }] } });
  steps.push({ component: { layer: 'Tag / neutral', name: 'Tag / neutral', set: 'Tag', variant: { tone: 'neutral' }, props: [{ name: 'label', type: 'text', target: 'Label' }] } });

  // A card made of the parts above.
  const card = h('article', { display: 'flex', flexDirection: 'column', gap: k.space(20), padding: k.space(40), border: `1px solid ${b.p.line}`, borderRadius: k.radius(), width: '560px' }, [
    h('x-instance', {}, [], { component: 'Tag', 'prop-tone': 'accent', 'prop-label': 'New' }),
    h('h3', { ...k.font(b.levels[2]!, 700), color: b.p.fg }, t(k.name), { 'data-name': 'Title' }),
    h('p', { ...k.font(k.type('body')), color: b.p.muted, maxWidth: '60ch' }, t(k.data.fields.positioning || 'Body text'), { 'data-name': 'Body' }),
    h('div', { display: 'flex', gap: k.space(12) }, [
      h('x-instance', {}, [], { component: 'Button', 'prop-kind': 'primary', 'prop-size': 'default', 'prop-label': 'Primary' }),
      h('x-instance', {}, [], { component: 'Button', 'prop-kind': 'quiet', 'prop-size': 'default', 'prop-label': 'Quiet' }),
    ], { 'data-name': 'Actions' }),
  ], { 'data-name': 'Card' });
  steps.push({ html: b.section('Card', [b.sub('Card'), h('div', { display: 'flex' }, [card], { 'data-name': 'Card holder', ...SPECIMEN })], { gap: k.space(24), paddingTop: '0px' }) });
  steps.push({ component: { layer: 'Card', name: 'Card', description: 'A block with a tag, a title, a line of text and two actions.', props: [{ name: 'title', type: 'text', target: 'Title' }, { name: 'body', type: 'text', target: 'Body' }] } });

  // The composition: the brand's own words with the parts in use.
  const line = shortest(k.data.voiceExamples.map((e) => e.good)) ?? k.name;
  steps.push({ into: 'Pitch', html: [
    h('p', { ...k.font(k.type('heading')), color: b.p.fg, maxWidth: '760px' }, t(line), { 'data-name': 'Line' }),
    k.data.fields.positioning ? h('p', { ...k.font(k.type('lead')), color: b.p.muted, maxWidth: '640px' }, t(k.data.fields.positioning), { 'data-name': 'Positioning' }) : '',
    h('div', { display: 'flex', gap: k.space(12) }, [
      h('x-instance', {}, [], { component: 'Button', 'prop-kind': 'primary', 'prop-size': 'large', 'prop-label': 'Get started' }),
      h('x-instance', {}, [], { component: 'Button', 'prop-kind': 'quiet', 'prop-size': 'large', 'prop-label': 'Learn more' }),
    ], { 'data-name': 'Actions' }),
  ].join('') });
  steps.push({ into: 'Form', html: [
    h('x-instance', {}, [], { component: 'Tag', 'prop-tone': 'neutral', 'prop-label': 'Form' }),
    h('x-instance', { alignSelf: 'stretch' }, [], { component: 'Field', 'prop-label': 'Name', 'prop-placeholder': 'Placeholder', 'prop-hint': 'Help text' }),
    h('x-instance', { alignSelf: 'stretch' }, [], { component: 'Field', 'prop-label': 'Email', 'prop-placeholder': 'Placeholder', 'prop-hint': 'Help text' }),
    h('x-instance', {}, [], { component: 'Button', 'prop-kind': 'primary', 'prop-size': 'default', 'prop-label': 'Send' }),
  ].join('') });
  return b.board('6 Components', steps);
}

/** The Button set: three kinds in two sizes, from the brand's colours, as mains. Shared with the landing page. */
export function buttonParts(k: BrandKit, scheme: Scheme, labels: Record<string, string> = {}): { mains: string[]; defs: BoardStep[]; note: string; ok: boolean } {
  const paint = k.paint(scheme);
  const accent = k.accent();
  const onAccent = accent ? k.textOn(accent) : null;
  const fg = scheme.fg;
  const inverse = fg && scheme.bg && k.canText(scheme.bg, fg) ? scheme.bg : null;
  const kinds: { kind: string; label: string; bg: string; color: string; border: string }[] = [];
  if (accent && onAccent) kinds.push({ kind: 'primary', label: 'Primary', bg: k.c(accent), color: k.c(onAccent), border: k.c(accent) });
  if (fg && inverse) kinds.push({ kind: accent && onAccent ? 'secondary' : 'primary', label: accent && onAccent ? 'Secondary' : 'Primary', bg: k.c(fg), color: k.c(inverse), border: k.c(fg) });
  kinds.push({ kind: 'quiet', label: 'Quiet', bg: 'transparent', color: paint.fg, border: paint.fg });
  const sizes = [
    { size: 'default', pad: `${k.space(12)} ${k.space(24)}`, role: k.type('body') },
    { size: 'large', pad: `${k.space(20)} ${k.space(40)}`, role: k.type('lead') },
  ];
  const mains: string[] = [];
  const defs: BoardStep[] = [];
  for (const s of sizes) {
    for (const kd of kinds) {
      const name = `Button / ${kd.kind} / ${s.size}`;
      mains.push(h('button', { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: s.pad, background: kd.bg, border: `1px solid ${kd.border}`, borderRadius: k.radius(), cursor: 'pointer', alignSelf: 'flex-start' }, [
        h('span', { ...k.font(s.role, 700), color: kd.color, whiteSpace: 'nowrap' }, t(labels[kd.kind] ?? kd.label), { 'data-name': 'Label' }),
      ], { 'data-name': name }));
      defs.push({ component: { layer: name, name, set: 'Button', variant: { kind: kd.kind, size: s.size }, props: [{ name: 'label', type: 'text', target: 'Label' }] } });
    }
  }
  const note = accent && !onAccent ? `${accent.name} carries no text colour the brand allows, so the primary button uses the text colour instead.` : 'Three kinds in two sizes. Change one main and every instance follows.';
  return { mains, defs, note, ok: Boolean(accent && onAccent) };
}

// ---------------------------------------------------------------- 7 Voice

function voiceBoard(k: BrandKit, gaps: string[]): BoardPlan {
  const alt = k.alternate();
  const b = new Board(k, k.scheme(alt ?? k.base()), gaps);
  const f = k.data.fields;
  const examples = k.data.voiceExamples;
  const goods = examples.map((e) => e.good).filter(Boolean);
  const heroLine = shortest(goods);
  const parts: string[] = [b.header('Voice', f.tone || undefined)];
  if (!f.tone) parts.push(b.gap('No tone yet: describe it in a line with brand_update (fields.tone).'));
  if (heroLine) parts.push(h('p', { ...k.font(heroLine.length <= 40 ? k.type('headline', 140) : k.type('heading')), color: b.p.fg, maxWidth: '1180px' }, t(heroLine), { 'data-name': 'In its own words' }));

  // Say this, not that.
  const rest = examples.filter((e) => e.good !== heroLine || e.bad);
  const withBad = rest.some((e) => e.bad);
  if (!examples.length) parts.push(b.gap('No voice examples yet: add pairs of good and bad lines with brand_update (voiceExamples).'));
  else if (rest.length) {
    parts.push(h('div', { display: 'flex', flexDirection: 'column', gap: k.space(24) }, [h('div', { display: 'flex', flexDirection: 'column' }, [
      h('div', { display: 'grid', gridTemplateColumns: withBad ? '1fr 1fr' : '1fr', gap: k.space(48), paddingBottom: k.space(20) }, [b.label('Say'), withBad ? b.label('Not') : ''], { 'data-name': 'Heads' }),
      ...rest.map((e) => h('div', { display: 'grid', gridTemplateColumns: withBad ? '1fr 1fr' : '1fr', gap: k.space(48), borderTop: `1px solid ${b.p.line}`, paddingTop: k.space(20), paddingBottom: k.space(20) }, [
        h('p', { ...k.font(k.type('lead')), color: b.p.fg }, t(e.good || ' '), { 'data-name': 'Good' }),
        withBad ? (e.bad ? h('p', { ...k.font(k.type('lead')), color: b.p.muted, textDecoration: 'line-through' }, t(e.bad), { 'data-name': 'Bad', ...DONT }) : h('div', {}, [])) : '',
      ], { 'data-name': 'Example' })),
    ], { 'data-name': 'Examples' }), withBad ? '' : b.gap('No bad lines yet: a good line says more next to a bad one. Add them with brand_update (voiceExamples, bad).')], { 'data-name': 'Say this' }));
  }

  // Words.
  const use = k.data.words.filter((w) => w.use === 'use');
  const avoid = k.data.words.filter((w) => w.use === 'avoid');
  if (use.length || avoid.length) {
    parts.push(h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: k.space(48) }, [
      h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12) }, [b.sub('Words to use'), use.length ? b.body(use.map((w) => w.word).join(', ')) : b.note('None listed.')], { 'data-name': 'Use' }),
      h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12) }, [b.sub('Words to avoid'), avoid.length
        ? h('div', { display: 'flex', flexDirection: 'column' }, avoid.map((w) => h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: k.space(24), borderTop: `1px solid ${b.p.line}`, paddingTop: k.space(12), paddingBottom: k.space(12) }, [
          h('p', { ...k.font(k.type('body')), color: b.p.muted, textDecoration: 'line-through' }, t(w.word), { 'data-name': 'Avoid' }),
          b.body(w.instead ? `Say ${w.instead}` : 'Rewrite without it'),
        ], { 'data-name': `Word: ${w.word}` })), { 'data-name': 'Avoid list', ...DONT })
        : b.note('None listed.')], { 'data-name': 'Avoid' }),
    ], { 'data-name': 'Words' }));
  } else parts.push(b.gap('No word list yet: add words to use and to avoid with brand_update (words).'));

  // Every rule, by topic, hard ones first.
  const rules = k.data.rules.filter((r) => !r.flagged);
  if (rules.length) {
    const topics = [...new Set(rules.map((r) => r.topic))];
    const groups = topics.map((topic) => {
      const list = rules.filter((r) => r.topic === topic).sort((a, c) => (a.severity === c.severity ? 0 : a.severity === 'hard' ? -1 : 1));
      return h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12) }, [
        b.label(TOPIC_NAMES[topic]),
        ...list.map((r: BrandRule) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(4), borderTop: `1px solid ${b.p.line}`, paddingTop: k.space(12) }, [
          b.body(r.text),
          r.severity === 'soft' ? b.note('Soft: break it for a reason, and say why.') : '',
        ], { 'data-name': `Rule: ${r.text.slice(0, 40)}` })),
      ], { 'data-name': `Topic: ${TOPIC_NAMES[topic]}` });
    });
    parts.push(h('div', { display: 'flex', flexDirection: 'column', gap: k.space(24) }, [
      b.sub('Rules'),
      h('div', { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: `${k.space(48)} ${k.space(40)}`, alignItems: 'start' }, groups, { 'data-name': 'By topic' }),
    ], { 'data-name': 'Rules' }));
  } else parts.push(b.gap('No rules yet: add do and don\'t rules with brand_update (rules, each hard or soft, with a topic).'));
  return b.board('7 Voice', [{ html: b.section('Voice', parts, { gap: k.space(88) }) }]);
}

// ---------------------------------------------------------------- the template

export const brandSystem: TemplateDef = {
  id: 'brand-system',
  name: 'Brand system',
  description: 'A visual foundation from the brand\'s data (the canonical 16-chapter brandbook lives in the brand document), seven boards side by side on a page named "Brand system": cover, logo (variants, size and clear space, don\'ts), colour (swatches, pairs right and wrong with contrast), type (specimens and the scale at real size), layout and spacing, components (Button, Field, Tag, Card as real components with variants) and voice (tone, examples, words, rules by topic). Gaps in the brand show as one quiet line saying how to fill them.',
  parts: [...BRAND_SYSTEM_PARTS],
  fileName: (brand) => `${brand} brand system`,
  build(env: TemplateEnv, options: TemplateOptions): TemplatePlan {
    const k = new BrandKit(env);
    const gaps: string[] = [];
    const want = (key: string) => !options.only?.length || options.only.includes(key);
    const builders: [string, () => BoardPlan][] = [
      ['cover', () => cover(k, gaps)], ['logo', () => logoBoard(k, gaps)], ['colour', () => colourBoard(k, gaps)], ['type', () => typeBoard(k, gaps)],
      ['layout', () => layoutBoard(k, gaps)], ['components', () => componentsBoard(k, gaps)], ['voice', () => voiceBoard(k, gaps)],
    ];
    return { page: 'Brand system', boards: builders.filter(([key]) => want(key)).map(([, build]) => build()), gaps };
  },
};
