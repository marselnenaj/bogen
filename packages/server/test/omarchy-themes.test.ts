import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BORDER_DEFAULTS, colorsToml, cssToHypr, hyprToCss, iconsThemeFor, keyForToken, PALETTE_KEYS, parseColorsToml, resolvePalette, themeFromTokens, themeSlug, themeTokens, tokenForKey, validThemeName,
} from '../src/omarchy-theme.ts';
import { gitInit } from '../src/git-mirror.ts';
import { imageSize, installTheme, tarGz, themeEnv, type ThemeEnv, type ThemeExport } from '../src/omarchy-themes.ts';
import { themeBoards } from '../src/templates/omarchy-theme.ts';
import { findBrowser } from '../src/render.ts';
import { call, callRaw, connectAgent, pngStats, startServer, type Harness } from './helpers.ts';

// A stock theme as Omarchy ships it (catppuccin, November 2026): the keys, their order and the files beside them.
const STOCK_COLORS = `mode = "dark"

accent = "#89b4fa"
selection = "#45475a"
muted = "#585b70"

background = "#1e1e2e"
dark_background = "#161622"
darker_background = "#101019"
lighter_background = "#313244"

foreground = "#cdd6f4"
dark_foreground = "#6c7086"
light_foreground = "#bac2de"
bright_foreground = "#cdd6f4"

red = "#f38ba8"
yellow = "#f9e2af"
orange = "#f6b6ab"
green = "#a6e3a1"
cyan = "#94e2d5"
blue = "#89b4fa"
magenta = "#f5c2e7"
brown = "#7b5b55"

bright_red = "#f38ba8"
bright_yellow = "#f9e2af"
bright_green = "#a6e3a1"
bright_cyan = "#94e2d5"
bright_blue = "#89b4fa"
bright_magenta = "#f5c2e7"
`;
const STOCK_FILES = ['backgrounds', 'colors.toml', 'icons.theme', 'neovim.lua', 'preview-unlock.png', 'preview.png', 'unlock.png', 'vscode.json'];
const TEMPLATES = ['alacritty.toml', 'btop.theme', 'chromium.theme', 'hyprland.lua', 'kitty.conf', 'neovim.lua', 'shell.toml'];
const REAL_STOCK = '/usr/share/omarchy/themes';
const hasRealStock = existsSync(REAL_STOCK) && readdirSync(REAL_STOCK).length > 0;
const keysOf = (toml: string) => [...toml.matchAll(/^([a-z_0-9]+)\s*=/gm)].map((m) => m[1]!);

