import { isLanguageCode, SOURCE_LANGUAGE } from './registry.ts';

/**
 * Which registry language a locale tag means, or null for a language Bogen does not have.
 *
 * Accepts BCP 47 tags from `navigator.languages` (`de-AT`, `zh-Hant-HK`, `nb`), POSIX names from `LANG`
 * (`pt_BR.UTF-8`, `sr_RS@latin`) and Omarchy's own codes (`es-MX`, `zh-TW`). Only the registry's languages come
 * out, so an unknown tag can never select a catalog that does not exist.
 *
 * - Norwegian Bokmål and Nynorsk (`nb`, `nn`) read the one Norwegian catalog, `no`.
 * - Every Spanish reads `es-MX`, the registry's only Spanish.
 * - Portuguese is `pt-BR` for Brazil and `pt` (Portugal) for every other region and for plain `pt`.
 * - Chinese goes by script first: Traditional (`Hant`, or Taiwan, Hong Kong and Macao without a script) is
 *   `zh-TW`, everything else, plain `zh` included, is `zh-CN`.
 * - Old codes still sent by some systems: `iw` Hebrew, `in` Indonesian, `tl` Filipino.
 * - Serbian in Latin script and Uzbek in Cyrillic read the registry's one catalog for the language, in the other
 *   script; a reader of either script can read it, which is closer than English.
 */
export function resolveLanguage(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  // POSIX: language[_territory][.codeset][@modifier]. The modifier can name a script (`@latin`).
  const raw = tag.trim();
  if (!raw || raw.length > 64 || raw === 'C' || raw === 'POSIX') return null;
  const posix = /^([A-Za-z]{2,3})(?:_([A-Za-z]{2}))?(?:\.[\w-]+)?(?:@(\w+))?$/.exec(raw);
  const parts = posix
    ? [posix[1]!, ...(posix[3] ? [posix[3]] : []), ...(posix[2] ? [posix[2]] : [])]
    : raw.split(/[-_]/);
  if (!parts.every((p) => /^[A-Za-z0-9]{1,8}$/.test(p))) return null;
  const lang = parts[0]!.toLowerCase();
  let script = '';
  let region = '';
  for (const p of parts.slice(1)) {
    if (/^[A-Za-z]{4}$/.test(p) && !script) script = p.toLowerCase();
    else if (/^([A-Za-z]{2}|\d{3})$/.test(p) && !region) region = p.toUpperCase();
    else if (/^(latin|cyrillic)$/i.test(p)) script = p.toLowerCase().startsWith('latin') ? 'latn' : 'cyrl';
  }

  switch (lang) {
    case 'nb': case 'nn': case 'no': return 'no';
    case 'es': return 'es-MX';
    case 'pt': return region === 'BR' ? 'pt-BR' : 'pt';
    case 'zh': {
      if (script === 'hant') return 'zh-TW';
      if (script === 'hans') return 'zh-CN';
      return region === 'TW' || region === 'HK' || region === 'MO' ? 'zh-TW' : 'zh-CN';
    }
    case 'iw': return 'he';
    case 'in': return 'id';
    case 'tl': case 'fil': return 'fil';
    case 'zsm': return 'ms';
    case 'uzs': case 'uzn': return 'uz';
  }
  return isLanguageCode(lang) ? lang : null;
}

/** The first of `tags` that Bogen has, in order, else English. */
export function pickLanguage(tags: readonly unknown[]): string {
  for (const tag of tags) {
    const code = resolveLanguage(tag);
    if (code) return code;
  }
  return SOURCE_LANGUAGE;
}

/** What Omarchy's language file says, by Omarchy's own rule: the first line, without spaces, if it is a known code. */
export function omarchyLanguageFromFile(text: string): string | null {
  const first = text.split(/\r?\n/, 1)[0]?.replace(/\s+/g, '') ?? '';
  return /^[a-z]{2,3}(-[A-Za-z]{2})?$/.test(first) && isLanguageCode(first) ? first : null;
}
