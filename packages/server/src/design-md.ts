import {
  BRAND_BOOK_CHAPTERS, bindingBrand, contrastRatio, createMode, getModes, getTextStyles, normalizeColor, safeCssValue, setTextStyle, setTokenMode, upsertBrandItem, updateBrandBookChapter,
  readBrand, readBrandBook, markBrandFields, setBrandField,
  type BogenDoc, type BrandData, type TextStyle, type Token, type TokenKind,
} from '@bogen/core';
import { isMap, parseDocument, stringify, type Document } from 'yaml';
import { applyExtraction, type Extraction } from './brand-extract.ts';

/**
 * DESIGN.md: a design system as one Markdown file, YAML tokens up front and prose below, in the open format described
 * at github.com/google-labs-code/design.md (Apache-2.0). This is Bogen's own reading and writing of it, written from
 * the format's text: no code of the reference tools is used.
 *
 * What maps onto what:
 * - `colors` are colour tokens, `rounded` radius tokens and `spacing` spacing tokens, by name. `{colors.x}` is
 *   `var(--x)`.
 * - `typography` entries are text styles.
 * - Bogen's own extension key `x-bogen` carries what the format has no place for, so that an export reads back the
 *   same: theme mode values, and tokens of the other kinds (font families, sizes, breakpoints and the like). Other
 *   readers ignore it, as the format asks them to do with keys they do not know.
 * - The prose sections come from a brand's brandbook, fields, rules and words; read back into a brand, each becomes a
 *   suggestion or a draft chapter, never a binding value.
 */

export const DESIGN_MD_FILE = 'DESIGN.md';
const EXT = 'x-bogen';
const MAX_TEXT = 1024 * 1024;

export type DesignMdSectionId = 'overview' | 'colors' | 'typography' | 'layout' | 'elevation' | 'shapes' | 'components' | 'dos';
/** The format's sections in its order, with the other names it allows for each. */
export const DESIGN_MD_SECTIONS: { id: DesignMdSectionId; title: string; aliases: string[] }[] = [
  { id: 'overview', title: 'Overview', aliases: ['overview', 'brand & style', 'brand and style'] },
  { id: 'colors', title: 'Colors', aliases: ['colors', 'colours', 'color', 'colour'] },
  { id: 'typography', title: 'Typography', aliases: ['typography', 'type'] },
  { id: 'layout', title: 'Layout', aliases: ['layout', 'layout & spacing', 'layout and spacing', 'spacing'] },
  { id: 'elevation', title: 'Elevation & Depth', aliases: ['elevation & depth', 'elevation and depth', 'elevation', 'depth'] },
  { id: 'shapes', title: 'Shapes', aliases: ['shapes', 'shape'] },
  { id: 'components', title: 'Components', aliases: ['components'] },
  { id: 'dos', title: "Do's and Don'ts", aliases: ["do's and don'ts", "dos and don'ts", 'dos and donts', "do's and dont's", 'do and do not', "do's & don'ts"] },
];
const TOP_KEYS = ['version', 'name', 'description', 'omitted', 'colors', 'typography', 'rounded', 'spacing', 'components'];

export interface DesignMdTypography { fontFamily?: string; fontSize?: string; fontWeight?: number | string; lineHeight?: string | number; letterSpacing?: string; fontFeature?: string; fontVariation?: string }
export interface DesignMdExtension { version?: number; modes?: Record<string, Record<string, string>>; tokens?: Record<string, { kind: TokenKind; value: string }> }
export interface DesignMdSection { heading: string; id?: DesignMdSectionId; body: string }
export type DesignMdSeverity = 'error' | 'warning' | 'info';
export interface DesignMdFinding {
  rule: string;
  severity: DesignMdSeverity;
  message: string;
  path?: string;
  /** The brand_check rule that holds a design to this part once it is confirmed in a brand. */
  brand_check?: string;
}
export interface DesignMd {
  version?: string;
  name?: string;
  description?: string;
  colors: Record<string, string>;
  typography: Record<string, DesignMdTypography>;
  rounded: Record<string, string>;
  spacing: Record<string, string>;
  components: Record<string, Record<string, string>>;
  omitted: { section: string; reason?: string }[];
  extension?: DesignMdExtension;
  sections: DesignMdSection[];
  findings: DesignMdFinding[];
}

/** Which brand_check rule enforces each part of a DESIGN.md once it is in a brand and confirmed. */
export const DESIGN_MD_TO_BRAND_CHECK: { part: string; brand_check: string[]; how: string }[] = [
  { part: 'colors', brand_check: ['color.off-palette', 'color.contrast', 'tokens.missing', 'tokens.drift'], how: 'Brand colours: a colour off the palette is flagged, near ones snap to their token, and text is held to the brand\'s minimum contrast.' },
  { part: 'components (backgroundColor with textColor)', brand_check: ['color.contrast', 'color.forbidden-pair'], how: 'Each pair is a suggested allowed pair; its contrast is checked here at import.' },
  { part: 'typography', brand_check: ['type.off-brand-font', 'type.size-off-scale', 'type.weight-off-scale'], how: 'Font families, the type scale and its weights.' },
  { part: 'rounded', brand_check: ['layout.radius-off-scale'], how: 'Corner radii off the scale are flagged.' },
  { part: 'spacing', brand_check: ['layout.spacing-off-scale'], how: 'Gaps, padding and margins off the scale are flagged.' },
  { part: "Do's and Don'ts", brand_check: ['rule:<id>'], how: 'Each line is a suggested rule. Rules no machine can check go on brand_check\'s checklist.' },
  { part: 'Overview, Layout, Elevation, Shapes, Components prose', brand_check: [], how: 'Draft brandbook chapters for the person to confirm. Prose is guidance, not something brand_check measures.' },
];

const LINT_TO_BRAND: Record<string, string> = {
  'contrast-ratio': 'color.contrast', 'missing-primary': 'color.off-palette', 'invalid-color': 'color.off-palette', 'missing-typography': 'type.off-brand-font', 'invalid-dimension': 'layout.spacing-off-scale',
};

// ---------------------------------------------------------------- reading

const headingKey = (h: string) => h.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

