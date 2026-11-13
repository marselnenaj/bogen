import { eachAxis, el, icon, ICONS, text, type Css } from './markup.ts';
import type { Kit, KitComponent, KitToken, Variant } from './types.ts';

/**
 * The U.S. Web Design System (`@uswds/uswds` 3.14.0). Its LICENSE.md: the work of GSA is not subject to copyright in
 * the United States, and GSA waives copyright worldwide through the CC0 1.0 Universal dedication; the fonts it
 * bundles (Source Sans Pro, Merriweather, Public Sans) are under the SIL OFL 1.1, Roboto Mono and the Material icons
 * under Apache-2.0, and parts of its element styles under MIT. Bogen ships none of those files: only the default
 * theme's colour values, read from dist/css/uswds.css, and its own drawing of the components with inline styles.
 * The font is Public Sans (OFL, made by USWDS), named, not bundled. No banner, flag or seal: the drawing is not a
 * government service and implies no endorsement. Code handoff is markup with USWDS's `usa-*` classes as its docs
 * write them, for a project that loads USWDS's CSS and JavaScript.
 */
const u = (name: string) => `var(--usa-${name})`;
const FONT = { fontFamily: u('font-sans'), fontSize: '1.06rem', lineHeight: '1.5', color: u('base-ink') } as const;
const PKG = '@uswds/uswds';
const FOCUS: Css = { outline: `0.25rem solid ${u('focus')}`, outlineOffset: '0.25rem' };

const BUTTONS: Record<string, Css> = {
  default: { background: u('primary'), color: u('white') },
  secondary: { background: u('secondary'), color: u('white') },
  'accent-cool': { background: u('accent-cool'), color: u('base-ink') },
  base: { background: u('base'), color: u('white') },
  outline: { background: 'transparent', color: u('primary'), boxShadow: `inset 0 0 0 2px ${u('primary')}` },
  unstyled: { background: 'transparent', color: u('primary'), textDecoration: 'underline', fontWeight: 400, padding: '0', borderRadius: '0' },
};

function button(variant: Variant): string {
  const big = variant.size === 'big';
  return el('button', {
    ...FONT, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', columnGap: '0.5rem', lineHeight: '0.9', fontWeight: 700, border: '0', borderRadius: u('radius-md'),
    padding: big ? '1rem 1.5rem' : '0.75rem 1.25rem', fontSize: big ? '1.46rem' : '1.06rem', flex: 'none', ...BUTTONS[variant.variant!], ...(variant.state === 'focus' ? FOCUS : {}),
  }, text('span', {}, 'Renew permit', 'Label'), { type: 'button' });
}

function formGroup(parts: string[], error = false, name = 'Form group'): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '360px', boxSizing: 'border-box', ...(error ? { borderLeft: `0.25rem solid ${u('error-dark')}`, paddingLeft: '1rem' } : {}) }, parts, { 'data-name': name });
}

function field(error: boolean, content: string, name: string): string {
  return el('div', { display: 'flex', alignItems: 'center', height: '2.5rem', marginTop: '0.5rem', padding: '0.5rem', boxSizing: 'border-box', background: u('white'), border: error ? `0.25rem solid ${u('error-dark')}` : `1px solid ${u('base-dark')}`, borderRadius: '0' }, content, { 'data-name': name });
}

function textInput(variant: Variant): string {
  const error = variant.state === 'error';
  return formGroup([
    text('label', { fontWeight: error ? 700 : 400, lineHeight: '1.3' }, 'Permit number', 'Label'),
    text('span', { color: u('base'), lineHeight: '1.3' }, 'Eight digits, on the top right of your permit', 'Hint'),
    error ? text('span', { color: u('error-dark'), fontWeight: 700, padding: '0.25rem 0' }, 'Enter all eight digits of the permit number', 'Error message') : '',
    field(error, text('span', { color: u('base-ink') }, '2048 1170', 'Value'), 'Input'),
  ], error);
}

function select(): string {
  return formGroup([
    text('label', { lineHeight: '1.3' }, 'Permit type', 'Label'),
    field(false, el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }, [text('span', {}, 'Residential parking', 'Value'), icon(ICONS.chevronsUpDown, 16)]), 'Select'),
  ]);
}

