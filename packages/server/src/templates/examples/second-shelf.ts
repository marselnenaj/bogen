import { Paint, type BrandSpec } from '../brand-spec.ts';
import { h, type BrandKit, type Style } from '../kit.ts';
import type { BoardPlan } from '../types.ts';
import type { ExampleDef } from './types.ts';

const shelfSvg = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 40"><rect x="4" y="6" width="8" height="28" fill="${color}"/><rect x="14" y="2" width="8" height="32" fill="${color}"/><rect x="24" y="10" width="7" height="24" fill="${color}"/><rect x="33" y="4" width="7" height="30" fill="${color}"/><rect x="0" y="34" width="44" height="4" fill="${color}"/></svg>`;

const brand: BrandSpec = {
  name: 'Second Shelf',
  positioning: 'A used bookshop that buys, sells and reads aloud.',
  audience: 'Neighbours, students, and anyone with a box of books to sell.',
  tone: 'Warm and dry. Dates, times and what to bring.',
  fields: { gradients: 'none', shadows: 'none' },
  colors: [
    { name: 'Pink', role: 'primary', value: '#ff5fa8', token: 'pink', note: 'Riso pink: events.' },
    { name: 'Blue', role: 'accent', value: '#24408c', token: 'blue', note: 'Riso blue: buying and selling.' },
    { name: 'Sheet', role: 'background', value: '#fbf8f2', token: 'sheet' },
    { name: 'Ink', role: 'text', value: '#1d1a1b', token: 'ink' },
  ],
  pairings: [{ fg: 'ink', bg: 'pink', verdict: 'allow' }, { fg: 'sheet', bg: 'blue', verdict: 'allow' }, { fg: 'pink', bg: 'blue', verdict: 'allow', note: 'Display sizes only, 3.4:1.' }, { fg: 'pink', bg: 'sheet', verdict: 'forbid' }],
  families: [
    { family: 'Bodoni Moda', role: 'display', fallback: 'Didot, serif', weights: [700], token: 'bodoni', license: 'OFL' },
    { family: 'Work Sans', role: 'body', fallback: '"Helvetica Neue", Arial, sans-serif', weights: [500, 600], token: 'work', license: 'OFL' },
  ],
  typeScale: [
    { name: 'Poster', role: 'display', size: 250, weight: 700, lineHeight: '0.82', tracking: '-0.035em', family: 'Bodoni Moda', token: 'text-poster' },
    { name: 'Headline', role: 'h1', size: 118, weight: 700, lineHeight: '0.92', tracking: '-0.02em', family: 'Bodoni Moda', token: 'text-headline' },
    { name: 'Details', role: 'body', size: 32, weight: 500, lineHeight: '1.35', family: 'Work Sans', token: 'text-details' },
    { name: 'Body', role: 'body', size: 28, weight: 500, lineHeight: '1.35', family: 'Work Sans', token: 'text-body' },
  ],
  spacing: [8, 16, 28, 48, 56, 64, 72],
  radius: [0],
  logos: [
    { name: 'Shelf', background: 'pink', minWidth: 24, clearSpace: 8, svg: shelfSvg('#1d1a1b') },
    { name: 'Shelf, light', background: 'light', minWidth: 24, clearSpace: 8, svg: shelfSvg('#1d1a1b') },
    { name: 'Shelf, reversed', background: 'dark', minWidth: 24, clearSpace: 8, svg: shelfSvg('#fbf8f2') },
  ],
  rules: [
    { text: 'Headlines in Bodoni Moda italic. Facts in Work Sans, never italic.', kind: 'do', severity: 'soft', topic: 'type' },
    { text: 'Pink for events, blue for buying and selling.', kind: 'do', severity: 'soft', topic: 'color' },
  ],
  voice: [{ good: 'We buy books.', bad: 'Turn your old books into instant cash today!' }, { good: 'Bring one poem, or none.', bad: 'Join our vibrant literary community.' }],
};

