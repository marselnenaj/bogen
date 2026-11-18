/**
 * normalize.py: text -> the words to say and the punctuation marks between them. Numbers, money, dates, times,
 * telephone numbers, units, abbreviations, initialisms, symbols, chat spellings, versions, codes, addresses and file
 * names are turned into words by rule; emoticons and emoji are dropped. The patterns are dizione's, as written in
 * Python, translated by py.ts.
 */

import { convert, fromText, isArpabet } from './convert.ts';
import {
  escape, findall, findallStrings, finditer, fullmatch, int, isAlnum, isAlpha, isAscii, isDigit, isLower, isSpace, isUpper,
  lstrip, match as reMatch, Match, pySplit, re, rstrip, search, split, sub,
} from './py.ts';
import { PUNCTUATION, type Phone } from './symbols.ts';
import { mapping, rows } from './tables.ts';

export interface Word { kind: 'word'; text: string; attach: boolean; raw: string; spell: boolean; phones: Phone[] | null }
export interface Punct { kind: 'punct'; mark: string }
export type Token = Word | Punct;
const W = (text: string, o: Partial<Omit<Word, 'kind' | 'text'>> = {}): Word =>
  ({ kind: 'word', text, attach: o.attach ?? false, raw: o.raw ?? '', spell: o.spell ?? false, phones: o.phones ?? null });
const Pu = (mark: string): Punct => ({ kind: 'punct', mark });

const SPELL = '', END = '', INLINE = '', INLINE_BASE = 0xe100;
const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
const SCALES = ['thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion'];
const ORDINAL: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
const MONTHS = 'January February March April May June July August September October November December'.split(' ');
const MONTH_NUMBER = new Map(MONTHS.map((name, i) => [name.toLowerCase().slice(0, 3), i + 1]));
const MONTH_PATTERN = MONTHS.join('|') + '|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';
const DAY_NAMES: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const DAY_PATTERN = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Thurs|Thur|Tues|Mon|Tue|Wed|Thu|Fri|Sat|Sun';
const CURRENCY: Record<string, [string, string, string, string]> = {
  '$': ['dollar', 'dollars', 'cent', 'cents'], '£': ['pound', 'pounds', 'penny', 'pence'],
  '€': ['euro', 'euros', 'cent', 'cents'], '¥': ['yen', 'yen', '', ''], '₹': ['rupee', 'rupees', 'paisa', 'paise'],
};
Object.assign(CURRENCY, {
  USD: CURRENCY['$'], EUR: CURRENCY['€'], GBP: CURRENCY['£'], JPY: CURRENCY['¥'], INR: CURRENCY['₹'],
  CHF: ['Swiss franc', 'Swiss francs', 'centime', 'centimes'], CAD: ['Canadian dollar', 'Canadian dollars', 'cent', 'cents'],
  AUD: ['Australian dollar', 'Australian dollars', 'cent', 'cents'], CNY: ['yuan', 'yuan', '', ''],
});
const CURRENCY_CODES = 'USD|EUR|GBP|JPY|INR|CHF|CAD|AUD|CNY';
const SCALE_LETTER: Record<string, string> = { k: 'thousand', m: 'million', b: 'billion', bn: 'billion', t: 'trillion' };
const FRACTION: Record<number, [string, string]> = { 2: ['half', 'halves'], 4: ['quarter', 'quarters'] };
const SYMBOL_WORDS: Record<string, string> = {
  '&': 'and', '@': 'at', '+': 'plus', '=': 'equals', '%': 'percent', '×': 'times', '÷': 'divided by',
  '±': 'plus or minus', '©': 'copyright', '§': 'section', '°': 'degrees',
  '≥': 'greater than or equal to', '≤': 'less than or equal to', '≠': 'not equal to', '≈': 'approximately',
  '∞': 'infinity', '√': 'square root of', 'π': 'pi',
};
const COMPARISONS: Record<string, string> = { '>=': 'greater than or equal to', '<=': 'less than or equal to', '!=': 'not equal to' };
const INITIALISMS = new Set('US IT AI ID UN EU UK LA AD BC AM PM OS PE PA MA LED SAT RIP ER'.split(' '));
const SOUNDS = new Set('sh shh ss zz hm hmm mm tsk psst pfft hmph psh pssh'.split(' '));
const IS = '';
const COMPARED = String.raw`(?P<gap>[ \t]?)(?P<sign>>=|<=|!=|[<>≥≤≠])(?P=gap)`;
const VALUE_BEFORE = String.raw`(?:(?<![\w.,])\d[\d.,]*%?|(?<![\w'’.-])[A-Za-z]|[)\]])$`;
const VALUE_AFTER = String.raw`(?:[-+]?[$£€¥₹]?\d[\d.,]*%?(?!\w)|\.\d|[A-Za-z](?![\w'’])|[(\[])`;
const CLAUSE_OPENERS = new Set(('if elif while when whenever where whether that because since as and or but so then think thinks '
  + 'thought know knows say says said suppose assume means implies hence thus therefore although though '
  + 'unless until once else also clearly obviously indeed here now again first next finally similarly '
  + 'otherwise however moreover').split(' '));
const SIGN = '[<>+*/^≤≥≠≈×÷±]';
const SPACED_SIGN = ' [<>+*≤≥≠≈×÷±] ';
const NO_PHRASE = String.raw`(?![\w'’-]|\s+(?!(?:and|or|then|if|when|where|while|for|is|are|was|but|so|in|to)\b)[A-Za-z])`;
const LETTER_PLACES = [
  String.raw`(?<![\w'’.-])(?P<letter>[Aakur])(?=` + IS + String.raw`?\s?[<>!=]?=)`,
  String.raw`[<>!=]?=\s?(?P<letter>[Aakur])` + NO_PHRASE,
  String.raw`(?<![\w'’.-])(?P<letter>[Aakur])(?=` + IS + '?' + SIGN + String.raw`(?:[\w($]|\.\d))`,
  String.raw`(?<=[\w)` + IS + ']' + SIGN + String.raw`)(?<![Ww]/)(?P<letter>[Aakur])(?![\w'’-])`,
  String.raw`(?<![\w'’.-])(?P<letter>[Aakur])(?=` + IS + '?' + SPACED_SIGN + String.raw`(?:[A-Za-z]|\d[\d.,]*)(?![\w'’]))`,
  String.raw`(?<![\w'’.])(?:[A-Za-z]|\d[\d.,]*)` + IS + '?' + SPACED_SIGN + '(?P<letter>[Aakur])' + NO_PHRASE,
  String.raw`(?<=\()(?P<letter>[Aakur])(?=\)|, )`,
  String.raw`(?<=, )(?P<letter>[Aakur])(?=\))`,
  String.raw`(?:(?<=\s)|^)(?P<letter>[akur])(?=\)\s)`,
];
const ANGLES = String.raw`(?<![\w)` + END + IS + String.raw`])<[A-Za-z0-9/!?][^<>(){}+*;|\n]*>`
  + String.raw`|(?<=[\w` + END + IS + String.raw`])<[^<>(){}+*;|\n]{1,80}>(?![\w$])`
  + String.raw`|</?[A-Za-z][\w-]+/?>`;
const ANGLE_MARK = '';

function withoutAngles(textIn: string): string {
  let text = textIn;
  while (text.includes('<') && text.includes('>')) {
    const marked = sub(re(ANGLES), (m) => ANGLE_MARK + m.get(0).slice(1, -1) + ANGLE_MARK, text);
    if (marked === text) break;
    text = marked;
  }
  return text;
}

const JOINED_COMPARISON = String.raw`(?<=[\w)` + END + IS + String.raw`])[<>](?=[\w(` + SPELL + String.raw`]|\.\d| minus \d)`;
const FIGURE_BEFORE = String.raw`(?<![\w.,])\d[\d.,]*%?$`;
const FIGURE_AFTER = String.raw`(?:\d[\d.,]*%?(?!\w)|\.\d| minus \d)`;
const LETTER_BEFORE = String.raw`(?:(?<![\w'’.])[A-Za-z]|[)` + END + '])$';
const LETTER_AFTER = String.raw`(?:[A-Za-z](?![\w'’])|[(` + SPELL + '])';
const SENTENCE_STARTERS = new Set(('the he she it i we they this that there but and in on at a an if when what why how who my our '
  + 'you then so now after before however').split(' '));
const YEAR_CONTEXT = new Set(('in since by from until till before after during around circa of year early late mid summer winter '
  + 'spring fall autumn class').split(' '));
const CARDINAL_AFTER = new Set('war chapter part book volume act scene section phase type class level stage title article appendix world'.split(' '));
const LABELLED = new Set(('plan vitamin grade type option class section part team group exhibit appendix point model series '
  + 'hepatitis level').split(' '));
const ROMAN: Record<string, number> = { II: 2, III: 3, IV: 4, VI: 6, VII: 7, VIII: 8, IX: 9, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XVI: 16, XVIII: 18, XX: 20 };
const LEADING_APOSTROPHE = new Set(["'em", "'tis", "'twas", "'til", "'cause", "'bout", "'round", "'n"]);
const EMOJI = '[\u{1F000}-\u{1FAFF}☀-➿\u{1F1E6}-\u{1F1FF}←-⇿⬀-⯿️‍⃣]+';
const EMOTICON = String.raw`(?<![A-Za-z0-9])(?:[:;=]['^-]?[DPpOo3|/\\*\]\[}{><]+|[)(\]\[][-^']?[:;=]|<3+|</3|\^_?\^|-_-|[oO]_[oO]|>_<|T_T|\\o/|:'[()])(?![A-Za-z0-9])`
  + String.raw`|[:;]['^-]?[)(]+`
  + String.raw`|(?<![A-Za-z0-9)])=['^-]?[)(]+|=['^-]?[)(]+(?![A-Za-z0-9(.$-])`
  + String.raw`|(?<=[A-Za-z]{2})<3+(?![.,]?\d)`;

