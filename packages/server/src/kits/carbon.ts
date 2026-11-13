import { eachAxis, el, icon, ICONS, text, type Css } from './markup.ts';
import type { Kit, KitComponent, KitProp, KitToken, Variant } from './types.ts';

/**
 * Carbon, IBM's design system for products (the guidelines and code are Apache-2.0): its theme tokens with the
 * `cds-` prefix as the CSS custom properties Carbon writes, light from the White theme and dark from Gray 100, read
 * from @carbon/themes 11.85.0 (scss/generated: _themes, _button-tokens, _notification-tokens, _tag-tokens). Square
 * corners, the 2x grid of 8px steps, 48, 40 and 32px controls, and IBM Plex Sans (OFL). Bogen's own drawing from
 * the public guidelines, with no IBM logo or Carbon icon. Handoff writes Carbon React (@carbon/react 1.120.0,
 * Apache-2.0) in its own props: kind, size, labelText, helperText, invalid.
 */
const v = (name: string) => `var(--cds-${name})`;
const CR = '@carbon/react';
const FONT = { fontFamily: v('font-family'), fontSize: '14px', lineHeight: '18px', letterSpacing: '0.16px', color: v('text-primary') } as const;
const LABEL: Css = { fontSize: '12px', lineHeight: '16px', letterSpacing: '0.32px', color: v('text-secondary') };
const HELPER: Css = { fontSize: '12px', lineHeight: '16px', letterSpacing: '0.32px', color: v('text-helper') };
const HEIGHT: Record<string, string> = { lg: '48px', md: '40px', sm: '32px' };
const FIELD: Css = { display: 'flex', alignItems: 'center', gap: '8px', height: '40px', padding: '0 16px', boxSizing: 'border-box', background: v('field-01'), borderBottom: `1px solid ${v('border-strong-01')}`, borderRadius: v('radius') };

const BUTTONS: Record<string, Css> = {
  primary: { background: v('button-primary'), color: v('text-on-color') },
  secondary: { background: v('button-secondary'), color: v('text-on-color') },
  tertiary: { background: 'transparent', color: v('button-tertiary'), border: `1px solid ${v('button-tertiary')}` },
  ghost: { background: 'transparent', color: v('link-primary'), padding: '0 16px' },
  danger: { background: v('button-danger-primary'), color: v('text-on-color') },
};

function button(variant: Variant): string {
  const kind = variant.kind!;
  return el('button', { ...FONT, display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: '32px', height: HEIGHT[variant.size!], minWidth: kind === 'ghost' ? undefined : '160px', padding: '0 15px', boxSizing: 'border-box', border: '1px solid transparent', borderRadius: v('radius'), flex: 'none', ...BUTTONS[kind] }, [
    text('span', {}, kind === 'danger' ? 'Delete cluster' : kind === 'ghost' ? 'View logs' : 'Deploy', 'Label'),
    kind === 'ghost' ? '' : icon(kind === 'danger' ? 'trash' : ICONS.plus, 16),
  ], { type: 'button' });
}

function textInput(variant: Variant): string {
  const invalid = variant.state === 'invalid';
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', width: '320px' }, [
    text('label', LABEL, 'Work email', 'Label'),
    el('div', { ...FIELD, ...(invalid ? { outline: `2px solid ${v('support-error')}`, outlineOffset: '-2px', borderBottom: '0' } : {}) }, [
      text('span', { flex: '1', color: v('text-placeholder') }, 'name@company.com', 'Placeholder'),
      invalid ? el('span', { display: 'flex', color: v('support-error') }, icon(ICONS.alert, 16)) : '',
    ], { 'data-name': 'Field' }),
    text('span', invalid ? { ...HELPER, color: v('text-error') } : HELPER, invalid ? 'Enter an email address with an @.' : 'Alerts for this project go here.', 'Helper'),
  ]);
}

function dropdown(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', width: '320px' }, [
    text('span', LABEL, 'Region', 'Label'),
    el('div', { ...FIELD, justifyContent: 'space-between', cursor: 'pointer' }, [text('span', {}, 'Frankfurt (eu-de)', 'Value'), icon(ICONS.chevronDown, 16)], { 'data-name': 'Field', role: 'combobox' }),
  ]);
}

