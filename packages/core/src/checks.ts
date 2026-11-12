import type { BogenDoc } from './doc.ts';

export interface CheckRule {
  id: string;
  kind: 'style' | 'attribute' | 'geometry' | 'count';
  selector: string;
  property?: string;
  operator: 'equals' | 'not-equals' | 'min' | 'max' | 'present' | 'absent';
  value?: string | number;
  message?: string;
  severity?: 'warning' | 'error';
  enabled?: boolean;
}
export interface CheckDefinition {
  id: string;
  name: string;
  description?: string;
  extends?: string;
  enabled?: boolean;
  lint?: boolean;
  /** The accessibility audit: headings, landmarks, names, alt text, link text, targets, focus and motion. */
  a11y?: boolean;
  responsive?: boolean;
  widths?: number[];
  viewport_heights?: number[];
  tolerance?: number;
  rules?: CheckRule[];
}
export const BUILTIN_CHECKS: readonly CheckDefinition[] = [
  { id: 'builtin:responsive', name: 'Responsive layout', responsive: true, widths: [1440, 768, 390] },
  { id: 'builtin:mobile', name: 'Mobile viewport stability', responsive: true, widths: [390], viewport_heights: [664, 760, 600], tolerance: 1 },
  { id: 'builtin:lint', name: 'Design lint', lint: true, widths: [1440] },
  { id: 'builtin:a11y', name: 'Accessibility', a11y: true, widths: [1440] },
];
const PREFIX = 'check:';
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('A check definition must be an object.');
  return v as Record<string, unknown>;
};
function text(v: unknown, name: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`${name} must be text, 1–${max} characters.`);
  return v.trim();
}
function keys(v: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(v).find((k) => !allowed.includes(k));
  if (extra) throw new Error(`Unknown check field: ${extra}.`);
}
function sizes(v: unknown, name: string, max: number, minItems: number): number[] {
  if (!Array.isArray(v) || v.length < minItems || v.length > 4 || v.some((n) => !Number.isInteger(n) || n < 100 || n > max)) throw new Error(`${name} needs ${minItems}–4 integer sizes between 100 and ${max}.`);
  return [...new Set(v)] as number[];
}
/** The same parser runs for editor writes, MCP writes and imported definitions. No executable code. */
export function parseCheck(value: unknown): CheckDefinition {
  const v = record(value);
  keys(v, ['id', 'name', 'description', 'extends', 'enabled', 'lint', 'a11y', 'responsive', 'widths', 'viewport_heights', 'tolerance', 'rules']);
  const id = text(v.id, 'id', 64);
  if (!ID.test(id)) throw new Error('Check ids start with a lowercase letter and use lowercase letters, digits, - and _.');
  const out: CheckDefinition = { id, name: text(v.name, 'name') };
  if (v.description !== undefined && v.description !== '') out.description = text(v.description, 'description', 2000);
  if (v.extends !== undefined && v.extends !== '') out.extends = text(v.extends, 'extends', 80);
  for (const key of ['enabled', 'lint', 'a11y', 'responsive'] as const) if (v[key] !== undefined) {
    if (typeof v[key] !== 'boolean') throw new Error(`${key} must be true or false.`);
    out[key] = v[key];
  }
  if (v.widths !== undefined) out.widths = sizes(v.widths, 'widths', 4000, 1);
  if (v.viewport_heights !== undefined) {
    out.viewport_heights = sizes(v.viewport_heights, 'viewport_heights', 1600, 2);
    if (out.viewport_heights.length < 2) throw new Error('Use at least two different viewport heights.');
  }
  if (v.tolerance !== undefined) {
    if (typeof v.tolerance !== 'number' || !Number.isFinite(v.tolerance) || v.tolerance < 0 || v.tolerance > 100) throw new Error('tolerance must be between 0 and 100 pixels.');
    out.tolerance = v.tolerance;
  }
  if (v.rules !== undefined) {
    if (!Array.isArray(v.rules) || v.rules.length > 32) throw new Error('A check can have at most 32 own rules.');
    const ids = new Set<string>();
    out.rules = v.rules.map((raw) => {
      const r = record(raw);
      keys(r, ['id', 'kind', 'selector', 'property', 'operator', 'value', 'message', 'severity', 'enabled']);
      const rid = text(r.id, 'rule id', 64);
      if (!ID.test(rid) || ids.has(rid)) throw new Error('Rule ids must be unique and use lowercase letters, digits, - and _.');
      ids.add(rid);
      if (!['style', 'attribute', 'geometry', 'count'].includes(String(r.kind))) throw new Error('Rule kind must be style, attribute, geometry or count.');
      const kind = r.kind as CheckRule['kind'];
      const operator = r.operator as CheckRule['operator'];
      const operators = kind === 'attribute' ? ['present', 'absent', 'equals', 'not-equals'] : kind === 'style' ? ['equals', 'not-equals', 'min', 'max'] : ['equals', 'min', 'max'];
      if (!operators.includes(operator)) throw new Error(`Invalid operator for ${kind}.`);
      const rule: CheckRule = { id: rid, kind, selector: text(r.selector, 'selector', 300), operator };
      if (kind !== 'count') {
        rule.property = text(r.property, 'property', 80);
        if (!/^[a-zA-Z_-][\w:-]*$/.test(rule.property)) throw new Error('Invalid property name.');
        if (kind === 'geometry' && !['width', 'height', 'top', 'left', 'right', 'bottom'].includes(rule.property)) throw new Error('Geometry property must be width, height, top, left, right or bottom.');
      }
      if (operator !== 'present' && operator !== 'absent') {
        const numeric = kind === 'count' || kind === 'geometry' || operator === 'min' || operator === 'max';
        if (numeric) {
          if (typeof r.value !== 'number' || !Number.isFinite(r.value) || Math.abs(r.value) > 1_000_000) throw new Error('This rule needs a finite numeric value.');
          rule.value = r.value;
        } else {
          if (typeof r.value !== 'string' || r.value.length > 500) throw new Error('value must be a string of at most 500 characters.');
          rule.value = r.value;
        }
      }
      if (r.message !== undefined && r.message !== '') rule.message = text(r.message, 'message', 500);
      if (r.severity !== undefined) {
        if (r.severity !== 'warning' && r.severity !== 'error') throw new Error('severity must be warning or error.');
        rule.severity = r.severity;
      }
      if (r.enabled !== undefined) {
        if (typeof r.enabled !== 'boolean') throw new Error('Rule enabled must be true or false.');
        rule.enabled = r.enabled;
      }
      return rule;
    });
  }
  return out;
}
/** Each definition is a separate meta entry: different checks merge and share the existing undo scope. */
export function getChecks(doc: BogenDoc): CheckDefinition[] {
  const checks: CheckDefinition[] = [];
  for (const [key, value] of doc.meta) if (key.startsWith(PREFIX) && typeof value === 'string') {
    try { const check = parseCheck(JSON.parse(value)); if (key === PREFIX + check.id) checks.push(check); } catch { /* Unknown or damaged imported entry. */ }
  }
  return checks.sort((a, b) => a.name.localeCompare(b.name));
}
export function resolveCheck(doc: BogenDoc, id: string, definitions = getChecks(doc)): CheckDefinition {
  const all = new Map([...BUILTIN_CHECKS, ...definitions].map((c) => [c.id, c]));
  const visit = (key: string, seen: string[]): CheckDefinition => {
    if (seen.includes(key) || seen.length >= 8) throw new Error('Check inheritance must not cycle or exceed eight levels.');
    const own = all.get(key);
    if (!own) throw new Error(`No check named ${key}.`);
    const base = own.extends ? visit(own.extends, [...seen, key]) : undefined;
    const rules = new Map((base?.rules ?? []).map((r) => [r.id, r]));
    for (const rule of own.rules ?? []) rules.set(rule.id, rule);
    if (rules.size > 64) throw new Error('An extended check can have at most 64 rules.');
    return { ...base, ...own, enabled: own.enabled !== false, rules: [...rules.values()] };
  };
  return visit(id, []);
}
export function setCheck(doc: BogenDoc, input: unknown, origin?: unknown): CheckDefinition {
  const check = parseCheck(input);
  const definitions = getChecks(doc).filter((c) => c.id !== check.id).concat(check);
  if (definitions.length > 50) throw new Error('A file can have at most 50 custom checks.');
  for (const definition of definitions) resolveCheck(doc, definition.id, definitions);
  doc.transact(() => doc.meta.set(PREFIX + check.id, JSON.stringify(check)), origin);
  return check;
}
export function deleteCheck(doc: BogenDoc, id: string, origin?: unknown): void {
  if (!ID.test(id) || !doc.meta.has(PREFIX + id)) throw new Error(`No custom check named ${id}.`);
  const dependent = getChecks(doc).find((c) => c.extends === id);
  if (dependent) throw new Error(`${dependent.name} extends this check. Change its base before deleting it.`);
  doc.transact(() => doc.meta.delete(PREFIX + id), origin);
}
