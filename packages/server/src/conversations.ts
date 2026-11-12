import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEnd, RunnerId, RunObserver, RunRequest, RunReview } from './agents.ts';
import type { EventHub } from './events.ts';
import { TALK_TOOLS } from './run-guard.ts';
import { atomicWrite, errorMessage } from './util.ts';

/**
 * Chats with an agent, per file. Every run starts a fresh CLI with no memory of its own, so a conversation is
 * kept here: each turn is what the person said, what the agent answered, who answered and which layers it touched.
 * The next run in the same conversation gets a compact transcript of the turns before it, whichever CLI ran them.
 * The id comes from the client, so a phone and a computer that use the same id share one conversation.
 */

export type TurnStatus = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted';

export interface Turn {
  runId: string;
  at: number;
  runner: RunnerId;
  /** What the person said, without the transcript that went with it. */
  message: string;
  reply?: string;
  /** Layers the run created or changed. */
  layers: string[];
  status: TurnStatus;
  review?: RunReview;
  /** It replied without changing anything and was asked once more. */
  nudged?: boolean;
}

export interface Conversation { id: string; fileId: string; startedAt: number; updatedAt: number; turns: Turn[] }

const MAX_CONVERSATIONS = 40;
const MAX_TURNS = 60;
const MAX_LAYERS = 60;
const STORE_KEY = /^[\w-]{1,80}$/;
const SAVE_DELAY_MS = 300;

/** What the transcript in a prompt may hold. Newest turns are kept, older ones are counted. */
export const TRANSCRIPT = { turns: 8, chars: 6000, message: 1200, reply: 1200, layers: 24 };

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The earlier turns as plain text for a prompt, oldest first, bounded by `TRANSCRIPT`. Empty when there are none. */
export function transcript(turns: Turn[], limits = TRANSCRIPT): string {
  const blocks: string[] = [];
  let used = 0;
  const done = turns.filter((t) => t.status !== 'running');
  for (const turn of [...done].reverse()) {
    if (blocks.length >= limits.turns) break;
    const how = turn.status === 'done' ? '' : turn.status === 'interrupted' ? ' (cut off)' : ` (${turn.status})`;
    const lines = [`The person: ${cut(oneLine(turn.message), limits.message)}`, `${turn.runner} answered${how}: ${turn.reply ? cut(oneLine(turn.reply), limits.reply) : '(nothing)'}`];
    if (turn.layers.length) lines.push(`Layers it created or changed: ${turn.layers.slice(0, limits.layers).join(', ')}${turn.layers.length > limits.layers ? ` and ${turn.layers.length - limits.layers} more` : ''}`);
    const block = lines.join('\n');
    if (used + block.length > limits.chars && blocks.length) break;
    blocks.unshift(block.length > limits.chars ? cut(block, limits.chars) : block);
    used += block.length;
  }
  if (!blocks.length) return '';
  const left = done.length - blocks.length;
  return [
    `Earlier in this conversation, oldest first${left ? ` (${left} older ${left === 1 ? 'turn' : 'turns'} left out)` : ''}:`,
    blocks.join('\n\n'),
    'Layers may have changed since. Read them again before you rely on an id.',
  ].join('\n\n');
}

interface Book { list: Conversation[]; timer: NodeJS.Timeout | null; write: Promise<void> }

/** Conversations per file, in `$BOGEN_HOME/conversations/<fileId>.json`, next to the run history. Survives a restart. */
export class Conversations implements RunObserver {
  private books = new Map<string, Book>();
  private loading = new Map<string, Promise<Book>>();
  /** Turns of runs still going, by run id. */
  private live = new Map<string, { fileId: string; turn: Turn }>();

  constructor(private readonly home: string, hub: EventHub) {
    hub.tap((event) => {
      if (event.t !== 'activity' || !event.runId || TALK_TOOLS.has(event.tool)) return;
      const live = this.live.get(event.runId);
      if (!live) return;
      for (const id of event.nodeIds) {
        if (live.turn.layers.length >= MAX_LAYERS) break;
        if (!live.turn.layers.includes(id)) live.turn.layers.push(id);
      }
      this.saveSoon(live.fileId);
    });
  }

  private path(fileId: string): string {
    if (!STORE_KEY.test(fileId)) throw new Error('Not a conversation key.');
    return join(this.home, 'conversations', `${fileId}.json`);
  }

  private book(fileId: string): Promise<Book> {
    const known = this.books.get(fileId);
    if (known) return Promise.resolve(known);
    let pending = this.loading.get(fileId);
    if (!pending) {
      pending = this.read(fileId).finally(() => this.loading.delete(fileId));
      this.loading.set(fileId, pending);
    }
    return pending;
  }

