import type { Theme, ThreadRunStatus } from './api.ts';

export type ServerEvent =
  | { t: 'files' }
  | { t: 'activity'; fileId: string; agent: string; tool: string; nodeIds: string[]; at: number; runId?: string }
  | { t: 'agent'; runId: string; fileId: string; kind: 'text' | 'tool' | 'done' | 'error'; text?: string; tool?: string }
  | { t: 'theme'; theme: Theme | null }
  | { t: 'peers' }
  | { t: 'phone' }
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
  | { t: 'pull'; id: string; fileId: string; status: string };

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

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/events`);
  socket.onopen = () => {
    retry = 500;
    setReachable(true);
  };
  socket.onmessage = (m) => {
    try {
      const data = JSON.parse(String(m.data)) as ServerEvent;
      for (const l of listeners) l(data);
    } catch {
      // A server newer than this editor may send messages it does not understand.
    }
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

export function onServerEvent(fn: Listener): () => void {
  if (!started) {
    started = true;
    connect();
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}