function sectionIdOf(heading: string): DesignMdSectionId | undefined {
  const key = headingKey(heading);
  return DESIGN_MD_SECTIONS.find((s) => s.aliases.includes(key))?.id;
}

const scalar = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const DIMENSION = /^-?\d*\.?\d+(px|em|rem)$/;

/** Reads a DESIGN.md: its YAML, front matter and fenced blocks merged, and its sections. Problems are findings, never throws. */
export function parseDesignMd(input: string): DesignMd {
  const out: DesignMd = { colors: {}, typography: {}, rounded: {}, spacing: {}, components: {}, omitted: [], sections: [], findings: [] };
  if (input.length > MAX_TEXT) {
    out.findings.push({ rule: 'too-large', severity: 'error', message: `The file is ${Math.round(input.length / 1024)} KB; at most ${MAX_TEXT / 1024} KB is read.` });
    return out;
  }
  const text = input.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const lines = text.split('\n');
  const blocks: { yaml: string; where: string }[] = [];
  let start = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      blocks.push({ yaml: lines.slice(1, end).join('\n'), where: 'front matter' });
      start = end + 1;
    } else out.findings.push({ rule: 'front-matter', severity: 'error', message: 'The front matter opens with --- and never closes with a line of exactly ---.' });
  }
  // The body: YAML code blocks are tokens, other fences are prose, and ## headings start sections.
  let current: DesignMdSection | null = null;
  const prose: string[] = [];
  const flush = () => {
    if (current) {
      current.body = prose.join('\n').trim();
      out.sections.push(current);
    }
    prose.length = 0;
  };
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      const close = lines.findIndex((l, j) => j > i && l.trim().startsWith(fence[1]!) && l.trim().replace(/[`~]/g, '') === '');
      const end = close < 0 ? lines.length : close;
      if (/^ya?ml$/i.test(fence[2] ?? '')) blocks.push({ yaml: lines.slice(i + 1, end).join('\n'), where: current ? `the yaml block under "${current.heading}"` : 'a yaml block' });
      else prose.push(...lines.slice(i, end + 1));
      i = end;
      continue;
    }
    const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h2 && !line.startsWith('###')) {
      flush();
      const id = sectionIdOf(h2[1]!);
      current = { heading: h2[1]!, ...(id ? { id } : {}), body: '' };
      continue;
    }
    if (current) prose.push(line);
  }
  flush();

  const seenHeadings = new Map<string, number>();
  for (const s of out.sections) {
    const key = s.id ?? headingKey(s.heading);
    seenHeadings.set(key, (seenHeadings.get(key) ?? 0) + 1);
  }
  for (const [key, n] of seenHeadings) if (n > 1) out.findings.push({ rule: 'duplicate-section', severity: 'error', message: `The section "${DESIGN_MD_SECTIONS.find((s) => s.id === key)?.title ?? key}" appears ${n} times. The format allows each once.` });
  const order = out.sections.flatMap((s) => (s.id ? [DESIGN_MD_SECTIONS.findIndex((d) => d.id === s.id)] : []));
  if (order.some((v, i) => i > 0 && v < order[i - 1]!)) out.findings.push({ rule: 'section-order', severity: 'warning', message: `The sections are out of the format's order: ${DESIGN_MD_SECTIONS.map((s) => s.title).join(', ')}.` });

  // Every block's top-level keys go into one tree, each key once.
  const tree: Record<string, unknown> = {};
  const from = new Map<string, string>();
  for (const block of blocks) {
    const parsed = parseDocument(block.yaml, { uniqueKeys: true, prettyErrors: false });
    if (parsed.errors.length) {
      out.findings.push({ rule: 'yaml', severity: 'error', message: `The YAML in ${block.where} does not parse: ${parsed.errors[0]!.message.split('\n')[0]}` });
      continue;
    }
    const value = parsed.toJS({ maxAliasCount: 50 }) as unknown;
    if (value === null || value === undefined) continue;
    if (typeof value !== 'object' || Array.isArray(value)) {
      out.findings.push({ rule: 'yaml', severity: 'error', message: `The YAML in ${block.where} is not a map of keys.` });
      continue;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k in tree) {
        out.findings.push({ rule: 'duplicate-key', severity: 'error', message: `The key ${k} is in ${from.get(k)} and again in ${block.where}. Each top-level key may be defined once.`, path: k });
        continue;
      }
      tree[k] = v;
      from.set(k, block.where);
    }
  }

  for (const k of Object.keys(tree)) {
    if (TOP_KEYS.includes(k) || k === EXT || k.startsWith('x-')) continue;
    const near = TOP_KEYS.find((t) => editDistance(t, k.toLowerCase()) <= 2);
    if (near) out.findings.push({ rule: 'unknown-key', severity: 'warning', message: `${k} looks like ${near}, and is not read as it.`, path: k });
  }
  out.version = scalar(tree.version);
  out.name = scalar(tree.name);
  out.description = scalar(tree.description);
  if (Array.isArray(tree.omitted)) {
    for (const o of tree.omitted) {
      if (typeof o === 'string') out.omitted.push({ section: o });
      else if (o && typeof o === 'object' && typeof (o as { section?: unknown }).section === 'string') out.omitted.push({ section: (o as { section: string }).section, ...(typeof (o as { reason?: unknown }).reason === 'string' ? { reason: (o as { reason: string }).reason } : {}) });
    }
  }
  for (const [k, v] of Object.entries(record(tree.colors))) {
    const value = scalar(v);
    if (value === undefined) out.findings.push({ rule: 'invalid-color', severity: 'warning', message: `colors.${k} is not a single colour value.`, path: `colors.${k}`, brand_check: 'color.off-palette' });
    else out.colors[k] = value;
  }
  for (const [k, v] of Object.entries(record(tree.typography))) {
    const t = record(v);
    const entry: DesignMdTypography = {};
    for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'fontFeature', 'fontVariation'] as const) {
      const s = scalar(t[prop]);
      if (s !== undefined) (entry as Record<string, string>)[prop] = s;
    }
    out.typography[k] = entry;
  }
  for (const [k, v] of Object.entries(record(tree.rounded))) {
    const s = scalar(v);
    if (s !== undefined) out.rounded[k] = s;
  }
  for (const [k, v] of Object.entries(record(tree.spacing))) {
    const s = scalar(v);
    if (s !== undefined) out.spacing[k] = s;
  }
  for (const [k, v] of Object.entries(record(tree.components))) {
    const props: Record<string, string> = {};
    for (const [p, pv] of Object.entries(record(v))) {
      const s = scalar(pv);
      if (s !== undefined) props[p] = s;
    }
    out.components[k] = props;
  }
  const ext = record(tree[EXT]);
  if (Object.keys(ext).length) {
    const modes: Record<string, Record<string, string>> = {};
    for (const [mode, values] of Object.entries(record(ext.modes))) {
      modes[mode] = {};
      for (const [name, v] of Object.entries(record(values))) {
        const s = scalar(v);
        if (s !== undefined) modes[mode]![name] = s;
      }
    }
    const tokens: Record<string, { kind: TokenKind; value: string }> = {};
    for (const [name, v] of Object.entries(record(ext.tokens))) {
      const t = record(v);
      const value = scalar(t.value);
      if (typeof t.kind === 'string' && KINDS.has(t.kind as TokenKind) && value !== undefined) tokens[name] = { kind: t.kind as TokenKind, value };
    }
    out.extension = { ...(typeof ext.version === 'number' ? { version: ext.version } : {}), ...(Object.keys(modes).length ? { modes } : {}), ...(Object.keys(tokens).length ? { tokens } : {}) };
  }
  lint(out, tree);
  return out;
}