  private async read(fileId: string): Promise<Book> {
    let list: Conversation[] = [];
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path(fileId), 'utf8'));
      if (Array.isArray(parsed)) list = parsed as Conversation[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`bogen: the conversations of ${fileId} were unreadable: ${errorMessage(e)}`);
    }
    // A turn that was going when the server stopped did not finish.
    for (const c of list) for (const t of c.turns) if (t.status === 'running' && !this.live.has(t.runId)) t.status = 'interrupted';
    const book = this.books.get(fileId) ?? { list, timer: null, write: Promise.resolve() };
    this.books.set(fileId, book);
    return book;
  }

  async get(fileId: string, id: string): Promise<Conversation | undefined> {
    return (await this.book(fileId)).list.find((c) => c.id === id);
  }

  /** Puts the transcript of the earlier turns ahead of the request. Runs outside a conversation pass unchanged. */
  async prepare(req: RunRequest): Promise<RunRequest> {
    if (!req.conversationId || req.threadId) return req;
    const conversation = await this.get(req.fileId, req.conversationId);
    const context = conversation ? transcript(conversation.turns) : '';
    return context ? { ...req, context } : req;
  }

  started(runId: string, req: RunRequest): void {
    const id = req.conversationId;
    if (!id || req.threadId) return;
    const turn: Turn = { runId, at: Date.now(), runner: req.runner, message: cut(req.title ?? req.prompt, 4000), layers: [], status: 'running', ...(req.review ? { review: req.review } : {}) };
    this.live.set(runId, { fileId: req.fileId, turn });
    void this.book(req.fileId).then((book) => {
      let conversation = book.list.find((c) => c.id === id);
      if (!conversation) {
        conversation = { id, fileId: req.fileId, startedAt: turn.at, updatedAt: turn.at, turns: [] };
        book.list.unshift(conversation);
      }
      conversation.turns.push(turn);
      if (conversation.turns.length > MAX_TURNS) conversation.turns.splice(0, conversation.turns.length - MAX_TURNS);
      conversation.updatedAt = turn.at;
      // The ones talked in last stay.
      book.list.sort((a, b) => b.updatedAt - a.updatedAt);
      if (book.list.length > MAX_CONVERSATIONS) book.list.length = MAX_CONVERSATIONS;
      this.saveSoon(req.fileId);
    });
  }

  event(runId: string, event: { kind: string; text?: string }): void {
    const live = this.live.get(runId);
    if (!live) return;
    if (event.kind === 'text' && event.text) live.turn.reply = cut(event.text, 8000);
    else if (event.kind === 'nudge') live.turn.nudged = true;
    else return;
    this.saveSoon(live.fileId);
  }

  ended(end: RunEnd): void {
    const live = this.live.get(end.runId);
    if (!live) return;
    this.live.delete(end.runId);
    live.turn.status = end.status;
    this.saveSoon(live.fileId);
  }

  private saveSoon(fileId: string): void {
    const book = this.books.get(fileId);
    if (!book || book.timer) return;
    book.timer = setTimeout(() => {
      book.timer = null;
      void this.save(fileId, book);
    }, SAVE_DELAY_MS);
    book.timer.unref();
  }

  private save(fileId: string, book: Book): Promise<void> {
    const body = JSON.stringify(book.list);
    book.write = book.write.catch(() => {}).then(async () => {
      await mkdir(join(this.home, 'conversations'), { recursive: true });
      await atomicWrite(this.path(fileId), body, 0o600);
    });
    book.write.catch((e) => console.error(`bogen: could not save the conversations of ${fileId}: ${errorMessage(e)}`));
    return book.write;
  }

  async forget(fileId: string): Promise<void> {
    const book = this.books.get(fileId);
    if (book?.timer) clearTimeout(book.timer);
    this.books.delete(fileId);
    await rm(this.path(fileId), { force: true }).catch(() => {});
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.books].map(([id, book]) => {
      if (book.timer) clearTimeout(book.timer);
      book.timer = null;
      return this.save(id, book).then(() => book.write);
    }));
  }
}

/** Several observers as one, since a run has one. */
export function observers(...list: RunObserver[]): RunObserver {
  return {
    started: (runId, req) => { for (const o of list) o.started(runId, req); },
    event: (runId, event) => { for (const o of list) o.event(runId, event); },
    ended: (end, problem) => { for (const o of list) o.ended(end, problem); },
  };
}
