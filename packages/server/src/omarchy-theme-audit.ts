// Read-only audit of every Omarchy theme for portrait screens: the installed theme folders (stock, user, overlays) and
// Bogen's own theme files. It says, for each, what a portrait screen shows today and what would change that, and
// changes nothing. The one write, `upgradeThemeRuntime`, is additive and opt-in: it adds displays/portrait-runtime.json
// to an installed user theme whose shipped portrait artwork it can verify, records a checkpoint, and touches no other
// file. It never trusts an older export's "composed": before November 2026 that could be the palette arc stand-in.

import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { BogenServer } from './http/server.ts';
import { aspectOf, orientationOf, WALLPAPER_DONE } from './omarchy-displays.ts';
import { currentThemeDir, loadRuntime, readThemeRuntime, RUNTIME_FILE, runtimeManifest, shippedDisplays, verifiedArtwork, type ThemeRuntimeState } from './omarchy-portrait-runtime.ts';
import { currentThemeName, listThemes, themeMeta, wallpaperStates, type ThemeEnv } from './omarchy-themes.ts';
import { themeSlug, validThemeName } from './omarchy-theme.ts';
import { atomicWrite, HttpError } from './util.ts';

const MAX_BACKGROUNDS = 48;
const MAX_FILES = 400;
const HEADER = 262_144;
const STILL = /\.(png|jpe?g|webp|gif|bmp)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function plainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function plainDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function head(path: string): Uint8Array | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEADER);
    const n = readSync(fd, buf, 0, HEADER, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readJson(path: string, max = 1 << 20): unknown {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > max) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- installed theme folders

export type FolderVerdict = 'portrait-ready' | 'artwork-unlisted' | 'needs-design' | 'unconfirmed' | 'no-portrait-design' | 'landscape-only';

export interface FolderAudit {
  slug: string;
  source: 'stock' | 'user' | 'overlay';
  current: boolean;
  fromRepo: boolean;
  /** Made by Bogen: it has a bogen-theme.json. */
  bogen: boolean;
  backgrounds: { file: string; width?: number; height?: number; orientation?: string; video?: boolean; link?: boolean }[];
  /** Portrait pictures in backgrounds/: Omarchy cycles them onto landscape screens too, cropped. */
  portraitInBackgrounds: string[];
  /** What bogen-theme.json says about each other display. */
  displays: { size: string; orientation: string; wallpaper: string; background?: string }[];
  runtime: Pick<ThemeRuntimeState, 'state' | 'problems'> & { ready: string[]; incomplete: string[] };
  verdict: FolderVerdict;
  /** What a portrait screen shows today with the plugin enabled, in one sentence. */
  portraitShows: string;
  /** What would change it, additive steps only. */
  actions: string[];
  /** `upgradeThemeRuntime` can add displays/portrait-runtime.json from verified artwork. */
  upgradable: boolean;
}

const userThemes = (env: ThemeEnv) => join(env.home, '.config', 'omarchy', 'themes');
const stockThemes = (env: ThemeEnv) => join(env.omarchyPath, 'themes');

function measureBackgrounds(dirs: string[], lib = loadRuntime()): FolderAudit['backgrounds'] {
  const seen = new Map<string, FolderAudit['backgrounds'][number]>();
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, 'backgrounds')).sort();
    } catch {
      continue;
    }
    for (const file of names) {
      if (seen.size >= MAX_BACKGROUNDS) break;
      const path = join(dir, 'backgrounds', file);
      if (VIDEO.test(file)) {
        seen.set(file, { file, video: true });
        continue;
      }
      if (!STILL.test(file)) continue;
      if (!plainFile(path)) {
        seen.set(file, { file, link: true });
        continue;
      }
      const h = lib.imageHeader(head(path));
      seen.set(file, h ? { file, width: h.width, height: h.height, orientation: orientationOf(h) } : { file });
    }
  }
  return [...seen.values()];
}

