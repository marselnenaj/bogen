// The Omarchy theme template: the palette as tokens named after colors.toml, previews of the desktop drawn from those
// tokens, and the images a theme ships as artboards of their own. Every colour on these boards is a var(--omarchy-…),
// so changing a token changes every preview at once.
//
// The previews follow the Omarchy shell of November 2026 (4.0) at its stock sizes on a 1920 x 1080 screen: a 26 px bar
// at a 12 px base font, Hyprland gaps of 5 and 10 with 2 px borders, the launcher card of 300, a notification of 380 with a
// border, and the lock screen's 381 x 67 field with a 3 px border over the blurred background.
//
// A theme may have more displays: a monitor turned on its side, or another size. Each gets the same four previews laid
// out for its own size, never one landscape picture stretched: the bar and the shell's surfaces keep their pixel sizes,
// and the windows tile the way dwindle splits a tall screen. A portrait or square display shows a wallpaper composition
// of its own shape (the component "Wallpaper · portrait 9:16"), not the landscape Wallpaper cropped.

import { iconSvg } from '@bogen/core/icons';
import { aspectOf, CANONICAL, needsOwnWallpaper, orientationOf, sizeLabel, wallpaperComponentName, type DisplaySize, type Orientation } from '../omarchy-displays.ts';
import { h, t, type Style } from './kit.ts';

export interface ThemeScreen { width: number; height: number }
export interface ThemeImage {
  src: string;
  width: number;
  height: number;
  name: string;
  /** Vector art (a Bogen collection preset): drawn as an svg layer filling the board instead of a picture. */
  svg?: string;
}

/** A wallpaper composition of a shape other than landscape: drawn from the palette, or a picture of that shape. */
export interface DisplayWallpaperPlan {
  /** Any display of the shape; the composition is named after its ratio. */
  shape: DisplaySize;
  /** The board's size: what it is exported at. */
  size: DisplaySize;
  /** A picture of this shape the theme brought: shown as it is, not drawn from the palette. */
  image?: ThemeImage;
}

export interface ThemeBoardsInput {
  name: string;
  /** The folder name, shown in the terminal's prompt. */
  slug?: string;
  /** Background artboards: one per landscape screen size for a new theme. Portrait screens get a composition instead. */
  screens: ThemeScreen[];
  /** A theme loaded from disk: its background images, one artboard each, at the image's own shape. */
  backgrounds?: ThemeImage[];
  /** Its unlock.png, the logo of the boot unlock screen. */
  unlock?: ThemeImage;
  /** The fonts Omarchy installs are here, so the bar can use the glyphs the real one draws. */
  glyphs?: boolean;
  /** Displays besides the 1920 x 1080 previews, each with its own four previews. */
  displays?: DisplaySize[];
  /** Compositions for the displays that are not landscape, one per shape. */
  wallpapers?: DisplayWallpaperPlan[];
}

export type ThemeBoardKind = 'background' | 'display-background' | 'unlock' | 'desktop' | 'launcher' | 'lock' | 'boot';

export interface ThemeBoard {
  kind: ThemeBoardKind;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** An artboard's own background: a token, or transparent for images exported with alpha. */
  background: string;
  html: string;
  /** Layers in this board, by name, that become components for the boards after it. */
  components: string[];
  /** For the previews of a display and a display's composition: its size or shape, such as "portrait 1080 × 1920". */
  display?: string;
}

export const V = (key: string) => `var(--omarchy-${key.replace(/_/g, '-')})`;
export const MONO = "'JetBrains Mono', 'JetBrainsMono Nerd Font', ui-monospace, monospace";
/** The shell sets notifications in Liberation Sans; Arimo has its metrics and is a Google font, so renders find it. */
const SANS = "'Liberation Sans', Arimo, Arial, sans-serif";
const W = CANONICAL.width;
const H = CANONICAL.height;
const BAR = 26;
const GAPS_OUT = 10;
const GAPS_IN = 5;
const BORDER = 2;
const GAP = 160;

/** Names a person reads in the layer list. */
export const n = (name: string) => ({ 'data-name': name });

function icon(name: string, size: number, style: Style = {}, label?: string): string {
  return h('div', { width: `${size}px`, height: `${size}px`, flexShrink: '0', display: 'flex', ...style }, iconSvg(name, { strokeWidth: 2 }), n(label ?? name));
}

function line(parts: [string, string?, Style?][], name = 'Line'): string {
  return h('div', { display: 'flex', whiteSpace: 'pre', minHeight: '1.35em' }, parts.map(([text, key, style]) => h('span', { color: key ? V(key) : undefined, ...style }, t(text))), n(name));
}

// ---------------------------------------------------------------- backgrounds

/**
 * A new theme's landscape background before anyone designs it: a plain field of the theme's background colours,
 * deepening toward the top, with no layers and no text, since Omarchy shows it on the real desktop. That it is not
 * designed is said in Bogen (the theme's problems, the dialog, agents), never written into the wallpaper. No palette
 * pattern stands in for a design.
 */
export function wallpaper(): string {
  return h('div', {
    position: 'relative', flex: '1 1 auto', width: '100%', height: '100%', overflow: 'hidden', containerType: 'size',
    background: `linear-gradient(180deg, ${V('darker_background')} 0%, ${V('background')} 70%)`,
  }, [], n('Wallpaper'));
}

/** What the placeholder's note says; the status check knows it by this text and by its layer names. */
export const PORTRAIT_PLACEHOLDER_TEXT = 'Portrait composition not designed yet';
/** Layers Bogen generates in a composition that is not designed: they never count as a design. */
export const PORTRAIT_PLACEHOLDER_LAYERS: readonly string[] = ['Not designed yet', 'Placeholder hint'];
/**
 * Layers of the palette arcs Bogen drew into portrait compositions before November 2026. Files made then still have
 * them; they are a stand-in, not a design, however they are recoloured.
 */
