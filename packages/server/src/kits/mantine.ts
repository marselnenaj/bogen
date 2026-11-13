import { eachAxis, el, icon, ICONS, text, type Css } from './markup.ts';
import type { Kit, KitComponent, KitProp, KitToken, Variant } from './types.ts';

/**
 * Mantine (MIT, Vitaly Rtishchev), from @mantine/core 9.8.0: the default theme's blue primary, the gray, dark, red
 * and teal scales, and the light and dark values its CSS variables resolver writes (`--mantine-color-body`,
 * `-text`, `-dimmed`, `-default-border`, the `-filled`, `-light` and `-outline` colours of a hue), with the sizes
 * of the component styles. Bogen's own drawing from the public docs. The font stack is Mantine's without the
 * platform vendor names. Handoff writes `@mantine/core` in Mantine's props; icons come from lucide-react.
 */
const v = (name: string) => `var(--mantine-${name})`;
const MC = '@mantine/core';
const LUCIDE = 'lucide-react';
const FONT = { fontFamily: v('font-family'), fontSize: '14px', lineHeight: '1.55', color: v('color-text') } as const;
const SHADOW_XS = '0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.1)';
const SHADOW_SM = '0 1px 3px rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0.05) 0 10px 15px -5px, rgba(0, 0, 0, 0.04) 0 7px 7px -5px';
const SHADOW_LG = '0 1px 3px rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0.05) 0 28px 23px -7px, rgba(0, 0, 0, 0.04) 0 12px 12px -7px';
const SHADOW_XL = '0 1px 3px rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0.05) 0 36px 28px -7px, rgba(0, 0, 0, 0.04) 0 17px 17px -7px';

/** The five looks of a Mantine button, action icon and badge, in the primary colour. */
const LOOKS: Record<string, Css> = {
  filled: { background: v('primary-color-filled'), color: v('primary-color-contrast'), border: '1px solid transparent' },
  light: { background: v('primary-color-light'), color: v('primary-color-light-color'), border: '1px solid transparent' },
  outline: { background: 'transparent', color: v('color-blue-outline'), border: `1px solid ${v('color-blue-outline')}` },
  subtle: { background: 'transparent', color: v('primary-color-light-color'), border: '1px solid transparent' },
  default: { background: v('color-default'), color: v('color-default-color'), border: `1px solid ${v('color-default-border')}` },
};
const BUTTON_SIZES: Record<string, Css> = {
  sm: { height: '36px', padding: '0 18px', fontSize: '14px' },
  xs: { height: '30px', padding: '0 14px', fontSize: '12px' },
  md: { height: '42px', padding: '0 22px', fontSize: '16px' },
  lg: { height: '50px', padding: '0 26px', fontSize: '18px' },
};

function button(variant: Variant): string {
  return el('button', { ...FONT, ...BUTTON_SIZES[variant.size!], display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: '1', fontWeight: 600, borderRadius: v('radius-default'), boxSizing: 'border-box', flex: 'none', ...LOOKS[variant.variant!] }, text('span', {}, 'Create invoice', 'Label'), { type: 'button' });
}

function actionIcon(variant: Variant): string {
  return el('button', { width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: v('radius-default'), boxSizing: 'border-box', flex: 'none', ...LOOKS[variant.variant!] }, icon(ICONS.heart, 18), { type: 'button', 'aria-label': 'Favourite' });
}

function label(content: string, name = 'Label'): string {
  return text('label', { fontSize: '14px', fontWeight: 500, lineHeight: '1.55' }, content, name);
}

function textInput(variant: Variant): string {
  const error = variant.state === 'error';
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '2px', width: '320px' }, [
    label('Work email'),
    text('span', { fontSize: '12px', lineHeight: '1.4', color: v('color-dimmed') }, 'We send the receipts here.', 'Description'),
    el('div', { display: 'flex', alignItems: 'center', height: '36px', padding: '0 12px', marginTop: '3px', boxSizing: 'border-box', borderRadius: v('radius-default'), background: v('color-default'), border: `1px solid ${error ? v('color-error') : v('color-default-border')}` },
      text('span', { color: error ? v('color-error') : v('color-placeholder') }, 'ana@northwind.com', 'Placeholder'), { 'data-name': 'Input' }),
    error ? text('span', { fontSize: '12px', lineHeight: '1.4', color: v('color-error'), marginTop: '3px' }, 'Enter an address with a domain, like .com', 'Error') : '',
  ]);
}

