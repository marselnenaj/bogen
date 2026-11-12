import { create } from 'zustand';
import { Y } from '@bogen/core';
import type { WebsocketProvider } from 'y-websocket';
import type { SyncConflict } from '../lib/agent-api.ts';
import { onReachableChange, serverReachable } from '../lib/events.ts';
import { OFFLINE_ORIGIN, patchFile, storedFiles, storedState, type OfflineDoc } from './offline.ts';

/**
 * The phone's link to the computer for one open file. Edits made while the computer cannot be reached wait in
 * the copy on the phone and are counted. When it can be reached again they go first, over
 * `/api/files/:id/catch-up`, where the computer compares them with what changed there meanwhile and notes a
 * value both sides set (packages/server/src/phone-sync.ts); only then does the sync socket connect again. The
 * socket's own retries are off, so that nothing slips past that comparison.
 */

export interface PhoneSyncState {
  fileId: string | null;
  /** Connected and in sync with the computer. */
  live: boolean;
  /** Sending the changes made offline. */
  sending: boolean;
  queued: number;
  syncedAt: number | null;
  /** Values both sides set while apart, for this file, as the computer keeps them. */
  conflicts: SyncConflict[];
  set: (patch: Partial<Omit<PhoneSyncState, 'set'>>) => void;
}

export const usePhoneSync = create<PhoneSyncState>((set) => ({
  fileId: null, live: false, sending: false, queued: 0, syncedAt: null, conflicts: [],
  set: (patch) => set(patch),
}));

const NO_CONFLICTS: readonly SyncConflict[] = Object.freeze([]);

/**
 * A file's conflicts, as a store selector. For another file, or none (the phone on the computer itself never sets
 * one), it is always the same empty list: a new [] on every read is a new snapshot each time, and React re-renders
 * until it gives up with "Maximum update depth exceeded", leaving the phone app blank.
 */
export function conflictsFor(fileId: string): (s: Pick<PhoneSyncState, 'fileId' | 'conflicts'>) => readonly SyncConflict[] {
  return (s) => (s.fileId === fileId ? s.conflicts : NO_CONFLICTS);
}

function b64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function unb64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export class CatchUpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Sends what the computer lacks of this document, and returns the notes it made. Throws when it cannot be reached. */
export async function catchUp(fileId: string, y: Y.Doc): Promise<{ conflicts: SyncConflict[]; changed: boolean }> {
  const ask = await fetch(`/api/files/${fileId}/catch-up`, { cache: 'no-store' });
  if (!ask.ok) throw new CatchUpError(ask.status, `The computer answered ${ask.status}.`);
  const { sv } = await ask.json() as { sv: string };
  const update = Y.encodeStateAsUpdate(y, unb64(sv));
  const res = await fetch(`/api/files/${fileId}/catch-up`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update: b64(update), sv: b64(Y.encodeStateVector(y)) }),
  });
  const body = await res.json().catch(() => ({})) as { conflicts?: SyncConflict[]; changed?: boolean; error?: string };
  if (!res.ok) throw new CatchUpError(res.status, body.error ?? `The computer answered ${res.status}.`);
  return { conflicts: body.conflicts ?? [], changed: Boolean(body.changed) };
}

const MAX_RETRY_MS = 10_000;

export class PhoneLink {
  private closed = false;
  private opening = false;
  private retry = 1000;
  private retryTimer = 0;
  private offs: (() => void)[] = [];

