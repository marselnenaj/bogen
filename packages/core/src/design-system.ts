import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { kebabCss } from './css.ts';
import type { BogenDoc, BogenNode, Token } from './doc.ts';

/**
 * Theme modes and text styles. A token's plain `value` is its value in the base mode, and other modes
 * are extra keys next to it (`mode:dark`), so that an old reader of a token still gets a real value.
 * Stored text goes into a style element, so it is checked again whenever it is written out.
 */
export interface ThemeMode { name: string; order: string; base: boolean }
export interface TextStyle { key: string; name: string; style: Record<string, string> }

const MODE_NAME = /^[a-zA-Z_][\w-]*$/;
const TEXT_STYLE_KEY = /^[a-z0-9_][a-z0-9_-]*$/;
const TOKEN_NAME = /^[a-zA-Z_][\w-]*$/;
/** What a text style bundles. */
export const TEXT_STYLE_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'fontStyle', 'textTransform', 'textDecorationLine', 'fontFeatureSettings', 'fontVariationSettings'] as const;

export const isModeName = (name: string): boolean => MODE_NAME.test(name);

/**
 * Whether a value can sit in a style element without ending its declaration, its rule or the element.
 * Braces and semicolons are fine inside strings and parentheses, as in a data URL.
 */
export function safeCssValue(value: string): boolean {
  if (/<\/|<!--|@import|expression\s*\(|javascript:/i.test(value)) return false;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === '{' || c === '}' || c === ';')) return false;
  }
  return !quote && depth === 0;
}

export function getModes(doc: BogenDoc): ThemeMode[] {
  const out: ThemeMode[] = [];
  doc.modes.forEach((m, name) => {
    if (m instanceof Y.Map && MODE_NAME.test(name)) out.push({ name, order: String(m.get('order') ?? ''), base: Boolean(m.get('base')) });
  });
  return out.sort((a, b) => Number(b.base) - Number(a.base) || (a.order < b.order ? -1 : a.order > b.order ? 1 : a.name < b.name ? -1 : 1));
}

export function baseMode(doc: BogenDoc): string | undefined {
  return getModes(doc).find((m) => m.base)?.name;
}

/** Adds a mode. The first mode of a file names what the plain token values are. */
export function createMode(doc: BogenDoc, name: string, options: { baseName?: string } = {}, origin?: unknown): void {
  if (!MODE_NAME.test(name)) throw new Error(`"${name}" is not a valid mode name. Use letters, digits, - and _.`);
  doc.transact(() => {
    const add = (mode: string, base: boolean) => {
      if (doc.modes.has(mode)) return;
      const list = getModes(doc);
      const m = new Y.Map<unknown>();
      m.set('order', generateKeyBetween(list.at(-1)?.order || null, null));
      if (base) m.set('base', true);
      doc.modes.set(mode, m);
    };
    // A mode needs something to differ from, and "light" is what a file without modes usually is.
    if (!getModes(doc).some((m) => m.base)) {
      const baseName = options.baseName ?? (name === 'light' ? 'dark' : 'light');
      add(baseName === name ? `${name}-base` : baseName, true);
    }
    add(name, false);
  }, origin);
}

export function deleteMode(doc: BogenDoc, name: string, origin?: unknown): void {
  const mode = getModes(doc).find((m) => m.name === name);
  if (!mode) throw new Error(`There is no mode "${name}".`);
  if (mode.base) throw new Error(`"${name}" holds the plain values of all tokens and cannot be deleted.`);
  doc.transact(() => {
    doc.modes.delete(name);
    doc.tokens.forEach((m) => m.delete(`mode:${name}`));
  }, origin);
}

/** A token's value in one mode. With null it goes back to the base value. */
export function setTokenMode(doc: BogenDoc, token: string, mode: string, value: string | null, origin?: unknown): void {
  const m = doc.tokens.get(token);
  if (!m) throw new Error(`There is no token "${token}".`);
  if (!MODE_NAME.test(mode)) throw new Error(`"${mode}" is not a valid mode name.`);
  if (value !== null && !safeCssValue(value)) throw new Error(`The value of --${token} is not a single CSS value.`);
  doc.transact(() => {
    const base = doc.modes.get(mode)?.get('base');
    if (base) {
      if (value !== null) m.set('value', value);
    } else if (value === null) m.delete(`mode:${mode}`);
    else m.set(`mode:${mode}`, value);
  }, origin);
}

