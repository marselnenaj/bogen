import { Paint, type BrandSpec } from '../brand-spec.ts';
import { h, type BrandKit, type Style } from '../kit.ts';
import type { BoardPlan } from '../types.ts';
import type { ExampleDef } from './types.ts';

const markSvg = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 40"><rect x="0" y="0" width="10" height="40" fill="${color}"/><rect x="38" y="0" width="10" height="40" fill="${color}"/><path d="M24 6 L34 20 L27 20 L27 34 L21 34 L21 20 L14 20 Z" fill="${color}"/></svg>`;

const brand: BrandSpec = {
  name: 'Laneway',
  positioning: 'Deliveries by cargo bike from small hubs at the edge of a city centre.',
  audience: 'Investors, city councils and the shops in a closed zone.',
  tone: 'Blunt and measured. One claim per slide, with the number that backs it.',
  fields: { container: 1920, gradients: 'none', shadows: 'none' },
  colors: [
    { name: 'Asphalt', role: 'text', value: '#19191b', token: 'asphalt' },
    { name: 'Kerb', role: 'background', value: '#f6f5f1', token: 'kerb' },
    { name: 'Lane', role: 'primary', value: '#12a35a', token: 'lane', note: 'The paint of a bike lane: routes, the title, the latest number.' },
    { name: 'Signal', role: 'accent', value: '#ffd23f', token: 'signal', note: 'The one number that matters, and the ask.' },
    { name: 'Tar', role: 'surface-dark', value: '#2a2a2d', token: 'tar' },
    { name: 'Street', role: 'line on tar', value: '#3a3a3e', token: 'street' },
    { name: 'Concrete', role: 'text-secondary-dark', value: '#8d8d88', token: 'concrete' },
    { name: 'Paint', role: 'text on dark', value: '#dcdcd6', token: 'paint' },
    { name: 'Kerb dim', role: 'text-secondary', value: '#4a4a46', token: 'kerb-dim' },
  ],
  pairings: [{ fg: 'asphalt', bg: 'lane', verdict: 'allow' }, { fg: 'asphalt', bg: 'signal', verdict: 'allow' }, { fg: 'kerb', bg: 'asphalt', verdict: 'allow' }, { fg: 'signal', bg: 'asphalt', verdict: 'allow' }, { fg: 'lane', bg: 'asphalt', verdict: 'allow', note: 'Display sizes only.' }, { fg: 'kerb', bg: 'lane', verdict: 'forbid' }],
  families: [{ family: 'Anybody', role: 'display', fallback: '"Arial Black", sans-serif', weights: [400, 700, 800], token: 'anybody', license: 'OFL' }],
  typeScale: [
    { name: 'Name', role: 'display', size: 290, weight: 800, lineHeight: '0.8', tracking: '-0.04em', family: 'Anybody', token: 'text-name' },
    { name: 'Number', role: 'display', size: 380, weight: 800, lineHeight: '0.76', tracking: '-0.05em', family: 'Anybody', token: 'text-number' },
    { name: 'Ask', role: 'h1', size: 150, weight: 800, lineHeight: '0.86', tracking: '-0.035em', family: 'Anybody', token: 'text-ask' },
    { name: 'Claim', role: 'h2', size: 84, weight: 800, lineHeight: '0.92', tracking: '-0.02em', family: 'Anybody', token: 'text-claim' },
    { name: 'Body', role: 'body', size: 30, weight: 400, lineHeight: '1.35', family: 'Anybody', token: 'text-body' },
    { name: 'Small', role: 'small', size: 22, weight: 400, lineHeight: '1.35', family: 'Anybody', token: 'text-small' },
  ],
  spacing: [8, 16, 24, 32, 48, 72, 120],
  radius: [0],
  logos: [
    { name: 'Mark', background: 'light', minWidth: 24, clearSpace: 8, svg: markSvg('#19191b') },
    { name: 'Mark on lane', background: 'lane', minWidth: 24, clearSpace: 8, svg: markSvg('#19191b') },
    { name: 'Mark, reversed', background: 'dark', minWidth: 24, clearSpace: 8, svg: markSvg('#f6f5f1') },
  ],
  rules: [
    { text: 'One claim per slide. If it needs two, it is two slides.', kind: 'do', severity: 'soft', topic: 'layout' },
    { text: 'Display type is Anybody at 115 to 130% width, weight 800.', kind: 'do', severity: 'soft', topic: 'type' },
    { text: 'Square corners: lanes, kerbs and boxes.', kind: 'do', severity: 'hard', topic: 'layout' },
  ],
  voice: [{ good: 'A hub at the edge. Bikes for the rest.', bad: 'Revolutionising urban logistics with green mobility.' }],
};