const set = (s: string): Set<string> => new Set(s.split(' '));
const PHONE_WORDS = set('call dial ring phone telephone tel mobile cell fax hotline text sms whatsapp');
const PHONE_LINKS = set('to on at or us me him her them back');
const PIN_WORDS = set('code pin extension ext passcode password zip postcode cvv cvc otp');
const STRONG_WORDS = set('number id reference ref serial account tracking booking confirmation');
const WEAK_WORDS = set('order ticket invoice case claim policy receipt transaction parcel shipment container payment '
  + 'reservation membership customer batch lot item job issue bug request');
const LINK_WORDS = set('is was are were ends ending in with starts starting begins beginning');
const NOT_COUNTED = set('is was has does goes ships arrives departs leaves shows needs blocks remains includes contains '
  + 'says reads starts ends closes opens runs takes comes this his its us as yes plus minus less');
const NUMBERED = set('ref reference serial account order invoice tracking part model phone tel fax id room flight case '
  + 'ticket policy licence license booking customer vat tax reg registration');
const DATE_BEFORE = set('on dated due until till by since from before after for shipped delivered arriving arrives arrive '
  + 'arrived expires expired ends ending starts starting begins beginning monday tuesday wednesday '
  + 'thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun');
const CLASSIC_FRACTIONS = new Set([2, 3, 4, 5, 6, 8, 10, 16, 32, 64, 100]);
const RATIO_WORDS = set('ratio ratios scale odds aspect mix split proportion');
const DURATION_WORDS = set('lasted took duration runtime recording video clip track lap pace length long');
const CLOCK_WORDS = set('window slot open opens opening hours shift session served service available booked appointment delivery arrive arrives arriving');
const CAPITAL_WORDS = set('IN ON AT TO OF BY OR IS AS IF NO SO WE HE MY ME DO GO UP AN AM PM BE IT US THE AND FOR BUT NOT ALL');
const SHORT_WORDS = set('my to in on of go up no do me we us it is at by be so or an as if he hi ok');
const ZONES = 'ET|CT|MT|PT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|GMT|UTC|BST|CET|CEST|IST|AEST|AEDT|JST';
const SIZES = 'XXXL|XXL|XXS|XL|XS|S|M|L';
const LENGTHS = 'mm|cm|km|m|ft|in|inch|inches|feet|foot|metres?|meters?|yards?|yd|px|pixels?';
const VERSIONED = 'version|ver|release|firmware|patch|kernel|build|python|node|nodejs|ios|ipados|macos|watchos|tvos|android|'
  + 'chrome|firefox|safari|java|php|ruby|rust|swift|kotlin|golang|django|rails|react|angular|vue|docker|'
  + 'kubernetes|ubuntu|debian|fedora|windows|linux|postgres|postgresql|mysql|redis|numpy|pytorch|tensorflow|cuda|'
  + 'xcode|gcc|clang|unity|minecraft|typescript|bluetooth|usb|hdmi|opengl|vulkan|directx|'
  + 'upgrade[ds]?|update[ds]?|downgrade[ds]?';
const SEPARATORS: Record<string, string> = { '.': 'dot', '/': 'slash', '@': 'at', '-': 'dash', '_': 'underscore', ':': 'colon', '=': 'equals', '&': 'and', '+': 'plus' };
const HALF_DAY = String.raw`(?:\s?([AaPp])\.[Mm]\.?|\s?([AaPp])[Mm]\b)`;
const AMOUNT = String.raw`(?P<whole>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?P<fraction>\d+))?`;
const MONEY = String.raw`(?:(?<![\w.])(?P<minus>-)\s?)?(?P<symbol>[$£€¥₹]|(?<![A-Za-z])(?:` + CURRENCY_CODES + String.raw`)(?![A-Za-z]))\s?`
  + String.raw`(?P<inner>-)?` + AMOUNT + String.raw`(?:\s?(?P<scale>thousand|million|billion|trillion|bn|[kKmMbB])(?![A-Za-z]))?`;
const SIGN_AFTER = String.raw`[$£€¥₹](?![\w$£€¥₹])|(?:` + CURRENCY_CODES + String.raw`)(?![A-Za-z])`;
const MONEY_AFTER = String.raw`(?:(?<![\w.])(?P<minus>-)\s?)?(?<![\w.,^])`
  + String.raw`(?P<whole>\d{1,3}(?:,\d{3})+|[1-9]\d{0,2}(?: \d{3})+|\d+)(?:\.(?P<fraction>\d+))?`
  + String.raw`\s?(?P<symbol>` + SIGN_AFTER + ')';
const RANGE_BEFORE_SIGN = String.raw`(?<![\w.,-])(\d[\d,]*(?:\.\d+)?)-(?=\d[\d,]*(?:\.\d+)?\s?(?:` + SIGN_AFTER + '))';
const CONTINENTAL = String.raw`(?<![\w.,])([1-9]\d{0,2}(?:\.\d{3})+),(\d{1,2})(?!\d|[.,]\d)`;
const COMMA_AFTER_SIGN = String.raw`((?:[$£€¥₹]|(?<![A-Za-z])(?:` + CURRENCY_CODES + String.raw`))\s?-?\d+),(\d{1,2})(?!\d|[.,]\d)`;
const COMMA_BEFORE_SIGN = String.raw`(?<![\w.,])(\d+),(\d{1,2})(?=\s?(?:%|` + SIGN_AFTER + '))';
const FORMULA_SIGN = '';
const FORMULA_END = String.raw`(?<![\w$])(?<!\d\s)\$(?:(?=[^\s\d$.,;:!?)])[^$\n]{0,80}`
  + String.raw`|(?=\d)[^$\n]{0,80}[=^_\\{}+*/<>][^$\n]{0,80}`
  + String.raw`|(?=\s)[^$\n]{0,80}[=^_\\{}+*<>][^$\n]{0,80})\d\s?\$(?![\w$])`;
const VULGAR = String.raw`(?<![\d.,/])(?:(\d+)\s?)?([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒])`;
const ADDRESS = String.raw`(?P<url>(?:https?://|www\.)[^\s<>"']+)`
  + String.raw`|(?P<mail>[\w.+-]+@[\w-]+(?:\.[\w-]+)+)`
  + String.raw`|(?P<file>(?<![\w@./-])(?P<folder>/?(?:[\w~-]+/)+)?(?P<stem>[\w-]+(?:\.[\w-]+)*)\.(?P<ending>[A-Za-z][A-Za-z0-9]{0,9})`
  + String.raw`(?![\w-])(?P<path>/[^\s<>"']*)?)`;
const DAY_RANGE = String.raw`\b(` + DAY_PATTERN + '|' + MONTH_PATTERN + String.raw`)\b(\.?)\s?[-–]\s?(` + DAY_PATTERN + '|' + MONTH_PATTERN + String.raw`)\b(\.?)`;
const RATIO = String.raw`(?<![\d:.,])(\d{1,3}):(\d{1,3}(?:,\d{3})+|\d+)(?![\d:]|[.,]\d)`;
const CODE = String.raw`(?<![\w.,/-])(#)?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)(?![\w-]|[.,]\d)`;
const SLASHED = String.raw`(?<![\w.,/-])(\d+(?:/\d+){2,})(?![\w/]|[.,]\d)`;
// Python's conditional group (?(lead)...) as two alternatives: with a lead (and an optional trail), then without.
const GROUPED_CORE = String.raw`[A-Z0-9]*\d[A-Z0-9]*(?: [A-Z0-9]*\d[A-Z0-9]*)+`;
const GROUPED_TAIL = String.raw`(?![\w]|[.,:/-]\d|\s?[%°])`;
const GROUPED = String.raw`(?<![\w.,:/#+-])(?:(?P<plus>\+)?(?P<lead>[A-Z]{2}) (?P<core>` + GROUPED_CORE + String.raw`)(?: (?P<trail>[A-Z]{2})(?![\w]))?` + GROUPED_TAIL
  + String.raw`|(?P<plus2>\+)?(?P<core2>` + GROUPED_CORE + ')' + GROUPED_TAIL + ')';
const GLUED = String.raw`(?<![\w'.])(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+(?![\w']|\.\d)`;

const ACCENT_DECIDES: Record<string, string> = {
  'résumé': 'R EH1 Z AH0 M EY2', 'resumé': 'R EH1 Z AH0 M EY2', 'exposé': 'EH2 K S P OW0 Z EY1',
  'rosé': 'R OW0 Z EY1', 'pâté': 'P AA0 T EY1', 'maté': 'M AA1 T EY2', 'saké': 'S AA1 K EY2', 'lamé': 'L AA0 M EY1',
};
const ACCENTED = String.raw`\b(` + Object.keys(ACCENT_DECIDES).join('|') + String.raw`)(s?)\b`;
const LETTER_FORMS: Record<string, string> = { 'ß': 'ss', 'æ': 'ae', 'Æ': 'Ae', 'œ': 'oe', 'Œ': 'Oe', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'ł': 'l', 'Ł': 'L' };

function plainLetter(char: string): string {
  if (isAscii(char) || !isAlpha(char)) return char;
  if (Object.hasOwn(LETTER_FORMS, char)) return LETTER_FORMS[char]!;
  const base = [...char.normalize('NFKD')].filter((c) => !/\p{M}/u.test(c)).join('');
  return isAscii(base) && isAlpha(base) ? base : char;
}

// ---- numbers as words ------------------------------------------------------

