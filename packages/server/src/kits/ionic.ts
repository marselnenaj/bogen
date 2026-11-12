import { el, icon, ICONS, text, type Css } from './markup.ts';
import type { Kit, KitComponent, Variant } from './types.ts';

/**
 * A phone kit in the grouped, translucent style Ionic's iOS mode follows, with handoff to Ionic React
 * (`@ionic/react`, MIT, Drifty Co.). Bogen's own drawing from Ionic's public docs: no assets, fonts or names
 * of any platform vendor, and the font is Inter. Tokens are Ionic's `ion-*` CSS variables.
 */
const v = (name: string) => `var(--ion-${name})`;
const FONT = { fontFamily: v('font-family'), fontSize: '17px', lineHeight: '22px', letterSpacing: '-0.01em' } as const;
const IR = '@ionic/react';
const W = '393px';

function button(variant: Variant): string {
  const fill = variant.fill!;
  const look: Css = fill === 'solid' ? { background: v('color-primary'), color: v('color-primary-contrast') } : fill === 'outline' ? { border: `1px solid ${v('color-primary')}`, color: v('color-primary') } : { color: v('color-primary') };
  return el('button', { ...FONT, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: variant.size === 'large' ? '50px' : '36px', padding: '0 18px', borderRadius: variant.size === 'large' ? '12px' : '10px', fontWeight: 500, background: 'transparent', border: '0', boxSizing: 'border-box', flex: 'none', ...look }, text('span', {}, 'Continue', 'Label'), { type: 'button' });
}