export const LEGACY_PORTRAIT_LAYERS: readonly string[] = ['Arc red', 'Arc orange', 'Arc yellow', 'Arc green', 'Arc cyan', 'Arc blue', 'Arc magenta', 'Accent dot'];

/**
 * A composition of a shape that is not landscape, before anyone designs it: the theme's background colour with a quiet
 * note that says so. It is not a design and is never counted or shipped as one: the export leaves it out, the
 * portrait background plugin never shows it, and the status reads "needs its own design" until someone composes the
 * shape from the theme's own identity or assigns artwork made for it.
 */
export function portraitWallpaper(name: string, aspect = ''): string {
  return h('div', {
    position: 'relative', flex: '1 1 auto', width: '100%', height: '100%', overflow: 'hidden', containerType: 'size',
    background: V('background'), display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.2cqw',
  }, [
    h('div', { fontFamily: MONO, fontSize: '2.4cqw', color: V('foreground'), opacity: '0.34', letterSpacing: '0.02em', textAlign: 'center' }, t(PORTRAIT_PLACEHOLDER_TEXT), n(PORTRAIT_PLACEHOLDER_LAYERS[0]!)),
    h('div', { fontFamily: MONO, fontSize: '1.7cqw', color: V('foreground'), opacity: '0.22', textAlign: 'center' }, t(`${aspect ? `${aspect} · ` : ''}compose it from the theme, or assign artwork of this shape`), n(PORTRAIT_PLACEHOLDER_LAYERS[1]!)),
  ], n(name));
}

export function imageWallpaper(img: ThemeImage, name = 'Wallpaper'): string {
  return h('div', { position: 'relative', flex: '1 1 auto', width: '100%', height: '100%', overflow: 'hidden', background: V('background') }, [
    img.svg ? vectorArt(img.svg, img.name) : `<img src="${img.src}" alt="${t(img.name)}" style="width:100%;height:100%;object-fit:cover" data-name="${t(img.name)}">`,
  ], n(name));
}

/**
 * Vector art composed for this shape, as one svg layer that fills the composition and scales with it. Its root has a
 * viewBox and `preserveAspectRatio="xMidYMid slice"` and no size of its own (omarchy-collection.ts checks that).
 */
function vectorArt(svg: string, name: string): string {
  return svg.trim().replace(/^<svg\b/, `<svg data-bogen-scope="layer" style="position:absolute;inset:0;width:100%;height:100%;display:block" data-name="${t(name)}"`);
}

// ---------------------------------------------------------------- the bar

/**
 * The bar's glyphs as the stock shell draws them: the menu from Omarchy's own icon font, the rest Material Design
 * glyphs of the Nerd Font every Omarchy installs. Elsewhere, where those fonts are missing, line icons stand in.
 */
const GLYPH = { menu: '\ue900', focused: '\u{f14fb}', bluetooth: '\u{f00af}', network: '\u{f0928}', audio: '\u{f057e}', monitor: '\u{f0379}', power: '\u{f0079}' };
const NERD = "'JetBrainsMono Nerd Font', 'JetBrainsMono NF', 'Symbols Nerd Font'";