function select(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '2px', width: '320px' }, [
    label('Billing period'),
    el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '36px', padding: '0 12px', marginTop: '3px', boxSizing: 'border-box', borderRadius: v('radius-default'), background: v('color-default'), border: `1px solid ${v('color-default-border')}` },
      [text('span', {}, 'Monthly', 'Value'), el('span', { display: 'flex', color: v('color-dimmed') }, icon(ICONS.chevronDown, 16))], { 'data-name': 'Input' }),
  ]);
}

function checkbox(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('div', { ...FONT, display: 'flex', alignItems: 'center', gap: '12px', flex: 'none' }, [
    el('span', { width: '20px', height: '20px', boxSizing: 'border-box', borderRadius: v('radius-sm'), border: `1px solid ${on ? v('primary-color-filled') : v('color-default-border')}`, background: on ? v('primary-color-filled') : v('color-default'), color: v('primary-color-contrast'), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, on ? icon(ICONS.check, 14, 'Check', 3) : '', { 'data-name': 'Box', role: 'checkbox' }),
    label('Send me the weekly summary'),
  ]);
}

function switchControl(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('div', { ...FONT, display: 'flex', alignItems: 'center', gap: '12px', flex: 'none' }, [
    el('span', { width: '38px', height: '20px', boxSizing: 'border-box', padding: '0 2px', borderRadius: '1000px', border: `1px solid ${on ? v('primary-color-filled') : v('color-default-border')}`, background: on ? v('primary-color-filled') : v('color-disabled'), display: 'flex', alignItems: 'center', justifyContent: on ? 'flex-end' : 'flex-start', flex: 'none' },
      el('span', { width: '14px', height: '14px', borderRadius: '1000px', background: v('color-white'), border: on ? '0' : `1px solid ${v('color-default-border')}`, boxSizing: 'border-box' }, [], { 'data-name': 'Thumb' }), { 'data-name': 'Track', role: 'switch' }),
    label('Two-step sign-in'),
  ]);
}

function radio(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('div', { ...FONT, display: 'flex', alignItems: 'center', gap: '12px', flex: 'none' }, [
    el('span', { width: '20px', height: '20px', boxSizing: 'border-box', borderRadius: '1000px', border: `1px solid ${on ? v('primary-color-filled') : v('color-default-border')}`, background: on ? v('primary-color-filled') : v('color-default'), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' },
      on ? el('span', { width: '8px', height: '8px', borderRadius: '1000px', background: v('primary-color-contrast') }, [], { 'data-name': 'Dot' }) : '', { 'data-name': 'Circle', role: 'radio' }),
    label('Standard shipping'),
  ]);
}

function segmented(): string {
  const seg = (content: string, active: boolean, name: string) => el('span', { flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '28px', padding: '0 10px', borderRadius: v('radius-default'), background: active ? v('color-default') : 'transparent', boxShadow: active ? SHADOW_XS : undefined, color: active ? v('color-text') : v('color-dimmed'), fontWeight: 500 }, text('span', {}, content, `${name} label`), { 'data-name': name });
  return el('div', { ...FONT, display: 'flex', width: '320px', padding: '4px', gap: '4px', boxSizing: 'border-box', borderRadius: v('radius-default'), background: v('color-default-hover') }, [seg('Day', true, 'Segment 1'), seg('Week', false, 'Segment 2'), seg('Month', false, 'Segment 3')], { role: 'radiogroup' });
}

function badge(variant: Variant): string {
  const lg = variant.size === 'lg';
  const dot = variant.variant === 'dot';
  const look = dot ? { background: 'transparent', color: v('color-text'), border: `1px solid ${v('color-default-border')}` } : LOOKS[variant.variant!];
  return el('span', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '6px', height: lg ? '26px' : '20px', padding: lg ? '0 12px' : '0 10px', fontSize: lg ? '13px' : '11px', fontWeight: 700, lineHeight: '1', borderRadius: '1000px', boxSizing: 'border-box', flex: 'none', ...look }, [
    dot ? el('span', { width: '6px', height: '6px', borderRadius: '1000px', background: v('primary-color-filled'), flex: 'none' }, [], { 'data-name': 'Dot' }) : '',
    text('span', {}, 'In review', 'Label'),
  ]);
}

function card(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', width: '340px', padding: '20px', boxSizing: 'border-box', borderRadius: v('radius-default'), background: v('color-default'), border: `1px solid ${v('color-default-border')}`, boxShadow: SHADOW_SM }, [
    text('span', { fontSize: '16px', fontWeight: 600 }, 'Quarterly report', 'Title'),
    text('span', { color: v('color-dimmed') }, 'Revenue, refunds and new customers for July to September, ready to share with the board.', 'Body'),
    el('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
    el('button', { ...FONT, ...BUTTON_SIZES.sm, marginTop: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: '1', fontWeight: 600, borderRadius: v('radius-default'), boxSizing: 'border-box', ...LOOKS.light }, text('span', {}, 'Open report', 'Action label'), { type: 'button' }),
  ]);
}

