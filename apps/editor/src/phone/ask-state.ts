import { create } from 'zustand';
import type { RunnerId } from '@bogen/core';
import { api } from '../lib/api.ts';
import { conversationFor, conversationTurns, startConversation } from '../lib/conversation.ts';
import { onServerEvent } from '../lib/events.ts';
import { loadInbox, type InboxItem } from './phone-api.ts';
import { msg } from '../i18n/core.ts';
import { t } from '../i18n/store.ts';

/**
 * The Ask thread on the phone: the person's messages and the agent's answers, for one file. Each message
 * starts an ordinary run on the computer, the same as the prompt bar there, asked to make proposals so that
 * the answer can be accepted or discarded right here. The thread is a conversation the server keeps, so each
 * run knows the turns before it, and the thread is there again after a reload.
 */

export type AskMessage =
  | { role: 'user'; text: string; photo?: string }
  | { role: 'agent'; text: string; runId: string; runner: string; done: boolean; proposals: Extract<InboxItem, { kind: 'proposal' }>[]; score?: number; error?: string };

interface AskState {
  fileId: string | null;
  /** The chat on the server that the thread is. */
  conversationId: string | null;
  runner: RunnerId;
  /** Layers the question is about, from a proposal or a selection. */
  nodeIds: string[];
  messages: AskMessage[];
  runId: string | null;
  startedAt: number;
  /** What the agent did so far, in words, for the watching screen. */
  steps: string[];
  /** Said while the agent works. It goes out when the run ends. */
  queued: string | null;
  set: (patch: Partial<AskState>) => void;
}

export const useAsk = create<AskState>((set) => ({
  fileId: null, conversationId: null, runner: 'claude', nodeIds: [], messages: [], runId: null, startedAt: 0, steps: [], queued: null,
  set: (patch) => set(patch),
}));

const ask = () => useAsk.getState();

/**
 * A new subject. Another file brings up that file's chat; a proposal or a selection in the same file only
 * changes what the next message is about, and the conversation goes on.
 */
export function askAbout(fileId: string, nodeIds: string[] = []): void {
  const state = ask();
  if (state.fileId === fileId) {
    if (state.nodeIds.join() !== nodeIds.join()) state.set({ nodeIds });
    return;
  }
  if (state.runId) return state.set({ queued: null });
  const conversationId = conversationFor(fileId);
  state.set({ fileId, conversationId, nodeIds, messages: [], steps: [], queued: null });
  void restore(fileId, conversationId);
}

/** Starts over: a new conversation, and an agent that knows nothing of the one before. */
export function newAsk(): void {
  const state = ask();
  if (!state.fileId || state.runId) return;
  state.set({ conversationId: startConversation(state.fileId), messages: [], steps: [], queued: null });
}

/** What was said in this file's chat, from the server, for a thread opened again. */
async function restore(fileId: string, conversationId: string): Promise<void> {
  const turns = await conversationTurns(fileId, conversationId);
  const state = ask();
  if (!turns.length || state.conversationId !== conversationId || state.messages.length) return;
  state.set({
    messages: turns.flatMap((turn): AskMessage[] => [
      { role: 'user', text: turn.message },
      { role: 'agent', text: turn.reply ?? '', runId: turn.runId, runner: turn.runner, done: turn.status !== 'running', proposals: [], ...(turn.status === 'failed' ? { error: t('The run failed.') } : turn.status === 'interrupted' ? { error: t('The run was cut off.') } : {}) },
    ]),
  });
}

/** Tool names, as a person would say what happened. */
const STEP_WORDS: Record<string, string> = {
  brand_get: msg('Read the brand'), brand_check: msg('Checked the brand'), file_open: msg('Opened the file'), context_get: msg('Looked at the file'), layer_tree: msg('Read the layers'),
  screenshot: msg('Looked at it'), canvas_screenshot: msg('Looked at it'), html_write: msg('Wrote layers'), html_read: msg('Read layers'), style_set: msg('Changed styles'), layers_style: msg('Changed styles'),
  text_set: msg('Changed text'), proposal_create: msg('Made a proposal'), responsive_check: msg('Checked other widths'), design_lint: msg('Checked the design'), artboard_create: msg('Made an artboard'),
  tokens_get: msg('Read the tokens'), tokens_set: msg('Changed tokens'), layer_delete: msg('Removed layers'), batch: msg('Made several changes'), comment_reply: msg('Answered a comment'), view_focus: msg('Showed you something'),
};

