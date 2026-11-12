import { api } from '../lib/api.ts';
import { conversationFor, conversationTurns, startConversation } from '../lib/conversation.ts';
import { agentApi, type LaneChoice } from '../lib/agent-api.ts';
import { session } from '../doc/session.ts';
import { placeImage } from '../ops/clipboard.ts';
import { editor } from '../state/store.ts';
import { onServerEvent, type ServerEvent } from '../lib/events.ts';
import { t } from '../i18n/store.ts';
import type { RunLanguageChoice } from '@bogen/core';

const RUNNER_KEY = 'bogen-prompt-runner';

/** Opens the agent prompt, attached to whatever is selected right now. */
export function startPrompt(): void {
  const state = editor();
  state.set({ prompt: { ...state.prompt, open: !state.prompt.open || state.prompt.nodeIds.join() !== state.selection.join(), nodeIds: state.selection, redo: undefined } });
}

/** `device`: a paired device to run it on, which has the CLI. Its changes come back by sync. */
export async function sendPrompt(text: string, runner: string, options: { model?: string; effort?: string; review?: string; intent?: 'edit' | 'revise' | 'new_page'; device?: string; language?: RunLanguageChoice } = {}): Promise<void> {
  const state = editor();
  const fileId = state.fileId;
  const pageId = state.pageId;
  if (!fileId || !pageId) return;
  const nodeIds = state.prompt.nodeIds;
  const messages = [...state.prompt.messages, { role: 'user' as const, text }];
  state.set({ prompt: { ...state.prompt, running: true, messages, runId: null } });
  try {
    // The server puts the earlier turns of this chat ahead of the message, so a follow-up knows what came before.
    const { runId } = await api.startRun({ fileId, pageId, nodeIds, prompt: text, runner, conversationId: conversationFor(fileId), ...options });
    const s = editor();
    s.set({ prompt: { ...s.prompt, runId } });
  } catch (err) {
    const s = editor();
    s.set({ prompt: { ...s.prompt, running: false, messages: [...s.prompt.messages, { role: 'error', text: (err as Error).message }] } });
  }
}

/** Starts a new chat: what was said goes from the bar, and the next run knows nothing of it. */
export function newChat(): void {
  const state = editor();
  if (!state.fileId || state.prompt.running) return;
  startConversation(state.fileId);
  state.set({ prompt: { ...state.prompt, messages: [], runId: null } });
}

/** After a reload, the bar shows the chat the file is in, as the server kept it. */
export async function restoreChat(): Promise<void> {
  const fileId = editor().fileId;
  if (!fileId || editor().prompt.messages.length) return;
  const turns = await conversationTurns(fileId, conversationFor(fileId));
  const state = editor();
  if (!turns.length || state.fileId !== fileId || state.prompt.messages.length || state.prompt.running) return;
  const messages = turns.flatMap((turn) => [
    { role: 'user' as const, text: turn.message },
    ...(turn.reply ? [{ role: 'agent' as const, text: turn.reply, runId: turn.runId }] : []),
    ...(turn.status === 'failed' || turn.status === 'interrupted' ? [{ role: 'error' as const, text: turn.status === 'failed' ? t('The run failed.') : t('The run was cut off.') }] : []),
  ]);
  state.set({ prompt: { ...state.prompt, messages } });
}

/** Several runs on one request, each in its own copy next to the layer. They are followed on the canvas, not here. */
export async function startRace(text: string, nodeId: string, lanes: LaneChoice[], language?: RunLanguageChoice): Promise<void> {
  const state = editor();
  const { fileId, pageId } = state;
  if (!fileId || !pageId) return;
  const messages = [...state.prompt.messages, { role: 'user' as const, text }];
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
    s.set({ prompt: { open: true, nodeIds: [nodeId], running: true, runId: null, messages: [{ role: 'user', text: options.note ? t('Rebuild as layers: {name}. {note}', { name: node.name, note: options.note }) : t('Rebuild as layers: {name}', { name: node.name }) }] } });
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
    const last = messages.at(-1);
    if (last?.role === 'agent' && (!last.runId || last.runId === e.runId)) messages[messages.length - 1] = { ...last, text: last.text + (e.text ?? ''), runId: e.runId };
    else messages.push({ role: 'agent', text: e.text ?? '', runId: e.runId });
    state.set({ prompt: { ...prompt, runId: e.runId, messages } });
  } else if (e.kind === 'tool') {
    messages.push({ role: 'tool', text: e.tool ?? e.text ?? 'tool' });
    state.set({ prompt: { ...prompt, runId: e.runId, messages } });
  } else if (e.kind === 'error') {
    messages.push({ role: 'error', text: e.text ?? t('The run failed.') });
    state.set({ prompt: { ...prompt, messages, running: false, runId: null } });
  } else {
    state.set({ prompt: { ...prompt, running: false, runId: null, messages } });
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
