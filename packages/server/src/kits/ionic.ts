import { el, icon, ICONS, text, type Css } from './markup.ts';
import type { Kit, KitComponent, KitProp, Variant } from './types.ts';

/**
 * A phone kit in the grouped, translucent style Ionic's iOS mode follows, with handoff to Ionic React
 * (`@ionic/react`, MIT, Drifty Co.). Bogen's own drawing from Ionic's public docs: no assets, fonts or names
 * of any platform vendor. Tokens are Ionic's `ion-*` CSS variables; the font is a token, so a brand's reading face
 * replaces it with from_brand or theme.
 *
 * The sizes are the platform's, so that a screen built from these parts is right before it is styled: a 54pt status
 * bar, a 44pt navigation bar with a 34pt large title under it, 44pt rows in a 16pt inset group, a 49pt tab bar over
 * the 34pt home indicator inset, 50pt full-width buttons with a 12pt radius, and the spacing on a 4pt grid.
 */
const v = (name: string) => `var(--ion-${name})`;
const FONT = { fontFamily: 'var(--ion-font-family, system-ui, sans-serif)', fontSize: '17px', lineHeight: '22px', letterSpacing: '-0.01em' } as const;
const IR = '@ionic/react';
/** Full-bleed parts follow the artboard's width, up to the widest iPhone. */
const W = '100%';
const FULL = { width: W, maxWidth: '440px' } as const;
/** Parts that sit between the screen margins fill them. */
const INSET = { width: '100%', maxWidth: '408px' } as const;
/** The screen margin and the inset of a grouped list. */
const MARGIN = '16px';
const TEXT = (name: string, target: string): KitProp => ({ name, type: 'text', target });
const SHOW = (name: string, target: string): KitProp => ({ name, type: 'boolean', target });

function button(variant: Variant): string {
  const fill = variant.fill!;
  const large = variant.size === 'large';
  const full = variant.width === 'full';
  const disabled = variant.state === 'disabled';
  // Ionic's light colour pair gives the tinted fill a native IonButton handoff too.
  const look: Css = fill === 'solid' ? { background: v('color-primary'), color: v('color-primary-contrast') } : fill === 'tinted' ? { background: v('color-light'), color: v('color-light-contrast') } : fill === 'outline' ? { border: `1px solid ${v('color-primary')}`, color: v('color-primary') } : { color: v('color-primary') };
  return el('button', { ...FONT, display: full ? 'flex' : 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px', width: full ? '100%' : undefined, maxWidth: full ? '408px' : undefined, minWidth: '44px', minHeight: '44px', height: large ? '50px' : '44px', padding: large ? '0 20px' : '0 16px', borderRadius: large ? '12px' : '10px', fontWeight: 600, background: 'transparent', border: '0', boxSizing: 'border-box', flex: 'none', ...look, opacity: disabled ? 0.5 : undefined }, text('span', {}, 'Continue', 'Label'), { type: 'button', ...(disabled ? { disabled: '' } : {}), 'aria-disabled': String(disabled) });
}

/** The native 94x32pt drawing sits inside two 47x44pt hit areas. */
function stepper(variant: Variant): string {
  const disabled = variant.state === 'disabled';
  const control = (glyph: string, name: string) => el('button', { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '1', minWidth: '44px', height: '44px', padding: '0', border: '0', background: 'transparent', color: v('color-primary'), zIndex: 1 }, icon(glyph, 20), { type: 'button', 'data-name': name, 'aria-label': name, ...(disabled ? { disabled: '' } : {}) });
  return el('div', { ...FONT, ...INSET, display: 'flex', alignItems: 'center', gap: '16px', minHeight: '44px', color: v('text-color') }, [
    text('span', { flex: '1', minWidth: '0' }, 'Quantity', 'Label'),
    text('span', { fontVariantNumeric: 'tabular-nums' }, '1', 'Value'),
    el('div', { position: 'relative', display: 'flex', width: '94px', maxWidth: '100%', height: '44px', flex: 'none', opacity: disabled ? 0.5 : undefined }, [
      el('span', { position: 'absolute', top: '6px', left: '0', right: '0', height: '32px', borderRadius: '8px', background: v('segment-background') }, [], { 'data-name': 'Track' }),
      control(ICONS.minus, 'Decrease'),
      el('span', { position: 'absolute', left: '50%', top: '12px', width: '1px', height: '20px', background: v('border-color') }, [], { 'data-name': 'Divider' }),
      control(ICONS.plus, 'Increase'),
    ], { 'data-name': 'Stepper', role: 'group', 'aria-label': 'Adjust quantity', 'aria-disabled': String(disabled) }),
  ]);
}

const DATE_COLUMNS = [
  { name: 'Month', values: ['September', 'October', 'November', 'December', 'January'], flex: '2' },
  { name: 'Day', values: ['16', '17', '18', '19', '20'], flex: '1' },
  { name: 'Year', values: ['2024', '2025', '2026', '2027', '2028'], flex: '1' },
];
const DATE_POSITIONS = ['before', 'previous', 'selected', 'next', 'after'];
const DATE_COPY = DATE_COLUMNS.flatMap((column) => DATE_POSITIONS.map((position) => TEXT(`${column.name.toLowerCase()}-${position}`, `${column.name} ${position}`)));

/** Ionic's iOS wheel: 200pt viewport, 34pt rows/highlight, 22pt type and 16pt insets. */
function datePicker(variant: Variant): string {
  const disabled = variant.state === 'disabled';
  return el('div', { ...FONT, ...INSET, display: 'flex', flexDirection: 'column', background: v('item-background'), color: v('text-color'), borderRadius: '12px', overflow: 'hidden' }, [
    // The ISO value is the code prop; the wheel's display strings remain independently editable for locale mockups.
    text('span', { display: 'none' }, '2026-11-18', 'Value'),
    el('div', { position: 'relative', display: 'flex', alignItems: 'center', height: '200px', padding: '0 16px', boxSizing: 'border-box', opacity: disabled ? 0.5 : undefined }, [
      el('span', { position: 'absolute', left: '8px', right: '8px', top: '83px', height: '34px', borderRadius: '8px', background: v('segment-background') }, [], { 'data-name': 'Selection' }),
      ...DATE_COLUMNS.map((column) => el('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: column.flex, minWidth: '44px', height: '200px', zIndex: 1 }, column.values.map((value, i) => text('span', { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '34px', fontSize: i === 0 || i === 4 ? '18px' : '22px', lineHeight: '34px', color: i === 2 ? v('text-color') : v('color-medium'), whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden' }, value, `${column.name} ${DATE_POSITIONS[i]}`)), { 'data-name': column.name, role: 'listbox', 'aria-label': column.name, 'aria-disabled': String(disabled) })),
    ], { 'data-name': 'Wheels' }),
  ]);
}

