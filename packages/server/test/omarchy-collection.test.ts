import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMain } from '@bogen/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ART_SIZE, COLLECTION, COLLECTION_LIMITS, collectionDir, collectionEntries, collectionThumb, presetArt, presetColors, presetFiles, presetReady, presetSource, svgProblems,
} from '../src/omarchy-collection.ts';
import { colorsToml, modeOf, PALETTE_KEYS, shellFromTokens, themeFromTokens, themeSlug, themeTokens, tokenForKey } from '../src/omarchy-theme.ts';
import { imageSize, landscapeProblems, themeMeta, wallpaperStates } from '../src/omarchy-themes.ts';
import { imageWallpaper } from '../src/templates/omarchy-theme.ts';
import { findBrowser } from '../src/render.ts';
import { startServer, type Harness } from './helpers.ts';

// WCAG 2 relative luminance and contrast, on #rrggbb.
const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const HUES = ['red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown', 'bright_red', 'bright_yellow', 'bright_green', 'bright_cyan', 'bright_blue', 'bright_magenta'];
const ASSETS = join(import.meta.dirname, '..', 'assets', 'omarchy-collection');

describe('the Bogen collection catalog', () => {
  it('has twenty original presets with unique ids, names and folder names, half dark and half light', () => {
    expect(COLLECTION).toHaveLength(20);
    expect(new Set(COLLECTION.map((p) => p.id)).size).toBe(20);
    expect(new Set(COLLECTION.map((p) => p.name.toLowerCase())).size).toBe(20);
    expect(new Set(COLLECTION.map((p) => themeSlug(p.name))).size).toBe(20);
    for (const p of COLLECTION) {
      expect(p.id).toMatch(/^[a-z0-9-]{1,40}$/);
      expect(themeSlug(p.name)).toBe(p.id);
      expect(p.description.length).toBeGreaterThan(40);
      expect(p.description.length).toBeLessThan(160);
    }
    expect(COLLECTION.filter((p) => p.mode === 'dark')).toHaveLength(10);
    expect(COLLECTION.every((p) => p.medium === 'raster')).toBe(true);
    expect(COLLECTION.filter((p) => p.medium === 'raster')).toHaveLength(20);
  });

  it('gives every preset every palette key as #rrggbb, its mode as Omarchy reads it, and its own accent and background', () => {
    for (const p of COLLECTION) {
      expect(Object.keys(p.colors).sort()).toEqual([...PALETTE_KEYS].sort());
      for (const key of PALETTE_KEYS) expect(p.colors[key], `${p.id} ${key}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(modeOf(p.colors.background), p.id).toBe(p.mode);
    }
    expect(new Set(COLLECTION.map((p) => p.colors.accent)).size).toBe(20);
    expect(new Set(COLLECTION.map((p) => p.colors.background)).size).toBe(20);
    expect(new Set(COLLECTION.map((p) => p.colors.selection)).size).toBe(20);
  });

  it('keeps text readable: 7:1 foreground, 4.5:1 secondary text and selection, 4.5:1 muted, 3:1 accent and every terminal hue', () => {
    const report: string[] = [];
    for (const p of COLLECTION) {
      const c = p.colors as Record<string, string>;
      const need = (what: string, ratio: number, min: number) => { if (ratio < min) report.push(`${p.id}: ${what} ${ratio.toFixed(2)} < ${min}`); };
      need('foreground/background', contrast(c.foreground!, c.background!), 7);
      need('bright_foreground/background', contrast(c.bright_foreground!, c.background!), 7);
      need('light_foreground/background', contrast(c.light_foreground!, c.background!), 4.5);
      need('dark_foreground/background', contrast(c.dark_foreground!, c.background!), 4.5);
      need('foreground/selection', contrast(c.foreground!, c.selection!), 4.5);
      need('foreground/lighter_background', contrast(c.foreground!, c.lighter_background!), 4.5);
      need('muted/background', contrast(c.muted!, c.background!), 4.5);
      need('accent/background', contrast(c.accent!, c.background!), 3);
      for (const hue of HUES) need(`${hue}/background`, contrast(c[hue]!, c.background!), 3);
    }
    expect(report).toEqual([]);
  });

  it('turns into theme tokens and borders through the ordinary colors.toml path', () => {
    for (const p of COLLECTION) {
      const tokens = new Map(themeTokens(presetColors(p)).map((t) => [t.name, t.value]));
      for (const key of PALETTE_KEYS) expect(tokens.get(tokenForKey(key))).toBe(p.colors[key]);
      expect(tokens.get('omarchy-hyprland-inactive-border')).toMatch(/^#[0-9a-f]{8}$/);
    }
  });

  it('records its source as collection/<id>, which no installed theme name can be', () => {
    expect(presetSource('kiln')).toBe('collection/kiln');
    expect(themeSlug(presetSource('kiln'))).not.toBe(presetSource('kiln'));
  });
});

describe('the Bogen collection art', () => {
  const dir = collectionDir();

  it('is found in the source tree, and every vector preset is complete there', () => {
    expect(dir).toBe(ASSETS);
    for (const p of COLLECTION.filter((x) => x.medium === 'vector')) expect(presetReady(p, dir), p.id).toBe(true);
  });

  it('ships SVG that is safe, bounded and composed for its own shape', () => {
    for (const p of COLLECTION.filter((x) => x.medium === 'vector')) {
      for (const o of ['landscape', 'portrait'] as const) {
        const markup = readFileSync(join(ASSETS, p.id, `${o}.svg`), 'utf8').trim();
        expect(svgProblems(markup, o), `${p.id}/${o}.svg`).toEqual([]);
        expect(markup.length).toBeLessThanOrEqual(COLLECTION_LIMITS.svgBytes);
      }
      // Two compositions, not one: the portrait is not the landscape with another viewBox.
      const land = readFileSync(join(ASSETS, p.id, 'landscape.svg'), 'utf8').replace(/<svg[^>]*>/, '');
      const port = readFileSync(join(ASSETS, p.id, 'portrait.svg'), 'utf8').replace(/<svg[^>]*>/, '');
      expect(land, p.id).not.toBe(port);
    }
  });

  it('keeps the ids of a theme’s two SVGs apart, since both are inline on one canvas', () => {
    for (const p of COLLECTION.filter((x) => x.medium === 'vector')) {
      const ids = (o: string) => new Set([...readFileSync(join(ASSETS, p.id, `${o}.svg`), 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
      const land = ids('landscape');
      for (const id of ids('portrait')) expect(land.has(id), `${p.id}: #${id} in both`).toBe(false);
    }
  });

  it('has raster art either complete at the exact sizes and weights, or not at all: a pending preset has no stand-in', () => {
    for (const p of COLLECTION.filter((x) => x.medium === 'raster')) {
      const present = presetFiles(p).filter((f) => { try { return lstatSync(join(ASSETS, p.id, f.file)).isFile(); } catch { return false; } });
      if (!present.length) {
        expect(presetReady(p, dir)).toBe(false);
        continue;
      }
      expect(present.map((f) => f.file), `${p.id} is partly there`).toEqual(presetFiles(p).map((f) => f.file));
      expect(presetReady(p, dir), `${p.id} is over a limit`).toBe(true);
      const art = presetArt(p, dir);
      expect(imageSize(art.landscape.bytes)).toEqual(ART_SIZE.landscape);
      expect(imageSize(art.portrait.bytes)).toEqual(ART_SIZE.portrait);
      expect(imageSize(readFileSync(join(ASSETS, p.id, 'thumb-landscape.webp')))).toEqual({ width: 640, height: 360 });
      expect(imageSize(readFileSync(join(ASSETS, p.id, 'thumb-portrait.webp')))).toEqual({ width: 360, height: 640 });
    }
  });

  it('stays under its weight, with nothing in the folder that is not a preset’s file', () => {
    let total = 0;
    const known = new Map(COLLECTION.map((p) => [p.id, new Set(presetFiles(p).map((f) => f.file))]));
    for (const id of readdirSync(ASSETS)) {
      if (id === 'provenance.json') continue; // the hash inventory of the folder, checked by scripts/check-asset-provenance.mjs
      expect(known.has(id), `unknown folder ${id}`).toBe(true);
      for (const file of readdirSync(join(ASSETS, id))) {
        expect(known.get(id)!.has(file), `unknown file ${id}/${file}`).toBe(true);
        total += statSync(join(ASSETS, id, file)).size;
      }
    }
    expect(total).toBeLessThan(COLLECTION_LIMITS.totalBytes);
  });

  it('is all here: every preset ready to start (fails until the requested raster art is added)', () => {
    expect(COLLECTION.filter((p) => !presetReady(p, dir)).map((p) => p.id)).toEqual([]);
  });

  it('lists metadata only and serves the small raster thumbnail', () => {
    const entries = collectionEntries(dir);
    expect(entries).toHaveLength(20);
    expect(JSON.stringify(entries).length).toBeLessThan(8000);
    for (const e of entries) expect(Object.keys(e).sort()).toEqual(['description', 'id', 'medium', 'mode', 'name', 'ready', 'swatches']);
    expect(collectionThumb('interference', 'portrait', dir)).toEqual({ path: join(ASSETS, 'interference', 'thumb-portrait.webp'), mime: 'image/webp' });
    expect(collectionThumb('nope', 'portrait', dir)).toBeNull();
  });

  it('draws vector art as one svg layer filling the composition', () => {
    const html = imageWallpaper({ src: '', width: 3840, height: 2160, name: 'interference', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3840 2160" preserveAspectRatio="xMidYMid slice"><rect width="10" height="10"/></svg>' });
    expect(html).toContain('<svg data-bogen-scope="layer" style="position:absolute;inset:0;width:100%;height:100%;display:block" data-name="interference" xmlns=');
    expect(html).not.toContain('<img');
  });
});

describe('starting a preset of the Bogen collection', () => {
  let h: Harness;
  let root: string;
  let home: string;
  let omarchyPath: string;
  const saved = { HOME: process.env.HOME, OMARCHY_PATH: process.env.OMARCHY_PATH, OMAMOBILE_PATH: process.env.OMAMOBILE_PATH, PATH: process.env.PATH, BOGEN_BROWSER: process.env.BOGEN_BROWSER };
  // Chosen with the real $HOME: a browser in ~/.local/bin (secure-chromium) is not found once HOME points elsewhere.
  const browser = findBrowser();
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(`${h.base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() as any : await res.text() };
  };
  const count = () => h.server.storage.list().length;
  const fromPreset = (id: string) => h.server.storage.list().filter((e) => e.theme?.from === presetSource(id));
  const pending = COLLECTION.find((p) => p.medium === 'raster' && !presetReady(p));
  const raster = COLLECTION.find((p) => p.medium === 'raster' && presetReady(p));

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'bogen-collection-'));
    home = join(root, 'home');
    omarchyPath = join(root, 'omarchy');
    const bin = join(root, 'bin');
    mkdirSync(join(omarchyPath, 'themes', 'tokyo-night'), { recursive: true });
    writeFileSync(join(omarchyPath, 'themes', 'tokyo-night', 'colors.toml'), 'mode = "dark"\naccent = "#7aa2f7"\nbackground = "#1a1b26"\nforeground = "#c0caf5"\n');
    mkdirSync(join(home, '.config', 'omarchy', 'themes'), { recursive: true });
    mkdirSync(bin);
    // Stand-ins: one small landscape screen, and an omarchy that is never run here.
    writeFileSync(join(bin, 'hyprctl'), `#!/bin/sh\necho '[{"width":320,"height":180,"transform":0}]'\n`);
    writeFileSync(join(bin, 'omarchy'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'hyprctl'), 0o755);
    chmodSync(join(bin, 'omarchy'), 0o755);
    if (browser) process.env.BOGEN_BROWSER = browser;
    process.env.HOME = home;
    process.env.OMARCHY_PATH = omarchyPath;
    process.env.OMAMOBILE_PATH = join(root, 'no-omamobile');
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

  it('lists the collection without making, opening or rendering anything', async () => {
    const before = count();
    const list = await api('/api/omarchy/collection');
    expect(list.status).toBe(200);
    expect(list.body.available).toBe(true);
    expect(list.body.presets.map((p: any) => p.id)).toEqual(COLLECTION.map((p) => p.id));
    expect(count()).toBe(before);
    const thumb = await api('/api/omarchy/collection/relief-tide/landscape');
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    expect(thumb.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await api('/api/omarchy/collection/relief-tide/sideways')).status).toBe(404);
    expect((await api('/api/omarchy/collection/..%2Fetc/landscape')).status).toBeGreaterThanOrEqual(400);
    expect(count()).toBe(before);
  });

  it('starts a raster preset as an ordinary theme project with its palette, Wallpaper and its own portrait', async () => {
    const before = count();
    const made = await api('/api/omarchy/themes', { preset: 'relief-tide' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'Relief Tide', slug: 'relief-tide', target: 'desktop', branch: { id: 'main' } });
    expect(count()).toBe(before + 1);
    const { doc } = await h.server.rooms.get(made.body.file_id);
    const meta = themeMeta(doc)!;
    expect(meta).toMatchObject({ name: 'Relief Tide', target: 'desktop', mode: 'light', from: 'collection/relief-tide' });
    const tokens = new Map(doc.getTokens().map((t) => [t.name, t.value]));
    const preset = COLLECTION.find((p) => p.id === 'relief-tide')!;
    for (const key of PALETTE_KEYS) expect(tokens.get(tokenForKey(key))).toBe(preset.colors[key]);
    expect(tokens.get('omarchy-shell-bar-background')).toBeDefined();
    // The landscape Wallpaper contains its original raster art, not a placeholder.
    const wall = findMain(doc.source, 'Wallpaper')!;
    expect(doc.descendants(wall.id).some((n) => n.type === 'image' && n.src?.startsWith('bogen-asset:'))).toBe(true);
    expect(landscapeProblems(doc)).toEqual([]);
    // The portrait is its own 9:16 composition, counted as designed.
    const states = await wallpaperStates(h.server, doc, meta);
    expect(states.map((s) => [s.aspect, s.status])).toEqual([['9:16', 'artwork']]);
    const portrait = findMain(doc.source, states[0]!.component)!;
    expect(doc.descendants(portrait.id).some((n) => n.type === 'image' && n.src?.startsWith('bogen-asset:'))).toBe(true);
    expect(meta.wallpapers?.every((w) => w.placeholder === false)).toBe(true);
  });

  it('opens the same project again on the next start, so edits and branches stay in one file', async () => {
    const first = fromPreset('relief-tide');
    expect(first).toHaveLength(1);
    const before = count();
    const again = await api('/api/omarchy/themes', { preset: 'relief-tide' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ file_id: first[0]!.id, reused: true });
    expect(again.body.next).toContain('design_branch_create');
    expect(count()).toBe(before);
  });

  it('makes a separate theme only with new_project, and then asks which one to open', async () => {
    const before = count();
    const second = await api('/api/omarchy/themes', { preset: 'relief-tide', new_project: true });
    expect(second.status).toBe(201);
    expect(second.body.name).toBe('Relief Tide 2');
    expect(count()).toBe(before + 1);
    const ask = await api('/api/omarchy/themes', { preset: 'relief-tide' });
    expect(ask.status).toBe(409);
    expect(ask.body.needs_choice).toBe(true);
    expect(ask.body.choose.map((c: any) => c.name).sort()).toEqual(['Relief Tide', 'Relief Tide 2']);
    expect(count()).toBe(before + 1);
  });

  it('lists a project started from a preset as a draft, never as installed', async () => {
    const lib = await api('/api/omarchy/library');
    const rows = lib.body.projects.filter((p: any) => p.from === 'collection/relief-tide');
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.status).toBe('draft');
    expect(lib.body.installed.some((i: any) => i.name === 'relief-tide')).toBe(false);
  });

  it('refuses what a preset is not, and an unknown preset, making nothing', async () => {
    const before = count();
    expect((await api('/api/omarchy/themes', { preset: 'interference', target: 'mobile' })).status).toBe(400);
    expect((await api('/api/omarchy/themes', { preset: 'interference', from: 'tokyo-night' })).status).toBe(400);
    expect((await api('/api/omarchy/themes', { preset: 'interference', name: 'Mine' })).status).toBe(400);
    expect((await api('/api/omarchy/themes', { preset: 'no-such-preset' })).status).toBe(404);
    expect(count()).toBe(before);
  });

  it.skipIf(!pending)('refuses a preset whose art has not arrived, with no stand-in file', async () => {
    const before = count();
    const out = await api('/api/omarchy/themes', { preset: pending!.id });
    expect(out.status).toBe(409);
    expect(out.body.error).toContain('not ready');
    expect(count()).toBe(before);
    expect((await api(`/api/omarchy/collection/${pending!.id}/landscape`)).status).toBe(404);
  });

  it.skipIf(!raster)('starts a raster preset with its pictures as artwork of their own shapes', async () => {
    const made = await api('/api/omarchy/themes', { preset: raster!.id });
    expect(made.status).toBe(201);
    const { doc } = await h.server.rooms.get(made.body.file_id);
    const meta = themeMeta(doc)!;
    expect(landscapeProblems(doc)).toEqual([]);
    const states = await wallpaperStates(h.server, doc, meta);
    expect(states.map((s) => [s.aspect, s.status, s.image?.width, s.image?.height])).toEqual([['9:16', 'artwork', 2160, 3840]]);
  });

  it('is not offered, and refuses to start, on an Omarchy Mobile phone or a machine without Omarchy', async () => {
    const before = count();
    mkdirSync(join(root, 'omamobile'), { recursive: true });
    process.env.OMAMOBILE_PATH = join(root, 'omamobile');
    try {
      expect((await api('/api/omarchy/collection')).body).toEqual({ available: false, presets: [] });
      expect((await api('/api/omarchy/collection/interference/landscape')).status).toBe(404);
      expect((await api('/api/omarchy/themes', { preset: 'interference' })).status).toBe(409);
    } finally {
      process.env.OMAMOBILE_PATH = join(root, 'no-omamobile');
    }
    process.env.OMARCHY_PATH = join(root, 'no-omarchy');
    process.env.HOME = join(root, 'elsewhere');
    try {
      expect((await api('/api/omarchy/collection')).body).toEqual({ available: false, presets: [] });
      const out = await api('/api/omarchy/themes', { preset: 'interference' });
      expect(out.status).toBe(409);
      expect(out.body.error).toContain('does not run Omarchy');
    } finally {
      process.env.OMARCHY_PATH = omarchyPath;
      process.env.HOME = home;
    }
    expect(count()).toBe(before);
  });

  // Exercise ordinary palette/render primitives without running the portrait export or runtime.
  it.skipIf(!browser)('writes its ordinary palette and shell data and renders its raster landscape', async () => {
    const made = await api('/api/omarchy/themes', { preset: 'interference' });
    expect([200, 201]).toContain(made.status);
    const { doc } = await h.server.rooms.get(made.body.file_id);
    const meta = themeMeta(doc)!;
    const out = themeFromTokens(doc.getTokens(), meta);
    const toml = colorsToml(out);
    expect(toml).toContain('mode = "dark"');
    expect(toml).toContain('accent = "#d46b4f"');
    expect(toml).toContain('hyprland_inactive_border = "rgba(3a3936aa)"');
    expect(shellFromTokens(doc.getTokens()).toml).toBeTruthy();
    const background = doc.getPages().flatMap((p) => doc.getChildren(p.id)).find((n) => n.name === 'Background 1 · interference.jpg')!;
    expect(background).toBeDefined();
    const rendered = await h.server.renderer.screenshot(doc, { nodeIds: [background.id] }, { format: 'png', scale: 0.25 });
    // This fixture's one monitor is 320 × 180; the wallpaper fills that board, then scales to the requested quarter size.
    expect(imageSize(rendered.bytes)).toEqual({ width: 80, height: 45 });
    expect(out.problems).toEqual([]);
    // The first render of this file starts the browser, which alone can take longer than the default 5 s on a busy machine.
  }, 30_000);
});
