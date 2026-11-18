/**
 * Python's string and `re` behaviour, as much of it as the port of dizione needs. The rules of dizione are written as
 * Python regular expressions; they are kept as written and translated here, so the port can be compared line by line
 * with the original. Python's `\w`, `\d` and `\b` are Unicode-aware, JavaScript's are not, so they are spelled out
 * with Unicode properties.
 */

const WORD = '\\p{L}\\p{N}_';
const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
const SYNTAX = new Set('^$\\.*+?()[]{}|/'.split(''));
const cache = new Map<string, RegExp>();

/** A Python pattern as a JavaScript one: `u`, `d` (group positions) and `g` are always on. */
export function re(pattern: string, flags = ''): RegExp {
  const key = flags + '\u0000' + pattern;
  let found = cache.get(key);
  if (!found) {
    found = new RegExp(translate(pattern), 'gud' + flags);
    cache.set(key, found);
  }
  found.lastIndex = 0;
  return found;
}

export function translate(pattern: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') {
      const n = pattern[i + 1]!;
      i++;
      if (n === 'w') out += inClass ? WORD : `[${WORD}]`;
      else if (n === 'W') out += inClass ? '\\W' : `[^${WORD}]`;
      else if (n === 'd') out += '\\p{Nd}';
      else if (n === 'D') out += '\\P{Nd}';
      else if (n === 'b' && !inClass) out += BOUNDARY;
      else if (/[A-Za-z0-9]/.test(n)) out += '\\' + n;
      else if (SYNTAX.has(n) || (inClass && n === '-')) out += '\\' + n;
      else out += n === '-' ? '-' : escapeChar(n);
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      out += c;
      continue;
    }
    if (c === '[') {
      inClass = true;
      out += c;
      if (pattern[i + 1] === '^') { out += '^'; i++; }
      if (pattern[i + 1] === ']') { out += '\\]'; i++; }
      continue;
    }
    if (c === '(' && pattern.startsWith('(?P<', i)) { out += '(?<'; i += 3; continue; }
    if (c === '(' && pattern.startsWith('(?P=', i)) {
      const end = pattern.indexOf(')', i);
      out += `\\k<${pattern.slice(i + 4, end)}>`;
      i = end;
      continue;
    }
    if (c === '{' && !/^\{\d*(,\d*)?\}/.test(pattern.slice(i))) { out += '\\{'; continue; }
    if (c === '}' && !/\{\d*(,\d*)?$/.test(out.slice(Math.max(0, out.length - 12)))) { out += '\\}'; continue; }
    out += c;
  }
  return out;
}

function escapeChar(c: string): string {
  return SYNTAX.has(c) ? '\\' + c : c;
}

/** `re.escape` for a literal inside a translated pattern. */
export function escape(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, (c) => '\\' + c);
}

export class Match {
  constructor(readonly m: RegExpExecArray, readonly string: string) {}
  group(n: number | string = 0): string | undefined {
    return typeof n === 'number' ? this.m[n] : this.m.groups?.[n];
  }
  get(n: number | string = 0): string {
    return this.group(n) ?? '';
  }
  groups(): (string | undefined)[] {
    return this.m.slice(1);
  }
  start(n: number | string = 0): number {
    if (n === 0) return this.m.index;
    const span = typeof n === 'number' ? this.m.indices?.[n] : this.m.indices?.groups?.[n];
    return span ? span[0] : -1;
  }
  end(n: number | string = 0): number {
    if (n === 0) return this.m.index + this.m[0].length;
    const span = typeof n === 'number' ? this.m.indices?.[n] : this.m.indices?.groups?.[n];
    return span ? span[1] : -1;
  }
}

export function* finditer(pattern: RegExp, text: string): Generator<Match> {
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    yield new Match(m, text);
    if (m[0].length === 0) pattern.lastIndex = advance(text, pattern.lastIndex);
  }
}

function advance(text: string, index: number): number {
  const code = text.codePointAt(index);
  return index + (code !== undefined && code > 0xffff ? 2 : 1);
}

