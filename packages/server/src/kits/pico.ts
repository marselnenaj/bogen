import { el, icon, ICONS, text, type Css } from './markup.ts';
import type { Kit, KitComponent, KitProp, KitToken, Variant } from './types.ts';

/**
 * Pico CSS 2 (MIT, Lucas Larroche and the Pico contributors), the minimal stylesheet for semantic HTML: its `pico-*`
 * variables from the default azure theme in light and dark (css/pico.css of @picocss/pico 2.1.1, with the values
 * other variables point at written out), its 1rem spacing, form elements of 0.75rem by 1rem padding and its 0.25rem
 * radius. Bogen's own drawing from the public docs. Code handoff is the plain HTML Pico styles, with the few classes
 * it has (`secondary`, `contrast`, `outline`, `striped`, `dropdown`) and its ARIA states, which works the same in
 * React, Vue, Svelte and HTML. Each usage imports Pico's stylesheet, as a bundler takes it.
 */
const v = (name: string) => `var(--pico-${name})`;
const PKG = '@picocss/pico';
const SIDE = ['@picocss/pico/css/pico.min.css'];
const FONT = { fontFamily: v('font-family'), fontSize: '16px', lineHeight: '24px', fontWeight: 400, color: v('color') } as const;
/** A form element or a button: 0.75rem by 1rem of padding around a 1.5 line, with a 1px border, so 50px tall. */
const FIELD: Css = { ...FONT, display: 'flex', alignItems: 'center', gap: '8px', padding: `${v('form-element-spacing-vertical')} ${v('form-element-spacing-horizontal')}`, borderRadius: v('border-radius'), boxSizing: 'border-box' };
const INPUT: Css = { ...FIELD, width: '360px', background: v('form-element-background-color'), border: `1px solid ${v('form-element-border-color')}`, color: v('form-element-color') };
/** Pico's box shadow, the first, fourth and sixth of its seven layers: soft and grey. */
const SHADOW = '0.0145rem 0.029rem 0.174rem rgba(129, 145, 181, 0.017), 0.1125rem 0.225rem 1.35rem rgba(129, 145, 181, 0.036), 0.5rem 1rem 6rem rgba(129, 145, 181, 0.06), 0 0 0 0.0625rem rgba(129, 145, 181, 0.015)';
const TEXT = (name: string, target: string): KitProp => ({ name, type: 'text', target });

const LOOK: Record<string, { fill: string; text: string; on: string }> = {
  primary: { fill: v('primary-background'), text: v('primary'), on: v('primary-inverse') },
  secondary: { fill: v('secondary-background'), text: v('secondary'), on: v('secondary-inverse') },
  contrast: { fill: v('contrast-background'), text: v('contrast'), on: v('contrast-inverse') },
};

function buttonLook(variant: string, outline: boolean): Css {
  const l = LOOK[variant]!;
  return outline ? { background: 'transparent', border: `1px solid ${l.fill}`, color: l.text } : { background: l.fill, border: `1px solid ${l.fill}`, color: l.on };
}

function button(variant: Variant): string {
  return el('button', { ...FIELD, justifyContent: 'center', flex: 'none', ...buttonLook(variant.variant!, variant.style === 'outline') }, text('span', {}, 'Save changes', 'Label'), { type: 'button' });
}

function loadingButton(): string {
  return el('button', { ...FIELD, justifyContent: 'center', flex: 'none', ...buttonLook('primary', false) }, [
    el('span', { width: '16px', height: '16px', boxSizing: 'border-box', borderRadius: '999px', border: `2px solid ${v('primary-inverse')}`, borderRightColor: 'transparent', opacity: 0.6, flex: 'none' }, [], { 'data-name': 'Spinner' }),
    text('span', {}, 'Saving', 'Label'),
  ], { type: 'button', 'aria-busy': 'true' });
}

function group(): string {
  return el('fieldset', { ...FONT, display: 'flex', width: '480px', margin: '0', padding: '0', border: '0' }, [
    el('div', { ...INPUT, width: 'auto', flex: '1', borderRadius: `${v('border-radius')} 0 0 ${v('border-radius')}` }, text('span', { color: v('form-element-placeholder-color') }, 'you@example.com', 'Placeholder'), { 'data-name': 'Input' }),
    el('button', { ...FIELD, flex: 'none', borderRadius: `0 ${v('border-radius')} ${v('border-radius')} 0`, ...buttonLook('primary', false) }, text('span', {}, 'Subscribe', 'Action label'), { type: 'button' }),
  ], { role: 'group' });
}

