// The portrait background on a real Omarchy desktop: Bogen's user shell plugin `bogen.portrait-background`.
//
// Stock Omarchy (shell/plugins/background/Background.qml) draws one `current/background` on every screen, cropped. It
// has no notion of a picture per screen, so a theme's portrait composition cannot reach a portrait monitor through
// the theme alone. This module installs, on the person's word, a clone of `omarchy.background` (the shell's own clone
// mechanism: `omarchy.clonedFrom`, which keeps the IPC target, intros and the theme switch talking to it) whose
// Background.qml is derived from the host's own stock file by a small, anchored patch. Where the stock file no longer
// has the anchors, nothing is derived and the plugin says it is incompatible: it never guesses.
//
// The plugin reads displays/portrait-runtime.json of the current theme (written by Bogen's export, data only) and
// draws a verified composition on each screen of that shape; every other screen keeps Omarchy's background.
//
// Everything here is read-only unless `apply` is set. Writes go to ~/.config/omarchy/plugins/bogen.portrait-background
// and ~/.local/state/bogen/portrait-background only. The stock plugin under $OMARCHY_PATH is only read. Commands run
// only as argv, never through a shell: `omarchy-shell shell rescanPlugins`, `omarchy plugin enable|disable <id>`, and,
// asked for, `omarchy-shell background portraitStatus`.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aspectOf, orientationOf } from './omarchy-displays.ts';
import { atomicWrite } from './util.ts';

export const PLUGIN_ID = 'bogen.portrait-background';
export const PLUGIN_NAME = 'Bogen portrait background';
/** Bumped when the plugin's own files or the patch change; an older install then reads as outdated. */
export const PLUGIN_VERSION = '1.0.2';
export const PATCH_VERSION = 1;
export const RUNTIME_FILE = 'displays/portrait-runtime.json';
const STOCK_ID = 'omarchy.background';
const OWN_FILES = ['PortraitMapping.qml', 'PortraitRuntime.js'] as const;
const MAX_MANIFEST = 64 * 1024;
const MAX_QML = 512 * 1024;
const MAX_PLUGIN_DIRS = 256;

// ---------------------------------------------------------------- where things are

export interface PortraitEnv {
  home: string;
  /** `$OMARCHY_PATH`: the stock plugin is read from shell/plugins/background. */
  omarchyPath: string;
  /** The `omarchy` command; tests put a stand-in here. */
  omarchyBin: string;
  /** The `omarchy-shell` command. */
  shellBin: string;
  /** This build's copy of the plugin's own files (integrations/omarchy/portrait-background). */
  sourceDir: string;
}

const PLUGIN_SOURCE = ['integrations', 'omarchy', 'portrait-background'] as const;

/**
 * Where the plugin's files are, for the module at `moduleUrl`, in the order they are tried. Each of them is checked
 * for PortraitRuntime.js; the checkout's place is the answer when none has it.
 * - a flat deploy (cli.js at the top of the app folder): next to the module;
 * - a package or a Linux deploy (dist/cli.js): next to dist/;
 * - a source checkout (packages/server/src/…): at the top of the repository.
 */
export function pluginSourceDirFrom(moduleUrl: string, exists: (path: string) => boolean = existsSync): string {
  const here = dirname(fileURLToPath(moduleUrl));
  const candidates = [join(here, ...PLUGIN_SOURCE), join(here, '..', ...PLUGIN_SOURCE), join(here, '..', '..', '..', ...PLUGIN_SOURCE)];
  return candidates.find((p) => exists(join(p, 'PortraitRuntime.js'))) ?? candidates[2]!;
}

/** The plugin's files as this build ships them. See `pluginSourceDirFrom`. */
export function pluginSourceDir(): string {
  return pluginSourceDirFrom(import.meta.url);
}

function onPath(name: string, path = ''): boolean {
  return path.split(':').some((dir) => dir && isFile(join(dir, name)));
}

export function portraitEnv(env: NodeJS.ProcessEnv = process.env): PortraitEnv {
  const omarchyPath = env.OMARCHY_PATH || '/usr/share/omarchy';
  const bin = (name: string) => (onPath(name, env.PATH) ? name : existsSync(join(omarchyPath, 'bin', name)) ? join(omarchyPath, 'bin', name) : name);
  return { home: env.HOME || homedir(), omarchyPath, omarchyBin: bin('omarchy'), shellBin: bin('omarchy-shell'), sourceDir: pluginSourceDir() };
}

