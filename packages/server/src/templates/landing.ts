import { buttonParts } from './brand-system.ts';
import { BrandKit, h, t, type Scheme, type TemplateEnv } from './kit.ts';
import type { BoardPlan, BoardStep, TemplateDef, TemplateOptions, TemplatePlan } from './types.ts';

/**
 * A landing page skeleton in the brand: the sections most product pages need, in order, with the brand's words where it
 * has them and plain placeholders where it does not. Repeated parts are components, so a person fills one and the rest follow.
 */
function page(k: BrandKit, width: number, defineButtons: boolean, defineParts: boolean): BoardPlan {
  const mobile = width < 700;
  const base = k.base();
  const scheme = k.scheme(base);
  const p = k.paint(scheme);
  const alt = k.alternate();
  const altScheme: Scheme = alt ? k.scheme(alt) : scheme;
  const a = k.paint(altScheme);
  const accent = k.accent();
  const pad = mobile ? k.space(24) : k.space(88);
  const block = mobile ? k.space(64) : k.space(120);
  const max = mobile ? 64 : 160;
  const f = k.data.fields;
  const goods = k.data.voiceExamples.map((e) => e.good).filter(Boolean);
  const headline = [...goods].sort((x, y) => x.length - y.length)[0] ?? k.name;
  const logo = k.logoFor(base);
  const cols = (desktop: string) => (mobile ? '1fr' : desktop);
  const steps: BoardStep[] = [];
  const button = (kind: 'primary' | 'quiet', label: string) => h('x-instance', {}, [], { component: 'Button', 'prop-kind': kind, 'prop-size': mobile ? 'default' : 'large', 'prop-label': label });
  // Headings a fifth apart at least, so that the hero stays the one loud line. Steps and features are components made
  // on the 1440 board and shown on the 390 one too, so their numbers and titles take the 390 board's levels.
  const [smallHero, smallSection, smallSub] = k.ladder([64, 40, 28], { max: 64 });
  const heroRole = mobile ? smallHero! : k.type('hero', max);
  const sectionRole = mobile ? smallSection! : k.ladder([heroRole.px, 72])[1]!;
  const heading = (text: string, color = p.fg) => h('h2', { ...k.font(sectionRole), color, maxWidth: '880px' }, t(text), { 'data-name': 'Heading' });
  const section = (name: string, children: string[], bg?: string, extra: Record<string, string> = {}) => h('section', { display: 'flex', flexDirection: 'column', gap: mobile ? k.space(40) : k.space(48), padding: `${block} ${pad}`, background: bg, ...extra }, children, { 'data-name': name });

  // Header and hero. The buttons are made here when the file has none yet.
  const buttons = buttonParts(k, scheme, { primary: 'Get started', quiet: 'Learn more' });
  const mainFor = (kind: string) => buttons.mains.find((m) => m.includes(`data-name="Button / ${kind} / ${mobile ? 'default' : 'large'}"`));
  const heroButtons = defineButtons ? [mainFor('primary'), mainFor('quiet')].filter(Boolean) as string[] : [button('primary', 'Get started'), button('quiet', 'Learn more')];
  const nav = mobile ? [] : ['Product', 'How it works', 'Pricing', 'FAQ'].map((n) => h('span', { ...k.font(k.type('small')), color: p.fg }, n, { 'data-name': 'Link' }));
  steps.push({ html: h('header', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: k.space(24), padding: `${k.space(24)} ${pad}`, borderBottom: `1px solid ${p.line}` }, [
    logo ? k.logo(logo, mobile ? 32 : 40) : h('span', { ...k.font(k.type('subheading', 32)), color: p.fg }, t(k.name), { 'data-name': 'Name' }),
    nav.length ? h('nav', { display: 'flex', gap: k.space(40) }, nav, { 'data-name': 'Links' }) : '',
  ], { 'data-name': 'Header' }) });
  steps.push({ html: section('Hero', [
    h('h1', { ...k.font(heroRole), color: p.fg, maxWidth: '1100px' }, t(headline), { 'data-name': 'Headline' }),
    h('div', { display: 'grid', gridTemplateColumns: cols('1fr 1fr'), gap: k.space(40), alignItems: 'end' }, [
      h('p', { ...k.font(k.type('lead')), color: p.fg, maxWidth: '620px' }, t(f.positioning || 'One or two sentences on what it does and for whom.'), { 'data-name': 'Positioning' }),
      h('div', { display: 'flex', gap: k.space(12), flexWrap: 'wrap', justifyContent: mobile ? 'flex-start' : 'flex-end' }, heroButtons, { 'data-name': 'Actions' }),
    ], { 'data-name': 'Under the headline' }),
    // The product itself, large: a placeholder to fill with the real screen, object or output, never left out.
    h('img', { width: '100%', height: mobile ? '240px' : '640px', objectFit: 'cover', borderRadius: k.radius() }, '', { 'data-name': 'Product view', alt: 'The product itself: its real screen, object or output' }),
  ], undefined, { paddingTop: mobile ? k.space(48) : k.space(88) }) });
  if (defineButtons) for (const kind of ['primary', 'quiet']) {
    const def = buttons.defs.find((d) => 'component' in d && d.component.name === `Button / ${kind} / ${mobile ? 'default' : 'large'}`);
    if (def) steps.push(def);
  }

  // Proof.
  steps.push({ html: section('Proof', [h('figure', { display: 'flex', flexDirection: 'column', gap: k.space(24), margin: 0 }, [
    h('blockquote', { margin: 0 }, [h('p', { ...k.font(k.type(mobile ? 'subheading' : 'heading', mobile ? 32 : 64), 700), color: a.fg, maxWidth: '1080px' }, '“A sentence from someone who uses it, in their words.”', { 'data-name': 'Quote' })], { 'data-name': 'Quotation' }),
    h('figcaption', { ...k.font(k.type('small')), color: a.muted }, 'Who said it: their name and what they do', { 'data-name': 'Source' }),
  ], { 'data-name': 'Testimonial' })], a.bg) });

  // What it does: one component, three times.
  const feature = (n: number) => h('div', { display: 'grid', gridTemplateColumns: cols('120px 1fr 1fr'), gap: mobile ? k.space(8) : k.space(40), borderTop: `1px solid ${p.line}`, paddingTop: k.space(24), paddingBottom: k.space(24) }, [
    // At the reading size: a tiny label over a heading reads as a template's eyebrow.
    h('span', { ...k.font({ ...k.type('body'), family: k.type('mono').family }), color: accent && base && k.canText(accent, base) ? k.c(accent) : p.fg }, `0${n}`, { 'data-name': 'Number' }),
    h('h3', { ...k.font(smallSub!, 700), color: p.fg }, 'What it does, in a few words', { 'data-name': 'Title' }),
    h('p', { ...k.font(k.type('body')), color: p.muted }, 'One or two sentences on what this means for the reader.', { 'data-name': 'Body' }),
  ], { 'data-name': 'Feature' });
  const features = defineParts ? [feature(1)] : [];
  steps.push({ html: section('Features', [heading('What it does'), h('div', { display: 'flex', flexDirection: 'column' }, features, { 'data-name': 'Feature list' })]) });
  if (defineParts) steps.push({ component: { layer: 'Feature', name: 'Feature', description: 'A numbered line of what the product does.', props: [{ name: 'number', type: 'text', target: 'Number' }, { name: 'title', type: 'text', target: 'Title' }, { name: 'body', type: 'text', target: 'Body' }] } });
  steps.push({ into: 'Feature list', html: (defineParts ? [2, 3] : [1, 2, 3]).map((n) => h('x-instance', mobile ? { gridTemplateColumns: '1fr', gap: k.space(8) } : {}, [], { component: 'Feature', 'prop-number': `0${n}` })).join('') });

  // How it works: three steps across, on the alternate ground.
  const stepCell = (n: number) => h('div', { display: 'flex', flexDirection: 'column', gap: k.space(12) }, [
    h('span', { ...k.font(smallSection!), color: a.fg }, String(n), { 'data-name': 'Number' }),
    h('h3', { ...k.font(smallSub!, 700), color: a.fg }, 'The step, as a verb', { 'data-name': 'Title' }),
    h('p', { ...k.font(k.type('body')), color: a.muted }, 'What happens, and what the reader does.', { 'data-name': 'Body' }),
  ], { 'data-name': 'Step' });
  steps.push({ html: section('How it works', [heading('How it works', a.fg), h('div', { display: 'grid', gridTemplateColumns: cols('repeat(3, 1fr)'), gap: k.space(40) }, defineParts ? [stepCell(1)] : [], { 'data-name': 'Steps' })], a.bg) });
  if (defineParts) steps.push({ component: { layer: 'Step', name: 'Step', description: 'One step of how it works.', props: [{ name: 'number', type: 'text', target: 'Number' }, { name: 'title', type: 'text', target: 'Title' }, { name: 'body', type: 'text', target: 'Body' }] } });
  steps.push({ into: 'Steps', html: (defineParts ? [2, 3] : [1, 2, 3]).map((n) => h('x-instance', {}, [], { component: 'Step', 'prop-number': String(n) })).join('') });

  // Getting it: a command when the brand has a mono face, a plain action otherwise.
  const mono = k.family('mono');
  steps.push({ html: section('Get it', [
    heading('Get started'),
    h('div', { display: 'grid', gridTemplateColumns: cols('1fr 1fr'), gap: k.space(40), alignItems: 'center' }, [
      mono ? h('div', { display: 'flex', alignItems: 'center', padding: `${k.space(20)} ${k.space(24)}`, background: a.bg, border: `1px solid ${p.line}`, borderRadius: k.radius() }, [
        h('code', { ...k.font(k.type('mono')), color: a.fg }, '$ the install command', { 'data-name': 'Command' }),
      ], { 'data-name': 'Install' }) : h('p', { ...k.font(k.type('lead')), color: p.fg }, 'What it costs, or how to get it, in one line.', { 'data-name': 'Price' }),
      h('div', { display: 'flex', gap: k.space(12), justifyContent: mobile ? 'flex-start' : 'flex-end' }, [button('primary', 'Get started')], { 'data-name': 'Actions' }),
    ], { 'data-name': 'Offer' }),
  ]) });

  // Questions.
  const question = () => h('div', { display: 'grid', gridTemplateColumns: cols('1fr 1fr'), gap: mobile ? k.space(8) : k.space(40), borderTop: `1px solid ${p.line}`, paddingTop: k.space(24), paddingBottom: k.space(24) }, [
    h('h3', { ...k.font(smallSub!, 700), color: p.fg }, 'A question people ask before they start', { 'data-name': 'Question' }),
    h('p', { ...k.font(k.type('body')), color: p.muted }, 'The answer, plainly, in two or three sentences.', { 'data-name': 'Answer' }),
  ], { 'data-name': 'Question item' });
  steps.push({ html: section('FAQ', [heading('Questions'), h('div', { display: 'flex', flexDirection: 'column' }, defineParts ? [question()] : [], { 'data-name': 'Questions' })], undefined, { paddingTop: '0px' }) });
  if (defineParts) steps.push({ component: { layer: 'Question item', name: 'Question', description: 'A question and its answer.', props: [{ name: 'question', type: 'text', target: 'Question' }, { name: 'answer', type: 'text', target: 'Answer' }] } });
  steps.push({ into: 'Questions', html: Array.from({ length: defineParts ? 3 : 4 }, () => h('x-instance', mobile ? { gridTemplateColumns: '1fr', gap: k.space(8) } : {}, [], { component: 'Question' })).join('') });

  // Footer.
  const footLogo = k.logoFor(alt ?? base);
  steps.push({ html: h('footer', { display: 'flex', flexDirection: mobile ? 'column' : 'row', justifyContent: 'space-between', alignItems: mobile ? 'flex-start' : 'center', gap: k.space(24), padding: `${k.space(48)} ${pad}`, background: a.bg }, [
    footLogo ? k.logo(footLogo, 32) : h('span', { ...k.font(k.type('body'), 700), color: a.fg }, t(k.name), { 'data-name': 'Name' }),
    h('p', { ...k.font(k.type('small')), color: a.muted }, t(`Copyright ${k.env.date.getFullYear()} ${k.name}`), { 'data-name': 'Small print' }),
  ], { 'data-name': 'Footer' }) });

  return { name: `Landing, ${width}`, width, background: p.bg, color: p.fg, font: k.stack(k.family('body')), steps };
}

export const landingPage: TemplateDef = {
  id: 'landing-page',
  name: 'Landing page',
  description: 'A landing page skeleton in the brand at 1440 and 390: header, hero (the brand\'s own line and positioning), proof, features, how it works, get started (an install command when the brand has a mono face), questions and footer. Set in the brand\'s tokens and type scale; Button, Feature, Step and Question are components, so filling one fills the rest. Placeholder copy says what goes where: replace it.',
  parts: [{ key: '1440', name: 'Landing, 1440', size: '1440 wide, hugs content' }, { key: '390', name: 'Landing, 390', size: '390 wide, hugs content' }],
  fileName: (brand) => `${brand} landing page`,
  build(env: TemplateEnv, options: TemplateOptions): TemplatePlan {
    const k = new BrandKit(env);
    const widths = [1440, 390].filter((w) => !options.only?.length || options.only.includes(String(w)));
    const hasButtons = env.components.has('Button');
    const hasParts = env.components.has('Feature') && env.components.has('Step') && env.components.has('Question');
    return { page: 'Landing page', boards: widths.map((w, i) => page(k, w, !hasButtons && i === 0, !hasParts && i === 0)), gaps: [] };
  },
};
