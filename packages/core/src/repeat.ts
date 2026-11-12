import * as Y from 'yjs';
import { safeUrl } from './html-import.ts';
import type { BogenDoc, NewNode } from './doc.ts';
import { isVirtualId, setMembers } from './components.ts';
import { getDataSource } from './data-sources.ts';

/**
 * Live data: a template layer with `{{field}}` placeholders in its text, image sources, attributes and
 * styles, and one copy per record right after it. The template stays in the file, hidden, so running
 * it again replaces the copies and a flex or grid parent lays them out like any other children.
 */
export type DataRecord = Record<string, unknown>;

/**
 * Where the records come from: pasted with the repeat (`inline`), a URL of its own (`url`), or one of the file's
 * data sources (`source`, see data-sources.ts), which is how several layers share data and refresh together.
 * `record` binds one record, by index, instead of the list: a single copy, such as a profile or a detail page.
 */
export interface RepeatSource { kind: 'inline' | 'url' | 'source'; url?: string; path?: string; format?: 'json' | 'csv'; source?: string; record?: number }

/** On a layer inside a template: show it only when the field is truthy. */
export const BIND_VISIBLE = 'data-bind-visible';
/** On an instance inside a template: `axis:field` pairs, comma separated, that pick its variant from the record. */
export const BIND_VARIANT = 'data-bind-variant';

export interface RepeatBinding {
  source: RepeatSource;
  copies: string[];
  /** The records of the last run, so an inline source can run again as it is. */
  records?: DataRecord[];
}

export interface RepeatResult {
  templateId: string;
  copies: string[];
  fields: string[];
  /** Fields a placeholder asks for that some record does not have. They come out empty. */
  missing: string[];
  /** Values refused in a style or a URL. The property stays out of that copy. */
  refused: string[];
  warning?: string;
}

export const MAX_REPEAT_RECORDS = 500;
export const MAX_REPEAT_LAYERS = 8000;
const MAP_NAME = 'repeats';
const PLACEHOLDER = /\{\{\s*([\w.$-]+)\s*\}\}/g;

function bindings(doc: BogenDoc): Y.Map<unknown> {
  return doc.y.getMap(MAP_NAME);
}

export function getRepeatBinding(doc: BogenDoc, templateId: string): RepeatBinding | undefined {
  const value = bindings(doc).get(templateId);
  return value && typeof value === 'object' && Array.isArray((value as RepeatBinding).copies) ? value as RepeatBinding : undefined;
}

/** A layer that is a copy made by a repeat, and the template it came from. */
export function repeatTemplateOf(doc: BogenDoc, nodeId: string): string | undefined {
  let found: string | undefined;
  bindings(doc).forEach((value, key) => {
    if ((value as RepeatBinding | undefined)?.copies?.includes(nodeId)) found = key;
  });
  return found;
}

function lookup(record: DataRecord, path: string): unknown {
  if (path in record) return record[path];
  let current: unknown = record;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** `axis:field` pairs of a variant binding. */
export function variantBindings(value: string | undefined): { axis: string; field: string }[] {
  if (!value) return [];
  return value.split(',').flatMap((pair) => {
    const m = /^\s*([\w-]+)\s*:\s*([\w.$-]+)\s*$/.exec(pair);
    return m ? [{ axis: m[1]!, field: m[2]! }] : [];
  });
}

/** How a record's value reads as a yes or no: empty, 0, false, no and off are no. */
export function truthyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0) return false;
  if (typeof value === 'string') return !/^\s*(|0|false|no|off|null)\s*$/i.test(value);
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function placeholdersIn(spec: NewNode): string[] {
  const out = new Set<string>();
  const scan = (value: string | undefined) => {
    for (const m of value?.matchAll(PLACEHOLDER) ?? []) out.add(m[1]!);
  };
  const walk = (node: NewNode) => {
    scan(node.text);
    scan(node.src);
    scan(node.name);
    Object.values(node.style ?? {}).forEach(scan);
    for (const [k, v] of Object.entries(node.attrs ?? {})) {
      if (k === BIND_VISIBLE && /^[\w.$-]+$/.test(v.trim())) out.add(v.trim());
      else if (k === BIND_VARIANT) variantBindings(v).forEach((b) => out.add(b.field));
      else scan(v);
    }
    for (const v of Object.values(node.props ?? {})) if (typeof v === 'string') scan(v);
    node.children?.forEach(walk);
  };
  walk(spec);
  return [...out].sort();
}

