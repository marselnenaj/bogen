/**
 * Code handoff of a component: which component of a code library a main stands for, so that code written from
 * a design imports it instead of writing it out, such as `import { Button } from "@/components/ui/button"` and
 * `<Button variant="outline" size="sm">Save</Button>`. Kits set it on their mains (see the server's kits/), and
 * a person or agent can set it on their own with component_update. Stored on the main's component map.
 */
export interface CodeHandoff {
  /** The module, such as `@/components/ui/button` or `@mui/material`. */
  from: string;
  /** The component a usage writes, such as `Button`. */
  name: string;
  /** Further names the usage needs from the same module, such as `CardHeader`. */
  imports?: string[];
  /** Names from other modules that the usage needs, such as the Label next to a Checkbox, or an icon. */
  more?: { from: string; imports: string[] }[];
  /**
   * Bogen prop or variant axis name to the prop name in code. `children` makes a text prop the children;
   * an empty name leaves it out of the usage. Names not listed keep their own, in camelCase.
   */
  props?: Record<string, string>;
  /** The value of each variant axis that code leaves unsaid, because it is the library's default. */
  defaults?: Record<string, string>;
  /** Variant values per axis to their value in code, such as `{ size: { md: 'medium' } }`. */
  values?: Record<string, Record<string, string>>;
  /** Attributes a variant value adds in code, such as `{ state: { disabled: 'disabled' } }`, for states that are flags there. */
  flags?: Record<string, Record<string, string>>;
  /**
   * A usage of several parts, such as a Card with its header. `{{attrs}}` is where the root's props go,
   * `{{children}}` the slot's content, and `{{name}}` the value of a text prop. Only tags and quoted
   * attributes: no JavaScript expressions, since documents come from other people.
   */
  usage?: string;
}

const MODULE = /^[@\w][\w@./-]{0,199}$/;
const IDENT = /^[A-Z][A-Za-z0-9_$]{0,99}$/;
const PROP = /^[A-Za-z_$][\w$-]{0,99}$/;
/** One JSX attribute: a bare name, a name with a quoted value, or with a number. */
const FLAG = /^[A-Za-z][\w-]{0,60}(="[^"{}<>\\\n]{0,100}"|=\{-?\d{1,9}(\.\d{1,6})?\})?$/;

/**
 * The two values in braces a usage may hold, as Base UI needs them: a list of quoted strings, such as
 * `defaultValue={["item-1"]}`, and one element of a tag and quoted attributes, such as
 * `render={<Button variant="outline" />}`. Neither can carry code.
 */
const STRING_LIST = /=\{\[\s*(?:"[^"{}<>\\\n`]{0,100}"\s*,?\s*){0,20}\]\}/g;
const ELEMENT_VALUE = /=\{<[A-Z][\w.]{0,99}(?:\s+[A-Za-z][\w-]{0,60}(?:="[^"{}<>\\\n`]{0,100}")?){0,10}\s*\/>\}/g;

/** Usage templates are tags, quoted attribute values and placeholders, so they cannot carry code. */
export function safeUsage(usage: string): boolean {
  if (usage.length > 4000) return false;
  const bare = usage.replace(/\{\{\s*[\w.$-]+\s*\}\}/g, '').replace(STRING_LIST, '=').replace(ELEMENT_VALUE, '=');
  return !/[{}`]/.test(bare) && !/<\s*script/i.test(bare);
}

export function readHandoff(v: unknown): CodeHandoff | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const h = v as Record<string, unknown>;
  if (typeof h.from !== 'string' || !MODULE.test(h.from) || h.from.includes('..') || typeof h.name !== 'string' || !IDENT.test(h.name)) return undefined;
  const out: CodeHandoff = { from: h.from, name: h.name };
  if (Array.isArray(h.imports)) {
    const names = h.imports.filter((n): n is string => typeof n === 'string' && IDENT.test(n)).slice(0, 30);
    if (names.length) out.imports = names;
  }
  if (Array.isArray(h.more)) {
    const more = h.more.slice(0, 10).flatMap((m: unknown) => {
      const r = m as Record<string, unknown> | null;
      if (!r || typeof r.from !== 'string' || !MODULE.test(r.from) || r.from.includes('..') || !Array.isArray(r.imports)) return [];
      const names = r.imports.filter((n): n is string => typeof n === 'string' && IDENT.test(n)).slice(0, 30);
      return names.length ? [{ from: r.from, imports: names }] : [];
    });
    if (more.length) out.more = more;
  }
  if (h.props && typeof h.props === 'object') {
    const props = Object.fromEntries(Object.entries(h.props).filter((e): e is [string, string] => typeof e[1] === 'string' && e[0] !== '__proto__' && (e[1] === '' || PROP.test(e[1]))));
    if (Object.keys(props).length) out.props = props;
  }
  if (h.defaults && typeof h.defaults === 'object') {
    const defaults = Object.fromEntries(Object.entries(h.defaults).filter((e): e is [string, string] => typeof e[1] === 'string' && e[0] !== '__proto__' && e[1].length < 100).slice(0, 20));
    if (Object.keys(defaults).length) out.defaults = defaults;
  }
  if (h.values && typeof h.values === 'object') {
    const values: Record<string, Record<string, string>> = {};
    for (const [axis, map] of Object.entries(h.values)) {
      if (axis === '__proto__' || !map || typeof map !== 'object') continue;
      const clean = Object.fromEntries(Object.entries(map).filter((e): e is [string, string] => typeof e[1] === 'string' && e[0] !== '__proto__' && e[1].length < 100 && !/["\\\n{}]/.test(e[1])));
      if (Object.keys(clean).length) values[axis] = clean;
    }
    if (Object.keys(values).length) out.values = values;
  }
  if (h.flags && typeof h.flags === 'object') {
    const flags: Record<string, Record<string, string>> = {};
    for (const [axis, map] of Object.entries(h.flags)) {
      if (axis === '__proto__' || !map || typeof map !== 'object') continue;
      const clean = Object.fromEntries(Object.entries(map).filter((e): e is [string, string] => typeof e[1] === 'string' && e[0] !== '__proto__' && FLAG.test(e[1])));
      if (Object.keys(clean).length) flags[axis] = clean;
    }
    if (Object.keys(flags).length) out.flags = flags;
  }
  if (typeof h.usage === 'string' && safeUsage(h.usage)) out.usage = h.usage;
  return out;
}

/** The import line for these handoffs, one per module, names sorted. */
export function handoffImportLines(list: CodeHandoff[]): string[] {
  const byModule = new Map<string, Set<string>>();
  const add = (from: string, list: string[]) => {
    const names = byModule.get(from) ?? new Set<string>();
    for (const n of list) names.add(n);
    byModule.set(from, names);
  };
  for (const h of list) {
    add(h.from, [h.name, ...(h.imports ?? [])]);
    for (const m of h.more ?? []) add(m.from, m.imports);
  }
  return [...byModule].sort(([a], [b]) => a.localeCompare(b)).map(([from, names]) => `import { ${[...names].sort().join(', ')} } from ${JSON.stringify(from)};`);
}
