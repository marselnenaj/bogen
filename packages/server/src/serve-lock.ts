import { randomBytes } from 'node:crypto';
import { readFileSync, readlinkSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One server per data folder. Two servers on one folder each keep the open files in memory and write them back whole,
 * so each loses the other's edits, and a browser on one never sees what an agent does through the other. That
 * happened when `bogen mcp` ran in a sandbox with a network of its own: it could not reach the service on
 * 127.0.0.1, could not ask systemd to start it, and started a server of its own on the same folder.
 *
 * The server that serves a folder holds `serve.lock` there and touches it every few seconds. A process that sees
 * that pid (the same pid namespace) asks whether it still runs; one in a sandbox cannot see the pid, and goes by the
 * touch instead: a lock touched in the last 20 seconds belongs to a server that runs.
 */

export const LOCK_FILE = 'serve.lock';
export const LOCK_BEAT_MS = 5_000;
export const LOCK_STALE_MS = 20_000;

export interface ServeLock {
  pid: number;
  port: number;
  host: string;
  /** `/proc/self/ns/pid` of the server: whether its pid means anything to the reader. Null where there is no /proc. */
  ns: string | null;
  instance: string;
  startedAt: number;
}

export function pidNamespace(): string | null {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function read(home: string): { lock: ServeLock; beatAt: number } | null {
  const path = join(home, LOCK_FILE);
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8')) as ServeLock;
    if (typeof lock.pid !== 'number' || typeof lock.instance !== 'string') return null;
    return { lock, beatAt: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

/** The server that serves this folder now, or null when none does (no lock, or one left by a server that is gone). */
export function lockHolder(home: string, now = Date.now(), ns = pidNamespace()): ServeLock | null {
  const found = read(home);
  if (!found) return null;
  const { lock, beatAt } = found;
  if (lock.ns === ns) return lock.pid !== process.pid && alive(lock.pid) ? lock : null;
  return now - beatAt < LOCK_STALE_MS ? lock : null;
}

export function heldMessage(home: string, lock: ServeLock): string {
  return `A Bogen server already serves ${home} (pid ${lock.pid}, port ${lock.port}). Only one server may use a data folder: two lose each other's edits.`;
}

export interface HeldLock {
  /** Records the port once the server listens. */
  setPort(port: number): void;
  /** Gives the folder free; only removes the lock while it is still this server's. */
  release(): void;
}

function write(home: string, lock: ServeLock): void {
  const path = join(home, LOCK_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lock), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Takes the folder for this process, or throws with who holds it. Keeps the lock touched until released. */
export function acquireServeLock(home: string, where: { port: number; host: string }, now = Date.now()): HeldLock {
  const holder = lockHolder(home, now);
  if (holder) throw new Error(heldMessage(home, holder));
  const lock: ServeLock = { pid: process.pid, port: where.port, host: where.host, ns: pidNamespace(), instance: randomBytes(8).toString('hex'), startedAt: now };
  write(home, lock);
  const path = join(home, LOCK_FILE);
  const mine = () => read(home)?.lock.instance === lock.instance;
  const beat = setInterval(() => {
    try {
      if (mine()) utimesSync(path, new Date(), new Date());
      // Gone, say by a cleanup of the folder: this server still serves it, so it says so again.
      else if (!lockHolder(home)) write(home, lock);
    } catch { /* a full or read-only disk: the next beat tries again */ }
  }, LOCK_BEAT_MS);
  beat.unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    try { if (mine()) rmSync(path, { force: true }); } catch { /* gone already */ }
  };
  process.once('exit', release);
  return {
    setPort(port: number) {
      lock.port = port;
      try { if (mine()) write(home, lock); } catch { /* the next start reads the requested port, which is the same */ }
    },
    release,
  };
}
