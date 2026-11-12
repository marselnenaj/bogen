// Omarchy themes on disk: reading the installed ones, making a theme file from one, exporting a file as a theme
// folder or a .tar.gz, installing it into ~/.config/omarchy/themes, and applying it with `omarchy theme set`.
//
// Writes go to two places only: a folder or archive the person chose, and ~/.config/omarchy/themes/<name>. The stock
// themes under $OMARCHY_PATH are only read. `omarchy theme set` runs only from `apply` and `undoApply`, which only the
// editor calls, on a person's click.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createComponent, currentBranchId, findMain, getDesignBranch, importHtml, MAIN_BRANCH, newId, resolveInstanceRefs, type BogenDoc, type BogenNode, type NewNode } from '@bogen/core';
import { gitCommit, gitInit } from './git-mirror.ts';
import type { BogenServer } from './http/server.ts';
import {
  colorsToml, DEFAULT_COLORS, displayName, extraKeys, GENERATED_FILES, iconsThemeFor, isShellToken, META_KEY, PALETTE_KEYS,
  parseColorsToml, parseShellToml, resolvePalette, shellFromTokens, shellTokens, shellTokensFrom, THEME_FORMAT, themeFromTokens, themeSlug, themeTokens, tokenForKey, validThemeName,
  type ThemeColors, type ThemeMeta, type ThemeMode, type ThemeTarget,
} from './omarchy-theme.ts';
import { checksums, installScript, mobileProfile, packageReadme, themeManifest, type ManifestDisplay, type MobileProfile, type ThemeManifest } from './omarchy-mobile.ts';
import { extOf, MAX_VIDEO, probeVideo, readVideos, stemOf, VIDEO, VIDEO_MIME, videoAdvice, type ThemeVideo, type ThemeVideoKind } from './omarchy-videos.ts';
import { MOBILE_BOARD_NAMES, mobileBoards } from './templates/omarchy-mobile.ts';
import {
  aspectOf, aspectSlug, CANONICAL, classifyComposition, type CompositionLayer, DISPLAY_PRESETS, displayProblem, describeMonitor, displayLabel, LIMITS, needsOwnWallpaper, newThemeDisplays, orientationOf, parseMonitors, readDisplays, readWallpapers, resolveRequests, sizeLabel,
  sameShape, WALLPAPER_DONE, WALLPAPER_STATUS_TEXT, wallpaperComponentName, wallpaperSize, type DetectedDisplay, type DisplayRequest, type DisplaySize, type ThemeDisplay, type ThemeWallpaper, type WallpaperStatus,
} from './omarchy-displays.ts';
import { BOARD_NAMES, displayWallpaperBoard, imageBoardSize, LEGACY_PORTRAIT_LAYERS, PORTRAIT_PLACEHOLDER_LAYERS, PORTRAIT_PLACEHOLDER_TEXT, previewBoards, themeBoards, wallpaperFor, type DisplayWallpaperPlan, type ThemeImage, type ThemeScreen } from './templates/omarchy-theme.ts';
import { VERSION } from './version.ts';
import { atomicWrite, errorMessage, HttpError } from './util.ts';
import type { FileEntry } from './storage.ts';
import { candidateOf, refreshThemeIndex, resolveThemeProject, serialized, type ThemeProjectRow } from './theme-projects.ts';
import { ART_SIZE, collectionPreset, presetArt, presetColors, presetSource, type CollectionPreset } from './omarchy-collection.ts';
import { pluginStatus, portraitEnv, RUNTIME_FILE, shippedPortraits, runtimeManifest, type PluginStatus, type RuntimeWallpaperInput } from './omarchy-portrait-runtime.ts';

export interface ThemeEnv {
  /** The person's home: themes go to `<home>/.config/omarchy/themes`. */
  home: string;
  /** `$OMARCHY_PATH`, where the stock themes and the templates are. */
  omarchyPath: string;
  /** The command that applies a theme. Tests put a stand-in first on PATH. */
  bin: string;
  /** Where Bogen records the theme it replaced, for Undo apply. */
  stateFile: string;
  /** `$OMAMOBILE_PATH`, present on a phone running Omarchy Mobile. Its presence makes this machine a mobile host. */
  omamobilePath: string;
}

export function themeEnv(app: BogenServer, env: NodeJS.ProcessEnv = process.env): ThemeEnv {
  const omarchyPath = env.OMARCHY_PATH || '/usr/share/omarchy';
  return {
    home: env.HOME || homedir(),
    omarchyPath,
    bin: omarchyBin(omarchyPath, env.PATH),
    stateFile: join(app.options.home, 'omarchy-apply.json'),
    omamobilePath: env.OMAMOBILE_PATH || '/usr/share/omamobile',
  };
}

/** What this machine is, for themes: a phone runs Omarchy Mobile, anything else with Omarchy is a desktop. */
export function hostTarget(env: ThemeEnv): ThemeTarget {
  return isDir(env.omamobilePath) ? 'mobile' : 'desktop';
}

/**
 * Refuses a theme made for another kind of device, before anything is written or applied. A mobile theme carries
 * shell sizes, a portrait background and a device profile; installed on a computer it would look broken, and the other
 * way round. The phone installs its package with the package's own install.sh.
 */
export function assertTargetMatches(env: ThemeEnv, target: ThemeTarget, what: string): void {
  const host = hostTarget(env);
  if (target === host) return;
  throw new HttpError(409, target === 'mobile'
    ? `${what} is a mobile theme, and this machine is a desktop. Export it as a package and install it on the phone with its install.sh; nothing was written here.`
    : `${what} is a desktop theme, and this machine is an Omarchy Mobile phone. Make a mobile theme for it instead; nothing was written here.`);
}

/** `omarchy` from PATH; a service started outside a login shell may not have Omarchy's bin on it, so then its own. */
function omarchyBin(omarchyPath: string, path = ''): string {
  if (path.split(':').some((dir) => dir && isFile(join(dir, 'omarchy')))) return 'omarchy';
  const own = join(omarchyPath, 'bin', 'omarchy');
  return existsSync(own) ? own : 'omarchy';
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const userThemes = (env: ThemeEnv) => join(env.home, '.config', 'omarchy', 'themes');
const stockThemes = (env: ThemeEnv) => join(env.omarchyPath, 'themes');
const stateDir = (env: ThemeEnv) => join(env.home, '.local', 'state', 'omarchy', 'current');

export function onOmarchy(env: ThemeEnv): boolean {
  return existsSync(stockThemes(env)) || existsSync(join(env.home, '.config', 'omarchy'));
}

/**
 * Whether this machine is offered the Bogen collection: its presets are Omarchy desktop themes, so an Omarchy desktop
 * only. A Mac or Windows machine, or a phone running Omarchy Mobile, is not.
 */
export function collectionAvailable(env: ThemeEnv): boolean {
  return onOmarchy(env) && hostTarget(env) === 'desktop';
}

// ---------------------------------------------------------------- reading what is installed

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };
const MAX_IMAGE = 48 * 1024 * 1024;
const MAX_BACKGROUNDS = 24;

/** A directory entry that is a regular file and not a symlink: a theme from a repo could point one anywhere. */
function plainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export interface InstalledTheme {
  name: string;
  title: string;
  /** stock: in $OMARCHY_PATH only; user: in ~/.config only; overlay: a user folder over a stock theme of that name. */
  source: 'stock' | 'user' | 'overlay';
  mode: ThemeMode;
  /** A few colours for a swatch row: background, foreground, accent and four hues. */
  swatches: string[];
  backgrounds: number;
  current: boolean;
  /** Cloned by `omarchy theme install`, so Omarchy holds it to the rules for repositories. */
  fromRepo: boolean;
}