const pluginsDir = (env: PortraitEnv) => join(env.home, '.config', 'omarchy', 'plugins');
const targetDir = (env: PortraitEnv) => join(pluginsDir(env), PLUGIN_ID);
const stateDir = (env: PortraitEnv) => join(env.home, '.local', 'state', 'bogen', 'portrait-background');
const backupsDir = (env: PortraitEnv) => join(stateDir(env), 'backups');
const shellJson = (env: PortraitEnv) => join(env.home, '.config', 'omarchy', 'shell.json');
const stockDir = (env: PortraitEnv) => join(env.omarchyPath, 'shell', 'plugins', 'background');
export const currentThemeDir = (home: string) => join(home, '.local', 'state', 'omarchy', 'current', 'theme');

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isPlainDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** A small file, read only when it is a regular file (not a link) of at most `max` bytes. */
function readSmall(path: string, max: number): string | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readJson(path: string, max = MAX_MANIFEST): unknown {
  const text = readSmall(path, max);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- the runtime library, shared with the plugin

export interface RuntimeEntry { aspect: string; orientation: string; width: number; height: number; file: string; sha256: string; bytes: number; status: string; format: string }
export interface RuntimeManifestCheck { ok: boolean; entries: RuntimeEntry[]; incomplete: { aspect: string; status: string; reason: string }[]; problems: string[]; theme: string; revision: string }
export interface MapEntry { aspect: string; width: number; height: number; path: string; orientation?: string }
export interface RuntimeMap { entries: MapEntry[] }

/** PortraitRuntime.js, the plugin's pure part, loaded as the plugin loads it: one source of truth for both sides. */
export interface PortraitRuntime {
  KIND: string; FORMAT: number; MAX_ASSET_BYTES: number; MAX_HEADER_BYTES: number; SHAPE_TOLERANCE: number;
  isVideoPath(path: string): boolean;
  orientationOf(width: number, height: number): string;
  sameShape(aw: number, ah: number, bw: number, bh: number): boolean;
  decodeBase64(text: string, limit?: number): number[] | null;
  imageHeader(bytes: ArrayLike<number> | null): { format: string; width: number; height: number } | null;
  validateManifest(raw: unknown): RuntimeManifestCheck;
  parseManifestText(text: string): RuntimeManifestCheck;
  parseKeyLines(text: string): Record<string, string>;
  verifyAsset(entry: RuntimeEntry, report: Record<string, string> | null): { ok: boolean; reason?: string; entry?: MapEntry & { file: string; status: string } };
  isThemeStill(path: string, themeDirs: string[]): boolean;
  entryFor(map: RuntimeMap | null, width: number, height: number, failed?: Record<string, boolean>): MapEntry | null;
  screenPath(globalPath: string, map: RuntimeMap | null, width: number, height: number, failed?: Record<string, boolean>): string;
  pathsOf(maps: (RuntimeMap | null)[]): string[];
  mapsAfterResolve(frames: RuntimeFrames, mapFor: (path: string) => RuntimeMap | null): { incomingMap: RuntimeMap | null; displayedMap: RuntimeMap | null };
  displayedMapAtRevealEnd(frames: RuntimeFrames): RuntimeMap | null;
  displayedMapOnPathChange(frames: RuntimeFrames, holding: boolean, mapFor: (path: string) => RuntimeMap | null): RuntimeMap | null;
  outcome(map: RuntimeMap | null, state: string, details?: Record<string, unknown>): { map: RuntimeMap | null; state: string; theme: string; revision: string; problems: unknown[]; incomplete: unknown[]; rejected: unknown[] };
}

/** The background service's frames, as the plugin hands them to PortraitRuntime.js. */
export interface RuntimeFrames { incoming: string; current: string; displayed: string; revealProgress: number; incomingMap: RuntimeMap | null; displayedMap: RuntimeMap | null }

const RUNTIME_EXPORTS = ['KIND', 'FORMAT', 'MAX_ASSET_BYTES', 'MAX_HEADER_BYTES', 'SHAPE_TOLERANCE', 'isVideoPath', 'orientationOf', 'sameShape', 'decodeBase64', 'imageHeader', 'validateManifest', 'parseManifestText', 'parseKeyLines', 'verifyAsset', 'isThemeStill', 'entryFor', 'screenPath', 'pathsOf', 'mapsAfterResolve', 'displayedMapAtRevealEnd', 'displayedMapOnPathChange', 'outcome'];
const runtimeCache = new Map<string, PortraitRuntime>();

export function loadRuntime(sourceDir = pluginSourceDir()): PortraitRuntime {
  const file = join(sourceDir, 'PortraitRuntime.js');
  const cached = runtimeCache.get(file);
  if (cached) return cached;
  const src = readFileSync(file, 'utf8').replace(/^\.pragma library\s*$/m, '');
  // Bogen's own shipped file, not theme content: nothing from a theme is ever evaluated.
  const lib = new Function(`"use strict";\n${src}\nreturn { ${RUNTIME_EXPORTS.join(', ')} };`)() as PortraitRuntime;
  runtimeCache.set(file, lib);
  return lib;
}

// ---------------------------------------------------------------- the runtime manifest a theme carries

export interface RuntimeWallpaperInput {
  aspect: string; orientation: string; status: string; reason: string;
  /** The exported file, for a done composition. */
  file?: string; bytes?: Uint8Array;
}

/**
 * displays/portrait-runtime.json for an export. Only `artwork` and `composed` compositions are listed as wallpapers,
 * each with its file, measured size, byte count and sha256; every other state is listed under `incomplete` with its
 * reason, so a stand-in can never be taken for a design. Null when the theme has no portrait shapes at all.
 */
export function runtimeManifest(slug: string, wallpapers: readonly RuntimeWallpaperInput[], lib = loadRuntime()): { json: string; active: number; incomplete: number; problems: string[] } | null {
  if (!wallpapers.length) return null;
  const done: Record<string, unknown>[] = [];
  const incomplete: Record<string, unknown>[] = [];
  const problems: string[] = [];
  for (const w of wallpapers) {
    if ((w.status === 'artwork' || w.status === 'composed') && w.file && w.bytes) {
      const head = lib.imageHeader(w.bytes.subarray(0, lib.MAX_HEADER_BYTES));
      if (!head) {
        problems.push(`The ${w.orientation} ${w.aspect} composition (${w.file}) is not a PNG, JPEG or WebP the portrait background plugin can measure, so it is not listed for portrait screens.`);
        incomplete.push({ aspect: w.aspect, orientation: w.orientation, status: 'unverified', reason: 'Its picture cannot be measured by the portrait background plugin.' });
        continue;
      }
      done.push({ aspect: w.aspect, orientation: w.orientation, width: head.width, height: head.height, file: w.file, sha256: sha256(w.bytes), bytes: w.bytes.length, status: w.status });
    } else {
      incomplete.push({ aspect: w.aspect, orientation: w.orientation, status: w.status, reason: w.reason.slice(0, 300) });
    }
  }
  const out = { kind: lib.KIND, format: lib.FORMAT, theme: slug, appliesTo: 'theme-backgrounds', wallpapers: done, incomplete };
  // The plugin reads at most 64 KB; checked here so an export never ships one it would refuse.
  const json = `${JSON.stringify(out, null, 2)}\n`;
  const check = lib.parseManifestText(json);
  problems.push(...check.problems);
  return { json, active: check.entries.length, incomplete: incomplete.length, problems };
}

export interface ThemeRuntimeState {
  dir: string;
  /** none: no runtime manifest; invalid: unreadable or refused; incomplete: nothing designed; ready: at least one verified. */
  state: 'none' | 'invalid' | 'incomplete' | 'ready';
  entries: (RuntimeEntry & { verified: boolean; reason?: string })[];
  incomplete: { aspect: string; status: string; reason: string }[];
  problems: string[];
}

/** Whether `child` resolves inside `parent`, both resolved. */
function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * Reads a theme folder's runtime manifest the way the plugin does: no links, nothing outside displays/, bounded, each
 * picture's bytes against its sha256 and its header against its size. Read-only.
 */
export function readThemeRuntime(dir: string, lib = loadRuntime()): ThemeRuntimeState {
  const out: ThemeRuntimeState = { dir, state: 'none', entries: [], incomplete: [], problems: [] };
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    out.problems.push(`${dir} is not there.`);
    return out;
  }
  const path = join(real, RUNTIME_FILE);
  if (!exists(path)) return out;
  let resolved = '';
  try {
    resolved = realpathSync(path);
  } catch {
    /* dangling */
  }
  if (resolved !== path) {
    out.state = 'invalid';
    out.problems.push(`${RUNTIME_FILE} is a link; the plugin does not read it.`);
    return out;
  }
  const text = readSmall(path, MAX_MANIFEST);
  if (text === null) {
    out.state = 'invalid';
    out.problems.push(`${RUNTIME_FILE} is larger than 64 KB or not a regular file; the plugin does not read it.`);
    return out;
  }
  const check = lib.parseManifestText(text);
  out.problems.push(...check.problems);
  out.incomplete = check.incomplete;
  for (const e of check.entries) {
    const file = join(real, e.file);
    let reason: string | undefined;
    try {
      const r = realpathSync(file);
      const st = lstatSync(r);
      if (r !== file || !within(join(real, 'displays'), r)) reason = 'It is a link, or under one.';
      else if (!st.isFile()) reason = 'It is not a regular file.';
      else if (st.size !== e.bytes) reason = `It is ${st.size} bytes; the manifest says ${e.bytes}. It changed after the export.`;
      else {
        const bytes = readFileSync(r);
        if (sha256(bytes) !== e.sha256) reason = 'Its bytes do not match the manifest\'s sha256: it changed after the export.';
        else {
          const head = lib.imageHeader(bytes.subarray(0, lib.MAX_HEADER_BYTES));
          if (!head || head.format !== e.format) reason = 'Its header is not the PNG, JPEG or WebP its name says.';
          else if (head.width !== e.width || head.height !== e.height) reason = `It is ${head.width} × ${head.height}; the manifest says ${e.width} × ${e.height}.`;
        }
      }
    } catch {
      reason = 'The file is not in the theme.';
    }
    out.entries.push({ ...e, verified: !reason, ...(reason ? { reason } : {}) });
  }
  out.state = out.entries.some((e) => e.verified) ? 'ready' : check.ok || check.incomplete.length ? (out.entries.length ? 'invalid' : 'incomplete') : 'invalid';
  return out;
}