export function stepWords(tool: string): string {
  const name = tool.replace(/^mcp__bogen__|^bogen_run_[A-Za-z0-9]+_/, '');
  const words = STEP_WORDS[name];
  return words ? t(words) : name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** A message, with a photo from the phone the agent sees with it: `src` is the stored asset, `url` its address here. */
export async function sendAsk(text: string, photo?: { src: string; url: string }): Promise<void> {
  const state = ask();
  const clean = text.trim();
  if (!clean || !state.fileId) return;
  if (state.runId) {
    state.set({ queued: clean });
    return;
  }
  const messages: AskMessage[] = [...state.messages, { role: 'user', text: clean, ...(photo ? { photo: photo.url } : {}) }];
  // Runs do not remember each other. The server keeps the conversation and gives each run the turns before it.
  const conversationId = state.conversationId ?? conversationFor(state.fileId);
  state.set({ messages, steps: [], startedAt: Date.now(), conversationId });
  try {
    const { runId } = await api.startRun({ fileId: state.fileId, nodeIds: state.nodeIds, prompt: clean, runner: state.runner, review: 'proposal', conversationId, ...(photo ? { images: [photo.src] } : {}) });
    ask().set({ runId, messages: [...ask().messages, { role: 'agent', text: '', runId, runner: state.runner, done: false, proposals: [] }] });
  } catch (e) {
    ask().set({ messages: [...ask().messages, { role: 'agent', text: '', runId: '', runner: state.runner, done: true, proposals: [], error: (e as Error).message }] });
  }
}

export function stopAsk(): void {
  const { runId } = ask();
  if (runId) void api.stopRun(runId);
}

function patchAgent(runId: string, fn: (m: Extract<AskMessage, { role: 'agent' }>) => Extract<AskMessage, { role: 'agent' }>): void {
  const state = ask();
  state.set({ messages: state.messages.map((m) => (m.role === 'agent' && m.runId === runId ? fn(m) : m)) });
}

/** Proposals the run made in its file, found once it has ended. */
async function collect(runId: string, fileId: string, since: number): Promise<void> {
  try {
    const { items } = await loadInbox();
    const made = items.filter((i): i is Extract<InboxItem, { kind: 'proposal' }> => i.kind === 'proposal' && i.fileId === fileId && i.at >= since - 1000);
    patchAgent(runId, (m) => ({ ...m, proposals: made }));
  } catch {
    // Offline by now: the answer stays text.
  }
}

let started = false;

/** Follows runs over the events socket. Once, for the life of the page. */
export function startAskEvents(): void {
  if (started) return;
  started = true;
  onServerEvent((e) => {
    const state = ask();
    if (e.t === 'brand-report' && state.messages.some((m) => m.role === 'agent' && m.runId === e.runId)) {
      patchAgent(e.runId, (m) => ({ ...m, score: e.score }));
      return;
    }
    if (e.t !== 'agent' || !state.runId || e.runId !== state.runId) return;
    if (e.kind === 'text') patchAgent(e.runId, (m) => ({ ...m, text: m.text + (e.text ?? '') }));
    else if (e.kind === 'tool') state.set({ steps: [...state.steps, stepWords(e.tool ?? e.text ?? 'tool')].slice(-12) });
    else {
      const runId = e.runId;
      patchAgent(runId, (m) => ({ ...m, done: true, ...(e.kind === 'error' ? { error: e.text ?? t('The run failed.') } : {}) }));
      const queued = state.queued;
      state.set({ runId: null, queued: null });
      if (state.fileId) void collect(runId, state.fileId, state.startedAt);
      if (queued) void sendAsk(queued);
    }
  });
}
