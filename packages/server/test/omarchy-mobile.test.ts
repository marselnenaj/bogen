import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BogenDoc } from '@bogen/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KOMODO, MOBILE_COVERAGE, themeManifest } from '../src/omarchy-mobile.ts';
import {
  parseShellToml, resolveShellColor, SHELL_ROLES, shellFromTokens, shellTokenFor, shellTokens, themeFromTokens, themeTokens, DEFAULT_COLORS, colorsToml,
} from '../src/omarchy-theme.ts';
import {
  adoptTheme, assertTargetMatches, installTheme, isThemeCandidate, isThemeFile, mobilePackage, tarGz, themeConsistency, themeMeta, type ThemeEnv, type ThemeExport,
} from '../src/omarchy-themes.ts';
import { probeVideo, videoAdvice } from '../src/omarchy-videos.ts';
import { mobileBoards } from '../src/templates/omarchy-mobile.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

const enc = new TextEncoder();
const palette = () => themeTokens({ colors: DEFAULT_COLORS, raw: {}, mode: 'dark' });

describe('shell surfaces', () => {
  it('writes every role of a new theme to shell.toml, and Omarchy\'s own parser reads back what it shows', () => {
    const tokens = [...palette(), ...shellTokens()];
    const out = shellFromTokens(tokens);
    expect(out.problems).toEqual([]);
    const read = parseShellToml(out.toml);
    // Everything written is read back by the shell's line parser, value for value.
    expect(read).toEqual(out.values);
    const byName = new Map(tokens.map((t) => [t.name, t.value]));
    for (const role of SHELL_ROLES) {
      const value = read[`${role.section}.${role.key}`];
      expect(value, `${role.section}.${role.key}`).toBeDefined();
      if (value === 'hyprland.active-border') continue;
      const c = resolveShellColor(byName.get(shellTokenFor(role))!, byName)!;
      expect(value).toBe('#' + [c.r, c.g, c.b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join(''));
    }
    // Omarchy's own defaults: lock field at 80 %, launcher card at 95 %, scrims at half, selection at 45 %.
    expect(read['lock.background-alpha']).toBe('0.8');
    expect(read['launcher.background-alpha']).toBe('0.95');
    expect(read['menu.scrim-alpha']).toBe('0.5');
    expect(read['lock.selection-alpha']).toBe('0.45');
    // Omarchy's template mixes foreground and background, 34 % of the background: #e6e0d6 and #17151a give #a09b96.
    expect(read['lock.placeholder']).toBe('#a09b96');
    expect(read['font.base-size']).toBe('12');
    // Borders that follow the window border stay that gradient, which the [hyprland] section carries.
    expect(read['lock.border']).toBe('hyprland.active-border');
    expect(read['hyprland.active-border']).toBe(DEFAULT_COLORS.accent);
  });

  it('keeps a gradient border as the shell\'s gradient and says what it cannot write', () => {
    const tokens = [...palette(), ...shellTokens('15px'),
      { name: 'omarchy-hyprland-active-border', kind: 'color', value: 'linear-gradient(45deg, var(--omarchy-red), #00ffffee)' },
      { name: shellTokenFor({ section: 'bar', key: 'text' }), kind: 'color', value: '#ffffff80' },
      { name: shellTokenFor({ section: 'menu', key: 'background' }), kind: 'color', value: 'linear-gradient(red, blue)' }];
    const dedup = [...new Map(tokens.map((t) => [t.name, t])).values()];
    const out = shellFromTokens(dedup);
    const read = parseShellToml(out.toml);
    expect(read['hyprland.active-border']).toBe(`${DEFAULT_COLORS.red} #00ffffee 45deg`);
    expect(read['font.base-size']).toBe('15');
    expect(out.problems.join('\n')).toMatch(/bar\.text takes an opaque colour/);
    expect(out.problems.join('\n')).toMatch(/omarchy-shell-menu-background is linear-gradient/);
    // Surface roles never leak into colors.toml as stray colours.
    expect(colorsToml(themeFromTokens(dedup))).not.toMatch(/shell/);
  });

  it('writes nothing for a file from before shell roles', () => {
    expect(shellFromTokens(palette())).toEqual({ toml: '', values: {}, problems: [] });
  });
});

describe('targets and old files', () => {
  it('no longer takes three palette tokens for a desktop theme, and makes one only on request', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    doc.transact(() => {
      for (const t of palette().slice(0, 12)) doc.setToken(t.name, t.kind, t.value);
    });
    expect(isThemeFile(doc)).toBe(false);
    expect(isThemeCandidate(doc)).toBe(true);
    const meta = adoptTheme(doc, { name: 'Phone Screens', target: 'mobile' }, 'test');
    expect(meta).toMatchObject({ target: 'mobile', profile: 'komodo', format: 2 });
    expect(isThemeFile(doc)).toBe(true);
    expect(() => adoptTheme(doc, { name: 'Again', target: 'desktop' }, 'test')).toThrow(/already/);
  });

  it('reads a file from before targets as a desktop theme of format 1', () => {
    const doc = new BogenDoc();
    doc.transact(() => doc.meta.set('omarchyTheme', { name: 'Old', mode: 'dark' }));
    expect(themeMeta(doc)).toMatchObject({ name: 'Old', target: 'desktop', format: 1 });
  });

  it('refuses a theme for the other kind of device before writing anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bogen-target-'));
    const env: ThemeEnv = { home: join(root, 'home'), omarchyPath: join(root, 'omarchy'), bin: 'omarchy', stateFile: join(root, 's.json'), omamobilePath: join(root, 'none') };
    const theme = { name: 'Phone', slug: 'phone', mode: 'dark', target: 'mobile', manifest: {}, files: [{ path: 'colors.toml', bytes: enc.encode('x') }], generated: [], problems: [] } as unknown as ThemeExport;
    await expect(installTheme(env, theme)).rejects.toThrow(/mobile theme, and this machine is a desktop/);
    expect(existsSync(join(env.home, '.config', 'omarchy', 'themes', 'phone'))).toBe(false);
    mkdirSync(join(root, 'omamobile'));
    expect(() => assertTargetMatches({ ...env, omamobilePath: join(root, 'omamobile') }, 'desktop', 'Desk')).toThrow(/desktop theme, and this machine is an Omarchy Mobile phone/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('the preview and the export agree', () => {
  it('draws the phone screens only from theme tokens, at the profile\'s logical size', () => {
    const boards = mobileBoards({ name: 'Dusk', profile: KOMODO });
    const phones = boards.filter((b) => b.kind === 'phone');
    expect(phones.map((b) => [b.width, b.height])).toEqual(phones.map(() => [420, 935]));
    expect(boards.find((b) => b.kind === 'background')).toMatchObject({ width: 1344, height: 2992 });
    expect(boards.find((b) => b.kind === 'preview')).toMatchObject({ width: 1800, height: 1012 });
    for (const b of phones) {
      const vars = [...b.html.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]!);
      expect(vars.length).toBeGreaterThan(10);
      for (const v of vars) expect(v, `${b.name}: ${v}`).toMatch(/^omarchy-/);
      // No colour typed in: every colour is a token, or a mix of them.
      expect(b.html, b.name).not.toMatch(/(?:color|background):\s*#[0-9a-f]{3,8}/i);
    }
    // Each shell section the phone reads appears on a preview.
    const all = phones.map((b) => b.html).join('');
    for (const section of ['bar', 'lock', 'launcher', 'menu', 'popups', 'notifications', 'polkit']) expect(all, section).toContain(`--omarchy-shell-${section}-`);
  });

  it('catches the green preview of an acid theme (om-accent beside omarchy-accent)', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const page = doc.getPages()[0]!.id;
    doc.transact(() => {
      doc.setToken('om-accent', 'color', '#9ece6a');
      doc.setToken('omarchy-accent', 'color', '#d8ff3d');
      doc.meta.set('omarchyTheme', { name: 'Acid', target: 'mobile', profile: 'komodo', format: 2 });
    });
    const board = doc.insert(page, { type: 'frame', name: 'Phone · appearance', artboard: true, style: { width: '420px', height: '935px' } });
    doc.insert(board, { type: 'frame', name: 'Accent swatch', style: { background: 'var(--om-accent)' } });
    const problems = themeConsistency(doc);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/--om-accent \(#9ece6a\).*exports accent as #d8ff3d/);
    // Drawn from the theme's own token, there is nothing to report.
    doc.updateStyle(doc.getChildren(board)[0]!.id, { background: 'var(--omarchy-accent)' });
    expect(themeConsistency(doc)).toEqual([]);
  });
});

// ---------------------------------------------------------------- the package on a stand-in phone

function untar(gz: Buffer, into: string): void {
  writeFileSync(join(into, 'pkg.tar.gz'), gz);
  execFileSync('tar', ['-xzf', 'pkg.tar.gz'], { cwd: into });
}

function fixtureTheme(accent: string, extra: { path: string; text: string }[] = []): ThemeExport {
  const tokens = [...palette().map((t) => (t.name === 'omarchy-accent' ? { ...t, value: accent } : t)), ...shellTokens()];
  const out = themeFromTokens(tokens, { name: 'Dusk', mode: 'dark' });
  const files = [
    { path: 'colors.toml', bytes: enc.encode(colorsToml(out)) },
    { path: 'shell.toml', bytes: enc.encode(shellFromTokens(tokens).toml) },
    { path: 'backgrounds/1-1344x2992.png', bytes: enc.encode('not really a png') },
    ...extra.map((e) => ({ path: e.path, bytes: enc.encode(e.text) })),
  ];
  const manifest = themeManifest({ name: 'Dusk', slug: 'dusk', target: 'mobile', mode: 'dark', profile: KOMODO, files, version: 'test' });
  return { name: 'Dusk', slug: 'dusk', mode: 'dark', target: 'mobile', profile: KOMODO, manifest, files: [...files, { path: 'bogen-theme.json', bytes: enc.encode(JSON.stringify(manifest)) }], generated: [], problems: [], notes: [] };
}

describe('install.sh against a Komodo fixture', () => {
  let root: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let log: string;
  const themes = () => join(home, '.config', 'omarchy', 'themes');
  const current = () => join(home, '.local', 'state', 'omarchy', 'current', 'theme.name');

  const unpack = (theme: ThemeExport, name: string) => {
    const pkg = mobilePackage(theme);
    const dir = join(root, name);
    mkdirSync(dir);
    untar(tarGz(pkg.files, pkg.root), dir);
    return join(dir, pkg.root);
  };
  const run = (pkg: string, args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync('sh', [join(pkg, 'install.sh'), ...args], { env: { ...env, ...extra }, encoding: 'utf8' });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'bogen-komodo-'));
    home = join(root, 'home');
    const bin = join(root, 'bin');
    log = join(root, 'theme-set.log');
    mkdirSync(join(home, '.local', 'state', 'omarchy', 'current'), { recursive: true });
    writeFileSync(current(), 'tokyo-night\n');
    mkdirSync(join(root, 'omamobile'));
    mkdirSync(bin);
    // The phone's own command, as a stand-in: it records the call and switches theme.name, as the real one does last.
    writeFileSync(join(bin, 'omarchy-theme-set'), `#!/bin/sh\necho "$1" >> "${log}"\nprintf '%s\\n' "$1" > "$HOME/.local/state/omarchy/current/theme.name"\n`);
    chmodSync(join(bin, 'omarchy-theme-set'), 0o755);
    env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, OMAMOBILE_PATH: join(root, 'omamobile'), BOGEN_THEME_DEVICE: 'Google Pixel 9 Pro XL (komodo)' };
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('ships an executable installer, the manifest with honest coverage, and checksums', () => {
    const pkg = unpack(fixtureTheme('#e8a85c'), 'a');
    expect(readdirSync(pkg).sort()).toEqual(['README.md', 'bogen-theme.json', 'checksums.sha256', 'install.sh', 'theme']);
    const manifest = JSON.parse(readFileSync(join(pkg, 'bogen-theme.json'), 'utf8'));
    expect(manifest).toMatchObject({ target: 'mobile', profile: { id: 'komodo', logical: '420x935', panel: '1344x2992', scale: 3.2 }, adapter: { id: 'omamobile', version: 1 } });
    expect(manifest.coverage.filter((c: any) => c.status === 'not-themable').map((c: any) => c.surface)).toEqual(MOBILE_COVERAGE.filter((c) => c.status === 'not-themable').map((c) => c.surface));
    expect(readFileSync(join(pkg, 'README.md'), 'utf8')).toMatch(/not an Android launcher theme/);
    expect(execFileSync('sha256sum', ['-c', '--quiet', 'checksums.sha256'], { cwd: pkg, encoding: 'utf8' })).toBe('');
    expect(spawnSync('test', ['-x', join(pkg, 'install.sh')]).status).toBe(0);
  });

  it('refuses a computer, another phone and a changed package', () => {
    const pkg = unpack(fixtureTheme('#e8a85c'), 'b');
    const desk = run(pkg, ['--dry-run'], { OMAMOBILE_PATH: join(root, 'missing') });
    expect(desk.status).toBe(4);
    expect(desk.stderr).toMatch(/not Omarchy Mobile/);
    const other = run(pkg, ['--dry-run'], { BOGEN_THEME_DEVICE: 'Google Pixel 7 Pro (cheetah)' });
    expect(other.status).toBe(4);
    expect(other.stderr).toMatch(/made for komodo/);
    writeFileSync(join(pkg, 'theme', 'dusk', 'colors.toml'), 'accent = "#000000"\n');
    const changed = run(pkg, ['--dry-run']);
    expect(changed.status).toBe(3);
    expect(changed.stderr).toMatch(/do not match checksums/);
    expect(existsSync(join(themes(), 'dusk'))).toBe(false);
  });

  it('dry-runs, installs, keeps a file the person edited on update, applies and rolls back', () => {
    const v1 = unpack(fixtureTheme('#e8a85c'), 'v1');
    const dry = run(v1, ['--dry-run']);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/new colors\.toml/);
    expect(dry.stdout).toMatch(/Dry run: nothing was written/);
    expect(existsSync(themes())).toBe(false);

    const first = run(v1, []);
    expect(first.status, first.stderr).toBe(0);
    expect(readFileSync(join(themes(), 'dusk', 'colors.toml'), 'utf8')).toContain('accent = "#e8a85c"');
    expect(readFileSync(current(), 'utf8').trim()).toBe('tokyo-night');
    expect(existsSync(log)).toBe(false);

    // The person edits shell.toml on the phone. An update replaces what they left alone and keeps their file.
    const edited = '[lock]\ntext = "#ffffff"\n';
    writeFileSync(join(themes(), 'dusk', 'shell.toml'), edited);
    const v2 = unpack(fixtureTheme('#d8ff3d'), 'v2');
    const update = run(v2, ['--apply']);
    expect(update.status, update.stderr).toBe(0);
    expect(update.stdout).toMatch(/keep {4}shell\.toml/);
    expect(update.stdout).toMatch(/update colors\.toml/);
    expect(readFileSync(join(themes(), 'dusk', 'colors.toml'), 'utf8')).toContain('accent = "#d8ff3d"');
    expect(readFileSync(join(themes(), 'dusk', 'shell.toml'), 'utf8')).toBe(edited);
    expect(readFileSync(log, 'utf8')).toBe('dusk\n');
    expect(readFileSync(current(), 'utf8').trim()).toBe('dusk');
    expect(readdirSync(themes()).filter((f) => f.startsWith('.'))).toEqual([]);

    // Rollback restores the folder as it was before the update, and the theme in use before.
    const back = run(v2, ['--rollback']);
    expect(back.status, back.stderr).toBe(0);
    expect(readFileSync(join(themes(), 'dusk', 'colors.toml'), 'utf8')).toContain('accent = "#e8a85c"');
    expect(readFileSync(join(themes(), 'dusk', 'shell.toml'), 'utf8')).toBe(edited);
    expect(readFileSync(current(), 'utf8').trim()).toBe('tokyo-night');
    // And once more: back to before the first install, when there was no such theme.
    const gone = run(v2, ['--rollback']);
    expect(gone.status, gone.stderr).toBe(0);
    expect(existsSync(join(themes(), 'dusk'))).toBe(false);
    expect(run(v2, ['--rollback']).status).toBe(7);
  });

  it('writes nowhere outside the theme folder and its own state', () => {
    const pkg = unpack(fixtureTheme('#e8a85c'), 'c');
    const before = new Set(execFileSync('find', [home], { encoding: 'utf8' }).split('\n'));
    expect(run(pkg, []).status).toBe(0);
    const added = execFileSync('find', [home], { encoding: 'utf8' }).split('\n').filter((p) => p && !before.has(p));
    for (const p of added) expect(p, p).toMatch(/\/\.config\/omarchy\/themes(\/dusk|$)|\/\.local\/state\/bogen-themes/);
  });
});