  constructor(private readonly fileId: string, private readonly y: Y.Doc, private readonly provider: WebsocketProvider, private readonly offline: OfflineDoc) {
    usePhoneSync.getState().set({ fileId, live: false, sending: false, queued: 0, syncedAt: null, conflicts: [] });
    const onStatus = ({ status }: { status: string }) => {
      if (status === 'disconnected') this.lost();
    };
    const onClose = () => this.lost();
    const onSync = (synced: boolean) => {
      if (!synced) return;
      this.retry = 1000;
      // What was typed while the catch-up was on its way went with the socket's own exchange, which is done now.
      if (this.offline.queued) this.offline.noteDelivered();
      else this.offline.noteInSync();
      this.publish({ live: true });
      void this.loadNotes();
    };
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === OFFLINE_ORIGIN) return;
      if (origin !== this.provider && !(this.provider.wsconnected && this.provider.synced)) {
        this.offline.noteLocalChange();
        this.publish();
        return;
      }
      if (this.provider.synced) {
        this.offline.noteInSync();
        this.publish();
      }
    };
    provider.on('status', onStatus);
    provider.on('connection-close', onClose);
    provider.on('sync', onSync);
    y.on('update', onUpdate);
    const visible = () => { if (document.visibilityState === 'visible') this.open(); };
    document.addEventListener('visibilitychange', visible);
    this.offs.push(
      () => provider.off('status', onStatus), () => provider.off('connection-close', onClose), () => provider.off('sync', onSync), () => y.off('update', onUpdate),
      () => document.removeEventListener('visibilitychange', visible),
      onReachableChange(() => { if (serverReachable()) this.open(); }),
    );
    void offline.loaded.then(() => {
      this.publish();
      this.open();
    });
  }

  private publish(patch: Partial<PhoneSyncState> = {}): void {
    if (this.closed) return;
    usePhoneSync.getState().set({ fileId: this.fileId, live: this.provider.wsconnected && this.provider.synced, queued: this.offline.queued, syncedAt: this.offline.syncedAt, ...patch });
  }

  /** The socket closed. It stays closed until the computer answers again, and the waiting changes went first. */
  private lost(): void {
    this.provider.shouldConnect = false;
    this.publish({ live: false });
    this.later();
  }

  private later(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = 0;
      // Offline as the events socket sees it: its own return calls `open`.
      if (serverReachable() !== false) this.open();
    }, this.retry);
    this.retry = Math.min(this.retry * 2, MAX_RETRY_MS);
  }

  /** Sends what waits, then connects. Safe to call any time: it does nothing while connected or connecting. */
  open(): void {
    if (this.closed || this.opening || this.provider.ws) return;
    this.opening = true;
    void (async () => {
      try {
        if (this.offline.queued > 0) {
          this.publish({ sending: true });
          await this.offline.flush();
          const out = await catchUp(this.fileId, this.y);
          this.offline.noteDelivered();
          if (out.conflicts.length) this.addNotes(out.conflicts);
        }
        if (!this.closed) this.provider.connect();
      } catch (e) {
        // The computer answered, but would not take them this way, say an older build: the socket merges them as before.
        if (e instanceof CatchUpError && e.status >= 400 && e.status !== 401 && e.status !== 503) {
          if (!this.closed) this.provider.connect();
        } else this.later();
      } finally {
        this.opening = false;
        this.publish({ sending: false });
      }
    })();
  }

  private addNotes(notes: SyncConflict[]): void {
    const known = usePhoneSync.getState().conflicts;
    const ids = new Set(known.map((c) => c.id));
    this.publish({ conflicts: [...notes.filter((c) => !ids.has(c.id)), ...known] });
  }

  /** The notes the computer keeps for this file, from any of the person's devices. */
  async loadNotes(): Promise<void> {
    try {
      const res = await fetch(`/api/files/${this.fileId}/conflicts`, { cache: 'no-store' });
      if (!res.ok) return;
      const notes = await res.json() as SyncConflict[];
      if (this.closed) return;
      this.publish({ conflicts: notes });
      void patchFile(this.fileId, () => ({ notes: notes.length })).catch(() => {});
    } catch {
      // Offline again.
    }
  }

  destroy(): void {
    this.closed = true;
    window.clearTimeout(this.retryTimer);
    for (const off of this.offs) off();
    usePhoneSync.getState().set({ fileId: null, live: false, sending: false, conflicts: [] });
  }
}

let flushing = false;

/**
 * Files with changes waiting that are not open, sent once the computer can be reached: the phone may have been
 * closed before it got back. Each goes the same way an open file's would.
 */
export async function flushQueued(openFileId: string | null): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const f of await storedFiles()) {
      if (!f.queued || f.id === openFileId) continue;
      const state = await storedState(f.id);
      if (!state) continue;
      const y = new Y.Doc();
      try {
        Y.applyUpdate(y, state);
        const out = await catchUp(f.id, y);
        await patchFile(f.id, () => ({ queued: 0, syncedAt: Date.now(), ...(out.conflicts.length ? { notes: out.conflicts.length } : {}) }));
        sent++;
      } catch (e) {
        // Offline again, or the file is gone on the computer: try the next one, and this one later.
        if (!(e instanceof CatchUpError)) break;
      } finally {
        y.destroy();
      }
    }
  } finally {
    flushing = false;
  }
  return sent;
}
