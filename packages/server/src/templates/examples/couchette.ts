import { Paint, type BrandSpec } from '../brand-spec.ts';
import { h, t, type BrandKit, type Style } from '../kit.ts';
import type { BoardPlan } from '../types.ts';
import type { ExampleDef } from './types.ts';

const WINDOW = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect x="1.5" y="1.5" width="37" height="37" fill="none" stroke="#ffb547" stroke-width="3"/><circle cx="24" cy="16" r="8" fill="#ffb547"/><circle cx="20" cy="13" r="7" fill="#15122e"/><rect x="1.5" y="27" width="37" height="3" fill="#ffb547"/></svg>';

const brand: BrandSpec = {
  name: 'Couchette',
  positioning: 'Sleeper trains across Europe, booked in one go.',
  audience: 'People who would rather sleep than fly.',
  tone: 'Calm and specific, like a good conductor. Times and places, not adjectives.',
  fields: { container: 1440, gradients: 'none', shadows: 'none' },
  colors: [
    { name: 'Night', role: 'text', value: '#15122e', token: 'night', note: 'The sky outside the window, and text on linen.' },
    { name: 'Linen', role: 'background', value: '#f3eee4', token: 'linen' },
    { name: 'Lamp', role: 'primary', value: '#ffb547', token: 'lamp', note: 'The reading lamp: actions, and one word per headline.' },
    { name: 'Berth', role: 'surface-dark', value: '#2a2656', token: 'berth' },
    { name: 'Dusk', role: 'text-secondary-dark', value: '#a9a4cf', token: 'dusk' },
    { name: 'Ash', role: 'text-secondary', value: '#5e5a70', token: 'ash' },
    { name: 'Line', role: 'border', value: '#d9d2c3', token: 'line' },
  ],
  pairings: [{ fg: 'night', bg: 'linen', verdict: 'allow' }, { fg: 'linen', bg: 'night', verdict: 'allow' }, { fg: 'lamp', bg: 'night', verdict: 'allow' }, { fg: 'night', bg: 'lamp', verdict: 'allow' }, { fg: 'lamp', bg: 'linen', verdict: 'forbid', note: 'Too pale to read.' }],
  families: [
    { family: 'Gloock', role: 'display', fallback: 'Georgia, serif', weights: [400], token: 'serif', license: 'OFL' },
    { family: 'Instrument Sans', role: 'body', fallback: '"Helvetica Neue", Arial, sans-serif', weights: [400, 600], token: 'sans', license: 'OFL' },
  ],
  typeScale: [
    { name: 'Hero', role: 'h1', size: 112, weight: 400, lineHeight: '0.98', tracking: '-0.015em', family: 'Gloock', token: 'text-hero' },
    { name: 'Section', role: 'h2', size: 72, weight: 400, lineHeight: '1', tracking: '-0.015em', family: 'Gloock', token: 'text-section' },
    { name: 'Cabin', role: 'h3', size: 36, weight: 400, lineHeight: '1', family: 'Gloock', token: 'text-cabin' },
    { name: 'Lead', role: 'lead', size: 21, weight: 400, lineHeight: '1.5', family: 'Instrument Sans', token: 'text-lead' },
    { name: 'Body', role: 'body', size: 18, weight: 400, lineHeight: '1.5', family: 'Instrument Sans', token: 'text-body' },
    { name: 'Small', role: 'small', size: 15, weight: 400, lineHeight: '1.5', family: 'Instrument Sans', token: 'text-small' },
  ],
  spacing: [8, 12, 16, 24, 32, 40, 64, 88, 120],
  radius: [4, 12],
  logos: [{ name: 'Window', background: 'dark', minWidth: 24, clearSpace: 8, svg: WINDOW }],
  rules: [
    { text: 'One word or phrase of each headline in Lamp, never more.', kind: 'do', severity: 'soft', topic: 'color' },
    { text: 'Times are set in Gloock, as on a departure board.', kind: 'do', severity: 'soft', topic: 'type' },
    { text: 'No gradients and no photos of trains: the window is drawn.', kind: 'dont', severity: 'hard', topic: 'imagery', check: { type: 'no-gradient' } },
  ],
  words: [{ word: 'journey', use: 'avoid', instead: 'trip' }],
  voice: [{ good: 'Fall asleep in Berlin. Wake up in Paris.', bad: 'Experience the magic of rail travel.' }, { good: 'A bed, a door that locks, and breakfast.', bad: 'Premium comfort for the discerning traveller.' }],
};

