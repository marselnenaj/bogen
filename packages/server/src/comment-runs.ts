import { type CommentAttachment, type CommentThread, agentMentions, isRunnerId, newId, nodeToHtml, type BogenDoc } from '@bogen/core';
import type { RunEnd, RunnerId, Runs } from './agents.ts';
import type { ThreadFiles } from './comment-files.ts';
import type { CommentRunStatus, EventHub } from './events.ts';
import type { Storage } from './storage.ts';
import type { Rooms } from './sync.ts';
import { runImages } from './run-images.ts';
import { CLI_DEFAULT, EFFORT_ID, MODEL_ID } from './run-settings.ts';
import { effectiveRequest, requestLines, requestTitle, SYSTEM_AUTHOR } from './thread-request.ts';
import { errorMessage, HttpError } from './util.ts';

/** Waiting mentions per file. More than this and the person gets told, rather than a long silent queue. */
const MAX_QUEUED = 5;
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 20;
const LAYER_HTML_LIMIT = 6000;
/** Newest messages kept. A long thread is mostly the reason for the request in front of it. */
const THREAD_LIMIT = 24_000;
/** Earlier runs on a thread said in the prompt, newest kept, and how much of each. */
const EARLIER_RUNS = 4;
const EARLIER_LAYERS = 24;
const EARLIER_REPLY = 600;

/** A run that answered this thread before, as the run history keeps it. */
export interface EarlierRun { runner: string; status: string; startedAt: number; layers: string[]; tools: { name: string; count: number }[]; result?: string; nudged?: boolean }
const SYSTEM_ORIGIN = 'system:comment-runs';

export interface CommentInput {
  fileId: string;
  attachments?: CommentAttachment[];
  text: string;
  author: string;
  threadId?: string;
  pageId?: string;
  nodeId?: string;
  x?: number;
  y?: number;
  model?: string;
  effort?: string;
  /**
   * Who a message without a mention goes to, as the person chose it in the composer: an agent, or `comment` for
   * a plain comment. Left out, a reply goes where the thread's last request went. A mention in the text wins.
   */
  to?: RunnerId | 'comment';
}

/**
 * Where a person's messages in a thread go: the agent, model and effort of the last request in it. `default`
 * stands for the CLI's own choice, so that a reply keeps it rather than falling back to the cheap one.
 */
export interface ReplyTarget { runner: RunnerId; model: string; effort: string; at: number }

/** How a run was asked for: a mention in the text, an agent chosen in the composer, or the thread's last target. */
export type RouteKind = 'mention' | 'chosen' | 'inherited';

export interface CommentResult {
  threadId: string;
  messageId: string;
  /** The agents this comment asked for, which have now started or are queued. */
  started: RunnerId[];
  /** Why mentions did not start anything. */
  refused?: string;
  /** Where it went, when it went to an agent, and how that was decided. */
  target?: ReplyTarget & { how: RouteKind };
}

interface Pending { id: string; at: number; fileId: string; threadId: string; messageId: string; runner: RunnerId; model?: string; effort?: string }
interface Route { runner: RunnerId; asked: { model?: string; effort?: string }; how: RouteKind }
/** A tool the run called, for the steps under its thread. */
export interface ThreadStep { tool: string; at: number }
interface Active extends Pending { runId: string; since: number; steps: ThreadStep[] }
export interface ThreadRun { threadId: string; runner: string; status: CommentRunStatus; runId?: string; queueId?: string; steps?: ThreadStep[]; reason?: string }
/** A comment waiting for its run, as the queue in the Agents tab shows it. `reason` says what it waits for. */
export interface QueuedComment { id: string; fileId: string; threadId: string; runner: RunnerId; at: number; title: string; reason: string }

/** Steps kept per run under its thread. The run history keeps the counts of all of them. */
const MAX_STEPS = 30;

/**
 * Starts agents from comments. This is deliberately not an observer of the document: documents arrive
 * from sync peers, imported files and agents, and nothing in a document may start a process. The only way
 * in is `submit`, called for a request a person's editor made on this device.
 *
 * Waiting comments form one queue across files, in the order they came in, which the person can change. One
 * starts when its file has no run going and the server has a free slot; a file's own comments keep their order.
 */
export class CommentRuns {
  private queue: Pending[] = [];
  private active = new Map<string, Active>();
  private recent = new Map<string, number[]>();
  private closed = false;
  private pumping: Promise<void> = Promise.resolve();