function label(content: string[], name: string): string {
  return el('label', { ...FONT, display: 'flex', flexDirection: 'column', gap: '6px', width: '360px' }, content, { 'data-name': name });
}

function input(variant: Variant): string {
  const state = variant.state!;
  const border = state === 'invalid' ? v('form-element-invalid-border-color') : state === 'valid' ? v('form-element-valid-border-color') : v('form-element-border-color');
  const hint = 'Use the address you sign in with.';
  const mark = state === 'invalid' ? el('span', { display: 'flex', color: v('del-color') }, icon(ICONS.alert, 20), { 'data-name': 'State icon' }) : state === 'valid' ? el('span', { display: 'flex', color: v('ins-color') }, icon(ICONS.check, 20), { 'data-name': 'State icon' }) : '';
  return label([
    text('span', {}, 'Email', 'Label'),
    el('div', { ...INPUT, justifyContent: 'space-between', border: `1px solid ${border}` }, [text('span', { color: v('form-element-placeholder-color') }, 'you@example.com', 'Placeholder'), mark], { 'data-name': 'Input' }),
    text('small', { fontSize: '14px', lineHeight: '21px', color: state === 'invalid' ? v('del-color') : state === 'valid' ? v('ins-color') : v('muted-color') }, hint, 'Hint'),
  ], 'Input field');
}

function search(): string {
  return el('div', { ...INPUT, borderRadius: '5rem', color: v('form-element-placeholder-color') }, [icon(ICONS.search, 18), text('span', {}, 'Search orders', 'Placeholder')], { role: 'search' });
}

function select(): string {
  return label([
    text('span', {}, 'Plan', 'Label'),
    el('div', { ...INPUT, justifyContent: 'space-between' }, [text('span', {}, 'Monthly', 'Value'), el('span', { display: 'flex', color: v('muted-color') }, icon(ICONS.chevronDown, 20))], { 'data-name': 'Select' }),
  ], 'Select field');
}

function checkbox(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('label', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '8px', flex: 'none' }, [
    el('span', { width: '20px', height: '20px', boxSizing: 'border-box', borderRadius: v('border-radius'), border: `1px solid ${on ? v('primary-background') : v('form-element-border-color')}`, background: on ? v('primary-background') : v('form-element-background-color'), color: v('primary-inverse'), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, on ? icon(ICONS.check, 14, 'Check', 4) : '', { 'data-name': 'Box', role: 'checkbox' }),
    text('span', {}, 'I agree to the terms', 'Label'),
  ]);
}

function toggle(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('label', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '8px', flex: 'none' }, [
    el('span', { width: '36px', height: '20px', boxSizing: 'border-box', padding: '2px', borderRadius: '20px', background: on ? v('primary-background') : v('switch-background-color'), display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start', flex: 'none' },
      el('span', { width: '16px', height: '16px', borderRadius: '999px', background: v('switch-color') }, [], { 'data-name': 'Thumb' }), { 'data-name': 'Track', role: 'switch' }),
    text('span', {}, 'Publish on save', 'Label'),
  ]);
}

function radio(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('label', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '8px', flex: 'none' }, [
    el('span', { width: '20px', height: '20px', boxSizing: 'border-box', borderRadius: '999px', border: on ? `6px solid ${v('primary-background')}` : `1px solid ${v('form-element-border-color')}`, background: on ? v('primary-inverse') : v('form-element-background-color'), flex: 'none' }, [], { 'data-name': 'Circle', role: 'radio' }),
    text('span', {}, 'Standard delivery', 'Label'),
  ]);
}

