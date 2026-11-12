import { googleFontsHrefs } from '@bogen/core';
import { api, type FontEntry } from './api.ts';

/** Offline-safe starting list. The server can offer the full Google Fonts catalogue on /api/fonts. */
const POPULAR = ['Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Source Sans 3', 'Source Serif 4', 'Source Code Pro', 'Noto Sans', 'Noto Serif', 'Raleway', 'Nunito', 'Work Sans', 'DM Sans', 'DM Serif Display', 'Manrope', 'Rubik', 'Karla', 'Mulish', 'Oswald', 'Playfair Display', 'Merriweather', 'Lora', 'PT Sans', 'PT Serif', 'IBM Plex Sans', 'IBM Plex Serif', 'IBM Plex Mono', 'JetBrains Mono', 'Fira Sans', 'Fira Code', 'Space Grotesk', 'Space Mono', 'Geist', 'Geist Mono', 'Figtree', 'Outfit', 'Plus Jakarta Sans', 'Sora', 'Lexend', 'Instrument Sans', 'Instrument Serif', 'Bricolage Grotesque', 'Fraunces', 'Newsreader', 'Crimson Pro', 'Libre Baskerville', 'Libre Franklin', 'Cabin', 'Barlow', 'Archivo', 'Syne', 'Unbounded', 'Bebas Neue', 'Anton', 'Abril Fatface', 'Caveat', 'Pacifico', 'Lobster'];

let cache: Promise<FontEntry[]> | null = null;

export function listFonts(): Promise<FontEntry[]> {
  if (!cache) {
    cache = api.fonts().catch(() => []).then((fonts) => {
      if (fonts.length) return fonts;
      return POPULAR.map((family) => ({ family, source: 'google' as const }));
    });
  }
  return cache;
}

interface LocalFontData { family: string }
declare global {
  interface Window { queryLocalFonts?: () => Promise<LocalFontData[]> }
}

export async function listLocalFonts(): Promise<FontEntry[]> {
  if (!window.queryLocalFonts) return [];
  try {
    const raw = await window.queryLocalFonts();
    return [...new Set(raw.map((f) => f.family))].map((family) => ({ family, source: 'local' as const }));
  } catch {
    return [];
  }
}

const loaded = new Set<string>();
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'cursive', 'fantasy', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'inherit', 'initial', 'unset']);

export function primaryFamily(fontFamily: string): string {
  return (fontFamily.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}

/** Loads a family from Google Fonts once. The legacy endpoint ignores weights a family lacks. */
export function ensureFont(fontFamily: string | undefined, hosted?: Set<string>): void {
  if (!fontFamily) return;
  const family = primaryFamily(fontFamily);
  if (!family || hosted?.has(family.toLowerCase()) || loaded.has(family) || GENERIC.has(family.toLowerCase()) || family.startsWith('var(')) return;
  loaded.add(family);
  for (const href of googleFontsHrefs(family)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
}
