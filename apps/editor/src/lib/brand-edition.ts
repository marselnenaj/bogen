import type { EditionPart } from '@bogen/core';
import { t } from '../i18n/store.ts';
import { msg } from '../i18n/core.ts';
import { rememberChatOpen } from '../panels/chat-state.ts';
import { putActivity } from './activity.ts';
import { api } from './api.ts';
import { continueConversation } from './conversation.ts';
import { chatAgent } from './critique-flow.ts';
import { onServerEvent } from './events.ts';

/**
 * A designed edition of a brand book (brand-edition.ts on the server): an agent art-directs the guidelines as pages
 * in a new file, on the person's plan, with the agent and model their chat uses. It shows in that file's chat and as
 * a pill in the activity dock; the brand page says that it exists and what changed in the brand since.
 */

export interface EditionStatus {
  file_id: string; file_name: string; page_id: string; at: number;
  parts: Record<EditionPart, string>; changed: EditionPart[];
  running: boolean; run_id?: string; refreshing?: boolean;
}
interface Started { file_id: string; file_name?: string; run_id: string; conversation_id: string }

/** The parts of a brand as the brand page names them. */
export const PART_LABELS: Record<EditionPart, string> = {
  identity: msg('Idea and positioning'), logo: msg('Logo'), colour: msg('Colour'), type: msg('Type'), layout: msg('Layout and space'),
  voice: msg('Voice'), imagery: msg('Imagery'), applications: msg('Applications'), rules: msg('Rules'),
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const detail = await res.json().then((b: { error?: string }) => b.error).catch(() => null);
    throw new Error(detail ?? t('{method} {path} failed with {status}', { method: init?.method ?? 'GET', path, status: res.status }));
  }
  return (await res.json()) as T;
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const editionApi = {
  status: (brandId: string) => json<{ edition: EditionStatus | null }>(`/api/brands/${brandId}/designed-edition`).then((r) => r.edition),
  create: (brandId: string, body: { runner: string; model?: string; effort?: string; by?: string }) => json<Started & { file_name: string }>(`/api/brands/${brandId}/designed-edition`, post(body)),
  refresh: (brandId: string, body: { runner: string; model?: string; effort?: string; by?: string }) => json<Started>(`/api/brands/${brandId}/designed-edition/refresh`, post(body)),
};

/** The agent the chat uses, as the button says it, or null when none is set up. */
export async function editionAgent(): Promise<{ runner: string; label: string; model?: string; effort?: string } | null> {
  return chatAgent();
}

/**
 * Makes a designed edition, or refreshes the one there is, and goes to its file: the chat there shows the run, and
 * the dock keeps a pill for it wherever the person goes.
 */
export async function startEdition(input: { brandId: string; brandName: string; by: string; refresh?: boolean; fileName?: string }): Promise<void> {
  const agent = await editionAgent();
  if (!agent) throw new Error(t('Install {claude} or {codex} to design a brand book.', { claude: 'claude', codex: 'codex' }));
  const body = { runner: agent.runner, ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}), by: input.by };
  const out = input.refresh ? await editionApi.refresh(input.brandId, body) : await editionApi.create(input.brandId, body);
  continueConversation(out.file_id, out.conversation_id);
  rememberChatOpen(out.file_id, true);
  follow({ runId: out.run_id, fileId: out.file_id, fileName: out.file_name ?? input.fileName ?? '', brand: input.brandName, agent: agent.label, refresh: Boolean(input.refresh) });
  location.hash = `#/file/${out.file_id}`;
}

/** The run's pill in the dock, kept current from the server's events until it ends. */
function follow(run: { runId: string; fileId: string; fileName: string; brand: string; agent: string; refresh: boolean }): void {
  const id = `edition:${run.runId}`;
  const startedAt = Date.now();
  const open = () => { location.hash = `#/file/${run.fileId}`; };
  putActivity({
    id, kind: 'brand', state: 'running', startedAt, open,
    title: run.refresh ? t('Refreshing the {brand} brand book', { brand: run.brand }) : t('Designing the {brand} brand book', { brand: run.brand }),
    detail: [run.agent, run.fileName].filter(Boolean).join(' · '),
    stop: () => void api.stopRun(run.runId), stopLabel: t('Stop the agent'),
  });
  const off = onServerEvent((e) => {
    if (e.t !== 'agent' || e.runId !== run.runId || (e.kind !== 'done' && e.kind !== 'error')) return;
    off();
    const stopped = e.kind === 'done' && e.text === 'Stopped.';
    putActivity({
      id, kind: 'brand', state: e.kind === 'error' ? 'failed' : stopped ? 'stopped' : 'done', startedAt, endedAt: Date.now(), open,
      title: e.kind === 'error' ? t('The brand book run did not finish') : stopped ? t('Stopped. What it made so far stays in the file.') : t('The {brand} brand book is designed', { brand: run.brand }),
      detail: e.kind === 'error' && e.text ? e.text.slice(0, 200) : run.fileName,
    });
  });
}