function card(): string {
  const section: Css = { padding: v('spacing'), background: v('card-sectioning-background-color') };
  return el('article', { ...FONT, display: 'flex', flexDirection: 'column', width: '400px', borderRadius: v('border-radius'), overflow: 'hidden', background: v('card-background-color'), boxShadow: SHADOW }, [
    text('header', { ...section, fontWeight: 600, borderBottom: `1px solid ${v('card-border-color')}` }, 'Team plan', 'Title'),
    el('div', { display: 'flex', flexDirection: 'column', gap: '8px', padding: v('spacing') }, [
      text('p', { margin: '0' }, 'Five seats, shared projects and one invoice a month.', 'Body'),
      el('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
    ], { 'data-name': 'Card body' }),
    text('footer', { ...section, color: v('muted-color'), borderTop: `1px solid ${v('card-border-color')}` }, 'Renews on 1 December', 'Footer'),
  ]);
}

function accordion(variant: Variant): string {
  const open = variant.open === 'true';
  return el('details', { ...FONT, display: 'flex', flexDirection: 'column', gap: v('spacing'), width: '480px', paddingBottom: v('spacing'), borderBottom: `1px solid ${v('accordion-border-color')}` }, [
    el('summary', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: open ? v('accordion-open-summary-color') : v('color') }, [
      text('span', {}, 'Changing plans later', 'Title'),
      el('span', { display: 'flex', color: v('muted-color') }, icon(open ? ICONS.chevronDown : ICONS.chevronRight, 20), { 'data-name': 'Chevron' }),
    ], { 'data-name': 'Summary' }),
    open ? text('p', { margin: '0' }, 'Yes. A change takes effect on your next invoice, and unused days are credited.', 'Body') : '',
  ]);
}

function table(variant: Variant): string {
  const striped = variant.style === 'striped';
  const rows = [['1042', 'Paid', '120.00'], ['1043', 'Open', '86.50'], ['1044', 'Paid', '42.00']];
  const cell = (value: string, head: boolean, right: boolean, name: string) => text(head ? 'th' : 'td', { padding: `calc(${v('spacing')} / 2) ${v('spacing')}`, textAlign: right ? 'right' : 'left', fontWeight: head ? 600 : 400, borderBottom: `1px solid ${v('table-border-color')}` }, value, name);
  const row = (cells: string[], head: boolean, i: number) => el('tr', { background: striped && !head && i % 2 === 0 ? v('table-row-stripped-background-color') : undefined }, cells.map((x, j) => cell(x, head, j === 2, `${head ? 'Head' : `Row ${i + 1}`} ${j + 1}`)), { 'data-name': head ? 'Head' : `Row ${i + 1}` });
  return el('table', { ...FONT, width: '480px', borderCollapse: 'collapse', borderSpacing: '0' }, [
    el('thead', {}, row(['Invoice', 'Status', 'Amount'], true, 0)),
    el('tbody', {}, rows.map((r, i) => row(r, false, i))),
  ]);
}

function blockquote(): string {
  return el('blockquote', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', width: '480px', margin: '0', padding: v('spacing'), borderLeft: `0.25rem solid ${v('blockquote-border-color')}` }, [
    text('p', { margin: '0', fontStyle: 'italic' }, 'Simplicity is prerequisite for reliability.', 'Quote'),
    text('footer', { color: v('muted-color') }, 'Edsger W. Dijkstra', 'Source'),
  ]);
}

function progress(variant: Variant): string {
  return el('div', { width: '360px', height: '8px', borderRadius: v('border-radius'), background: v('progress-background-color'), overflow: 'hidden', flex: 'none' }, el('div', { width: `${variant.value}%`, height: '100%', background: v('primary-background') }, [], { 'data-name': 'Value' }), { role: 'progressbar' });
}

function nav(): string {
  const link = (label: string, name: string) => text('a', { padding: '8px', color: v('primary'), textDecoration: 'none' }, label, name);
  return el('nav', { ...FONT, display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '720px', padding: '8px 0' }, [
    text('strong', { fontWeight: 700, padding: '8px' }, 'Northwind', 'Brand'),
    el('div', { display: 'flex', alignItems: 'center', gap: '8px' }, [
      link('Pricing', 'Link 1'), link('Docs', 'Link 2'),
      el('a', { ...FIELD, padding: '8px 16px', textDecoration: 'none', ...buttonLook('primary', false) }, text('span', {}, 'Sign in', 'Action label'), { role: 'button' }),
    ], { 'data-name': 'Links' }),
  ]);
}