function avatar(variant: Variant): string {
  const look = variant.variant === 'filled' ? LOOKS.filled : LOOKS.light;
  return el('div', { ...FONT, width: '38px', height: '38px', borderRadius: '1000px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', fontWeight: 700, boxSizing: 'border-box', flex: 'none', ...look }, text('span', {}, 'AR', 'Initials'));
}

function progress(variant: Variant): string {
  return el('div', { width: '320px', height: '8px', borderRadius: v('radius-sm'), background: v('color-disabled'), overflow: 'hidden', flex: 'none' }, el('div', { width: `${variant.value}%`, height: '100%', background: v('primary-color-filled') }, [], { 'data-name': 'Section' }), { role: 'progressbar' });
}

/** One title and message for every colour: code takes a text prop's default from one member of the set. */
const ALERTS: Record<string, { bg: string; fg: string }> = {
  blue: { bg: v('primary-color-light'), fg: v('primary-color-light-color') },
  teal: { bg: v('color-teal-light'), fg: v('color-teal-light-color') },
  red: { bg: v('color-red-light'), fg: v('color-red-light-color') },
};

function alert(variant: Variant): string {
  const a = ALERTS[variant.color!]!;
  return el('div', { ...FONT, display: 'flex', gap: '16px', width: '440px', padding: '16px', boxSizing: 'border-box', borderRadius: v('radius-default'), background: a.bg, color: a.fg }, [
    el('span', { display: 'flex', flex: 'none', paddingTop: '1px' }, icon(ICONS.info, 20)),
    el('div', { display: 'flex', flexDirection: 'column', gap: '10px', flex: '1' }, [text('span', { fontWeight: 700 }, 'Bank details changed', 'Title'), text('span', { color: v('color-text') }, 'Payouts go to the new account from tomorrow.', 'Message')]),
  ], { role: 'alert' });
}