export function cardinal(numberIn: number | bigint): string {
  let number = BigInt(numberIn);
  if (number < 0n) return 'minus ' + cardinal(-number);
  if (number < 20n) return ONES[Number(number)]!;
  if (number < 100n) {
    const tens = Number(number / 10n), ones = Number(number % 10n);
    return TENS[tens - 2]! + (ones ? ' ' + ONES[ones]! : '');
  }
  if (number < 1000n) {
    const hundreds = number / 100n, rest = number % 100n;
    return ONES[Number(hundreds)]! + ' hundred' + (rest ? ' ' + cardinal(rest) : '');
  }
  if (number >= 1000n ** BigInt(SCALES.length + 1)) return digits(number.toString());
  const parts: string[] = [];
  for (let power = SCALES.length; power > 0; power--) {
    const unit = 1000n ** BigInt(power);
    const count = number / unit;
    number %= unit;
    if (count) parts.push(cardinal(count) + ' ' + SCALES[power - 1]!);
  }
  if (number) parts.push(cardinal(number));
  return parts.join(' ');
}

export function ordinal(number: number | bigint): string {
  const words = cardinal(number).split(' ');
  const last = words[words.length - 1]!;
  words[words.length - 1] = ORDINAL[last] ?? (last.endsWith('y') ? last.slice(0, -1) + 'ieth' : last + 'th');
  return words.join(' ');
}

export const digits = (text: string, zero = 'zero'): string =>
  [...text].filter((c) => isDigit(c)).map((c) => (c === '0' ? zero : ONES[int(c)]!)).join(' ');

export function year(number: number): string {
  if (!(number >= 1000 && number <= 2999)) return cardinal(number);
  const high = Math.floor(number / 100), low = number % 100;
  if (low === 0) return high % 10 === 0 ? cardinal(number) : cardinal(high) + ' hundred';
  if (high === 20 && low < 10) return 'two thousand ' + ONES[low]!;
  return cardinal(high) + (low < 10 ? ' oh ' + ONES[low]! : ' ' + cardinal(low));
}

export function pairs(number: number): string {
  const high = Math.floor(number / 100), low = number % 100;
  if (!(number >= 100 && number <= 9999) || (low === 0 && (high < 10 || high % 10 === 0))) return cardinal(number);
  if (low === 0) return cardinal(high) + ' hundred';
  return cardinal(high) + (low < 10 ? ' oh ' + ONES[low]! : ' ' + cardinal(low));
}

const bigint = (s: string): bigint => BigInt([...s].map((c) => (/[0-9]/.test(c) ? c : String(int(c)))).join('') || '0');

export function numberWords(text: string): string {
  const clean = text.replaceAll(',', '');
  const dot = clean.indexOf('.');
  const whole = dot < 0 ? clean : clean.slice(0, dot);
  const fraction = dot < 0 ? '' : clean.slice(dot + 1);
  if (fraction) return (whole ? cardinal(bigint(whole)) : '') + ' point ' + digits(fraction);
  if ((whole.length > 1 && whole.startsWith('0')) || whole.length > 18) return digits(whole);
  return cardinal(bigint(whole));
}

function duration(hours: number, minutes: number, seconds: number): string {
  const parts = ([[hours, 'hour'], [minutes, 'minute'], [seconds, 'second']] as const)
    .filter(([count]) => count).map(([count, name]) => `${cardinal(count)} ${count === 1 ? name : name + 's'}`);
  if (parts.length < 2) return parts[0] ?? 'zero seconds';
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]!;
}

function pluralOf(words: string): string {
  const cut = words.lastIndexOf(' ');
  const head = cut < 0 ? '' : words.slice(0, cut);
  let last = cut < 0 ? words : words.slice(cut + 1);
  last = last.endsWith('y') ? last.slice(0, -1) + 'ies' : last + 's';
  return (head ? head + ' ' : '') + last;
}

function fractionWords(top: number, bottom: number, article = false): string {
  const [one, many] = FRACTION[bottom] ?? [ordinal(bottom), ordinal(bottom) + 's'];
  if (top !== 1) return `${cardinal(top)} ${many}`;
  return (article ? ('aeiou'.includes(one[0]!) ? 'an ' : 'a ') : 'one ') + one;
}

const versionPart = (part: string): string => (part.length > 2 ? digits(part) : numberWords(part));
const minor = (part: string): string => (part.startsWith('0') ? digits(part, 'oh') : cardinal(int(part)));
const shortNumber = (text: string): boolean => !text.startsWith('0') && (text.length <= 2 || new Set(text.slice(1)).size === 1 && text.slice(1).startsWith('0'));
const spelled = (letters: string): string => `${SPELL}${letters}${END}`;

function before(text: string, position: number, count = 4): string[] {
  const parts = split(re(String.raw`[.!?;…]\s|[()"]`), text.slice(Math.max(0, position - 80), position));
  const clause = parts[parts.length - 1]!;
  return findallStrings(re('[A-Za-z]+'), clause).map((w) => w.toLowerCase()).slice(-count);
}

function identifier(text: string, position: number): string | null {
  const words = before(text, position);
  if (!words.length) return null;
  const last = words[words.length - 1]!;
  if (PHONE_WORDS.has(last) || (PHONE_LINKS.has(last) && words.slice(-3, -1).some((w) => PHONE_WORDS.has(w)))) return 'phone';
  let index = words.length - 1;
  while (index > 0 && LINK_WORDS.has(words[index]!)) index--;
  for (const [kind, group] of [['phone', PHONE_WORDS], ['pin', PIN_WORDS], ['strong', STRONG_WORDS], ['weak', WEAK_WORDS]] as const) {
    if (group.has(words[index]!)) return kind;
  }
  return last === 'enter' ? 'enter' : null;
}

const decimalComma = (text: string): string => (fullmatch(re(String.raw`\d+,\d{1,2}`), text) ? text.replaceAll(',', '.') : text);

function addressDigits(text: string): string {
  if (text.length <= 2 && !(text.length === 2 && text[0] === '0')) return cardinal(int(text));
  if (text.length === 4 && int(text) >= 1900 && int(text) <= 2099) return year(int(text));
  return digits(text);
}

/** `re.escape` as Python 3.12 writes it (the order of the unit names depends on it). */
const pyEscape = (s: string): string => s.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, (c) => '\\' + c);

// ---- rewriting -------------------------------------------------------------

export class Normalizer {
  private abbreviations = new Map<string, [string, string]>();
  private units = new Map<string, [string, string]>();
  private exactUnits = new Map<string, [string, string]>();
  private chat = new Map<string, string>();
  private replies = new Set<string>();
  private endings: Map<string, string>;
  private unitNames: string;
  private unit: string;
  private inline: [string, Phone[]][] = [];
  private dayFirst = false;
  private dated = false;

  constructor(private isWord: (word: string) => boolean = () => true) {
    for (const [, columns] of rows('abbreviations.txt')) this.abbreviations.set(columns[0]!, [columns[1]!, columns[2]!]);
    for (const [, columns] of rows('units.txt')) {
      if (columns.length > 3 && columns[3] === 'exact') this.exactUnits.set(columns[0]!, [columns[1]!, columns[2]!]);
      else this.units.set(columns[0]!.toLowerCase(), [columns[1]!, columns[2]!]);
    }
    for (const [number, columns] of rows('chat.txt')) {
      if (columns.length > 2 && !(columns.length === 3 && columns[2] === 'alone')) throw new Error(`chat.txt line ${number}`);
      this.chat.set(columns[0]!, columns.length > 1 ? columns[1]! : '-');
      if (columns.length > 2) this.replies.add(columns[0]!);
    }
    this.endings = mapping('endings.txt');
    const names = [...new Set([...this.units.keys(), ...this.exactUnits.keys()].map(pyEscape))]
      .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    this.unitNames = names.join('|');
    this.unit = String.raw`(?<![\w.])(\d[\d,]*(?:\.\d+)?)(?:[-–](\d[\d,]*(?:\.\d+)?))?\s?(` + this.unitNames
      + String.raw`)(?![A-Za-z])(\.(?=\s+(?-i:[a-z])))?`;
  }

  // -- pieces of the text that are not words --

  private amount(symbol: string, whole: string, fraction: string | undefined, scaleIn: string | undefined): string {
    const [one, many, cent, cents] = CURRENCY[symbol]!;
    if (scaleIn) {
      const scale = SCALE_LETTER[scaleIn.toLowerCase()] ?? scaleIn.toLowerCase();
      return `${numberWords(whole + (fraction ? '.' + fraction : ''))} ${scale} ${many}`;
    }
    if (fraction && (fraction.length > 2 || !cent)) return `${numberWords(whole + '.' + fraction)} ${many}`;
    const amount = bigint(whole), change = int((fraction || '0').padEnd(2, '0'));
    const parts: string[] = [];
    if (amount || !change) parts.push(`${cardinal(amount)} ${amount === 1n ? one : many}`);
    if (change && cent) parts.push(`${cardinal(change)} ${change === 1 ? cent : cents}`);
    return parts.join(' and ');
  }

  private continental = (m: Match): string => {
    const groups = m.get(1).split('.');
    if (groups.length === 4 && groups.every((g) => int(g) <= 255)) return m.get(0);
    return groups.join(',') + '.' + m.get(2);
  };

  private money = (m: Match): string => {
    const whole = m.get('whole').replaceAll(',', '').replaceAll(' ', '');
    const words = this.amount(m.get('symbol'), whole, m.group('fraction'), m.group('scale'));
    return (m.group('minus') || m.group('inner') ? ' minus ' : ' ') + words + ' ';
  };

  private halfDay(m: Match, dotted: string | undefined, plain: string | undefined): string {
    if (!(dotted || plain)) return '';
    const following = lstrip(m.string.slice(m.end()));
    const first = reMatch(re("[A-Za-z']+"), following);
    const closes = Boolean(dotted) && m.get(0).endsWith('.') && (
      !following || (isUpper(following[0]!) && first !== null && SENTENCE_STARTERS.has(first.get(0).toLowerCase())));
    return `${SPELL}${(dotted || plain)!.toUpperCase()}M${END}${closes ? ' .' : ''} `;
  }

