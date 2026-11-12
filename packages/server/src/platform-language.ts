// The desktop's interface language, for the editor's "Automatic" language. Read only: Bogen never writes Omarchy's
// language file or the session's locale, and only a request from this machine is told what they say. A phone or
// another computer chooses from its own browser's languages instead.

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Omarchy's language codes, the same list as apps/editor/src/i18n/registry.ts (a test keeps them equal). A code
 * outside it is not a language Bogen can show, whatever the file says.
 */
export const LANGUAGE_CODES: ReadonlySet<string> = new Set([
  'en', 'da', 'ar', 'fi', 'fr', 'el', 'hu', 'hi', 'is', 'ja', 'ko', 'es-MX', 'fil', 'pt', 'sv', 'tr', 'vi', 'ur', 'bn', 'ca', 'si', 'ta', 'th', 'uz',
  'it', 'zh-CN', 'pl', 'lt', 'ga', 'nl', 'no', 'ru', 'id', 'de', 'sw', 'fa', 'ms', 'uk', 'ro', 'cs', 'sr', 'he', 'bg', 'sk', 'hr', 'sl', 'zh-TW',
  'et', 'lv', 'pt-BR',
]);

export interface PlatformLanguage {
  /** The code in Omarchy's language file, when there is one and Bogen has the language. */
  omarchy: string | null;
  /** The session's locale names (`LANGUAGE`, `LC_ALL`, `LC_MESSAGES`, `LANG`), in that order, for the editor to match. */
  system: string[];
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Where Omarchy keeps the language, by the rule of `omarchy-language`: `OMARCHY_LANGUAGE_FILE`, else
 * `$XDG_CONFIG_HOME/omarchy/language`, else `~/.config/omarchy/language`. A relative path in either variable is
 * ignored, as the XDG specification asks, so the answer never depends on the server's working folder.
 */
export function languageFilePath(env: Env = process.env, home: string = homedir()): string {
  const override = env.OMARCHY_LANGUAGE_FILE;
  if (override && isAbsolute(override)) return override;
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(config, 'omarchy', 'language');
}

/** Omarchy's own reading of the file: the first line without spaces, when it is a known code. */
export function parseLanguageFile(text: string): string | null {
  const first = text.split(/\r?\n/, 1)[0]?.replace(/\s+/g, '') ?? '';
  return /^[a-z]{2,3}(-[A-Za-z]{2})?$/.test(first) && LANGUAGE_CODES.has(first) ? first : null;
}

const MAX_BYTES = 256;

/**
 * The first bytes of a regular file, or null. Opened non-blocking, so that a FIFO in the file's place cannot stall
 * the server, and checked to be a regular file before anything is read.
 */
async function readSmallFile(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOCTTY ?? 0));
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const LOCALE_NAME = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*(\.[\w-]{1,20})?(@\w{1,20})?$/;

/** Locale names from the environment, checked to look like locale names, in the order glibc consults them. */
export function systemLocales(env: Env = process.env): string[] {
  const names = [...(env.LANGUAGE ?? '').split(':'), env.LC_ALL, env.LC_MESSAGES, env.LANG];
  const out: string[] = [];
  for (const name of names) {
    const value = name?.trim();
    if (value && value !== 'C' && value !== 'POSIX' && !value.startsWith('C.') && LOCALE_NAME.test(value) && !out.includes(value)) out.push(value);
    if (out.length >= 8) break;
  }
  return out;
}

export async function platformLanguage(env: Env = process.env, home: string = homedir()): Promise<PlatformLanguage> {
  const text = await readSmallFile(languageFilePath(env, home));
  return { omarchy: text === null ? null : parseLanguageFile(text), system: systemLocales(env) };
}

/** What a request that is not from this machine is told: nothing about the desktop. */
export const NO_PLATFORM_LANGUAGE: PlatformLanguage = Object.freeze({ omarchy: null, system: [] as string[] });