export function auditFolders(env: ThemeEnv): FolderAudit[] {
  const lib = loadRuntime();
  const out: FolderAudit[] = [];
  for (const t of listThemes(env)) {
    const user = join(userThemes(env), t.name);
    const stock = join(stockThemes(env), t.name);
    const dirs = [stock, user].filter(plainDir);
    const manifestDir = [...dirs].reverse().find((d) => plainFile(join(d, 'bogen-theme.json')));
    const manifest = manifestDir ? readJson(join(manifestDir, 'bogen-theme.json')) : null;
    const backgrounds = measureBackgrounds(dirs, lib);
    const portraitInBackgrounds = backgrounds.filter((b) => b.orientation === 'portrait').map((b) => b.file);
    const displays = shippedDisplays(manifest);
    // What the plugin would read: the user folder over the stock one, as `omarchy theme set` stages them.
    const rtDir = [...dirs].reverse().find((d) => existsSync(join(d, RUNTIME_FILE)));
    const rt = rtDir ? readThemeRuntime(rtDir, lib) : null;
    const runtime = { state: rt?.state ?? 'none', problems: rt?.problems ?? [], ready: (rt?.entries ?? []).filter((e) => e.verified).map((e) => `${e.aspect} ${e.file}`), incomplete: (rt?.incomplete ?? []).map((i) => `${i.aspect} ${i.status}`) } as FolderAudit['runtime'];
    const portraitShipped = displays.filter((d) => d.orientation !== 'landscape');
    const art = manifestDir && !rt ? verifiedArtwork(manifestDir, manifest, lib) : { artwork: [], problems: [] };
    const upgradable = t.source !== 'stock' && !t.fromRepo && manifestDir === user && art.artwork.length > 0 && !rt;
    let verdict: FolderVerdict;
    const actions: string[] = [];
    let portraitShows: string;
    if (rt?.state === 'ready') {
      verdict = 'portrait-ready';
      portraitShows = `its own composition (${runtime.ready.join(', ')}) on a screen of that shape`;
    } else if (upgradable) {
      verdict = 'artwork-unlisted';
      portraitShows = 'the theme background, cropped: its portrait artwork has no runtime manifest yet';
      actions.push(`bogen omarchy portrait upgrade ${t.name}            # plan: list ${art.artwork.map((a) => a.file).join(', ')} in ${RUNTIME_FILE}`, `bogen omarchy portrait upgrade ${t.name} --apply    # adds that one file; nothing else changes`);
    } else if (portraitShipped.some((d) => d.wallpaper === 'composed')) {
      verdict = 'unconfirmed';
      portraitShows = 'the theme background, cropped';
      actions.push('Its export calls the portrait composition "composed", which before November 2026 included the palette arc stand-in. Open its Bogen file: if the composition is designed, export and install it again so the new export lists it; if not, design it first.');
    } else if (portraitShipped.length) {
      verdict = 'needs-design';
      portraitShows = 'the theme background, cropped';
      actions.push(`The ${portraitShipped.map((d) => `${d.orientation} ${d.size}`).join(', ')} composition is ${[...new Set(portraitShipped.map((d) => d.wallpaper))].join(', ')}. Design it in its Bogen file from the theme's identity (or assign artwork of that shape), then export and install it again.`);
    } else if (manifest) {
      verdict = 'no-portrait-design';
      portraitShows = 'the theme background, cropped';
      actions.push('Its Bogen file has no portrait display. Add one in the theme dialog (Displays) or with omarchy_theme_displays add: it adds boards below the design and changes nothing else. Then design the composition.');
    } else {
      verdict = 'landscape-only';
      portraitShows = 'the theme background, cropped';
      actions.push(t.source === 'stock'
        ? 'A stock theme. To give it a portrait design, make a Bogen theme from it (Omarchy → New theme from it), design its portrait composition and install that under its own name; the stock theme is never changed.'
        : 'Not made by Bogen. Make a Bogen theme from it to design a portrait composition; the folder itself is left as it is.');
    }
    if (portraitInBackgrounds.length) actions.push(`${portraitInBackgrounds.join(', ')} ${portraitInBackgrounds.length === 1 ? 'is' : 'are'} portrait and in backgrounds/, so Omarchy cycles ${portraitInBackgrounds.length === 1 ? 'it' : 'them'} onto landscape screens too.`);
    if (t.fromRepo && verdict !== 'portrait-ready') actions.push('Installed from a repository: change it at its source; `omarchy theme update` would otherwise fight a local change.');
    out.push({ slug: t.name, source: t.source, current: t.current, fromRepo: t.fromRepo, bogen: Boolean(manifest), backgrounds, portraitInBackgrounds, displays, runtime: { ...runtime, problems: [...runtime.problems, ...art.problems] }, verdict, portraitShows, actions, upgradable });
  }
  return out;
}