  private time = (m: Match): string => {
    const hour = int(m.get(1)), minute = int(m.get(2)), second = m.group(3);
    const half = m.group(4) || m.group(5);
    const words0 = before(m.string, m.start(), 3);
    if (second !== undefined && !half && !(words0.length && words0[words0.length - 1] === 'at')) return ` ${duration(hour, minute, int(second))} `;
    if (hour > 24 && second === undefined && !half) {
      const after = reMatch(re(String.raw`\s*([A-Za-z]+)`), m.string.slice(m.end()));
      if (words0.some((w) => DURATION_WORDS.has(w)) || (after && DURATION_WORDS.has(after.get(1).toLowerCase()))) return ` ${duration(0, hour, minute)} `;
      return ` ${cardinal(hour)} ${minute < 10 ? 'oh ' : ''}${cardinal(minute)} `;
    }
    if (hour > 24) return m.get(0);
    let words = cardinal(hour);
    if (minute === 0) {
      if (half) { /* nothing */ } else if (hour === 0) words = 'midnight';
      else if (hour > 12) words += ' hundred';
      else words += " o'clock";
    } else {
      words += (minute < 10 ? ' oh ' : ' ') + cardinal(minute);
    }
    if (second) words += ' and ' + cardinal(int(second)) + (int(second) === 1 ? ' second' : ' seconds');
    return ` ${words} ` + this.halfDay(m, m.group(4), m.group(5));
  };

  private dotTimes = (m: Match): string => {
    const following = m.string.slice(m.end());
    if (int(m.get(1)) > 23 || int(m.get(4)) > 23 || !before(m.string, m.start()).some((w) => CLOCK_WORDS.has(w))
      || reMatch(re(String.raw`\s?(?:%|percent|million|billion|` + this.unitNames + String.raw`)(?![A-Za-z])`, 'i'), following)) return m.get(0);
    return `${m.get(1)}:${m.get(2)}${m.get(3)}${m.get(4)}:${m.get(5)}`;
  };

  private ratio = (m: Match): string => {
    const first = m.get(1), second = m.get(2);
    if (first.length <= 2 && second.length === 2 && '012345'.includes(second[0]!)) {
      const after = reMatch(re(String.raw`\s*([A-Za-z]+)`), m.string.slice(m.end()));
      if (!(before(m.string, m.start(), 3).some((w) => RATIO_WORDS.has(w)) || (after && RATIO_WORDS.has(after.get(1).toLowerCase())))) return m.get(0);
    }
    return ` ${numberWords(first)} to ${numberWords(second)} `;
  };

  private date(month: number, day: number, yearText?: string, the = false): string | null {
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
    let words = the ? `the ${ordinal(day)} of ${MONTHS[month - 1]}` : `${MONTHS[month - 1]} ${ordinal(day)}`;
    if (yearText) words += ' ' + (yearText.length === 4 ? year(int(yearText)) : (int(yearText) < 10 ? 'oh ' : '') + cardinal(int(yearText)));
    return ` ${words} `;
  }

  private slashDate = (m: Match): string => {
    let first = int(m.get(1)), second = int(m.get(2));
    if ((first > 12 && 12 >= second) || (this.dayFirst && second <= 12)) [first, second] = [second, first];
    return this.date(first, second, m.group(3)) ?? m.get(0);
  };

  private dotDate = (m: Match): string => {
    let day = int(m.get(1)), month = int(m.get(2));
    if (month > 12 && 12 >= day) [day, month] = [month, day];
    return this.date(month, day, m.group(3)) ?? m.get(0);
  };

  private dayMonth = (m: Match): string => {
    const month = m.get(2);
    const spoken = this.date(MONTH_NUMBER.get(month.toLowerCase().slice(0, 3))!, int(m.get(1)), m.group(4), true);
    if (spoken === null) return m.get(0);
    return spoken + (m.group(3) && MONTHS.includes(month) ? '. ' : '');
  };

  private daysOfMonth = (m: Match): string => {
    const monthFirst = isAlpha(m.get(1)[0]!);
    const [month, a, b] = monthFirst ? [m.get(1), m.get(2), m.get(3)] : [m.get(3), m.get(1), m.get(2)];
    const first = int(a), second = int(b);
    if (!(first >= 1 && first <= 31 && second >= 1 && second <= 31)) return m.get(0);
    const name = MONTHS[MONTH_NUMBER.get(month.toLowerCase().slice(0, 3))! - 1]!;
    const words = monthFirst ? `${name} ${ordinal(first)} to ${ordinal(second)}` : `the ${ordinal(first)} to the ${ordinal(second)} of ${name}`;
    return ` ${words}${m.group(4) ? ' ' + year(int(m.get(4))) : ''} `;
  };

  private dayRange = (m: Match): string => {
    const names = [m.get(1), m.get(3)].map((name) => {
      const k = name.toLowerCase();
      return this.abbreviations.has(k) ? this.abbreviations.get(k)![1] : DAY_NAMES[k] ?? name;
    });
    const following = lstrip(m.string.slice(m.end()));
    const first = reMatch(re("[A-Za-z']+"), following);
    const ends = Boolean(m.group(4)) && (!following || (isUpper(following[0]!) && first !== null && SENTENCE_STARTERS.has(first.get(0).toLowerCase())));
    return `${names[0]} to ${names[1]}${ends ? ' .' : ''}`;
  };

  private shortDate(m: Match): string | null {
    const firstText = m.get(1), secondText = m.get(2);
    if (firstText.length > 2 || secondText.length > 2) return null;
    let first = int(firstText), second = int(secondText);
    const words = before(m.string, m.start());
    if (first >= 1 && first <= 12 && second >= 20 && second <= 49 && words.includes('card')) return ` ${MONTHS[first - 1]} ${year(2000 + second)} `;
    const last = words.length ? words[words.length - 1]! : '';
    const classic = first < second && CLASSIC_FRACTIONS.has(second);
    const zero = (firstText.length === 2 && firstText[0] === '0') || (secondText.length === 2 && secondText[0] === '0');
    if (!(zero || (first > 12 && first <= 31 && second <= 12 && !(first === 24 && second === 7))
      || (DATE_BEFORE.has(last) && (!classic || last === 'on'))
      || (this.dated && !classic && first !== second))) return null;
    if (first > 12 || (this.dayFirst && second <= 12)) [first, second] = [second, first];
    return this.date(first, second);
  }

  private fraction = (m: Match): string => {
    const spoken = this.shortDate(m);
    if (spoken) return spoken;
    const top = int(m.get(1)), bottom = int(m.get(2));
    if ((top === 24 && bottom === 7) || top === bottom) return ` ${cardinal(top)} ${cardinal(bottom)} `;
    if (!(top > 0 && top < 100) || !(bottom > 1 && bottom <= 100)) return ` ${cardinal(top)} over ${cardinal(bottom)} `;
    return ` ${fractionWords(top, bottom)} `;
  };

  private mixedFraction = (m: Match): string => {
    const top = int(m.get(2)), bottom = int(m.get(3));
    if (!(top > 0 && top < bottom)) return m.get(0);
    return ` ${numberWords(m.get(1))} and ${fractionWords(top, bottom, true)} `;
  };

  private vulgar = (m: Match): string => {
    const [top, bottom] = m.get(2).normalize('NFKC').split('⁄').map((p) => int(p)) as [number, number];
    if (m.group(1) === undefined) return ` ${top}/${bottom} `;
    return ` ${cardinal(int(m.get(1)))} and ${fractionWords(top, bottom, true)} `;
  };

  private phone = (m: Match): string => {
    const groups = m.groups().filter((g): g is string => Boolean(g));
    return ' ' + groups.map((g) => (g === '800' ? 'eight hundred' : digits(g, 'oh'))).join(', ') + ' ';
  };

  private measure = (m: Match): string => {
    const unit = m.get(3);
    const names = this.exactUnits.get(unit) ?? this.units.get(unit.toLowerCase());
    if (names === undefined || (unit.length === 1 && ['-', "'", '/'].includes(m.string.slice(m.end(3), m.end(3) + 1)))) return m.get(0);
    const [one, many] = names;
    const value = decimalComma(m.get(1)), upper = m.group(2) && decimalComma(m.get(2));
    if (upper) return ` ${numberWords(value)} to ${numberWords(upper)} ${many} `;
    return ` ${numberWords(value)} ${value === '1' || value === '1.0' ? one : many} `;
  };

  private square = (m: Match): string => {
    const unit = m.get(2);
    const [one, many] = unit === 'in' ? ['inch', 'inches'] : this.exactUnits.get(unit) ?? this.units.get(unit)!;
    const kind = '²2'.includes(m.get(3)) ? 'square' : 'cubic';
    const value = decimalComma(m.get(1));
    return ` ${numberWords(value)} ${kind} ${value === '1' || value === '1.0' ? one : many} `;
  };

  private counted(text: string, end: number): boolean {
    const after = reMatch(re(String.raw`\s*([A-Za-z]+)`), text.slice(end));
    if (!after) return false;
    const word = after.get(1).toLowerCase();
    if (['people', 'men', 'women', 'children', 'feet', 'miles'].includes(word)) return true;
    return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !NOT_COUNTED.has(word) && this.isWord(word.slice(0, -1));
  }