/** A real PNG of one colour, small enough to keep tests fast. */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Entries of a .tar.gz, by path, with their sizes. */
function untar(gz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(gz);
  const out = new Map<string, Buffer>();
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    const size = parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
    const path = prefix ? `${prefix}/${name}` : name;
    out.set(path, tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe('colors.toml and tokens', () => {
  it('names tokens after the keys and back', () => {
    expect(tokenForKey('dark_background')).toBe('omarchy-dark-background');
    expect(keyForToken('omarchy-bright-magenta')).toBe('bright_magenta');
    expect(keyForToken('accent')).toBeNull();
    expect(keyForToken('omarchy-Bad Name')).toBeNull();
  });

  it('writes a stock theme back with its keys in their order and groups', () => {
    const parsed = parseColorsToml(STOCK_COLORS);
    const tokens = themeTokens(parsed);
    expect(tokens.map((t) => t.name)).toEqual([...PALETTE_KEYS.map(tokenForKey), 'omarchy-hyprland-active-border', 'omarchy-hyprland-inactive-border']);
    const out = themeFromTokens(tokens, { mode: parsed.mode });
    expect(out.problems).toEqual([]);
    // Borders at Omarchy's defaults stay out, as in the stock file.
    expect(colorsToml(out)).toBe(STOCK_COLORS);
  });

  it('fills a partial palette the way omarchy-theme-color does', () => {
    const p = resolvePalette({ color0: '#000000', color7: '#ffffff', color1: '#ff0000', color4: '#0000ff', bg: '#101010' });
    expect(p.background).toBe('#101010');
    expect(p.foreground).toBe('#ffffff');
    expect(p.red).toBe('#ff0000');
    expect(p.accent).toBe('#0000ff');
    expect(p.bright_red).toBe('#ff3333');
    expect(p.dark_background).toBe('#0c0c0c');
    expect(Object.keys(p)).toEqual([...PALETTE_KEYS]);
  });

  it('turns Hyprland borders into CSS and back', () => {
    expect(hyprToCss('rgba(26a269ee) rgba(2ec27eee) 45deg')).toBe('linear-gradient(45deg, #26a269ee, #2ec27eee)');
    expect(hyprToCss('rgb(dcd7ba)')).toBe('#dcd7ba');
    expect(hyprToCss('accent')).toBe('var(--omarchy-accent)');
    expect(hyprToCss('0xee33ccff')).toBe('#33ccffee');
    expect(hyprToCss('not a colour')).toBeUndefined();
    expect(cssToHypr('linear-gradient(45deg, #26a269ee, #2ec27eee)')).toBe('rgba(26a269ee) rgba(2ec27eee) 45deg');
    expect(cssToHypr('linear-gradient(90deg, var(--omarchy-accent), #ffffff)')).toBe('accent rgb(ffffff)');
    expect(cssToHypr('#584e51aa')).toBe('rgba(584e51aa)');
    expect(cssToHypr('oklch(70% 0.1 200)')).toMatch(/^rgb\([0-9a-f]{6}\)$/);
    expect(cssToHypr('linear-gradient(to right, red, blue)')).toBeUndefined();
  });

  it('keeps a border gradient and other keys of a theme through a round trip', () => {
    const text = `${STOCK_COLORS}hyprland_active_border = "rgba(8a8588ee) rgba(e2dddcee)"\nhyprland_inactive_border = "rgba(584e51aa)"\nactive_tab_background = "#0A84FF"\n`;
    const parsed = parseColorsToml(text);
    const tokens = themeTokens(parsed);
    expect(tokens.find((t) => t.name === 'omarchy-hyprland-active-border')!.value).toBe('linear-gradient(90deg, #8a8588ee, #e2dddcee)');
    expect(tokens.find((t) => t.name === 'omarchy-active-tab-background')!.value).toBe('#0a84ff');
    const toml = colorsToml(themeFromTokens(tokens, { mode: 'dark' }));
    expect(toml).toContain('hyprland_active_border = "rgba(8a8588ee) rgba(e2dddcee)"');
    expect(toml).toContain('hyprland_inactive_border = "rgba(584e51aa)"');
    expect(toml).toContain('active_tab_background = "#0a84ff"');
  });

  it('writes an alias as the colour it shows, and says what it cannot write', () => {
    const tokens = themeTokens(parseColorsToml(STOCK_COLORS)).map((t) => (t.name === 'omarchy-blue' ? { ...t, value: 'var(--omarchy-accent)' } : t.name === 'omarchy-red' ? { ...t, value: 'linear-gradient(red, blue)' } : t));
    const out = themeFromTokens(tokens, {});
    expect(new Map(out.entries).get('blue')).toBe('#89b4fa');
    expect(out.problems.join(' ')).toMatch(/--omarchy-red/);
    expect(out.mode).toBe('dark');
  });

  it('gives a folder name Omarchy accepts, or none', () => {
    expect(themeSlug('Tokyo Night')).toBe('tokyo-night');
    expect(themeSlug('Café Noir 2')).toBe('cafe-noir-2');
    expect(themeSlug('../../etc')).toBe('etc');
    expect(themeSlug('...')).toBeNull();
    expect(validThemeName('a/b')).toBe(false);
    expect(validThemeName('.hidden')).toBe(false);
  });

  it('picks the Yaru icons nearest to the accent', () => {
    expect(iconsThemeFor('#89b4fa')).toBe('Yaru-blue');
    expect(iconsThemeFor('#f38ba8')).toBe('Yaru-red');
    expect(iconsThemeFor('#888888')).toBe('Yaru-wartybrown');
  });

  it.skipIf(!hasRealStock)('reads every stock theme on this machine into the same keys', () => {
    for (const name of readdirSync(REAL_STOCK)) {
      // Omarchy 4.5 keeps folders that hold only backgrounds; a theme is a folder with colors.toml.
      if (!existsSync(join(REAL_STOCK, name, 'colors.toml'))) continue;
      const text = readFileSync(join(REAL_STOCK, name, 'colors.toml'), 'utf8');
      const toml = colorsToml(themeFromTokens(themeTokens(parseColorsToml(text)), { mode: parseColorsToml(text).mode }));
      const stockKeys = keysOf(text);
      // Every key of the stock file comes back, and the palette is complete even where the stock file is not.
      for (const key of stockKeys) expect(keysOf(toml), `${name}: ${key}`).toContain(key);
      for (const key of PALETTE_KEYS) expect(keysOf(toml), `${name}: ${key}`).toContain(key);
    }
  });

  it('reads the size of a PNG and a JPEG header', () => {
    expect(imageSize(png(7, 5, [0, 0, 0]))).toEqual({ width: 7, height: 5 });
    const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108021c03c003012200021101031101', 'hex');
    expect(imageSize(jpeg)).toEqual({ width: 960, height: 540 });
  });
});

describe('the template', () => {
  const screens = [{ width: 3840, height: 2160 }, { width: 2560, height: 1600 }];

  it('draws the bar with the glyphs of the real one where Omarchy\'s fonts are, and line icons elsewhere', () => {
    const desktop = (glyphs: boolean) => themeBoards({ name: 'Dusk', screens, glyphs }).find((b) => b.kind === 'desktop')!.html;
    const launcher = (glyphs: boolean) => themeBoards({ name: 'Dusk', screens, glyphs }).find((b) => b.kind === 'launcher')!.html;
    // The menu glyph of Omarchy's icon font, the focused workspace and the bluetooth glyph of the Nerd Font.
    for (const glyph of ['\ue900', '\u{f14fb}', '\u{f00af}']) expect(desktop(true)).toContain(glyph);
    expect(desktop(true)).toContain('font-family:omarchy');
    expect(launcher(true)).toContain('\u{f003b}');
    expect(desktop(false)).not.toContain('\ue900');
    expect(desktop(false)).toContain('<svg');
  });

  it('lays out the stock bar: five 20 px workspaces, the clock in the middle, 27 px icon slots', () => {
    const html = themeBoards({ name: 'Dusk', screens }).find((b) => b.kind === 'desktop')!.html;
    expect((html.match(/data-name="Workspace \d/g) ?? []).length).toBe(5);
    expect(html).toMatch(/grid-template-columns:1fr auto 1fr;align-items:center;height:26px/);
    expect((html.match(/width:27px;height:26px/g) ?? []).length).toBe(5);
  });

  it('puts the boot entry 40 px under unlock.png, as the Plymouth script does, at the logo\'s own size', () => {
    const boot = (unlock?: { width: number; height: number }) => themeBoards({ name: 'Dusk', screens, ...(unlock ? { unlock: { ...unlock, src: 'bogen-asset:x.png', name: 'unlock.png' } } : {}) });
    const plain = boot().find((b) => b.kind === 'boot')!.html;
    // 1080 / 2 - 188 / 2 + 188 + 40
    expect(plain).toContain('left:817px;top:674px;width:286px;height:48px');
    const big = boot({ width: 1108, height: 523 });
    expect(big.find((b) => b.kind === 'unlock')!).toMatchObject({ name: 'Unlock logo · 1108 × 523', width: 1108, height: 523 });
    expect(big.find((b) => b.kind === 'boot')!.html).toContain('top:842px;width:286px');
  });

  it('gives every screen a background, the first the design and the others instances of it', () => {
    const boards = themeBoards({ name: 'Dusk', screens });
    expect(boards.filter((b) => b.kind === 'background').map((b) => [b.width, b.height])).toEqual([[3840, 2160], [2560, 1600]]);
    expect(boards[1]!.html).toContain('<x-instance component="Wallpaper"');
  });
});

describe('outside the theme folders', () => {
  it('finds omarchy on PATH, or in $OMARCHY_PATH/bin for a service started without it', () => {
    const root = mkdtempSync(join(tmpdir(), 'bogen-omarchy-bin-'));
    try {
      mkdirSync(join(root, 'omarchy', 'bin'), { recursive: true });
      writeFileSync(join(root, 'omarchy', 'bin', 'omarchy'), '#!/bin/sh\n');
      const app = { options: { home: root } } as Parameters<typeof themeEnv>[0];
      expect(themeEnv(app, { HOME: root, OMARCHY_PATH: join(root, 'omarchy'), PATH: '/nowhere' }).bin).toBe(join(root, 'omarchy', 'bin', 'omarchy'));
      expect(themeEnv(app, { HOME: root, OMARCHY_PATH: join(root, 'omarchy'), PATH: join(root, 'omarchy', 'bin') }).bin).toBe('omarchy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('makes an exported folder a repository of its own, even inside another one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bogen-omarchy-git-'));
    try {
      await gitInit(root);
      const inner = join(root, 'omarchy-dusk-theme');
      expect(await gitInit(inner, { own: true })).toBe(true);
      expect(existsSync(join(inner, '.git'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- the server, with a temp HOME and a stand-in omarchy

describe('Omarchy theme files', () => {
  let h: Harness;
  let root: string;
  let home: string;
  let omarchyPath: string;
  let log: string;
  const saved = { HOME: process.env.HOME, OMARCHY_PATH: process.env.OMARCHY_PATH, PATH: process.env.PATH };
  const userThemes = () => join(home, '.config', 'omarchy', 'themes');
  const themeName = () => readFileSync(join(home, '.local', 'state', 'omarchy', 'current', 'theme.name'), 'utf8').trim();
  const api = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(`${h.base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: type.includes('json') ? await res.json() as any : Buffer.from(await res.arrayBuffer()) };
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'bogen-omarchy-'));
    home = join(root, 'home');
    omarchyPath = join(root, 'omarchy');
    const bin = join(root, 'bin');
    log = join(root, 'omarchy.log');
    // A stock theme with its files, and the templates Omarchy fills from colors.toml.
    const stock = join(omarchyPath, 'themes', 'catppuccin');
    mkdirSync(join(stock, 'backgrounds'), { recursive: true });
    writeFileSync(join(stock, 'colors.toml'), STOCK_COLORS);
    writeFileSync(join(stock, 'icons.theme'), 'Yaru-purple\n');
    writeFileSync(join(stock, 'neovim.lua'), 'return {}\n');
    writeFileSync(join(stock, 'vscode.json'), '{}\n');
    writeFileSync(join(stock, 'preview.png'), png(18, 10, [30, 30, 46]));
    writeFileSync(join(stock, 'preview-unlock.png'), png(19, 10, [30, 30, 46]));
    writeFileSync(join(stock, 'unlock.png'), png(80, 19, [205, 214, 244]));
    writeFileSync(join(stock, 'backgrounds', '1-waves.png'), png(64, 36, [137, 180, 250]));
    writeFileSync(join(stock, 'backgrounds', '2-dusk.png'), png(64, 36, [243, 139, 168]));
    mkdirSync(join(omarchyPath, 'default', 'themed'), { recursive: true });
    for (const t of TEMPLATES) writeFileSync(join(omarchyPath, 'default', 'themed', `${t}.tpl`), '');
    mkdirSync(join(home, '.local', 'state', 'omarchy', 'current'), { recursive: true });
    writeFileSync(join(home, '.local', 'state', 'omarchy', 'current', 'theme.name'), 'catppuccin\n');
    mkdirSync(userThemes(), { recursive: true });
    // Stand-ins: `omarchy theme set` records the call and switches theme.name, as the real one does last; hyprctl reports small screens.
    mkdirSync(bin);
    writeFileSync(join(bin, 'omarchy'), `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = theme ] && [ "$2" = set ]; then printf '%s\\n' "$3" > "$HOME/.local/state/omarchy/current/theme.name"; fi\n`);
    writeFileSync(join(bin, 'hyprctl'), `#!/bin/sh\necho '[{"width":320,"height":180,"transform":0},{"width":320,"height":180,"transform":0},{"width":180,"height":320,"transform":0}]'\n`);
    chmodSync(join(bin, 'omarchy'), 0o755);
    chmodSync(join(bin, 'hyprctl'), 0o755);
    process.env.HOME = home;
    process.env.OMARCHY_PATH = omarchyPath;
    process.env.PATH = `${bin}:${saved.PATH}`;
    h = await startServer();
  });

  afterAll(async () => {
    await h?.cleanup();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('lists the installed themes', async () => {
    const { body } = await api('/api/omarchy/themes');
    expect(body.onOmarchy).toBe(true);
    expect(body.themes.map((t: any) => t.name)).toEqual(['catppuccin']);
    expect(body.themes[0]).toMatchObject({ title: 'Catppuccin', source: 'stock', mode: 'dark', backgrounds: 2, current: true });
    // The screens of the stand-in hyprctl, a turned one the way it is mounted, each size once.
    expect(body.screens).toEqual([{ width: 320, height: 180 }, { width: 180, height: 320 }]);
  });

  it('names a theme started from another "<name> Custom", and renames its file with it', async () => {
    const made = await api('/api/omarchy/themes', { from: 'catppuccin' });
    expect(made.body.name).toBe('Catppuccin Custom');
    expect(made.body.file_name).toBe('Catppuccin Custom · Omarchy theme');
    const renamed = await api(`/api/omarchy/theme/${made.body.file_id}`, { name: 'Mocha Night' }, 'PATCH');
    expect(renamed.body.theme).toMatchObject({ name: 'Mocha Night', slug: 'mocha-night' });
    expect(h.server.storage.get(made.body.file_id)!.name).toBe('Mocha Night · Omarchy theme');
    expect((await api(`/api/omarchy/theme/${made.body.file_id}`, { name: '...' }, 'PATCH')).status).toBe(400);
  });

  it('lays out a new theme: tokens named after colors.toml, previews drawn from them, backgrounds at the screen sizes', async () => {
    const agent = await connectAgent(h.base, 'claude');
    const out = await call(agent, 'omarchy_theme_create', { name: 'Dusk' });
    expect(out.slug).toBe('dusk');
    const tokens = await call(agent, 'tokens_get', { file_id: out.file_id });
    const names = JSON.stringify(tokens);
    for (const key of PALETTE_KEYS) expect(names).toContain(`omarchy-${key.replace(/_/g, '-')}`);
    // The stand-in hyprctl's portrait screen is smaller than Bogen draws desktop previews for, so the theme gets the
    // 1080 x 1920 portrait preset, with a composition of its own instead of a portrait copy of the landscape background.
    expect(out.boards.map((b: any) => b.name)).toEqual([
      'Background 1 · 320 × 180', 'Portrait background · 9:16 · 2160 × 3840', 'Unlock logo · 800 × 188',
      'Preview · desktop', 'Preview · launcher', 'Preview · lock screen', 'Preview · boot unlock',
      'Preview · desktop · portrait 1080 × 1920', 'Preview · launcher · portrait 1080 × 1920', 'Preview · lock screen · portrait 1080 × 1920', 'Preview · boot unlock · portrait 1080 × 1920',
    ]);
    const room = await h.server.rooms.get(out.file_id);
    const { doc } = room;
    const desktop = out.boards.find((b: any) => b.name === 'Preview · desktop').id;
    // Every colour on the previews is a token, so one token change reaches all of them.
    const colours = doc.descendants(desktop).flatMap((n) => [n.style.color, n.style.backgroundColor, n.style.background].filter(Boolean)) as string[];
    expect(colours.length).toBeGreaterThan(50);
    for (const c of colours) expect(c, c).toMatch(/var\(--omarchy-|transparent/);
    const components = await call(agent, 'component_list', { file_id: out.file_id });
    for (const name of ['Wallpaper', 'Bar', 'Unlock logo']) expect(JSON.stringify(components)).toContain(name);
    // The portrait composition is its own design, not an instance of the landscape one, and the portrait previews show it.
    const portrait = doc.getChildren(out.boards[1].id)[0]!;
    expect(portrait.instanceOf).toBeUndefined();
    expect(portrait.name).toBe('Wallpaper · portrait 9:16');
    const portraitDesktop = out.boards.find((b: any) => b.name === 'Preview · desktop · portrait 1080 × 1920').id;
    expect(doc.getChildren(portraitDesktop)[0]!.instanceOf).toBe(portrait.id);
    await agent.close();
  });

  it('starts from an installed theme with its palette and backgrounds', async () => {
    const { status, body } = await api('/api/omarchy/themes', { from: 'catppuccin', name: 'Catppuccin Remix', new_project: true });
    expect(status).toBe(201);
    expect(body.left).toEqual(['neovim.lua', 'vscode.json']);
    expect(body.boards.filter((b: any) => b.name.startsWith('Background')).map((b: any) => b.name)).toEqual(['Background 1 · 1-waves.png', 'Background 2 · 2-dusk.png']);
    const room = await h.server.rooms.get(body.file_id);
    const tokens = new Map(room.doc.getTokens().map((t) => [t.name, t.value]));
    expect(tokens.get('omarchy-accent')).toBe('#89b4fa');
    expect(tokens.get('omarchy-brown')).toBe('#7b5b55');
    const info = await api(`/api/omarchy/theme/${body.file_id}`);
    expect(info.body.theme).toMatchObject({ name: 'Catppuccin Remix', slug: 'catppuccin-remix', mode: 'dark', from: 'catppuccin', installed: null, overStock: false });
    expect(info.body.theme.backgrounds.every((b: any) => b.kept)).toBe(true);
    expect(info.body.theme.generated).toEqual(TEMPLATES);
  });

  describe.skipIf(!findBrowser())('export, install and apply', () => {
    let fileId: string;
    let files: Map<string, Buffer>;

    beforeAll(async () => {
      const made = await api('/api/omarchy/themes', { from: 'catppuccin', name: 'Remix', new_project: true });
      fileId = made.body.file_id;
      const tar = await api(`/api/omarchy/theme/${fileId}/export`, { to: 'tar' });
      expect(tar.status).toBe(200);
      files = untar(tar.body as Buffer);
    }, 120_000);

    it('exports a theme folder with the files a stock theme has, and none Omarchy writes itself', async () => {
      const paths = [...files.keys()].filter((p) => !p.endsWith('/')).map((p) => p.replace(/^remix\//, '')).sort();
      // The portrait composition is still Bogen's placeholder, so it is not shipped; the runtime manifest says so.
      expect(paths).toEqual(['README.md', 'backgrounds/1-waves.png', 'backgrounds/2-dusk.png', 'bogen-theme.json', 'colors.toml', 'displays/portrait-runtime.json', 'displays/preview-portrait-1080x1920.png', 'icons.theme', 'preview-unlock.png', 'preview.png', 'shell.toml', 'unlock.png']);
      expect(JSON.parse(files.get('remix/displays/portrait-runtime.json')!.toString('utf8'))).toMatchObject({ wallpapers: [], incomplete: [{ aspect: '9:16', status: 'needs-design' }] });
      // What the stock theme ships, less what Omarchy generates or a repository may not carry.
      const shipped = STOCK_FILES.filter((f) => !f.endsWith('.lua') && f !== 'vscode.json');
      for (const f of shipped) expect(paths.some((p) => p === f || p.startsWith(`${f}/`)), f).toBe(true);
      // shell.toml is the theme's own design of the shell surfaces, written from its tokens, so it ships; every other
      // file Omarchy generates from colors.toml stays out.
      expect(paths).toContain('shell.toml');
      for (const t of TEMPLATES.filter((x) => x !== 'shell.toml')) expect(paths).not.toContain(t);
      const toml = files.get('remix/colors.toml')!.toString('utf8');
      expect(keysOf(toml)).toEqual(keysOf(STOCK_COLORS));
      expect(toml).toBe(STOCK_COLORS);
      expect(files.get('remix/icons.theme')!.toString('utf8')).toBe('Yaru-blue\n');
      // Images that came in untouched go out byte for byte; the previews are rendered at the stock sizes.
      expect(files.get('remix/backgrounds/1-waves.png')!.equals(png(64, 36, [137, 180, 250]))).toBe(true);
      expect(files.get('remix/unlock.png')!.equals(png(80, 19, [205, 214, 244]))).toBe(true);
      expect(await pngStats(files.get('remix/preview.png')!)).toMatchObject({ width: 1800, height: 1012 });
      expect(await pngStats(files.get('remix/preview-unlock.png')!)).toMatchObject({ width: 1920, height: 1080 });
    });

    it('renders a new theme\'s backgrounds at full size, and follows a token change', async () => {
      const agent = await connectAgent(h.base, 'claude');
      const made = await call(agent, 'omarchy_theme_create', { name: 'Dusk Two' });
      const dest = join(root, 'exports', 'dusk-two');
      const out = await call(agent, 'omarchy_theme_export', { file_id: made.file_id, dest, git: true });
      expect(out.files).toContain('backgrounds/1-320x180.png');
      expect(out.files.filter((f: string) => f.startsWith('backgrounds/'))).toEqual(['backgrounds/1-320x180.png']);
      // A new theme's portrait composition is a placeholder until designed: not shipped, listed as incomplete.
      expect(out.files).not.toContain('displays/background-portrait-9x16.png');
      expect(out.files).toContain('displays/portrait-runtime.json');
      expect(out.git).toMatch(/^[0-9a-f]{7,}/);
      expect(await pngStats(readFileSync(join(dest, 'backgrounds', '1-320x180.png')))).toMatchObject({ width: 320, height: 180 });
      const before = readFileSync(join(dest, 'preview.png'));
      // A folder that has files in it is never written into.
      const again = await callRaw(agent, 'omarchy_theme_export', { file_id: made.file_id, dest });
      expect(again.isError).toBe(true);
      expect(again.content[0]!.text).toMatch(/not empty/);
      await call(agent, 'tokens_set', { file_id: made.file_id, tokens: [{ name: 'omarchy-background', kind: 'color', value: '#00ff00' }, { name: 'omarchy-hyprland-active-border', kind: 'color', value: 'linear-gradient(45deg, var(--omarchy-red), #00ffffee)' }] });
      const dest2 = join(root, 'exports', 'dusk-three.tar.gz');
      await call(agent, 'omarchy_theme_export', { file_id: made.file_id, dest: dest2 });
      const second = untar(readFileSync(dest2));
      expect(second.get('dusk-two/colors.toml')!.toString()).toContain('background = "#00ff00"');
      expect(second.get('dusk-two/colors.toml')!.toString()).toContain('hyprland_active_border = "red rgba(00ffffee) 45deg"');
      expect(second.get('dusk-two/preview.png')!.equals(before)).toBe(false);
      await agent.close();
    }, 120_000);

    it('installs into the themes folder, refuses to replace without a yes, and never writes outside it', async () => {
      const agent = await connectAgent(h.base, 'claude');
      const first = await call(agent, 'omarchy_theme_install', { file_id: fileId });
      expect(first).toMatchObject({ name: 'remix', replaced: false, overStock: false });
      expect(readdirSync(join(userThemes(), 'remix')).sort()).toEqual(['README.md', 'backgrounds', 'bogen-theme.json', 'colors.toml', 'displays', 'icons.theme', 'preview-unlock.png', 'preview.png', 'shell.toml', 'unlock.png']);
      writeFileSync(join(userThemes(), 'remix', 'mine.txt'), 'the person wrote this');
      // An agent cannot replace it.
      const refused = await callRaw(agent, 'omarchy_theme_install', { file_id: fileId });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toMatch(/installed already/);
      expect(readFileSync(join(userThemes(), 'remix', 'mine.txt'), 'utf8')).toBe('the person wrote this');
      // Nor can the editor without the person's yes.
      expect((await api(`/api/omarchy/theme/${fileId}/install`, {})).status).toBe(409);
      expect((await api(`/api/omarchy/theme/${fileId}`)).body.theme.installed).toBe(join(userThemes(), 'remix'));
      const yes = await api(`/api/omarchy/theme/${fileId}/install`, { overwrite: true });
      expect(yes.status).toBe(201);
      expect(yes.body.replaced).toBe(true);
      expect(existsSync(join(userThemes(), 'remix', 'mine.txt'))).toBe(false);
      expect(readdirSync(userThemes()).filter((f) => f.startsWith('.'))).toEqual([]);
      await agent.close();
    }, 60_000);

    it('refuses names and paths that would leave the themes folder, and links', async () => {
      const env: ThemeEnv = { home, omarchyPath, bin: 'omarchy', stateFile: join(root, 'state.json'), omamobilePath: join(root, 'no-omamobile') };
      const theme = (slug: string, path = 'colors.toml'): ThemeExport => ({ name: slug, slug, mode: 'dark', target: 'desktop', manifest: {} as ThemeExport['manifest'], files: [{ path, bytes: new TextEncoder().encode('x') }], generated: [], problems: [], notes: [] });
      await expect(installTheme(env, theme('..'))).rejects.toThrow(/not a theme name/);
      await expect(installTheme(env, theme('a/../../b'))).rejects.toThrow(/not a theme name/);
      await expect(installTheme(env, theme('fine', '../../escape.txt'))).rejects.toThrow(/not a path inside/);
      await expect(installTheme(env, theme('fine2', 'backgrounds/../../escape.txt'))).rejects.toThrow(/not a path inside/);
      expect(existsSync(join(home, '.config', 'omarchy', 'escape.txt'))).toBe(false);
      expect(existsSync(join(userThemes(), 'fine'))).toBe(false);
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(userThemes(), 'linked'));
      await expect(installTheme(env, theme('linked'))).rejects.toThrow(/link/);
      await expect(installTheme(env, theme('linked'), { overwrite: true })).rejects.toThrow(/link/);
      expect(readdirSync(elsewhere)).toEqual([]);
    });

    it('applies only on request, with the stand-in, and undo goes back to the theme before', async () => {
      writeFileSync(log, '');
      expect(themeName()).toBe('catppuccin');
      const applied = await api('/api/omarchy/apply', { name: 'remix' });
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ applied: 'remix', previous: 'catppuccin' });
      expect(themeName()).toBe('remix');
      // A second apply keeps the theme the person started from.
      await api('/api/omarchy/apply', { name: 'remix' });
      expect((await api('/api/omarchy/themes')).body.apply).toMatchObject({ applied: 'remix', previous: 'catppuccin', current: 'remix' });
      const undone = await api('/api/omarchy/undo-apply', {});
      expect(undone.body).toMatchObject({ restored: 'catppuccin' });
      expect(themeName()).toBe('catppuccin');
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['theme set remix', 'theme set remix', 'theme set catppuccin']);
      expect((await api('/api/omarchy/undo-apply', {})).status).toBe(409);
      expect((await api('/api/omarchy/apply', { name: 'not-installed' })).status).toBe(404);
      expect((await api('/api/omarchy/apply', { name: '../x' })).status).toBe(400);
    });

    it('never runs omarchy from an agent', async () => {
      writeFileSync(log, '');
      const agent = await connectAgent(h.base, 'claude');
      const { tools } = await agent.listTools();
      expect(tools.map((t) => t.name).filter((n) => n.startsWith('omarchy_'))).toEqual(['omarchy_theme_list', 'omarchy_theme_projects', 'omarchy_theme_create', 'omarchy_theme_displays', 'omarchy_theme_export', 'omarchy_theme_install']);
      await call(agent, 'omarchy_theme_install', { file_id: (await call(agent, 'omarchy_theme_create', { name: 'Agent Made' })).file_id });
      expect(readFileSync(log, 'utf8')).toBe('');
      await agent.close();
    }, 60_000);
  });

  it('writes a tar every tar reads', () => {
    const gz = tarGz([{ path: 'colors.toml', bytes: new TextEncoder().encode('mode = "dark"\n') }, { path: 'backgrounds/1-a.png', bytes: png(2, 2, [1, 2, 3]) }], 'dusk');
    const entries = untar(gz);
    expect([...entries.keys()]).toEqual(['dusk/', 'dusk/backgrounds/', 'dusk/colors.toml', 'dusk/backgrounds/1-a.png']);
    expect(entries.get('dusk/colors.toml')!.toString()).toBe('mode = "dark"\n');
    expect(BORDER_DEFAULTS.hyprland_active_border).toBe('var(--omarchy-accent)');
  });
});