// ---------------------------------------------------------------- Bogen's theme files

export interface FileAudit {
  id: string;
  name: string;
  slug: string | null;
  updatedAt: number;
  /** Other theme files of the same slug, newest first: copies made over time. */
  sameSlug: string[];
  installed: boolean;
  compositions: { aspect: string; status: string; legacyArcs: boolean; board?: string }[];
  verdict: 'portrait-designed' | 'needs-design' | 'no-portrait-display' | 'mobile';
  actions: string[];
}

/** Every desktop theme file, read-only: its compositions' states, legacy palette arcs, and copies of the same slug. */
export async function auditFiles(app: BogenServer, env: ThemeEnv): Promise<FileAudit[]> {
  const out: FileAudit[] = [];
  const candidates = app.storage.list().filter((f) => /Omarchy (mobile )?theme$/.test(f.name)).slice(0, MAX_FILES);
  for (const f of candidates) {
    const room = await app.rooms.get(f.id).catch(() => null);
    if (!room) continue;
    const meta = themeMeta(room.doc);
    if (!meta) continue;
    const slug = themeSlug(meta.name);
    if (meta.target === 'mobile') {
      out.push({ id: f.id, name: meta.name, slug, updatedAt: f.updatedAt, sameSlug: [], installed: false, compositions: [], verdict: 'mobile', actions: [] });
      continue;
    }
    const states = await wallpaperStates(app, room.doc, meta);
    const compositions = states.map((s) => {
      const legacyArcs = s.status === 'needs-design' && /palette arc/.test(s.reason);
      return { aspect: s.aspect, status: s.status, legacyArcs, ...(s.board ? { board: s.board.name } : {}) };
    });
    const designed = states.length > 0 && states.every((s) => WALLPAPER_DONE.has(s.status));
    const verdict: FileAudit['verdict'] = !states.length ? 'no-portrait-display' : designed ? 'portrait-designed' : 'needs-design';
    const actions: string[] = [];
    if (verdict === 'no-portrait-display') actions.push('Add a portrait display (theme dialog → Displays, or omarchy_theme_displays add). It adds boards below the design, one undo step, and changes nothing that is there.');
    for (const s of states) if (!WALLPAPER_DONE.has(s.status)) actions.push(`${s.aspect}: ${s.reason}`);
    if (designed) actions.push('Export and install it again so the theme carries displays/portrait-runtime.json.');
    out.push({ id: f.id, name: meta.name, slug, updatedAt: f.updatedAt, sameSlug: [], installed: Boolean(slug && plainDir(join(userThemes(env), slug))), compositions, verdict, actions });
  }
  const bySlug = new Map<string, FileAudit[]>();
  for (const a of out) if (a.slug) bySlug.set(a.slug, [...(bySlug.get(a.slug) ?? []), a]);
  for (const group of bySlug.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const a of group) a.sameSlug = group.filter((x) => x !== a).map((x) => x.id);
  }
  return out;
}

// ---------------------------------------------------------------- the one additive upgrade

export interface UpgradeResult {
  slug: string;
  possible: boolean;
  applied: boolean;
  blockers: string[];
  /** The runtime manifest it writes (or would). */
  file?: string;
  lists: string[];
  incomplete: string[];
  checkpoint?: string;
  next: string[];
}

const checkpoints = (env: ThemeEnv) => join(env.home, '.local', 'state', 'bogen', 'portrait-background', 'checkpoints');

/**
 * Adds displays/portrait-runtime.json to an installed user theme made by Bogen, listing only portrait artwork whose
 * bytes match what the export shipped. Plans unless `apply`. Refuses a stock theme, a theme from a repository, a
 * folder that is a link, one that has the file already, and one with nothing verified to list: an older "composed"
 * is never trusted, as it may be the palette arc stand-in. Writes that one file and a checkpoint, nothing else.
 */