function list(): string {
  const row = (label: string, detail: string, name: string, last = false) => el('div', { display: 'flex', alignItems: 'center', gap: '12px', minHeight: '44px', paddingLeft: '16px' }, [
    el('span', { width: '29px', height: '29px', borderRadius: '7px', background: v('color-primary'), color: v('color-primary-contrast'), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, icon(ICONS.settings, 17), { 'data-name': `${name} icon` }),
    el('div', { flex: '1', display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px', paddingRight: '16px', borderBottom: last ? '0' : `0.5px solid ${v('border-color')}` }, [
      text('span', { flex: '1' }, label, `${name} label`),
      text('span', { color: v('color-medium') }, detail, `${name} detail`),
      el('span', { display: 'flex', color: v('color-medium'), opacity: 0.6 }, icon(ICONS.chevronRight, 16)),
    ]),
  ], { 'data-name': name });
  return el('div', { ...FONT, width: W, padding: '0 16px', boxSizing: 'border-box' },
    el('div', { borderRadius: '10px', overflow: 'hidden', background: v('item-background'), color: v('text-color') }, [row('General', '', 'Row 1'), row('Display', 'Automatic', 'Row 2'), row('Notifications', 'On', 'Row 3', true)]), { role: 'list' });
}

function toggle(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('span', { width: '51px', height: '31px', borderRadius: '999px', padding: '2px', boxSizing: 'border-box', background: on ? v('color-success') : v('toggle-background'), display: 'flex', alignItems: 'center', justifyContent: on ? 'flex-end' : 'flex-start', flex: 'none' },
    el('span', { width: '27px', height: '27px', borderRadius: '999px', background: '#ffffff', boxShadow: '0 3px 8px rgb(0 0 0 / 15%), 0 3px 1px rgb(0 0 0 / 6%)' }, [], { 'data-name': 'Knob' }), { role: 'switch' });
}

function checkbox(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('span', { width: '22px', height: '22px', borderRadius: '999px', boxSizing: 'border-box', border: on ? '0' : `1.5px solid ${v('color-medium')}`, background: on ? v('color-primary') : 'transparent', color: v('color-primary-contrast'), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, on ? icon(ICONS.check, 14, 'Check', 3) : '', { role: 'checkbox' });
}

function segment(): string {
  const seg = (label: string, active: boolean, name: string) => el('span', { flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '7px', background: active ? v('segment-active') : 'transparent', boxShadow: active ? '0 3px 8px rgb(0 0 0 / 12%), 0 3px 1px rgb(0 0 0 / 4%)' : undefined, fontWeight: active ? 600 : 400 }, text('span', {}, label, `${name} label`), { 'data-name': name });
  return el('div', { ...FONT, fontSize: '13px', display: 'flex', width: '343px', height: '32px', padding: '2px', borderRadius: '9px', boxSizing: 'border-box', background: v('segment-background'), color: v('text-color') }, [seg('Day', true, 'Segment 1'), seg('Week', false, 'Segment 2'), seg('Month', false, 'Segment 3')], { role: 'tablist' });
}

function searchbar(): string {
  return el('div', { ...FONT, display: 'flex', alignItems: 'center', gap: '6px', width: '361px', height: '36px', padding: '0 8px', borderRadius: '10px', boxSizing: 'border-box', background: v('segment-background'), color: v('color-medium') }, [icon(ICONS.search, 16), text('span', {}, 'Search', 'Placeholder')], { role: 'search' });
}

function toolbar(variant: Variant): string {
  const large = variant.title === 'large';
  return el('header', { ...FONT, display: 'flex', flexDirection: 'column', width: W, boxSizing: 'border-box', background: v('toolbar-background'), color: v('text-color'), borderBottom: large ? undefined : `0.5px solid ${v('border-color')}` }, [
    el('div', { display: 'flex', alignItems: 'center', height: '44px', padding: '0 8px' }, [
      el('span', { display: 'flex', alignItems: 'center', gap: '2px', color: v('color-primary'), flex: '1' }, [icon(ICONS.chevronLeft, 22), text('span', {}, 'Back', 'Back label')], { 'data-name': 'Back' }),
      large ? '' : text('span', { fontWeight: 600 }, 'Title', 'Title'),
      el('span', { flex: '1', display: 'flex', justifyContent: 'flex-end', color: v('color-primary') }, text('span', {}, 'Edit', 'Action label'), { 'data-name': 'Action' }),
    ]),
    large ? text('span', { fontSize: '34px', lineHeight: '41px', fontWeight: 700, padding: '0 16px 8px' }, 'Title', 'Title') : '',
  ]);
}

function tabBar(): string {
  const tab = (label: string, ic: string, active: boolean, name: string) => el('div', { flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', color: active ? v('color-primary') : v('color-medium') }, [icon(ic, 24), text('span', { fontSize: '10px', lineHeight: '12px', fontWeight: 500 }, label, `${name} label`)], { 'data-name': name });
  return el('nav', { ...FONT, display: 'flex', width: W, height: '83px', padding: '6px 0 34px', boxSizing: 'border-box', background: v('tab-bar-background'), borderTop: `0.5px solid ${v('border-color')}` }, [tab('Home', ICONS.home, true, 'Tab 1'), tab('Search', ICONS.search, false, 'Tab 2'), tab('Saved', ICONS.heart, false, 'Tab 3'), tab('Profile', ICONS.user, false, 'Tab 4')]);
}

function card(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '6px', width: '361px', padding: '16px', borderRadius: '14px', boxSizing: 'border-box', background: v('item-background'), color: v('text-color'), boxShadow: '0 4px 16px rgb(0 0 0 / 8%)' }, [
    text('span', { fontSize: '13px', fontWeight: 600, color: v('color-medium'), textTransform: 'uppercase', letterSpacing: '0.02em' }, 'Card subtitle', 'Subtitle'),
    text('span', { fontSize: '22px', lineHeight: '28px', fontWeight: 700 }, 'Card title', 'Title'),
    text('span', { fontSize: '15px', lineHeight: '20px', color: v('color-medium') }, 'Here is a small text description for the card content.', 'Body'),
    el('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
  ]);
}

function alert(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '270px', borderRadius: '14px', overflow: 'hidden', background: v('alert-background'), color: v('text-color'), textAlign: 'center' }, [
    el('div', { display: 'flex', flexDirection: 'column', gap: '2px', padding: '19px 16px' }, [text('span', { fontWeight: 600 }, 'Delete draft?', 'Title'), text('span', { fontSize: '13px', lineHeight: '18px' }, 'This cannot be undone.', 'Message')]),
    el('div', { display: 'flex', borderTop: `0.5px solid ${v('border-color')}` }, [
      text('span', { flex: '1', padding: '11px', color: v('color-primary'), borderRight: `0.5px solid ${v('border-color')}` }, 'Cancel', 'Cancel'),
      text('span', { flex: '1', padding: '11px', color: v('color-danger'), fontWeight: 600 }, 'Delete', 'Confirm'),
    ], { 'data-name': 'Buttons' }),
  ], { role: 'alertdialog' });
}

function actionSheet(): string {
  const item = (label: string, name: string, danger = false, last = false) => text('div', { padding: '18px', textAlign: 'center', fontSize: '20px', color: danger ? v('color-danger') : v('color-primary'), borderBottom: last ? '0' : `0.5px solid ${v('border-color')}` }, label, name);
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', width: '377px' }, [
    el('div', { borderRadius: '14px', overflow: 'hidden', background: v('alert-background') }, [item('Share', 'Item 1'), item('Duplicate', 'Item 2'), item('Delete', 'Item 3', true, true)], { 'data-name': 'Group' }),
    el('div', { borderRadius: '14px', background: v('item-background'), fontWeight: 600 }, item('Cancel', 'Cancel', false, true), { 'data-name': 'Cancel group' }),
  ], { role: 'menu' });
}