function checkbox(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('label', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '8px', minHeight: '24px', flex: 'none' }, [
    el('span', { width: '16px', height: '16px', boxSizing: 'border-box', borderRadius: '2px', border: on ? '0' : `1px solid ${v('icon-primary')}`, background: on ? v('icon-primary') : 'transparent', color: v('background'), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, on ? icon(ICONS.check, 12, 'Check', 3) : '', { 'data-name': 'Box', role: 'checkbox' }),
    text('span', {}, 'Keep audit logs for 90 days', 'Label'),
  ]);
}

function toggle(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '16px', flex: 'none' }, [
    text('span', LABEL, 'Email alerts', 'Label'),
    el('div', { display: 'flex', alignItems: 'center', gap: '8px' }, [
      el('span', { width: '48px', height: '24px', boxSizing: 'border-box', padding: '3px', borderRadius: '12px', background: on ? v('support-success') : v('toggle-off'), display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start', flex: 'none' },
        el('span', { width: '18px', height: '18px', borderRadius: '999px', background: v('icon-on-color') }, [], { 'data-name': 'Knob' }), { 'data-name': 'Track', role: 'switch' }),
      text('span', {}, on ? 'On' : 'Off', 'State'),
    ]),
  ]);
}

function radioGroup(): string {
  const option = (label: string, on: boolean, name: string) => el('label', { display: 'inline-flex', alignItems: 'center', gap: '8px', minHeight: '24px' }, [
    el('span', { width: '18px', height: '18px', boxSizing: 'border-box', borderRadius: '999px', border: `1px solid ${v('icon-primary')}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, on ? el('span', { width: '8px', height: '8px', borderRadius: '999px', background: v('icon-primary') }) : '', { 'data-name': `${name} circle`, role: 'radio' }),
    text('span', {}, label, `${name} label`),
  ], { 'data-name': name });
  return el('fieldset', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', margin: '0', padding: '0', border: '0', flex: 'none' }, [
    text('legend', { ...LABEL, padding: '0 0 8px' }, 'Backup frequency', 'Legend'),
    el('div', { display: 'flex', gap: '16px' }, [option('Hourly', false, 'Option 1'), option('Daily', true, 'Option 2'), option('Weekly', false, 'Option 3')], { 'data-name': 'Options' }),
  ], { role: 'radiogroup' });
}

function search(): string {
  return el('div', { ...FONT, ...FIELD, width: '320px', gap: '12px', color: v('icon-secondary') }, [icon(ICONS.search, 16), text('span', { color: v('text-placeholder') }, 'Find a cluster', 'Placeholder')], { role: 'search' });
}

const TAG_TEXT: Record<string, string> = { gray: 'Stopped', blue: 'Provisioning', green: 'Running', red: 'Failed', purple: 'Beta' };

function tag(variant: Variant): string {
  const type = variant.type!;
  return el('span', { ...FONT, fontSize: '12px', lineHeight: '16px', letterSpacing: '0.32px', display: 'inline-flex', alignItems: 'center', height: '24px', padding: '0 8px', boxSizing: 'border-box', borderRadius: '999px', background: v(`tag-background-${type}`), color: v(`tag-color-${type}`), flex: 'none' }, text('span', {}, TAG_TEXT[type]!, 'Label'));
}

function tile(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', width: '320px', padding: '16px', boxSizing: 'border-box', background: v('layer-01'), borderRadius: v('radius') }, [
    text('h3', { margin: '0', fontSize: '16px', lineHeight: '24px', fontWeight: 600 }, 'prod-eu-1', 'Title'),
    text('p', { margin: '0', color: v('text-secondary') }, 'Six nodes in Frankfurt. Last backup 14 minutes ago.', 'Body'),
    el('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
  ]);
}

function dataTable(variant: Variant): string {
  const row = variant.size === 'sm' ? '32px' : '48px';
  const cell = (value: string, name: string, head = false): string => text(head ? 'th' : 'td', { height: row, padding: '0 16px', boxSizing: 'border-box', textAlign: 'left', fontWeight: head ? 600 : 400, color: head ? v('text-primary') : v('text-secondary'), borderBottom: head ? '0' : `1px solid ${v('border-subtle-01')}`, whiteSpace: 'nowrap' }, value, name);
  const body = [['prod-eu-1', 'Frankfurt', '6', 'Running'], ['prod-us-2', 'Washington DC', '9', 'Running'], ['stage-eu-1', 'Dublin', '3', 'Stopped']];
  return el('table', { ...FONT, width: '640px', borderCollapse: 'collapse', background: v('layer-01') }, [
    el('thead', { background: v('layer-accent-01') }, el('tr', {}, ['Cluster', 'Region', 'Nodes', 'Status'].map((h, i) => cell(h, `Header ${i + 1}`, true)))),
    el('tbody', {}, body.map((r, ri) => el('tr', {}, r.map((value, ci) => cell(value, `Row ${ri + 1} cell ${ci + 1}`)), { 'data-name': `Row ${ri + 1}` }))),
  ]);
}

const NOTICE: Record<string, { icon: string; title: string; subtitle: string }> = {
  error: { icon: 'circle-x', title: 'Deploy failed', subtitle: 'The image could not be pulled from the registry.' },
  success: { icon: ICONS.circleCheck, title: 'Backup complete', subtitle: 'prod-eu-1 was saved at 09:42.' },
  warning: { icon: ICONS.triangleAlert, title: 'Quota at 90%', subtitle: 'Add capacity before the next release.' },
  info: { icon: ICONS.info, title: 'Maintenance on Sunday', subtitle: 'Dublin restarts between 02:00 and 03:00.' },
};

function notification(variant: Variant): string {
  const kind = variant.kind!;
  const n = NOTICE[kind]!;
  return el('div', { ...FONT, display: 'flex', alignItems: 'flex-start', gap: '16px', width: '560px', minHeight: '48px', padding: '15px 16px 15px 13px', boxSizing: 'border-box', background: v(`notification-background-${kind}`), borderLeft: `3px solid ${v(`support-${kind}`)}`, borderRadius: v('radius') }, [
    el('span', { display: 'flex', color: v(`support-${kind}`), flex: 'none' }, icon(n.icon, 20), { 'data-name': 'Icon' }),
    el('div', { flex: '1', display: 'flex', flexWrap: 'wrap', gap: '4px' }, [text('span', { fontWeight: 600 }, n.title, 'Title'), text('span', {}, n.subtitle, 'Subtitle')]),
    el('span', { display: 'flex', color: v('icon-primary'), flex: 'none' }, icon(ICONS.x, 16), { 'data-name': 'Close' }),
  ], { role: 'status' });
}

function progressBar(variant: Variant): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', width: '320px' }, [
    text('span', {}, 'Uploading logs', 'Label'),
    el('div', { height: '8px', background: v('border-subtle-01') }, el('div', { width: `${variant.value}%`, height: '100%', background: v('interactive') }, [], { 'data-name': 'Bar' }), { role: 'progressbar', 'data-name': 'Track' }),
    text('span', HELPER, `${variant.value === '100' ? '240' : String(Math.round(2.4 * Number(variant.value)))} of 240 MB`, 'Helper'),
  ]);
}

function modal(): string {
  const action = (label: string, look: Css, name: string) => el('button', { ...FONT, flex: '1', display: 'flex', alignItems: 'flex-start', height: '64px', padding: '14px 16px', boxSizing: 'border-box', border: '0', borderRadius: '0', color: v('text-on-color'), ...look }, text('span', {}, label, `${name} label`), { type: 'button', 'data-name': name });
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '512px', background: v('layer-01'), borderRadius: v('radius'), overflow: 'hidden' }, [
    el('div', { display: 'flex', flexDirection: 'column', gap: '4px', padding: '16px 16px 0' }, [
      text('span', LABEL, 'prod-eu-1', 'Label'),
      text('h2', { margin: '0', fontSize: '20px', lineHeight: '28px', fontWeight: 400 }, 'Delete this cluster', 'Heading'),
    ]),
    text('p', { margin: '0', padding: '16px 64px 48px 16px' }, 'Its six nodes and their volumes are removed. Backups stay for 30 days.', 'Body'),
    el('div', { display: 'flex' }, [action('Cancel', { background: v('button-secondary') }, 'Secondary'), action('Delete', { background: v('button-danger-primary') }, 'Primary')], { 'data-name': 'Footer' }),
  ], { role: 'dialog' });
}

function tabs(): string {
  const tab = (label: string, active: boolean, name: string) => el('span', { display: 'flex', alignItems: 'center', height: '40px', padding: '0 16px', boxSizing: 'border-box', borderBottom: `2px solid ${active ? v('border-interactive') : v('border-subtle-01')}`, fontWeight: active ? 600 : 400, color: active ? v('text-primary') : v('text-secondary') }, text('span', {}, label, `${name} label`), { 'data-name': name, role: 'tab' });
  return el('div', { ...FONT, display: 'flex', flex: 'none' }, [tab('Overview', true, 'Tab 1'), tab('Nodes', false, 'Tab 2'), tab('Backups', false, 'Tab 3'), tab('Access', false, 'Tab 4')], { role: 'tablist' });
}

function breadcrumb(): string {
  const sep = (i: number) => text('span', { color: v('text-primary') }, '/', `Separator ${i}`);
  return el('nav', { ...FONT, display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' }, [
    text('a', { color: v('link-primary'), textDecoration: 'none' }, 'Projects', 'Item 1'), sep(1),
    text('a', { color: v('link-primary'), textDecoration: 'none' }, 'Payments', 'Item 2'), sep(2),
    text('span', {}, 'prod-eu-1', 'Current'),
  ], { 'aria-label': 'Breadcrumb' });
}

function overflowMenu(): string {
  const item = (label: string, name: string, danger = false) => el('div', { display: 'flex', alignItems: 'center', height: '40px', padding: '0 16px', borderTop: danger ? `1px solid ${v('border-subtle-01')}` : undefined, color: danger ? v('support-error') : v('text-secondary') }, text('span', {}, label, `${name} label`), { 'data-name': name, role: 'menuitem' });
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', flex: 'none' }, [
    el('span', { width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: v('layer-01'), color: v('icon-primary') }, icon(ICONS.more, 16), { 'data-name': 'Trigger', role: 'button' }),
    el('div', { display: 'flex', flexDirection: 'column', width: '160px', background: v('layer-01'), boxShadow: '0 2px 6px rgb(0 0 0 / 0.3)' }, [item('Restart', 'Item 1'), item('Resize', 'Item 2'), item('Delete', 'Item 3', true)], { 'data-name': 'Menu', role: 'menu' }),
  ]);
}

const TEXT = (name: string, target: string): KitProp => ({ name, type: 'text', target });
const KINDS = ['primary', 'secondary', 'tertiary', 'ghost', 'danger'];
const TAGS = ['gray', 'blue', 'green', 'red', 'purple'];

const components: KitComponent[] = [
  { name: 'Button', group: 'Actions', description: 'Primary, secondary, tertiary, ghost and danger buttons, in the large, medium and small heights.', axes: { kind: KINDS, size: ['lg', 'md', 'sm'] }, members: eachAxis({ kind: KINDS, size: ['lg', 'md', 'sm'] }), props: [TEXT('label', 'Label')], html: button, handoff: { from: CR, name: 'Button', props: { label: 'children' } } },
  { name: 'Overflow menu', group: 'Actions', description: 'The three-dot menu of a row or a tile, open, with a destructive item last.', html: overflowMenu, handoff: { from: CR, name: 'OverflowMenu', imports: ['OverflowMenuItem'], usage: '<OverflowMenu aria-label="Cluster actions" flipped{{attrs}}>\n  <OverflowMenuItem itemText="Restart" />\n  <OverflowMenuItem itemText="Resize" />\n  <OverflowMenuItem itemText="Delete" isDelete hasDivider />\n</OverflowMenu>' } },
  { name: 'Text input', group: 'Forms', description: 'A text input with its label and helper text, and its invalid state.', axes: { state: ['default', 'invalid'] }, props: [TEXT('label', 'Label'), TEXT('placeholder', 'Placeholder'), TEXT('helper', 'Helper')], html: textInput, handoff: { from: CR, name: 'TextInput', props: { label: 'labelText', placeholder: 'placeholder', helper: 'helperText', state: '' }, flags: { state: { invalid: 'invalid' } }, usage: '<TextInput id="work-email" type="email" labelText="{{label}}" placeholder="{{placeholder}}" helperText="{{helper}}" invalidText="Enter an email address with an @."{{attrs}} />' } },
  { name: 'Dropdown', group: 'Forms', description: 'A dropdown with its title and the chosen item.', props: [TEXT('label', 'Label'), TEXT('value', 'Value')], html: dropdown, handoff: { from: CR, name: 'Dropdown', props: { label: 'titleText', value: 'initialSelectedItem' }, usage: '<Dropdown id="region" titleText="{{label}}" label="Choose a region" items={["Frankfurt (eu-de)", "Dublin (eu-ie)", "Washington DC (us-east)"]} initialSelectedItem="{{value}}"{{attrs}} />' } },
  { name: 'Search', group: 'Forms', description: 'A search field.', props: [TEXT('placeholder', 'Placeholder')], html: search, handoff: { from: CR, name: 'Search', props: { placeholder: 'placeholder' }, usage: '<Search labelText="Search clusters" placeholder="{{placeholder}}"{{attrs}} />' } },
  { name: 'Checkbox', group: 'Forms', description: 'A checkbox with its label.', axes: { checked: ['false', 'true'] }, props: [TEXT('label', 'Label')], html: checkbox, handoff: { from: CR, name: 'Checkbox', props: { label: 'labelText', checked: '' }, flags: { checked: { true: 'defaultChecked' } }, usage: '<Checkbox id="audit-logs" labelText="{{label}}"{{attrs}} />' } },
  { name: 'Toggle', group: 'Forms', description: 'A switch with its label and its state written out.', axes: { checked: ['false', 'true'] }, props: [TEXT('label', 'Label')], html: toggle, handoff: { from: CR, name: 'Toggle', props: { label: 'labelText', checked: '' }, flags: { checked: { true: 'defaultToggled' } }, usage: '<Toggle id="email-alerts" labelText="{{label}}" labelA="Off" labelB="On"{{attrs}} />' } },
  { name: 'Radio button group', group: 'Forms', description: 'Three options in a row with their legend.', props: [TEXT('legend', 'Legend')], html: radioGroup, handoff: { from: CR, name: 'RadioButtonGroup', imports: ['RadioButton'], props: { legend: 'legendText' }, usage: '<RadioButtonGroup legendText="{{legend}}" name="backup-frequency" defaultSelected="daily"{{attrs}}>\n  <RadioButton labelText="Hourly" value="hourly" id="backup-hourly" />\n  <RadioButton labelText="Daily" value="daily" id="backup-daily" />\n  <RadioButton labelText="Weekly" value="weekly" id="backup-weekly" />\n</RadioButtonGroup>' } },
  { name: 'Data table', group: 'Data', description: 'A table with a header row and three rows, at the default or the compact row height.', axes: { size: ['lg', 'sm'] }, html: dataTable, handoff: { from: CR, name: 'Table', imports: ['TableBody', 'TableCell', 'TableHead', 'TableHeader', 'TableRow'], props: { size: 'size' }, usage: '<Table aria-label="Clusters"{{attrs}}>\n  <TableHead>\n    <TableRow>\n      <TableHeader>Cluster</TableHeader>\n      <TableHeader>Region</TableHeader>\n      <TableHeader>Nodes</TableHeader>\n      <TableHeader>Status</TableHeader>\n    </TableRow>\n  </TableHead>\n  <TableBody>\n    <TableRow>\n      <TableCell>prod-eu-1</TableCell>\n      <TableCell>Frankfurt</TableCell>\n      <TableCell>6</TableCell>\n      <TableCell>Running</TableCell>\n    </TableRow>\n    <TableRow>\n      <TableCell>prod-us-2</TableCell>\n      <TableCell>Washington DC</TableCell>\n      <TableCell>9</TableCell>\n      <TableCell>Running</TableCell>\n    </TableRow>\n    <TableRow>\n      <TableCell>stage-eu-1</TableCell>\n      <TableCell>Dublin</TableCell>\n      <TableCell>3</TableCell>\n      <TableCell>Stopped</TableCell>\n    </TableRow>\n  </TableBody>\n</Table>' } },
  { name: 'Tag', group: 'Data', description: 'A status tag in one of Carbon\'s tag colours.', axes: { type: TAGS }, props: [TEXT('label', 'Label')], html: tag, handoff: { from: CR, name: 'Tag', props: { label: 'children', type: 'type' } } },
  { name: 'Tile', group: 'Data', description: 'A tile on the first layer, with a title, a line of detail and a slot.', props: [TEXT('title', 'Title'), TEXT('body', 'Body')], html: tile, handoff: { from: CR, name: 'Tile', props: { title: '', body: '' }, usage: '<Tile{{attrs}}>\n  <h3>{{title}}</h3>\n  <p>{{body}}</p>\n  {{children}}\n</Tile>' } },
  { name: 'Inline notification', group: 'Feedback', description: 'A notification in the page: error, success, warning or info.', axes: { kind: ['error', 'success', 'warning', 'info'] }, props: [TEXT('title', 'Title'), TEXT('subtitle', 'Subtitle')], html: notification, handoff: { from: CR, name: 'InlineNotification', props: { title: 'title', subtitle: 'subtitle', kind: 'kind' } } },
  { name: 'Progress bar', group: 'Feedback', description: 'Determinate progress with its label and helper text.', axes: { value: ['60', '25', '100'] }, props: [TEXT('label', 'Label'), TEXT('helper', 'Helper')], html: progressBar, handoff: { from: CR, name: 'ProgressBar', props: { label: 'label', helper: 'helperText', value: '' }, flags: { value: { 60: 'value={60}', 25: 'value={25}', 100: 'value={100}' } } } },
  { name: 'Modal', group: 'Feedback', description: 'A danger modal with its label, heading, text and the two footer buttons.', props: [TEXT('label', 'Label'), TEXT('heading', 'Heading'), TEXT('body', 'Body')], html: modal, handoff: { from: CR, name: 'Modal', props: { label: 'modalLabel', heading: 'modalHeading', body: '' }, usage: '<Modal open danger modalLabel="{{label}}" modalHeading="{{heading}}" primaryButtonText="Delete" secondaryButtonText="Cancel"{{attrs}}>\n  <p>{{body}}</p>\n</Modal>' } },
  { name: 'Tabs', group: 'Navigation', description: 'Line tabs with the selected one underlined.', html: tabs, handoff: { from: CR, name: 'Tabs', imports: ['Tab', 'TabList', 'TabPanel', 'TabPanels'], usage: '<Tabs{{attrs}}>\n  <TabList aria-label="Cluster sections">\n    <Tab>Overview</Tab>\n    <Tab>Nodes</Tab>\n    <Tab>Backups</Tab>\n    <Tab>Access</Tab>\n  </TabList>\n  <TabPanels>\n    <TabPanel>Overview</TabPanel>\n    <TabPanel>Nodes</TabPanel>\n    <TabPanel>Backups</TabPanel>\n    <TabPanel>Access</TabPanel>\n  </TabPanels>\n</Tabs>' } },
  { name: 'Breadcrumb', group: 'Navigation', description: 'The path to the current page.', html: breadcrumb, handoff: { from: CR, name: 'Breadcrumb', imports: ['BreadcrumbItem'], usage: '<Breadcrumb{{attrs}}>\n  <BreadcrumbItem href="#">Projects</BreadcrumbItem>\n  <BreadcrumbItem href="#">Payments</BreadcrumbItem>\n  <BreadcrumbItem isCurrentPage>prod-eu-1</BreadcrumbItem>\n</Breadcrumb>' } },
];

const t = (name: string, light: string, dark: string, role?: KitToken['role']): KitToken => ({ name: `cds-${name}`, kind: 'color', light, dark, ...(role ? { role } : {}) });

export const carbonKit: Kit = {
  id: 'carbon',
  name: 'Carbon',
  description: 'A dense product kit in the Carbon Design System: square corners, 8px steps, tables and forms, with the White and Gray 100 themes. Bogen\'s own drawing; it ships no IBM logo or icons.',
  platform: 'web',
  library: { name: 'Carbon React', package: '@carbon/react', license: 'Apache-2.0', url: 'https://carbondesignsystem.com' },
  design: { name: 'Carbon Design System', license: 'Apache-2.0', url: 'https://carbondesignsystem.com' },
  font: '"IBM Plex Sans", system-ui, sans-serif',
  version: 1,
  tokens: [
    t('background', '#ffffff', '#161616', 'background'),
    t('layer-01', '#f4f4f4', '#262626', 'surface'),
    t('layer-accent-01', '#e0e0e0', '#393939'),
    t('field-01', '#f4f4f4', '#262626'),
    t('border-subtle-01', '#c6c6c6', '#525252', 'border'),
    t('border-strong-01', '#8d8d8d', '#6f6f6f'),
    t('border-interactive', '#0f62fe', '#4589ff'),
    t('text-primary', '#161616', '#f4f4f4', 'foreground'),
    t('text-secondary', '#525252', '#c6c6c6', 'muted'),
    t('text-placeholder', 'rgba(22, 22, 22, 0.4)', 'rgba(244, 244, 244, 0.4)'),
    t('text-helper', '#6f6f6f', '#a8a8a8'),
    t('text-error', '#da1e28', '#ff8389'),
    t('text-on-color', '#ffffff', '#ffffff', 'on-primary'),
    t('icon-primary', '#161616', '#f4f4f4'),
    t('icon-secondary', '#525252', '#c6c6c6'),
    t('icon-on-color', '#ffffff', '#ffffff'),
    t('button-primary', '#0f62fe', '#0f62fe', 'primary'),
    t('interactive', '#0f62fe', '#4589ff', 'primary'),
    t('link-primary', '#0f62fe', '#78a9ff', 'primary'),
    t('button-secondary', '#393939', '#6f6f6f', 'secondary'),
    t('button-tertiary', '#0f62fe', '#ffffff'),
    t('button-danger-primary', '#da1e28', '#da1e28', 'danger'),
    t('focus', '#0f62fe', '#ffffff'),
    t('toggle-off', '#8d8d8d', '#6f6f6f'),
    t('support-error', '#da1e28', '#fa4d56', 'danger'),
    t('support-success', '#24a148', '#42be65'),
    t('support-warning', '#f1c21b', '#f1c21b'),
    t('support-info', '#0043ce', '#4589ff'),
    t('notification-background-error', '#fff1f1', '#262626'),
    t('notification-background-success', '#defbe6', '#262626'),
    t('notification-background-warning', '#fcf4d6', '#262626'),
    t('notification-background-info', '#edf5ff', '#262626'),
    ...TAGS.flatMap((tg) => {
      const bg: Record<string, [string, string]> = { gray: ['#e0e0e0', '#525252'], blue: ['#d0e2ff', '#0043ce'], green: ['#a7f0ba', '#0e6027'], red: ['#ffd7d9', '#a2191f'], purple: ['#e8daff', '#6929c4'] };
      const fg: Record<string, [string, string]> = { gray: ['#161616', '#f4f4f4'], blue: ['#0043ce', '#d0e2ff'], green: ['#0e6027', '#a7f0ba'], red: ['#a2191f', '#ffd7d9'], purple: ['#6929c4', '#e8daff'] };
      return [t(`tag-background-${tg}`, ...bg[tg]!), t(`tag-color-${tg}`, ...fg[tg]!)];
    }),
    { name: 'cds-radius', kind: 'radius', light: '0px', role: 'radius' },
    { name: 'cds-font-family', kind: 'font-family', light: '"IBM Plex Sans", system-ui, sans-serif', role: 'font' },
  ],
  components,
};
