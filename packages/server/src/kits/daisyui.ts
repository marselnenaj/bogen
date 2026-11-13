import { eachAxis, el, icon, ICONS, text, type Css } from './markup.ts';
import type { Kit, KitComponent, KitToken, Variant } from './types.ts';

/**
 * daisyUI 5 (MIT, Pouya Saadeghi), the component classes for Tailwind CSS: its `--color-*` theme variables from the
 * light and dark themes it ships, its three radii, and the components as its public docs show them. Bogen's own
 * drawing with inline styles. Code handoff is markup with daisyUI's classes (`btn btn-primary`), which works the
 * same in React, Vue, Svelte and plain HTML once the project loads daisyUI as a Tailwind plugin.
 */
const v = (name: string) => `var(--${name})`;
const c = (name: string) => v(`color-${name}`);
const mix = (color: string, pct: number, other = 'transparent') => `color-mix(in oklab, ${color} ${pct}%, ${other})`;
const FONT = { fontFamily: v('font-sans'), fontSize: '14px', lineHeight: '20px', color: c('base-content') } as const;
const PKG = 'daisyui';
const COLORS = ['primary', 'secondary', 'accent', 'neutral', 'base'];
/** The colours with a `-content` pair; base is the plain look, which takes no colour class. */
const tone = (color: string) => (color === 'base' ? { fill: c('base-200'), on: c('base-content') } : { fill: c(color), on: c(`${color}-content`) });
const SHADOW = (color: string) => `0 0.5px 0 0.5px oklch(100% 0 0 / 6%) inset, 0 3px 2px -2px ${mix(color, 30)}, 0 4px 3px -2px ${mix(color, 30)}`;
const SIZES: Record<string, { height: string; padding: string; fontSize: string }> = {
  md: { height: '40px', padding: '0 16px', fontSize: '14px' },
  xs: { height: '24px', padding: '0 8px', fontSize: '11px' },
  sm: { height: '32px', padding: '0 12px', fontSize: '12px' },
  lg: { height: '48px', padding: '0 20px', fontSize: '18px' },
};

function button(variant: Variant): string {
  const { fill, on } = tone(variant.color!);
  const style = variant.style!;
  const size = SIZES[variant.size!]!;
  const look: Css = style === 'solid' ? { background: fill, color: on, border: `1px solid ${mix(fill, 95, '#000')}`, boxShadow: SHADOW(fill) }
    : style === 'outline' ? { background: 'transparent', color: variant.color === 'base' ? c('base-content') : fill, border: `1px solid ${variant.color === 'base' ? c('base-300') : fill}` }
      : style === 'dash' ? { background: 'transparent', color: variant.color === 'base' ? c('base-content') : fill, border: `1px dashed ${variant.color === 'base' ? c('base-300') : fill}` }
        : style === 'soft' ? { background: mix(variant.color === 'base' ? c('base-content') : fill, 8, c('base-100')), color: variant.color === 'base' ? c('base-content') : fill, border: `1px solid ${mix(variant.color === 'base' ? c('base-content') : fill, 10, c('base-100'))}` }
          : { background: 'transparent', color: c('base-content'), border: '1px solid transparent' };
  return el('button', { ...FONT, ...size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontWeight: 600, borderRadius: v('radius-field'), boxSizing: 'border-box', flex: 'none', ...look }, text('span', {}, 'Save changes', 'Label'), { type: 'button' });
}

function badge(variant: Variant): string {
  const { fill, on } = tone(variant.color!);
  const base = variant.color === 'base';
  const look: Css = variant.style === 'outline' ? { background: 'transparent', color: base ? c('base-content') : fill, border: `1px solid ${base ? c('base-300') : fill}` }
    : variant.style === 'soft' ? { background: mix(base ? c('base-content') : fill, 8, c('base-100')), color: base ? c('base-content') : fill, border: `1px solid ${mix(base ? c('base-content') : fill, 10, c('base-100'))}` }
      : { background: base ? c('base-100') : fill, color: base ? c('base-content') : on, border: `1px solid ${base ? c('base-200') : fill}` };
  return el('span', { ...FONT, display: 'inline-flex', alignItems: 'center', height: '24px', padding: '0 11px', boxSizing: 'border-box', borderRadius: v('radius-selector'), flex: 'none', ...look }, text('span', {}, 'Paid', 'Label'));
}

