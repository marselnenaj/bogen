import { LOCAL, Session } from './session.ts';

/**
 * Sessions of files that are open as tabs but not in view. Leaving a tab parks its session here instead of closing
 * it, so that going back is instant: the document, its connection and its undo stack are still there, and the
 * document kept syncing meanwhile. A parked session goes to sleep (is closed) after a while, or when more are parked
 * than memory should hold; going back to a sleeping tab loads the file again, as opening it always did.
 */

interface Parked { session: Session; timer: number; at: number }

const parked = new Map<string, Parked>();
const listeners = new Set<() => void>();

/**
 * How long a tab that is not in view keeps its file loaded, and how many such tabs may. A heavy file (a captured
 * site of tens of thousands of layers holds hundreds of MB) sleeps sooner.
 */
export const sleepPolicy = { afterMs: 5 * 60_000, keep: 2, heavyNodes: 20_000, heavyAfterMs: 60_000 };

function changed(): void {
  for (const fn of listeners) fn();
}

/** Called when the set of live sessions changes: one parked, woken or put to sleep. */
export function onSessionsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The session for a file being opened: the parked one when there is one, else a new one. */
export function acquireSession(fileId: string): Session {
  const p = parked.get(fileId);
  if (p) {
    clearTimeout(p.timer);
    parked.delete(fileId);
    changed();
    return p.session;
  }
  return new Session(fileId);
}

/** A file's editor let go of its session: keep it for a while, unless the tab was closed. */
export function releaseSession(s: Session, keep: boolean): void {
  if (!keep || sleepPolicy.keep <= 0) {
    s.destroy();
    return;
  }
  const old = parked.get(s.fileId);
  if (old && old.session !== s) sleep(s.fileId);
  // Nobody sees this person in a file that is not in view.
  s.provider.awareness.setLocalState(null);
  const heavy = (s.snap?.nodes?.size ?? 0) >= sleepPolicy.heavyNodes;
  const timer = window.setTimeout(() => sleep(s.fileId), heavy ? Math.min(sleepPolicy.afterMs, sleepPolicy.heavyAfterMs) : sleepPolicy.afterMs);
  parked.set(s.fileId, { session: s, timer, at: Date.now() });
  // The oldest go first when more are parked than allowed.
  const extra = [...parked.values()].sort((a, b) => a.at - b.at).slice(0, Math.max(0, parked.size - sleepPolicy.keep));
  for (const e of extra) sleep(e.session.fileId);
  changed();
}

/** Closes a parked session now. The tab stays; it loads its file again when it is opened. */
export function sleep(fileId: string): void {
  const p = parked.get(fileId);
  if (!p) return;
  clearTimeout(p.timer);
  parked.delete(fileId);
  p.session.destroy();
  changed();
}

/** Puts every parked session to sleep. */
export function sleepAll(): void {
  for (const id of [...parked.keys()]) sleep(id);
}

/** The parked session of a file, if its tab is awake. */
export function parkedSession(fileId: string): Session | undefined {
  return parked.get(fileId)?.session;
}

/** The files whose tabs are awake but not in view. */
export function parkedFiles(): string[] {
  return [...parked.keys()];
}

/** Whether a session has local edits that the server has not had yet: made while it was not connected. */
export function watchPending(s: Session, onChange: (pending: boolean) => void): () => void {
  let pending = false;
  const set = (v: boolean) => {
    if (v === pending) return;
    pending = v;
    onChange(v);
  };
  const onUpdate = (_u: Uint8Array, origin: unknown) => {
    if (origin === LOCAL && !s.provider.wsconnected) set(true);
  };
  const onSync = (synced: boolean) => {
    if (synced && s.provider.wsconnected) set(false);
  };
  s.y.on('update', onUpdate);
  s.provider.on('sync', onSync);
  return () => {
    s.y.off('update', onUpdate);
    s.provider.off('sync', onSync);
  };
}
