import type { BogenDoc } from './doc.ts';
import { newId } from './doc.ts';
import type { DataRecord } from './repeat.ts';

/**
 * Data sources of a file: named record lists that layers bind to. Pasted or uploaded JSON and CSV keep their
 * records here; a URL keeps the records of its last fetch too, so the design shows real data offline, on every
 * device, and in exports. Fetching is the server's job (net-guard.ts); this only holds what came back.
 */
export interface DataSource {
  id: string;
  name: string;
  kind: 'inline' | 'url';
  url?: string;
  /** Where the list is in the JSON, such as data.items. */
  path?: string;
  format?: 'json' | 'csv';
  records: DataRecord[];
  /** Field names, from the records, in the order they first appear. */
  fields: string[];
  updatedAt: number;
  /**
   * The person allowed this URL to reach this computer's own network (a dev server, a NAS). Only honoured on a
   * request from this device by a person, never for an agent or another device. See the server's data routes.
   */
  allowLocal?: boolean;
}

const MAP = 'dataSources';
export const MAX_SOURCE_RECORDS = 2000;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const SOURCE_ID = /^[a-z0-9]{4,32}$/;

function map(doc: BogenDoc) {
  return doc.y.getMap<unknown>(MAP);
}

/** Field names of records, keys of nested objects as a.b one level down. */
export function recordFields(records: DataRecord[]): string[] {
  const out: string[] = [];
  const add = (k: string) => { if (!out.includes(k)) out.push(k); };
  for (const r of records.slice(0, 200)) {
    for (const [k, v] of Object.entries(r)) {
      add(k);
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const inner of Object.keys(v as object).slice(0, 30)) add(`${k}.${inner}`);
    }
  }
  return out.slice(0, 200);
}

function read(id: string, v: unknown): DataSource | undefined {
  if (!v || typeof v !== 'object' || !SOURCE_ID.test(id)) return undefined;
  const s = v as Record<string, unknown>;
  if (typeof s.name !== 'string' || (s.kind !== 'inline' && s.kind !== 'url') || !Array.isArray(s.records)) return undefined;
  const records = (s.records as unknown[]).filter((r): r is DataRecord => !!r && typeof r === 'object' && !Array.isArray(r)).slice(0, MAX_SOURCE_RECORDS);
  return {
    id, name: s.name.slice(0, 200), kind: s.kind, records, fields: recordFields(records),
    updatedAt: Number(s.updatedAt) || 0,
    ...(typeof s.url === 'string' && s.kind === 'url' ? { url: s.url } : {}),
    ...(typeof s.path === 'string' ? { path: s.path } : {}),
    ...(s.format === 'json' || s.format === 'csv' ? { format: s.format } : {}),
    ...(s.allowLocal === true ? { allowLocal: true } : {}),
  };
}

export function listDataSources(doc: BogenDoc): DataSource[] {
  const out: DataSource[] = [];
  map(doc).forEach((v, id) => {
    const s = read(id, v);
    if (s) out.push(s);
  });
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** A source by id or by name. */
export function getDataSource(doc: BogenDoc, ref: string): DataSource | undefined {
  const direct = read(ref, map(doc).get(ref));
  if (direct) return direct;
  const lower = ref.trim().toLowerCase();
  return listDataSources(doc).find((s) => s.name.toLowerCase() === lower);
}

export interface DataSourceInput {
  id?: string;
  name: string;
  kind: 'inline' | 'url';
  url?: string;
  path?: string;
  format?: 'json' | 'csv';
  records: DataRecord[];
  allowLocal?: boolean;
}

/** Adds a source, or replaces the one with this id or name. Inside the caller's transaction. */
export function setDataSource(doc: BogenDoc, input: DataSourceInput): DataSource {
  if (!input.records.length) throw new Error('There are no records in this data.');
  if (input.records.length > MAX_SOURCE_RECORDS) throw new Error(`That is ${input.records.length} records. A data source holds at most ${MAX_SOURCE_RECORDS}.`);
  const size = JSON.stringify(input.records).length;
  if (size > MAX_SOURCE_BYTES) throw new Error(`The records weigh ${Math.round(size / 1024)} KB. A data source holds at most ${MAX_SOURCE_BYTES / 1024 / 1024} MB.`);
  const existing = input.id ? getDataSource(doc, input.id) : getDataSource(doc, input.name);
  const id = existing?.id ?? input.id ?? newId(10);
  if (!SOURCE_ID.test(id)) throw new Error(`"${id}" is not a data source id.`);
  const value = {
    name: input.name.trim().slice(0, 200) || 'Data', kind: input.kind, records: input.records, updatedAt: Date.now(),
    ...(input.kind === 'url' && input.url ? { url: input.url } : {}),
    ...(input.path ? { path: input.path } : {}),
    ...(input.format ? { format: input.format } : {}),
    ...(input.allowLocal ? { allowLocal: true } : {}),
  };
  doc.transact(() => map(doc).set(id, value));
  return read(id, value)!;
}

export function deleteDataSource(doc: BogenDoc, ref: string): boolean {
  const s = getDataSource(doc, ref);
  if (!s) return false;
  doc.transact(() => map(doc).delete(s.id));
  return true;
}