function omarchyMark(glyphs: boolean): string {
  if (glyphs) return h('span', { fontFamily: 'omarchy', fontSize: '12px', lineHeight: '1' }, GLYPH.menu, n('Omarchy mark'));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="1" width="12" height="12"/><rect x="5" y="5" width="4" height="4" fill="currentColor" stroke="none"/></svg>`;
}

/** One of the bar's 27 px icon slots, with the glyph at the shell's icon size of 13. */
function indicator(name: keyof typeof GLYPH, fallback: string, glyphs: boolean): string {
  const inner = glyphs ? h('span', { fontFamily: NERD, fontSize: '13px', lineHeight: '1' }, GLYPH[name], n('Glyph')) : icon(fallback, 13);
  return h('div', { width: '27px', height: `${BAR}px`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: '0' }, inner, n(name[0]!.toUpperCase() + name.slice(1)));
}

/**
 * The stock bar of shell.json at base size 12: the menu and five workspaces of 20 px with 1 px between on the left,
 * the clock in the centre, and bluetooth, network, audio, monitor and power on the right.
 */
function bar(glyphs = false): string {
  const slot = (label: string, content: string, dim: boolean) => h('div', { width: '20px', height: `${BAR}px`, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: dim ? '0.5' : undefined }, content, n(label));
  const workspaces = h('div', { display: 'flex', alignItems: 'center', gap: '1px', paddingRight: '1.5px' }, [
    slot('Workspace 1, focused', glyphs ? h('span', { fontFamily: NERD, lineHeight: '1' }, GLYPH.focused, n('Glyph')) : h('div', { width: '8px', height: '8px', background: V('foreground'), borderRadius: '2px' }, [], n('Mark')), false),
    slot('Workspace 2', '2', false),
    slot('Workspace 3', '3', true),
    slot('Workspace 4', '4', true),
    slot('Workspace 5', '5', true),
  ], n('Workspaces'));
  return h('header', {
    display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', height: `${BAR}px`, flexShrink: '0', padding: '0 8px',
    background: V('background'), color: V('foreground'), fontFamily: MONO, fontSize: '12px', lineHeight: '1',
  }, [
    h('div', { display: 'flex', alignItems: 'center' }, [h('div', { display: 'flex', alignItems: 'center', padding: '0 7.5px', height: `${BAR}px` }, omarchyMark(glyphs), n('Menu')), workspaces], n('Left')),
    h('div', { display: 'flex', alignItems: 'center', padding: '0 7.5px' }, h('span', {}, 'Monday 20:14', n('Clock')), n('Center')),
    h('div', { display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }, [
      indicator('bluetooth', 'bluetooth', glyphs), indicator('network', 'wifi', glyphs), indicator('audio', 'volume-2', glyphs), indicator('monitor', 'monitor', glyphs), indicator('power', 'battery-full', glyphs),
    ], n('Right')),
  ], n('Bar'));
}

// ---------------------------------------------------------------- windows

/** A Hyprland window: the border is a frame of its own, so a gradient border token draws as Hyprland draws it. */
function windowFrame(name: string, active: boolean, inner: string, style: Style = {}): string {
  return h('div', { display: 'flex', flexDirection: 'column', padding: `${BORDER}px`, background: V(active ? 'hyprland_active_border' : 'hyprland_inactive_border'), minHeight: '0', minWidth: '0', ...style }, [
    h('div', { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: '0', overflow: 'hidden', background: V('background'), opacity: active ? undefined : '0.97' }, inner, n('Surface')),
  ], n(name));
}

const TERM: Style = { display: 'flex', flexDirection: 'column', padding: '14px', fontFamily: MONO, fontSize: '12.5px', lineHeight: '1.38', color: V('foreground'), flex: '1 1 auto' };

function prompt(dir: string, cmd: string, cursor = false): string {
  return line([[`~/themes/${dir} `, 'cyan', { fontWeight: '700' }], ['❯ ', 'green', { fontWeight: '700' }], [cmd, 'foreground'], ...(cursor ? [[' ', undefined, { background: V('bright_foreground') }] as [string, string?, Style?]] : [])], 'Prompt');
}

function swatches(keys: string[], name: string): string {
  return h('div', { display: 'flex' }, keys.map((k) => h('div', { width: '26px', height: '15px', background: V(k) }, [], n(k))), n(name));
}

function terminal(name: string, dir: string): string {
  const facts: [string, string][] = [['OS', 'Omarchy 3.2'], ['Kernel', 'Linux 6.18'], ['WM', 'Hyprland'], ['Shell', 'bash 5.3'], ['Terminal', 'Alacritty'], ['Theme', name], ['Font', 'JetBrains Mono']];
  return h('div', TERM, [
    prompt(dir, 'fastfetch'),
    h('div', { display: 'flex', gap: '26px', padding: '8px 0 10px' }, [
      h('div', { display: 'grid', gridTemplateColumns: 'repeat(4, 12px)', gridAutoRows: '12px', gap: '3px', alignContent: 'start', paddingTop: '3px' },
        ['accent', 'accent', 'accent', 'accent', 'accent', 'none', 'none', 'accent', 'accent', 'none', 'bright_foreground', 'accent', 'accent', 'accent', 'accent', 'accent']
          .map((k, i) => h('div', { background: k === 'none' ? undefined : V(k) }, [], n(`Logo ${i + 1}`))), n('Logo')),
      h('div', { display: 'flex', flexDirection: 'column' }, [
        line([['you', 'accent', { fontWeight: '700' }], ['@', 'foreground'], ['omarchy', 'accent', { fontWeight: '700' }]], 'Host'),
        line([['-------------', 'dark_foreground']], 'Rule'),
        ...facts.map(([k, v]) => line([[k.padEnd(10), 'accent', { fontWeight: '700' }], [v, 'foreground']], k)),
        h('div', { display: 'flex', flexDirection: 'column', paddingTop: '8px' }, [
          swatches(['background', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'foreground'], 'Normal colours'),
          swatches(['muted', 'bright_red', 'bright_green', 'bright_yellow', 'bright_blue', 'bright_magenta', 'bright_cyan', 'bright_foreground'], 'Bright colours'),
        ], n('Colours')),
      ], n('Facts')),
    ], n('Fastfetch')),
    prompt(dir, 'git log --oneline -4'),
    line([['3f9c2a1 ', 'yellow'], ['(', 'yellow'], ['HEAD -> ', 'cyan', { fontWeight: '700' }], ['main', 'green', { fontWeight: '700' }], [') ', 'yellow'], ['Warmer accent, calmer borders', 'foreground']], 'Commit 1'),
    line([['b12e07d ', 'yellow'], ['Backgrounds at 3840 and 2160 wide', 'foreground']], 'Commit 2'),
    line([['8d41f6c ', 'yellow'], ['Lock screen field on the blur', 'foreground']], 'Commit 3'),
    line([['0aa93be ', 'yellow'], ['Start from Tokyo Night', 'foreground']], 'Commit 4'),
    h('div', { height: '10px' }, [], n('Space')),
    prompt(dir, 'ls'),
    line([['backgrounds  ', 'blue', { fontWeight: '700' }], ['colors.toml  icons.theme  ', 'foreground'], ['preview.png  ', 'magenta'], ['unlock.png', 'magenta']], 'Listing'),
    h('div', { height: '10px' }, [], n('Space')),
    prompt(dir, '', true),
  ], n('Terminal'));
}

function editor(): string {
  const K = 'magenta';
  const code: [string, string?, Style?][][] = [
    [['-- Look and feel, read by Hyprland at login', 'muted', { fontStyle: 'italic' }]],
    [['local ', K], ['theme', 'red'], [' = ', 'foreground'], ['require', 'cyan'], ['(', 'foreground'], ['"omarchy.theme"', 'green'], [')', 'foreground']],
    [],
    [['hl', 'red'], ['.', 'foreground'], ['config', 'blue'], ['({', 'foreground']],
    [['  general = {', 'foreground']],
    [['    gaps_in', 'red'], [' = ', 'foreground'], ['5', 'orange'], [',', 'foreground']],
    [['    gaps_out', 'red'], [' = ', 'foreground'], ['10', 'orange'], [',', 'foreground']],
    [['    border_size', 'red'], [' = ', 'foreground'], ['2', 'orange'], [',', 'foreground']],
    [['    col', 'red'], [' = { ', 'foreground'], ['active_border', 'red'], [' = ', 'foreground'], ['theme', 'red'], ['.', 'foreground'], ['accent', 'blue'], [' },', 'foreground']],
    [['    layout', 'red'], [' = ', 'foreground'], ['"dwindle"', 'green'], [',', 'foreground']],
    [['  },', 'foreground']],
    [['  decoration = {', 'foreground']],
    [['    rounding', 'red'], [' = ', 'foreground'], ['0', 'orange'], [',', 'foreground']],
    [['    shadow', 'red'], [' = { ', 'foreground'], ['enabled', 'red'], [' = ', 'foreground'], ['false', 'orange'], [' },', 'foreground']],
    [['    blur', 'red'], [' = { ', 'foreground'], ['enabled', 'red'], [' = ', 'foreground'], ['true', 'orange'], [', ', 'foreground'], ['size', 'red'], [' = ', 'foreground'], ['3', 'orange'], [', ', 'foreground'], ['passes', 'red'], [' = ', 'foreground'], ['2', 'orange'], [' },', 'foreground']],
    [['  },', 'foreground']],
    [['  animations = {', 'foreground']],
    [['    enabled', 'red'], [' = ', 'foreground'], ['true', 'orange'], [',', 'foreground']],
    [['    bezier', 'red'], [' = { ', 'foreground'], ['"easeOutQuint, 0.23, 1, 0.32, 1"', 'green'], [' },', 'foreground']],
    [['  },', 'foreground']],
    [['})', 'foreground']],
    [],
    [['-- Terminals a touch see-through, the rest solid', 'muted', { fontStyle: 'italic' }]],
    [['for ', K], ['_', 'red'], [', ', 'foreground'], ['tag', 'red'], [' in ', K], ['ipairs', 'cyan'], ['({ ', 'foreground'], ['"terminal"', 'green'], [', ', 'foreground'], ['"editor"', 'green'], [' }) ', 'foreground'], ['do', K]],
    [['  o', 'red'], ['.', 'foreground'], ['window', 'blue'], ['({ ', 'foreground'], ['tag', 'red'], [' = ', 'foreground'], ['tag', 'red'], [' }, { ', 'foreground'], ['opacity', 'red'], [' = ', 'foreground'], ['"0.97 0.9"', 'green'], [' })', 'foreground']],
    [['end', K]],
    [],
    [['local function ', K], ['apply', 'blue'], ['(', 'foreground'], ['name', 'red'], [')', 'foreground']],
    [['  if ', K], ['not ', K], ['name', 'red'], [' then ', K], ['return ', K], ['nil', 'orange'], [' end', K]],
    [['  return ', K], ['os', 'red'], ['.', 'foreground'], ['execute', 'blue'], ['(', 'foreground'], ['"omarchy theme set "', 'green'], [' .. ', 'foreground'], ['name', 'red'], [')', 'foreground']],
    [['end', K]],
    [],
    [['return ', K], ['{ ', 'foreground'], ['apply', 'red'], [' = ', 'foreground'], ['apply', 'blue'], [' }', 'foreground']],
  ];
  const rows = code.map((parts, i) => h('div', { display: 'flex', whiteSpace: 'pre', minHeight: '1.38em', background: i === 7 ? V('lighter_background') : undefined }, [
    h('span', { width: '34px', flexShrink: '0', textAlign: 'right', paddingRight: '12px', color: V(i === 7 ? 'accent' : 'muted') }, String(i + 1), n('Number')),
    ...parts.map(([text, key, style]) => h('span', { color: key ? V(key) : undefined, background: i === 18 && key === 'green' ? V('selection') : undefined, ...style }, t(text))),
  ], n(`Line ${i + 1}`)));
  return h('div', { display: 'flex', flexDirection: 'column', flex: '1 1 auto', fontFamily: MONO, fontSize: '12.5px', lineHeight: '1.38', color: V('foreground') }, [
    h('div', { display: 'flex', fontSize: '12px', background: V('dark_background'), color: V('dark_foreground') }, [
      h('span', { padding: '3px 12px', background: V('background'), color: V('foreground') }, 'looknfeel.lua', n('Tab, current')),
      h('span', { padding: '3px 12px' }, 'bindings.lua', n('Tab')),
    ], n('Tabs')),
    h('div', { display: 'flex', flexDirection: 'column', flex: '1 1 auto', paddingTop: '6px' }, rows, n('Code')),
    h('div', { display: 'flex', alignItems: 'center', fontSize: '12px', background: V('dark_background') }, [
      h('span', { padding: '2px 10px', background: V('accent'), color: V('background'), fontWeight: '700' }, 'NORMAL', n('Mode')),
      h('span', { padding: '2px 10px', color: V('foreground'), background: V('lighter_background') }, ' main', n('Branch')),
      h('span', { padding: '2px 10px', color: V('dark_foreground'), flex: '1 1 auto' }, '~/.config/hypr/looknfeel.lua', n('File')),
      h('span', { padding: '2px 10px', color: V('dark_foreground') }, 'lua  8:20', n('Position')),
    ], n('Status line')),
  ], n('Editor'));
}

function tests(dir: string): string {
  return h('div', TERM, [
    prompt(dir, 'npm test'),
    line([[' RUN ', 'background', { background: V('blue'), fontWeight: '700' }], [` v4.0  ~/themes/${dir}`, 'dark_foreground']], 'Run'),
    h('div', { height: '8px' }, [], n('Space')),
    line([[' \u2713\uFE0E ', 'green'], ['colors.toml keys match the stock themes', 'foreground'], ['  12ms', 'dark_foreground']], 'Pass 1'),
    line([[' \u2713\uFE0E ', 'green'], ['backgrounds render at 3840 x 2160', 'foreground'], ['  1.2s', 'dark_foreground']], 'Pass 2'),
    line([[' \u2713\uFE0E ', 'green'], ['install refuses to overwrite', 'foreground'], ['  4ms', 'dark_foreground']], 'Pass 3'),
    line([[' ! ', 'yellow'], ['contrast of muted on background is 3.9', 'yellow']], 'Warning'),
    line([[' ✗ ', 'red'], ['unlock.png is missing', 'red']], 'Fail'),
    h('div', { height: '8px' }, [], n('Space')),
    line([[' Tests  ', 'dark_foreground'], ['1 failed', 'bright_red', { fontWeight: '700' }], [' | ', 'dark_foreground'], ['3 passed', 'bright_green', { fontWeight: '700' }], [' (4)', 'dark_foreground']], 'Summary'),
  ], n('Tests'));
}

/**
 * Three windows tiled the way dwindle splits them. On a wide screen the first split is side by side and the right
 * half splits again top to bottom; on a tall one the first split is top to bottom, and the lower half, wider than tall,
 * splits side by side. So a portrait screen has the editor across its width and two terminals under it.
 */
function desktopWindows(name: string, dir: string, orientation: Orientation = 'landscape'): string {
  const area: Style = { position: 'absolute', top: `${BAR + GAPS_OUT}px`, left: `${GAPS_OUT}px`, right: `${GAPS_OUT}px`, bottom: `${GAPS_OUT}px`, display: 'flex', gap: `${GAPS_IN * 2}px` };
  if (orientation !== 'landscape') {
    return h('div', { ...area, flexDirection: 'column' }, [
      windowFrame('Editor', false, editor(), { flex: '1 1 0' }),
      h('div', { display: 'flex', gap: `${GAPS_IN * 2}px`, flex: '1.1 1 0', minHeight: '0' }, [
        windowFrame('Terminal, focused', true, terminal(name, dir), { flex: '1 1 0' }),
        windowFrame('Terminal', false, tests(dir), { flex: '1 1 0' }),
      ], n('Lower row')),
    ], n('Windows'));
  }
  return h('div', area, [
    h('div', { display: 'flex', flexDirection: 'column', gap: `${GAPS_IN * 2}px`, flex: '1 1 0', minWidth: '0' }, [
      windowFrame('Terminal, focused', true, terminal(name, dir), { flex: '1.25 1 0' }),
      windowFrame('Terminal', false, tests(dir), { flex: '1 1 0' }),
    ], n('Left column')),
    windowFrame('Editor', false, editor(), { flex: '1 1 0' }),
  ], n('Windows'));
}

function notification(name: string, screenWidth = W): string {
  const text = `color-mix(in srgb, ${V('foreground')} 87%, black)`;
  return h('aside', {
    position: 'absolute', top: `${BAR + GAPS_OUT}px`, right: `${GAPS_OUT}px`, width: `${Math.min(380, screenWidth - GAPS_OUT * 2)}px`, display: 'flex', padding: `${BORDER}px`,
    background: V('hyprland_active_border'),
  }, h('div', { display: 'flex', alignItems: 'center', gap: '12px', flex: '1 1 auto', padding: '10px 12px', background: V('background'), fontFamily: SANS, fontSize: '14px', lineHeight: '1.3' }, [
    h('div', { width: '40px', height: '40px', flexShrink: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: V('accent') }, iconSvg('palette', { strokeWidth: 1.75 }), n('Icon')),
    h('div', { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }, [
      h('p', { fontWeight: '700', color: V('foreground') }, 'Theme applied', n('Summary')),
      h('p', { color: text }, t(`${name} is now your theme. Undo in Bogen if it is not right yet.`), n('Body')),
    ], n('Text')),
  ], n('Card')), n('Notification'));
}

// ---------------------------------------------------------------- overlays

/** The root of omarchy-menu.jsonc: its Nerd Font glyph, a line icon for elsewhere, and the label. */
const MENU: [string, string, string][] = [
  ['\u{f003b}', 'layout-grid', 'Apps'], ['\u{f09d1}', 'graduation-cap', 'Learn'], ['\u{f14de}', 'zap', 'Trigger'], ['\uebcf', 'palette', 'Style'], ['\ue615', 'settings', 'Setup'],
  ['\u{f0249}', 'download', 'Install'], ['\u{f0b4c}', 'trash', 'Remove'], ['\uf021', 'refresh-cw', 'Update'], ['\uea74', 'info', 'About'], ['\uf011', 'power', 'System'],
];

function launcher(glyphs = false): string {
  return h('div', { position: 'absolute', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', background: `color-mix(in srgb, ${V('background')} 50%, transparent)` }, [
    outlined('Launcher', { width: '300px' }, `color-mix(in srgb, ${V('background')} 95%, transparent)`, V('foreground'), BORDER, h('div', {
      display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', flex: '1 1 auto', fontFamily: MONO, color: V('foreground'),
    }, [
      h('div', { display: 'flex', alignItems: 'center', height: '34px', fontSize: '16px', opacity: '0.58', paddingLeft: '6px' }, 'Go…', n('Search')),
      h('div', { display: 'flex', flexDirection: 'column' }, MENU.map(([glyph, ic, label], i) => {
        const cursor = i === 3;
        return h('div', {
          display: 'flex', alignItems: 'center', gap: '6px', height: '36px', padding: '0 8px', border: `1px solid ${cursor ? `color-mix(in srgb, ${V('foreground')} 25%, transparent)` : 'transparent'}`,
          background: cursor ? `color-mix(in srgb, ${V('foreground')} 8%, transparent)` : undefined, color: V(cursor ? 'accent' : 'foreground'),
        }, [
          h('div', { width: '36px', display: 'flex', justifyContent: 'center' }, glyphs ? h('span', { fontFamily: NERD, fontSize: '18px', lineHeight: '1' }, glyph, n('Glyph')) : icon(ic, 18), n('Icon')),
          h('span', { fontSize: '16px', fontWeight: '500' }, t(label), n('Label')),
        ], n(cursor ? `${label}, cursor` : label));
      }), n('Rows')),
    ], n('Menu'))),
  ], n('Scrim'));
}

/**
 * A see-through card with an outline on top, as the shell draws it: the outline is its own layer, masked to a ring, so
 * neither a gradient border shows through the fill nor the fill dims the border.
 */
export function outlined(name: string, style: Style, fill: string, border: string, width: number, inner: string): string {
  return h('div', { position: 'relative', display: 'flex', flexShrink: '0', ...style }, [
    h('div', { position: 'absolute', inset: '0', background: fill }, [], n('Fill')),
    h('div', {
      position: 'absolute', inset: '0', padding: `${width}px`, background: border,
      mask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
    }, [], n('Outline')),
    h('div', { position: 'relative', display: 'flex', flex: '1 1 auto', minWidth: '0', padding: `${width}px` }, inner, n('Content')),
  ], n(name));
}

/** The shell's lock field: 381 x 67, a 3 px outline in the active border, the background at 80 % and an 18 px placeholder. */
function lockField(): string {
  return h('div', { position: 'absolute', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center' }, outlined('Password', { width: '381px', height: '67px' },
    `color-mix(in srgb, ${V('background')} 80%, transparent)`, V('hyprland_active_border'), 3, h('div', {
      flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: `color-mix(in srgb, ${V('foreground')} 66%, ${V('background')})`, fontFamily: MONO, fontSize: '18px',
    }, 'Enter Password', n('Field'))), n('Centre'));
}

/**
 * The boot unlock screen as Omarchy's Plymouth script lays it out: unlock.png in the middle of the background colour,
 * the 286 x 48 entry 40 px below it with a 1 px line in the foreground, the lock at 80 % of the entry's height 15 px to
 * its left, and 7 px bullets 12 px apart.
 */
function bootScreen(logo: { width: number; height: number }, screen: DisplaySize = CANONICAL, logoHtml?: string): string {
  // Plymouth draws unlock.png at its own size on every screen (omarchy.script loads it and centres it, unscaled), so the
  // preview does too: a logo wider than a narrow display runs off its edges here as it would at boot, and the theme
  // says so in its problems (bootLogoProblems) rather than the preview hiding it.
  const { width: W, height: H } = screen;
  const entryTop = Math.round(H / 2 - logo.height / 2 + logo.height + 40);
  const lockH = 48 * 0.8;
  const lockW = 84 * (lockH / 96);
  const bullets = Array.from({ length: 6 }, (_, i) => h('div', { position: 'absolute', left: `${20 + i * 12}px`, top: '20.5px', width: '7px', height: '7px', borderRadius: '50%', background: V('foreground') }, [], n(`Bullet ${i + 1}`)));
  return h('div', { position: 'absolute', inset: '0' }, [
    logoHtml
      ? h('div', { position: 'absolute', left: `${(W - logo.width) / 2}px`, top: `${(H - logo.height) / 2}px`, width: `${logo.width}px`, height: `${logo.height}px`, display: 'flex' }, logoHtml, n('Logo'))
      : `<x-instance component="Unlock logo" style="position:absolute;left:${(W - logo.width) / 2}px;top:${(H - logo.height) / 2}px;width:${logo.width}px;height:${logo.height}px"></x-instance>`,
    h('div', { position: 'absolute', left: `${W / 2 - 143 - 15 - lockW}px`, top: `${entryTop + 24 - lockH / 2}px`, width: `${lockW}px`, height: `${lockH}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', color: V('foreground') }, [
      h('div', { width: '62%', height: '45%', border: `${Math.max(3, Math.round(lockW * 0.14))}px solid currentColor`, borderBottom: '0', borderRadius: '999px 999px 0 0', flexShrink: '0' }, [], n('Shackle')),
      h('div', { width: '100%', flex: '1 1 auto', background: 'currentColor', borderRadius: '3px' }, [], n('Body')),
    ], n('Lock')),
    h('div', { position: 'absolute', left: `${W / 2 - 143}px`, top: `${entryTop}px`, width: '286px', height: '48px', border: `1px solid ${V('foreground')}`, borderRadius: '2px', background: 'rgb(0 0 0 / 5%)' }, bullets, n('Entry')),
  ], n('Boot'));
}

