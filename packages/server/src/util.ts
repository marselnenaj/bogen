import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { open, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_PORT = 29990;

export function bogenHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOGEN_HOME) return env.BOGEN_HOME;
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'bogen');
  return join(homedir(), '.local', 'share', 'bogen');
}

/**
 * A short fingerprint of a data folder, so a client can tell which folder the server on a port
 * serves without the server telling anyone its path. The same folder gives the same id through a
 * symlink or a relative path.
 */
export function homeId(home: string): string {
  let path = resolve(home);
  try {
    path = realpathSync(path);
  } catch {
    // A folder that does not exist yet is compared by the path it will have.
  }
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

/**
 * Creates the data folder owner-only, or makes an existing one so: designs, assets, histories and
 * agent logs are nobody else's business. Refuses a folder that belongs to another user, since a server
 * of ours that wrote into it would be writing where they can read.
 */
export function ensurePrivateHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const info = lstatSync(home);
  if (!info.isDirectory()) throw new Error(`${home} is not a folder.`);
  if (info.uid !== uid && uid !== 0) throw new Error(`${home} belongs to another user. Set BOGEN_HOME to a folder of your own.`);
  if ((info.mode & 0o077) !== 0) chmodSync(home, 0o700);
}

/** The name `atomicWrite` gives its temp file: the target, a dot, 12 hex digits, `.tmp`. */
const TEMP_NAME = /\.[0-9a-f]{12}\.tmp$/;

/**
 * Removes temp files that an `atomicWrite` left behind when the process died between writing and renaming. Only
 * names of that exact shape, only older than `minAgeMs` (so a write in flight elsewhere is never touched), only in the
 * data folder and the folders right under it. Answers how many went.
 */
export async function sweepTempFiles(home: string, minAgeMs = 10 * 60_000, now = Date.now()): Promise<number> {
  let removed = 0;
  const sweep = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth > 0) await sweep(path, depth - 1);
      else if (entry.isFile() && TEMP_NAME.test(entry.name)) {
        const info = await stat(path).catch(() => null);
        if (info && now - info.mtimeMs >= minAgeMs && (await rm(path, { force: true }).then(() => true, () => false))) removed++;
      }
    }
  };
  await sweep(home, 1);
  return removed;
}

/** Writes to a temp file in the same folder, syncs it, then renames over the target. */
/** Writes every byte: a short write (a nearly full disk) is continued; a write that takes nothing fails. */
export function writeAllSync(fd: number, bytes: Uint8Array, write: (fd: number, b: Uint8Array, offset: number, length: number) => number = writeSync): void {
  let done = 0;
  while (done < bytes.length) {
    const n = write(fd, bytes, done, bytes.length - done);
    if (!(n > 0)) throw new Error('The disk took no more bytes; nothing was kept.');
    done += n;
  }
}

/**
 * The same, synchronously, for a record that must exist before anything else happens: every byte written (a short
 * write on a full disk is continued, or fails), fsynced, then renamed into place. With `exclusive`, an existing file
 * is kept and false comes back. Throws when it cannot write; then no file is left at `path`.
 */
export function atomicWriteSync(path: string, data: Uint8Array | string, options: { mode?: number; exclusive?: boolean } = {}): boolean {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (options.exclusive) {
    try {
      lstatSync(path);
      return false;
    } catch { /* not there: write it */ }
  }
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', options.mode ?? 0o600);
  try {
    writeAllSync(fd, bytes);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
  return true;
}

export async function atomicWrite(path: string, data: Uint8Array | string, mode = 0o644): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'w', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (e) {
    await handle.close().catch(() => {});
    await rm(tmp, { force: true });
    throw e;
  }
  await handle.close();
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Splits on commas outside parentheses and quotes, so `rgb(1,2,3)` and `"A, B"` stay whole. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