/** What each monitor would show from a theme's verified compositions, in the logical sizes the shell lays out in. */
export function screensFor(state: ThemeRuntimeState | null, monitors: readonly { name: string; logical: { width: number; height: number }; orientation: string }[], lib = loadRuntime()): { name: string; width: number; height: number; orientation: string; shows: string; reason?: string }[] {
  const map: RuntimeMap = { entries: (state?.entries ?? []).filter((e) => e.verified).map((e) => ({ aspect: e.aspect, width: e.width, height: e.height, path: e.file })) };
  return monitors.map((m) => {
    const e = lib.entryFor(map, m.logical.width, m.logical.height);
    const base = { name: m.name, width: m.logical.width, height: m.logical.height, orientation: m.orientation };
    if (e) return { ...base, shows: `${e.path} (${e.aspect})` };
    if (m.orientation === 'landscape') return { ...base, shows: 'the theme background' };
    const pending = state?.incomplete.find((i) => lib.sameShape(m.logical.width, m.logical.height, ...aspectPair(i.aspect)));
    return { ...base, shows: 'the theme background, cropped', reason: pending ? `The ${pending.aspect} composition is ${pending.status}: ${pending.reason}` : state?.state === 'none' ? 'The theme has no portrait runtime manifest.' : `The theme has no verified composition of this shape (${m.logical.width} × ${m.logical.height}).` };
  });
}

function aspectPair(aspect: string): [number, number] {
  const [a, b] = aspect.split(':').map(Number);
  return [a || 0, b || 0];
}

// ---------------------------------------------------------------- what an installed Bogen theme ships

const HEADER = 262_144;

function plainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export interface ShippedDisplay { size: string; orientation: string; wallpaper: string; background?: string }

export function shippedDisplays(manifest: unknown): ShippedDisplay[] {
  if (!isObject(manifest) || !Array.isArray(manifest.displays)) return [];
  const out: ShippedDisplay[] = [];
  for (const d of manifest.displays.slice(0, 8)) {
    if (!isObject(d) || typeof d.size !== 'string' || !/^\d{2,5}x\d{2,5}$/.test(d.size)) continue;
    const background = typeof d.background === 'string' && /^displays\/[\w.-]{1,90}$/.test(d.background) ? d.background : undefined;
    out.push({ size: d.size, orientation: String(d.orientation ?? '').slice(0, 16), wallpaper: String(d.wallpaper ?? 'unknown').slice(0, 24), ...(background ? { background } : {}) });
  }
  return out;
}

function shippedSha(manifest: unknown, path: string): string | null {
  if (!isObject(manifest) || !Array.isArray(manifest.files)) return null;
  const f = manifest.files.find((x) => isObject(x) && x.path === path);
  return isObject(f) && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256) ? f.sha256 : null;
}

