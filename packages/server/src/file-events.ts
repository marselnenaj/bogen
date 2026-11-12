import { listProposals, newId, proposalDecision, proposalMark, Y } from '@bogen/core';
import type { WebSocket } from 'ws';
import type { Room } from './sync.ts';

export type FileEventKind = 'comment_added' | 'comment_replied' | 'comment_resolved' | 'comment_reopened' | 'selection_changed' | 'page_changed' | 'layer_changed_by_person' | 'tokens_changed' | 'agent_finished' | 'agent_idle' | 'proposal_created' | 'proposal_accepted' | 'proposal_discarded' | 'brand_changed' | 'brand_checked';
export const FILE_EVENT_KINDS = ['comment_added', 'comment_replied', 'comment_resolved', 'comment_reopened', 'selection_changed', 'page_changed', 'layer_changed_by_person', 'tokens_changed', 'agent_finished', 'agent_idle', 'proposal_created', 'proposal_accepted', 'proposal_discarded', 'brand_changed', 'brand_checked'] as const satisfies readonly FileEventKind[];

/** Who caused an event. `peer` is another of this person's devices, which may be a person or an agent over there. */
export type EventSource = 'person' | 'peer' | 'agent' | 'system';

export interface FileEvent {
  seq: number;
  kind: FileEventKind;
  at: number;
  source: EventSource;
  actor?: string;
  [detail: string]: unknown;
}

/** What a resource shows. Listeners hear about every change, whoever made it. */
export type EventTopic = 'selection' | 'tokens' | 'tree' | 'comments';

export interface WaitOptions {
  cursor?: string;
  kinds?: readonly string[];
  /** Leaves out what this agent did itself, so that an agent's own writes do not wake it. */
  excludeAgent?: string;
  timeoutMs: number;
  limit: number;
  signal?: AbortSignal;
}

export interface WaitResult {
  events: FileEvent[];
  cursor: string;
  timedOut: boolean;
  /** The server restarted since this cursor was made, so what happened in between is unknown. */
  reset?: boolean;
  /** The log has moved past this cursor, so some events are gone. */
  missed?: boolean;
}

interface Log {
  events: FileEvent[];
  next: number;
  waiters: Set<() => void>;
}

/** Per file. An agent further behind than this gets `missed`, and catches up with comments_list and layer_tree. */
const LOG_SIZE = 500;
const MAX_LOGS = 200;
const MAX_WAITERS = 64;
const AWARENESS_SETTLE_MS = 200;
const LAYER_SETTLE_MS = 400;
const TEXT_LIMIT = 2000;
const IDS_LIMIT = 50;

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Reads what a transaction's origin says about who made it. */
export function sourceOf(room: Room, origin: unknown): { source: EventSource; actor?: string } {
  if (typeof origin === 'string') {
    if (origin.startsWith('agent:')) return { source: 'agent', actor: origin.slice(6) };
    if (origin.startsWith('person:')) return { source: 'person', actor: origin.slice(7) };
    if (origin.startsWith('peer:')) return { source: 'peer', actor: origin.slice(5) };
    return { source: 'system' };
  }
  if (origin instanceof Y.UndoManager) {
    const tracked = [...origin.trackedOrigins].find((o): o is string => typeof o === 'string' && o.startsWith('agent:'));
    return tracked ? { source: 'agent', actor: tracked.slice(6) } : { source: 'system' };
  }
  const owned = room.conns.get(origin as WebSocket);
  if (!owned) return { source: 'system' };
  const client = [...owned].map((id) => room.awareness.getStates().get(id)).find((state) => state?.user);
  return { source: 'person', ...(client ? { actor: String(client.user.name) } : {}) };
}

/**
 * What happened in each file, kept in memory: a log that agents read with a cursor, and a signal for
 * resource subscriptions. It is an observer only. Nothing here can start anything.
 */
export class FileEvents {
  /** New on every start, so that a cursor from before a restart is recognized. */
  readonly epoch = newId(6);
  private logs = new Map<string, Log>();
  private topics = new Set<(fileId: string, topic: EventTopic) => void>();
  private listeners = new Set<(fileId: string, event: FileEvent) => void>();
  private closed = false;