/** A record's value inside CSS: it may not end the declaration, open anything or load anything. */
function safeInStyle(value: string): boolean {
  return !/[;{}<>\\]|url\s*\(|expression\s*\(|javascript:|@import|\/\*/i.test(value);
}

function fill(template: string, record: DataRecord, seen: { missing: Set<string> }): string {
  return template.replace(PLACEHOLDER, (_, field: string) => {
    const value = lookup(record, field);
    if (value === undefined) seen.missing.add(field);
    return asText(value);
  });
}

interface BindReport { missing: Set<string>; refused: Set<string> }
/** The member of an instance's variant set that a record asks for, or the instance's own main. */
type VariantPick = (instanceOf: string, wanted: Record<string, string>) => string | undefined;

function bindSpec(spec: NewNode, record: DataRecord, report: BindReport, pick?: VariantPick): NewNode {
  const out: NewNode = { ...spec };
  const visible = spec.attrs?.[BIND_VISIBLE]?.trim();
  if (visible) {
    const value = lookup(record, visible);
    if (value === undefined) report.missing.add(visible);
    if (!truthyValue(value)) out.hidden = true;
  }
  const variant = variantBindings(spec.attrs?.[BIND_VARIANT]);
  if (variant.length && spec.instanceOf && pick) {
    const wanted: Record<string, string> = {};
    for (const b of variant) {
      const value = lookup(record, b.field);
      if (value === undefined) report.missing.add(b.field);
      else wanted[b.axis] = asText(value);
    }
    const member = pick(spec.instanceOf, wanted);
    if (member) out.instanceOf = member;
    else if (Object.keys(wanted).length) report.refused.add(`variant: ${Object.entries(wanted).map(([k, v]) => `${k}=${v}`).join(', ').slice(0, 80)}`);
  }
  if (spec.props) {
    const props: NonNullable<NewNode['props']> = {};
    for (const [k, v] of Object.entries(spec.props)) props[k] = typeof v === 'string' && v.includes('{{') ? fill(v, record, report) : v;
    out.props = props;
  }
  const hasMark = (v: string | undefined) => Boolean(v && v.includes('{{'));
  if (hasMark(spec.text)) out.text = fill(spec.text!, record, report);
  if (hasMark(spec.name)) out.name = fill(spec.name!, record, report).slice(0, 200);
  if (hasMark(spec.src)) {
    const value = fill(spec.src!, record, report);
    // A record is other people's data: the same URL rules as a stored document, here as well as at render.
    if (safeUrl(value)) out.src = value;
    else {
      report.refused.add(`src: ${value.slice(0, 80)}`);
      delete out.src;
    }
  }
  if (spec.style) {
    const style: Record<string, string> = {};
    for (const [key, raw] of Object.entries(spec.style)) {
      if (!hasMark(raw)) {
        style[key] = raw;
        continue;
      }
      let unsafe = false;
      const seen = raw.replace(PLACEHOLDER, (_, field: string) => {
        const value = lookup(record, field);
        if (value === undefined) report.missing.add(field);
        const text = asText(value);
        if (!safeInStyle(text)) unsafe = true;
        return text;
      });
      if (unsafe) report.refused.add(`${key}: ${seen.slice(0, 80)}`);
      else if (seen.trim()) style[key] = seen;
    }
    out.style = style;
  }
  if (spec.attrs) {
    const attrs: Record<string, string> = {};
    for (const [key, raw] of Object.entries(spec.attrs)) {
      // A copy shows the data; what it is bound to stays on the template.
      if (key === BIND_VISIBLE || key === BIND_VARIANT) continue;
      const value = hasMark(raw) ? fill(raw, record, report) : raw;
      if ((key === 'href' || key === 'poster' || key === 'src') && hasMark(raw) && !safeUrl(value)) {
        report.refused.add(`${key}: ${value.slice(0, 80)}`);
        continue;
      }
      attrs[key] = value;
    }
    out.attrs = attrs;
  }
  if (spec.children) out.children = spec.children.map((c) => bindSpec(c, record, report, pick));
  return out;
}

function countSpec(spec: NewNode): number {
  return 1 + (spec.children ?? []).reduce((sum, c) => sum + countSpec(c), 0);
}

/**
 * Replaces the template's copies with one per record, as one transaction and so one undo step. Copies
 * sit right after the template. The template itself is hidden, which takes it out of any layout.
 */
export function applyRepeat(doc: BogenDoc, templateId: string, all: DataRecord[], source: RepeatSource, origin?: unknown): RepeatResult {
  let records = all;
  const template = doc.getNode(templateId);
  if (!template) throw new Error(`No layer with id ${templateId}.`);
  if (repeatTemplateOf(doc, templateId)) throw new Error('This layer is a copy made from a template. Run the repeat on its template instead.');
  if (!records.length) throw new Error('There are no records to repeat.');
  if (source.record !== undefined) {
    const one = records[source.record];
    if (!one) throw new Error(`There is no record ${source.record}: the data has ${records.length}, counted from 0.`);
    records = [one];
  }
  if (records.length > MAX_REPEAT_RECORDS) throw new Error(`That is ${records.length} records. A repeat makes at most ${MAX_REPEAT_RECORDS} copies.`);
  const spec = doc.toSpec(templateId);
  delete (spec as { hidden?: boolean }).hidden;
  const fields = placeholdersIn(spec);
  if (!fields.length) throw new Error('The template has no {{field}} placeholders in its text, image source, styles, attributes or props, and no bindings.');
  if (countSpec(spec) * records.length > MAX_REPEAT_LAYERS) throw new Error(`That would make ${countSpec(spec) * records.length} layers, more than the limit of ${MAX_REPEAT_LAYERS}.`);
  const report: BindReport = { missing: new Set<string>(), refused: new Set<string>() };
  const pick: VariantPick = (instanceOf, wanted) => {
    const main = doc.source.raw(instanceOf);
    const set = main?.component?.set;
    if (!set) return undefined;
    const want = { ...(main.component?.variant ?? {}), ...wanted };
    return setMembers(doc.source, set).find((m) => Object.entries(want).every(([k, v]) => m.component?.variant?.[k] === v))?.id;
  };
  const specs = records.map((record) => bindSpec(spec, record, report, pick));
  let copies: string[] = [];
  doc.transact(() => {
    const previous = getRepeatBinding(doc, templateId)?.copies ?? [];
    doc.delete(previous.filter((id) => doc.nodes.has(id)));
    const siblings = doc.getChildren(template.parent);
    const at = siblings.findIndex((s) => s.id === templateId);
    copies = doc.insertMany(template.parent, specs, at + 1);
    if (!template.hidden) doc.updateFields(templateId, { hidden: true });
    const binding: RepeatBinding = { source, copies, ...(source.kind === 'inline' ? { records: all } : {}) };
    bindings(doc).set(templateId, binding);
  }, origin);
  const parent = doc.getNode(template.parent);
  const parentDisplay = parent?.style.display ?? '';
  const flowing = /flex|grid/.test(parentDisplay);
  const absolute = template.style.position === 'absolute' || template.style.position === 'fixed';
  return {
    templateId, copies, fields,
    missing: [...report.missing].sort(),
    refused: [...report.refused],
    ...(absolute ? { warning: 'The template is positioned absolutely, so the copies sit on top of each other. Put it in a flex or grid frame and take its position off.' } : !flowing && !parent ? { warning: 'The template sits directly on the page. Copies only line up inside a flex or grid frame.' } : {}),
  };
}

/** One RFC 4180 table, header row first. */
export function parseCsv(text: string): DataRecord[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  // A sheet exported with semicolons is common here, and a comma in the header row says it is not one.
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v !== '')) rows.push(row);
  const [header, ...data] = rows;
  if (!header || !data.length) throw new Error('A table needs a header row and at least one row of data.');
  const names = header.map((h) => h.trim());
  return data.map((cells) => Object.fromEntries(names.map((name, i) => [name, cells[i] ?? ''])));
}