/** The artwork an installed Bogen theme ships that a runtime manifest could list, each checked against its manifest. */
export function verifiedArtwork(dir: string, manifest: unknown, lib = loadRuntime()): { artwork: { aspect: string; orientation: string; file: string; bytes: Uint8Array }[]; problems: string[] } {
  const artwork: { aspect: string; orientation: string; file: string; bytes: Uint8Array }[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const d of shippedDisplays(manifest)) {
    if (d.wallpaper !== 'artwork' || !d.background || seen.has(d.background)) continue;
    seen.add(d.background);
    const path = join(dir, d.background);
    if (!plainFile(path)) {
      problems.push(`${d.background} is not a regular file in the theme.`);
      continue;
    }
    const bytes = readFileSync(path);
    const want = shippedSha(manifest, d.background);
    if (!want || sha256(bytes) !== want) {
      problems.push(`${d.background} differs from what the export shipped; it is not listed.`);
      continue;
    }
    const h = lib.imageHeader(bytes.subarray(0, HEADER));
    if (!h) {
      problems.push(`${d.background} is not a PNG, JPEG or WebP the plugin can measure.`);
      continue;
    }
    const [w, hh] = d.size.split('x').map(Number) as [number, number];
    if (!lib.sameShape(h.width, h.height, w, hh)) {
      problems.push(`${d.background} is ${h.width} × ${h.height}, not the shape of ${d.size}.`);
      continue;
    }
    artwork.push({ aspect: aspectOf(h), orientation: orientationOf(h), file: d.background, bytes });
  }
  return { artwork, problems };
}

export interface ShippedPortrait { aspect: string; orientation: string; file: string; bytes: Uint8Array; status: string }

/**
 * The portrait compositions an installed Bogen theme ships that can be trusted, so that making a file from the theme
 * again keeps them: those its runtime manifest lists and the bytes still match, else (an older export) its artwork
 * whose bytes match bogen-theme.json. Never a placeholder, a needs-design picture, or an older "composed", which may
 * be the palette arc stand-in.
 */
export function shippedPortraits(dir: string, lib = loadRuntime()): ShippedPortrait[] {
  const rt = readThemeRuntime(dir, lib);
  if (rt.state !== 'none') {
    return rt.entries.filter((e) => e.verified).map((e) => ({ aspect: e.aspect, orientation: e.orientation, file: e.file, status: e.status, bytes: readFileSync(join(realpathSync(dir), e.file)) }));
  }
  const manifest = readJson(join(dir, 'bogen-theme.json'), 1 << 20);
  return verifiedArtwork(dir, manifest, lib).artwork.map((a) => ({ ...a, status: 'artwork' }));
}

// ---------------------------------------------------------------- deriving Background.qml from the host's own

interface Anchor { name: string; find: string; replace: string }

const MARK = '// bogen.portrait-background';

/**
 * The patch, as exact replacements of lines in Omarchy's Background.qml. Each must be found exactly once; otherwise
 * the stock file has changed in a way this version does not know, and nothing is derived.
 */
const ANCHORS: readonly Anchor[] = [
  {
    name: 'root map properties',
    find: '  property real revealProgress: 1\n',
    replace: '  property real revealProgress: 1\n'
      + `  ${MARK}: the map each frame on screen was started with, and the per-screen chooser (PortraitMapping.qml).\n`
      + '  property var portraitDisplayedMap: null\n'
      + '  property var portraitIncomingMap: null\n'
      + '  property var portraitOldMap: null\n'
      + '  property alias portrait: portraitMapping\n'
      + '  PortraitMapping { id: portraitMapping; host: root }\n',
  },
  {
    name: 'transition start',
    find: '    lastTransitionPath = path\n',
    replace: `    lastTransitionPath = path\n    portrait.beginTransition(fromPath, path, finalPath) ${MARK}\n`,
  },
  {
    name: 'decode size of a composition',
    find: '        var native = root.nativeSizes[path]\n',
    replace: `        var native = root.nativeSizes[path] !== undefined ? root.nativeSizes[path] : root.portrait.nativeSize(path) ${MARK}\n`,
  },
  {
    name: 'reveal waits for the new map',
    find: '      function maybeStartReveal() {\n        if (!root.incomingBackground || root.revealProgress !== 0 || maskReady) return\n',
    replace: `      ${MARK}: this screen's picture for a global path and the map its frame started with.\n`
      + '      function screenPath(path, map) {\n'
      + '        return root.portrait.screenPath(path, map, width, height)\n'
      + '      }\n\n'
      + '      function maybeStartReveal() {\n'
      + `        if (root.portrait.holding) return ${MARK}\n`
      + '        if (!root.incomingBackground || root.revealProgress !== 0 || maskReady) return\n',
  },
  {
    name: 'displayed frame',
    find: '        path: root.displayedBackground\n',
    replace: `        path: panel.screenPath(root.displayedBackground, root.portraitDisplayedMap) ${MARK}\n`,
  },
  {
    name: 'displayed decode size',
    find: '        decodeSize: panel.decodeSize(root.displayedBackground)\n',
    replace: '        decodeSize: panel.decodeSize(path)\n',
  },
  {
    name: 'a composition that fails falls back',
    find: '        onFailedChanged: if (failed) root.recoverBackground(path)\n',
    replace: `        onFailedChanged: if (failed) { if (root.portrait.owns(path)) root.portrait.markFailed(path); else root.recoverBackground(path) } ${MARK}\n`,
  },
  {
    name: 'outgoing frame',
    find: '        readonly property size decode: panel.decodeSize(root.oldBackground)\n        source: decode.width > 0 ? root.imageUrl(root.oldBackground) : ""\n',
    replace: `        readonly property string framePath: panel.screenPath(root.oldBackground, root.portraitOldMap) ${MARK}\n`
      + '        readonly property size decode: panel.decodeSize(framePath)\n'
      + '        source: decode.width > 0 ? root.imageUrl(framePath) : ""\n',
  },
  {
    name: 'incoming frame',
    find: '          readonly property string framePath: root.incomingBackground || root.preparedBackground\n',
    replace: `          readonly property string framePath: root.incomingBackground ? panel.screenPath(root.incomingBackground, root.portraitIncomingMap) : root.preparedBackground ${MARK}\n`,
  },
  {
    name: 'reveal resumes when the map arrives',
    find: '      MouseArea {\n',
    replace: `      Connections { ${MARK}\n        target: root.portrait\n        function onHoldingChanged() { panel.maybeStartReveal() }\n      }\n\n      MouseArea {\n`,
  },
  {
    name: 'status over IPC',
    find: '    function prepare(path: string): void {\n',
    replace: `    ${MARK}: omarchy-shell background portraitStatus | portraitRefresh\n`
      + '    function portraitStatus(): string {\n      return root.portrait.status()\n    }\n\n'
      + '    function portraitRefresh(): void {\n      root.portrait.resolve()\n    }\n\n'
      + '    function prepare(path: string): void {\n',
  },
];