export async function upgradeThemeRuntime(env: ThemeEnv, slug: string, options: { apply?: boolean } = {}): Promise<UpgradeResult> {
  if (!validThemeName(slug)) throw new HttpError(400, `${slug} is not a theme name.`);
  const dir = join(userThemes(env), slug);
  const out: UpgradeResult = { slug, possible: false, applied: false, blockers: [], lists: [], incomplete: [], next: [] };
  if (!plainDir(dir)) out.blockers.push(lstatExists(dir) ? `${dir} is a link; Bogen does not write through it.` : `There is no user theme ${slug} in ${userThemes(env)}. Stock themes are never changed.`);
  else {
    if (plainDir(join(dir, '.git'))) out.blockers.push(`${slug} was installed from a repository; change it at its source.`);
    if (lstatExists(join(dir, RUNTIME_FILE))) out.blockers.push(`${slug} has ${RUNTIME_FILE} already; nothing is added twice.`);
    if (lstatExists(join(dir, 'displays')) && !plainDir(join(dir, 'displays'))) out.blockers.push(`${slug}/displays is not a plain folder.`);
    const manifest = readJson(join(dir, 'bogen-theme.json'));
    if (!manifest) out.blockers.push(`${slug} has no bogen-theme.json: it was not made by Bogen, so there is no shipped portrait artwork to verify.`);
    else {
      const { artwork, problems } = verifiedArtwork(dir, manifest);
      if (!artwork.length) out.blockers.push(...problems.map((p) => `Not listed: ${p}`));
      for (const d of shippedDisplays(manifest)) {
        if (d.orientation === 'landscape' || d.wallpaper === 'artwork') continue;
        out.incomplete.push(`${d.orientation} ${d.size}: ${d.wallpaper}${d.wallpaper === 'composed' ? ' (not trusted from an older export: re-export from Bogen to confirm)' : ''}`);
      }
      if (!artwork.length) out.blockers.push('There is no verified portrait artwork to list. A placeholder or an unconfirmed composition is never listed.');
      else {
        const rt = runtimeManifest(slug, artwork.map((a) => ({ aspect: a.aspect, orientation: a.orientation, status: 'artwork', reason: '', file: a.file, bytes: a.bytes })));
        out.lists = artwork.map((a) => `${a.aspect} ${a.file}`);
        out.file = join(dir, RUNTIME_FILE);
        if (!out.blockers.length && rt && options.apply) {
          // The folder is resolved once more, so a link swapped in meanwhile is not written through.
          const real = realpathSync(dir);
          if (basename(real) !== slug) throw new HttpError(409, `${dir} moved while it was checked. Nothing was written.`);
          await mkdir(join(real, 'displays'), { recursive: true });
          await atomicWrite(join(real, RUNTIME_FILE), rt.json);
          await mkdir(checkpoints(env), { recursive: true, mode: 0o700 });
          const at = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
          out.checkpoint = join(checkpoints(env), `${at}-${slug}.json`);
          await atomicWrite(out.checkpoint, `${JSON.stringify({ slug, created: [join(real, RUNTIME_FILE)], sha256: createHash('sha256').update(rt.json).digest('hex'), at: Date.now() }, null, 2)}\n`);
          out.applied = true;
        }
      }
    }
  }
  out.possible = !out.blockers.length;
  if (out.possible) out.next.push(currentThemeName(env) === slug ? `omarchy theme set ${slug}   # stages the theme again so the running plugin reads the new file` : `It takes effect the next time ${slug} is applied.`);
  return out;
}

/** Takes back an upgrade: deletes the file it created, only while it is byte for byte what the upgrade wrote. */
export async function undoUpgrade(env: ThemeEnv, checkpoint: string, options: { apply?: boolean } = {}): Promise<{ removed: string[]; kept: string[]; applied: boolean }> {
  const base = checkpoints(env);
  if (!checkpoint.startsWith(`${base}/`) || checkpoint.includes('..')) throw new HttpError(400, `A checkpoint is a file in ${base}.`);
  const cp = readJson(checkpoint);
  if (!isObject(cp) || !Array.isArray(cp.created) || typeof cp.sha256 !== 'string') throw new HttpError(400, `${checkpoint} is not a checkpoint.`);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const p of cp.created.slice(0, 4)) {
    if (typeof p !== 'string' || !p.endsWith(`/${RUNTIME_FILE}`) || !plainFile(p) || sha256(readFileSync(p)) !== cp.sha256) {
      kept.push(String(p));
      continue;
    }
    if (options.apply) await rm(p);
    removed.push(p);
  }
  return { removed, kept, applied: Boolean(options.apply) };
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The current theme's runtime state, as the plugin would read it now. */
export function currentRuntime(env: ThemeEnv): ThemeRuntimeState {
  return readThemeRuntime(currentThemeDir(env.home));
}
