import { useSyncExternalStore } from 'react';
import { onServerEvent, type IncomingCallInfo } from '../lib/events.ts';
import { t } from '../i18n/store.ts';
import { callState, openChatWhenIn, startCall } from './call-session.ts';
import { repeatSound } from './call-sounds.ts';

/**
 * Calls from agents: when a run the person asked for ends on a question and they allowed it, the server rings here
 * (`incoming-call`), on every open Bogen of theirs, for thirty seconds. Answer opens the call in that file and the
 * voice asks the question first; Reply in writing opens the file's chat; Decline, or no answer, leaves the question
 * where it is. A missed call stays as a note until it is opened or closed.
 */

export interface AgentCallSettings { enabled: boolean; quietFrom: string | null; quietTo: string | null }

export interface IncomingState {
  ringing: IncomingCallInfo | null;
  missed: IncomingCallInfo | null;
  settings: AgentCallSettings | null;
}

let state: IncomingState = { ringing: null, missed: null, settings: null };
const listeners = new Set<() => void>();
function set(patch: Partial<IncomingState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

// A narrow door for UI captures and tests: shows an incoming or missed call without the server. Nothing in the app uses it.
if (typeof window !== 'undefined') (window as unknown as { __bogenIncoming?: unknown }).__bogenIncoming = { set: (patch: Partial<IncomingState>) => set(patch) };
export function useIncoming<T>(pick: (s: IncomingState) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => pick(state));
}

export function incomingState(): IncomingState { return state; }

let stopRing: (() => void) | null = null;
let started = false;

export function agentName(runner: string): string {
  return runner === 'codex' ? 'Codex' : runner === 'claude' ? 'Claude' : runner ? runner.charAt(0).toUpperCase() + runner.slice(1) : 'An agent';
}

function ring(call: IncomingCallInfo | null): void {
  stopRing?.();
  stopRing = null;
  // In a call already, the card shows without a ring: the person is talking.
  if (call && !callState().active) stopRing = repeatSound('incoming', 2600);
}

function notifyDesktop(call: IncomingCallInfo): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const n = new Notification(t('{agent} needs you', { agent: agentName(call.runner) }), { body: `${call.question}\n${call.fileName}`, tag: `bogen-call-${call.id}` });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* not allowed here */ }
}

/** Starts listening for calls, once per page. */
export function startIncoming(): void {
  if (started) return;
  started = true;
  void refreshIncoming();
  onServerEvent((e) => {
    if (e.t === 'incoming-call') {
      set({ ringing: e.call, missed: null });
      ring(e.call);
      notifyDesktop(e.call);
    } else if (e.t === 'incoming-call-end' && state.ringing?.id === e.id) {
      const call = state.ringing;
      ring(null);
      set({ ringing: null, ...(e.reason === 'missed' ? { missed: call } : {}) });
    }
  });
}

export async function refreshIncoming(): Promise<void> {
  try {
    const r = await fetch('/api/call/incoming');
    if (!r.ok) return;
    const body = await r.json() as { settings: AgentCallSettings; ringing: IncomingCallInfo | null };
    set({ settings: body.settings, ringing: body.ringing && body.ringing.expiresAt > Date.now() ? body.ringing : null });
    ring(state.ringing);
  } catch { /* the server is away; the next event brings it */ }
}

async function respond(call: IncomingCallInfo, action: 'answer' | 'decline' | 'text'): Promise<boolean> {
  ring(null);
  set({ ringing: null });
  const r = await fetch(`/api/call/incoming/${call.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }).catch(() => null);
  return Boolean(r?.ok);
}

function goTo(call: IncomingCallInfo): void {
  const target = `#/file/${call.fileId}${call.threadId ? `/thread/${call.threadId}` : ''}`;
  if (!location.hash.startsWith(`#/file/${call.fileId}`)) location.hash = target;
}

/** Answers: the call opens in that file and the voice asks the agent's question first. */
export async function answerIncoming(call = state.ringing): Promise<void> {
  if (!call) return;
  await respond(call, 'answer');
  goTo(call);
  await startCall({ fileId: call.fileId, fileName: call.fileName, ask: call.question });
  openChatWhenIn(call.fileId);
}

/** Opens the file's chat, or the thread, to answer in writing. */
export async function replyInWriting(call = state.ringing ?? state.missed): Promise<void> {
  if (!call) return;
  if (state.ringing?.id === call.id) await respond(call, 'text');
  set({ missed: null });
  goTo(call);
  if (!call.threadId) openChatWhenIn(call.fileId, () => document.querySelector<HTMLElement>('[data-testid="prompt-input"], .chat textarea')?.focus());
}

export async function declineIncoming(call = state.ringing): Promise<void> {
  if (call) await respond(call, 'decline');
}

export function dismissMissed(): void { set({ missed: null }); }

/** Turns agent calls on or off, or sets quiet hours. Turning them on asks this browser for notifications once. */
export async function setAgentCalls(patch: Partial<AgentCallSettings>): Promise<string | null> {
  if (patch.enabled && typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission().catch(() => undefined);
  const r = await fetch('/api/call/incoming/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => null);
  if (!r) return t('Bogen did not answer.');
  const body = await r.json().catch(() => ({})) as { settings?: AgentCallSettings; error?: string };
  if (!r.ok || !body.settings) return body.error ?? t('That did not work.');
  set({ settings: body.settings });
  return null;
}
