import { BrandKit, h, seenMin, t, type Style, type TemplateEnv } from './kit.ts';
import { brandLines, pick, Slots, slotText, target } from './words.ts';
import type { BoardPlan, TemplateDef } from './types.ts';

type Part = { key: string; name: string; width: number; height?: number };
type Build = (k: BrandKit, slots: Slots, part: Part) => string;
/** The smallest text that reads on the 1080-wide social boards, seen at 390 in a phone feed. */
const SOCIAL_MIN = seenMin(1080, 'social');
const widths = [{ key: '1440', name: 'Desktop', width: 1440 }, { key: '390', name: 'Mobile', width: 390 }];
const named = (name: string) => ({ 'data-name': name });
const stack: Style = { display: 'flex', flexDirection: 'column' };
const row: Style = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start' };
function kit(k: BrandKit) { return k.paint(k.scheme(k.base())); }
function text(k: BrandKit, slots: Slots, name: string, hint: string, size = 20, heading = false, content?: string, min = 0) {
  return slotText(slots, heading ? 'h1' : 'p', { ...k.font(k.sized(size, heading ? 'display' : 'body', undefined, min)), color: kit(k).fg, margin: 0, overflowWrap: 'anywhere' }, content ?? hint, name, hint);
}
function title(k: BrandKit, slots: Slots, size: number) {
  return text(k, slots, 'Main message', 'Write the useful outcome in the audience’s words.', size, true, pick(k, brandLines(k), 'h1', 'Write the useful outcome.'));
}
/** `min` is the smallest size that reads where the board is seen (seenMin). */
function header(k: BrandKit, min = 0) {
  return h('header', { ...row, justifyContent: 'space-between', gap: k.space(16), paddingBottom: k.space(24), borderBottom: `1px solid ${kit(k).line}` }, [h('p', { ...k.font(k.sized(18, 'body', 700, min)), margin: 0 }, t(k.name), named('Brand name'))], named('Header'));
}
function button(k: BrandKit, slots: Slots, name: string, hint: string) {
  // Until a destination is supplied this is a real button, not a fabricated product URL.
  return h('button', { ...target(), ...k.font(k.sized(18, 'body', 600)), minHeight: '48px', padding: `${k.space(12)} ${k.space(24)}`, color: kit(k).fg, background: kit(k).bg, border: `1px solid ${kit(k).fg}`, borderRadius: k.radius(), cursor: 'pointer' }, slotText(slots, 'span', {}, hint, name, hint), named(name + ' button'));
}
function imageSlot(k: BrandKit, slots: Slots, name: string, hint: string, minHeight = 240, min = 0) {
  return h('div', { ...stack, justifyContent: 'center', minHeight: `${minHeight}px`, padding: k.space(24), border: `1px dashed ${kit(k).line}`, minWidth: 0 }, text(k, slots, name, hint, 18, false, undefined, min), named(name + ' region'));
}
function fields(k: BrandKit, slots: Slots, names: string[], error = false) {
  return h('form', { ...stack, gap: k.space(24), width: '100%', maxWidth: '560px' }, names.map((name) => h('label', { ...stack, gap: k.space(8), ...k.font(k.sized(18)) }, [t(name), h('input', { ...k.font(k.sized(18)), color: kit(k).fg, background: kit(k).bg, border: `1px solid ${kit(k).fg}`, width: '100%', minWidth: 0, minHeight: '48px', padding: k.space(12), boxSizing: 'border-box' }, [], { type: name.toLowerCase().includes('email') ? 'email' : 'text', name: name.toLowerCase().replace(/\W+/g, '-'), ...(error ? { 'aria-invalid': 'true' } : {}), ...named(name + ' input') }), error ? text(k, slots, name + ' error', 'Explain what to correct and keep the entered answer.', 16) : ''], named(name + ' field'))), named('Fields'));
}

function define(id: string, name: string, discipline: string, description: string, parts: Part[], build: Build, gap?: string): TemplateDef {
  return {
    id, name, discipline, description,
    fileName: (brand) => `${brand} — ${name}`,
    parts: parts.map((p) => ({ key: p.key, name: p.name, size: `${p.width} x ${p.height ?? 'content'}` })),
    build(env: TemplateEnv, options) {
      const k = new BrandKit(env), slots = new Slots(), p = kit(k);
      const boards = parts.filter((part) => !options.only || options.only.includes(part.key)).map((part): BoardPlan => ({
        name: `${name} · ${part.name}`, width: part.width, ...(part.height ? { height: part.height } : {}), background: p.bg, color: p.fg, font: k.stack(k.family('body')),
        steps: [{ html: build(k, slots, part) }],
      }));
      return { page: name, boards, gaps: gap ? [gap] : [], slots: slots.list };
    },
  };
}

