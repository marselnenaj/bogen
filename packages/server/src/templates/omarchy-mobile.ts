// The Omarchy Mobile theme template: the phone's own shell surfaces at the profile's logical size (420 x 935 on Komodo),
// drawn only from the theme's tokens: the palette (--omarchy-*) and the shell roles (--omarchy-shell-*), which are
// what shell.toml is written from. So a preview and the export cannot disagree about a colour.
//
// Layouts follow the Komodo checkout (2caa95b with its local changes): pixel.lock's field and 3 x 4 PIN pad, the
// launcher's single bottom bar that is app search, app grid and agent prompt at once, quick settings tiles, the
// notification shade, squeekboard at 420 x 276 with its 42 px strip, and the native Pixel services app. These are
// design states for checking a theme, not claims about what runs on the phone.

import { iconSvg } from '@bogen/core/icons';
import type { MobileProfile } from '../omarchy-mobile.ts';
import { h, t, type Style } from './kit.ts';
import { imageWallpaper, MONO, n, outlined, V, wallpaper, type ThemeImage } from './omarchy-theme.ts';

/** A shell role: `S('lock', 'border')` is var(--omarchy-shell-lock-border). */
const S = (section: string, key: string) => `var(--omarchy-shell-${section}-${key})`;
/** The shell's type scale, from [font] base-size the way Commons.Style derives it. */
const F = (k: number) => `calc(var(--omarchy-shell-font-base-size) * ${k})`;
const SCALE = { caption: 0.833, body: 1, subtitle: 1.083, title: 1.167, heading: 1.333, display: 2, displayLarge: 2.333 } as const;
/** The Pixel services app bundles Geist (OFL-1.1); where it is missing the app falls back to the Omarchy font. */
const GEIST = `Geist, 'Geist Variable', ${MONO}`;
const GAP = 120;

export interface MobileBoardsInput {
  name: string;
  profile: MobileProfile;
  backgrounds?: ThemeImage[];
}

export interface MobileBoard {
  kind: 'background' | 'phone' | 'preview' | 'guide';
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  background: string;
  html: string;
  components: string[];
}

function glyph(name: string, size: number, color: string, label?: string): string {
  return h('div', { width: `${size}px`, height: `${size}px`, flexShrink: '0', display: 'flex', color }, iconSvg(name, { strokeWidth: 1.75 }), n(label ?? name));
}

/** pixel.bar: the clock on the left, battery on the right, in the bar's own colours. */
function statusBar(): string {
  return h('header', {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: `calc(var(--omarchy-shell-font-base-size) * 26 / 12)`, flexShrink: '0',
    padding: '0 18px', background: S('bar', 'background'), color: S('bar', 'text'), fontFamily: MONO, fontSize: F(SCALE.body),
  }, [
    h('span', { fontVariantNumeric: 'tabular-nums' }, '14:51', n('Clock')),
    h('span', { display: 'flex', alignItems: 'center', gap: '6px' }, [
      h('span', { width: '7px', height: '7px', borderRadius: '50%', background: S('bar', 'active') }, [], n('Recording')),
      glyph('wifi', 14, S('bar', 'text'), 'Network'),
      h('span', { fontVariantNumeric: 'tabular-nums' }, '83%', n('Battery')),
    ], n('Indicators')),
  ], n('Status bar'));
}

const wall = '<x-instance component="Wallpaper" style="position:absolute;inset:0;width:100%;height:100%"></x-instance>';

