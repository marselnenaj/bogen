import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, errorMessage } from './util.ts';

/**
 * Where each comment thread's next reply goes, per file, in `$BOGEN_HOME/reply-targets/<fileId>.json`: the agent,
 * model and effort of the last request a person addressed in it. It is written when the request is accepted, so a
 * request still waiting in the queue counts, and it survives a restart (the queue itself does not). Like the run
 * history it lives next to the files, never in the document, so a synced or imported document cannot set it.
 */

const STORE_KEY = /^[\w-]{1,80}$/;
const MAX_THREADS = 500;

export class ReplyTargets {
  private books = new Map<string, Promise<Record<string, unknown>>>();
  private writes = new Map<string, Promise<void>>();

  constructor(private readonly home: string) {}

  private path(fileId: string): string {
    if (!STORE_KEY.test(fileId)) throw new Error('Not a file id.');
    return join(this.home, 'reply-targets', `${fileId}.json`);
  }

  /** Every stored target of a file, by thread, as stored: the caller checks what each may be. */
  load(fileId: string): Promise<Record<string, unknown>> {
    let book = this.books.get(fileId);
    if (!book) {
      book = readFile(this.path(fileId), 'utf8').then((raw) => {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') console.error(`bogen: the reply targets of ${fileId} were unreadable: ${errorMessage(e)}`);
        return {};
      });
      this.books.set(fileId, book);
    }
    return book;
  }

  async save(fileId: string, threadId: string, target: { at: number }): Promise<void> {
    const book = await this.load(fileId);
    book[threadId] = target;
    const ids = Object.keys(book);
    // The threads talked in last stay.
    if (ids.length > MAX_THREADS) {
      ids.sort((a, b) => ((book[a] as { at?: number }).at ?? 0) - ((book[b] as { at?: number }).at ?? 0));
      for (const id of ids.slice(0, ids.length - MAX_THREADS)) delete book[id];
    }
    const body = JSON.stringify(book);
    const write = (this.writes.get(fileId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(join(this.home, 'reply-targets'), { recursive: true });
      await atomicWrite(this.path(fileId), body, 0o600);
    });
    this.writes.set(fileId, write);
    await write.catch((e) => console.error(`bogen: could not save the reply targets of ${fileId}: ${errorMessage(e)}`));
  }

  async forget(fileId: string): Promise<void> {
    this.books.delete(fileId);
    await (this.writes.get(fileId) ?? Promise.resolve()).catch(() => {});
    this.writes.delete(fileId);
    await rm(this.path(fileId), { force: true }).catch(() => {});
  }
}
