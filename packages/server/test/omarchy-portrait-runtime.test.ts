// The portrait background on a real Omarchy desktop, offline: the plugin's own selection logic (PortraitRuntime.js,
// loaded exactly as the shell loads it), deriving Background.qml from the stock file, and installing, enabling,
// disabling, rolling back and removing the plugin in a made-up home with stand-ins for `omarchy` and `omarchy-shell`.
// Nothing here runs a real Omarchy command or touches the real home.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyComposition, fillsComposition, parseMonitors, type CompositionLayer } from '../src/omarchy-displays.ts';
import { loadTheme } from '../src/omarchy-themes.ts';
import {
  disablePlugin, enablePlugin, installPlugin, loadRuntime, patchBackground, pluginSourceDir, pluginSourceDirFrom, pluginStatus, PLUGIN_ID, readThemeRuntime, removePlugin, rollbackPlugin,
  RUNTIME_FILE, runtimeManifest, screensFor, type PortraitEnv,
} from '../src/omarchy-portrait-runtime.ts';
import { auditFolders, undoUpgrade, upgradeThemeRuntime } from '../src/omarchy-theme-audit.ts';
import { LEGACY_PORTRAIT_LAYERS, portraitWallpaper, wallpaper } from '../src/templates/omarchy-theme.ts';

const lib = loadRuntime();
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** A PNG header of any size: the plugin measures only the header. */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b, 0);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}

function webpHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBPVP8X', 8, 'latin1');
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

const DESK = JSON.stringify([
  { name: 'DP-3', width: 3840, height: 2160, transform: 0, scale: 1 },
  { name: 'DP-5', width: 3840, height: 2160, transform: 3, scale: 1 },
]);

const art = (over: Record<string, unknown> = {}) => ({ aspect: '9:16', orientation: 'portrait', width: 2160, height: 3840, file: 'displays/background-portrait-9x16.png', sha256: 'a'.repeat(64), bytes: 1234, status: 'artwork', ...over });
const manifest = (wallpapers: unknown[], extra: Record<string, unknown> = {}) => ({ kind: 'bogen-portrait-runtime', format: 1, theme: 'desk', appliesTo: 'theme-backgrounds', wallpapers, incomplete: [], ...extra });
const map = (entries: { aspect: string; width: number; height: number; path: string }[]) => ({ entries });

describe('the plugin\'s selection logic', () => {
  it('measures PNG, JPEG and WebP from their headers, and nothing else', () => {
    expect(lib.imageHeader(pngHeader(2160, 3840))).toEqual({ format: 'png', width: 2160, height: 3840 });
    expect(lib.imageHeader(jpegHeader(1080, 1920))).toEqual({ format: 'jpeg', width: 1080, height: 1920 });
    expect(lib.imageHeader(webpHeader(1440, 2560))).toEqual({ format: 'webp', width: 1440, height: 2560 });
    expect(lib.imageHeader(Buffer.from('GIF89a' + '\0'.repeat(30), 'latin1'))).toBeNull();
    expect(lib.imageHeader(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'))).toBeNull();
    expect(lib.imageHeader(pngHeader(0, 3840))).toBeNull();
    expect(lib.imageHeader(pngHeader(99999, 10))).toBeNull();
    expect(lib.imageHeader(pngHeader(10, 10).subarray(0, 20))).toBeNull();
  });

  it('decodes base64 as the shell hands it over, and refuses anything else', () => {
    const bytes = pngHeader(2160, 3840);
    expect(Buffer.from(lib.decodeBase64(bytes.toString('base64'))!)).toEqual(bytes);
    expect(lib.decodeBase64('not base64!')).toBeNull();
    expect(lib.decodeBase64(Buffer.alloc(1000).toString('base64'), 10)!.length).toBe(10);
  });

  it('takes only designed compositions from a manifest; a placeholder is listed as incomplete, never shown', () => {
    const check = lib.validateManifest(manifest([art(), art({ aspect: '10:16', width: 1200, height: 1920, status: 'needs-design', file: 'displays/x.png' })]));
    expect(check.entries.map((e) => e.aspect)).toEqual(['9:16']);
    expect(check.incomplete).toEqual([expect.objectContaining({ aspect: '10:16', status: 'needs-design' })]);
    const only = lib.validateManifest(manifest([], { incomplete: [{ aspect: '9:16', status: 'needs-design', reason: 'Bogen\'s placeholder' }] }));
    expect(only.ok).toBe(false);
    expect(only.entries).toEqual([]);
    for (const status of ['needs-design', 'mismatch', 'unverified', 'missing', 'placeholder', '']) expect(lib.validateManifest(manifest([art({ status })])).entries).toEqual([]);
  });

  it('refuses a manifest entry that could reach outside displays/, lies about its shape, or is landscape', () => {
    const bad = [
      art({ file: '../../.ssh/id_ed25519.png' }), art({ file: 'displays/../colors.png' }), art({ file: '/etc/passwd.png' }), art({ file: 'backgrounds/1.png' }),
      art({ file: 'displays/x.svg' }), art({ file: 'displays/x.gif' }), art({ sha256: 'z'.repeat(64) }), art({ bytes: 100 * 1024 * 1024 }),
      art({ width: 3840, height: 2160 }), art({ aspect: '16:9', width: 3840, height: 2160 }), art({ orientation: 'landscape' }), art({ width: 2000 }),
    ];
    for (const entry of bad) expect(lib.validateManifest(manifest([entry])).entries, JSON.stringify(entry)).toEqual([]);
    expect(lib.validateManifest({ ...manifest([art()]), kind: 'other' }).ok).toBe(false);
    expect(lib.validateManifest({ ...manifest([art()]), format: 2 }).ok).toBe(false);
    expect(lib.validateManifest(manifest(Array.from({ length: 9 }, (_, i) => art({ aspect: `9:${16 + i}` })))).problems[0]).toMatch(/only the first 6/);
    expect(lib.parseManifestText('x'.repeat(70_000)).ok).toBe(false);
    expect(lib.parseManifestText('{').ok).toBe(false);
  });

  it('gives a portrait screen its composition, whatever its rotation, mirroring or scale, and never a landscape one', () => {
    const m = map([{ aspect: '9:16', width: 2160, height: 3840, path: '/c/a.png' }]);
    const rows = parseMonitors(JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7].flatMap((transform) => [1, 1.5, 2].map((scale) => ({ name: `T${transform}S${scale}`, width: 3840, height: 2160, transform, scale })))));
    for (const r of rows) {
      const got = lib.entryFor(m, r.logical.width, r.logical.height);
      expect(Boolean(got), r.name).toBe(r.orientation === 'portrait');
    }
    const [dp3, dp5] = parseMonitors(DESK);
    expect(lib.screenPath('/t/backgrounds/1.png', m, dp3!.logical.width, dp3!.logical.height)).toBe('/t/backgrounds/1.png');
    expect(lib.screenPath('/t/backgrounds/1.png', m, dp5!.logical.width, dp5!.logical.height)).toBe('/c/a.png');
  });

  it('does not crop: a screen of another portrait shape keeps the global background', () => {
    const m = map([{ aspect: '9:16', width: 2160, height: 3840, path: '/c/a.png' }]);
    expect(lib.entryFor(m, 1200, 1920)).toBeNull();
    expect(lib.entryFor(m, 1080, 1080)).toBeNull();
    const both = map([...m.entries, { aspect: '10:16', width: 1200, height: 1920, path: '/c/b.png' }, { aspect: '1:1', width: 2000, height: 2000, path: '/c/s.png' }]);
    expect(lib.entryFor(both, 1200, 1920)!.path).toBe('/c/b.png');
    expect(lib.entryFor(both, 1080, 1080)!.path).toBe('/c/s.png');
    // The largest of the same shape wins.
    const two = map([{ aspect: '9:16', width: 1080, height: 1920, path: '/c/small.png' }, { aspect: '9:16', width: 2160, height: 3840, path: '/c/big.png' }]);
    expect(lib.entryFor(two, 1080, 1920)!.path).toBe('/c/big.png');
  });

  it('falls back to the global background for a video, a failed picture or no map, so a screen is never blank', () => {
    const m = map([{ aspect: '9:16', width: 2160, height: 3840, path: '/c/a.png' }]);
    expect(lib.screenPath('/t/backgrounds/loop.mp4', m, 2160, 3840)).toBe('/t/backgrounds/loop.mp4');
    expect(lib.screenPath('/t/backgrounds/1.png', m, 2160, 3840, { '/c/a.png': true })).toBe('/t/backgrounds/1.png');
    expect(lib.screenPath('/t/backgrounds/1.png', null, 2160, 3840)).toBe('/t/backgrounds/1.png');
    expect(lib.screenPath('', m, 2160, 3840)).toBe('');
    expect(lib.screenPath('/t/backgrounds/1.png', m, 0, 0)).toBe('/t/backgrounds/1.png');
  });

  it('maps only the theme\'s own stills: not a picture the person chose elsewhere, not a snapshot, not a path that escapes', () => {
    const dirs = ['/h/.local/state/omarchy/current/theme', '/real/theme'];
    expect(lib.isThemeStill('/h/.local/state/omarchy/current/theme/backgrounds/1-ink.png', dirs)).toBe(true);
    expect(lib.isThemeStill('/real/theme/backgrounds/2.webp', dirs)).toBe(true);
    for (const p of ['/h/.config/omarchy/backgrounds/desk/mine.jpg', '/h/.cache/omarchy/background-transitions/next-12.png', '/h/.local/state/omarchy/current/theme/backgrounds/../../x.png', '/h/.local/state/omarchy/current/theme/backgrounds/sub/1.png', '/h/.local/state/omarchy/current/theme/backgrounds/loop.webm', 'relative/backgrounds/1.png', '']) {
      expect(lib.isThemeStill(p, dirs), p).toBe(false);
    }
  });

  it('checks a copied picture against the manifest: bytes, size, format and header', () => {
    const entry = lib.validateManifest(manifest([art()])).entries[0]!;
    const ok = { path: '/c/aaaa.png', bytes: '1234', header: pngHeader(2160, 3840).toString('base64') };
    expect(lib.verifyAsset(entry, ok)).toMatchObject({ ok: true, entry: { path: '/c/aaaa.png', width: 2160, height: 3840 } });
    expect(lib.verifyAsset(entry, { status: 'sha' }).reason).toMatch(/changed after the theme was exported/);
    expect(lib.verifyAsset(entry, { status: 'link' }).reason).toMatch(/link/);
    expect(lib.verifyAsset(entry, { ...ok, bytes: '99' }).reason).toMatch(/99 bytes/);
    expect(lib.verifyAsset(entry, { ...ok, header: pngHeader(3840, 2160).toString('base64') }).reason).toMatch(/3840 × 2160/);
    expect(lib.verifyAsset(entry, { ...ok, header: jpegHeader(2160, 3840).toString('base64') }).reason).toMatch(/jpeg named .png/);
    expect(lib.verifyAsset(entry, { ...ok, path: 'relative.png' }).ok).toBe(false);
  });
});

