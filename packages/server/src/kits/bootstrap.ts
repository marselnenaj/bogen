import { eachAxis, el, icon, ICONS, text, type Css } from './markup.ts';
import type { Kit, KitComponent, Variant } from './types.ts';

/**
 * Bootstrap 5 (MIT, The Bootstrap Authors): the components as its public docs show them, with its `bs-*` CSS
 * variables and its light and dark colour modes. Code handoff writes React Bootstrap (`react-bootstrap`, MIT).
 */
const v = (name: string) => `var(--bs-${name})`;
const FONT = { fontFamily: v('body-font-family'), fontSize: '16px', lineHeight: '1.5' } as const;
const RB = 'react-bootstrap';
const THEMES = ['primary', 'secondary', 'success', 'danger', 'warning', 'info', 'light', 'dark'];
const TEXT_ON: Record<string, string> = { primary: '#ffffff', secondary: '#ffffff', success: '#ffffff', danger: '#ffffff', warning: '#000000', info: '#000000', light: '#000000', dark: '#ffffff' };

function button(variant: Variant): string {
  const look = variant.variant!;
  const outline = look.startsWith('outline-');
  const theme = outline ? look.slice(8) : look;
  const size: Css = variant.size === 'sm' ? { padding: '4px 8px', fontSize: '14px', borderRadius: v('border-radius-sm') } : variant.size === 'lg' ? { padding: '8px 16px', fontSize: '20px', borderRadius: v('border-radius-lg') } : { padding: '6px 12px', borderRadius: v('border-radius') };
  const colors: Css = look === 'link' ? { color: v('link-color'), background: 'transparent', border: '1px solid transparent', textDecoration: 'underline' } : outline ? { color: v(theme), background: 'transparent', border: `1px solid ${v(theme)}` } : { color: TEXT_ON[theme], background: v(theme), border: `1px solid ${v(theme)}` };
  return el('button', { ...FONT, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 400, flex: 'none', ...colors, ...size }, text('span', {}, 'Button', 'Label'), { type: 'button' });
}

function badge(variant: Variant): string {
  const theme = variant.bg!;
  return el('span', { fontFamily: v('body-font-family'), display: 'inline-flex', padding: '5px 9px', fontSize: '12px', fontWeight: 700, lineHeight: '1', borderRadius: variant.pill === 'true' ? '999px' : v('border-radius'), background: v(theme), color: TEXT_ON[theme], flex: 'none' }, text('span', {}, 'Badge', 'Label'));
}

function alert(variant: Variant): string {
  const theme = variant.variant!;
  return el('div', { ...FONT, width: '480px', padding: '16px', borderRadius: v('border-radius'), boxSizing: 'border-box', color: v(`${theme}-text-emphasis`), background: v(`${theme}-bg-subtle`), border: `1px solid ${v(`${theme}-border-subtle`)}` }, text('span', {}, 'A simple alert, check it out!', 'Message'), { role: 'alert' });
}

const control = (extra: Css = {}): Css => ({ ...FONT, display: 'flex', alignItems: 'center', width: '280px', padding: '6px 12px', boxSizing: 'border-box', color: v('body-color'), background: v('body-bg'), border: `1px solid ${v('border-color')}`, borderRadius: v('border-radius'), ...extra });

function formControl(variant: Variant): string {
  const look: Css = variant.state === 'invalid' ? { borderColor: v('danger') } : variant.state === 'disabled' ? { background: v('secondary-bg') } : {};
  return el('div', control(look), text('span', { color: v('secondary-color') }, 'name@example.com', 'Placeholder'), { role: 'textbox' });
}

function formSelect(): string {
  return el('div', control({ justifyContent: 'space-between' }), [text('span', {}, 'Open this select menu', 'Value'), icon(ICONS.chevronDown, 16)], { role: 'combobox' });
}