  constructor(private readonly deps: {
    rooms: Rooms; runs: Runs; hub: EventHub; storage: Storage;
    choice?: (runner: RunnerId, asked: { model?: string; effort?: string }) => Promise<{ model?: string; effort?: string }>;
    /** Runs that answered a thread before, oldest first, so that the next one knows what was done. */
    earlier?: (fileId: string, threadId: string) => Promise<EarlierRun[]>;
    /** The images and files attached to the thread, as the run takes them. */
    files?: (fileId: string, thread: CommentThread, messageId: string) => Promise<ThreadFiles>;
    /**
     * The newest comment run of each thread, from the run history: where a reply goes in a thread whose last
     * request is older than the stored targets (`store`).
     */
    addressed?: (fileId: string) => Promise<Map<string, unknown>>;
    /** The last addressed target of each thread, kept on disk when a request is accepted. See `reply-targets.ts`. */
    store?: { load(fileId: string): Promise<Record<string, unknown>>; save(fileId: string, threadId: string, target: ReplyTarget): Promise<void> };
  }) {}

  /** The last target a person addressed in a thread, by `fileId` and thread, as this process accepted it. */
  private targets = new Map<string, ReplyTarget>();

  /**
   * Where a reply in this thread goes when the person names no agent: the agent and model of the last request a
   * person addressed in it, also when that request still waits in the queue. What this process accepted comes
   * first, then what is stored on disk (which outlives a restart and the queue), then the run history.
   */
  async targetOf(fileId: string, threadId: string): Promise<ReplyTarget | undefined> {
    return this.targets.get(`${fileId}\n${threadId}`) ?? (await this.targetsOf(fileId))[threadId];
  }

  /** Every thread of a file that has a target, for the composer. */
  async targetsOf(fileId: string): Promise<Record<string, ReplyTarget>> {
    const out: Record<string, ReplyTarget> = {};
    // Stored files are data on disk: only what a target can be is taken from them.
    const take = (entries: Iterable<[string, unknown]>, authoritative: boolean) => {
      for (const [threadId, raw] of entries) {
        const target = cleanTarget(raw);
        if (target && (authoritative || !out[threadId] || target.at >= out[threadId].at)) out[threadId] = target;
      }
    };
    // The history only stands in for threads from before targets were stored. Its time is when a run started, which
    // for a request that waited in the queue is later than a request accepted after it: a stored target always wins.
    take((await this.deps.addressed?.(fileId).catch(() => null)) ?? [], false);
    take(Object.entries((await this.deps.store?.load(fileId).catch(() => null)) ?? {}), true);
    for (const [key, target] of this.targets) {
      const [file, thread] = key.split('\n');
      if (file === fileId && thread) out[thread] = target;
    }
    return out;
  }

  /** The request a comment run answers, for the reply it writes. Only for runs going now. */
  requestOf(runId: string): { fileId: string; threadId: string; messageId: string } | undefined {
    for (const a of this.active.values()) if (a.runId === runId) return { fileId: a.fileId, threadId: a.threadId, messageId: a.messageId };
    return undefined;
  }

  /** Messages of a thread whose own run is waiting or going: a bare mention does not ask for them again. */
  private inFlight(fileId: string, threadId: string, except?: string): Set<string> {
    const ids = new Set<string>();
    for (const p of [...this.queue, ...this.active.values()]) if (p.fileId === fileId && p.threadId === threadId && p.messageId !== except) ids.add(p.messageId);
    return ids;
  }