describe('deriving Background.qml from the stock file', () => {
  const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'background-stock-anchors.qml'), 'utf8');

  it('patches every anchor once, marks each change and records the stock file it came from', () => {
    const out = patchBackground(fixture);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.source).toMatch(/sha256 [0-9a-f]{64}/);
    for (const line of [
      'PortraitMapping { id: portraitMapping; host: root }', 'portrait.beginTransition(fromPath, path, finalPath)', 'root.portrait.nativeSize(path)',
      'if (root.portrait.holding) return', 'path: panel.screenPath(root.displayedBackground, root.portraitDisplayedMap)', 'decodeSize: panel.decodeSize(path)',
      'root.portrait.markFailed(path); else root.recoverBackground(path)', 'panel.screenPath(root.oldBackground, root.portraitOldMap)',
      'panel.screenPath(root.incomingBackground, root.portraitIncomingMap) : root.preparedBackground', 'function onHoldingChanged()', 'function portraitStatus(): string',
    ]) expect(out.source, line).toContain(line);
    // The stock behaviour around the changes stays: clicks, the IPC target, recovery of the global background.
    expect(out.source).toContain('target: "background"');
    expect(out.source).toContain('MouseArea {');
    expect(patchBackground(out.source)).toMatchObject({ ok: false, reason: expect.stringMatching(/already patched/) });
  });

  it('derives nothing from a stock file that changed where the patch goes', () => {
    const changed = fixture.replace('        path: root.displayedBackground\n', '        path: root.shownBackground\n');
    expect(patchBackground(changed)).toMatchObject({ ok: false, missing: ['displayed frame'] });
    expect(patchBackground(fixture + fixture.slice(fixture.indexOf('  property real revealProgress')))).toMatchObject({ ok: false });
    expect(patchBackground('Item {}')).toMatchObject({ ok: false, reason: expect.stringMatching(/not Omarchy's background plugin/) });
  });

  it.runIf(existsSync('/usr/share/omarchy/shell/plugins/background/Background.qml'))('patches the Background.qml installed on this machine (read only)', () => {
    const out = patchBackground(readFileSync('/usr/share/omarchy/shell/plugins/background/Background.qml', 'utf8'));
    expect(out.ok ? 'ok' : out.reason).toBe('ok');
  });
});

// ---------------------------------------------------------------- a made-up home

let root = '';
let env: PortraitEnv;
let log = '';

function stub(name: string, body: string): string {
  const path = join(root, 'bin', name);
  writeFileSync(path, `#!/usr/bin/env node\nconst fs = require('fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + args.join(' ') + '\\n');\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function writeStock(text: string): void {
  mkdirSync(join(root, 'omarchy', 'shell', 'plugins', 'background'), { recursive: true });
  writeFileSync(join(root, 'omarchy', 'shell', 'plugins', 'background', 'Background.qml'), text);
  writeFileSync(join(root, 'omarchy', 'shell', 'plugins', 'background', 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'omarchy.background', name: 'Background', version: '1.0.0', kinds: ['service'], entryPoints: { service: 'Background.qml' } }));
}

const shellJsonPath = () => join(root, 'home', '.config', 'omarchy', 'shell.json');
const shellJson = () => JSON.parse(readFileSync(shellJsonPath(), 'utf8'));
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bogen-portrait-'));
  log = join(root, 'calls.log');
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'home', '.config', 'omarchy', 'plugins'), { recursive: true });
  // Other people's plugins, which must stay as they are.
  mkdirSync(join(root, 'home', '.config', 'omarchy', 'plugins', 'custom.weather'));
  writeFileSync(join(root, 'home', '.config', 'omarchy', 'plugins', 'custom.weather', 'manifest.json'), JSON.stringify({ id: 'custom.weather', omarchy: { clonedFrom: 'omarchy.weather' } }));
  writeFileSync(shellJsonPath(), JSON.stringify({ plugins: [{ id: 'custom.weather' }], disabledPlugins: ['omarchy.weather'] }, null, 2));
  writeStock(readFileSync(join(import.meta.dirname, 'fixtures', 'background-stock-anchors.qml'), 'utf8'));
  // The stand-ins do what Omarchy's registry does to shell.json, in the made-up home only.
  const shell = shellJsonPath();
  const omarchy = stub('omarchy', `
const p = ${JSON.stringify(shell)};
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
const [group, verb, id] = args;
if (group !== 'plugin') process.exit(2);
c.plugins = c.plugins || []; c.disabledPlugins = c.disabledPlugins || [];
if (verb === 'enable') { if (!c.plugins.some((x) => x.id === id)) c.plugins.push({ id }); if (!c.disabledPlugins.includes('omarchy.background')) { c.disabledPlugins.push('omarchy.background'); c.cloneSourceRestores = [...(c.cloneSourceRestores || []), id]; } }
if (verb === 'disable') { c.plugins = c.plugins.filter((x) => x.id !== id); if ((c.cloneSourceRestores || []).includes(id)) { c.disabledPlugins = c.disabledPlugins.filter((x) => x !== 'omarchy.background'); c.cloneSourceRestores = c.cloneSourceRestores.filter((x) => x !== id); } }
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log(verb === 'enable' ? 'Enabled ' + id : 'Disabled ' + id);`);
  const shellBin = stub('omarchy-shell', 'console.log("ok");');
  env = { home: join(root, 'home'), omarchyPath: join(root, 'omarchy'), omarchyBin: omarchy, shellBin, sourceDir: pluginSourceDir() };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('where this build keeps the plugin\'s files', () => {
  const PLUGIN = 'integrations/omarchy/portrait-background';
  /** Only the given folders hold PortraitRuntime.js. Nothing on disk is read. */
  const only = (...dirs: string[]) => (path: string) => dirs.some((d) => path === `${d}/PortraitRuntime.js`);

  it('finds them in a source checkout, a package or Linux deploy, and a flat deploy such as the macOS one', () => {
    // packages/server/src/omarchy-portrait-runtime.ts in a checkout: the top of the repository.
    expect(pluginSourceDirFrom('file:///repo/packages/server/src/omarchy-portrait-runtime.ts', only(`/repo/${PLUGIN}`))).toBe(`/repo/${PLUGIN}`);
    // dist/cli.js in a package or ~/.local/share/bogen: next to dist/.
    expect(pluginSourceDirFrom('file:///opt/bogen/dist/cli.js', only(`/opt/bogen/${PLUGIN}`))).toBe(`/opt/bogen/${PLUGIN}`);
    // cli.js at the top of the app folder, as a flat deploy stages it: next to cli.js.
    expect(pluginSourceDirFrom('file:///Users/m/.local/share/bogen-app/cli.js', only(`/Users/m/.local/share/bogen-app/${PLUGIN}`))).toBe(`/Users/m/.local/share/bogen-app/${PLUGIN}`);
  });

  it('prefers the files nearest the module, and falls back to the checkout\'s place when none are there', () => {
    expect(pluginSourceDirFrom('file:///a/b/app/cli.js', only(`/a/b/app/${PLUGIN}`, `/a/b/${PLUGIN}`, `/${PLUGIN}`))).toBe(`/a/b/app/${PLUGIN}`);
    expect(pluginSourceDirFrom('file:///a/b/app/cli.js', only())).toBe(`/${PLUGIN}`);
    expect(pluginSourceDirFrom('file:///repo/packages/server/src/x.ts', only())).toBe(`/repo/${PLUGIN}`);
  });

  it('in this checkout, is the repository\'s own folder', () => {
    expect(pluginSourceDir()).toBe(join(import.meta.dirname, '..', '..', '..', PLUGIN));
    expect(existsSync(join(pluginSourceDir(), 'PortraitRuntime.js'))).toBe(true);
  });
});

describe('installing the plugin', () => {
  it('plans first and changes nothing without --apply', async () => {
    const plan = await installPlugin(env);
    expect(plan).toMatchObject({ possible: true, applied: false });
    expect(existsSync(join(env.home, '.config', 'omarchy', 'plugins', PLUGIN_ID))).toBe(false);
    expect(calls()).toEqual([]);
    expect(pluginStatus(env).state).toBe('not-installed');
  });

  it('installs a clone of omarchy.background next to the person\'s plugins, enables it with omarchy\'s own commands and disables it again', async () => {
    const done = await installPlugin(env, { apply: true });
    expect(done.applied).toBe(true);
    const dir = join(env.home, '.config', 'omarchy', 'plugins', PLUGIN_ID);
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(m).toMatchObject({ schemaVersion: 1, id: PLUGIN_ID, kinds: ['service'], entryPoints: { service: 'Background.qml' }, omarchy: { clonedFrom: 'omarchy.background' }, bogen: { plugin: 'portrait-background' } });
    expect(readFileSync(join(dir, 'PortraitRuntime.js'), 'utf8')).toBe(readFileSync(join(pluginSourceDir(), 'PortraitRuntime.js'), 'utf8'));
    expect(readFileSync(join(dir, 'Background.qml'), 'utf8')).toContain('PortraitMapping { id: portraitMapping; host: root }');
    // Nothing was enabled by installing, and the stock plugin was only read.
    expect(calls()).toEqual([]);
    expect(pluginStatus(env)).toMatchObject({ state: 'installed', enabled: false });

    const plan = await enablePlugin(env);
    expect(plan.commands).toEqual([[env.shellBin, 'shell', 'rescanPlugins'], [env.omarchyBin, 'plugin', 'enable', PLUGIN_ID]]);
    expect(calls()).toEqual([]);
    await enablePlugin(env, { apply: true });
    expect(calls()).toEqual(['omarchy-shell shell rescanPlugins', `omarchy plugin enable ${PLUGIN_ID}`]);
    expect(shellJson().plugins.map((p: any) => p.id)).toEqual(['custom.weather', PLUGIN_ID]);
    expect(shellJson().disabledPlugins).toEqual(['omarchy.weather', 'omarchy.background']);
    expect(pluginStatus(env)).toMatchObject({ state: 'enabled', enabled: true, stockDisabled: true });

    await disablePlugin(env, { apply: true });
    expect(shellJson()).toMatchObject({ plugins: [{ id: 'custom.weather' }], disabledPlugins: ['omarchy.weather'] });
    expect(readFileSync(join(env.home, '.config', 'omarchy', 'plugins', 'custom.weather', 'manifest.json'), 'utf8')).toContain('omarchy.weather');
  });

  it('never writes over a folder of that name that is not Bogen\'s, or through a link', async () => {
    const dir = join(env.home, '.config', 'omarchy', 'plugins', PLUGIN_ID);
    mkdirSync(dir);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: PLUGIN_ID, name: 'Mine' }));
    expect(await installPlugin(env, { apply: true, force: true })).toMatchObject({ applied: false, blockers: [expect.stringMatching(/not Bogen's/)] });
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).name).toBe('Mine');
    rmSync(dir, { recursive: true });
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), dir);
    expect(await installPlugin(env, { apply: true, force: true })).toMatchObject({ applied: false, blockers: [expect.stringMatching(/not Bogen's/)] });
    expect(existsSync(join(root, 'elsewhere', 'manifest.json'))).toBe(false);
  });

  it('does not enable beside another background clone, or over a stock background the person turned off', async () => {
    await installPlugin(env, { apply: true });
    const theirs = join(env.home, '.config', 'omarchy', 'plugins', 'custom.background');
    mkdirSync(theirs);
    writeFileSync(join(theirs, 'manifest.json'), JSON.stringify({ id: 'custom.background', omarchy: { clonedFrom: 'omarchy.background' } }));
    const r = await enablePlugin(env, { apply: true });
    expect(r).toMatchObject({ applied: false, blockers: [expect.stringMatching(/custom\.background/)] });
    expect(calls()).toEqual([]);
    rmSync(theirs, { recursive: true });
    writeFileSync(shellJsonPath(), JSON.stringify({ plugins: [], disabledPlugins: ['omarchy.background'] }));
    expect(await enablePlugin(env, { apply: true })).toMatchObject({ applied: false, blockers: [expect.stringMatching(/omarchy\.background is disabled/)] });
  });

  it('refuses to derive from a stock file it does not know, and says the installed copy is outdated after an Omarchy update', async () => {
    writeStock('Item { ShellIpc { target: "background" } }');
    expect(await installPlugin(env, { apply: true })).toMatchObject({ applied: false, blockers: [expect.stringMatching(/changed where the patch goes/)] });
    expect(pluginStatus(env).stock.compatible).toBe(false);

    writeStock(readFileSync(join(import.meta.dirname, 'fixtures', 'background-stock-anchors.qml'), 'utf8'));
    await installPlugin(env, { apply: true });
    expect(pluginStatus(env).installed!.outdated).toBe(false);
    expect((await installPlugin(env, { apply: true })).steps[0]!.do).toMatch(/Nothing to do/);
    writeStock(readFileSync(join(import.meta.dirname, 'fixtures', 'background-stock-anchors.qml'), 'utf8').replace('Item {', 'Item { // updated'));
    expect(pluginStatus(env).installed!.outdated).toBe(true);
    const again = await installPlugin(env, { apply: true });
    expect(again.applied).toBe(true);
    expect(again.backup).toBeTruthy();
    expect(pluginStatus(env).installed!.outdated).toBe(false);
  });

  it('keeps the person\'s edits unless forced, backs up every replaced version, and rolls back to it', async () => {
    await installPlugin(env, { apply: true });
    const qml = join(env.home, '.config', 'omarchy', 'plugins', PLUGIN_ID, 'Background.qml');
    writeFileSync(qml, `${readFileSync(qml, 'utf8')}\n// mine\n`);
    expect(pluginStatus(env).installed!.modified).toEqual(['Background.qml']);
    expect(await installPlugin(env, { apply: true })).toMatchObject({ applied: false, blockers: [expect.stringMatching(/You edited Background\.qml/)] });
    const forced = await installPlugin(env, { apply: true, force: true });
    expect(forced.applied).toBe(true);
    expect(readFileSync(join(forced.backup!, 'Background.qml'), 'utf8')).toContain('// mine');
    expect(readFileSync(qml, 'utf8')).not.toContain('// mine');
    const back = await rollbackPlugin(env, { apply: true });
    expect(back.applied).toBe(true);
    expect(readFileSync(qml, 'utf8')).toContain('// mine');
    // The rollback is itself backed up.
    expect(readFileSync(join(back.backup!, 'Background.qml'), 'utf8')).not.toContain('// mine');
  });

  it('removes its files only when disabled, so the desktop always has a background', async () => {
    await installPlugin(env, { apply: true });
    await enablePlugin(env, { apply: true });
    expect(await removePlugin(env, { apply: true })).toMatchObject({ applied: false, blockers: [expect.stringMatching(/Disable it first/)] });
    expect(existsSync(join(env.home, '.config', 'omarchy', 'plugins', PLUGIN_ID))).toBe(true);
    await disablePlugin(env, { apply: true });
    const gone = await removePlugin(env, { apply: true });
    expect(gone.applied).toBe(true);
    expect(existsSync(join(env.home, '.config', 'omarchy', 'plugins', PLUGIN_ID))).toBe(false);
    expect(existsSync(join(gone.backup!, 'manifest.json'))).toBe(true);
    expect(shellJson().disabledPlugins).toEqual(['omarchy.weather']);
  });
});