export function currentThemeName(env: ThemeEnv): string | null {
  try {
    return readFileSync(join(stateDir(env), 'theme.name'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** The folders a theme of this name is read from, stock first, as `omarchy theme set` stages them. */
function themeDirs(env: ThemeEnv, name: string): string[] {
  if (!validThemeName(name)) return [];
  return [join(stockThemes(env), name), join(userThemes(env), name)].filter(isDir);
}

function readColors(dirs: string[]): ThemeColors | null {
  for (const dir of [...dirs].reverse()) {
    const path = join(dir, 'colors.toml');
    if (plainFile(path)) return parseColorsToml(readFileSync(path, 'utf8'));
  }
  return null;
}

export function listThemes(env: ThemeEnv): InstalledTheme[] {
  const names = new Set([...list(stockThemes(env)), ...list(userThemes(env))].filter((n) => validThemeName(n) && !n.startsWith('.')));
  const current = currentThemeName(env);
  const out: InstalledTheme[] = [];
  for (const name of names) {
    const dirs = themeDirs(env, name);
    const colors = dirs.length ? readColors(dirs) : null;
    if (!colors) continue;
    const p = resolvePalette(colors.colors);
    const stock = isDir(join(stockThemes(env), name));
    const user = isDir(join(userThemes(env), name));
    const backgrounds = new Set(dirs.flatMap((d) => list(join(d, 'backgrounds')).filter((f) => IMAGE.test(f))));
    out.push({
      name, title: displayName(name), source: stock && user ? 'overlay' : stock ? 'stock' : 'user', mode: colors.mode ?? (p.background ? modeFromPalette(p) : 'dark'),
      swatches: [p.background!, p.foreground!, p.accent!, p.red!, p.yellow!, p.green!, p.blue!],
      backgrounds: backgrounds.size, current: name === current, fromRepo: user && isDir(join(userThemes(env), name, '.git')),
    });
  }
  return out.sort((a, b) => Number(b.current) - Number(a.current) || a.title.localeCompare(b.title));
}

function modeFromPalette(p: Record<string, string>): ThemeMode {
  const h = p.background!;
  const sum = [1, 3, 5].reduce((s, i) => s + parseInt(h.slice(i, i + 2), 16), 0);
  return sum > 382 ? 'light' : 'dark';
}

interface LoadedImage {
  name: string;
  bytes: Uint8Array;
  mime: string;
  /** Vector art of the Bogen collection: it goes into the file as an svg layer, not a stored picture. */
  svg?: { markup: string; width: number; height: number };
}

export interface LoadedTheme {
  name: string;
  colors: ThemeColors;
  backgrounds: LoadedImage[];
  unlock?: LoadedImage;
  /** Intros and loop wallpapers, Omarchy 4.5. */
  videos: LoadedVideo[];
  /** The theme's own shell.toml, `section.key` to value, when it ships one. */
  shell?: Record<string, string>;
  /** Files the theme ships besides colors.toml and images, which a new theme does not carry over. */
  left: string[];
  /**
   * Portrait compositions a Bogen export shipped and that can still be trusted (shippedPortraits): they come back as
   * the compositions of their shapes, never the placeholder of an undesigned one.
   */
  portraits: (LoadedImage & { aspect: string })[];
  /** It has a bogen-theme.json: Bogen made it, so its name is the person's own and gets no " Custom". */
  bogen: boolean;
}

/** Everything of an installed theme a file is made from: the palette, the backgrounds and the unlock logo. */
export function loadTheme(env: ThemeEnv, name: string): LoadedTheme {
  const dirs = themeDirs(env, name);
  if (!dirs.length) {
    const names = listThemes(env).map((t) => t.name);
    throw new HttpError(404, `There is no installed theme "${name}". Themes here: ${names.join(', ') || 'none'}.`);
  }
  const colors = readColors(dirs);
  if (!colors) throw new HttpError(422, `${name} has no colors.toml, so there is no palette to start from.`);
  const byName = new Map<string, string>();
  for (const dir of dirs) for (const f of list(join(dir, 'backgrounds'))) if (IMAGE.test(f) && plainFile(join(dir, 'backgrounds', f))) byName.set(f, join(dir, 'backgrounds', f));
  const read = (path: string, file: string): LoadedImage | null => {
    const size = statSync(path).size;
    if (size > MAX_IMAGE) return null;
    const ext = file.split('.').pop()!.toLowerCase();
    return { name: file, bytes: readFileSync(path), mime: MIME[ext] ?? 'image/png' };
  };
  const backgrounds = [...byName.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).slice(0, MAX_BACKGROUNDS)
    .map(([file, path]) => read(path, file)).filter((x): x is LoadedImage => Boolean(x));
  const unlockPath = [...dirs].reverse().map((d) => join(d, 'unlock.png')).find(plainFile);
  const unlock = unlockPath ? read(unlockPath, 'unlock.png') ?? undefined : undefined;
  // Omarchy 4.5: intros in backgrounds/intros/, paired with a still by name; loop wallpapers directly in backgrounds/.
  const videos: LoadedVideo[] = [];
  const readVideo = (path: string, file: string, kind: ThemeVideoKind) => {
    if (!plainFile(path) || statSync(path).size > MAX_VIDEO) return;
    const ext = extOf(file);
    videos.push({ kind, name: file, bytes: readFileSync(path), mime: VIDEO_MIME[ext]!, ...(kind === 'intro' ? { still: backgrounds.find((b) => stemOf(b.name) === stemOf(file))?.name } : {}) });
  };
  const seen = new Map<string, [string, ThemeVideoKind]>();
  for (const dir of dirs) {
    for (const f of list(join(dir, 'backgrounds'))) if (VIDEO.test(f)) seen.set(`loop/${f}`, [join(dir, 'backgrounds', f), 'loop']);
    for (const f of list(join(dir, 'backgrounds', 'intros'))) if (VIDEO.test(f)) seen.set(`intro/${f}`, [join(dir, 'backgrounds', 'intros', f), 'intro']);
  }
  for (const [key, [path, kind]] of [...seen.entries()].sort(([a], [b]) => a.localeCompare(b))) readVideo(path, key.slice(key.indexOf('/') + 1), kind);
  const shipped = new Set(dirs.flatMap((d) => list(d)));
  const left = [...shipped].filter((f) => !['colors.toml', 'backgrounds', 'unlock.png', 'preview.png', 'preview-unlock.png', 'icons.theme', '.git', 'shell.toml', 'displays', 'bogen-theme.json', 'README.md'].includes(f)).sort();
  const bogenDir = [...dirs].reverse().find((d) => plainFile(join(d, 'bogen-theme.json')));
  const portraits = bogenDir ? shippedPortraits(bogenDir).filter((p) => p.bytes.length <= MAX_IMAGE).slice(0, LIMITS.maxDisplays).map((p) => {
    const ext = p.file.split('.').pop()!.toLowerCase();
    return { name: p.file.split('/').pop()!, bytes: p.bytes, mime: MIME[ext] ?? 'image/png', aspect: p.aspect };
  }) : [];
  // A shell.toml the theme wrote by hand is its surface design: it comes in as the shell role tokens.
  const shellPath = [...dirs].reverse().map((d) => join(d, 'shell.toml')).find(plainFile);
  const shell = shellPath ? parseShellToml(readFileSync(shellPath, 'utf8')) : undefined;
  return { name, colors, backgrounds, ...(unlock ? { unlock } : {}), videos, ...(shell ? { shell } : {}), left, portraits, bogen: Boolean(bogenDir) };
}

interface LoadedVideo { kind: ThemeVideoKind; name: string; bytes: Uint8Array; mime: string; still?: string }

// ---------------------------------------------------------------- screens

/**
 * The monitors of this machine as `hyprctl monitors -j` reports them, checked, turned the way they are mounted and with
 * their logical size. Empty where there is no Hyprland, such as on a Mac: then a person picks a preset.
 */
export function detectDisplays(): Promise<DetectedDisplay[]> {
  return new Promise((done) => {
    execFile('hyprctl', ['monitors', '-j'], { timeout: 1500, maxBuffer: 1 << 20 }, (err, stdout) => done(err ? [] : parseMonitors(stdout)));
  });
}

const FALLBACK_SCREENS: ThemeScreen[] = [{ width: 3840, height: 2160 }, { width: 2560, height: 1600 }];

/** Full-size wallpaper sizes: each monitor's mode turned as mounted, each size once. */
export function screensOf(detected: readonly DetectedDisplay[]): ThemeScreen[] {
  const sizes = new Map<string, ThemeScreen>();
  for (const d of detected) sizes.set(`${d.pixels.width}x${d.pixels.height}`, d.pixels);
  return sizes.size ? [...sizes.values()].slice(0, 4) : FALLBACK_SCREENS;
}

/** The screens of this machine as `hyprctl` reports them, turned the way they are mounted. */
export async function screenSizes(): Promise<ThemeScreen[]> {
  return screensOf(await detectDisplays());
}

/** Whether the fonts Omarchy installs are here: its own icon font and the Nerd Font the bar's glyphs come from. */
export function barFonts(): Promise<boolean> {
  const has = (family: string) => new Promise<boolean>((done) => execFile('fc-list', ['-q', family], { timeout: 1500 }, (err) => done(!err)));
  return Promise.all([has('omarchy'), has('JetBrainsMono Nerd Font')]).then(([a, b]) => a && b, () => false);
}

/** Width and height from the header of a PNG, JPEG or WebP. Null for anything else. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (b.length > 10 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a')) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

// ---------------------------------------------------------------- making a theme file

export interface ThemeFileRun {
  /** An installed theme to start from. */
  from?: string;
  /** The theme's name. Defaults to "<the theme started from> Custom", which does not go over it, or "New theme". */
  name?: string;
  screens?: ThemeScreen[];
  /** This machine's monitors, for the portrait displays of a new desktop theme. Asked from hyprctl when left out. */
  detected?: DetectedDisplay[];
  /** Draw the bar with Omarchy's glyphs. Found out from the fonts on this machine when left out. */
  glyphs?: boolean;
  /** Desktop (the default) or mobile. A mobile theme is drawn at its profile's size and exports as a phone package. */
  target?: ThemeTarget;
  /** The phone profile of a mobile theme. Defaults to komodo, the only one so far. */
  profile?: string;
  /** Continue this theme file: nothing is made, the file is checked to be a theme and opened. */
  fileId?: string;
  /**
   * A preset of the Bogen collection (omarchy-collection.ts) to start from: its palette and its own landscape and
   * portrait art. Its project is the one started from it before; desktop only, on an Omarchy desktop.
   */
  preset?: string;
  /**
   * A separate new theme, on purpose (New theme, Duplicate as a new theme). Otherwise the request goes to the project
   * it means: the one theme file of that target and profile with that name, or started from that theme.
   */
  newProject?: boolean;
  /** Deprecated: `reuse: false` is `newProject: true`. */
  reuse?: boolean;
  /**
   * Called inside the one-at-a-time creation, right before a new theme file would be made (never when an existing
   * project is reused or continued): throws to refuse, and then nothing is made. Agents' sessions pass one that keeps
   * edit and redo runs, revisions and branches from turning into new files (mcp/tools-files.ts themeCreateGuard).
   */
  beforeCreate?: () => void;
  origin: string;
}

export interface ThemeFileResult {
  file_id: string;
  file_name: string;
  page_id: string;
  name: string;
  slug: string;
  target: ThemeTarget;
  profile?: string;
  boards: { id: string; name: string; width: number; height: number }[];
  tokens: number;
  /** Files of the theme started from that the new file does not carry. */
  left: string[];
  /** The file already there for this theme was opened; nothing was made. */
  reused?: boolean;
  /** Asked for a file that was brought into this project as a branch. */
  consolidated_from?: { file_id: string; branch_id: string };
  /** Portrait compositions carried over from the installed theme, by ratio. */
  portraits?: string[];
  /** The stable id of the logical theme. */
  project_id?: string;
  /** The branch checked out in the file: where edits go. */
  branch?: { id: string; name: string };
  /** For a reused file: what to do next without making another one. */
  next?: string;
}

/** Several theme files could be the one meant, or a new name sits beside themes from the same start: nothing was made. */
export interface ThemeChoice {
  needs_choice: true;
  candidates: ReturnType<typeof candidateOf>[];
  message: string;
  next: string;
}

export type ThemeCreateOutcome = ThemeFileResult | ThemeChoice;

export function isThemeChoice(out: ThemeCreateOutcome): out is ThemeChoice {
  return (out as ThemeChoice).needs_choice === true;
}

const THEME_PAGE = 'Theme';

interface PlannedBoard { name: string; x: number; y: number; width: number; height: number; background: string; html: string; components: string[] }

/** Writes the boards in order, so that each component exists before the boards that use it. One transaction. */
function writeThemeBoards(doc: BogenDoc, pageId: string, boards: PlannedBoard[]): { id: string; name: string; width: number; height: number }[] {
  const out: { id: string; name: string; width: number; height: number }[] = [];
  for (const b of boards) {
    const id = doc.insert(pageId, {
      type: 'frame', tag: 'main', name: b.name, artboard: true,
      style: { position: 'absolute', left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px`, display: 'flex', flexDirection: 'column', backgroundColor: b.background, overflow: 'hidden' },
    });
    doc.invalidate();
    const { nodes } = importHtml(b.html);
    resolveInstanceRefs(doc, nodes as NewNode[]);
    doc.insertMany(id, nodes);
    doc.invalidate();
    for (const name of b.components) {
      const main = doc.descendants(id).find((n) => n.name === name && n.type === 'frame' && !n.virtual);
      if (!main) throw new Error(`Template error: no layer "${name}" in ${b.name}.`);
      createComponent(doc, main.id, { name });
      doc.invalidate();
    }
    out.push({ id, name: b.name, width: b.width, height: b.height });
  }
  return out;
}

const REUSE_NEXT = 'This is the theme\'s existing project, opened rather than copied. Small edits continue here, on the branch that is checked out. For an alternative or a redo the person asked for, call design_branch_create: a branch inside this same file. Pass new_project: true only when the person asks for a separate new theme.';

/** Opens a theme file to continue it: nothing is made. Refuses a file that is not a theme. */
async function openThemeFile(app: BogenServer, fileId: string): Promise<ThemeFileResult> {
  const asked = app.requireFile(fileId);
  // A file brought into another project as a branch continues as that project: its work is in the branch now.
  const into = asked.theme?.consolidatedInto;
  if (into && app.storage.get(into.fileId) && into.fileId !== fileId) {
    const out = await openThemeFile(app, into.fileId);
    return { ...out, consolidated_from: { file_id: asked.id, branch_id: into.branchId }, next: `${asked.name} (${asked.id}) was brought into this theme as the branch ${into.branchId}; it is not a project of its own any more. ${REUSE_NEXT}` };
  }
  const entry = asked;
  if (entry.kind === 'brand') throw new HttpError(422, `${entry.name} is a brand, not an Omarchy theme file.`);
  const room = await app.rooms.get(entry.id);
  const meta = themeMeta(room.doc);
  if (!meta) throw new HttpError(422, `${entry.name} is not an Omarchy theme file. Nothing was changed.`);
  refreshThemeIndex(app.storage, entry.id, room.doc);
  const pageId = room.doc.getPages().find((p) => p.name === THEME_PAGE)?.id ?? room.doc.getPages()[0]?.id ?? '';
  const branchId = currentBranchId(room.doc);
  let branchName = branchId;
  try {
    branchName = getDesignBranch(room.doc, branchId).name;
  } catch { /* the id stands in */ }
  const target = meta.target ?? 'desktop';
  return {
    file_id: entry.id, file_name: app.storage.get(entry.id)?.name ?? entry.name, page_id: pageId, name: meta.name, slug: themeSlug(meta.name) ?? '', target,
    ...(meta.profile && target === 'mobile' ? { profile: meta.profile } : {}), boards: [], tokens: room.doc.getTokens().length, left: [], reused: true,
    ...(meta.project ? { project_id: meta.project } : {}), branch: { id: branchId, name: branchName }, next: REUSE_NEXT,
  };
}

/** The theme dirs of an installed theme, and whether Bogen made it, without reading its pictures. */
function installedKind(env: ThemeEnv, name: string): { bogen: boolean } | null {
  const dirs = themeDirs(env, name);
  return dirs.length ? { bogen: dirs.some((d) => plainFile(join(d, 'bogen-theme.json'))) } : null;
}

/**
 * The theme file a request means: the one given by id, the one existing project it names or started from, or a new
 * one. Several plausible files are a choice for the caller, never the newest picked. One request at a time per server,
 * so that the same request sent twice at once makes one file; a request that fails after its file was made leaves none.
 */
export function createThemeFile(app: BogenServer, env: ThemeEnv, run: ThemeFileRun): Promise<ThemeCreateOutcome> {
  return serialized(app, () => resolveThemeFile(app, env, run));
}

/** Several projects could be the one meant: nothing was made, and the caller asks the person. */
function themeChoice(found: { candidates: ThemeProjectRow[]; reason: string }): ThemeChoice {
  return {
    needs_choice: true, candidates: found.candidates.map(candidateOf), message: `${found.reason} Nothing was made.`,
    next: 'Ask the person which theme to continue, or continue the one they named: call again with its file_id. For an alternative inside it, open it and call design_branch_create. Pass new_project: true only when the person asks for a separate new theme. Never pick the newest one on your own.',
  };
}

async function resolveThemeFile(app: BogenServer, env: ThemeEnv, run: ThemeFileRun): Promise<ThemeCreateOutcome> {
  if (run.fileId) return openThemeFile(app, run.fileId);
  if (run.preset) return resolvePresetFile(app, env, run);
  const target: ThemeTarget = run.target ?? 'desktop';
  const profile = target === 'mobile' ? mobileProfile(run.profile) : undefined;
  const newProject = run.newProject === true || run.reuse === false;
  const installed = run.from ? installedKind(env, run.from) : null;
  // No such theme: the same answer as loading it, before anything is looked up or made.
  if (run.from && !installed) loadTheme(env, run.from);
  // A theme Bogen made is the person's own: opened again it keeps its name, and installing it asks before going over it.
  const own = Boolean(installed?.bogen) && !newProject;
  const given = run.name?.trim() || undefined;
  let title = given ?? (run.from ? (own ? displayName(run.from) : `${displayName(run.from)} ${profile ? 'Mobile' : 'Custom'}`) : profile ? 'New mobile theme' : 'New theme');
  if (!newProject) {
    const found = await resolveThemeProject(app, { ...(run.from ? { from: run.from, fromBogen: Boolean(installed?.bogen) } : {}), ...(given ? { name: given } : {}), defaultName: title, target, ...(profile ? { profile: profile.id } : {}) });
    if (found.kind === 'reuse') return openThemeFile(app, found.row.file_id);
    if (found.kind === 'choose') return themeChoice(found);
    if (found.unindexed) throw new HttpError(503, `Bogen is still reading ${found.unindexed} older theme files to find this theme's project. Nothing was made; ask again.`);
  }
  // A name Bogen chose is not taken twice: a second deliberate copy is "… Custom 2", not another "… Custom".
  if (!given) title = untakenTitle(app, title, target);
  // The last word before anything is made, still inside the lock: a refusal here leaves no file.
  run.beforeCreate?.();
  return makeThemeFile(app, run, { title, target, profile, loaded: run.from ? loadTheme(env, run.from) : null });
}

/** A title whose folder name no theme file of the target has yet: "Kiln", else "Kiln 2", and so on. */
function untakenTitle(app: BogenServer, title: string, target: ThemeTarget): string {
  const taken = new Set(app.storage.list().filter((e) => e.theme && e.theme.target === target).map((e) => e.theme!.slug));
  let out = title;
  for (let n = 2; taken.has(themeSlug(out)) && n < 100; n++) out = `${title} ${n}`;
  return out;
}

/**
 * A preset of the Bogen collection, started on a person's click. Like an installed theme: the one project started
 * from it is opened again (edits and branches live there), several are a choice, and only none, or new_project,
 * makes a file. The file is an ordinary theme from the preset's palette, with its landscape art as the Wallpaper and
 * its portrait art as the 9:16 composition. Refused on a machine that is not an Omarchy desktop, before anything is
 * looked up or made.
 */
async function resolvePresetFile(app: BogenServer, env: ThemeEnv, run: ThemeFileRun): Promise<ThemeCreateOutcome> {
  const preset = collectionPreset(run.preset!);
  if (run.from || run.name || (run.target && run.target !== 'desktop') || run.profile) {
    throw new HttpError(400, `${preset.name} is a desktop preset of the Bogen collection: it starts under its own name, from its own palette and art. Rename it in the theme afterwards. Nothing was made.`);
  }
  if (!collectionAvailable(env)) {
    throw new HttpError(409, hostTarget(env) === 'mobile'
      ? `${preset.name} is an Omarchy desktop theme, and this machine is an Omarchy Mobile phone. Nothing was made.`
      : `${preset.name} is an Omarchy desktop theme, and this machine does not run Omarchy. Nothing was made.`);
  }
  const from = presetSource(preset.id);
  if (run.newProject !== true && run.reuse !== false) {
    const found = await resolveThemeProject(app, { from, target: 'desktop' });
    if (found.kind === 'reuse') return openThemeFile(app, found.row.file_id);
    if (found.kind === 'choose') return themeChoice(found);
    if (found.unindexed) throw new HttpError(503, `Bogen is still reading ${found.unindexed} older theme files to find this theme's project. Nothing was made; ask again.`);
  }
  // Read and checked before anything is made: art that has not arrived, or is not the size it should be, makes no file.
  const loaded = presetTheme(preset);
  const title = untakenTitle(app, preset.name, 'desktop');
  run.beforeCreate?.();
  return makeThemeFile(app, run, { title, target: 'desktop', profile: undefined, loaded });
}

/** A preset as a loaded theme: what an installed one gives, from the catalog's palette and art. */
function presetTheme(preset: CollectionPreset): LoadedTheme {
  const art = presetArt(preset);
  for (const orientation of ['landscape', 'portrait'] as const) {
    const file = art[orientation];
    const want = ART_SIZE[orientation];
    const size = file.svg ?? imageSize(file.bytes);
    if (!size || size.width !== want.width || size.height !== want.height) {
      throw new HttpError(500, `The collection's ${file.name} is ${size ? `${size.width} × ${size.height}` : 'not a picture Bogen can read'}, not ${want.width} × ${want.height}. Nothing was made.`);
    }
  }
  return {
    name: presetSource(preset.id), colors: presetColors(preset), backgrounds: [art.landscape], videos: [], left: [],
    portraits: [{ ...art.portrait, aspect: '9:16' }], bogen: false,
  };
}

/** A new file holding a theme: from an installed one, or from Bogen's own palette. */
async function makeThemeFile(app: BogenServer, run: ThemeFileRun, input: { title: string; target: ThemeTarget; profile: MobileProfile | undefined; loaded: LoadedTheme | null }): Promise<ThemeFileResult> {
  const { title, target, profile, loaded } = input;
  // Omarchy's own advice for a variant of a theme is a copy under a new name, such as catppuccin-custom.
  const slug = themeSlug(title) ?? 'theme';
  const colors: ThemeColors = loaded?.colors ?? { colors: DEFAULT_COLORS, raw: {}, mode: 'dark' };
  // A phone's screen is its profile's, not this machine's monitors.
  const detected = profile ? [] : run.detected ?? (await detectDisplays());
  const screens = profile ? [profile.panel] : run.screens ?? screensOf(detected);
  const glyphs = profile ? false : run.glyphs ?? (await barFonts());

  const put = async (img: LoadedImage): Promise<ThemeImage> => {
    // Vector art becomes layers of the file, editable like any other, not a stored picture.
    if (img.svg) return { src: '', width: img.svg.width, height: img.svg.height, name: img.name, svg: img.svg.markup };
    const asset = await app.storage.putAsset(img.bytes, img.mime);
    const size = imageSize(img.bytes) ?? screens[0]!;
    return { src: asset.src, width: size.width, height: size.height, name: img.name };
  };
  const backgrounds = loaded ? await Promise.all(loaded.backgrounds.map(put)) : [];
  const unlock = loaded?.unlock ? await put(loaded.unlock) : undefined;
  // The portrait compositions a Bogen export shipped, verified: each comes back as its shape's composition.
  const portraits = loaded && !profile ? await Promise.all(loaded.portraits.map(put)) : [];

  const entry = app.createFile(`${title} · ${profile ? 'Omarchy mobile theme' : 'Omarchy theme'}`);
  try {
    return await fillThemeFile(app, run, entry, { ...input, slug, colors, detected, screens, glyphs, backgrounds, unlock, portraits });
  } catch (e) {
    // Nothing half made stays behind: the file goes again, and the request can simply be sent again.
    await app.deleteFile(entry.id).catch((err) => console.error(`bogen: could not remove the unfinished theme file ${entry.id}: ${errorMessage(err)}`));
    throw e;
  }
}

async function fillThemeFile(
  app: BogenServer, run: ThemeFileRun, entry: FileEntry,
  input: { title: string; target: ThemeTarget; profile: MobileProfile | undefined; loaded: LoadedTheme | null; slug: string; colors: ThemeColors; detected: DetectedDisplay[]; screens: ThemeScreen[]; glyphs: boolean; backgrounds: ThemeImage[]; unlock: ThemeImage | undefined; portraits: ThemeImage[] },
): Promise<ThemeFileResult> {
  const { title, target, profile, loaded, slug, colors, detected, screens, glyphs, backgrounds, unlock, portraits } = input;
  const room = await app.rooms.get(entry.id);
  const { doc } = room;
  const project = newId();
  const meta: ThemeMeta = {
    name: title, format: THEME_FORMAT, target, ...(profile ? { profile: profile.id } : {}), project,
    ...(colors.mode ? { mode: colors.mode } : {}), ...(loaded ? { from: loaded.name } : {}),
  };
  const extra = extraKeys(colors);
  if (Object.keys(extra).length) meta.extra = extra;
  // Every new theme designs the shell's surfaces too, desktop and mobile alike: they become shell.toml.
  const tokens = [...themeTokens(colors), ...(loaded?.shell ? shellTokensFrom(loaded.shell) : shellTokens())];
  // A desktop theme is designed for portrait monitors too: this machine's, or a 1080 x 1920 one where it has none.
  const displays: ThemeDisplay[] = profile ? [] : newThemeDisplays(detected);
  // A shape the theme shipped a composition for keeps a display of it, even where this machine has no such monitor.
  for (const p of portraits) {
    if (displays.length >= LIMITS.maxDisplays || displays.some((d) => sameShape(d, p))) continue;
    const size = wallpaperSize(p);
    const logical = { width: Math.round(size.width / 2), height: Math.round(size.height / 2) };
    if (!displayProblem(logical)) displays.push({ ...logical, source: 'custom' });
  }
  const wallpapers = profile ? [] : planWallpapers(displays, detected, [...portraits, ...backgrounds]);
  if (displays.length) {
    meta.displays = displays;
    // Every composition Bogen generates is a quiet placeholder until someone designs it, new theme or imported: a
    // landscape picture is not cropped into a portrait, and no palette pattern stands in for a design.
    meta.wallpapers = wallpapers.map((w) => ({ aspect: aspectOf(w.shape), component: wallpaperFor(w.shape), placeholder: !w.image }));
  }
  const plan: PlannedBoard[] = profile
    ? mobileBoards({ name: title, profile, ...(backgrounds.length ? { backgrounds } : {}) })
    : themeBoards({ name: title, slug, screens, glyphs, displays, wallpapers, ...(backgrounds.length ? { backgrounds } : {}), ...(unlock ? { unlock } : {}) });
  let pageId = '';
  let written: ThemeFileResult['boards'] = [];
  doc.transact(() => {
    for (const t of tokens) doc.setToken(t.name, t.kind, t.value);
    doc.meta.set(META_KEY, meta);
    const page = doc.getPages()[0];
    if (page) {
      doc.renamePage(page.id, THEME_PAGE);
      pageId = page.id;
    } else pageId = doc.createPage(THEME_PAGE);
    written = writeThemeBoards(doc, pageId, plan);
    // What each composition and the landscape Wallpaper look like now, to tell later whether either was designed on.
    if (meta.wallpapers?.length) {
      meta.wallpapers = meta.wallpapers.map((w) => ({ ...w, ...fingerprints(doc, w.component) }));
      doc.meta.set(META_KEY, meta);
    }
  }, run.origin);
  // The theme's videos, carried as they are: an intro stays with the Background board of its still.
  if (loaded?.videos.length) {
    const videos: ThemeVideo[] = [];
    for (const v of loaded.videos) {
      const asset = await app.storage.putAsset(v.bytes, v.mime);
      const board = v.kind === 'intro' && v.still ? written.find((b) => b.name.endsWith(` · ${v.still}`))?.id : undefined;
      videos.push({ kind: v.kind, name: v.name, src: asset.src, ...(board ? { board } : {}), facts: probeVideo(v.bytes, extOf(v.name)) });
    }
    doc.transact(() => doc.meta.set(META_KEY, { ...meta, videos }), run.origin);
  }
  // Indexed before the next request is let through, so that it finds this file.
  refreshThemeIndex(app.storage, entry.id, doc);
  return {
    file_id: entry.id, file_name: entry.name, page_id: pageId, name: title, slug, target, ...(profile ? { profile: profile.id } : {}), boards: written, tokens: tokens.length, left: loaded?.left ?? [],
    ...(portraits.length ? { portraits: wallpapers.filter((w) => w.image && portraits.includes(w.image)).map((w) => aspectOf(w.shape)) } : {}),
    project_id: project, branch: { id: MAIN_BRANCH, name: 'Main' },
  };
}

// ---------------------------------------------------------------- reading a theme file

export function themeMeta(doc: BogenDoc): ThemeMeta | null {
  const m = doc.meta.get(META_KEY) as Partial<ThemeMeta> | undefined;
  if (!m || typeof m !== 'object' || typeof m.name !== 'string') return null;
  const out: ThemeMeta = { name: m.name };
  // Format 1 had no target: every such file is a desktop theme.
  out.format = typeof m.format === 'number' && m.format >= 1 ? Math.floor(m.format) : 1;
  out.target = m.target === 'mobile' ? 'mobile' : 'desktop';
  if (out.target === 'mobile') out.profile = typeof m.profile === 'string' && /^[a-z0-9-]{1,32}$/.test(m.profile) ? m.profile : 'komodo';
  if (m.mode === 'dark' || m.mode === 'light') out.mode = m.mode;
  const videos = readVideos(m.videos);
  if (videos.length) out.videos = videos;
  if (typeof m.icons === 'string' && /^[\w.+-]{1,64}$/.test(m.icons)) out.icons = m.icons;
  if (typeof m.from === 'string') out.from = m.from;
  if (typeof m.project === 'string' && /^[0-9a-z]{4,40}$/.test(m.project)) out.project = m.project;
  if (m.extra && typeof m.extra === 'object') out.extra = Object.fromEntries(Object.entries(m.extra).filter(([k, v]) => /^[A-Za-z0-9_-]+$/.test(k) && typeof v === 'string' && /^[A-Za-z0-9#(),._+/% -]*$/.test(v)));
  if (out.target === 'desktop') {
    const displays = readDisplays(m.displays);
    if (displays.length) out.displays = displays;
    const wallpapers = readWallpapers(m.wallpapers);
    if (wallpapers.length) out.wallpapers = wallpapers;
  }
  return out;
}

/**
 * A file is a theme only when it says so in its meta, with a target. Three palette tokens alone no longer make one:
 * a design file that imported the palette (such as a set of phone screens) would otherwise be offered a desktop export
 * and install. Such a file is a candidate, and the person makes it a theme on purpose (`adoptTheme`).
 */
export function isThemeFile(doc: BogenDoc): boolean {
  return themeMeta(doc) !== null;
}

/** Has the palette tokens but no theme meta: may become a theme when the person says so, never by itself. */
export function isThemeCandidate(doc: BogenDoc): boolean {
  if (themeMeta(doc)) return false;
  const names = new Set(doc.getTokens().map((t) => t.name));
  return ['background', 'foreground', 'accent'].every((k) => names.has(tokenForKey(k)));
}

/** Makes a candidate file a theme of the given target, keeping its tokens. The person's choice, from the editor. */
export function adoptTheme(doc: BogenDoc, input: { name: string; target: ThemeTarget; profile?: string }, origin: string): ThemeMeta {
  if (themeMeta(doc)) throw new HttpError(409, 'This file is a theme already.');
  if (!isThemeCandidate(doc)) throw new HttpError(422, 'This file has no --omarchy-background, --omarchy-foreground and --omarchy-accent tokens to make a theme from.');
  if (!themeSlug(input.name)) throw new HttpError(400, `"${input.name}" does not give a folder name Omarchy accepts.`);
  const profile = input.target === 'mobile' ? mobileProfile(input.profile).id : undefined;
  const meta: ThemeMeta = { name: input.name.trim().slice(0, 64), format: THEME_FORMAT, target: input.target, ...(profile ? { profile } : {}), project: newId() };
  doc.transact(() => doc.meta.set(META_KEY, meta), origin);
  return meta;
}

interface DisplayBoards { size: DisplaySize; desktop?: BogenNode; launcher?: BogenNode; lock?: BogenNode; boot?: BogenNode }

interface Boards {
  backgrounds: BogenNode[]; unlock?: BogenNode; desktop?: BogenNode; boot?: BogenNode; phones: BogenNode[];
  /** Every "Preview · …" board, the 1920 x 1080 ones and those of other displays. */
  previews: BogenNode[];
  /** Previews of displays besides 1920 x 1080, by size, in the order of the canvas. */
  displays: DisplayBoards[];
  /** Boards of compositions for shapes that are not landscape. */
  displayBackgrounds: BogenNode[];
}

const sizeOf = (n: BogenNode): DisplaySize => ({ width: Number.parseFloat(n.style.width ?? '0') || 0, height: Number.parseFloat(n.style.height ?? '0') || 0 });

function findBoards(doc: BogenDoc): Boards {
  const tops = doc.getPages().flatMap((p) => doc.getChildren(p.id)).filter((n) => n.artboard && !n.hidden);
  const x = (n: BogenNode) => Number.parseFloat(n.style.left ?? '0') || 0;
  const y = (n: BogenNode) => Number.parseFloat(n.style.top ?? '0') || 0;
  const displays = new Map<string, DisplayBoards>();
  const kinds = { desktop: 'desktop', launcher: 'launcher', 'lock screen': 'lock', 'boot unlock': 'boot' } as const;
  for (const n of [...tops].sort((a, b) => y(a) - y(b) || x(a) - x(b))) {
    const m = BOARD_NAMES.display.exec(n.name);
    if (!m) continue;
    const size = { width: Number(m[3]), height: Number(m[4]) };
    const key = `${size.width}x${size.height}`;
    if (!displays.has(key)) displays.set(key, { size });
    const entry = displays.get(key)!;
    entry[kinds[m[1] as keyof typeof kinds]] ??= n;
  }
  return {
    backgrounds: tops.filter((n) => BOARD_NAMES.background.test(n.name)).sort((a, b) => x(a) - x(b)),
    unlock: tops.find((n) => BOARD_NAMES.unlock.test(n.name)),
    desktop: tops.find((n) => BOARD_NAMES.desktop.test(n.name) || MOBILE_BOARD_NAMES.preview.test(n.name)),
    boot: tops.find((n) => BOARD_NAMES.boot.test(n.name)),
    phones: tops.filter((n) => MOBILE_BOARD_NAMES.phone.test(n.name)),
    previews: tops.filter((n) => /^Preview · /.test(n.name)),
    displays: [...displays.values()],
    displayBackgrounds: tops.filter((n) => BOARD_NAMES.displayBackground.test(n.name)).sort((a, b) => x(a) - x(b)),
  };
}

// ---------------------------------------------------------------- displays and their compositions

/**
 * The compositions a new theme's displays need, one per shape that is not landscape. A picture of that shape among the
 * theme's own backgrounds is used as it is; otherwise the composition is a quiet placeholder that says it is not
 * designed, at the size of the largest monitor of that shape, or 3840 on its long side.
 */
function planWallpapers(displays: readonly DisplaySize[], detected: readonly DetectedDisplay[], images: readonly ThemeImage[]): DisplayWallpaperPlan[] {
  const out: DisplayWallpaperPlan[] = [];
  for (const d of displays) {
    if (!needsOwnWallpaper(d) || out.some((w) => aspectOf(w.shape) === aspectOf(d))) continue;
    const image = images.find((img) => sameShape(img, d));
    out.push({ shape: d, size: image ? imageBoardSize(image, wallpaperSize(d, detected.map((m) => m.pixels))) : wallpaperSize(d, detected.map((m) => m.pixels)), ...(image ? { image } : {}) });
  }
  return out;
}

/** The visible layers of a composition, as the pure classifier reads them. */
function compositionLayers(doc: BogenDoc, mainId: string): CompositionLayer[] {
  const inside = visibleDescendants(doc, mainId);
  const generated = new Set(inside.filter(generatedLayer).map((n) => n.id));
  return inside.map((n) => {
    const ancestors = doc.ancestors(n.id).filter((a) => a !== mainId && inside.some((x) => x.id === a));
    return {
      id: n.id, name: n.name, type: n.type, style: n.style as Record<string, string | undefined>, ...(n.src ? { src: n.src } : {}),
      label: n.attrs?.alt || n.name, generated: generated.has(n.id) || ancestors.some((a) => generated.has(a)), ancestors,
    };
  });
}

/** A layer Bogen generated as a stand-in: the quiet placeholder's note, or the palette arcs older files have. */
function generatedLayer(n: BogenNode): boolean {
  if (PORTRAIT_PLACEHOLDER_LAYERS.includes(n.name) || LEGACY_PORTRAIT_LAYERS.includes(n.name)) return true;
  return n.type === 'text' && typeof n.text === 'string' && n.text.trim() === PORTRAIT_PLACEHOLDER_TEXT;
}

/**
 * The landscape Wallpaper when it has nothing of its own: Bogen's plain field, or the palette arcs of older files.
 * Omarchy needs a picture, so it is exported as the plain field, and the problem is said here every time, never in
 * the picture.
 */
export function landscapeProblems(doc: BogenDoc): string[] {
  const main = mainNamed(doc, 'Wallpaper');
  if (!main) return [];
  const layers = compositionLayers(doc, main.id);
  if (layers.some((l) => !l.generated)) return [];
  const legacy = layers.some((l) => /^Arc |^Accent dot$/.test(l.name));
  return [`The landscape background (the Wallpaper on Background 1) is ${legacy ? 'the palette arc stand-in Bogen drew before' : 'Bogen\'s plain placeholder field'}, not a design: compose it from the theme's own identity, or put the theme's own picture on it. Until then the desktop shows a plain field of the theme's background colours.`];
}

/** Layers under a node that show: a hidden layer hides everything in it. */
function visibleDescendants(doc: BogenDoc, id: string): BogenNode[] {
  const out: BogenNode[] = [];
  const walk = (parent: string) => {
    for (const child of doc.getChildren(parent)) {
      if (child.hidden) continue;
      out.push(child);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}

/** What a component's main looks like, as a short hash: it changes when anyone designs on it. */
function fingerprintOf(doc: BogenDoc, mainId: string): string {
  const parts = [doc.getNode(mainId), ...doc.descendants(mainId)].filter((n): n is BogenNode => Boolean(n))
    .map((n) => [n.name, n.type, n.hidden ? 1 : 0, n.style, n.src ?? '', n.text ?? '', n.svg ?? '', n.instanceOf ?? '']);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

function mainNamed(doc: BogenDoc, name: string): BogenNode | undefined {
  return findMain(doc.source, name);
}

function fingerprints(doc: BogenDoc, component: string): Pick<ThemeWallpaper, 'fingerprint' | 'landscapeFingerprint'> {
  const own = mainNamed(doc, component);
  const landscape = mainNamed(doc, 'Wallpaper');
  return { ...(own ? { fingerprint: fingerprintOf(doc, own.id) } : {}), ...(landscape ? { landscapeFingerprint: fingerprintOf(doc, landscape.id) } : {}) };
}

export interface WallpaperState {
  aspect: string;
  orientation: string;
  component: string;
  board?: { id: string; name: string; width: number; height: number };
  status: WallpaperStatus;
  /** What the status means, and what to do about it. */
  reason: string;
  /** For artwork: the picture's src and size, as read from its own header. */
  image?: { src: string; width?: number; height?: number };
}

/**
 * Sizes of stored pictures, by src. An asset's name is the hash of its bytes, so its size never changes: kept for the
 * life of the server, the oldest dropped past a few hundred, so that asking about a theme on every token change does
 * not read its pictures again. A picture that is not there is not remembered, as it may be stored later.
 */
const ASSET_SIZES = new Map<string, DisplaySize | null>();
const ASSET_SIZES_MAX = 512;

/** A picture's size from its header, for a bogen-asset src; null when Bogen cannot read it (AVIF, SVG, remote). */
async function assetSize(app: BogenServer, src: string | undefined): Promise<DisplaySize | null> {
  if (!src?.startsWith('bogen-asset:')) return null;
  if (ASSET_SIZES.has(src)) return ASSET_SIZES.get(src)!;
  const asset = await app.storage.readAsset(src.slice('bogen-asset:'.length)).catch(() => null);
  if (!asset) return null;
  const size = imageSize(asset.bytes);
  if (ASSET_SIZES.size >= ASSET_SIZES_MAX) ASSET_SIZES.delete(ASSET_SIZES.keys().next().value!);
  ASSET_SIZES.set(src, size);
  return size;
}


/**
 * Whether each non-landscape composition is designed. A picture of the composition's own shape, or a composition
 * with layers someone made, is done. A picture of another shape filling it (a landscape wallpaper cropped into a
 * portrait, by any tool), a picture whose size Bogen cannot read, Bogen's quiet placeholder, or the palette arcs older
 * files carry (recoloured or not), still needs its own design and says so every time it is asked: it is never shown,
 * exported or installed as done.
 */
export async function wallpaperStates(app: BogenServer, doc: BogenDoc, meta: ThemeMeta | null): Promise<WallpaperState[]> {
  const boards = findBoards(doc);
  const records = new Map((meta?.wallpapers ?? []).map((w) => [w.component, w]));
  const shapes = new Map<string, DisplaySize>();
  for (const d of [...(meta?.displays ?? []), ...boards.displays.map((b) => b.size)]) if (needsOwnWallpaper(d) && !shapes.has(wallpaperFor(d))) shapes.set(wallpaperFor(d), d);
  const out: WallpaperState[] = [];
  for (const [component, shape] of shapes) {
    const base = { aspect: aspectOf(shape), orientation: orientationOf(shape), component };
    const main = mainNamed(doc, component);
    const board = main ? boards.displayBackgrounds.find((b) => b.id === main.id || doc.ancestors(main.id).includes(b.id)) : undefined;
    const where = board ? { board: { id: board.id, name: board.name, ...sizeOf(board) } } : {};
    const target = board ? sizeOf(board) : shape;
    const fix = `Design a ${base.orientation} composition for ${base.aspect} on "${board?.name ?? component}", or give it artwork made at ${base.aspect} (omarchy_theme_displays assign_artwork, or Use artwork in the theme dialog).`;
    if (!main) {
      out.push({ ...base, status: 'missing', reason: `There is no "${component}" component, so the ${base.orientation} previews fill with the background colour. Bring it back with Undo or the file's History. Adding the same display again does not help: its previews are still there, so it is skipped.` });
      continue;
    }
    const layers = compositionLayers(doc, main.id);
    const sizes = new Map<string, DisplaySize | null>();
    for (const l of layers) if (l.type === 'image' && l.src && !sizes.has(l.src)) sizes.set(l.src, await assetSize(app, l.src));
    const verdict = classifyComposition(layers, target, (src) => (src ? sizes.get(src) ?? null : null));
    if (verdict.status === 'unverified') {
      out.push({ ...base, ...where, status: 'unverified', image: { src: verdict.layer.src ?? '' }, reason: `"${verdict.layer.label}" fills the ${base.orientation} composition, but Bogen cannot read its size (it reads PNG, JPEG, WebP and GIF), so it cannot tell whether it is ${base.aspect} or a picture of another shape cropped. ${fix}` });
    } else if (verdict.status === 'mismatch') {
      out.push({ ...base, ...where, status: 'mismatch', image: { src: verdict.layer.src ?? '', ...verdict.size }, reason: `"${verdict.layer.label}" fills the ${base.orientation} composition at ${verdict.size.width} × ${verdict.size.height} (${aspectOf(verdict.size)}), not ${base.aspect}: the ${base.orientation} previews show it cropped, which is not a ${base.orientation} design, and the export leaves it out. Show it whole inside a layout of the shape (object-fit: contain, or a band of its own ratio), or ${fix[0]!.toLowerCase()}${fix.slice(1)}` });
    } else if (verdict.status === 'artwork') {
      out.push({ ...base, ...where, status: 'artwork', image: { src: verdict.layer.src ?? '', ...verdict.size }, reason: `Shows its own ${base.aspect} artwork, "${verdict.layer.label}" (${verdict.size.width} × ${verdict.size.height}), exported as it is.` });
    } else if (verdict.status === 'composed') {
      const plates = verdict.contained.length ? ` It shows ${verdict.contained.map((l) => `"${l.label}"`).join(', ')} whole inside the layout; the export renders the composition, never ${verdict.contained.length === 1 ? 'that picture' : 'those pictures'} on ${verdict.contained.length === 1 ? 'its' : 'their'} own.` : '';
      out.push({ ...base, ...where, status: 'composed', reason: `Designed for ${base.aspect}: ${verdict.own} layer${verdict.own === 1 ? '' : 's'} of its own.${plates}` });
    } else {
      const rec = records.get(component);
      out.push({ ...base, ...where, status: 'needs-design', reason: `${verdict.legacy ? 'This is the palette arc stand-in Bogen drew before, not a design for this theme.' : rec?.placeholder === false ? 'Nothing is designed for this shape.' : 'This is Bogen\'s placeholder: nothing is designed for this shape yet.'} ${fix} Compose it from the theme's own identity (its backgrounds, logo, type and accent), not a generic pattern, and keep the subject and any text clear of the bar at the top and the lock field in the middle. Until then portrait screens keep the theme background.` });
    }
  }
  return out;
}

/**
 * A boot logo wider or taller than a display: Plymouth draws unlock.png at its own size, centred, so on that display it
 * is cut at the edges. Said for every such display, every time, since no preview may hide it.
 */
export function bootLogoProblems(doc: BogenDoc): string[] {
  const boards = findBoards(doc);
  if (!boards.unlock) return [];
  const logo = sizeOf(boards.unlock);
  const out: string[] = [];
  for (const d of [...(boards.boot ? [{ size: CANONICAL }] : []), ...boards.displays.filter((x) => x.boot)]) {
    const room = { width: d.size.width - 80, height: d.size.height - 120 };
    if (logo.width > room.width || logo.height > room.height) {
      out.push(`The boot unlock logo is ${sizeLabel(logo)}, and Plymouth draws it at that size on the ${displayLabel(d.size)} display too, so its edges are cut there. Make unlock.png at most ${Math.max(1, room.width)} px wide to fit every display of this theme.`);
    }
  }
  return out;
}

/** Sizes that have previews already: 1920 x 1080 and every other display's boards. */
function displaySizesIn(doc: BogenDoc, meta: ThemeMeta | null): DisplaySize[] {
  const boards = findBoards(doc);
  const out: DisplaySize[] = [];
  const add = (s: DisplaySize) => { if (!out.some((o) => o.width === s.width && o.height === s.height)) out.push(s); };
  if (boards.desktop) add(CANONICAL);
  for (const d of boards.displays) add(d.size);
  for (const d of meta?.displays ?? []) if (boards.displays.some((b) => b.size.width === d.width && b.size.height === d.height)) add(d);
  return out;
}

export interface AddDisplaysResult {
  added: { width: number; height: number; orientation: string; boards: { id: string; name: string }[] }[];
  /** New compositions, one per new shape. */
  wallpapers: { component: string; board: { id: string; name: string; width: number; height: number }; status: WallpaperStatus }[];
  skipped: { width: number; height: number; reason: string }[];
  page_id: string;
}

/**
 * Adds previews of more desktop displays to a theme file that exists: four boards per size, laid out for it, below
 * what is there, and a composition for each new shape that is not landscape. Nothing on the canvas is changed, moved
 * or recoloured, no page or file is made, and a size the theme has already is skipped. One transaction, one undo step.
 * A mobile theme is refused: a phone is its profile, not a display.
 */
export async function addThemeDisplays(doc: BogenDoc, input: { requests: DisplayRequest[]; detected: DetectedDisplay[]; glyphs: boolean }, transact: (fn: () => void) => void): Promise<AddDisplaysResult> {
  const meta = themeMeta(doc);
  if (!meta) throw new HttpError(422, 'This file is not an Omarchy theme. Make one with omarchy_theme_create.');
  if (meta.target === 'mobile') throw new HttpError(409, `${meta.name} is a mobile theme: a phone is drawn at its profile, and has no desktop displays. Desktop displays, portrait monitors included, are for a desktop theme.`);
  if (!input.requests.length) throw new HttpError(400, 'Say which displays to add: a preset, a detected monitor, or a width and height.');
  const have = displaySizesIn(doc, meta);
  let resolved: ReturnType<typeof resolveRequests>;
  try {
    resolved = resolveRequests(input.requests, have, input.detected);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const boards = findBoards(doc);
  const pageId = (boards.desktop && doc.pageOf(boards.desktop.id)) ?? doc.getPages().find((p) => p.name === THEME_PAGE)?.id ?? doc.getPages()[0]?.id;
  if (!pageId) throw new HttpError(422, 'This theme has no page to add the displays to.');
  const out: AddDisplaysResult = { added: [], wallpapers: [], skipped: resolved.skipped.map((s) => ({ ...s.size, reason: s.reason })), page_id: pageId };
  if (!resolved.add.length) return out;

  // Below everything on the page, at the left edge of what is there.
  const tops = doc.getChildren(pageId).filter((n) => n.artboard);
  const num = (v: string | undefined) => Number.parseFloat(v ?? '0') || 0;
  const bottom = tops.reduce((m, n) => Math.max(m, num(n.style.top) + num(n.style.height)), 0);
  const left = tops.length ? Math.min(...tops.map((n) => num(n.style.left))) : 0;
  const name = meta.name;
  const slug = themeSlug(name) ?? 'theme';
  const unlockBoard = boards.unlock;
  const unlock = unlockBoard ? sizeOf(unlockBoard) : { width: 800, height: 188 };
  const hasMain = (n: string) => Boolean(mainNamed(doc, n));
  const plans: { boards: PlannedBoard[]; size: DisplaySize; wallpaper?: { component: string; plan: DisplayWallpaperPlan } }[] = [];
  const newShapes = new Set<string>();
  let y = bottom + 160 * 4;
  for (const r of resolved.add) {
    const component = wallpaperFor(r.size);
    let wallpaper: { component: string; plan: DisplayWallpaperPlan } | undefined;
    let x = left;
    const row: PlannedBoard[] = [];
    if (component !== 'Wallpaper' && !hasMain(component) && !newShapes.has(component)) {
      newShapes.add(component);
      const plan = { shape: r.size, size: wallpaperSize(r.size, input.detected.map((d) => d.pixels)) };
      row.push(displayWallpaperBoard(plan, x, y));
      x += plan.size.width + 160;
      wallpaper = { component, plan };
    }
    const sources = { wallpaper: hasMain(component) || newShapes.has(component) ? component : null, barComponent: hasMain('Bar'), unlockComponent: hasMain('Unlock logo'), unlock };
    row.push(...previewBoards({ name, slug, glyphs: input.glyphs, display: r.size, x, y, sources }));
    const height = Math.max(...row.map((b) => b.height));
    y += height + 160 * 4;
    plans.push({ boards: row, size: r.size, ...(wallpaper ? { wallpaper } : {}) });
  }

  transact(() => {
    for (const p of plans) {
      const written = writeThemeBoards(doc, pageId, p.boards);
      const previews = written.filter((b) => /^Preview · /.test(b.name));
      out.added.push({ ...p.size, orientation: orientationOf(p.size), boards: previews.map((b) => ({ id: b.id, name: b.name })) });
      if (p.wallpaper) {
        const board = written.find((b) => !/^Preview · /.test(b.name))!;
        out.wallpapers.push({ component: p.wallpaper.component, board, status: 'needs-design' });
      }
    }
    const records = new Map((meta.wallpapers ?? []).map((w) => [w.component, w]));
    // On a theme that exists the composition is always a stand-in: its landscape design may be anything by now.
    for (const w of out.wallpapers) records.set(w.component, { aspect: aspectOf(plans.find((p) => p.wallpaper?.component === w.component)!.size), component: w.component, placeholder: true, ...fingerprints(doc, w.component) });
    const displays = [...(meta.displays ?? [])];
    for (const r of resolved.add) if (!displays.some((d) => d.width === r.size.width && d.height === r.size.height)) displays.push({ ...r.size, source: r.source, ...(r.monitor ? { monitor: r.monitor } : {}) });
    doc.meta.set(META_KEY, { ...(doc.meta.get(META_KEY) as object), displays: displays.slice(0, LIMITS.maxDisplays), wallpapers: [...records.values()] });
  });
  return out;
}

/**
 * Gives a non-landscape composition artwork of its own: a picture already stored in Bogen (asset_upload, or an upload
 * in the editor). The composition's layers are hidden, not deleted, so they come back with a click; the picture goes
 * in over them, filling the shape. Its previews follow, and the export ships the picture's own bytes.
 */
export async function assignDisplayArtwork(app: BogenServer, doc: BogenDoc, input: { aspect: string; src: string; name?: string }, transact: (fn: () => void) => void): Promise<WallpaperState> {
  const meta = themeMeta(doc);
  if (!meta) throw new HttpError(422, 'This file is not an Omarchy theme.');
  if (meta.target === 'mobile') throw new HttpError(409, `${meta.name} is a mobile theme: its backgrounds are on its Background boards, not desktop displays.`);
  const states = await wallpaperStates(app, doc, meta);
  const state = states.find((w) => w.aspect === input.aspect);
  if (!state) throw new HttpError(404, `This theme has no ${input.aspect} composition. Its shapes: ${states.map((w) => w.aspect).join(', ') || 'none; add a portrait display first'}.`);
  const main = mainNamed(doc, state.component);
  if (!main || !state.board) throw new HttpError(404, state.reason);
  // Everything is checked before anything changes: the picture must be stored, readable and of the composition's shape.
  if (!/^bogen-asset:[0-9a-f]{16,64}\.(png|jpe?g|webp|gif)$/.test(input.src)) throw new HttpError(400, 'The artwork is a PNG, JPEG, WebP or GIF stored in Bogen: a bogen-asset: src from asset_upload or an upload in the theme dialog. Bogen reads the size of those, which it checks against the shape; AVIF and SVG it cannot check, so they are not taken. Nothing was changed.');
  const asset = await app.storage.readAsset(input.src.slice('bogen-asset:'.length));
  if (!asset) throw new HttpError(404, `There is no stored picture ${input.src}. Nothing was changed.`);
  const size = imageSize(asset.bytes);
  if (!size) throw new HttpError(422, `Bogen cannot read the size of ${input.src}, so it cannot check that it is ${input.aspect}. Nothing was changed.`);
  const target = { width: state.board.width, height: state.board.height };
  if (!sameShape(size, target)) {
    throw new HttpError(422, `That picture is ${size.width} × ${size.height} (${aspectOf(size)}), and this composition is ${input.aspect} (${target.width} × ${target.height}). Cropping a picture of another shape into it is not a ${state.orientation} design, so it is not taken. Make the artwork at ${input.aspect}, such as ${target.width} × ${target.height}, keeping the subject and any text clear of the bar and the lock field, then assign it. Nothing was changed.`);
  }
  const label = (input.name?.trim() || `${state.orientation}-${input.aspect.replace(':', 'x')}`).replace(/[^\w .+-]+/g, '').slice(0, 60) || 'artwork';
  transact(() => {
    for (const child of doc.getChildren(main.id)) if (!child.hidden) doc.updateFields(child.id, { hidden: true });
    doc.insert(main.id, { type: 'image', tag: 'img', name: label, src: input.src, attrs: { alt: label }, style: { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover' } });
  });
  return (await wallpaperStates(app, doc, themeMeta(doc))).find((w) => w.component === state.component)!;
}

export interface DisplayInfo {
  width: number; height: number; orientation: string; label: string; source?: string; monitor?: string;
  /** The component its previews show. */
  wallpaper: string;
  boards: { id: string; name: string }[];
}

/** The theme's displays, for the dialog and agents: the 1920 x 1080 previews, then the others, with their boards. */
export function themeDisplays(doc: BogenDoc, meta: ThemeMeta | null): DisplayInfo[] {
  const boards = findBoards(doc);
  const out: DisplayInfo[] = [];
  if (boards.desktop && meta?.target !== 'mobile') {
    const own = boards.previews.filter((b) => /^Preview · (desktop|launcher|lock screen|boot unlock)$/.test(b.name));
    out.push({ ...CANONICAL, orientation: 'landscape', label: `Landscape ${sizeLabel(CANONICAL)} (preview.png)`, wallpaper: 'Wallpaper', boards: own.map((b) => ({ id: b.id, name: b.name })) });
  }
  for (const d of boards.displays) {
    const rec = meta?.displays?.find((m) => m.width === d.size.width && m.height === d.size.height);
    const list = [d.desktop, d.launcher, d.lock, d.boot].filter((b): b is BogenNode => Boolean(b));
    const label = displayLabel(d.size);
    out.push({ ...d.size, orientation: orientationOf(d.size), label: `${label[0]!.toUpperCase()}${label.slice(1)}${rec?.monitor ? ` (${rec.monitor})` : ''}`, ...(rec ? { source: rec.source } : {}), ...(rec?.monitor ? { monitor: rec.monitor } : {}), wallpaper: wallpaperFor(d.size), boards: list.map((b) => ({ id: b.id, name: b.name })) });
  }
  return out;
}

/** What a person can add, for the dialog: presets, and this machine's monitors with why one cannot be used. */
export function displayChoices(doc: BogenDoc, detected: readonly DetectedDisplay[]): { presets: { id: string; label: string; note: string; present: boolean }[]; monitors: { name: string; label: string; width: number; height: number; usable: boolean; reason?: string; present: boolean }[] } {
  const have = displaySizesIn(doc, themeMeta(doc));
  const present = (s: DisplaySize) => have.some((h) => h.width === s.width && h.height === s.height);
  return {
    presets: DISPLAY_PRESETS.map((p) => ({ id: p.id, label: p.label, note: p.note, present: present(p) })),
    monitors: detected.map((d) => ({ name: d.name, label: describeMonitor(d), ...d.logical, usable: d.usable, ...(d.reason ? { reason: d.reason } : {}), present: present(d.logical) })),
  };
}

/** What a person reads about the portrait background plugin on this machine: never more than it does. */
export interface PortraitPluginSummary {
  state: PluginStatus['state'];
  /** Whether stock Omarchy's background plugin can be patched here; false on a Mac, a phone or a changed Omarchy. */
  available: boolean;
  enabled: boolean;
  summary: string;
  next: string[];
}

export function portraitPlugin(env: ThemeEnv): PortraitPluginSummary {
  const st = pluginStatus(portraitEnv({ ...process.env, HOME: env.home, OMARCHY_PATH: env.omarchyPath }));
  return { state: st.state, available: st.stock.compatible, enabled: st.enabled, summary: st.summary, next: st.next };
}

export interface DisplayRuntime {
  plugin: PortraitPluginSummary;
  /** Each monitor of this machine, and what it would show of this theme once it is exported, installed and applied. */
  screens: { name: string; width: number; height: number; orientation: string; shows: string; reason?: string }[];
  /** Compositions that are designed and would be listed in displays/portrait-runtime.json. */
  ready: string[];
  /** Compositions that are not, and so are never shown: their screens keep the theme background. */
  incomplete: { aspect: string; status: WallpaperStatus }[];
}

/**
 * The runtime side of a theme file's displays, said plainly: what each monitor here would show, and why a portrait
 * one would keep the theme background. A composition that is not designed is never counted, whatever the plugin.
 */
export function displayRuntime(env: ThemeEnv, states: readonly WallpaperState[], detected: readonly DetectedDisplay[]): DisplayRuntime {
  const plugin = portraitPlugin(env);
  const screens = detected.filter((d) => d.usable).map((d) => {
    const base = { name: d.name, width: d.logical.width, height: d.logical.height, orientation: d.orientation };
    if (d.orientation === 'landscape') return { ...base, shows: 'the theme background' };
    const st = states.find((s) => { const [a, b] = s.aspect.split(':').map(Number); return Boolean(a && b) && sameShape(d.logical, { width: a!, height: b! }); });
    if (!st) return { ...base, shows: 'the theme background, cropped', reason: `The theme has no composition of this shape (${aspectOf(d.logical)}).` };
    if (!WALLPAPER_DONE.has(st.status)) return { ...base, shows: 'the theme background, cropped', reason: `The ${st.aspect} composition ${WALLPAPER_STATUS_TEXT[st.status].toLowerCase()}: it is never shown until it is designed.` };
    if (!plugin.enabled) return { ...base, shows: 'the theme background, cropped', reason: `The ${st.aspect} composition is designed, but ${plugin.available ? 'the portrait background plugin is not enabled' : 'the portrait background plugin cannot run here'}. ${plugin.summary}` };
    return { ...base, shows: `the ${st.aspect} composition, once the theme is exported, installed and applied` };
  });
  return { plugin, screens, ready: states.filter((s) => WALLPAPER_DONE.has(s.status)).map((s) => s.aspect), incomplete: states.filter((s) => !WALLPAPER_DONE.has(s.status)).map((s) => ({ aspect: s.aspect, status: s.status })) };
}

/** Said with every desktop export and in the dialog, so nobody expects more of Omarchy than it does. */
export const DISPLAY_RUNTIME_NOTE = 'Stock Omarchy shows one background on every screen, cropped to fill each one. A portrait screen shows this theme\'s own composition only with Bogen\'s portrait background plugin installed and enabled (bogen omarchy portrait install, then enable), and only a composition that is designed: a placeholder is never shown or exported, and that screen keeps the theme background. The compositions go in displays/, outside backgrounds/, with displays/portrait-runtime.json saying which are ready.';

/**
 * Colours a preview shows that the export would not write: a board that draws with a token outside the theme's own
 * (`--om-accent` beside `--omarchy-accent`), or with a colour typed in. Each names the layer and both values, so
 * "the preview is green, the theme is acid" is caught before anything is installed.
 */
export function themeConsistency(doc: BogenDoc): string[] {
  const tokens = new Map(doc.getTokens().map((t) => [t.name, t]));
  const theme = (name: string) => name.startsWith('omarchy-');
  const boards = findBoards(doc);
  // Every preview, the portrait ones too, and the compositions they show: a portrait preview that drifts from the
  // palette is as wrong as a landscape one.
  const checked = [...new Map([...boards.phones, ...(boards.desktop ? [boards.desktop] : []), ...boards.previews, ...boards.displayBackgrounds].map((b) => [b.id, b])).values()];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const board of checked) {
    for (const node of [board, ...doc.descendants(board.id)]) {
      for (const [prop, value] of Object.entries(node.style)) {
        if (!/color|background|border|fill|stroke|outline/i.test(prop) || typeof value !== 'string') continue;
        for (const m of value.matchAll(/var\(--([\w-]+)/g)) {
          const name = m[1]!;
          if (theme(name) || seen.has(name)) continue;
          const t = tokens.get(name);
          if (!t || t.kind !== 'color') continue;
          seen.add(name);
          // Which theme role it shadows, when the name says so: om-accent is accent.
          const role = name.replace(/^[a-z]+-/, '');
          const own = tokens.get(tokenForKey(role.replace(/-/g, '_')));
          out.push(own
            ? `"${board.name}" draws with --${name} (${t.value}), but the theme exports ${role} as ${own.value} from --${own.name}. Use var(--${own.name}) on the board, or set --${own.name} to the colour you mean.`
            : `"${board.name}" draws with --${name} (${t.value}), which is not a theme token: the exported theme cannot carry it.`);
        }
      }
    }
  }
  return out;
}

/** A board that is only an image, as a theme loaded from disk makes it, ships that image as it was. */
function soleImage(doc: BogenDoc, board: BogenNode): BogenNode | null {
  const inside = visibleDescendants(doc, board.id);
  const images = inside.filter((n) => n.type === 'image');
  if (images.length !== 1 || inside.some((n) => n.type !== 'image' && n.type !== 'frame') || inside.length > 2) return null;
  return images[0]!.src?.startsWith('bogen-asset:') ? images[0]! : null;
}

// ---------------------------------------------------------------- export

export interface ThemeFileOut { path: string; bytes: Uint8Array; /** A script that runs: 0755 in an archive. */ executable?: boolean }

export interface ThemeExport {
  name: string;
  slug: string;
  mode: ThemeMode;
  target: ThemeTarget;
  profile?: MobileProfile;
  manifest: ThemeManifest;
  files: ThemeFileOut[];
  /** Files Omarchy makes from colors.toml when the theme is applied. */
  generated: string[];
  problems: string[];
  /** What a person should know that is not a fault, such as what Omarchy does with portrait screens. */
  notes: string[];
}

const enc = new TextEncoder();

function safeName(name: string): string {
  return name.replace(/[^\w.+-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').toLowerCase().slice(0, 60) || 'background';
}

function readme(name: string, slug: string, out: ReturnType<typeof themeFromTokens>, backgrounds: string[], displays: ManifestDisplay[] = []): string {
  const map = new Map(out.entries);
  const portrait = displays.length ? [
    '## Other displays',
    '',
    `The theme was also designed for ${displays.map((d) => `${d.orientation} ${d.size.replace('x', ' × ')}`).join(', ')}. Their previews and compositions are in displays/:`,
    '',
    ...displays.flatMap((d) => [d.preview ? `- ${d.preview}` : '', d.background ? `- ${d.background}` : d.wallpaper !== 'landscape' ? `- The ${d.orientation} composition is not designed yet (${d.wallpaper}), so none is shipped: portrait screens keep the theme background.` : ''].filter(Boolean)),
    '',
    'Stock Omarchy shows one background on every screen, cropped to fill it, and does not read displays/. With the Bogen portrait background plugin (`bogen omarchy portrait install --apply`, then `enable --apply`), each portrait screen shows the composition of its shape listed in displays/portrait-runtime.json; every other screen keeps the theme background.',
    '',
  ] : [];
  return [
    `# ${name}`,
    '',
    `An [Omarchy](https://omarchy.org) theme, ${out.mode}, with an accent of \`${map.get('accent') ?? ''}\` on \`${map.get('background') ?? ''}\`. Made in [Bogen](https://github.com/marselnenaj/bogen).`,
    '',
    '![The theme on a desktop](preview.png)',
    '',
    '## Install',
    '',
    '```sh',
    `omarchy theme install https://github.com/<you>/omarchy-${slug}-theme`,
    '```',
    '',
    `That clones it as ${slug} and applies it. Switch back any time with the theme picker or \`omarchy theme set <name>\`, and get updates with \`omarchy theme update\`.`,
    '',
    `It ships colors.toml, ${backgrounds.length} background${backgrounds.length === 1 ? '' : 's'}, the boot unlock logo and the previews. Omarchy writes the terminal, editor, bar and app colours from colors.toml when you apply it.`,
    '',
    ...portrait,
  ].join('\n');
}

export function generatedFiles(env: ThemeEnv): string[] {
  const dir = join(env.omarchyPath, 'default', 'themed');
  const found = list(dir).filter((f) => f.endsWith('.tpl')).map((f) => f.slice(0, -4));
  return found.length ? found : [...GENERATED_FILES];
}

/** Every file of the theme, rendered and written in memory. Nothing touches the disk here. */
export async function exportTheme(app: BogenServer, env: ThemeEnv, fileId: string, override: { name?: string; mode?: ThemeMode } = {}): Promise<ThemeExport> {
  const room = await app.rooms.get(app.requireFile(fileId).id);
  const { doc } = room;
  const meta = themeMeta(doc);
  if (!meta) {
    throw new HttpError(422, isThemeCandidate(doc)
      ? 'This file has an Omarchy palette but is not a theme yet, so it does not say whether it is for a desktop or a phone. Make it one in the editor (Make it a theme) or with omarchy_theme_create.'
      : 'This file is not an Omarchy theme. Make one with omarchy_theme_create.');
  }
  const target = meta.target ?? 'desktop';
  const profile = target === 'mobile' ? mobileProfile(meta.profile) : undefined;
  const name = override.name?.trim() || meta.name;
  const slug = themeSlug(name);
  if (!slug) throw new HttpError(400, `"${name}" does not give a folder name Omarchy accepts: use letters, digits, dashes or dots.`);
  const out = themeFromTokens(doc.getTokens(), { ...meta, ...(override.mode ? { mode: override.mode } : {}) });
  const files: ThemeFileOut[] = [{ path: 'colors.toml', bytes: enc.encode(colorsToml(out)) }];
  const shell = shellFromTokens(doc.getTokens());
  if (shell.toml) files.push({ path: 'shell.toml', bytes: enc.encode(shell.toml) });
  const accent = new Map(out.entries).get('accent');
  files.push({ path: 'icons.theme', bytes: enc.encode(`${meta.icons ?? iconsThemeFor(accent ?? '#7aa2f7')}\n`) });

  const boards = findBoards(doc);
  const problems = [...out.problems, ...shell.problems, ...themeConsistency(doc), ...(profile ? [] : [...bootLogoProblems(doc), ...landscapeProblems(doc)])];
  const render = async (node: BogenNode, options: { scale?: number; transparent?: boolean } = {}) => (await app.renderer.screenshot(doc, { nodeIds: [node.id] }, { format: 'png', ...options })).bytes;
  const original = async (node: BogenNode) => {
    const img = soleImage(doc, node);
    if (!img) return null;
    const asset = await app.storage.readAsset(img.src!.slice('bogen-asset:'.length));
    return asset ? { bytes: asset.bytes, ext: img.src!.split('.').pop()!, name: img.attrs?.alt ?? img.name } : null;
  };
  const backgrounds: string[] = [];
  const fileOfBoard = new Map<string, { file: string; kept: boolean }>();
  for (const [i, board] of boards.backgrounds.entries()) {
    const kept = await original(board);
    const label = board.name.replace(BOARD_NAMES.background, '').replace(/^\s*\d*\s*·?\s*/, '');
    let file: string;
    let bytes: Uint8Array;
    if (kept && IMAGE.test(kept.name)) {
      // An image from the theme keeps its name, which is also where Omarchy's sorted list puts it.
      file = safeName(kept.name);
      bytes = kept.bytes;
    } else {
      file = `${i + 1}-${safeName(label.replace(/\s*×\s*/g, 'x')) || 'background'}.png`.replace(/\.png\.png$/, '.png');
      if (!file.endsWith('.png')) file = file.replace(/\.(jpe?g|webp|gif|bmp)$/i, '') + '.png';
      bytes = await render(board);
    }
    for (let n = 2; backgrounds.includes(file); n++) file = file.replace(/(-\d+)?(\.\w+)$/, `-${n}$2`);
    backgrounds.push(file);
    fileOfBoard.set(board.id, { file, kept: Boolean(kept && IMAGE.test(kept.name)) });
    files.push({ path: `backgrounds/${file}`, bytes });
  }
  // Omarchy 4.5 videos: an intro under backgrounds/intros/ with its still's name, a loop wallpaper beside the stills.
  for (const video of meta.videos ?? []) {
    const asset = await app.storage.readAsset(video.src.slice('bogen-asset:'.length));
    if (!asset) {
      problems.push(`${video.name} is not on this computer any more, so it is left out.`);
      continue;
    }
    if (asset.bytes.length > MAX_VIDEO) {
      problems.push(`${video.name} is larger than ${MAX_VIDEO / 1024 / 1024} MB and is left out.`);
      continue;
    }
    const ext = extOf(video.name);
    if (video.kind === 'loop') {
      let file = safeName(video.name);
      if (!VIDEO.test(file)) file = `${stemOf(file)}.${ext}`;
      for (let n = 2; backgrounds.includes(file); n++) file = file.replace(/(-\d+)?(\.\w+)$/, `-${n}$2`);
      backgrounds.push(file);
      files.push({ path: `backgrounds/${file}`, bytes: asset.bytes });
      continue;
    }
    const still = video.board ? fileOfBoard.get(video.board) : undefined;
    if (!still) {
      problems.push(`The intro ${video.name} has no Background board to end on any more, so it is left out: Omarchy plays an intro only with the still of the same name.`);
      continue;
    }
    if (!still.kept) problems.push(`The still for the intro ${video.name} was redrawn in Bogen; the video still ends on the original picture. It is exported as backgrounds/intros/${stemOf(still.file)}.${ext}.`);
    const board = boards.backgrounds.find((b) => b.id === video.board);
    const size = board ? { width: Number.parseFloat(board.style.width ?? '0'), height: Number.parseFloat(board.style.height ?? '0') } : undefined;
    problems.push(...videoAdvice(video, size && size.width && size.height ? size : undefined));
    files.push({ path: `backgrounds/intros/${stemOf(still.file)}.${ext}`, bytes: asset.bytes });
  }
  if (!backgrounds.length) problems.push('There is no artboard named Background, so the theme has no background: Omarchy says "No background was found" when it is applied.');
  if (boards.desktop) {
    // The stock previews are 1800 x 1012, which the theme picker expects: 1800 wide with the height rounded down. The
    // renderer rounds, so the scale is a hair under 1800 / width to keep 1012.5 from becoming 1013.
    const w = Number.parseFloat(boards.desktop.style.width ?? '') || 1920;
    files.push({ path: 'preview.png', bytes: await render(boards.desktop, { scale: (1800 - 0.1) / w }) });
  }
  else problems.push(`There is no "${profile ? 'Preview · mobile' : 'Preview · desktop'}" artboard, so there is no preview.png: the theme picker shows the first background instead.`);
  if (profile) {
    for (const b of boards.backgrounds) {
      const w = Number.parseFloat(b.style.width ?? '0');
      const h = Number.parseFloat(b.style.height ?? '0');
      if (w && h && (w < h) !== (profile.panel.width < profile.panel.height)) problems.push(`"${b.name}" is ${w} × ${h}, but ${profile.device} is ${profile.panel.width} × ${profile.panel.height}: on the phone it would be cropped.`);
    }
  }
  if (boards.unlock && !profile) {
    const kept = await original(boards.unlock);
    files.push({ path: 'unlock.png', bytes: kept?.ext === 'png' ? kept.bytes : await render(boards.unlock, { transparent: true }) });
  }
  if (boards.boot && !profile) files.push({ path: 'preview-unlock.png', bytes: await render(boards.boot) });
  const notes: string[] = [];
  const displays: ManifestDisplay[] = [];
  if (!profile) {
    // Other displays: each one's desktop preview, and each shape's own composition, under displays/. preview.png stays
    // the 1920 x 1080 one, which is what the theme picker is made for.
    const states = await wallpaperStates(app, doc, meta);
    const backgroundOf = new Map<string, string>();
    const runtime: RuntimeWallpaperInput[] = [];
    for (const st of states) {
      if (!WALLPAPER_DONE.has(st.status)) problems.push(`The ${st.orientation} ${st.aspect} background needs its own design (${WALLPAPER_STATUS_TEXT[st.status].toLowerCase()}). ${st.reason}`);
      const board = st.board ? boards.displayBackgrounds.find((b) => b.id === st.board!.id) : undefined;
      // Only a designed composition is shipped. A placeholder, a picture of another shape, or one of a size Bogen
      // cannot read is not, whatever path an older export gave it: nothing can mistake it for this shape's design.
      if (!board || !WALLPAPER_DONE.has(st.status)) {
        runtime.push({ aspect: st.aspect, orientation: st.orientation, status: st.status, reason: st.reason });
        continue;
      }
      // Only artwork, a picture of exactly this shape filling it, ships its own bytes. A composition, a picture shown
      // whole inside a layout of the shape included, ships as a render of the composition: never the source picture.
      const asset = st.status === 'artwork' && st.image?.src?.startsWith('bogen-asset:') ? await app.storage.readAsset(st.image.src.slice('bogen-asset:'.length)) : null;
      const kept = asset ? { bytes: asset.bytes, ext: st.image!.src.split('.').pop()! } : null;
      const stem = `displays/background-${st.orientation}-${aspectSlug(st.aspect)}`;
      // The portrait plugin shows PNG, JPEG and WebP; any other kept picture is rendered to PNG.
      const keep = kept && /^(png|jpe?g|webp)$/i.test(kept.ext);
      const path = keep ? `${stem}.${kept!.ext.toLowerCase()}` : `${stem}.png`;
      const bytes = keep ? kept!.bytes : await render(board);
      files.push({ path, bytes });
      backgroundOf.set(st.component, path);
      runtime.push({ aspect: st.aspect, orientation: st.orientation, status: st.status, reason: st.reason, file: path, bytes });
    }
    for (const d of boards.displays) {
      const o = orientationOf(d.size);
      const wallpaper = needsOwnWallpaper(d.size) ? states.find((s) => s.component === wallpaperFor(d.size))?.status ?? 'missing' : 'landscape';
      const entry: ManifestDisplay = { size: `${d.size.width}x${d.size.height}`, orientation: o, wallpaper, runtime: wallpaper === 'landscape' ? 'theme-backgrounds' : WALLPAPER_DONE.has(wallpaper as WallpaperStatus) ? 'bogen.portrait-background' : 'not-shown' };
      if (d.desktop) {
        const s = sizeOf(d.desktop);
        const path = `displays/preview-${o}-${d.size.width}x${d.size.height}.png`;
        files.push({ path, bytes: await render(d.desktop, { scale: Math.min(1, (1800 - 0.1) / Math.max(s.width, s.height, 1)) }) });
        entry.preview = path;
      }
      const bg = backgroundOf.get(wallpaperFor(d.size));
      if (bg) entry.background = bg;
      displays.push(entry);
    }
    const rt = runtimeManifest(slug, runtime);
    if (rt) {
      files.push({ path: RUNTIME_FILE, bytes: enc.encode(rt.json) });
      problems.push(...rt.problems);
    }
    if (displays.length || states.length) notes.push(DISPLAY_RUNTIME_NOTE);
    for (const b of boards.backgrounds) {
      const s = sizeOf(b);
      if (s.width && s.height && orientationOf(s) === 'portrait') notes.push(`"${b.name}" is portrait and goes in backgrounds/, so Omarchy shows it on every screen when it comes round: a landscape screen shows its middle band. A composition for portrait monitors belongs on a Portrait background board, which goes to displays/.`);
    }
  }
  if (!profile) files.push({ path: 'README.md', bytes: enc.encode(readme(name, slug, out, backgrounds, displays)) });
  const manifest = themeManifest({ name, slug, target, mode: out.mode, ...(profile ? { profile } : {}), files, version: VERSION, displays });
  files.push({ path: 'bogen-theme.json', bytes: enc.encode(JSON.stringify(manifest, null, 2) + '\n') });
  return { name, slug, mode: out.mode, target, ...(profile ? { profile } : {}), manifest, files, generated: generatedFiles(env).filter((f) => !files.some((x) => x.path === f)), problems, notes };
}

/**
 * The package a mobile theme goes to the phone in: the theme folder under theme/<slug>, its install.sh, the manifest,
 * a README that says what it can and cannot change, and checksums the installer verifies before it writes anything.
 * Root folder `<slug>-mobile`.
 */
export function mobilePackage(theme: ThemeExport): { root: string; files: ThemeFileOut[] } {
  if (theme.target !== 'mobile' || !theme.profile) throw new HttpError(422, `${theme.name} is a desktop theme: it exports as a theme folder, not as a phone package.`);
  const inner: ThemeFileOut[] = theme.files.map((f) => ({ path: `theme/${theme.slug}/${f.path}`, bytes: f.bytes }));
  const files: ThemeFileOut[] = [
    { path: 'install.sh', bytes: enc.encode(installScript(theme.manifest, theme.profile)), executable: true },
    { path: 'bogen-theme.json', bytes: enc.encode(JSON.stringify(theme.manifest, null, 2) + '\n') },
    { path: 'README.md', bytes: enc.encode(packageReadme(theme.manifest, theme.profile)) },
    ...inner,
  ];
  files.push({ path: 'checksums.sha256', bytes: enc.encode(checksums(files)) });
  return { root: `${theme.slug}-mobile`, files };
}

// ---------------------------------------------------------------- writing it out

/** POSIX ustar, which every tar reads, gzipped. Folders first, each file under `<root>/`. */
export function tarGz(files: ThemeFileOut[], root: string): Buffer {
  const blocks: Buffer[] = [];
  const now = Math.floor(Date.now() / 1000);
  const header = (path: string, size: number, dir: boolean, executable = false) => {
    const h = Buffer.alloc(512);
    let name = path;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf('/', name.length - 1 - 0);
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
      if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`The path ${path} is too long for a tar archive.`);
    }
    h.write(name, 0, 100, 'utf8');
    h.write(dir || executable ? '0000755\0' : '0000644\0', 100, 8, 'ascii');
    h.write('0000000\0', 108, 8, 'ascii');
    h.write('0000000\0', 116, 8, 'ascii');
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    h.write(now.toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii');
    h.write(dir ? '5' : '0', 156, 1, 'ascii');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    h.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    return h;
  };
  const dirs = new Set<string>([root]);
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${root}/${parts.slice(0, i).join('/')}`);
  }
  for (const d of [...dirs].sort()) blocks.push(header(`${d}/`, 0, true));
  for (const f of files) {
    blocks.push(header(`${root}/${f.path}`, f.bytes.length, false, f.executable));
    blocks.push(Buffer.from(f.bytes));
    const pad = (512 - (f.bytes.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/** True when `child` is `parent` or inside it, after resolving both. */
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function writeFiles(dir: string, files: ThemeFileOut[]): Promise<void> {
  for (const f of files) {
    const path = resolve(dir, f.path);
    if (!inside(dir, path) || path === dir) throw new HttpError(400, `${f.path} is not a path inside the theme.`);
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, f.bytes);
    if (f.executable) await chmod(path, 0o755);
  }
}

export interface FolderResult { dir: string; files: string[]; git?: string | null }

/**
 * The theme as a folder at `dest`, which must not exist yet or be empty. With `git`, the folder becomes a repository
 * with one commit, ready to push as omarchy-<name>-theme. Nothing is pushed.
 */
export async function writeThemeFolder(theme: ThemeExport, dest: string, options: { git?: boolean } = {}): Promise<FolderResult> {
  if (!isAbsolute(dest)) throw new HttpError(400, 'Give the folder as an absolute path.');
  const dir = resolve(dest);
  if (existsSync(dir)) {
    if (!isDir(dir)) throw new HttpError(409, `${dir} is a file, not a folder.`);
    if (readdirSync(dir).length) throw new HttpError(409, `${dir} is not empty. Pick a new or an empty folder: an export never writes over other files.`);
  }
  await mkdir(dir, { recursive: true });
  await writeFiles(dir, theme.files);
  let git: string | null | undefined;
  if (options.git) {
    await gitInit(dir, { own: true });
    git = await gitCommit(dir, `${theme.name}, an Omarchy theme`, { name: 'Bogen' });
  }
  return { dir, files: theme.files.map((f) => f.path), ...(options.git ? { git } : {}) };
}

/** `dest` ending in .tar.gz or .tgz is an archive, anything else a folder. */
export async function writeThemeTo(theme: ThemeExport, dest: string, options: { git?: boolean } = {}): Promise<FolderResult & { archive?: boolean; package?: boolean }> {
  // A mobile theme always leaves as its phone package, with install.sh, so it is never copied raw onto a computer.
  const pkg = theme.target === 'mobile' ? mobilePackage(theme) : null;
  const files = pkg?.files ?? theme.files;
  if (/\.(tar\.gz|tgz)$/i.test(dest)) {
    if (!isAbsolute(dest)) throw new HttpError(400, 'Give the archive as an absolute path.');
    const path = resolve(dest);
    if (existsSync(path)) throw new HttpError(409, `${path} exists already. An export never writes over a file.`);
    if (!isDir(dirname(path))) throw new HttpError(400, `There is no folder ${dirname(path)}.`);
    await writeFile(path, tarGz(files, pkg?.root ?? theme.slug), { flag: 'wx' });
    return { dir: path, files: files.map((f) => f.path), archive: true, ...(pkg ? { package: true } : {}) };
  }
  const out = await writeThemeFolder({ ...theme, files }, dest, options);
  return { ...out, ...(pkg ? { package: true } : {}) };
}

// ---------------------------------------------------------------- install

export interface InstallResult { name: string; dir: string; replaced: boolean; overStock: boolean; files: string[] }

/**
 * Copies the theme into ~/.config/omarchy/themes/<slug>. An existing theme there is replaced only with `overwrite`,
 * which only the editor sends, after the person said yes. Nothing is written anywhere else: the folder is checked
 * after resolving links, and a theme folder that is itself a link is refused.
 */
export async function installTheme(env: ThemeEnv, theme: ThemeExport, options: { overwrite?: boolean } = {}): Promise<InstallResult> {
  const slug = theme.slug;
  if (!validThemeName(slug)) throw new HttpError(400, `${slug} is not a theme name Omarchy accepts.`);
  assertTargetMatches(env, theme.target, theme.name);
  const base = userThemes(env);
  await mkdir(base, { recursive: true });
  const real = realpathSync(base);
  const target = join(real, slug);
  if (!inside(real, target) || dirname(target) !== real) throw new HttpError(400, 'That name would leave the themes folder.');
  let exists = false;
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) throw new HttpError(409, `${join(base, slug)} is a link to somewhere else. Bogen does not write through it: remove the link, or pick another name.`);
    exists = true;
  } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  if (exists && !options.overwrite) {
    const err = new HttpError(409, `A theme named ${slug} is installed already, in ${join(base, slug)}. Replacing it needs the person's yes: Install in the editor asks for it. Or pick another name.`);
    (err as HttpError & { exists?: boolean }).exists = true;
    throw err;
  }
  for (const f of theme.files) if (f.path.split('/').some((p) => p === '..' || p === '' || p.startsWith('.'))) throw new HttpError(400, `${f.path} is not a path inside the theme.`);
  // Written next to the old one and swapped in, so a failure halfway leaves the installed theme as it was.
  const staging = join(real, `.${slug}.bogen-new`);
  const old = join(real, `.${slug}.bogen-old`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  await writeFiles(staging, theme.files);
  if (exists) {
    await rm(old, { recursive: true, force: true });
    await rename(target, old);
  }
  await rename(staging, target);
  if (exists) await rm(old, { recursive: true, force: true });
  return { name: slug, dir: join(base, slug), replaced: exists, overStock: isDir(join(stockThemes(env), slug)), files: theme.files.map((f) => f.path) };
}

/** Refuses installing a file of the other target here, before anything is rendered. */
export async function assertFileInstallable(app: BogenServer, env: ThemeEnv, fileId: string): Promise<void> {
  const room = await app.rooms.get(app.requireFile(fileId).id);
  const meta = themeMeta(room.doc);
  if (meta) assertTargetMatches(env, meta.target ?? 'desktop', meta.name);
}

/** The target an installed theme declares in its bogen-theme.json; desktop when it has none. */
export function installedTarget(env: ThemeEnv, slug: string): ThemeTarget {
  for (const dir of [...themeDirs(env, slug)].reverse()) {
    const path = join(dir, 'bogen-theme.json');
    if (!plainFile(path)) continue;
    try {
      const m = JSON.parse(readFileSync(path, 'utf8')) as { target?: unknown };
      return m.target === 'mobile' ? 'mobile' : 'desktop';
    } catch {
      return 'desktop';
    }
  }
  return 'desktop';
}

export function installedAt(env: ThemeEnv, slug: string): string | null {
  const dir = join(userThemes(env), slug);
  return validThemeName(slug) && isDir(dir) ? dir : null;
}

/**
 * What a theme project is on this machine, from real state only: in use when it is installed and the theme in use,
 * installed when its folder is in ~/.config/omarchy/themes, a draft otherwise. A theme for another kind of device is
 * never installed here.
 */
export function projectStatus(env: ThemeEnv): (row: { slug: string | null; target: ThemeTarget }) => 'draft' | 'installed' | 'in-use' {
  const current = currentThemeName(env);
  const host = hostTarget(env);
  return ({ slug, target }) => (!slug || target !== host || !installedAt(env, slug) ? 'draft' : current === slug ? 'in-use' : 'installed');
}

// ---------------------------------------------------------------- apply and undo

interface ApplyState { applied: string; previous: string | null; at: number }

function readState(env: ThemeEnv): ApplyState | null {
  try {
    const s = JSON.parse(readFileSync(env.stateFile, 'utf8')) as ApplyState;
    return typeof s.applied === 'string' ? s : null;
  } catch {
    return null;
  }
}

export function applyState(env: ThemeEnv): (ApplyState & { current: string | null }) | { current: string | null } {
  return { ...(readState(env) ?? {}), current: currentThemeName(env) };
}

function themeSet(env: ThemeEnv, name: string): Promise<string> {
  return new Promise((done, fail) => {
    // Omarchy 4.5 retints most apps in the background once the command returns, unless OMARCHY_THEME_WAIT=1: then it
    // waits and names a failed retint on stderr, which is what a person clicking Apply should hear about. Bogen runs
    // no theme sync of its own; Omarchy's herdr sync, when the person turned it on, follows from this one command.
    execFile(env.bin, ['theme', 'set', name], { timeout: 120_000, maxBuffer: 1 << 20, env: { ...process.env, OMARCHY_THEME_WAIT: '1' } }, (err, stdout, stderr) => {
      if (err) return fail(new HttpError(502, `omarchy theme set ${name} failed: ${(stderr || err.message).trim().split('\n').at(-1)}`));
      done(`${stdout}${stderr}`.trim());
    });
  });
}

/** Records the theme in use, then applies this one. Only on a person's click in the editor. */
export async function applyTheme(env: ThemeEnv, slug: string): Promise<{ applied: string; previous: string | null; output: string }> {
  if (!validThemeName(slug) || !themeDirs(env, slug).length) throw new HttpError(404, `There is no installed theme ${slug}. Install it first.`);
  // A theme Bogen made says what it is for; the stock and other themes say nothing and stay desktop themes.
  assertTargetMatches(env, installedTarget(env, slug), slug);
  const before = currentThemeName(env);
  const state = readState(env);
  // Applying twice in a row keeps the theme from before the first, so Undo goes back to where the person started.
  const previous = state && state.applied === before ? state.previous : before;
  await atomicWrite(env.stateFile, JSON.stringify({ applied: slug, previous, at: Date.now() } satisfies ApplyState));
  const output = await themeSet(env, slug);
  return { applied: slug, previous, output };
}

export async function undoApply(env: ThemeEnv): Promise<{ restored: string; output: string }> {
  const state = readState(env);
  if (!state?.previous) throw new HttpError(409, 'There is nothing to undo: Bogen has not applied a theme, or did not know the one before.');
  const output = await themeSet(env, state.previous);
  await rm(env.stateFile, { force: true });
  return { restored: state.previous, output };
}

// ---------------------------------------------------------------- what the editor shows

export interface ThemeInfo {
  name: string;
  slug: string | null;
  target: ThemeTarget;
  /** The phone profile, for a mobile theme. */
  profile?: { id: string; device: string; logical: string };
  /** What this machine is: Install and Apply are offered only when it matches the target. */
  host: ThemeTarget;
  /** Coverage of a mobile theme: what it themes, what is generated, what no theme can change. */
  coverage?: { surface: string; status: string; via: string; note?: string }[];
  /** How many shell roles the file designs: they become shell.toml. */
  shellRoles: number;
  mode: ThemeMode;
  icons: string;
  iconsFollowAccent: boolean;
  from?: string;
  installed: string | null;
  /** A stock theme of the same name: the user folder goes over it. */
  overStock: boolean;
  /** Its Git clone: replacing it ends Omarchy's repository rules for it, and `omarchy theme update` for it. */
  installedFromRepo: boolean;
  backgrounds: { name: string; width: number; height: number; kept: boolean }[];
  /** Intros and loop wallpapers it carries, with what Omarchy's advice says about each. */
  videos: { kind: string; name: string; still?: string; durationS?: number; hasAudio?: boolean; advice: string[] }[];
  previews: { desktop: boolean; unlock: boolean; boot: boolean };
  /** Desktop displays with previews: 1920 x 1080 first, then a portrait monitor and the others. */
  displays: DisplayInfo[];
  /** The composition of each shape that is not landscape, and whether it is designed. */
  wallpapers: WallpaperState[];
  generated: string[];
  problems: string[];
  /** Not faults: what Omarchy does with these displays at runtime. */
  notes: string[];
  /** The portrait background plugin on this machine, for a desktop theme with compositions. */
  portrait?: PortraitPluginSummary;
  apply: ReturnType<typeof applyState>;
  /** How many keys colors.toml gets. */
  keys: number;
}

export async function themeInfo(app: BogenServer, env: ThemeEnv, fileId: string): Promise<ThemeInfo | null> {
  const room = await app.rooms.get(app.requireFile(fileId).id);
  const { doc } = room;
  const meta = themeMeta(doc);
  if (!meta) return null;
  const target = meta.target ?? 'desktop';
  const profile = target === 'mobile' ? mobileProfile(meta.profile) : undefined;
  const out = themeFromTokens(doc.getTokens(), meta);
  const shell = shellFromTokens(doc.getTokens());
  const slug = themeSlug(meta.name);
  const accent = new Map(out.entries).get('accent') ?? '#7aa2f7';
  const boards = findBoards(doc);
  const size = (n: BogenNode) => ({ width: Number.parseFloat(n.style.width ?? '0') || 0, height: Number.parseFloat(n.style.height ?? '0') || 0 });
  const installed = slug ? installedAt(env, slug) : null;
  const displays = target === 'desktop' ? themeDisplays(doc, meta) : [];
  const wallpapers = target === 'desktop' ? await wallpaperStates(app, doc, meta) : [];
  return {
    name: meta.name, slug, target, host: hostTarget(env),
    ...(profile ? { profile: { id: profile.id, device: profile.device, logical: `${profile.logical.width} × ${profile.logical.height}` }, coverage: themeManifest({ name: meta.name, slug: slug ?? 'theme', target, mode: out.mode, profile, files: [], version: VERSION }).coverage.map((c) => ({ ...c })) } : {}),
    shellRoles: doc.getTokens().filter((t) => isShellToken(t.name)).length,
    mode: out.mode, icons: meta.icons ?? iconsThemeFor(accent), iconsFollowAccent: !meta.icons, ...(meta.from ? { from: meta.from } : {}),
    installed, overStock: Boolean(slug && isDir(join(stockThemes(env), slug))), installedFromRepo: Boolean(installed && isDir(join(installed, '.git'))),
    backgrounds: boards.backgrounds.map((b) => ({ name: b.name, ...size(b), kept: Boolean(soleImage(doc, b)) })),
    videos: (meta.videos ?? []).map((v) => {
      const board = v.board ? boards.backgrounds.find((b) => b.id === v.board) : undefined;
      return {
        kind: v.kind, name: v.name, ...(board ? { still: board.name } : {}), ...(v.facts?.durationS !== undefined ? { durationS: v.facts.durationS } : {}),
        ...(v.facts?.hasAudio !== undefined ? { hasAudio: v.facts.hasAudio } : {}),
        advice: [...videoAdvice(v, board ? size(board) : undefined), ...(v.kind === 'intro' && !board ? [`${v.name} has no still to end on, so it will not be exported.`] : [])],
      };
    }),
    previews: { desktop: Boolean(boards.desktop), unlock: Boolean(boards.unlock), boot: Boolean(boards.boot) },
    displays, wallpapers,
    generated: generatedFiles(env),
    problems: [...out.problems, ...shell.problems, ...themeConsistency(doc), ...(target === 'desktop' ? [...bootLogoProblems(doc), ...landscapeProblems(doc)] : []), ...wallpapers.filter((w) => !WALLPAPER_DONE.has(w.status)).map((w) => `The ${w.orientation} ${w.aspect} background needs its own design (${WALLPAPER_STATUS_TEXT[w.status].toLowerCase()}). ${w.reason}`)],
    notes: displays.length > 1 || wallpapers.length ? [DISPLAY_RUNTIME_NOTE] : [],
    ...(target === 'desktop' && wallpapers.length ? { portrait: portraitPlugin(env) } : {}),
    apply: applyState(env), keys: out.entries.length,
  };
}

export function setThemeMeta(doc: BogenDoc, patch: { name?: string; mode?: ThemeMode; icons?: string | null }, origin: string): ThemeMeta {
  const current = themeMeta(doc) ?? { name: 'Theme' };
  const next: ThemeMeta = { ...current };
  if (patch.name !== undefined) {
    if (!themeSlug(patch.name)) throw new HttpError(400, `"${patch.name}" does not give a folder name Omarchy accepts.`);
    next.name = patch.name.trim().slice(0, 64);
  }
  if (patch.mode) next.mode = patch.mode;
  if (patch.icons === null) delete next.icons;
  else if (patch.icons !== undefined) {
    if (!/^[\w.+-]{1,64}$/.test(patch.icons)) throw new HttpError(400, 'Not an icon theme name.');
    next.icons = patch.icons;
  }
  doc.transact(() => doc.meta.set(META_KEY, next), origin);
  return next;
}

/** Keys a stock colors.toml has, for checks against the structure of the stock themes. */
export const STOCK_KEYS = ['mode', ...PALETTE_KEYS];