function formCheck(variant: Variant): string {
  const on = variant.checked === 'true';
  const kind = variant.type!;
  const mark = kind === 'switch'
    ? el('span', { width: '32px', height: '16px', borderRadius: '999px', boxSizing: 'border-box', border: `1px solid ${on ? v('primary') : v('border-color')}`, background: on ? v('primary') : v('body-bg'), display: 'flex', alignItems: 'center', justifyContent: on ? 'flex-end' : 'flex-start', padding: '2px', flex: 'none' }, el('span', { width: '10px', height: '10px', borderRadius: '999px', background: on ? '#ffffff' : v('border-color') }), { 'data-name': 'Switch' })
    : el('span', { width: '16px', height: '16px', boxSizing: 'border-box', borderRadius: kind === 'radio' ? '999px' : '4px', border: `1px solid ${on ? v('primary') : v('border-color')}`, background: on ? v('primary') : v('body-bg'), color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, on ? (kind === 'radio' ? el('span', { width: '6px', height: '6px', borderRadius: '999px', background: '#ffffff' }) : icon(ICONS.check, 12, 'Check', 3)) : '', { 'data-name': 'Mark' });
  return el('label', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '8px', color: v('body-color') }, [mark, text('span', {}, 'Default checkbox', 'Label')]);
}

function card(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '288px', borderRadius: v('border-radius'), border: `1px solid ${v('border-color-translucent')}`, background: v('body-bg'), color: v('body-color'), overflow: 'hidden' }, [
    el('div', { display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px' }, [
      text('h5', { margin: '0', fontSize: '20px', fontWeight: 500 }, 'Card title', 'Title'),
      text('p', { margin: '0' }, 'Some quick example text to build on the card title and make up the bulk of the card.', 'Body'),
      el('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
    ], { 'data-name': 'Card body' }),
  ]);
}

function nav(variant: Variant): string {
  const pills = variant.variant === 'pills';
  const link = (label: string, active: boolean, name: string) => el('span', { padding: '8px 16px', color: active ? (pills ? '#ffffff' : v('body-color')) : v('link-color'), background: active && pills ? v('primary') : active ? v('body-bg') : 'transparent', borderRadius: pills ? v('border-radius') : `${v('border-radius')} ${v('border-radius')} 0 0`, border: !pills ? `1px solid ${active ? v('border-color') : 'transparent'}` : undefined, borderBottomColor: !pills && active ? v('body-bg') : undefined, marginBottom: pills ? undefined : '-1px' }, text('span', {}, label, `${name} label`), { 'data-name': name });
  return el('nav', { ...FONT, display: 'flex', gap: pills ? '4px' : '0', width: '420px', borderBottom: pills ? undefined : `1px solid ${v('border-color')}` }, [link('Active', true, 'Link 1'), link('Link', false, 'Link 2'), link('Link', false, 'Link 3')]);
}

function navbar(): string {
  return el('nav', { ...FONT, display: 'flex', alignItems: 'center', gap: '16px', width: '720px', padding: '8px 16px', boxSizing: 'border-box', background: v('tertiary-bg'), color: v('body-color') }, [
    text('span', { fontSize: '20px', marginRight: '16px' }, 'Navbar', 'Brand'),
    text('span', { color: v('emphasis-color') }, 'Home', 'Link 1'), text('span', { color: v('secondary-color') }, 'Features', 'Link 2'), text('span', { color: v('secondary-color') }, 'Pricing', 'Link 3'),
  ]);
}

function breadcrumb(): string {
  return el('nav', { ...FONT, display: 'flex', gap: '8px', color: v('secondary-color') }, [text('span', { color: v('link-color'), textDecoration: 'underline' }, 'Home', 'Item 1'), text('span', {}, '/', 'Divider'), text('span', { color: v('link-color'), textDecoration: 'underline' }, 'Library', 'Item 2'), text('span', {}, '/', 'Divider 2'), text('span', {}, 'Data', 'Active')], { 'aria-label': 'breadcrumb' });
}

function pagination(): string {
  const item = (label: string, active: boolean, name: string, first = false, last = false) => el('span', { padding: '6px 12px', border: `1px solid ${v('border-color')}`, marginLeft: first ? '0' : '-1px', color: active ? '#ffffff' : v('link-color'), background: active ? v('primary') : v('body-bg'), borderColor: active ? v('primary') : v('border-color'), borderRadius: first ? `${v('border-radius')} 0 0 ${v('border-radius')}` : last ? `0 ${v('border-radius')} ${v('border-radius')} 0` : '0' }, text('span', {}, label, `${name} label`), { 'data-name': name });
  return el('nav', { ...FONT, display: 'flex' }, [item('Previous', false, 'Previous', true), item('1', false, 'Page 1'), item('2', true, 'Page 2'), item('3', false, 'Page 3'), item('Next', false, 'Next', false, true)], { 'aria-label': 'pagination' });
}

