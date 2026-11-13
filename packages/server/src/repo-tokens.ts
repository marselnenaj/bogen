import { readFile } from 'node:fs/promises';
import { createMode, getModes, safeCssValue, setTokenMode, type BogenDoc, type Token, type TokenKind } from '@bogen/core';
import type { CodeProject, CodeProjects } from './code-projects.ts';
import { blankComments } from './code-scan.ts';
import { inferKind } from './mcp/css-vars.ts';
import { isRecord, LiteralReader, type JsValue } from './js-literal.ts';
import { designMdTokens, parseDesignMd, writeDesignMdTokens } from './design-md.ts';

/**
 * A repository's design tokens next to a file's, both ways. Read from CSS variables (`:root` and mode blocks such
 * as `.dark`), a Tailwind 4 `@theme` block, a Tailwind 3 config read as text, a DTCG `tokens.json`, or the YAML of a
 * `DESIGN.md`. Written back into CSS in place, keeping everything around the values, into DTCG, or into the YAML of a
 * DESIGN.md, keeping its prose. Nothing here runs the repository's code,
 * and nothing here writes into the repository itself: a push goes through `PullRequests`, in a folder of its own.
 */

export type RepoTokenFormat = 'css' | 'tailwind' | 'tailwind3' | 'dtcg' | 'design-md';
export interface RepoToken { name: string; kind: TokenKind; value: string; modes?: Record<string, string>; file: string; format: RepoTokenFormat; path?: string[] }
export interface RepoTokenSource { file: string; format: RepoTokenFormat; count: number; writable: boolean }
export interface RepoTokens { sources: RepoTokenSource[]; tokens: RepoToken[]; unclassified: { file: string; name: string; value: string }[] }

/** Tailwind's theme namespaces, and the prefixes a token name may already carry for one. */
export const TAILWIND: Record<TokenKind, { namespace: string; strip: RegExp; v3: string }> = {
  color: { namespace: 'color', strip: /^colou?r-/, v3: 'colors' },
  radius: { namespace: 'radius', strip: /^(radius|rounded)-/, v3: 'borderRadius' },
  spacing: { namespace: 'spacing', strip: /^(spacing|space)-/, v3: 'spacing' },
  container: { namespace: 'container', strip: /^container-/, v3: 'maxWidth' },
  breakpoint: { namespace: 'breakpoint', strip: /^(breakpoint|bp|screen)-/, v3: 'screens' },
  'font-family': { namespace: 'font', strip: /^(font-family|font)-/, v3: 'fontFamily' },
  'font-weight': { namespace: 'font-weight', strip: /^(font-weight|weight)-/, v3: 'fontWeight' },
  'font-size': { namespace: 'text', strip: /^(font-size|text)-/, v3: 'fontSize' },
  'line-height': { namespace: 'leading', strip: /^(line-height|leading)-/, v3: 'lineHeight' },
  'letter-spacing': { namespace: 'tracking', strip: /^(letter-spacing|tracking)-/, v3: 'letterSpacing' },
};
const KINDS = Object.keys(TAILWIND) as TokenKind[];
/** Longest first, so that `font-weight-` is not read as `font-`. */
const NAMESPACES = KINDS.map((kind) => ({ kind, prefix: TAILWIND[kind].namespace })).sort((a, b) => b.prefix.length - a.prefix.length);

export function tailwindKey(t: { name: string; kind: TokenKind }): string {
  return t.name.replace(TAILWIND[t.kind].strip, '') || t.name;
}

// ---------------------------------------------------------------- CSS

interface CssBlock { prelude: string; open: number; close: number }