function dropdown(variant: Variant): string {
  const open = variant.open === 'true';
  const item = (label: string, name: string, hover = false) => text('li', { padding: `calc(${v('form-element-spacing-vertical)')} / 2) ${v('form-element-spacing-horizontal')}`, background: hover ? v('dropdown-hover-background-color') : 'transparent' }, label, name);
  return el('details', { ...FONT, display: 'flex', flexDirection: 'column', gap: '4px', width: '280px' }, [
    el('summary', { ...INPUT, width: '100%', justifyContent: 'space-between' }, [text('span', {}, 'Sort by', 'Label'), el('span', { display: 'flex', color: v('muted-color') }, icon(ICONS.chevronDown, 20))], { 'data-name': 'Summary' }),
    open ? el('ul', { display: 'flex', flexDirection: 'column', margin: '0', padding: '8px 0', listStyle: 'none', borderRadius: v('border-radius'), border: `1px solid ${v('dropdown-border-color')}`, background: v('dropdown-background-color'), boxShadow: SHADOW }, [item('Newest', 'Item 1', true), item('Oldest', 'Item 2'), item('Price', 'Item 3')], { 'data-name': 'Menu' }) : '',
  ], { 'data-name': 'Dropdown' });
}

function modal(): string {
  const section: Css = { display: 'flex', alignItems: 'center', padding: v('spacing'), background: v('card-sectioning-background-color') };
  return el('article', { ...FONT, display: 'flex', flexDirection: 'column', width: '510px', borderRadius: v('border-radius'), overflow: 'hidden', background: v('card-background-color'), boxShadow: SHADOW }, [
    el('header', { ...section, justifyContent: 'space-between', borderBottom: `1px solid ${v('card-border-color')}` }, [
      text('strong', { fontWeight: 700 }, 'Delete this project', 'Title'),
      el('span', { display: 'flex', color: v('muted-color') }, icon(ICONS.x, 20), { 'data-name': 'Close', 'aria-label': 'Close' }),
    ]),
    text('p', { margin: '0', padding: v('spacing') }, 'Its pages and comments go with it. This cannot be undone.', 'Body'),
    el('footer', { ...section, justifyContent: 'flex-end', gap: '8px', borderTop: `1px solid ${v('card-border-color')}` }, [
      el('button', { ...FIELD, ...buttonLook('secondary', false) }, text('span', {}, 'Cancel', 'Cancel label'), { type: 'button' }),
      el('button', { ...FIELD, ...buttonLook('primary', false) }, text('span', {}, 'Delete', 'Confirm label'), { type: 'button' }),
    ], { 'data-name': 'Actions' }),
  ], { role: 'dialog' });
}

function tooltip(): string {
  return el('span', { ...FONT, display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '0', flex: 'none' }, [
    text('span', { padding: '4px 8px', borderRadius: v('border-radius'), background: v('contrast-background'), color: v('contrast-inverse'), fontSize: '14px', lineHeight: '21px' }, 'Sent to your email', 'Tip'),
    el('span', { width: '0', height: '0', borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: `6px solid ${v('contrast-background')}`, marginBottom: '6px' }, [], { 'data-name': 'Arrow' }),
    text('span', { borderBottom: `1px dotted ${v('color')}` }, 'Receipt', 'Label'),
  ]);
}

const LABEL = TEXT('label', 'Label');
const h = (name: string, element: string, rest: Omit<KitComponent['handoff'], 'from' | 'name' | 'element' | 'side'> = {}): KitComponent['handoff'] => ({ from: PKG, name, element, side: SIDE, ...rest });

