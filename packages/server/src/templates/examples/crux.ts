import { Paint, type BrandSpec } from '../brand-spec.ts';
import { h, t, type BrandKit, type Style } from '../kit.ts';
import type { BoardPlan } from '../types.ts';
import type { ExampleDef } from './types.ts';

/** A left chevron, drawn: an arrow glyph is drawn as an emoji on phones. */
const BACK = '<svg data-name="Chevron" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" style="width:16px;height:16px;flex:none" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const HOLD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M6 30 L14 8 L30 6 L35 22 L22 34 Z" fill="#ff5a1f"/><circle cx="20" cy="19" r="4" fill="#1c1d1f"/></svg>';

const brand: BrandSpec = {
  name: 'Crux',
  positioning: 'A logbook for bouldering: what you tried, what you sent, and how your grades grow.',
  audience: 'People who climb indoors two or three times a week.',
  tone: 'Short, like chalked notes on a wall. Grades and moves, no cheering.',
  fields: { gradients: 'none', shadows: 'none' },
  colors: [
    { name: 'Chalk', role: 'background', value: '#f2f1ec', token: 'chalk' },
    { name: 'Granite', role: 'text', value: '#1c1d1f', token: 'granite' },
    { name: 'Hold', role: 'primary', value: '#ff5a1f', token: 'hold', note: 'Actions, the hardest grade, and the logo.' },
    { name: 'Slate', role: 'text-secondary', value: '#64676c', token: 'slate' },
    { name: 'Dust', role: 'text-secondary-dark', value: '#a9aaa6', token: 'dust' },
    { name: 'Crimp', role: 'border', value: '#e2e0d8', token: 'crimp', note: 'Lines, quiet fields and the wall.' },
    { name: 'Seam', role: 'line on crimp', value: '#cdcac0', token: 'seam' },
    { name: 'Flash', role: 'accent', value: '#ffd84d', token: 'flash', note: 'Only for a flash, and for yellow holds.' },
    { name: 'Sky', role: 'hold colour', value: '#2a5fd0', token: 'sky' },
  ],
  pairings: [{ fg: 'granite', bg: 'chalk', verdict: 'allow' }, { fg: 'chalk', bg: 'granite', verdict: 'allow' }, { fg: 'granite', bg: 'hold', verdict: 'allow' }, { fg: 'granite', bg: 'flash', verdict: 'allow' }, { fg: 'chalk', bg: 'sky', verdict: 'allow' }, { fg: 'hold', bg: 'chalk', verdict: 'forbid', note: 'Orange text on chalk is too weak.' }],
  families: [{ family: 'Saira', role: 'display', fallback: '"Arial Narrow", sans-serif', weights: [400, 500, 600, 700, 800], token: 'saira', license: 'OFL' }],
  typeScale: [
    { name: 'Grade', role: 'display', size: 150, weight: 800, lineHeight: '0.78', tracking: '-0.03em', family: 'Saira', token: 'text-grade' },
    { name: 'Headline', role: 'h1', size: 64, weight: 800, lineHeight: '0.9', tracking: '-0.01em', family: 'Saira', token: 'text-headline' },
    { name: 'Number', role: 'h2', size: 40, weight: 800, lineHeight: '0.9', family: 'Saira', token: 'text-number' },
    { name: 'Section', role: 'h3', size: 28, weight: 800, lineHeight: '0.9', family: 'Saira', token: 'text-section' },
    { name: 'Grade chip', role: 'label', size: 24, weight: 800, lineHeight: '1', family: 'Saira', token: 'text-chip' },
    { name: 'Body', role: 'body', size: 16, weight: 400, lineHeight: '1.4', family: 'Saira', token: 'text-body' },
    { name: 'Small', role: 'small', size: 14, weight: 400, lineHeight: '1.4', family: 'Saira', token: 'text-small' },
  ],
  spacing: [4, 8, 12, 16, 24, 32, 40],
  radius: [8, 12, 14],
  logos: [{ name: 'Hold', background: 'any', minWidth: 20, clearSpace: 6, svg: HOLD }],
  rules: [
    { text: 'Display type is Saira at 75% width and weight 800; text is Saira at its normal width.', kind: 'do', severity: 'soft', topic: 'type' },
    { text: 'Every grade sits on the colour of its holds.', kind: 'do', severity: 'soft', topic: 'color' },
    { text: 'Hold orange is for the one action on a screen.', kind: 'do', severity: 'soft', topic: 'color' },
  ],
  voice: [{ good: '3 sends, 1 flash', bad: 'Amazing session, you crushed it!' }, { good: 'Left heel, not right.', bad: 'Remember to optimise your technique.' }],
};

