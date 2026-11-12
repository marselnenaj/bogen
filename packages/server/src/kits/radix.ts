import { combinations, el, icon, ICONS, text, type Css } from './markup.ts';
import type { Kit, KitComponent, KitProp, Variant } from './types.ts';

/**
 * Radix Themes (MIT, WorkOS): its components as its public docs show them, with its CSS variables, the
 * 12-step scales of Radix Colors (MIT) in indigo and gray, and their light and dark values. Handoff writes
 * `@radix-ui/themes` in its own props: `variant`, `size` as "1" to "3", and the parts as `Select.Root` and so on.
 */
const v = (name: string) => `var(--${name})`;
const RT = '@radix-ui/themes';
const FONT = { fontFamily: v('default-font-family'), fontSize: '14px', lineHeight: '20px', color: v('gray-12') } as const;
const SIZES: Record<string, Css> = {
  1: { height: '24px', padding: '0 8px', gap: '4px', fontSize: '12px', lineHeight: '16px', borderRadius: v('radius-1') },
  2: { height: '32px', padding: '0 12px', gap: '8px', fontSize: '14px', lineHeight: '20px', borderRadius: v('radius-2') },
  3: { height: '40px', padding: '0 16px', gap: '12px', fontSize: '16px', lineHeight: '24px', borderRadius: v('radius-3') },
};
const LOOKS: Record<string, Css> = {
  solid: { background: v('accent-9'), color: v('accent-contrast') },
  soft: { background: v('accent-3'), color: v('accent-11') },
  surface: { background: v('accent-2'), color: v('accent-11'), boxShadow: `inset 0 0 0 1px ${v('accent-7')}` },
  outline: { background: 'transparent', color: v('accent-11'), boxShadow: `inset 0 0 0 1px ${v('accent-8')}` },
  ghost: { background: 'transparent', color: v('accent-11') },
};