// ---------------------------------------------------------------- what a theme carries

function themeWith(dir: string, files: Record<string, Uint8Array | string>): void {
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
}

describe('a theme\'s portrait runtime manifest', () => {
  const picture = Buffer.concat([pngHeader(2160, 3840), Buffer.alloc(500, 7)]);

  it('lists designed compositions with their measured size and sha256, and only names the rest as incomplete', () => {
    const rt = runtimeManifest('desk', [
      { aspect: '9:16', orientation: 'portrait', status: 'artwork', reason: '', file: 'displays/background-portrait-9x16.png', bytes: picture },
      { aspect: '10:16', orientation: 'portrait', status: 'needs-design', reason: 'This is Bogen\'s placeholder.' },
    ])!;
    const json = JSON.parse(rt.json);
    expect(json.wallpapers).toEqual([{ aspect: '9:16', orientation: 'portrait', width: 2160, height: 3840, file: 'displays/background-portrait-9x16.png', sha256: sha(picture), bytes: picture.length, status: 'artwork' }]);
    expect(json.incomplete).toEqual([{ aspect: '10:16', orientation: 'portrait', status: 'needs-design', reason: 'This is Bogen\'s placeholder.' }]);
    expect(rt).toMatchObject({ active: 1, incomplete: 1, problems: [] });
    // A composition whose picture the plugin cannot measure is not listed as ready.
    const odd = runtimeManifest('desk', [{ aspect: '9:16', orientation: 'portrait', status: 'composed', reason: '', file: 'displays/a.png', bytes: Buffer.from('GIF89a') }])!;
    expect(JSON.parse(odd.json).wallpapers).toEqual([]);
    expect(runtimeManifest('desk', [])).toBeNull();
  });

  it('reads a theme as the plugin does: stale, swapped, linked or missing pictures are refused', () => {
    const dir = join(root, 'theme');
    const rt = runtimeManifest('desk', [{ aspect: '9:16', orientation: 'portrait', status: 'artwork', reason: '', file: 'displays/background-portrait-9x16.png', bytes: picture }])!;
    themeWith(dir, { [RUNTIME_FILE]: rt.json, 'displays/background-portrait-9x16.png': picture });
    expect(readThemeRuntime(dir)).toMatchObject({ state: 'ready', entries: [{ verified: true }] });
    const [dp3, dp5] = parseMonitors(DESK);
    expect(screensFor(readThemeRuntime(dir), [dp3!, dp5!]).map((s) => [s.name, s.shows])).toEqual([['DP-3', 'the theme background'], ['DP-5', 'displays/background-portrait-9x16.png (9:16)']]);

    writeFileSync(join(dir, 'displays/background-portrait-9x16.png'), Buffer.concat([pngHeader(2160, 3840), Buffer.alloc(500, 8)]));
    expect(readThemeRuntime(dir)).toMatchObject({ state: 'invalid', entries: [{ verified: false, reason: expect.stringMatching(/changed after the export/) }] });
    rmSync(join(dir, 'displays/background-portrait-9x16.png'));
    writeFileSync(join(root, 'secret.png'), picture);
    symlinkSync(join(root, 'secret.png'), join(dir, 'displays/background-portrait-9x16.png'));
    expect(readThemeRuntime(dir).entries[0]).toMatchObject({ verified: false, reason: expect.stringMatching(/link/) });
    rmSync(join(dir, 'displays/background-portrait-9x16.png'));
    expect(readThemeRuntime(dir).entries[0]).toMatchObject({ verified: false, reason: expect.stringMatching(/not in the theme/) });
    expect(screensFor(readThemeRuntime(dir), [dp5!])[0]).toMatchObject({ shows: 'the theme background, cropped' });
  });

  it('never shows a placeholder: a theme with only an incomplete composition keeps the global background', () => {
    const dir = join(root, 'placeholder-theme');
    const rt = runtimeManifest('desk', [{ aspect: '9:16', orientation: 'portrait', status: 'needs-design', reason: 'Bogen\'s placeholder' }])!;
    // Even with a picture lying at the old export's path.
    themeWith(dir, { [RUNTIME_FILE]: rt.json, 'displays/background-portrait-9x16.png': picture });
    const st = readThemeRuntime(dir);
    expect(st).toMatchObject({ state: 'incomplete', entries: [] });
    const [, dp5] = parseMonitors(DESK);
    expect(screensFor(st, [dp5!])[0]).toMatchObject({ shows: 'the theme background, cropped', reason: expect.stringMatching(/needs-design/) });
  });

  it('refuses a runtime manifest that is a link', () => {
    const dir = join(root, 'linked');
    themeWith(dir, { 'displays/elsewhere.json': JSON.stringify(manifest([art()])) });
    symlinkSync(join(dir, 'displays/elsewhere.json'), join(dir, RUNTIME_FILE));
    expect(readThemeRuntime(dir)).toMatchObject({ state: 'invalid', problems: [expect.stringMatching(/is a link/)] });
  });
});