export type PatchResult = { ok: true; source: string } | { ok: false; missing: string[]; reason: string };

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

/** Omarchy's Background.qml with the portrait patch, or why it cannot be patched. Pure. */
export function patchBackground(stock: string, stockSha = sha256(stock)): PatchResult {
  if (stock.includes(MARK)) return { ok: false, missing: [], reason: 'The file is already patched by Bogen; derive from the stock file only.' };
  if (!/ShellIpc\s*{\s*target:\s*"background"/.test(stock)) return { ok: false, missing: ['ShellIpc target "background"'], reason: 'The file has no "background" IPC target, so it is not Omarchy\'s background plugin.' };
  const missing = ANCHORS.filter((a) => count(stock, a.find) !== 1).map((a) => a.name);
  if (missing.length) return { ok: false, missing, reason: `Omarchy's Background.qml changed where the patch goes (${missing.join(', ')}). This Bogen version does not know the new file, so it derives nothing; the stock background stays in use.` };
  let out = stock;
  for (const a of ANCHORS) out = out.replace(a.find, () => a.replace);
  const header = [
    `${MARK} ${PLUGIN_VERSION} (patch ${PATCH_VERSION})`,
    `// Derived by Bogen from Omarchy's own shell/plugins/background/Background.qml (sha256 ${stockSha}), MIT License,`,
    '// https://github.com/basecamp/omarchy. Every changed line is marked; PortraitMapping.qml holds the rest. Editing',
    '// this file by hand is fine: Bogen then refuses to replace it without --force, and keeps a backup when it does.',
    '',
  ].join('\n');
  return { ok: true, source: header + out };
}

// ---------------------------------------------------------------- status

export type PluginState = 'not-installed' | 'installed' | 'enabled' | 'foreign' | 'unknown';

export interface PluginStatus {
  id: string;
  version: string;
  stock: { path: string; present: boolean; sha256?: string; version?: string; compatible: boolean; reason?: string };
  installed: null | {
    dir: string; version?: string; stockSha256?: string; ours: boolean;
    /** Files changed since Bogen wrote them. */
    modified: string[];
    /** Derived from another stock file or an older plugin version: an update re-derives it. */
    outdated: boolean;
  };
  enabled: boolean;
  /** omarchy.background is in disabledPlugins. */
  stockDisabled: boolean;
  /** Other user clones of omarchy.background. The plugin is never enabled beside one, and never writes over one. */
  conflicts: { id: string; dir: string; enabled: boolean }[];
  state: PluginState;
  /** What a person reads, in one sentence. */
  summary: string;
  /** What to run next, if anything. */
  next: string[];
  backups: string[];
  live?: unknown;
  liveError?: string;
}

interface ShellConfig { plugins: string[]; disabled: string[] }

function readShellConfig(env: PortraitEnv): ShellConfig {
  const raw = readJson(shellJson(env), 4 * 1024 * 1024);
  const ids = (v: unknown) => (Array.isArray(v) ? v.slice(0, 1024).map((p) => (isObject(p) ? String(p.id ?? '') : String(p ?? ''))).filter(Boolean) : []);
  if (!isObject(raw)) return { plugins: [], disabled: [] };
  return { plugins: ids(raw.plugins), disabled: ids(raw.disabledPlugins) };
}

function ownFileHashes(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)]));
}

function backupsOf(env: PortraitEnv): string[] {
  try {
    return readdirSync(backupsDir(env)).filter((n) => /^\d{8}T\d{6}Z(-\d+)?$/.test(n)).sort().reverse();
  } catch {
    return [];
  }
}