export function tokenValueIn(token: Token, mode: string | undefined): string {
  return (mode && token.modes?.[mode]) || token.value;
}

/** Sets or clears the mode of a page. */
export function setPageMode(doc: BogenDoc, pageId: string, mode: string | null, origin?: unknown): void {
  const m = doc.pages.get(pageId);
  if (!m) throw new Error(`No page with id ${pageId}.`);
  doc.transact(() => {
    if (mode) m.set('mode', mode);
    else m.delete('mode');
  }, origin);
}

/** The mode a layer shows: its own, the nearest ancestor's, or its page's. */
export function effectiveMode(doc: BogenDoc, id: string): string | undefined {
  const own = doc.getNode(id)?.mode;
  if (own) return own;
  for (const a of doc.ancestors(id)) {
    const mode = doc.getNode(a)?.mode;
    if (mode) return mode;
  }
  const page = doc.pageOf(id);
  const mode = page ? doc.pages.get(page)?.get('mode') : undefined;
  return typeof mode === 'string' ? mode : undefined;
}

export interface ThemeCssOptions {
  /** Where the base values go. */
  selector?: string;
  /** Where a mode's values go. Default `[data-mode="<name>"]`. */
  modeSelector?: (mode: string) => string;
}

const declaration = (name: string, value: string, spaced: boolean) => `--${name}:${spaced ? ' ' : ''}${value}`;

/**
 * A variable that refers to another is computed where it is declared. For an alias to follow a mode,
 * it has to be declared again inside that mode's block.
 */
function modeBlock(tokens: Token[], mode: string): { name: string; value: string }[] {
  const own = new Map<string, string>();
  for (const t of tokens) if (t.modes?.[mode] !== undefined) own.set(t.name, t.modes[mode]!);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tokens) {
      if (own.has(t.name)) continue;
      const refs = [...t.value.matchAll(/var\(\s*--([\w-]+)/g)].map((m) => m[1]!);
      if (refs.some((r) => own.has(r))) {
        own.set(t.name, t.value);
        grew = true;
      }
    }
  }
  return tokens.flatMap((t) => (own.has(t.name) ? [{ name: t.name, value: own.get(t.name)! }] : []));
}

/** Tokens as CSS: base values, then one block per mode. Nothing unsafe gets through. */
export function themeCss(tokens: Token[], modes: ThemeMode[], options: ThemeCssOptions = {}, pretty = false): string {
  const usable = tokens.filter((t) => TOKEN_NAME.test(t.name) && safeCssValue(t.value));
  if (!usable.length) return '';
  const selector = options.selector ?? ':root';
  const modeSelector = options.modeSelector ?? ((m: string) => `[data-mode="${m}"]`);
  const block = (sel: string, lines: string[]) => (pretty ? `${sel} {\n${lines.map((l) => `  ${l};`).join('\n')}\n}` : `${sel}{${lines.join(';')}}`);
  const base = usable.map((t) => declaration(t.name, t.value, pretty));
  const baseName = modes.find((m) => m.base)?.name;
  // The base mode can sit inside a part in another mode, so it needs a selector of its own too.
  const out = [block(baseName ? `${selector},${pretty ? ' ' : ''}${modeSelector(baseName)}` : selector, base)];
  for (const mode of modes) {
    if (mode.base || !MODE_NAME.test(mode.name)) continue;
    const lines = modeBlock(usable, mode.name).filter((l) => safeCssValue(l.value)).map((l) => declaration(l.name, l.value, pretty));
    if (lines.length) out.push(block(modeSelector(mode.name), lines));
  }
  return out.join(pretty ? '\n\n' : '\n');
}

export function textStyleKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The class a text style writes. Prefixed so that a style called `lg` is not read as Tailwind's. */
export function textStyleClass(key: string): string | undefined {
  return TEXT_STYLE_KEY.test(key) ? `ts-${key}` : undefined;
}