  private number(m: Match, text: string): string {
    const value = m.get(0);
    const plain = value.replaceAll(',', '');
    if (!plain.includes('.') && !value.includes(',') && !plain.startsWith('0') && plain.length > 2) {
      const kind = identifier(text, m.start());
      const limit = ({ phone: 3, pin: 3, strong: 4, enter: 4, weak: 5 } as Record<string, number>)[kind ?? ''] ?? 7;
      if (plain.length >= limit && !(kind === null && plain.endsWith('000'))
        && !(kind === 'enter' && plain.length === 4 && int(plain) >= 1900 && int(plain) <= 2099)
        && !([null, 'phone', 'weak'].includes(kind) && this.counted(text, m.end()))) {
        return ` ${digits(plain, kind === 'phone' ? 'oh' : 'zero')} `;
      }
    }
    if (!plain.includes('.') && !value.includes(',') && plain.length === 4 && !plain.startsWith('0')) {
      const number = int(plain);
      const beforeWords = findallStrings(re('[A-Za-z]+'), text.slice(0, m.start()).slice(-24));
      const after = reMatch(re(String.raw`\s*([A-Za-z]+)`), text.slice(m.end()));
      const counted = Boolean(after) && search(re(String.raw`(?:[^s]s|people|men|women|children|feet|miles)$`), after!.get(1).toLowerCase()) !== null;
      const lastBefore = beforeWords.length ? beforeWords[beforeWords.length - 1]!.toLowerCase() : '';
      const dated = Boolean(beforeWords.length) && (YEAR_CONTEXT.has(lastBefore) || MONTH_NUMBER.has(lastBefore.slice(0, 3)));
      const model = search(re(String.raw`(?<![A-Za-z])([A-Z]{2,5}) $`), text.slice(0, m.start()));
      if (model && !CAPITAL_WORDS.has(model.get(1)) && !counted) return ` ${pairs(number)} `;
      if ((number >= 1100 && number <= 1999) || (number >= 2000 && number <= 2099 && (dated || !counted))) return ` ${year(number)} `;
    }
    return ` ${numberWords(value)} `;
  }

  // -- codes and reference numbers --

  private readsAsWord(letters: string): boolean {
    const lower = letters.toLowerCase();
    if (lower.length < 3 || !this.isWord(lower)) return false;
    return lower.length > 3 || ['s', 'es', 'ed', 'ing'].some((e) => this.isWord(lower + e));
  }

  private alnum(group: string, zero = 'zero'): string {
    return findallStrings(re(String.raw`[A-Za-z]+|\d+`), group).map((run) => (isDigit(run) ? digits(run, zero) : spelled(run))).join(' ');
  }

  private digitGroups(groups: string[], zero = 'zero'): string {
    if (groups.every((g) => shortNumber(g) && g.length <= 2)) return groups.map((g) => cardinal(int(g))).join(' , ');
    return groups.map((g) => digits(g, zero)).join(' , ');
  }

  private codeWords(groups: string[], m: Match): string | null {
    const token = groups.join('-');
    if (![...token].some((c) => isDigit(c))) return null;
    const kinds = groups.map((g) => (isDigit(g) ? 'd' : [...g].some((c) => isDigit(c)) ? 'm' : isUpper(g) ? 'u' : 'l'));
    if (kinds.every((k) => k === 'd')) {
      if (groups.length === 2) {
        const years = groups.every((g) => g.length === 4 && int(g) >= 1000 && int(g) <= 2100);
        if (!(m.group(1) || groups.some((g) => g.length > 1 && g[0] === '0')
          || (Math.min(...groups.map((g) => g.length)) >= 4 && !years)
          || ['strong', 'pin'].includes(identifier(m.string, m.start()) ?? ''))) return null;
      }
      return this.digitGroups(groups);
    }
    if (groups.length === 2 && kinds[1] === 'd' && 'ul'.includes(kinds[0]!)) {
      const [letters, number] = groups as [string, string];
      if ((kinds[0] === 'l' && letters.length > 1) || this.readsAsWord(letters)) return null;
      if (shortNumber(number)) return `${spelled(letters)} ${cardinal(int(number))}`;
      return `${spelled(letters)} , ${digits(number)}`;
    }
    if (groups.length === 2 && kinds[0] === 'd' && (kinds[1] === 'l' || groups[1]!.length === 1 || fullmatch(re(String.raw`\d+[A-Za-z]+`), groups[1]!))) return null;
    if (groups.some((g, k) => (kinds[k] === 'l' && g.length > 2) || (kinds[k] === 'm' && fullmatch(re(String.raw`\d+(?:s|st|nd|rd|th)`), g)))) return null;
    if (![...token].some((c) => isUpper(c)) && (kinds.includes('l') || kinds.includes('m'))) return null;
    const parts: string[] = [];
    groups.forEach((group, k) => {
      const kind = kinds[k];
      if (kind === 'd') parts.push(digits(group));
      else if (kind === 'm') parts.push(this.alnum(group));
      else if (group.length > 3 && this.isWord(group.toLowerCase())) parts.push(group);
      else parts.push(group.length <= 5 ? spelled(group) : group);
    });
    return parts.join(' , ');
  }

  private code = (m: Match): string => {
    const words = this.codeWords(m.get(2).split('-'), m);
    if (words === null) return m.get(0);
    return (m.group(1) ? ' number ' : ' ') + words + ' ';
  };

  private grouped = (m: Match): string => {
    const text = m.string;
    const plus = m.group('plus') ?? m.group('plus2');
    let lead = m.group('lead'), trail = m.group('trail');
    const core = (m.group('core') ?? m.get('core2')).split(' ');
    let head = '', tail = '';
    if (lead !== undefined && CAPITAL_WORDS.has(lead)) {
      head = lead + ' ';
      tail = trail ? ' ' + trail : '';
      lead = undefined;
      trail = undefined;
    }
    const kind = identifier(text, m.start());
    const pure = core.every((part) => isDigit(part));
    if (pure && !plus && !lead) {
      const following = text.slice(m.end());
      const amount = this.counted(text, m.end()) || reMatch(re(String.raw`\s?(?:` + this.unitNames + String.raw`)(?![A-Za-z])`, 'i'), following) !== null;
      if (kind === null && core[0]![0] !== '0' && core[0]!.length <= 3 && core.slice(1).every((p) => p.length === 3)
        && (core[core.length - 1] === '000' || (amount && core.length > 2))) return head + core.join(',') + tail;
      if (!(kind || (core[0]!.length > 1 && core[0]![0] === '0') || (core.length > 2 && core.some((p) => p.length > 2)))) return m.get(0);
    } else if (!pure && !lead && !plus && kind === null) {
      return m.get(0);
    }
    const zero = plus || kind === 'phone' || (pure && core[0]![0] === '0' && core.reduce((n, p) => n + p.length, 0) >= 10) ? 'oh' : 'zero';
    let spoken = pure ? this.digitGroups(core, zero) : core.map((part) => (isDigit(part) ? digits(part, zero) : this.alnum(part, zero))).join(' , ');
    if (lead) spoken = `${spelled(lead)} , ${spoken}`;
    if (trail) spoken = `${spoken} , ${spelled(trail)}`;
    return head + (plus ? ' plus ' : ' ') + spoken + ' ' + tail;
  };

  private glued = (m: Match): string => {
    const out: string[] = [];
    for (const run of findallStrings(re(String.raw`[A-Za-z]+|\d+`), m.get(0))) {
      if (isDigit(run)) out.push(shortNumber(run) ? cardinal(int(run)) : digits(run));
      else if (run.length === 1 || ((isUpper(run) || run.length <= 3) && !this.readsAsWord(run))) out.push(spelled(run));
      else out.push(run);
    }
    return ' ' + out.join(' ') + ' ';
  };

  // -- web addresses and file names --

  private addressPart(part: string): string {
    const lower = part.toLowerCase();
    if (part.length > 1 && this.isWord(lower) && (part.length > 2 || SHORT_WORDS.has(lower))) return part;
    return part.length <= 3 ? spelled(part) : part;
  }

  private spokenAddress(core: string): string {
    const pieces = findallStrings(re(String.raw`[A-Za-z]+|\d+|.`), core);
    const mail = core.includes('@');
    let host = false;
    const out: string[] = [];
    pieces.forEach((piece, index) => {
      const following = index + 1 < pieces.length ? pieces[index + 1]! : '';
      if (piece === '@') host = true;
      if (isDigit(piece)) out.push(addressDigits(piece));
      else if (!isAlpha(piece)) out.push(SEPARATORS[piece] ?? '');
      else if (index && pieces[index - 1] === '.' && (host || !mail) && (
        ['', '/', ':', '?', '#'].includes(following)
        || (piece.length <= 3 && (this.endings.has(piece.toLowerCase()) || !this.isWord(piece.toLowerCase()))))) {
        out.push(this.endings.get(piece.toLowerCase()) === 'word' ? piece.toLowerCase() : spelled(piece));
      } else {
        let letters = '';
        for (const part of findallStrings(re('[A-Z]?[a-z]+|[A-Z]+(?![a-z])'), piece)) {
          const said = this.addressPart(part);
          if (said.startsWith(SPELL)) { letters += part; continue; }
          if (letters) { out.push(spelled(letters)); letters = ''; }
          out.push(said);
        }
        if (letters) out.push(spelled(letters));
      }
    });
    return out.filter(Boolean).join(' ');
  }

  private address = (m: Match): string => {
    const whole = m.get(0);
    const text = rstrip(whole, '.,;:!?)');
    const tail = whole.slice(text.length);
    if (m.group('file')) {
      const ending = m.get('ending');
      const known = this.endings.has(ending.toLowerCase());
      const marked = Boolean(m.group('folder') || m.group('path')) || m.get('stem').includes('_');
      if (!(known || (marked && ending.length <= 5 && (isLower(ending) || isUpper(ending)) && !this.isWord(ending.toLowerCase())))) return whole;
    }
    const core = rstrip(sub(re('^(?:https?://)?(?:www\\.)?'), '', text), '/');
    return ` ${this.spokenAddress(core)} ${tail}`;
  };

  private chatForm = (m: Match): string => {
    const said = this.chat.get(m.get(0).toLowerCase());
    if (said === undefined) return m.get(0);
    if (said === '-') return ' ';
    return ' ' + pySplit(said).map((part) => (part.startsWith('*') ? `${SPELL}${part.slice(1)}${END}` : part)).join(' ') + ' ';
  };