const components: KitComponent[] = [
  {
    name: 'Button', group: 'Actions', description: 'A button in primary, secondary or contrast, filled or outlined.', axes: { variant: ['primary', 'secondary', 'contrast'], style: ['solid', 'outline'] }, props: [LABEL], html: button,
    handoff: h('Button', 'button', { props: { label: 'children', variant: '', style: '' }, flags: { variant: { secondary: 'class="secondary"', contrast: 'class="contrast"' }, style: { outline: 'class="outline"' } } }),
  },
  {
    name: 'Loading button', group: 'Actions', description: 'A button that is busy, with its spinner.', props: [LABEL], html: loadingButton,
    handoff: h('LoadingButton', 'button', { props: { label: 'children' }, usage: '<button aria-busy="true"{{attrs}}>{{label}}</button>' }),
  },
  {
    name: 'Group', group: 'Actions', description: 'An input and a button joined as one control.', props: [TEXT('placeholder', 'Placeholder'), TEXT('action', 'Action label')], html: group,
    handoff: h('Group', 'fieldset', { props: { placeholder: '', action: '' }, usage: '<fieldset role="group"{{attrs}}>\n  <input type="email" name="email" placeholder="{{placeholder}}" />\n  <input type="submit" value="{{action}}" />\n</fieldset>' }),
  },
  {
    name: 'Input', group: 'Forms', description: 'A labelled input with its helper text, and its invalid and valid states.', axes: { state: ['default', 'invalid', 'valid'] }, props: [LABEL, TEXT('placeholder', 'Placeholder'), TEXT('hint', 'Hint')], html: input,
    handoff: h('Input', 'label', { props: { label: '', placeholder: '', hint: '', state: '' }, flags: { state: { invalid: 'aria-invalid="true"', valid: 'aria-invalid="false"' } }, usage: '<label>\n  {{label}}\n  <input type="email" name="email" placeholder="{{placeholder}}" aria-describedby="email-helper"{{attrs}} />\n  <small id="email-helper">{{hint}}</small>\n</label>' }),
  },
  {
    name: 'Search', group: 'Forms', description: 'A rounded search field.', props: [TEXT('placeholder', 'Placeholder')], html: search,
    handoff: h('Search', 'input', { props: { placeholder: '' }, usage: '<input type="search" name="search" placeholder="{{placeholder}}" aria-label="Search"{{attrs}} />' }),
  },
  {
    name: 'Select', group: 'Forms', description: 'A labelled select.', props: [LABEL], html: select,
    handoff: h('Select', 'label', { props: { label: '' }, usage: '<label>\n  {{label}}\n  <select name="plan"{{attrs}}>\n    <option>Monthly</option>\n    <option>Yearly</option>\n  </select>\n</label>' }),
  },
  {
    name: 'Checkbox', group: 'Forms', description: 'A checkbox with its label.', axes: { checked: ['false', 'true'] }, props: [LABEL], html: checkbox,
    handoff: h('Checkbox', 'label', { props: { label: '', checked: '' }, flags: { checked: { true: 'checked' } }, usage: '<label>\n  <input type="checkbox" name="terms"{{attrs}} />\n  {{label}}\n</label>' }),
  },
  {
    name: 'Switch', group: 'Forms', description: 'A checkbox drawn as a switch.', axes: { checked: ['false', 'true'] }, props: [LABEL], html: toggle,
    handoff: h('Switch', 'label', { props: { label: '', checked: '' }, flags: { checked: { true: 'checked' } }, usage: '<label>\n  <input type="checkbox" name="publish" role="switch"{{attrs}} />\n  {{label}}\n</label>' }),
  },
  {
    name: 'Radio', group: 'Forms', description: 'A radio button with its label.', axes: { checked: ['false', 'true'] }, props: [LABEL], html: radio,
    handoff: h('Radio', 'label', { props: { label: '', checked: '' }, flags: { checked: { true: 'checked' } }, usage: '<label>\n  <input type="radio" name="delivery"{{attrs}} />\n  {{label}}\n</label>' }),
  },
  {
    name: 'Card', group: 'Content', description: 'An article with a header, a body with a slot, and a footer.', props: [TEXT('title', 'Title'), TEXT('body', 'Body'), TEXT('footer', 'Footer')], html: card,
    handoff: h('Card', 'article', { props: { title: '', body: '', footer: '' }, usage: '<article{{attrs}}>\n  <header>{{title}}</header>\n  <p>{{body}}</p>\n  {{children}}\n  <footer>{{footer}}</footer>\n</article>' }),
  },
  {
    name: 'Accordion', group: 'Content', description: 'A details element that opens to show its text.', axes: { open: ['false', 'true'] }, props: [TEXT('title', 'Title'), TEXT('body', 'Body')], html: accordion,
    handoff: h('Accordion', 'details', { props: { title: '', body: '', open: '' }, flags: { open: { true: 'open' } }, usage: '<details{{attrs}}>\n  <summary>{{title}}</summary>\n  <p>{{body}}</p>\n</details>' }),
  },
  {
    name: 'Table', group: 'Content', description: 'A table with a header row, plain or striped.', axes: { style: ['plain', 'striped'] }, html: table,
    handoff: h('Table', 'table', { props: { style: '' }, flags: { style: { striped: 'class="striped"' } }, usage: '<table{{attrs}}>\n  <thead>\n    <tr><th scope="col">Invoice</th><th scope="col">Status</th><th scope="col">Amount</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>1042</td><td>Paid</td><td>120.00</td></tr>\n    <tr><td>1043</td><td>Open</td><td>86.50</td></tr>\n    <tr><td>1044</td><td>Paid</td><td>42.00</td></tr>\n  </tbody>\n</table>' }),
  },
  {
    name: 'Blockquote', group: 'Content', description: 'A quotation with its source.', props: [TEXT('quote', 'Quote'), TEXT('source', 'Source')], html: blockquote,
    handoff: h('Blockquote', 'blockquote', { props: { quote: '', source: '' }, usage: '<blockquote{{attrs}}>\n  {{quote}}\n  <footer><cite>{{source}}</cite></footer>\n</blockquote>' }),
  },
  {
    name: 'Progress', group: 'Feedback', description: 'A progress bar.', axes: { value: ['60', '25', '100'] }, html: progress,
    handoff: h('Progress', 'progress', { props: { value: '' }, flags: { value: { 60: 'value="60"', 25: 'value="25"', 100: 'value="100"' } }, usage: '<progress max="100"{{attrs}}></progress>' }),
  },
  {
    name: 'Tooltip', group: 'Feedback', description: 'A word with a tooltip over it.', props: [LABEL, TEXT('tip', 'Tip')], html: tooltip,
    handoff: h('Tooltip', 'span', { props: { label: '', tip: '' }, usage: '<span data-tooltip="{{tip}}"{{attrs}}>{{label}}</span>' }),
  },
  {
    name: 'Nav', group: 'Navigation', description: 'A bar with the product name, links and a link drawn as a button.', html: nav,
    handoff: h('Nav', 'nav', { usage: '<nav{{attrs}}>\n  <ul>\n    <li><strong>Northwind</strong></li>\n  </ul>\n  <ul>\n    <li><a href="#">Pricing</a></li>\n    <li><a href="#">Docs</a></li>\n    <li><a href="#" role="button">Sign in</a></li>\n  </ul>\n</nav>' }),
  },
  {
    name: 'Dropdown', group: 'Navigation', description: 'A details element as a menu, closed and open.', axes: { open: ['false', 'true'] }, props: [LABEL], html: dropdown,
    handoff: h('Dropdown', 'details', { props: { label: '', open: '' }, flags: { open: { true: 'open' } }, usage: '<details class="dropdown"{{attrs}}>\n  <summary>{{label}}</summary>\n  <ul>\n    <li><a href="#">Newest</a></li>\n    <li><a href="#">Oldest</a></li>\n    <li><a href="#">Price</a></li>\n  </ul>\n</details>' }),
  },
  {
    name: 'Modal', group: 'Overlays', description: 'A dialog with a header, a message and two actions.', props: [TEXT('title', 'Title'), TEXT('body', 'Body')], html: modal,
    handoff: h('Modal', 'dialog', { props: { title: '', body: '' }, usage: '<dialog open{{attrs}}>\n  <article>\n    <header>\n      <button aria-label="Close" class="close"></button>\n      <p><strong>{{title}}</strong></p>\n    </header>\n    <p>{{body}}</p>\n    <footer>\n      <button class="secondary">Cancel</button>\n      <button>Delete</button>\n    </footer>\n  </article>\n</dialog>' }),
  },
];

