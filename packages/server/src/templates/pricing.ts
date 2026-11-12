import { BrandKit, h, t, type TemplateEnv } from './kit.ts';
import { pageFooter, pageHeader } from './page-parts.ts';
import type { BoardPlan, BoardStep, TemplateDef, TemplateOptions, TemplatePlan } from './types.ts';
import { pick, Slots, slotText, target } from './words.ts';

/**
 * A pricing page in the brand: a headline, three plans as instances of one Plan component set (standard and featured),
 * a table that compares them, questions as disclosures, and the footer. Prices, names and features are slots: a template
 * never invents a price.
 */

function pricing(k: BrandKit, width: number, slots: Slots, define: boolean): BoardPlan {
  const mobile = width < 700;
  const base = k.base();
  const p = k.paint(k.scheme(base));
  const alt = k.alternate();
  const a = k.paint(alt ? k.scheme(alt) : k.scheme(base));
  const accent = k.accent();
  const onAccent = accent ? k.textOn(accent) : null;
  const pad = mobile ? k.space(24) : k.space(88);
  const block = mobile ? k.space(64) : k.space(96);
  const steps: BoardStep[] = [];
  // The page's levels a fifth apart at least: the headline, the section headings, the plan names. The plans are one
  // component on both boards, so their price and name take sizes under the 390 board's headline too.
  const above = { above: k.type('body').px };
  const [h1Size, h2Size] = k.ladder(mobile ? [48, 32] : [96, 48], above);
  const [, priceSize, nameSize] = k.ladder([48, 32, 24], above);
  const action = (featured: boolean) => {
    const fill = featured && accent && onAccent ? { background: k.c(accent), color: k.c(onAccent), border: `1px solid ${k.c(accent)}` } : { background: 'transparent', color: p.fg, border: `1px solid ${p.fg}` };
    return h('a', { ...k.font(k.type('body'), 700), ...target({ justifyContent: 'center', padding: `${k.space(12)} ${k.space(24)}` }), ...fill, textDecoration: 'none', borderRadius: k.radius() }, 'Choose this plan', { href: '#', 'data-name': 'Plan action' });
  };
  const plan = (featured: boolean) => h('article', { display: 'flex', flexDirection: 'column', gap: k.space(20), padding: k.space(32), border: `${featured ? 2 : 1}px solid ${featured && accent && base && k.canText(accent, base, true) ? k.c(accent) : p.line}`, borderRadius: k.radius(), background: p.bg }, [
    h('h3', { ...k.font(nameSize!, 700), color: p.fg }, 'Name of the plan', { 'data-name': 'Plan name' }),
    h('p', { ...k.font(priceSize!), color: p.fg }, 'Price', { 'data-name': 'Plan price' }),
    h('p', { ...k.font(k.type('small')), color: p.muted }, 'Per month, and what is billed when.', { 'data-name': 'Plan terms' }),
    h('p', { ...k.font(k.type('body')), color: p.fg }, 'Who this plan is for.', { 'data-name': 'Plan audience' }),
    h('ul', { display: 'flex', flexDirection: 'column', gap: k.space(8), margin: 0, paddingLeft: k.space(20) }, [1, 2, 3].map(() => h('li', { ...k.font(k.type('body')), color: p.fg }, 'Something this plan includes', { 'data-name': 'Plan feature' })), { 'data-name': 'Plan features' }),
    action(featured),
  ], { 'data-name': `Plan / ${featured ? 'featured' : 'standard'}` });
  for (const [layer, hint] of [['Plan name', 'The name of the plan, as customers say it.'], ['Plan price', 'The real price, with its currency. Never a made-up one.'], ['Plan terms', 'How it is billed: per month, per seat, per year.'], ['Plan audience', 'Who the plan is for, in a line.'], ['Plan feature', 'Something the plan includes, as the customer gets it.']] as const) slots.add(layer, hint);

  const plans = define ? [plan(false), plan(true)] : [];
  const comparison = (label: string) => h('tr', {}, [
    h('th', { ...k.font(k.type('small'), 700), color: p.fg, textAlign: 'left', padding: `${k.space(12)} ${k.space(16)}`, borderBottom: `1px solid ${p.line}` }, t(label), { scope: 'row', 'data-name': slots.add('Compared feature', 'A feature that differs between the plans.') }),
    ...['Included', 'Included', 'Not included'].reverse().map((v) => h('td', { ...k.font(k.type('small')), color: p.fg, padding: `${k.space(12)} ${k.space(16)}`, borderBottom: `1px solid ${p.line}` }, v, { 'data-name': 'Plan value' })),
  ], { 'data-name': 'Feature row' });
  const question = () => h('details', { borderTop: `1px solid ${p.line}`, padding: `${k.space(16)} 0` }, [
    h('summary', { ...k.font(k.type('body'), 700), ...target(), color: p.fg, cursor: 'pointer' }, 'A question people ask before they buy', { 'data-name': 'Question' }),
    h('p', { ...k.font(k.type('body')), color: p.muted, paddingTop: k.space(8), maxWidth: '720px' }, 'The answer, plainly, in a sentence or two.', { 'data-name': 'Answer' }),
  ], { 'data-name': 'Question item' });
  slots.add('Question', 'A question buyers really ask, in their words.');
  slots.add('Answer', 'The answer, plainly, in one or two sentences.');

  const main = h('main', { display: 'flex', flexDirection: 'column' }, [
    h('section', { display: 'flex', flexDirection: 'column', gap: k.space(24), padding: `${block} ${pad} ${k.space(48)}` }, [
      slotText(slots, 'h1', { ...k.font(h1Size!), color: p.fg, maxWidth: '1000px' }, 'Plans and prices, plainly', 'Headline', 'What the reader can buy, in a line.'),
      slotText(slots, 'p', { ...k.font(k.type('lead')), color: p.fg, maxWidth: '720px' }, pick(k, [k.data.fields.positioning], 'p', 'Who it is for, and what every plan includes.'), 'Lead', 'Who it is for, and what every plan includes.'),
    ], { 'data-name': 'Intro' }),
    h('section', { display: 'flex', flexDirection: 'column', gap: k.space(32), padding: `${k.space(24)} ${pad} ${block}` }, [
      slotText(slots, 'h2', { ...k.font(h2Size!), color: p.fg }, 'Pick the plan that fits', 'Plans heading', 'A heading over the plans.'),
      h('div', { display: 'grid', gridTemplateColumns: mobile ? '1fr' : 'repeat(3, 1fr)', gap: k.space(24), alignItems: 'start' }, plans, { 'data-name': 'Plans' }),
    ], { 'data-name': 'Plans section' }),
    h('section', { display: 'flex', flexDirection: 'column', gap: k.space(32), padding: `${block} ${pad}`, background: a.bg }, [
      slotText(slots, 'h2', { ...k.font(h2Size!), color: a.fg }, 'Compare the plans side by side', 'Compare heading', 'A heading over the comparison.'),
      h('div', { overflow: 'auto', background: p.bg }, [
        h('table', { width: '100%', borderCollapse: 'collapse' }, [
          h('thead', {}, [h('tr', {}, ['Feature', 'First plan', 'Second plan', 'Third plan'].map((label) => h('th', { ...k.font(k.type('small'), 700), color: p.fg, textAlign: 'left', padding: `${k.space(12)} ${k.space(16)}`, borderBottom: `2px solid ${p.fg}` }, t(label), { scope: 'col', 'data-name': 'Column' })))]),
          h('tbody', {}, ['A feature that differs', 'Another feature that differs', 'Support and how fast'].map(comparison)),
        ], { 'data-name': 'Comparison table' }),
      ], { 'data-name': 'Table wrapper' }),
    ], { 'data-name': 'Comparison' }),
    h('section', { display: 'flex', flexDirection: 'column', gap: k.space(24), padding: `${block} ${pad}` }, [
      slotText(slots, 'h2', { ...k.font(h2Size!), color: p.fg }, 'Questions before you decide', 'Questions heading', 'A heading over the questions.'),
      h('div', { display: 'flex', flexDirection: 'column' }, [question(), question(), question()], { 'data-name': 'Questions' }),
    ], { 'data-name': 'FAQ' }),
  ], { 'data-name': 'Main' });

  if (define) {
    for (const kind of ['standard', 'featured']) steps.push({ component: { layer: `Plan / ${kind}`, name: `Plan / ${kind}`, set: 'Plan', variant: { emphasis: kind }, description: 'A plan with its name, price, terms, audience, features and action.', props: [{ name: 'name', type: 'text', target: 'Plan name' }, { name: 'price', type: 'text', target: 'Plan price' }, { name: 'terms', type: 'text', target: 'Plan terms' }, { name: 'audience', type: 'text', target: 'Plan audience' }] } });
    steps.push({ into: 'Plans', html: h('x-instance', {}, [], { component: 'Plan', 'prop-emphasis': 'standard' }) });
  } else {
    steps.push({ into: 'Plans', html: ['standard', 'featured', 'standard'].map((e) => h('x-instance', {}, [], { component: 'Plan', 'prop-emphasis': e })).join('') });
  }
  return {
    name: `Pricing, ${width}`, tag: 'div', width, background: p.bg, color: p.fg, font: k.stack(k.family('body')),
    steps: [{ html: [pageHeader(k, base, p, mobile, ['Product', 'Pricing', 'Docs'], pad), main, pageFooter(k, base, p, mobile, pad)].join('') }, ...steps],
  };
}

export const pricingPage: TemplateDef = {
  id: 'pricing-page',
  name: 'Pricing page',
  description: 'A pricing page in the brand at 1440 and 390: header, headline, three plans as instances of a Plan component set (standard and featured), a table comparing them, questions as disclosures, and the footer. Prices, plan names and features are slots: it never invents a price.',
  parts: [{ key: '1440', name: 'Pricing, 1440', size: '1440 wide, hugs content' }, { key: '390', name: 'Pricing, 390', size: '390 wide, hugs content' }],
  fileName: (brand) => `${brand} pricing page`,
  build(env: TemplateEnv, options: TemplateOptions): TemplatePlan {
    const k = new BrandKit(env);
    const slots = new Slots();
    const widths = [1440, 390].filter((w) => !options.only?.length || options.only.includes(String(w)));
    const has = env.components.has('Plan');
    return { page: 'Pricing page', boards: widths.map((w, i) => pricing(k, w, slots, !has && i === 0)), gaps: [], slots: slots.list };
  },
};