/** The phone's lock: clock, the field in lock roles with its outline in the active border, and the 3 x 4 PIN pad. */
function lockScreen(p: MobileProfile): string {
  const key = (label: string, icon?: string) => outlined(icon ? `Key ${icon}` : `Key ${label}`, { width: '84px', height: '84px' }, S('lock', 'background'), S('lock', 'border'), 2,
    h('div', { flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', color: S('lock', 'text'), fontFamily: MONO, fontSize: F(SCALE.display) }, icon ? glyph(icon, 26, S('lock', 'text')) : t(label), n('Label')));
  const rows = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']];
  return h('div', { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column', alignItems: 'center', fontFamily: MONO, color: S('lock', 'text') }, [
    h('div', { position: 'absolute', inset: '0', background: `color-mix(in srgb, ${V('background')} 55%, transparent)` }, [], n('Dim')),
    h('div', { position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', marginTop: '210px' }, [
      h('p', { fontSize: F(SCALE.displayLarge), fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em' }, '14:51', n('Time')),
      h('p', { fontSize: F(SCALE.subtitle), color: S('lock', 'placeholder') }, 'Thursday, 5 November', n('Date')),
    ], n('Clock')),
    h('div', { position: 'relative', marginTop: '28px' }, outlined('PIN field', { width: `${p.logical.width - 40}px`, height: '64px' }, S('lock', 'background'), S('lock', 'border-active'), 3,
      h('div', { flex: '1 1 auto', display: 'flex', alignItems: 'center', padding: '0 18px', gap: '12px' }, [
        h('span', { fontSize: F(SCALE.body), color: S('lock', 'placeholder') }, 'ABC', n('Keyboard switch')),
        h('span', { flex: '1 1 auto', display: 'flex', justifyContent: 'center', gap: '6px' }, ['', '', '', ''].map(() => h('span', { width: '14px', height: '14px', borderRadius: '50%', background: S('lock', 'text') }, [], n('Digit'))), n('Entered')),
      ], n('Field'))), n('Field row')),
    h('div', { position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(3, 84px)', gap: '24px', marginTop: '40px' }, [
      ...rows.flat().map((d) => key(d)),
      key('', 'delete'), key('0'), key('', 'corner-down-left'),
    ], n('PIN pad')),
    h('p', { position: 'relative', marginTop: 'auto', marginBottom: `${p.pillStrip}px`, fontSize: F(SCALE.body), color: S('lock', 'text') }, 'Emergency call', n('Emergency')),
  ], n('Lock'));
}

/** A home-screen tile: bordered like a window, as widgets on the phone are. Its colours are palette names only. */
function tile(name: string, cols: number, rows: number, inner: string): string {
  return h('section', {
    gridColumn: `span ${cols}`, gridRow: `span ${rows}`, display: 'flex', padding: '2px', background: V('hyprland_active_border'), minWidth: '0',
  }, h('div', { flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px', background: V('background'), color: V('foreground'), fontFamily: MONO, minWidth: '0' }, inner, n('Content')), n(name));
}

const APPS: [string, string][] = [['terminal', 'Terminal'], ['globe', 'Firefox'], ['folder', 'Files'], ['message-square', 'Messages'], ['camera', 'Camera'], ['music', 'Music'], ['map', 'Maps'], ['settings', 'Settings']];

function appIcon(icon: string, label: string, selected = false): string {
  return h('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', padding: '8px 0', background: selected ? S('launcher', 'selected-background') : undefined }, [
    h('div', { width: '52px', height: '52px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: V('lighter_background'), color: selected ? S('launcher', 'selected-text') : V('foreground') }, glyph(icon, 26, 'currentColor'), n('Icon')),
    h('span', { fontSize: F(SCALE.caption), color: selected ? S('launcher', 'selected-text') : 'inherit', whiteSpace: 'nowrap' }, t(label), n('Name')),
  ], n(label));
}

/** The dock: one pill that is search, drawer and agent prompt, inside the launcher's 44 px strip. */
function dock(p: MobileProfile, focused = false): string {
  return h('div', { display: 'flex', alignItems: 'center', height: `${p.launcherStrip + 20}px`, padding: '0 20px', flexShrink: '0' },
    h('div', {
      flex: '1 1 auto', display: 'flex', alignItems: 'center', gap: '10px', height: `${p.launcherStrip}px`, padding: '0 16px', borderRadius: `${p.launcherStrip / 2}px`,
      background: S('launcher', 'background'), color: S('launcher', 'text'), border: `1px solid ${focused ? S('launcher', 'selected-text') : `color-mix(in srgb, ${V('foreground')} 25%, transparent)`}`, fontFamily: MONO, fontSize: F(SCALE.subtitle),
    }, [glyph('search', 18, 'currentColor', 'Search icon'), h('span', { opacity: focused ? '1' : '0.6' }, focused ? 'ter' : 'Search apps or ask', n('Query'))], n('Search pill')), n('Dock'));
}

function homeScreen(p: MobileProfile): string {
  return h('div', { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column' }, [
    statusBar(),
    h('div', { flex: '1 1 auto', display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gridAutoRows: '56px', gap: '10px', padding: '18px 16px', alignContent: 'start' }, [
      tile('Today', 6, 3, [
        h('p', { fontSize: F(SCALE.caption), color: V('muted') }, 'Thursday', n('Day')),
        h('p', { fontSize: F(SCALE.display), color: V('foreground') }, '14:51', n('Time')),
        h('p', { fontSize: F(SCALE.body), color: V('accent') }, '11° · light rain at 17:00', n('Weather')),
      ].join('')),
      tile('Memory', 3, 2, [
        h('p', { fontSize: F(SCALE.caption), color: V('muted') }, 'memory', n('Label')),
        h('p', { fontSize: F(SCALE.title), color: V('foreground') }, '41%', n('Value')),
        h('div', { height: '4px', background: V('lighter_background'), marginTop: 'auto' }, h('div', { width: '41%', height: '100%', background: V('accent') }, [], n('Used')), n('Bar')),
      ].join('')),
      tile('Agent', 3, 2, [
        h('p', { fontSize: F(SCALE.caption), color: V('muted') }, 'agent', n('Label')),
        h('p', { fontSize: F(SCALE.body), color: V('green') }, 'tests pass', n('Status')),
        h('p', { fontSize: F(SCALE.caption), color: V('yellow') }, '2 files changed', n('Detail')),
      ].join('')),
    ], n('Widgets')),
    h('div', { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', padding: '0 16px', color: V('foreground'), fontFamily: MONO }, APPS.slice(0, 4).map(([i, l]) => appIcon(i, l)), n('Apps')),
    dock(p),
    h('div', { height: `${p.pillStrip}px`, flexShrink: '0' }, [], n('Pill strip')),
  ], n('Home'));
}

/** squeekboard at the profile's panel size: four rows of keys and the strip under them. Colours are generated from colors.toml. */
function keyboard(p: MobileProfile): string {
  const row = (keys: string[], pad = 0) => h('div', { display: 'flex', justifyContent: 'center', gap: '6px', padding: `0 ${pad}px` }, keys.map((k) => h('span', {
    flex: k.length > 1 ? '1.6 1 0' : '1 1 0', height: '46px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '8px',
    background: k.length > 1 ? V('dark_background') : V('lighter_background'), color: V('foreground'), fontSize: '22px', fontFamily: "'Noto Sans', sans-serif",
  }, t(k), n(`Key ${k}`))), n('Row'));
  return h('div', { position: 'absolute', left: '0', right: '0', bottom: '0', height: `${p.keyboard.height}px`, display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px 3px 0', background: V('background') }, [
    row('qwertyuiop'.split('')), row('asdfghjkl'.split(''), 18), row(['⇧', ...'zxcvbnm'.split(''), '⌫']), row(['123', ',', 'space', '.', '⏎']),
    h('div', { height: `${p.keyboard.strip}px`, marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 16px', color: V('foreground') },
      ['globe', 'clipboard', 'mic', 'chevron-down'].map((i) => glyph(i, 20, 'currentColor')), n('Strip')),
  ], n('Keyboard'));
}

function drawerScreen(p: MobileProfile): string {
  return h('div', { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column' }, [
    h('div', { position: 'absolute', inset: '0', background: S('launcher', 'scrim') }, [], n('Scrim')),
    h('div', { position: 'relative', display: 'flex', flexDirection: 'column' }, statusBar(), n('Top')),
    h('div', {
      position: 'relative', flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '10px', margin: `12px 12px ${p.keyboard.height + 8}px`, padding: '2px',
      background: S('launcher', 'border'),
    }, h('div', { flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px', background: S('launcher', 'background'), color: S('launcher', 'text'), fontFamily: MONO }, [
      h('p', { fontSize: F(SCALE.caption), color: V('muted') }, '3 apps match "ter"', n('Count')),
      h('div', { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px' }, [appIcon('terminal', 'Terminal', true), appIcon('monitor', 'Btop'), appIcon('file-text', 'Notes')].join(''), n('Matches')),
      h('div', { display: 'flex', alignItems: 'center', gap: '10px', minHeight: `${p.touchMin + 4}px`, padding: '0 12px', marginTop: 'auto', border: `1px solid color-mix(in srgb, ${V('foreground')} 25%, transparent)` }, [
        glyph('sparkles', 18, S('launcher', 'selected-text'), 'Agent icon'),
        h('span', { fontSize: F(SCALE.body) }, 'Ask your agent: "ter"', n('Label')),
      ], n('Ask agent')),
    ], n('Card')), n('Drawer')),
    h('div', { position: 'absolute', left: '0', right: '0', bottom: `${p.keyboard.height}px` }, dock(p, true), n('Dock')),
    keyboard(p),
  ], n('Drawer and keyboard'));
}

function quickSettings(p: MobileProfile): string {
  const tileQs = (icon: string, label: string, state: string, on: boolean) => h('div', {
    display: 'flex', alignItems: 'center', gap: '10px', minHeight: `${p.touchMin + 12}px`, padding: '0 14px',
    background: on ? S('menu', 'selected-background') : `color-mix(in srgb, ${V('foreground')} 4%, transparent)`,
    border: `1px solid color-mix(in srgb, ${V('foreground')} ${on ? 40 : 18}%, transparent)`,
  }, [
    glyph(icon, 20, on ? S('menu', 'selected-text') : S('popups', 'text')),
    h('div', { display: 'flex', flexDirection: 'column', minWidth: '0' }, [
      h('span', { fontSize: F(SCALE.body), color: on ? S('menu', 'selected-text') : S('popups', 'text') }, t(label), n('Name')),
      h('span', { fontSize: F(SCALE.caption), color: V('muted') }, t(state), n('State')),
    ], n('Text')),
  ], n(label));
  return h('div', { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column' }, [
    h('div', { position: 'absolute', inset: '0', background: S('menu', 'scrim') }, [], n('Scrim')),
    h('div', { position: 'relative', display: 'flex', flexDirection: 'column', padding: '2px', background: S('popups', 'border') },
      h('div', { display: 'flex', flexDirection: 'column', gap: '14px', padding: '18px 16px 20px', background: S('popups', 'background'), color: S('popups', 'text'), fontFamily: MONO }, [
        h('div', { display: 'flex', justifyContent: 'space-between', fontSize: F(SCALE.title) }, [h('span', {}, '14:51', n('Time')), h('span', { color: V('muted'), fontSize: F(SCALE.body) }, 'Thu 5 Nov · 83%', n('Date'))], n('Header')),
        h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }, [
          tileQs('wifi', 'Wi-Fi', 'Home', true), tileQs('bluetooth', 'Bluetooth', 'Off', false), tileQs('moon', 'Dark', 'On', true),
          tileQs('flashlight', 'Torch', 'Off', false), tileQs('mic', 'Dictation', 'Ready', false), tileQs('circle-dot', 'Record', 'Off', false),
        ].join(''), n('Tiles')),
        h('div', { display: 'flex', alignItems: 'center', gap: '12px', minHeight: `${p.touchMin}px` }, [
          glyph('sun', 18, S('popups', 'text')),
          h('div', { flex: '1 1 auto', height: '6px', background: `color-mix(in srgb, ${V('foreground')} 18%, transparent)` }, h('div', { width: '62%', height: '100%', background: V('accent') }, [], n('Level')), n('Track')),
        ], n('Brightness')),
      ], n('Panel')), n('Quick settings')),
    h('div', { position: 'relative', display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px 12px' }, [
      notificationCard('Messages', 'Lena: Are we still on for 19:00?', false),
      notificationCard('Updates', '3 packages can be updated. Open the update sheet to review them.', true),
    ], n('Shade')),
  ], n('Quick settings and shade'));
}

function notificationCard(app: string, body: string, countdown: boolean): string {
  return h('article', { display: 'flex', padding: '2px', background: S('notifications', 'border') }, h('div', {
    flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '4px', padding: '12px 14px', background: S('notifications', 'background'), color: S('notifications', 'text'), fontFamily: MONO, position: 'relative',
  }, [
    h('p', { fontSize: F(SCALE.caption), color: V('muted') }, t(app), n('App')),
    h('p', { fontSize: F(SCALE.body), lineHeight: '1.4' }, t(body), n('Body')),
    countdown ? h('div', { position: 'absolute', left: '0', bottom: '0', height: '3px', width: '58%', background: S('notifications', 'countdown') }, [], n('Countdown')) : '',
  ], n('Card')), n(`Notification ${app}`));
}

/** The password dialog the shell shows for polkit, in its error state, and a switcher of recent apps behind it. */
function dialogScreen(p: MobileProfile): string {
  const card = (title: string, x: number) => h('div', { position: 'absolute', top: '120px', left: `${x}px`, width: '250px', height: '520px', display: 'flex', flexDirection: 'column', padding: '2px', background: S('menu', 'border') },
    h('div', { flex: '1 1 auto', display: 'flex', flexDirection: 'column', background: S('menu', 'background'), color: S('menu', 'text'), fontFamily: MONO }, [
      h('p', { padding: '10px 12px', fontSize: F(SCALE.body), borderBottom: `1px solid color-mix(in srgb, ${V('foreground')} 18%, transparent)` }, t(title), n('Title')),
      h('div', { flex: '1 1 auto', background: V('dark_background') }, [], n('Window')),
    ], n('Card')), n(`Recent ${title}`));
  return h('div', { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column' }, [
    h('div', { position: 'absolute', inset: '0', background: S('menu', 'scrim') }, [], n('Switcher scrim')),
    card('Terminal', -150), card('Firefox', 85), card('Files', 320),
    h('div', { position: 'absolute', inset: '0', background: S('polkit', 'scrim') }, [], n('Dialog scrim')),
    h('div', { position: 'absolute', left: '20px', right: '20px', top: '300px', display: 'flex', padding: '2px', background: S('polkit', 'border-error') },
      h('div', { flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px', background: S('polkit', 'background'), color: S('polkit', 'text'), fontFamily: MONO }, [
        h('div', { display: 'flex', alignItems: 'center', gap: '10px' }, [glyph('lock', 22, S('polkit', 'accent')), h('p', { fontSize: F(SCALE.title) }, 'Authentication required', n('Title'))], n('Head')),
        h('p', { fontSize: F(SCALE.body), lineHeight: '1.45' }, 'Files wants to change the owner of a folder outside your home.', n('Reason')),
        h('div', { display: 'flex', alignItems: 'center', minHeight: `${p.touchMin + 4}px`, padding: '0 14px', border: `2px solid ${S('polkit', 'border-error')}`, color: S('polkit', 'text-error'), fontSize: F(SCALE.subtitle) }, '••••••', n('Password')),
        h('p', { fontSize: F(SCALE.caption), color: S('polkit', 'text-error') }, 'That password did not work. Try again.', n('Error')),
        h('div', { display: 'flex', justifyContent: 'flex-end', gap: '10px' }, [
          h('span', { minHeight: `${p.touchMin}px`, display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: F(SCALE.body) }, 'Cancel', n('Cancel')),
          h('span', { minHeight: `${p.touchMin}px`, display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: F(SCALE.body), background: S('polkit', 'accent'), color: V('background') }, 'Authenticate', n('Authenticate')),
        ], n('Actions')),
      ], n('Card')), n('Password dialog')),
  ], n('Dialog and switcher'));
}

/** The native Pixel services app: Commons.Color for colour, its own Geist for type, actions outside the scroll area. */
function servicesApp(p: MobileProfile): string {
  const row = (icon: string, title: string, detail: string, status?: string) => h('div', {
    display: 'flex', alignItems: 'center', gap: '14px', minHeight: '64px', padding: '0 16px', borderBottom: `1px solid color-mix(in srgb, ${V('foreground')} 12%, transparent)`,
  }, [
    glyph(icon, 22, V('accent')),
    h('div', { flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }, [
      h('span', { fontSize: '16px', fontWeight: '500' }, t(title), n('Title')),
      h('span', { fontSize: '13px', color: V('muted'), fontFamily: MONO }, t(detail), n('Detail')),
    ], n('Text')),
    status ? h('span', { fontSize: '13px', fontFamily: MONO, color: V('green') }, t(status), n('Status')) : '',
  ], n(title));
  return h('div', { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column', background: V('background'), color: V('foreground'), fontFamily: GEIST }, [
    statusBar(),
    h('div', { display: 'flex', alignItems: 'center', gap: '8px', minHeight: '56px', padding: '0 8px' }, [
      h('span', { width: '48px', height: '48px', display: 'flex', alignItems: 'center', justifyContent: 'center' }, glyph('arrow-left', 22, V('foreground'), 'Back'), n('Back')),
      h('h1', { fontSize: '20px', fontWeight: '600' }, 'Dein Pixel', n('Title')),
    ], n('Header')),
    h('div', { flex: '1 1 auto', display: 'flex', flexDirection: 'column', overflow: 'hidden' }, [
      row('shield', 'Tailscale', 'connected · exit node off', 'on'),
      row('app-window', 'Web apps', '4 installed'),
      row('house', 'Home services', '7 links'),
      row('bell', 'Notifications', 'ntfy · not set up'),
      row('receipt', 'Receipt upload', 'choose a file'),
    ], n('List')),
    h('div', { display: 'flex', padding: '12px 16px', flexShrink: '0' }, h('span', {
      flex: '1 1 auto', minHeight: '52px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: V('accent'), color: V('background'), fontSize: '16px', fontWeight: '600',
    }, 'Add a web app', n('Primary action')), n('Actions')),
    h('div', { height: `${p.pillStrip}px`, flexShrink: '0' }, [], n('Pill strip')),
  ], n('Pixel services'));
}

/** Where the phone's own UI keeps clear: corner arcs, back-gesture edges, the pill strip and the keyboard. Not exported. */
function guides(p: MobileProfile): string {
  const line = 'var(--omarchy-red)';
  const label = (text: string, style: Style) => h('span', { position: 'absolute', fontFamily: MONO, fontSize: '11px', color: line, background: V('background'), padding: '1px 4px', ...style }, t(text), n('Label'));
  return h('div', { position: 'absolute', inset: '0' }, [
    h('div', { position: 'absolute', inset: '0', borderRadius: `${p.cornerRadius}px`, border: `1px dashed ${line}` }, [], n('Corner arc')),
    h('div', { position: 'absolute', top: '0', bottom: '0', left: '0', width: `${p.backEdge}px`, background: `color-mix(in srgb, ${line} 14%, transparent)` }, [], n('Back edge left')),
    h('div', { position: 'absolute', top: '0', bottom: '0', right: '0', width: `${p.backEdge}px`, background: `color-mix(in srgb, ${line} 14%, transparent)` }, [], n('Back edge right')),
    h('div', { position: 'absolute', left: '0', right: '0', bottom: '0', height: `${p.pillStrip}px`, borderTop: `1px dashed ${line}` }, [], n('Pill strip')),
    h('div', { position: 'absolute', left: '0', right: '0', bottom: '0', height: `${p.keyboard.height + p.pillStrip}px`, borderTop: `1px dashed ${line}` }, [], n('Keyboard over an app')),
    label(`corner ${p.cornerRadius}`, { top: '18px', left: '50%' }),
    label(`back edge ${p.backEdge}`, { top: '45%', left: '4px' }),
    label(`pill strip ${p.pillStrip}`, { bottom: `${p.pillStrip + 4}px`, right: `${p.backEdge + 4}px` }),
    label(`keyboard ${p.keyboard.height} + pill ${p.pillStrip}`, { bottom: `${p.keyboard.height + p.pillStrip + 4}px`, right: `${p.backEdge + 4}px` }),
    label(`touch targets ≥ ${p.touchMin}`, { top: '45%', right: `${p.backEdge + 4}px` }),
  ], n('Safe areas'));
}

/** Board names a mobile theme is read by. */
export const MOBILE_BOARD_NAMES = {
  phone: /^Phone · /,
  preview: /^Preview · mobile$/,
  guide: /^Guide · /,
} as const;

export function mobileBoards(input: MobileBoardsInput): MobileBoard[] {
  const p = input.profile;
  const { width: W, height: H } = p.logical;
  const boards: MobileBoard[] = [];
  const below = H + GAP * 3;
  const images = input.backgrounds ?? [];
  // A background at the panel's own pixels: what Omarchy sets as the wallpaper on the phone.
  const bgs = images.length ? images.map((img, i) => ({ name: `Background ${i + 1} · ${img.name}`, html: imageWallpaper(img) })) : [{ name: `Background 1 · ${p.panel.width} × ${p.panel.height}`, html: wallpaper() }];
  let x = 0;
  bgs.forEach((b, i) => {
    boards.push({ kind: 'background', name: b.name, x, y: below, width: p.panel.width, height: p.panel.height, background: V('background'), html: i === 0 ? b.html : b.html.replace('data-name="Wallpaper"', 'data-name="Image"'), components: i === 0 ? ['Wallpaper'] : [] });
    x += p.panel.width + GAP;
  });
  const screens: [string, string, string][] = [
    ['Phone · lock screen', 'Screen lock', lockScreen(p)],
    ['Phone · home', 'Screen home', homeScreen(p)],
    ['Phone · drawer and keyboard', 'Screen drawer', drawerScreen(p)],
    ['Phone · quick settings and notifications', 'Screen quick settings', quickSettings(p)],
    ['Phone · dialog and recent apps', 'Screen dialog', dialogScreen(p)],
    ['Phone · Pixel services app', 'Screen services', servicesApp(p)],
  ];
  screens.forEach(([name, component, html], i) => {
    const withWall = name.includes('services') ? html : wall + html;
    boards.push({ kind: 'phone', name, x: i * (W + GAP), y: 0, width: W, height: H, background: V('background'), html: h('div', { position: 'relative', flex: '1 1 auto', overflow: 'hidden' }, withWall, n(component)), components: [component] });
  });
  boards.push({ kind: 'guide', name: 'Guide · safe areas', x: screens.length * (W + GAP), y: 0, width: W, height: H, background: V('background'), html: `<x-instance component="Screen home" style="position:absolute;inset:0;width:100%;height:100%"></x-instance>` + guides(p), components: [] });
  // preview.png for the theme picker, 1800 x 1012 as the stock previews are: three screens side by side.
  const inst = (component: string) => `<div style="width:${W}px;height:${H}px;display:flex;flex-shrink:0;position:relative;overflow:hidden;border-radius:${p.cornerRadius}px" data-name="${component}"><x-instance component="${component}" style="width:100%;height:100%"></x-instance></div>`;
  boards.push({
    kind: 'preview', name: 'Preview · mobile', x: 0, y: below + p.panel.height + GAP, width: 1800, height: 1012, background: V('background'),
    html: wall + h('div', { position: 'absolute', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '60px', background: `color-mix(in srgb, ${V('darker_background')} 60%, transparent)` }, [inst('Screen lock'), inst('Screen home'), inst('Screen drawer')].join(''), n('Phones')),
    components: [],
  });
  return boards;
}