function images(k: BrandKit): BoardPlan[] {
  const p = new Paint(k);
  const serif = p.f('bodoni');
  const sans = p.f('work');
  const d = (size: number, extra: Style = {}): Style => ({ margin: 0, fontFamily: serif, fontSize: `${size}px`, fontWeight: 700, fontStyle: 'italic', lineHeight: 0.92, letterSpacing: '-0.02em', ...extra });
  const b = (size = 26, extra: Style = {}): Style => ({ margin: 0, fontFamily: sans, fontSize: `${size}px`, fontWeight: 500, lineHeight: 1.35, ...extra });
  const [pink, blue, sheet, ink] = ['pink', 'blue', 'sheet', 'ink'].map((x) => p.c(x)) as [string, string, string, string];
  // The name is set at the body step, the smallest size that still reads in a feed; the shelf a little taller.
  const brandMark = (token: string, fg: string, size: number) => {
    const logo = k.logoFor(k.data.colors.find((c) => c.token === token) ?? null);
    return h('div', { display: 'flex', alignItems: 'center', gap: '16px' }, [logo ? k.logo(logo, Math.round(size * 1.1)) : '', h('span', b(28, { color: fg, fontWeight: 600, letterSpacing: '-0.01em' }), 'Second Shelf', { 'data-name': 'Name' })], { 'data-name': 'Logo' });
  };
  const spine = (width: number, height: string, bg: string, band: string) => h('div', { display: 'flex', flexDirection: 'column', paddingTop: '16px', width: `${width}px`, height, background: bg }, [h('div', { height: '6px', background: band }, [], { 'data-name': 'Band' })], { 'data-name': 'Spine' });

  const og = h('div', { display: 'grid', gridTemplateColumns: '1fr 300px', flex: '1', background: pink }, [
    h('div', { display: 'flex', flexDirection: 'column', padding: '56px 0 56px 64px' }, [
      brandMark('pink', ink, 40),
      h('h1', d(118, { color: ink, marginTop: 'auto' }), 'Poems after closing time', { 'data-name': 'Headline' }),
      h('p', b(28, { color: ink, marginTop: '28px', maxWidth: '700px' }), 'Thursday 14 November, 19:30. Free. Bring one poem, or none.', { 'data-name': 'When' }),
    ], { 'data-name': 'Words' }),
    h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: '0 56px 56px 0' }, [
      h('div', { display: 'flex', alignItems: 'flex-end', gap: '8px', height: '420px', borderBottom: `10px solid ${ink}` }, [spine(44, '62%', blue, pink), spine(60, '88%', ink, sheet), spine(36, '48%', sheet, blue), spine(52, '100%', blue, sheet)], { 'data-name': 'Books' }),
    ], { 'data-name': 'Shelf' }),
  ], { 'data-name': 'Layout' });

  const square = h('div', { display: 'flex', flexDirection: 'column', flex: '1', padding: '72px', background: blue }, [
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, [brandMark('blue', sheet, 44), h('span', b(28, { color: sheet }), 'Every Saturday', { 'data-name': 'When' })], { 'data-name': 'Top' }),
    h('h1', d(250, { color: pink, marginTop: 'auto', lineHeight: 0.82, letterSpacing: '-0.035em' }), 'We buy books.', { 'data-name': 'Headline' }),
    h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '48px', marginTop: '56px', paddingTop: '28px', borderTop: `4px solid ${sheet}` }, [
      h('p', b(32, { color: sheet }), 'Bring a bag from 10 to 2. We look while you wait.', { 'data-name': 'How' }),
      h('p', b(32, { color: sheet }), 'Cash, or a third more in shop credit.', { 'data-name': 'Pay' }),
    ], { 'data-name': 'Details' }),
  ], { 'data-name': 'Layout' });

  return [
    { name: 'Second Shelf, 1200 x 630', width: 1200, height: 630, background: pink, color: ink, font: sans, steps: [{ html: og }] },
    { name: 'Second Shelf, 1080 x 1080', width: 1080, height: 1080, background: blue, color: sheet, font: sans, steps: [{ html: square }] },
  ];
}

export const secondShelf: ExampleDef = {
  id: 'example-social',
  kind: 'Social images',
  name: 'Second Shelf, social images',
  description: 'Share images for a made-up used bookshop: an evening reading at 1200 x 630 on riso pink, and "We buy books" at 1080 x 1080 on riso blue. Bodoni Moda italic over Work Sans.',
  brand,
  parts: [{ key: 'og', name: 'Second Shelf, 1200 x 630', size: '1200 x 630' }, { key: 'square', name: 'Second Shelf, 1080 x 1080', size: '1080 x 1080' }],
  build: (k) => ({ page: 'Social images', boards: images(k), gaps: [] }),
};
