import type { BrandColor } from '@bogen/core';
import { BrandKit, h, t, type TemplateEnv } from './kit.ts';
import type { BoardPlan, BoardStep, TemplateDef, TemplateOptions, TemplatePlan } from './types.ts';
import { brandLines, pick, Slots, slotText } from './words.ts';

/**
 * A pitch deck of ten slides at 1920 x 1080, one board each, in the order investors expect: what it is, the problem,
 * the answer, how it works, the product, traction, the market, the business model, the team and the ask. The brand's
 * own lines go where they fit; every other text is a short slot that says what to write there.
 */

const SLIDES = [
  { key: 'title', name: 'Title' },
  { key: 'problem', name: 'Problem' },
  { key: 'solution', name: 'Solution' },
  { key: 'how', name: 'How it works' },
  { key: 'product', name: 'Product' },
  { key: 'traction', name: 'Traction' },
  { key: 'market', name: 'Market' },
  { key: 'model', name: 'Business model' },
  { key: 'team', name: 'Team' },
  { key: 'ask', name: 'The ask' },
] as const;

type Key = (typeof SLIDES)[number]['key'];
const W = 1920;
const H = 1080;

function slide(k: BrandKit, slots: Slots, key: Key, n: number, define: { steps: boolean; people: boolean }): BoardPlan {
  const loud = key === 'title' || key === 'ask';
  const accent = k.accent();
  const ground: BrandColor | null = loud && accent && k.textOn(accent, true) && k.textOn(accent) ? accent : key === 'traction' || key === 'team' ? k.alternate() ?? k.base() : k.base();
  const s = k.scheme(ground);
  const p = k.paint(s);
  const pad = k.space(120);
  const logo = k.logoFor(ground);
  const title = (text: string, hint: string, size = 112) => slotText(slots, 'h1', { ...k.font(k.sized(size, 'display')), color: p.fg, maxWidth: '1500px' }, text, 'Headline', hint);
  const body = (text: string, layer = 'Body', hint = 'One or two short sentences that back the headline.') => slotText(slots, 'p', { ...k.font(k.sized(40)), color: p.fg, maxWidth: '820px' }, text, layer, hint);
  const small = (text: string, layer: string, hint: string) => slotText(slots, 'p', { ...k.font(k.sized(30)), color: p.muted, maxWidth: '520px' }, text, layer, hint);
  const lines = brandLines(k);

  const top = h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: k.space(24) }, [
    logo ? k.logo(logo, 48) : h('p', { ...k.font(k.sized(30, 'body', 700)), color: p.fg }, t(k.name), { 'data-name': 'Name' }),
    h('p', { ...k.font(k.sized(24, 'mono')), color: p.muted }, `${String(n).padStart(2, '0')} of 10`, { 'data-name': 'Slide number' }),
  ], { 'data-name': 'Top' });

  const steps: BoardStep[] = [];
  let middle: string;
  switch (key) {
    case 'title':
      middle = h('div', { display: 'flex', flexDirection: 'column', gap: k.space(40) }, [
        slotText(slots, 'h1', { ...k.font(k.sized(180, 'display')), color: p.fg, maxWidth: '1600px' }, pick(k, lines, 'h1', 'Say what you make in a line'), 'Headline', 'The one line that says what you make and for whom. The brand\'s own line is used where it has one.'),
        body(pick(k, [k.data.fields.positioning], 'p', 'Who it is for, and what changes for them.'), 'Positioning', 'Who it is for, and what changes for them, in a sentence or two.'),
      ], { 'data-name': 'Opening' });
      break;
    case 'problem':
      middle = h('div', { display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: k.space(96), alignItems: 'end' }, [
        title('Name the problem in one line', 'The problem, as the customer would say it.'),
        body('Who has it, and what it costs them today.'),
      ], { 'data-name': 'Statement' });
      break;
    case 'solution':
      middle = h('div', { display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: k.space(96), alignItems: 'end' }, [
        title('What you make, in one line', 'The answer to the problem on the slide before.'),
        body(pick(k, [k.data.fields.positioning], 'p', 'What it does, and what the customer gets from it.')),
      ], { 'data-name': 'Statement' });
      break;
    case 'how': {
      const step = (i: number) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(16), borderTop: `2px solid ${p.line}`, paddingTop: k.space(24) }, [
        // A quarter or more under the headline, so the slide keeps one loud line.
        h('p', { ...k.font(k.sized(64, 'display')), color: p.fg }, String(i), { 'data-name': 'Number' }),
        h('h2', { ...k.font(k.sized(44, 'display')), color: p.fg }, 'Name this step plainly', { 'data-name': 'Step title' }),
        h('p', { ...k.font(k.sized(30)), color: p.muted }, 'What happens in this step.', { 'data-name': 'Step body' }),
      ], { 'data-name': 'Step' });
      slots.add('Step title', 'A step of how it works, as a verb and its object.');
      slots.add('Step body', 'What happens in this step, in a sentence.');
      middle = h('div', { display: 'flex', flexDirection: 'column', gap: k.space(64) }, [
        title('How it works, step by step', 'How the product works, in a line.'),
        h('div', { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: k.space(48) }, define.steps ? [step(1)] : [], { 'data-name': 'Steps' }),
      ], { 'data-name': 'Steps section' });
      if (define.steps) steps.push({ component: { layer: 'Step', name: 'Deck step', description: 'One numbered step of how it works.', props: [{ name: 'number', type: 'text', target: 'Number' }, { name: 'title', type: 'text', target: 'Step title' }, { name: 'body', type: 'text', target: 'Step body' }] } });
      steps.push({ into: 'Steps', html: (define.steps ? [2, 3] : [1, 2, 3]).map((i) => h('x-instance', {}, [], { component: 'Deck step', 'prop-number': String(i) })).join('') });
      break;
    }
    case 'product':
      middle = h('div', { display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: k.space(80), alignItems: 'center' }, [
        h('div', { display: 'flex', flexDirection: 'column', gap: k.space(32) }, [
          title('Show the product at work', 'What the screenshot shows, as a claim.'),
          body('The one thing to notice in the picture.', 'Caption', 'What the reader should notice in the picture.'),
        ], { 'data-name': 'Words' }),
        h('img', { width: '900px', height: '560px', objectFit: 'cover', border: `2px solid ${p.line}` }, [], { alt: 'A screenshot of the product at work', 'data-name': slots.add('Product picture', 'A real screenshot of the product: upload it with asset_upload and set it as the src.') }),
      ], { 'data-name': 'Product' });
      break;
    case 'traction':
      middle = h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: k.space(96), alignItems: 'end' }, [
        h('div', { display: 'flex', flexDirection: 'column', gap: k.space(24) }, [
          title('What has happened so far', 'The progress that matters most, as a claim.'),
          body('Since when, and what it counts.'),
        ], { 'data-name': 'Words' }),
        h('div', { display: 'flex', flexDirection: 'column', gap: k.space(16) }, [
          slotText(slots, 'p', { ...k.font(k.sized(220, 'display')), lineHeight: '1', color: p.fg }, 'Your figure', 'Figure', 'One real figure: customers, revenue or growth. Only one the person gave you.'),
          small('What the figure counts, and since when.', 'Figure label', 'What the figure counts, and over which time.'),
        ], { 'data-name': 'Figure block' }),
      ], { 'data-name': 'Traction' });
      break;
    case 'market':
      middle = h('div', { display: 'flex', flexDirection: 'column', gap: k.space(48) }, [
        title('Who buys it, and how many', 'Who the customers are, and how many there are.'),
        h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: k.space(64) }, [
          small('The customers you can reach first, and how.', 'First market', 'The first customers you can reach, and how you reach them.'),
          small('Where it goes after them, and how large that is.', 'Whole market', 'The whole market, with its size and where the figure comes from.'),
        ], { 'data-name': 'Markets' }),
      ], { 'data-name': 'Market' });
      break;
    case 'model':
      middle = h('div', { display: 'flex', flexDirection: 'column', gap: k.space(48) }, [
        title('How it makes money', 'How the business earns, in a line.'),
        h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: k.space(64), borderTop: `2px solid ${p.line}`, paddingTop: k.space(32) }, [
          small('What a customer pays, and how often.', 'Price', 'What a customer pays, and how often.'),
          small('What it costs to win and serve one customer.', 'Cost', 'What it costs to win and to serve one customer.'),
        ], { 'data-name': 'Model' }),
      ], { 'data-name': 'Business model' });
      break;
    case 'team': {
      const person = () => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(16) }, [
        h('img', { width: '240px', height: '240px', objectFit: 'cover' }, [], { alt: 'Portrait of a person on the team', 'data-name': 'Portrait' }),
        h('h2', { ...k.font(k.sized(44, 'display')), color: p.fg }, 'Name of the person', { 'data-name': 'Person name' }),
        h('p', { ...k.font(k.sized(30)), color: p.muted }, 'Their role, and what they did before.', { 'data-name': 'Person role' }),
      ], { 'data-name': 'Person' });
      slots.add('Person name', 'A real name the person gave you.');
      slots.add('Person role', 'Their role here, and the one thing they did before that matters.');
      slots.add('Portrait', 'A real portrait: upload it with asset_upload and set it as the src.');
      middle = h('div', { display: 'flex', flexDirection: 'column', gap: k.space(64) }, [
        title('The people who build it', 'Why this team can do it, in a line.'),
        h('div', { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: k.space(48) }, define.people ? [person()] : [], { 'data-name': 'People' }),
      ], { 'data-name': 'Team' });
      if (define.people) steps.push({ component: { layer: 'Person', name: 'Deck person', description: 'A person on the team, with a portrait, name and role.', props: [{ name: 'name', type: 'text', target: 'Person name' }, { name: 'role', type: 'text', target: 'Person role' }, { name: 'portrait', type: 'image', target: 'Portrait' }] } });
      steps.push({ into: 'People', html: (define.people ? [2, 3] : [1, 2, 3]).map(() => h('x-instance', {}, [], { component: 'Deck person' })).join('') });
      break;
    }
    case 'ask':
      middle = h('div', { display: 'flex', flexDirection: 'column', gap: k.space(40) }, [
        title('What you are asking for now', 'The amount and what it pays for, in a line.', 140),
        body('What it pays for, and how long it lasts.'),
        slotText(slots, 'p', { ...k.font(k.sized(40, 'body', 700)), color: p.fg }, 'Your email address or website', 'Contact', 'How to reach you: an email address or a website.'),
      ], { 'data-name': 'Ask' });
      break;
  }

  return {
    name: `${String(n).padStart(2, '0')} ${SLIDES[n - 1]!.name}`, width: W, height: H, background: p.bg, color: p.fg, font: k.stack(k.family('body')),
    steps: [{ html: h('div', { display: 'flex', flexDirection: 'column', flex: '1 1 auto', padding: pad, gap: k.space(48) }, [top, h('div', { display: 'flex', flexDirection: 'column', justifyContent: key === 'title' ? 'flex-end' : 'center', flex: '1 1 auto' }, [middle], { 'data-name': 'Content' })], { 'data-name': 'Slide' }) }, ...steps],
  };
}