function progressBar(variant: Variant): string {
  return el('div', { width: '320px', height: '16px', borderRadius: v('border-radius'), background: v('secondary-bg'), overflow: 'hidden', display: 'flex', flex: 'none' }, el('div', { width: `${variant.now}%`, height: '100%', background: v('primary') }, [], { 'data-name': 'Bar' }), { role: 'progressbar' });
}

function spinner(variant: Variant): string {
  return variant.animation === 'grow'
    ? el('span', { width: '32px', height: '32px', borderRadius: '999px', background: v('primary'), opacity: 0.6, flex: 'none' }, [], { role: 'status' })
    : el('span', { width: '32px', height: '32px', borderRadius: '999px', border: `4px solid ${v('primary')}`, borderRightColor: 'transparent', boxSizing: 'border-box', flex: 'none' }, [], { role: 'status' });
}

function modal(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '500px', borderRadius: v('border-radius-lg'), border: `1px solid ${v('border-color-translucent')}`, background: v('body-bg'), color: v('body-color'), boxShadow: '0 8px 24px rgb(0 0 0 / 15%)' }, [
    el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px', borderBottom: `1px solid ${v('border-color')}` }, [text('h5', { margin: '0', fontSize: '20px', fontWeight: 500 }, 'Modal heading', 'Title'), icon(ICONS.x, 16, 'Close')], { 'data-name': 'Header' }),
    el('div', { padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }, text('p', { margin: '0' }, 'Woohoo, you are reading this text in a modal!', 'Body'), { 'data-name': 'Modal body', 'data-slot': 'content' }),
    el('div', { display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '12px 16px', borderTop: `1px solid ${v('border-color')}` }, [
      el('span', { padding: '6px 12px', borderRadius: v('border-radius'), background: v('secondary'), color: '#ffffff' }, text('span', {}, 'Close', 'Close label')),
      el('span', { padding: '6px 12px', borderRadius: v('border-radius'), background: v('primary'), color: '#ffffff' }, text('span', {}, 'Save changes', 'Action label')),
    ], { 'data-name': 'Footer' }),
  ], { role: 'dialog' });
}

function toast(): string {
  return el('div', { ...FONT, fontSize: '14px', width: '350px', borderRadius: v('border-radius'), border: `1px solid ${v('border-color-translucent')}`, background: v('body-bg'), color: v('body-color'), boxShadow: '0 8px 16px rgb(0 0 0 / 15%)', overflow: 'hidden' }, [
    el('div', { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderBottom: `1px solid ${v('border-color-translucent')}`, color: v('secondary-color') }, [text('strong', { flex: '1', color: v('body-color') }, 'Bootstrap', 'Title'), text('small', {}, '11 mins ago', 'Time'), icon(ICONS.x, 14, 'Close')], { 'data-name': 'Header' }),
    text('div', { padding: '12px' }, 'Hello, world! This is a toast message.', 'Body'),
  ], { role: 'status' });
}

function listGroup(): string {
  const item = (label: string, active: boolean, name: string, last = false) => text('div', { padding: '8px 16px', borderBottom: last ? '0' : `1px solid ${v('border-color')}`, background: active ? v('primary') : v('body-bg'), color: active ? '#ffffff' : v('body-color') }, label, name);
  return el('div', { ...FONT, width: '288px', border: `1px solid ${v('border-color')}`, borderRadius: v('border-radius'), overflow: 'hidden' }, [item('An active item', true, 'Item 1'), item('A second item', false, 'Item 2'), item('A third item', false, 'Item 3', true)]);
}

function table(): string {
  const cell = (value: string, head: boolean, name: string) => text(head ? 'th' : 'td', { padding: '8px', textAlign: 'left', borderBottom: `1px solid ${v('border-color')}`, fontWeight: head ? 700 : 400 }, value, name);
  return el('table', { ...FONT, width: '480px', borderCollapse: 'collapse', color: v('body-color') }, [
    el('thead', {}, el('tr', {}, ['#', 'First', 'Last', 'Handle'].map((h, i) => cell(h, true, `Head ${i + 1}`)))),
    el('tbody', {}, [['1', 'Mark', 'Otto', '@mdo'], ['2', 'Jacob', 'Thornton', '@fat']].map((row, r) => el('tr', {}, row.map((x, i) => cell(x, false, `Cell ${r + 1}.${i + 1}`))))),
  ]);
}