/** Records from text an agent or a person pasted: a JSON list, or an object with a list inside, or a table. */
export function parseRecords(text: string, options: { format?: 'json' | 'csv'; path?: string } = {}): DataRecord[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('The data is empty.');
  const format = options.format ?? (/^[[{]/.test(trimmed) ? 'json' : 'csv');
  if (format === 'csv') return parseCsv(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('The data is not valid JSON.');
  }
  return recordsFrom(parsed, options.path);
}

/** Finds the list in parsed JSON: at `path`, or the data itself, or the only list in the object. */
export function recordsFrom(data: unknown, path?: string): DataRecord[] {
  let value = data;
  if (path) {
    for (const key of path.split('.').filter(Boolean)) {
      value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    }
    if (value === undefined) throw new Error(`There is nothing at "${path}" in this data.`);
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const lists = Object.values(value).filter(Array.isArray);
    if (lists.length === 1) value = lists[0];
    else if (lists.length > 1) throw new Error(`This data has several lists. Say which one with a path, such as "${Object.entries(value).find(([, v]) => Array.isArray(v))![0]}".`);
    else value = [value];
  }
  if (!Array.isArray(value)) throw new Error('This data is not a list of records.');
  return value.map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? item as DataRecord : { value: item }));
}

/** The records a repeat's source holds now, without fetching: pasted ones, or a data source's last read. */
export function storedRecords(doc: BogenDoc, binding: RepeatBinding): DataRecord[] | undefined {
  if (binding.source.kind === 'source') return binding.source.source ? getDataSource(doc, binding.source.source)?.records : undefined;
  return binding.records;
}

