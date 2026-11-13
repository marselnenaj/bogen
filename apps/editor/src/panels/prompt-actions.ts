import { api, type ConversationTurn } from '../lib/api.ts';
import { continueConversation, conversationFor, conversationTurns, startConversation } from '../lib/conversation.ts';
import { agentApi, type LaneChoice } from '../lib/agent-api.ts';
import { session } from '../doc/session.ts';
import { placeImage } from '../ops/clipboard.ts';
import { editor } from '../state/store.ts';
import { onServerEvent, type ServerEvent } from '../lib/events.ts';
import { t } from '../i18n/store.ts';
import type { RunLanguageChoice } from '@bogen/core';
import type { PromptMessage } from '../state/store.ts';
import { appendReply, rememberChatOpen } from './chat-state.ts';

const RUNNER_KEY = 'bogen-prompt-runner';

/** Asks the chat panel to take the focus, once it is there. */
export const CHAT_FOCUS_EVENT = 'bogen-chat-focus';
function focusChat(): void {
  requestAnimationFrame(() => window.dispatchEvent(new Event(CHAT_FOCUS_EVENT)));
}

/** Shows or hides the chat panel, and remembers it for this file. */
export function setChatOpen(open: boolean): void {
  const state = editor();
  if (state.fileId) rememberChatOpen(state.fileId, open);
  state.set({ prompt: { ...state.prompt, open, nodeIds: open ? state.selection : state.prompt.nodeIds, ...(open ? {} : { redo: undefined }) } });
  if (open) focusChat();
}

export function toggleChat(): void {
  setChatOpen(!editor().prompt.open);
}

/** Ask your agent: the chat opens with the focus in its field and what is selected right now going with the message. */
export function startPrompt(): void {
  const state = editor();
  if (state.minimal) state.set({ minimal: false });
  if (state.prompt.open) {
    state.set({ prompt: { ...state.prompt, nodeIds: state.selection, redo: undefined } });
    focusChat();
  } else setChatOpen(true);
}

/** What goes with a person's message in the chat, besides its words. */
export interface SentWith { context?: string[]; runnerLabel?: string; review?: string }

/** `device`: a paired device to run it on, which has the CLI. Its changes come back by sync. */
export async function sendPrompt(text: string, runner: string, options: { model?: string; effort?: string; review?: string; intent?: 'edit' | 'revise' | 'new_page'; device?: string; language?: RunLanguageChoice; images?: string[] } = {}, sent: SentWith = {}): Promise<void> {
  const state = editor();
  const fileId = state.fileId;
  const pageId = state.pageId;
  if (!fileId || !pageId) return;
  const nodeIds = state.prompt.nodeIds;
  const mine: PromptMessage = { role: 'user', text, at: Date.now(), runner: sent.runnerLabel ?? runner, ...(sent.review ? { review: sent.review } : {}), ...(sent.context?.length ? { context: sent.context } : {}), ...(options.images?.length ? { images: options.images } : {}) };
  state.set({ prompt: { ...state.prompt, running: true, messages: [...state.prompt.messages, mine], runId: null, startedAt: Date.now() } });
  try {
    // The server puts the earlier turns of this chat ahead of the message, so a follow-up knows what came before.
    const { runId } = await api.startRun({ fileId, pageId, nodeIds, prompt: text, runner, conversationId: conversationFor(fileId), ...options });
    const s = editor();
    s.set({ prompt: { ...s.prompt, runId } });
  } catch (err) {
    const s = editor();
    s.set({ prompt: { ...s.prompt, running: false, startedAt: undefined, messages: [...s.prompt.messages, { role: 'error', text: (err as Error).message }] } });
  }
}

/** Starts a new chat: what was said goes from the bar, and the next run knows nothing of it. */
export function newChat(): void {
  const state = editor();
  if (!state.fileId || state.prompt.running) return;
  startConversation(state.fileId);
  state.set({ prompt: { ...state.prompt, messages: [], runId: null } });
}

/** A chat as the server kept it, as messages for the panel. */
export function turnMessages(turns: ConversationTurn[]): PromptMessage[] {
  return turns.flatMap((turn): PromptMessage[] => [
    { role: 'user', text: turn.message, at: turn.at, runner: turn.runner, ...(turn.review ? { review: turn.review } : {}) },
    ...(turn.reply ? [{ role: 'agent' as const, text: turn.reply, runId: turn.runId, at: turn.at }] : []),
    ...(turn.status === 'failed' || turn.status === 'interrupted' ? [{ role: 'error' as const, text: turn.status === 'failed' ? t('The run failed.') : t('The run was cut off.') }] : []),
    ...(turn.status === 'stopped' ? [{ role: 'note' as const, text: t('Stopped. What it changed so far stays, and Undo this run takes it back.') }] : []),
  ]);
}