  private inlinePronunciation = (m: Match): string => {
    const symbols = pySplit(m.get(2));
    if (!symbols.length || symbols.every((s) => [...s].length === 1 && isAscii(s))) return m.get(0);
    let phones: Phone[];
    try {
      phones = isArpabet(symbols) ? convert('', symbols) : fromText(symbols.join(' '));
    } catch {
      return m.get(0);
    }
    this.inline.push([m.group(1) ?? '', phones]);
    return ` ${INLINE}${String.fromCharCode(INLINE_BASE + this.inline.length - 1)}${INLINE} `;
  };

  private dotted(m: Match, text: string): string {
    const letters = m.get(0).replaceAll('.', '');
    const k = letters.toLowerCase();
    const following = lstrip(text.slice(m.end()));
    const words = k === 'eg' ? 'for example' : k === 'ie' ? 'that is' : `${SPELL}${letters.toUpperCase()}${END}`;
    const first = reMatch(re("[A-Za-z']+"), following);
    const endsSentence = !following || (isUpper(following[0]!) && first !== null && SENTENCE_STARTERS.has(first.get(0).toLowerCase()));
    return ` ${words}${endsSentence && m.get(0).endsWith('.') ? ' .' : ''} `;
  }

  private abbreviation(m: Match, text: string): string {
    const token = m.get(1), stop = m.get(2);
    const k = token.toLowerCase();
    const following = text.slice(m.end());
    const nextWord = reMatch(re(String.raw`\s*([A-Za-z]+|\d)`), following);
    const capitalNext = Boolean(nextWord) && isUpper(nextWord!.get(1)[0]!);
    const capitalBefore = search(re(String.raw`[A-Z][a-z]+\s+$`), text.slice(0, m.start())) !== null;
    if ((k === 'st' || k === 'dr') && isUpper(token[0]!)) {
      if (capitalNext && (stop || k === 'dr')) return k === 'st' ? ' saint ' : ' doctor ';
      if (capitalBefore && stop) return (k === 'st' ? ' street' : ' drive') + (!following.trim() ? ' .' : ' ');
      return m.get(0);
    }
    if (!this.abbreviations.has(k)) return m.get(0);
    let [when, words] = this.abbreviations.get(k)!;
    const numberNext = Boolean(nextWord) && isDigit(nextWord!.get(1));
    if (when === 'title') {
      if (!(isUpper(token[0]!) && (capitalNext || stop))) return m.get(0);
    } else if (when === 'number') {
      const previous = search(re(String.raw`([A-Za-z]+)\.?\s+$`), text.slice(0, m.start()));
      if (!(stop && (numberNext || (k === 'no' && previous && NUMBERED.has(previous.get(1).toLowerCase()))))) return m.get(0);
    } else if (!stop || (when === 'small' && isUpper(token))) {
      return m.get(0);
    } else if (['mar', 'sun', 'sat', 'jan', 'dec', 'max', 'min', 'est', 'no'].includes(k) && !isUpper(token[0]!) && !numberNext) {
      if (!(['max', 'min', 'est'].includes(k) && nextWord && isLower(nextWord.get(1)[0]!))) return m.get(0);
    }
    if (k === 'est' && !numberNext) words = 'estimated';
    const endsSentence = when !== 'title' && (!following.trim() || (capitalNext && SENTENCE_STARTERS.has(nextWord!.get(1).toLowerCase())));
    return ` ${words}${endsSentence ? ' .' : ''} `;
  }

