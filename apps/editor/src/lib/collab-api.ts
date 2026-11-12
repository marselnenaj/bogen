/** The parts of the API for working with agents next to people: the queue, undoing a run, what a run changed, other devices, the check. */
import { t } from '../i18n/store.ts';

export interface QueueRow {
  kind: 'running' | 'comment' | 'race';
  id: string;
  fileId: string;
  fileName: string;
  runner: string;
  agent?: string;
  title: string;
  at: number;
  source?: string;
  threadId?: string;
  runId?: string;
  tool?: string;
  reason?: string;
  /** Set for a run on another device: its name. */
  device?: string;
}
export interface RunQueueView { limit: number; running: QueueRow[]; queued: QueueRow[] }

export interface RevertConflict { what: string; field?: string; reason: string; now?: unknown; wanted?: unknown }
export interface UndoRunAnswer { reverted: number; clean: boolean; conflicts: RevertConflict[]; changes: string[] }

/** What a run changed, for its reply: the layers, and a picture of before and after when something visible changed. */
export interface RunSummary {
  runId: string;
  status: 'running' | 'done' | 'failed' | 'stopped' | 'interrupted';
  pageId?: string;
  layers: { id: string; name: string; gone?: boolean }[];
  shots?: { nodeId: string; before: boolean; after: boolean };
  undone?: { at: number; by: string };
}

/** A paired device that lets this one ask its agents. */
export interface RemoteRunner { deviceId: string; device: string; allowed: boolean; runners: { id: string; available: boolean; version?: string }[] }

export interface CheckCase { name: 'polite' | 'question' | 'memory'; ok: boolean; changed?: boolean; answered?: boolean; remembered?: boolean; nudged?: boolean; reply?: string; detail: string; seconds: number; error?: string }
export interface CheckRunner { runner: string; model?: string; available: boolean; version?: string; cases: CheckCase[]; error?: string }
export interface AgentsCheck { id: string; status: 'running' | 'done' | 'failed'; startedAt: number; endedAt?: number; runners: CheckRunner[]; error?: string }

async function asJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Reported below.
  }
  if (!res.ok) throw new Error((parsed as { error?: string } | null)?.error ?? t('The server answered {status}.', { status: res.status }));
  return parsed as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const collabApi = {
  queue: async () => asJson<RunQueueView>(await fetch('/api/runs/queue')),
  moveQueued: async (id: string, to: number) => asJson<RunQueueView>(await fetch('/api/runs/queue/move', post({ id, to }))),
  cancelQueued: async (id: string, who: string) => asJson<RunQueueView>(await fetch('/api/runs/queue/cancel', post({ id, who }))),
  stopRun: async (runId: string) => asJson<{ ok: boolean }>(await fetch(`/api/runs/${runId}/stop`, post({}))),
  undoRun: async (fileId: string, runId: string, who: string) => asJson<UndoRunAnswer>(await fetch(`/api/runs/${runId}/undo`, post({ fileId, who }))),
  summary: async (fileId: string, runId: string) => asJson<RunSummary>(await fetch(`/api/runs/${runId}/summary?fileId=${encodeURIComponent(fileId)}`)),
  shot: (fileId: string, runId: string, which: 'before' | 'after') => `/api/runs/${runId}/shot?fileId=${encodeURIComponent(fileId)}&which=${which}`,
  remoteRunners: async () => asJson<RemoteRunner[]>(await fetch('/api/runs/remote')),
  startCheck: async (body: { runners?: string[]; model?: string } = {}) => asJson<AgentsCheck>(await fetch('/api/agents/check', post(body))),
  check: async (id: string) => asJson<AgentsCheck>(await fetch(`/api/agents/check/${id}`)),
  lastCheck: async () => asJson<AgentsCheck | null>(await fetch('/api/agents/check')),
};
