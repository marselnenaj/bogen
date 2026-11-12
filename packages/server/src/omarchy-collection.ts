// The Bogen collection: twenty original Omarchy desktop themes that ship with Bogen as a catalog, not as files.
//
// Each preset is a palette and two wallpapers composed for it: a 16:9 landscape and a 9:16 portrait, never one cropped
// from the other. The catalog now uses original raster artwork with bounded previews. The loader still supports editable SVG. Painting, photography and
// collage are raster files. Listing the catalog reads metadata and stats a few files; a theme file is made only when a
// person starts a preset (omarchy-themes.ts, createThemeFile with `preset`), through the ordinary theme path.
//
// The art lives in packages/server/assets/omarchy-collection/<id>/, copied to dist/omarchy-collection/ by the build.

import { lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALETTE_KEYS, type ThemeColors, type ThemeMode } from './omarchy-theme.ts';
import { HttpError } from './util.ts';

export type CollectionMedium = 'vector' | 'raster';
export type ArtOrientation = 'landscape' | 'portrait';

export interface CollectionPreset {
  /** Folder of its art and the stable part of its source, `collection/<id>`. */
  id: string;
  name: string;
  description: string;
  mode: ThemeMode;
  /** Vector art is authored SVG; raster art is a painting, photograph or collage. */
  medium: CollectionMedium;
  /** Every key of colors.toml. */
  colors: Record<string, string>;
  /** Hyprland borders as colors.toml writes them; left out, Omarchy's defaults. */
  borders?: { active?: string; inactive?: string };
}

/** The sizes the art is composed at. */
export const ART_SIZE: Record<ArtOrientation, { width: number; height: number }> = {
  landscape: { width: 3840, height: 2160 },
  portrait: { width: 2160, height: 3840 },
};

/** What a shipped file may weigh, so the collection stays small and opening a theme never reads anything large. */
export const COLLECTION_LIMITS = {
  svgBytes: 80_000,
  /** Elements in one SVG, as a bound on what the canvas draws in each preview. */
  svgElements: 1500,
  wallpaperBytes: 1_400_000,
  thumbBytes: 64_000,
  totalBytes: 25_000_000,
} as const;

const SOURCE_PREFIX = 'collection/';
export const presetSource = (id: string): string => `${SOURCE_PREFIX}${id}`;
export const presetIdOf = (from: string | undefined): string | null => (from?.startsWith(SOURCE_PREFIX) ? from.slice(SOURCE_PREFIX.length) : null);

const ART_FILE: Record<CollectionMedium, Record<ArtOrientation, string>> = {
  vector: { landscape: 'landscape.svg', portrait: 'portrait.svg' },
  raster: { landscape: 'landscape.jpg', portrait: 'portrait.jpg' },
};
const THUMB_FILE: Record<ArtOrientation, string> = { landscape: 'thumb-landscape.webp', portrait: 'thumb-portrait.webp' };
const MIME: Record<string, string> = { svg: 'image/svg+xml', jpg: 'image/jpeg', webp: 'image/webp' };

const P = (
  accent: string, selection: string, muted: string,
  background: string, dark_background: string, darker_background: string, lighter_background: string,
  foreground: string, dark_foreground: string, light_foreground: string, bright_foreground: string,
  red: string, yellow: string, orange: string, green: string, cyan: string, blue: string, magenta: string, brown: string,
  bright_red: string, bright_yellow: string, bright_green: string, bright_cyan: string, bright_blue: string, bright_magenta: string,
): Record<string, string> => ({
  accent, selection, muted, background, dark_background, darker_background, lighter_background, foreground, dark_foreground, light_foreground, bright_foreground,
  red, yellow, orange, green, cyan, blue, magenta, brown, bright_red, bright_yellow, bright_green, bright_cyan, bright_blue, bright_magenta,
});