const KINDS = new Set<TokenKind>(['color', 'radius', 'spacing', 'container', 'breakpoint', 'font-family', 'font-weight', 'font-size', 'line-height', 'letter-spacing']);

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

const REF = /^\{([^{}]+)\}$/;

/** A `{group.name}` reference followed to its value, or undefined when it leads nowhere. */
export function resolveDesignRef(md: DesignMd, value: string, depth = 0): string | undefined {
  const m = REF.exec(value.trim());
  if (!m) return value;
  if (depth > 8) return undefined;
  const [group, ...rest] = m[1]!.split('.');
  const name = rest.join('.');
  const table: Record<string, unknown> | undefined = group === 'colors' ? md.colors : group === 'rounded' ? md.rounded : group === 'spacing' ? md.spacing : group === 'typography' ? md.typography : group === 'components' ? md.components : undefined;
  const hit = table?.[name];
  if (hit === undefined) return undefined;
  return typeof hit === 'string' ? resolveDesignRef(md, hit, depth + 1) : JSON.stringify(hit);
}

function lint(md: DesignMd, tree: Record<string, unknown>): void {
  const add = (f: DesignMdFinding) => md.findings.push(LINT_TO_BRAND[f.rule] && !f.brand_check ? { ...f, brand_check: LINT_TO_BRAND[f.rule] } : f);
  const omitted = new Set(md.omitted.map((o) => o.section));
  const refs = new Set<string>();
  const visitRef = (value: string, path: string) => {
    const m = REF.exec(value.trim());
    if (!m) return;
    refs.add(m[1]!);
    if (resolveDesignRef(md, value) === undefined) add({ rule: 'broken-ref', severity: 'error', message: `${path} refers to ${value}, which is not defined.`, path });
  };
  for (const [k, v] of Object.entries(md.colors)) {
    if (REF.test(v)) visitRef(v, `colors.${k}`);
    else if (!normalizeColor(v)) add({ rule: 'invalid-color', severity: 'warning', message: `colors.${k} is "${v}", which is not a CSS colour.`, path: `colors.${k}` });
  }
  for (const [group, table] of [['rounded', md.rounded], ['spacing', md.spacing]] as const) {
    for (const [k, v] of Object.entries(table)) {
      if (REF.test(v)) visitRef(v, `${group}.${k}`);
      else if (group === 'rounded' && !DIMENSION.test(v) && v !== '0') add({ rule: 'invalid-dimension', severity: 'warning', message: `rounded.${k} is "${v}". The format expects a length in px, em or rem.`, path: `rounded.${k}`, brand_check: 'layout.radius-off-scale' });
    }
  }
  for (const [k, t] of Object.entries(md.typography)) {
    for (const [p, v] of Object.entries(t)) if (typeof v === 'string') visitRef(v, `typography.${k}.${p}`);
    if (t.fontSize && !REF.test(t.fontSize) && !DIMENSION.test(t.fontSize)) add({ rule: 'invalid-dimension', severity: 'warning', message: `typography.${k}.fontSize is "${t.fontSize}". The format expects a length in px, em or rem.`, path: `typography.${k}.fontSize`, brand_check: 'type.size-off-scale' });
  }
  for (const [c, props] of Object.entries(md.components)) {
    for (const [p, v] of Object.entries(props)) visitRef(v, `components.${c}.${p}`);
    const bg = props.backgroundColor && resolveDesignRef(md, props.backgroundColor);
    const fg = props.textColor && resolveDesignRef(md, props.textColor);
    const nb = bg && normalizeColor(bg);
    const nf = fg && normalizeColor(fg);
    if (nb && nf) {
      const ratio = contrastRatio(nf, nb);
      if (ratio < 4.5) add({ rule: 'contrast-ratio', severity: 'warning', message: `components.${c}: textColor ${fg} on backgroundColor ${bg} has a contrast of ${ratio}:1, under 4.5:1 (WCAG AA).`, path: `components.${c}` });
    }
  }
  const colorNames = Object.keys(md.colors);
  if (colorNames.length && !('primary' in md.colors) && !omitted.has('colors')) add({ rule: 'missing-primary', severity: 'warning', message: 'There are colours but no primary colour.', path: 'colors' });
  if (colorNames.length && !Object.keys(md.typography).length && !omitted.has('typography')) add({ rule: 'missing-typography', severity: 'warning', message: 'There are colours but no typography.', path: 'typography' });
  if (Object.keys(md.components).length) {
    const orphans = colorNames.filter((n) => !refs.has(`colors.${n}`));
    if (orphans.length) add({ rule: 'orphaned-tokens', severity: 'warning', message: `${orphans.length} colour${orphans.length === 1 ? ' is' : 's are'} not used by any component: ${orphans.slice(0, 12).join(', ')}${orphans.length > 12 ? ', ...' : ''}.`, path: 'colors' });
  }
  for (const section of ['spacing', 'rounded'] as const) {
    if (!Object.keys(md[section]).length && colorNames.length && !omitted.has(section)) add({ rule: 'missing-sections', severity: 'info', message: `There is no ${section} scale.`, path: section });
  }
  for (const o of md.omitted) if (!TOP_KEYS.includes(o.section) && !DESIGN_MD_SECTIONS.some((s) => s.id === o.section || s.aliases.includes(headingKey(o.section)))) add({ rule: 'omitted-rules', severity: 'info', message: `omitted names "${o.section}", which is not a section.` });
  for (const o of md.omitted) if (o.section in tree && Object.keys(record(tree[o.section])).length) add({ rule: 'omitted-rules', severity: 'info', message: `${o.section} is omitted and defined too.` });
  add({ rule: 'token-summary', severity: 'info', message: `${colorNames.length} colours, ${Object.keys(md.typography).length} typography levels, ${Object.keys(md.rounded).length} radii, ${Object.keys(md.spacing).length} spacing steps, ${Object.keys(md.components).length} components.` });
}