function checkbox(variant: Variant): string {
  const on = variant.checked === 'true';
  const tile = variant.tile === 'true';
  return el('label', {
    ...FONT, display: 'flex', alignItems: 'flex-start', gap: '0.75rem', width: tile ? '360px' : undefined, boxSizing: 'border-box', flex: 'none',
    ...(tile ? { padding: '0.75rem 1rem 0.75rem 0.5rem', borderRadius: u('radius-md'), border: `2px solid ${on ? u('primary') : u('base-light')}`, background: on ? u('primary-lightest') : u('white') } : {}),
  }, [
    el('span', { width: '1.25rem', height: '1.25rem', margin: '2px', marginTop: '3px', borderRadius: u('radius-sm'), background: on ? u('primary') : u('white'), boxShadow: `0 0 0 2px ${on ? u('primary') : u('base-ink')}`, color: u('white'), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, on ? icon(ICONS.check, 16, 'Check', 3) : '', { 'data-name': 'Box', role: 'checkbox' }),
    el('span', { display: 'flex', flexDirection: 'column' }, [
      text('span', {}, 'Send me a reminder before it expires', 'Label'),
      tile ? text('span', { color: u('base-dark'), fontSize: '0.93rem' }, 'One email, 30 days before the end date', 'Description') : '',
    ]),
  ]);
}

function radio(variant: Variant): string {
  const on = variant.checked === 'true';
  const tile = variant.tile === 'true';
  return el('label', {
    ...FONT, display: 'flex', alignItems: 'flex-start', gap: '0.75rem', width: tile ? '360px' : undefined, boxSizing: 'border-box', flex: 'none',
    ...(tile ? { padding: '0.75rem 1rem 0.75rem 0.5rem', borderRadius: u('radius-md'), border: `2px solid ${on ? u('primary') : u('base-light')}`, background: on ? u('primary-lightest') : u('white') } : {}),
  }, [
    el('span', { width: '1.25rem', height: '1.25rem', margin: '2px', marginTop: '3px', borderRadius: '99rem', background: on ? u('primary') : u('white'), boxShadow: on ? `0 0 0 2px ${u('primary')}, inset 0 0 0 2px ${u('white')}` : `0 0 0 2px ${u('base-ink')}`, flex: 'none' }, [], { 'data-name': 'Circle', role: 'radio' }),
    el('span', { display: 'flex', flexDirection: 'column' }, [
      text('span', {}, 'Pay by bank transfer', 'Label'),
      tile ? text('span', { color: u('base-dark'), fontSize: '0.93rem' }, 'No fee. Takes two to three business days.', 'Description') : '',
    ]),
  ]);
}

function search(): string {
  return el('div', { ...FONT, display: 'flex', width: '420px' }, [
    el('div', { flex: '1', display: 'flex', alignItems: 'center', height: '2rem', padding: '0 0.5rem', boxSizing: 'border-box', background: u('white'), border: `1px solid ${u('base-dark')}`, borderRight: '0' }, text('span', { color: u('base') }, 'Search permits and fees', 'Placeholder'), { 'data-name': 'Input' }),
    el('button', { ...FONT, display: 'flex', alignItems: 'center', gap: '0.5rem', height: '2rem', padding: '0 1rem', border: '0', borderRadius: `0 ${u('radius-md')} ${u('radius-md')} 0`, background: u('primary'), color: u('white'), fontWeight: 700, lineHeight: '0.9' }, [icon(ICONS.search, 18), text('span', {}, 'Search', 'Button label')], { type: 'button', 'data-name': 'Button' }),
  ], { role: 'search' });
}

const ALERTS: Record<string, { bar: string; fill: string; icon: string; title: string; body: string }> = {
  info: { bar: 'info', fill: 'info-lighter', icon: ICONS.info, title: 'Office hours change on 1 July', body: 'The permit office opens at 9:00 on weekdays from 1 July.' },
  success: { bar: 'success', fill: 'success-lighter', icon: ICONS.circleCheck, title: 'Your permit is renewed', body: 'We sent the new permit to the email address on your account.' },
  warning: { bar: 'warning', fill: 'warning-lighter', icon: ICONS.triangleAlert, title: 'Your permit ends in 14 days', body: 'Renew it before 30 June to keep parking on your street.' },
  error: { bar: 'error', fill: 'error-lighter', icon: ICONS.alert, title: 'The payment did not go through', body: 'Your card was declined. Use another card or pay by bank transfer.' },
  emergency: { bar: 'emergency', fill: 'emergency', icon: ICONS.alert, title: 'Street closures for flooding', body: 'Parking permits do not apply on closed streets until the water goes down.' },
};

function alert(variant: Variant, slim = false): string {
  const a = ALERTS[variant.kind!]!;
  const dark = variant.kind === 'emergency';
  return el('div', { ...FONT, display: 'flex', gap: '0.75rem', width: '640px', padding: slim ? '0.5rem 1.25rem 0.5rem 0.75rem' : '1rem 1.25rem 1rem 0.75rem', boxSizing: 'border-box', borderLeft: `0.5rem solid ${u(a.bar)}`, background: u(a.fill), color: dark ? u('white') : u('base-ink') }, [
    el('span', { display: 'flex', paddingTop: slim ? '0.125rem' : '0', flex: 'none' }, icon(a.icon, slim ? 24 : 32), { 'data-name': 'Icon' }),
    el('div', { display: 'flex', flexDirection: 'column', gap: '0.5rem' }, [
      slim ? '' : text('h4', { margin: '0', fontSize: '1.46rem', lineHeight: '1.1', fontWeight: 700 }, a.title, 'Heading'),
      text('p', { margin: '0' }, a.body, 'Text'),
    ], { 'data-name': 'Body' }),
  ], { role: variant.kind === 'error' || dark ? 'alert' : 'status' });
}

function tag(variant: Variant): string {
  const big = variant.size === 'big';
  // USWDS's CSS sets tags in capitals; the drawing keeps the words as written.
  return el('span', { ...FONT, display: 'inline-flex', alignItems: 'center', fontSize: big ? '1.06rem' : '0.93rem', lineHeight: big ? '1.5' : '1.2', padding: big ? '0.125rem 0.5rem' : '1px 0.5rem', borderRadius: u('radius-sm'), background: u('base-dark'), color: u('white'), flex: 'none' }, text('span', {}, 'In review', 'Label'));
}

function card(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '360px', boxSizing: 'border-box', background: u('white'), border: `2px solid ${u('base-lighter')}`, borderRadius: u('radius-lg') }, [
    el('div', { padding: '1.5rem 1.5rem 0.5rem' }, text('h3', { margin: '0', fontFamily: u('font-serif'), fontSize: '1.34rem', lineHeight: '1.2', fontWeight: 700 }, 'Residential parking permit', 'Heading'), { 'data-name': 'Header' }),
    el('div', { display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.5rem 1.5rem' }, [
      text('p', { margin: '0' }, 'Park on your own street without a time limit. A permit costs $35 a year.', 'Body'),
      el('div', { display: 'flex', flexDirection: 'column', gap: '0.5rem' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
    ], { 'data-name': 'Card body' }),
    el('div', { padding: '0.5rem 1.5rem 1.5rem' },
      el('button', { ...FONT, display: 'inline-flex', alignItems: 'center', padding: '0.75rem 1.25rem', lineHeight: '0.9', fontWeight: 700, border: '0', borderRadius: u('radius-md'), background: u('primary'), color: u('white') }, text('span', {}, 'Apply for a permit', 'Action label'), { type: 'button' }), { 'data-name': 'Footer' }),
  ]);
}

function summaryBox(): string {
  const item = (label: string, name: string) => el('li', { margin: '0' }, text('span', { color: u('primary'), textDecoration: 'underline' }, label, name));
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '560px', padding: '1.5rem', boxSizing: 'border-box', background: u('info-lighter'), border: `1px solid ${u('info-light')}`, borderRadius: u('radius-md') }, [
    text('h4', { margin: '0', fontSize: '1.46rem', lineHeight: '1.1', fontWeight: 700 }, 'What you need to renew', 'Heading'),
    el('ul', { display: 'flex', flexDirection: 'column', gap: '0.25rem', margin: '0', paddingLeft: '2ch' }, [item('Your permit number', 'Item 1'), item('Proof that you live at the address', 'Item 2'), item('A card or bank account for the $35 fee', 'Item 3')], { 'data-name': 'List' }),
  ], { role: 'region' });
}