export function unlockLogo(name: string, image?: ThemeImage): string {
  if (image) return h('div', { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }, `<img src="${image.src}" alt="unlock.png" style="max-width:100%;max-height:100%;object-fit:contain" data-name="unlock.png">`, n('Unlock logo'));
  return h('div', { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '28px', width: '100%', height: '100%', fontFamily: MONO, color: V('foreground') }, [
    h('div', { width: '112px', height: '112px', flexShrink: '0', borderRadius: '50%', border: `14px solid ${V('accent')}` }, [], n('Ring')),
    h('span', { fontSize: '96px', fontWeight: '700', letterSpacing: '-2px', lineHeight: '1' }, t(name.toLowerCase()), n('Name')),
  ], n('Unlock logo'));
}

// ---------------------------------------------------------------- the plan

/** What the previews of one display draw from: components of the file where they exist, its own drawing where not. */
export interface PreviewSources {
  /** The component the wallpaper of these previews is, or null to fill with the background colour. */
  wallpaper: string | null;
  /** Instance the theme's Bar, which the first desktop preview holds; else draw one. */
  barComponent: boolean;
  /** Instance the theme's Unlock logo; else draw one. */
  unlockComponent: boolean;
  /** The size of unlock.png, for the boot screen. */
  unlock: { width: number; height: number };
}