const LABEL = [{ name: 'label', type: 'text' as const, target: 'Label' }];
const BUTTON_AXES = { variant: ['primary', 'secondary', 'success', 'danger', 'warning', 'info', 'light', 'dark', 'outline-primary', 'outline-secondary', 'link'], size: ['md', 'sm', 'lg'] };

const components: KitComponent[] = [
  { name: 'Button', group: 'Actions', description: 'Buttons in every theme colour, outline and link, in three sizes.', axes: BUTTON_AXES, members: eachAxis(BUTTON_AXES), props: LABEL, html: button, handoff: { from: RB, name: 'Button', props: { label: 'children', size: 'size' }, values: { size: { md: '' } } } },
  { name: 'Badge', group: 'Content', description: 'Small count and labelling component.', axes: { bg: THEMES, pill: ['false', 'true'] }, members: eachAxis({ bg: THEMES, pill: ['false', 'true'] }), props: LABEL, html: badge, handoff: { from: RB, name: 'Badge', props: { label: 'children', pill: '' }, flags: { pill: { true: 'pill' } } } },
  { name: 'Alert', group: 'Feedback', description: 'Contextual feedback messages.', axes: { variant: THEMES }, props: [{ name: 'message', type: 'text', target: 'Message' }], html: alert, handoff: { from: RB, name: 'Alert', props: { message: 'children' } } },
  { name: 'Card', group: 'Content', description: 'A flexible content container.', props: [{ name: 'title', type: 'text', target: 'Title' }, { name: 'body', type: 'text', target: 'Body' }], html: card, handoff: { from: RB, name: 'Card', props: { title: '', body: '' }, usage: '<Card{{attrs}}>\n  <Card.Body>\n    <Card.Title>{{title}}</Card.Title>\n    <Card.Text>{{body}}</Card.Text>\n    {{children}}\n  </Card.Body>\n</Card>' } },
  { name: 'Form control', group: 'Forms', description: 'Text input with valid, invalid and disabled states.', axes: { state: ['default', 'invalid', 'disabled'] }, props: [{ name: 'placeholder', type: 'text', target: 'Placeholder' }], html: formControl, handoff: { from: RB, name: 'Form', props: { state: '' }, flags: { state: { invalid: 'isInvalid', disabled: 'disabled' } }, usage: '<Form.Control type="email" placeholder="{{placeholder}}"{{attrs}} />' } },
  { name: 'Form select', group: 'Forms', description: 'A native select menu, styled.', props: [{ name: 'value', type: 'text', target: 'Value' }], html: formSelect, handoff: { from: RB, name: 'Form', props: { value: '' }, usage: '<Form.Select{{attrs}}>\n  <option>{{value}}</option>\n</Form.Select>' } },
  { name: 'Form check', group: 'Forms', description: 'Checkboxes, radios and switches.', axes: { type: ['checkbox', 'radio', 'switch'], checked: ['false', 'true'] }, props: LABEL, html: formCheck, handoff: { from: RB, name: 'Form', props: { checked: '', label: '' }, flags: { checked: { true: 'defaultChecked' } }, usage: '<Form.Check label="{{label}}"{{attrs}} />' } },
  { name: 'Nav', group: 'Navigation', description: 'Tabs and pills.', axes: { variant: ['tabs', 'pills'] }, html: nav, handoff: { from: RB, name: 'Nav', usage: '<Nav defaultActiveKey="active"{{attrs}}>\n  <Nav.Item><Nav.Link eventKey="active">Active</Nav.Link></Nav.Item>\n  <Nav.Item><Nav.Link eventKey="link-1">Link</Nav.Link></Nav.Item>\n  <Nav.Item><Nav.Link eventKey="link-2">Link</Nav.Link></Nav.Item>\n</Nav>' } },
  { name: 'Navbar', group: 'Navigation', description: 'A responsive navigation header.', props: [{ name: 'brand', type: 'text', target: 'Brand' }], html: navbar, handoff: { from: RB, name: 'Navbar', imports: ['Container', 'Nav'], props: { brand: '' }, usage: '<Navbar bg="body-tertiary"{{attrs}}>\n  <Container>\n    <Navbar.Brand href="#home">{{brand}}</Navbar.Brand>\n    <Nav>\n      <Nav.Link href="#home">Home</Nav.Link>\n      <Nav.Link href="#features">Features</Nav.Link>\n      <Nav.Link href="#pricing">Pricing</Nav.Link>\n    </Nav>\n  </Container>\n</Navbar>' } },
  { name: 'Breadcrumb', group: 'Navigation', description: 'The current page\'s location within a navigational hierarchy.', html: breadcrumb, handoff: { from: RB, name: 'Breadcrumb', usage: '<Breadcrumb{{attrs}}>\n  <Breadcrumb.Item href="#">Home</Breadcrumb.Item>\n  <Breadcrumb.Item href="#">Library</Breadcrumb.Item>\n  <Breadcrumb.Item active>Data</Breadcrumb.Item>\n</Breadcrumb>' } },
  { name: 'Pagination', group: 'Navigation', description: 'Pagination across a series of pages.', html: pagination, handoff: { from: RB, name: 'Pagination', usage: '<Pagination{{attrs}}>\n  <Pagination.Prev />\n  <Pagination.Item>1</Pagination.Item>\n  <Pagination.Item active>2</Pagination.Item>\n  <Pagination.Item>3</Pagination.Item>\n  <Pagination.Next />\n</Pagination>' } },
  { name: 'Progress bar', group: 'Feedback', description: 'A progress bar.', axes: { now: ['60', '25', '100'] }, html: progressBar, handoff: { from: RB, name: 'ProgressBar', props: { now: '' }, flags: { now: { 60: 'now={60}', 25: 'now={25}', 100: 'now={100}' } } } },
  { name: 'Spinner', group: 'Feedback', description: 'A loading indicator, border or grow.', axes: { animation: ['border', 'grow'] }, html: spinner, handoff: { from: RB, name: 'Spinner' } },
  { name: 'Modal', group: 'Overlays', description: 'A dialog with a header, body and footer.', props: [{ name: 'title', type: 'text', target: 'Title' }, { name: 'action', type: 'text', target: 'Action label' }], html: modal, handoff: { from: RB, name: 'Modal', imports: ['Button'], props: { title: '', action: '' }, usage: '<Modal show{{attrs}}>\n  <Modal.Header closeButton>\n    <Modal.Title>{{title}}</Modal.Title>\n  </Modal.Header>\n  <Modal.Body>{{children}}</Modal.Body>\n  <Modal.Footer>\n    <Button variant="secondary">Close</Button>\n    <Button variant="primary">{{action}}</Button>\n  </Modal.Footer>\n</Modal>' } },
  { name: 'Toast', group: 'Overlays', description: 'A lightweight notification.', props: [{ name: 'title', type: 'text', target: 'Title' }, { name: 'body', type: 'text', target: 'Body' }], html: toast, handoff: { from: RB, name: 'Toast', props: { title: '', body: '' }, usage: '<Toast{{attrs}}>\n  <Toast.Header>\n    <strong className="me-auto">{{title}}</strong>\n    <small>11 mins ago</small>\n  </Toast.Header>\n  <Toast.Body>{{body}}</Toast.Body>\n</Toast>' } },
  { name: 'List group', group: 'Content', description: 'A series of content in a list.', html: listGroup, handoff: { from: RB, name: 'ListGroup', usage: '<ListGroup{{attrs}}>\n  <ListGroup.Item active>An active item</ListGroup.Item>\n  <ListGroup.Item>A second item</ListGroup.Item>\n  <ListGroup.Item>A third item</ListGroup.Item>\n</ListGroup>' } },
  { name: 'Table', group: 'Content', description: 'A table with Bootstrap\'s styles.', html: table, handoff: { from: RB, name: 'Table', usage: '<Table{{attrs}}>\n  <thead>\n    <tr><th>#</th><th>First</th><th>Last</th><th>Handle</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>1</td><td>Mark</td><td>Otto</td><td>@mdo</td></tr>\n  </tbody>\n</Table>' } },
];

