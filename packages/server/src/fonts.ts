import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GOOGLE_FONTS } from './google-fonts.ts';

const run = promisify(execFile);
const CACHE_MS = 5 * 60_000;
let cache: { at: number; fonts: string[] } | null = null;

/** Parses `system_profiler SPFontsDataType -json`. A Mac has no fontconfig unless Homebrew brought it. */
export function parseMacFonts(json: string): string[] {
  const names = new Set<string>();
  try {
    const data = JSON.parse(json) as { SPFontsDataType?: { typefaces?: { family?: unknown }[] }[] };
    for (const file of data.SPFontsDataType ?? []) {
      for (const face of file.typefaces ?? []) if (typeof face.family === 'string' && face.family && !face.family.startsWith('.')) names.add(face.family);
    }
  } catch {
    return [];
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

async function macFonts(): Promise<string[]> {
  try {
    const { stdout } = await run('system_profiler', ['SPFontsDataType', '-json'], { timeout: 30_000, maxBuffer: 128 * 1024 * 1024 });
    return parseMacFonts(stdout);
  } catch {
    return [];
  }
}

/** Family names the system knows, through fontconfig or on a Mac through `system_profiler`. */
export async function localFonts(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.fonts;
  let fonts: string[] = [];
  try {
    const { stdout } = await run('fc-list', [':', 'family'], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
    const names = new Set<string>();
    for (const line of stdout.split('\n')) {
      const first = line.split(',')[0]?.trim();
      if (first && !first.startsWith('.')) names.add(first);
    }
    fonts = [...names].sort((a, b) => a.localeCompare(b));
  } catch {
    // No fontconfig on this system.
    if (process.platform === 'darwin') fonts = await macFonts();
  }
  cache = { at: Date.now(), fonts };
  return fonts;
}

export interface FontList {
  local: string[];
  google: string[];
  note: string;
}

export async function listFonts(query = '', source: 'all' | 'local' | 'google' = 'all', limit = 80): Promise<FontList> {
  const q = query.toLowerCase();
  const match = (list: string[]) => list.filter((f) => f.toLowerCase().includes(q)).slice(0, limit);
  return {
    local: source === 'google' ? [] : match(await localFonts()),
    google: source === 'local' ? [] : match(GOOGLE_FONTS),
    note: 'Set style fontFamily to any of these. Screenshots and exports load Google Fonts by family name, including families not listed here.',
  };
}

/** Families used by a doc, read from layer styles and font-family tokens. */
export function firstFamily(value: string): string {
  return value.split(',')[0]!.trim().replace(/^["']|["']$/g, '');
}

