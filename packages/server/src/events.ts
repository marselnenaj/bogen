import { WebSocket } from 'ws';

export type BogenEvent =
  | { t: 'files' }
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
  | { t: 'conversation'; fileId: string; conversationId: string; closed?: boolean };

export type CommentRunStatus = 'queued' | 'working' | 'done' | 'failed' | 'stopped';

/** The `/events` socket: one JSON message per event, to everyone connected. */
export class EventHub {
  private clients = new Set<WebSocket>();
  private taps = new Set<(event: BogenEvent) => void>();

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => ws.terminate());
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
  }
}