/** Blocks of a style sheet with where their bodies are, `@layer` opened up. Positions are in the original text. */
export function cssBlocks(css: string): CssBlock[] {
  const text = blankComments(css);
  const out: CssBlock[] = [];
  const walk = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      const open = text.indexOf('{', i);
      if (open < 0 || open >= to) return;
      const semi = text.lastIndexOf(';', open);
      const close = text.lastIndexOf('}', open);
      const start = Math.max(i, semi + 1, close + 1);
      const prelude = text.slice(start, open).trim().replace(/\s+/g, ' ');
      let depth = 1;
      let j = open + 1;
      while (j < to && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      out.push({ prelude, open, close: j - 1 });
      if (prelude.startsWith('@layer')) walk(open + 1, j - 1);
      i = j;
    }
  };
  walk(0, text.length);
  return out;
}

const BASE = /^(:root|html|:host|body)$/;
const THEME = /^@theme(\s+(inline|static|reference|default))*$/;
const MODE = /^(?::root|html)?(?:\.(?:theme-)?([A-Za-z_][\w-]*)|\[data-(?:mode|theme)=["']?([A-Za-z_][\w-]*)["']?\])$/;
const HSL_TRIPLET = /^\d+(\.\d+)?(deg)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%(\s*\/\s*[\d.]+%?)?$/;

function declarations(css: string, block: CssBlock): { name: string; value: string; at: number; end: number }[] {
  const text = blankComments(css);
  const out: { name: string; value: string; at: number; end: number }[] = [];
  // Only the block's own declarations, not those of blocks inside it.
  let body = text.slice(block.open + 1, block.close);
  body = body.replace(/\{[^{}]*\}/g, (m) => ' '.repeat(m.length));
  for (const m of body.matchAll(/(^|[;{\s])--([a-zA-Z_][\w-]*)\s*:\s*([^;{}]+?)\s*(?=;|}|$)/g)) {
    const valueAt = block.open + 1 + m.index! + m[0].length - m[3]!.length;
    out.push({ name: m[2]!, value: css.slice(valueAt, valueAt + m[3]!.length).trim(), at: valueAt, end: valueAt + m[3]!.length });
  }
  return out;
}

function modeOf(prelude: string): string | null {
  const m = MODE.exec(prelude);
  const name = m?.[1] ?? m?.[2];
  return name && name !== 'root' ? name : null;
}

function cssValue(v: string): string {
  return HSL_TRIPLET.test(v.trim()) ? `hsl(${v.trim()})` : v.trim();
}

/** The namespace of a Tailwind theme variable, and the token name without it. */
function tailwindName(cssName: string): { kind: TokenKind; name: string } | null {
  if (cssName.includes('--')) return null;
  for (const { kind, prefix } of NAMESPACES) {
    if (cssName === prefix) return { kind, name: prefix };
    if (cssName.startsWith(`${prefix}-`)) return { kind, name: kind === 'color' ? cssName.slice(prefix.length + 1) : cssName };
  }
  return null;
}

export function readCssTokens(css: string, file: string): { tokens: RepoToken[]; unclassified: RepoTokens['unclassified']; theme: boolean } {
  const blocks = cssBlocks(css);
  const base = new Map<string, RepoToken>();
  const unclassified: RepoTokens['unclassified'] = [];
  let theme = false;
  // Plain variables first, so that a theme block that maps onto them is known as a mapping wherever it stands.
  const kindOf = (b: CssBlock) => (THEME.test(b.prelude) ? 1 : b.prelude.split(',').some((s) => BASE.test(s.trim())) ? 0 : -1);
  for (const block of blocks.filter((b) => kindOf(b) >= 0).sort((a, b) => kindOf(a) - kindOf(b))) {
    const isTheme = kindOf(block) === 1;
    for (const d of declarations(css, block)) {
      const value = cssValue(d.value);
      if (isTheme) {
        theme = true;
        // `--color-accent: var(--accent)` maps a utility onto a variable already read: no token of its own.
        const ref = /^var\(\s*--([\w-]+)\s*\)$/.exec(value)?.[1];
        if (ref && base.has(ref)) continue;
        const tw = tailwindName(d.name);
        if (!tw) {
          unclassified.push({ file, name: d.name, value });
          continue;
        }
        if (!base.has(tw.name)) base.set(tw.name, { name: tw.name, kind: tw.kind, value, file, format: 'tailwind' });
        continue;
      }
      const kind = inferKind(d.name, d.value);
      if (!kind) {
        unclassified.push({ file, name: d.name, value });
        continue;
      }
      base.set(d.name, { name: d.name, kind, value, file, format: 'css' });
    }
  }
  for (const block of blocks) {
    const mode = modeOf(block.prelude);
    if (!mode) continue;
    for (const d of declarations(css, block)) {
      const value = cssValue(d.value);
      const tw = tailwindName(d.name);
      const token = base.get(d.name) ?? (tw ? base.get(tw.name) : undefined);
      if (token) token.modes = { ...token.modes, [mode]: value };
      else {
        const kind = inferKind(d.name, d.value);
        if (kind) base.set(d.name, { name: d.name, kind, value, modes: { [mode]: value }, file, format: 'css' });
      }
    }
  }
  return { tokens: [...base.values()], unclassified, theme };
}

/** The variable a token has in a style sheet of this kind. */
function cssNameOf(t: { name: string; kind: TokenKind }, format: RepoTokenFormat): string {
  if (format !== 'tailwind') return t.name;
  if (t.name === TAILWIND[t.kind].namespace) return t.name;
  if (t.kind === 'color') return `color-${t.name.replace(TAILWIND.color.strip, '')}`;
  return `${TAILWIND[t.kind].namespace}-${tailwindKey(t)}`;
}

/**
 * Writes tokens into a style sheet: a value that is there changes where it is, a new one goes at the end of the
 * block it belongs in, and a mode's values go into that mode's block, made when it is missing. Nothing else moves.
 */
export function writeCssTokens(css: string, tokens: Token[], format: 'css' | 'tailwind'): string {
  const blocks = cssBlocks(css);
  const edits: { at: number; end: number; text: string }[] = [];
  const isTarget = (b: CssBlock) => (format === 'tailwind' ? THEME.test(b.prelude) && !/\binline\b/.test(b.prelude) : b.prelude.split(',').some((s) => BASE.test(s.trim())));
  const target = blocks.find(isTarget) ?? (format === 'tailwind' ? blocks.find((b) => THEME.test(b.prelude)) : undefined);
  const indentIn = (b: CssBlock | undefined) => (b ? /\n([ \t]+)--/.exec(css.slice(b.open, b.close))?.[1] : undefined) ?? '  ';
  const appended: string[] = [];
  const put = (block: CssBlock | undefined, selector: string, lines: { cssName: string; value: string }[]) => {
    if (!lines.length) return;
    const known = block ? declarations(css, block) : [];
    const fresh: string[] = [];
    for (const line of lines) {
      const found = known.find((d) => d.name === line.cssName);
      if (found) {
        if (found.value !== line.value) edits.push({ at: found.at, end: found.end, text: line.value });
      } else fresh.push(`${indentIn(block)}--${line.cssName}: ${line.value};`);
    }
    if (!fresh.length) return;
    if (block) {
      const before = css.slice(block.open + 1, block.close);
      const tail = before.match(/\s*$/)?.[0] ?? '';
      const at = block.close - tail.length;
      const needsSemi = /[^;{\s]\s*$/.test(css.slice(block.open + 1, at));
      edits.push({ at, end: at, text: `${needsSemi ? ';' : ''}\n${fresh.join('\n')}` });
    } else appended.push(`${selector} {\n${fresh.join('\n')}\n}`);
  };
  const usable = tokens.filter((t) => safeCssValue(t.value));
  put(target, format === 'tailwind' ? '@theme' : ':root', usable.map((t) => ({ cssName: cssNameOf(t, format), value: t.value })));
  const modes = [...new Set(usable.flatMap((t) => Object.keys(t.modes ?? {})))];
  const classStyle = blocks.some((b) => /^(?::root|html)?\.[\w-]+$/.test(b.prelude) && modeOf(b.prelude));
  for (const mode of modes) {
    const block = blocks.find((b) => modeOf(b.prelude) === mode);
    const lines = usable.filter((t) => t.modes?.[mode] !== undefined && safeCssValue(t.modes[mode]!)).map((t) => ({ cssName: cssNameOf(t, format), value: t.modes![mode]! }));
    put(block, classStyle ? `.${mode}` : `[data-mode="${mode}"]`, lines);
  }
  let out = css;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  if (appended.length) out = `${out.replace(/\s*$/, '')}${out.trim() ? '\n\n' : ''}${appended.join('\n\n')}\n`;
  return out;
}

// ---------------------------------------------------------------- Tailwind 3 config

const V3: Record<string, TokenKind> = Object.fromEntries(KINDS.map((k) => [TAILWIND[k].v3, k]));

/** The theme of a Tailwind 3 config, read as text. Values a config computes are left out. */
export function readTailwindConfig(src: string, file: string): RepoToken[] {
  const out = new Map<string, RepoToken>();
  const at = /\btheme\s*:\s*\{/.exec(src);
  if (!at) return [];
  const reader = new LiteralReader(src, at.index + at[0].length - 1);
  const theme = reader.value();
  if (!isRecord(theme)) return [];
  const sections = [theme, ...(isRecord(theme.extend) ? [theme.extend] : [])];
  const valueOf = (v: JsValue): string | null => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v) && v.length && typeof v[0] === 'string') return v.every((x) => typeof x === 'string') && v.length > 1 && !/\d/.test(v[0]) ? (v as string[]).map((f) => (/\s/.test(f) && !/^["']/.test(f) ? `"${f}"` : f)).join(', ') : v[0];
    return null;
  };
  for (const section of sections) {
    for (const [key, group] of Object.entries(section)) {
      const kind = V3[key];
      if (!kind || !isRecord(group)) continue;
      const visit = (obj: { [k: string]: JsValue }, prefix: string) => {
        for (const [k, v] of Object.entries(obj)) {
          const part = k === 'DEFAULT' ? '' : k;
          const name = [prefix, part].filter(Boolean).join('-').replace(/[^\w-]/g, '-');
          if (isRecord(v) && kind === 'color') {
            visit(v, name);
            continue;
          }
          const value = valueOf(v);
          if (!value || !name || !/^[a-zA-Z_]/.test(kind === 'color' ? name : `x${name}`)) continue;
          const full = kind === 'color' ? name : `${TAILWIND[kind].namespace}-${name}`;
          out.set(full, { name: full, kind, value, file, format: 'tailwind3' });
        }
      };
      visit(group, '');
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- DTCG

const DTCG_TYPE: Partial<Record<TokenKind, string>> = { color: 'color', 'font-family': 'fontFamily', 'font-weight': 'fontWeight' };
const EXT = 'dev.bogen';

function dtcgValue(v: unknown): string | null {
  if (typeof v === 'string') {
    const alias = /^\{([^{}]+)\}$/.exec(v.trim());
    return alias ? `var(--${alias[1]!.split('.').join('-')})` : v;
  }
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return (v as string[]).map((f) => (/[\s,]/.test(f) && !/^["']/.test(f) ? `"${f}"` : f)).join(', ');
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.value === 'number' && typeof o.unit === 'string') return `${o.value}${o.unit}`;
    if (typeof o.hex === 'string') return typeof o.alpha === 'number' && o.alpha < 1 ? `${o.hex}${Math.round(o.alpha * 255).toString(16).padStart(2, '0')}` : o.hex;
    if (typeof o.colorSpace === 'string' && Array.isArray(o.components)) return `color(${o.colorSpace} ${(o.components as unknown[]).join(' ')}${typeof o.alpha === 'number' && o.alpha < 1 ? ` / ${o.alpha}` : ''})`;
  }
  return null;
}

function kindFromDtcg(type: string | undefined, name: string, value: string, ext: Record<string, unknown> | undefined): TokenKind | null {
  if (typeof ext?.kind === 'string' && (KINDS as string[]).includes(ext.kind)) return ext.kind as TokenKind;
  if (type === 'color') return 'color';
  if (type === 'fontFamily') return 'font-family';
  if (type === 'fontWeight') return 'font-weight';
  if (type === 'dimension' || type === 'number') return inferKind(name, value) ?? (type === 'dimension' ? 'spacing' : null);
  if (type) return null;
  return inferKind(name, value);
}

/** Tokens of a DTCG file: groups joined with `-` make the name, `{a.b}` becomes `var(--a-b)`. */
export function readDtcg(json: unknown, file: string): { tokens: RepoToken[]; unclassified: RepoTokens['unclassified'] } {
  const tokens: RepoToken[] = [];
  const unclassified: RepoTokens['unclassified'] = [];
  const walk = (node: unknown, path: string[], type: string | undefined) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    const here = typeof obj.$type === 'string' ? obj.$type : type;
    if ('$value' in obj) {
      const name = path.join('-').replace(/[^\w-]/g, '-');
      const value = dtcgValue(obj.$value);
      const ext = (obj.$extensions as Record<string, unknown> | undefined)?.[EXT] as Record<string, unknown> | undefined;
      const kind = value === null ? null : kindFromDtcg(here, name, value, ext);
      if (!value || !kind || !/^[a-zA-Z_]/.test(name)) {
        unclassified.push({ file, name, value: value ?? JSON.stringify(obj.$value).slice(0, 80) });
        return;
      }
      const modes: Record<string, string> = {};
      if (ext?.modes && typeof ext.modes === 'object') for (const [m, mv] of Object.entries(ext.modes as Record<string, unknown>)) {
        const v = dtcgValue(mv);
        if (v && /^[a-zA-Z_][\w-]*$/.test(m)) modes[m] = v;
      }
      tokens.push({ name, kind, value, file, format: 'dtcg', path, ...(Object.keys(modes).length ? { modes } : {}) });
      return;
    }
    for (const [k, v] of Object.entries(obj)) if (!k.startsWith('$')) walk(v, [...path, k], here);
  };
  walk(json, [], undefined);
  return { tokens, unclassified };
}

function toDtcgValue(t: { kind: TokenKind; value: string }): unknown {
  const alias = /^var\(\s*--([\w-]+)\s*\)$/.exec(t.value.trim());
  if (alias) return `{${alias[1]}}`;
  const dim = /^(-?\d+(?:\.\d+)?)(px|rem)$/.exec(t.value.trim());
  if (dim && !DTCG_TYPE[t.kind]) return { value: Number(dim[1]), unit: dim[2] };
  if (t.kind === 'font-weight' && /^\d+$/.test(t.value.trim())) return Number(t.value);
  if (t.kind === 'font-family') {
    const parts = t.value.split(',').map((f) => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    return parts.length > 1 ? parts : parts[0] ?? t.value;
  }
  return t.value;
}

function dtcgType(t: { kind: TokenKind; value: string }): string | undefined {
  if (DTCG_TYPE[t.kind]) return DTCG_TYPE[t.kind];
  if (/^var\(/.test(t.value.trim())) return undefined;
  return /^-?\d+(?:\.\d+)?(px|rem)$/.test(t.value.trim()) ? 'dimension' : undefined;
}

/**
 * Tokens into DTCG. An existing file keeps its groups and everything else: a token it has changes where it is,
 * a new one is added at the top level under its own name. The kind and the mode values go into `$extensions`.
 */
export function writeDtcg(existing: string | null, tokens: Token[]): string {
  let doc: Record<string, unknown> = {};
  let indent = 2;
  if (existing?.trim()) {
    doc = JSON.parse(existing) as Record<string, unknown>;
    indent = /\n( +|\t)"/.exec(existing)?.[1]?.length ?? 2;
  }
  const known = new Map(readDtcg(doc, '').tokens.map((t) => [t.name, t.path!]));
  for (const t of tokens) {
    const path = known.get(t.name) ?? [t.name];
    let parent = doc;
    for (const key of path.slice(0, -1)) parent = (parent[key] ??= {}) as Record<string, unknown>;
    const last = path.at(-1)!;
    const entry = (parent[last] && typeof parent[last] === 'object' ? parent[last] : {}) as Record<string, unknown>;
    const type = dtcgType(t);
    const ext = { ...((entry.$extensions as Record<string, unknown> | undefined) ?? {}) };
    const ours: Record<string, unknown> = { kind: t.kind, ...(t.modes && Object.keys(t.modes).length ? { modes: Object.fromEntries(Object.entries(t.modes).map(([m, v]) => [m, toDtcgValue({ kind: t.kind, value: v })])) } : {}) };
    ext[EXT] = ours;
    parent[last] = { ...entry, ...(type && !entry.$type ? { $type: type } : {}), $value: toDtcgValue(t), $extensions: ext };
  }
  return `${JSON.stringify(doc, null, indent)}\n`;
}

// ---------------------------------------------------------------- the project

const DTCG_FILE = /(^|\/)(tokens|design-tokens|[\w.-]+\.tokens)\.json$|(^|\/)tokens\/[\w.-]+\.json$/i;
const TAILWIND3_FILE = /(^|\/)tailwind\.config\.(js|cjs|mjs|ts)$/;
export const DESIGN_MD = /(^|\/)DESIGN\.md$/i;
const ORDER: RepoTokenFormat[] = ['dtcg', 'tailwind', 'css', 'design-md', 'tailwind3'];

/** The tokens in the YAML of a DESIGN.md. */
export function readDesignMdTokens(text: string, file: string): RepoToken[] {
  return designMdTokens(parseDesignMd(text)).tokens.map((t) => ({ ...t, file, format: 'design-md' as const }));
}

/** Every token source in the project, and its tokens. A name found twice keeps the first, DTCG before CSS. */
export async function readRepoTokens(projects: CodeProjects, project: CodeProject): Promise<RepoTokens> {
  const files = (await projects.files(project)).filter((f) => f.size < 2 * 1024 * 1024);
  const sources: RepoTokenSource[] = [];
  const found: RepoToken[] = [];
  const unclassified: RepoTokens['unclassified'] = [];
  for (const f of files) {
    if (DTCG_FILE.test(f.rel)) {
      let json: unknown;
      try {
        json = JSON.parse(await readFile(f.abs, 'utf8'));
      } catch {
        continue;
      }
      const read = readDtcg(json, f.rel);
      if (!read.tokens.length && !read.unclassified.length) continue;
      sources.push({ file: f.rel, format: 'dtcg', count: read.tokens.length, writable: true });
      found.push(...read.tokens);
      unclassified.push(...read.unclassified);
    } else if (/\.css$/.test(f.rel) && f.size < 1024 * 1024) {
      const css = await readFile(f.abs, 'utf8').catch(() => '');
      if (!css.includes('--')) continue;
      const read = readCssTokens(css, f.rel);
      if (!read.tokens.length) continue;
      sources.push({ file: f.rel, format: read.tokens.some((t) => t.format === 'tailwind') ? 'tailwind' : 'css', count: read.tokens.length, writable: true });
      found.push(...read.tokens);
      unclassified.push(...read.unclassified);
    } else if (DESIGN_MD.test(f.rel) && f.size < 1024 * 1024) {
      const read = readDesignMdTokens(await readFile(f.abs, 'utf8').catch(() => ''), f.rel);
      if (!read.length) continue;
      sources.push({ file: f.rel, format: 'design-md', count: read.length, writable: true });
      found.push(...read);
    } else if (TAILWIND3_FILE.test(f.rel)) {
      const read = readTailwindConfig(await readFile(f.abs, 'utf8').catch(() => ''), f.rel);
      if (!read.length) continue;
      sources.push({ file: f.rel, format: 'tailwind3', count: read.length, writable: false });
      found.push(...read);
    }
  }
  sources.sort((a, b) => ORDER.indexOf(a.format) - ORDER.indexOf(b.format) || b.count - a.count);
  const rank = new Map(sources.map((s, i) => [s.file, i]));
  const byName = new Map<string, RepoToken>();
  for (const t of [...found].sort((a, b) => (rank.get(a.file) ?? 0) - (rank.get(b.file) ?? 0))) if (!byName.has(t.name)) byName.set(t.name, t);
  // A Tailwind 3 mapping onto a CSS variable read elsewhere is not a token of its own.
  for (const [name, t] of byName) {
    const ref = /^var\(\s*--([\w-]+)\s*\)$/.exec(t.value)?.[1];
    if (t.format === 'tailwind3' && ref && byName.has(ref) && ref !== name) byName.delete(name);
  }
  return { sources, tokens: [...byName.values()], unclassified };
}

// ---------------------------------------------------------------- the difference

export type TokenDiffStatus = 'same' | 'changed' | 'file' | 'repo';
export interface TokenDiffRow { name: string; kind: TokenKind; status: TokenDiffStatus; file?: string; repo?: string; source?: string; modes?: { mode: string; file?: string; repo?: string }[] }

function norm(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim().replace(/\s+/g, ' ');
  return /^#[0-9a-f]+$/i.test(t) ? t.toLowerCase() : t;
}

/** The file's tokens against the repository's, by name. */
export function diffTokens(fileTokens: Token[], repo: RepoToken[]): TokenDiffRow[] {
  const ours = new Map(fileTokens.map((t) => [t.name, t]));
  const theirs = new Map(repo.map((t) => [t.name, t]));
  const rows: TokenDiffRow[] = [];
  for (const name of [...new Set([...ours.keys(), ...theirs.keys()])].sort()) {
    const a = ours.get(name);
    const b = theirs.get(name);
    const modeNames = [...new Set([...Object.keys(a?.modes ?? {}), ...Object.keys(b?.modes ?? {})])].sort();
    const modes = modeNames.map((mode) => ({ mode, ...(a?.modes?.[mode] !== undefined ? { file: a.modes[mode] } : {}), ...(b?.modes?.[mode] !== undefined ? { repo: b.modes[mode] } : {}) }));
    const status: TokenDiffStatus = !a ? 'repo' : !b ? 'file' : norm(a.value) === norm(b.value) && modes.every((m) => norm(m.file) === norm(m.repo)) ? 'same' : 'changed';
    rows.push({ name, kind: (a?.kind ?? b?.kind)!, status, ...(a ? { file: a.value } : {}), ...(b ? { repo: b.value, source: b.file } : {}), ...(modes.length ? { modes } : {}) });
  }
  return rows;
}

/** Takes the repository's tokens into the file, as one transaction. Returns the names taken. */
export function pullTokens(doc: BogenDoc, repo: RepoToken[], names: string[] | undefined, origin: unknown): string[] {
  const picked = repo.filter((t) => !names || names.includes(t.name)).filter((t) => safeCssValue(t.value));
  if (!picked.length) return [];
  doc.transact(() => {
    for (const t of picked) {
      doc.setToken(t.name, t.kind, t.value);
      for (const [mode, value] of Object.entries(t.modes ?? {})) {
        if (!safeCssValue(value)) continue;
        if (!getModes(doc).some((m) => m.name === mode)) createMode(doc, mode);
        setTokenMode(doc, t.name, mode, value);
      }
    }
  }, origin);
  return picked.map((t) => t.name);
}

/** The new text of a token file, from what it holds now (null when it is new) and the file's tokens. */
export function writeTokenFile(format: RepoTokenFormat, existing: string | null, tokens: Token[]): string {
  if (format === 'dtcg') return writeDtcg(existing, tokens);
  if (format === 'css' || format === 'tailwind') return writeCssTokens(existing ?? '', tokens, format);
  if (format === 'design-md') return writeDesignMdTokens(existing, tokens);
  throw new Error('A Tailwind 3 config is code, and Bogen does not rewrite code. Push into a CSS file or a tokens.json instead.');
}