export const pitchDeck: TemplateDef = {
  id: 'pitch-deck',
  name: 'Pitch deck',
  description: 'A pitch deck of ten slides at 1920 x 1080 in the brand: title, problem, solution, how it works, product, traction, market, business model, team and the ask. The brand\'s own line opens it where it fits; every other text is a short slot that says what to write, and slots lists them. Steps and people are components.',
  parts: SLIDES.map((s, i) => ({ key: s.key, name: `${String(i + 1).padStart(2, '0')} ${s.name}`, size: '1920 x 1080' })),
  fileName: (brand) => `${brand} pitch deck`,
  build(env: TemplateEnv, options: TemplateOptions): TemplatePlan {
    const k = new BrandKit(env);
    const slots = new Slots();
    const define = { steps: !env.components.has('Deck step'), people: !env.components.has('Deck person') };
    const boards = SLIDES.map((s, i) => ({ s, n: i + 1 })).filter(({ s }) => !options.only?.length || options.only.includes(s.key)).map(({ s, n }) => slide(k, slots, s.key, n, define));
    const gaps: string[] = [];
    if (!k.logos().length) gaps.push('No logo yet: add one with brand_asset_add, and every slide carries it.');
    return { page: 'Pitch deck', boards, gaps, slots: slots.list };
  },
};