function statusBar(): string {
  return el('div', { ...FONT, display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...FULL, height: '54px', padding: '0 32px 0 40px', boxSizing: 'border-box', fontSize: '17px', fontWeight: 600, color: v('text-color'), flex: 'none' }, [
    text('span', { fontVariantNumeric: 'tabular-nums' }, '9:41', 'Time'),
    el('span', { display: 'flex', alignItems: 'center', gap: '6px' }, [icon(ICONS.signal, 17, 'Signal'), icon(ICONS.wifi, 17, 'Wi-Fi'), icon(ICONS.battery, 24, 'Battery')], { 'data-name': 'Indicators' }),
  ], { 'data-name': 'Status bar', role: 'presentation' });
}

function homeIndicator(): string {
  return el('div', { display: 'flex', alignItems: 'flex-end', justifyContent: 'center', ...FULL, height: v('safe-area-bottom'), paddingBottom: '8px', boxSizing: 'border-box', flex: 'none' },
    el('span', { width: '134px', height: '5px', borderRadius: '999px', background: v('text-color') }, [], { 'data-name': 'Pill' }), { 'data-name': 'Home indicator', role: 'presentation' });
}

function toolbar(variant: Variant): string {
  const large = variant.size === 'large';
  return el('header', { ...FONT, display: 'flex', flexDirection: 'column', ...FULL, boxSizing: 'border-box', background: 'transparent', color: v('text-color'), flex: 'none' }, [
    // Three columns, the outer two equal, so the title stays centred whatever Back and the action say or hide.
    el('div', { display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', height: '44px', padding: '0 8px' }, [
      el('div', { display: 'flex', justifyContent: 'flex-start', minWidth: '0' }, el('span', { display: 'flex', alignItems: 'center', gap: '4px', minHeight: '44px', color: v('color-primary') }, [icon(ICONS.chevronLeft, 24), text('span', {}, 'Back', 'Back label')], { 'data-name': 'Back', role: 'button' }), { 'data-name': 'Leading' }),
      large ? el('span', {}, [], { 'data-name': 'Middle' }) : text('span', { fontWeight: 600, textAlign: 'center' }, 'Title', 'Title'),
      el('div', { display: 'flex', justifyContent: 'flex-end', minWidth: '0' }, el('span', { display: 'flex', alignItems: 'center', minHeight: '44px', padding: '0 8px', color: v('color-primary') }, text('span', {}, 'Edit', 'Action label'), { 'data-name': 'Action', role: 'button' }), { 'data-name': 'Trailing' }),
    ], { 'data-name': 'Bar' }),
    large ? text('h1', { margin: '0', fontSize: '34px', lineHeight: '41px', fontWeight: 700, letterSpacing: '0.01em', padding: `0 ${MARGIN} 11px` }, 'Title', 'Title') : '',
  ]);
}