  /**
   * Who a message goes to. A mention names the agents; without one, the person's choice in the composer, else the
   * agent the thread's last request went to, with its model and effort. An explicit model or effort always wins.
   * The same agent mentioned again keeps the thread's model, so that a bare "@claude" never drops to a cheaper one.
   */
  private async route(input: CommentInput, threadId: string, isNew: boolean): Promise<Route[]> {
    const explicit = { ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) };
    const inherited = isNew ? undefined : await this.targetOf(input.fileId, threadId);
    const keep = (runner: RunnerId) => (inherited?.runner === runner ? { model: inherited.model, effort: inherited.effort } : {});
    const mentioned = agentMentions(input.text);
    if (mentioned.length) return mentioned.map((runner) => ({ runner, asked: { ...keep(runner), ...explicit }, how: 'mention' }));
    if (input.to === 'comment') return [];
    if (input.to && isRunnerId(input.to)) return [{ runner: input.to, asked: { ...keep(input.to), ...explicit }, how: 'chosen' }];
    if (inherited) return [{ runner: inherited.runner, asked: { ...keep(inherited.runner), ...explicit }, how: 'inherited' }];
    return [];
  }

  /** Writes the comment. `local` says that a person on this device sent it, which is what allows a run. */
  async submit(input: CommentInput, local: boolean): Promise<CommentResult> {
    const room = await this.deps.rooms.get(input.fileId);
    const { doc } = room;
    const origin = `person:${input.author}`;
    let threadId = input.threadId;
    if (threadId) {
      if (!doc.comments.has(threadId)) throw new HttpError(404, `No comment thread with id ${threadId}.`);
      doc.replyThread(threadId, input.author, input.text, origin, input.attachments);
    } else {
      const pageId = input.nodeId ? doc.pageOf(input.nodeId) : input.pageId ?? doc.getPages()[0]?.id;
      if (!pageId || !doc.pages.has(pageId)) throw new HttpError(400, 'That page or layer does not exist.');
      threadId = doc.addThread({ pageId, ...(input.nodeId ? { nodeId: input.nodeId } : {}), x: input.x ?? 0, y: input.y ?? 0, author: input.author, text: input.text, ...(input.attachments ? { attachments: input.attachments } : {}) }, origin);
    }
    const thread = doc.getComments().find((t) => t.id === threadId)!;
    const messageId = thread.messages.at(-1)!.id;
    const result: CommentResult = { threadId, messageId, started: [] };

    const routes = await this.route(input, threadId, !input.threadId);
    if (!routes.length) return result;
    // A reply that would only have followed the thread stays a plain comment where no agent may start; the person
    // only hears a refusal for an agent they named or chose.
    const asked = routes.some((r) => r.how !== 'inherited');
    if (!local) return asked ? { ...result, refused: 'Agents only start for a person on the device that runs them.' } : result;
    // A client's words would be in the run's prompt. They are data from outside, so a thread they started never starts an agent.
    if (thread.client) return asked ? { ...result, refused: 'A thread from a client never starts an agent. Start one from a comment of your own.' } : result;
    // Asking again reopens a finished thread, or the answer would land somewhere filtered out of view.
    if (thread.resolved) doc.setThreadResolved(threadId, false, origin);

    for (const route of routes) {
      const refusal = this.admit(input.fileId);
      if (refusal) {
        this.note(doc, threadId, refusal);
        return { ...result, refused: refusal };
      }
      // Decided now rather than when it starts, so that the next reply follows exactly this choice.
      const choice = this.deps.choice ? await this.deps.choice(route.runner, route.asked) : route.asked;
      const target: ReplyTarget = { runner: route.runner, model: choice.model ?? CLI_DEFAULT, effort: choice.effort ?? CLI_DEFAULT, at: Date.now() };
      // The first agent asked is the one the thread's next reply goes to.
      if (!result.target) {
        this.targets.set(`${input.fileId}\n${threadId}`, target);
        await this.deps.store?.save(input.fileId, threadId, target).catch(() => {});
        result.target = { ...target, how: route.how };
      }
      const pending: Pending = { id: newId(), at: Date.now(), fileId: input.fileId, threadId, messageId, runner: route.runner, model: target.model, effort: target.effort };
      this.queue.push(pending);
      result.started.push(route.runner);
      this.announce({ fileId: input.fileId, threadId, runner: route.runner, status: 'queued', queueId: pending.id });
    }
    void this.pump();
    return result;
  }

  /** Why one more run cannot be accepted right now. */
  private admit(fileId: string): string | null {
    if (this.queue.filter((p) => p.fileId === fileId).length >= MAX_QUEUED) return `${MAX_QUEUED} comments are already waiting for an agent in this file. Mention it again once those are done.`;
    const now = Date.now();
    const times = (this.recent.get(fileId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (times.length >= MAX_PER_WINDOW) return `This file has started ${MAX_PER_WINDOW} agent runs from comments in the last ${WINDOW_MS / 60_000} minutes, which is the limit. Try again in a while.`;
    times.push(now);
    this.recent.set(fileId, times);
    return null;
  }

  /** What a waiting comment waits for, in the queue's order. */
  private reason(pending: Pending, index: number): string {
    const { runs } = this.deps;
    if (this.queue.slice(0, index).some((p) => p.fileId === pending.fileId)) return 'Waits behind an earlier comment in this file';
    const busy = this.active.get(pending.fileId);
    if (busy) return busy.runId ? `Waits for ${busy.runner} to finish in this file` : `Waits for ${busy.runner} to start in this file`;
    if (runs.activeFor(pending.fileId)) return 'Waits for the run going on this file';
    if (runs.count() >= runs.limit) return `Waits for a free slot: ${runs.limit} runs are going on this computer`;
    return 'Starting';
  }

  /** Starts what can start, in order. One pump at a time, so that two cannot take the same slot. */
  private pump(): Promise<void> {
    this.pumping = this.pumping.then(() => this.pumpNow(), () => this.pumpNow());
    return this.pumping;
  }

  private async pumpNow(): Promise<void> {
    for (let i = 0; i < this.queue.length && !this.closed;) {
      const next = this.queue[i]!;
      const { runs } = this.deps;
      const blocked = this.active.has(next.fileId) || Boolean(runs.activeFor(next.fileId)) || this.queue.slice(0, i).some((p) => p.fileId === next.fileId);
      if (blocked) {
        i++;
        continue;
      }
      if (runs.count() >= runs.limit) break;
      this.queue.splice(i, 1);
      await this.begin(next);
    }
  }

  /** Starts one waiting comment's run. */
  private async begin(next: Pending): Promise<void> {
    const { fileId } = next;
    const placeholder: Active = { ...next, runId: '', since: Date.now(), steps: [] };
    // Taken before the first await, so that nothing else starts on this file meanwhile.
    this.active.set(fileId, placeholder);
    const room = await this.deps.rooms.get(fileId).catch(() => null);
    if (!room || !room.doc.comments.has(next.threadId)) {
      this.active.delete(fileId);
      return;
    }
    const entry = this.deps.storage.get(fileId);
    try {
      const thread = room.doc.getComments().find((t) => t.id === next.threadId)!;
      // A comment costs what the person chose for comments, which starts out as the cheapest the CLI offers.
      const asked = { ...(next.model ? { model: next.model } : {}), ...(next.effort ? { effort: next.effort } : {}) };
      const chosen = this.deps.choice ? await this.deps.choice(next.runner, asked) : asked;
      // `default` is no flag at all: the CLI decides.
      const choice = { ...(chosen.model && chosen.model !== CLI_DEFAULT ? { model: chosen.model } : {}), ...(chosen.effort && chosen.effort !== CLI_DEFAULT ? { effort: chosen.effort } : {}) };
      const earlier = (await this.deps.earlier?.(fileId, next.threadId).catch(() => [])) ?? [];
      const files = await this.deps.files?.(fileId, thread, next.messageId).catch(() => null);
      const pictures = files ? [] : (thread.messages.find((m) => m.id === next.messageId)?.attachments ?? []).filter((a) => a.kind !== 'audio' && a.src.startsWith('bogen-asset:')).map((a) => a.src);
      const images = files?.images ?? (pictures.length ? await runImages(this.deps.storage, pictures).catch(() => []) : []);
      const inFlight = this.inFlight(fileId, next.threadId, next.messageId);
      const prompt = threadPrompt(room.doc, next.threadId, next.messageId, earlier, inFlight);
      const runId = await this.deps.runs.start({
        fileId, fileName: entry?.name ?? fileId, pageId: thread.pageId, nodeIds: thread.nodeId ? [thread.nodeId] : [],
        prompt: files?.text ? `${prompt}\n\n${files.text}` : prompt, ...(images.length ? { images } : {}),
        // What the run was asked, which is also what decides between edit and revision, and whether it gets nudged.
        title: requestTitle(effectiveRequest(thread, next.messageId, inFlight)), runner: next.runner, threadId: next.threadId, ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}),
      }, {
        onTool: (id, tool) => {
          placeholder.steps.push({ tool, at: Date.now() });
          if (placeholder.steps.length > MAX_STEPS) placeholder.steps.splice(0, placeholder.steps.length - MAX_STEPS);
          this.announce({ fileId, threadId: next.threadId, runner: next.runner, status: 'working', runId: id, tool, queueId: next.id });
        },
      });
      placeholder.runId = runId;
      placeholder.since = Date.now();
      this.announce({ fileId, threadId: next.threadId, runner: next.runner, status: 'working', runId, queueId: next.id });
    } catch (e) {
      this.active.delete(fileId);
      this.note(room.doc, next.threadId, `${next.runner} could not start: ${errorMessage(e)}`);
      this.announce({ fileId, threadId: next.threadId, runner: next.runner, status: 'failed' });
    }
  }

  /** Every run on the server ends here: a slot is free, and a comment waiting behind a prompt run moves on too. */
  runEnded(end: RunEnd): void {
    if (this.closed) return;
    const active = this.active.get(end.fileId);
    if (active?.runId === end.runId) {
      this.active.delete(end.fileId);
      void this.settle(active, end);
    }
    void this.pump();
  }

  private async settle(active: Active, end: RunEnd): Promise<void> {
    this.announce({ fileId: end.fileId, threadId: active.threadId, runner: active.runner, status: end.status, runId: end.runId });
    const room = await this.deps.rooms.get(end.fileId).catch(() => null);
    if (!room) return;
    const { doc } = room;
    const thread = doc.getComments().find((t) => t.id === active.threadId);
    if (!thread) return;
    const steps = active.steps.length;
    if (end.status === 'stopped') this.note(doc, thread.id, `${active.runner} was stopped${steps ? ` after ${steps} ${steps === 1 ? 'step' : 'steps'}. What it changed until then stays, and Undo this run takes it back` : ' before it did anything'}.`);
    else if (end.status === 'failed') this.note(doc, thread.id, `${active.runner} stopped with an error: ${(end.error ?? 'unknown').slice(0, 500)}`);
    else if (!thread.messages.some((m) => m.author === active.runner && m.at >= active.since)) this.note(doc, thread.id, `${active.runner} finished without answering here.`);
  }

  /**
   * Takes a comment out of the queue before it starts, or stops its run when it has started. False when there
   * is no such comment. The thread says plainly that nobody will answer, and who decided that.
   */
  async cancel(queueId: string, who: string): Promise<boolean> {
    const index = this.queue.findIndex((p) => p.id === queueId);
    if (index >= 0) {
      const pending = this.queue.splice(index, 1)[0]!;
      this.announce({ fileId: pending.fileId, threadId: pending.threadId, runner: pending.runner, status: 'stopped', queueId });
      const room = await this.deps.rooms.get(pending.fileId).catch(() => null);
      if (room) this.note(room.doc, pending.threadId, `${who} took the request to ${pending.runner} out of the queue before it started.`);
      void this.pump();
      return true;
    }
    for (const active of this.active.values()) {
      if (active.id === queueId) return active.runId ? this.deps.runs.stop(active.runId) : false;
    }
    return false;
  }

  /** Puts a waiting comment at another place in the queue, counted over all files. */
  move(queueId: string, to: number): boolean {
    const index = this.queue.findIndex((p) => p.id === queueId);
    if (index < 0) return false;
    const pending = this.queue.splice(index, 1)[0]!;
    this.queue.splice(Math.max(0, Math.min(this.queue.length, Math.round(to))), 0, pending);
    this.deps.hub.broadcast({ t: 'run-queue' });
    void this.pump();
    return true;
  }

  /** Every waiting comment over all files, in the order they would start, with what each waits for. */
  queued(): QueuedComment[] {
    return this.queue.map((p, i) => {
      const thread = this.deps.rooms.peek(p.fileId)?.doc.getComments().find((t) => t.id === p.threadId);
      const title = thread ? requestTitle(effectiveRequest(thread, p.messageId, this.inFlight(p.fileId, p.threadId, p.messageId))) : '';
      return { id: p.id, fileId: p.fileId, threadId: p.threadId, runner: p.runner, at: p.at, title: title.replace(/\s+/g, ' ').trim().slice(0, 200), reason: this.reason(p, i) };
    });
  }

  /** The waiting or running comment of a run, for the queue. */
  queueIdOf(runId: string): string | undefined {
    for (const a of this.active.values()) if (a.runId === runId) return a.id;
    return undefined;
  }

  /** The thread says plainly what happened, also for whoever reads it later. */
  private note(doc: BogenDoc, threadId: string, text: string): void {
    if (doc.comments.has(threadId)) doc.replyThread(threadId, SYSTEM_AUTHOR, text, SYSTEM_ORIGIN, undefined, 'system');
  }

  private announce(event: { fileId: string; threadId: string; runner: string; status: CommentRunStatus; runId?: string; tool?: string; queueId?: string }): void {
    this.deps.hub.broadcast({ t: 'comment-run', ...event });
  }

  /** What is going on, for an editor that opens the file midway. */
  list(fileId: string): ThreadRun[] {
    const active = this.active.get(fileId);
    return [
      ...(active ? [{ threadId: active.threadId, runner: active.runner, status: 'working' as const, queueId: active.id, steps: [...active.steps], ...(active.runId ? { runId: active.runId } : {}) }] : []),
      ...this.queue.flatMap((p, i) => (p.fileId === fileId ? [{ threadId: p.threadId, runner: p.runner, status: 'queued' as const, queueId: p.id, reason: this.reason(p, i) }] : [])),
    ];
  }

  forget(fileId: string): void {
    this.queue = this.queue.filter((p) => p.fileId !== fileId);
    this.recent.delete(fileId);
    for (const key of this.targets.keys()) if (key.startsWith(`${fileId}\n`)) this.targets.delete(key);
  }

  /** Runs are being killed with the server. That is not news for the thread. */
  close(): void {
    this.closed = true;
    this.queue = [];
  }
}