const PREVIEW_NAMES = { desktop: 'Preview · desktop', launcher: 'Preview · launcher', lock: 'Preview · lock screen', boot: 'Preview · boot unlock' } as const;

/** "Preview · desktop" for the 1920 x 1080 set, "Preview · desktop · portrait 1080 × 1920" for a display. */
export const previewName = (kind: keyof typeof PREVIEW_NAMES, display?: DisplaySize): string =>
  display ? `${PREVIEW_NAMES[kind]} · ${orientationOf(display)} ${sizeLabel(display)}` : PREVIEW_NAMES[kind];

/** The board a non-landscape composition is drawn on: "Portrait background · 9:16 · 2160 × 3840". */
export const displayBackgroundName = (shape: DisplaySize, size: DisplaySize): string => {
  const o = orientationOf(shape);
  return `${o[0]!.toUpperCase()}${o.slice(1)} background · ${aspectOf(shape)} · ${sizeLabel(size)}`;
};

/** The wallpaper component a display's previews show: the landscape Wallpaper, or the composition of its shape. */
export const wallpaperFor = (display: DisplaySize): string => (needsOwnWallpaper(display) ? wallpaperComponentName(aspectOf(display), orientationOf(display)) : 'Wallpaper');

/**
 * The four previews of one screen size, at (x, y), side by side. Without `display` it is the theme's own 1920 x 1080
 * set, whose desktop holds the Bar component. With one, the same surfaces laid out for that size.
 */