/** After a reload, the panel shows the chat the file is in, as the server kept it. */
export async function restoreChat(): Promise<void> {
  const fileId = editor().fileId;
  if (!fileId || editor().prompt.messages.length) return;
  const turns = await conversationTurns(fileId, conversationFor(fileId));
  const state = editor();
  if (!turns.length || state.fileId !== fileId || state.prompt.messages.length || state.prompt.running) return;
  state.set({ prompt: { ...state.prompt, messages: turnMessages(turns) } });
}

/** Goes back to an earlier chat of this file: it shows, and the next message continues it. */
export async function openChat(id: string): Promise<void> {
  const state = editor();
  const fileId = state.fileId;
  if (!fileId || state.prompt.running) return;
  continueConversation(fileId, id);
  const turns = await conversationTurns(fileId, id);
  const now = editor();
  if (now.fileId !== fileId || now.prompt.running) return;
  now.set({ prompt: { ...now.prompt, messages: turnMessages(turns), runId: null } });
}

/** Several runs on one request, each in its own copy next to the layer. They are followed on the canvas, not here. */
export async function startRace(text: string, nodeId: string, lanes: LaneChoice[], language?: RunLanguageChoice): Promise<void> {
  const state = editor();
  const { fileId, pageId } = state;
  if (!fileId || !pageId) return;
  const messages = [...state.prompt.messages, { role: 'user' as const, text, at: Date.now(), review: 'directions' }];
  state.set({ prompt: { ...state.prompt, messages, runId: null } });
  try {
    const race = await agentApi.startRace({ fileId, pageId, nodeId, prompt: text, lanes, who: session().user.name, ...(language ? { language } : {}) });
    const s = editor();
    s.set({ prompt: { ...s.prompt, messages: [...s.prompt.messages, { role: 'agent', text: t.n(race.lanes.length, '{count} run started, each in its own copy: {agents}. Follow them on the canvas, and accept the one you like.', '{count} runs started, each in its own copy: {agents}. Follow them on the canvas, and accept the one you like.', { agents: race.lanes.map((l) => l.agent).join(', ') }) }] } });
  } catch (err) {
    const s = editor();
    s.set({ prompt: { ...s.prompt, messages: [...s.prompt.messages, { role: 'error', text: (err as Error).message }] } });
  }
}

/** Rebuilds an image layer as editable layers next to it. Progress shows in the prompt, as for any run. */
export async function rebuildAsLayers(nodeId: string, options: { note?: string; runner?: string } = {}): Promise<void> {
  const state = editor();
  const { fileId } = state;
  const node = session().snap.nodes.get(nodeId);
  if (!fileId || !node) return;
  if (node.type !== 'image' || !node.src) return void state.showToast(t('Rebuild as layers works on an image with something in it.'));
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(RUNNER_KEY);
  } catch {
    // The first available runner then.
  }
  try {
    const runners = (await api.runners()).filter((r) => r.available);
    const runner = runners.find((r) => r.id === (options.runner || saved))?.id ?? runners[0]?.id;
    if (!runner) return void state.showToast(t('Install {claude} or {codex} to rebuild images as layers.', { claude: 'claude', codex: 'codex' }));
    const { model, effort } = (await agentApi.runSettings()).settings.runners[runner]?.prompt ?? {};
    const s = editor();
    if (s.fileId) rememberChatOpen(s.fileId, true);
    s.set({ prompt: { open: true, nodeIds: [nodeId], running: true, runId: null, startedAt: Date.now(), messages: [...s.prompt.messages, { role: 'user', at: Date.now(), runner, text: options.note ? t('Rebuild as layers: {name}. {note}', { name: node.name, note: options.note }) : t('Rebuild as layers: {name}', { name: node.name }) }] } });
    const { runId } = await agentApi.rebuild({ fileId, nodeId, runner, ...(options.note ? { prompt: options.note } : {}), ...(model && model !== 'default' ? { model } : {}), ...(effort && effort !== 'default' ? { effort } : {}) });
    const after = editor();
    after.set({ prompt: { ...after.prompt, runId } });
  } catch (err) {
    const s = editor();
    s.set({ prompt: { ...s.prompt, running: false, messages: [...s.prompt.messages, { role: 'error', text: (err as Error).message }] } });
  }
}

/** An image pasted into the prompt: placed on the canvas first, since the run compares its rebuild with it. */
export async function pasteImageToRebuild(file: Blob, note: string, runner: string): Promise<void> {
  try {
    const asset = await api.upload(file);
    const id = await placeImage(asset.src);
    await rebuildAsLayers(id, { ...(note ? { note } : {}), ...(runner ? { runner } : {}) });
  } catch (err) {
    editor().showToast(t('Could not add the image. {error}', { error: (err as Error).message }));
  }
}