describe('the portrait placeholder', () => {
  it('is quiet: no palette arcs, no colours of its own, and it says it is not designed', () => {
    const html = portraitWallpaper('Wallpaper · portrait 9:16', '9:16');
    for (const name of LEGACY_PORTRAIT_LAYERS) expect(html).not.toContain(`data-name="${name}"`);
    expect(html).not.toMatch(/omarchy-(red|orange|yellow|green|cyan|blue|magenta)\b/);
    expect(html).toContain('Portrait composition not designed yet');
  });
});

describe('the audit of installed themes, and the one additive upgrade', () => {
  const picture = Buffer.concat([pngHeader(2160, 3840), Buffer.alloc(300, 1)]);
  const themeEnv = () => ({ home: env.home, omarchyPath: env.omarchyPath, bin: env.omarchyBin, stateFile: join(root, 'apply.json'), omamobilePath: join(root, 'none') });
  const bogenTheme = (slug: string, display: Record<string, unknown>, extra: Record<string, Uint8Array | string> = {}) => {
    const dir = join(env.home, '.config', 'omarchy', 'themes', slug);
    const files = { 'colors.toml': 'background = "#000000"\nforeground = "#ffffff"\naccent = "#c6ff00"\n', 'backgrounds/1-ink.png': Buffer.concat([pngHeader(3840, 2160), Buffer.alloc(10)]), ...extra };
    themeWith(dir, files);
    const list = Object.entries(files).map(([path, b]) => ({ path, sha256: sha(typeof b === 'string' ? Buffer.from(b) : b), bytes: b.length }));
    writeFileSync(join(dir, 'bogen-theme.json'), JSON.stringify({ format: 1, kind: 'omarchy-theme', name: slug, slug, target: 'desktop', files: list, displays: [display] }));
    return dir;
  };

  it('says what a portrait screen shows for every theme, and changes nothing', () => {
    bogenTheme('nenaj', { size: '2160x3840', orientation: 'portrait', wallpaper: 'needs-design', runtime: 'not-used-by-omarchy', background: 'displays/background-portrait-9x16.png' }, { 'displays/background-portrait-9x16.png': picture });
    bogenTheme('arcs', { size: '2160x3840', orientation: 'portrait', wallpaper: 'composed', runtime: 'not-used-by-omarchy', background: 'displays/background-portrait-9x16.png' }, { 'displays/background-portrait-9x16.png': picture });
    bogenTheme('drawn', { size: '2160x3840', orientation: 'portrait', wallpaper: 'artwork', runtime: 'not-used-by-omarchy', background: 'displays/background-portrait-9x16.png' }, { 'displays/background-portrait-9x16.png': picture });
    themeWith(join(env.home, '.config', 'omarchy', 'themes', 'plain'), { 'colors.toml': 'background = "#111111"\n', 'backgrounds/tall.png': pngHeader(1080, 1920) });
    const before = JSON.stringify(readdirTree(env.home));
    const audit = Object.fromEntries(auditFolders(themeEnv()).map((a) => [a.slug, a]));
    expect(JSON.stringify(readdirTree(env.home))).toBe(before);
    // A placeholder is never upgradable, whatever its old export put in displays/.
    expect(audit.nenaj).toMatchObject({ verdict: 'needs-design', upgradable: false });
    // An older "composed" may be the palette arcs: never trusted.
    expect(audit.arcs).toMatchObject({ verdict: 'unconfirmed', upgradable: false });
    expect(audit.drawn).toMatchObject({ verdict: 'artwork-unlisted', upgradable: true });
    expect(audit.plain).toMatchObject({ verdict: 'landscape-only', portraitInBackgrounds: ['tall.png'] });
  });

  it('adds only displays/portrait-runtime.json from verified artwork, with a checkpoint, and takes it back', async () => {
    const dir = bogenTheme('drawn', { size: '2160x3840', orientation: 'portrait', wallpaper: 'artwork', runtime: 'not-used-by-omarchy', background: 'displays/background-portrait-9x16.png' }, { 'displays/background-portrait-9x16.png': picture });
    const before = readdirTree(dir);
    const plan = await upgradeThemeRuntime(themeEnv(), 'drawn');
    expect(plan).toMatchObject({ possible: true, applied: false, lists: ['9:16 displays/background-portrait-9x16.png'] });
    expect(readdirTree(dir)).toEqual(before);
    const done = await upgradeThemeRuntime(themeEnv(), 'drawn', { apply: true });
    expect(done.applied).toBe(true);
    expect(readdirTree(dir)).toEqual([...before, RUNTIME_FILE].sort());
    expect(readThemeRuntime(dir)).toMatchObject({ state: 'ready' });
    expect(await upgradeThemeRuntime(themeEnv(), 'drawn', { apply: true })).toMatchObject({ applied: false, blockers: [expect.stringMatching(/already/)] });
    const undo = await undoUpgrade(themeEnv(), done.checkpoint!, { apply: true });
    expect(undo.removed).toEqual([join(dir, RUNTIME_FILE)]);
    expect(readdirTree(dir)).toEqual(before);
  });

  it('refuses a placeholder, an unconfirmed composition, a changed picture, a stock theme and a repository clone', async () => {
    bogenTheme('nenaj', { size: '2160x3840', orientation: 'portrait', wallpaper: 'needs-design', background: 'displays/background-portrait-9x16.png' }, { 'displays/background-portrait-9x16.png': picture });
    expect(await upgradeThemeRuntime(themeEnv(), 'nenaj', { apply: true })).toMatchObject({ applied: false, blockers: [expect.stringMatching(/no verified portrait artwork/)] });
    bogenTheme('arcs', { size: '2160x3840', orientation: 'portrait', wallpaper: 'composed', background: 'displays/background-portrait-9x16.png' }, { 'displays/background-portrait-9x16.png': picture });
    expect((await upgradeThemeRuntime(themeEnv(), 'arcs')).incomplete[0]).toMatch(/not trusted/);
    const changed = bogenTheme('changed', { size: '2160x3840', orientation: 'portrait', wallpaper: 'artwork', background: 'displays/background-portrait-9x16.png' }, { 'displays/background-portrait-9x16.png': picture });
    writeFileSync(join(changed, 'displays/background-portrait-9x16.png'), Buffer.concat([picture, Buffer.from('x')]));
    expect((await upgradeThemeRuntime(themeEnv(), 'changed')).blockers.join(' ')).toMatch(/differs from what the export shipped/);
    mkdirSync(join(env.omarchyPath, 'themes', 'stocky', 'backgrounds'), { recursive: true });
    expect((await upgradeThemeRuntime(themeEnv(), 'stocky')).blockers[0]).toMatch(/Stock themes are never changed/);
    const repo = bogenTheme('repo', { size: '2160x3840', orientation: 'portrait', wallpaper: 'artwork', background: 'displays/background-portrait-9x16.png' }, { 'displays/background-portrait-9x16.png': picture });
    mkdirSync(join(repo, '.git'));
    expect((await upgradeThemeRuntime(themeEnv(), 'repo')).blockers[0]).toMatch(/repository/);
    for (const slug of ['nenaj', 'arcs', 'changed', 'repo']) expect(existsSync(join(env.home, '.config', 'omarchy', 'themes', slug, RUNTIME_FILE))).toBe(false);
  });
});