// ---------------------------------------------------------------- Omarchy 4.5 videos

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** A minimal ISO media file: mvhd with a duration, a video track of a size, and optionally a sound track. */
function mp4(seconds: number, width: number, height: number, sound: boolean): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(width * 65536, 76);
  tkhd.writeUInt32BE(height * 65536, 80);
  const hdlr = (kind: string) => { const b = Buffer.alloc(24); b.write(kind, 8, 'latin1'); return box('hdlr', b); };
  const tracks = [box('trak', box('tkhd', tkhd), box('mdia', hdlr('vide')))];
  if (sound) tracks.push(box('trak', box('tkhd', Buffer.alloc(84)), box('mdia', hdlr('soun'))));
  return Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov', box('mvhd', mvhd), ...tracks)]);
}

describe('Omarchy 4.5 intros and loop wallpapers', () => {
  let h: Harness;
  let root: string;
  let stock: string;
  const saved = { HOME: process.env.HOME, OMARCHY_PATH: process.env.OMARCHY_PATH, OMAMOBILE_PATH: process.env.OMAMOBILE_PATH };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'bogen-intros-'));
    stock = join(root, 'omarchy', 'themes', 'winding');
    mkdirSync(join(stock, 'backgrounds', 'intros'), { recursive: true });
    writeFileSync(join(stock, 'colors.toml'), 'mode = "dark"\naccent = "#7aa2f7"\nbackground = "#1a1b26"\nforeground = "#c0caf5"\n');
    // A still and its intro by the same name, an intro with no still, a loop wallpaper, and the theme's own shell.toml.
    writeFileSync(join(stock, 'backgrounds', '0-winding-road.webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X'), Buffer.alloc(8), Buffer.from([0x7f, 0x07, 0x00, 0x37, 0x04, 0x00]), Buffer.alloc(4)]));
    writeFileSync(join(stock, 'backgrounds', 'intros', '0-winding-road.mp4'), mp4(6, 1920, 1080, false));
    writeFileSync(join(stock, 'backgrounds', 'intros', 'lonely.mp4'), mp4(14, 1920, 1080, true));
    writeFileSync(join(stock, 'backgrounds', '9-rain.webm'), Buffer.from('webm bytes'));
    writeFileSync(join(stock, 'shell.toml'), '[lock]\nbackground = "#000000"\nbackground-alpha = 0.6\nborder = "hyprland.active-border"\n[font]\nbase-size = 14\n');
    process.env.HOME = join(root, 'home');
    process.env.OMARCHY_PATH = join(root, 'omarchy');
    process.env.OMAMOBILE_PATH = join(root, 'no-phone');
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

  it('reads an mp4\'s duration, size and sound track, and judges it against Omarchy\'s advice', () => {
    expect(probeVideo(mp4(6, 1920, 1080, false), 'mp4')).toEqual({ bytes: expect.any(Number), durationS: 6, width: 1920, height: 1080, hasAudio: false });
    const long = { kind: 'intro' as const, name: 'long.mp4', facts: probeVideo(mp4(14, 1280, 1024, true), 'mp4') };
    const advice = videoAdvice(long, { width: 1920, height: 1080 }).join('\n');
    expect(advice).toMatch(/runs 14 s/);
    expect(advice).toMatch(/sound track/);
    expect(advice).toMatch(/hand-over .* will jump/);
    expect(probeVideo(Buffer.from('not iso'), 'webm')).toEqual({ bytes: 7 });
  });

  it('carries a theme\'s intro with its still, its loop wallpaper and its shell.toml into the file and back out', async () => {
    const res = await fetch(`${h.base}/api/omarchy/themes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'winding', name: 'Winding Remix' }) });
    const made = await res.json() as any;
    expect(res.status).toBe(201);
    const room = await h.server.rooms.get(made.file_id);
    const meta = themeMeta(room.doc)!;
    expect(meta.videos!.map((v) => [v.kind, v.name, Boolean(v.board)])).toEqual([['intro', '0-winding-road.mp4', true], ['intro', 'lonely.mp4', false], ['loop', '9-rain.webm', false]]);
    const tokens = new Map(room.doc.getTokens().map((t) => [t.name, t.value]));
    expect(tokens.get('omarchy-shell-lock-background')).toBe('color-mix(in srgb, #000000 60%, transparent)');
    expect(tokens.get('omarchy-shell-font-base-size')).toBe('14px');
    const info = await (await fetch(`${h.base}/api/omarchy/theme/${made.file_id}`)).json() as any;
    expect(info.theme.videos.find((v: any) => v.name === 'lonely.mp4').advice.join(' ')).toMatch(/no still to end on/);
    expect(info.theme.videos.find((v: any) => v.name === '0-winding-road.mp4')).toMatchObject({ durationS: 6, hasAudio: false, advice: [] });

    // Without the rendered previews, so no browser is needed: the stills and videos go out as they came.
    for (const page of room.doc.getPages()) {
      const drop = room.doc.getChildren(page.id).filter((n) => /^Preview · |^Unlock logo/.test(n.name)).map((n) => n.id);
      room.doc.delete(drop);
    }
    const { exportTheme, themeEnv } = await import('../src/omarchy-themes.ts');
    const theme = await exportTheme(h.server, themeEnv(h.server), made.file_id);
    const paths = theme.files.map((f) => f.path);
    expect(paths).toContain('backgrounds/0-winding-road.webp');
    expect(paths).toContain('backgrounds/intros/0-winding-road.mp4');
    expect(paths).toContain('backgrounds/9-rain.webm');
    expect(paths.filter((p) => p.includes('lonely'))).toEqual([]);
    expect(theme.problems.join('\n')).toMatch(/intro lonely\.mp4 has no Background board/);
    expect(Buffer.from(theme.files.find((f) => f.path === 'backgrounds/intros/0-winding-road.mp4')!.bytes).equals(mp4(6, 1920, 1080, false))).toBe(true);
    // The manifest's checksums cover the videos, so a package and a Git theme carry the same bytes.
    expect(theme.manifest.files.map((f) => f.path)).toContain('backgrounds/intros/0-winding-road.mp4');
    expect(parseShellToml(new TextDecoder().decode(theme.files.find((f) => f.path === 'shell.toml')!.bytes))['lock.background-alpha']).toBe('0.6');
  }, 60_000);
});

describe('a mobile theme made by an agent', () => {
  let h: Harness;
  const saved = { HOME: process.env.HOME, OMAMOBILE_PATH: process.env.OMAMOBILE_PATH };
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'bogen-mobile-agent-'));
    process.env.HOME = join(root, 'home');
    process.env.OMAMOBILE_PATH = join(root, 'not-a-phone');
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

  it('is laid out at 420 x 935 with its shell roles, and is refused by this desktop\'s install', async () => {
    const agent = await connectAgent(h.base, 'claude');
    const out = await call(agent, 'omarchy_theme_create', { name: 'Pocket Dusk', target: 'mobile' });
    expect(out).toMatchObject({ slug: 'pocket-dusk', target: 'mobile', profile: 'komodo' });
    expect(out.boards.filter((b: any) => b.name.startsWith('Phone · ')).every((b: any) => b.width === 420 && b.height === 935)).toBe(true);
    const room = await h.server.rooms.get(out.file_id);
    expect(room.doc.getTokens().filter((t) => t.name.startsWith('omarchy-shell-')).length).toBe(SHELL_ROLES.length + 1);
    const refused = await callRaw(agent, 'omarchy_theme_install', { file_id: out.file_id });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/mobile theme, and this machine is a desktop/);
    const info = await (await fetch(`${h.base}/api/omarchy/theme/${out.file_id}`)).json() as any;
    expect(info.theme).toMatchObject({ target: 'mobile', host: 'desktop', profile: { id: 'komodo', logical: '420 × 935' } });
    expect(info.theme.coverage.length).toBe(MOBILE_COVERAGE.length);
    await agent.close();
  }, 60_000);
});
