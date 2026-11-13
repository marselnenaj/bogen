import type { DesignContent, EditLocation, PlanOp, ReplayRect, ReplayStepInfo, RevertConflict } from '@bogen/core';
import { t } from '../i18n/store.ts';

/** Timeline, commits, comparing and branches. Same server contract as `api.ts`, kept apart by subject. */
export type ChangeRow = {
  row: 'change';
  id: string;
  at: number;
  source: 'person' | 'agent' | 'peer' | 'system';
  actor: string;
  tool?: string;
  run?: string;
  summary: string;
  layers: string[];
  layerCount: number;
  locations?: EditLocation[];
  fields?: string[];
  deviceName: string;
  device: string;
  thinned?: boolean;
  revertable: boolean;
  revertedBy?: string;
  revertOf?: string[];
  restoreOf?: string;
};

export type CommitRow = {
  row: 'commit';
  id: string;
  at: number;
  kind: 'commit' | 'run' | 'restore' | 'auto';
  message?: string;
  author?: string;
  deviceName?: string;
  run?: string;
  layers: number;
  pages: number;
  bytes: number;
};

export type HistoryRow = ChangeRow | CommitRow;

export interface RevertPlanAnswer {
  ops: PlanOp[];
  conflicts: RevertConflict[];
  reverted: number;
  unchanged: number;
  layers: string[];
  clean: boolean;
  changes: string[];
}

export interface CommitDiff {
  same: boolean;
  from: string;
  to: string;
  counts: { added: number; removed: number; changed: number };
  pages: { added: string[]; removed: string[]; renamed: { from: string; to: string }[]; reordered: boolean };
  layers: { page: string; added: string[]; removed: string[]; changed: { id: string; name: string; fields: string[] }[] }[];
  tokens: { added: string[]; removed: string[]; changed: string[] };
  comments: { added: number; removed: number; changed: number };
  assets: { added: string[]; removed: string[] };
  fonts: { added: string[]; removed: string[] };
  changedPages: { id: string; name: string; inFrom: boolean; inTo: boolean }[];
}

export interface VisualDiff { percent: number | null; before: string | null; after: string | null; diff: string | null }
export interface BranchRow { id: string; name: string; at: number; exists: boolean }

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(t('{path} answered {status}.', { path, status: res.status }));
  }
  if (!res.ok) throw new Error((body as { error?: string }).error ?? t('{path} answered {status}.', { path, status: res.status }));
  return body as T;
}

const post = (data: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

/** A replay as the server rebuilt it: see packages/server/src/replay.ts. */
export interface ReplayPlan {
  id: string;
  fileId: string;
  pageId: string;
  pageName: string;
  steps: ReplayStepInfo[];
  shots: (ReplayRect | null)[];
  frame: ReplayRect;
  scale: number;
  notes: string[];
  colors: Record<string, string>;
}

export interface ReplayExportOptions {
  pageId: string;
  format: 'mp4' | 'webm' | 'gif';
  speed: number;
  maxIdleMs: number;
  width: number;
  height: number;
  captions: boolean;
  cursors: boolean;
  camera: 'auto' | 'fit' | 'grow' | 'follow';
  fromStep?: number;
  toStep?: number;
}

/** Rebuilds the replay of a page, saying how far it got as it renders. */
async function replay(fileId: string, pageId: string, onProgress: (done: number, total: number) => void, signal?: AbortSignal): Promise<ReplayPlan> {
  const res = await fetch(`/api/files/${fileId}/replay`, { ...post({ pageId }), signal });
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? t('The replay answered {status}.', { status: res.status }));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const event = JSON.parse(line) as { t: string; done?: number; total?: number; replay?: ReplayPlan; error?: string };
      if (event.t === 'progress') onProgress(event.done ?? 0, event.total ?? 0);
      else if (event.t === 'done' && event.replay) return event.replay;
      else if (event.t === 'error') throw new Error(event.error ?? t('The replay failed.'));
    }
    if (done) throw new Error(t('The replay stopped before it was ready.'));
  }
}

async function replayExport(fileId: string, options: ReplayExportOptions): Promise<{ blob: Blob; name: string }> {
  const res = await fetch(`/api/files/${fileId}/replay/export`, post(options));
  if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? t('The export answered {status}.', { status: res.status }));
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `replay.${options.format}`;
  return { blob: await res.blob(), name };
}

export const history = {
  replay,
  replayExport,
  replayShot: (fileId: string, replayId: string, index: number) => `/api/files/${fileId}/replay/${replayId}/shot/${index}`,
  list: (fileId: string, limit = 300) => json<HistoryRow[]>(`/api/files/${fileId}/timeline?limit=${limit}`),
  commit: (fileId: string, message: string, author: string, kind: 'commit' | 'restore' = 'commit') => json<{ id: string }>(`/api/files/${fileId}/commits`, post({ message, author, kind })),
  content: (fileId: string, id: string) => json<DesignContent>(`/api/files/${fileId}/commits/${id}`),
  plan: (fileId: string, query: { ids?: string[]; run?: string }) => json<RevertPlanAnswer>(`/api/files/${fileId}/changes/plan`, post(query)),
  diff: (fileId: string, from: string, to: string) => json<CommitDiff>(`/api/files/${fileId}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  render: (fileId: string, from: string, to: string, page: string, screen?: string) => json<VisualDiff>(`/api/files/${fileId}/compare/render?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&page=${encodeURIComponent(page)}${screen ? `&screen=${encodeURIComponent(screen)}` : ''}`),
  /** Two layers of the live file, such as a proposal and its original. */
  layers: (fileId: string, a: string, b: string) => json<VisualDiff>(`/api/files/${fileId}/compare/layers?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
  branches: (fileId: string) => json<BranchRow[]>(`/api/files/${fileId}/branches`),
  branch: (fileId: string, name: string) => json<BranchRow>(`/api/files/${fileId}/branches`, post({ name })),
  merge: (fileId: string, branchId: string, author: string) => json<{ delta: { added: number; removed: number; changed: number } }>(`/api/files/${fileId}/branches/${branchId}/merge`, post({ author })),
  discard: (fileId: string, branchId: string) => json<{ ok: boolean }>(`/api/files/${fileId}/branches/${branchId}`, { method: 'DELETE' }),
};