function card(variant: Variant): string {
  const look: Css = variant.style === 'border' ? { border: `1px solid ${c('base-300')}` } : variant.style === 'dash' ? { border: `1px dashed ${c('base-300')}` } : { boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)' };
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '360px', borderRadius: v('radius-box'), background: c('base-100'), boxSizing: 'border-box', ...look }, [
    el('div', { display: 'flex', flexDirection: 'column', gap: '8px', padding: '24px' }, [
      text('h2', { margin: '0', fontSize: '18px', lineHeight: '28px', fontWeight: 600 }, 'Team plan', 'Title'),
      text('p', { margin: '0' }, 'Five seats, shared projects and a monthly invoice. Change the seat count at any time.', 'Body'),
      el('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
      el('div', { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }, [
        text('button', { ...FONT, height: '40px', padding: '0 16px', fontWeight: 600, borderRadius: v('radius-field'), background: c('primary'), color: c('primary-content'), border: `1px solid ${c('primary')}`, boxShadow: SHADOW(c('primary')) }, 'Choose plan', 'Action label', { type: 'button' }),
      ], { 'data-name': 'Actions' }),
    ], { 'data-name': 'Card body' }),
  ]);
}

const ALERT_ICONS: Record<string, string> = { info: ICONS.info, success: ICONS.circleCheck, warning: ICONS.triangleAlert, error: 'circle-x' };
const ALERT_TEXT: Record<string, string> = { info: 'A new version is ready to install.', success: 'Your order was placed.', warning: 'Your storage is almost full.', error: 'The payment did not go through.' };

function alert(variant: Variant): string {
  const kind = variant.kind!;
  const look: Css = variant.style === 'soft' ? { background: mix(c(kind), 8, c('base-100')), color: c(kind), border: `1px solid ${mix(c(kind), 10, c('base-100'))}` }
    : variant.style === 'outline' ? { background: 'transparent', color: c(kind), border: `1px solid ${c(kind)}` }
      : { background: c(kind), color: c(`${kind}-content`), border: `1px solid ${c(kind)}`, boxShadow: `0 3px 0 -2px oklch(100% 0 0 / 8%) inset, 0 4px 3px -2px oklch(0% 0 0 / 8%)` };
  return el('div', { ...FONT, display: 'flex', alignItems: 'center', gap: '16px', width: '480px', padding: '12px 16px', boxSizing: 'border-box', borderRadius: v('radius-box'), ...look }, [icon(ALERT_ICONS[kind]!, 24), text('span', {}, ALERT_TEXT[kind]!, 'Message')], { role: 'alert' });
}

function fieldset(label: string, control: string, hint: string, name: string): string {
  return el('fieldset', { ...FONT, display: 'flex', flexDirection: 'column', gap: '6px', width: '320px', margin: '0', padding: '4px 0', border: '0', fontSize: '12px' }, [
    text('legend', { padding: '0 0 6px', fontSize: '14px', fontWeight: 600 }, label, 'Label'),
    control,
    text('p', { margin: '0', color: mix(c('base-content'), 60) }, hint, 'Hint'),
  ], { 'data-name': name });
}

