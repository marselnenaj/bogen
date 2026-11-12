// An Omarchy theme as data: the keys of colors.toml, how they map to tokens of a Bogen file and back, and the
// fallbacks Omarchy itself applies. Pure: no files, no processes. The files are in omarchy-themes.ts.
//
// What Omarchy does with a theme, read from `omarchy-theme-set` and `omarchy-theme-set-templates`: it copies the stock
// theme of that name, then the user's folder over it, then writes every `default/themed/*.tpl` the theme does not ship,
// filled from colors.toml. So colors.toml is the theme; the per-app files are generated unless a theme brings its own.

import { normalizeColor } from '@bogen/core';
import { parse as parseToml } from 'smol-toml';
import type { ThemeDisplay, ThemeWallpaper } from './omarchy-displays.ts';
import type { ThemeVideo } from './omarchy-videos.ts';

/** The keys of a stock colors.toml, in its order and groups. Every stock theme has these (orange and brown since 2026). */
export const PALETTE_GROUPS: readonly (readonly string[])[] = [
  ['accent', 'selection', 'muted'],
  ['background', 'dark_background', 'darker_background', 'lighter_background'],
  ['foreground', 'dark_foreground', 'light_foreground', 'bright_foreground'],
  ['red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown'],
  ['bright_red', 'bright_yellow', 'bright_green', 'bright_cyan', 'bright_blue', 'bright_magenta'],
];
export const PALETTE_KEYS: readonly string[] = PALETTE_GROUPS.flat();

/** Window borders. Each takes a colour or a Hyprland gradient such as `rgba(26a269ee) rgba(2ec27eee) 45deg`. */
export const BORDER_KEYS = ['hyprland_active_border', 'hyprland_inactive_border'] as const;
/** What Hyprland gets when a theme leaves a border out, in CSS: the accent, and Omarchy's grey. */
export const BORDER_DEFAULTS: Record<(typeof BORDER_KEYS)[number], string> = {
  hyprland_active_border: 'var(--omarchy-accent)',
  hyprland_inactive_border: '#595959aa',
};

/**
 * Files Omarchy writes from colors.toml when a theme does not ship them: the templates in
 * `$OMARCHY_PATH/default/themed`. Read from there when it exists; this is the list of November 2026.
 */
export const GENERATED_FILES: readonly string[] = [
  'alacritty.toml', 'btop.theme', 'chromium.theme', 'claude.json', 'foot.ini', 'ghostty.conf', 'gum_env.lua', 'helix.toml',
  'hermes.yaml', 'hyprland.lua', 'hyprland-preview-share-picker.css', 'keyboard.rgb', 'kitty.conf', 'neovim.lua',
  'obsidian.css', 'pi.json', 'shell.toml', 't3code.json', 'vscode-theme.json',
];

/** What a theme from a Git repository may not ship, because it runs code (`INSTALLED_THEME_DENIED` and `*.lua`). */
export const REPO_DENIED: readonly string[] = ['alacritty.toml', 'foot.ini', 'ghostty.conf', 'kitty.conf', 'vscode.json'];
export const deniedFromRepo = (file: string): boolean => file.endsWith('.lua') || REPO_DENIED.includes(file);

export type ThemeMode = 'dark' | 'light';

/** A colors.toml read: the mode, colours as #rrggbb (or #rrggbbaa), borders and other keys as they were written. */
export interface ThemeColors {
  mode?: ThemeMode;
  colors: Record<string, string>;
  /** Keys whose value is not one colour, such as a border gradient or a legacy word, kept as written. */
  raw: Record<string, string>;
}

/** Where a theme is meant to run. Desktop is Omarchy on a computer; mobile is Omarchy Mobile on a named phone profile. */
export type ThemeTarget = 'desktop' | 'mobile';

/**
 * The version of `meta.omarchyTheme`. 1 is every file made before targets existed: it has no `target` and is a desktop
 * theme. 2 says its target, and for mobile its profile. A reader takes any version it knows and treats a missing one as 1.
 */
export const THEME_FORMAT = 2;

/** Stored in the file's `meta.omarchyTheme`. Additive: an older build keeps it and ignores it. */
export interface ThemeMeta {
  name: string;
  /** Format of this record. Missing means 1, a desktop theme from before targets. */
  format?: number;
  /** Missing means desktop, which is what every format-1 file is. */
  target?: ThemeTarget;
  /** For a mobile theme: the device profile it is made and checked for, such as komodo. */
  profile?: string;
  /** Intro videos (paired with a Background board) and loop wallpapers, Omarchy 4.5. */
  videos?: ThemeVideo[];
  mode?: ThemeMode;
  /** The icon theme in icons.theme. Left out, it follows the accent. */
  icons?: string;
  /** The installed theme this file started from. */
  from?: string;
  /**
   * Stable id of the logical theme, given when its file is made and kept through renames and branches: what finds the
   * project again. Files made before it have none.
   */
  project?: string;
  /** Keys of colors.toml that are neither colours nor borders, written back as they came. */
  extra?: Record<string, string>;
  /** Desktop displays besides the 1920 x 1080 previews, such as a monitor turned on its side. Desktop themes only. */
  displays?: ThemeDisplay[];
  /** The compositions of the shapes that are not landscape, and whether each still needs its own design. */
  wallpapers?: ThemeWallpaper[];
}

