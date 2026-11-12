import * as Y from 'yjs';
import type { BogenDoc } from './doc.ts';

/**
 * Code components: a layer that shows a component from the person's own repository, rendered by that
 * repository's code in a sandboxed frame. The layer is an `embed` with two fields on its map:
 * `code` ({ project, file, name, import? }, written whole) and `codeProps` (a Y.Map, so that two people
 * setting different props merge). The repository is linked per device, by project id; see the server's
 * `code-projects.ts`. Nothing here runs the repository's code.
 */

export type CodePropValue = string | number | boolean | null | CodePropValue[] | { [key: string]: CodePropValue };

export interface CodeRef {
  /** The linked project, an id the server gave it on this device. */
  project: string;
  /** Path of the module in the project, relative to its root, with `/`. */
  file: string;
  /** The export: a component name, or `default`. */
  name: string;
  /** How code imports the module, such as `@/components/ui/button`. */
  import?: string;
  props: Record<string, CodePropValue>;
}

const PROJECT_ID = /^[a-z0-9]{8,64}$/;
const EXPORT_NAME = /^(default|[A-Za-z_$][\w$]{0,99})$/;
const PROP_NAME = /^[A-Za-z_$][\w$-]{0,99}$/;
/** What one layer's props may weigh, as JSON. */
export const CODE_PROPS_LIMIT = 16 * 1024;

/** A path inside a project: relative, no `..`, no backslashes, no hidden segments other than none at all. */
export function isProjectPath(file: string): boolean {
  if (!file || file.length > 500 || file.startsWith('/') || file.includes('\\') || file.includes('\0')) return false;
  return file.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function checkValue(value: unknown, depth = 0): value is CodePropValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth > 8 || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length <= 500 && value.every((v) => checkValue(v, depth + 1));
  const entries = Object.entries(value as object);
  return entries.length <= 200 && entries.every(([k, v]) => k !== '__proto__' && checkValue(v, depth + 1));
}

/** Throws with a reason when a prop cannot be stored. */
export function assertCodeProp(name: string, value: unknown): asserts value is CodePropValue {
  if (!PROP_NAME.test(name) || name === '__proto__') throw new Error(`"${name}" is not a prop name.`);
  if (!checkValue(value)) throw new Error(`The value of ${name} is not plain JSON (strings, numbers, booleans, null, arrays and objects).`);
}

/** The ref of a layer as stored, or nothing if it is not a code component. Documents come from other people, so all of it is checked. */
export function readCodeRef(m: Y.Map<unknown>): CodeRef | undefined {
  const code = m.get('code');
  if (!code || typeof code !== 'object' || code instanceof Y.AbstractType) return undefined;
  const { project, file, name, import: spec } = code as Record<string, unknown>;
  if (typeof project !== 'string' || !PROJECT_ID.test(project) || typeof file !== 'string' || !isProjectPath(file) || typeof name !== 'string' || !EXPORT_NAME.test(name)) return undefined;
  const props: Record<string, CodePropValue> = {};
  const stored = m.get('codeProps');
  if (stored instanceof Y.Map) {
    stored.forEach((value: unknown, key: string) => {
      if (PROP_NAME.test(key) && key !== '__proto__' && checkValue(value)) props[key] = value;
    });
  }
  return { project, file, name, ...(typeof spec === 'string' && spec.length < 300 ? { import: spec } : {}), props };
}

/** Writes a ref onto a new layer's map. */
export function writeCodeRef(m: Y.Map<unknown>, ref: CodeRef): void {
  m.set('code', { project: ref.project, file: ref.file, name: ref.name, ...(ref.import ? { import: ref.import } : {}) });
  const props = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(ref.props)) props.set(k, v);
  m.set('codeProps', props);
}

/** Merges props into a code component layer. `null` as a value is stored; `undefined` removes the prop. */
export function setCodeProps(doc: BogenDoc, id: string, patch: Record<string, CodePropValue | undefined>, origin?: unknown): void {
  const m = doc.nodes.get(id);
  const ref = m && readCodeRef(m);
  if (!m || !ref) throw new Error(`Layer ${id} is not a code component.`);
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) assertCodeProp(k, v);
  const merged: Record<string, CodePropValue | undefined> = { ...ref.props, ...patch };
  if (JSON.stringify(merged).length > CODE_PROPS_LIMIT) throw new Error(`Props are limited to ${CODE_PROPS_LIMIT / 1024} KB of JSON.`);
  doc.transact(() => {
    let props = m.get('codeProps');
    if (!(props instanceof Y.Map)) {
      props = new Y.Map<unknown>();
      m.set('codeProps', props);
    }
    const map = props as Y.Map<unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) map.delete(k);
      else if (JSON.stringify(map.get(k)) !== JSON.stringify(v)) map.set(k, v);
    }
  }, origin);
}

