import type { Theme, ThreadRunStatus } from './api.ts';

/** An agent ringing the person because a run they asked for ended on a question. See server `incoming-calls.ts`. */
export interface IncomingCallInfo { id: string; fileId: string; fileName: string; runId: string; runner: string; question: string; threadId?: string; conversationId?: string; at: number; expiresAt: number }

export type ServerEvent =
  | { t: 'files' }
  | { t: 'incoming-call'; call: IncomingCallInfo }
  | { t: 'incoming-call-end'; id: string; fileId: string; reason: 'answered' | 'declined' | 'text' | 'missed' }
  | { t: 'team-unsent'; fileId: string; count: number }
  | { t: 'file-reset'; fileId: string }
  | { t: 'activity'; fileId: string; agent: string; tool: string; nodeIds: string[]; at: number; runId?: string }
  | { t: 'agent'; runId: string; fileId: string; kind: 'text' | 'tool' | 'done' | 'error'; text?: string; tool?: string }
  | { t: 'theme'; theme: Theme | null }
  | { t: 'peers' }
  | { t: 'phone' }
  | { t: 'extension' }
  | { t: 'references' }
  | { t: 'publish' }
  | { t: 'run-history'; fileId: string }
  | { t: 'history'; fileId: string }
  | { t: 'sync-conflicts'; fileId: string }
  | { t: 'brand'; id: string }
  | { t: 'library'; id: string }
  | { t: 'brand-report'; fileId: string; runId: string; runner: string; score: number; hard: number; soft: number; waived: number; checklist: number; text: string; violations: { node_id: string; layer: string; rule: string; severity: string; message: string }[] }
  | { t: 'comment-run'; fileId: string; threadId: string; runner: string; status: ThreadRunStatus; runId?: string; tool?: string; queueId?: string }
  | { t: 'run-queue' }
  | { t: 'agents-check'; id: string; status: string }
  | { t: 'race'; fileId: string; raceId: string }
  | { t: 'memory'; fileId: string; brandId?: string }
  | { t: 'pull'; id: string; fileId: string; status: string }
  | { t: 'conversation'; fileId: string; conversationId: string; closed?: boolean }
  /** `bogen open` on this machine asks whether a window that is there takes the file (tabs/OneWindow.tsx). */
  | { t: 'open-request'; id: string; hash: string; raise?: boolean };

type Listener = (e: ServerEvent) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let retry = 500;
let retryTimer = 0;
let started = false;

/** Whether the server answers: the events socket is open. Unknown until the first try ends. */
let reachable: boolean | null = null;
const reachListeners = new Set<() => void>();
function setReachable(value: boolean): void {
  if (reachable === value) return;
  reachable = value;
  for (const fn of reachListeners) fn();
}

export function serverReachable(): boolean | null {
  return reachable;
}

/** Subscribes to `serverReachable`, and opens the socket if nothing has yet. */
export function onReachableChange(fn: () => void): () => void {
  if (!started) {
    started = true;
    connect();
  }
  reachListeners.add(fn);
  return () => reachListeners.delete(fn);
}

/** Whether the socket was open before: an open after that is a reconnect, and what was sent meanwhile is missed. */
let opened = false;
const reconnectListeners = new Set<() => void>();

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/events`);
  socket.onopen = () => {
    retry = 500;
    setReachable(true);
    if (opened) for (const fn of [...reconnectListeners]) run(fn);
    opened = true;
  };
  socket.onmessage = (m) => {
    let data: ServerEvent;
    try {
      data = JSON.parse(String(m.data)) as ServerEvent;
    } catch {
      // A server newer than this editor may send messages it does not understand.
      return;
    }
    // Each listener on its own: one that throws must not keep the event from the ones after it.
    for (const l of [...listeners]) run(() => l(data));
  };
  socket.onclose = () => {
    setReachable(false);
    retryTimer = window.setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10000);
  };
}

/** Connects again now, say once a phone has paired and its cookie lets the socket in. */
export function reconnectEvents(): void {
  retry = 500;
  if (!started) return;
  clearTimeout(retryTimer);
  if (socket && socket.readyState <= WebSocket.OPEN) {
    socket.onclose = null;
    socket.close();
  }
  connect();
}

function run(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error('bogen: an event listener failed', e);
  }
}

/**
 * Called each time the events socket opens again after it was closed, say by a restart of the server. Events sent
 * while it was closed never arrive, so a view that follows them reads its data anew here.
 */
export function onEventsReconnect(fn: () => void): () => void {
  if (!started) {
    started = true;
    connect();
  }
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}

export function onServerEvent(fn: Listener): () => void {
  if (!started) {
    started = true;
    connect();
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}
