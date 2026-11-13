import { eachAxis, el, icon, ICONS, text, type Css } from './markup.ts';
import type { Kit, KitComponent, KitProp, KitToken, Variant } from './types.ts';

/**
 * Web Awesome 3 (MIT, Fonticons, Inc.), web components built with Lit: the free core only. Web Awesome Pro and its
 * themes, and Font Awesome's icons and logos, are not used. Tokens are the `--wa-*` variables of the default theme
 * in @awesome.me/webawesome 3.14.0 (dist/styles/themes/default.css, with the colours of its default palette resolved),
 * in light and in `.wa-dark`. Bogen's own drawing from the components' styles; icons are Lucide. Code handoff is
 * markup with Web Awesome's custom elements in their own attributes (`<wa-button variant="brand">`), which works the
 * same in React 19, Vue, Svelte and plain HTML, and imports the script that defines each element and the theme.
 */
const v = (name: string) => `var(--wa-${name})`;
const c = (name: string) => v(`color-${name}`);
const PKG = '@awesome.me/webawesome';
const THEME = `${PKG}/dist/styles/webawesome.css`;
const side = (...names: string[]) => [THEME, ...names.map((n) => `${PKG}/dist/components/${n}/${n}.js`)];
const FONT = { fontFamily: v('font-family-body'), fontSize: '16px', lineHeight: '1.2', color: c('text-normal') } as const;
const VARIANTS = ['neutral', 'brand', 'success', 'warning', 'danger'];
/** Button sizes: the font size, and the height Web Awesome derives from it (2 x 0.75em padding plus 1.2em). */
const SIZES: Record<string, { fontSize: string; height: string }> = { m: { fontSize: '16px', height: '43px' }, s: { fontSize: '14px', height: '38px' }, l: { fontSize: '20px', height: '54px' } };
const SHADOW_S = '0 2px 2px -1px rgb(16 18 25 / 12%)';
const SHADOW_L = '0 8px 8px -4px rgb(16 18 25 / 12%)';
const TEXT = (name: string, target: string): KitProp => ({ name, type: 'text', target });

/** The colours an appearance gives a control of a variant: Web Awesome's fill, border and on- roles. */
function appearanceLook(variant: string, appearance: string, border = true): Css {
  const r = (part: string) => c(`${variant}-${part}`);
  if (appearance === 'filled') return { background: r('fill-normal'), color: r('on-normal'), border: '1px solid transparent' };
  if (appearance === 'outlined') return { background: 'transparent', color: r('on-quiet'), border: `1px solid ${r('border-loud')}` };
  if (appearance === 'filled-outlined') return { background: r('fill-normal'), color: r('on-normal'), border: `1px solid ${border ? r('border-normal') : 'transparent'}` };
  if (appearance === 'plain') return { background: 'transparent', color: r('on-quiet'), border: '1px solid transparent' };
  return { background: r('fill-loud'), color: r('on-loud'), border: '1px solid transparent' };
}

