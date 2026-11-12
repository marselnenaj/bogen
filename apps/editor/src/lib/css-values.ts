/** Parsing and printing of CSS values the inspector edits as structured data. Pure. */
import { msg } from '../i18n/core.ts';

export function splitTopLevel(value: string, separator: ',' | ' ' = ','): string[] {
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

/** Number with optional unit, or null. `px` and bare numbers come back with unit `px`/``. */
export function parseLength(value: string | undefined): { n: number; unit: string } | null {
  if (!value) return null;
  const m = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i.exec(value.trim());
  return m ? { n: parseFloat(m[1]!), unit: m[2]! } : null;
}

export function px(value: string | undefined, fallback = 0): number {
  const l = parseLength(value);
  return l ? l.n : fallback;
}

/** Shortest decimal form, enough for layout: 12.5, not 12.500000001. */
export function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '0';
  const r = Number(n.toFixed(digits));
  return String(Object.is(r, -0) ? 0 : r);
}

export function fmtPx(n: number): string {
  return `${fmt(n)}px`;
}

/**
 * Safe arithmetic for numeric fields: 12+8, 100/3, (4+4)*2, 50%*200, 2^3. Returns null if the text
 * is not an expression. `base` is the current value, so "+8" or "*2" work on it.
 */
export function evalExpression(text: string, base?: number): number | null {
  let src = text.trim().replace(/,/g, '.').replace(/px\b/gi, '');
  if (!src) return null;
  if (base !== undefined && /^[*/]/.test(src)) src = `${base}${src}`;
  else if (base !== undefined && /^\+/.test(src)) src = `${base}${src}`;
  let i = 0;
  const ws = () => { while (src[i] === ' ') i++; };
  const primary = (): number | null => {
    ws();
    if (src[i] === '(') {
      i++;
      const v = additive();
      ws();
      if (src[i] !== ')') return null;
      i++;
      return v;
    }
    if (src[i] === '-') { i++; const v = primary(); return v === null ? null : -v; }
    const m = /^(\d+\.?\d*|\.\d+)(%?)/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    const n = parseFloat(m[1]!);
    return m[2] ? n / 100 : n;
  };
  const power = (): number | null => {
    const a = primary();
    if (a === null) return null;
    ws();
    if (src[i] === '^') { i++; const b = power(); return b === null ? null : a ** b; }
    return a;
  };
  const multiplicative = (): number | null => {
    let a = power();
    while (a !== null) {
      ws();
      const op = src[i];
      if (op !== '*' && op !== '/') break;
      i++;
      const b = power();
      if (b === null) return null;
      a = op === '*' ? a * b : a / b;
    }
    return a;
  };
  function additive(): number | null {
    let a = multiplicative();
    while (a !== null) {
      ws();
      const op = src[i];
      if (op !== '+' && op !== '-') break;
      i++;
      const b = multiplicative();
      if (b === null) return null;
      a = op === '+' ? a + b : a - b;
    }
    return a;
  }
  const v = additive();
  ws();
  if (v === null || i !== src.length || !Number.isFinite(v)) return null;
  return v;
}

// Box shorthands

export interface Sides { top: string; right: string; bottom: string; left: string }

export function parseSides(value: string | undefined): Sides {
  const p = splitTopLevel(value ?? '', ' ');
  const a = p[0] ?? '0';
  const b = p[1] ?? a;
  const c = p[2] ?? a;
  const d = p[3] ?? b;
  return { top: a, right: b, bottom: c, left: d };
}

export function printSides(s: Sides): string {
  if (s.top === s.right && s.top === s.bottom && s.top === s.left) return s.top;
  if (s.top === s.bottom && s.left === s.right) return `${s.top} ${s.right}`;
  return `${s.top} ${s.right} ${s.bottom} ${s.left}`;
}

/** Padding of a style, honouring both the shorthand and the longhands. */
export function paddingOf(style: Record<string, string>): { top: number; right: number; bottom: number; left: number } {
  const s = parseSides(style.padding);
  const inline = style.paddingInline ? parseSides(style.paddingInline) : null;
  const block = style.paddingBlock ? parseSides(style.paddingBlock) : null;
  return {
    top: px(style.paddingTop ?? block?.top ?? s.top),
    right: px(style.paddingRight ?? inline?.right ?? inline?.top ?? s.right),
    bottom: px(style.paddingBottom ?? block?.right ?? block?.top ?? s.bottom),
    left: px(style.paddingLeft ?? inline?.top ?? s.left),
  };
}