function tabItem(variant: Variant): string {
  const on = variant.selected === 'true';
  return el('div', { flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', height: '49px', minWidth: '44px', color: on ? v('color-primary') : v('color-medium') }, [
    el('span', { display: 'flex', width: '28px', height: '24px', alignItems: 'center', justifyContent: 'center' }, icon(ICONS.home, 24), { 'data-name': 'Icon', 'data-slot': 'icon' }),
    text('span', { fontFamily: 'var(--ion-font-family, system-ui, sans-serif)', fontSize: '10px', lineHeight: '12px', fontWeight: 500 }, 'Today', 'Label'),
  ], { role: 'tab', 'aria-selected': on ? 'true' : 'false' });
}

function tabBar(): string {
  const tab = (label: string, ic: string, active: boolean, name: string) => el('div', { flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', height: '49px', color: active ? v('color-primary') : v('color-medium') }, [icon(ic, 24), text('span', { fontSize: '10px', lineHeight: '12px', fontWeight: 500 }, label, `${name} label`)], { 'data-name': name, role: 'tab' });
  return el('nav', { ...FONT, display: 'flex', flexDirection: 'column', ...FULL, height: '83px', paddingBottom: v('safe-area-bottom'), boxSizing: 'border-box', background: v('tab-bar-background'), borderTop: `0.5px solid ${v('border-color')}`, flex: 'none' },
    el('div', { display: 'flex', height: '49px', padding: '0 8px' }, [tab('Home', ICONS.home, true, 'Tab 1'), tab('Search', ICONS.search, false, 'Tab 2'), tab('Saved', ICONS.heart, false, 'Tab 3'), tab('Profile', ICONS.user, false, 'Tab 4')], { 'data-name': 'Tabs', 'data-slot': 'tabs', role: 'tablist' }));
}

/** One row of a grouped list: an optional leading icon, a title with an optional subtitle, and what trails it. */
function listRow(variant: Variant): string {
  const trailing = variant.accessory!;
  // Every member has the same layers, so that props and overrides carry across a change of accessory.
  const detail = text('span', { color: v('color-medium'), display: trailing === 'toggle' || trailing === 'check' ? 'none' : undefined }, 'Detail', 'Detail');
  const end = trailing === 'toggle' ? [detail, toggle({ checked: 'true' })].join('')
    : trailing === 'check' ? [detail, el('span', { display: 'flex', color: v('color-primary') }, icon(ICONS.check, 20, 'Check', 2.5))].join('')
    : [detail, trailing === 'chevron' ? el('span', { display: 'flex', color: v('color-medium'), opacity: 0.6 }, icon(ICONS.chevronRight, 16)) : ''].join('');
  return el('div', { ...FONT, display: 'flex', alignItems: 'center', gap: '12px', ...FULL, minHeight: '44px', paddingLeft: MARGIN, boxSizing: 'border-box', background: v('item-background'), color: v('text-color') }, [
    el('span', { width: '28px', height: '28px', borderRadius: '8px', background: v('color-primary'), color: v('color-primary-contrast'), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, icon(ICONS.settings, 16), { 'data-name': 'Leading', 'data-slot': 'leading' }),
    el('div', { flex: '1', display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px', padding: `0 ${MARGIN} 0 0`, boxSizing: 'border-box', borderBottom: `0.5px solid ${v('border-color')}` }, [
      el('div', { flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0', padding: '11px 0' }, [
        text('span', {}, 'Title', 'Title'),
        text('span', { fontSize: '15px', lineHeight: '20px', color: v('color-medium') }, 'Subtitle', 'Subtitle'),
      ], { 'data-name': 'Text' }),
      el('span', { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' }, end, { 'data-name': 'Trailing' }),
    ], { 'data-name': 'Content' }),
  ], { 'data-name': 'Row', role: 'listitem' });
}

/** An inset grouped section: a header, the rows in a rounded group, and a footer. */
function listSection(): string {
  const row = (label: string, detail: string, name: string, last = false) => el('div', { display: 'flex', alignItems: 'center', gap: '12px', minHeight: '44px', paddingLeft: MARGIN }, [
    el('span', { width: '28px', height: '28px', borderRadius: '8px', background: v('color-primary'), color: v('color-primary-contrast'), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, icon(ICONS.settings, 16), { 'data-name': `${name} icon` }),
    el('div', { flex: '1', display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px', paddingRight: MARGIN, borderBottom: last ? '0' : `0.5px solid ${v('border-color')}` }, [
      text('span', { flex: '1' }, label, `${name} label`),
      text('span', { color: v('color-medium') }, detail, `${name} detail`),
      el('span', { display: 'flex', color: v('color-medium'), opacity: 0.6 }, icon(ICONS.chevronRight, 16)),
    ]),
  ], { 'data-name': name, role: 'listitem' });
  return el('section', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', ...INSET, boxSizing: 'border-box', color: v('text-color') }, [
    text('div', { margin: '0', padding: `0 ${MARGIN}`, fontSize: '13px', lineHeight: '18px', fontWeight: 400, color: v('color-medium') }, 'Section header', 'Header', { role: 'heading', 'aria-level': '2' }),
    // The rows sit 1px lower than the group's bottom edge, which clips the last row's separator.
    el('div', { display: 'flex', flexDirection: 'column', borderRadius: '10px', overflow: 'hidden', background: v('item-background') },
      el('div', { display: 'flex', flexDirection: 'column', marginBottom: '-1px' }, [row('General', '', 'Row 1'), row('Display', 'Automatic', 'Row 2'), row('Notifications', 'On', 'Row 3', true)], { 'data-name': 'Rows', 'data-slot': 'rows', role: 'list' }), { 'data-name': 'Group' }),
    text('p', { margin: '0', padding: `0 ${MARGIN}`, fontSize: '13px', lineHeight: '18px', color: v('color-medium') }, 'A footer explains the rows above it in a sentence.', 'Footer'),
  ]);
}

function toggle(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('span', { width: '51px', height: '31px', borderRadius: '999px', padding: '2px', boxSizing: 'border-box', background: on ? v('color-success') : v('toggle-background'), display: 'flex', alignItems: 'center', justifyContent: on ? 'flex-end' : 'flex-start', flex: 'none' },
    el('span', { width: '27px', height: '27px', borderRadius: '999px', background: '#ffffff', boxShadow: '0 3px 8px rgb(0 0 0 / 15%), 0 3px 1px rgb(0 0 0 / 6%)' }, [], { 'data-name': 'Knob' }), { role: 'switch', 'aria-checked': on ? 'true' : 'false' });
}

function checkbox(variant: Variant): string {
  const on = variant.checked === 'true';
  return el('span', { width: '44px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' },
    el('span', { width: '22px', height: '22px', borderRadius: '999px', boxSizing: 'border-box', border: on ? '0' : `1.5px solid ${v('color-medium')}`, background: on ? v('color-primary') : 'transparent', color: v('color-primary-contrast'), display: 'flex', alignItems: 'center', justifyContent: 'center' }, on ? icon(ICONS.check, 14, 'Check', 3) : '', { 'data-name': 'Mark' }), { role: 'checkbox', 'aria-checked': on ? 'true' : 'false' });
}

function segment(): string {
  const seg = (label: string, active: boolean, name: string) => el('span', { flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '7px', background: active ? v('segment-active') : 'transparent', boxShadow: active ? '0 3px 8px rgb(0 0 0 / 12%), 0 3px 1px rgb(0 0 0 / 4%)' : undefined, fontWeight: active ? 600 : 400 }, text('span', {}, label, `${name} label`), { 'data-name': name, role: 'tab' });
  return el('div', { ...FONT, fontSize: '13px', lineHeight: '18px', display: 'flex', ...INSET, height: '32px', padding: '2px', borderRadius: '9px', boxSizing: 'border-box', background: v('segment-background'), color: v('text-color') }, [seg('Day', true, 'Segment 1'), seg('Week', false, 'Segment 2'), seg('Month', false, 'Segment 3')], { role: 'tablist' });
}

function searchbar(): string {
  return el('div', { ...FONT, display: 'flex', alignItems: 'center', gap: '8px', ...INSET, height: '36px', padding: '0 8px', borderRadius: '10px', boxSizing: 'border-box', background: v('segment-background'), color: v('color-medium') }, [icon(ICONS.search, 16), text('span', {}, 'Search', 'Placeholder')], { role: 'search' });
}

function input(): string {
  return el('div', { ...FONT, display: 'flex', alignItems: 'center', gap: '12px', ...FULL, minHeight: '44px', padding: `0 ${MARGIN}`, boxSizing: 'border-box', background: v('item-background'), color: v('text-color') }, [text('span', { width: '96px', flex: 'none' }, 'Email', 'Label'), text('span', { flex: '1', color: v('color-medium') }, 'you@example.com', 'Placeholder')], { role: 'textbox' });
}

function card(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', ...INSET, padding: MARGIN, borderRadius: '14px', boxSizing: 'border-box', background: v('item-background'), color: v('text-color') }, [
    text('span', { fontSize: '20px', lineHeight: '25px', fontWeight: 600 }, 'Card title', 'Title'),
    text('span', { fontSize: '15px', lineHeight: '20px', color: v('color-medium') }, 'What the card holds, in a sentence or two.', 'Body'),
    el('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
  ]);
}

/** A modal sheet: a grabber, a bar with Cancel, the title and Done, and the sheet's content. */
function sheet(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', ...FULL, minHeight: '420px', borderRadius: '10px 10px 0 0', boxSizing: 'border-box', background: v('background-color'), color: v('text-color'), boxShadow: '0 -1px 0 rgb(0 0 0 / 4%)' }, [
    el('div', { display: 'flex', justifyContent: 'center', paddingTop: '6px' }, el('span', { width: '36px', height: '5px', borderRadius: '999px', background: v('color-medium'), opacity: 0.4 }, [], { 'data-name': 'Grabber' }), { 'data-name': 'Grabber row' }),
    el('div', { display: 'flex', alignItems: 'center', height: '44px', padding: `0 ${MARGIN}` }, [
      text('span', { flex: '1', display: 'flex', alignItems: 'center', minHeight: '44px', color: v('color-primary') }, 'Cancel', 'Cancel', { role: 'button' }),
      text('span', { fontWeight: 600 }, 'Title', 'Title'),
      text('span', { flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', minHeight: '44px', color: v('color-primary'), fontWeight: 600 }, 'Done', 'Done', { role: 'button' }),
    ], { 'data-name': 'Bar' }),
    el('div', { flex: '1', display: 'flex', flexDirection: 'column', gap: '24px', padding: `8px ${MARGIN} ${v('safe-area-bottom')}` }, [], { 'data-name': 'Body', 'data-slot': 'body' }),
  ], { role: 'dialog' });
}

/** What a screen shows when it has nothing yet, an error or no permission: an icon, a title, why, and one action. */
function emptyState(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', ...INSET, padding: '32px 16px', boxSizing: 'border-box', textAlign: 'center', color: v('text-color') }, [
    el('span', { display: 'flex', color: v('color-medium'), marginBottom: '8px' }, icon(ICONS.inbox, 48, 'Icon', 1.5), { 'data-name': 'Icon slot', 'data-slot': 'icon' }),
    text('h2', { margin: '0', fontSize: '22px', lineHeight: '28px', fontWeight: 700 }, 'Nothing due today', 'Title'),
    text('p', { margin: '0', fontSize: '15px', lineHeight: '20px', color: v('color-medium'), maxWidth: '300px' }, 'Say what happens next and when, in one sentence.', 'Message'),
    el('div', { display: 'flex', paddingTop: '16px' }, button({ fill: 'clear', size: 'default', width: 'auto' }).replace('Continue', 'Add one'), { 'data-name': 'Action' }),
  ]);
}

function alert(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '270px', borderRadius: '14px', overflow: 'hidden', background: v('alert-background'), color: v('text-color'), textAlign: 'center' }, [
    el('div', { display: 'flex', flexDirection: 'column', gap: '4px', padding: '20px 16px' }, [text('span', { fontWeight: 600 }, 'Delete draft?', 'Title'), text('span', { fontSize: '13px', lineHeight: '18px' }, 'This cannot be undone.', 'Message')]),
    el('div', { display: 'flex', borderTop: `0.5px solid ${v('border-color')}` }, [
      text('span', { flex: '1', minHeight: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: v('color-primary'), fontWeight: 600, borderRight: `0.5px solid ${v('border-color')}` }, 'Cancel', 'Cancel', { role: 'button' }),
      text('span', { flex: '1', minHeight: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: v('color-danger') }, 'Delete', 'Confirm', { role: 'button' }),
    ], { 'data-name': 'Buttons' }),
  ], { role: 'alertdialog' });
}

