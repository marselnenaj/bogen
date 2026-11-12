import type { BogenEvent, EventHub } from './events.ts';
import type { FileEvents } from './file-events.ts';
import type { Rooms } from './sync.ts';
import type { Storage } from './storage.ts';

/** Something worth a desktop notification. The bar widget asks for these and shows them; nothing else acts on them. */
export interface BogenNotification {
  seq: number;
  kind: 'comment' | 'run';
  fileId: string;
  fileName: string;
  title: string;
  body: string;
  threadId?: string;
  at: number;
}

const KEEP = 50;

/**
 * Reads the log of each file and the run events, and keeps a short list for the widget. A comment that someone
 * writes while looking at that file on this device is not news for them, so it is left out.
 */
export class Notifications {
  private list: BogenNotification[] = [];
  private seq = 0;
  private stop: (() => void)[] = [];

  constructor(private readonly deps: { hub: EventHub; storage: Storage; rooms: Rooms; fileEvents: FileEvents }) {
    this.stop.push(deps.hub.tap((event) => this.onEvent(event)));
    this.stop.push(deps.fileEvents.onEvent((fileId, event) => {
      if (event.kind !== 'comment_added' && event.kind !== 'comment_replied') return;
      const author = String(event.author ?? 'Someone');
      // What a person sends from an editor here, they already know about.
      if (event.source === 'person' && this.deps.rooms.peek(fileId)?.humans().some((h) => h.name === author)) return;
      if (event.source === 'system') return;
      const via = event.source === 'peer' ? ' on another device' : '';
      this.push({ kind: 'comment', fileId, title: `${author} commented${via}`, body: String(event.text ?? '').slice(0, 200), ...(typeof event.thread_id === 'string' ? { threadId: event.thread_id } : {}) });
    }));
  }

  private onEvent(event: BogenEvent): void {
    if (event.t !== 'comment-run' || event.status === 'queued' || event.status === 'working') return;
    const how = event.status === 'done' ? 'finished' : event.status === 'failed' ? 'failed' : 'was stopped';
    this.push({ kind: 'run', fileId: event.fileId, title: `${event.runner} ${how} on a comment`, body: '', threadId: event.threadId });
  }

  private push(item: Omit<BogenNotification, 'seq' | 'at' | 'fileName'>): void {
    this.list.unshift({ ...item, seq: ++this.seq, at: Date.now(), fileName: this.deps.storage.get(item.fileId)?.name ?? 'Bogen' });
    if (this.list.length > KEEP) this.list.length = KEEP;
  }

  /** What came after `since`. The answer's `seq` is what to pass next time. */
  after(since: number): { seq: number; items: BogenNotification[] } {
    return { seq: this.seq, items: this.list.filter((n) => n.seq > since).reverse() };
  }

  close(): void {
    for (const off of this.stop) off();
  }
}