  private log(fileId: string): Log {
    let log = this.logs.get(fileId);
    if (!log) {
      log = { events: [], next: 1, waiters: new Set() };
      this.logs.set(fileId, log);
      if (this.logs.size > MAX_LOGS) {
        for (const [id, candidate] of this.logs) {
          if (id !== fileId && !candidate.waiters.size) {
            this.logs.delete(id);
            break;
          }
        }
      }
    }
    return log;
  }

  append(fileId: string, kind: FileEventKind, who: { source: EventSource; actor?: string }, detail: Record<string, unknown> = {}): FileEvent {
    const log = this.log(fileId);
    const event: FileEvent = { ...detail, seq: log.next++, kind, at: Date.now(), source: who.source, ...(who.actor ? { actor: who.actor } : {}) };
    log.events.push(event);
    if (log.events.length > LOG_SIZE) log.events.splice(0, log.events.length - LOG_SIZE);
    for (const wake of [...log.waiters]) wake();
    for (const fn of this.listeners) fn(fileId, event);
    return event;
  }

  /** Hears every event of every file. It only reads: nothing that listens here may start anything. */
  onEvent(fn: (fileId: string, event: FileEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A cursor at the current end of the log. */
  head(fileId: string): string {
    return `${this.epoch}.${fileId}.${this.log(fileId).next - 1}`;
  }

  onTopic(fn: (fileId: string, topic: EventTopic) => void): () => void {
    this.topics.add(fn);
    return () => this.topics.delete(fn);
  }

  private touch(fileId: string, topic: EventTopic): void {
    for (const fn of this.topics) fn(fileId, topic);
  }

  /** Returns at once if something is already there after the cursor, else at the next event or the timeout. */
  async wait(fileId: string, options: WaitOptions): Promise<WaitResult> {
    const log = this.log(fileId);
    const [epoch, file, seq] = (options.cursor ?? '').split('.');
    const known = options.cursor !== undefined && epoch === this.epoch && file === fileId && /^\d+$/.test(seq ?? '');
    const reset = options.cursor !== undefined && !known;
    // With no cursor the wait starts now. A cursor from another run of the server reads all this run has.
    let after = known ? Number(seq) : options.cursor === undefined ? log.next - 1 : 0;
    if (after > log.next - 1) after = log.next - 1;
    const first = log.events[0];
    const missed = known && first !== undefined && first.seq > after + 1;
    const wanted = (e: FileEvent) => (!options.kinds?.length || options.kinds.includes(e.kind)) && !(options.excludeAgent && e.source === 'agent' && e.actor === options.excludeAgent);
    const read = () => {
      const fresh = log.events.filter((e) => e.seq > after);
      const hits = fresh.filter(wanted);
      if (hits.length > options.limit) {
        // The rest stays behind the returned cursor.
        const kept = hits.slice(0, options.limit);
        return { kept, cursor: kept.at(-1)!.seq };
      }
      return { kept: hits, cursor: fresh.at(-1)?.seq ?? after };
    };
    const reply = (found: ReturnType<typeof read>, timedOut: boolean): WaitResult => ({
      events: found.kept, cursor: `${this.epoch}.${fileId}.${found.cursor}`, timedOut,
      ...(reset ? { reset } : {}), ...(missed ? { missed } : {}),
    });

    let found = read();
    if (found.kept.length || options.timeoutMs <= 0 || this.closed) return reply(found, !found.kept.length);
    if (log.waiters.size >= MAX_WAITERS) throw new Error(`${MAX_WAITERS} agents are already waiting on this file. Try again in a moment.`);

    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        log.waiters.delete(wake);
        options.signal?.removeEventListener('abort', finish);
        resolve();
      };
      const wake = () => {
        if (this.closed || read().kept.length) finish();
      };
      const timer = setTimeout(finish, options.timeoutMs);
      timer.unref();
      log.waiters.add(wake);
      options.signal?.addEventListener('abort', finish);
      if (options.signal?.aborted) finish();
    });
    found = read();
    return reply(found, !found.kept.length);
  }

  /** Starts watching a loaded file. */
  watch(room: Room): void {
    const fileId = room.id;
    const { doc } = room;

    const threads = new Map<string, { messages: Set<string>; resolved: boolean }>();
    for (const t of doc.getComments()) threads.set(t.id, { messages: new Set(t.messages.map((m) => m.id)), resolved: t.resolved });
    const onComments = (_events: unknown, tx: Y.Transaction) => {
      const who = sourceOf(room, tx.origin);
      const present = new Set<string>();
      for (const t of doc.getComments()) {
        present.add(t.id);
        let known = threads.get(t.id);
        const fresh = !known;
        if (!known) {
          known = { messages: new Set(), resolved: t.resolved };
          threads.set(t.id, known);
        }
        for (const m of t.messages) {
          if (known.messages.has(m.id)) continue;
          known.messages.add(m.id);
          this.append(fileId, fresh && m === t.messages[0] ? 'comment_added' : 'comment_replied', who, {
            thread_id: t.id, message_id: m.id, author: m.author, text: m.text.slice(0, TEXT_LIMIT), page_id: t.pageId,
            ...(t.nodeId ? { node_id: t.nodeId, layer_name: doc.getNode(t.nodeId)?.name } : {}),
            ...(t.client ? { from_client: true } : {}),
          });
        }
        if (known.resolved !== t.resolved) {
          known.resolved = t.resolved;
          this.append(fileId, t.resolved ? 'comment_resolved' : 'comment_reopened', who, { thread_id: t.id });
        }
      }
      for (const id of threads.keys()) if (!present.has(id)) threads.delete(id);
      this.touch(fileId, 'comments');
    };
    doc.comments.observeDeep(onComments);

    // A drag makes a stream of small transactions. Agents want to hear about it once it settles.
    let changed = new Map<string, { source: EventSource; actor?: string; ids: Set<string> }>();
    let layerTimer: NodeJS.Timeout | null = null;
    const flushLayers = () => {
      layerTimer = null;
      const batches = changed;
      changed = new Map();
      for (const batch of batches.values()) {
        const ids = [...batch.ids];
        this.append(fileId, 'layer_changed_by_person', { source: batch.source, ...(batch.actor ? { actor: batch.actor } : {}) }, { node_ids: ids.slice(0, IDS_LIMIT), count: ids.length });
      }
    };
    // A proposal is a layer with a mark. It is gone either because its content went into the original or because it was discarded.
    const proposals = new Map(listProposals(doc).map((p) => [p.id, p]));
    const onProposals = (events: Y.YEvent<any>[], tx: Y.Transaction, who: { source: EventSource; actor?: string }) => {
      const top = events.find((e) => e.path.length === 0);
      if (!top) return;
      const accepted = new Map<string, string>();
      for (const [id, { action }] of top.changes.keys) {
        const receipt = action === 'delete' ? proposalDecision(doc, id) : undefined;
        if (receipt && proposals.get(id)?.of === receipt.source) {
          if (receipt.decision === 'accepted') accepted.set(receipt.source, id);
          else if (!accepted.has(receipt.source)) accepted.set(receipt.source, '');
        }
      }
      for (const [id, { action }] of top.changes.keys) {
        if (action === 'add') {
          const mark = proposalMark(doc, id);
          if (!mark) continue;
          const info = { id, of: mark.of, by: mark.by, at: mark.at, name: doc.getNode(id)!.name, sourceExists: true, ...(mark.note ? { note: mark.note } : {}) };
          proposals.set(id, info);
          this.append(fileId, 'proposal_created', who, { proposal_id: id, node_id: mark.of, ...(mark.note ? { note: mark.note } : {}) });
        } else if (action === 'delete' && proposals.has(id)) {
          const info = proposals.get(id)!;
          proposals.delete(id);
          const source = doc.nodes.get(info.of);
          const style = source?.get('style') as Y.Map<string> | undefined;
          const changed = tx.changed as Map<unknown, unknown>;
          // Accepting keeps the original's ids and may change only layers inside it (or move the copy's new ones in).
          const inside = source ? new Set([info.of, ...doc.descendants(info.of).map((n) => n.id)]) : new Set<string>();
          const picked = accepted.has(info.of) ? accepted.get(info.of) === id : Boolean(source && (changed.has(source) || (style && changed.has(style)) || events.some((e) => typeof e.path[0] === 'string' && inside.has(e.path[0]))));
          this.append(fileId, picked ? 'proposal_accepted' : 'proposal_discarded', who, { proposal_id: id, node_id: info.of });
        }
      }
    };
    const onNodes = (events: Y.YEvent<any>[], tx: Y.Transaction) => {
      this.touch(fileId, 'tree');
      const who = sourceOf(room, tx.origin);
      onProposals(events, tx, who);
      if (who.source !== 'person' && who.source !== 'peer') return;
      const key = `${who.source}:${who.actor ?? ''}`;
      const batch = changed.get(key) ?? { ...who, ids: new Set<string>() };
      changed.set(key, batch);
      for (const event of events) {
        if (event.path.length) batch.ids.add(String(event.path[0]));
        else for (const id of event.keys.keys()) batch.ids.add(id);
      }
      layerTimer ??= setTimeout(flushLayers, LAYER_SETTLE_MS);
      layerTimer.unref();
    };
    doc.nodes.observeDeep(onNodes);
    const onPages = () => this.touch(fileId, 'tree');
    doc.pages.observeDeep(onPages);
    const onTokens = (_events: unknown, tx: Y.Transaction) => {
      this.touch(fileId, 'tokens');
      this.append(fileId, 'tokens_changed', sourceOf(room, tx.origin), { tokens: doc.getTokens().length });
    };
    doc.tokens.observeDeep(onTokens);

    const seen = new Map<number, { selection: string[]; pageId?: string }>();
    let awarenessTimer: NodeJS.Timeout | null = null;
    const flushAwareness = () => {
      awarenessTimer = null;
      const here = new Set<number>();
      for (const human of room.humans()) {
        here.add(human.clientId);
        const before = seen.get(human.clientId);
        seen.set(human.clientId, { selection: human.selection, pageId: human.pageId });
        const who = { source: 'person' as const, actor: human.name };
        if (human.pageId && human.pageId !== before?.pageId) {
          this.append(fileId, 'page_changed', who, { page_id: human.pageId, page_name: doc.getPages().find((p) => p.id === human.pageId)?.name });
          this.touch(fileId, 'selection');
        }
        if (!sameList(human.selection, before?.selection ?? [])) {
          this.append(fileId, 'selection_changed', who, {
            page_id: human.pageId,
            selection: human.selection.slice(0, IDS_LIMIT).flatMap((id) => {
              const n = doc.getNode(id);
              return n ? [{ id, type: n.type, name: n.name }] : [];
            }),
          });
          this.touch(fileId, 'selection');
        }
      }
      for (const id of seen.keys()) {
        if (!here.has(id)) {
          seen.delete(id);
          this.touch(fileId, 'selection');
        }
      }
    };
    const onAwareness = () => {
      // Cursors change this many times a second, so the comparison runs on a timer.
      awarenessTimer ??= setTimeout(flushAwareness, AWARENESS_SETTLE_MS);
      awarenessTimer.unref();
    };
    room.awareness.on('change', onAwareness);

    room.cleanups.push(() => {
      if (layerTimer) clearTimeout(layerTimer);
      if (awarenessTimer) clearTimeout(awarenessTimer);
      room.awareness.off('change', onAwareness);
      doc.comments.unobserveDeep(onComments);
      doc.nodes.unobserveDeep(onNodes);
      doc.pages.unobserveDeep(onPages);
      doc.tokens.unobserveDeep(onTokens);
    });
  }

  forget(fileId: string): void {
    const log = this.logs.get(fileId);
    if (log) for (const wake of [...log.waiters]) wake();
    this.logs.delete(fileId);
  }

  close(): void {
    this.closed = true;
    for (const log of this.logs.values()) for (const wake of [...log.waiters]) wake();
    this.topics.clear();
  }
}
