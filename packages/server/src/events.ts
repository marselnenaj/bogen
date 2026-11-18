import { WebSocket } from 'ws';

export type BogenEvent =
  | { t: 'files' }
  | { t: 'incoming-call'; call: import('./incoming-calls.ts').IncomingCall }
  | { t: 'incoming-call-end'; id: string; fileId: string; reason: import('./incoming-calls.ts').IncomingEnd }
  | { t: 'team-unsent'; fileId: string; count: number }
  | { t: 'file-reset'; fileId: string }
  | { t: 'activity'; fileId: string; agent: string; tool: string; nodeIds: string[]; at: number; runId?: string; canvasOnly?: boolean }
  | { t: 'agent'; runId: string; fileId: string; kind: 'text' | 'tool' | 'done' | 'error'; text?: string; tool?: string }
  | { t: 'theme'; theme: unknown }
  | { t: 'peers' }
  | { t: 'phone' }
  | { t: 'extension' }
  | { t: 'references' }
  | { t: 'publish' }
  | { t: 'brand'; id: string }
  | { t: 'library'; id: string }
  | { t: 'brand-report'; fileId: string; runId: string; runner: string; score: number; hard: number; soft: number; waived: number; checklist: number; text: string; violations: { node_id: string; layer: string; rule: string; severity: string; message: string }[] }
  | { t: 'run-history'; fileId: string }
  | { t: 'history'; fileId: string }
  | { t: 'sync-conflicts'; fileId: string }
  | { t: 'comment-run'; fileId: string; threadId: string; runner: string; status: CommentRunStatus; runId?: string; tool?: string; queueId?: string }
  | { t: 'run-queue' }
  | { t: 'agents-check'; id: string; status: string }
  | { t: 'race'; fileId: string; raceId: string }
  | { t: 'memory'; brandId?: string; fileId: string }
  | { t: 'pull'; id: string; fileId: string; status: string }
  | { t: 'conversation'; fileId: string; conversationId: string; closed?: boolean }
  /** `bogen open` on this machine: a window that has the file, or one in view, may take it (open-routes.ts). Sent to windows on this machine only. */
  | { t: 'open-request'; id: string; hash: string; raise: boolean };

export type CommentRunStatus = 'queued' | 'working' | 'done' | 'failed' | 'stopped';

/** The `/events` socket: one JSON message per event, to everyone connected. */
export class EventHub {
  private clients = new Set<WebSocket>();
  /** The sockets of windows on this machine, directly: not a phone, a paired device or anything behind a proxy. */
  private local = new Set<WebSocket>();
  private taps = new Set<(event: BogenEvent) => void>();

  add(ws: WebSocket, onThisMachine = false): void {
    this.clients.add(ws);
    if (onThisMachine) this.local.add(ws);
    ws.on('close', () => { this.clients.delete(ws); this.local.delete(ws); });
    ws.on('error', () => ws.terminate());
  }

  /** Sends to the windows on this machine only, and says to how many. */
  sendLocal(event: BogenEvent): number {
    const body = JSON.stringify(event);
    let sent = 0;
    for (const ws of this.local) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      ws.send(body);
      sent++;
    }
    return sent;
  }

  /** Hears every event in this process, with or without connected sockets. */
  tap(fn: (event: BogenEvent) => void): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  broadcast(event: BogenEvent): void {
    for (const fn of this.taps) fn(event);
    if (!this.clients.size) return;
    const body = JSON.stringify(event);
    for (const ws of this.clients) if (ws.readyState === WebSocket.OPEN) ws.send(body);
  }

  close(): void {
    for (const ws of this.clients) ws.close(1001);
    this.clients.clear();
    this.local.clear();
  }
}