export const META_KEY = 'omarchyTheme';

// ---------------------------------------------------------------- names

const TOKEN_PREFIX = 'omarchy-';

/** `dark_background` is the token `omarchy-dark-background`, as `paletteTokens` names it. */
export function tokenForKey(key: string): string {
  return TOKEN_PREFIX + key.replace(/_/g, '-');
}

/** The colors.toml key of a token, or null for a token that is not one. */
export function keyForToken(name: string): string | null {
  if (!name.startsWith(TOKEN_PREFIX)) return null;
  const rest = name.slice(TOKEN_PREFIX.length);
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(rest) ? rest.replace(/-/g, '_') : null;
}

/**
 * The folder name Omarchy uses: `omarchy theme set` lowercases and turns spaces into dashes, and
 * `omarchy theme install` holds names to `^[a-z0-9_][a-z0-9._+-]*$`. Null when nothing usable is left.
 */
export function themeSlug(name: string): string | null {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    .replace(/\s+/g, '-').replace(/[^a-z0-9._+-]+/g, '').replace(/^[.+-]+/, '').replace(/-{2,}/g, '-').slice(0, 64);
  return validThemeName(slug) ? slug : null;
}

export function validThemeName(name: string): boolean {
  return /^[a-z0-9_][a-z0-9._+-]*$/.test(name) && name.length <= 64 && !name.includes('..');
}

/** The name people read: `tokyo-night` is Tokyo Night. */
export function displayName(slug: string): string {
  return slug.split(/[-_]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ') || slug;
}

// ---------------------------------------------------------------- colours

function hex(value: string): string | undefined {
  const raw = value.trim().toLowerCase().replace(/^(#|0x)/, '');
  if (/^[0-9a-f]{6}$/.test(raw) || /^[0-9a-f]{8}$/.test(raw)) return '#' + raw;
  if (/^[0-9a-f]{3}$/.test(raw)) return '#' + [...raw].map((c) => c + c).join('');
  return undefined;
}

/** sRGB mix the way `omarchy-theme-color` does it, rounded. */
export function mixHex(from: string, to: string, amount: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return '#' + [0, 1, 2].map((i) => Math.round(ch(from, i) * (1 - amount) + ch(to, i) * amount).toString(16).padStart(2, '0')).join('');
}

/** Omarchy's own test for light: the channels of the background add up to more than 382. */
export function modeOf(background: string | undefined): ThemeMode {
  const h = background && hex(background);
  if (!h) return 'dark';
  const sum = [1, 3, 5].reduce((s, i) => s + parseInt(h.slice(i, i + 2), 16), 0);
  return sum > 382 ? 'light' : 'dark';
}

/** Reads colors.toml. Never throws: a broken file gives no colours. */
export function parseColorsToml(text: string): ThemeColors {
  let doc: Record<string, unknown> = {};
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch {
    // Omarchy reads line by line and would get further; a file TOML cannot read is not one to design from.
  }
  const out: ThemeColors = { colors: {}, raw: {} };
  for (const [key, value] of Object.entries(doc)) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key)) continue;
    if (key === 'mode' || key === 'theme_type') {
      if (value === 'dark' || value === 'light') out.mode ??= value;
      continue;
    }
    const color = (BORDER_KEYS as readonly string[]).includes(key) ? undefined : hex(value);
    if (color) out.colors[key] = color;
    else out.raw[key] = value;
  }
  return out;
}

/**
 * Every palette key, filled the way `omarchy-theme-color` fills what a theme leaves out: short names (`bg`), ANSI
 * names (`color4`), then derived shades. So a theme with half a palette still shows what Omarchy would show.
 */