function input(variant: Variant): string {
  const error = variant.state === 'error';
  const field = el('div', { ...FONT, display: 'flex', alignItems: 'center', height: '40px', padding: '0 12px', boxSizing: 'border-box', borderRadius: v('radius-field'), background: c('base-100'), border: `1px solid ${error ? c('error') : mix(c('base-content'), 20)}`, boxShadow: `0 1px ${mix(c('base-content'), 4)} inset` }, text('span', { color: mix(c('base-content'), 40) }, 'you@example.com', 'Placeholder'), { 'data-name': 'Input' });
  return fieldset('Email', field, error ? 'Enter an email address with an @.' : 'We send the receipt here.', 'Input field');
}

function select(): string {
  const field = el('div', { ...FONT, display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '40px', padding: '0 12px', boxSizing: 'border-box', borderRadius: v('radius-field'), background: c('base-100'), border: `1px solid ${mix(c('base-content'), 20)}` }, [text('span', {}, 'Monthly', 'Value'), icon(ICONS.chevronDown, 16)], { 'data-name': 'Select' });
  return fieldset('Billing', field, 'Switch to yearly to pay for ten months.', 'Select field');
}

function checkbox(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('label', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '8px', flex: 'none' }, [
    el('span', { width: '24px', height: '24px', boxSizing: 'border-box', borderRadius: v('radius-selector'), border: `1px solid ${on ? c('primary') : mix(c('base-content'), 20)}`, background: on ? c('primary') : 'transparent', color: c('primary-content'), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, on ? icon(ICONS.check, 16, 'Check', 3) : '', { 'data-name': 'Box', role: 'checkbox' }),
    text('span', {}, 'Email me when it ships', 'Label'),
  ]);
}

function toggle(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('label', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '8px', flex: 'none' }, [
    el('span', { width: '48px', height: '24px', boxSizing: 'border-box', padding: '3px', borderRadius: '999px', border: `1px solid ${on ? c('primary') : mix(c('base-content'), 50)}`, background: on ? c('primary') : 'transparent', display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start', flex: 'none' },
      el('span', { width: '16px', height: '16px', borderRadius: '999px', background: on ? c('primary-content') : mix(c('base-content'), 50) }, [], { 'data-name': 'Knob' }), { 'data-name': 'Track', role: 'switch' }),
    text('span', {}, 'Dark mode', 'Label'),
  ]);
}

function radio(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('label', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '8px', flex: 'none' }, [
    el('span', { width: '24px', height: '24px', boxSizing: 'border-box', borderRadius: '999px', border: `1px solid ${on ? c('primary') : mix(c('base-content'), 20)}`, padding: '4px', display: 'flex', flex: 'none' },
      el('span', { flex: '1', borderRadius: '999px', background: on ? c('primary') : 'transparent' }, [], { 'data-name': 'Dot' }), { 'data-name': 'Circle', role: 'radio' }),
    text('span', {}, 'Standard delivery', 'Label'),
  ]);
}