function notification(): string {
  return el('div', { ...FONT, display: 'flex', alignItems: 'flex-start', gap: '12px', width: '400px', padding: '10px 10px 10px 22px', boxSizing: 'border-box', borderRadius: v('radius-default'), background: v('color-default'), boxShadow: SHADOW_LG, position: 'relative', overflow: 'hidden' }, [
    el('span', { position: 'absolute', left: '4px', top: '8px', bottom: '8px', width: '6px', borderRadius: v('radius-default'), background: v('primary-color-filled') }, [], { 'data-name': 'Bar' }),
    el('div', { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1' }, [text('span', { fontWeight: 500 }, 'Export finished', 'Title'), text('span', { color: v('color-dimmed') }, 'The CSV of 1,284 orders is in your downloads.', 'Message')]),
    el('span', { display: 'flex', color: v('color-dimmed'), padding: '2px' }, icon(ICONS.x, 16), { 'data-name': 'Close' }),
  ], { role: 'status' });
}

function tabs(variant: Variant): string {
  const look = variant.variant!;
  const tab = (content: string, active: boolean, name: string) => {
    const style: Css = look === 'pills' ? { borderRadius: v('radius-default'), background: active ? v('primary-color-filled') : 'transparent', color: active ? v('primary-color-contrast') : v('color-text') }
      : look === 'outline' ? { borderRadius: `${v('radius-default')} ${v('radius-default')} 0 0`, border: `1px solid ${active ? v('color-default-border') : 'transparent'}`, borderBottom: active ? `1px solid ${v('color-body')}` : '1px solid transparent', background: active ? v('color-body') : 'transparent', marginBottom: '-1px' }
        : { borderBottom: `2px solid ${active ? v('primary-color-filled') : 'transparent'}`, marginBottom: '-2px' };
    return el('span', { display: 'flex', alignItems: 'center', padding: '10px 16px', boxSizing: 'border-box', fontWeight: active ? 500 : 400, ...style }, text('span', {}, content, `${name} label`), { 'data-name': name, role: 'tab' });
  };
  const list: Css = look === 'pills' ? { gap: '4px' } : look === 'outline' ? { borderBottom: `1px solid ${v('color-default-border')}` } : { borderBottom: `2px solid ${v('color-default-border')}` };
  return el('div', { ...FONT, display: 'flex', width: '440px', ...list }, [tab('Overview', true, 'Tab 1'), tab('Invoices', false, 'Tab 2'), tab('Settings', false, 'Tab 3')], { role: 'tablist' });
}

function navLink(variant: Variant): string {
  const active = variant.active === 'true';
  return el('a', { ...FONT, display: 'flex', alignItems: 'center', gap: '12px', width: '260px', padding: '8px 12px', boxSizing: 'border-box', textDecoration: 'none', background: active ? v('primary-color-light') : 'transparent', color: active ? v('primary-color-light-color') : v('color-text'), fontWeight: active ? 500 : 400 }, [
    icon('credit-card', 16),
    text('span', { flex: '1' }, 'Billing', 'Label'),
    el('span', { display: 'flex', color: v('color-dimmed') }, icon(ICONS.chevronRight, 14)),
  ], { href: '#' });
}

function modal(): string {
  const action = (content: string, look: Css, name: string) => el('button', { ...FONT, ...BUTTON_SIZES.sm, display: 'flex', alignItems: 'center', lineHeight: '1', fontWeight: 600, borderRadius: v('radius-default'), boxSizing: 'border-box', ...look }, text('span', {}, content, `${name} label`), { type: 'button', 'data-name': name });
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '16px', width: '440px', padding: '16px', boxSizing: 'border-box', borderRadius: v('radius-default'), background: v('color-body'), boxShadow: SHADOW_XL }, [
    el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, [text('span', { fontSize: '16px', fontWeight: 600 }, 'Delete project', 'Title'), el('span', { display: 'flex', color: v('color-dimmed') }, icon(ICONS.x, 18), { 'data-name': 'Close' })], { 'data-name': 'Header' }),
    text('span', {}, 'The project and its 42 files are removed for everyone. This cannot be undone.', 'Body'),
    el('div', { display: 'flex', justifyContent: 'flex-end', gap: '8px' }, [action('Cancel', LOOKS.default!, 'Cancel'), action('Delete', { background: v('color-error'), color: v('color-white'), border: '1px solid transparent' }, 'Confirm')], { 'data-name': 'Actions' }),
  ], { role: 'dialog' });
}

const TEXT = (name: string, target: string): KitProp => ({ name, type: 'text', target });
const VARIANTS = ['filled', 'light', 'outline', 'subtle', 'default'];