function table(): string {
  const cell = (tag: string, content: string, name: string, head = false) => text(tag, { padding: '0.5rem 1rem', border: `1px solid ${u('base-ink')}`, background: head ? u('base-lighter') : u('white'), textAlign: 'left', fontWeight: head ? 700 : 400, lineHeight: head ? '1.3' : '1.5' }, content, name);
  const rows = [['Residential parking', '$35', '1 year'], ['Visitor parking', '$12', '30 days'], ['Contractor parking', '$80', '6 months']];
  return el('table', { ...FONT, borderCollapse: 'collapse', borderSpacing: '0', width: '560px' }, [
    el('thead', {}, el('tr', {}, [cell('th', 'Permit', 'Head 1', true), cell('th', 'Fee', 'Head 2', true), cell('th', 'Valid for', 'Head 3', true)])),
    el('tbody', {}, rows.map((r, i) => el('tr', {}, r.map((v, j) => cell('td', v, `Row ${i + 1} cell ${j + 1}`)), { 'data-name': `Row ${i + 1}` }))),
  ]);
}

function breadcrumb(): string {
  const link = (label: string, name: string) => text('span', { color: u('primary'), textDecoration: 'underline' }, label, name);
  const sep = () => el('span', { display: 'flex', color: u('base') }, icon(ICONS.chevronRight, 16));
  return el('nav', { ...FONT, display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '1rem 0', lineHeight: '1.4', background: u('white') }, [
    link('Home', 'Link 1'), sep(), link('Permits', 'Link 2'), sep(), text('span', {}, 'Renew a parking permit', 'Current'),
  ], { 'aria-label': 'Breadcrumbs' });
}