/** `re.sub` with a function or a template (`\1`, `\g<name>`). */
export function sub(pattern: RegExp, replacement: string | ((m: Match) => string), text: string): string {
  let out = '';
  let last = 0;
  for (const match of finditer(pattern, text)) {
    out += text.slice(last, match.start());
    out += typeof replacement === 'string' ? expand(replacement, match) : replacement(match);
    last = match.end();
  }
  return out + text.slice(last);
}

function expand(template: string, match: Match): string {
  return template.replace(/\\(\d+)|\\g<(\w+)>/g, (_, n: string | undefined, name: string | undefined) =>
    match.get(n !== undefined ? Number(n) : /^\d+$/.test(name!) ? Number(name) : name!));
}

/** `re.search`: the first match anywhere, or null. */
export function search(pattern: RegExp, text: string): Match | null {
  pattern.lastIndex = 0;
  const m = pattern.exec(text);
  return m ? new Match(m, text) : null;
}

/** `re.match`: a match that starts at the beginning. */
export function match(pattern: RegExp, text: string): Match | null {
  const sticky = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'y');
  sticky.lastIndex = 0;
  const m = sticky.exec(text);
  return m ? new Match(m, text) : null;
}

/** `re.fullmatch`. */
export function fullmatch(pattern: RegExp, text: string): Match | null {
  const whole = new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace('g', ''));
  const m = whole.exec(text);
  return m ? new Match(m, text) : null;
}

/** `re.findall`: whole matches, the group, or tuples of groups. */
export function findall(pattern: RegExp, text: string): (string | string[])[] {
  const out: (string | string[])[] = [];
  for (const m of finditer(pattern, text)) {
    const groups = m.groups();
    out.push(groups.length === 0 ? m.get(0) : groups.length === 1 ? (groups[0] ?? '') : groups.map((g) => g ?? ''));
  }
  return out;
}

export function findallStrings(pattern: RegExp, text: string): string[] {
  return findall(pattern, text) as string[];
}

/** `re.split` (patterns without groups). */
export function split(pattern: RegExp, text: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of finditer(pattern, text)) {
    out.push(text.slice(last, m.start()));
    last = m.end();
  }
  out.push(text.slice(last));
  return out;
}

// ---- str methods ----------------------------------------------------------

const CASED = /[\p{Lu}\p{Ll}\p{Lt}]/u;
export const isAlpha = (s: string): boolean => s.length > 0 && /^\p{L}+$/u.test(s);
export const isDigit = (s: string): boolean => s.length > 0 && /^\p{Nd}+$/u.test(s);
export const isAlnum = (s: string): boolean => s.length > 0 && /^[\p{L}\p{N}]+$/u.test(s);
export const isSpace = (s: string): boolean => s.length > 0 && /^\s+$/u.test(s);
export const isAscii = (s: string): boolean => /^[\x00-\x7f]*$/.test(s);
export const isUpper = (s: string): boolean => CASED.test(s) && !/[\p{Ll}\p{Lt}]/u.test(s);
export const isLower = (s: string): boolean => CASED.test(s) && !/[\p{Lu}\p{Lt}]/u.test(s);
export const pySplit = (s: string): string[] => s.trim().split(/\s+/u).filter(Boolean);

/** `str.strip(chars)`. */
export function strip(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

export const rstrip = (s: string, chars?: string): string => {
  if (chars === undefined) return s.replace(/\s+$/u, '');
  let b = s.length;
  while (b > 0 && chars.includes(s[b - 1]!)) b--;
  return s.slice(0, b);
};

export const lstrip = (s: string): string => s.replace(/^\s+/u, '');

/** `int()` of a string of (Unicode) decimal digits. */
export function int(s: string): number {
  if (/^[0-9]+$/.test(s)) return Number.parseInt(s, 10);
  return Number.parseInt([...s].map((d) => (/[0-9]/.test(d) ? d : String(digitValue(d)))).join(''), 10);
}

function digitValue(d: string): number {
  // Unicode decimal digits come in runs of ten: count back to the first one of the run.
  const code = d.codePointAt(0)!;
  let zero = code;
  while (zero > code - 9 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
  return code - zero;
}

/** A tuple key for maps. */
export const key = (parts: readonly string[]): string => parts.join('\u0000');
