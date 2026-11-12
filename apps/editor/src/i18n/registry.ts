/**
 * The 50 interface languages, copied from Omarchy's language registry so that Bogen offers exactly the languages
 * Omarchy does, with the same codes, native names, formatting locales and writing directions.
 *
 * Provenance: /usr/share/omarchy/default/i18n/locales.json from the Omarchy package 4.5.0-3
 * (https://github.com/omacom/omarchy, MIT licence, copyright DHH and contributors), sha256
 * dbe622637c2ee6acb320c0ba6f02cc2eb6338642ae71aa2a8e10e93a5f3beace. Only the fields Bogen uses are copied; the
 * POSIX `locale` names stay with Omarchy. Bogen never reads the installed file at run time: this list is the
 * registry on every device, Omarchy or not. apps/editor/test/i18n-registry.test.ts compares the two where the
 * file is installed.
 */

export interface Language {
  /** Omarchy's language code, the one stored in ~/.config/omarchy/language. */
  code: string;
  /** The language's name in itself, as the picker shows it. */
  name: string;
  englishName: string;
  /** The BCP 47 locale for dates, numbers and plural rules. */
  formatLocale: string;
  dir: 'ltr' | 'rtl';
  /** Omarchy's decimal separator and zero digit for the language, kept for comparison with Intl. */
  decimal: string;
  zeroDigit: string;
}

