import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 29990;

export function bogenHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOGEN_HOME) return env.BOGEN_HOME;
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'bogen');
  return join(homedir(), '.local', 'share', 'bogen');
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
