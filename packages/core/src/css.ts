/** `background-color` to `backgroundColor`. Custom properties and vendor prefixes keep working. */
export function camelCss(prop: string): string {
  const p = prop.trim();
  if (p.startsWith('--')) return p;
  return p.replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** `backgroundColor` to `background-color`, `WebkitTextStroke` to `-webkit-text-stroke`. */
export function kebabCss(prop: string): string {
  if (prop.startsWith('--')) return prop;
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^ms-/, '-ms-');
}

/** Parses declarations, honouring strings, parentheses and comments, into camelCase keys. */
export function parseStyle(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let quote = '';
  let start = 0;
  const flush = (end: number) => {
    const decl = clean.slice(start, end);
    const colon = decl.indexOf(':');
    if (colon > 0) {
      const value = decl.slice(colon + 1).replace(/\s*!important\s*$/i, '').trim();
      if (value) out[camelCss(decl.slice(0, colon))] = value;
    }
  };
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(clean.length);
  return out;
}

export function styleToCss(style: Record<string, string>): string {
  return Object.entries(style).map(([k, v]) => `${kebabCss(k)}:${v}`).join(';');
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

const ZERO_UNITS = /^(px|em|rem|%|vw|vh|vmin|vmax|vi|vb|ch|ex|pt|pc|cm|mm|in|q|lh|rlh|cqw|cqh|cqi|cqb|svh|lvh|dvh|svw|lvw|dvw)$/;

function hexByte(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

/** `rgb(255, 0, 0)` and `rgba(0 0 0 / 50%)` as hex, or null when it holds more than plain numbers. */
function rgbToHex(args: string): string | null {
  const parts = args.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const nums = parts.map((p, i) => {
    if (!/^-?(?:\d+\.?\d*|\.\d+)%?$/.test(p)) return Number.NaN;
    const n = Number.parseFloat(p);
    return p.endsWith('%') ? (i < 3 ? n * 2.55 : n / 100) : n;
  });
  if (nums.some((n) => Number.isNaN(n))) return null;
  const alpha = nums[3] ?? 1;
  return `#${hexByte(nums[0]!)}${hexByte(nums[1]!)}${hexByte(nums[2]!)}${alpha >= 1 ? '' : hexByte(alpha * 255)}`;
}

/**
 * One spelling for values that mean the same, for comparing them: `.55` and `0.550` as `0.55`, `0px` as `0`, `#ABC`
 * as `#aabbcc`, `rgb(255, 0, 0)` as `#ff0000`, no spaces after commas or inside brackets. Not for writing CSS.
 */
export function normalizeCssValue(value: string): string {
  return value.trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*\/\s*/g, '/')
    .replace(/\brgba?\(([^()]*)\)/g, (whole, args: string) => rgbToHex(args) ?? whole)
    .replace(/#([0-9a-f]{3,4})(?![0-9a-f])/g, (_, h: string) => `#${[...h].map((c) => c + c).join('')}`)
    .replace(/#([0-9a-f]{6})ff(?![0-9a-f])/g, '#$1')
    .replace(/(?<![\w#.-])(-?)(\d*\.?\d+)([a-z%]*)/g, (_, sign: string, num: string, unit: string) => {
      const n = Number(`${sign}${num}`);
      if (n === 0 && (unit === '' || ZERO_UNITS.test(unit))) return '0';
      return `${String(n)}${unit}`;
    });
}

/**
 * Whether a CSS value contains another, both normalized, without matching inside a longer number or colour:
 * `0.5` is not in `0.55`, `#000` is not in `#000000aa`, and `16` is in `16px`.
 */
export function cssValueContains(value: string, wanted: string): boolean {
  const hay = normalizeCssValue(value);
  const needle = normalizeCssValue(wanted);
  if (!needle) return true;
  const numericStart = /^[-\d.]/.test(needle);
  const numericEnd = /\d$/.test(needle);
  const hexEnd = /#[0-9a-f]+$/.test(needle);
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = hay[at - 1] ?? '';
    const after = hay[at + needle.length] ?? '';
    if (numericStart && /[\d.]/.test(before)) continue;
    if (numericEnd && /[\d.]/.test(after)) continue;
    if (hexEnd && /[0-9a-f]/.test(after)) continue;
    return true;
  }
  return false;
}

/** Splits a CSS value at top-level commas or spaces, leaving parentheses and strings whole. */
export function splitCssList(value: string, separator: ',' | ' ' = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      cur += c;
      if (c === '\\') { cur += value[++i] ?? ''; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    const isSep = separator === ',' ? c === ',' : /\s/.test(c);
    if (isSep && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
