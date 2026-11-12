import { el, icon, ICONS, text, type Css } from './markup.ts';
import type { Kit, KitComponent, KitProp, Variant } from './types.ts';

/**
 * Material Design 3 (the guidelines and their tokens are Apache-2.0, Google), as a phone kit at 412 wide: its
 * `md-sys-color-*` roles from the baseline scheme in light and dark, its shapes and its type in Roboto (Apache-2.0,
 * on Google Fonts). Bogen's own drawing from the public guidelines. Handoff writes MUI (`@mui/material`, MIT), in
 * MUI's props: M3's filled button is MUI's `contained`, outlined stays `outlined`, and so on.
 */
const v = (name: string) => `var(--md-sys-color-${name})`;
const MUI = '@mui/material';
const FONT = { fontFamily: 'var(--md-ref-typeface-plain)', fontSize: '14px', lineHeight: '20px', letterSpacing: '0.25px', color: v('on-surface') } as const;
const LABEL_LARGE: Css = { fontSize: '14px', lineHeight: '20px', fontWeight: 500, letterSpacing: '0.1px' };
const W = '412px';
const ELEVATION_1 = '0 1px 2px rgb(0 0 0 / 0.3), 0 1px 3px 1px rgb(0 0 0 / 0.15)';
const ELEVATION_3 = '0 1px 3px rgb(0 0 0 / 0.3), 0 4px 8px 3px rgb(0 0 0 / 0.15)';

const BUTTONS: Record<string, Css> = {
  filled: { background: v('primary'), color: v('on-primary') },
  tonal: { background: v('secondary-container'), color: v('on-secondary-container') },
  outlined: { color: v('primary'), border: `1px solid ${v('outline')}` },
  text: { color: v('primary'), padding: '0 12px' },
  elevated: { background: v('surface-container-low'), color: v('primary'), boxShadow: ELEVATION_1 },
};

