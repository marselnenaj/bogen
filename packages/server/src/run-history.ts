import { readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEnd, RunnerId, RunObserver, RunRequest, RunReview } from './agents.ts';
import type { EventHub } from './events.ts';
import { atomicWrite, errorMessage } from './util.ts';

export type RunRecordStatus = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted';

/** One run, kept with its file. Not part of the document, so it never travels to another device. */
export interface RunRecord {
  id: string;
  fileId: string;
  prompt: string;
  /** What the person asked, where the prompt also holds a thread or an element. */
  title?: string;
  runner: RunnerId;
  /** What was asked for. Empty means the CLI's own default. */
  model?: string;
  effort?: string;
  /** What the CLI said it used. */
  actualModel?: string;
  /** Guidance delivered at start; not a claim about the model's reasoning or design quality. */
  knowledge?: { discipline: string; revision: string; customized: boolean };
  source: 'prompt' | 'comment' | 'live';
  threadId?: string;
  pageId?: string;
  nodeIds: string[];
  /** The design content language the run wrote in, and whether the person chose it for this request (source run). */
  language?: { tag: string; source: 'run' | 'file' | 'brand'; mode: 'write' | 'translate' | 'add' };
  review?: RunReview;
  /** A lane of a race: the race, the lane and the name it worked under. */
  race?: { id: string; lane: string; agent: string };
  /** The image layer a run rebuilt as layers. */
  rebuildOf?: string;
  /** The chat it was a turn of. */
  conversationId?: string;
  /** The paired device that asked for it, when it was not asked on this one. */
  askedFrom?: string;
  /** It replied to a request without changing anything, and was continued once. `firstReply` is what it said then. */
  nudged?: boolean;
  firstReply?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: RunRecordStatus;
  result?: string;
  error?: string;
  tools: { name: string; count: number }[];
  layers: string[];
  files?: string[];
  /** Someone took back what it changed, with Undo this run. */
  undone?: { at: number; by: string };
  /** The layers it changed, with their names then; `gone` when it removed them. See `run-summary.ts`. */
  named?: { id: string; name: string; gone?: boolean }[];
  /** Pictures of what it changed, before and after, kept next to the history. */
  shots?: { nodeId: string; before: boolean; after: boolean };
}

const MAX_PER_FILE = 200;
const RESULT_LIMIT = 8000;
const LAYERS_LIMIT = 200;
const SAVE_DELAY_MS = 300;
const STORE_KEY = /^[\w-]{1,80}$/;

interface Book { records: RunRecord[]; timer: NodeJS.Timeout | null; write: Promise<void> }

/** Everything that ran, per file, in `$BOGEN_HOME/runs/<fileId>.json`. Survives a restart. */
export class RunHistory implements RunObserver {
  private books = new Map<string, Book>();
  private live = new Map<string, RunRecord>();
  private loading = new Map<string, Promise<Book>>();

  constructor(private readonly home: string, private readonly hub: EventHub) {
    hub.tap((event) => {
      if (event.t !== 'activity' || !event.runId) return;
      const record = this.live.get(event.runId);
      if (!record) return;
      for (const id of event.nodeIds) {
        if (record.layers.length >= LAYERS_LIMIT) break;
        if (!record.layers.includes(id)) record.layers.push(id);
      }
      this.saveSoon(record.fileId);
    });
  }