function readdirTree(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...readdirTree(p, base));
    else out.push(p.slice(base.length + 1));
  }
  return out.sort();
}


// ---------------------------------------------------------------- what a composition is, offline

const layer = (over: Partial<CompositionLayer> & { id: string }): CompositionLayer => ({ name: over.id, type: 'frame', style: {}, generated: false, ancestors: [], ...over });
const PORTRAIT = { width: 2160, height: 3840 };
const sizes: Record<string, { width: number; height: number }> = { 'bogen-asset:wide.png': { width: 3840, height: 2160 }, 'bogen-asset:tall.png': { width: 2160, height: 3840 }, 'bogen-asset:tall-small.webp': { width: 1080, height: 1920 } };
const sizeOf = (src: string | undefined) => (src ? sizes[src] ?? null : null);

describe('what a portrait composition is (no renderer)', () => {
  it('counts a landscape plate shown whole inside an authored portrait field as composed, never as artwork or a mismatch', () => {
    // The Flexoki case: the field's gradient is the composition's own; the 16:9 picture sits in a band, contained.
    const plate = layer({ id: 'img', name: '1-orb.webp', type: 'image', src: 'bogen-asset:wide.png', style: { position: 'absolute', top: '15.755cqh', left: '0', width: '100cqw', height: '56.25cqw', objectFit: 'contain' } });
    const verdict = classifyComposition([plate], PORTRAIT, sizeOf);
    expect(verdict).toMatchObject({ status: 'composed', own: 1, contained: [{ id: 'img' }] });
    // The same with object-fit: cover in a band of its own ratio: nothing is cropped, it is a plate.
    expect(classifyComposition([{ ...plate, style: { ...plate.style, objectFit: 'cover' } }], PORTRAIT, sizeOf)).toMatchObject({ status: 'composed' });
    // Beside a title of its own, too.
    expect(classifyComposition([plate, layer({ id: 'title', type: 'text' })], PORTRAIT, sizeOf)).toMatchObject({ status: 'composed', own: 2 });
  });

  it('rejects a landscape picture laid over the whole portrait, however it is filled, and one of unknown size', () => {
    for (const style of [{ inset: '0', objectFit: 'cover' }, { width: '100%', height: '100%', objectFit: 'cover' }, { width: '100%', height: '100%' }, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%' }]) {
      const cover = layer({ id: 'img', type: 'image', src: 'bogen-asset:wide.png', style });
      expect(classifyComposition([cover], PORTRAIT, sizeOf), JSON.stringify(style)).toMatchObject({ status: 'mismatch', size: { width: 3840, height: 2160 } });
      // A title on top does not make a cropped landscape picture a portrait design.
      expect(classifyComposition([cover, layer({ id: 't', type: 'text' })], PORTRAIT, sizeOf).status).toBe('mismatch');
    }
    expect(classifyComposition([layer({ id: 'img', type: 'image', src: 'bogen-asset:unknown.avif', style: { inset: '0' } })], PORTRAIT, sizeOf)).toMatchObject({ status: 'unverified' });
  });

  it('keeps true portrait artwork as artwork, in or out of its wrapper frame, so its bytes ship as they are', () => {
    const art = layer({ id: 'img', type: 'image', src: 'bogen-asset:tall-small.webp', style: { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover' } });
    expect(classifyComposition([art], PORTRAIT, sizeOf)).toMatchObject({ status: 'artwork', layer: { src: 'bogen-asset:tall-small.webp' }, size: { width: 1080, height: 1920 } });
    const wrap = layer({ id: 'wrap', type: 'frame' });
    expect(classifyComposition([wrap, { ...art, ancestors: ['wrap'] }], PORTRAIT, sizeOf).status).toBe('artwork');
    // Hidden placeholder layers are not passed in; a placeholder still showing under it is generated, not own.
    expect(classifyComposition([layer({ id: 'note', name: 'Not designed yet', generated: true }), art], PORTRAIT, sizeOf).status).toBe('artwork');
    // Anything of its own beside the picture makes it a composition, rendered as a whole.
    expect(classifyComposition([art, layer({ id: 'logo', type: 'image', src: 'bogen-asset:tall.png', style: { width: '20%', height: '10%' } })], PORTRAIT, sizeOf).status).toBe('composed');
  });

  it('never counts the placeholder or the palette arcs as a design, recoloured or not', () => {
    expect(classifyComposition([layer({ id: 'n', name: 'Not designed yet', generated: true }), layer({ id: 'h', name: 'Placeholder hint', generated: true })], PORTRAIT, sizeOf)).toEqual({ status: 'needs-design', legacy: false });
    const arcs = LEGACY_PORTRAIT_LAYERS.map((name) => layer({ id: name, name, generated: true, style: { border: '1.9cqw solid var(--omarchy-accent)' } }));
    expect(classifyComposition(arcs, PORTRAIT, sizeOf)).toEqual({ status: 'needs-design', legacy: true });
    expect(classifyComposition([], PORTRAIT, sizeOf).status).toBe('needs-design');
    expect(classifyComposition([...arcs, layer({ id: 'mark', name: 'Wordmark', type: 'text' })], PORTRAIT, sizeOf).status).toBe('composed');
  });

  it('tells filling from placing, measured by axis against the composition', () => {
    const F = PORTRAIT;
    expect(fillsComposition({ inset: '0' }, F)).toBe(true);
    expect(fillsComposition({ inset: '0', objectFit: 'contain' }, F)).toBe(false);
    expect(fillsComposition({ width: '100%', height: '100%', top: '0', left: '0' }, F)).toBe(true);
    expect(fillsComposition({ width: '100%', height: '100%', top: '12%' }, F)).toBe(false);
    expect(fillsComposition({ width: '100cqw', height: '56.25cqw', objectFit: 'cover' }, F)).toBe(false);
    expect(fillsComposition({ objectFit: 'cover' }, F)).toBe(false);
    // Pixels, container units and oversized boxes are measured, not matched as strings.
    expect(fillsComposition({ position: 'absolute', top: '0px', left: '0px', width: '2160px', height: '3840px', objectFit: 'cover' }, F)).toBe(true);
    expect(fillsComposition({ top: '0', left: '0', width: '100cqw', height: '100cqh' }, F)).toBe(true);
    expect(fillsComposition({ top: '-5%', left: '-10%', width: '120%', height: '110%' }, F)).toBe(true);
    // A square band at the top: 100cqw is 2160 px, not the height.
    expect(fillsComposition({ top: '0', left: '0', width: '100cqw', height: '100cqw', objectFit: 'cover' }, F)).toBe(false);
    // object-fit: none fills only with a picture at least as large as the composition.
    expect(fillsComposition({ inset: '0', objectFit: 'none' }, F, { width: 3840, height: 2160 })).toBe(true);
    expect(fillsComposition({ inset: '0', objectFit: 'none' }, F, { width: 800, height: 600 })).toBe(false);
  });

  it('meets the parent\'s acceptance cases: px-sized cover, none-fit clipping, a square band in width units', () => {
    const one = (style: Record<string, string>, src: string) => classifyComposition([layer({ id: 'p', type: 'image', src, style })], PORTRAIT, sizeOf).status;
    sizes['bogen-asset:square.png'] = { width: 3000, height: 3000 };
    expect(one({ position: 'absolute', top: '0px', left: '0px', width: '2160px', height: '3840px', objectFit: 'cover' }, 'bogen-asset:wide.png')).toBe('mismatch');
    expect(one({ position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'none' }, 'bogen-asset:wide.png')).toBe('mismatch');
    expect(one({ position: 'absolute', top: '0', left: '0', width: '100cqw', height: '100cqw', objectFit: 'cover' }, 'bogen-asset:square.png')).toBe('composed');
    // A portrait picture at exactly the composition's size with object-fit: none is whole: artwork.
    expect(one({ position: 'absolute', inset: '0', objectFit: 'none' }, 'bogen-asset:tall.png')).toBe('artwork');
    // Twice the size, it is clipped to its middle quarter: not whole.
    sizes['bogen-asset:huge.png'] = { width: 4320, height: 7680 };
    expect(one({ position: 'absolute', inset: '0', objectFit: 'none' }, 'bogen-asset:huge.png')).toBe('mismatch');
    // Stretched (the default fill) across a portrait it is distorted.
    expect(one({ position: 'absolute', inset: '0' }, 'bogen-asset:wide.png')).toBe('mismatch');
  });

  it('gives a new theme\'s landscape background a plain field: no palette arcs, no layers, no text on the desktop', () => {
    const html = wallpaper();
    for (const name of LEGACY_PORTRAIT_LAYERS) expect(html).not.toContain(`data-name="${name}"`);
    expect(html).not.toMatch(/omarchy-(red|orange|yellow|green|cyan|blue|magenta)\b/);
    expect(html).not.toMatch(/designed|compose|artwork/i);
    // One element: the Wallpaper itself, with nothing inside it.
    expect(html.match(/<div/g)).toHaveLength(1);
    expect(html).toMatch(/^<div [^>]*data-name="Wallpaper"><\/div>$/);
    // The portrait placeholder stays explicit in Bogen: it is never exported or shown, so its note never reaches a screen.
    expect(portraitWallpaper('Wallpaper · portrait 9:16', '9:16')).toContain('Portrait composition not designed yet');
  });
});

describe('reading an installed Bogen theme back (no renderer)', () => {
  const themeEnv = () => ({ home: env.home, omarchyPath: env.omarchyPath, bin: env.omarchyBin, stateFile: join(root, 'apply.json'), omamobilePath: join(root, 'none') });
  const picture = Buffer.concat([pngHeader(2160, 3840), Buffer.alloc(200, 3)]);

  it('carries the verified portrait compositions, and never a placeholder or a changed one', () => {
    const dir = join(env.home, '.config', 'omarchy', 'themes', 'nenaj');
    const rt = runtimeManifest('nenaj', [
      { aspect: '9:16', orientation: 'portrait', status: 'composed', reason: '', file: 'displays/background-portrait-9x16.png', bytes: picture },
      { aspect: '10:16', orientation: 'portrait', status: 'needs-design', reason: 'placeholder' },
    ])!;
    themeWith(dir, { 'colors.toml': 'background = "#000000"\nforeground = "#ffffff"\naccent = "#c6ff00"\n', 'backgrounds/1-ink.png': Buffer.concat([pngHeader(3840, 2160), Buffer.alloc(10)]), 'bogen-theme.json': JSON.stringify({ format: 1, kind: 'omarchy-theme', name: 'Nenaj', slug: 'nenaj', target: 'desktop', files: [] }), [RUNTIME_FILE]: rt.json, 'displays/background-portrait-9x16.png': picture, 'displays/needs-design-portrait-10x16.png': Buffer.concat([pngHeader(1200, 1920), Buffer.alloc(10)]) });
    const loaded = loadTheme(themeEnv(), 'nenaj');
    expect(loaded.bogen).toBe(true);
    expect(loaded.portraits.map((p) => [p.aspect, p.name, Buffer.compare(Buffer.from(p.bytes), picture)])).toEqual([['9:16', 'background-portrait-9x16.png', 0]]);
    expect(loaded.left).not.toContain('displays');
    writeFileSync(join(dir, 'displays/background-portrait-9x16.png'), Buffer.concat([picture, Buffer.from('changed')]));
    expect(loadTheme(themeEnv(), 'nenaj').portraits).toEqual([]);
  });

  it('reads nothing portrait from a theme Bogen did not make', () => {
    themeWith(join(env.home, '.config', 'omarchy', 'themes', 'plain'), { 'colors.toml': 'background = "#111111"\n', 'displays/background-portrait-9x16.png': picture });
    expect(loadTheme(themeEnv(), 'plain')).toMatchObject({ bogen: false, portraits: [] });
  });
});

// ---------------------------------------------------------------- which map each frame takes, through Omarchy's own sequence

/**
 * A model of Omarchy's background service (shell/plugins/background/Background.qml) as far as the maps go, with the
 * plugin's patch and PortraitMapping.qml's handlers: a property's change handler runs only when its value changes, a
 * reveal ends by setting displayedBackground to currentBackground and then finishingTransition, and
 * incomingBackground is cleared only when the base image becomes ready on a new path.
 */
class Service {
  incoming = ''; current = ''; displayed = ''; old = ''; revealProgress = 1; finishing = false;
  incomingMap: any = null; displayedMap: any = null; oldMap: any = null; holding = false;
  active: any = null;
  constructor(readonly themeDirs: string[]) {}
  mapFor = (path: string) => (this.active && lib.isThemeStill(path, this.active.themeDirs) ? this.active : null);
  frames() {
    return { incoming: this.incoming, current: this.current, displayed: this.displayed, revealProgress: this.revealProgress, incomingMap: this.incomingMap, displayedMap: this.displayedMap };
  }
  /** Returns whether the path changed: only then does the base image load again and report ready. */
  setDisplayed(path: string): boolean {
    if (path === this.displayed) return false;
    this.displayed = path;
    this.displayedMap = lib.displayedMapOnPathChange(this.frames(), this.holding, this.mapFor);
    return true;
  }
  setFinishing(v: boolean) {
    if (v === this.finishing) return;
    this.finishing = v;
    if (v) this.displayedMap = lib.displayedMapAtRevealEnd(this.frames());
  }
  /** transitionBackground(fromPath, path, finalPath, instant, force), with beginTransition where the patch puts it. */
  transition(from: string, path: string, final: string, instant: boolean) {
    this.oldMap = this.displayedMap;
    this.incomingMap = null;
    this.holding = true;
    this.current = final;
    this.setFinishing(false);
    if (instant || !this.displayed) {
      this.old = ''; this.incoming = ''; this.revealProgress = 1;
      this.setDisplayed(final);
      return;
    }
    this.old = from || this.displayed;
    this.incoming = path;
    this.revealProgress = 0;
  }
  revealEnds() {
    this.revealProgress = 1;
    const reloads = this.setDisplayed(this.current);
    this.setFinishing(true);
    // The base image becomes ready on the new path, which clears the finished reveal. On an unchanged path it never
    // does, and Omarchy leaves the incoming frame (the same picture) over the base.
    if (reloads) { this.incoming = ''; this.old = ''; this.finishing = false; }
  }
  /** The theme's map checked (or found absent), as PortraitMapping.finish applies it. */
  resolved(map: any) {
    this.active = map;
    const next = lib.mapsAfterResolve(this.frames(), this.mapFor);
    this.incomingMap = next.incomingMap;
    this.displayedMap = next.displayedMap;
    this.holding = false;
  }
  /** What a screen of this size shows now: the incoming frame over the base once revealed, else the base. */
  shows(width: number, height: number): string {
    if (this.incoming && this.revealProgress >= 1) return lib.screenPath(this.incoming, this.incomingMap, width, height);
    return lib.screenPath(this.displayed, this.displayedMap, width, height);
  }
}

describe('which map each frame takes, through Omarchy\'s own sequence (no shell)', () => {
  const themeLink = '/h/.local/state/omarchy/current/theme';
  const still = `${themeLink}/backgrounds/1-ink.png`;
  const map = { themeDirs: [themeLink], entries: [{ aspect: '9:16', width: 2160, height: 3840, path: '/h/.cache/bogen/portrait-background/abc.png' }] };
  const DP5 = [2160, 3840] as const;
  const DP3 = [3840, 2160] as const;

  it('shows the composition after the theme is applied again on the same still (the live case)', () => {
    const s = new Service([themeLink]);
    // The shell starts before the theme has a runtime manifest: the global background everywhere.
    s.transition('', still, still, false);
    s.resolved(null);
    expect(s.shows(...DP5)).toBe(still);
    // The manifest is added and the theme applied again: Omarchy's themeTransition with snapshots, ending on the
    // same path, so displayedBackground never changes and the base image never reloads.
    s.transition('/h/.cache/omarchy/background-transitions/previous-1.png', '/h/.cache/omarchy/background-transitions/next-1.png', still, false);
    s.resolved(map);
    s.revealEnds();
    expect(s.displayed).toBe(still);
    expect(s.incoming).not.toBe('');
    expect(s.displayedMap).toBe(map);
    expect(s.shows(...DP5)).toBe(map.entries[0]!.path);
    // DP-3 keeps the theme background: here the incoming snapshot of the same still, as stock Omarchy leaves it.
    expect(s.shows(...DP3)).toBe('/h/.cache/omarchy/background-transitions/next-1.png');
    // What portraitStatus reads: the displayed frame's map has the composition for DP-5.
    expect(lib.entryFor(s.displayedMap, ...DP5)).toBe(map.entries[0]);
  });

  it('takes the map on portraitRefresh even while Omarchy leaves the last incoming frame set', () => {
    const s = new Service([themeLink]);
    s.transition('', still, still, false);
    s.resolved(null);
    s.transition('/x/previous.png', '/x/next.png', still, false);
    s.revealEnds();
    s.resolved(null);
    expect(lib.entryFor(s.displayedMap, ...DP5)).toBeNull();
    // portraitRefresh: the map is checked again, with no transition at all.
    s.resolved(map);
    expect(lib.entryFor(s.displayedMap, ...DP5)).toBe(map.entries[0]);
    expect(s.shows(...DP5)).toBe(map.entries[0]!.path);
  });

  it('takes the map when it arrives after the reveal ended, and after an instant set of the same path', () => {
    const s = new Service([themeLink]);
    s.transition('', still, still, false);
    s.resolved(null);
    s.transition('/x/old.png', '/x/new.png', still, false);
    s.revealEnds();
    expect(s.shows(...DP5)).toBe('/x/new.png');
    s.resolved(map);
    expect(s.shows(...DP5)).toBe(map.entries[0]!.path);
    // setInstant on the same path: the displayed frame keeps its map while the theme is checked again, then takes
    // the result, a composition or none, so a map never outlives its check.
    s.transition('', still, still, true);
    expect(s.shows(...DP5)).toBe(map.entries[0]!.path);
    s.resolved(map);
    expect(s.shows(...DP5)).toBe(map.entries[0]!.path);
    s.transition('', still, still, true);
    s.resolved(null);
    expect(s.shows(...DP5)).toBe(still);
  });

  it('keeps each frame on the map it started with during a reveal, and drops a theme\'s map when the next has none', () => {
    const s = new Service([themeLink]);
    s.transition('', still, still, false);
    s.resolved(map);
    expect(s.shows(...DP5)).toBe(map.entries[0]!.path);
    // Switching to a theme without compositions: the old frame keeps the old map until the reveal ends.
    const next = `${themeLink}/backgrounds/1-other.png`;
    s.transition('/x/prev.png', '/x/next.png', next, false);
    expect(s.oldMap).toBe(map);
    s.resolved(null);
    expect(s.displayedMap).toBe(map);
    s.revealEnds();
    expect(s.displayedMap).toBeNull();
    expect(s.shows(...DP5)).toBe(next);
    // A video is never mapped.
    s.transition('', `${themeLink}/backgrounds/loop.mp4`, `${themeLink}/backgrounds/loop.mp4`, true);
    s.resolved(map);
    expect(s.shows(...DP5)).toBe(`${themeLink}/backgrounds/loop.mp4`);
  });
});

describe('what a check leaves for the status (no shell)', () => {
  it('reports no theme or revision after switching to a theme without a manifest, and every field is reset', () => {
    const map = { entries: [{ aspect: '9:16', width: 2160, height: 3840, path: '/c/a.png' }] };
    const first = lib.outcome(map, 'active', { theme: 'nenaj', revision: 'abcdef012345', problems: [], incomplete: [], rejected: [] });
    expect(first).toMatchObject({ map, state: 'active', theme: 'nenaj', revision: 'abcdef012345' });
    for (const state of ['no-manifest', 'no-theme', 'error']) {
      // A failed check passes no theme; even one passed by mistake is not reported for a state that read no manifest.
      expect(lib.outcome(null, state, { problems: ['x'] })).toEqual({ map: null, state, theme: '', revision: '', problems: ['x'], incomplete: [], rejected: [] });
      expect(lib.outcome(null, state, { theme: 'nenaj', revision: 'abcdef012345' })).toMatchObject({ theme: '', revision: '' });
    }
    // A manifest that was read but holds nothing to show names its own theme.
    expect(lib.outcome(null, 'incomplete', { theme: 'tokyo', incomplete: [{ aspect: '9:16' }] })).toMatchObject({ map: null, state: 'incomplete', theme: 'tokyo', revision: '' });
    expect(lib.outcome(null, '', undefined)).toMatchObject({ state: 'error', problems: [], incomplete: [], rejected: [] });
    expect(lib.outcome(null, 'invalid', { problems: Array.from({ length: 40 }, (_, i) => String(i)) }).problems).toHaveLength(16);
  });
});

describe('a running shell with an older plugin', () => {
  it('says to restart the shell only when the running version is known and differs from the installed one', async () => {
    const { staleRuntime } = await import('../src/omarchy-portrait-runtime.ts');
    expect(staleRuntime('1.0.2', { version: '1' })).toMatch(/still has plugin 1, and 1\.0\.2 is installed.*omarchy restart shell/);
    expect(staleRuntime('1.0.2', { version: '1.0.2' })).toBeNull();
    expect(staleRuntime(undefined, { version: '1' })).toBeNull();
    expect(staleRuntime('1.0.2', null)).toBeNull();
    expect(staleRuntime('1.0.2', { state: 'active' })).toBeNull();
  });
});