/** Templates bound to a data source. */
export function repeatsOfSource(doc: BogenDoc, sourceId: string): string[] {
  const out: string[] = [];
  bindings(doc).forEach((value, key) => {
    const b = value as RepeatBinding | undefined;
    if (b?.source?.kind === 'source' && b.source.source === sourceId && doc.nodes.has(key)) out.push(key);
  });
  return out.sort();
}

/** Runs every repeat bound to a data source again from its records, as after a refresh. */
export function rerunSource(doc: BogenDoc, sourceId: string, origin?: unknown): RepeatResult[] {
  const source = getDataSource(doc, sourceId);
  if (!source) throw new Error(`No data source ${sourceId}.`);
  return repeatsOfSource(doc, source.id).map((id) => applyRepeat(doc, id, source.records, getRepeatBinding(doc, id)!.source, origin));
}

/** Every template with a repeat and where its records come from, for panels and exports. */
export function listRepeats(doc: BogenDoc): { templateId: string; binding: RepeatBinding }[] {
  const out: { templateId: string; binding: RepeatBinding }[] = [];
  bindings(doc).forEach((value, key) => {
    const b = value as RepeatBinding | undefined;
    if (b && Array.isArray(b.copies) && b.source && doc.nodes.has(key)) out.push({ templateId: key, binding: b });
  });
  return out;
}

// ---------------------------------------------------------------- binding a layer to fields

/** What a layer is bound to. A field name, or null to take the binding away. */
export interface LayerBindingPatch {
  /** The whole text becomes the field. */
  text?: string | null;
  /** An image or video source. */
  src?: string | null;
  /** Shown only when the field is truthy. */
  visible?: string | null;
  /** On an instance: the variant axis to the field that picks its value. */
  variant?: Record<string, string | null>;
  /** On an instance: a prop to a field. */
  props?: Record<string, string | null>;
  /** Attributes such as alt or href. */
  attrs?: Record<string, string | null>;
}

export interface LayerBindings {
  text?: string;
  src?: string;
  visible?: string;
  variant: Record<string, string>;
  props: Record<string, string>;
  attrs: Record<string, string>;
}

const FIELD = /^[\w.$-]{1,120}$/;
const WHOLE = /^\{\{\s*([\w.$-]+)\s*\}\}$/;
const wholeField = (v: unknown) => (typeof v === 'string' ? WHOLE.exec(v)?.[1] : undefined);

/** The fields a layer is bound to: a value that is one whole placeholder, and the bind attributes. */
export function layerBindings(doc: BogenDoc, id: string): LayerBindings {
  const n = doc.rawNode(id);
  const out: LayerBindings = { variant: {}, props: {}, attrs: {} };
  if (!n) return out;
  const text = wholeField(n.text);
  if (text) out.text = text;
  const src = wholeField(n.src);
  if (src) out.src = src;
  const visible = n.attrs?.[BIND_VISIBLE]?.trim();
  if (visible) out.visible = visible;
  for (const b of variantBindings(n.attrs?.[BIND_VARIANT])) out.variant[b.axis] = b.field;
  for (const [k, v] of Object.entries(n.props ?? {})) {
    const f = wholeField(v);
    if (f) out.props[k] = f;
  }
  for (const [k, v] of Object.entries(n.attrs ?? {})) {
    const f = k === BIND_VISIBLE || k === BIND_VARIANT ? undefined : wholeField(v);
    if (f) out.attrs[k] = f;
  }
  return out;
}