const theme = (name: string, light: string, dark: string, role?: 'primary' | 'secondary' | 'danger') => ({ name: `bs-${name}`, kind: 'color' as const, light, dark, ...(role ? { role } : {}) });

export const bootstrapKit: Kit = {
  id: 'bootstrap-5',
  name: 'Bootstrap 5',
  description: 'Bootstrap 5 components with its CSS variables and its light and dark colour modes.',
  platform: 'web',
  library: { name: 'React Bootstrap', package: 'react-bootstrap', license: 'MIT', url: 'https://getbootstrap.com' },
  font: 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  version: 1,
  tokens: [
    theme('primary', '#0d6efd', '#0d6efd', 'primary'), theme('secondary', '#6c757d', '#6c757d', 'secondary'), theme('success', '#198754', '#198754'),
    theme('danger', '#dc3545', '#dc3545', 'danger'), theme('warning', '#ffc107', '#ffc107'), theme('info', '#0dcaf0', '#0dcaf0'), theme('light', '#f8f9fa', '#f8f9fa'), theme('dark', '#212529', '#212529'),
    ...THEMES.flatMap((t) => [
      theme(`${t}-text-emphasis`, ({ primary: '#052c65', secondary: '#2b2f32', success: '#0a3622', danger: '#58151c', warning: '#664d03', info: '#055160', light: '#495057', dark: '#495057' } as Record<string, string>)[t]!, ({ primary: '#6ea8fe', secondary: '#a7acb1', success: '#75b798', danger: '#ea868f', warning: '#ffda6a', info: '#6edff6', light: '#f8f9fa', dark: '#dee2e6' } as Record<string, string>)[t]!),
      theme(`${t}-bg-subtle`, ({ primary: '#cfe2ff', secondary: '#e2e3e5', success: '#d1e7dd', danger: '#f8d7da', warning: '#fff3cd', info: '#cff4fc', light: '#fcfcfd', dark: '#ced4da' } as Record<string, string>)[t]!, ({ primary: '#031633', secondary: '#161719', success: '#051b11', danger: '#2c0b0e', warning: '#332701', info: '#032830', light: '#343a40', dark: '#1a1d20' } as Record<string, string>)[t]!),
      theme(`${t}-border-subtle`, ({ primary: '#9ec5fe', secondary: '#c4c8cb', success: '#a3cfbb', danger: '#f1aeb5', warning: '#ffe69c', info: '#9eeaf9', light: '#e9ecef', dark: '#adb5bd' } as Record<string, string>)[t]!, ({ primary: '#084298', secondary: '#41464b', success: '#0f5132', danger: '#842029', warning: '#997404', info: '#087990', light: '#495057', dark: '#343a40' } as Record<string, string>)[t]!),
    ]),
    { name: 'bs-body-bg', kind: 'color', light: '#ffffff', dark: '#212529', role: 'background' },
    { name: 'bs-body-color', kind: 'color', light: '#212529', dark: '#dee2e6', role: 'foreground' },
    { name: 'bs-emphasis-color', kind: 'color', light: '#000000', dark: '#ffffff' },
    { name: 'bs-secondary-color', kind: 'color', light: 'rgba(33, 37, 41, 0.75)', dark: 'rgba(222, 226, 230, 0.75)', role: 'muted' },
    { name: 'bs-secondary-bg', kind: 'color', light: '#e9ecef', dark: '#343a40' },
    { name: 'bs-tertiary-bg', kind: 'color', light: '#f8f9fa', dark: '#2b3035', role: 'surface' },
    { name: 'bs-border-color', kind: 'color', light: '#dee2e6', dark: '#495057', role: 'border' },
    { name: 'bs-border-color-translucent', kind: 'color', light: 'rgba(0, 0, 0, 0.175)', dark: 'rgba(255, 255, 255, 0.15)' },
    { name: 'bs-link-color', kind: 'color', light: '#0d6efd', dark: '#6ea8fe' },
    { name: 'bs-border-radius', kind: 'radius', light: '0.375rem', role: 'radius' },
    { name: 'bs-border-radius-sm', kind: 'radius', light: '0.25rem' },
    { name: 'bs-border-radius-lg', kind: 'radius', light: '0.5rem' },
    { name: 'bs-body-font-family', kind: 'font-family', light: 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', role: 'font' },
  ],
  components,
};