/** What earlier runs did on the thread. Their replies are in the thread already; what they changed is not. */
function earlierLines(runs: EarlierRun[]): string[] {
  if (!runs.length) return [];
  const shown = runs.slice(-EARLIER_RUNS);
  const lines = shown.map((r) => {
    // comment_resolve is gone, but older runs in the history used it: never show it to an agent as something to do.
    const tools = r.tools.filter((t) => t.name !== 'comment_reply' && t.name !== 'comment_resolve').map((t) => (t.count > 1 ? `${t.name} x${t.count}` : t.name)).join(', ');
    const layers = r.layers.length ? `changed layers ${r.layers.slice(0, EARLIER_LAYERS).join(', ')}${r.layers.length > EARLIER_LAYERS ? ` and ${r.layers.length - EARLIER_LAYERS} more` : ''}` : 'changed no layers';
    const said = r.result ? ` It ended with: ${r.result.replace(/\s+/g, ' ').trim().slice(0, EARLIER_REPLY)}` : '';
    return `- ${r.runner}, ${new Date(r.startedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC, ${r.status}${r.nudged ? ' after being asked again to make the change' : ''}: ${layers}${tools ? ` (tools: ${tools})` : ''}.${said}`;
  });
  return ['', `What agents did on this thread before${runs.length > shown.length ? ` (the last ${shown.length} of ${runs.length} runs)` : ''}, oldest first. Build on it rather than starting over:`, ...lines];
}