export function radiiOf(style: Record<string, string>): [string, string, string, string] {
  const s = parseSides(style.borderRadius);
  return [style.borderTopLeftRadius ?? s.top, style.borderTopRightRadius ?? s.right, style.borderBottomRightRadius ?? s.bottom, style.borderBottomLeftRadius ?? s.left];
}

// Shadows

export interface Shadow { inset: boolean; x: number; y: number; blur: number; spread: number; color: string }

export function parseShadows(value: string | undefined): Shadow[] {
  if (!value || value === 'none') return [];
  return splitTopLevel(value).map((part) => {
    const tokens = splitTopLevel(part, ' ');
    const out: Shadow = { inset: false, x: 0, y: 0, blur: 0, spread: 0, color: 'rgba(0,0,0,0.25)' };
    const lengths: number[] = [];
    for (const t of tokens) {
      if (t === 'inset') out.inset = true;
      else {
        const l = parseLength(t);
        if (l) lengths.push(l.n);
        else out.color = t;
      }
    }
    out.x = lengths[0] ?? 0;
    out.y = lengths[1] ?? 0;
    out.blur = lengths[2] ?? 0;
    out.spread = lengths[3] ?? 0;
    return out;
  });
}

export function printShadows(list: Shadow[]): string {
  return list.map((s) => `${s.inset ? 'inset ' : ''}${fmt(s.x)}px ${fmt(s.y)}px ${fmt(s.blur)}px ${fmt(s.spread)}px ${s.color}`).join(', ');
}

/** Text shadows have no spread or inset. */
export function printTextShadows(list: Shadow[]): string {
  return list.map((s) => `${fmt(s.x)}px ${fmt(s.y)}px ${fmt(s.blur)}px ${s.color}`).join(', ');
}

// Filters

export interface FilterFn { fn: string; value: number; unit: string }

export const FILTER_DEFS: { fn: string; label: string; unit: string; min: number; max: number; step: number; initial: number }[] = [
  { fn: 'blur', label: msg('Blur'), unit: 'px', min: 0, max: 200, step: 1, initial: 4 },
  { fn: 'brightness', label: msg('Brightness'), unit: '%', min: 0, max: 300, step: 1, initial: 100 },
  { fn: 'contrast', label: msg('Contrast'), unit: '%', min: 0, max: 300, step: 1, initial: 100 },
  { fn: 'saturate', label: msg('Saturate'), unit: '%', min: 0, max: 300, step: 1, initial: 100 },
  { fn: 'hue-rotate', label: msg('Hue'), unit: 'deg', min: -180, max: 180, step: 1, initial: 0 },
  { fn: 'grayscale', label: msg('Grayscale'), unit: '%', min: 0, max: 100, step: 1, initial: 100 },
  { fn: 'sepia', label: msg('Sepia'), unit: '%', min: 0, max: 100, step: 1, initial: 100 },
  { fn: 'invert', label: msg('Invert'), unit: '%', min: 0, max: 100, step: 1, initial: 100 },
];

export function parseFilters(value: string | undefined): FilterFn[] {
  if (!value || value === 'none') return [];
  const out: FilterFn[] = [];
  for (const m of value.matchAll(/([a-z-]+)\(([^)]*)\)/g)) {
    const arg = parseLength(m[2]!.trim());
    if (!arg) continue;
    let n = arg.n;
    let unit = arg.unit;
    if (!unit && m[1] !== 'blur' && m[1] !== 'hue-rotate') { n *= 100; unit = '%'; }
    out.push({ fn: m[1]!, value: n, unit: unit || (m[1] === 'blur' ? 'px' : 'deg') });
  }
  return out;
}

export function printFilters(list: FilterFn[]): string {
  return list.map((f) => `${f.fn}(${fmt(f.value)}${f.unit})`).join(' ');
}

// Font features, `"liga" 1, "ss01" on`

export function parseFeatures(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || value === 'normal') return out;
  for (const part of splitTopLevel(value)) {
    const m = /^["']([^"']+)["']\s*(.*)$/.exec(part);
    if (m) out[m[1]!] = m[2]!.trim() || '1';
  }
  return out;
}

export function printFeatures(f: Record<string, string>): string {
  return Object.entries(f).map(([k, v]) => `"${k}" ${v}`).join(', ');
}

export const printAxes = printFeatures;
export const parseAxes = parseFeatures;