const ROUTES = [
  ['20:28', 'Berlin', 'Paris', '09:52', '89'],
  ['19:14', 'Vienna', 'Hamburg', '08:40', '79'],
  ['21:40', 'Zürich', 'Amsterdam', '09:54', '95'],
  ['22:05', 'Munich', 'Rome', '09:23', '99'],
  ['23:12', 'Brussels', 'Prague', '11:30', '85'],
] as const;

function page(k: BrandKit, width: number): BoardPlan {
  const p = new Paint(k);
  const m = width < 700;
  const serif = p.f('serif');
  const sans = p.f('sans');
  const d = (size: number, extra: Style = {}): Style => ({ margin: 0, fontFamily: serif, fontSize: `${size}px`, fontWeight: 400, lineHeight: 1, letterSpacing: '-0.015em', ...extra });
  const b = (size = 18, extra: Style = {}): Style => ({ margin: 0, fontFamily: sans, fontSize: `${size}px`, fontWeight: 400, lineHeight: 1.5, ...extra });
  const pad = m ? '24px' : '88px';
  const night = p.c('night');
  const linen = p.c('linen');
  const lamp = p.c('lamp');
  const logo = k.logos().find((l) => l.name === 'Window');
  // The name is set on a step of the scale, the window drawn a little larger than its capitals.
  const brandMark = (size: number, text: number) => h('div', { display: 'flex', alignItems: 'center', gap: '12px' }, [logo ? k.logo(logo, size) : '', h('span', d(text, { color: linen }), 'Couchette', { 'data-name': 'Name' })], { 'data-name': 'Logo' });
  const button = (label: string, loud: boolean, extra: Style = {}) => h('a', { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', padding: m ? '12px 24px' : '16px 32px', background: loud ? lamp : 'transparent', color: loud ? night : linen, border: loud ? 'none' : `1.5px solid ${linen}`, borderRadius: '4px', fontFamily: sans, fontWeight: 600, fontSize: '18px', textDecoration: 'none', ...extra }, t(label), { href: '#', 'data-name': `Button ${label}` });
  const steps: string[] = [];

  steps.push(h('header', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${m ? '16px' : '24px'} ${pad}`, background: night }, [
    m ? brandMark(28, 24) : brandMark(40, 36),
    m ? h('span', b(18, { color: linen, fontWeight: 600 }), 'Menu', { 'data-name': 'Menu' }) : h('nav', { display: 'flex', gap: '32px' }, ['Routes', 'Cabins', 'Rail passes', 'Help'].map((n) => h('a', b(18, { color: linen, textDecoration: 'none' }), n, { href: '#', 'data-name': 'Link' })), { 'data-name': 'Links' }),
  ], { 'data-name': 'Header' }));

  // The hero, with the window of a compartment at night.
  const ww = m ? 342 : 480;
  const art = h('div', { position: 'relative', width: `${ww}px`, height: `${m ? 300 : 420}px`, flex: 'none', overflow: 'hidden', background: p.c('berth'), border: `10px solid ${linen}`, borderRadius: '28px' }, [
    h('div', { position: 'absolute', right: '18%', top: '16%', width: `${Math.round(ww * 0.2)}px`, height: `${Math.round(ww * 0.2)}px`, borderRadius: '50%', background: lamp }, [], { 'data-name': 'Moon' }),
    `<svg data-name="Hills" viewBox="0 0 400 120" preserveAspectRatio="none" style="position:absolute;left:0;bottom:0;width:100%;height:42%"><path d="M0 70 C60 30 110 40 160 62 C210 84 250 30 310 40 C350 46 380 60 400 56 L400 120 L0 120 Z" fill="${p.hex('night')}"/></svg>`,
    h('div', { position: 'absolute', left: 0, right: 0, bottom: '8%', height: '3px', background: lamp, opacity: 0.6 }, [], { 'data-name': 'Track light' }),
  ], { 'data-name': 'Window' });
  steps.push(h('section', { display: 'grid', gridTemplateColumns: m ? '1fr' : '1.25fr 1fr', gap: m ? '40px' : '64px', alignItems: 'center', padding: `${m ? '40px' : '64px'} ${pad} ${m ? '64px' : '120px'}`, background: night }, [
    h('div', { display: 'flex', flexDirection: 'column', gap: m ? '24px' : '32px' }, [
      h('h1', d(m ? 52 : 112, { color: linen, lineHeight: 0.98 }), ['Fall asleep in Berlin. ', h('span', { color: lamp }, 'Wake up in Paris.')], { 'data-name': 'Headline' }),
      h('p', b(m ? 18 : 21, { color: p.c('dusk'), maxWidth: '560px' }), 'Sleeper trains across Europe, booked in one go. A bed, a door that locks, and breakfast before the last station.', { 'data-name': 'Positioning' }),
      h('div', { display: 'flex', gap: '12px', flexWrap: 'wrap' }, [button('Find a train', true), button('See all routes', false)], { 'data-name': 'Actions' }),
    ], { 'data-name': 'Words' }),
    h('div', { display: 'flex', justifyContent: m ? 'flex-start' : 'flex-end' }, [art], { 'data-name': 'Art' }),
  ], { 'data-name': 'Hero' }));

  // Tonight's departures, as a real table.
  const line = p.c('line');
  const ash = p.c('ash');
  const cell = (v: string, extra: Style = {}) => h('td', { padding: m ? '12px 0' : '24px 0', borderTop: `1px solid ${line}`, ...extra }, v);
  const head = (v: string, extra: Style = {}) => h('th', { ...b(15, { color: ash, fontWeight: 600, textAlign: 'left' }), paddingBottom: '12px', ...extra }, v);
  const rows = ROUTES.slice(0, m ? 4 : 5).map(([dep, from, to, arr, price]) => h('tr', {}, [
    cell(h('span', d(m ? 24 : 36, { color: night }), dep, { 'data-name': 'Departs' }), { width: m ? '76px' : '160px' }),
    cell(h('span', b(m ? 18 : 21, { color: night, fontWeight: 600 }), [t(from), h('span', { color: ash, fontWeight: 400 }, ' to '), t(to)], { 'data-name': 'Route' })),
    m ? '' : cell(h('span', b(21, { color: ash }), `arrives ${arr}`, { 'data-name': 'Arrives' })),
    cell(h('span', b(m ? 18 : 21, { color: night, fontWeight: 600 }), `from €${price}`, { 'data-name': 'Price' }), { textAlign: 'right' }),
  ].filter(Boolean) as string[], { 'data-name': `${from} to ${to}` }));
  steps.push(h('section', { display: 'flex', flexDirection: 'column', gap: m ? '24px' : '40px', padding: `${m ? '64px' : '120px'} ${pad}`, background: linen }, [
    h('div', { display: 'flex', flexDirection: m ? 'column' : 'row', justifyContent: 'space-between', alignItems: m ? 'flex-start' : 'flex-end', gap: '16px' }, [
      h('h2', d(m ? 40 : 72, { color: night }), 'Leaving tonight', { 'data-name': 'Heading' }),
      h('p', b(18, { color: ash, maxWidth: '420px' }), 'Every price is for a couchette berth, one way, bedding and breakfast included.', { 'data-name': 'Note' }),
    ], { 'data-name': 'Head' }),
    h('table', { width: '100%', borderCollapse: 'collapse' }, [
      m ? '' : h('thead', {}, h('tr', {}, [head('Departs'), head('Route'), head('Arrives'), head('Price', { textAlign: 'right' })])),
      h('tbody', {}, rows),
    ], { 'data-name': 'Departures' }),
  ], { 'data-name': 'Departures' }));

  // Cabins: one carriage from above, and the three ways to sleep in it.
  const berth = p.c('berth');
  const tall = m ? '84px' : '200px';
  const inner = m ? '8px' : '12px';
  const compartment = (kind: string) => {
    if (kind === 'Seat') return h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', height: tall, padding: inner, background: berth, borderRadius: '6px' }, [0, 1, 2, 3, 4, 5].map(() => h('div', { background: night, borderRadius: '3px' }, [], { 'data-name': 'Seat' })), { 'data-name': 'Seat compartment' });
    if (kind === 'Couchette') return h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'space-around', height: tall, padding: inner, background: berth, borderRadius: '6px' }, [0, 1, 2].map(() => h('div', { height: m ? '8px' : '14px', background: p.c('dusk'), borderRadius: '2px' }, [], { 'data-name': 'Berth' })), { 'data-name': 'Couchette compartment' });
    return h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'center', height: tall, padding: inner, background: lamp, borderRadius: '6px' }, [h('div', { height: m ? '16px' : '30px', background: night, borderRadius: '3px' }, [], { 'data-name': 'Bed' })], { 'data-name': 'Sleeper compartment' });
  };
  const group = (kind: string) => h('div', { display: 'flex', flexDirection: 'column', gap: '12px' }, [
    h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }, [compartment(kind), compartment(kind)], { 'data-name': 'Compartments' }),
    h('p', b(15, { color: p.c('dusk') }), kind, { 'data-name': 'Label' }),
  ], { 'data-name': kind });
  const plan = h('div', { display: 'flex', flexDirection: 'column', gap: m ? '12px' : '24px', padding: m ? '16px' : '32px', background: night, borderRadius: '12px' }, [
    h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: m ? '8px' : '16px' }, [group('Seat'), group('Couchette'), group('Sleeper')], { 'data-name': 'Carriage' }),
    h('p', b(15, { color: p.c('dusk'), borderTop: `1px solid ${berth}`, paddingTop: m ? '8px' : '16px' }), 'One carriage, seen from above. Most of our trains have all three.', { 'data-name': 'Caption' }),
  ], { 'data-name': 'Plan' });
  const cabin = (name: string, what: string, price: string) => h('div', { display: 'grid', gridTemplateColumns: m ? '1fr auto' : '200px 1fr auto', gap: m ? '8px 16px' : '24px', alignItems: 'baseline', padding: '24px 0', borderTop: `1px solid ${line}` }, [
    h('h3', d(m ? 28 : 36, { color: night }), name, { 'data-name': 'Name' }),
    m ? h('span', b(18, { color: night, fontWeight: 600 }), price, { 'data-name': 'Price' }) : '',
    h('p', b(18, { color: ash, gridColumn: m ? '1 / -1' : undefined }), what, { 'data-name': 'What you get' }),
    m ? '' : h('span', b(18, { color: night, fontWeight: 600 }), price, { 'data-name': 'Price' }),
  ], { 'data-name': `Cabin ${name}` });
  steps.push(h('section', { display: 'grid', gridTemplateColumns: m ? '1fr' : '1fr 1fr', gap: m ? '32px' : '88px', alignItems: 'center', padding: `0 ${pad} ${m ? '64px' : '120px'}`, background: linen }, [
    plan,
    h('div', { display: 'flex', flexDirection: 'column' }, [
      h('h2', d(m ? 40 : 72, { color: night, marginBottom: m ? '16px' : '32px' }), 'Pick your bed', { 'data-name': 'Heading' }),
      cabin('Seat', 'A reclining seat in a compartment of six. The cheapest way to get there.', 'from €39'),
      cabin('Couchette', 'One of four or six berths, with sheets, a pillow and a reading lamp.', 'from €79'),
      cabin('Sleeper', 'A room for one to three, with its own washbasin and a door that locks.', 'from €149'),
    ], { 'data-name': 'Cabins' }),
  ], { 'data-name': 'Cabins' }));

  // The close, on the lamp, and the footer.
  steps.push(h('section', { display: 'flex', flexDirection: m ? 'column' : 'row', alignItems: m ? 'flex-start' : 'center', justifyContent: 'space-between', gap: '32px', padding: `${m ? '64px' : '88px'} ${pad}`, background: lamp }, [
    h('h2', d(m ? 40 : 72, { color: night, maxWidth: '900px' }), 'Pack a toothbrush. We will wake you at the border.', { 'data-name': 'Closing' }),
    h('a', { display: 'inline-flex', flex: 'none', padding: m ? '12px 24px' : '16px 32px', background: night, color: linen, borderRadius: '4px', fontFamily: sans, fontWeight: 600, fontSize: '18px', textDecoration: 'none' }, 'Find a train', { href: '#', 'data-name': 'Button Find a train' }),
  ], { 'data-name': 'Closing' }));
  steps.push(h('footer', { display: 'flex', flexDirection: m ? 'column' : 'row', justifyContent: 'space-between', gap: '16px', padding: `${m ? '32px' : '40px'} ${pad}`, background: night }, [
    brandMark(28, 24),
    h('p', b(15, { color: p.c('dusk') }), 'An example in Bogen. Couchette, its routes and its prices are made up.', { 'data-name': 'Small print' }),
  ], { 'data-name': 'Footer' }));
  return { name: `Couchette, ${width}`, width, background: linen, color: night, font: sans, steps: steps.map((html) => ({ html })) };
}

export const couchette: ExampleDef = {
  id: 'example-landing',
  kind: 'Landing page',
  name: 'Couchette, a landing page',
  description: 'A landing page for a made-up sleeper train company, at 1440 and 390: a hero with a drawn compartment window, tonight\'s departures as a real table, a carriage plan with the three ways to sleep, and a close on the lamp colour. Gloock and Instrument Sans on night, linen and lamp.',
  brand,
  parts: [{ key: '1440', name: 'Couchette, 1440', size: '1440 wide, hugs content' }, { key: '390', name: 'Couchette, 390', size: '390 wide, hugs content' }],
  build: (k) => ({ page: 'Landing page', boards: [page(k, 1440), page(k, 390)], gaps: [] }),
};