// ---------------------------------------------------------------- tokens

const tokenName = (name: string) => {
  const clean = name.trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-zA-Z_]/.test(clean) ? clean : clean ? `t-${clean}` : '';
};

/** `{colors.x}` as `var(--x)`; anything else as it is. */
function toCss(value: string): string {
  const m = REF.exec(value.trim());
  if (!m) return value;
  const name = m[1]!.split('.').slice(1).join('-');
  return `var(--${tokenName(name)})`;
}

/** The tokens a DESIGN.md describes, with theme mode values from Bogen's extension. */
export function designMdTokens(md: DesignMd): { tokens: Token[]; skipped: string[] } {
  const out = new Map<string, Token>();
  const skipped: string[] = [];
  const put = (name: string, kind: TokenKind, raw: string, path: string) => {
    const n = tokenName(name);
    const value = toCss(raw);
    if (!n || !safeCssValue(value) || !value.trim()) {
      skipped.push(path);
      return;
    }
    out.set(n, { name: n, kind, value });
  };
  for (const [k, v] of Object.entries(md.colors)) put(k, 'color', v, `colors.${k}`);
  for (const [k, v] of Object.entries(md.rounded)) put(k, 'radius', v, `rounded.${k}`);
  for (const [k, v] of Object.entries(md.spacing)) put(k, 'spacing', v, `spacing.${k}`);
  for (const [k, t] of Object.entries(md.extension?.tokens ?? {})) put(k, t.kind, t.value, `${EXT}.tokens.${k}`);
  for (const [mode, values] of Object.entries(md.extension?.modes ?? {})) {
    if (!/^[a-zA-Z_][\w-]*$/.test(mode)) continue;
    for (const [k, v] of Object.entries(values)) {
      const token = out.get(tokenName(k));
      const value = toCss(v);
      if (token && safeCssValue(value)) token.modes = { ...token.modes, [mode]: value };
    }
  }
  return { tokens: [...out.values()], skipped };
}

/** Typography levels as text styles, with names kept. */
export function designMdTextStyles(md: DesignMd): { name: string; style: Record<string, string> }[] {
  return Object.entries(md.typography).map(([name, t]) => {
    const style: Record<string, string> = {};
    const v = (s: string | number | undefined) => (s === undefined ? undefined : toCss(String(s)));
    if (t.fontFamily) style.fontFamily = cssFamily(v(t.fontFamily)!);
    if (t.fontSize) style.fontSize = v(t.fontSize)!;
    if (t.fontWeight !== undefined) style.fontWeight = v(t.fontWeight)!;
    if (t.lineHeight !== undefined) style.lineHeight = v(t.lineHeight)!;
    if (t.letterSpacing) style.letterSpacing = v(t.letterSpacing)!;
    if (t.fontFeature) style.fontFeatureSettings = v(t.fontFeature)!;
    if (t.fontVariation) style.fontVariationSettings = v(t.fontVariation)!;
    return { name, style: Object.fromEntries(Object.entries(style).filter(([, val]) => safeCssValue(val))) };
  });
}