export function pluginStatus(env: PortraitEnv): PluginStatus {
  const stockPath = join(stockDir(env), 'Background.qml');
  const stockText = readSmall(stockPath, MAX_QML);
  const stockManifest = readJson(join(stockDir(env), 'manifest.json'));
  const stockSha = stockText === null ? undefined : sha256(stockText);
  const patched = stockText === null ? null : patchBackground(stockText, stockSha);
  const stock: PluginStatus['stock'] = {
    path: stockPath, present: stockText !== null, compatible: Boolean(patched?.ok),
    ...(stockSha ? { sha256: stockSha } : {}),
    ...(isObject(stockManifest) && typeof stockManifest.version === 'string' ? { version: stockManifest.version.slice(0, 32) } : {}),
    ...(patched && !patched.ok ? { reason: patched.reason } : stockText === null ? { reason: `There is no ${stockPath}: this is not an Omarchy desktop with the shell background plugin.` } : {}),
  };

  const dir = targetDir(env);
  let installed: PluginStatus['installed'] = null;
  if (exists(dir)) {
    const manifest = readJson(join(dir, 'manifest.json'));
    const bogen = isObject(manifest) && isObject(manifest.bogen) ? manifest.bogen : null;
    const ours = !lstatSync(dir).isSymbolicLink() && isObject(manifest) && manifest.id === PLUGIN_ID && bogen?.plugin === 'portrait-background';
    const modified: string[] = [];
    const files = bogen && isObject(bogen.files) ? (bogen.files as Record<string, unknown>) : {};
    if (ours) {
      for (const [name, hash] of Object.entries(files).slice(0, 16)) {
        if (!/^[\w.-]+$/.test(name)) continue;
        const text = readSmall(join(dir, name), MAX_QML);
        if (text === null || sha256(text) !== hash) modified.push(name);
      }
    }
    const version = isObject(manifest) && typeof manifest.version === 'string' ? manifest.version.slice(0, 32) : undefined;
    const derivedFrom = typeof bogen?.stockSha256 === 'string' ? bogen.stockSha256 : undefined;
    installed = {
      dir, ours, modified, ...(version ? { version } : {}), ...(derivedFrom ? { stockSha256: derivedFrom } : {}),
      outdated: ours && (version !== PLUGIN_VERSION || bogen?.patch !== PATCH_VERSION || (Boolean(stockSha) && derivedFrom !== stockSha)),
    };
  }

  const config = readShellConfig(env);
  const conflicts: PluginStatus['conflicts'] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(pluginsDir(env)).filter((n) => !n.startsWith('.')).sort().slice(0, MAX_PLUGIN_DIRS);
  } catch {
    /* no user plugins */
  }
  for (const name of dirs) {
    const m = readJson(join(pluginsDir(env), name, 'manifest.json'));
    if (!isObject(m) || !isObject(m.omarchy) || m.omarchy.clonedFrom !== STOCK_ID) continue;
    const id = String(m.id ?? name);
    if (id === PLUGIN_ID) continue;
    conflicts.push({ id, dir: join(pluginsDir(env), name), enabled: config.plugins.includes(id) && !config.disabled.includes(id) });
  }

  const enabled = Boolean(installed?.ours) && config.plugins.includes(PLUGIN_ID) && !config.disabled.includes(PLUGIN_ID);
  const stockDisabled = config.disabled.includes(STOCK_ID);
  const state: PluginState = installed && !installed.ours ? 'foreign' : enabled ? 'enabled' : installed ? 'installed' : 'not-installed';
  const next: string[] = [];
  let summary: string;
  if (!stock.present) summary = 'Omarchy\'s background plugin is not on this machine, so the portrait background cannot be installed here (a Mac or a phone cannot run a desktop shell plugin).';
  else if (state === 'foreign') summary = `${dir} exists and is not Bogen's; Bogen does not write over it.`;
  else if (conflicts.length) summary = `Another clone of the background plugin is installed (${conflicts.map((c) => c.id).join(', ')}). Bogen does not enable its own beside it; merge the portrait patch into yours, or remove yours first.`;
  else if (!stock.compatible && state === 'not-installed') summary = stock.reason ?? 'The stock background plugin cannot be patched.';
  else if (state === 'enabled') {
    summary = installed!.outdated ? 'The portrait background is in use, derived from an older stock file or plugin version.' : 'The portrait background is in use: portrait screens show the current theme\'s verified composition, the others the theme background.';
    if (installed!.outdated) next.push(stock.compatible ? 'bogen omarchy portrait install --apply   # re-derive from the current stock file; a backup is kept' : 'bogen omarchy portrait disable --apply   # the new stock file cannot be patched; go back to the stock background');
  } else if (state === 'installed') {
    summary = 'The portrait background plugin is installed but not enabled: every screen shows Omarchy\'s own background.';
    if (installed!.outdated && stock.compatible) next.push('bogen omarchy portrait install --apply');
    next.push('bogen omarchy portrait enable --apply');
  } else {
    summary = 'The portrait background plugin is not installed: Omarchy shows one background on every screen, cropped to fill it.';
    next.push('bogen omarchy portrait install          # plan only', 'bogen omarchy portrait install --apply', 'bogen omarchy portrait enable --apply');
  }
  if (stockDisabled && state !== 'enabled') next.unshift(`# omarchy.background is disabled in shell.json: something else may draw your wallpaper. Bogen does not enable over that; re-enable it with: omarchy plugin enable ${STOCK_ID}`);
  return { id: PLUGIN_ID, version: PLUGIN_VERSION, stock, installed, enabled, stockDisabled, conflicts, state, summary, next, backups: backupsOf(env) };
}

function run(bin: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((done, fail) => {
    execFile(bin, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) return fail(new Error(`${[bin, ...args].join(' ')} failed: ${(stderr || err.message).trim().split('\n').at(-1)}`));
      done(String(stdout).trim());
    });
  });
}

/**
 * Whether the running shell still has an older copy of the plugin than the one installed: Omarchy's hot reload can
 * keep the QML it already imported. Only when both versions are known and differ; then `omarchy restart shell`.
 */
export function staleRuntime(installedVersion: string | undefined, live: unknown): string | null {
  const running = live && typeof live === 'object' && typeof (live as { version?: unknown }).version === 'string' ? (live as { version: string }).version : null;
  if (!installedVersion || !running || running === installedVersion) return null;
  return `The running shell still has plugin ${running.slice(0, 16)}, and ${installedVersion} is installed: its hot reload kept the code it had loaded. Run: omarchy restart shell`;
}

/** The running plugin's own report, from `omarchy-shell background portraitStatus`. Only on request. */
export async function liveStatus(env: PortraitEnv): Promise<{ live?: unknown; liveError?: string }> {
  try {
    const text = await run(env.shellBin, ['background', 'portraitStatus'], 3000);
    if (text.length > 256 * 1024) return { liveError: 'The plugin\'s report is too long.' };
    try {
      return { live: JSON.parse(text) };
    } catch {
      return { liveError: `The running background did not answer portraitStatus (${text.slice(0, 120) || 'no output'}): the plugin is not the one drawing the background.` };
    }
  } catch (e) {
    return { liveError: (e as Error).message };
  }
}

// ---------------------------------------------------------------- plan and install

export interface PluginFiles { files: Record<string, string>; stockSha256: string }

