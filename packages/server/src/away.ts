import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, errorMessage } from './util.ts';

export interface AwayNote { changes: number; from: Record<string, number>; firstAt: number; lastAt: number }

const SAVE_DELAY_MS = 1000;

/**
 * What happened to a file while no editor had it open: another device, or an agent nobody was watching. An editor
 * asks when it connects, so someone coming back to a file, or a laptop waking up, hears about it once.
 */
export class AwayLog {
  private notes = new Map<string, AwayNote>();
  private timer: NodeJS.Timeout | null = null;
  private write: Promise<void> = Promise.resolve();

  constructor(private readonly home: string) {}

  private get path(): string {
    return join(this.home, 'away.json');
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, AwayNote>;
      for (const [id, note] of Object.entries(parsed)) if (typeof note?.changes === 'number') this.notes.set(id, note);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`bogen: away.json was unreadable: ${errorMessage(e)}`);
    }
  }

  note(fileId: string, who: string): void {
    const now = Date.now();
    const note = this.notes.get(fileId) ?? { changes: 0, from: {}, firstAt: now, lastAt: now };
    note.changes++;
    note.lastAt = now;
    note.from[who] = (note.from[who] ?? 0) + 1;
    this.notes.set(fileId, note);
    this.saveSoon();
  }

  /** What there is to say, once. */
  take(fileId: string): AwayNote | null {
    const note = this.notes.get(fileId) ?? null;
    if (note) {
      this.notes.delete(fileId);
      this.saveSoon();
    }
    return note;
  }

  forget(fileId: string): void {
    if (this.notes.delete(fileId)) this.saveSoon();
  }

  private saveSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, SAVE_DELAY_MS);
    this.timer.unref();
  }

  private save(): Promise<void> {
    const body = JSON.stringify(Object.fromEntries(this.notes));
    this.write = this.write.catch(() => {}).then(() => atomicWrite(this.path, body, 0o600));
    this.write.catch((e) => console.error(`bogen: could not save away.json: ${errorMessage(e)}`));
    return this.write;
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.save().catch(() => {});
  }
}
