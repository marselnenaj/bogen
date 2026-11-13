import { clampChroma, converter, formatHex, parse } from 'culori';
import { contrastRatio } from './brand.ts';

/**
 * Palettes with roles, computed in OKLCH, offline and deterministic. A palette is a decision for a subject, not a
 * default: a ground, an ink, two or three supporting colours and an action colour, each with what it is for, and the
 * contrast of every text pair, so that a braver palette does not cost readability.
 *
 * The subject palettes are Bogen's own, written for this module. No third-party colour dataset is shipped: see
 * THIRD_PARTY_NOTICES.md for the historical sets that were considered and why they are not here.
 */
export type PaletteRole = 'ground' | 'surface' | 'ink' | 'ink-muted' | 'support' | 'action' | 'action-ink';
export interface PaletteColour { role: PaletteRole; token: string; name: string; hex: string; oklch: [number, number, number]; use: string }
/** A text or shape pair with its WCAG 2 contrast ratio, the measure WCAG 2.x and EN 301 549 use. */
export interface PalettePair { fg: string; bg: string; wcag: number; passes: string }
export interface Palette {
  id: string; name: string; source: 'subject' | 'seed' | 'image'; idea: string;
  /** Which of Itten's seven contrasts carries the palette: light-dark, hue, warm-cold, complementary, simultaneous, saturation, extension. */
  contrast: string;
  colours: PaletteColour[]; pairs: PalettePair[];
  tokens: { name: string; kind: 'color'; value: string }[];
}

const toOklch = converter('oklch');
const toRgb = converter('rgb');
const hexOf = (l: number, c: number, h: number) => formatHex(clampChroma({ mode: 'oklch', l, c, h }, 'oklch')) ?? '#000000';
const lch = (hex: string): [number, number, number] => {
  const o = toOklch(parse(hex)!)!;
  return [round(o.l, 3), round(o.c ?? 0, 3), round(o.h ?? 0, 1)];
};
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const wrap = (h: number) => ((h % 360) + 360) % 360;

function pair(fg: PaletteColour, bg: PaletteColour, size: 'body' | 'large' | 'shape' = 'body'): PalettePair {
  const wcag = round(contrastRatio(fg.hex, bg.hex), 2);
  if (size === 'shape') return { fg: fg.token, bg: bg.token, wcag, passes: wcag >= 3 ? 'a filled shape that stands out (3:1)' : 'a filled shape that needs an edge or outline to stand out' };
  const need = size === 'body' ? 4.5 : 3;
  return { fg: fg.token, bg: bg.token, wcag, passes: wcag >= need ? (size === 'body' ? 'body text' : 'large text and icons') : wcag >= 3 ? 'large text only' : 'areas and illustration only, not for text' };
}

function finish(id: string, name: string, source: Palette['source'], idea: string, contrast: string, colours: Omit<PaletteColour, 'oklch'>[], prefix = ''): Palette {
  const full = colours.map((c) => ({ ...c, token: prefix + c.token, oklch: lch(c.hex) }));
  const by = (role: PaletteRole) => full.filter((c) => c.role === role);
  const ground = by('ground')[0]!, surface = by('surface')[0];
  const pairs: PalettePair[] = [];
  for (const ink of [...by('ink'), ...by('ink-muted')]) { pairs.push(pair(ink, ground)); if (surface) pairs.push(pair(ink, surface)); }
  for (const s of by('support')) pairs.push(pair(s, ground, 'large'));
  const action = by('action')[0], actionInk = by('action-ink')[0];
  if (action && actionInk) pairs.push(pair(actionInk, action));
  if (action) pairs.push(pair(action, ground, 'shape'));
  return { id, name, source, idea, contrast, colours: full, pairs, tokens: full.map((c) => ({ name: c.token, kind: 'color', value: c.hex })) };
}

/** Light or dark ink for text on a colour: whichever reads better. */
function inkOn(hex: string, dark: string, light = '#ffffff'): string {
  return contrastRatio(dark, hex) >= contrastRatio(light, hex) ? dark : light;
}

