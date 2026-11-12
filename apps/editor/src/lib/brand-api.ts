import type { BrandData } from '@bogen/core';
import { t } from '../i18n/store.ts';

/** REST client for brands. See "Brand" in docs/SPEC.md. */

export interface BrandListItem { id: string; name: string; updatedAt: number; positioning: string; colors: string[]; isDefault: boolean; linkedFiles: number; version: number; suggestions: number; draft: boolean }
export interface BrandFull { id: string; name: string; data: BrandData; counts: { suggestions: number; flagged: number }; linkedFiles: { id: string; name: string }[]; versions: { id: string; n: number; at: number; by: string; note: string }[]; draftChanges: number; /** The brand this one was duplicated from, as it was then. */ duplicatedFrom?: { id: string; name: string; version: number; at: number } | null }
export interface BrandFix { description: string; safe: boolean; block?: string }
export interface BrandViolation { rule: string; category: string; severity: 'hard' | 'soft'; node_id: string; layer: string; message: string; rule_text?: string; fix: BrandFix }
export interface BrandLever { kind: 'rule' | 'quality'; key: string; category?: string; label: string; gain: number; safe?: number; node_ids: string[]; how: string }
export interface BrandScore {
  value: number;
  formula: string;
  categories: { category: string; weight: number; checked: number; failed: number; score: number; node_ids: string[] }[];
  conformance: number;
  quality?: number;
  quality_parts: { dimension: string; weight: number; score: number; basis: string; how?: string; node_ids?: string[] }[];
  raise: BrandLever[];
  hard_violations: number;
  hard_penalty: number;
}
export interface ScorePoint { at: number; score: number; hard: number; soft: number; layers: number; by: string }
export interface BrandScores { summary: { at: number; score: number; files: number; hard: number; soft: number }[]; files: { file_id: string; file_name: string; points: ScorePoint[] }[] }
export interface Trend { last: number; previous?: number; first?: number; change?: number; since?: number }
export interface BrandDrift {
  brand_id: string;
  brand_name: string;
  at: number;
  summary: number | null;
  files: { file_id: string; file_name: string; score: number | null; hard: number; soft: number; layers: number; worst: { node_id: string; layer: string; page: string; hard: number; soft: number; rules: string[]; first: string }[]; trend: Trend | null; top?: { label: string; gain: number }[] }[];
  trend: Trend | null;
  history: { at: number; score: number }[];
}
export interface BrandReport {
  /** This file's whole-file scores so far, oldest first. */
  history?: { at: number; score: number }[];
  mode: string;
  score: BrandScore;
  counts: { hard: number; soft: number; waived: number; layers: number };
  violations: BrandViolation[];
  waived: { node_id: string; rule: string; reason: string; by: string }[];
  checklist: { rule_id: string; text: string; severity: 'hard' | 'soft'; topic: string; how: string }[];
  not_checked: string[];
  fixed?: { node_id: string; rule: string; what: string }[];
}
export interface FileBrand {
  link: { id: string; version: string } | null;
  note: { id: string; name?: string; version?: number; missing?: boolean; summary: string } | null;
  version: number | null;
  linkedVersion: number | null;
  updateAvailable: boolean;
  waivers: { nodeId: string; rule: string; reason: string; by: string; at: number }[];
  /** The brand's primary language, when it sets one, as a tag. Older servers leave it out. */
  language?: string | null;
  /** All the languages the brand speaks, the primary first. Older servers leave it out. */
  languages?: string[];
}
export interface FileImpact { file_id: string; file_name: string; from_version: number | null; layer_count: number; layers: { id: string; name: string; prop: string; from: string; to: string }[]; tokens: { name: string; from: string | null; to: string }[] }
export interface BrandChange { section: string; id: string; name: string; kind: 'added' | 'removed' | 'changed'; fields?: { field: string; from: unknown; to: unknown }[] }

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const detail = await res.json().then((b: { error?: string }) => b.error).catch(() => null);
    throw new Error(detail ?? t('{method} {path} failed with {status}', { method: init?.method ?? 'GET', path, status: res.status }));
  }
  return (await res.json()) as T;
}

const send = (method: string, data?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) });

export const brandApi = {
  list: () => json<BrandListItem[]>('/api/brands'),
  create: (name: string, by?: string) => json<{ id: string; name: string }>('/api/brands', send('POST', { name, by })),
  get: (id: string) => json<BrandFull>(`/api/brands/${id}`),
  rename: (id: string, name: string) => json(`/api/brands/${id}`, send('PATCH', { name })),
  duplicate: (id: string) => json<{ id: string; name: string }>(`/api/brands/${id}/duplicate`, { method: 'POST' }),
  remove: (id: string) => json(`/api/brands/${id}`, { method: 'DELETE' }),
  setDefault: (brandId: string | null) => json('/api/brands/default', send('PUT', { brandId })),
  publish: (id: string, note: string, by: string) => json<{ n: number }>(`/api/brands/${id}/versions`, send('POST', { note, by })),
  diff: (id: string, from: string, to = 'current') => json<{ from: number | string; to: number | string; changes: BrandChange[] }>(`/api/brands/${id}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  impact: (id: string) => json<{ draft_changes: number; files: FileImpact[] }>(`/api/brands/${id}/impact`),
  apply: (id: string, by: string, fileIds?: string[]) => json<{ version: number; files: { file_id: string; file_name: string; layers: number; tokens: number }[] }>(`/api/brands/${id}/apply`, send('POST', { by, ...(fileIds ? { fileIds } : {}) })),
  systemFile: (id: string) => json<{ file_id: string }>(`/api/brands/${id}/system-file`, send('POST')),
  useTemplate: (id: string, template: string, fileId?: string) => json<{ file_id: string; page_id: string; boards: { id: string; name: string }[]; gaps: string[]; slots: { id: string; board: string; name: string; hint: string }[] }>(`/api/brands/${id}/template`, send('POST', { template, ...(fileId ? { fileId } : {}) })),
  drift: (id: string, by: string) => json<BrandDrift>(`/api/brands/${id}/drift`, send('POST', { by })),
  scores: (id: string) => json<BrandScores>(`/api/brands/${id}/scores`),
  ofFile: (fileId: string) => json<FileBrand>(`/api/files/${fileId}/brand`),
  link: (fileId: string, brandId: string | null) => json(`/api/files/${fileId}/brand`, send('PUT', { brandId })),
  check: (fileId: string, body: { mode?: 'rendered' | 'static'; fix?: boolean; nodeId?: string; pageId?: string }) => json<BrandReport>(`/api/files/${fileId}/brand/check`, send('POST', body)),
  waive: (fileId: string, body: { nodeId: string; rule: string; reason: string; by: string }) => json<{ waivers: FileBrand['waivers'] }>(`/api/files/${fileId}/brand/waivers`, send('POST', body)),
  unwaive: (fileId: string, body: { nodeId: string; rule: string }) => json<{ waivers: FileBrand['waivers'] }>(`/api/files/${fileId}/brand/waivers`, send('DELETE', body)),
};