/** The catalog, in the order Home shows it: vector and raster, dark and light, interleaved. */
export const COLLECTION: readonly CollectionPreset[] = [
  {
    id: 'interference', name: 'Interference', mode: 'dark', medium: 'raster',
    description: 'Monumental concrete ribs and a narrow cut of pale sky: warm bone, deep charcoal and the grain of architectural photography.',
    colors: P('#d46b4f', '#3a3936', '#8a8a84', '#0f0f0e', '#0a0a09', '#050505', '#1d1d1b', '#ecebe4', '#9d9c95', '#d6d5ce', '#fafaf5',
      '#ff5f45', '#e8d36a', '#f2914a', '#9fcf7d', '#7fd1c8', '#8fb0ff', '#e08ad6', '#a07658', '#ff8a75', '#f4e59a', '#bfe7a2', '#a6ebe2', '#b5cbff', '#f0b2e8'),
    borders: { inactive: 'rgba(3a3936aa)' },
  },
  {
    id: 'ink-harbour', name: 'Ink Harbour', mode: 'light', medium: 'raster',
    description: 'Sumi ink wash on rice paper: pilings and moored skiffs dissolving into harbour mist, with one faint slate-blue wash.',
    colors: P('#33506b', '#d2d6da', '#6b6965', '#eeebe3', '#e2ded4', '#ccc7bb', '#f8f6f1', '#1c1c1e', '#55554f', '#33332f', '#050506',
      '#9e3a32', '#7a6214', '#9a5424', '#4a6a3e', '#2f6670', '#2f4f86', '#7a3f6e', '#6a5038', '#b84a3f', '#8f7420', '#5a7f4c', '#3f7f8a', '#4566a0', '#955384'),
    borders: { inactive: 'rgba(7a7872aa)' },
  },
  {
    id: 'sodium-facade', name: 'Sodium Facade', mode: 'dark', medium: 'raster',
    description: 'Weathered concrete balconies at night, a handful of amber windows and quiet ink-blue sky, with the atmosphere of analog photography.',
    colors: P('#f29a3a', '#2a3a3e', '#718182', '#0e1416', '#0a0f11', '#050809', '#182125', '#d9dcd6', '#8e9a98', '#c3c8c2', '#f3f1e8',
      '#e8644f', '#f0c862', '#e8873a', '#8fbf8a', '#6fc1c4', '#7fa6d9', '#c995c4', '#a8794f', '#ff8a70', '#ffe08a', '#b2dbab', '#98dfe0', '#a7c4ef', '#e2b6dd'),
    borders: { inactive: 'rgba(2a3a3eaa)' },
  },
  {
    id: 'relief-tide', name: 'Relief Tide', mode: 'light', medium: 'raster',
    description: 'An indigo woodblock sea on warm washi: carved foam, a distant headland and a single small vermilion fishing boat.',
    colors: P('#2f4fa0', '#cbd3e6', '#6d6962', '#f1eadb', '#e6dcc8', '#d6c9b0', '#f8f3e8', '#1d2747', '#4f5672', '#2e3758', '#0f1630',
      '#a8281e', '#7d600a', '#a4500f', '#3f6b2a', '#1f6a6e', '#24408a', '#8a2f6e', '#6e4a2c', '#c4402c', '#9c7a12', '#4f8236', '#2a8288', '#3d5fbf', '#a8418a'),
    borders: { inactive: 'rgba(7a7466aa)' },
  },
  {
    id: 'kiln', name: 'Kiln', mode: 'dark', medium: 'raster',
    description: 'Hand-thrown dark stoneware, pooled lavender glaze and a small copper-red firing mark, photographed in quiet studio light.',
    colors: P('#a58fd6', '#342c40', '#857b8f', '#16131a', '#100e13', '#09080b', '#221e28', '#e6e0e8', '#9a92a2', '#cdc6d0', '#fbf7fc',
      '#d9655a', '#d9bd6a', '#d98a52', '#93b48a', '#7fb8bf', '#8aa0e0', '#c784c4', '#a8806a', '#ec8c82', '#ecd697', '#b2ccaa', '#a4d0d5', '#aebcf0', '#dcaad9'),
    borders: { active: '#a58fd6', inactive: 'rgba(342c40aa)' },
  },
  {
    id: 'signal-grammar', name: 'Signal Grammar', mode: 'light', medium: 'raster',
    description: 'A tactile modernist paper sculpture in ultramarine, vermilion, ochre and black, with natural studio shadows on warm ivory.',
    colors: P('#d0281e', '#ffd84a', '#6e6a62', '#f4f4f1', '#e7e6e1', '#d3d2cb', '#fdfdfb', '#141414', '#4a4843', '#2a2926', '#000000',
      '#b8201a', '#866400', '#c2510a', '#1e7a3c', '#00728a', '#2447b8', '#b0237a', '#7a4a1e', '#d63a2e', '#a07c00', '#2b9550', '#0a8aa6', '#3d6ae6', '#cc3d96'),
    borders: { active: '#d0281e', inactive: 'rgba(6e6a62aa)' },
  },
  {
    id: 'lead-came', name: 'Lead Came', mode: 'dark', medium: 'raster',
    description: 'Rippled smoky cobalt and teal glass in a shadowed stone chapel, imperfect lead seams and one small amber pane.',
    colors: P('#86b1ab', '#2c3340', '#7a7f8a', '#121417', '#0c0d10', '#060708', '#1e2228', '#e4e0d6', '#9a978f', '#cbc7bd', '#fbf8f0',
      '#e2566a', '#e8b84a', '#e0874a', '#62c08a', '#4fb8c8', '#6a8ff0', '#b77de0', '#a47a52', '#f2849a', '#f6d488', '#92dcae', '#86d8e4', '#9fb8f7', '#d3aaf0'),
    borders: { active: '#86b1ab', inactive: 'rgba(2c3340aa)' },
  },
  {
    id: 'fresco-dust', name: 'Fresco Dust', mode: 'light', medium: 'raster',
    description: 'Weathered lime plaster, faded red ochre and terre verte, with the shadow of draped cloth and the texture of a worn fresco.',
    colors: P('#3f6b56', '#e6c3a8', '#726351', '#ede2d0', '#e2d4bd', '#cfbfa3', '#f6efe3', '#2e231c', '#5e5040', '#43362a', '#160f0a',
      '#a33a26', '#7f6210', '#a55a22', '#4a6a2e', '#2e6a6a', '#3a5585', '#8a3f5a', '#74502e', '#bd4a32', '#94761a', '#5a8040', '#3d8080', '#4a6aa0', '#a3506e'),
    borders: { inactive: 'rgba(857560aa)' },
  },
  {
    id: 'night-line', name: 'Night Line', mode: 'dark', medium: 'raster',
    description: 'A late train over a rainy harbour: midnight blue, quiet amber carriage windows, wet stone and restrained analog grain.',
    colors: P('#d5b272', '#2b3445', '#788294', '#15181f', '#10131a', '#0a0c11', '#1f2430', '#e8ecf2', '#8f98a8', '#c7cdd8', '#ffffff',
      '#ff5a5f', '#ffd23f', '#ff8c42', '#4fd18b', '#3fd0d4', '#5b8def', '#d77cf2', '#b0835a', '#ff8a8e', '#ffe27a', '#86e6b1', '#7fe3e6', '#8fb1f7', '#e6a6f7'),
    borders: { inactive: 'rgba(2b3445aa)' },
  },
  {
    id: 'contour-survey', name: 'Contour Survey', mode: 'light', medium: 'raster',
    description: 'An Alpine massif engraved in olive-grey ink: fine hachures, shaded relief and quiet sage-ivory survey paper.',
    colors: P('#7a4416', '#d3d9bf', '#6c6b55', '#e9ecdf', '#dde1d0', '#c9cfb8', '#f4f6ec', '#2b2318', '#5a5240', '#3d3526', '#17120a',
      '#a8302a', '#7a6408', '#a65518', '#3b6b2c', '#1f6670', '#2f5487', '#a3246b', '#6b4a26', '#c24236', '#8f7612', '#4d8a3a', '#2a7f8a', '#3f6aa8', '#bf3a85'),
    borders: { inactive: 'rgba(77775faa)' },
  },
  {
    id: 'cyanotype-fern', name: 'Cyanotype Fern', mode: 'dark', medium: 'raster',
    description: 'A fern contact print on hand-coated Prussian-blue paper: pale fronds, fine botanical detail and an uneven cream border.',
    colors: P('#e8d9a8', '#24456e', '#738dab', '#0f2440', '#0b1c33', '#071426', '#193356', '#eef3f6', '#a3b7c9', '#d4e0e8', '#ffffff',
      '#f0827a', '#f0d77a', '#f0a66a', '#9ed69a', '#8ad9e6', '#9dbcf2', '#dca0e6', '#c9a07e', '#ffa8a0', '#fff0b0', '#c0eabc', '#b2ecf4', '#c4d8fa', '#ecc4f2'),
    borders: { inactive: 'rgba(24456eaa)' },
  },
  {
    id: 'overprint', name: 'Overprint', mode: 'light', medium: 'raster',
    description: 'A handmade magnolia print in indigo and muted raspberry, with carved veins, imperfect registration and warm paper grain.',
    colors: P('#304d85', '#f7c6d5', '#726679', '#f7ebe4', '#eddcd3', '#dcc6bb', '#fdf8f4', '#1b1f4b', '#4a4d78', '#2e3263', '#0d1035',
      '#b8263a', '#8a6200', '#b84a14', '#1f7a52', '#0f6f8a', '#2a3f9e', '#9a2a8a', '#7a4a35', '#d6344a', '#a07800', '#2b9466', '#1585a6', '#3d56c4', '#b83aa6'),
    borders: { active: '#304d85', inactive: 'rgba(8a7a86aa)' },
  },
  {
    id: 'basalt', name: 'Basalt', mode: 'dark', medium: 'raster',
    description: 'Black coastal columns, cold Atlantic surf and northern mist: a charcoal-and-petrol geological landscape.',
    colors: P('#b5c48a', '#2e3033', '#7a7d7f', '#101112', '#0b0c0d', '#060606', '#1b1c1e', '#d6d6d2', '#8c8d8a', '#b8b8b4', '#f2f2ee',
      '#d0786a', '#d4c07a', '#d49a6a', '#9fb88a', '#8ab8b8', '#8aa2c4', '#b896b8', '#9a8270', '#e89a8e', '#e8d89c', '#bcd2a8', '#a8d2d2', '#a8bcd8', '#d0b2d0'),
    borders: { inactive: 'rgba(2e3033aa)' },
  },
  {
    id: 'endpaper', name: 'Endpaper', mode: 'light', medium: 'raster',
    description: 'Restrained hand-marbled endpaper: fine violet and teal currents, warm cream space and small rust-colored pools.',
    colors: P('#5b3fa0', '#ddd2ec', '#71677b', '#f3eee2', '#e8e1d2', '#d6cdb9', '#fbf8f1', '#221a2e', '#5a506a', '#3a3048', '#0d0814',
      '#a8323a', '#7a5f0a', '#a8541e', '#2f6e4a', '#156e78', '#2f4f9a', '#8a2f80', '#6e4a35', '#c4434a', '#927614', '#3f8a5e', '#1f8792', '#4566b8', '#a8459e'),
    borders: { inactive: 'rgba(82788caa)' },
  },
  {
    id: 'oxblood', name: 'Oxblood', mode: 'dark', medium: 'raster',
    description: 'Pomegranate, quince and a pewter vessel on oxblood cloth, painted in deep shadow with a narrow wash of window light.',
    colors: P('#d6b24c', '#4a1f1c', '#897a6e', '#17100e', '#110b0a', '#0a0606', '#261a17', '#eadfcc', '#a39484', '#d1c5b2', '#fbf3e4',
      '#d4574a', '#e0c06a', '#d98a4a', '#9fae6a', '#84b0a6', '#8a9fc4', '#c0849f', '#a87a52', '#ea7f72', '#f0d894', '#bcc890', '#a6cac2', '#aebad8', '#d8a6bc'),
    borders: { inactive: 'rgba(4a1f1caa)' },
  },
  {
    id: 'parcel', name: 'Parcel', mode: 'light', medium: 'raster',
    description: 'Tuscan fields, cypress shadows and a winding farm lane in morning mist, photographed in muted olive and harvested ochre.',
    colors: P('#4a6a14', '#d6dbb0', '#6c664c', '#ece4cf', '#e0d6bc', '#cdc1a2', '#f6f1e2', '#262a1a', '#5b5a40', '#3a3d28', '#12140a',
      '#a43a22', '#786000', '#a15214', '#3d6a24', '#2a6a6a', '#3a5a85', '#8a3a6a', '#74502a', '#c04a2c', '#957800', '#4f8530', '#348585', '#4a72a8', '#a8508a'),
    borders: { inactive: 'rgba(7d7558aa)' },
  },
  {
    id: 'selvedge', name: 'Selvedge', mode: 'dark', medium: 'raster',
    description: 'Midnight woven cloth, one sculptural fold and a fine copper thread: a quiet tactile study in navy and shadow.',
    colors: P('#e88a9a', '#2d3756', '#7a829c', '#141a2a', '#0f1422', '#090c16', '#1f2740', '#e2e0d8', '#8f93a6', '#c4c3bd', '#f7f5ee',
      '#e0606a', '#e6c46a', '#e6935a', '#8fc48f', '#7cc4cf', '#7f9ae6', '#c88fd6', '#b08a68', '#f2909a', '#f2dc9a', '#b2dcb2', '#a6dce4', '#a8bcf2', '#e0b4ea'),
    borders: { inactive: 'rgba(2d3756aa)' },
  },
  {
    id: 'paste-up', name: 'Paste-Up', mode: 'light', medium: 'raster',
    description: 'An architectural photocollage in torn black-and-white paper, warm kraft and a small orange cutout, composed by hand.',
    colors: P('#b03e0a', '#f3cdb0', '#69665f', '#e9e6df', '#dcd8cf', '#c8c3b8', '#f5f3ee', '#151515', '#4f4c46', '#2f2d2a', '#000000',
      '#b3261e', '#7d6000', '#a85010', '#2f6b2f', '#106a7a', '#2a3fa8', '#9a2a7a', '#6a4a2a', '#d1382c', '#957400', '#3f8a3f', '#1a8496', '#3f58cc', '#b8459a'),
    borders: { inactive: 'rgba(77736baa)' },
  },
  {
    id: 'glasshouse', name: 'Glasshouse', mode: 'dark', medium: 'raster',
    description: 'A moonlit iron-and-glass conservatory: silver-blue panes, dark foliage and wet stone, photographed without neon lighting.',
    colors: P('#92b6a0', '#2a3a33', '#6f8279', '#0e1311', '#0a0e0c', '#050706', '#18201c', '#e0e8e2', '#92a198', '#c4cec6', '#f6fbf7',
      '#e86a6a', '#e3cf6f', '#e8955a', '#7fd18e', '#6fcfc0', '#7fa8e6', '#d58ae0', '#a88a62', '#f39494', '#efe09a', '#a8e4b2', '#9ae2d6', '#a8c4f0', '#e8b0ef'),
    borders: { active: '#92b6a0', inactive: 'rgba(2a3a33aa)' },
  },
  {
    id: 'terrazzo', name: 'Terrazzo', mode: 'light', medium: 'raster',
    description: 'Honed ivory stone with forest-green marble and terracotta fragments, composed as a quiet architectural material study.',
    colors: P('#1a6e63', '#cfe0d8', '#716b62', '#f1ede6', '#e5e0d6', '#d2ccbf', '#fbf9f5', '#1e1d1b', '#57534c', '#36342f', '#080807',
      '#a8322e', '#7d6006', '#a8521e', '#2f6e3a', '#1a6e74', '#2d4f8a', '#8a3366', '#6e4a30', '#c4433a', '#957408', '#3f8a4a', '#248790', '#3f65ad', '#a8437e'),
    borders: { inactive: 'rgba(7c766caa)' },
  },
];