  private path(fileId: string): string {
    if (!STORE_KEY.test(fileId)) throw new Error('Not a run history key.');
    return join(this.home, 'runs', `${fileId}.json`);
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
    let records: RunRecord[] = [];
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path(fileId), 'utf8'));
      if (Array.isArray(parsed)) records = parsed as RunRecord[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`bogen: the run history of ${fileId} was unreadable: ${errorMessage(e)}`);
    }
    // A run that was going when the server stopped did not finish, whatever else it did.
    for (const r of records) if (r.status === 'running' && !this.live.has(r.id)) r.status = 'interrupted';
    const book = this.books.get(fileId) ?? { records, timer: null, write: Promise.resolve() };
    this.books.set(fileId, book);
    return book;
  }

  async list(fileId: string, limit = MAX_PER_FILE): Promise<RunRecord[]> {
    const { records } = await this.book(fileId);
    return records.slice(0, limit);
  }

  async get(fileId: string, id: string): Promise<RunRecord | undefined> {
    return (await this.book(fileId)).records.find((r) => r.id === id);
  }

  /** The latest runs over all files, for the bar widget. */
  async recent(fileIds: string[], limit: number): Promise<RunRecord[]> {
    const all = await Promise.all(fileIds.map((id) => this.list(id, limit)));
    return all.flat().sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  started(runId: string, req: RunRequest): void {
    const record: RunRecord = {
      id: runId, fileId: req.fileId, prompt: req.prompt, ...(req.title ? { title: req.title.slice(0, 500) } : {}), runner: req.runner,
      ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}),
      ...(req.designGuidance ? { knowledge: { discipline:req.designGuidance.discipline, revision:req.designGuidance.revision, customized:req.designGuidance.customized } } : {}),
      source: req.live ? 'live' : req.threadId ? 'comment' : 'prompt',
      ...(req.threadId ? { threadId: req.threadId } : {}), ...(req.pageId ? { pageId: req.pageId } : {}), ...(req.review ? { review: req.review } : {}),
      ...(req.race ? { race: { id: req.race.raceId, lane: req.race.laneId, agent: req.agent ?? req.runner } } : {}),
      ...(req.rebuildOf ? { rebuildOf: req.rebuildOf } : {}), ...(req.conversationId ? { conversationId: req.conversationId } : {}), ...(req.askedFrom ? { askedFrom: req.askedFrom.slice(0, 100) } : {}),
      ...(req.contentLanguage ? { language: { tag: req.contentLanguage.tag, source: req.contentLanguage.source, mode: req.contentLanguage.mode } } : {}),
      nodeIds: req.nodeIds ?? [], startedAt: Date.now(), status: 'running', tools: [], layers: [],
    };
    this.live.set(runId, record);
    void this.book(req.fileId).then((book) => {
      book.records.unshift(record);
      if (book.records.length > MAX_PER_FILE) book.records.length = MAX_PER_FILE;
      this.saveSoon(req.fileId);
      this.hub.broadcast({ t: 'run-history', fileId: req.fileId });
    });
  }

  event(runId: string, event: { kind: 'text' | 'tool' | 'error' | 'model' | 'nudge'; text?: string; tool?: string }): void {
    const record = this.live.get(runId);
    if (!record) return;
    if (event.kind === 'model') record.actualModel = event.text;
    else if (event.kind === 'nudge') {
      record.nudged = true;
      if (event.text) record.firstReply = event.text.slice(-RESULT_LIMIT);
    }
    else if (event.kind === 'text') record.result = event.text?.slice(-RESULT_LIMIT);
    else if (event.kind === 'error') record.error = event.text?.slice(0, 2000);
    else if (event.tool) {
      const known = record.tools.find((t) => t.name === event.tool);
      if (known) known.count++;
      else record.tools.push({ name: event.tool, count: 1 });
    }
    this.saveSoon(record.fileId);
  }

  ended(end: RunEnd, problem?: string): void {
    const record = this.live.get(end.runId);
    if (!record) return;
    this.live.delete(end.runId);
    record.endedAt = Date.now();
    record.durationMs = record.endedAt - record.startedAt;
    record.status = end.status;
    if (end.status === 'failed' && problem) record.error = problem.slice(0, 2000);
    this.saveSoon(record.fileId);
    // After the run's own last word, which is what its listeners take as the end.
    setTimeout(() => this.hub.broadcast({ t: 'run-history', fileId: record.fileId }), 50).unref();
  }

  /** What a run changed, worked out once it ended. */
  noteSummary(fileId: string, runId: string, summary: Pick<RunRecord, 'named' | 'shots'>): void {
    const record = this.books.get(fileId)?.records.find((r) => r.id === runId);
    if (!record) return;
    Object.assign(record, summary);
    this.saveSoon(fileId);
    this.hub.broadcast({ t: 'run-history', fileId });
  }

  /** Says that a person took back what the run changed. */
  markUndone(fileId: string, runId: string, by: string): void {
    const record = this.books.get(fileId)?.records.find((r) => r.id === runId);
    if (!record) return;
    record.undone = { at: Date.now(), by: by.slice(0, 80) };
    this.saveSoon(fileId);
    this.hub.broadcast({ t: 'run-history', fileId });
  }

  /** For a tool outside the CLI's stream that knows what it touched. It may report right after the run ended. */
  noteFiles(runId: string, files: string[]): void {
    for (const [fileId, book] of this.books) {
      const record = book.records.find((r) => r.id === runId);
      if (!record) continue;
      record.files = files.slice(0, LAYERS_LIMIT);
      this.saveSoon(fileId);
      this.hub.broadcast({ t: 'run-history', fileId });
      return;
    }
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
    const body = JSON.stringify(book.records);
    book.write = book.write.catch(() => {}).then(async () => {
      await mkdir(join(this.home, 'runs'), { recursive: true });
      await atomicWrite(this.path(fileId), body, 0o600);
    });
    book.write.catch((e) => console.error(`bogen: could not save the run history of ${fileId}: ${errorMessage(e)}`));
    return book.write;
  }

  async forget(fileId: string): Promise<void> {
    const book = this.books.get(fileId);
    if (book?.timer) clearTimeout(book.timer);
    this.books.delete(fileId);
    await rm(this.path(fileId), { force: true }).catch(() => {});
  }

  /** Runs still going are about to be killed with the server, which says so in their records. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.books].map(([id, book]) => {
      if (book.timer) clearTimeout(book.timer);
      book.timer = null;
      return this.save(id, book).then(() => book.write);
    }));
  }
}