function actionSheet(): string {
  const item = (label: string, name: string, danger = false, last = false) => text('div', { minHeight: '56px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', color: danger ? v('color-danger') : v('color-primary'), borderBottom: last ? '0' : `0.5px solid ${v('border-color')}` }, label, name, { role: 'menuitem' });
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', width: 'calc(100% - 16px)', maxWidth: '424px' }, [
    el('div', { borderRadius: '14px', overflow: 'hidden', background: v('alert-background') }, [item('Share', 'Item 1'), item('Duplicate', 'Item 2'), item('Delete', 'Item 3', true, true)], { 'data-name': 'Group' }),
    el('div', { borderRadius: '14px', background: v('item-background'), fontWeight: 600 }, item('Cancel', 'Cancel', false, true), { 'data-name': 'Cancel group' }),
  ], { role: 'menu' });
}

function badge(variant: Variant): string {
  // White on the success green is under 2:1, so its count is dark, as on a light chip.
  return el('span', { ...FONT, fontSize: '13px', lineHeight: '18px', minWidth: '20px', padding: '1px 8px', borderRadius: '999px', boxSizing: 'border-box', textAlign: 'center', fontWeight: 600, background: v(`color-${variant.color}`), color: variant.color === 'success' ? '#04230f' : variant.color === 'primary' ? v('color-primary-contrast') : v('color-danger-contrast'), flex: 'none' }, text('span', {}, '12', 'Label'));
}