function button(variant: Variant): string {
  const size = SIZES[variant.size!]!;
  return el('button', { ...FONT, ...size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 1em', boxSizing: 'border-box', fontWeight: 500, borderRadius: v('border-radius-m'), flex: 'none', ...appearanceLook(variant.variant!, variant.appearance!) }, text('span', {}, 'Save draft', 'Label'), { type: 'button' });
}

function badge(variant: Variant): string {
  const look = variant.appearance === 'filled' ? { ...appearanceLook(variant.variant!, 'filled'), color: c(`${variant.variant}-on-normal`) } : appearanceLook(variant.variant!, variant.appearance!);
  return el('span', { ...FONT, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0.375em 0.625em', fontSize: '12px', lineHeight: '1', fontWeight: 500, borderRadius: v('border-radius-s'), flex: 'none', ...look }, text('span', {}, 'Beta', 'Label'));
}

function tag(variant: Variant): string {
  const r = (part: string) => c(`${variant.variant}-${part}`);
  const look: Css = variant.appearance === 'accent' ? { background: r('fill-loud'), color: r('on-loud'), border: '1px solid transparent' }
    : variant.appearance === 'outlined' ? { background: 'transparent', color: r('on-quiet'), border: `1px solid ${r('border-loud')}` }
      : variant.appearance === 'filled' ? { background: r('fill-quiet'), color: r('on-quiet'), border: '1px solid transparent' }
        : { background: r('fill-quiet'), color: r('on-quiet'), border: `1px solid ${r('border-normal')}` };
  return el('span', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '0.5em', height: '34px', padding: '0 0.75em', boxSizing: 'border-box', borderRadius: v('border-radius-m'), flex: 'none', ...look }, [
    text('span', { fontSize: '14px' }, 'Design', 'Label'),
    el('span', { display: 'flex', opacity: 0.8 }, icon(ICONS.x, 14), { 'data-name': 'Remove' }),
  ]);
}

const CALLOUT: Record<string, { icon: string; text: string }> = {
  brand: { icon: ICONS.info, text: 'Invoices now go out on the first working day of the month.' },
  success: { icon: ICONS.circleCheck, text: 'Your domain is connected and serving over HTTPS.' },
  warning: { icon: ICONS.triangleAlert, text: 'Your card expires at the end of this month.' },
  danger: { icon: ICONS.alert, text: 'The last backup failed. Check the storage settings.' },
  neutral: { icon: ICONS.info, text: 'This project is shared with three people.' },
};

function callout(variant: Variant): string {
  const kind = variant.variant!;
  const r = (part: string) => c(`${kind}-${part}`);
  const look: Css = variant.appearance === 'accent' ? { background: r('fill-loud'), color: r('on-loud'), border: '1px solid transparent' }
    : variant.appearance === 'filled' ? { background: r('fill-quiet'), border: '1px solid transparent' }
      : variant.appearance === 'outlined' ? { background: 'transparent', border: `1px solid ${r('border-loud')}` }
        : variant.appearance === 'plain' ? { background: 'transparent', border: '1px solid transparent' }
          : { background: r('fill-quiet'), border: `1px solid ${r('border-quiet')}` };
  return el('div', { ...FONT, lineHeight: '1.6', display: 'flex', alignItems: 'flex-start', gap: '1em', width: '480px', padding: '1em', boxSizing: 'border-box', borderRadius: v('border-radius-l'), color: c('text-normal'), ...look }, [
    el('span', { display: 'flex', paddingTop: '3px', color: variant.appearance === 'accent' ? 'currentColor' : r('on-quiet') }, icon(CALLOUT[kind]!.icon, 20), { 'data-name': 'Icon' }),
    text('span', { flex: '1' }, CALLOUT[kind]!.text, 'Message'),
  ], { role: 'note' });
}

function card(variant: Variant): string {
  const appearance = variant.appearance!;
  const look: Css = appearance === 'filled' ? { background: c('neutral-fill-quiet'), border: '1px solid transparent' }
    : appearance === 'plain' ? { background: 'transparent', border: '1px solid transparent' }
      : appearance === 'accent' ? { background: c('neutral-fill-loud'), color: c('neutral-on-loud'), border: '1px solid transparent' }
        : { background: c('surface-default'), border: `1px solid ${c('surface-border')}`, boxShadow: SHADOW_S };
  const rule = appearance === 'outlined' ? c('surface-border') : 'transparent';
  return el('div', { ...FONT, lineHeight: '1.6', display: 'flex', flexDirection: 'column', width: '340px', boxSizing: 'border-box', borderRadius: v('border-radius-l'), color: c('text-normal'), ...look }, [
    el('div', { padding: '12px 24px', borderBottom: `1px solid ${rule}` }, text('h3', { margin: '0', fontSize: '20px', lineHeight: '1.2', fontWeight: 600 }, 'Team plan', 'Title'), { 'data-name': 'Header' }),
    el('div', { display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px' }, [
      text('p', { margin: '0' }, 'Five seats, shared projects and one monthly invoice.', 'Body'),
      el('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
    ], { 'data-name': 'Card body' }),
    el('div', { display: 'flex', justifyContent: 'flex-end', padding: '24px', borderTop: `1px solid ${rule}` },
      el('button', { ...FONT, height: '43px', padding: '0 1em', fontWeight: 500, borderRadius: v('border-radius-m'), ...appearanceLook('brand', 'accent') }, text('span', {}, 'Choose plan', 'Action label'), { type: 'button', 'data-name': 'Action label' }), { 'data-name': 'Footer' }),
  ]);
}

function field(label: string, control: string, hint: string, name: string): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '0.5em', width: '320px' }, [
    text('label', { fontWeight: 500 }, label, 'Label'),
    control,
    text('span', { fontSize: '14px', lineHeight: '1.6', color: c('text-quiet') }, hint, 'Hint'),
  ], { 'data-name': name });
}

function input(variant: Variant): string {
  const error = variant.state === 'error';
  const box = el('div', { display: 'flex', alignItems: 'center', height: '43px', padding: '0 1em', boxSizing: 'border-box', borderRadius: v('border-radius-m'), background: c('surface-default'), border: `1px solid ${error ? c('danger-border-loud') : c('neutral-border-loud')}` }, text('span', { color: c('gray-50') }, 'you@example.com', 'Placeholder'), { 'data-name': 'Field' });
  return field('Email', box, 'We send the receipt here.', 'Input');
}

function select(): string {
  const box = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '43px', padding: '0 1em', boxSizing: 'border-box', borderRadius: v('border-radius-m'), background: c('surface-default'), border: `1px solid ${c('neutral-border-loud')}` }, [text('span', {}, 'Monthly', 'Value'), el('span', { display: 'flex', color: c('text-quiet') }, icon(ICONS.chevronDown, 16))], { 'data-name': 'Field' });
  return field('Billing', box, 'Yearly billing costs ten months.', 'Select');
}