  rewrite(textIn: string): string {
    let text = sub(re(VULGAR), this.vulgar, textIn);
    text = sub(re(String.raw`(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s?(km|cm|mm|m|ft|mi|yd|in)([²³])`), this.square, text);
    text = text.replaceAll('²', ' squared ').replaceAll('³', ' cubed ');
    text = text.normalize('NFKC').replaceAll('⁄', '/').replaceAll('−', ' minus ');
    if (!isAscii(text)) {
      text = sub(re(ACCENTED, 'i'), (m) => '{' + ACCENT_DECIDES[m.get(1).toLowerCase()]! + (m.group(2) ? ' Z' : '') + '}', text);
      text = [...text].map(plainLetter).join('');
    }
    text = sub(re(String.raw`(?<=\d)–(?=\d)`), '-', text);
    text = sub(re(DAY_RANGE), this.dayRange, text);
    for (const [old, replacement] of [['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"], ['`', "'"], ['´', "'"], ['“', '"'], ['”', '"'],
      ['„', '"'], ['‟', '"'], ['«', '"'], ['»', '"'], ['–', '—'], ['―', '—'], ['[', '('], [']', ')']]) text = text.replaceAll(old!, replacement!);
    this.inline = [];
    text = sub(re(String.raw`([A-Za-z']+)?\{([^{}]*)\}`), this.inlinePronunciation, text);
    text = text.replaceAll('{', '(').replaceAll('}', ')');
    text = sub(re(ADDRESS), this.address, text);
    text = text.replaceAll('→', ' to ');
    text = sub(re(EMOJI), ' ', text);
    text = sub(re(EMOTICON), ' ', text);
    text = sub(re(String.raw`\.{3,}`), '…', text);
    text = sub(re(String.raw`(?<=\d)\s-\s(?=\d[\d.,]*\s?=)`), ' minus ', text);
    text = sub(re(String.raw`(?<![\d.,/-])(\d[\d.,]*)-(?=\d[\d.,]*=)`), '\\1 minus ', text);
    text = sub(re(String.raw`-{2,}|\s-\s`), '—', text);
    text = sub(re(String.raw`\bw/o\b`, 'i'), ' without ', text);
    text = sub(re(String.raw`\bw/(?=\s|$)`, 'i'), ' with ', text);
    text = sub(re(String.raw`\bn/a\b`, 'i'), ' not applicable ', text);
    text = text.replaceAll("'n'", " 'n ");
    if (search(re('[<>≥≤≠]|!='), text)) text = this.markComparisons(text);
    if (search(re(String.raw`\d`), text)) text = this.figures(text);
    return this.signs(text);
  }

  private figures(textIn: string): string {
    let text = sub(re(FORMULA_END), (m) => m.get(0).slice(0, -1) + FORMULA_SIGN, textIn);
    text = sub(re(CONTINENTAL), this.continental, text);
    text = sub(re(COMMA_AFTER_SIGN), '\\1.\\2', text);
    text = sub(re(COMMA_BEFORE_SIGN), '\\1.\\2', text);
    text = sub(re(MONEY), this.money, text);
    text = sub(re(RANGE_BEFORE_SIGN), '\\1 to ', text);
    text = sub(re(MONEY_AFTER), this.money, text);
    text = sub(re(String.raw`(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s?¢`), (m) => ` ${numberWords(m.get(1))} ${m.get(1) === '1' ? 'cent' : 'cents'} `, text);

    const clock = String.raw`\d{1,2}:[0-5]\d(?:\s?[AaPp]\.?[Mm]\.?)?|\b\d{1,2}\s?[AaPp]\.?[Mm]\.?`;
    text = sub(re('(' + clock + String.raw`)\s(` + ZONES + String.raw`)\b`), (m) => `${m.get(1)} ${spelled(m.get(2))}`, text);
    text = sub(re(String.raw`(?<![\d.,:])(\d{1,2})\.([0-5]\d)(?=\s?[AaPp]\.?[Mm]\b)`), '\\1:\\2', text);
    text = sub(re(String.raw`(?<![\d.,:])(\d{1,2})\.(00|15|30|45)(\s?(?:to|until|till|and|[-—])\s?)(\d{1,2})\.(00|15|30|45)(?!\d|\.\d)`), this.dotTimes, text);
    text = sub(re('(' + clock + String.raw`)\s?[-—]\s?(?=\d{1,2}(?::[0-5]\d|\s?[AaPp]\.?[Mm]\b))`), '\\1 to ', text);
    text = sub(re(RATIO), this.ratio, text);
    text = sub(re(String.raw`(?<![\d:])(\d{1,2}):([0-5]\d)(?::([0-5]\d))?` + HALF_DAY + String.raw`?(?![\d:])`), this.time, text);
    text = sub(re(String.raw`(?<![\d.:,])(\d{1,2})` + HALF_DAY + String.raw`(?![A-Za-z])`),
      (m) => ` ${cardinal(int(m.get(1)))} ` + this.halfDay(m, m.group(2), m.group(3)), text);

    const seen = (findall(re(String.raw`(?<![\d/.])(\d{1,2})/(\d{1,2})(?:/(?:\d{4}|\d{2}))?(?![\d/])`), text) as string[][])
      .map(([a, b]) => [int(a!), int(b!)] as const).filter(([a, b]) => !(a === 24 && b === 7));
    this.dayFirst = seen.some(([a, b]) => a > 12 && 12 >= b) && !seen.some(([a, b]) => b > 12 && 12 >= a);
    this.dated = search(re(String.raw`(?<![\d/])\d{1,2}/\d{1,2}/(?:\d{4}|\d{2})(?![\d/])`), text) !== null;
    text = sub(re(String.raw`(?<![\d-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d-])`), (m) => this.date(int(m.get(2)), int(m.get(3)), m.get(1)) ?? m.get(0), text);
    text = sub(re(String.raw`(?<![\d/])(\d{4})/(\d{1,2})/(\d{1,2})(?![\d/])`), (m) => this.date(int(m.get(2)), int(m.get(3)), m.get(1)) ?? m.get(0), text);
    text = sub(re(String.raw`(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d|\.\d)`), this.dotDate, text);
    text = sub(re(String.raw`(?<![\d/])(\d{1,2})/(\d{1,2})/(\d{4}|\d{2})(?![\d/])`), this.slashDate, text);
    text = sub(re(String.raw`\b(` + MONTH_PATTERN + String.raw`)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s?[-—]\s?(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?![\d:])`), this.daysOfMonth, text);
    text = sub(re(String.raw`(?<![\d.,/:-])(\d{1,2})(?:st|nd|rd|th)?\s?[-—]\s?(\d{1,2})(?:st|nd|rd|th)?\s+(` + MONTH_PATTERN + String.raw`)\b(?:,?\s+(\d{4}))?`), this.daysOfMonth, text);
    text = sub(re(String.raw`\b(` + MONTH_PATTERN + String.raw`)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?![\d:])`),
      (m) => this.date(MONTH_NUMBER.get(m.get(1).toLowerCase().slice(0, 3))!, int(m.get(2)), m.group(3)) ?? m.get(0), text);
    text = sub(re(String.raw`(?<![\d.,/:-])(\d{1,2})(?:st|nd|rd|th)?\s+(` + MONTH_PATTERN + String.raw`)\b(\.(?=\s+[a-z\d]))?(?:,?\s+(\d{4}))?`), this.dayMonth, text);

    text = sub(re(String.raw`(?<![\d-])(?:\+?(1)[-.\s])?\(?(\d{3})\)?[-.\s](\d{3})[-.\s](\d{4})(?![\d-])`), this.phone, text);
    text = sub(re(String.raw`(?<![\w.,-])(\d{3})-(\d{4})(?![\w-])`), this.phone, text);
    text = sub(re(String.raw`(?<![\w.])([vV])?(\d+(?:\.\d+){2,})(?:-(\d+)(?![\w-]|\.\d))?(?![\w])`),
      (m) => ' ' + (m.group(1) ? spelled(m.get(1)) + ' ' : '') + m.get(2).split('.').map(versionPart).join(' point ')
        + (m.group(3) ? ' dash ' + numberWords(m.get(3)) : '') + ' ', text);
    text = sub(re(String.raw`(?<![\w.])([vV])(\d+)\.(\d{2,3})(?!\d|\.\d|\w)`), (m) => ` ${spelled(m.get(1))} ${cardinal(int(m.get(2)))} point ${minor(m.get(3))} `, text);
    text = sub(re(String.raw`\b(` + VERSIONED + String.raw`)(\.?\s(?:(?:from|to)\s)?)(\d+)\.(\d{2,3})(?:(\s(?:to|or|and)\s)(\d+)\.(\d{2,3}))?(?!\d|\.\d|\s?%|\s(?:percent|million|billion)\b)`, 'i'),
      (m) => `${m.get(1)}${m.get(2)}${cardinal(int(m.get(3)))} point ${minor(m.get(4))}`
        + (m.group(5) ? `${m.get(5)}${cardinal(int(m.get(6)))} point ${minor(m.get(7))}` : '') + ' ', text);
    text = sub(re(CODE), this.code, text);
    text = sub(re(SLASHED), (m) => ' ' + this.digitGroups(m.get(1).split('/')) + ' ', text);
    text = sub(re(GROUPED), this.grouped, text);

    text = sub(re(String.raw`(?<![\w.])-(?=\d)`), ' minus ', text);
    text = sub(re(String.raw`(?:(?<=\d)\s?[xX×]|×)\s?(?=\d[\d.,]*\s?(?:` + LENGTHS + String.raw`)\b)`), ' by ', text);
    text = sub(re(String.raw`(?<=\d)\s[xX×]\s(?=\d)`), ' times ', text);
    text = sub(re(String.raw`(?<![\w/'])[A-Za-z0-9/]*[0-9/][A-Za-z0-9/]*(?![\w/'])`), this.chatForm, text);
    text = sub(re(String.raw`(?<![\w.])'?(\d{2}|\d{4})'?s\b`),
      (m) => ' ' + pluralOf(m.get(1).length === 4 ? year(int(m.get(1))) : cardinal(int(m.get(1)))) + ' ', text);
    text = sub(re(String.raw`(?<![\w.])(\d+)(?:st|nd|rd|th)\b`), (m) => ` ${ordinal(bigint(m.get(1)))} `, text);
    text = sub(re(String.raw`(?<![\w.])(144|240|360|480|540|576|720|900|1080|1440|2160|4320)([pi])\b`),
      (m) => ` ${pairs(int(m.get(1)))} ${spelled(m.get(2))} `, text);
    text = sub(re(String.raw`(\d[\d,]*(?:\.\d+)?)\s?%`), (m) => ` ${numberWords(m.get(1))} percent `, text);
    text = sub(re(String.raw`(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s?(km|cm|mm|m|ft)([23])(?![\w])`), this.square, text);
    text = sub(re(this.unit, 'i'), this.measure, text);
    text = sub(re(String.raw`(?<![\d/.,-])(\d+) (\d)/(2|3|4|5|6|8|10|16)(?![\d/]|\.\d)`), this.mixedFraction, text);
    text = sub(re(String.raw`(?<![\d/.])(\d+)/(\d+)(?![\d/]|\.\d)`), this.fraction, text);
    text = sub(re(String.raw`(?<![\w.,-])(\d{4})[-–](\d{4})(?![\w.,-])`), (m) => ` ${year(int(m.get(1)))} to ${year(int(m.get(2)))} `, text);
    text = sub(re(String.raw`(?<![\w.,-])(\d+)[-–](\d+)(?![\w-]|[.,]\d)`), (m) => ` ${numberWords(m.get(1))} to ${numberWords(m.get(2))} `, text);
    text = sub(re(String.raw`(?<![\w.])(\d+)x\b`), (m) => ` ${numberWords(m.get(1))} times `, text);
    text = sub(re(String.raw`(?<=\d)\^(?=\d)`), ' to the power of ', text);
    return text;
  }

  private namedLetters(text: string): string {
    if (![...'=<>+*/^()≤≥≠≈×÷±'].some((sign) => text.includes(sign))) return text;
    const plain = withoutAngles(text);
    const places = new Set<number>();
    for (const pattern of LETTER_PLACES) for (const m of finditer(re(pattern), plain)) places.add(m.start('letter'));
    if (!places.size) return text;
    let out = '';
    for (let index = 0; index < text.length; index++) out += places.has(index) ? `${SPELL}${text[index]!.toUpperCase()}${END}` : text[index]!;
    return out;
  }

  private markComparisons(text: string): string {
    const plain = withoutAngles(text);
    const mark = (m: Match): string => {
      const beforeText = plain.slice(0, m.start()), after = plain.slice(m.end());
      const value = search(re(VALUE_BEFORE), beforeText);
      if (plain[m.start('sign')] !== m.get('sign')[0] || value === null || !reMatch(re(VALUE_AFTER), after)) return m.get(0);
      let start = value.start();
      if (')]'.includes(value.get(0)) && value.get(0).length === 1) {
        let depth = 0;
        while (start >= 0) {
          depth += (')]'.includes(beforeText[start]!) ? 1 : 0) - ('(['.includes(beforeText[start]!) ? 1 : 0);
          if (depth === 0) break;
          start--;
        }
        while (start > 0 && (isAlnum(beforeText[start - 1]!) || '_.'.includes(beforeText[start - 1]!))) start--;
      }
      const word = search(re("[A-Za-z']+$"), rstrip(beforeText.slice(0, Math.max(start, 0))));
      if (word && !CLAUSE_OPENERS.has(word.get(0).toLowerCase())) return m.get(0);
      return IS + m.get(0);
    };
    return sub(re(COMPARED), mark, text);
  }

  private compared(m: Match, words: string): string {
    const marked = m.get(0).startsWith(IS) || rstrip(m.string.slice(0, m.start()), ' ').endsWith(IS);
    return ` ${marked ? 'is ' : ''}${words} `;
  }

  private joinedComparisons(text: string): string {
    const plain = withoutAngles(text);
    const read = (m: Match): string => {
      const beforeText = rstrip(text.slice(0, m.start()), IS), after = text.slice(m.end());
      if (plain[m.start()] !== m.get(0)) return m.get(0);
      if (!(search(re(FIGURE_BEFORE), beforeText) || reMatch(re(FIGURE_AFTER), after)
        || (search(re(LETTER_BEFORE), beforeText) && reMatch(re(LETTER_AFTER), after)))) return m.get(0);
      return this.compared(m, m.get(0) === '<' ? 'less than' : 'greater than');
    };
    return sub(re(JOINED_COMPARISON), read, text);
  }

  private signs(textIn: string): string {
    let text = this.namedLetters(textIn);
    if (text.includes('<') || text.includes('>')) text = this.joinedComparisons(text);
    text = sub(re(String.raw`(?<![\w-])(` + SIZES + ')-(' + SIZES + String.raw`)(?![\w-])`), (m) => ` ${spelled(m.get(1))} to ${spelled(m.get(2))} `, text);
    text = sub(re(String.raw`#(?=\d)`), ' number ', text);
    text = sub(re(String.raw`#(?=[A-Z]{1,4}-?\d)`), ' number ', text);
    text = sub(re('#(?=[A-Za-z])'), ' hashtag ', text);
    text = sub(re(String.raw`~(?=\s?\d)`), ' about ', text);
    text = sub(re(String.raw`(?<=[\w\s` + END + IS + String.raw`])(>=|<=|!=)(?=[\w\s` + SPELL + '])'), (m) => this.compared(m, COMPARISONS[m.get(1)]!), text);
    text = sub(re(String.raw`(?<=\d) Ti\b`), ` ${spelled('TI')}`, text);
    text = sub(re(String.raw`\b([Rr])ef\.\s?[Nn]o\.(?=\s)`), '\\1eference number', text);
    if (text.includes('.')) {
      const current = text;
      text = sub(re(String.raw`\b((?:[A-Za-z]\.){2,})`), (m) => this.dotted(m, current), text);
    }
    {
      const current = text;
      text = sub(re(String.raw`\b([A-Za-z]{1,6})\b(\.?)(?![A-Za-z'’])`), (m) => this.abbreviation(m, current), text);
    }
    if (search(re(String.raw`\d`), text)) {
      text = sub(re(GLUED), this.glued, text);
      const current = text;
      text = sub(re(String.raw`(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|(?<![\w.])\.\d+`), (m) => this.number(m, current), text);
    }
    text = sub(re('(?<=[A-Za-z])/(?=[A-Za-z])'), ' ', text);
    text = sub(re(String.raw`(?<=\d)` + IS + String.raw`?\s?[<>]\s?(?=\d)|(?<=\s)[<>](?=\s)`),
      (m) => this.compared(m, m.get(0).includes('<') ? 'less than' : 'greater than'), text);
    text = sub(re('[' + escape(Object.keys(SYMBOL_WORDS).join('')) + ']'),
      (m) => ('≥≤≠'.includes(m.get(0)) ? this.compared(m, SYMBOL_WORDS[m.get(0)]!) : ` ${SYMBOL_WORDS[m.get(0)]} `), text);
    return text.replaceAll(IS, '');
  }

  // -- words --

  private static unstretched(word: string): string[] {
    if (!search(re(String.raw`(.)\1\1`), word)) return [];
    const cut = (doubleInside: boolean, doubleFinal: boolean): string =>
      sub(re(String.raw`(.)\1{2,}`), (m) => m.get(1).repeat((m.end() === word.length ? doubleFinal : doubleInside) ? 2 : 1), word);
    const liked = search(re(String.raw`([lfsz])\1\1+$`), word) !== null || (new Set(word).size === 1 && word[0] === 'm')
      || sub(re(String.raw`(.)\1{2,}$`), '\\1', word) === 'to';
    return [...new Set([cut(true, liked), cut(true, !liked), cut(false, liked), cut(false, !liked)])];
  }

  private static chatWords(chat: string, raw: string): Word[] {
    if (chat === '-') return [];
    return pySplit(chat).map((part) => (part.startsWith('*') ? W(part.slice(1).toLowerCase(), { raw, spell: true }) : W(part.toLowerCase(), { raw: part })));
  }

  private static reply(out: Token[], place: number): boolean {
    const marks: string[] = [];
    for (const step of [-1, 1]) {
      let index = place + step;
      while (index >= 0 && index < out.length && out[index]!.kind === 'punct' && '"\'()'.includes((out[index] as Punct).mark)) index += step;
      if (!(index >= 0 && index < out.length)) marks.push('');
      else if (out[index]!.kind === 'word') return false;
      else {
        const mark = (out[index] as Punct).mark;
        marks.push(mark);
        const beyond = index + step >= 0 && index + step < out.length ? out[index + step]! : null;
        if (mark === ',' && beyond && beyond.kind === 'word' && beyond.text.length === 1 && beyond.text !== 'i') return false;
      }
    }
    return !(marks[0] === ',' && marks[1] === ',');
  }

  private wordTokens(raw: string, allCaps: boolean, previous: string, following = true, fresh = false): Word[] {
    const lower = raw.toLowerCase();
    const chat = this.chat.get(lower);
    if (chat !== undefined && (raw.length > 1 || isLower(raw)) && !this.replies.has(lower)) return Normalizer.chatWords(chat, raw);
    if (Object.hasOwn(ROMAN, raw) && previous && isUpper(previous[0]!)) {
      const number = ROMAN[raw]!;
      const words = CARDINAL_AFTER.has(previous.toLowerCase()) ? cardinal(number) : 'the ' + ordinal(number);
      return words.split(' ').map((w) => W(w, { raw }));
    }
    const letters = raw.replaceAll("'", '');
    const possessive = lower.endsWith("'s");
    const stem = possessive ? raw.slice(0, -2) : raw;
    if (stem.length === 1 && isAlpha(stem)) {
      const label = stem === 'A' && Boolean(previous) && (!following || (!fresh && LABELLED.has(previous.toLowerCase())));
      if (['a', 'A', 'I', 'i'].includes(stem) && !possessive && !label) return [W(stem.toLowerCase(), { raw })];
      return [W(lower, { raw, spell: true })];
    }
    if (stem.length > 2 && 'SsZz'.includes(stem[0]!) && new Set(lower).size === 1 && (allCaps || !isUpper(stem))) {
      return [W(lower, { raw, phones: [[lower[0]!, 0]] })];
    }
    if (isUpper(stem) && isAlpha(stem) && stem.length >= 2 && stem.length <= 5 && (!allCaps || !this.isWord(stem.toLowerCase()))) {
      if (INITIALISMS.has(stem) || !this.isWord(stem.toLowerCase())) return [W(lower, { raw, spell: true })];
    }
    if (!isAlpha(letters)) return [];
    const capitals = fullmatch(re("[a-z]+(?:[A-Z][a-z]+)*[A-Z]{2,}(?:'s)?"), raw) !== null;
    if (capitals || !this.isWord(lower)) {
      for (const candidate of capitals ? [] : Normalizer.unstretched(lower)) if (this.isWord(candidate)) return [W(candidate, { raw })];
      const parts = findallStrings(re("[A-Z]?[a-z']+|[A-Z]+(?![a-z])"), raw);
      if (parts.length > 1 && parts.join('') === raw) {
        const out: Word[] = [];
        for (const part of parts) {
          const named = capitals && isUpper(part) ? INITIALISMS.has(part) : false;
          const spelledPart = part.length === 1 || named || (isUpper(part) && !this.isWord(part.toLowerCase()));
          const lastOut = out[out.length - 1];
          if (capitals && lastOut && lastOut.spell && (spelledPart || part === "'s")) {
            out[out.length - 1] = { ...lastOut, text: lastOut.text + part.toLowerCase(), raw: lastOut.raw + part };
          } else {
            out.push(W(part.toLowerCase(), { attach: out.length > 0, raw: part, spell: spelledPart }));
          }
        }
        return out;
      }
    }
    return [W(lower, { raw })];
  }

  tokens(textIn: string): Token[] {
    const text = this.rewrite(textIn);
    const runs = findallStrings(re('[A-Za-z]{2,}'), text);
    const allCaps = runs.length >= 3 && runs.filter((r) => isUpper(r)).length >= 0.6 * runs.length;
    const out: Token[] = [];
    const pattern = re(SPELL + '([A-Za-z ]+)' + END + '|' + INLINE + '(.)' + INLINE + String.raw`|('?[A-Za-z]+(?:'[A-Za-z]+)*)|(\d+)|(-)|(\S)`);
    let attach = false;
    let previous = '';
    let fresh = true;
    const short: number[] = [];
    const replies: number[] = [];
    for (const m of finditer(pattern, text)) {
      const [spelledText, inline, wordIn, number, hyphen, other] = m.groups();
      const beforeChar = m.start() ? text[m.start() - 1]! : ' ';
      if (hyphen) {
        const last = out[out.length - 1];
        attach = Boolean(last) && last!.kind === 'word' && !isSpace(beforeChar) && m.end() < text.length && isAlnum(text[m.end()]!);
        continue;
      }
      let added: Word[] = [];
      if (spelledText !== undefined) {
        added = [W(spelledText.replaceAll(' ', '').toLowerCase(), { raw: spelledText, spell: true })];
      } else if (inline !== undefined) {
        const [written, phones] = this.inline[inline.charCodeAt(0) - INLINE_BASE]!;
        added = [W(written.toLowerCase(), { raw: written, phones })];
      } else if (wordIn !== undefined) {
        let word = wordIn;
        if (word.startsWith("'") && !LEADING_APOSTROPHE.has(word.toLowerCase())) { out.push(Pu("'")); word = word.slice(1); }
        else if (word.startsWith("'") && !this.isWord(word.toLowerCase())) word = word.slice(1);
        added = this.wordTokens(word, allCaps, previous, reMatch(re(String.raw`\s*[A-Za-z]`), text.slice(m.end())) !== null, fresh);
        previous = word;
        if (['Ss', 'ss', 'Zz', 'zz'].includes(word) && added.length === 1 && (isSpace(beforeChar) || '"\'('.includes(beforeChar))
          && reMatch(re(String.raw`[.!?…,;:—"')]*(?:\s|$)`), text.slice(m.end()))) short.push(out.length);
        if (this.replies.has(word.toLowerCase()) && (word.length > 1 || isLower(word)) && added.length === 1
          && (isSpace(beforeChar) || '"\''.includes(beforeChar))
          && reMatch(re(String.raw`(?:[.?…,;—]*["']?(?:\s|$)|!+["']?\s*$)`), text.slice(m.end()))) replies.push(out.length);
      } else if (number !== undefined) {
        added = pySplit(numberWords(number)).map((part) => W(part, { raw: number }));
      } else if (other !== undefined && PUNCTUATION.includes(other)) {
        if (!(other === "'" && isAlnum(beforeChar) && m.end() < text.length && isAlnum(text[m.end()]!))) out.push(Pu(other));
        if ('.!?;…'.includes(other)) fresh = true;
        attach = false;
        continue;
      }
      if (added.length && attach) added[0] = { ...added[0]!, attach: true };
      out.push(...added);
      attach = false;
      fresh = fresh && !added.length;
    }
    for (const place of short) {
      let first = place, last = place + 1;
      while (first && (out[first - 1]!.kind === 'word' || '"\'()'.includes((out[first - 1] as Punct).mark))) first--;
      while (last < out.length && (out[last]!.kind === 'word' || '"\'()'.includes((out[last] as Punct).mark))) last++;
      const words = out.slice(first, last).filter((t): t is Word => t.kind === 'word');
      if (words.every((t) => SOUNDS.has(t.text) || (t.phones !== null && new Set(t.text).size === 1))) {
        const word = out[place] as Word;
        out[place] = { ...word, phones: [[word.text[0]!, 0]] };
      }
    }
    for (const place of [...replies].reverse()) {
      if (Normalizer.reply(out, place)) {
        const raw = (out[place] as Word).raw;
        out.splice(place, 1, ...Normalizer.chatWords(this.chat.get(raw.toLowerCase())!, raw));
      }
    }
    return out;
  }
}