/** Every file the plugin is made of, derived from this host's stock plugin. Throws with the reason when it cannot be. */
export function buildPlugin(env: PortraitEnv): PluginFiles {
  const stockPath = join(stockDir(env), 'Background.qml');
  const stock = readSmall(stockPath, MAX_QML);
  if (stock === null) throw new Error(`There is no ${stockPath}: this is not an Omarchy desktop with the shell background plugin. Nothing was written.`);
  const stockSha = sha256(stock);
  const patched = patchBackground(stock, stockSha);
  if (!patched.ok) throw new Error(`${patched.reason} Nothing was written.`);
  const files: Record<string, string> = { 'Background.qml': patched.source };
  for (const name of OWN_FILES) {
    const text = readSmall(join(env.sourceDir, name), MAX_QML);
    if (text === null) throw new Error(`This build has no ${join(env.sourceDir, name)}. Nothing was written.`);
    files[name] = text;
  }
  const stockManifest = readJson(join(stockDir(env), 'manifest.json'));
  const manifest = {
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    author: 'Bogen',
    description: 'Omarchy\'s background, with the current theme\'s own verified composition on each portrait screen',
    kinds: ['service'],
    entryPoints: { service: 'Background.qml' },
    omarchy: { clonedFrom: STOCK_ID },
    bogen: {
      plugin: 'portrait-background', patch: PATCH_VERSION, stockSha256: stockSha,
      ...(isObject(stockManifest) && typeof stockManifest.version === 'string' ? { stockVersion: stockManifest.version.slice(0, 32) } : {}),
      files: ownFileHashes(files),
    },
  };
  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
  files['NOTICE'] = [
    'Background.qml is derived at install time from the Omarchy background plugin installed on this machine',
    `(shell/plugins/background/Background.qml, sha256 ${stockSha}), which is MIT licensed:`,
    'https://github.com/basecamp/omarchy. Bogen\'s changes, PortraitMapping.qml and PortraitRuntime.js are MIT',
    'licensed as part of Bogen: https://github.com/marselnenaj/bogen.',
    '',
  ].join('\n');
  return { files, stockSha256: stockSha };
}

export interface Step { do: string; detail?: string }

export interface PlanResult {
  /** Whether the action would run. When false, `blockers` say why. */
  possible: boolean;
  applied: boolean;
  blockers: string[];
  steps: Step[];
  /** The exact commands it runs, for a person to check or run by hand. */
  commands: string[][];
  status: PluginStatus;
  backup?: string;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

async function backup(env: PortraitEnv, from: string): Promise<string> {
  await mkdir(backupsDir(env), { recursive: true, mode: 0o700 });
  let dest = join(backupsDir(env), stamp());
  for (let n = 2; exists(dest); n++) dest = join(backupsDir(env), `${stamp()}-${n}`);
  // Links are copied as links, never followed.
  cpSync(from, dest, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true });
  return dest;
}

/** Plugins dir resolved, and our target in it: neither may be a link out, and ours must not be a link at all. */
async function preparedTarget(env: PortraitEnv): Promise<string> {
  await mkdir(pluginsDir(env), { recursive: true });
  const real = realpathSync(pluginsDir(env));
  const target = join(real, PLUGIN_ID);
  if (exists(target) && lstatSync(target).isSymbolicLink()) throw new Error(`${target} is a link. Bogen does not write through it. Nothing was written.`);
  return target;
}

/**
 * Installs or updates the plugin's files. Plans only, unless `apply`. Refuses a folder of that name that is not
 * Bogen's, an install that would derive from an incompatible stock file, and replacing files the person edited unless
 * `force`. An existing copy is backed up first. Does not enable anything: that is `enablePlugin`.
 */
export async function installPlugin(env: PortraitEnv, options: { apply?: boolean; force?: boolean } = {}): Promise<PlanResult> {
  const status = pluginStatus(env);
  const blockers: string[] = [];
  const steps: Step[] = [];
  let built: PluginFiles | null = null;
  try {
    built = buildPlugin(env);
  } catch (e) {
    blockers.push((e as Error).message);
  }
  if (status.state === 'foreign') blockers.push(`${targetDir(env)} exists and is not Bogen's plugin. Bogen never writes over it.`);
  if (status.installed?.ours && status.installed.modified.length && !options.force) blockers.push(`You edited ${status.installed.modified.join(', ')} in ${targetDir(env)}. Replacing them needs --force; a backup is kept.`);
  const upToDate = Boolean(built && status.installed?.ours && !status.installed.outdated && !status.installed.modified.length);
  if (!blockers.length) {
    if (upToDate) steps.push({ do: 'Nothing to do: the installed plugin is this version, derived from the current stock file.' });
    else {
      if (status.installed?.ours) steps.push({ do: `Back up ${targetDir(env)}`, detail: `to ${backupsDir(env)}/<time>` });
      steps.push({ do: `Write ${Object.keys(built!.files).join(', ')} to ${targetDir(env)}`, detail: `Background.qml derived from ${join(stockDir(env), 'Background.qml')} (sha256 ${built!.stockSha256.slice(0, 12)}…); the stock file is only read` });
      if (status.enabled) steps.push({ do: 'The shell reloads the plugin on its own when its files change.' });
      else steps.push({ do: 'Nothing is enabled: every screen keeps Omarchy\'s background until `bogen omarchy portrait enable --apply`.' });
    }
  }
  const result: PlanResult = { possible: !blockers.length, applied: false, blockers, steps, commands: [], status };
  if (!options.apply || blockers.length || upToDate) return result;

  const target = await preparedTarget(env);
  const staging = join(dirname(target), `.${PLUGIN_ID}.bogen-new`);
  const old = join(dirname(target), `.${PLUGIN_ID}.bogen-old`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  for (const [name, text] of Object.entries(built!.files)) await atomicWrite(join(staging, name), text);
  if (exists(target)) {
    result.backup = await backup(env, target);
    await rm(old, { recursive: true, force: true });
    await rename(target, old);
  }
  await rename(staging, target);
  await rm(old, { recursive: true, force: true });
  await recordState(env, { installedAt: Date.now(), version: PLUGIN_VERSION, stockSha256: built!.stockSha256, ...(result.backup ? { backup: result.backup } : {}) });
  result.applied = true;
  result.status = pluginStatus(env);
  return result;
}

async function recordState(env: PortraitEnv, patch: Record<string, unknown>): Promise<void> {
  await mkdir(stateDir(env), { recursive: true, mode: 0o700 });
  const path = join(stateDir(env), 'install.json');
  let prev: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (isObject(raw)) prev = raw;
  } catch {
    /* first */
  }
  await atomicWrite(path, `${JSON.stringify({ ...prev, ...patch }, null, 2)}\n`);
}

/**
 * Enables the plugin through Omarchy's own `omarchy plugin enable`, which disables omarchy.background and records
 * that it should come back on disable. Refused beside another background clone, over a stock background the person
 * turned off, for a plugin that is not installed, or derived from a stock file that no longer patches.
 */