function progressBar(variant: Variant): string {
  return el('div', { ...INSET, height: '4px', borderRadius: '999px', background: v('segment-background'), overflow: 'hidden', flex: 'none' }, el('div', { width: `${variant.value}%`, height: '100%', background: v('color-primary') }, [], { 'data-name': 'Bar' }), { role: 'progressbar' });
}

/** The system draws these on a device: code writes nothing for them. */
const NONE = { from: IR, name: 'IonContent', usage: '<></>' };
const components: KitComponent[] = [
  { name: 'Status bar', group: 'System', description: 'The 54pt status bar of an iPhone with a Dynamic Island: put it first on every screen; content starts under it.', props: [TEXT('time', 'Time')], html: statusBar, handoff: NONE },
  { name: 'Home indicator', group: 'System', description: 'The 34pt home indicator strip: last on a screen without a tab bar. Only backgrounds reach into it.', html: homeIndicator, handoff: NONE },
  { name: 'Toolbar', group: 'Navigation', description: 'The navigation bar: 44pt with a back button, a title and an action; size large puts the 34pt bold title under it on top-level screens. Hide Back on a tab\'s root screen.', axes: { size: ['inline', 'large'] }, props: [TEXT('title', 'Title'), TEXT('back', 'Back label'), TEXT('action', 'Action label'), SHOW('show-back', 'Back'), SHOW('show-action', 'Action')], html: toolbar, handoff: { from: IR, name: 'IonHeader', imports: ['IonBackButton', 'IonButtons', 'IonTitle', 'IonToolbar'], props: { title: '', back: '', action: '', 'show-back': '', 'show-action': '' }, flags: { size: { large: 'collapse="condense"' } }, usage: '<IonHeader{{attrs}}>\n  <IonToolbar>\n    <IonButtons slot="start"><IonBackButton /></IonButtons>\n    <IonTitle>{{title}}</IonTitle>\n  </IonToolbar>\n</IonHeader>' } },
  { name: 'Tab bar', group: 'Navigation', description: 'The bottom tab bar: 49pt of tabs over the 34pt home indicator inset (83pt). Three to five tabs; fill its tabs slot with Tab item instances for your own icons and labels.', props: [TEXT('tab-1', 'Tab 1 label'), TEXT('tab-2', 'Tab 2 label'), TEXT('tab-3', 'Tab 3 label'), TEXT('tab-4', 'Tab 4 label')], html: tabBar, handoff: { from: IR, name: 'IonTabBar', imports: ['IonLabel', 'IonTabButton'], props: { 'tab-1': '', 'tab-2': '', 'tab-3': '', 'tab-4': '' }, usage: '<IonTabBar slot="bottom"{{attrs}}>\n  <IonTabButton tab="home"><IonLabel>Home</IonLabel></IonTabButton>\n  <IonTabButton tab="search"><IonLabel>Search</IonLabel></IonTabButton>\n  <IonTabButton tab="saved"><IonLabel>Saved</IonLabel></IonTabButton>\n  <IonTabButton tab="profile"><IonLabel>Profile</IonLabel></IonTabButton>\n</IonTabBar>' } },
  { name: 'Tab item', group: 'Navigation', description: 'One tab for the Tab bar\'s tabs slot: a 24pt icon in its icon slot (icon_insert or inline SVG) and a 10pt label.', axes: { selected: ['false', 'true'] }, props: [TEXT('label', 'Label')], html: tabItem, handoff: { from: IR, name: 'IonTabButton', imports: ['IonLabel'], props: { label: '', selected: '' }, flags: { selected: { true: 'selected' } }, usage: '<IonTabButton tab="{{label}}"{{attrs}}><IonLabel>{{label}}</IonLabel></IonTabButton>' } },
  { name: 'Button', group: 'Controls', description: 'Solid, outline, clear and tinted buttons, enabled or disabled, with 44pt targets. Tinted uses the kit\'s ion-color-light pair. Large is 50pt; large and full is the primary action above the home indicator.', axes: { fill: ['solid', 'outline', 'clear', 'tinted'], size: ['default', 'large'], width: ['auto', 'full'], state: ['enabled', 'disabled'] }, props: [TEXT('label', 'Label')], html: button, handoff: { from: IR, name: 'IonButton', props: { label: 'children', size: '', width: '', state: '' }, values: { fill: { tinted: 'solid' } }, flags: { fill: { tinted: 'color="light"' }, size: { large: 'size="large"' }, width: { full: 'expand="block"' }, state: { disabled: 'disabled' } } } },
  { name: 'Stepper', group: 'Controls', description: 'A quantity label, value and standard 94x32pt stepper inside 44pt targets. Ionic has no stepper: code composes IonButtons and IonButton.', axes: { state: ['enabled', 'disabled'] }, props: [TEXT('label', 'Label'), TEXT('value', 'Value')], html: stepper, handoff: { from: IR, name: 'IonItem', imports: ['IonButton', 'IonButtons', 'IonLabel', 'IonNote'], props: { label: '', value: '', state: '' }, flags: { state: { disabled: 'disabled' } }, usage: '<IonItem>\n  <IonLabel>{{label}}</IonLabel>\n  <IonNote slot="end">{{value}}</IonNote>\n  <IonButtons slot="end" aria-label="{{label}}">\n    <IonButton aria-label="Decrease"{{attrs}}>−</IonButton>\n    <IonButton aria-label="Increase"{{attrs}}>+</IonButton>\n  </IonButtons>\n</IonItem>' } },
  { name: 'Date picker', group: 'Controls', description: 'An inline iOS date wheel: 200pt high, 34pt rows, 22pt type. Edit value as an ISO date for code; month/day/year strings are display copy for locale mockups.', axes: { state: ['enabled', 'disabled'] }, props: [TEXT('value', 'Value'), ...DATE_COPY], html: datePicker, handoff: { from: IR, name: 'IonDatetime', props: { state: '', value: 'value', ...Object.fromEntries(DATE_COPY.map((prop) => [prop.name, ''])) }, flags: { state: { disabled: 'disabled' } }, usage: '<IonDatetime mode="ios" presentation="date" preferWheel size="cover"{{attrs}} />' } },
  { name: 'Toggle', group: 'Controls', description: 'A switch for a setting, 51x31pt, at the end of a list row.', axes: { checked: ['false', 'true'] }, html: toggle, handoff: { from: IR, name: 'IonToggle', props: { checked: '' }, flags: { checked: { true: 'checked' } } } },
  { name: 'Checkbox', group: 'Controls', description: 'A round check for selecting items in a list, in a 44pt target.', axes: { checked: ['false', 'true'] }, html: checkbox, handoff: { from: IR, name: 'IonCheckbox', props: { checked: '' }, flags: { checked: { true: 'checked' } } } },
  { name: 'Segment', group: 'Controls', description: 'A segmented control for two to four views, 32pt, full width between the margins.', props: [TEXT('segment-1', 'Segment 1 label'), TEXT('segment-2', 'Segment 2 label'), TEXT('segment-3', 'Segment 3 label')], html: segment, handoff: { from: IR, name: 'IonSegment', imports: ['IonLabel', 'IonSegmentButton'], props: { 'segment-1': '', 'segment-2': '', 'segment-3': '' }, usage: '<IonSegment value="day"{{attrs}}>\n  <IonSegmentButton value="day"><IonLabel>Day</IonLabel></IonSegmentButton>\n  <IonSegmentButton value="week"><IonLabel>Week</IonLabel></IonSegmentButton>\n  <IonSegmentButton value="month"><IonLabel>Month</IonLabel></IonSegmentButton>\n</IonSegment>' } },
  { name: 'Searchbar', group: 'Controls', description: 'A search field under the navigation bar.', props: [TEXT('placeholder', 'Placeholder')], html: searchbar, handoff: { from: IR, name: 'IonSearchbar', props: { placeholder: 'placeholder' } } },
  { name: 'Input', group: 'Controls', description: 'A labelled text field as a list row: put it in a List section\'s rows.', props: [TEXT('label', 'Label'), TEXT('placeholder', 'Placeholder')], html: input, handoff: { from: IR, name: 'IonInput', props: { label: 'label', placeholder: 'placeholder' } } },
  { name: 'List section', group: 'Content', description: 'An inset grouped section: a 13pt header, rows in a 10pt rounded group 16pt from the edges, and a footer. Fill its rows slot with List row instances.', props: [TEXT('header', 'Header'), TEXT('footer', 'Footer'), SHOW('show-header', 'Header'), SHOW('show-footer', 'Footer')], html: listSection, handoff: { from: IR, name: 'IonList', imports: ['IonItem', 'IonLabel', 'IonListHeader', 'IonNote'], props: { header: '', footer: '', 'show-header': '', 'show-footer': '' }, usage: '<IonList inset{{attrs}}>\n  <IonListHeader>{{header}}</IonListHeader>\n  {{children}}\n</IonList>' } },
  { name: 'List row', group: 'Content', description: 'A 44pt row: a leading icon slot, a title, an optional subtitle, and a chevron, a value, a switch or a check at the end.', axes: { accessory: ['chevron', 'value', 'toggle', 'check'] }, props: [TEXT('title', 'Title'), TEXT('subtitle', 'Subtitle'), TEXT('detail', 'Detail'), SHOW('show-subtitle', 'Subtitle'), SHOW('show-leading', 'Leading')], html: listRow, handoff: { from: IR, name: 'IonItem', imports: ['IonLabel', 'IonNote'], props: { title: '', subtitle: '', detail: '', accessory: '', 'show-subtitle': '', 'show-leading': '' }, flags: { accessory: { chevron: 'detail' } }, usage: '<IonItem{{attrs}}><IonLabel><h2>{{title}}</h2><p>{{subtitle}}</p></IonLabel><IonNote slot="end">{{detail}}</IonNote></IonItem>' } },
  { name: 'Card', group: 'Content', description: 'A card for one distinct object (a batch, a round), with a title, a sentence and a content slot. Not for single lines.', props: [TEXT('title', 'Title'), TEXT('body', 'Body')], html: card, handoff: { from: IR, name: 'IonCard', imports: ['IonCardContent', 'IonCardHeader', 'IonCardTitle'], props: { title: '', body: '' }, usage: '<IonCard{{attrs}}>\n  <IonCardHeader>\n    <IonCardTitle>{{title}}</IonCardTitle>\n  </IonCardHeader>\n  <IonCardContent>{{body}}{{children}}</IonCardContent>\n</IonCard>' } },
  { name: 'Empty state', group: 'Content', description: 'Nothing yet, an error or a permission that is off: an icon, a 22pt title, why in a sentence, and one action. Centre it in the space.', props: [TEXT('title', 'Title'), TEXT('message', 'Message'), TEXT('action', 'Label')], html: emptyState, handoff: { from: IR, name: 'IonText', props: { title: '', message: '', action: '' }, usage: '<IonText{{attrs}}><h2>{{title}}</h2><p>{{message}}</p></IonText>' } },
  { name: 'Badge', group: 'Content', description: 'A count on a row or a tab.', axes: { color: ['danger', 'primary', 'success'] }, props: [TEXT('label', 'Label')], html: badge, handoff: { from: IR, name: 'IonBadge', props: { label: 'children' } } },
  { name: 'Progress bar', group: 'Content', description: 'A thin progress bar, full width between the margins.', axes: { value: ['60', '25', '100'] }, html: progressBar, handoff: { from: IR, name: 'IonProgressBar', props: { value: '' }, flags: { value: { 60: 'value={0.6}', 25: 'value={0.25}', 100: 'value={1}' } } } },
  { name: 'Sheet', group: 'Overlays', description: 'A modal sheet with a grabber, Cancel, the title and Done, and a body slot for its content: for add, edit, settings and the paywall.', props: [TEXT('title', 'Title'), TEXT('cancel', 'Cancel'), TEXT('done', 'Done')], html: sheet, handoff: { from: IR, name: 'IonModal', imports: ['IonButton', 'IonButtons', 'IonContent', 'IonHeader', 'IonTitle', 'IonToolbar'], props: { title: '', cancel: '', done: '' }, usage: '<IonModal isOpen{{attrs}}>\n  <IonHeader>\n    <IonToolbar>\n      <IonButtons slot="start"><IonButton>{{cancel}}</IonButton></IonButtons>\n      <IonTitle>{{title}}</IonTitle>\n      <IonButtons slot="end"><IonButton strong>{{done}}</IonButton></IonButtons>\n    </IonToolbar>\n  </IonHeader>\n  <IonContent>{{children}}</IonContent>\n</IonModal>' } },
  { name: 'Alert', group: 'Overlays', description: 'A small dialog with a title, a message and two buttons.', props: [TEXT('title', 'Title'), TEXT('message', 'Message')], html: alert, handoff: { from: IR, name: 'IonAlert', props: { title: 'header', message: 'message' }, usage: '<IonAlert isOpen header="{{title}}" message="{{message}}"{{attrs}} />' } },
  { name: 'Action sheet', group: 'Overlays', description: 'A sheet of actions from the bottom of the screen.', html: actionSheet, handoff: { from: IR, name: 'IonActionSheet', usage: '<IonActionSheet isOpen header="Actions"{{attrs}} />' } },
];

