// Everything Bogen reads from Omarchy lives here: a pure colors.toml parser and
// a thin watcher around it.
//
// `omarchy theme set` does not edit the live theme. It builds `current/next-theme`,
// then runs `rm -rf current/theme && mv current/next-theme current/theme`, and only
// afterwards writes `current/theme.name`. A watch on the theme directory therefore
// dies with the old inode, so the parent directory is watched too, and the inner
// watch is re-armed on every change. The parent watch also sees a symlink swap.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export interface OmarchyTheme {
  name: string;
  mode: 'dark' | 'light';
  vars: Record<string, string>;
  font?: string;
  /** Every colour in colors.toml, normalised to #rrggbb. Source of `paletteTokens`. */
  palette: Record<string, string>;
}

/** Structurally the same as `Token` in @bogen/core, so it can go straight into `setToken`. */
export interface PaletteToken {
  name: string;
  kind: 'color' | 'font-family';
  value: string;
}

export interface OmarchyOptions {
  broadcast: (message: { t: 'theme'; theme: OmarchyTheme | null }) => void;
  /** Defaults to ~/.local/state/omarchy. Omarchy hard-codes the path, so XDG_STATE_HOME is not consulted. */
  stateDir?: string;
  /** Defaults to asking fontconfig. Return undefined when the font is unknown. */
  readFont?: () => string | undefined;
  debounceMs?: number;
}

export interface Omarchy {
  getTheme(): OmarchyTheme | null;
  reload(): OmarchyTheme | null;
  close(): void;
}

// ---------------------------------------------------------------- colour maths

type Rgb = [number, number, number];

function toRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function toHex(rgb: Rgb): string {
  return '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}

/** Accepts #rgb, #rrggbb, #rrggbbaa, rrggbb and 0xrrggbb. Anything else is not a colour. */
export function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim().toLowerCase().replace(/^(#|0x)/, '');
  if (/^[0-9a-f]{3}$/.test(raw)) return '#' + [...raw].map((c) => c + c).join('');
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(raw)) return '#' + raw.slice(0, 6);
  return undefined;
}

/** WCAG 2 relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `amount` of `to` over `from`, in sRGB, the way Omarchy's own templates mix. */
export function mix(from: string, to: string, amount: number): string {
  const a = toRgb(from);
  const b = toRgb(to);
  return toHex(a.map((c, i) => c * (1 - amount) + b[i]! * amount) as Rgb);
}

const AA = 4.5;

/** The theme's own colour when it passes AA on the accent, otherwise black or white, whichever is stronger. */
export function pickAccentForeground(accent: string, background: string, foreground: string): string {
  const best = [background, foreground].sort((x, y) => contrast(y, accent) - contrast(x, accent))[0]!;
  if (contrast(best, accent) >= AA) return best;
  return contrast('#000000', accent) >= contrast('#ffffff', accent) ? '#000000' : '#ffffff';
}

function secondaryForeground(p: Record<string, string>, fg: string, surfaces: string[]): string {
  const legible = (c: string) => surfaces.every((s) => contrast(c, s) >= AA);
  // The names lie: `dark_foreground` is the dim one in dark themes and often too
  // faint in light ones, so measure rather than trust the key.
  for (const key of ['dark_foreground', 'light_foreground', 'muted', 'color8']) {
    const c = p[key];
    if (c && c !== fg && legible(c)) return c;
  }
  for (let amount = 0.35; amount > 0; amount -= 0.05) {
    const c = mix(fg, surfaces[0]!, amount);
    if (legible(c)) return c;
  }
  return fg;
}

// ---------------------------------------------------------------- pure parsing

/** Returns null when the text is not TOML or has no usable background and foreground. Never throws. */
export function parseTheme(text: string, info: { name?: string; font?: string } = {}): OmarchyTheme | null {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch {
    return null;
  }

  const palette: Record<string, string> = {};
  for (const [key, value] of Object.entries(doc)) {
    const color = normalizeColor(value);
    if (color) palette[key] = color;
  }

  const bg = palette.background;
  const fg = palette.foreground;
  if (!bg || !fg) return null;

  const mode = doc.mode === 'dark' || doc.mode === 'light' ? doc.mode : luminance(bg) < 0.4 ? 'dark' : 'light';
  const accent = palette.accent ?? palette.color4 ?? fg;

  const lifted = palette.lighter_background;
  const bg2 = lifted && contrast(lifted, bg) >= 1.03 ? lifted : mix(bg, fg, 0.06);
  const bg3 = mix(bg2, fg, 0.08);

  const reds = [palette.red, palette.color1, palette.bright_red, palette.color9].filter((c): c is string => !!c);
  const danger = reds.find((c) => contrast(c, bg) >= 3) ?? reds[0] ?? (mode === 'dark' ? '#ef514a' : '#c62828');

  const theme: OmarchyTheme = {
    name: info.name?.trim() || 'omarchy',
    mode,
    vars: {
      '--ui-bg': bg,
      '--ui-bg-2': bg2,
      '--ui-bg-3': bg3,
      '--ui-fg': fg,
      '--ui-fg-2': secondaryForeground(palette, fg, [bg, bg2]),
      '--ui-border': mix(bg2, fg, 0.16),
      '--ui-accent': accent,
      '--ui-accent-fg': pickAccentForeground(accent, bg, fg),
      '--ui-danger': danger,
    },
    palette,
  };
  if (info.font) theme.font = info.font;
  return theme;
}

/** The active palette as design tokens: `omarchy-accent`, `omarchy-dark-background`, `omarchy-font`. */
export function paletteTokens(theme: OmarchyTheme | null): PaletteToken[] {
  if (!theme) return [];
  const tokens: PaletteToken[] = Object.entries(theme.palette).map(([key, value]) => ({
    name: 'omarchy-' + key.replace(/_/g, '-'),
    kind: 'color',
    value,
  }));
  if (theme.font) tokens.push({ name: 'omarchy-font', kind: 'font-family', value: theme.font });
  return tokens;
}

// ---------------------------------------------------------------- file access

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Same source as `omarchy font current`, without going through its dispatcher. */
function fontFromFontconfig(): string | undefined {
  const result = spawnSync('fc-match', ['monospace', '-f', '%{family}\n'], { encoding: 'utf8', timeout: 1500 });
  if (result.status !== 0) return undefined;
  return result.stdout.split('\n')[0]?.split(',')[0]?.trim() || undefined;
}

// ---------------------------------------------------------------- watcher

const RETRY_MS = 400;
const RETRIES = 5;

export function createOmarchy(options: OmarchyOptions): Omarchy {
  const stateDir = options.stateDir ?? join(homedir(), '.local/state/omarchy');
  const currentDir = join(stateDir, 'current');
  const themeDir = join(currentDir, 'theme');
  const readFont = options.readFont ?? fontFromFontconfig;
  const debounceMs = options.debounceMs ?? 150;
  const onOmarchy = existsSync(currentDir);

  let theme: OmarchyTheme | null = null;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let retries = 0;
  let parentWatcher: FSWatcher | undefined;
  let themeWatcher: FSWatcher | undefined;

  const send = () => {
    try {
      options.broadcast({ t: 'theme', theme });
    } catch {
      // A client going away must not take the watcher down with it.
    }
  };

  /** A fresh theme, or null when the file is missing or broken right now. */
  const read = (): OmarchyTheme | null => {
    const text = readText(join(themeDir, 'colors.toml'));
    if (text === undefined) return null;
    return parseTheme(text, { name: readText(join(currentDir, 'theme.name')), font: readFont() });
  };

  const watchDir = (dir: string, listener: () => void): FSWatcher | undefined => {
    try {
      const watcher = watch(dir, { persistent: false }, listener);
      watcher.on('error', () => watcher.close());
      return watcher;
    } catch {
      return undefined; // Gone mid-swap. The parent watch brings us back.
    }
  };

  const armThemeWatch = () => {
    themeWatcher?.close();
    themeWatcher = watchDir(themeDir, () => schedule());
  };

  function schedule(delay = debounceMs) {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(settle, delay);
    timer.unref();
  }

  function settle() {
    timer = undefined;
    if (closed) return;
    armThemeWatch(); // Before reading, so a write right after the read still fires.
    const next = read();
    if (!next) {
      // Most likely the gap between rm and mv. Keep the last good theme meanwhile.
      if (retries++ < RETRIES) schedule(RETRY_MS);
      return;
    }
    retries = 0;
    if (JSON.stringify(next) === JSON.stringify(theme)) return;
    theme = next;
    send();
  }

  if (onOmarchy) {
    theme = read();
    parentWatcher = watchDir(currentDir, () => schedule());
    armThemeWatch();
  }

  return {
    getTheme: () => theme,
    reload() {
      if (onOmarchy && !closed) {
        armThemeWatch();
        theme = read() ?? theme;
      }
      send();
      return theme;
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      parentWatcher?.close();
      themeWatcher?.close();
    },
  };
}