const HARMONIES: { id: string; name: string; offsets: number[]; contrast: string; idea: string }[] = [
  { id: 'analogous', name: 'Analogous', offsets: [-30, 30], contrast: 'light-dark, with hue kept close', idea: 'Neighbouring hues: calm and coherent, carried by light against dark.' },
  { id: 'complementary', name: 'Complementary', offsets: [180, 165], contrast: 'complementary', idea: 'The seed against its opposite: the strongest pull, so let one side dominate in area.' },
  { id: 'split', name: 'Split complementary', offsets: [150, 210], contrast: 'hue, with complementary tension', idea: 'Two neighbours of the opposite: lively, easier to balance than a straight complement.' },
  { id: 'triadic', name: 'Triad', offsets: [120, 240], contrast: 'hue', idea: 'Three hues a third apart at even weight: for a multi-colour system, coding categories or a playful subject.' },
  { id: 'warm-cold', name: 'Warm against cold', offsets: [0, 0], contrast: 'warm-cold', idea: 'The seed set against a colour from the other side of the wheel\'s temperature, with tinted neutrals.' },
  { id: 'tinted', name: 'Tinted neutrals, one colour', offsets: [], contrast: 'saturation and extension', idea: 'Restraint on purpose: every neutral tinted with the seed, the seed itself small and saturated. Right when the content or the brand must lead.' },
];

/** Palettes around a seed colour, one per harmony. Neutrals are tinted with the seed's hue, never plain grey. */
export function palettesFromSeed(seed: string, options: { dark?: boolean; prefix?: string } = {}): Palette[] {
  const parsed = parse(seed);
  if (!parsed) throw new Error(`Not a colour: ${seed}. Give a hex value such as #2f8fa6, or a CSS colour.`);
  const [, c0, h0] = lch(formatHex(parsed)!);
  const chroma = Math.max(0.08, Math.min(0.2, c0 || 0.12));
  const dark = !!options.dark;
  return HARMONIES.map((hm) => {
    const ground = dark ? hexOf(0.2, 0.025, h0) : hexOf(0.97, 0.014, h0);
    const surface = dark ? hexOf(0.26, 0.03, h0) : hexOf(0.93, 0.02, h0);
    const inkHue = hm.id === 'complementary' ? h0 + 180 : h0;
    const ink = dark ? hexOf(0.95, 0.015, inkHue) : hexOf(0.24, 0.035, inkHue);
    const muted = dark ? hexOf(0.76, 0.025, inkHue) : hexOf(0.45, 0.03, inkHue);
    const warm = (h: number) => wrap(h) < 110 || wrap(h) > 330;
    const offsets = hm.id === 'warm-cold' ? [warm(h0) ? 230 - h0 : 45 - h0] : hm.offsets;
    const supports = offsets.map((o, i) => ({ role: 'support' as const, token: `support-${i + 1}`, name: `${hm.name} ${i + 1}`, hex: hexOf(dark ? 0.74 : 0.62, chroma * 0.85, wrap(h0 + o)), use: 'Areas, illustration, charts and categories; large text only where its pair passes.' }));
    const action = hexOf(dark ? 0.72 : 0.52, Math.max(chroma, 0.12), h0);
    return finish(`${hm.id}${dark ? '-dark' : ''}`, `${hm.name}${dark ? ', dark' : ''}`, 'seed', hm.idea, hm.contrast, [
      { role: 'ground', token: 'ground', name: 'Ground', hex: ground, use: 'The page.' },
      { role: 'surface', token: 'surface', name: 'Surface', hex: surface, use: 'Panels and quiet areas, tinted with the seed.' },
      { role: 'ink', token: 'ink', name: 'Ink', hex: ink, use: 'Text and lines.' },
      { role: 'ink-muted', token: 'ink-muted', name: 'Ink, muted', hex: muted, use: 'Secondary text.' },
      ...supports,
      { role: 'action', token: 'action', name: 'Action', hex: action, use: 'The primary action and what needs attention.' },
      { role: 'action-ink', token: 'action-ink', name: 'Action ink', hex: inkOn(action, dark ? ground : ink), use: 'Text on the action colour.' },
    ], options.prefix);
  });
}