/** The thread and its layer, as a request. Bounded, since a thread can be long and a layer large. */
export function threadPrompt(doc: BogenDoc, threadId: string, messageId: string, earlier: EarlierRun[] = [], inFlight: ReadonlySet<string> = new Set()): string {
  const thread = doc.getComments().find((t) => t.id === threadId);
  if (!thread) throw new Error(`No comment thread with id ${threadId}.`);
  const asked = thread.messages.find((m) => m.id === messageId);
  const history = thread.messages.map((m) => `${m.author}: ${m.text}`).join('\n').slice(-THREAD_LIMIT);
  const author = asked?.author ?? 'a person';
  const parts = [`Comment thread ${threadId}:`, history, ...earlierLines(earlier), '', `The message to answer, from ${author}: ${asked?.text ?? ''}`, ...requestLines(effectiveRequest(thread, messageId, inFlight), author)];
  if (thread.suggestion) parts.push('', `${thread.suggestion.by} suggested this change when it started the thread: ${thread.suggestion.text}`);
  const node = thread.nodeId ? doc.getNode(thread.nodeId) : undefined;
  if (node) {
    const html = nodeToHtml(doc, node.id, { indent: true, stripRootPosition: true });
    parts.push('', `The thread is pinned to layer ${node.id}, a ${node.type} named "${node.name}" on page ${thread.pageId}. Its HTML:`, html.length > LAYER_HTML_LIMIT ? `${html.slice(0, LAYER_HTML_LIMIT)}\n... cut here, read more with layer_tree and layer_get` : html);
  } else parts.push('', `The thread is on page ${thread.pageId}, at x ${thread.x}, y ${thread.y}.`);
  return parts.join('\n');
}


/** A target as it may be: a known runner, and a model and effort the CLIs take, or `default`. */
export function cleanTarget(raw: unknown): ReplyTarget | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  if (!isRunnerId(t.runner)) return undefined;
  const model = typeof t.model === 'string' && MODEL_ID.test(t.model) ? t.model : CLI_DEFAULT;
  const effort = typeof t.effort === 'string' && (t.effort === CLI_DEFAULT || EFFORT_ID.test(t.effort)) ? t.effort : CLI_DEFAULT;
  return { runner: t.runner, model, effort, at: typeof t.at === 'number' && Number.isFinite(t.at) ? t.at : 0 };
}
