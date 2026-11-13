import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationTurn } from '../src/lib/api.ts';
import type { ServerEvent } from '../src/lib/events.ts';

const events = vi.hoisted(() => ({ listener: undefined as ((e: ServerEvent) => void) | undefined, reachable: undefined as (() => void) | undefined }));
vi.mock('../src/lib/events.ts', () => ({
  onServerEvent: (listener: (e: ServerEvent) => void) => { events.listener = listener; return () => { events.listener = undefined; }; },
  onReachableChange: (listener: () => void) => { events.reachable = listener; return () => { events.reachable = undefined; }; },
  serverReachable: () => true,
}));
vi.mock('../src/doc/session.ts', () => ({ session: vi.fn() }));
vi.mock('../src/ops/clipboard.ts', () => ({ placeImage: vi.fn() }));

import { api } from '../src/lib/api.ts';
import { continueConversation } from '../src/lib/conversation.ts';
import { editor } from '../src/state/store.ts';
import { newChat, openChat, restoreChat, sendPrompt, startAgentEvents, stopPrompt } from '../src/panels/prompt-actions.ts';

const turn = (status: ConversationTurn['status'] = 'running'): ConversationTurn => ({ runId: 'run1', at: 1234, runner: 'codex', message: 'Improve the website concepts', reply: 'Reading the existing concepts.', layers: [], status });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) });
  continueConversation('file1', 'chat1');
  editor().set({ fileId: 'file1', pageId: 'page1', prompt: { open: true, running: false, runId: null, messages: [], nodeIds: [] } });
});
afterEach(() => { events.listener = undefined; events.reachable = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('recovering the chat while its agent is working', () => {
  it('blocks another send until the server has recovered the run status', async () => {
    const answer = deferred<{ id: string; turns: ConversationTurn[] }>();
    vi.spyOn(api, 'conversation').mockReturnValue(answer.promise);
    const start = vi.spyOn(api, 'startRun');
    const restoring = restoreChat();
    expect(editor().prompt.restoring).toBe(true);
    await sendPrompt('what is happening?', 'codex');
    expect(start).not.toHaveBeenCalled();
    answer.resolve({ id: 'chat1', turns: [turn()] });
    await restoring;
    expect(editor().prompt.restoring).toBe(false);
    expect(editor().prompt.running).toBe(true);
  });

  it('restores the active run, its elapsed time and reply, follows new progress, and stops that run', async () => {
    vi.spyOn(api, 'conversation').mockResolvedValue({ id: 'chat1', turns: [turn()] });
    const start = vi.spyOn(api, 'startRun');
    const stop = vi.spyOn(api, 'stopRun').mockResolvedValue();
    await restoreChat();
    expect(editor().prompt).toMatchObject({ running: true, runId: 'run1', startedAt: 1234 });
    expect(editor().prompt.messages.map((m) => m.text)).toEqual(['Improve the website concepts', 'Reading the existing concepts.']);
    await sendPrompt('what is happening?', 'codex');
    expect(start).not.toHaveBeenCalled();
    expect(editor().prompt.messages).toHaveLength(2);
    const off = startAgentEvents();
    events.listener!({ t: 'agent', fileId: 'file1', runId: 'run1', kind: 'tool', tool: 'html_write' });
    expect(editor().prompt.messages.at(-1)?.text).toBe('html_write');
    stopPrompt();
    expect(stop).toHaveBeenCalledWith('run1');
    events.listener!({ t: 'agent', fileId: 'file1', runId: 'run1', kind: 'done', text: 'Stopped.' });
    expect(editor().prompt).toMatchObject({ running: false, runId: null, startedAt: undefined });
    off();
  });

  it.each(['done', 'failed', 'stopped', 'interrupted'] as const)('does not revive a %s run', async (status) => {
    vi.spyOn(api, 'conversation').mockResolvedValue({ id: 'chat1', turns: [turn(status)] });
    await restoreChat();
    expect(editor().prompt).toMatchObject({ running: false, runId: null, startedAt: undefined });
  });

  it('reattaches when an earlier chat with a running turn is opened', async () => {
    vi.spyOn(api, 'conversation').mockResolvedValue({ id: 'other', turns: [turn()] });
    await openChat('other');
    expect(editor().prompt).toMatchObject({ running: true, runId: 'run1', startedAt: 1234 });
  });

  it('keeps an in-flight restoration out of a new chat', async () => {
    const answer = deferred<{ id: string; turns: ConversationTurn[] }>();
    vi.spyOn(api, 'conversation').mockReturnValue(answer.promise);
    const restoring = restoreChat();
    newChat();
    answer.resolve({ id: 'chat1', turns: [turn()] });
    await restoring;
    expect(editor().prompt.messages).toEqual([]);
    expect(editor().prompt.running).toBe(false);
  });

  it('does not overwrite streamed progress with an older restoration', async () => {
    const answer = deferred<{ id: string; turns: ConversationTurn[] }>();
    vi.spyOn(api, 'conversation').mockReturnValue(answer.promise);
    const restoring = restoreChat();
    editor().set({ prompt: { ...editor().prompt, running: true, runId: 'run2', messages: [{ role: 'agent', text: 'New progress', runId: 'run2' }] } });
    answer.resolve({ id: 'chat1', turns: [turn()] });
    await restoring;
    expect(editor().prompt.runId).toBe('run2');
    expect(editor().prompt.messages[0]?.text).toBe('New progress');
  });

  it('recovers a run that finished while its initial running snapshot was in flight', async () => {
    const old = deferred<{ id: string; turns: ConversationTurn[] }>();
    const get = vi.spyOn(api, 'conversation').mockReturnValueOnce(old.promise).mockResolvedValue({ id: 'chat1', turns: [turn('done')] });
    const off = startAgentEvents();
    const restoring = restoreChat();
    events.listener!({ t: 'agent', fileId: 'file1', runId: 'run1', kind: 'done' });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    old.resolve({ id: 'chat1', turns: [turn()] });
    await restoring;
    expect(editor().prompt).toMatchObject({ running: false, runId: null });
    expect(editor().prompt.messages).toHaveLength(2);
    off();
  });

  it('recovers a completion missed while disconnected, and removes its reconnect listener on cleanup', async () => {
    const get = vi.spyOn(api, 'conversation').mockResolvedValueOnce({ id: 'chat1', turns: [turn()] }).mockResolvedValue({ id: 'chat1', turns: [turn('done')] });
    await restoreChat();
    const off = startAgentEvents();
    events.reachable!();
    await vi.waitFor(() => expect(editor().prompt.running).toBe(false));
    expect(get).toHaveBeenCalledTimes(2);
    expect(editor().prompt.runId).toBeNull();
    off();
    expect(events.reachable).toBeUndefined();
    expect(events.listener).toBeUndefined();
  });

  it('does not replace a displayed error with events from an unrelated run', async () => {
    const get = vi.spyOn(api, 'conversation');
    editor().set({ prompt: { ...editor().prompt, messages: [{ role: 'error', text: 'Wait for the current run.' }] } });
    const off = startAgentEvents();
    events.listener!({ t: 'agent', fileId: 'file1', runId: 'other', kind: 'done' });
    expect(get).not.toHaveBeenCalled();
    off();
  });

  it('keeps earlier streamed paragraphs and steps when a reconnect recovers the final answer', async () => {
    vi.spyOn(api, 'conversation').mockResolvedValue({ id: 'chat1', turns: [{ ...turn('done'), reply: 'The final answer.' }] });
    editor().set({ prompt: { ...editor().prompt, running: true, runId: 'run1', messages: [
      { role: 'user', text: 'Improve the website concepts' },
      { role: 'agent', runId: 'run1', text: 'First paragraph.\n\nSecond paragraph.' },
      { role: 'tool', runId: 'run1', text: 'html_write' },
    ] } });
    await restoreChat({ refresh: true });
    expect(editor().prompt.messages.map((m) => m.text)).toEqual(['Improve the website concepts', 'First paragraph.\n\nSecond paragraph.', 'html_write', 'The final answer.']);
    expect(editor().prompt.running).toBe(false);
  });

  it('releases the loading state when recovery cannot reach the server', async () => {
    vi.spyOn(api, 'conversation').mockRejectedValue(new TypeError('Offline'));
    await restoreChat();
    expect(editor().prompt).toMatchObject({ restoring: false, running: false, runId: null, messages: [] });
  });

  it('keeps the last chat chosen when an earlier request arrives late', async () => {
    const old = deferred<{ id: string; turns: ConversationTurn[] }>();
    vi.spyOn(api, 'conversation').mockReturnValueOnce(old.promise).mockResolvedValue({ id: 'newer', turns: [{ ...turn('done'), message: 'The newer chat' }] });
    const opening = openChat('older');
    await openChat('newer');
    old.resolve({ id: 'older', turns: [turn()] });
    await opening;
    expect(editor().prompt.messages[0]?.text).toBe('The newer chat');
    expect(editor().prompt).toMatchObject({ restoring: false, running: false, runId: null });
  });
});

describe('a chat request in flight', () => {
  it('sends only once even when called twice before the server replies', async () => {
    const answer = deferred<{ runId: string }>();
    const start = vi.spyOn(api, 'startRun').mockReturnValue(answer.promise);
    const first = sendPrompt('Make it calmer', 'codex');
    const second = sendPrompt('Make it calmer', 'codex');
    answer.resolve({ runId: 'run1' });
    await Promise.all([first, second]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(editor().prompt.messages).toHaveLength(1);
  });

  it('ignores a late response after switching files', async () => {
    const answer = deferred<{ runId: string }>();
    vi.spyOn(api, 'startRun').mockReturnValue(answer.promise);
    const sending = sendPrompt('Make it calmer', 'codex');
    editor().set({ fileId: 'file2', prompt: { open: true, running: false, runId: null, messages: [], nodeIds: [] } });
    answer.resolve({ runId: 'run1' });
    await sending;
    expect(editor().prompt).toMatchObject({ running: false, runId: null, messages: [] });
  });

  it('does not put an already completed run back into the prompt when POST arrives late', async () => {
    const answer = deferred<{ runId: string }>();
    vi.spyOn(api, 'startRun').mockReturnValue(answer.promise);
    const off = startAgentEvents();
    const sending = sendPrompt('Make it calmer', 'codex');
    events.listener!({ t: 'agent', fileId: 'file1', runId: 'run1', kind: 'done' });
    answer.resolve({ runId: 'run1' });
    await sending;
    expect(editor().prompt).toMatchObject({ running: false, runId: null });
    off();
  });

  it('keeps a late rejection out of a different file', async () => {
    const answer = deferred<{ runId: string }>();
    vi.spyOn(api, 'startRun').mockImplementation(async () => { await answer.promise; throw new Error('The original request failed.'); });
    const sending = sendPrompt('Make it calmer', 'codex');
    editor().set({ fileId: 'file2', prompt: { open: true, running: false, runId: null, messages: [], nodeIds: [] } });
    answer.resolve({ runId: 'run1' });
    await sending;
    expect(editor().prompt.messages).toEqual([]);
  });
});