export async function enablePlugin(env: PortraitEnv, options: { apply?: boolean } = {}): Promise<PlanResult> {
  const status = pluginStatus(env);
  const blockers: string[] = [];
  if (!status.installed?.ours) blockers.push('The plugin is not installed: run `bogen omarchy portrait install --apply` first.');
  else if (status.installed.modified.includes('manifest.json')) blockers.push('Its manifest.json was edited by hand; Bogen does not enable a plugin it cannot vouch for.');
  if (status.conflicts.length) blockers.push(`Another clone of the background plugin is installed (${status.conflicts.map((c) => c.id).join(', ')}). Two clones fight over the background; Bogen does not enable its own beside one.`);
  if (status.stockDisabled && !status.enabled) blockers.push('omarchy.background is disabled in shell.json, so something else may draw the wallpaper. Bogen does not take over from it.');
  if (status.installed?.ours && status.installed.outdated && !status.stock.compatible) blockers.push(`The installed plugin was derived from another stock file, and the current one cannot be patched (${status.stock.reason}).`);
  const commands = [[env.shellBin, 'shell', 'rescanPlugins'], [env.omarchyBin, 'plugin', 'enable', PLUGIN_ID]];
  const steps: Step[] = status.enabled ? [{ do: 'Nothing to do: it is enabled.' }] : [
    { do: 'Rescan plugins so the shell knows the new folder' },
    { do: `Enable ${PLUGIN_ID}`, detail: 'Omarchy disables omarchy.background and brings it back when this plugin is disabled' },
  ];
  const result: PlanResult = { possible: !blockers.length, applied: false, blockers, steps, commands: status.enabled ? [] : commands, status };
  if (!options.apply || blockers.length || status.enabled) return result;
  for (const [bin, ...args] of commands) await run(bin!, args);
  await recordState(env, { enabledAt: Date.now() });
  result.applied = true;
  result.status = pluginStatus(env);
  return result;
}

/** Disables the plugin with `omarchy plugin disable`, which puts omarchy.background back. Files stay. */
export async function disablePlugin(env: PortraitEnv, options: { apply?: boolean } = {}): Promise<PlanResult> {
  const status = pluginStatus(env);
  const commands = [[env.omarchyBin, 'plugin', 'disable', PLUGIN_ID]];
  const result: PlanResult = { possible: true, applied: false, blockers: [], steps: status.enabled ? [{ do: `Disable ${PLUGIN_ID}`, detail: 'Omarchy enables omarchy.background again' }] : [{ do: 'Nothing to do: it is not enabled.' }], commands: status.enabled ? commands : [], status };
  if (!options.apply || !status.enabled) return result;
  for (const [bin, ...args] of commands) await run(bin!, args);
  await recordState(env, { disabledAt: Date.now() });
  result.applied = true;
  result.status = pluginStatus(env);
  return result;
}

/**
 * Puts back the newest backup of the plugin's folder, after backing up what is there now, so a rollback can be rolled
 * back. With no backup there is nothing to go back to; `removePlugin` takes the plugin away instead.
 */
export async function rollbackPlugin(env: PortraitEnv, options: { apply?: boolean } = {}): Promise<PlanResult> {
  const status = pluginStatus(env);
  const latest = status.backups[0];
  const blockers: string[] = [];
  if (!latest) blockers.push('There is no backup of an earlier version to go back to. To stop using the plugin: bogen omarchy portrait disable --apply.');
  if (status.state === 'foreign') blockers.push(`${targetDir(env)} is not Bogen's. Nothing was changed.`);
  const from = latest ? join(backupsDir(env), latest) : '';
  if (latest) {
    const m = readJson(join(from, 'manifest.json'));
    if (!isObject(m) || m.id !== PLUGIN_ID || !isObject(m.bogen) || m.bogen.plugin !== 'portrait-background') blockers.push(`The backup ${from} is not a copy of this plugin.`);
  }
  const result: PlanResult = { possible: !blockers.length, applied: false, blockers, steps: blockers.length ? [] : [{ do: `Back up ${targetDir(env)}` }, { do: `Restore ${from}` }], commands: [], status };
  if (!options.apply || blockers.length) return result;
  const target = await preparedTarget(env);
  const staging = join(dirname(target), `.${PLUGIN_ID}.bogen-new`);
  await rm(staging, { recursive: true, force: true });
  cpSync(from, staging, { recursive: true, dereference: false, verbatimSymlinks: true });
  if (exists(target)) {
    result.backup = await backup(env, target);
    await rm(target, { recursive: true, force: true });
  }
  await rename(staging, target);
  await rm(from, { recursive: true, force: true });
  await recordState(env, { rolledBackAt: Date.now(), restored: latest });
  result.applied = true;
  result.status = pluginStatus(env);
  return result;
}

/**
 * Takes the plugin's folder away, into a backup. Only when it is not enabled: with omarchy.background disabled and
 * this plugin gone, the desktop would have no background at all.
 */
export async function removePlugin(env: PortraitEnv, options: { apply?: boolean } = {}): Promise<PlanResult> {
  const status = pluginStatus(env);
  const blockers: string[] = [];
  if (!status.installed) blockers.push('It is not installed.');
  else if (!status.installed.ours) blockers.push(`${targetDir(env)} is not Bogen's. Nothing was changed.`);
  if (status.enabled) blockers.push('It is enabled. Disable it first (bogen omarchy portrait disable --apply), so omarchy.background comes back before its files go; otherwise the desktop would have no background.');
  const result: PlanResult = { possible: !blockers.length, applied: false, blockers, steps: blockers.length ? [] : [{ do: `Move ${targetDir(env)} to ${backupsDir(env)}/<time>` }], commands: [], status };
  if (!options.apply || blockers.length) return result;
  const target = await preparedTarget(env);
  result.backup = await backup(env, target);
  await rm(target, { recursive: true, force: true });
  await recordState(env, { removedAt: Date.now() });
  result.applied = true;
  result.status = pluginStatus(env);
  return result;
}

/** True when this machine can run the plugin at all: an Omarchy desktop with the shell background plugin. */
export function canRunHere(env: PortraitEnv): boolean {
  return isPlainDir(stockDir(env)) || isFile(join(stockDir(env), 'Background.qml'));
}
