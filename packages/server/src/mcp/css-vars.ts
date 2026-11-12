import type { TokenKind } from '@bogen/core';

export interface ParsedVar { name: string; value: string; kind: TokenKind | null }
export interface ParsedVars { tokens: ParsedVar[]; skipped: { selector: string; names: string[] }[] }

const NAMED_COLORS = new Set(['transparent', 'black', 'white', 'red', 'green', 'blue', 'gray', 'grey', 'orange', 'yellow', 'purple', 'pink', 'teal', 'navy', 'currentcolor']);
const COLOR_VALUE = /^(#[0-9a-f]{3,8}\b|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\()/i;
const HSL_TRIPLET = /^\d+(\.\d+)?(deg)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%(\s*\/\s*[\d.]+%?)?$/;
const LENGTH = /^-?[\d.]+(px|rem|em|vw|vh|%)$/;

export function inferKind(name: string, value: string): TokenKind | null {
  const n = name.toLowerCase();
  const v = value.trim().toLowerCase();
  if (COLOR_VALUE.test(v) || NAMED_COLORS.has(v) || HSL_TRIPLET.test(v)) return 'color';
  if (/radius|rounded/.test(n)) return 'radius';
  if (/font-?weight|(^|-)weight/.test(n)) return 'font-weight';
  if (/font-?size|text-size|^text-(xs|sm|md|base|lg|xl|\d+xl|display)/.test(n)) return 'font-size';
  if (/line-?height|leading/.test(n)) return 'line-height';
  if (/letter-?spacing|tracking/.test(n)) return 'letter-spacing';
  if (/font|family/.test(n)) return 'font-family';
  if (/breakpoint|^screen|^bp-/.test(n)) return 'breakpoint';
  if (/container|max-?w/.test(n)) return 'container';
  if (/space|spacing|gap|padding|margin|size/.test(n)) return 'spacing';
  if (/color|colour|(^|-)(bg|fg)(-|$)|background|foreground|border|accent|primary|secondary|muted|surface|ring|destructive/.test(n)) return 'color';
  if (/^(100|200|300|400|500|600|700|800|900)$/.test(v)) return 'font-weight';
  if (LENGTH.test(v)) return 'spacing';
  return null;
}

function declarations(body: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const m of body.matchAll(/(?:^|[;{\s])--([a-zA-Z_][\w-]*)\s*:\s*([^;{}]+?)\s*(?=;|}|$)/g)) out.push({ name: m[1]!, value: m[2]! });
  return out;
}

const THEME_SELECTOR = /^(:root|html|:host|body|@theme(\s+\w+)?)$/;

/** Reads custom properties from a stylesheet. Only theme-level blocks count unless `selector` asks for another. */
export function parseCssVars(css: string, selector?: string): ParsedVars {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Map<string, ParsedVar>();
  const skipped = new Map<string, string[]>();
  const add = (decls: { name: string; value: string }[]) => {
    for (const { name, value } of decls) {
      let final = value;
      if (HSL_TRIPLET.test(value.trim())) final = `hsl(${value.trim()})`;
      found.set(name, { name, value: final, kind: inferKind(name, value) });
    }
  };
  const walk = (text: string, prefix: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(text.lastIndexOf(';', open) < i ? i : text.lastIndexOf(';', open) + 1, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      const label = prefix ? `${prefix} ${prelude}` : prelude;
      if (/^@(media|supports|layer|container)\b/.test(prelude)) {
        // `@layer base { :root {...} }` still counts; `@media` variants are alternatives, not the theme.
        if (prelude.startsWith('@layer')) walk(body, prefix);
        else {
          const names = declarations(body).map((d) => d.name);
          if (names.length) skipped.set(label, names);
        }
      } else {
        const take = selector ? prelude === selector : prelude.split(',').some((s) => THEME_SELECTOR.test(s.trim()));
        const decls = declarations(body.replace(/\{[^}]*\}/g, ''));
        if (take) add(decls);
        else if (decls.length) skipped.set(label, decls.map((d) => d.name));
        if (body.includes('{')) walk(body, label);
      }
      i = j;
    }
  };
  if (clean.includes('{')) walk(clean, '');
  else add(declarations(clean));
  return { tokens: [...found.values()], skipped: [...skipped].map(([sel, names]) => ({ selector: sel, names })) };
}