export const appFlow = define('app-flow', 'Mobile task flow', 'mobile-apps', 'Four editable 393-wide app states: browse, detail, empty and recoverable error. Brand type and colors, real labeled fields and content slots; choose the target OS before refining hit regions and system insets.', [
  { key: 'browse', name: 'Browse', width: 393, height: 852 }, { key: 'detail', name: 'Detail', width: 393, height: 852 }, { key: 'empty', name: 'Empty', width: 393, height: 852 }, { key: 'error', name: 'Error', width: 393, height: 852 },
], (k, slots, part) => {
  const content = part.key === 'browse' ? [title(k, slots, 36), text(k, slots, 'Task context', 'Explain what the person can do here.'), ...['First item', 'Second item'].map((name) => h('section', { ...stack, gap: k.space(12), paddingBlock: k.space(24), borderBottom: `1px solid ${kit(k).line}` }, [text(k, slots, name, 'Name a real item from the product.', 24), text(k, slots, name + ' context', 'Add only the information needed to choose.', 18)], named(name)))]
    : part.key === 'detail' ? [text(k, slots, 'Selected item', 'Name the selected item.', 36, true), imageSlot(k, slots, 'Product view', 'Place an actual product or item image.', 180), text(k, slots, 'Decision context', 'Explain the useful details for the selected item.')]
      : part.key === 'empty' ? [text(k, slots, 'Empty title', 'Explain why there are no items.', 36, true), text(k, slots, 'Empty next step', 'Show how to add an item or change the current filter.')]
        : [text(k, slots, 'Error title', 'Explain which action did not complete.', 36, true), fields(k, slots, ['Name'], true), text(k, slots, 'Recovery', 'Explain how to retry without losing the answer.')];
  return h('div', { ...stack, height: '100%', boxSizing: 'border-box', padding: k.space(24), gap: k.space(32) }, [header(k), h('div', { ...stack, flex: '1 1 auto', minHeight: 0, overflowY: 'auto', gap: k.space(24) }, content, named('Task content')), button(k, slots, 'Primary action', part.key === 'empty' ? 'Name the useful first action.' : 'Name the next action.')], named('Mobile layout'));
}, 'Choose the native OS, real content, safe areas and navigation before delivery. These static screens do not implement an app.');

export const desktopWorkspace = define('desktop-workspace', 'Document workspace', 'desktop-apps', '1280 and 640-wide resizable workspace studies with navigation, document and contextual inspector. Panels wrap and scroll independently instead of hiding the last command.', [
  { key: 'wide', name: 'Wide window', width: 1280, height: 800 }, { key: 'narrow', name: 'Narrow window', width: 640, height: 800 },
], (k, slots) => h('div', { ...stack, height: '100%', boxSizing: 'border-box', padding: k.space(24), gap: k.space(24), overflow: 'auto' }, [header(k),
  h('div', { ...row, gap: k.space(24), flex: '1 1 auto', minHeight: 0 }, [
    h('nav', { ...stack, flex: '0 1 180px', gap: k.space(16) }, [text(k, slots, 'Navigation heading', 'Name the collection.', 18), ...['Current document', 'Related document'].map((n) => button(k, slots, n, 'Name a real destination.'))], { 'aria-label': 'Documents', ...named('Navigation') }),
    h('section', { ...stack, gap: k.space(24), flex: '1 1 300px', minWidth: 0, overflow: 'auto' }, [text(k, slots, 'Document title', 'Name the working document.', 36, true), imageSlot(k, slots, 'Working content', 'Place the actual editable document content.', 320)], named('Document')),
    h('aside', { ...stack, flex: '1 1 220px', minWidth: 0, gap: k.space(24), overflow: 'auto' }, [text(k, slots, 'Inspector heading', 'Name the selected object.', 24), fields(k, slots, ['Label']), text(k, slots, 'Inspector scope', 'Explain what the selected property affects.', 16)], named('Inspector')),
  ], named('Workspace panes')),
]), 'Native menus, shortcuts and persistence need implementation and target-OS verification.');

