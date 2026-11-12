import { escapeAttr, escapeHtml, styleToCss } from './css.ts';
import { safeUrl } from './html-import.ts';
import type { TextSpan } from './doc.ts';

/**
 * Ranges in a text layer. `text` stays the plain string everything else reads, and spans only say how
 * parts of it look, in UTF-16 offsets. Stored spans come from other people's files, so they are checked
 * every time they turn into markup: offsets are clamped, styles and links go through the lists below.
 */
export const SPAN_STYLE_KEYS = ['fontWeight', 'fontStyle', 'fontSize', 'color', 'textDecorationLine', 'fontFamily', 'letterSpacing', 'backgroundColor'] as const;
const ALLOWED = new Set<string>(SPAN_STYLE_KEYS);
const UNSAFE_VALUE = /url\(|expression\s*\(|javascript:|@import|[;{}<>\\]/i;

export interface TextRun { text: string; style: Record<string, string>; href?: string }

export function cleanSpanStyle(style: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(style ?? {})) {
    if (ALLOWED.has(k) && typeof v === 'string' && v && v.length <= 200 && !UNSAFE_VALUE.test(v)) out[k] = v;
  }
  return out;
}

/** Spans that fit this text: sorted, non-overlapping, safe. Anything malformed is dropped. */
export function normalizeSpans(spans: unknown, length: number): TextSpan[] {
  if (!Array.isArray(spans)) return [];
  const clean: TextSpan[] = [];
  for (const raw of spans) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Partial<TextSpan>;
    const start = Math.max(0, Math.min(length, Math.floor(Number(s.start))));
    const end = Math.max(0, Math.min(length, Math.floor(Number(s.end))));
    if (!(end > start)) continue;
    const style = cleanSpanStyle(s.style);
    const href = typeof s.href === 'string' ? safeUrl(s.href) : undefined;
    if (!Object.keys(style).length && !href) continue;
    clean.push({ start, end, ...(Object.keys(style).length ? { style } : {}), ...(href ? { href } : {}) });
  }
  // Later spans win where they overlap, the same way a later edit would.
  return flatten(clean, length);
}

function flatten(spans: TextSpan[], length: number): TextSpan[] {
  const cuts = new Set<number>([0, length]);
  for (const s of spans) { cuts.add(s.start); cuts.add(s.end); }
  const points = [...cuts].sort((a, b) => a - b);
  const out: TextSpan[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    let style: Record<string, string> = {};
    let href: string | undefined;
    for (const s of spans) {
      if (s.start <= a && s.end >= b) {
        style = { ...style, ...s.style };
        if (s.href !== undefined) href = s.href;
      }
    }
    if (!Object.keys(style).length && !href) continue;
    const last = out.at(-1);
    const same = last && last.end === a && (last.href ?? '') === (href ?? '') && JSON.stringify(sorted(last.style)) === JSON.stringify(sorted(style));
    if (same) last.end = b;
    else out.push({ start: a, end: b, ...(Object.keys(style).length ? { style } : {}), ...(href ? { href } : {}) });
  }
  return out;
}

function sorted(style: Record<string, string> | undefined): [string, string][] {
  return Object.entries(style ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** The text cut at span edges, for anything that writes it out. */
export function textRuns(text: string, spans: unknown): TextRun[] {
  const list = normalizeSpans(spans, text.length);
  const out: TextRun[] = [];
  let at = 0;
  for (const s of list) {
    if (s.start > at) out.push({ text: text.slice(at, s.start), style: {} });
    out.push({ text: text.slice(s.start, s.end), style: s.style ?? {}, ...(s.href ? { href: s.href } : {}) });
    at = s.end;
  }
  if (at < text.length || !out.length) out.push({ text: text.slice(at), style: {} });
  return out;
}

const textHtml = (t: string) => escapeHtml(t).replace(/\n/g, '<br>');

/** Runs as inline markup. A plain run is bare text, so a text layer with no spans has no extra elements. */
export function runsToHtml(runs: TextRun[]): string {
  return runs.map((r) => {
    const css = styleToCss(r.style);
    const style = css ? ` style="${escapeAttr(css)}"` : '';
    if (r.href) return `<a href="${escapeAttr(r.href)}"${style}>${textHtml(r.text)}</a>`;
    return css ? `<span${style}>${textHtml(r.text)}</span>` : textHtml(r.text);
  }).join('');
}

/** Sets style properties on a range; a null value clears one. `href` null removes a link. */
export function applySpanStyle(spans: unknown, length: number, start: number, end: number, patch: Record<string, string | null>, href?: string | null): TextSpan[] {
  const list = normalizeSpans(spans, length);
  const a = Math.max(0, Math.min(start, end));
  const b = Math.min(length, Math.max(start, end));
  if (a >= b) return list;
  const out: TextSpan[] = [];
  let cursor = a;
  const applied = (base: TextSpan | null, from: number, to: number): TextSpan | null => {
    const style = { ...base?.style };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') delete style[k];
      else style[k] = v;
    }
    const nextHref = href === undefined ? base?.href : href ?? undefined;
    if (!Object.keys(style).length && !nextHref) return null;
    return { start: from, end: to, ...(Object.keys(style).length ? { style } : {}), ...(nextHref ? { href: nextHref } : {}) };
  };
  const push = (s: TextSpan | null) => { if (s && s.end > s.start) out.push(s); };
  for (const s of list) {
    if (s.end <= a || s.start >= b) { push(s); continue; }
    if (s.start < a) push({ ...s, end: a });
    const from = Math.max(s.start, a);
    const to = Math.min(s.end, b);
    if (from > cursor) push(applied(null, cursor, from));
    push(applied(s, from, to));
    cursor = to;
    if (s.end > b) push({ ...s, start: b });
  }
  if (cursor < b) push(applied(null, cursor, b));
  return normalizeSpans(out, length);
}

/** Whether every character of the range has this value. */
export function rangeHasStyle(spans: unknown, length: number, start: number, end: number, key: string, value: string): boolean {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  if (a >= b) return false;
  let cursor = a;
  for (const s of normalizeSpans(spans, length)) {
    if (s.end <= cursor) continue;
    if (s.start >= b) break;
    if (s.start > cursor || s.style?.[key] !== value) return false;
    cursor = s.end;
    if (cursor >= b) return true;
  }
  return cursor >= b;
}

/**
 * Carries spans across an edit of the text: only what changed between the common start and the common
 * end moves. Typing at the end of a span extends it, as it does in any editor.
 */
export function remapSpans(spans: unknown, before: string, after: string): TextSpan[] {
  const list = normalizeSpans(spans, before.length);
  if (before === after || !list.length) return list;
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const oldEnd = before.length - suffix;
  const delta = after.length - before.length;
  const map = (at: number, isEnd: boolean): number => {
    if (at < prefix || (at === prefix && !isEnd)) return at;
    if (at >= oldEnd && !(at === oldEnd && oldEnd === prefix && !isEnd)) return at + delta;
    return isEnd ? prefix + (after.length - before.length + (oldEnd - prefix)) : prefix;
  };
  const moved = list.map((s) => ({ ...s, start: map(s.start, false), end: map(s.end, true) }));
  return normalizeSpans(moved, after.length);
}