export function getTextStyles(doc: BogenDoc): TextStyle[] {
  const out: TextStyle[] = [];
  doc.textStyles.forEach((m, key) => {
    if (!(m instanceof Y.Map) || !TEXT_STYLE_KEY.test(key)) return;
    const style: Record<string, string> = {};
    for (const prop of TEXT_STYLE_PROPS) {
      const value = m.get(prop);
      if (typeof value === 'string' && value) style[prop] = value;
    }
    out.push({ key, name: String(m.get('name') ?? key), style });
  });
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Creates or updates a text style. Values left out stay as they are, and null removes one. */
export function setTextStyle(doc: BogenDoc, name: string, style: Partial<Record<(typeof TEXT_STYLE_PROPS)[number], string | null>>, origin?: unknown): string {
  const key = textStyleKey(name);
  if (!key || !TEXT_STYLE_KEY.test(key)) throw new Error(`"${name}" cannot name a text style. Use letters and digits.`);
  for (const [prop, value] of Object.entries(style)) {
    if (!(TEXT_STYLE_PROPS as readonly string[]).includes(prop)) throw new Error(`A text style cannot hold ${prop}. It holds ${TEXT_STYLE_PROPS.join(', ')}.`);
    if (value && !safeCssValue(value)) throw new Error(`The value of ${prop} is not a single CSS value.`);
  }
  doc.transact(() => {
    let m = doc.textStyles.get(key);
    if (!m) {
      m = new Y.Map<unknown>();
      doc.textStyles.set(key, m);
    }
    m.set('name', name.trim());
    for (const [prop, value] of Object.entries(style)) {
      if (value === null || value === '') m.delete(prop);
      else if (value !== undefined) m.set(prop, value);
    }
  }, origin);
  return key;
}

export function deleteTextStyle(doc: BogenDoc, key: string, origin?: unknown): void {
  doc.transact(() => {
    const style = getTextStyles(doc).find((s) => s.key === key)?.style ?? {};
    // Layers keep their look: what the style gave them moves onto them.
    doc.nodes.forEach((m, id) => {
      if (m.get('textStyle') !== key) return;
      const own = doc.rawNode(id)?.style ?? {};
      doc.updateStyle(id, Object.fromEntries(Object.entries(style).filter(([k]) => own[k] === undefined)));
      m.delete('textStyle');
    });
    doc.textStyles.delete(key);
  }, origin);
}

/** Text styles as CSS classes. `scope` lets a class beat a reset rule on the canvas. */
export function textStylesCss(styles: TextStyle[], scope = '', pretty = false): string {
  const rules: string[] = [];
  for (const s of styles) {
    const cls = textStyleClass(s.key);
    if (!cls) continue;
    const lines = Object.entries(s.style).filter(([, v]) => safeCssValue(v)).map(([k, v]) => `${kebabCss(k)}:${pretty ? ' ' : ''}${v}`);
    if (!lines.length) continue;
    rules.push(pretty ? `${scope}.${cls} {\n${lines.map((l) => `  ${l};`).join('\n')}\n}` : `${scope}.${cls}{${lines.join(';')}}`);
  }
  return rules.join(pretty ? '\n\n' : '\n');
}

/** Tokens in all their modes and the text style classes, as a stylesheet to hand to code. */
export function designSystemCss(doc: BogenDoc, options: ThemeCssOptions = {}): string {
  return [themeCss(doc.getTokens(), getModes(doc), options, true), textStylesCss(getTextStyles(doc), '', true)].filter(Boolean).join('\n\n');
}

/** Applies a text style: the layer gives up what the style now decides, so that it actually shows. */
export function applyTextStyle(doc: BogenDoc, id: string, key: string | null, origin?: unknown): void {
  doc.transact(() => {
    if (key === null) {
      doc.updateFields(id, { textStyle: undefined });
      return;
    }
    if (!doc.textStyles.has(key)) throw new Error(`There is no text style "${key}". Call text_styles_list.`);
    const style = getTextStyles(doc).find((s) => s.key === key)!.style;
    const patch: Record<string, null> = {};
    for (const prop of Object.keys(style)) patch[prop] = null;
    doc.updateFields(id, { textStyle: key });
    doc.updateStyle(id, patch);
  }, origin);
}


/** Font families a layer's overrides ask for. */
export function overrideFamilies(n: BogenNode): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(n.overrides ?? {})) if (key.endsWith('#style.fontFamily') && typeof value === 'string' && value) out.push(value);
  return out;
}