/** Dominant colours of an image in OKLab, by k-means with a fixed start: the same picture always gives the same answer. */
export function dominantColours(rgba: Uint8ClampedArray | Uint8Array, k = 6): { hex: string; share: number; chroma: number; lightness: number }[] {
  const toLab = converter('oklab');
  const pts: [number, number, number][] = [];
  const step = Math.max(1, Math.floor(rgba.length / 4 / 6000));
  for (let i = 0; i + 3 < rgba.length; i += 4 * step) {
    if (rgba[i + 3]! < 128) continue;
    const o = toLab({ mode: 'rgb', r: rgba[i]! / 255, g: rgba[i + 1]! / 255, b: rgba[i + 2]! / 255 })!;
    pts.push([o.l, o.a ?? 0, o.b ?? 0]);
  }
  if (!pts.length) return [];
  // Start from points spread through the image, sorted by lightness, so the result does not depend on chance.
  const sorted = [...pts].sort((a, b) => a[0] - b[0]);
  let centres = Array.from({ length: Math.min(k, sorted.length) }, (_, i) => [...sorted[Math.floor(((i + 0.5) * sorted.length) / k)]!] as [number, number, number]);
  let groups: number[] = [];
  for (let iter = 0; iter < 12; iter++) {
    groups = pts.map((p) => centres.reduce((best, c, j) => {
      const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
      return d < best.d ? { d, j } : best;
    }, { d: Infinity, j: 0 }).j);
    centres = centres.map((c, j) => {
      const mine = pts.filter((_, i) => groups[i] === j);
      return mine.length ? [0, 1, 2].map((a) => mine.reduce((s, p) => s + p[a]!, 0) / mine.length) as [number, number, number] : c;
    });
  }
  return centres.map((c, j) => {
    const hex = formatHex(clampChroma({ mode: 'oklab', l: c[0], a: c[1], b: c[2] }, 'oklch')) ?? '#000000';
    const [l, ch] = lch(hex);
    return { hex, share: round(groups.filter((g) => g === j).length / groups.length, 3), chroma: ch, lightness: l };
  }).filter((c) => c.share > 0).sort((a, b) => b.share - a.share);
}

/** A palette taken from a picture: its ground and ink from the dominant colours, its supports and action from its accents. */
export function paletteFromImage(rgba: Uint8ClampedArray | Uint8Array, options: { dark?: boolean; prefix?: string } = {}): Palette[] {
  const found = dominantColours(rgba, 7);
  if (!found.length) throw new Error('The image has no opaque pixels to read colours from.');
  const chromatic = found.filter((c) => c.chroma >= 0.05).sort((a, b) => b.chroma * Math.sqrt(b.share) - a.chroma * Math.sqrt(a.share));
  const main = found[0]!;
  const [, , hMain] = lch(main.hex);
  const accent = chromatic[0] ?? main;
  const [la, ca, ha] = lch(accent.hex);
  const ground = options.dark ? hexOf(0.2, Math.min(0.03, lch(main.hex)[1]), hMain) : hexOf(0.96, Math.min(0.02, lch(main.hex)[1] + 0.005), hMain);
  const ink = options.dark ? hexOf(0.95, 0.015, hMain) : hexOf(0.23, 0.03, hMain);
  const supports = chromatic.slice(1, 4).map((c, i) => {
    const [l, ch, h] = lch(c.hex);
    return { role: 'support' as const, token: `support-${i + 1}`, name: `From the picture ${i + 1}`, hex: hexOf(Math.min(0.75, Math.max(0.45, l)), ch, h), use: `${Math.round(c.share * 100)}% of the picture. Areas, illustration and charts.` };
  });
  const action = hexOf(options.dark ? Math.max(0.65, la) : Math.min(0.55, la), Math.max(0.1, ca), ha);
  return [finish('image', 'From the picture', 'image', `Ground and ink tinted with the picture's main colour (${main.hex}, ${Math.round(main.share * 100)}%), supports and the action from its accents, so the page and the photograph belong together.`, 'extension: large quiet areas against small saturated ones', [
    { role: 'ground', token: 'ground', name: 'Ground', hex: ground, use: 'The page, tinted with the picture.' },
    { role: 'surface', token: 'surface', name: 'Surface', hex: options.dark ? hexOf(0.26, 0.03, hMain) : hexOf(0.92, 0.025, hMain), use: 'Panels and quiet areas.' },
    { role: 'ink', token: 'ink', name: 'Ink', hex: ink, use: 'Text and lines.' },
    { role: 'ink-muted', token: 'ink-muted', name: 'Ink, muted', hex: options.dark ? hexOf(0.76, 0.02, hMain) : hexOf(0.45, 0.025, hMain), use: 'Secondary text.' },
    ...supports,
    { role: 'action', token: 'action', name: 'Action', hex: action, use: 'The primary action: the picture\'s strongest accent.' },
    { role: 'action-ink', token: 'action-ink', name: 'Action ink', hex: inkOn(action, options.dark ? ground : ink), use: 'Text on the action colour.' },
  ], options.prefix), ...palettesFromSeed(accent.hex, options).filter((p) => p.id.startsWith('analogous') || p.id.startsWith('tinted'))];
}