function tabs(variant: Variant): string {
  const style = variant.style!;
  const tab = (label: string, active: boolean, name: string) => {
    const look: Css = style === 'box' ? (active ? { background: c('base-100'), borderRadius: v('radius-field'), boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.08)' } : {})
      : style === 'border' ? { borderBottom: `2px solid ${active ? c('base-content') : 'transparent'}` }
        : (active ? { background: c('base-100'), border: `1px solid ${c('base-300')}`, borderBottom: '0', borderRadius: `${v('radius-field')} ${v('radius-field')} 0 0` } : { border: '1px solid transparent' });
    return el('span', { display: 'flex', alignItems: 'center', height: '32px', padding: '0 12px', boxSizing: 'border-box', color: active ? c('base-content') : mix(c('base-content'), 60), fontWeight: active ? 600 : 400, ...look }, text('span', {}, label, `${name} label`), { 'data-name': name, role: 'tab' });
  };
  return el('div', { ...FONT, display: 'flex', alignItems: 'flex-end', gap: '4px', padding: style === 'box' ? '4px' : '0', borderRadius: style === 'box' ? v('radius-box') : '0', background: style === 'box' ? c('base-200') : 'transparent', borderBottom: style === 'lift' ? `1px solid ${c('base-300')}` : undefined, flex: 'none' }, [tab('Overview', true, 'Tab 1'), tab('Invoices', false, 'Tab 2'), tab('Members', false, 'Tab 3')], { role: 'tablist' });
}

function navbar(): string {
  return el('nav', { ...FONT, display: 'flex', alignItems: 'center', gap: '8px', width: '720px', minHeight: '64px', padding: '8px 16px', boxSizing: 'border-box', background: c('base-100'), boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1)', borderRadius: v('radius-box') }, [
    text('span', { fontSize: '20px', fontWeight: 600, padding: '0 8px', flex: '1' }, 'Northwind', 'Brand'),
    el('div', { display: 'flex', gap: '4px' }, ['Docs', 'Pricing'].map((label, i) => text('span', { padding: '6px 12px', borderRadius: v('radius-field') }, label, `Link ${i + 1}`)), { 'data-name': 'Links' }),
    text('button', { ...FONT, height: '32px', padding: '0 12px', fontSize: '12px', fontWeight: 600, borderRadius: v('radius-field'), background: c('primary'), color: c('primary-content'), border: `1px solid ${c('primary')}` }, 'Sign in', 'Action label', { type: 'button' }),
  ]);
}

