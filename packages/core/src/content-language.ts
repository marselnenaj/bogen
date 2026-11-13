import type { BogenDoc } from './doc.ts';

/**
 * The language of a design's content: the words inside its screens. It is a property of the design, kept in the
 * file's meta as one validated language tag (`meta.contentLanguage`), so it syncs with the file, travels with a
 * download and a design folder, and belongs to the design branch that is checked out (a branch's content includes
 * the file's meta, design-branches.ts). It never follows Bogen's interface language, the operating system or the
 * language a person chats in: only the person sets it, in the prompt bar.
 *
 * A run can name a language of its own for one request, which wins over the file's. A brand with a primary language
 * (brand-language.ts) offers it as a soft default when the file has none. Nothing is set by default, and a file
 * without one runs exactly as before.
 */

export const CONTENT_LANGUAGE_KEY = 'contentLanguage';

/**
 * What a run does with the language: write new and changed copy in it, translate the existing screens in place,
 * or add a version of the design in that language next to the original (a design branch inside the same file).
 */
export type ContentLanguageMode = 'write' | 'translate' | 'add';
export const CONTENT_LANGUAGE_MODES: readonly ContentLanguageMode[] = ['write', 'translate', 'add'];
/** Where the effective language came from: this request, the file's own setting, or the brand's primary language. */
export type ContentLanguageSource = 'run' | 'file' | 'brand';

export interface ContentLanguage {
  /** A canonical BCP 47 tag: language, optionally script and region (`de`, `pt-BR`, `zh-Hant-TW`, `sr-Latn`). */
  tag: string;
  /** Its English name, for prompts and tool results. */
  name: string;
  dir: 'ltr' | 'rtl';
  source: ContentLanguageSource;
  mode: ContentLanguageMode;
}

/** What one request asks for. Either part may be left out: a mode alone applies to the file's (or brand's) language. */
export interface RunLanguageChoice { tag?: string; mode?: ContentLanguageMode }

/** Language, then an optional script, then an optional region. No variants, extensions or private use: a tag, never text. */
const TAG = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/i;
const NOT_A_LANGUAGE = new Set(['und', 'zxx', 'mul', 'mis']);
/** Languages written right to left in their usual script. */
const RTL_LANGUAGES = new Set(['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'iw', 'ks', 'mzn', 'glk', 'azb', 'lrc', 'ps', 'sd', 'syr', 'ug', 'ur', 'yi', 'nqo', 'prs', 'pnb', 'bal', 'bqi', 'sdh']);
const RTL_SCRIPTS = new Set(['Arab', 'Hebr', 'Thaa', 'Syrc', 'Nkoo', 'Adlm', 'Rohg', 'Mand', 'Samr', 'Mend', 'Yezi']);

let englishNames: Intl.DisplayNames | null | undefined;
function displayNames(): Intl.DisplayNames | null {
  if (englishNames === undefined) {
    try {
      englishNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
    } catch {
      englishNames = null;
    }
  }
  return englishNames;
}

/**
 * The canonical tag for a language tag, or null when it is not one. Bounded and strict, so that what the file keeps
 * and what reaches an agent's instructions can only ever be a language tag. A primary language that Intl does not
 * know by name is refused where Intl can tell; `ar`, `de-CH`, `pt-BR`, `zh-Hant-TW` and `sr-Latn` pass.
 */
export function normalizeLanguageTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/_/g, '-');
  if (!text || text.length > 20) return null;
  const m = TAG.exec(text);
  if (!m) return null;
  const language = m[1]!.toLowerCase();
  if (NOT_A_LANGUAGE.has(language) || /^q[a-t][a-z]$/.test(language)) return null;
  let canonical: string;
  try {
    canonical = Intl.getCanonicalLocales(text)[0] ?? '';
  } catch {
    return null;
  }
  if (!TAG.test(canonical)) return null;
  const names = displayNames();
  if (names) {
    const primary = canonical.split('-')[0]!;
    let known: string | undefined;
    try {
      known = names.of(primary);
    } catch {
      known = undefined;
    }
    if (!known || known === primary) return null;
  }
  return canonical;
}

/** Whether text in this language runs right to left, from its script when the tag names one, else from the language. */
export function languageDirection(tag: string): 'ltr' | 'rtl' {
  const m = TAG.exec(tag);
  if (!m) return 'ltr';
  const script = m[2] ? m[2][0]!.toUpperCase() + m[2].slice(1).toLowerCase() : '';
  if (script) return RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';
  return RTL_LANGUAGES.has(m[1]!.toLowerCase()) ? 'rtl' : 'ltr';
}