function checkbox(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('label', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '0.5em', flex: 'none' }, [
    el('span', { width: '20px', height: '20px', boxSizing: 'border-box', borderRadius: v('border-radius-s'), border: `1px solid ${on ? c('brand-fill-loud') : c('neutral-border-loud')}`, background: on ? c('brand-fill-loud') : c('surface-default'), color: c('brand-on-loud'), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, on ? icon(ICONS.check, 14, 'Check', 3) : '', { 'data-name': 'Control', role: 'checkbox' }),
    text('span', {}, 'Email me when it ships', 'Label'),
  ]);
}

function switchControl(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('label', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '0.5em', flex: 'none' }, [
    el('span', { width: '35px', height: '20px', boxSizing: 'border-box', padding: '0 3px', borderRadius: '20px', border: `1px solid ${on ? c('brand-fill-loud') : c('neutral-border-loud')}`, background: on ? c('brand-fill-loud') : c('surface-default'), display: 'flex', alignItems: 'center', justifyContent: on ? 'flex-end' : 'flex-start', flex: 'none' },
      el('span', { width: '12px', height: '12px', borderRadius: '999px', background: on ? c('surface-default') : c('neutral-border-loud') }, [], { 'data-name': 'Thumb' }), { 'data-name': 'Control', role: 'switch' }),
    text('span', {}, 'Sync over mobile data', 'Label'),
  ]);
}

function radioGroup(): string {
  const radio = (label: string, on: boolean, name: string) => el('div', { display: 'flex', alignItems: 'center', gap: '0.5em' }, [
    el('span', { width: '20px', height: '20px', boxSizing: 'border-box', borderRadius: '999px', border: `1px solid ${on ? c('brand-fill-loud') : c('neutral-border-loud')}`, background: c('surface-default'), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' },
      el('span', { width: '10px', height: '10px', borderRadius: '999px', background: on ? c('brand-fill-loud') : 'transparent' }, [], { 'data-name': `${name} dot` }), { 'data-name': `${name} control` }),
    text('span', {}, label, `${name} label`),
  ], { 'data-name': name, role: 'radio' });
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '12px', width: '320px' }, [
    text('span', { fontWeight: 500 }, 'Delivery', 'Label'),
    radio('Standard, 3 to 5 days', true, 'Radio 1'), radio('Express, next day', false, 'Radio 2'), radio('Pick up in store', false, 'Radio 3'),
  ], { role: 'radiogroup' });
}