export function previewBoards(input: { name: string; slug: string; glyphs?: boolean; display?: DisplaySize; x: number; y: number; sources: PreviewSources }): ThemeBoard[] {
  const screen = input.display ?? CANONICAL;
  const { width, height } = screen;
  const label = input.display ? `${orientationOf(screen)} ${sizeLabel(screen)}` : undefined;
  const s = input.sources;
  const wall = s.wallpaper
    ? `<x-instance component="${t(s.wallpaper)}" style="position:absolute;inset:0;width:100%;height:100%"></x-instance>`
    : h('div', { position: 'absolute', inset: '0', background: V('background') }, [], n('Wallpaper'));
  const own = !input.display;
  const top = own || !s.barComponent
    ? h('div', { position: 'absolute', top: '0', left: '0', right: '0', display: 'flex', flexDirection: 'column' }, bar(input.glyphs), n('Top'))
    : `<div style="position:absolute;top:0;left:0;right:0;display:flex;flex-direction:column" data-name="Top"><x-instance component="Bar"></x-instance></div>`;
  const barInstance = s.barComponent || own
    ? `<div style="position:absolute;top:0;left:0;right:0;display:flex;flex-direction:column" data-name="Top"><x-instance component="Bar"></x-instance></div>`
    : top;
  const at = (i: number) => input.x + i * (width + GAP);
  const base = { y: input.y, width, height, background: V('background'), ...(label ? { display: label } : {}) };
  const blurred = s.wallpaper
    ? `<div style="position:absolute;inset:-60px;filter:blur(48px) contrast(0.92);display:flex" data-name="Blurred background"><x-instance component="${t(s.wallpaper)}" style="width:100%;height:100%"></x-instance></div>`
    : h('div', { position: 'absolute', inset: '0', background: V('background') }, [], n('Blurred background'));
  return [
    { ...base, kind: 'desktop', name: previewName('desktop', input.display), x: at(0), html: wall + top + desktopWindows(input.name, input.slug, orientationOf(screen)) + notification(input.name, width), components: own ? ['Bar'] : [] },
    { ...base, kind: 'launcher', name: previewName('launcher', input.display), x: at(1), html: wall + barInstance + launcher(input.glyphs), components: [] },
    { ...base, kind: 'lock', name: previewName('lock', input.display), x: at(2), html: blurred + lockField(), components: [] },
    { ...base, kind: 'boot', name: previewName('boot', input.display), x: at(3), html: bootScreen(s.unlock, screen, s.unlockComponent ? undefined : unlockLogo(input.name)), components: [] },
  ];
}