/** Bogen's own subject palettes: colours named after the materials of a world, each with the contrast that carries it. */
const SUBJECTS: { id: string; name: string; words: string[]; idea: string; contrast: string; colours: [PaletteRole, string, string][] }[] = [
  { id: 'swimming-pool', name: 'Pool and lane ropes', words: ['swim', 'pool', 'water', 'sport', 'school', 'kids', 'summer'], idea: 'Tile blue and the red and yellow of lane ropes at equal weight: a cheerful multi-colour system.', contrast: 'hue', colours: [['ground', 'Chlorine pale', '#eef7f8'], ['surface', 'Wet tile', '#d7eef1'], ['ink', 'Deep end', '#0f2f3a'], ['ink-muted', 'Shallow end', '#3f6670'], ['support', 'Pool tile', '#2f8fa6'], ['support', 'Rope yellow', '#f2c230'], ['action', 'Rope red', '#c8352d'], ['action-ink', 'White', '#ffffff']] },
  { id: 'forest-floor', name: 'Forest floor', words: ['forest', 'garden', 'plant', 'outdoor', 'hike', 'wood', 'nature', 'seed', 'farm'], idea: 'Moss, bark and lichen with one mushroom orange: earthy without beige.', contrast: 'warm-cold', colours: [['ground', 'Lichen', '#eef1e6'], ['surface', 'Fern shade', '#dde5d0'], ['ink', 'Bark', '#2b2620'], ['ink-muted', 'Peat', '#5a5348'], ['support', 'Moss', '#5d7a2e'], ['support', 'Pine', '#1f4d3a'], ['action', 'Chanterelle', '#d9821f'], ['action-ink', 'Bark', '#2b2620']] },
  { id: 'night-city', name: 'Night city', words: ['night', 'city', 'transit', 'bus', 'train', 'travel', 'music', 'club', 'late'], idea: 'Asphalt dark with sodium, route and signal colours: light against dark, the lights small and each with its job.', contrast: 'light-dark, with extension', colours: [['ground', 'Asphalt', '#14181f'], ['surface', 'Wet street', '#1f2630'], ['ink', 'Street light', '#eef1f5'], ['ink-muted', 'Kerb', '#9aa4b2'], ['support', 'Sodium', '#f2a33a'], ['support', 'Route blue', '#4f8df5'], ['action', 'Signal green', '#3ccf8e'], ['action-ink', 'Asphalt', '#14181f']] },
  { id: 'print-shop', name: 'Riso print shop', words: ['print', 'zine', 'book', 'poster', 'magazine', 'editorial', 'design', 'agency', 'studio'], idea: 'Fluorescent pink and federal blue overprinted on white stock: two inks doing everything.', contrast: 'complementary, with simultaneous overprint', colours: [['ground', 'Stock white', '#fbfaf7'], ['surface', 'Newsprint', '#efece4'], ['ink', 'Black ink', '#1b1b1d'], ['ink-muted', 'Half tone', '#5c5c62'], ['support', 'Federal blue', '#3255a4'], ['support', 'Overprint violet', '#6b4a9e'], ['action', 'Fluo pink', '#ec4d84'], ['action-ink', 'Black ink', '#1b1b1d']] },
  { id: 'clinic', name: 'Calm clinic', words: ['health', 'clinic', 'care', 'doctor', 'vet', 'medical', 'therapy', 'pharmacy', 'patient'], idea: 'Sage and soft coral on a cool white: reassuring, with status colours that stay distinct.', contrast: 'saturation: soft areas, crisp states', colours: [['ground', 'Cool white', '#f6f9f8'], ['surface', 'Sage mist', '#e3ece8'], ['ink', 'Charting ink', '#18302b'], ['ink-muted', 'Slate sage', '#4f6660'], ['support', 'Sage', '#6f9a86'], ['support', 'Coral', '#e58a72'], ['action', 'Clinic teal', '#11766d'], ['action-ink', 'White', '#ffffff']] },
  { id: 'ledger', name: 'Ledger and stamp', words: ['finance', 'bank', 'invoice', 'tax', 'accounting', 'legal', 'law', 'contract', 'compliance', 'insurance'], idea: 'Ruled-ledger green and stamp-pad blue with a single deadline red: restraint that comes from the paperwork itself.', contrast: 'light-dark, with one hue for urgency', colours: [['ground', 'Ledger paper', '#f7f8f3'], ['surface', 'Ruled green', '#e6ece1'], ['ink', 'Iron gall', '#1c2230'], ['ink-muted', 'Pencil', '#5b6170'], ['support', 'Ledger green', '#3e6b4f'], ['support', 'Stamp blue', '#2d4f8a'], ['action', 'Deadline red', '#b3261e'], ['action-ink', 'White', '#ffffff']] },
  { id: 'workshop', name: 'Workshop', words: ['tool', 'repair', 'bike', 'craft', 'maker', 'hardware', 'engine', 'garage', 'build', 'construction'], idea: 'Safety yellow, enamel green and steel on concrete: function colours of a workshop.', contrast: 'hue, with light-dark', colours: [['ground', 'Concrete', '#eceeee'], ['surface', 'Galvanised', '#d9dddf'], ['ink', 'Graphite', '#1e2326'], ['ink-muted', 'Steel', '#58626a'], ['support', 'Enamel green', '#2e7d5b'], ['support', 'Tool red', '#c23b2a'], ['action', 'Safety yellow', '#f2c70f'], ['action-ink', 'Graphite', '#1e2326']] },
  { id: 'kitchen', name: 'Market kitchen', words: ['food', 'restaurant', 'bakery', 'cafe', 'coffee', 'recipe', 'kitchen', 'market', 'grocery', 'wine'], idea: 'Tomato, basil and olive oil on enamel white: appetite colours, used at full strength in small areas.', contrast: 'complementary, red against green', colours: [['ground', 'Enamel', '#f7f8f4'], ['surface', 'Flour', '#f1efe8'], ['ink', 'Espresso', '#2a1d17'], ['ink-muted', 'Roast', '#6b5a50'], ['support', 'Basil', '#3f7d3a'], ['support', 'Olive oil', '#c9a227'], ['action', 'Tomato', '#d6402b'], ['action-ink', 'White', '#ffffff']] },
  { id: 'sky-weather', name: 'Weather and sky', words: ['weather', 'climate', 'energy', 'solar', 'air', 'flight', 'aviation', 'sky', 'wind'], idea: 'A gradient of daylight from dawn to dusk as a stepped scale, for data that moves through the day.', contrast: 'warm-cold, as a sequence', colours: [['ground', 'High cloud', '#f4f8fc'], ['surface', 'Haze', '#e2ebf5'], ['ink', 'Storm', '#152238'], ['ink-muted', 'Overcast', '#53627a'], ['support', 'Noon blue', '#3f86d8'], ['support', 'Dusk violet', '#7a5aa6'], ['action', 'Dawn orange', '#e9752e'], ['action-ink', 'Storm', '#152238']] },
  { id: 'terminal-green', name: 'Instrument panel', words: ['developer', 'code', 'api', 'data', 'monitor', 'devops', 'security', 'analytics', 'dashboard'], idea: 'Instrument colours on deep navy: status colours each with one meaning, not a single neon accent.', contrast: 'hue, as a coded system', colours: [['ground', 'Panel navy', '#0f1729'], ['surface', 'Bezel', '#18223a'], ['ink', 'Readout', '#e8edf7'], ['ink-muted', 'Scale marks', '#93a0b8'], ['support', 'Nominal teal', '#2fbfa8'], ['support', 'Caution amber', '#f0b429'], ['support', 'Fault red', '#ef5b5b'], ['action', 'Signal blue', '#5b8cff'], ['action-ink', 'Panel navy', '#0f1729']] },
];

/** Subject palettes whose words appear in the text, best match first; all of them when nothing matches. */
export function palettesFromSubject(text: string, options: { prefix?: string } = {}): Palette[] {
  const q = text.toLowerCase();
  const scored = SUBJECTS.map((s) => ({ s, n: s.words.filter((w) => new RegExp(`\\b${w}`).test(q)).length })).sort((a, b) => b.n - a.n);
  const hits = scored.filter((x) => x.n > 0);
  return (hits.length ? hits : scored).slice(0, 4).map(({ s }) => finish(s.id, s.name, 'subject', s.idea, s.contrast,
    s.colours.map(([role, name, hex], i, all) => ({ role, name, hex, token: role === 'support' ? `support-${all.slice(0, i + 1).filter(([r]) => r === 'support').length}` : role, use: USES[role] })), options.prefix));
}
const USES: Record<PaletteRole, string> = {
  ground: 'The page.', surface: 'Panels and quiet areas.', ink: 'Text and lines.', 'ink-muted': 'Secondary text.',
  support: 'Areas, illustration, charts and categories; large text only where its pair passes.', action: 'The primary action and what needs attention.', 'action-ink': 'Text on the action colour.',
};