function slider(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '12px', width: '320px' }, [
    text('label', { fontWeight: 500 }, 'Volume', 'Label'),
    el('div', { position: 'relative', height: '20px', display: 'flex', alignItems: 'center' }, [
      el('div', { width: '100%', height: '6px', borderRadius: v('border-radius-pill'), background: c('neutral-fill-normal'), overflow: 'hidden' }, el('div', { width: '40%', height: '100%', background: c('brand-fill-loud') }, [], { 'data-name': 'Indicator' }), { 'data-name': 'Track' }),
      el('span', { position: 'absolute', left: 'calc(40% - 10px)', top: '0', width: '20px', height: '20px', boxSizing: 'border-box', borderRadius: '999px', background: c('brand-fill-loud'), border: `2px solid ${c('surface-default')}`, boxShadow: SHADOW_S }, [], { 'data-name': 'Thumb' }),
    ], { 'data-name': 'Slider', role: 'slider' }),
  ]);
}

function rating(variant: Variant): string {
  const value = Number(variant.value);
  const star = (i: number) => el('span', { display: 'flex', padding: '2px', color: i < value ? c('yellow-70') : c('neutral-on-quiet') }, i < value ? icon(ICONS.star, 20, `Star ${i + 1}`).replace('fill="none"', 'fill="currentColor"') : icon(ICONS.star, 20, `Star ${i + 1}`));
  return el('div', { display: 'inline-flex', gap: '2px', flex: 'none' }, [0, 1, 2, 3, 4].map(star), { role: 'slider', 'aria-label': 'Rating' });
}

function progressBar(variant: Variant): string {
  return el('div', { ...FONT, width: '320px', height: '16px', borderRadius: v('border-radius-pill'), background: c('neutral-fill-normal'), overflow: 'hidden', display: 'flex', flex: 'none' },
    el('div', { width: `${variant.value}%`, height: '100%', background: c('brand-fill-loud') }, [], { 'data-name': 'Indicator' }), { role: 'progressbar' });
}

function avatar(variant: Variant): string {
  const radius = variant.shape === 'square' ? '0' : variant.shape === 'rounded' ? v('border-radius-m') : '999px';
  return el('div', { ...FONT, width: '48px', height: '48px', borderRadius: radius, background: c('neutral-fill-normal'), color: c('neutral-on-normal'), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '19px', lineHeight: '1', flex: 'none' }, text('span', {}, 'MK', 'Initials'), { role: 'img', 'aria-label': 'Avatar of Mara Klein' });
}

function details(variant: Variant): string {
  const open = variant.open === 'true';
  return el('div', { ...FONT, lineHeight: '1.6', width: '420px', boxSizing: 'border-box', borderRadius: v('border-radius-l'), border: `1px solid ${c('surface-border')}`, background: c('surface-default') }, [
    el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', padding: '16px' }, [
      text('span', {}, 'Changing plans later', 'Summary'),
      el('span', { display: 'flex', color: c('text-quiet') }, icon(open ? ICONS.chevronDown : ICONS.chevronRight, 16), { 'data-name': 'Icon' }),
    ], { 'data-name': 'Header' }),
    open ? text('p', { margin: '0', padding: '0 16px 16px' }, 'Yes. A change takes effect on the next invoice, and unused days carry over.', 'Body') : '',
  ]);
}

function tabGroup(): string {
  const tab = (label: string, active: boolean, name: string) => el('span', { display: 'flex', padding: '1em 1.5em', fontWeight: 500, color: active ? c('brand-on-quiet') : c('neutral-on-quiet'), borderBottom: `2px solid ${active ? c('brand-fill-loud') : 'transparent'}`, marginBottom: '-2px' }, text('span', {}, label, `${name} label`), { 'data-name': name, role: 'tab' });
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '480px' }, [
    el('div', { display: 'flex', borderBottom: `2px solid ${c('neutral-fill-normal')}` }, [tab('General', true, 'Tab 1'), tab('Members', false, 'Tab 2'), tab('Billing', false, 'Tab 3')], { 'data-name': 'Tabs', role: 'tablist' }),
    text('p', { margin: '0', padding: '32px 0', lineHeight: '1.6' }, 'The project name, its owner and where its files are kept.', 'Panel'),
  ]);
}

