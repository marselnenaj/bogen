import type { CodePropValue } from '@bogen/core';

/**
 * Finds React components in a module's source and what props they take, by reading the text. Nothing is
 * run or type-checked: this covers the common shapes (function and arrow components, forwardRef and memo,
 * interfaces, type aliases, inline object types, string unions, cva variants, element props) and says
 * nothing about the rest, which can still be set as JSON.
 */

export type CodePropType = 'string' | 'number' | 'boolean' | 'enum' | 'node' | 'json';
export interface CodePropInfo { name: string; type: CodePropType; options?: string[]; default?: CodePropValue; required?: boolean; description?: string }
export interface ScannedComponent { name: string; display: string; props: CodePropInfo[] }

const OPEN: Record<string, string> = { '(': ')', '{': '}', '[': ']' };

/** Comments and string contents keep their length, so that positions in the result match the source. */
export function blankComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop - 1;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else out += c;
  }
  return out;
}

/** The index of the bracket that closes the one at `at`, skipping strings. -1 if it never closes. */
export function closing(src: string, at: number): number {
  const stack: string[] = [];
  for (let i = at; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      i = j;
    } else if (OPEN[c]) stack.push(OPEN[c]!);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Splits at a separator outside brackets, angle brackets and strings. */
export function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let angle = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      i = j;
    } else if (OPEN[c]) depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === '<') angle++;
    else if (c === '>' && text[i - 1] !== '=') angle = Math.max(0, angle - 1);
    else if (c === separator && depth === 0 && angle === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The generic arguments of `Name<...>` at the start of `text`, split. */
function genericArgs(text: string): string[] | null {
  const open = text.indexOf('<');
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '<') depth++;
    else if (text[i] === '>' && text[i - 1] !== '=') {
      depth--;
      if (!depth) return splitTop(text.slice(open + 1, i), ',');
    }
  }
  return null;
}

