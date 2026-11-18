import { currentLanguage, t } from '../i18n/store.ts';

export type Reviewer = 'auto' | 'fable' | 'opus' | 'sonnet';
export interface CritiqueStatus { state: 'ready' | 'missing'; message?: string }
export type CritiqueStep = 'queued' | 'rules' | 'pictures' | 'reviewer' | 'writing';
/** A review as the server reports it (critique-run.ts): the real stage, never an estimate. */
export interface CritiqueJob {
  id: string; fileId: string; state: 'running' | 'done' | 'failed' | 'stopped'; step?: CritiqueStep; stepAt?: Partial<Record<CritiqueStep, number>>; reviewer?: string;
  screens: number; screenIds?: string[]; rendered?: number; sizes?: { width: number; height: number }[]; ruleFindings?: number; written?: { defects: number; taste: number };
  startedAt: number; endedAt?: number; recordId?: string; score?: number; defects?: number; next?: string; note?: string; error?: string;
}
export interface CritiqueStart { fileId: string; screens?: string[]; pageId?: string; flow?: boolean; reviewer: Reviewer; series?: string; until?: number; maxRounds?: number; replyLanguage?: string }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const out = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (!res.ok || !out) throw new Error(out?.error ?? t('Request failed with {status}', { status: res.status }));
  return out;
}

export const critiqueApi = {
  status: () => call<CritiqueStatus>('/api/critique'),
  start: (req: CritiqueStart) =>
    call<{ job: CritiqueJob }>('/api/critique', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replyLanguage: currentLanguage(), ...req }) }).then((r) => r.job),
  job: (id: string) => call<{ job: CritiqueJob }>(`/api/critique/${id}`).then((r) => r.job),
  cancel: (id: string) => call<{ job: CritiqueJob }>(`/api/critique/${id}`, { method: 'DELETE' }).then((r) => r.job),
  /** The picture of screen n (1-based) as the reviewer got it, while the job is kept. */
  picture: (jobId: string, n: number) => `/api/critique/${jobId}/screens/${n}`,
  /** A small picture of an artboard as it is now, for a review whose own pictures are gone. */
  shot: (fileId: string, nodeId: string) => `/api/critique/shot/${fileId}/${encodeURIComponent(nodeId)}`,
};