/**
 * Binds a layer of a template to fields, as `{{field}}` placeholders and the bind attributes, which is what a
 * repeat fills. Taking a text or source binding away leaves it empty for the person to fill. Inside the caller's
 * transaction or its own.
 */
export function bindLayer(doc: BogenDoc, id: string, patch: LayerBindingPatch, origin?: unknown): LayerBindings {
  if (isVirtualId(id)) throw new Error('This layer is inside an instance. Bind the instance\'s props or variant instead.');
  const n = doc.rawNode(id);
  const m = doc.nodes.get(id);
  if (!n || !m) throw new Error(`No layer with id ${id}.`);
  const check = (v: string | null | undefined, what: string) => {
    if (v !== null && v !== undefined && !FIELD.test(v)) throw new Error(`"${String(v).slice(0, 40)}" is not a field name for ${what}. Use letters, digits, _ and $, and a.b to reach inside.`);
  };
  for (const [k, v] of Object.entries({ text: patch.text, src: patch.src, visible: patch.visible })) check(v, k);
  for (const v of Object.values({ ...patch.variant, ...patch.props, ...patch.attrs })) check(v, 'that binding');
  const instance = n.instanceOf !== undefined;
  if ((patch.variant && Object.keys(patch.variant).length || patch.props && Object.keys(patch.props).length) && !instance) throw new Error('Only an instance has props and a variant to bind. Bind text, src, visible or attrs here.');
  if (patch.text !== undefined && n.type !== 'text') throw new Error(`A ${n.type} layer has no text to bind.`);
  if (patch.src !== undefined && n.type !== 'image' && n.type !== 'video') throw new Error(`A ${n.type} layer has no source to bind.`);
  const mark = (f: string) => `{{${f}}}`;
  doc.transact(() => {
    if (patch.text !== undefined) doc.updateFields(id, { text: patch.text === null ? '' : mark(patch.text), spans: [] });
    if (patch.src !== undefined) doc.updateFields(id, { src: patch.src === null ? undefined : mark(patch.src) });
    if (patch.props && Object.keys(patch.props).length) {
      // Straight on the instance: props hold strings, and a placeholder is one until the repeat fills it.
      const props = { ...(n.props ?? {}) };
      for (const [k, v] of Object.entries(patch.props)) if (v === null) delete props[k]; else props[k] = mark(v);
      m.set('props', props);
    }
    if (patch.visible !== undefined || patch.variant || patch.attrs) {
      // The instance's own attributes, not overrides of its main: they are about the copy, not what it shows.
      const attrs = { ...(n.attrs ?? {}) };
      if (patch.visible === null) delete attrs[BIND_VISIBLE];
      else if (patch.visible !== undefined) attrs[BIND_VISIBLE] = patch.visible;
      if (patch.variant) {
        const pairs = Object.fromEntries(variantBindings(attrs[BIND_VARIANT]).map((b) => [b.axis, b.field]));
        for (const [axis, field] of Object.entries(patch.variant)) if (field === null) delete pairs[axis]; else pairs[axis] = field;
        const value = Object.entries(pairs).map(([a, f]) => `${a}:${f}`).join(',');
        if (value) attrs[BIND_VARIANT] = value;
        else delete attrs[BIND_VARIANT];
      }
      for (const [k, v] of Object.entries(patch.attrs ?? {})) {
        if (!/^[a-z][\w-]{0,60}$/i.test(k) || /^on/i.test(k) || k === 'style') throw new Error(`"${k}" is not an attribute that can be bound.`);
        if (v === null) delete attrs[k]; else attrs[k] = mark(v);
      }
      if (instance) {
        if (Object.keys(attrs).length) m.set('attrs', attrs);
        else m.delete('attrs');
      } else doc.updateFields(id, { attrs: Object.keys(attrs).length ? attrs : undefined });
    }
  }, origin);
  return layerBindings(doc, id);
}