/** The name of a language in another language (English by default), or the tag itself when Intl has no name. */
export function languageName(tag: string, inLanguage = 'en'): string {
  try {
    return new Intl.DisplayNames([inLanguage], { type: 'language', fallback: 'code' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The file's design language: the one checked out with the current branch. Null when not set or not a valid tag. */
export function contentLanguageOf(doc: BogenDoc): string | null {
  return normalizeLanguageTag(doc.meta.get(CONTENT_LANGUAGE_KEY));
}

/** Sets or clears the file's design language. Throws on anything that is not a language tag. */
export function setContentLanguage(doc: BogenDoc, tag: string | null, origin?: unknown): string | null {
  const value = tag === null || tag === '' ? null : normalizeLanguageTag(tag);
  if (tag && !value) throw new Error(`"${String(tag).slice(0, 40)}" is not a language tag such as de, fr-CA or pt-BR.`);
  doc.transact(() => {
    if (value) doc.meta.set(CONTENT_LANGUAGE_KEY, value);
    else doc.meta.delete(CONTENT_LANGUAGE_KEY);
  }, origin);
  return value;
}

/** A run's own choice, checked: an unknown tag or mode is dropped rather than passed on. */
export function cleanRunLanguage(raw: unknown): RunLanguageChoice | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { tag?: unknown; mode?: unknown };
  const tag = normalizeLanguageTag(r.tag);
  const mode = CONTENT_LANGUAGE_MODES.includes(r.mode as ContentLanguageMode) ? r.mode as ContentLanguageMode : undefined;
  if (!tag && !mode) return undefined;
  return { ...(tag ? { tag } : {}), ...(mode ? { mode } : {}) };
}

/**
 * The language a run writes in: its own choice, else the file's, else the brand's primary language. Null when none of
 * them says, and then a run behaves as it always did.
 */
export function resolveContentLanguage(input: { run?: RunLanguageChoice | null; file?: string | null; brand?: string | null }): ContentLanguage | null {
  const run = input.run ? normalizeLanguageTag(input.run.tag) : null;
  const file = normalizeLanguageTag(input.file);
  const brand = normalizeLanguageTag(input.brand);
  const tag = run ?? file ?? brand;
  if (!tag) return null;
  const source: ContentLanguageSource = run ? 'run' : file ? 'file' : 'brand';
  const mode = input.run?.mode && CONTENT_LANGUAGE_MODES.includes(input.run.mode) ? input.run.mode : 'write';
  return { tag, name: languageName(tag), dir: languageDirection(tag), source, mode };
}

/** The same language, ignoring region and script: `de-CH` is German as far as a German voice check is concerned. */
export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.split('-')[0]!.toLowerCase() === b.split('-')[0]!.toLowerCase();
}

/** How an agent learns what the file's language is, in a tool result. */
export function describeContentLanguage(lang: ContentLanguage | null): { tag: string; name: string; dir: 'ltr' | 'rtl'; source: ContentLanguageSource; mode?: ContentLanguageMode; note: string } | null {
  if (!lang) return null;
  const from = lang.source === 'run' ? 'chosen by the person for this request' : lang.source === 'file' ? "the file's design language" : "the brand's primary language, as a soft default (the file sets none)";
  return {
    tag: lang.tag, name: lang.name, dir: lang.dir, source: lang.source, ...(lang.source === 'run' ? { mode: lang.mode } : {}),
    note: `Visible copy in this design is written in ${lang.name} (${lang.tag}, ${from}). That is independent of the language the person talks to you in. Keep brand and product names, URLs, identifiers and amounts as they are. Artboards you write or translate in it get lang="${lang.tag}" and dir="${lang.dir}" (layer_attrs)${lang.dir === 'rtl' ? `: ${lang.name} runs right to left` : ', which also resets an older dir="rtl"'}.`,
  };
}

/**
 * lang and dir on the artboards a run touches. dir is always set, to ltr as well: an artboard translated from Arabic
 * into English keeps an old dir="rtl" otherwise, and that would still lay the English out right to left.
 */
function directionLine(lang: ContentLanguage): string {
  const attrs = `lang="${lang.tag}" and dir="${lang.dir}"`;
  const common = `On each artboard you write or translate in ${lang.name}, set the attributes ${attrs} with layer_attrs, also where an earlier version said otherwise, and remove a dir that says ${lang.dir === 'rtl' ? 'ltr' : 'rtl'} from layers inside it (layer_attrs with null) unless that layer really holds text in another direction. Leave lang and dir alone on artboards you do not change.`;
  return lang.dir === 'rtl'
    ? `${lang.name} is written right to left. ${common} Prefer start and end over left and right where you set alignment; mirror arrows and other icons that point the way of reading; keep logos, numbers, phone numbers and media controls as they are.`
    : `${common} Where the design was right to left before, alignment set with left or right and icons mirrored for it read the other way now: turn them back.`;
}

/**
 * The lines a run's system prompt gets about the language. `brandVoice` is the brand's primary language, when it has
 * one, and `brandLanguages` the others it speaks, so that a run is told whether the brand speaks its language, and
 * which of the brand's checks judge its text. `branch` names the branch an added language version works in.
 */
export function contentLanguageLines(lang: ContentLanguage | null, options: { brandVoice?: string | null; brandLanguages?: string[]; branch?: { id: string; name: string } | null; scoped?: boolean } = {}): string[] {
  if (!lang) return [];
  const label = `${lang.name} (${lang.tag})`;
  const from = lang.source === 'run'
    ? 'The person chose it for this request.'
    : lang.source === 'file'
      ? "It is the file's design language, a default the person set."
      : "It is the linked brand's primary language, as a soft default: the file sets no language of its own.";
  const out = [
    `Design content language: ${label}. ${from} This is the language of the words inside the design, not of Bogen's interface and not of this conversation: reply to the person in the language they wrote to you in.`,
  ];
  const mode = options.scoped && lang.mode === 'add' ? 'translate' : lang.mode;
  if (mode === 'translate') {
    out.push(
      options.scoped
        ? `Translate the copy you work on into ${label}, in the layers you were given, and leave everything else as it is.`
        : `This request translates the existing design into ${label} in place. Change the text of the existing layers (layer_text) and their alt, aria-label, title and placeholder attributes (layer_attrs). Keep every file, page, artboard and layer, with its id, name, styles, tokens, components and layout. Do not make a new file, page, artboard, copy or revision for it.`,
    );
  } else if (mode === 'add') {
    out.push(options.branch
      ? `This request adds a ${label} version of the design. It works in the branch "${options.branch.name}" (${options.branch.id}) inside this file, which started as a copy of the design: translate the copy there in place, keeping every page, artboard and layer. The original (main) keeps its language and is not changed. Do not make a new file or page.`
      : `This request adds a ${label} version of the design: translate the copy in place in the version you work in, and make no new file or page.`);
    out.push(`When the version exists already, start with translation_status language "${lang.tag}": it lists only the text that is new or changed since the last translation. Send your translations with translation_apply, which remembers them and brings the version up to date with the original, so unchanged text is never translated again.`);
  } else {
    out.push(`Write every new or changed piece of visible copy in ${label}: headings, body text, button labels, form placeholders, alt text and aria-labels. Leave existing copy you were not asked to change in its language.`);
  }
  out.push(
    `Keep brand names, product names, names of people, URLs, e-mail addresses, code, identifiers, token and layer names, and prices and other amounts with their currency exactly as they are, unless the person asked to change them. Translate meaning, not word for word, in the register the design already uses.`,
    `Translations are often longer. Make every text fit: let it wrap, let its container grow, or find a shorter wording that says the same. Never hide the rest of a text (overflow hidden, an ellipsis, a font below the design's type scale). Check the result with canvas_screenshot.`,
    directionLine(lang),
  );
  const others = (options.brandLanguages ?? []).filter((t) => !options.brandVoice || !sameLanguage(t, options.brandVoice));
  const spoken = others.find((t) => t.toLowerCase() === lang.tag.toLowerCase()) ?? others.find((t) => sameLanguage(t, lang.tag));
  if (options.brandVoice && !sameLanguage(options.brandVoice, lang.tag) && spoken) {
    out.push(`${lang.name} is one of the brand's languages, besides its primary ${languageName(options.brandVoice)}. Its words, examples and text rules for ${languageName(spoken)} apply to this copy; where it has none of its own, those of ${languageName(options.brandVoice)} are the guide. Write numbers and dates the way ${lang.name} usually does. Bogen checks no grammar or spelling of ${lang.name}.`);
  } else if (options.brandVoice && !sameLanguage(options.brandVoice, lang.tag)) {
    const brandLanguage = languageName(options.brandVoice);
    const also = others.length ? `, and the brand also speaks ${others.map((t) => languageName(t)).join(', ')}, but not ${lang.name}` : '';
    out.push(`The brand's voice is set to ${brandLanguage}${also}. Its hard rules, required words and terms still apply, and so does any number or date format the brand sets explicitly. What was only inferred from ${brandLanguage} is not applied to ${lang.name} text: the du or Sie address check and a number format the brand does not set itself. Where the brand sets no format, write numbers and dates the way ${lang.name} usually does. Bogen checks no grammar or spelling of ${lang.name}.`);
  }
  out.push(lang.source === 'run'
    ? `If the person's message clearly names a different target language than ${lang.name}, do not choose between them: change nothing and ask in one sentence which language they want. A language named only as the source ("translate the German copy") is no conflict.`
    : `If the person's message clearly asks for another target language, follow the message, since it is newer and more specific than this default, and say in your reply which language you used. A language named only as the source ("translate the German copy") does not change the target.`);
  return out;
}