const byId = new Map(COLLECTION.map((p) => [p.id, p]));

/** A preset by id; a 404 for one the catalog does not have. */
export function collectionPreset(id: string): CollectionPreset {
  const preset = byId.get(id);
  if (!preset) throw new HttpError(404, `There is no "${id}" in the Bogen collection. It has: ${COLLECTION.map((p) => p.id).join(', ')}.`);
  return preset;
}

/** Where the art is: $BOGEN_COLLECTION_DIR, next to the bundle (dist/), or in the source tree. Null when none is there. */
export function collectionDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [env.BOGEN_COLLECTION_DIR, join(here, 'omarchy-collection'), join(here, '..', 'assets', 'omarchy-collection')]) {
    if (dir && isDir(dir)) return dir;
  }
  return null;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A regular file, not a symlink, of at most `max` bytes; its size, or null. */
function plainSize(path: string, max: number): number | null {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.size > 0 && st.size <= max ? st.size : null;
  } catch {
    return null;
  }
}

/** Every file a preset ships, with the most it may weigh. */
export function presetFiles(preset: CollectionPreset): { file: string; role: 'art' | 'thumb'; orientation: ArtOrientation; max: number }[] {
  const art = (['landscape', 'portrait'] as const).map((o) => ({ file: ART_FILE[preset.medium][o], role: 'art' as const, orientation: o, max: preset.medium === 'vector' ? COLLECTION_LIMITS.svgBytes : COLLECTION_LIMITS.wallpaperBytes }));
  // Vector art is its own thumbnail: the browser draws it small. Raster art has small WebP copies.
  const thumbs = preset.medium === 'raster' ? (['landscape', 'portrait'] as const).map((o) => ({ file: THUMB_FILE[o], role: 'thumb' as const, orientation: o, max: COLLECTION_LIMITS.thumbBytes })) : [];
  return [...art, ...thumbs];
}

