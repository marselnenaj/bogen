import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contrast, createOmarchy, mix, normalizeColor, paletteTokens, parseTheme, pickAccentForeground, type Omarchy, type OmarchyTheme } from '../src/omarchy.ts';

const STOCK = '/usr/share/omarchy/themes';
const hasStock = (() => {
  try {
    return readdirSync(STOCK).length > 0;
  } catch {
    return false;
  }
})();
// Omarchy 4.5 keeps folders that hold only backgrounds; a theme is a folder with colors.toml.
const stockThemes = hasStock ? readdirSync(STOCK).filter((name) => existsSync(join(STOCK, name, 'colors.toml'))) : [];

const DARK = 'mode = "dark"\naccent = "#d8ff3d"\nbackground = "#0a0a0a"\nforeground = "#f2f0ea"\nred = "#d93b36"\n';
const LIGHT = 'mode = "light"\naccent = "#1e66f5"\nbackground = "#eff1f5"\nforeground = "#4c4f69"\nred = "#d20f39"\n';

describe('parseTheme', () => {
  it('maps a theme to the UI variables', () => {
    const theme = parseTheme(DARK, { name: 'nenaj\n', font: 'Iosevka' })!;
    expect(theme.name).toBe('nenaj');
    expect(theme.mode).toBe('dark');
    expect(theme.font).toBe('Iosevka');
    expect(Object.keys(theme.vars).sort()).toEqual(
      ['--ui-accent', '--ui-accent-fg', '--ui-bg', '--ui-bg-2', '--ui-bg-3', '--ui-border', '--ui-danger', '--ui-fg', '--ui-fg-2'].sort(),
    );
    expect(theme.vars['--ui-bg']).toBe('#0a0a0a');
    expect(theme.vars['--ui-accent']).toBe('#d8ff3d');
    expect(theme.vars['--ui-danger']).toBe('#d93b36');
    for (const value of Object.values(theme.vars)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('omits font when unknown', () => {
    expect('font' in parseTheme(DARK)!).toBe(false);
  });

  it('infers the mode from luminance when the key is missing', () => {
    expect(parseTheme('background = "#101010"\nforeground = "#eeeeee"')!.mode).toBe('dark');
    expect(parseTheme('background = "#fafafa"\nforeground = "#111111"')!.mode).toBe('light');
  });

  it('understands colours generated from alacritty.toml (color0..15, no mode)', () => {
    const theme = parseTheme('accent = "#7aa2f7"\nbackground = "#1a1b26"\nforeground = "#c0caf5"\ncolor1 = "#f7768e"\ncolor8 = "#9099c0"')!;
    expect(theme.vars['--ui-danger']).toBe('#f7768e');
    expect(theme.vars['--ui-fg-2']).toBe('#9099c0');
  });

  it('returns null, not an exception, on malformed input', () => {
    expect(parseTheme('this is = = not toml [')).toBeNull();
    expect(parseTheme('')).toBeNull();
    expect(parseTheme('accent = "#ffffff"')).toBeNull();
    expect(parseTheme('background = "nope"\nforeground = 12')).toBeNull();
  });

  it('ignores keys that are not colours', () => {
    const theme = parseTheme(DARK + 'wallpaper = "forest.png"\ncount = 3\n[extra]\nfoo = "#000000"\n')!;
    expect(theme.palette.wallpaper).toBeUndefined();
    expect(theme.palette.count).toBeUndefined();
    expect(theme.palette.extra).toBeUndefined();
  });
});

describe('colour helpers', () => {
  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBe(1);
    // The reference value for #767676 on white is the classic 4.54.
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('normalises colour spellings', () => {
    expect(normalizeColor('#ABC')).toBe('#aabbcc');
    expect(normalizeColor('0xD8FF3D')).toBe('#d8ff3d');
    expect(normalizeColor('d8ff3d80')).toBe('#d8ff3d');
    expect(normalizeColor('red')).toBeUndefined();
    expect(normalizeColor(3)).toBeUndefined();
  });

  it('mixes in sRGB', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#102030', '#102030', 0.3)).toBe('#102030');
  });

  it('prefers a theme colour for accent-fg and falls back to black or white', () => {
    // Acid yellow on a near-black background: the background itself reads well.
    expect(pickAccentForeground('#d8ff3d', '#0a0a0a', '#f2f0ea')).toBe('#0a0a0a');
    // Neither theme colour passes on a mid grey, so black or white has to.
    const picked = pickAccentForeground('#808080', '#707070', '#909090');
    expect(['#000000', '#ffffff']).toContain(picked);
    expect(contrast(picked, '#808080')).toBeGreaterThanOrEqual(4.5);
  });
});

describe.runIf(hasStock)('stock themes', () => {
  it.each(stockThemes)('%s', (name) => {
    const theme = parseTheme(readFileSync(join(STOCK, name, 'colors.toml'), 'utf8'), { name })!;
    expect(theme).not.toBeNull();
    const v = theme.vars as Record<string, string>;
    expect(contrast(v['--ui-accent-fg']!, v['--ui-accent']!)).toBeGreaterThanOrEqual(4.5);
    const fgOnBg = contrast(v['--ui-fg']!, v['--ui-bg']!);
    // Secondary text stays AA on both surfaces, unless the theme's own foreground is below that already.
    for (const surface of ['--ui-bg', '--ui-bg-2']) {
      expect(contrast(v['--ui-fg-2']!, v[surface]!)).toBeGreaterThanOrEqual(Math.min(4.5, contrast(v['--ui-fg']!, v[surface]!)));
    }
    expect(fgOnBg).toBeGreaterThan(3);
    expect(v['--ui-bg-2']).not.toBe(v['--ui-bg']);
    expect(v['--ui-bg-3']).not.toBe(v['--ui-bg-2']);
    expect(theme.mode).toMatch(/^(dark|light)$/);
  });
});

describe('paletteTokens', () => {
  it('returns valid design tokens', () => {
    const tokens = paletteTokens(parseTheme(DARK + 'dark_background = "#050505"\n', { font: 'Iosevka Nerd Font' }));
    expect(tokens).toContainEqual({ name: 'omarchy-accent', kind: 'color', value: '#d8ff3d' });
    expect(tokens).toContainEqual({ name: 'omarchy-dark-background', kind: 'color', value: '#050505' });
    expect(tokens).toContainEqual({ name: 'omarchy-font', kind: 'font-family', value: 'Iosevka Nerd Font' });
    // The name rule from @bogen/core's setToken.
    for (const token of tokens) expect(token.name).toMatch(/^[a-zA-Z_][\w-]*$/);
    expect(tokens.some((t) => t.name === 'omarchy-mode')).toBe(false);
  });

  it('is empty off Omarchy', () => {
    expect(paletteTokens(null)).toEqual([]);
  });
});

describe('createOmarchy', () => {
  const open: Omarchy[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const o of open.splice(0)) o.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function stateDir(colors?: string, name = 'first') {
    const dir = mkdtempSync(join(tmpdir(), 'bogen-omarchy-'));
    dirs.push(dir);
    const current = join(dir, 'current');
    mkdirSync(join(current, 'theme'), { recursive: true });
    if (colors !== undefined) writeFileSync(join(current, 'theme', 'colors.toml'), colors);
    writeFileSync(join(current, 'theme.name'), name + '\n');
    return { dir, current };
  }

  function start(dir: string) {
    const seen: (OmarchyTheme | null)[] = [];
    const omarchy = createOmarchy({
      stateDir: dir,
      debounceMs: 20,
      readFont: () => 'Test Font',
      broadcast: (m) => {
        expect(m.t).toBe('theme');
        seen.push(m.theme);
      },
    });
    open.push(omarchy);
    return { omarchy, seen };
  }

  // What omarchy-theme-set does, step for step.
  function themeSet(current: string, colors: string, name: string) {
    const next = join(current, 'next-theme');
    mkdirSync(next);
    writeFileSync(join(next, 'colors.toml'), colors);
    rmSync(join(current, 'theme'), { recursive: true });
    renameSync(next, join(current, 'theme'));
    writeFileSync(join(current, 'theme.name'), name + '\n');
  }

  it('is null off Omarchy and stays quiet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bogen-omarchy-'));
    dirs.push(dir);
    const { omarchy } = start(join(dir, 'nothing-here'));
    expect(omarchy.getTheme()).toBeNull();
    expect(omarchy.reload()).toBeNull();
    expect(paletteTokens(omarchy.getTheme())).toEqual([]);
  });

  it('reads the live theme, name and font on start', () => {
    const { dir } = stateDir(DARK, 'nenaj');
    const { omarchy, seen } = start(dir);
    const theme = omarchy.getTheme()!;
    expect(theme.name).toBe('nenaj');
    expect(theme.font).toBe('Test Font');
    expect(theme.vars['--ui-bg']).toBe('#0a0a0a');
    expect(seen).toEqual([]);
  });

  it('survives a missing file, then picks it up when it appears', async () => {
    const { dir, current } = stateDir(undefined);
    const { omarchy, seen } = start(dir);
    expect(omarchy.getTheme()).toBeNull();
    writeFileSync(join(current, 'theme', 'colors.toml'), DARK);
    await vi.waitFor(() => expect(omarchy.getTheme()?.vars['--ui-bg']).toBe('#0a0a0a'));
    expect(seen.at(-1)?.vars['--ui-bg']).toBe('#0a0a0a');
  });

  it('is null on a malformed first read, without throwing', () => {
    const { dir } = stateDir('not = = toml');
    expect(start(dir).omarchy.getTheme()).toBeNull();
  });

  it('keeps the last good theme when the file breaks, and recovers', async () => {
    const { dir, current } = stateDir(DARK);
    const { omarchy, seen } = start(dir);
    writeFileSync(join(current, 'theme', 'colors.toml'), 'broken = = =');
    await new Promise((r) => setTimeout(r, 80));
    expect(omarchy.getTheme()?.vars['--ui-bg']).toBe('#0a0a0a');
    expect(seen).toEqual([]);
    writeFileSync(join(current, 'theme', 'colors.toml'), LIGHT);
    await vi.waitFor(() => expect(omarchy.getTheme()?.mode).toBe('light'));
  });

  it('survives the directory swap of omarchy theme set, more than once', async () => {
    const { dir, current } = stateDir(DARK, 'first');
    const { omarchy, seen } = start(dir);

    themeSet(current, LIGHT, 'second');
    await vi.waitFor(() => expect(omarchy.getTheme()?.name).toBe('second'));
    expect(omarchy.getTheme()?.mode).toBe('light');

    themeSet(current, DARK, 'third');
    await vi.waitFor(() => expect(omarchy.getTheme()?.name).toBe('third'));
    expect(omarchy.getTheme()?.mode).toBe('dark');

    // In-place edits keep working on the swapped-in directory: the inner watch was re-armed.
    writeFileSync(join(current, 'theme', 'colors.toml'), DARK.replace('#d8ff3d', '#00ff00'));
    await vi.waitFor(() => expect(omarchy.getTheme()?.vars['--ui-accent']).toBe('#00ff00'));
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  it('follows a symlinked theme directory when the link is swapped', async () => {
    const { dir, current } = stateDir(undefined);
    rmSync(join(current, 'theme'), { recursive: true });
    for (const [folder, colors] of [['a', DARK], ['b', LIGHT]] as const) {
      mkdirSync(join(dir, folder));
      writeFileSync(join(dir, folder, 'colors.toml'), colors);
    }
    symlinkSync(join(dir, 'a'), join(current, 'theme'));
    const { omarchy } = start(dir);
    expect(omarchy.getTheme()?.mode).toBe('dark');

    unlinkSync(join(current, 'theme'));
    symlinkSync(join(dir, 'b'), join(current, 'theme'));
    await vi.waitFor(() => expect(omarchy.getTheme()?.mode).toBe('light'));
  });

  it('debounces a burst into one broadcast and skips unchanged content', async () => {
    const { dir, current } = stateDir(DARK);
    const { omarchy, seen } = start(dir);
    for (let i = 0; i < 5; i++) writeFileSync(join(current, 'theme', 'colors.toml'), LIGHT);
    await vi.waitFor(() => expect(omarchy.getTheme()?.mode).toBe('light'));
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toHaveLength(1);

    writeFileSync(join(current, 'theme', 'colors.toml'), LIGHT);
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toHaveLength(1);
  });

  it('reload re-reads and always broadcasts', () => {
    const { dir } = stateDir(DARK);
    const { omarchy, seen } = start(dir);
    const first = omarchy.reload();
    expect(first?.vars['--ui-bg']).toBe('#0a0a0a');
    expect(seen).toHaveLength(1);
    omarchy.reload();
    expect(seen).toHaveLength(2);
  });

  it('a throwing broadcast does not break the watcher', async () => {
    const { dir, current } = stateDir(DARK);
    const omarchy = createOmarchy({ stateDir: dir, debounceMs: 20, readFont: () => undefined, broadcast: () => { throw new Error('socket gone'); } });
    open.push(omarchy);
    writeFileSync(join(current, 'theme', 'colors.toml'), LIGHT);
    await vi.waitFor(() => expect(omarchy.getTheme()?.mode).toBe('light'));
    expect(() => omarchy.reload()).not.toThrow();
  });

  it('stops reacting after close', async () => {
    const { dir, current } = stateDir(DARK);
    const { omarchy, seen } = start(dir);
    omarchy.close();
    omarchy.close();
    writeFileSync(join(current, 'theme', 'colors.toml'), LIGHT);
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toEqual([]);
    expect(omarchy.getTheme()?.mode).toBe('dark');
  });
});
