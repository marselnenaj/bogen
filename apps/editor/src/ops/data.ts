import { useEffect, useState } from 'react';
import { getDataSource, listDataSources, parseRecords, rerunSource, setDataSource, type DataRecord, type DataSource, type RepeatResult } from '@bogen/core';
import { session } from '../doc/session.ts';
import { t } from '../i18n/store.ts';

/**
 * The file's data sources, for the Data panel and the inspector. Records live in the document; this fetches URLs
 * through the server, which guards them, and keeps which sources this person allowed to reach this computer's
 * own network. That permission stays on this device: a flag that came in with the file from elsewhere is not one.
 */
const LOCAL_KEY = 'bogen.data.allowLocal';

function allowedHere(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function rememberAllowed(id: string, on: boolean): void {
  const all = allowedHere();
  if (on) all.add(id);
  else all.delete(id);
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify([...all].slice(-200)));
  } catch { /* private mode: it is asked again */ }
}

/** Sources of the open file, following every change to them. */
export function useDataSources(): DataSource[] {
  const { doc } = session();
  const [list, setList] = useState(() => listDataSources(doc));
  useEffect(() => {
    const map = doc.y.getMap('dataSources');
    const update = () => setList(listDataSources(doc));
    map.observe(update);
    update();
    return () => map.unobserve(update);
  }, [doc]);
  return list;
}

export async function fetchRecords(url: string, options: { path?: string; format?: 'json' | 'csv'; allowLocal?: boolean } = {}): Promise<DataRecord[]> {
  const res = await fetch('/api/data/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, ...(options.path ? { path: options.path } : {}), ...(options.format ? { format: options.format } : {}), ...(options.allowLocal ? { allowLocal: true } : {}) }) });
  const body = await res.json().catch(() => ({})) as { records?: DataRecord[]; error?: string };
  if (!res.ok || !body.records) throw new Error(body.error ?? t('Fetching failed with {status}.', { status: res.status }));
  return body.records;
}

export interface SourceInput { name: string; text?: string; url?: string; path?: string; allowLocal?: boolean }

/** Adds a source, or replaces the one of this name, and runs its templates again. One undo step. */
export async function addSource(input: SourceInput): Promise<{ source: DataSource; reran: RepeatResult[] }> {
  const s = session();
  const path = input.path?.trim() || undefined;
  let records: DataRecord[];
  if (input.url) records = await fetchRecords(input.url, { path, allowLocal: input.allowLocal });
  else if (input.text?.trim()) records = parseRecords(input.text, { path });
  else throw new Error(t('Paste some data, upload a file, or give an address.'));
  const format = input.url ? undefined : /^\s*[[{]/.test(input.text!) ? 'json' as const : 'csv' as const;
  return s.tx(() => {
    const source = setDataSource(s.doc, { name: input.name.trim() || 'Data', kind: input.url ? 'url' : 'inline', ...(input.url ? { url: input.url } : {}), ...(path ? { path } : {}), ...(format ? { format } : {}), records, ...(input.url && input.allowLocal ? { allowLocal: true } : {}) });
    if (source.allowLocal) rememberAllowed(source.id, true);
    return { source, reran: rerunSource(s.doc, source.id) };
  });
}

/** Fetches a URL source again, then runs every template bound to it. A pasted source just runs them again. */
export async function refreshSource(id: string): Promise<RepeatResult[]> {
  const s = session();
  const source = getDataSource(s.doc, id);
  if (!source) throw new Error(t('That data source is gone.'));
  let records = source.records;
  if (source.kind === 'url' && source.url) {
    const local = Boolean(source.allowLocal) && allowedHere().has(source.id);
    records = await fetchRecords(source.url, { path: source.path, format: source.format, allowLocal: local });
  }
  return s.tx(() => {
    if (source.kind === 'url') setDataSource(s.doc, { id: source.id, name: source.name, kind: 'url', url: source.url, path: source.path, format: source.format, records, ...(source.allowLocal ? { allowLocal: true } : {}) });
    return rerunSource(s.doc, source.id);
  });
}

/** When the records were read, in words. */
export function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

export function sourceOrigin(source: DataSource): string {
  if (source.kind === 'url' && source.url) {
    try {
      return `from ${new URL(source.url).host}`;
    } catch {
      return 'from a URL';
    }
  }
  return source.format === 'csv' ? 'pasted CSV' : 'pasted';
}