/** A family name as CSS: quoted when it has a space and no stack of its own. */
function cssFamily(family: string): string {
  if (/^var\(/.test(family) || family.includes(',') || /^["']/.test(family)) return family;
  return /\s/.test(family) ? `"${family}"` : family;
}

/** Puts the tokens and text styles of a DESIGN.md into a file. The caller wraps it in one undoable transaction. */
export function importDesignMdTokens(doc: BogenDoc, md: DesignMd, options: { textStyles?: boolean } = {}): { tokens: string[]; modes: string[]; text_styles: string[]; skipped: string[] } {
  const { tokens, skipped } = designMdTokens(md);
  const modes = new Set<string>();
  for (const t of tokens) {
    doc.setToken(t.name, t.kind, t.value);
    for (const [mode, value] of Object.entries(t.modes ?? {})) {
      if (!getModes(doc).some((m) => m.name === mode)) createMode(doc, mode);
      setTokenMode(doc, t.name, mode, value);
      modes.add(mode);
    }
  }
  const styles: string[] = [];
  if (options.textStyles !== false) {
    for (const s of designMdTextStyles(md)) {
      if (!Object.keys(s.style).length) continue;
      try {
        styles.push(setTextStyle(doc, s.name, s.style));
      } catch {
        skipped.push(`typography.${s.name}`);
      }
    }
  }
  return { tokens: tokens.map((t) => t.name), modes: [...modes], text_styles: styles, skipped };
}

// ---------------------------------------------------------------- writing

export interface DesignMdInput {
  name: string;
  description?: string;
  tokens: Token[];
  textStyles?: TextStyle[];
  components?: Record<string, Record<string, string>>;
  sections?: DesignMdSection[];
}

/** A token value as the format writes it: `var(--x)` of a token in the same group as `{group.x}`, else as it is. */
function fromCss(value: string, groups: Map<string, string>, tokens: Map<string, Token>, depth = 0): string {
  const m = /^var\(\s*--([\w-]+)\s*\)$/.exec(value.trim());
  if (!m) return value;
  const group = groups.get(m[1]!);
  if (group) return `{${group}.${m[1]}}`;
  const t = tokens.get(m[1]!);
  return t && depth < 8 ? fromCss(t.value, groups, tokens, depth + 1) : value;
}

/** Resolves var(--x) inside a text style value to the token's value, for a reader without the tokens. */
function resolveVars(value: string, tokens: Map<string, Token>, depth = 0): string {
  if (depth > 8) return value;
  return value.replace(/var\(\s*--([\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name: string, fallback?: string) => {
    const t = tokens.get(name);
    return t ? resolveVars(t.value, tokens, depth + 1) : fallback?.trim() || whole;
  });
}

const GROUP_OF: Partial<Record<TokenKind, 'colors' | 'rounded' | 'spacing'>> = { color: 'colors', radius: 'rounded', spacing: 'spacing' };

/** Writes a DESIGN.md: front matter with the tokens, then the prose sections in the format's order. */
export function writeDesignMd(input: DesignMdInput): string {
  const byName = new Map(input.tokens.map((t) => [t.name, t]));
  const groups = new Map(input.tokens.flatMap((t) => (GROUP_OF[t.kind] ? [[t.name, GROUP_OF[t.kind]!] as [string, string]] : [])));
  const front: Record<string, unknown> = { version: 'alpha', name: input.name };
  if (input.description) front.description = input.description;
  const colors: Record<string, string> = {};
  const rounded: Record<string, string> = {};
  const spacing: Record<string, string> = {};
  const other: Record<string, { kind: TokenKind; value: string }> = {};
  const modes: Record<string, Record<string, string>> = {};
  for (const t of input.tokens) {
    const group = GROUP_OF[t.kind];
    const value = fromCss(t.value, groups, byName);
    if (group === 'colors') colors[t.name] = value;
    else if (group === 'rounded') rounded[t.name] = value;
    else if (group === 'spacing') spacing[t.name] = value;
    else other[t.name] = { kind: t.kind, value: t.value };
    for (const [mode, v] of Object.entries(t.modes ?? {})) (modes[mode] ??= {})[t.name] = group ? fromCss(v, groups, byName) : v;
  }
  if (Object.keys(colors).length) front.colors = colors;
  const typography: Record<string, Record<string, string | number>> = {};
  for (const s of input.textStyles ?? []) {
    const st = Object.fromEntries(Object.entries(s.style).map(([k, v]) => [k, resolveVars(v, byName)]));
    const entry: Record<string, string | number> = {};
    if (st.fontFamily) entry.fontFamily = st.fontFamily.split(',').length > 1 ? st.fontFamily : st.fontFamily.replace(/^["']|["']$/g, '');
    if (st.fontSize) entry.fontSize = st.fontSize;
    if (st.fontWeight) entry.fontWeight = /^\d+$/.test(st.fontWeight) ? Number(st.fontWeight) : st.fontWeight;
    if (st.lineHeight) entry.lineHeight = /^\d*\.?\d+$/.test(st.lineHeight) ? Number(st.lineHeight) : st.lineHeight;
    if (st.letterSpacing) entry.letterSpacing = st.letterSpacing;
    if (st.fontFeatureSettings) entry.fontFeature = st.fontFeatureSettings;
    if (st.fontVariationSettings) entry.fontVariation = st.fontVariationSettings;
    if (Object.keys(entry).length) typography[s.key] = entry;
  }
  if (Object.keys(typography).length) front.typography = typography;
  if (Object.keys(rounded).length) front.rounded = rounded;
  if (Object.keys(spacing).length) front.spacing = spacing;
  if (input.components && Object.keys(input.components).length) front.components = input.components;
  if (Object.keys(other).length || Object.keys(modes).length) front[EXT] = { version: 1, ...(Object.keys(modes).length ? { modes } : {}), ...(Object.keys(other).length ? { tokens: other } : {}) };
  const yaml = stringify(front, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' }).trimEnd();
  const sections = [...(input.sections ?? [])].sort((a, b) => sectionRank(a) - sectionRank(b)).filter((s) => s.body.trim());
  const body = sections.map((s) => `## ${s.heading}\n\n${s.body.trim()}`).join('\n\n');
  return `---\n${yaml}\n---\n\n# ${input.name}\n${body ? `\n${body}\n` : ''}`;
}

function sectionRank(s: DesignMdSection): number {
  const i = s.id ? DESIGN_MD_SECTIONS.findIndex((d) => d.id === s.id) : -1;
  return i < 0 ? DESIGN_MD_SECTIONS.length : i;
}

/**
 * Writes tokens into the YAML of a DESIGN.md that exists, keeping its prose, comments and every other key: a token goes
 * into the block that already holds its group (front matter or a fenced yaml block), else into the front matter. A new
 * file is made when there is none.
 */
export function writeDesignMdTokens(existing: string | null, tokens: Token[], name = 'Design'): string {
  if (!existing?.trim()) return writeDesignMd({ name, tokens });
  const text = existing.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  interface Block { from: number; to: number; doc: Document; front: boolean; changed: boolean }
  const blocks: Block[] = [];
  let i = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      blocks.push({ from: 1, to: end, doc: parseDocument(lines.slice(1, end).join('\n')), front: true, changed: false });
      i = end + 1;
    }
  }
  for (; i < lines.length; i++) {
    const fence = /^(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(lines[i]!);
    if (!fence) continue;
    const close = lines.findIndex((l, j) => j > i && l.trim().startsWith(fence[1]!) && l.trim().replace(/[`~]/g, '') === '');
    const end = close < 0 ? lines.length : close;
    if (/^ya?ml$/i.test(fence[2] ?? '')) blocks.push({ from: i + 1, to: end, doc: parseDocument(lines.slice(i + 1, end).join('\n')), front: false, changed: false });
    i = end;
  }
  if (blocks.some((b) => b.doc.errors.length)) throw new Error('The YAML in this DESIGN.md does not parse, so Bogen leaves it alone. Fix it first.');
  let front = blocks.find((b) => b.front);
  const holder = (key: string): Block => {
    const found = blocks.find((b) => isMap(b.doc.contents) && b.doc.has(key));
    if (found) return found;
    if (!front) {
      front = { from: -1, to: -1, doc: parseDocument('version: alpha'), front: true, changed: true };
      blocks.unshift(front);
    }
    return front;
  };
  const byName = new Map(tokens.map((t) => [t.name, t]));
  const groups = new Map(tokens.flatMap((t) => (GROUP_OF[t.kind] ? [[t.name, GROUP_OF[t.kind]!] as [string, string]] : [])));
  for (const t of tokens) {
    const group = GROUP_OF[t.kind];
    const value = group ? fromCss(t.value, groups, byName) : t.value;
    const b = group ? holder(group) : holder(EXT);
    if (group) b.doc.setIn([group, t.name], value);
    else b.doc.setIn([EXT, 'tokens', t.name], { kind: t.kind, value });
    b.changed = true;
    for (const [mode, v] of Object.entries(t.modes ?? {})) {
      const mb = holder(EXT);
      mb.doc.setIn([EXT, 'modes', mode, t.name], group ? fromCss(v, groups, byName) : v);
      mb.changed = true;
    }
  }
  const out = [...lines];
  // From the end, so that earlier positions stay right.
  for (const b of [...blocks].filter((x) => x.from >= 0).sort((a, z) => z.from - a.from)) {
    if (!b.changed) continue;
    out.splice(b.from, b.to - b.from, ...b.doc.toString({ lineWidth: 0 }).replace(/\n$/, '').split('\n'));
  }
  const added = blocks.find((b) => b.from < 0);
  if (added) out.unshift('---', ...added.doc.toString({ lineWidth: 0 }).replace(/\n$/, '').split('\n'), '---', '');
  return out.join('\n');
}

const title = (id: DesignMdSectionId) => DESIGN_MD_SECTIONS.find((s) => s.id === id)!.title;

/** The prose a file's tokens can say for themselves, for a file with no brand. */
export function tokenProse(tokens: Token[], textStyles: TextStyle[]): DesignMdSection[] {
  const list = (kind: TokenKind) => tokens.filter((t) => t.kind === kind);
  const sections: DesignMdSection[] = [];
  const colors = list('color');
  if (colors.length) sections.push({ id: 'colors', heading: title('colors'), body: colors.map((t) => `- **${t.name}** (${t.value})${t.modes && Object.keys(t.modes).length ? `, ${Object.entries(t.modes).map(([m, v]) => `${v} in ${m}`).join(', ')}` : ''}`).join('\n') });
  if (textStyles.length) sections.push({ id: 'typography', heading: title('typography'), body: textStyles.map((s) => `- **${s.name}**: ${[s.style.fontFamily, s.style.fontSize, s.style.fontWeight].filter(Boolean).join(', ')}`).join('\n') });
  const space = list('spacing');
  if (space.length) sections.push({ id: 'layout', heading: title('layout'), body: `Spacing steps: ${space.map((t) => `${t.name} ${t.value}`).join(', ')}.` });
  const radius = list('radius');
  if (radius.length) sections.push({ id: 'shapes', heading: title('shapes'), body: `Corner radii: ${radius.map((t) => `${t.name} ${t.value}`).join(', ')}.` });
  return sections;
}

/** What binds of a brand: its fields as they bind, and no item that is still a suggestion. */
function bound(raw: BrandData): BrandData {
  const data = bindingBrand(raw);
  const keep = <T extends { suggested?: boolean }>(items: T[]) => items.filter((i) => !i.suggested);
  return { ...data, colors: keep(data.colors), pairings: keep(data.pairings), logos: keep(data.logos), families: keep(data.families), typeScale: keep(data.typeScale), spacing: keep(data.spacing), radius: keep(data.radius), rules: keep(data.rules), words: keep(data.words), voiceExamples: keep(data.voiceExamples), artboards: keep(data.artboards), assets: keep(data.assets) };
}

const CHAPTERS_FOR: Partial<Record<DesignMdSectionId, string[]>> = {
  overview: ['strategy', 'audience', 'principles'], colors: ['color'], typography: ['type'], layout: ['layout'], components: ['applications'],
};

/** The prose of a brand, from what binds: fields, confirmed and draft chapters, colours, families, rules and words. */
export function brandProse(raw: BrandData): DesignMdSection[] {
  const data = bound(raw);
  const f = data.fields;
  const chapter = (id: string) => {
    const c = data.book?.chapters.find((ch) => ch.id === id);
    if (!c?.markdown.trim() || c.status === 'not-applicable') return '';
    // Headings inside a chapter would start sections of their own.
    const text = c.markdown.trim().replace(/^(#{1,2})\s/gm, '### ');
    return c.status === 'draft' ? `${text}\n\n_Draft, not confirmed yet._` : text;
  };
  const chapters = (id: DesignMdSectionId) => (CHAPTERS_FOR[id] ?? []).map(chapter).filter(Boolean);
  const out: DesignMdSection[] = [];
  const push = (id: DesignMdSectionId, parts: (string | false | undefined)[]) => {
    const body = parts.filter(Boolean).join('\n\n').trim();
    if (body) out.push({ id, heading: title(id), body });
  };
  push('overview', [f.positioning, f.audience && `Audience: ${f.audience}`, f.tone && `Tone: ${f.tone}`, ...chapters('overview')]);
  push('colors', [data.colors.length > 0 && data.colors.map((c) => `- **${c.name}** (${c.value})${c.role ? `: ${c.role}` : ''}${c.token ? `, token \`${c.token}\`` : ''}${c.modes && Object.keys(c.modes).length ? `; ${Object.entries(c.modes).map(([m, v]) => `${v} in ${m}`).join(', ')}` : ''}`).join('\n'),
    data.pairings.length > 0 && `Pairs: ${data.pairings.map((p) => `${p.fg} on ${p.bg} ${p.verdict === 'allow' ? 'allowed' : 'not allowed'}`).join('; ')}.`,
    f.minContrast ? `Text keeps a contrast of at least ${f.minContrast}:1.` : '', ...chapters('colors')]);
  push('typography', [data.families.length > 0 && data.families.map((fam) => `- **${fam.family}**${fam.role ? ` for ${fam.role}` : ''}${fam.weights.length ? `, weights ${fam.weights.join(', ')}` : ''}${fam.fallback ? `, falls back to ${fam.fallback}` : ''}`).join('\n'), ...chapters('typography')]);
  push('layout', [f.layoutNotes, f.grid && `Grid: ${f.grid}.`, f.container ? `Content is at most ${f.container}px wide.` : '', data.spacing.length > 0 && `Spacing scale: ${data.spacing.map((s) => `${s.value}px`).join(', ')}.`, ...chapters('layout')]);
  push('elevation', [f.shadows === 'none' ? 'Flat: no shadows. Hierarchy comes from colour, space and type.' : '', f.gradients === 'none' ? 'No gradients.' : '']);
  push('shapes', [data.radius.length > 0 && `Corner radii: ${data.radius.map((r) => `${r.value}px${r.name && r.name !== String(r.value) ? ` (${r.name})` : ''}`).join(', ')}.`]);
  push('components', chapters('components'));
  const rules = data.rules.map((r) => `- ${r.kind === 'do' ? 'Do' : "Don't"}${/^(do|don't|dont|never|always)\b/i.test(r.text) ? ':' : ''} ${r.text.replace(/^(do|don't|dont)\s*:?\s*/i, '')}`);
  const words = data.words.map((w) => (w.use === 'use' ? `- Do write "${w.word}"` : `- Don't write "${w.word}"${w.instead ? `; write "${w.instead}"` : ''}`));
  push('dos', [[...rules, ...words].join('\n')]);
  return out;
}

/** A brand's own tokens, from what binds: colours with their mode values, radii, spacing, and its type scale as text styles. */
export function brandTokens(raw: BrandData): { tokens: Token[]; textStyles: TextStyle[] } {
  const data = bound(raw);
  const tokens: Token[] = [];
  const seen = new Set<string>();
  const add = (t: Token) => {
    if (!t.name || seen.has(t.name)) return;
    seen.add(t.name);
    tokens.push(t);
  };
  for (const c of data.colors) add({ name: c.token, kind: 'color', value: c.value, ...(c.modes && Object.keys(c.modes).length ? { modes: c.modes } : {}) });
  for (const r of data.radius) add({ name: r.token || `radius-${r.value}`, kind: 'radius', value: `${r.value}px` });
  for (const s of data.spacing) add({ name: s.token || `space-${s.value}`, kind: 'spacing', value: `${s.value}px` });
  for (const fam of data.families) if (fam.token) add({ name: fam.token, kind: 'font-family', value: `${cssFamily(fam.family)}${fam.fallback ? `, ${fam.fallback}` : ''}` });
  const textStyles: TextStyle[] = data.typeScale.map((s) => {
    const fam = data.families.find((x) => x.role === s.family || x.family === s.family);
    const style: Record<string, string> = { fontSize: `${s.size}px` };
    if (fam) style.fontFamily = cssFamily(fam.family);
    else if (s.family) style.fontFamily = cssFamily(s.family);
    if (s.weight) style.fontWeight = String(s.weight);
    if (s.lineHeight) style.lineHeight = s.lineHeight;
    if (s.tracking) style.letterSpacing = s.tracking;
    const key = (s.token || s.name || `size-${s.size}`).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `size-${s.size}`;
    return { key, name: s.name || key, style };
  });
  return { tokens, textStyles };
}

/** A file's tokens and text styles as a DESIGN.md, with the prose of its brand when `brand` gives one, else what the tokens say. */
export function docDesignMd(doc: BogenDoc, name: string, brand?: BrandData | null): string {
  const tokens = doc.getTokens();
  const textStyles = getTextStyles(doc);
  let sections = tokenProse(tokens, textStyles);
  if (brand) {
    const prose = brandProse(brand);
    // The brand's words, and the file's own lists where the brand says nothing.
    sections = [...prose, ...sections.filter((s) => !prose.some((p) => p.id === s.id))];
  }
  return writeDesignMd({ name, description: brand ? bindingBrand(brand).fields.positioning || undefined : undefined, tokens, textStyles, sections });
}

/** A DESIGN.md of a brand. */
export function brandDesignMd(name: string, data: BrandData): string {
  const { tokens, textStyles } = brandTokens(data);
  return writeDesignMd({ name, description: bindingBrand(data).fields.positioning || undefined, tokens, textStyles, sections: brandProse(data) });
}

// ---------------------------------------------------------------- into a brand, as suggestions

const px = (v: string | undefined): number | null => {
  const m = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(v?.trim() ?? '');
  if (!m) return null;
  return m[2] === 'rem' || m[2] === 'em' ? Number(m[1]) * 16 : Number(m[1]);
};

function familyRole(name: string): string {
  const n = name.toLowerCase();
  if (/mono|code/.test(n)) return 'mono';
  if (/display|head|title|hero|h[1-3]\b/.test(n)) return 'display';
  if (/body|text|base|label|caption|paragraph/.test(n)) return 'body';
  return '';
}

/** A DESIGN.md as a brand extraction: values only, to go in as suggestions. */
export function designMdExtraction(md: DesignMd, source: string): Extraction {
  const ex: Extraction = { source, colors: [], families: [], typeScale: [], spacing: [], radius: [], logos: [], shadows: 0, gradients: 0, notes: [] };
  for (const [name, value] of Object.entries(md.colors)) {
    const hex = normalizeColor(resolveDesignRef(md, value) ?? '');
    if (!hex) continue;
    ex.colors.push({ value: hex, usage: 0, as: { text: 0, background: 0, border: 0, vector: 0 }, role: /primary|accent|brand/.test(name) ? 'accent' : /surface|background|bg|neutral/.test(name) ? 'background' : /^on-|text|ink|foreground/.test(name) ? 'text' : '', name, token: tokenName(name) });
  }
  const families = new Map<string, { role: string; weights: Set<number>; n: number }>();
  for (const [name, t] of Object.entries(md.typography)) {
    const family = t.fontFamily ? resolveDesignRef(md, t.fontFamily) : undefined;
    const size = px(t.fontSize ? resolveDesignRef(md, t.fontSize) : undefined);
    const weight = Number(t.fontWeight);
    const first = family?.split(',')[0]!.trim().replace(/^["']|["']$/g, '');
    if (first) {
      const f = families.get(first) ?? { role: '', weights: new Set<number>(), n: 0 };
      f.n++;
      if (!f.role) f.role = familyRole(name);
      if (Number.isFinite(weight) && weight > 0) f.weights.add(weight);
      families.set(first, f);
    }
    if (size) ex.typeScale.push({ size, layers: 0, ...(Number.isFinite(weight) && weight > 0 ? { weight } : {}), ...(t.lineHeight !== undefined ? { lineHeight: String(t.lineHeight) } : {}), ...(t.letterSpacing ? { tracking: t.letterSpacing } : {}), ...(first ? { family: first } : {}), name, token: tokenName(name) });
  }
  for (const [family, f] of families) ex.families.push({ family, layers: f.n, characters: 0, role: f.role || 'other', weights: [...f.weights].sort((a, b) => a - b) });
  if (ex.families.length && !ex.families.some((f) => f.role === 'body')) [...ex.families].sort((a, b) => b.layers - a.layers)[0]!.role = 'body';
  for (const [name, value] of Object.entries(md.spacing)) {
    const n = px(resolveDesignRef(md, value));
    if (n !== null) ex.spacing.push({ value: n, count: 0, name, token: tokenName(name) });
  }
  for (const [name, value] of Object.entries(md.rounded)) {
    const n = px(resolveDesignRef(md, value));
    if (n !== null) ex.radius.push({ value: n, count: 0, name, token: tokenName(name) });
  }
  return ex;
}

/** Lines of a Do's and Don'ts section, each as a rule. */
export function designMdRules(md: DesignMd): { text: string; kind: 'do' | 'dont' }[] {
  const section = md.sections.find((s) => s.id === 'dos');
  if (!section) return [];
  const out: { text: string; kind: 'do' | 'dont' }[] = [];
  let mode: 'do' | 'dont' | null = null;
  for (const raw of section.body.split('\n')) {
    const line = raw.trim();
    if (/^#{3,}\s*(do'?s?|dos)\b(?!.*don)/i.test(line)) mode = 'do';
    else if (/^#{3,}\s*(don'?t'?s?|donts|avoid)\b/i.test(line.replace(/’/g, "'"))) mode = 'dont';
    const item = /^[-*+]\s+(.+)$/.exec(line)?.[1] ?? /^\d+[.)]\s+(.+)$/.exec(line)?.[1];
    if (!item) continue;
    const text = item.replace(/\*\*/g, '').replace(/’/g, "'").trim();
    const kind = /^(don't|dont|do not|never|avoid)\b/i.test(text) ? 'dont' : /^(do|always|use)\b/i.test(text) ? 'do' : mode ?? 'do';
    if (text.length >= 3) out.push({ text: text.slice(0, 500), kind });
  }
  return out.slice(0, 100);
}

/** Which brandbook chapter a section's prose goes to as a draft. */
const CHAPTER_OF: Partial<Record<DesignMdSectionId, string>> = { overview: 'strategy', colors: 'color', typography: 'type', layout: 'layout', components: 'applications' };

/**
 * Puts a DESIGN.md into a brand as suggestions, through the same review a brand extraction goes through: values,
 * rules, the positioning, and the prose as draft chapters where a chapter is still empty. Nothing binds until the
 * person confirms it. The caller wraps it in one transaction.
 */
export function importDesignMdBrand(doc: BogenDoc, md: DesignMd, source: string, by: string, origin: unknown): { added: Record<string, number>; ids: string[]; chapters: string[]; fields: string[] } {
  const ex = designMdExtraction(md, source);
  const { added, ids } = applyExtraction(doc, ex, origin);
  const data = readBrand(doc);
  for (const r of designMdRules(md)) {
    if (data.rules.some((x) => x.text.toLowerCase() === r.text.toLowerCase())) continue;
    ids.push(upsertBrandItem(doc, 'rules', { text: r.text, kind: r.kind, severity: 'soft', topic: 'general', suggested: true, source }, origin));
    added.rules = (added.rules ?? 0) + 1;
  }
  // Pairs a component states: allowed, with their contrast already checked by the lint.
  for (const [, props] of Object.entries(md.components)) {
    const bg = props.backgroundColor && normalizeColor(resolveDesignRef(md, props.backgroundColor) ?? '');
    const fg = props.textColor && normalizeColor(resolveDesignRef(md, props.textColor) ?? '');
    if (!bg || !fg || data.pairings.some((p) => p.fg === fg && p.bg === bg)) continue;
    ids.push(upsertBrandItem(doc, 'pairings', { fg, bg, verdict: 'allow', suggested: true, source }, origin));
    added.pairings = (added.pairings ?? 0) + 1;
  }
  const fields: string[] = [];
  const positioning = md.description || md.sections.find((s) => s.id === 'overview')?.body.split(/\n\s*\n/)[0]?.trim();
  if (positioning && !data.fields.positioning) {
    setBrandField(doc, 'positioning', positioning.slice(0, 2000), origin);
    markBrandFields(doc, ['positioning'], true, origin);
    fields.push('positioning');
  }
  if (md.name && !data.fields.name) {
    setBrandField(doc, 'name', md.name.slice(0, 200), origin);
    markBrandFields(doc, ['name'], true, origin);
    fields.push('name');
  }
  const book = readBrandBook(doc);
  const chapters: string[] = [];
  for (const s of md.sections) {
    const id = s.id ? CHAPTER_OF[s.id] : undefined;
    if (!id || !s.body.trim() || book?.chapters.some((c) => c.id === id)) continue;
    if (!BRAND_BOOK_CHAPTERS.some((c) => c.id === id)) continue;
    try {
      updateBrandBookChapter(doc, { id: id as never, markdown: s.body.slice(0, 11000), source, questions: '', status: 'draft', expectedRevision: null }, by);
      chapters.push(id);
    } catch {
      // A chapter that does not take the text stays open.
    }
  }
  return { added, ids, chapters, fields };
}
