import { t } from '../i18n/store.ts';

/** The shapes the server makes, as Codex is asked for them. */
export const IMAGE_ASPECTS = ['square', 'landscape', 'portrait', 'wide', 'tall'] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];
export const ASPECT_RATIO: Record<ImageAspect, number> = { square: 1, landscape: 3 / 2, portrait: 2 / 3, wide: 16 / 9, tall: 9 / 16 };

export type GeneratorState = 'ready' | 'missing' | 'signed-out' | 'broken';
export interface GeneratorStatus { state: GeneratorState; version?: string; message?: string }
export interface JobPicture { state: 'waiting' | 'making' | 'done' | 'failed' | 'cancelled'; src?: string; width?: number; height?: number; error?: string }
export interface ImageJob { id: string; prompt: string; aspect: ImageAspect; startedAt: number; endedAt?: number; pictures: JobPicture[] }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const out = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (!res.ok || !out) throw new Error(out?.error ?? t('Request failed with {status}', { status: res.status }));
  return out;
}

export const imageGen = {
  status: (fresh = false) => call<GeneratorStatus>(`/api/images/generate${fresh ? '?fresh=1' : ''}`),
  start: (req: { prompt: string; aspect: ImageAspect; count: number; fileId?: string }) =>
    call<{ job: ImageJob }>('/api/images/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) }).then((r) => r.job),
  job: (id: string) => call<{ job: ImageJob }>(`/api/images/generate/${id}`).then((r) => r.job),
  cancel: (id: string) => call<{ job: ImageJob }>(`/api/images/generate/${id}`, { method: 'DELETE' }).then((r) => r.job),
};

/** The shape nearest to a box, so a picture for a 1200x500 hero comes out wide. */
export function aspectFor(width: number, height: number): ImageAspect {
  if (!(width > 0) || !(height > 0)) return 'landscape';
  const r = width / height;
  let best: ImageAspect = 'square';
  for (const a of IMAGE_ASPECTS) if (Math.abs(Math.log(ASPECT_RATIO[a] / r)) < Math.abs(Math.log(ASPECT_RATIO[best] / r))) best = a;
  return best;
}