function dialog(): string {
  const action = (label: string, look: Css, name: string) => el('button', { ...FONT, height: '43px', padding: '0 1em', fontWeight: 500, borderRadius: v('border-radius-m'), ...look }, text('span', {}, label, name), { type: 'button', 'data-name': name });
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '496px', boxSizing: 'border-box', borderRadius: v('border-radius-l'), background: c('surface-raised'), boxShadow: SHADOW_L }, [
    el('div', { display: 'flex', alignItems: 'center', padding: '12px 12px 0 24px' }, [
      text('h2', { flex: '1', margin: '0', fontSize: '20px', lineHeight: '1.2', fontWeight: 600 }, 'Discard this draft', 'Title'),
      el('span', { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '43px', height: '43px', color: c('neutral-on-quiet') }, icon(ICONS.x, 20), { 'data-name': 'Close', 'aria-label': 'Close' }),
    ], { 'data-name': 'Header' }),
    text('p', { margin: '0', padding: '24px', lineHeight: '1.6' }, 'The changes since your last save are lost.', 'Body'),
    el('div', { display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '0 24px 24px' }, [
      action('Keep editing', appearanceLook('neutral', 'outlined'), 'Cancel label'),
      action('Discard', appearanceLook('danger', 'accent'), 'Confirm label'),
    ], { 'data-name': 'Footer' }),
  ], { role: 'dialog' });
}

const LABEL = TEXT('label', 'Label');
const BUTTON_AXES = { variant: VARIANTS, appearance: ['accent', 'filled', 'outlined', 'filled-outlined', 'plain'], size: ['m', 's', 'l'] };
const BADGE_AXES = { variant: ['brand', 'neutral', 'success', 'warning', 'danger'], appearance: ['accent', 'filled', 'outlined', 'filled-outlined'] };
const TAG_AXES = { variant: VARIANTS, appearance: ['filled-outlined', 'accent', 'filled', 'outlined'] };
const CALLOUT_AXES = { variant: ['brand', 'success', 'warning', 'danger', 'neutral'], appearance: ['filled-outlined', 'accent', 'filled', 'outlined', 'plain'] };

