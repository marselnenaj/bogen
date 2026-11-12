/**
 * Which language this device shows: the person's choice, or "Automatic".
 *
 * The choice is this browser's alone (localStorage), like the other settings: it is never written into a design,
 * synced to another device or sent to the server. "Automatic" follows, in order:
 *
 * 1. Omarchy's language, when Bogen runs on this Omarchy computer (`/api/language`, answered only for this machine);
 * 2. the browser's languages, which on a phone, a Mac or any other computer follow the system's;
 * 3. the session's locale (`LANG` and friends) of the computer Bogen runs on, for this machine only;
 * 4. English.
 */
import { useSyncExternalStore } from 'react';
import { isLanguageCode, SOURCE_LANGUAGE } from './registry.ts';
import { resolveLanguage } from './resolve.ts';
import { showLanguage } from './store.ts';

export type LanguagePreference = 'auto' | string;

export interface PlatformLanguage {
  omarchy: string | null;
  system: string[];
}

const KEY = 'bogen-language';
/** The last answer of `/api/language`, so that a start in Automatic can fetch the right catalog at once. */
const PLATFORM_KEY = 'bogen-language-platform';

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* kept for this session */ }
}

export function parsePreference(raw: string | null): LanguagePreference {
  return raw && isLanguageCode(raw) ? raw : 'auto';
}

export function parsePlatform(raw: unknown): PlatformLanguage | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { omarchy?: unknown; system?: unknown };
  const omarchy = isLanguageCode(value.omarchy) ? value.omarchy : null;
  const system = Array.isArray(value.system) ? value.system.filter((s): s is string => typeof s === 'string' && s.length <= 64).slice(0, 8) : [];
  return { omarchy, system };
}

/** The language "Automatic" means, from what the platform said and the browser's languages. */
export function automaticLanguage(platform: PlatformLanguage | null, browser: readonly string[]): string {
  if (platform?.omarchy) return platform.omarchy;
  for (const tag of browser) {
    const code = resolveLanguage(tag);
    if (code) return code;
  }
  for (const tag of platform?.system ?? []) {
    const code = resolveLanguage(tag);
    if (code) return code;
  }
  return SOURCE_LANGUAGE;
}

function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') return [];
  const list = navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
  return [...list];
}

let preference: LanguagePreference = parsePreference(read(KEY));
let platform: PlatformLanguage | null = (() => {
  try { return parsePlatform(JSON.parse(read(PLATFORM_KEY) ?? 'null')); } catch { return null; }
})();
const listeners = new Set<() => void>();
let snapshot = { preference, automatic: automaticLanguage(platform, browserLanguages()) };

function emit(): void {
  snapshot = { preference, automatic: automaticLanguage(platform, browserLanguages()) };
  for (const fn of [...listeners]) fn();
}

/** The language to show now. */
export function effectiveLanguage(): string {
  return preference === 'auto' ? snapshot.automatic : preference;
}

export function languagePreference(): LanguagePreference {
  return preference;
}

/** The person's choice: shown at once, kept for the next start on this device. */
export function setLanguagePreference(next: LanguagePreference): Promise<void> {
  preference = parsePreference(next === 'auto' ? null : next);
  write(KEY, preference === 'auto' ? null : preference);
  emit();
  return showLanguage(effectiveLanguage());
}

export function useLanguagePreference(): { preference: LanguagePreference; automatic: string } {
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, () => snapshot);
}

export type FetchPlatform = () => Promise<unknown>;

const defaultFetch: FetchPlatform = async () => {
  const res = await fetch('/api/language', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

let refreshing: Promise<void> | null = null;
let lastRefresh = 0;

/** Asks the computer again what its language is, and follows it when the preference is Automatic. */
export function refreshPlatformLanguage(fetchPlatform: FetchPlatform = defaultFetch): Promise<void> {
  if (refreshing) return refreshing;
  lastRefresh = Date.now();
  refreshing = (async () => {
    try {
      const next = parsePlatform(await fetchPlatform());
      if (!next) return;
      platform = next;
      write(PLATFORM_KEY, JSON.stringify(next));
      emit();
      if (preference === 'auto') await showLanguage(effectiveLanguage());
    } catch {
      // Offline, or an older server: the browser's languages decide.
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * At start: the stored choice, or Automatic from the last known platform answer, is loaded straight away, and the
 * computer is asked again in the background. Resolves when the first language is shown, or after `waitMs` at the
 * latest, so a slow catalog never holds the app back for long; it is shown when it arrives.
 */
export async function startLanguage(options: { waitMs?: number; fetchPlatform?: FetchPlatform; follow?: boolean } = {}): Promise<void> {
  const first = showLanguage(effectiveLanguage());
  const refresh = refreshPlatformLanguage(options.fetchPlatform);
  if (options.follow !== false && typeof window !== 'undefined') {
    // Omarchy's language can change under Setup > Language while Bogen is open: look again when the window is used.
    const again = () => {
      if (preference === 'auto' && document.visibilityState !== 'hidden' && Date.now() - lastRefresh > 15_000) void refreshPlatformLanguage(options.fetchPlatform);
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    window.addEventListener('languagechange', () => {
      emit();
      if (preference === 'auto') void showLanguage(effectiveLanguage());
    });
  }
  // A first start without a stored platform answer may learn the Omarchy language only now.
  const ready = platform ? first : Promise.all([first, refresh]).then(() => undefined);
  await Promise.race([ready, new Promise<void>((r) => setTimeout(r, options.waitMs ?? 1500))]);
}

/** For tests. */
export function resetPreferenceForTests(): void {
  preference = parsePreference(read(KEY));
  try { platform = parsePlatform(JSON.parse(read(PLATFORM_KEY) ?? 'null')); } catch { platform = null; }
  refreshing = null;
  lastRefresh = 0;
  emit();
}