function stepIndicator(): string {
  const steps: [string, 'complete' | 'current' | 'todo'][] = [['Your details', 'complete'], ['Address', 'current'], ['Payment', 'todo'], ['Review', 'todo']];
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '760px', lineHeight: '1.1', background: u('white') }, [
    el('ol', { display: 'flex', gap: '2px', margin: '0', padding: '0', listStyle: 'none' }, steps.map(([label, state], i) => el('li', { flex: '1', display: 'flex', flexDirection: 'column', gap: '1rem' }, [
      el('span', { height: '0.5rem', background: state === 'complete' ? u('primary-darker') : state === 'current' ? u('primary') : u('base-light') }, [], { 'data-name': `Step ${i + 1} bar` }),
      text('span', { paddingRight: '2rem', color: state === 'complete' ? u('primary-darker') : state === 'current' ? u('primary') : u('base-dark'), fontWeight: state === 'current' ? 700 : 400 }, label, `Step ${i + 1} label`),
    ], { 'data-name': `Step ${i + 1}` })), { 'data-name': 'Segments' }),
    el('div', { display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '2rem' }, [
      el('span', { width: '2.5rem', height: '2.5rem', borderRadius: '99rem', background: u('primary'), color: u('white'), display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flex: 'none' }, text('span', {}, '2', 'Current step')),
      text('span', { color: u('primary'), fontWeight: 700 }, 'of 4', 'Total steps'),
      text('h4', { margin: '0 0 0 0.5rem', fontSize: '1.46rem', fontWeight: 700 }, 'Address', 'Heading'),
    ], { 'data-name': 'Header' }),
  ], { 'aria-label': 'Progress' });
}

function pagination(): string {
  const page = (label: string, current: boolean, name: string) => el('span', { display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '2.5rem', height: '2.5rem', padding: '0.5rem', boxSizing: 'border-box', borderRadius: u('radius-md'), border: `1px solid ${current ? 'transparent' : u('base-light')}`, background: current ? u('base-ink') : 'transparent', color: current ? u('white') : u('primary') }, text('span', {}, label, `${name} label`), { 'data-name': name });
  const step = (label: string, ic: string, before: boolean, name: string) => el('span', { display: 'flex', alignItems: 'center', gap: '0.25rem', color: u('primary'), padding: '0 0.5rem' }, before ? [icon(ic, 20), text('span', { textDecoration: 'underline' }, label, `${name} label`)] : [text('span', { textDecoration: 'underline' }, label, `${name} label`), icon(ic, 20)], { 'data-name': name });
  return el('nav', { ...FONT, display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 'none' }, [
    step('Previous', ICONS.chevronLeft, true, 'Previous'), page('1', false, 'Page 1'), page('2', true, 'Page 2'), page('3', false, 'Page 3'), step('Next', ICONS.chevronRight, false, 'Next'),
  ], { 'aria-label': 'Pagination' });
}