const components: KitComponent[] = [
  { name: 'Button', group: 'Buttons', description: 'A button: filled, light, outline, subtle or default, in four sizes.', axes: { variant: VARIANTS, size: ['sm', 'xs', 'md', 'lg'] }, members: eachAxis({ variant: VARIANTS, size: ['sm', 'xs', 'md', 'lg'] }), props: [TEXT('label', 'Label')], html: button, handoff: { from: MC, name: 'Button', props: { label: 'children' } } },
  { name: 'Action icon', group: 'Buttons', description: 'An icon button in the same looks as a button.', axes: { variant: VARIANTS }, html: actionIcon, handoff: { from: MC, name: 'ActionIcon', more: [{ from: LUCIDE, imports: ['Heart'] }], usage: '<ActionIcon aria-label="Favourite"{{attrs}}>\n  <Heart />\n</ActionIcon>' } },
  { name: 'Text input', group: 'Inputs', description: 'A text input with its label and description, and its error state.', axes: { state: ['default', 'error'] }, props: [TEXT('label', 'Label'), TEXT('description', 'Description'), TEXT('placeholder', 'Placeholder')], html: textInput, handoff: { from: MC, name: 'TextInput', props: { label: 'label', description: 'description', placeholder: 'placeholder', state: '' }, flags: { state: { error: 'error="Enter an address with a domain, like .com"' } } } },
  { name: 'Select', group: 'Inputs', description: 'A select with its label.', props: [TEXT('label', 'Label')], html: select, handoff: { from: MC, name: 'Select', props: { label: '' }, usage: '<Select label="{{label}}" data={["Monthly", "Yearly"]} defaultValue="Monthly"{{attrs}} />' } },
  { name: 'Checkbox', group: 'Inputs', description: 'A checkbox with its label.', axes: { checked: ['false', 'true'] }, props: [TEXT('label', 'Label')], html: checkbox, handoff: { from: MC, name: 'Checkbox', props: { label: 'label', checked: '' }, flags: { checked: { true: 'defaultChecked' } } } },
  { name: 'Switch', group: 'Inputs', description: 'A switch with its label.', axes: { checked: ['false', 'true'] }, props: [TEXT('label', 'Label')], html: switchControl, handoff: { from: MC, name: 'Switch', props: { label: 'label', checked: '' }, flags: { checked: { true: 'defaultChecked' } } } },
  { name: 'Radio', group: 'Inputs', description: 'A radio button with its label.', axes: { checked: ['false', 'true'] }, props: [TEXT('label', 'Label')], html: radio, handoff: { from: MC, name: 'Radio', props: { label: '', checked: '' }, flags: { checked: { true: 'defaultChecked' } }, usage: '<Radio value="standard" label="{{label}}"{{attrs}} />' } },
  { name: 'Segmented control', group: 'Inputs', description: 'A choice of three, the current one raised.', html: segmented, handoff: { from: MC, name: 'SegmentedControl', usage: '<SegmentedControl data={["Day", "Week", "Month"]}{{attrs}} />' } },
  { name: 'Badge', group: 'Data display', description: 'A short status: filled, light, outline or with a dot, in two sizes. Written in sentence case, which Mantine needs tt="none" for.', axes: { variant: ['filled', 'light', 'outline', 'dot'], size: ['md', 'lg'] }, members: eachAxis({ variant: ['filled', 'light', 'outline', 'dot'], size: ['md', 'lg'] }), props: [TEXT('label', 'Label')], html: badge, handoff: { from: MC, name: 'Badge', props: { label: 'children' }, usage: '<Badge tt="none"{{attrs}}>{{children}}</Badge>' } },
  { name: 'Card', group: 'Data display', description: 'A bordered card with a title, text, a slot and an action.', props: [TEXT('title', 'Title'), TEXT('body', 'Body'), TEXT('action', 'Action label')], html: card, handoff: { from: MC, name: 'Card', imports: ['Button', 'Text'], props: { title: '', body: '', action: '' }, usage: '<Card shadow="sm" padding="lg" radius="md" withBorder{{attrs}}>\n  <Text fw="600">{{title}}</Text>\n  <Text size="sm" c="dimmed">{{body}}</Text>\n  {{children}}\n  <Button variant="light" fullWidth mt="md">{{action}}</Button>\n</Card>' } },
  { name: 'Avatar', group: 'Data display', description: 'Initials in a circle, light or filled.', axes: { variant: ['light', 'filled'] }, props: [TEXT('initials', 'Initials')], html: avatar, handoff: { from: MC, name: 'Avatar', props: { initials: 'children' }, usage: '<Avatar radius="xl"{{attrs}}>{{children}}</Avatar>' } },
  { name: 'Progress', group: 'Data display', description: 'A progress bar in the primary colour.', axes: { value: ['60', '25', '100'] }, html: progress, handoff: { from: MC, name: 'Progress', props: { value: '' }, flags: { value: { 60: 'value={60}', 25: 'value={25}', 100: 'value={100}' } } } },
  { name: 'Alert', group: 'Feedback', description: 'A light alert with an icon, a title and a message, in blue, teal or red.', axes: { color: ['blue', 'teal', 'red'] }, props: [TEXT('title', 'Title'), TEXT('message', 'Message')], html: alert, handoff: { from: MC, name: 'Alert', more: [{ from: LUCIDE, imports: ['Info'] }], props: { title: '', message: '' }, usage: '<Alert variant="light" title="{{title}}" icon={<Info />}{{attrs}}>\n  {{message}}\n</Alert>' } },
  { name: 'Notification', group: 'Feedback', description: 'A notification with a title, a message and a close button.', props: [TEXT('title', 'Title'), TEXT('message', 'Message')], html: notification, handoff: { from: MC, name: 'Notification', props: { title: '', message: '' }, usage: '<Notification title="{{title}}"{{attrs}}>\n  {{message}}\n</Notification>' } },
  { name: 'Tabs', group: 'Navigation', description: 'Tabs in the default, outline or pills style.', axes: { variant: ['default', 'outline', 'pills'] }, html: tabs, handoff: { from: MC, name: 'Tabs', usage: '<Tabs defaultValue="overview"{{attrs}}>\n  <Tabs.List>\n    <Tabs.Tab value="overview">Overview</Tabs.Tab>\n    <Tabs.Tab value="invoices">Invoices</Tabs.Tab>\n    <Tabs.Tab value="settings">Settings</Tabs.Tab>\n  </Tabs.List>\n</Tabs>' } },
  { name: 'Nav link', group: 'Navigation', description: 'A link in a side navigation, with an icon, and the current one.', axes: { active: ['false', 'true'] }, props: [TEXT('label', 'Label')], html: navLink, handoff: { from: MC, name: 'NavLink', more: [{ from: LUCIDE, imports: ['CreditCard'] }], props: { label: '', active: '' }, flags: { active: { true: 'active' } }, usage: '<NavLink href="#" label="{{label}}" leftSection={<CreditCard />}{{attrs}} />' } },
  { name: 'Modal', group: 'Overlays', description: 'A dialog that asks before deleting. In code it needs an onClose handler of yours.', props: [TEXT('title', 'Title'), TEXT('body', 'Body')], html: modal, handoff: { from: MC, name: 'Modal', imports: ['Button', 'Group', 'Text'], props: { title: '', body: '' }, usage: '<Modal opened title="{{title}}"{{attrs}}>\n  <Text size="sm">{{body}}</Text>\n  <Group justify="flex-end" mt="md">\n    <Button variant="default">Cancel</Button>\n    <Button color="red">Delete</Button>\n  </Group>\n</Modal>' } },
];