export const analyticsDashboard = define('analytics-dashboard', 'Decision dashboard', 'dashboards', 'Desktop and mobile analytics composition with decision context, a wide chart region and a readable evidence table. All metrics remain explicit content slots until real data is supplied.', widths, (k, slots, part) => h('div', { ...stack, padding: k.space(part.width < 600 ? 24 : 64), gap: k.space(40) }, [header(k), title(k, slots, part.width < 600 ? 36 : 56),
  h('div', { ...row, gap: k.space(24), justifyContent: 'space-between' }, [text(k, slots, 'Period', 'State the measured period and comparison.'), text(k, slots, 'Provenance', 'Name the data source and last update.', 16)], named('Data context')),
  imageSlot(k, slots, 'Measured chart', 'Insert a chart from verified data, with units and an honest scale.', part.width < 600 ? 220 : 360),
  h('div', { overflowX: 'auto' }, h('table', { width: '100%', borderCollapse: 'collapse', ...k.font(k.sized(18)), color: kit(k).fg }, [h('caption', { textAlign: 'start', marginBottom: k.space(16) }, t('Add the decision-relevant detail.'), named('Table purpose')), h('thead', {}, h('tr', {}, ['Measure', 'Value', 'Context'].map((n) => h('th', { textAlign: 'start', padding: k.space(12), borderBottom: `1px solid ${kit(k).line}` }, t(n), { scope: 'col' })))), h('tbody', {}, h('tr', {}, ['Measure name', 'Actual value', 'Definition and coverage'].map((n) => h('td', { padding: k.space(12), verticalAlign: 'top' }, text(k, slots, n, 'Supply ' + n.toLowerCase() + '.', 18)))))], named('Evidence table')), named('Table scroll region')),
  text(k, slots, 'Missing data state', 'Explain the difference between unavailable data and a measured zero.', 16),
]), 'No sample metrics or fabricated trend are supplied. Connect or provide the actual dataset.');

export const checkoutFlow = define('checkout-flow', 'Checkout and recovery', 'ecommerce', 'Desktop and mobile guest checkout studies plus a mobile validation-error state. Persistent labels, order context and explicit terms slots; no invented prices or payment integration.', [
  ...widths, { key: 'error', name: 'Mobile error', width: 390 },
], (k, slots, part) => h('div', { ...stack, padding: k.space(part.width < 600 ? 24 : 64), gap: k.space(40) }, [header(k), text(k, slots, 'Checkout title', 'Name the current checkout step.', part.width < 600 ? 36 : 48, true),
  part.key === 'error' ? h('section', { ...stack, gap: k.space(12), border: `2px solid ${kit(k).fg}`, padding: k.space(16) }, [text(k, slots, 'Error summary', 'Explain the problem and link to each affected answer.', 20)], { role: 'alert', ...named('Error summary region') }) : '',
  h('div', { ...row, gap: k.space(48) }, [h('section', { ...stack, flex: '2 1 300px', minWidth: 0, gap: k.space(24) }, [text(k, slots, 'Guest context', 'Explain that an account is optional.', 20), fields(k, slots, ['Email address', 'Full name', 'Delivery address'], part.key === 'error'), button(k, slots, 'Continue', 'Name the next checkout step.'), text(k, slots, 'Terms', 'State the relevant commitment before the final purchase.', 16)], named('Guest details')),
    h('aside', { ...stack, flex: '1 1 240px', minWidth: 0, gap: k.space(24), borderTop: `1px solid ${kit(k).line}`, paddingTop: k.space(24) }, [text(k, slots, 'Order heading', 'Describe the selected order.', 28), text(k, slots, 'Actual total', 'Supply the actual total and currency.', 24), text(k, slots, 'Delivery terms', 'State shipping cost, timing and return conditions.', 18)], named('Order summary'))], named('Checkout columns')),
]), 'Supply real product, pricing, address requirements, delivery and payment rules. Static form layers are not a functioning checkout.');

export const socialCarousel = define('social-carousel', 'Educational carousel', 'social', 'Five editable 1080-square cards with different narrative roles, one readable point each and a consistent brand identity. An original composition; check the actual organic or paid placement before export.', [
  { key: 'cover', name: 'Useful promise', width: 1080, height: 1080 }, { key: 'context', name: 'Context', width: 1080, height: 1080 }, { key: 'point', name: 'Key point', width: 1080, height: 1080 }, { key: 'example', name: 'Concrete example', width: 1080, height: 1080 }, { key: 'close', name: 'Next step', width: 1080, height: 1080 },
], (k, slots, part) => h('div', { ...stack, padding: k.space(72), boxSizing: 'border-box', height: '100%', gap: k.space(40), justifyContent: 'space-between' }, [header(k, SOCIAL_MIN), h('div', { ...stack, gap: k.space(32) }, [part.key === 'cover' ? title(k, slots, 88) : text(k, slots, part.name + ' title', 'Write the distinct point of this card.', 72, true), part.key === 'example' ? imageSlot(k, slots, 'Real example', 'Place one real annotated example.', 280, SOCIAL_MIN) : text(k, slots, part.name + ' body', part.key === 'close' ? 'State a useful next step and actual destination.' : 'Give only the context needed for this point.', 36)], named('Card message')), h('footer', { ...row, justifyContent: 'space-between', gap: k.space(24) }, [h('span', k.font(k.sized(24, 'body', undefined, SOCIAL_MIN)), t(k.name)), h('span', k.font(k.sized(24, 'body', undefined, SOCIAL_MIN)), t(String(['cover', 'context', 'point', 'example', 'close'].indexOf(part.key) + 1) + ' / 5'))])], named('Carousel layout')),
  'Five cards are an editable narrative choice, not a platform requirement or an engagement guarantee.');