const components: KitComponent[] = [
  {
    name: 'Button', group: 'Actions', description: 'A button in five variants and five appearances, in three sizes.', axes: BUTTON_AXES, members: eachAxis(BUTTON_AXES), props: [LABEL], html: button,
    handoff: { from: PKG, name: 'Button', element: 'wa-button', side: side('button'), props: { label: 'children' } },
  },
  {
    name: 'Input', group: 'Forms', description: 'A text input with its label and hint, and its invalid state.', axes: { state: ['default', 'error'] },
    props: [LABEL, TEXT('placeholder', 'Placeholder'), TEXT('hint', 'Hint')], html: input,
    handoff: { from: PKG, name: 'Input', element: 'wa-input', side: side('input'), props: { label: '', placeholder: '', hint: '', state: '' }, flags: { state: { error: 'custom-error="Enter an email address with an @."' } }, usage: '<wa-input type="email" label="{{label}}" hint="{{hint}}" placeholder="{{placeholder}}"{{attrs}}></wa-input>' },
  },
  {
    name: 'Select', group: 'Forms', description: 'A select with its label, options and hint.', props: [LABEL, TEXT('hint', 'Hint')], html: select,
    handoff: { from: PKG, name: 'Select', element: 'wa-select', side: side('select', 'option'), props: { label: '', hint: '' }, usage: '<wa-select label="{{label}}" hint="{{hint}}" value="monthly"{{attrs}}>\n  <wa-option value="monthly">Monthly</wa-option>\n  <wa-option value="yearly">Yearly</wa-option>\n</wa-select>' },
  },
  {
    name: 'Checkbox', group: 'Forms', description: 'A checkbox with its label.', axes: { checked: ['false', 'true'] }, props: [LABEL], html: checkbox,
    handoff: { from: PKG, name: 'Checkbox', element: 'wa-checkbox', side: side('checkbox'), props: { label: 'children', checked: '' }, flags: { checked: { true: 'checked' } } },
  },
  {
    name: 'Switch', group: 'Forms', description: 'A switch for a setting that applies at once.', axes: { checked: ['false', 'true'] }, props: [LABEL], html: switchControl,
    handoff: { from: PKG, name: 'Switch', element: 'wa-switch', side: side('switch'), props: { label: 'children', checked: '' }, flags: { checked: { true: 'checked' } } },
  },
  {
    name: 'Radio group', group: 'Forms', description: 'One choice of three, with the group\'s label.', props: [LABEL], html: radioGroup,
    handoff: { from: PKG, name: 'RadioGroup', element: 'wa-radio-group', side: side('radio-group', 'radio'), props: { label: '' }, usage: '<wa-radio-group label="{{label}}" name="delivery" value="standard"{{attrs}}>\n  <wa-radio value="standard">Standard, 3 to 5 days</wa-radio>\n  <wa-radio value="express">Express, next day</wa-radio>\n  <wa-radio value="pickup">Pick up in store</wa-radio>\n</wa-radio-group>' },
  },
  {
    name: 'Slider', group: 'Forms', description: 'A slider with its label.', props: [LABEL], html: slider,
    handoff: { from: PKG, name: 'Slider', element: 'wa-slider', side: side('slider'), props: { label: '' }, usage: '<wa-slider label="{{label}}" value="40"{{attrs}}></wa-slider>' },
  },
  {
    name: 'Rating', group: 'Forms', description: 'A rating out of five stars.', axes: { value: ['4', '2'] }, html: rating,
    handoff: { from: PKG, name: 'Rating', element: 'wa-rating', side: side('rating'), props: { value: '' }, flags: { value: { 4: 'value="4"', 2: 'value="2"' } }, usage: '<wa-rating label="Rating"{{attrs}}></wa-rating>' },
  },
  {
    name: 'Callout', group: 'Feedback', description: 'A message in a variant\'s colours, with an icon.', axes: CALLOUT_AXES, members: eachAxis(CALLOUT_AXES), props: [TEXT('message', 'Message')], html: callout,
    handoff: { from: PKG, name: 'Callout', element: 'wa-callout', side: side('callout'), props: { message: 'children' } },
  },
  {
    name: 'Badge', group: 'Feedback', description: 'A short label in a variant\'s colours.', axes: BADGE_AXES, members: eachAxis(BADGE_AXES), props: [LABEL], html: badge,
    handoff: { from: PKG, name: 'Badge', element: 'wa-badge', side: side('badge'), props: { label: 'children' } },
  },
  {
    name: 'Tag', group: 'Feedback', description: 'A removable tag in a variant\'s colours.', axes: TAG_AXES, members: eachAxis(TAG_AXES), props: [LABEL], html: tag,
    handoff: { from: PKG, name: 'Tag', element: 'wa-tag', side: side('tag'), props: { label: 'children' }, usage: '<wa-tag with-remove{{attrs}}>{{children}}</wa-tag>' },
  },
  {
    name: 'Progress bar', group: 'Feedback', description: 'Determinate progress on its track.', axes: { value: ['60', '25', '100'] }, html: progressBar,
    handoff: { from: PKG, name: 'ProgressBar', element: 'wa-progress-bar', side: side('progress-bar'), props: { value: '' }, flags: { value: { 60: 'value="60"', 25: 'value="25"', 100: 'value="100"' } }, usage: '<wa-progress-bar label="Upload progress"{{attrs}}></wa-progress-bar>' },
  },
  {
    name: 'Card', group: 'Content', description: 'A card with a header, text, a slot and a footer action.', axes: { appearance: ['outlined', 'filled', 'plain', 'accent'] },
    props: [TEXT('title', 'Title'), TEXT('body', 'Body'), TEXT('action', 'Action label')], html: card,
    handoff: { from: PKG, name: 'Card', element: 'wa-card', side: side('card', 'button'), props: { title: '', body: '', action: '' }, usage: '<wa-card with-header with-footer{{attrs}}>\n  <h3 slot="header">{{title}}</h3>\n  <p>{{body}}</p>\n  {{children}}\n  <wa-button slot="footer" variant="brand">{{action}}</wa-button>\n</wa-card>' },
  },
  {
    name: 'Avatar', group: 'Content', description: 'Initials in a circle, a rounded square or a square.', axes: { shape: ['circle', 'rounded', 'square'] }, props: [TEXT('initials', 'Initials')], html: avatar,
    handoff: { from: PKG, name: 'Avatar', element: 'wa-avatar', side: side('avatar'), props: { initials: 'initials' }, usage: '<wa-avatar label="Avatar of Mara Klein"{{attrs}}></wa-avatar>' },
  },
  {
    name: 'Details', group: 'Content', description: 'A summary that opens to show more.', axes: { open: ['false', 'true'] }, props: [TEXT('summary', 'Summary')], html: details,
    handoff: { from: PKG, name: 'Details', element: 'wa-details', side: side('details'), props: { summary: 'summary', open: '' }, flags: { open: { true: 'open' } }, usage: '<wa-details{{attrs}}>\n  Yes. A change takes effect on the next invoice, and unused days carry over.\n</wa-details>' },
  },
  {
    name: 'Tab group', group: 'Navigation', description: 'Tabs with the active one underlined, over its panel.', html: tabGroup,
    handoff: { from: PKG, name: 'TabGroup', element: 'wa-tab-group', side: side('tab-group', 'tab', 'tab-panel'), usage: '<wa-tab-group{{attrs}}>\n  <wa-tab panel="general">General</wa-tab>\n  <wa-tab panel="members">Members</wa-tab>\n  <wa-tab panel="billing">Billing</wa-tab>\n  <wa-tab-panel name="general">The project name, its owner and where its files are kept.</wa-tab-panel>\n  <wa-tab-panel name="members">Members</wa-tab-panel>\n  <wa-tab-panel name="billing">Billing</wa-tab-panel>\n</wa-tab-group>' },
  },
  {
    name: 'Dialog', group: 'Overlays', description: 'A dialog that asks before something that cannot be undone.', props: [TEXT('title', 'Title'), TEXT('body', 'Body')], html: dialog,
    handoff: { from: PKG, name: 'Dialog', element: 'wa-dialog', side: side('dialog', 'button'), props: { title: 'label', body: '' }, usage: '<wa-dialog open{{attrs}}>\n  {{body}}\n  <wa-button slot="footer" appearance="outlined" data-dialog="close">Keep editing</wa-button>\n  <wa-button slot="footer" variant="danger">Discard</wa-button>\n</wa-dialog>' },
  },
];