const color = (name: string, light: string, dark?: string, role?: KitToken['role']): KitToken => ({ name: `mantine-${name}`, kind: 'color', light, ...(dark ? { dark } : {}), ...(role ? { role } : {}) });

export const mantineKit: Kit = {
  id: 'mantine',
  name: 'Mantine',
  description: 'Mantine\'s core components with the colours of its default theme, in light and dark. Bogen\'s own drawing from Mantine\'s docs.',
  platform: 'web',
  library: { name: 'Mantine', package: '@mantine/core', license: 'MIT', url: 'https://mantine.dev' },
  font: 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  version: 1,
  tokens: [
    color('color-body', '#ffffff', '#242424', 'background'),
    color('color-text', '#000000', '#c9c9c9', 'foreground'),
    color('color-default', '#ffffff', '#2e2e2e', 'surface'),
    color('color-default-hover', '#f8f9fa', '#3b3b3b'),
    color('color-default-color', '#000000', '#ffffff'),
    color('color-default-border', '#ced4da', '#424242', 'border'),
    color('color-dimmed', '#868e96', '#828282', 'muted'),
    color('color-placeholder', '#adb5bd', '#696969'),
    color('color-disabled', '#e9ecef', '#2e2e2e'),
    color('color-white', '#ffffff'),
    color('primary-color-filled', '#228be6', '#1971c2', 'primary'),
    color('primary-color-contrast', '#ffffff', '#ffffff', 'on-primary'),
    color('primary-color-light', '#d0ebff', 'rgba(12, 50, 86, 1)', 'accent'),
    color('primary-color-light-color', '#1864ab', '#e7f5ff'),
    color('color-blue-outline', '#228be6', '#4dabf7'),
    color('color-error', '#fa5252', '#e03131', 'danger'),
    color('color-red-light', '#ffe3e3', 'rgba(101, 21, 21, 1)'),
    color('color-red-light-color', '#c92a2a', '#fff5f5'),
    color('color-teal-light', '#c3fae8', 'rgba(4, 64, 46, 1)'),
    color('color-teal-light-color', '#087f5b', '#e6fcf5'),
    { name: 'mantine-radius-default', kind: 'radius', light: '0.5rem', role: 'radius' },
    { name: 'mantine-radius-sm', kind: 'radius', light: '0.25rem' },
    { name: 'mantine-font-family', kind: 'font-family', light: 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', role: 'font' },
  ],
  components,
};