function input(): string {
  return el('div', { ...FONT, display: 'flex', alignItems: 'center', width: W, padding: '0 32px', minHeight: '44px', boxSizing: 'border-box', background: v('item-background'), color: v('text-color') }, [text('span', { width: '96px' }, 'Email', 'Label'), text('span', { color: v('color-medium') }, 'you@example.com', 'Placeholder')]);
}

function badge(variant: Variant): string {
  return el('span', { ...FONT, fontSize: '13px', lineHeight: '18px', minWidth: '20px', padding: '1px 7px', borderRadius: '999px', boxSizing: 'border-box', textAlign: 'center', fontWeight: 600, background: v(`color-${variant.color}`), color: '#ffffff', flex: 'none' }, text('span', {}, '12', 'Label'));
}

function progressBar(variant: Variant): string {
  return el('div', { width: '343px', height: '4px', borderRadius: '999px', background: v('segment-background'), overflow: 'hidden', flex: 'none' }, el('div', { width: `${variant.value}%`, height: '100%', background: v('color-primary') }, [], { 'data-name': 'Bar' }), { role: 'progressbar' });
}

const components: KitComponent[] = [
  { name: 'Button', group: 'Controls', description: 'Solid, outline and clear buttons, in two sizes.', axes: { fill: ['solid', 'outline', 'clear'], size: ['default', 'large'] }, props: [{ name: 'label', type: 'text', target: 'Label' }], html: button, handoff: { from: IR, name: 'IonButton', props: { label: 'children' }, flags: { size: { large: 'expand="block"' } } } },
  { name: 'Toggle', group: 'Controls', description: 'A switch for a setting.', axes: { checked: ['false', 'true'] }, html: toggle, handoff: { from: IR, name: 'IonToggle', props: { checked: '' }, flags: { checked: { true: 'checked' } } } },
  { name: 'Checkbox', group: 'Controls', description: 'A round check for selecting items in a list.', axes: { checked: ['false', 'true'] }, html: checkbox, handoff: { from: IR, name: 'IonCheckbox', props: { checked: '' }, flags: { checked: { true: 'checked' } } } },
  { name: 'Segment', group: 'Controls', description: 'Segmented control to switch between views.', html: segment, handoff: { from: IR, name: 'IonSegment', imports: ['IonLabel', 'IonSegmentButton'], usage: '<IonSegment value="day"{{attrs}}>\n  <IonSegmentButton value="day"><IonLabel>Day</IonLabel></IonSegmentButton>\n  <IonSegmentButton value="week"><IonLabel>Week</IonLabel></IonSegmentButton>\n  <IonSegmentButton value="month"><IonLabel>Month</IonLabel></IonSegmentButton>\n</IonSegment>' } },
  { name: 'Searchbar', group: 'Controls', description: 'A search field.', props: [{ name: 'placeholder', type: 'text', target: 'Placeholder' }], html: searchbar, handoff: { from: IR, name: 'IonSearchbar', props: { placeholder: 'placeholder' } } },
  { name: 'Input', group: 'Controls', description: 'A labelled text input in a list row.', props: [{ name: 'label', type: 'text', target: 'Label' }, { name: 'placeholder', type: 'text', target: 'Placeholder' }], html: input, handoff: { from: IR, name: 'IonInput', props: { label: 'label', placeholder: 'placeholder' } } },
  { name: 'List', group: 'Content', description: 'An inset grouped list of rows with icons, details and disclosure.', html: list, handoff: { from: IR, name: 'IonList', imports: ['IonItem', 'IonLabel', 'IonNote'], usage: '<IonList inset{{attrs}}>\n  <IonItem button detail><IonLabel>General</IonLabel></IonItem>\n  <IonItem button detail><IonLabel>Display</IonLabel><IonNote slot="end">Automatic</IonNote></IonItem>\n  <IonItem button detail><IonLabel>Notifications</IonLabel><IonNote slot="end">On</IonNote></IonItem>\n</IonList>' } },
  { name: 'Card', group: 'Content', description: 'A card with a subtitle, a title and content.', props: [{ name: 'title', type: 'text', target: 'Title' }, { name: 'subtitle', type: 'text', target: 'Subtitle' }, { name: 'body', type: 'text', target: 'Body' }], html: card, handoff: { from: IR, name: 'IonCard', imports: ['IonCardContent', 'IonCardHeader', 'IonCardSubtitle', 'IonCardTitle'], props: { title: '', subtitle: '', body: '' }, usage: '<IonCard{{attrs}}>\n  <IonCardHeader>\n    <IonCardSubtitle>{{subtitle}}</IonCardSubtitle>\n    <IonCardTitle>{{title}}</IonCardTitle>\n  </IonCardHeader>\n  <IonCardContent>{{body}}{{children}}</IonCardContent>\n</IonCard>' } },
  { name: 'Badge', group: 'Content', description: 'A count on a row or a tab.', axes: { color: ['danger', 'primary', 'success'] }, props: [{ name: 'label', type: 'text', target: 'Label' }], html: badge, handoff: { from: IR, name: 'IonBadge', props: { label: 'children' } } },
  { name: 'Progress bar', group: 'Content', description: 'A thin progress bar.', axes: { value: ['60', '25', '100'] }, html: progressBar, handoff: { from: IR, name: 'IonProgressBar', props: { value: '' }, flags: { value: { 60: 'value={0.6}', 25: 'value={0.25}', 100: 'value={1}' } } } },
  { name: 'Toolbar', group: 'Navigation', description: 'A navigation bar with a back button, a title and an action; the large title sits under it.', axes: { title: ['inline', 'large'] }, props: [{ name: 'title', type: 'text', target: 'Title' }], html: toolbar, handoff: { from: IR, name: 'IonHeader', imports: ['IonBackButton', 'IonButtons', 'IonTitle', 'IonToolbar'], props: { title: '' }, flags: { title: { large: 'collapse="condense"' } }, usage: '<IonHeader{{attrs}}>\n  <IonToolbar>\n    <IonButtons slot="start"><IonBackButton /></IonButtons>\n    <IonTitle>{{title}}</IonTitle>\n  </IonToolbar>\n</IonHeader>' } },
  { name: 'Tab bar', group: 'Navigation', description: 'The bottom tab bar of a phone app.', html: tabBar, handoff: { from: IR, name: 'IonTabBar', imports: ['IonLabel', 'IonTabButton'], usage: '<IonTabBar slot="bottom"{{attrs}}>\n  <IonTabButton tab="home"><IonLabel>Home</IonLabel></IonTabButton>\n  <IonTabButton tab="search"><IonLabel>Search</IonLabel></IonTabButton>\n  <IonTabButton tab="saved"><IonLabel>Saved</IonLabel></IonTabButton>\n  <IonTabButton tab="profile"><IonLabel>Profile</IonLabel></IonTabButton>\n</IonTabBar>' } },
  { name: 'Alert', group: 'Overlays', description: 'A small dialog with a title, a message and two buttons.', props: [{ name: 'title', type: 'text', target: 'Title' }, { name: 'message', type: 'text', target: 'Message' }], html: alert, handoff: { from: IR, name: 'IonAlert', props: { title: 'header', message: 'message' }, usage: '<IonAlert isOpen header="{{title}}" message="{{message}}"{{attrs}} />' } },
  { name: 'Action sheet', group: 'Overlays', description: 'A sheet of actions from the bottom of the screen.', html: actionSheet, handoff: { from: IR, name: 'IonActionSheet', usage: '<IonActionSheet isOpen header="Actions"{{attrs}} />' } },
];