const ELEMENT_PROPS = /^(?:React\.)?(?:ComponentProps(?:WithoutRef|WithRef)?|ComponentPropsWithoutRef|HTMLProps|AllHTMLAttributes|HTMLAttributes|(\w+)HTMLAttributes)\s*</;
const STRING_LITERAL = /^(['"])((?:(?!\1)[^\\]|\\.)*)\1$/;
const NODE_TYPES = /^(?:React\.)?(?:ReactNode|ReactElement|ReactChild|JSX\.Element)(?:<.*>)?$/;

interface Member { name: string; type: string; optional: boolean; description?: string }

class ModuleText {
  readonly code: string;
  constructor(readonly src: string) {
    this.code = blankComments(src);
  }

  /** The text of a type alias or interface body by name. */
  declaration(name: string): { kind: 'interface'; body: string; extends: string[] } | { kind: 'type'; body: string } | null {
    const iface = new RegExp(`\\binterface\\s+${name}\\b(?:\\s*<[^{]*?>)?\\s*(?:extends\\s+([^{]+))?\\{`).exec(this.code);
    if (iface) {
      const open = iface.index + iface[0].length - 1;
      const end = closing(this.code, open);
      if (end > 0) return { kind: 'interface', body: this.src.slice(open + 1, end), extends: iface[1] ? splitTop(iface[1], ',') : [] };
    }
    const alias = new RegExp(`\\btype\\s+${name}\\b(?:\\s*<[^=]*?>)?\\s*=`).exec(this.code);
    if (alias) {
      const start = alias.index + alias[0].length;
      let end = start;
      // To the end of the statement: a semicolon or a new statement at the top level.
      for (let i = start, depth = 0; i <= this.code.length; i++) {
        const c = this.code[i];
        if (c === undefined) { end = i; break; }
        if (c === '"' || c === "'" || c === '`') {
          let j = i + 1;
          while (j < this.code.length && this.code[j] !== c) j += this.code[j] === '\\' ? 2 : 1;
          i = j;
          continue;
        }
        if (OPEN[c]) depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        if (depth === 0 && (c === ';' || (c === '\n' && /^\s*(export|const|let|var|function|type|interface|class|import)\b/.test(this.code.slice(i + 1, i + 40))))) { end = i; break; }
      }
      return { kind: 'type', body: this.src.slice(start, end).trim() };
    }
    return null;
  }

  /** Variant names and options of `const name = cva(...)`. */
  cva(name: string): { members: CodePropInfo[] } | null {
    const m = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:\\w+\\.)?(?:cva|tv)\\s*\\(`).exec(this.code);
    if (!m) return null;
    const open = m.index + m[0].length - 1;
    const end = closing(this.code, open);
    if (end < 0) return null;
    const args = this.code.slice(open + 1, end);
    const objectAfter = (key: string): string | null => {
      const at = new RegExp(`\\b${key}\\s*:\\s*\\{`).exec(args);
      if (!at) return null;
      const start = at.index + at[0].length - 1;
      const stop = closing(args, start);
      return stop > 0 ? args.slice(start + 1, stop) : null;
    };
    const variants = objectAfter('variants');
    if (variants === null) return { members: [] };
    const defaults = objectAfter('defaultVariants') ?? '';
    const members: CodePropInfo[] = [];
    for (const entry of objectEntries(variants)) {
      const options = objectEntries(entry.value.replace(/^\{|\}$/g, '')).map((o) => o.key);
      const fallback = objectEntries(defaults).find((d) => d.key === entry.key)?.value;
      const literal = fallback !== undefined ? literalValue(fallback) : undefined;
      const isBoolean = options.length && options.every((o) => o === 'true' || o === 'false');
      members.push({ name: entry.key, ...(isBoolean ? { type: 'boolean' as const } : { type: 'enum' as const, options }), ...(literal !== undefined ? { default: isBoolean ? literal === 'true' || literal === true : literal } : {}) });
    }
    return { members };
  }
}

/** Keys and values of an object literal's body, at its top level. */
function objectEntries(body: string): { key: string; value: string }[] {
  return splitTop(body, ',').flatMap((part) => {
    const m = /^(?:(['"])(.+?)\1|([A-Za-z_$][\w$-]*))\s*:\s*([\s\S]*)$/.exec(part);
    return m ? [{ key: m[2] ?? m[3]!, value: m[4]!.trim() }] : [];
  });
}

function literalValue(text: string): CodePropValue | undefined {
  const t = text.trim();
  const s = STRING_LITERAL.exec(t);
  if (s) return s[2]!.replace(/\\(.)/g, '$1');
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  if (t === 'null') return null;
  return undefined;
}

/** Members of an object type's body, with the doc comment right above each. */
function typeMembers(body: string): Member[] {
  const code = blankComments(body);
  const out: Member[] = [];
  const starts: { at: number; name: string; optional: boolean; valueAt: number }[] = [];
  const keyAt = /(^|[;,\n{])\s*(?:readonly\s+)?(?:(['"])([^'"]+)\2|([A-Za-z_$][\w$-]*))(\?)?\s*:/g;
  let depth = 0;
  let last = 0;
  // Only keys at the top level of this body count.
  const depthAt = (i: number) => {
    for (; last < i; last++) {
      const c = code[last]!;
      if (OPEN[c]) depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
    }
    return depth;
  };
  for (let m = keyAt.exec(code); m; m = keyAt.exec(code)) {
    const at = m.index + m[1]!.length;
    if (depthAt(at) !== 0) continue;
    starts.push({ at, name: m[3] ?? m[4]!, optional: m[5] === '?', valueAt: m.index + m[0].length });
  }
  starts.forEach((s, i) => {
    const end = starts[i + 1]?.at ?? body.length;
    const type = code.slice(s.valueAt, end).trim().replace(/[;,]$/, '').trim();
    // The comment was blanked in `code`, so it sits between the separator and the key.
    const doc = /\/\*\*([\s\S]*?)\*\//.exec(body.slice(s.at, s.valueAt));
    out.push({ name: s.name, type, optional: s.optional, ...(doc ? { description: doc[1]!.replace(/^\s*\*\s?/gm, '').trim().slice(0, 300) } : {}) });
  });
  return out;
}

function classify(mod: ModuleText, type: string, depth = 0): Pick<CodePropInfo, 'type' | 'options'> | null {
  const t = type.trim().replace(/^\|/, '').trim();
  if (/=>/.test(t) && /^(\(|<)/.test(t)) return null;
  const parts = splitTop(t, '|').filter((p) => p !== 'undefined' && p !== 'null');
  if (!parts.length) return { type: 'json' };
  if (parts.every((p) => p === 'true' || p === 'false' || p === 'boolean')) return { type: 'boolean' };
  if (parts.every((p) => STRING_LITERAL.test(p))) return { type: 'enum', options: parts.map((p) => STRING_LITERAL.exec(p)![2]!) };
  if (parts.length === 1 && parts[0] === 'string') return { type: 'string' };
  if (parts.length === 1 && parts[0] === 'number') return { type: 'number' };
  if (parts.some((p) => NODE_TYPES.test(p))) return { type: 'node' };
  if (parts.every((p) => p === 'string' || STRING_LITERAL.test(p))) return { type: 'string' };
  if (parts.length === 1 && /^[A-Z]\w*$/.test(parts[0]!) && depth < 3) {
    const decl = mod.declaration(parts[0]!);
    if (decl?.kind === 'type') return classify(mod, decl.body, depth + 1);
  }
  if (/^(Function|\(\s*\)|.*=>)/.test(t)) return null;
  return { type: 'json' };
}

function elementMembers(tag: string | undefined): CodePropInfo[] {
  const out: CodePropInfo[] = [{ name: 'children', type: 'node' }, { name: 'className', type: 'string' }];
  if (tag === 'button' || tag === 'Button' || tag === 'input' || tag === 'Input') out.push({ name: 'disabled', type: 'boolean' });
  if (tag === 'a' || tag === 'Anchor') out.push({ name: 'href', type: 'string' });
  if (tag === 'input' || tag === 'Input' || tag === 'textarea' || tag === 'TextArea') out.push({ name: 'placeholder', type: 'string' });
  return out;
}

/** Props of a type expression, in the order they are declared, later ones winning. */
function propsOfType(mod: ModuleText, type: string, depth = 0): CodePropInfo[] {
  if (depth > 6) return [];
  const out: CodePropInfo[] = [];
  for (const raw of splitTop(type.trim(), '&')) {
    const part = raw.trim();
    if (part.startsWith('{')) {
      const end = closing(part, 0);
      for (const m of typeMembers(part.slice(1, end > 0 ? end : undefined))) {
        if (m.name === 'ref' || m.name === 'key') continue;
        const kind = classify(mod, m.type);
        if (kind) out.push({ name: m.name, ...kind, ...(m.optional ? {} : { required: true }), ...(m.description ? { description: m.description } : {}) });
      }
      continue;
    }
    const element = ELEMENT_PROPS.exec(part);
    if (element) {
      const arg = genericArgs(part)?.[0] ?? '';
      const tag = STRING_LITERAL.exec(arg)?.[2] ?? element[1] ?? /typeof\s+(\w+)/.exec(arg)?.[1];
      out.push(...elementMembers(tag));
      continue;
    }
    const variant = /^VariantProps\s*<\s*typeof\s+(\w+)\s*>$/.exec(part);
    if (variant) {
      out.push(...(mod.cva(variant[1]!)?.members ?? []));
      continue;
    }
    const wrapper = /^(?:React\.)?(Omit|Pick|Partial|Required|Readonly|PropsWithChildren)\s*</.exec(part);
    if (wrapper) {
      const args = genericArgs(part) ?? [];
      const inner = propsOfType(mod, args[0] ?? '', depth + 1);
      const keys = (args[1] ?? '').split('|').map((k) => STRING_LITERAL.exec(k.trim())?.[2]).filter(Boolean);
      if (wrapper[1] === 'Omit') out.push(...inner.filter((p) => !keys.includes(p.name)));
      else if (wrapper[1] === 'Pick') out.push(...inner.filter((p) => keys.includes(p.name)));
      else if (wrapper[1] === 'Partial') out.push(...inner.map(({ required: _r, ...p }) => p));
      else if (wrapper[1] === 'PropsWithChildren') out.push(...inner, { name: 'children', type: 'node' });
      else out.push(...inner);
      continue;
    }
    const named = /^([A-Z][\w]*)(?:\s*<.*>)?$/s.exec(part);
    if (named) {
      const decl = mod.declaration(named[1]!);
      if (decl?.kind === 'interface') {
        for (const base of decl.extends) out.push(...propsOfType(mod, base, depth + 1));
        out.push(...propsOfType(mod, `{${decl.body}}`, depth + 1));
      } else if (decl?.kind === 'type') out.push(...propsOfType(mod, decl.body, depth + 1));
    }
  }
  const byName = new Map<string, CodePropInfo>();
  for (const p of out) byName.set(p.name, { ...byName.get(p.name), ...p });
  return [...byName.values()];
}

/** Names and literal defaults of a destructuring pattern's top level. */
function destructured(pattern: string): { names: string[]; defaults: Record<string, CodePropValue> } {
  const names: string[] = [];
  const defaults: Record<string, CodePropValue> = {};
  for (const part of splitTop(pattern, ',')) {
    if (part.startsWith('...')) continue;
    const m = /^([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?\s*(?:=\s*([\s\S]+))?$/.exec(part);
    if (!m) continue;
    names.push(m[1]!);
    const value = m[2] !== undefined ? literalValue(m[2]) : undefined;
    if (value !== undefined) defaults[m[1]!] = value;
  }
  return { names, defaults };
}

/** Props from a component's parameter list, `(...)` without the parentheses. */
function propsOfParams(mod: ModuleText, params: string, typeHint?: string): CodePropInfo[] {
  const first = splitTop(params, ',')[0] ?? '';
  let pattern = '';
  let type = typeHint ?? '';
  if (first.startsWith('{')) {
    const end = closing(first, 0);
    pattern = first.slice(1, end);
    const rest = first.slice(end + 1).trim();
    if (rest.startsWith(':')) type = rest.slice(1).trim();
  } else {
    const m = /^[A-Za-z_$][\w$]*\s*:\s*([\s\S]+)$/.exec(first);
    if (m) type = m[1]!;
  }
  const props = type ? propsOfType(mod, type) : [];
  const { names, defaults } = destructured(pattern);
  for (const name of names) if (!props.some((p) => p.name === name) && name !== 'ref') props.push({ name, type: name === 'children' ? 'node' : 'string' });
  for (const p of props) if (defaults[p.name] !== undefined) p.default = defaults[p.name];
  return props;
}

interface Declaration { local: string; props: () => CodePropInfo[] }

/** Exported React components of a module, by export name, and their props. */
export function scanModule(src: string): ScannedComponent[] {
  const mod = new ModuleText(src);
  const code = mod.code;
  const declared = new Map<string, Declaration>();
  const exported = new Map<string, string>();

  const fn = /(^|\n)[ \t]*(export\s+(default\s+)?)?(?:async\s+)?function\s+([A-Z][\w$]*)\s*(?:<[^(]*>)?\s*\(/g;
  for (let m = fn.exec(code); m; m = fn.exec(code)) {
    const open = m.index + m[0].length - 1;
    const end = closing(code, open);
    const local = m[4]!;
    declared.set(local, { local, props: () => (end > 0 ? propsOfParams(mod, src.slice(open + 1, end)) : []) });
    if (m[2]) exported.set(m[3] ? 'default' : local, local);
  }

  const constant = /(^|\n)[ \t]*(export\s+)?(?:const|let|var)\s+([A-Z][\w$]*)\s*(?::\s*([^=]+?))?\s*=\s*/g;
  for (let m = constant.exec(code); m; m = constant.exec(code)) {
    const local = m[3]!;
    const annotation = m[4]?.trim();
    let at = m.index + m[0].length;
    let typeHint = annotation ? genericArgs(annotation)?.[0] : undefined;
    // Through wrappers such as forwardRef(...) and memo(...), to the function inside.
    for (let guard = 0; guard < 3; guard++) {
      const wrap = /^(?:React\.)?(forwardRef|memo)\s*(<[\s\S]*?>)?\s*\(/.exec(code.slice(at, at + 400));
      if (!wrap) break;
      if (wrap[1] === 'forwardRef' && wrap[2]) typeHint = genericArgs(wrap[2])?.[1] ?? typeHint;
      at += wrap[0].length;
    }
    const head = /^(?:async\s+)?(?:function\s*[\w$]*\s*)?(?:<[^(]*>)?\s*\(/.exec(code.slice(at, at + 200));
    const isComponent = head || /^[A-Za-z_$][\w$]*\s*=>/.test(code.slice(at, at + 100));
    if (!isComponent) continue;
    const open = head ? at + head[0].length - 1 : -1;
    const end = open >= 0 ? closing(code, open) : -1;
    declared.set(local, { local, props: () => (end > 0 ? propsOfParams(mod, src.slice(open + 1, end), typeHint) : typeHint ? propsOfType(mod, typeHint) : []) });
    if (m[2]) exported.set(local, local);
  }

  const list = /\bexport\s*\{([^}]*)\}(?!\s*from)/g;
  for (let m = list.exec(code); m; m = list.exec(code)) {
    for (const item of m[1]!.split(',')) {
      const [local, as] = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map((s) => s.trim());
      if (local && declared.has(local)) exported.set(as ?? local, local);
    }
  }
  const fallback = /\bexport\s+default\s+(?:(?:React\.)?memo\s*\(\s*)?([A-Z][\w$]*)\s*\)?\s*;?/.exec(code);
  if (fallback && declared.has(fallback[1]!)) exported.set('default', fallback[1]!);

  const out: ScannedComponent[] = [];
  for (const [name, local] of exported) {
    const decl = declared.get(local);
    if (!decl) continue;
    // `export default Card` next to `export const Card` is one component.
    if (name === 'default' && [...exported].some(([other, l]) => other !== 'default' && l === local)) continue;
    let props: CodePropInfo[] = [];
    try {
      props = decl.props();
    } catch {
      props = [];
    }
    out.push({ name, display: local, props });
  }
  return out.sort((a, b) => (a.name === 'default' ? 1 : b.name === 'default' ? -1 : a.name < b.name ? -1 : 1));
}