function deck(k: BrandKit): BoardPlan[] {
  const p = new Paint(k);
  const font = p.f('anybody');
  const d = (size: number, extra: Style = {}): Style => ({ margin: 0, fontFamily: font, fontSize: `${size}px`, fontWeight: 800, fontStretch: '130%', lineHeight: 0.92, letterSpacing: '-0.02em', ...extra });
  const b = (size = 28, extra: Style = {}): Style => ({ margin: 0, fontFamily: font, fontSize: `${size}px`, fontWeight: 400, fontStretch: '100%', lineHeight: 1.35, ...extra });
  const [asphalt, kerb, lane, signal, tar, concrete, paint, kerbDim] = ['asphalt', 'kerb', 'lane', 'signal', 'tar', 'concrete', 'paint', 'kerb-dim'].map((x) => p.c(x)) as [string, string, string, string, string, string, string, string];
  const groundOf: Record<string, string> = { [asphalt]: 'asphalt', [kerb]: 'kerb', [lane]: 'lane', [signal]: 'signal' };
  const mark = (ground: string, size: number) => {
    const color = k.data.colors.find((c) => c.token === groundOf[ground]) ?? null;
    const logo = k.logoFor(color);
    return logo ? k.logo(logo, Math.round(size * 1.2)) : '';
  };
  const foot = (n: number, ground: string, fg: string, topic: string) => h('footer', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto' }, [
    h('div', { display: 'flex', alignItems: 'center', gap: '16px' }, [mark(ground, 28), h('span', d(24, { color: fg, fontStretch: '120%' }), 'Laneway', { 'data-name': 'Name' })], { 'data-name': 'Logo' }),
    h('span', b(22, { color: fg }), `${topic}, ${n} of 6`, { 'data-name': 'Page' }),
  ], { 'data-name': 'Footer' });
  const slide = (name: string, bg: string, children: string[]): BoardPlan => ({
    name, width: 1920, height: 1080, background: bg, color: bg === asphalt ? kerb : asphalt, font,
    steps: [{ html: h('div', { display: 'flex', flexDirection: 'column', flex: '1', padding: '120px 120px 72px', background: bg }, children, { 'data-name': 'Slide' }) }],
  });
  const gap = (px: number) => h('div', { height: `${px}px`, flex: 'none' }, [], { 'data-name': 'Space' });

  const s1 = slide('Laneway 1, title', lane, [
    h('div', { display: 'flex', alignItems: 'center' }, [mark(lane, 64)], { 'data-name': 'Mark' }),
    h('h1', d(290, { color: asphalt, marginTop: 'auto', marginLeft: '-12px', letterSpacing: '-0.04em', lineHeight: 0.8, fontStretch: '118%' }), 'Laneway', { 'data-name': 'Name' }),
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: '56px', paddingTop: '32px', borderTop: `4px solid ${asphalt}` }, [
      h('p', d(56, { color: asphalt, fontStretch: '115%', lineHeight: 1 }), 'The last mile, by cargo bike.', { 'data-name': 'Line' }),
      h('p', b(30, { color: asphalt }), 'Seed round, 2026', { 'data-name': 'Occasion' }),
    ], { 'data-name': 'Under' }),
  ]);

  const s2 = slide('Laneway 2, problem', asphalt, [
    h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '120px', alignItems: 'end', marginTop: 'auto' }, [
      h('div', { display: 'flex', flexDirection: 'column', gap: '24px' }, [
        h('p', d(380, { color: signal, lineHeight: 0.76, letterSpacing: '-0.05em' }), '61%', { 'data-name': 'Number' }),
        h('p', b(30, { color: concrete }), 'of a delivery van’s working day in our pilot city, spent parked.', { 'data-name': 'What it counts' }),
      ], { 'data-name': 'Number block' }),
      h('div', { display: 'flex', flexDirection: 'column', gap: '32px', paddingBottom: '16px' }, [
        h('h1', d(76, { color: kerb, fontStretch: '115%' }), 'Vans are too big for the streets they serve.', { 'data-name': 'Claim' }),
        h('p', b(30, { color: paint }), 'Old towns close to motor traffic before ten. Shops still need their goods by eleven.', { 'data-name': 'Why' }),
      ], { 'data-name': 'Words' }),
    ], { 'data-name': 'Body' }),
    gap(72),
    foot(2, asphalt, concrete, 'The problem'),
  ]);

  const map = `<svg data-name="Map" viewBox="0 0 760 620" style="width:760px;height:620px;flex:none"><rect width="760" height="620" fill="${p.hex('tar')}"/><path d="M0 140 H760 M0 300 H760 M0 470 H760 M150 0 V620 M330 0 V620 M520 0 V620 M660 0 V620" stroke="${p.hex('street')}" stroke-width="18"/><path d="M230 0 L760 400 M0 560 L420 0" stroke="${p.hex('street')}" stroke-width="10"/><rect x="250" y="160" width="330" height="270" fill="none" stroke="${p.hex('concrete')}" stroke-width="3"/><path d="M80 540 H150 V300 H330 V230 M150 470 H520 V330 M80 540 H330 V470 M330 300 H420" stroke="${p.hex('lane')}" stroke-width="12" fill="none"/><rect x="40" y="500" width="80" height="80" fill="${p.hex('signal')}"/><circle cx="330" cy="230" r="14" fill="${p.hex('kerb')}"/><circle cx="520" cy="330" r="14" fill="${p.hex('kerb')}"/><circle cx="330" cy="470" r="14" fill="${p.hex('kerb')}"/><circle cx="420" cy="300" r="14" fill="${p.hex('kerb')}"/></svg>`;
  const legend = (swatch: string, label: string) => h('div', { display: 'flex', alignItems: 'center', gap: '16px' }, [swatch, h('span', b(24, { color: paint }), label, { 'data-name': 'Label' })], { 'data-name': label });
  const s3 = slide('Laneway 3, what we do', asphalt, [
    h('div', { display: 'grid', gridTemplateColumns: '760px 1fr', gap: '120px', alignItems: 'center' }, [
      map,
      h('div', { display: 'flex', flexDirection: 'column', gap: '48px' }, [
        h('h1', d(84, { color: kerb, fontStretch: '115%' }), 'A hub at the edge. Bikes for the rest.', { 'data-name': 'Claim' }),
        h('p', b(30, { color: paint, maxWidth: '800px' }), 'Trucks unload once at a small hub outside the closed zone. Our riders take each order the last two kilometres, into streets a van cannot use.', { 'data-name': 'How' }),
        h('div', { display: 'flex', flexDirection: 'column', gap: '16px', paddingTop: '8px' }, [
          legend(h('span', { width: '28px', height: '28px', flex: 'none', background: signal }, [], { 'data-name': 'Swatch' }), 'Hub, 400 m² at the ring road'),
          legend(h('span', { width: '28px', height: '8px', flex: 'none', background: lane }, [], { 'data-name': 'Swatch' }), 'Bike routes'),
          legend(h('span', { width: '28px', height: '28px', flex: 'none', border: `3px solid ${concrete}` }, [], { 'data-name': 'Swatch' }), 'Zone closed to vans before 10:00'),
        ], { 'data-name': 'Legend' }),
      ], { 'data-name': 'Words' }),
    ], { 'data-name': 'Body' }),
    foot(3, asphalt, concrete, 'What we do'),
  ]);

  const stop = (time: string, what: string, detail: string, last = false) => h('div', { display: 'flex', flexDirection: 'column', gap: '16px', flex: '1' }, [
    h('div', { display: 'flex', alignItems: 'center' }, [
      h('span', { width: '36px', height: '36px', flex: 'none', background: last ? lane : asphalt }, [], { 'data-name': 'Stop' }),
      last ? '' : h('span', { flex: '1', height: '8px', background: asphalt }, [], { 'data-name': 'Line' }),
    ], { 'data-name': 'Track' }),
    h('p', d(72, { color: asphalt, fontStretch: '115%' }), time, { 'data-name': 'Time' }),
    h('h2', b(30, { color: asphalt, fontWeight: 700 }), what, { 'data-name': 'What' }),
    h('p', b(26, { color: kerbDim, maxWidth: '340px' }), detail, { 'data-name': 'Detail' }),
  ], { 'data-name': `At ${time}` });
  const s4 = slide('Laneway 4, a morning', kerb, [
    h('h1', d(108, { color: asphalt, maxWidth: '1500px' }), 'Four hours from truck to till.', { 'data-name': 'Claim' }),
    h('div', { display: 'flex', marginTop: 'auto' }, [
      stop('06:00', 'Trucks arrive', 'Two trucks unload at the hub instead of nine vans driving in.'),
      stop('06:45', 'Sorted by street', 'Each order goes into the box of one rider and one route.'),
      stop('07:30', 'Riders out', 'Twelve bikes, up to 180 kg each, in the lanes before traffic.'),
      stop('10:00', 'Every shop done', 'Before the zone opens to anything with an engine.', true),
    ], { 'data-name': 'Timeline' }),
    gap(72),
    foot(4, kerb, kerbDim, 'A morning in Leipzig'),
  ]);

  const weeks = [620, 780, 910, 1180, 1420, 1690, 2050, 2380, 2760, 3240, 3710, 4200];
  const top = Math.max(...weeks);
  const s5 = slide('Laneway 5, traction', asphalt, [
    h('div', { display: 'grid', gridTemplateColumns: '1fr 520px', gap: '120px', flex: '1' }, [
      h('div', { display: 'flex', flexDirection: 'column', gap: '24px' }, [
        h('div', { display: 'flex', alignItems: 'flex-end', gap: '16px', flex: '1', borderBottom: `3px solid ${concrete}` }, weeks.map((n, i) => h('div', { flex: '1', height: `${Math.round((n / top) * 100)}%`, background: i === weeks.length - 1 ? lane : tar }, [], { 'data-name': `Week ${i + 1}` })), { 'data-name': 'Bars' }),
        h('div', { display: 'flex', justifyContent: 'space-between' }, [h('span', b(22, { color: concrete }), 'Week 1', { 'data-name': 'From' }), h('span', b(22, { color: concrete }), 'Week 12', { 'data-name': 'To' })], { 'data-name': 'Axis' }),
      ], { 'data-name': 'Chart' }),
      h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: '72px' }, [
        // The slide's claim is the number.
        h('div', { display: 'flex', flexDirection: 'column', gap: '16px' }, [h('h1', d(150, { color: lane, lineHeight: 0.8 }), '4,200', { 'data-name': 'Number' }), h('p', b(30, { color: paint }), 'drops in the last week, from one hub', { 'data-name': 'What it counts' })], { 'data-name': 'Drops' }),
        h('div', { display: 'flex', flexDirection: 'column', gap: '16px', paddingTop: '48px', borderTop: `3px solid ${tar}` }, [h('p', d(110, { color: kerb, lineHeight: 0.8 }), '€2.90', { 'data-name': 'Number' }), h('p', b(30, { color: paint }), 'what a drop costs us, against €4.60 by van', { 'data-name': 'What it counts' })], { 'data-name': 'Cost' }),
      ], { 'data-name': 'Numbers' }),
    ], { 'data-name': 'Body' }),
    gap(56),
    foot(5, asphalt, concrete, 'Since we started'),
  ]);

  const s6 = slide('Laneway 6, the ask', signal, [
    h('h1', d(150, { color: asphalt, marginTop: 'auto', maxWidth: '1600px', letterSpacing: '-0.035em', lineHeight: 0.86 }), '€1.8 million for three more cities.', { 'data-name': 'Ask' }),
    h('div', { display: 'flex', flexDirection: 'column', marginTop: '64px' }, [
      ['Hubs', 'Dresden, Erfurt and Halle, each open within six months.'],
      ['Bikes', 'Forty more, bought, not leased, with their batteries.'],
      ['People', 'Riders on contracts, and one operations lead per city.'],
    ].map(([key, value]) => h('div', { display: 'grid', gridTemplateColumns: '320px 1fr', gap: '48px', alignItems: 'baseline', padding: '24px 0', borderTop: `4px solid ${asphalt}` }, [h('h2', d(40, { color: asphalt, fontStretch: '115%' }), key!, { 'data-name': 'What' }), h('p', b(30, { color: asphalt }), value!, { 'data-name': 'For' })], { 'data-name': key })), { 'data-name': 'Use of funds' }),
    gap(72),
    foot(6, signal, asphalt, 'hello@laneway.example'),
  ]);

  return [s1, s2, s3, s4, s5, s6];
}

export const laneway: ExampleDef = {
  id: 'example-deck',
  kind: 'Pitch deck',
  name: 'Laneway, a pitch deck',
  description: 'Six slides at 1920 x 1080 for a made-up cargo bike delivery company: title, the problem as one number, a drawn map of hub and routes, a morning as a timeline, traction as bars, and the ask. Anybody at a wide width on asphalt, kerb white, lane green and signal yellow.',
  brand,
  parts: [1, 2, 3, 4, 5, 6].map((n) => ({ key: String(n), name: `Laneway ${n}`, size: '1920 x 1080' })),
  build: (k) => ({ page: 'Pitch deck', boards: deck(k), gaps: [] }),
};