function accordion(variant: Variant): string {
  const bordered = variant.style === 'bordered';
  const head = (label: string, open: boolean, name: string) => el('div', { display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1rem 1.25rem', background: u('base-lightest'), fontWeight: 700 }, [icon(open ? ICONS.minus : ICONS.plus, 24), text('span', {}, label, `${name} label`)], { 'data-name': name, role: 'button' });
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '640px' }, [
    head('Who needs a parking permit', true, 'Item 1'),
    text('div', { padding: '1rem 1.25rem 0.75rem', background: u('white'), ...(bordered ? { border: `0.25rem solid ${u('base-lightest')}`, borderTop: '0' } : {}) }, 'Anyone who parks on a permit street for more than two hours between 8:00 and 18:00.', 'Item 1 content'),
    head('How long a renewal takes', false, 'Item 2'),
    head('What to do if your car changes', false, 'Item 3'),
  ]);
}

const LABEL = { name: 'label', type: 'text' as const, target: 'Label' };
const cls = (prefix: string, values: string[]) => Object.fromEntries(values.map((x) => [x, `class="${prefix}--${x}"`]));
const BUTTON_AXES = { variant: ['default', 'secondary', 'accent-cool', 'base', 'outline', 'unstyled'], size: ['default', 'big'], state: ['default', 'focus'] };
const ALERT_KINDS = ['info', 'success', 'warning', 'error', 'emergency'];