/** Where a frame for this ref is served. Relative, so that the editor and the headless renderer each answer it. Props travel in the fragment, so a change does not reload the frame. */
export function codeFrameUrl(ref: CodeRef): string {
  const query = new URLSearchParams({ file: ref.file, name: ref.name });
  return `/api/code/${ref.project}/frame?${query}#${encodeURIComponent(JSON.stringify(ref.props))}`;
}

/** The name code uses for the component. */
export function codeComponentName(ref: Pick<CodeRef, 'file' | 'name'>): string {
  if (ref.name !== 'default') return ref.name;
  const base = ref.file.split('/').at(-1)!.replace(/\.[^.]+$/, '');
  const name = base.split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
  return /^[A-Z]/.test(name) ? name : `Component${name}`;
}

/** The module specifier code imports the component from. */
export function codeImportPath(ref: Pick<CodeRef, 'file' | 'import'>): string {
  return ref.import ?? `./${ref.file.replace(/\.(tsx|ts|jsx|js|mjs)$/, '')}`;
}

function jsxString(value: string): string {
  return /^[^"\\\n{}<>&]*$/.test(value) ? `"${value}"` : `{${JSON.stringify(value)}}`;
}

/** A usage such as `<Button variant="ghost">Save</Button>`, indented by `pad`. */
export function codeUsageJsx(ref: CodeRef, pad = ''): string {
  const tag = codeComponentName(ref);
  const attrs: string[] = [];
  for (const [k, v] of Object.entries(ref.props)) {
    if (k === 'children' || !/^[A-Za-z_$][\w$-]*$/.test(k)) continue;
    if (v === true) attrs.push(k);
    else if (typeof v === 'string') attrs.push(`${k}=${jsxString(v)}`);
    else attrs.push(`${k}={${JSON.stringify(v)}}`);
  }
  const open = `${pad}<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
  const children = ref.props.children;
  if (children === undefined || children === null || children === '') return `${open} />`;
  const body = typeof children === 'string' && /^[^{}<>&\n]*$/.test(children) && children.trim() === children ? children : `{${JSON.stringify(children)}}`;
  return `${open}>${body}</${tag}>`;
}

/** Code components in layers and everything stored under them. */
export function codeRefsUnder(doc: BogenDoc, ids: string | string[]): CodeRef[] {
  const out: CodeRef[] = [];
  const seen = new Set<string>();
  const walk = (at: string) => {
    if (seen.has(at)) return;
    seen.add(at);
    const m = doc.nodes.get(at);
    const ref = m && readCodeRef(m);
    if (ref) out.push(ref);
    // An instance of a main that is a code component uses that component.
    const main = m?.get('instanceOf');
    const mainRef = typeof main === 'string' ? doc.nodes.get(main) : undefined;
    const used = mainRef && readCodeRef(mainRef);
    if (used) out.push(used);
    for (const kid of doc.rawKids(at)) walk(kid);
  };
  for (const id of typeof ids === 'string' ? [ids] : ids) walk(id);
  return out;
}

/** Import lines for the code components under layers, one per module. */
export function codeImportLines(doc: BogenDoc, ids: string | string[]): string[] {
  const byModule = new Map<string, { named: Set<string>; fallback?: string }>();
  for (const ref of codeRefsUnder(doc, ids)) {
    const path = codeImportPath(ref);
    const entry = byModule.get(path) ?? { named: new Set<string>() };
    if (ref.name === 'default') entry.fallback = codeComponentName(ref);
    else entry.named.add(ref.name);
    byModule.set(path, entry);
  }
  return [...byModule].map(([path, { named, fallback }]) => {
    const parts = [fallback, named.size ? `{ ${[...named].sort().join(', ')} }` : undefined].filter(Boolean);
    return `import ${parts.join(', ')} from ${JSON.stringify(path)};`;
  });
}

/** Puts the imports a module needs for its code components on top of it. */
export function withCodeImports(doc: BogenDoc, id: string, code: string): string {
  const lines = codeImportLines(doc, id);
  return lines.length ? `${lines.join('\n')}\n\n${code}` : code;
}