const color = (name: string, light: string, dark: string, role?: KitToken['role']): KitToken => ({ name: `pico-${name}`, kind: 'color', light, dark, ...(role ? { role } : {}) });

/** The default azure theme of @picocss/pico 2.1.1 (css/pico.css), light and dark. */
export const picoKit: Kit = {
  id: 'pico',
  name: 'Pico CSS',
  description: 'Pico CSS styles plain semantic HTML: buttons, forms, articles, details and dialogs, with the colours of its default theme in light and dark. Code is the HTML itself, for any framework, with Pico\'s stylesheet imported.',
  platform: 'web',
  library: { name: 'Pico CSS', package: PKG, license: 'MIT', url: 'https://picocss.com' },
  font: 'system-ui, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, Helvetica, Arial, "Helvetica Neue", sans-serif',
  version: 1,
  tokens: [
    color('background-color', '#fff', 'rgb(19, 22.5, 30.5)', 'background'),
    color('color', '#373c44', '#c2c7d0', 'foreground'),
    color('muted-color', '#646b79', '#7b8495', 'muted'),
    color('muted-border-color', 'rgb(231, 234, 239.5)', '#202632', 'border'),
    color('primary-background', '#0172ad', '#0172ad', 'primary'),
    color('primary', '#0172ad', '#01aaff', 'primary'),
    color('primary-hover-background', '#02659a', '#017fc0'),
    color('primary-inverse', '#fff', '#fff', 'on-primary'),
    color('secondary-background', '#525f7a', '#525f7a', 'secondary'),
    color('secondary', '#5d6b89', '#969eaf'),
    color('secondary-inverse', '#fff', '#fff'),
    color('contrast-background', '#181c25', '#eff1f4'),
    color('contrast', '#181c25', '#dfe3eb'),
    color('contrast-inverse', '#fff', '#000'),
    color('ins-color', 'rgb(28.5, 105.5, 84)', '#62af9a'),
    color('del-color', 'rgb(136, 56.5, 53)', 'rgb(205.5, 126, 123)', 'danger'),
    color('form-element-background-color', 'rgb(251, 251.5, 252.25)', 'rgb(28, 33, 43.5)'),
    color('form-element-border-color', '#cfd5e2', '#2a3140'),
    color('form-element-color', '#23262c', '#e0e3e7'),
    color('form-element-placeholder-color', '#646b79', '#8891a4'),
    color('form-element-invalid-border-color', 'rgb(183.5, 105.5, 106.5)', 'rgb(149.5, 74, 80)'),
    color('form-element-valid-border-color', 'rgb(76, 154.5, 137.5)', '#2a7b6f'),
    color('switch-background-color', '#bfc7d9', '#333c4e'),
    color('switch-color', '#fff', '#fff'),
    color('card-background-color', '#fff', '#181c25', 'surface'),
    color('card-border-color', 'rgb(231, 234, 239.5)', '#181c25'),
    color('card-sectioning-background-color', 'rgb(251, 251.5, 252.25)', 'rgb(26, 30.5, 40.25)'),
    color('accordion-border-color', 'rgb(231, 234, 239.5)', '#202632'),
    color('accordion-open-summary-color', '#646b79', '#7b8495'),
    color('dropdown-background-color', '#fff', '#181c25'),
    color('dropdown-border-color', '#eff1f4', '#202632'),
    color('dropdown-hover-background-color', '#eff1f4', '#202632'),
    color('table-border-color', 'rgb(231, 234, 239.5)', '#202632'),
    color('table-row-stripped-background-color', 'rgba(111, 120, 135, 0.0375)', 'rgba(111, 120, 135, 0.0375)'),
    color('blockquote-border-color', 'rgb(231, 234, 239.5)', '#202632'),
    color('progress-background-color', '#dfe3eb', '#202632'),
    { name: 'pico-border-radius', kind: 'radius', light: '0.25rem', role: 'radius' },
    { name: 'pico-spacing', kind: 'spacing', light: '1rem' },
    { name: 'pico-form-element-spacing-vertical', kind: 'spacing', light: '0.75rem' },
    { name: 'pico-form-element-spacing-horizontal', kind: 'spacing', light: '1rem' },
    { name: 'pico-font-family', kind: 'font-family', light: 'system-ui, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, Helvetica, Arial, "Helvetica Neue", sans-serif', role: 'font' },
  ],
  components,
};