const components: KitComponent[] = [
  {
    name: 'Button', group: 'Actions', description: 'A button: default, secondary, accent cool, base, outline or unstyled, in two sizes, and with the focus ring.',
    axes: BUTTON_AXES, members: eachAxis(BUTTON_AXES), props: [LABEL], html: button,
    handoff: { from: PKG, name: 'Button', element: 'button', props: { label: 'children', variant: '', size: '', state: '' }, flags: { variant: cls('usa-button', BUTTON_AXES.variant.slice(1)), size: { big: 'class="usa-button--big"' }, state: { focus: 'class="usa-focus"' } }, usage: '<button type="button" class="usa-button"{{attrs}}>{{children}}</button>' },
  },
  {
    name: 'Text input', group: 'Forms', description: 'A text input in its form group with a label and a hint, and the error state with its message. In code the error state also needs usa-form-group--error on the group and the usa-error-message line.', axes: { state: ['default', 'error'] },
    props: [LABEL, { name: 'hint', type: 'text', target: 'Hint' }], html: textInput,
    handoff: { from: PKG, name: 'TextInput', element: 'input', props: { label: '', hint: '', state: '' }, flags: { state: { error: 'class="usa-input--error"' } }, usage: '<div class="usa-form-group">\n  <label class="usa-label" for="permit-number">{{label}}</label>\n  <div class="usa-hint" id="permit-number-hint">{{hint}}</div>\n  <input class="usa-input" id="permit-number" name="permit-number" aria-describedby="permit-number-hint"{{attrs}} />\n</div>' },
  },
  {
    name: 'Select', group: 'Forms', description: 'A select with its label.', props: [LABEL], html: select,
    handoff: { from: PKG, name: 'Select', element: 'select', props: { label: '' }, usage: '<div class="usa-form-group">\n  <label class="usa-label" for="permit-type">{{label}}</label>\n  <select class="usa-select" id="permit-type" name="permit-type"{{attrs}}>\n    <option>Residential parking</option>\n    <option>Visitor parking</option>\n  </select>\n</div>' },
  },
  {
    name: 'Checkbox', group: 'Forms', description: 'A checkbox with its label, plain or as a tile with a description.', axes: { checked: ['false', 'true'], tile: ['false', 'true'] },
    props: [LABEL, { name: 'description', type: 'text', target: 'Description' }], html: checkbox,
    handoff: { from: PKG, name: 'Checkbox', element: 'input', props: { label: '', description: '', checked: '', tile: '' }, flags: { checked: { true: 'checked' }, tile: { true: 'class="usa-checkbox__input--tile"' } }, usage: '<div class="usa-checkbox">\n  <input class="usa-checkbox__input" id="reminder" type="checkbox" name="reminder"{{attrs}} />\n  <label class="usa-checkbox__label" for="reminder">{{label}}</label>\n</div>' },
  },
  {
    name: 'Radio', group: 'Forms', description: 'A radio button with its label, plain or as a tile with a description.', axes: { checked: ['false', 'true'], tile: ['false', 'true'] },
    props: [LABEL, { name: 'description', type: 'text', target: 'Description' }], html: radio,
    handoff: { from: PKG, name: 'Radio', element: 'input', props: { label: '', description: '', checked: '', tile: '' }, flags: { checked: { true: 'checked' }, tile: { true: 'class="usa-radio__input--tile"' } }, usage: '<div class="usa-radio">\n  <input class="usa-radio__input" id="bank-transfer" type="radio" name="payment" value="bank"{{attrs}} />\n  <label class="usa-radio__label" for="bank-transfer">{{label}}</label>\n</div>' },
  },
  {
    name: 'Search', group: 'Forms', description: 'A small search field with its button.', props: [{ name: 'placeholder', type: 'text', target: 'Placeholder' }], html: search,
    handoff: { from: PKG, name: 'Search', element: 'section', props: { placeholder: '' }, usage: '<section aria-label="Search permits"{{attrs}}>\n  <form class="usa-search usa-search--small" role="search">\n    <label class="usa-sr-only" for="search-field">Search</label>\n    <input class="usa-input" id="search-field" type="search" name="search" placeholder="{{placeholder}}" />\n    <button class="usa-button" type="submit">Search</button>\n  </form>\n</section>' },
  },
  {
    name: 'Alert', group: 'Feedback', description: 'A message with a heading: info, success, warning, error or emergency.', axes: { kind: ALERT_KINDS },
    props: [{ name: 'heading', type: 'text', target: 'Heading' }, { name: 'text', type: 'text', target: 'Text' }], html: (v) => alert(v),
    handoff: { from: PKG, name: 'Alert', element: 'div', props: { heading: '', text: '', kind: '' }, flags: { kind: cls('usa-alert', ALERT_KINDS) }, usage: '<div class="usa-alert"{{attrs}}>\n  <div class="usa-alert__body">\n    <h4 class="usa-alert__heading">{{heading}}</h4>\n    <p class="usa-alert__text">{{text}}</p>\n  </div>\n</div>' },
  },
  {
    name: 'Slim alert', group: 'Feedback', description: 'A one-line alert without a heading.', axes: { kind: ALERT_KINDS.slice(0, 4) },
    props: [{ name: 'text', type: 'text', target: 'Text' }], html: (v) => alert(v, true),
    handoff: { from: PKG, name: 'SlimAlert', element: 'div', props: { text: '', kind: '' }, flags: { kind: cls('usa-alert', ALERT_KINDS.slice(0, 4)) }, usage: '<div class="usa-alert usa-alert--slim"{{attrs}}>\n  <div class="usa-alert__body">\n    <p class="usa-alert__text">{{text}}</p>\n  </div>\n</div>' },
  },
  {
    name: 'Summary box', group: 'Feedback', description: 'The key points of a page, with links.', html: summaryBox,
    handoff: { from: PKG, name: 'SummaryBox', element: 'div', usage: '<div class="usa-summary-box" role="region" aria-labelledby="summary-heading"{{attrs}}>\n  <div class="usa-summary-box__body">\n    <h4 class="usa-summary-box__heading" id="summary-heading">What you need to renew</h4>\n    <div class="usa-summary-box__text">\n      <ul class="usa-list">\n        <li><a class="usa-summary-box__link" href="#permit-number">Your permit number</a></li>\n        <li><a class="usa-summary-box__link" href="#proof">Proof that you live at the address</a></li>\n        <li><a class="usa-summary-box__link" href="#payment">A card or bank account for the $35 fee</a></li>\n      </ul>\n    </div>\n  </div>\n</div>' },
  },
  {
    name: 'Tag', group: 'Content', description: 'A short status, in two sizes. USWDS\'s CSS sets tags in capitals; the drawing keeps the words as written.', axes: { size: ['default', 'big'] }, props: [LABEL], html: tag,
    handoff: { from: PKG, name: 'Tag', element: 'span', props: { label: 'children', size: '' }, flags: { size: { big: 'class="usa-tag--big"' } }, usage: '<span class="usa-tag"{{attrs}}>{{children}}</span>' },
  },
  {
    name: 'Card', group: 'Content', description: 'A card with a heading, text, a slot and an action.',
    props: [{ name: 'heading', type: 'text', target: 'Heading' }, { name: 'body', type: 'text', target: 'Body' }, { name: 'action', type: 'text', target: 'Action label' }], html: card,
    handoff: { from: PKG, name: 'Card', element: 'li', props: { heading: '', body: '', action: '' }, usage: '<li class="usa-card"{{attrs}}>\n  <div class="usa-card__container">\n    <div class="usa-card__header">\n      <h3 class="usa-card__heading">{{heading}}</h3>\n    </div>\n    <div class="usa-card__body">\n      <p>{{body}}</p>\n      {{children}}\n    </div>\n    <div class="usa-card__footer">\n      <a href="#apply" class="usa-button">{{action}}</a>\n    </div>\n  </div>\n</li>' },
  },
  {
    name: 'Table', group: 'Content', description: 'A bordered table with a header row.', html: table,
    handoff: { from: PKG, name: 'Table', element: 'table', usage: '<table class="usa-table"{{attrs}}>\n  <thead>\n    <tr><th scope="col">Permit</th><th scope="col">Fee</th><th scope="col">Valid for</th></tr>\n  </thead>\n  <tbody>\n    <tr><th scope="row">Residential parking</th><td>$35</td><td>1 year</td></tr>\n    <tr><th scope="row">Visitor parking</th><td>$12</td><td>30 days</td></tr>\n    <tr><th scope="row">Contractor parking</th><td>$80</td><td>6 months</td></tr>\n  </tbody>\n</table>' },
  },
  {
    name: 'Accordion', group: 'Content', description: 'Questions that open to their answer, borderless or bordered.', axes: { style: ['borderless', 'bordered'] }, html: accordion,
    handoff: { from: PKG, name: 'Accordion', element: 'div', props: { style: '' }, flags: { style: { bordered: 'class="usa-accordion--bordered"' } }, usage: '<div class="usa-accordion"{{attrs}}>\n  <h4 class="usa-accordion__heading">\n    <button type="button" class="usa-accordion__button" aria-expanded="true" aria-controls="a1">Who needs a parking permit</button>\n  </h4>\n  <div id="a1" class="usa-accordion__content usa-prose">\n    <p>Anyone who parks on a permit street for more than two hours between 8:00 and 18:00.</p>\n  </div>\n  <h4 class="usa-accordion__heading">\n    <button type="button" class="usa-accordion__button" aria-expanded="false" aria-controls="a2">How long a renewal takes</button>\n  </h4>\n  <div id="a2" class="usa-accordion__content usa-prose" hidden></div>\n</div>' },
  },
  {
    name: 'Breadcrumb', group: 'Navigation', description: 'Where a page sits, with links back up.', html: breadcrumb,
    handoff: { from: PKG, name: 'Breadcrumb', element: 'nav', usage: '<nav class="usa-breadcrumb" aria-label="Breadcrumbs"{{attrs}}>\n  <ol class="usa-breadcrumb__list">\n    <li class="usa-breadcrumb__list-item"><a href="/" class="usa-breadcrumb__link"><span>Home</span></a></li>\n    <li class="usa-breadcrumb__list-item"><a href="/permits" class="usa-breadcrumb__link"><span>Permits</span></a></li>\n    <li class="usa-breadcrumb__list-item usa-current" aria-current="page"><span>Renew a parking permit</span></li>\n  </ol>\n</nav>' },
  },
  {
    name: 'Step indicator', group: 'Navigation', description: 'The steps of a form, with the current one and its heading.', html: stepIndicator,
    handoff: { from: PKG, name: 'StepIndicator', element: 'div', usage: '<div class="usa-step-indicator" aria-label="Progress"{{attrs}}>\n  <ol class="usa-step-indicator__segments">\n    <li class="usa-step-indicator__segment usa-step-indicator__segment--complete"><span class="usa-step-indicator__segment-label">Your details</span></li>\n    <li class="usa-step-indicator__segment usa-step-indicator__segment--current" aria-current="true"><span class="usa-step-indicator__segment-label">Address</span></li>\n    <li class="usa-step-indicator__segment"><span class="usa-step-indicator__segment-label">Payment</span></li>\n    <li class="usa-step-indicator__segment"><span class="usa-step-indicator__segment-label">Review</span></li>\n  </ol>\n  <div class="usa-step-indicator__header">\n    <h4 class="usa-step-indicator__heading">\n      <span class="usa-step-indicator__heading-counter"><span class="usa-sr-only">Step</span><span class="usa-step-indicator__current-step">2</span> <span class="usa-step-indicator__total-steps">of 4</span></span>\n      <span class="usa-step-indicator__heading-text">Address</span>\n    </h4>\n  </div>\n</div>' },
  },
  {
    name: 'Pagination', group: 'Navigation', description: 'Pages of results, with the current page.', html: pagination,
    handoff: { from: PKG, name: 'Pagination', element: 'nav', usage: '<nav aria-label="Pagination" class="usa-pagination"{{attrs}}>\n  <ul class="usa-pagination__list">\n    <li class="usa-pagination__item usa-pagination__arrow"><a href="#" class="usa-pagination__link usa-pagination__previous-page" aria-label="Previous page"><span class="usa-pagination__link-text">Previous</span></a></li>\n    <li class="usa-pagination__item usa-pagination__page-no"><a href="#" class="usa-pagination__button" aria-label="Page 1">1</a></li>\n    <li class="usa-pagination__item usa-pagination__page-no"><a href="#" class="usa-pagination__button usa-current" aria-label="Page 2" aria-current="page">2</a></li>\n    <li class="usa-pagination__item usa-pagination__page-no"><a href="#" class="usa-pagination__button" aria-label="Page 3">3</a></li>\n    <li class="usa-pagination__item usa-pagination__arrow"><a href="#" class="usa-pagination__link usa-pagination__next-page" aria-label="Next page"><span class="usa-pagination__link-text">Next</span></a></li>\n  </ul>\n</nav>' },
  },
];