/** Whether every file of a preset is there and within its limit. Stats only; nothing is read. */
export function presetReady(preset: CollectionPreset, dir: string | null = collectionDir()): boolean {
  if (!dir) return false;
  return presetFiles(preset).every((f) => plainSize(join(dir, preset.id, f.file), f.max) !== null);
}

/** What Home lists of a preset: a few words and colours, no art. */
export interface CollectionEntry {
  id: string;
  name: string;
  description: string;
  mode: ThemeMode;
  medium: CollectionMedium;
  /** Background, foreground, accent and four hues, as the installed themes list them. */
  swatches: string[];
  /** Its art is all here. A preset still waiting for its art is not offered. */
  ready: boolean;
}

export function collectionEntries(dir: string | null = collectionDir()): CollectionEntry[] {
  return COLLECTION.map((p) => ({
    id: p.id, name: p.name, description: p.description, mode: p.mode, medium: p.medium,
    swatches: ['background', 'foreground', 'accent', 'red', 'yellow', 'green', 'blue'].map((k) => p.colors[k]!),
    ready: presetReady(p, dir),
  }));
}

/** The small picture of a preset for Home: the SVG itself for vector art, the WebP copy for raster. */
export function collectionThumb(id: string, orientation: ArtOrientation, dir: string | null = collectionDir()): { path: string; mime: string } | null {
  const preset = byId.get(id);
  if (!preset || !dir) return null;
  const file = preset.medium === 'vector' ? ART_FILE.vector[orientation] : THUMB_FILE[orientation];
  const max = preset.medium === 'vector' ? COLLECTION_LIMITS.svgBytes : COLLECTION_LIMITS.thumbBytes;
  const path = join(dir, preset.id, file);
  if (plainSize(path, max) === null) return null;
  return { path, mime: MIME[file.split('.').pop()!]! };
}