export const ionicKit: Kit = {
  id: 'ionic-ios',
  name: 'Ionic (iOS mode)',
  description: 'A phone kit at iOS sizes in the grouped style of Ionic\'s iOS mode: status bar, navigation bar with large title, inset grouped lists and rows, tab bar, sheet, segmented control, search, buttons, steppers, inline date wheels and empty states, in light and dark. Bogen\'s own drawing; it uses no platform vendor\'s assets or fonts.',
  platform: 'ios-like',
  library: { name: 'Ionic React', package: '@ionic/react', license: 'MIT', url: 'https://ionicframework.com/docs' },
  font: 'system-ui, sans-serif',
  version: 9,
  tokens: [
    { name: 'ion-color-primary', kind: 'color', light: '#0054e9', dark: '#4d8dff', role: 'primary' },
    { name: 'ion-color-primary-contrast', kind: 'color', light: '#ffffff', dark: '#000000', role: 'on-primary' },
    { name: 'ion-color-light', kind: 'color', light: '#e6edfb', dark: '#162845' },
    { name: 'ion-color-light-contrast', kind: 'color', light: '#0054e9', dark: '#7facff' },
    { name: 'ion-color-success', kind: 'color', light: '#2dd55b', dark: '#2fdf75' },
    { name: 'ion-color-danger', kind: 'color', light: '#c5000f', dark: '#ff4961', role: 'danger' },
    { name: 'ion-color-danger-contrast', kind: 'color', light: '#ffffff', dark: '#000000' },
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
    { name: 'ion-font-family', kind: 'font-family', light: 'system-ui, sans-serif', role: 'font' },
    // The insets of an iPhone with a Dynamic Island: Ionic's own names for them.
    { name: 'ion-safe-area-top', kind: 'spacing', light: '54px' },
    { name: 'ion-safe-area-bottom', kind: 'spacing', light: '34px' },
  ],
  components,
};