function screens(k: BrandKit): BoardPlan[] {
  const p = new Paint(k);
  const font = p.f('saira');
  const d = (size: number, extra: Style = {}): Style => ({ margin: 0, fontFamily: font, fontSize: `${size}px`, fontWeight: 800, fontStretch: '75%', lineHeight: 0.9, letterSpacing: '-0.01em', ...extra });
  const b = (size = 16, extra: Style = {}): Style => ({ margin: 0, fontFamily: font, fontSize: `${size}px`, fontWeight: 400, lineHeight: 1.4, ...extra });
  const [chalk, granite, hold, slate, dust, crimp, flash, sky] = ['chalk', 'granite', 'hold', 'slate', 'dust', 'crimp', 'flash', 'sky'].map((x) => p.c(x)) as [string, string, string, string, string, string, string, string];
  const logo = k.logos()[0];

  const status = (dark: boolean) => h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px 4px', color: dark ? chalk : granite, background: dark ? granite : undefined }, [
    h('span', b(14, { fontWeight: 600 }), '9:41', { 'data-name': 'Time' }),
    h('div', { width: '18px', height: '10px', border: '1.5px solid currentColor', borderRadius: '3px' }, [], { 'data-name': 'Battery' }),
  ], { 'data-name': 'Status bar' });
  const tabs = (active: string) => h('nav', { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 'auto', padding: '8px 12px 32px', background: chalk, borderTop: `1px solid ${crimp}` }, ['Session', 'Walls', 'Log', 'Progress'].map((n) => h('a', { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', textDecoration: 'none', color: n === active ? granite : slate }, [
    h('div', { width: '22px', height: '4px', borderRadius: '2px', background: n === active ? hold : 'transparent' }, [], { 'data-name': 'Marker' }),
    h('span', b(14, { fontWeight: n === active ? 700 : 500 }), n, { 'data-name': 'Label' }),
  ], { href: '#', 'data-name': `Tab ${n}` })), { 'data-name': 'Tab bar' });
  const chip = (grade: string, color: string) => h('span', { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', minWidth: '52px', height: '40px', padding: '0 8px', background: color, color: color === granite || color === sky ? chalk : granite, borderRadius: '8px', ...d(24, { lineHeight: 1 }) }, t(grade), { 'data-name': 'Grade' });
  const problem = (grade: string, color: string, name: string, wall: string, result: string) => h('div', { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0', borderTop: `1px solid ${crimp}` }, [
    chip(grade, color),
    h('div', { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1' }, [
      h('p', b(16, { fontWeight: 600, color: granite, lineHeight: 1.2 }), t(name), { 'data-name': 'Name' }),
      h('p', b(14, { color: slate, lineHeight: 1.2 }), t(wall), { 'data-name': 'Wall' }),
    ], { 'data-name': 'What' }),
    h('span', b(14, { fontWeight: 700, color: result === 'Project' ? slate : granite, ...(result === 'Flash' ? { background: flash, padding: '2px 8px', borderRadius: '4px' } : {}) }), t(result), { 'data-name': 'Result' }),
  ], { 'data-name': `Problem ${name}` });
  // Both carry a 2px border, so that the filled and the outlined button are the same height on the same padding.
  const button = (label: string, loud: boolean, extra: Style = {}) => h('a', { display: 'flex', justifyContent: 'center', flex: '1', padding: '12px 0', background: loud ? hold : 'transparent', border: `2px solid ${loud ? hold : granite}`, color: granite, borderRadius: '12px', ...b(16, { fontWeight: 700 }), textDecoration: 'none', ...extra }, t(label), { href: '#', 'data-name': `Button ${label}` });
  // A form's prompts label its fields; the screen's one heading is its title.
  const question = (text: string) => h('p', b(16, { fontWeight: 700, color: granite }), t(text), { 'data-name': 'Question' });

  // 1. Today's session.
  const session = [
    status(false),
    h('header', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px 0' }, [
      h('div', { display: 'flex', alignItems: 'center', gap: '8px' }, [logo ? k.logo(logo, 26) : '', h('span', d(24, { color: granite }), 'Crux', { 'data-name': 'Name' })], { 'data-name': 'Logo' }),
      h('span', b(14, { color: slate }), 'Tue 12 Nov', { 'data-name': 'Date' }),
    ], { 'data-name': 'Header' }),
    h('section', { display: 'flex', flexDirection: 'column', gap: '8px', padding: '32px 24px 24px' }, [
      h('p', b(14, { color: slate }), 'Boulderhalle Nord, 58 minutes in', { 'data-name': 'Where' }),
      h('h1', d(64, { color: granite }), '3 sends, 1 flash', { 'data-name': 'Headline' }),
    ], { 'data-name': 'Summary' }),
    h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', margin: '0 24px', padding: '16px 4px', background: granite, borderRadius: '14px' }, [['14', 'tries'], ['6C', 'hardest'], ['4', 'walls']].map(([n, l]) => h('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }, [
      h('span', d(40, { color: n === '6C' ? hold : chalk }), n!, { 'data-name': 'Number' }),
      h('span', b(14, { color: dust }), l!, { 'data-name': 'Label' }),
    ], { 'data-name': l })), { 'data-name': 'Numbers' }),
    h('section', { display: 'flex', flexDirection: 'column', padding: '24px 24px 0' }, [
      h('h2', d(28, { color: granite, paddingBottom: '12px' }), 'Climbed today', { 'data-name': 'Heading' }),
      problem('6C', hold, 'Sloper Party', 'Cave, left', 'Send'),
      problem('6B+', sky, 'Blue Monday', 'Slab', 'Flash'),
      problem('6A', flash, 'Pinch Me', 'Arete', 'Send'),
      problem('7A', granite, 'The Long Goodbye', 'Roof', 'Project'),
    ], { 'data-name': 'List' }),
    tabs('Session'),
  ];

  // 2. One problem on its wall.
  const holdAt = (x: number, y: number, w: number, hh: number, rot: number, color = hold) => h('div', { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px`, background: color, borderRadius: '40% 55% 45% 60%', transform: `rotate(${rot}deg)` }, [], { 'data-name': 'Hold' });
  const seam = p.c('seam');
  const wall = h('div', { position: 'relative', height: '296px', margin: '0 24px', overflow: 'hidden', background: crimp, borderRadius: '14px' }, [
    `<svg data-name="Wall panels" viewBox="0 0 345 296" style="position:absolute;left:0;top:0;width:100%;height:100%"><path d="M0 110 L345 80 M0 230 L345 210 M120 0 L135 296 M240 0 L230 296" stroke="${p.hex('seam')}" stroke-width="2" fill="none"/></svg>`,
    holdAt(60, 236, 40, 26, -10), holdAt(150, 208, 30, 22, 20), holdAt(92, 160, 34, 24, -30), holdAt(190, 140, 44, 28, 12), holdAt(130, 82, 30, 22, -18), holdAt(232, 40, 52, 32, 8),
    holdAt(40, 60, 18, 14, 0, seam), holdAt(280, 190, 22, 16, 30, seam), holdAt(250, 250, 18, 14, 0, seam),
    h('span', b(14, { position: 'absolute', left: '58px', top: '264px', fontWeight: 700, color: granite }), 'Start', { 'data-name': 'Start' }),
    h('span', b(14, { position: 'absolute', left: '232px', top: '76px', fontWeight: 700, color: granite }), 'Top', { 'data-name': 'Top' }),
  ], { 'data-name': 'Wall' });
  const route = [
    status(true),
    h('section', { display: 'flex', flexDirection: 'column', gap: '4px', padding: '12px 24px 24px', background: granite }, [
      h('a', b(16, { display: 'flex', alignItems: 'center', gap: '4px', alignSelf: 'flex-start', color: dust, textDecoration: 'none', paddingBottom: '16px' }), [BACK, h('span', {}, 'Cave', { 'data-name': 'Label' })], { href: '#', 'aria-label': 'Back to Cave', 'data-name': 'Back' }),
      h('div', { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }, [
        h('h1', d(150, { color: hold, lineHeight: 0.78, letterSpacing: '-0.03em' }), '6C', { 'data-name': 'Grade' }),
        h('div', { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px', paddingBottom: '8px' }, [
          h('p', b(14, { color: dust }), 'set by Mira', { 'data-name': 'Setter' }),
          h('p', b(14, { color: dust }), 'up since 4 Nov', { 'data-name': 'Since' }),
        ], { 'data-name': 'Facts' }),
      ], { 'data-name': 'Top line' }),
      h('p', d(40, { color: chalk, paddingTop: '8px' }), 'Sloper Party', { 'data-name': 'Name' }),
    ], { 'data-name': 'Head' }),
    h('div', { display: 'flex', flexDirection: 'column', paddingTop: '16px' }, [wall], { 'data-name': 'Wall area' }),
    h('section', { display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px 24px 0' }, [
      h('p', b(16, { color: granite }), 'Big slopers into a heel hook on the lip. Most people fall at the third move.', { 'data-name': 'Beta' }),
      h('p', b(14, { color: slate }), 'You: 4 tries, sent on the last one.', { 'data-name': 'Yours' }),
    ], { 'data-name': 'About' }),
    h('div', { display: 'flex', gap: '12px', padding: '16px 24px 0' }, [button('Log a send', true), button('Log a try', false)], { 'data-name': 'Actions' }),
    tabs('Walls'),
  ];

  // 3. Logging a send.
  const option = (label: string, on: boolean, note: string) => h('div', { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1', padding: '12px', borderRadius: '12px', background: on ? granite : 'transparent', border: on ? undefined : `1.5px solid ${crimp}` }, [
    h('span', d(28, { color: on ? chalk : granite }), label, { 'data-name': 'Label' }),
    h('span', b(14, { color: on ? dust : slate }), note, { 'data-name': 'Note' }),
  ], { 'data-name': `Style ${label}` });
  const square = (sign: string, loud: boolean) => h('span', { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '44px', height: '44px', borderRadius: '12px', ...(loud ? { background: granite, color: chalk } : { border: `1.5px solid ${crimp}`, color: granite }), ...d(28) }, sign, { 'data-name': loud ? 'More' : 'Less' });
  const log = [
    status(false),
    h('header', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px' }, [
      h('a', b(16, { color: slate, textDecoration: 'none' }), 'Cancel', { href: '#', 'data-name': 'Cancel' }),
      h('h1', b(16, { fontWeight: 700, color: granite }), 'Log a send', { 'data-name': 'Title' }),
      h('span', { width: '48px' }, [], { 'data-name': 'Space' }),
    ], { 'data-name': 'Header' }),
    h('div', { display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 24px 24px', borderBottom: `1px solid ${crimp}` }, [
      chip('6C', hold),
      h('div', { display: 'flex', flexDirection: 'column' }, [h('p', b(16, { fontWeight: 600, color: granite }), 'Sloper Party', { 'data-name': 'Name' }), h('p', b(14, { color: slate }), 'Cave, left', { 'data-name': 'Wall' })], { 'data-name': 'Problem' }),
    ], { 'data-name': 'What' }),
    h('section', { display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px 24px 0' }, [
      question('Result'),
      h('div', { display: 'flex', gap: '8px' }, [option('Flash', false, 'first try'), option('Send', true, 'after tries'), option('Repeat', false, 'done before')], { 'data-name': 'Styles' }),
    ], { 'data-name': 'Style' }),
    h('section', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '24px 24px 0' }, [
      question('Tries'),
      h('div', { display: 'flex', alignItems: 'center', gap: '16px' }, [square('−', false), h('span', d(40, { minWidth: '36px', textAlign: 'center', color: granite }), '4', { 'data-name': 'Count' }), square('+', true)], { 'data-name': 'Stepper' }),
    ], { 'data-name': 'Tries' }),
    h('section', { display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px 24px 0' }, [
      question('For the grade, it felt'),
      h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '4px', background: crimp, borderRadius: '12px' }, ['Soft', 'Right', 'Hard'].map((n) => h('span', { display: 'flex', justifyContent: 'center', padding: '8px 0', borderRadius: '8px', background: n === 'Hard' ? chalk : 'transparent', ...b(16, { fontWeight: n === 'Hard' ? 700 : 500, color: granite }) }, n, { 'data-name': n })), { 'data-name': 'Feel' }),
    ], { 'data-name': 'Feel' }),
    h('section', { display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px 24px 0' }, [
      question('Note'),
      h('div', { padding: '12px', minHeight: '76px', border: `1.5px solid ${crimp}`, borderRadius: '12px', ...b(16, { color: granite }) }, 'Left heel, not right. Breathe before the lip.', { 'data-name': 'Field' }),
    ], { 'data-name': 'Note' }),
    h('div', { display: 'flex', marginTop: 'auto', padding: '0 24px 40px' }, [button('Save the send', true, { padding: '16px 0' })], { 'data-name': 'Save' }),
  ];

  // 4. Progress: the grade pyramid.
  const pyramid: [string, number][] = [['7A', 1], ['6C+', 2], ['6C', 4], ['6B+', 7], ['6B', 10], ['6A+', 13], ['6A', 16]];
  const widest = Math.max(...pyramid.map(([, n]) => n));
  const total = pyramid.reduce((s, [, n]) => s + n, 0);
  const progress = [
    status(true),
    h('section', { display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px 24px 32px', background: granite }, [
      h('p', b(14, { color: dust }), 'Since September', { 'data-name': 'Period' }),
      h('h1', d(64, { color: chalk }), 'Your pyramid', { 'data-name': 'Headline' }),
      h('p', b(14, { color: dust, maxWidth: '300px' }), 'Sends per grade. A wide base under each step keeps the next one coming.', { 'data-name': 'Line' }),
    ], { 'data-name': 'Head' }),
    h('section', { display: 'flex', flexDirection: 'column', gap: '8px', padding: '32px 24px' }, pyramid.map(([g, n]) => h('div', { display: 'grid', gridTemplateColumns: '44px 1fr 28px', alignItems: 'center', gap: '12px' }, [
      h('span', d(24, { color: granite }), g, { 'data-name': 'Grade' }),
      h('div', { display: 'flex', justifyContent: 'center' }, [h('div', { width: `${Math.round((n / widest) * 100)}%`, height: '30px', borderRadius: '6px', background: g === '7A' ? hold : g.startsWith('6C') ? granite : crimp }, [], { 'data-name': 'Bar' })], { 'data-name': 'Bar area' }),
      h('span', b(14, { color: slate, textAlign: 'right' }), String(n), { 'data-name': 'Count' }),
    ], { 'data-name': `Step ${g}` })), { 'data-name': 'Pyramid' }),
    h('section', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', padding: '0 24px' }, [
      h('div', { display: 'flex', flexDirection: 'column', gap: '4px', padding: '16px', background: hold, borderRadius: '14px' }, [h('span', d(40, { color: granite }), '7A', { 'data-name': 'Number' }), h('span', b(14, { color: granite }), 'first one, 28 Oct', { 'data-name': 'Label' })], { 'data-name': 'Hardest' }),
      h('div', { display: 'flex', flexDirection: 'column', gap: '4px', padding: '16px', border: `1.5px solid ${crimp}`, borderRadius: '14px' }, [h('span', d(40, { color: granite }), String(total), { 'data-name': 'Number' }), h('span', b(14, { color: slate }), 'sends in all', { 'data-name': 'Label' })], { 'data-name': 'All' }),
    ], { 'data-name': 'Facts' }),
    tabs('Progress'),
  ];

  const board = (name: string, steps: string[]): BoardPlan => ({ name, width: 393, height: 852, background: chalk, color: granite, font, steps: steps.map((html) => ({ html })) });
  return [board('Crux, session', session), board('Crux, problem', route), board('Crux, log a send', log), board('Crux, progress', progress)];
}

export const crux: ExampleDef = {
  id: 'example-app',
  kind: 'App screens',
  name: 'Crux, app screens',
  description: 'Four screens at 393 x 852 of a made-up bouldering logbook: today\'s session, one problem on a drawn wall, logging a send, and a grade pyramid. Saira at 75% width for grades, chalk and granite with hold orange.',
  brand,
  parts: [{ key: 'session', name: 'Crux, session', size: '393 x 852' }, { key: 'problem', name: 'Crux, problem', size: '393 x 852' }, { key: 'log', name: 'Crux, log a send', size: '393 x 852' }, { key: 'progress', name: 'Crux, progress', size: '393 x 852' }],
  build: (k) => ({ page: 'App screens', boards: screens(k), gaps: [] }),
};