/** The palette of a preset as a colors.toml would read: every key, the mode and the borders. */
export function presetColors(preset: CollectionPreset): ThemeColors {
  const colors: Record<string, string> = {};
  for (const key of PALETTE_KEYS) colors[key] = preset.colors[key]!;
  const raw: Record<string, string> = {};
  if (preset.borders?.active) raw.hyprland_active_border = preset.borders.active;
  if (preset.borders?.inactive) raw.hyprland_inactive_border = preset.borders.inactive;
  return { mode: preset.mode, colors, raw };
}

/** Why an SVG of the collection is not fit to ship: anything that runs, reaches out, filters or animates. Empty when fine. */
export function svgProblems(markup: string, orientation: ArtOrientation): string[] {
  const out: string[] = [];
  const { width, height } = ART_SIZE[orientation];
  const open = /^<svg\b[^>]*>/.exec(markup)?.[0];
  if (!open) return ['It does not start with <svg>.'];
  if (!open.includes(`viewBox="0 0 ${width} ${height}"`)) out.push(`Its viewBox is not 0 0 ${width} ${height}.`);
  if (!open.includes('preserveAspectRatio="xMidYMid slice"')) out.push('It does not fill its frame (preserveAspectRatio="xMidYMid slice").');
  if (/\s(style|width|height)=/.test(open)) out.push('Its root sets style, width or height; the layer sizes it.');
  for (const [re, why] of [
    [/<script/i, 'a script'], [/<foreignObject/i, 'foreign content'], [/<image/i, 'an embedded image'], [/<filter/i, 'a filter (costly to draw in every preview)'],
    [/<(animate|set)\b/i, 'animation'], [/<style/i, 'a style sheet'], [/\son\w+=/i, 'an event handler'], [/xlink:/i, 'xlink attributes'],
    [/href="(?!#)/i, 'a reference outside the file'], [/url\((?!#)/i, 'a url outside the file'], [/<!--/, 'a comment'],
  ] as const) if (re.test(markup)) out.push(`It has ${why}.`);
  const elements = (markup.match(/<[a-zA-Z]/g) ?? []).length;
  if (elements > COLLECTION_LIMITS.svgElements) out.push(`It has ${elements} elements, over ${COLLECTION_LIMITS.svgElements}.`);
  return out;
}

export interface PresetArtFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
  /** Vector art: its markup and the size it is composed at. */
  svg?: { markup: string; width: number; height: number };
}