/** The default palette's scales that the default theme's variants use: brand blue, neutral gray, success green, warning yellow, danger red. */
const SCALES: Record<string, Record<string, string>> = {
  brand: { '95': '#e8f3ff', '90': '#d1e8ff', '80': '#9fceff', '70': '#6eb3ff', '60': '#3e96ff', '50': '#0071ec', '40': '#0053c0', '30': '#003f9c', '20': '#002d77', '10': '#001a4e', '05': '#000f35' },
  neutral: { '95': '#f1f2f3', '90': '#e4e5e9', '80': '#c7c9d0', '70': '#abaeb9', '60': '#9194a2', '50': '#717584', '40': '#545868', '30': '#424554', '20': '#2f323f', '10': '#1b1d26', '05': '#101219' },
  success: { '95': '#e3f9e3', '90': '#c2f2c1', '80': '#93da98', '70': '#5dc36f', '60': '#00ac49', '50': '#00883c', '40': '#036730', '30': '#0a5027', '20': '#0a3a1d', '10': '#052310', '05': '#031608' },
  warning: { '95': '#fef3cd', '90': '#ffe495', '80': '#fac22b', '70': '#ef9d00', '60': '#da7e00', '50': '#b45f04', '40': '#8c4602', '30': '#6f3601', '20': '#532600', '10': '#331600', '05': '#220c00' },
  danger: { '95': '#fff0ef', '90': '#ffdedc', '80': '#ffb8b6', '70': '#fd8f90', '60': '#f3676c', '50': '#dc3146', '40': '#b30532', '30': '#8a132c', '20': '#631323', '10': '#3e0913', '05': '#2a040b' },
};