/** The board of a non-landscape composition: a picture of that shape the theme brought, or the quiet placeholder, as a component. */
export function displayWallpaperBoard(plan: DisplayWallpaperPlan, x: number, y: number): ThemeBoard {
  const component = wallpaperFor(plan.shape);
  return {
    kind: 'display-background', name: displayBackgroundName(plan.shape, plan.size), x, y, width: plan.size.width, height: plan.size.height, background: V('background'),
    html: plan.image ? imageWallpaper(plan.image, component) : portraitWallpaper(component, aspectOf(plan.shape)), components: [component], display: `${orientationOf(plan.shape)} ${aspectOf(plan.shape)}`,
  };
}

/** An image from a theme at its own shape, as large as the screen it is for: never cropped to a screen it is not. */
export function imageBoardSize(img: { width: number; height: number }, screen: DisplaySize): DisplaySize {
  const long = Math.max(screen.width, screen.height);
  if (!img.width || !img.height) return screen;
  return img.width >= img.height
    ? { width: long, height: Math.max(1, Math.round((long * img.height) / img.width)) }
    : { width: Math.max(1, Math.round((long * img.width) / img.height)), height: long };
}

/** What `layout` places, in the order the boards must be written: mains before the instances of them. */
export function themeBoards(input: ThemeBoardsInput): ThemeBoard[] {
  const boards: ThemeBoard[] = [];
  const name = input.name || 'Theme';
  const dir = input.slug || 'theme';
  const displays = input.displays ?? [];
  const wallpapers = input.wallpapers ?? [];
  // Rows from the top: the 1920 x 1080 previews, a row for each other display, then the backgrounds and the logo, far
  // enough apart that their names stay readable when the canvas is zoomed out to see it all.
  const rows: number[] = [0];
  let next = H + GAP * 4;
  for (const d of displays) {
    rows.push(next);
    next += d.height + GAP * 4;
  }
  const below = next;

  // Backgrounds come first, as Background 1 holds the Wallpaper every landscape preview shows. They are what Omarchy
  // shows on every screen, so they are drawn for the landscape screens; a portrait screen gets a composition below.
  let x = 0;
  const landscape = input.screens.filter((s) => !needsOwnWallpaper(s));
  const first = landscape[0] ?? { width: 3840, height: 2160 };
  // The first landscape picture is the Wallpaper the landscape previews show, wherever it is in the theme's list: a
  // portrait picture first would otherwise be cropped into every landscape preview. The others follow in their order.
  const given = input.backgrounds ?? [];
  const lead = Math.max(0, given.findIndex((img) => img.width > 0 && img.height > 0 && orientationOf(img) === 'landscape'));
  const images = given.length ? [given[lead]!, ...given.filter((_, i) => i !== lead)] : [];
  const backgrounds = images.length
    ? images.map((img, i) => ({ screen: imageBoardSize(img, first), html: imageWallpaper(img), name: `Background ${i + 1} · ${img.name}` }))
    : (landscape.length ? landscape : [first]).map((s, i) => ({ screen: s, html: wallpaper(), name: `Background ${i + 1} · ${s.width} × ${s.height}` }));
  backgrounds.forEach((b, i) => {
    boards.push({ kind: 'background', name: b.name, x, y: below, width: b.screen.width, height: b.screen.height, background: V('background'), html: i === 0 ? b.html : b.html.replace('data-name="Wallpaper"', 'data-name="Image"'), components: i === 0 ? ['Wallpaper'] : [] });
    x += b.screen.width + GAP;
  });
  // A new theme's other screen sizes show the same design: an instance of the first, which follows it.
  if (!images.length) for (const b of boards.slice(1)) b.html = `<x-instance component="Wallpaper" style="width:100%;height:100%;flex:1 1 auto"></x-instance>`;
  // Each other shape has its own composition: designed for it, never the landscape picture cropped.
  for (const w of wallpapers) {
    boards.push(displayWallpaperBoard(w, x, below));
    x += w.size.width + GAP;
  }

  // Plymouth shows unlock.png at its own size; Omarchy's are 800 x 188, some themes ship a larger one.
  const own = input.unlock && input.unlock.width <= 1600 && input.unlock.height <= 900 ? input.unlock : null;
  const unlockW = own?.width ?? 800;
  const unlockH = own?.height ?? 188;
  boards.push({ kind: 'unlock', name: `Unlock logo · ${unlockW} × ${unlockH}`, x, y: below, width: unlockW, height: unlockH, background: 'transparent', html: unlockLogo(name, input.unlock), components: ['Unlock logo'] });

  const shapes = new Set(wallpapers.map((w) => wallpaperFor(w.shape)));
  const sources = (d?: DisplaySize): PreviewSources => {
    const wall = d ? wallpaperFor(d) : 'Wallpaper';
    return { wallpaper: wall === 'Wallpaper' || shapes.has(wall) ? wall : null, barComponent: true, unlockComponent: true, unlock: { width: unlockW, height: unlockH } };
  };
  boards.push(...previewBoards({ name, slug: dir, ...(input.glyphs !== undefined ? { glyphs: input.glyphs } : {}), x: 0, y: rows[0]!, sources: sources() }));
  displays.forEach((d, i) => boards.push(...previewBoards({ name, slug: dir, ...(input.glyphs !== undefined ? { glyphs: input.glyphs } : {}), display: d, x: 0, y: rows[i + 1]!, sources: sources(d) })));
  return boards;
}

/** Board names a theme file is read by when it is exported. A person may add more backgrounds: any board named Background. */
export const BOARD_NAMES = {
  background: /^Background\b/,
  unlock: /^Unlock logo\b/,
  desktop: /^Preview · desktop$/,
  boot: /^Preview · boot unlock$/,
  /** The previews of another display: "Preview · desktop · portrait 1080 × 1920". */
  display: /^Preview · (desktop|launcher|lock screen|boot unlock) · (landscape|portrait|square) (\d{3,5}) × (\d{3,5})$/,
  /** A composition of another shape: "Portrait background · 9:16 · 2160 × 3840". */
  displayBackground: /^(Portrait|Square|Landscape) background · ([\d.]+:[\d.]+) · (\d{2,5}) × (\d{2,5})$/,
} as const;