/**
 * The two wallpapers of a preset, read for a theme file being made. A preset whose art has not all arrived is refused
 * with 409, and broken vector art with 500: either way before any file is made.
 */
export function presetArt(preset: CollectionPreset, dir: string | null = collectionDir()): Record<ArtOrientation, PresetArtFile> {
  if (!presetReady(preset, dir)) throw new HttpError(409, `${preset.name} is not ready to start: its artwork has not been added to this build of Bogen yet. Nothing was made.`);
  const read = (orientation: ArtOrientation): PresetArtFile => {
    const file = ART_FILE[preset.medium][orientation];
    const bytes = readFileSync(join(dir!, preset.id, file));
    const label = `${preset.id}${orientation === 'portrait' ? '-portrait' : ''}`;
    if (preset.medium === 'raster') return { name: `${label}.jpg`, bytes, mime: MIME.jpg! };
    const markup = bytes.toString('utf8').trim();
    const problems = svgProblems(markup, orientation);
    if (problems.length) throw new HttpError(500, `The collection's ${preset.id}/${file} cannot be used: ${problems.join(' ')} Nothing was made.`);
    // No extension: the export renders it and names the PNG after it.
    return { name: label, bytes, mime: MIME.svg!, svg: { markup, ...ART_SIZE[orientation] } };
  };
  return { landscape: read('landscape'), portrait: read('portrait') };
}