/** Which step of its scale each role of a variant takes in light and in dark (themes/default.css). */
const ROLE_STEPS: [string, string, string][] = [
  ['fill-quiet', '95', '10'], ['fill-normal', '90', '20'], ['fill-loud', '50', '50'],
  ['border-quiet', '90', '20'], ['border-normal', '80', '30'], ['border-loud', '60', '40'],
  ['on-quiet', '40', '60'], ['on-normal', '30', '70'], ['on-loud', 'white', 'white'],
];
const KIT_ROLES: Record<string, KitToken['role']> = { 'brand-fill-loud': 'primary', 'brand-on-loud': 'on-primary', 'neutral-fill-loud': 'secondary', 'danger-fill-loud': 'danger', 'brand-fill-quiet': 'accent' };

function variantTokens(variant: string): KitToken[] {
  const scale = SCALES[variant]!;
  return ROLE_STEPS.map(([part, light, dark]) => {
    // The neutral variant's loud fill is dark in light mode and light in dark mode, and so is what sits on it.
    const [l, d] = variant === 'neutral' && part === 'fill-loud' ? ['20', '90'] : variant === 'neutral' && part === 'on-loud' ? ['white', '05'] : [light, dark];
    const name = `${variant}-${part}`;
    const value = (step: string) => (step === 'white' ? '#ffffff' : scale[step]!);
    return { name: `wa-color-${name}`, kind: 'color' as const, light: value(l), dark: value(d), ...(KIT_ROLES[name] ? { role: KIT_ROLES[name] } : {}) };
  });
}

const color = (name: string, light: string, dark: string, role?: KitToken['role']): KitToken => ({ name: `wa-color-${name}`, kind: 'color', light, dark, ...(role ? { role } : {}) });

export const webAwesomeKit: Kit = {
  id: 'web-awesome',
  name: 'Web Awesome',
  description: 'Web Awesome\'s free web components with the colours of its default theme, light and dark. Code is markup with its custom elements, for any framework.',
  platform: 'web',
  library: { name: 'Web Awesome', package: PKG, license: 'MIT', url: 'https://webawesome.com' },
  font: 'ui-sans-serif, system-ui, sans-serif',
  version: 1,
  tokens: [
    color('surface-default', '#ffffff', '#101219', 'background'),
    color('surface-raised', '#ffffff', '#1b1d26', 'surface'),
    color('surface-border', '#e4e5e9', '#2f323f', 'border'),
    color('text-normal', '#1b1d26', '#f1f2f3', 'foreground'),
    color('text-quiet', '#545868', '#9194a2', 'muted'),
    color('gray-50', '#717584', '#717584'),
    color('yellow-70', '#ef9d00', '#ef9d00'),
    ...['brand', 'neutral', 'success', 'warning', 'danger'].flatMap(variantTokens),
    { name: 'wa-border-radius-s', kind: 'radius', light: '0.1875rem' },
    { name: 'wa-border-radius-m', kind: 'radius', light: '0.375rem', role: 'radius' },
    { name: 'wa-border-radius-l', kind: 'radius', light: '0.75rem' },
    { name: 'wa-border-radius-pill', kind: 'radius', light: '9999px' },
    { name: 'wa-font-family-body', kind: 'font-family', light: 'ui-sans-serif, system-ui, sans-serif', role: 'font' },
  ],
  components,
};