function menu(): string {
  const item = (label: string, ic: string, active: boolean, name: string) => el('li', { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', borderRadius: v('radius-field'), background: active ? c('neutral') : 'transparent', color: active ? c('neutral-content') : c('base-content') }, [icon(ic, 16), text('span', {}, label, `${name} label`)], { 'data-name': name });
  return el('ul', { ...FONT, display: 'flex', flexDirection: 'column', gap: '2px', width: '224px', margin: '0', padding: '8px', listStyle: 'none', boxSizing: 'border-box', borderRadius: v('radius-box'), background: c('base-200') }, [
    item('Dashboard', ICONS.home, true, 'Item 1'), item('Inbox', ICONS.mail, false, 'Item 2'), item('Calendar', ICONS.calendar, false, 'Item 3'), item('Settings', ICONS.settings, false, 'Item 4'),
  ], { role: 'menu' });
}

function stats(): string {
  const stat = (title: string, value: string, desc: string, name: string, last = false) => el('div', { display: 'flex', flexDirection: 'column', gap: '2px', padding: '16px 24px', borderRight: last ? '0' : `1px dashed ${mix(c('base-content'), 10)}` }, [
    text('span', { fontSize: '12px', color: mix(c('base-content'), 60) }, title, `${name} title`),
    text('span', { fontSize: '32px', lineHeight: '40px', fontWeight: 800 }, value, `${name} value`),
    text('span', { fontSize: '12px', color: mix(c('base-content'), 60) }, desc, `${name} description`),
  ], { 'data-name': name });
  return el('div', { ...FONT, display: 'flex', borderRadius: v('radius-box'), background: c('base-100'), boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1)', flex: 'none' }, [stat('Orders', '1,284', 'Up 8% on last month', 'Stat 1'), stat('Refunds', '23', 'Down 2 on last month', 'Stat 2', true)]);
}

function progress(variant: Variant): string {
  return el('div', { width: '320px', height: '8px', borderRadius: v('radius-box'), background: mix(c('base-content'), 20), overflow: 'hidden', flex: 'none' }, el('div', { width: `${variant.value}%`, height: '100%', borderRadius: v('radius-box'), background: c('primary') }, [], { 'data-name': 'Value' }), { role: 'progressbar' });
}

function avatar(variant: Variant): string {
  const size = variant.size === 'lg' ? 64 : variant.size === 'sm' ? 32 : 48;
  return el('div', { ...FONT, width: `${size}px`, height: `${size}px`, borderRadius: '999px', background: c('neutral'), color: c('neutral-content'), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: `${Math.round(size * 0.4)}px`, fontWeight: 600, flex: 'none' }, text('span', {}, 'MK', 'Initials'));
}

function modal(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', width: '448px', padding: '24px', boxSizing: 'border-box', borderRadius: v('radius-box'), background: c('base-100'), boxShadow: '0 25px 50px -12px rgb(0 0 0 / 0.25)' }, [
    text('h3', { margin: '0', fontSize: '18px', lineHeight: '28px', fontWeight: 700 }, 'Leave this workspace', 'Title'),
    text('p', { margin: '0' }, 'You lose access to its projects. An owner can invite you back.', 'Body'),
    el('div', { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }, [
      text('button', { ...FONT, height: '40px', padding: '0 16px', fontWeight: 600, borderRadius: v('radius-field'), background: c('base-200'), border: `1px solid ${c('base-300')}` }, 'Stay', 'Cancel label', { type: 'button' }),
      text('button', { ...FONT, height: '40px', padding: '0 16px', fontWeight: 600, borderRadius: v('radius-field'), background: c('error'), color: c('error-content'), border: `1px solid ${c('error')}` }, 'Leave', 'Confirm label', { type: 'button' }),
    ], { 'data-name': 'Actions' }),
  ], { role: 'dialog' });
}

const LABEL = { name: 'label', type: 'text' as const, target: 'Label' };
const classes = (prefix: string, values: string[], skip: string[] = []) => Object.fromEntries(values.filter((x) => !skip.includes(x)).map((x) => [x, `class="${prefix}-${x}"`]));

const components: KitComponent[] = [
  {
    name: 'Button', group: 'Actions', description: 'A button in a theme colour: solid, outline, dash, soft or ghost, in four sizes.',
    axes: { color: COLORS, style: ['solid', 'outline', 'dash', 'soft', 'ghost'], size: ['md', 'xs', 'sm', 'lg'] },
    members: eachAxis({ color: COLORS, style: ['solid', 'outline', 'dash', 'soft', 'ghost'], size: ['md', 'xs', 'sm', 'lg'] }),
    props: [LABEL], html: button,
    handoff: { from: PKG, name: 'Button', element: 'button', props: { label: 'children', color: '', style: '', size: '' }, flags: { color: classes('btn', COLORS, ['base']), style: classes('btn', ['outline', 'dash', 'soft', 'ghost']), size: classes('btn', ['xs', 'sm', 'lg']) }, usage: '<button class="btn"{{attrs}}>{{children}}</button>' },
  },
  {
    name: 'Badge', group: 'Data display', description: 'A short status in a theme colour.',
    axes: { color: COLORS, style: ['solid', 'outline', 'soft'] }, members: eachAxis({ color: COLORS, style: ['solid', 'outline', 'soft'] }),
    props: [LABEL], html: badge,
    handoff: { from: PKG, name: 'Badge', element: 'span', props: { label: 'children', color: '', style: '' }, flags: { color: classes('badge', COLORS, ['base']), style: classes('badge', ['outline', 'soft']) }, usage: '<span class="badge"{{attrs}}>{{children}}</span>' },
  },
  {
    name: 'Card', group: 'Data display', description: 'A card with a title, text, a slot and an action.', axes: { style: ['shadow', 'border', 'dash'] },
    props: [{ name: 'title', type: 'text', target: 'Title' }, { name: 'body', type: 'text', target: 'Body' }, { name: 'action', type: 'text', target: 'Action label' }], html: card,
    handoff: { from: PKG, name: 'Card', element: 'div', props: { title: '', body: '', action: '', style: '' }, flags: { style: { shadow: 'class="shadow-sm"', border: 'class="card-border"', dash: 'class="card-dash"' } }, usage: '<div class="card w-90 bg-base-100"{{attrs}}>\n  <div class="card-body">\n    <h2 class="card-title">{{title}}</h2>\n    <p>{{body}}</p>\n    {{children}}\n    <div class="card-actions justify-end">\n      <button class="btn btn-primary">{{action}}</button>\n    </div>\n  </div>\n</div>' },
  },
  {
    name: 'Stats', group: 'Data display', description: 'Two figures with a title and a line of context each.', html: stats,
    handoff: { from: PKG, name: 'Stats', element: 'div', usage: '<div class="stats shadow"{{attrs}}>\n  <div class="stat">\n    <div class="stat-title">Orders</div>\n    <div class="stat-value">1,284</div>\n    <div class="stat-desc">Up 8% on last month</div>\n  </div>\n  <div class="stat">\n    <div class="stat-title">Refunds</div>\n    <div class="stat-value">23</div>\n    <div class="stat-desc">Down 2 on last month</div>\n  </div>\n</div>' },
  },
  {
    name: 'Avatar', group: 'Data display', description: 'Initials in a circle, in three sizes.', axes: { size: ['md', 'sm', 'lg'] }, props: [{ name: 'initials', type: 'text', target: 'Initials' }], html: avatar,
    handoff: { from: PKG, name: 'Avatar', element: 'div', props: { initials: '', size: '' }, flags: { size: { sm: 'class="w-8"', md: 'class="w-12"', lg: 'class="w-16"' } }, usage: '<div class="avatar avatar-placeholder">\n  <div class="bg-neutral text-neutral-content rounded-full"{{attrs}}>\n    <span>{{initials}}</span>\n  </div>\n</div>' },
  },
  {
    name: 'Alert', group: 'Feedback', description: 'A message with an icon: info, success, warning or error, solid, soft or outline.',
    axes: { kind: ['info', 'success', 'warning', 'error'], style: ['solid', 'soft', 'outline'] }, members: eachAxis({ kind: ['info', 'success', 'warning', 'error'], style: ['solid', 'soft', 'outline'] }),
    props: [{ name: 'message', type: 'text', target: 'Message' }], html: alert,
    handoff: { from: PKG, name: 'Alert', element: 'div', props: { message: '', kind: '', style: '' }, flags: { kind: classes('alert', ['info', 'success', 'warning', 'error']), style: classes('alert', ['soft', 'outline']) }, usage: '<div role="alert" class="alert"{{attrs}}>\n  <span>{{message}}</span>\n</div>' },
  },
  {
    name: 'Progress', group: 'Feedback', description: 'Progress in the primary colour.', axes: { value: ['60', '25', '100'] }, html: progress,
    handoff: { from: PKG, name: 'Progress', element: 'progress', props: { value: '' }, flags: { value: { 60: 'value="60"', 25: 'value="25"', 100: 'value="100"' } }, usage: '<progress class="progress progress-primary w-80" max="100"{{attrs}}></progress>' },
  },
  {
    name: 'Modal', group: 'Feedback', description: 'A dialog that asks before something that cannot be undone.', props: [{ name: 'title', type: 'text', target: 'Title' }, { name: 'body', type: 'text', target: 'Body' }], html: modal,
    handoff: { from: PKG, name: 'Modal', element: 'dialog', props: { title: '', body: '' }, usage: '<dialog class="modal" open{{attrs}}>\n  <div class="modal-box">\n    <h3 class="text-lg font-bold">{{title}}</h3>\n    <p class="py-4">{{body}}</p>\n    <div class="modal-action">\n      <form method="dialog">\n        <button class="btn">Stay</button>\n        <button class="btn btn-error">Leave</button>\n      </form>\n    </div>\n  </div>\n</dialog>' },
  },
  {
    name: 'Input', group: 'Data input', description: 'A text input in a fieldset with its legend and a hint, and its error state.', axes: { state: ['default', 'error'] },
    props: [{ name: 'label', type: 'text', target: 'Label' }, { name: 'placeholder', type: 'text', target: 'Placeholder' }, { name: 'hint', type: 'text', target: 'Hint' }], html: input,
    handoff: { from: PKG, name: 'Input', element: 'fieldset', props: { label: '', placeholder: '', hint: '', state: '' }, flags: { state: { error: 'class="input-error"' } }, usage: '<fieldset class="fieldset">\n  <legend class="fieldset-legend">{{label}}</legend>\n  <input type="email" class="input" placeholder="{{placeholder}}"{{attrs}} />\n  <p class="label">{{hint}}</p>\n</fieldset>' },
  },
  {
    name: 'Select', group: 'Data input', description: 'A select in a fieldset.', props: [{ name: 'label', type: 'text', target: 'Label' }, { name: 'hint', type: 'text', target: 'Hint' }], html: select,
    handoff: { from: PKG, name: 'Select', element: 'fieldset', props: { label: '', hint: '' }, usage: '<fieldset class="fieldset"{{attrs}}>\n  <legend class="fieldset-legend">{{label}}</legend>\n  <select class="select">\n    <option>Monthly</option>\n    <option>Yearly</option>\n  </select>\n  <p class="label">{{hint}}</p>\n</fieldset>' },
  },
  {
    name: 'Checkbox', group: 'Data input', description: 'A checkbox with its label.', axes: { checked: ['false', 'true'] }, props: [LABEL], html: checkbox,
    handoff: { from: PKG, name: 'Checkbox', element: 'label', props: { label: '', checked: '' }, flags: { checked: { true: 'checked' } }, usage: '<label class="label">\n  <input type="checkbox" class="checkbox checkbox-primary"{{attrs}} />\n  {{label}}\n</label>' },
  },
  {
    name: 'Toggle', group: 'Data input', description: 'A switch with its label.', axes: { checked: ['false', 'true'] }, props: [LABEL], html: toggle,
    handoff: { from: PKG, name: 'Toggle', element: 'label', props: { label: '', checked: '' }, flags: { checked: { true: 'checked' } }, usage: '<label class="label">\n  <input type="checkbox" class="toggle toggle-primary"{{attrs}} />\n  {{label}}\n</label>' },
  },
  {
    name: 'Radio', group: 'Data input', description: 'A radio button with its label.', axes: { checked: ['false', 'true'] }, props: [LABEL], html: radio,
    handoff: { from: PKG, name: 'Radio', element: 'label', props: { label: '', checked: '' }, flags: { checked: { true: 'checked' } }, usage: '<label class="label">\n  <input type="radio" name="delivery" class="radio radio-primary"{{attrs}} />\n  {{label}}\n</label>' },
  },
  {
    name: 'Tabs', group: 'Navigation', description: 'Tabs in the box, border or lift style.', axes: { style: ['box', 'border', 'lift'] }, html: tabs,
    handoff: { from: PKG, name: 'Tabs', element: 'div', props: { style: '' }, flags: { style: classes('tabs', ['box', 'border', 'lift']) }, usage: '<div role="tablist" class="tabs"{{attrs}}>\n  <a role="tab" class="tab tab-active">Overview</a>\n  <a role="tab" class="tab">Invoices</a>\n  <a role="tab" class="tab">Members</a>\n</div>' },
  },
  {
    name: 'Menu', group: 'Navigation', description: 'A vertical menu with icons and the current item.', html: menu,
    handoff: { from: PKG, name: 'Menu', element: 'ul', usage: '<ul class="menu bg-base-200 rounded-box w-56"{{attrs}}>\n  <li><a class="menu-active">Dashboard</a></li>\n  <li><a>Inbox</a></li>\n  <li><a>Calendar</a></li>\n  <li><a>Settings</a></li>\n</ul>' },
  },
  {
    name: 'Navbar', group: 'Navigation', description: 'A bar with the product name, links and an action.', html: navbar,
    handoff: { from: PKG, name: 'Navbar', element: 'nav', usage: '<nav class="navbar bg-base-100 shadow-sm"{{attrs}}>\n  <div class="flex-1"><a class="btn btn-ghost text-xl">Northwind</a></div>\n  <div class="flex-none">\n    <a class="btn btn-ghost">Docs</a>\n    <a class="btn btn-ghost">Pricing</a>\n    <button class="btn btn-primary btn-sm">Sign in</button>\n  </div>\n</nav>' },
  },
];

const color = (name: string, light: string, dark: string, role?: KitToken['role']): KitToken => ({ name: `color-${name}`, kind: 'color', light, dark, ...(role ? { role } : {}) });

/** The `light` and `dark` themes of daisyui 5.8.0 (theme/light.css and theme/dark.css). */
export const daisyuiKit: Kit = {
  id: 'daisyui',
  name: 'daisyUI',
  description: 'daisyUI\'s component classes for Tailwind CSS, with the colours of its light and dark themes. Code is markup with daisyUI classes, for any framework.',
  platform: 'web',
  library: { name: 'daisyUI', package: 'daisyui', license: 'MIT', url: 'https://daisyui.com' },
  font: 'ui-sans-serif, system-ui, sans-serif',
  version: 1,
  tokens: [
    color('base-100', 'oklch(100% 0 0)', 'oklch(25.33% 0.016 252.42)', 'background'),
    color('base-200', 'oklch(98% 0 0)', 'oklch(23.26% 0.014 253.1)', 'surface'),
    color('base-300', 'oklch(95% 0 0)', 'oklch(21.15% 0.012 254.09)', 'border'),
    color('base-content', 'oklch(21% 0.006 285.885)', 'oklch(97.807% 0.029 256.847)', 'foreground'),
    color('primary', 'oklch(45% 0.24 277.023)', 'oklch(58% 0.233 277.117)', 'primary'),
    color('primary-content', 'oklch(93% 0.034 272.788)', 'oklch(96% 0.018 272.314)', 'on-primary'),
    color('secondary', 'oklch(65% 0.241 354.308)', 'oklch(65% 0.241 354.308)', 'secondary'),
    color('secondary-content', 'oklch(94% 0.028 342.258)', 'oklch(94% 0.028 342.258)'),
    color('accent', 'oklch(77% 0.152 181.912)', 'oklch(77% 0.152 181.912)', 'accent'),
    color('accent-content', 'oklch(38% 0.063 188.416)', 'oklch(38% 0.063 188.416)'),
    color('neutral', 'oklch(14% 0.005 285.823)', 'oklch(14% 0.005 285.823)', 'muted'),
    color('neutral-content', 'oklch(92% 0.004 286.32)', 'oklch(92% 0.004 286.32)'),
    color('info', 'oklch(74% 0.16 232.661)', 'oklch(74% 0.16 232.661)'),
    color('info-content', 'oklch(29% 0.066 243.157)', 'oklch(29% 0.066 243.157)'),
    color('success', 'oklch(76% 0.177 163.223)', 'oklch(76% 0.177 163.223)'),
    color('success-content', 'oklch(37% 0.077 168.94)', 'oklch(37% 0.077 168.94)'),
    color('warning', 'oklch(82% 0.189 84.429)', 'oklch(82% 0.189 84.429)'),
    color('warning-content', 'oklch(41% 0.112 45.904)', 'oklch(41% 0.112 45.904)'),
    color('error', 'oklch(71% 0.194 13.428)', 'oklch(71% 0.194 13.428)', 'danger'),
    color('error-content', 'oklch(27% 0.105 12.094)', 'oklch(27% 0.105 12.094)'),
    { name: 'radius-selector', kind: 'radius', light: '0.5rem' },
    { name: 'radius-field', kind: 'radius', light: '0.25rem', role: 'radius' },
    { name: 'radius-box', kind: 'radius', light: '0.5rem' },
    { name: 'font-sans', kind: 'font-family', light: 'ui-sans-serif, system-ui, sans-serif', role: 'font' },
  ],
  components,
};