function button(variant: Variant): string {
  return el('button', { ...FONT, ...LABEL_LARGE, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px', height: '40px', padding: '0 24px', boxSizing: 'border-box', borderRadius: '20px', border: '0', background: 'transparent', flex: 'none', ...BUTTONS[variant.variant!] }, text('span', {}, 'Button', 'Label'), { type: 'button' });
}

function fab(variant: Variant): string {
  const size = variant.size!;
  const box = size === 'small' ? { width: '40px', height: '40px', borderRadius: '12px' } : size === 'large' ? { width: '96px', height: '96px', borderRadius: '28px' } : { width: '56px', height: '56px', borderRadius: '16px' };
  return el('button', { ...box, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '0', background: v('primary-container'), color: v('on-primary-container'), boxShadow: ELEVATION_3, flex: 'none' }, icon(ICONS.edit, size === 'large' ? 36 : 24), { type: 'button', 'aria-label': 'Edit' });
}

function iconButton(variant: Variant): string {
  const look: Css = variant.variant === 'filled' ? { background: v('primary'), color: v('on-primary') } : variant.variant === 'tonal' ? { background: v('secondary-container'), color: v('on-secondary-container') } : variant.variant === 'outlined' ? { border: `1px solid ${v('outline')}`, color: v('on-surface-variant') } : { color: v('on-surface-variant') };
  return el('button', { width: '40px', height: '40px', boxSizing: 'border-box', borderRadius: '20px', border: '0', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', ...look }, icon(ICONS.heart, 24), { type: 'button', 'aria-label': 'Favourite' });
}

function chip(variant: Variant): string {
  const on = variant.selected === 'true';
  return el('span', { ...FONT, ...LABEL_LARGE, display: 'inline-flex', alignItems: 'center', gap: '8px', height: '32px', padding: on ? '0 16px 0 8px' : '0 16px', boxSizing: 'border-box', borderRadius: '8px', border: on ? '0' : `1px solid ${v('outline')}`, background: on ? v('secondary-container') : 'transparent', color: on ? v('on-secondary-container') : v('on-surface-variant'), flex: 'none' }, [on ? icon(ICONS.check, 18) : '', text('span', {}, 'Filter', 'Label')]);
}

function textField(variant: Variant): string {
  const filled = variant.variant === 'filled';
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '280px', gap: '4px' }, [
    el('div', { display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '56px', padding: '0 16px', boxSizing: 'border-box', borderRadius: filled ? '4px 4px 0 0' : '4px', background: filled ? v('surface-container-highest') : 'transparent', border: filled ? undefined : `1px solid ${v('outline')}`, borderBottom: filled ? `1px solid ${v('on-surface-variant')}` : undefined }, [
      text('span', { fontSize: '12px', lineHeight: '16px', letterSpacing: '0.4px', color: v('on-surface-variant') }, 'Label', 'Label'),
      text('span', { fontSize: '16px', lineHeight: '24px', letterSpacing: '0.5px' }, 'Input text', 'Value'),
    ], { 'data-name': 'Field' }),
    text('span', { fontSize: '12px', lineHeight: '16px', letterSpacing: '0.4px', color: v('on-surface-variant'), padding: '0 16px' }, 'Supporting text', 'Supporting'),
  ]);
}

function checkbox(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('span', { width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' },
    el('span', { width: '18px', height: '18px', boxSizing: 'border-box', borderRadius: '2px', border: on ? '0' : `2px solid ${v('on-surface-variant')}`, background: on ? v('primary') : 'transparent', color: v('on-primary'), display: 'flex', alignItems: 'center', justifyContent: 'center' }, on ? icon(ICONS.check, 14, 'Check', 3) : '', { 'data-name': 'Box' }), { role: 'checkbox' });
}

function switchControl(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('span', { width: '52px', height: '32px', boxSizing: 'border-box', borderRadius: '16px', border: on ? '0' : `2px solid ${v('outline')}`, background: on ? v('primary') : v('surface-container-highest'), display: 'flex', alignItems: 'center', justifyContent: on ? 'flex-end' : 'flex-start', padding: on ? '0 4px' : '0 6px', flex: 'none' },
    el('span', { width: on ? '24px' : '16px', height: on ? '24px' : '16px', borderRadius: '999px', background: on ? v('on-primary') : v('outline') }, [], { 'data-name': 'Handle' }), { role: 'switch' });
}

function radio(variant: Variant): string {
  const on = variant.selected === 'true';
  return el('span', { width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' },
    el('span', { width: '20px', height: '20px', boxSizing: 'border-box', borderRadius: '999px', border: `2px solid ${on ? v('primary') : v('on-surface-variant')}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }, on ? el('span', { width: '10px', height: '10px', borderRadius: '999px', background: v('primary') }) : '', { 'data-name': 'Ring' }), { role: 'radio' });
}

function topAppBar(variant: Variant): string {
  const kind = variant.size!;
  const bar = el('div', { display: 'flex', alignItems: 'center', gap: '4px', height: '64px', padding: '0 4px' }, [
    el('span', { width: '48px', height: '48px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: v('on-surface') }, icon(ICONS.arrowLeft, 24, 'Navigation')),
    kind === 'small' ? text('span', { flex: '1', fontSize: '22px', lineHeight: '28px' }, 'Title', 'Title') : kind === 'center' ? text('span', { flex: '1', fontSize: '22px', lineHeight: '28px', textAlign: 'center' }, 'Title', 'Title') : el('span', { flex: '1' }),
    el('span', { width: '48px', height: '48px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: v('on-surface-variant') }, icon(ICONS.more, 24, 'Action')),
  ]);
  return el('header', { ...FONT, display: 'flex', flexDirection: 'column', width: W, background: v('surface'), color: v('on-surface') }, [
    bar,
    kind === 'large' ? text('span', { padding: '0 16px 28px', fontSize: '28px', lineHeight: '36px' }, 'Title', 'Title') : '',
  ]);
}

function navigationBar(): string {
  const item = (label: string, ic: string, active: boolean, name: string) => el('div', { flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', paddingTop: '12px' }, [
    el('span', { width: '64px', height: '32px', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: active ? v('secondary-container') : 'transparent', color: active ? v('on-secondary-container') : v('on-surface-variant') }, icon(ic, 24), { 'data-name': `${name} indicator` }),
    text('span', { fontSize: '12px', lineHeight: '16px', fontWeight: 500, letterSpacing: '0.5px', color: active ? v('on-surface') : v('on-surface-variant') }, label, `${name} label`),
  ], { 'data-name': name });
  return el('nav', { ...FONT, display: 'flex', width: W, height: '80px', boxSizing: 'border-box', background: v('surface-container') }, [item('Home', ICONS.home, true, 'Item 1'), item('Search', ICONS.search, false, 'Item 2'), item('Saved', ICONS.star, false, 'Item 3'), item('Profile', ICONS.user, false, 'Item 4')]);
}

function card(variant: Variant): string {
  const look: Css = variant.variant === 'elevated' ? { background: v('surface-container-low'), boxShadow: ELEVATION_1 } : variant.variant === 'filled' ? { background: v('surface-container-highest') } : { background: v('surface'), border: `1px solid ${v('outline-variant')}` };
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', width: '360px', padding: '16px', boxSizing: 'border-box', borderRadius: '12px', ...look }, [
    text('div', { fontSize: '16px', lineHeight: '24px', fontWeight: 500, letterSpacing: '0.15px' }, 'Card title', 'Title'),
    text('div', { color: v('on-surface-variant') }, 'Supporting text that says what the card is about.', 'Body'),
    el('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
  ]);
}

function listItem(variant: Variant): string {
  const two = variant.lines === '2';
  return el('div', { ...FONT, display: 'flex', alignItems: 'center', gap: '16px', width: W, minHeight: two ? '72px' : '56px', padding: '8px 24px 8px 16px', boxSizing: 'border-box', background: v('surface') }, [
    el('span', { width: '40px', height: '40px', borderRadius: '999px', background: v('primary-container'), color: v('on-primary-container'), display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 500, flex: 'none' }, text('span', {}, 'A', 'Initial'), { 'data-name': 'Avatar' }),
    el('div', { flex: '1', display: 'flex', flexDirection: 'column' }, [
      text('span', { fontSize: '16px', lineHeight: '24px', letterSpacing: '0.5px' }, 'List item', 'Headline'),
      two ? text('span', { color: v('on-surface-variant') }, 'Supporting text', 'Supporting') : '',
    ]),
    el('span', { display: 'flex', color: v('on-surface-variant') }, icon(ICONS.chevronRight, 24, 'Trailing')),
  ], { role: 'listitem' });
}

function dialog(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '16px', width: '312px', padding: '24px', boxSizing: 'border-box', borderRadius: '28px', background: v('surface-container-high') }, [
    text('div', { fontSize: '24px', lineHeight: '32px' }, 'Discard draft?', 'Title'),
    text('div', { color: v('on-surface-variant') }, 'Your changes will not be saved.', 'Body'),
    el('div', { display: 'flex', justifyContent: 'flex-end', gap: '8px', paddingTop: '8px' }, [
      text('span', { ...LABEL_LARGE, padding: '10px 12px', color: v('primary') }, 'Cancel', 'Dismiss'),
      text('span', { ...LABEL_LARGE, padding: '10px 12px', color: v('primary') }, 'Discard', 'Confirm'),
    ], { 'data-name': 'Actions' }),
  ], { role: 'dialog' });
}

function snackbar(): string {
  return el('div', { ...FONT, display: 'flex', alignItems: 'center', gap: '8px', width: '344px', minHeight: '48px', padding: '4px 8px 4px 16px', boxSizing: 'border-box', borderRadius: '4px', background: v('inverse-surface'), color: v('inverse-on-surface'), boxShadow: ELEVATION_3 }, [
    text('span', { flex: '1' }, 'Photo saved', 'Message'),
    text('span', { ...LABEL_LARGE, padding: '10px 12px', color: v('inverse-primary') }, 'Undo', 'Action'),
  ], { role: 'status' });
}

function progress(variant: Variant): string {
  return el('div', { width: '300px', height: '4px', display: 'flex', gap: '4px', flex: 'none' }, [
    el('div', { width: `${variant.value}%`, height: '100%', borderRadius: '2px', background: v('primary') }, [], { 'data-name': 'Indicator' }),
    el('div', { flex: '1', height: '100%', borderRadius: '2px', background: v('secondary-container') }, [], { 'data-name': 'Track' }),
  ], { role: 'progressbar' });
}

function slider(): string {
  return el('div', { width: '300px', height: '44px', display: 'flex', alignItems: 'center', gap: '6px', flex: 'none' }, [
    el('div', { width: '50%', height: '16px', borderRadius: '8px 2px 2px 8px', background: v('primary') }, [], { 'data-name': 'Active track' }),
    el('span', { width: '4px', height: '44px', borderRadius: '2px', background: v('primary'), flex: 'none' }, [], { 'data-name': 'Handle' }),
    el('div', { flex: '1', height: '16px', borderRadius: '2px 8px 8px 2px', background: v('secondary-container') }, [], { 'data-name': 'Inactive track' }),
  ], { role: 'slider' });
}

function tabs(): string {
  const tab = (label: string, active: boolean, name: string) => el('div', { flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '48px' }, [
    text('span', { ...LABEL_LARGE, paddingBottom: '14px', color: active ? v('primary') : v('on-surface-variant') }, label, `${name} label`),
    el('span', { width: '60%', height: '3px', borderRadius: '3px 3px 0 0', background: active ? v('primary') : 'transparent' }, [], { 'data-name': `${name} indicator` }),
  ], { 'data-name': name, role: 'tab' });
  return el('div', { ...FONT, display: 'flex', width: W, background: v('surface'), borderBottom: `1px solid ${v('surface-variant')}` }, [tab('Flights', true, 'Tab 1'), tab('Trips', false, 'Tab 2'), tab('Explore', false, 'Tab 3')], { role: 'tablist' });
}

function badge(): string {
  return el('span', { ...FONT, minWidth: '16px', height: '16px', padding: '0 4px', boxSizing: 'border-box', borderRadius: '8px', background: v('error'), color: v('on-error'), fontSize: '11px', lineHeight: '16px', fontWeight: 500, textAlign: 'center', flex: 'none' }, text('span', {}, '3', 'Label'));
}

function searchBar(): string {
  return el('div', { ...FONT, display: 'flex', alignItems: 'center', gap: '16px', width: '360px', height: '56px', padding: '0 16px', boxSizing: 'border-box', borderRadius: '28px', background: v('surface-container-high'), color: v('on-surface-variant') }, [icon(ICONS.menu, 24, 'Leading'), text('span', { flex: '1', fontSize: '16px', lineHeight: '24px', letterSpacing: '0.5px' }, 'Search', 'Placeholder'), icon(ICONS.search, 24, 'Trailing')], { role: 'search' });
}

const TEXT = (name: string, target: string): KitProp => ({ name, type: 'text', target });

const components: KitComponent[] = [
  { name: 'Button', group: 'Actions', description: 'Common buttons: filled, tonal, outlined, text and elevated.', axes: { variant: ['filled', 'tonal', 'outlined', 'text', 'elevated'] }, props: [TEXT('label', 'Label')], html: button, handoff: { from: MUI, name: 'Button', props: { label: 'children' }, values: { variant: { filled: 'contained', tonal: 'contained', outlined: 'outlined', text: 'text', elevated: 'contained' } }, flags: { variant: { filled: 'variant="contained"', tonal: 'color="secondary"', elevated: 'color="inherit"' } } } },
  { name: 'FAB', group: 'Actions', description: 'A floating action button in three sizes.', axes: { size: ['medium', 'small', 'large'] }, html: fab, handoff: { from: MUI, name: 'Fab', more: [{ from: '@mui/icons-material', imports: ['Edit'] }], props: { size: 'size' }, values: { size: { medium: 'medium', small: 'small', large: 'large' } }, usage: '<Fab color="primary" aria-label="edit"{{attrs}}>\n  <Edit />\n</Fab>' } },
  { name: 'Icon button', group: 'Actions', description: 'An icon as a button: standard, filled, tonal or outlined.', axes: { variant: ['standard', 'filled', 'tonal', 'outlined'] }, html: iconButton, handoff: { from: MUI, name: 'IconButton', more: [{ from: '@mui/icons-material', imports: ['Favorite'] }], props: { variant: '' }, flags: { variant: { filled: 'color="primary"', tonal: 'color="secondary"' } }, usage: '<IconButton aria-label="favourite"{{attrs}}>\n  <Favorite />\n</IconButton>' } },
  { name: 'Chip', group: 'Actions', description: 'A filter chip, selected or not.', axes: { selected: ['false', 'true'] }, props: [TEXT('label', 'Label')], html: chip, handoff: { from: MUI, name: 'Chip', props: { selected: '', label: 'label' }, flags: { selected: { false: 'variant="outlined"', true: 'color="secondary"' } } } },
  { name: 'Text field', group: 'Forms', description: 'A text field, filled or outlined, with a label and supporting text.', axes: { variant: ['filled', 'outlined'] }, props: [TEXT('label', 'Label'), TEXT('value', 'Value'), TEXT('helper', 'Supporting')], html: textField, handoff: { from: MUI, name: 'TextField', props: { label: 'label', value: 'defaultValue', helper: 'helperText', variant: '' }, flags: { variant: { filled: 'variant="filled"', outlined: 'variant="outlined"' } } } },
  { name: 'Checkbox', group: 'Forms', description: 'A checkbox in its touch target.', axes: { checked: ['false', 'true'] }, html: checkbox, handoff: { from: MUI, name: 'Checkbox', props: { checked: '' }, flags: { checked: { true: 'defaultChecked' } } } },
  { name: 'Switch', group: 'Forms', description: 'A switch, off or on.', axes: { checked: ['false', 'true'] }, html: switchControl, handoff: { from: MUI, name: 'Switch', props: { checked: '' }, flags: { checked: { true: 'defaultChecked' } } } },
  { name: 'Radio button', group: 'Forms', description: 'A radio button in its touch target.', axes: { selected: ['false', 'true'] }, html: radio, handoff: { from: MUI, name: 'Radio', props: { selected: '' }, flags: { selected: { true: 'checked' } } } },
  { name: 'Slider', group: 'Forms', description: 'A slider with its handle.', html: slider, handoff: { from: MUI, name: 'Slider', usage: '<Slider aria-label="Value"{{attrs}} />' } },
  { name: 'Search bar', group: 'Forms', description: 'A search bar with a menu and a search icon.', props: [TEXT('placeholder', 'Placeholder')], html: searchBar, handoff: { from: MUI, name: 'TextField', props: { placeholder: 'placeholder' }, usage: '<TextField placeholder="{{placeholder}}" variant="filled" fullWidth{{attrs}} />' } },
  { name: 'Top app bar', group: 'Navigation', description: 'The bar at the top of a screen: small, centre-aligned or large.', axes: { size: ['small', 'center', 'large'] }, props: [TEXT('title', 'Title')], html: topAppBar, handoff: { from: MUI, name: 'AppBar', imports: ['IconButton', 'Toolbar', 'Typography'], more: [{ from: '@mui/icons-material', imports: ['ArrowBack', 'MoreVert'] }], props: { title: '', size: '' }, usage: '<AppBar position="static" color="inherit"{{attrs}}>\n  <Toolbar>\n    <IconButton edge="start" aria-label="back"><ArrowBack /></IconButton>\n    <Typography variant="h6" component="div">{{title}}</Typography>\n    <IconButton edge="end" aria-label="more"><MoreVert /></IconButton>\n  </Toolbar>\n</AppBar>' } },
  { name: 'Navigation bar', group: 'Navigation', description: 'The bar at the bottom of a phone app.', html: navigationBar, handoff: { from: MUI, name: 'BottomNavigation', imports: ['BottomNavigationAction'], usage: '<BottomNavigation showLabels{{attrs}}>\n  <BottomNavigationAction label="Home" />\n  <BottomNavigationAction label="Search" />\n  <BottomNavigationAction label="Saved" />\n  <BottomNavigationAction label="Profile" />\n</BottomNavigation>' } },
  { name: 'Tabs', group: 'Navigation', description: 'Primary tabs with an indicator.', html: tabs, handoff: { from: MUI, name: 'Tabs', imports: ['Tab'], usage: '<Tabs value="flights"{{attrs}}>\n  <Tab value="flights" label="Flights" />\n  <Tab value="trips" label="Trips" />\n  <Tab value="explore" label="Explore" />\n</Tabs>' } },
  { name: 'Card', group: 'Content', description: 'A card: elevated, filled or outlined, with a slot.', axes: { variant: ['elevated', 'filled', 'outlined'] }, props: [TEXT('title', 'Title'), TEXT('body', 'Body')], html: card, handoff: { from: MUI, name: 'Card', imports: ['CardContent', 'Typography'], props: { title: '', body: '', variant: '' }, flags: { variant: { outlined: 'variant="outlined"' } }, usage: '<Card{{attrs}}>\n  <CardContent>\n    <Typography variant="h6">{{title}}</Typography>\n    <Typography variant="body2" color="text.secondary">{{body}}</Typography>\n    {{children}}\n  </CardContent>\n</Card>' } },
  { name: 'List item', group: 'Content', description: 'A list row with an avatar, one or two lines, and a trailing icon.', axes: { lines: ['1', '2'] }, props: [TEXT('headline', 'Headline'), TEXT('supporting', 'Supporting')], html: listItem, handoff: { from: MUI, name: 'ListItem', imports: ['Avatar', 'ListItemAvatar', 'ListItemButton', 'ListItemText'], props: { headline: '', supporting: '', lines: '' }, usage: '<ListItem disablePadding{{attrs}}>\n  <ListItemButton>\n    <ListItemAvatar><Avatar>A</Avatar></ListItemAvatar>\n    <ListItemText primary="{{headline}}" secondary="{{supporting}}" />\n  </ListItemButton>\n</ListItem>' } },
  { name: 'Badge', group: 'Content', description: 'A small count.', props: [TEXT('label', 'Label')], html: badge, handoff: { from: MUI, name: 'Badge', more: [{ from: '@mui/icons-material', imports: ['Mail'] }], props: { label: '' }, usage: '<Badge badgeContent="{{label}}" color="error"{{attrs}}>\n  <Mail />\n</Badge>' } },
  { name: 'Dialog', group: 'Overlays', description: 'A basic dialog with a title, text and two actions.', props: [TEXT('title', 'Title'), TEXT('body', 'Body')], html: dialog, handoff: { from: MUI, name: 'Dialog', imports: ['Button', 'DialogActions', 'DialogContent', 'DialogContentText', 'DialogTitle'], props: { title: '', body: '' }, usage: '<Dialog open{{attrs}}>\n  <DialogTitle>{{title}}</DialogTitle>\n  <DialogContent>\n    <DialogContentText>{{body}}</DialogContentText>\n  </DialogContent>\n  <DialogActions>\n    <Button>Cancel</Button>\n    <Button>Discard</Button>\n  </DialogActions>\n</Dialog>' } },
  { name: 'Snackbar', group: 'Feedback', description: 'A short message at the bottom, with an action.', props: [TEXT('message', 'Message')], html: snackbar, handoff: { from: MUI, name: 'Snackbar', props: { message: '' }, usage: '<Snackbar open message="{{message}}"{{attrs}} />' } },
  { name: 'Linear progress', group: 'Feedback', description: 'Determinate progress with its track.', axes: { value: ['60', '25', '100'] }, html: progress, handoff: { from: MUI, name: 'LinearProgress', props: { value: '' }, flags: { value: { 60: 'value={60}', 25: 'value={25}', 100: 'value={100}' } }, usage: '<LinearProgress variant="determinate"{{attrs}} />' } },
];

const role = (name: string, light: string, dark: string, r?: Kit['tokens'][number]['role']) => ({ name: `md-sys-color-${name}`, kind: 'color' as const, light, dark, ...(r ? { role: r } : {}) });

export const materialKit: Kit = {
  id: 'material-3',
  name: 'Material 3',
  description: 'A phone kit after Material Design 3: its colour roles from the baseline scheme in light and dark, its shapes and type, at 412 wide.',
  platform: 'android',
  library: { name: 'MUI', package: '@mui/material', license: 'MIT', url: 'https://mui.com/material-ui/' },
  design: { name: 'Material Design 3', license: 'Apache-2.0', url: 'https://m3.material.io' },
  font: 'Roboto, system-ui, sans-serif',
  version: 1,
  tokens: [
    role('primary', '#6750a4', '#d0bcff', 'primary'), role('on-primary', '#ffffff', '#381e72', 'on-primary'),
    role('primary-container', '#eaddff', '#4f378b'), role('on-primary-container', '#21005d', '#eaddff'),
    role('secondary', '#625b71', '#ccc2dc', 'secondary'), role('on-secondary', '#ffffff', '#332d41'),
    role('secondary-container', '#e8def8', '#4a4458'), role('on-secondary-container', '#1d192b', '#e8def8'),
    role('tertiary', '#7d5260', '#efb8c8', 'accent'), role('on-tertiary', '#ffffff', '#492532'),
    role('error', '#b3261e', '#f2b8b5', 'danger'), role('on-error', '#ffffff', '#601410'),
    role('surface', '#fef7ff', '#141218', 'background'), role('on-surface', '#1d1b20', '#e6e0e9', 'foreground'),
    role('surface-variant', '#e7e0ec', '#49454f'), role('on-surface-variant', '#49454f', '#cac4d0', 'muted'),
    role('outline', '#79747e', '#938f99', 'border'), role('outline-variant', '#cac4d0', '#49454f'),
    role('surface-container-lowest', '#ffffff', '#0f0d13'), role('surface-container-low', '#f7f2fa', '#1d1b20', 'surface'),
    role('surface-container', '#f3edf7', '#211f26'), role('surface-container-high', '#ece6f0', '#2b2930'), role('surface-container-highest', '#e6e0e9', '#36343b'),
    role('inverse-surface', '#322f35', '#e6e0e9'), role('inverse-on-surface', '#f5eff7', '#322f35'), role('inverse-primary', '#d0bcff', '#6750a4'),
    { name: 'md-sys-shape-corner-medium', kind: 'radius', light: '12px', role: 'radius' },
    { name: 'md-ref-typeface-plain', kind: 'font-family', light: 'Roboto, system-ui, sans-serif', role: 'font' },
  ],
  components,
};