const color = (name: string, light: string, role?: KitToken['role']): KitToken => ({ name: `usa-${name}`, kind: 'color', light, ...(role ? { role } : {}) });

/** The default theme of USWDS 3.14.0, as dist/css/uswds.css writes it. USWDS has no dark theme. */
export const uswdsKit: Kit = {
  id: 'uswds',
  name: 'USWDS',
  description: 'The U.S. Web Design System\'s components with its default theme: forms, alerts, steps and tables built for accessible public services. Bogen\'s own drawing, not a government service; no banner, flag or seal. Code is markup with USWDS classes for a project that loads its CSS and JavaScript.',
  platform: 'web',
  library: { name: 'U.S. Web Design System', package: '@uswds/uswds', license: 'CC0-1.0', url: 'https://designsystem.digital.gov' },
  font: '"Public Sans", "Source Sans Pro", Helvetica, Arial, sans-serif',
  version: 1,
  tokens: [
    color('white', '#ffffff', 'background'),
    color('base-ink', '#1b1b1b', 'foreground'),
    color('base-lightest', '#f0f0f0', 'surface'),
    color('base-lighter', '#dfe1e2'),
    color('base-light', '#a9aeb1', 'border'),
    color('base', '#71767a', 'muted'),
    color('base-dark', '#565c65'),
    color('primary', '#005ea2', 'primary'),
    color('primary-dark', '#1a4480'),
    color('primary-darker', '#162e51'),
    color('primary-lightest', 'rgba(0, 94, 162, 0.1)'),
    color('secondary', '#d83933', 'secondary'),
    color('accent-cool', '#00bde3', 'accent'),
    color('info', '#00bde3'),
    color('info-light', '#99deea'),
    color('info-lighter', '#e7f6f8'),
    color('success', '#00a91c'),
    color('success-lighter', '#ecf3ec'),
    color('warning', '#ffbe2e'),
    color('warning-lighter', '#faf3d1'),
    color('error', '#d54309'),
    color('error-dark', '#b50909', 'danger'),
    color('error-lighter', '#f4e3db'),
    color('emergency', '#9c3d10'),
    color('focus', '#2491ff'),
    { name: 'usa-radius-sm', kind: 'radius', light: '2px' },
    { name: 'usa-radius-md', kind: 'radius', light: '0.25rem', role: 'radius' },
    { name: 'usa-radius-lg', kind: 'radius', light: '0.5rem' },
    { name: 'usa-font-sans', kind: 'font-family', light: '"Public Sans", "Source Sans Pro", Helvetica, Arial, sans-serif', role: 'font' },
    { name: 'usa-font-serif', kind: 'font-family', light: 'Merriweather, Georgia, Cambria, "Times New Roman", serif' },
  ],
  components,
};