/** The template a layer belongs to: itself, or the nearest ancestor that has a repeat. */
export function templateFor(doc: BogenDoc, id: string): string | undefined {
  for (const a of [id, ...doc.ancestors(id)]) if (getRepeatBinding(doc, a)) return a;
  return undefined;
}

// ---------------------------------------------------------------- code that maps over the data

/** `item.a.b`, or `item["a b"]` where a key is no identifier. */
export function fieldAccess(item: string, field: string): string {
  return item + field.split('.').map((k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join('');
}

/** A value with {{field}} as a JavaScript expression: the field itself, a template literal, or a plain string. */
export function placeholderExpr(value: string, item: string): string {
  const whole = /^\{\{\s*([\w.$-]+)\s*\}\}$/.exec(value);
  if (whole) return fieldAccess(item, whole[1]!);
  if (!value.includes('{{')) return JSON.stringify(value);
  return `\`${value.split(PLACEHOLDER).map((part, i) => (i % 2 ? `\${${fieldAccess(item, part)}}` : part.replace(/[`\\$]/g, (c) => `\\${c}`))).join('')}\``;
}

/** Text with {{field}} as JSX children. */
export function placeholderJsx(text: string, item: string): string {
  return text.split(PLACEHOLDER).map((part, i) => {
    if (i % 2) return `{${fieldAccess(item, part)}}`;
    if (!part) return '';
    return /[{}<>&\n]/.test(part) || /^\s|\s$/.test(part) ? `{${JSON.stringify(part)}}` : part;
  }).join('');
}

/** What code export needs about the repeats in a file: copies to leave out, and templates to map. */
export interface RepeatPlan {
  copies: Set<string>;
  templates: Map<string, { list: string; single: boolean; records: DataRecord[]; source: RepeatSource; sourceName?: string }>;
}

function camelName(name: string, fallback: string): string {
  const parts = name.replace(/[^\w\s-]/g, ' ').split(/[\s_-]+/).filter(Boolean);
  const out = parts.map((p, i) => (i ? p[0]!.toUpperCase() + p.slice(1) : p[0]!.toLowerCase() + p.slice(1))).join('');
  return /^[a-zA-Z_$][\w$]*$/.test(out) && !['default', 'class', 'function', 'item', 'React'].includes(out) ? out : fallback;
}

export function repeatPlan(doc: BogenDoc): RepeatPlan {
  const plan: RepeatPlan = { copies: new Set(), templates: new Map() };
  const used = new Set<string>();
  for (const { templateId, binding } of listRepeats(doc)) {
    binding.copies.forEach((c) => plan.copies.add(c));
    const records = storedRecords(doc, binding) ?? [];
    const sourceName = binding.source.kind === 'source' && binding.source.source ? getDataSource(doc, binding.source.source)?.name : undefined;
    const single = binding.source.record !== undefined;
    let list = camelName(sourceName ?? doc.getNode(templateId)?.name ?? '', single ? 'record' : 'records');
    if (!single && !/s$/.test(list)) list = `${list}Records`;
    let name = list;
    for (let i = 2; used.has(name); i++) name = `${list}${i}`;
    used.add(name);
    plan.templates.set(templateId, { list: name, single, records, source: binding.source, ...(sourceName ? { sourceName } : {}) });
  }
  return plan;
}

const EXPORT_RECORDS = 50;

/** `const products = [...]` for the templates a piece of code maps over. */
export function dataDeclarations(plan: RepeatPlan, used: Iterable<string>): string {
  const out: string[] = [];
  for (const id of new Set(used)) {
    const t = plan.templates.get(id);
    if (!t) continue;
    const from = t.source.kind === 'url' ? ` from ${t.source.url}` : t.sourceName ? ` from the data source "${t.sourceName}"` : '';
    if (t.single) {
      const one = t.records[t.source.record ?? 0] ?? {};
      out.push(`// The record this design shows${from}.\nconst ${t.list} = ${JSON.stringify(one, null, 2)};`);
      continue;
    }
    const shown = t.records.slice(0, EXPORT_RECORDS);
    const more = t.records.length > shown.length ? ` The first ${shown.length} of ${t.records.length}.` : '';
    out.push(`// The records this design shows${from}, as Bogen last read them.${more} Load them in your app.\nconst ${t.list} = ${JSON.stringify(shown, null, 2)};`);
  }
  return out.join('\n\n');
}