/** An image already attached to a chat message, rebuilt as layers instead of going with the message. */
export async function rebuildStoredImage(src: string, note: string, runner: string): Promise<void> {
  try {
    const id = await placeImage(src);
    await rebuildAsLayers(id, { ...(note ? { note } : {}), ...(runner ? { runner } : {}) });
  } catch (err) {
    editor().showToast(t('Could not add the image. {error}', { error: (err as Error).message }));
  }
}

export function stopPrompt(): void {
  const { runId } = editor().prompt;
  if (runId) void api.stopRun(runId);
}

function onAgent(e: Extract<ServerEvent, { t: 'agent' }>): void {
  const state = editor();
  const { prompt } = state;
  if (e.fileId !== state.fileId) return;
  if (prompt.runId && e.runId !== prompt.runId) return;
  if (!prompt.running && !prompt.runId) return;
  const messages = [...prompt.messages];
  if (e.kind === 'text') {
    // Each block of words a CLI writes arrives whole, and is a paragraph of the reply.
    state.set({ prompt: { ...prompt, runId: e.runId, messages: appendReply(messages, e.runId, e.text ?? '') } });
  } else if (e.kind === 'tool') {
    messages.push({ role: 'tool', text: e.tool ?? e.text ?? 'tool', runId: e.runId });
    state.set({ prompt: { ...prompt, runId: e.runId, messages } });
  } else if (e.kind === 'error') {
    messages.push({ role: 'error', text: e.text ?? t('The run failed.'), runId: e.runId });
    state.set({ prompt: { ...prompt, messages, running: false, runId: null, startedAt: undefined } });
  } else {
    // How it ended, when there is something to say: stopped, or the server's own word on its checks.
    if (e.text === 'Stopped.') messages.push({ role: 'note', text: t('Stopped. What it changed so far stays, and Undo this run takes it back.'), runId: e.runId });
    else if (e.text) messages.push({ role: 'note', text: e.text, runId: e.runId });
    state.set({ prompt: { ...prompt, running: false, runId: null, startedAt: undefined, messages } });
  }
}

function onCommentRun(e: Extract<ServerEvent, { t: 'comment-run' }>): void {
  const state = editor();
  if (e.fileId !== state.fileId) return;
  const { [e.threadId]: previous, ...rest } = state.threadRuns;
  // How a run ended stays in the thread as a message, or as the agent's own answer.
  if (e.status !== 'queued' && e.status !== 'working') {
    state.set({ threadRuns: rest });
    // Another request in the same thread may be waiting behind the one that ended: ask what is going on now.
    const { fileId } = state;
    if (fileId) {
      void api.commentRuns(fileId).then((runs) => {
        if (editor().fileId !== fileId) return;
        const now = runs.find((r) => r.threadId === e.threadId);
        const { [e.threadId]: _gone, ...others } = editor().threadRuns;
        editor().set({ threadRuns: now ? { ...others, [e.threadId]: now } : others });
      }).catch(() => {});
    }
    return;
  }
  // Steps add up under the thread while it works. A run that starts anew starts with none.
  const same = previous && previous.status === 'working' && (!e.runId || !previous.runId || previous.runId === e.runId);
  const steps = [...(same ? previous.steps ?? [] : []), ...(e.tool ? [{ tool: e.tool, at: Date.now() }] : [])].slice(-30);
  const queueId = e.queueId ?? previous?.queueId;
  state.set({ threadRuns: { ...rest, [e.threadId]: { threadId: e.threadId, runner: e.runner, status: e.status, ...(e.runId ?? previous?.runId ? { runId: e.runId ?? previous?.runId } : {}), ...(e.tool ? { tool: e.tool } : {}), ...(queueId ? { queueId } : {}), ...(e.status === 'working' ? { steps } : {}) } } });
}

/** Feeds run progress and activity into the store for the file that is open. */
export function startAgentEvents(): () => void {
  return onServerEvent((e) => {
    if (e.t === 'agent') onAgent(e);
    if (e.t === 'comment-run') onCommentRun(e);
    if (e.t === 'activity') {
      const state = editor();
      if (e.fileId !== state.fileId) return;
      const at = e.at ?? Date.now();
      state.set({
        activity: [{ id: `${at}-${Math.random()}`, agent: e.agent, tool: e.tool, nodeIds: e.nodeIds ?? [], at }, ...state.activity].slice(0, 200),
        activeAgents: { ...state.activeAgents, [e.agent]: { nodeIds: e.nodeIds ?? [], at: Date.now(), tool: e.tool } },
      });
    }
  });
}