export function resolvePalette(given: Record<string, string>): Record<string, string> {
  const c: Record<string, string> = { ...given };
  const alias = (key: string, from: string) => { if (!c[key] && c[from]) c[key] = c[from]!; };
  for (const [key, short] of [['background', 'bg'], ['dark_background', 'dark_bg'], ['darker_background', 'darker_bg'], ['lighter_background', 'lighter_bg'], ['foreground', 'fg'], ['dark_foreground', 'dark_fg'], ['light_foreground', 'light_fg'], ['bright_foreground', 'bright_fg']] as const) alias(key, short);
  alias('background', 'color0');
  alias('foreground', 'color7');
  c.background ??= '#1a1b26';
  c.foreground ??= '#c0caf5';
  const ansi: Record<string, string> = { red: 'color1', green: 'color2', yellow: 'color3', blue: 'color4', magenta: 'color5', cyan: 'color6', bright_red: 'color9', bright_green: 'color10', bright_yellow: 'color11', bright_blue: 'color12', bright_magenta: 'color13', bright_cyan: 'color14' };
  for (const [key, from] of Object.entries(ansi)) alias(key, from);
  alias('magenta', 'purple');
  alias('bright_magenta', 'bright_purple');
  c.light_foreground ??= c.color7 ?? c.foreground;
  c.bright_foreground ??= c.color15 ?? c.foreground;
  c.lighter_background ??= c.color0 ?? c.background;
  c.dark_foreground ??= c.color8 ?? c.foreground;
  c.muted ??= c.color8 ?? c.dark_foreground;
  c.selection ??= c.selection_background ?? c.color8 ?? c.color0 ?? c.background;
  // Hues a palette lacks entirely: Omarchy would leave the template empty; a preview needs something to show.
  const hues: Record<string, string> = { red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2' };
  for (const [key, value] of Object.entries(hues)) c[key] ??= value;
  c.accent ??= c.blue!;
  c.orange ??= c.yellow!;
  c.brown ??= mixHex(c.orange!.slice(0, 7), '#000000', 0.5);
  c.dark_background ??= mixHex(c.background.slice(0, 7), '#000000', 0.25);
  c.darker_background ??= mixHex(c.background.slice(0, 7), '#000000', 0.5);
  for (const hue of ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta']) c[`bright_${hue}`] ??= mixHex(c[hue]!.slice(0, 7), '#ffffff', 0.2);
  const out: Record<string, string> = {};
  for (const key of PALETTE_KEYS) out[key] = c[key]!;
  return out;
}

// ---------------------------------------------------------------- borders: Hyprland and CSS

const HYPR_PART = /^(?:rgba?\(([0-9a-f]{6}(?:[0-9a-f]{2})?)\)|0x([0-9a-f]{8})|(#[0-9a-f]{6}(?:[0-9a-f]{2})?))$/i;

/** One colour of a Hyprland colour spec as CSS, or a palette name as its token. */
function hyprColorToCss(part: string, keys: ReadonlySet<string>): string | undefined {
  if (keys.has(part)) return `var(${'--' + tokenForKey(part)})`;
  const m = HYPR_PART.exec(part);
  if (m?.[1]) return '#' + m[1].toLowerCase();
  if (m?.[2]) return '#' + m[2].slice(2).toLowerCase() + m[2].slice(0, 2).toLowerCase();
  if (m?.[3]) return m[3].toLowerCase();
  const rgb = /^rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)$/i.exec(part.replace(/\s+/g, ''));
  if (rgb) {
    const a = rgb[4] !== undefined ? Math.round(Math.min(1, Number(rgb[4])) * 255).toString(16).padStart(2, '0') : '';
    return '#' + [rgb[1], rgb[2], rgb[3]].map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('') + (a === 'ff' ? '' : a);
  }
  return undefined;
}

/**
 * A Hyprland border as CSS for the previews: one colour stays a colour, several become a linear gradient. Hyprland's
 * 0deg runs left to right and turns anticlockwise, which is CSS 90deg turning the other way.
 */
export function hyprToCss(spec: string, keys: ReadonlySet<string> = new Set(PALETTE_KEYS)): string | undefined {
  const parts = spec.trim().split(/\s+/).filter(Boolean);
  let angle: number | undefined;
  const colors: string[] = [];
  for (const part of parts) {
    const deg = /^(-?\d+(?:\.\d+)?)deg$/.exec(part);
    if (deg) {
      angle = Number(deg[1]);
      continue;
    }
    const css = hyprColorToCss(part, keys);
    if (!css) return undefined;
    colors.push(css);
  }
  if (!colors.length) return undefined;
  if (colors.length === 1) return colors[0];
  return `linear-gradient(${Math.round((90 - (angle ?? 0)) * 100) / 100}deg, ${colors.join(', ')})`;
}

function cssColorToHypr(value: string): string | undefined {
  const v = value.trim();
  const token = /^var\(--omarchy-([a-z0-9-]+)\)$/.exec(v);
  if (token) return token[1]!.replace(/-/g, '_');
  const h = normalizeColor(v);
  if (!h) return undefined;
  return h.length === 9 ? `rgba(${h.slice(1)})` : `rgb(${h.slice(1)})`;
}

/** The other way, for colors.toml. Undefined when it is not a colour or a linear gradient of colours. */
export function cssToHypr(value: string): string | undefined {
  const v = value.trim();
  const grad = /^linear-gradient\((.*)\)$/i.exec(v);
  if (!grad) return cssColorToHypr(v);
  const args = splitArgs(grad[1]!);
  let angle = 180;
  const first = /^(-?\d+(?:\.\d+)?)deg$/.exec(args[0] ?? '');
  if (first) {
    angle = Number(first[1]);
    args.shift();
  } else if (/^to\s/.test(args[0] ?? '')) return undefined;
  const parts = args.map((a) => cssColorToHypr(a.replace(/\s+\d+(\.\d+)?%$/, '')));
  if (!parts.length || parts.some((p) => !p)) return undefined;
  const hyprAngle = Math.round((90 - angle) * 100) / 100;
  return `${parts.join(' ')}${hyprAngle ? ` ${((hyprAngle % 360) + 360) % 360}deg` : ''}`;
}

function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---------------------------------------------------------------- tokens

export interface ThemeToken { name: string; kind: 'color'; value: string }

/** The tokens a theme file holds: every palette key, both borders, and any other colour the theme had. */
export function themeTokens(colors: ThemeColors): ThemeToken[] {
  const palette = resolvePalette(colors.colors);
  const out: ThemeToken[] = PALETTE_KEYS.map((key) => ({ name: tokenForKey(key), kind: 'color', value: palette[key]! }));
  for (const key of BORDER_KEYS) {
    const given = colors.raw[key] ?? colors.colors[key];
    out.push({ name: tokenForKey(key), kind: 'color', value: (given && hyprToCss(given)) ?? BORDER_DEFAULTS[key] });
  }
  // Colours Omarchy reads only through its fallbacks (`color4`, `bg`) are folded into the palette above.
  const folded = /^(color\d+|bg|fg|dark_bg|darker_bg|lighter_bg|dark_fg|light_fg|bright_fg|purple|bright_purple|selection_background)$/;
  for (const [key, value] of Object.entries(colors.colors)) {
    if (PALETTE_KEYS.includes(key) || folded.test(key) || !/^[a-z0-9]+(_[a-z0-9]+)*$/.test(key)) continue;
    out.push({ name: tokenForKey(key), kind: 'color', value });
  }
  return out;
}

/** Keys that are not colours, borders or the mode: kept in the file's meta and written back. */
export function extraKeys(colors: ThemeColors): Record<string, string> {
  return Object.fromEntries(Object.entries(colors.raw).filter(([k]) => !(BORDER_KEYS as readonly string[]).includes(k)));
}

/** Resolves `var(--omarchy-x)` inside a token value, up to a few levels, so that an alias exports as the colour it shows. */
function resolveValue(value: string, tokens: Map<string, string>, depth = 0): string {
  if (depth > 8) return value;
  return value.replace(/var\(--([\w-]+)\)/g, (whole, name: string) => {
    const v = tokens.get(name);
    return v === undefined ? whole : resolveValue(v, tokens, depth + 1);
  });
}

export interface ThemeOut {
  mode: ThemeMode;
  /** In colors.toml order: the palette, the borders that differ from Omarchy's defaults, then the rest. */
  entries: [string, string][];
  /** Tokens that could not be written, with why. */
  problems: string[];
}

/** colors.toml from the tokens of a file. */
export function themeFromTokens(tokens: { name: string; kind: string; value: string }[], meta: Partial<ThemeMeta> = {}): ThemeOut {
  const byName = new Map(tokens.map((t) => [t.name, t.value]));
  const problems: string[] = [];
  const entries: [string, string][] = [];
  const seen = new Set<string>();
  const colorOf = (key: string): string | undefined => {
    const name = tokenForKey(key);
    const value = byName.get(name);
    if (value === undefined) return undefined;
    const h = normalizeColor(resolveValue(value, byName));
    if (!h) problems.push(`--${name} is ${value}, which is not one colour.`);
    return h ?? undefined;
  };
  for (const key of PALETTE_KEYS) {
    seen.add(key);
    const c = colorOf(key);
    if (c) entries.push([key, c]);
    else if (!byName.has(tokenForKey(key))) problems.push(`There is no --${tokenForKey(key)} token, so ${key} is left to Omarchy's fallback.`);
  }
  for (const key of BORDER_KEYS) {
    seen.add(key);
    const value = byName.get(tokenForKey(key));
    if (value === undefined || value.trim() === BORDER_DEFAULTS[key]) continue;
    const spec = cssToHypr(value);
    if (spec) entries.push([key, spec]);
    else problems.push(`--${tokenForKey(key)} is ${value}: a border takes a colour, a token or a linear gradient of them.`);
  }
  for (const t of tokens) {
    const key = keyForToken(t.name);
    // Surface roles go to shell.toml, never into colors.toml as stray colours.
    if (!key || seen.has(key) || t.kind !== 'color' || isShellToken(t.name)) continue;
    seen.add(key);
    const c = colorOf(key);
    if (c) entries.push([key, c]);
  }
  for (const [key, value] of Object.entries(meta.extra ?? {})) if (!seen.has(key)) entries.push([key, value]);
  const background = entries.find(([k]) => k === 'background')?.[1];
  return { mode: meta.mode ?? modeOf(background), entries, problems };
}

/** The file itself, laid out like the stock themes: mode, then the groups with a blank line between. */
export function colorsToml(out: ThemeOut): string {
  const quote = (v: string) => `"${v.replace(/["\\]/g, '')}"`;
  const map = new Map(out.entries);
  const lines: string[] = [`mode = ${quote(out.mode)}`];
  const done = new Set<string>();
  for (const group of [...PALETTE_GROUPS, BORDER_KEYS]) {
    const present = group.filter((k) => map.has(k));
    if (!present.length) continue;
    lines.push('');
    for (const k of present) {
      lines.push(`${k} = ${quote(map.get(k)!)}`);
      done.add(k);
    }
  }
  const rest = out.entries.filter(([k]) => !done.has(k));
  if (rest.length) {
    lines.push('');
    for (const [k, v] of rest) lines.push(`${k} = ${quote(v)}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- icons

/** The Yaru accents that ship with Omarchy, with the hue each is. */
const YARU: { name: string; hue: number }[] = [
  { name: 'Yaru', hue: 18 }, { name: 'Yaru-red', hue: 350 }, { name: 'Yaru-magenta', hue: 300 }, { name: 'Yaru-purple', hue: 255 },
  { name: 'Yaru-blue', hue: 210 }, { name: 'Yaru-prussiangreen', hue: 178 }, { name: 'Yaru-olive', hue: 90 }, { name: 'Yaru-yellow', hue: 45 },
];

/** icons.theme follows the accent the way the stock themes pick it: the Yaru colour nearest in hue, sage or warty brown when grey. */
export function iconsThemeFor(accent: string): string {
  const h = normalizeColor(accent) ?? '#7aa2f7';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  let hue = 0;
  if (max !== min) {
    if (max === r) hue = ((g - b) / (max - min)) * 60;
    else if (max === g) hue = (2 + (b - r) / (max - min)) * 60;
    else hue = (4 + (r - g) / (max - min)) * 60;
  }
  hue = (hue + 360) % 360;
  if (sat < 0.18) return hue > 60 && hue < 200 ? 'Yaru-sage' : 'Yaru-wartybrown';
  const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  return [...YARU].sort((a, b) => dist(a.hue, hue) - dist(b.hue, hue))[0]!.name;
}

/** A light or dark default palette for a theme made from nothing: ink, paper and an amber accent. */
export const DEFAULT_COLORS: Record<string, string> = {
  accent: '#e8a85c', selection: '#3a3530', muted: '#6b645c',
  background: '#17151a', dark_background: '#121014', darker_background: '#0c0b0e', lighter_background: '#232026',
  foreground: '#e6e0d6', dark_foreground: '#8c857b', light_foreground: '#cfc8bd', bright_foreground: '#f6f1e8',
  red: '#e0685f', yellow: '#e8c15c', orange: '#e8a85c', green: '#a3c26b', cyan: '#6fbfb3', blue: '#7aa5d8', magenta: '#c88fc0', brown: '#8a6a4a',
  bright_red: '#f08279', bright_yellow: '#f5d37a', bright_green: '#bad685', bright_cyan: '#8cd4c8', bright_blue: '#97bdea', bright_magenta: '#dba8d4',
};

// ---------------------------------------------------------------- shell surfaces: shell.toml

/**
 * The surfaces of Omarchy's shell that a theme can style through `shell.toml`, read from
 * `$OMARCHY_PATH/default/themed/shell.toml.tpl` and `shell/Commons/Color.qml` (Omarchy 4.0, November 2026). The same
 * shell, with the Omarchy Mobile plugins on top, draws the phone: its lock screen reads `Color.lock.*`, the drawer and
 * quick settings `Color.menu.*` and `Color.popups.*`, the status bar `Color.bar.*`.
 *
 * Each role is one colour token, `--omarchy-shell-<section>-<key>`. Its alpha is the token's own: `#1a1b26cc`, or
 * `color-mix(in srgb, var(--omarchy-background) 80%, transparent)`. Roles with an `-alpha` key in shell.toml get the
 * alpha written there; the others take an opaque colour, and an alpha in their token is a problem to fix.
 */
export interface ShellRole {
  section: string;
  key: string;
  /** shell.toml has `<key>-alpha` (or the shared `border-alpha` for lock and polkit borders). */
  alpha?: string;
  /** The value of a new theme's token, as Omarchy's template would fill it. */
  value: string;
  /** What a person sees it on. */
  label: string;
}

const P = (key: string) => `var(--omarchy-${key.replace(/_/g, '-')})`;
const ACTIVE = 'var(--omarchy-hyprland-active-border)';
const withAlpha = (ref: string, pct: number) => (pct >= 100 ? ref : `color-mix(in srgb, ${ref} ${pct}%, transparent)`);

export const SHELL_ROLES: readonly ShellRole[] = [
  { section: 'bar', key: 'background', alpha: 'background-alpha', value: P('background'), label: 'Status bar' },
  { section: 'bar', key: 'text', value: P('foreground'), label: 'Status bar text' },
  { section: 'bar', key: 'active', value: P('red'), label: 'Status bar alerts (recording, updates)' },
  { section: 'popups', key: 'background', alpha: 'background-alpha', value: P('background'), label: 'Popups and quick settings' },
  { section: 'popups', key: 'text', value: P('foreground'), label: 'Popup text' },
  { section: 'popups', key: 'border', alpha: 'border-alpha', value: ACTIVE, label: 'Popup border' },
  { section: 'tooltip', key: 'background', alpha: 'background-alpha', value: withAlpha(P('background'), 97), label: 'Tooltip' },
  { section: 'tooltip', key: 'text', value: P('foreground'), label: 'Tooltip text' },
  { section: 'tooltip', key: 'border', alpha: 'border-alpha', value: ACTIVE, label: 'Tooltip border' },
  { section: 'notifications', key: 'background', alpha: 'background-alpha', value: P('background'), label: 'Notification' },
  { section: 'notifications', key: 'text', value: P('foreground'), label: 'Notification text' },
  { section: 'notifications', key: 'border', alpha: 'border-alpha', value: ACTIVE, label: 'Notification border' },
  { section: 'notifications', key: 'countdown', value: P('accent'), label: 'Notification countdown' },
  { section: 'launcher', key: 'background', alpha: 'background-alpha', value: withAlpha(P('background'), 95), label: 'Launcher and app drawer' },
  { section: 'launcher', key: 'text', value: P('foreground'), label: 'Launcher text' },
  { section: 'launcher', key: 'border', alpha: 'border-alpha', value: ACTIVE, label: 'Launcher border' },
  { section: 'launcher', key: 'scrim', alpha: 'scrim-alpha', value: withAlpha(P('background'), 50), label: 'Launcher scrim' },
  { section: 'launcher', key: 'selected-background', alpha: 'selected-background-alpha', value: withAlpha(P('foreground'), 8), label: 'Launcher selected row' },
  { section: 'launcher', key: 'selected-text', value: P('accent'), label: 'Launcher selected text' },
  { section: 'menu', key: 'background', alpha: 'background-alpha', value: P('background'), label: 'Menus, clipboard, cards' },
  { section: 'menu', key: 'text', value: P('foreground'), label: 'Menu text' },
  { section: 'menu', key: 'border', alpha: 'border-alpha', value: ACTIVE, label: 'Menu border' },
  { section: 'menu', key: 'scrim', alpha: 'scrim-alpha', value: withAlpha(P('background'), 50), label: 'Menu scrim' },
  { section: 'menu', key: 'selected-background', alpha: 'selected-background-alpha', value: withAlpha(P('foreground'), 8), label: 'Menu selected row' },
  { section: 'menu', key: 'selected-text', value: P('accent'), label: 'Menu selected text' },
  { section: 'polkit', key: 'background', alpha: 'background-alpha', value: P('background'), label: 'Password dialog' },
  { section: 'polkit', key: 'text', value: P('foreground'), label: 'Password dialog text' },
  { section: 'polkit', key: 'text-error', value: P('red'), label: 'Password dialog error' },
  { section: 'polkit', key: 'border', alpha: 'border-alpha', value: ACTIVE, label: 'Password dialog border' },
  { section: 'polkit', key: 'border-error', value: P('red'), label: 'Password dialog error border' },
  { section: 'polkit', key: 'scrim', alpha: 'scrim-alpha', value: withAlpha(P('background'), 50), label: 'Password dialog scrim' },
  { section: 'polkit', key: 'accent', value: P('accent'), label: 'Password dialog accent' },
  { section: 'lock', key: 'background', alpha: 'background-alpha', value: withAlpha(P('background'), 80), label: 'Lock screen field' },
  { section: 'lock', key: 'text', value: P('foreground'), label: 'Lock screen text' },
  { section: 'lock', key: 'placeholder', value: 'color-mix(in srgb, var(--omarchy-foreground) 66%, var(--omarchy-background))', label: 'Lock screen placeholder' },
  { section: 'lock', key: 'text-error', value: P('red'), label: 'Lock screen error' },
  { section: 'lock', key: 'border', alpha: 'border-alpha', value: ACTIVE, label: 'Lock screen field border' },
  { section: 'lock', key: 'border-active', value: ACTIVE, label: 'Lock screen while typing' },
  { section: 'lock', key: 'border-error', value: P('red'), label: 'Lock screen wrong PIN' },
  { section: 'lock', key: 'selection', alpha: 'selection-alpha', value: withAlpha(P('accent'), 45), label: 'Lock screen selection' },
  { section: 'image-picker', key: 'scrim', alpha: 'scrim-alpha', value: withAlpha(P('background'), 50), label: 'Image and theme picker scrim' },
  { section: 'image-picker', key: 'selected-border', alpha: 'selected-border-alpha', value: P('accent'), label: 'Picker selection' },
  { section: 'image-picker', key: 'unselected-border', alpha: 'unselected-border-alpha', value: withAlpha(P('foreground'), 28), label: 'Picker other items' },
];

/** The base of the shell's type scale. Omarchy's own default; a machine's `~/.config/omarchy/shell.toml` still wins. */
export const SHELL_FONT_TOKEN = 'omarchy-shell-font-base-size';
export const SHELL_FONT_DEFAULT = '12px';

export const shellTokenFor = (role: Pick<ShellRole, 'section' | 'key'>): string => `omarchy-shell-${role.section}-${role.key}`;
export const isShellToken = (name: string): boolean => name.startsWith('omarchy-shell-');

/** The tokens a new theme gets for its shell surfaces: every role at Omarchy's own default, and the font size. */
export function shellTokens(fontBase = SHELL_FONT_DEFAULT): { name: string; kind: 'color' | 'font-size'; value: string }[] {
  return [...SHELL_ROLES.map((r) => ({ name: shellTokenFor(r), kind: 'color' as const, value: r.value })), { name: SHELL_FONT_TOKEN, kind: 'font-size', value: fontBase }];
}

/**
 * The shell role tokens of an installed theme's own shell.toml, over Omarchy's defaults: a colour with its `-alpha`
 * becomes one colour with alpha, `hyprland.active-border` the border token, a palette role name its token. Keys Bogen
 * has no role for are left to the theme's file and not carried.
 */
export function shellTokensFrom(values: Record<string, string>): { name: string; kind: 'color' | 'font-size'; value: string }[] {
  const roles: Record<string, string> = { foreground: P('foreground'), text: P('foreground'), accent: P('accent'), background: P('background'), muted: P('muted'), urgent: P('red'), transparent: 'transparent' };
  return shellTokens().map((t) => {
    if (t.kind === 'font-size') {
      const n = Number(values['font.base-size']);
      return Number.isFinite(n) && n >= 1 && n <= 64 ? { ...t, value: `${n}px` } : t;
    }
    const role = SHELL_ROLES.find((r) => shellTokenFor(r) === t.name)!;
    const raw = values[`${role.section}.${role.key}`]?.trim();
    if (!raw) return t;
    const alphaKey = role.alpha ?? ((role.section === 'lock' || role.section === 'polkit') && role.key.startsWith('border') ? 'border-alpha' : undefined);
    const alpha = alphaKey ? Number(values[`${role.section}.${alphaKey}`]) : NaN;
    if (raw.startsWith('hyprland.active-border')) return { ...t, value: ACTIVE };
    const base = roles[raw.toLowerCase()] ?? (hex(raw.split(/\s+/)[0]!) ? hex(raw.split(/\s+/)[0]!)!.slice(0, 7) : undefined);
    if (!base) return t;
    return { ...t, value: Number.isFinite(alpha) && alpha < 1 ? withAlpha(base, Math.round(Math.max(0, alpha) * 100)) : base };
  });
}

interface Rgba { r: number; g: number; b: number; a: number }

function parseHexRgba(value: string): Rgba | null {
  const h = hex(value);
  if (!h) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(1), g: n(3), b: n(5), a: h.length === 9 ? n(7) / 255 : 1 };
}

/**
 * A role's value as one colour with alpha. Understands what the roles are written in: hex, `var(--…)` of another
 * token, `transparent`, and `color-mix(in srgb, A p%, B)`, mixed the way CSS does, premultiplied. Null when it is not one
 * colour, such as a gradient.
 */
export function resolveShellColor(value: string, tokens: ReadonlyMap<string, string>, depth = 0): Rgba | null {
  if (depth > 10) return null;
  const v = value.trim();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const ref = /^var\(--([\w-]+)\)$/.exec(v);
  if (ref) {
    const next = tokens.get(ref[1]!);
    return next === undefined ? null : resolveShellColor(next, tokens, depth + 1);
  }
  const mix = /^color-mix\(\s*in\s+srgb\s*,(.*)\)$/i.exec(v);
  if (mix) {
    const args = splitArgs(mix[1]!);
    if (args.length !== 2) return null;
    const part = (s: string): { c: Rgba | null; p?: number } => {
      const m = /^(.*?)(?:\s+(\d+(?:\.\d+)?)%)?$/.exec(s.trim())!;
      return { c: resolveShellColor(m[1]!, tokens, depth + 1), ...(m[2] !== undefined ? { p: Number(m[2]) / 100 } : {}) };
    };
    const [a, b] = [part(args[0]!), part(args[1]!)];
    if (!a.c || !b.c) return null;
    let pa = a.p ?? (b.p !== undefined ? 1 - b.p : 0.5);
    let pb = b.p ?? 1 - pa;
    const sum = pa + pb;
    if (sum <= 0) return null;
    const scale = Math.min(sum, 1);
    pa /= sum;
    pb /= sum;
    const alpha = a.c.a * pa + b.c.a * pb;
    const ch = (k: 'r' | 'g' | 'b') => (alpha === 0 ? 0 : (a.c![k] * a.c!.a * pa + b.c![k] * b.c!.a * pb) / alpha);
    return { r: ch('r'), g: ch('g'), b: ch('b'), a: alpha * scale };
  }
  const plain = normalizeColor(v);
  return plain ? parseHexRgba(plain) : null;
}

const toHex6 = (c: Rgba) => '#' + [c.r, c.g, c.b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
const alphaText = (a: number) => String(Math.round(Math.max(0, Math.min(1, a)) * 100) / 100);

export interface ShellOut {
  /** shell.toml, in the template's order of sections. Empty when the file has no shell tokens. */
  toml: string;
  /** `section.key` to the value written, for checks and the manifest. */
  values: Record<string, string>;
  problems: string[];
}

/**
 * shell.toml from the tokens of a file, in the dialect Omarchy's `Commons.Color.parseShell` reads: quoted strings with
 * no quotes inside, bare numbers. A role that points at the active window border is written as `hyprland.active-border`,
 * so the shell keeps drawing it as the gradient, and the `[hyprland]` section carries that gradient.
 */
export function shellFromTokens(tokens: { name: string; kind: string; value: string }[]): ShellOut {
  const byName = new Map(tokens.map((t) => [t.name, t.value]));
  const values: Record<string, string> = {};
  const problems: string[] = [];
  if (!tokens.some((t) => isShellToken(t.name))) return { toml: '', values, problems };
  const sections = new Map<string, [string, string][]>();
  const put = (section: string, key: string, value: string) => {
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)!.push([key, value]);
    values[`${section}.${key}`] = value;
  };
  // The active border as the shell's gradient: colours and an angle, which `hyprland.active-border` refers to.
  const border = byName.get(tokenForKey('hyprland_active_border'));
  const accent = resolveShellColor(P('accent'), byName);
  const borderSpec = border !== undefined ? cssToHypr(resolveValue(border, byName)) : undefined;
  const gradient = borderSpec
    ? borderSpec.split(/\s+/).map((part) => {
      const m = /^rgba?\(([0-9a-f]{6})([0-9a-f]{2})?\)$/.exec(part);
      return m ? `#${m[1]}${m[2] && m[2] !== 'ff' ? m[2] : ''}` : part;
    }).join(' ')
    : accent ? toHex6(accent) : '';
  const usesBorder = SHELL_ROLES.some((r) => (byName.get(shellTokenFor(r)) ?? '').trim() === ACTIVE);
  if (usesBorder && gradient && !/["'\n]/.test(gradient)) {
    put('hyprland', 'active-border', gradient);
    put('hyprland', 'active-border-foreground', gradient);
  }
  const alphaDone = new Set<string>();
  for (const role of SHELL_ROLES) {
    const name = shellTokenFor(role);
    const raw = byName.get(name);
    if (raw === undefined) continue;
    if (raw.trim() === ACTIVE && values['hyprland.active-border']) {
      put(role.section, role.key, 'hyprland.active-border');
      if (role.alpha && !alphaDone.has(`${role.section}.${role.alpha}`)) {
        put(role.section, role.alpha, '1');
        alphaDone.add(`${role.section}.${role.alpha}`);
      }
      continue;
    }
    const c = resolveShellColor(raw, byName);
    if (!c) {
      problems.push(`--${name} is ${raw}: a shell surface takes one colour, a token or color-mix of them.`);
      continue;
    }
    put(role.section, role.key, toHex6(c));
    // Lock and polkit borders share one alpha: the first border sets it.
    const alphaKey = role.alpha ?? ((role.section === 'lock' || role.section === 'polkit') && role.key.startsWith('border') ? 'border-alpha' : undefined);
    if (alphaKey && role.alpha) {
      if (!alphaDone.has(`${role.section}.${alphaKey}`)) put(role.section, alphaKey, alphaText(c.a));
      alphaDone.add(`${role.section}.${alphaKey}`);
    } else if (c.a < 0.995) {
      problems.push(`--${name} has an alpha of ${alphaText(c.a)}, but ${role.section}.${role.key} takes an opaque colour: Omarchy would draw it solid.`);
    }
  }
  const font = byName.get(SHELL_FONT_TOKEN);
  if (font !== undefined) {
    const px = /^(\d+(?:\.\d+)?)px$/.exec(font.trim());
    if (px && Number(px[1]) >= 1 && Number(px[1]) <= 64) put('font', 'base-size', String(Number(px[1])));
    else problems.push(`--${SHELL_FONT_TOKEN} is ${font}: the shell's base size is a number of px between 1 and 64.`);
  }
  const order = ['bar', 'hyprland', 'font', 'popups', 'tooltip', 'notifications', 'launcher', 'menu', 'polkit', 'lock', 'image-picker'];
  const lines = ['# Omarchy shell surfaces, written by Bogen from this theme\'s --omarchy-shell-* tokens.', '# A machine\'s own ~/.config/omarchy/shell.toml still wins over any key here.'];
  for (const section of [...order, ...[...sections.keys()].filter((s) => !order.includes(s))]) {
    const entries = sections.get(section);
    if (!entries?.length) continue;
    lines.push('', `[${section}]`);
    for (const [key, value] of entries) lines.push(/^-?\d+(\.\d+)?$/.test(value) ? `${key} = ${value}` : `${key} = "${value.replace(/["'\n\\]/g, '')}"`);
  }
  return { toml: lines.join('\n') + '\n', values, problems };
}

/**
 * Reads shell.toml the way `Commons.Color.parseShell` does, line by line, so a test can prove the shell reads back what
 * Bogen wrote. Returns `section.key` to the raw string.
 */
export function parseShellToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const head = /^\[([A-Za-z0-9_-]+)\]\s*(#.*)?$/.exec(line);
    if (head) {
      section = head[1]!;
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']\s*(#.*)?$/.exec(line) ?? /^([A-Za-z0-9_-]+)\s*=\s*(-?\d+(?:\.\d+)?)\s*(#.*)?$/.exec(line)
      ?? /^([A-Za-z0-9_-]+)\s*=\s*([A-Za-z][A-Za-z0-9_-]*)\s*(#.*)?$/.exec(line);
    if (kv && section) out[`${section}.${kv[1]}`] = kv[2]!;
  }
  return out;
}