/** In Omarchy's own order. */
export const LANGUAGES: readonly Language[] = [
  { code: 'en', name: 'English', englishName: 'English', formatLocale: 'en-US', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'da', name: 'Dansk', englishName: 'Danish', formatLocale: 'da-DK', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'ar', name: 'العربية', englishName: 'Arabic', formatLocale: 'ar-AE', dir: 'rtl', decimal: '.', zeroDigit: '0' },
  { code: 'fi', name: 'Suomi', englishName: 'Finnish', formatLocale: 'fi-FI', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'fr', name: 'Français', englishName: 'French', formatLocale: 'fr-FR', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'el', name: 'Ελληνικά', englishName: 'Greek', formatLocale: 'el-GR', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'hu', name: 'Magyar', englishName: 'Hungarian', formatLocale: 'hu-HU', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'hi', name: 'हिन्दी', englishName: 'Hindi', formatLocale: 'hi-IN', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'is', name: 'Íslenska', englishName: 'Icelandic', formatLocale: 'is-IS', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'ja', name: '日本語', englishName: 'Japanese', formatLocale: 'ja-JP', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'ko', name: '한국어', englishName: 'Korean', formatLocale: 'ko-KR', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'es-MX', name: 'Español (México)', englishName: 'Spanish (Mexico)', formatLocale: 'es-MX', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'fil', name: 'Filipino', englishName: 'Filipino', formatLocale: 'fil-PH', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'pt', name: 'Português (Portugal)', englishName: 'Portuguese (Portugal)', formatLocale: 'pt-PT', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'sv', name: 'Svenska', englishName: 'Swedish', formatLocale: 'sv-SE', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'tr', name: 'Türkçe', englishName: 'Turkish', formatLocale: 'tr-TR', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'vi', name: 'Tiếng Việt', englishName: 'Vietnamese', formatLocale: 'vi-VN', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'ur', name: 'اردو', englishName: 'Urdu', formatLocale: 'ur-PK', dir: 'rtl', decimal: '.', zeroDigit: '0' },
  { code: 'bn', name: 'বাংলা', englishName: 'Bengali', formatLocale: 'bn-BD', dir: 'ltr', decimal: '.', zeroDigit: '০' },
  { code: 'ca', name: 'Català', englishName: 'Catalan', formatLocale: 'ca-AD', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'si', name: 'සිංහල', englishName: 'Sinhala', formatLocale: 'si-LK', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'ta', name: 'தமிழ்', englishName: 'Tamil', formatLocale: 'ta-LK', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'th', name: 'ไทย', englishName: 'Thai', formatLocale: 'th-TH', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'uz', name: 'Oʻzbekcha', englishName: 'Uzbek', formatLocale: 'uz-UZ', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'it', name: 'Italiano', englishName: 'Italian', formatLocale: 'it-IT', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'zh-CN', name: '简体中文', englishName: 'Chinese (Simplified)', formatLocale: 'zh-CN', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'pl', name: 'Polski', englishName: 'Polish', formatLocale: 'pl-PL', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'lt', name: 'Lietuvių', englishName: 'Lithuanian', formatLocale: 'lt-LT', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'ga', name: 'Gaeilge', englishName: 'Irish', formatLocale: 'ga-IE', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'nl', name: 'Nederlands', englishName: 'Dutch', formatLocale: 'nl-NL', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'no', name: 'Norsk', englishName: 'Norwegian', formatLocale: 'nb-NO', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'ru', name: 'Русский', englishName: 'Russian', formatLocale: 'ru-RU', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'id', name: 'Bahasa Indonesia', englishName: 'Indonesian', formatLocale: 'id-ID', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'de', name: 'Deutsch', englishName: 'German', formatLocale: 'de-DE', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'sw', name: 'Kiswahili', englishName: 'Swahili', formatLocale: 'sw-TZ', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'fa', name: 'فارسی', englishName: 'Persian', formatLocale: 'fa-IR', dir: 'rtl', decimal: '٫', zeroDigit: '۰' },
  { code: 'ms', name: 'Bahasa Melayu', englishName: 'Malay', formatLocale: 'ms-MY', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'uk', name: 'Українська', englishName: 'Ukrainian', formatLocale: 'uk-UA', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'ro', name: 'Română', englishName: 'Romanian', formatLocale: 'ro-RO', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'cs', name: 'Čeština', englishName: 'Czech', formatLocale: 'cs-CZ', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'sr', name: 'Српски', englishName: 'Serbian', formatLocale: 'sr-RS', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'he', name: 'עברית', englishName: 'Hebrew', formatLocale: 'he-IL', dir: 'rtl', decimal: '.', zeroDigit: '0' },
  { code: 'bg', name: 'Български', englishName: 'Bulgarian', formatLocale: 'bg-BG', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'sk', name: 'Slovenčina', englishName: 'Slovak', formatLocale: 'sk-SK', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'hr', name: 'Hrvatski', englishName: 'Croatian', formatLocale: 'hr-HR', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'sl', name: 'Slovenščina', englishName: 'Slovenian', formatLocale: 'sl-SI', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'zh-TW', name: '繁體中文', englishName: 'Chinese (Traditional)', formatLocale: 'zh-TW', dir: 'ltr', decimal: '.', zeroDigit: '0' },
  { code: 'et', name: 'Eesti', englishName: 'Estonian', formatLocale: 'et-EE', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'lv', name: 'Latviešu', englishName: 'Latvian', formatLocale: 'lv-LV', dir: 'ltr', decimal: ',', zeroDigit: '0' },
  { code: 'pt-BR', name: 'Português (Brasil)', englishName: 'Portuguese (Brazil)', formatLocale: 'pt-BR', dir: 'ltr', decimal: ',', zeroDigit: '0' },
];

export const LANGUAGE_CODES: readonly string[] = LANGUAGES.map((l) => l.code);

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export const SOURCE_LANGUAGE = 'en';

export function language(code: string): Language | undefined {
  return BY_CODE.get(code);
}

export function isLanguageCode(code: unknown): code is string {
  return typeof code === 'string' && BY_CODE.has(code);
}

/** For the picker: every language under its own name, sorted the way a reader of `code` would expect. */
export function languagesForPicker(code: string): Language[] {
  const collator = new Intl.Collator(language(code)?.formatLocale ?? 'en-US');
  return [...LANGUAGES].sort((a, b) => collator.compare(a.name, b.name));
}