export const socialStory = define('social-story', 'Portrait launch story', 'social', 'Three editable 1080 x 1920 portrait boards for context, actual product and next step. Real portrait composition with large text; intended-placement overlays still need a delivery check.', [
  { key: 'context', name: 'Context', width: 1080, height: 1920 }, { key: 'product', name: 'Product', width: 1080, height: 1920 }, { key: 'next', name: 'Next step', width: 1080, height: 1920 },
], (k, slots, part) => h('div', { ...stack, minHeight: '100%', boxSizing: 'border-box', padding: `${k.space(160)} ${k.space(80)}`, gap: k.space(64), justifyContent: 'space-between' }, [header(k, SOCIAL_MIN), text(k, slots, part.name + ' headline', part.key === 'context' ? 'Name the audience’s real problem.' : part.key === 'product' ? 'Explain the visible product outcome.' : 'State the next useful action.', 88, true), part.key === 'product' ? imageSlot(k, slots, 'Portrait product view', 'Compose an actual product view for portrait.', 800, SOCIAL_MIN) : text(k, slots, part.name + ' support', 'Add concise, verified supporting context.', 40), text(k, slots, 'Delivery note', 'Add the real destination or sequence cue.', 32)], named('Portrait composition')),
  'The inset is a draft composition margin, not a universal platform safe area. Confirm the actual placement UI before publishing.');

export const caseStudyPage = define('case-study-page', 'Evidence-led case study', 'websites', '1440 and 390-wide editorial case study: context, constraints, approach, actual before/after visuals, verified outcome and limitations. Real flow layout and content slots rather than fabricated success metrics.', widths, (k, slots, part) => h('div', { ...stack, padding: k.space(part.width < 600 ? 24 : 64), gap: k.space(48) }, [header(k), title(k, slots, part.width < 600 ? 48 : 72), text(k, slots, 'Case context', 'Name the client or context only when approved for publication.', 22),
  h('div', { ...row, gap: k.space(40) }, [h('section', { ...stack, flex: '1 1 280px', minWidth: 0, gap: k.space(24) }, [text(k, slots, 'Constraint', 'Explain the most important real constraint.', 28), text(k, slots, 'Approach', 'Explain the design decision and its reason.', 20)], named('Approach region')), h('section', { ...stack, flex: '2 1 340px', minWidth: 0, gap: k.space(24) }, [imageSlot(k, slots, 'Before view', 'Place the actual earlier state.'), imageSlot(k, slots, 'After view', 'Place the actual final state.')], named('Before and after'))], named('Case composition')),
  text(k, slots, 'Outcome', 'State the verified outcome and how it was measured.', 28), text(k, slots, 'Limitations', 'State the limits of the evidence and what was not tested.', 18), button(k, slots, 'Related next step', 'Name the useful next step.'),
]));

export const onePagePitch = define('one-page-pitch', 'One-page pitch', 'pitch-decks', 'A 1600 x 1000 leave-behind with a clear purpose, problem/answer, evidence region and a supplied decision. Original editorial composition with large text, no fake traction or market figures.', [{ key: 'summary', name: 'Summary', width: 1600, height: 1000 }], (k, slots) => h('div', { ...stack, height: '100%', boxSizing: 'border-box', padding: k.space(64), gap: k.space(40) }, [header(k), title(k, slots, 72), h('div', { ...row, flex: '1 1 auto', gap: k.space(48) }, [h('section', { ...stack, flex: '1 1 400px', minWidth: 0, gap: k.space(24) }, [text(k, slots, 'Problem', 'Describe the real audience problem.', 32), text(k, slots, 'Answer', 'Explain the distinct answer and mechanism.', 28), text(k, slots, 'Ask', 'State the decision requested from this audience.', 28)], named('Argument')), h('section', { ...stack, flex: '1 1 500px', minWidth: 0, gap: k.space(24) }, [imageSlot(k, slots, 'Evidence', 'Place actual product evidence or a sourced comparison.', 260), text(k, slots, 'Evidence context', 'Name the source, date and relevant limitation.', 22)], named('Proof'))], named('Pitch columns')), text(k, slots, 'Contact', 'Supply the real contact or follow-up destination.', 24)]));

export const DISCIPLINE_TEMPLATES = [appFlow, desktopWorkspace, analyticsDashboard, checkoutFlow, socialCarousel, socialStory, caseStudyPage, onePagePitch];