function button(variant: Variant): string {
  return el('button', { ...FONT, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', border: '0', fontWeight: 500, flex: 'none', ...SIZES[variant.size!], ...LOOKS[variant.variant!] }, text('span', {}, 'Bookmark', 'Label'), { type: 'button' });
}

function badge(variant: Variant): string {
  const small = variant.size === '1';
  return el('span', { ...FONT, display: 'inline-flex', alignItems: 'center', padding: small ? '2px 6px' : '2px 8px', fontSize: '12px', lineHeight: '16px', fontWeight: 500, borderRadius: v('radius-2'), flex: 'none', ...LOOKS[variant.variant!] }, text('span', {}, 'In progress', 'Label'));
}

function callout(variant: Variant): string {
  const look: Css = variant.variant === 'soft' ? { background: v('accent-3') } : variant.variant === 'surface' ? { background: v('accent-2'), boxShadow: `inset 0 0 0 1px ${v('accent-6')}` } : { boxShadow: `inset 0 0 0 1px ${v('accent-7')}` };
  return el('div', { ...FONT, display: 'flex', alignItems: 'flex-start', gap: '12px', width: '440px', padding: '16px', boxSizing: 'border-box', borderRadius: v('radius-4'), color: v('accent-11'), ...look }, [
    el('span', { display: 'flex', paddingTop: '2px' }, icon(ICONS.info, 16)),
    text('p', { margin: '0' }, 'You will need admin privileges to install and access this application.', 'Text'),
  ], { role: 'note' });
}

function card(variant: Variant): string {
  const classic = variant.variant === 'classic';
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '4px', width: '320px', padding: '16px', boxSizing: 'border-box', borderRadius: v('radius-4'), background: v('color-panel-solid'), boxShadow: classic ? `0 0 0 1px ${v('gray-5')}, 0 1px 1px ${v('gray-4')}, 0 2px 4px -2px ${v('gray-5')}` : `inset 0 0 0 1px ${v('gray-6')}` }, [
    text('div', { fontWeight: 700, fontSize: '16px', lineHeight: '24px' }, 'Quick start', 'Title'),
    text('div', { color: v('gray-11') }, 'Start building your next project in minutes.', 'Body'),
    el('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
  ]);
}

const field = (extra: Css = {}): Css => ({ ...FONT, display: 'flex', alignItems: 'center', gap: '8px', width: '280px', height: '32px', padding: '0 8px', boxSizing: 'border-box', borderRadius: v('radius-2'), background: v('color-surface'), boxShadow: `inset 0 0 0 1px ${v('gray-7')}`, ...extra });

function textField(): string {
  return el('div', field(), [el('span', { display: 'flex', color: v('gray-10') }, icon(ICONS.search, 16)), text('span', { color: v('gray-10') }, 'Search the docs', 'Placeholder')], { role: 'textbox' });
}

function textArea(): string {
  return el('div', field({ alignItems: 'flex-start', height: 'auto', minHeight: '80px', padding: '8px 12px' }), text('span', { color: v('gray-10') }, 'Reply to comment', 'Placeholder'), { role: 'textbox' });
}

function checkbox(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('label', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '8px' }, [
    el('span', { width: '16px', height: '16px', boxSizing: 'border-box', borderRadius: v('radius-1'), background: on ? v('accent-9') : v('color-surface'), boxShadow: on ? undefined : `inset 0 0 0 1px ${v('gray-7')}`, color: v('accent-contrast'), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, on ? icon(ICONS.check, 12, 'Check', 3) : '', { 'data-name': 'Box', role: 'checkbox' }),
    text('span', {}, 'Agree to Terms and Conditions', 'Label'),
  ]);
}

function switchControl(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('span', { width: '42px', height: '24px', padding: '1px', boxSizing: 'border-box', borderRadius: '999px', background: on ? v('accent-9') : v('gray-5'), display: 'flex', alignItems: 'center', justifyContent: on ? 'flex-end' : 'flex-start', flex: 'none' },
    el('span', { width: '22px', height: '22px', borderRadius: '999px', background: '#ffffff', boxShadow: '0 1px 3px rgb(0 0 0 / 0.2)' }, [], { 'data-name': 'Thumb' }), { role: 'switch' });
}

function radioGroup(): string {
  const item = (label: string, on: boolean, name: string) => el('label', { display: 'flex', alignItems: 'center', gap: '8px' }, [
    el('span', { width: '16px', height: '16px', boxSizing: 'border-box', borderRadius: '999px', background: on ? v('accent-9') : v('color-surface'), boxShadow: on ? undefined : `inset 0 0 0 1px ${v('gray-7')}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, on ? el('span', { width: '6px', height: '6px', borderRadius: '999px', background: v('accent-contrast') }) : '', { 'data-name': `${name} mark` }),
    text('span', {}, label, `${name} label`),
  ], { 'data-name': name });
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px' }, [item('Default', true, 'Option 1'), item('Comfortable', false, 'Option 2'), item('Compact', false, 'Option 3')], { role: 'radiogroup' });
}

function select(): string {
  return el('div', field({ width: '160px', justifyContent: 'space-between', padding: '0 12px' }), [text('span', {}, 'Apple', 'Value'), el('span', { display: 'flex', color: v('gray-11') }, icon(ICONS.chevronDown, 14))], { role: 'combobox' });
}

function tabs(): string {
  const tab = (label: string, active: boolean, name: string) => el('span', { display: 'flex', alignItems: 'center', height: '40px', padding: '0 8px', boxSizing: 'border-box', color: active ? v('gray-12') : v('gray-11'), fontWeight: active ? 500 : 400, boxShadow: active ? `inset 0 -2px 0 0 ${v('accent-10')}` : undefined }, text('span', {}, label, `${name} label`), { 'data-name': name, role: 'tab' });
  return el('div', { ...FONT, display: 'flex', gap: '8px', width: '400px', boxShadow: `inset 0 -1px 0 0 ${v('gray-5')}` }, [tab('Account', true, 'Tab 1'), tab('Documents', false, 'Tab 2'), tab('Settings', false, 'Tab 3')], { role: 'tablist' });
}

function segmentedControl(): string {
  const item = (label: string, active: boolean, name: string) => el('span', { flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: v('radius-2'), background: active ? v('color-background') : 'transparent', boxShadow: active ? `0 0 0 1px ${v('gray-6')}` : undefined, fontWeight: active ? 500 : 400 }, text('span', {}, label, `${name} label`), { 'data-name': name });
  return el('div', { ...FONT, display: 'flex', width: '300px', height: '32px', padding: '2px', boxSizing: 'border-box', borderRadius: v('radius-2'), background: v('gray-3') }, [item('Inbox', true, 'Item 1'), item('Drafts', false, 'Item 2'), item('Sent', false, 'Item 3')], { role: 'radiogroup' });
}

function avatar(): string {
  return el('span', { ...FONT, width: '40px', height: '40px', borderRadius: v('radius-3'), background: v('accent-3'), color: v('accent-11'), display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 500, flex: 'none' }, text('span', {}, 'A', 'Initials'));
}

function slider(): string {
  return el('div', { position: 'relative', width: '300px', height: '20px', display: 'flex', alignItems: 'center', flex: 'none' }, [
    el('div', { flex: '1', height: '6px', borderRadius: '999px', background: v('gray-4'), overflow: 'hidden', display: 'flex' }, el('div', { width: '50%', height: '100%', background: v('accent-9') }, [], { 'data-name': 'Range' }), { 'data-name': 'Track' }),
    el('span', { position: 'absolute', left: 'calc(50% - 10px)', top: '0', width: '20px', height: '20px', borderRadius: '999px', background: '#ffffff', boxShadow: `0 0 0 1px ${v('gray-7')}, 0 1px 3px rgb(0 0 0 / 0.15)` }, [], { 'data-name': 'Thumb' }),
  ], { role: 'slider' });
}

function progress(variant: Variant): string {
  return el('div', { width: '300px', height: '6px', borderRadius: '999px', background: v('gray-4'), overflow: 'hidden', display: 'flex', flex: 'none' }, el('div', { width: `${variant.value}%`, height: '100%', background: v('accent-9') }, [], { 'data-name': 'Indicator' }), { role: 'progressbar' });
}

function spinner(): string {
  return el('span', { width: '16px', height: '16px', boxSizing: 'border-box', borderRadius: '999px', border: `2px solid ${v('gray-6')}`, borderTopColor: v('gray-11'), flex: 'none' }, [], { role: 'status' });
}

function table(): string {
  const cell = (value: string, head: boolean, name: string) => text(head ? 'th' : 'td', { padding: '8px 12px', textAlign: 'left', fontWeight: head ? 700 : 400, boxShadow: `inset 0 -1px ${v('gray-5')}` }, value, name);
  return el('table', { ...FONT, width: '480px', borderCollapse: 'collapse' }, [
    el('thead', {}, el('tr', {}, ['Full name', 'Email', 'Group'].map((h, i) => cell(h, true, `Head ${i + 1}`)))),
    el('tbody', {}, [['Danilo Sousa', 'danilo@example.com', 'Developer'], ['Zahra Ambessa', 'zahra@example.com', 'Admin']].map((row, r) => el('tr', {}, row.map((x, i) => cell(x, false, `Cell ${r + 1}.${i + 1}`))))),
  ]);
}

function dialog(): string {
  const btn = (label: string, look: string, name: string) => el('span', { display: 'inline-flex', alignItems: 'center', ...SIZES[2], ...LOOKS[look], fontWeight: 500 }, text('span', {}, label, `${name} label`), { 'data-name': name });
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', width: '450px', padding: '24px', boxSizing: 'border-box', borderRadius: v('radius-5'), background: v('color-panel-solid'), boxShadow: `0 0 0 1px ${v('gray-5')}, 0 12px 60px rgb(0 0 0 / 0.15), 0 16px 64px rgb(0 0 0 / 0.1)` }, [
    text('div', { fontSize: '20px', lineHeight: '28px', fontWeight: 700 }, 'Edit profile', 'Title'),
    text('div', { color: v('gray-11'), marginBottom: '8px' }, 'Make changes to your profile.', 'Description'),
    el('div', { display: 'flex', flexDirection: 'column', gap: '12px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
    el('div', { display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '8px' }, [btn('Cancel', 'soft', 'Cancel'), btn('Save', 'solid', 'Action')], { 'data-name': 'Footer' }),
  ], { role: 'dialog' });
}

const TEXT = (name: string, target: string): KitProp => ({ name, type: 'text', target });
const BUTTON_AXES = { variant: ['solid', 'soft', 'surface', 'outline', 'ghost'], size: ['2', '1', '3'] };

const components: KitComponent[] = [
  { name: 'Button', group: 'Actions', description: 'A button in five variants and three sizes.', axes: BUTTON_AXES, members: combinations({ variant: BUTTON_AXES.variant, size: ['2'] }).concat([{ variant: 'solid', size: '1' }, { variant: 'solid', size: '3' }]), props: [TEXT('label', 'Label')], html: button, handoff: { from: RT, name: 'Button', props: { label: 'children' } } },
  { name: 'Badge', group: 'Content', description: 'A small label for a status.', axes: { variant: ['soft', 'solid', 'surface', 'outline'], size: ['1', '2'] }, members: [{ variant: 'soft', size: '1' }, { variant: 'solid', size: '1' }, { variant: 'surface', size: '1' }, { variant: 'outline', size: '1' }, { variant: 'soft', size: '2' }], props: [TEXT('label', 'Label')], html: badge, handoff: { from: RT, name: 'Badge', props: { label: 'children' } } },
  { name: 'Card', group: 'Content', description: 'A card with a heading, a line of text and a slot.', axes: { variant: ['surface', 'classic'] }, props: [TEXT('title', 'Title'), TEXT('body', 'Body')], html: card, handoff: { from: RT, name: 'Card', imports: ['Heading', 'Text'], props: { title: '', body: '' }, usage: '<Card{{attrs}}>\n  <Heading as="h3" size="3">{{title}}</Heading>\n  <Text as="p" size="2" color="gray">{{body}}</Text>\n  {{children}}\n</Card>' } },
  { name: 'Avatar', group: 'Content', description: 'An image of a person with a fallback.', props: [TEXT('initials', 'Initials')], html: avatar, handoff: { from: RT, name: 'Avatar', props: { initials: 'fallback' } } },
  { name: 'Table', group: 'Content', description: 'A table of rows with a header.', html: table, handoff: { from: RT, name: 'Table', usage: '<Table.Root{{attrs}}>\n  <Table.Header>\n    <Table.Row>\n      <Table.ColumnHeaderCell>Full name</Table.ColumnHeaderCell>\n      <Table.ColumnHeaderCell>Email</Table.ColumnHeaderCell>\n      <Table.ColumnHeaderCell>Group</Table.ColumnHeaderCell>\n    </Table.Row>\n  </Table.Header>\n  <Table.Body>\n    <Table.Row>\n      <Table.RowHeaderCell>Danilo Sousa</Table.RowHeaderCell>\n      <Table.Cell>danilo@example.com</Table.Cell>\n      <Table.Cell>Developer</Table.Cell>\n    </Table.Row>\n  </Table.Body>\n</Table.Root>' } },
  { name: 'Text field', group: 'Forms', description: 'A text input with a leading icon.', props: [TEXT('placeholder', 'Placeholder')], html: textField, handoff: { from: RT, name: 'TextField', props: { placeholder: '' }, usage: '<TextField.Root placeholder="{{placeholder}}"{{attrs}} />' } },
  { name: 'Text area', group: 'Forms', description: 'A text input of several lines.', props: [TEXT('placeholder', 'Placeholder')], html: textArea, handoff: { from: RT, name: 'TextArea', props: { placeholder: 'placeholder' } } },
  { name: 'Checkbox', group: 'Forms', description: 'A checkbox with its label.', axes: { checked: ['false', 'true'] }, props: [TEXT('label', 'Label')], html: checkbox, handoff: { from: RT, name: 'Checkbox', imports: ['Flex', 'Text'], props: { checked: '', label: '' }, flags: { checked: { true: 'defaultChecked' } }, usage: '<Text as="label" size="2">\n  <Flex gap="2">\n    <Checkbox{{attrs}} />\n    {{label}}\n  </Flex>\n</Text>' } },
  { name: 'Switch', group: 'Forms', description: 'A switch, off or on.', axes: { checked: ['false', 'true'] }, html: switchControl, handoff: { from: RT, name: 'Switch', props: { checked: '' }, flags: { checked: { true: 'defaultChecked' } } } },
  { name: 'Radio group', group: 'Forms', description: 'Options of which one is chosen.', html: radioGroup, handoff: { from: RT, name: 'RadioGroup', usage: '<RadioGroup.Root defaultValue="1"{{attrs}}>\n  <RadioGroup.Item value="1">Default</RadioGroup.Item>\n  <RadioGroup.Item value="2">Comfortable</RadioGroup.Item>\n  <RadioGroup.Item value="3">Compact</RadioGroup.Item>\n</RadioGroup.Root>' } },
  { name: 'Select', group: 'Forms', description: 'A closed select showing its value.', html: select, handoff: { from: RT, name: 'Select', usage: '<Select.Root defaultValue="apple"{{attrs}}>\n  <Select.Trigger />\n  <Select.Content>\n    <Select.Item value="apple">Apple</Select.Item>\n    <Select.Item value="orange">Orange</Select.Item>\n  </Select.Content>\n</Select.Root>' } },
  { name: 'Slider', group: 'Forms', description: 'A value along a track.', html: slider, handoff: { from: RT, name: 'Slider' } },
  { name: 'Tabs', group: 'Navigation', description: 'Tabs with an underline.', html: tabs, handoff: { from: RT, name: 'Tabs', usage: '<Tabs.Root defaultValue="account"{{attrs}}>\n  <Tabs.List>\n    <Tabs.Trigger value="account">Account</Tabs.Trigger>\n    <Tabs.Trigger value="documents">Documents</Tabs.Trigger>\n    <Tabs.Trigger value="settings">Settings</Tabs.Trigger>\n  </Tabs.List>\n</Tabs.Root>' } },
  { name: 'Segmented control', group: 'Navigation', description: 'A row of options, one of them chosen.', html: segmentedControl, handoff: { from: RT, name: 'SegmentedControl', usage: '<SegmentedControl.Root defaultValue="inbox"{{attrs}}>\n  <SegmentedControl.Item value="inbox">Inbox</SegmentedControl.Item>\n  <SegmentedControl.Item value="drafts">Drafts</SegmentedControl.Item>\n  <SegmentedControl.Item value="sent">Sent</SegmentedControl.Item>\n</SegmentedControl.Root>' } },
  { name: 'Callout', group: 'Feedback', description: 'A short message with an icon.', axes: { variant: ['soft', 'surface', 'outline'] }, props: [TEXT('text', 'Text')], html: callout, handoff: { from: RT, name: 'Callout', props: { text: '' }, usage: '<Callout.Root{{attrs}}>\n  <Callout.Text>{{text}}</Callout.Text>\n</Callout.Root>' } },
  { name: 'Progress', group: 'Feedback', description: 'How far something has come.', axes: { value: ['50', '25', '100'] }, html: progress, handoff: { from: RT, name: 'Progress', props: { value: '' }, flags: { value: { 50: 'value={50}', 25: 'value={25}', 100: 'value={100}' } } } },
  { name: 'Spinner', group: 'Feedback', description: 'A loading indicator.', html: spinner, handoff: { from: RT, name: 'Spinner' } },
  { name: 'Dialog', group: 'Overlays', description: 'A dialog with a title, a description, a slot and buttons.', props: [TEXT('title', 'Title'), TEXT('description', 'Description')], html: dialog, handoff: { from: RT, name: 'Dialog', imports: ['Button', 'Flex'], props: { title: '', description: '' }, usage: '<Dialog.Root open{{attrs}}>\n  <Dialog.Content maxWidth="450px">\n    <Dialog.Title>{{title}}</Dialog.Title>\n    <Dialog.Description size="2" mb="4">{{description}}</Dialog.Description>\n    {{children}}\n    <Flex gap="3" mt="4" justify="end">\n      <Dialog.Close>\n        <Button variant="soft" color="gray">Cancel</Button>\n      </Dialog.Close>\n      <Button>Save</Button>\n    </Flex>\n  </Dialog.Content>\n</Dialog.Root>' } },
];

const scale = (hue: string, light: string[], dark: string[], roles: Partial<Record<number, Kit['tokens'][number]['role']>> = {}) =>
  light.map((value, i) => ({ name: `${hue}-${i + 1}`, kind: 'color' as const, light: value, dark: dark[i]!, ...(roles[i + 1] ? { role: roles[i + 1] } : {}) }));

export const radixKit: Kit = {
  id: 'radix-themes',
  name: 'Radix Themes',
  description: 'Radix Themes components with its CSS variables and the Radix Colors scales in indigo and gray, light and dark.',
  platform: 'web',
  library: { name: 'Radix Themes', package: '@radix-ui/themes', license: 'MIT', url: 'https://www.radix-ui.com/themes' },
  font: '"Segoe UI", Roboto, Ubuntu, Cantarell, "Noto Sans", sans-serif',
  version: 1,
  tokens: [
    ...scale('accent',
      ['#fdfdfe', '#f7f9ff', '#edf2fe', '#e1e9ff', '#d2deff', '#c1d0ff', '#abbdf9', '#8da4ef', '#3e63dd', '#3358d4', '#3a5bc7', '#1f2d5c'],
      ['#11131f', '#141726', '#182449', '#1d2e62', '#253974', '#304384', '#3a4f97', '#435db1', '#3e63dd', '#5472e4', '#9eb1ff', '#d6e1ff'], { 3: 'accent', 9: 'primary' }),
    ...scale('gray',
      ['#fcfcfc', '#f9f9f9', '#f0f0f0', '#e8e8e8', '#e0e0e0', '#d9d9d9', '#cecece', '#bbbbbb', '#8d8d8d', '#838383', '#646464', '#202020'],
      ['#111111', '#191919', '#222222', '#2a2a2a', '#313131', '#3a3a3a', '#484848', '#606060', '#6e6e6e', '#7b7b7b', '#b4b4b4', '#eeeeee'], { 6: 'border', 11: 'muted', 12: 'foreground' }),
    { name: 'accent-contrast', kind: 'color', light: '#ffffff', dark: '#ffffff', role: 'on-primary' },
    { name: 'red-9', kind: 'color', light: '#e5484d', dark: '#e5484d', role: 'danger' },
    { name: 'color-background', kind: 'color', light: '#ffffff', dark: '#111111', role: 'background' },
    { name: 'color-panel-solid', kind: 'color', light: '#ffffff', dark: '#191919', role: 'surface' },
    { name: 'color-surface', kind: 'color', light: 'rgba(255, 255, 255, 0.9)', dark: 'rgba(0, 0, 0, 0.25)' },
    { name: 'radius-1', kind: 'radius', light: '3px' },
    { name: 'radius-2', kind: 'radius', light: '4px', role: 'radius' },
    { name: 'radius-3', kind: 'radius', light: '6px' },
    { name: 'radius-4', kind: 'radius', light: '8px' },
    { name: 'radius-5', kind: 'radius', light: '12px' },
    { name: 'default-font-family', kind: 'font-family', light: '"Segoe UI", Roboto, Ubuntu, Cantarell, "Noto Sans", sans-serif', role: 'font' },
  ],
  components,
};