export const ionicKit: Kit = {
  id: 'ionic-ios',
  name: 'Ionic (iOS mode)',
  description: 'A phone kit in the grouped style of Ionic\'s iOS mode: lists, toggles, segments, bars and sheets, in light and dark. Bogen\'s own drawing; it uses no platform vendor\'s assets or fonts.',
  platform: 'ios-like',
  library: { name: 'Ionic React', package: '@ionic/react', license: 'MIT', url: 'https://ionicframework.com/docs' },
  font: 'Inter, system-ui, sans-serif',
  version: 1,
  tokens: [
    { name: 'ion-color-primary', kind: 'color', light: '#0054e9', dark: '#4d8dff', role: 'primary' },
    { name: 'ion-color-primary-contrast', kind: 'color', light: '#ffffff', dark: '#000000', role: 'on-primary' },
    { name: 'ion-color-success', kind: 'color', light: '#2dd55b', dark: '#2fdf75' },
    { name: 'ion-color-danger', kind: 'color', light: '#c5000f', dark: '#ff4961', role: 'danger' },
    { name: 'ion-color-medium', kind: 'color', light: '#636469', dark: '#989aa2', role: 'muted' },
    { name: 'ion-background-color', kind: 'color', light: '#f2f2f6', dark: '#000000', role: 'background' },
    { name: 'ion-text-color', kind: 'color', light: '#000000', dark: '#ffffff', role: 'foreground' },
    { name: 'ion-item-background', kind: 'color', light: '#ffffff', dark: '#1c1c1d', role: 'surface' },
    { name: 'ion-border-color', kind: 'color', light: 'rgba(0, 0, 0, 0.2)', dark: 'rgba(255, 255, 255, 0.2)', role: 'border' },
    { name: 'ion-toolbar-background', kind: 'color', light: 'rgba(248, 248, 250, 0.92)', dark: 'rgba(22, 22, 24, 0.92)' },
    { name: 'ion-tab-bar-background', kind: 'color', light: 'rgba(248, 248, 250, 0.92)', dark: 'rgba(22, 22, 24, 0.92)' },
    { name: 'ion-segment-background', kind: 'color', light: 'rgba(118, 118, 128, 0.12)', dark: 'rgba(118, 118, 128, 0.24)' },
    { name: 'ion-segment-active', kind: 'color', light: '#ffffff', dark: '#636366' },
    { name: 'ion-toggle-background', kind: 'color', light: 'rgba(120, 120, 128, 0.16)', dark: 'rgba(120, 120, 128, 0.32)' },
    { name: 'ion-alert-background', kind: 'color', light: 'rgba(249, 249, 249, 0.94)', dark: 'rgba(30, 30, 30, 0.94)' },
    { name: 'ion-font-family', kind: 'font-family', light: 'Inter, system-ui, sans-serif', role: 'font' },
  ],
  components,
};
