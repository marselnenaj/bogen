import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionFromEnv, daemonTiming, startDaemon } from '../src/daemon.ts';
import { acquireServeLock, LOCK_FILE, LOCK_STALE_MS, lockHolder, pidNamespace, type ServeLock } from '../src/serve-lock.ts';

const dirs: string[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bogen-lock-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A pid that ran and is gone. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid!;
}

function lockOf(home: string, patch: Partial<ServeLock>, ageMs = 0): void {
  const lock: ServeLock = { pid: process.ppid, port: 29990, host: '127.0.0.1', ns: pidNamespace(), instance: 'other', startedAt: Date.now(), ...patch };
  const path = join(home, LOCK_FILE);
  writeFileSync(path, JSON.stringify(lock));
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as { port: number }).port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

describe('one server per data folder', () => {
  it('finds no holder without a lock, or with one left by a server that is gone', () => {
    const home = dir();
    expect(lockHolder(home)).toBeNull();
    lockOf(home, { pid: deadPid() });
    expect(lockHolder(home)).toBeNull();
  });

  it('a server this process can see holds the folder while it runs', () => {
    const home = dir();
    lockOf(home, { pid: process.ppid }, LOCK_STALE_MS * 3);
    expect(lockHolder(home)?.pid).toBe(process.ppid);
  });

  it('from a sandbox, where the pid means nothing, a recently touched lock holds the folder and an old one does not', () => {
    const home = dir();
    // The bug: `bogen mcp` in a sandbox could not see the service, and started a second server on its folder.
    lockOf(home, { pid: deadPid(), ns: 'pid:[elsewhere]' });
    expect(lockHolder(home)?.ns).toBe('pid:[elsewhere]');
    lockOf(home, { pid: deadPid(), ns: 'pid:[elsewhere]' }, LOCK_STALE_MS + 1000);
    expect(lockHolder(home)).toBeNull();
  });

  it('refuses a second server, takes a stale folder, and releases only its own lock', () => {
    const home = dir();
    lockOf(home, { pid: process.ppid, port: 4242 });
    expect(() => acquireServeLock(home, { port: 1, host: '127.0.0.1' })).toThrow(/already serves .*pid \d+, port 4242/);

    lockOf(home, { pid: deadPid() });
    const held = acquireServeLock(home, { port: 0, host: '127.0.0.1' });
    held.setPort(31337);
    const mine = JSON.parse(readFileSync(join(home, LOCK_FILE), 'utf8')) as ServeLock;
    expect(mine).toMatchObject({ pid: process.pid, port: 31337, ns: pidNamespace() });
    expect(readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    // Someone else took over meanwhile: releasing leaves their lock alone.
    lockOf(home, { pid: process.ppid, instance: 'theirs' });
    held.release();
    expect(lockHolder(home)?.instance).toBe('theirs');

    rmSync(join(home, LOCK_FILE));
    const again = acquireServeLock(home, { port: 0, host: '127.0.0.1' });
    again.release();
    expect(existsSync(join(home, LOCK_FILE))).toBe(false);
  });

  it('a command that cannot reach the server holding the folder says so and starts no second one', async () => {
    const home = dir();
    lockOf(home, { pid: deadPid(), ns: 'pid:[sandbox-outside]', port: 29990 });
    const port = await freePort();
    const before = daemonTiming.holderWaitMs;
    daemonTiming.holderWaitMs = 300;
    try {
      await expect(startDaemon(connectionFromEnv(port, { BOGEN_HOME: home }))).rejects.toThrow(/cannot reach it .*No second server was started/);
    } finally {
      daemonTiming.holderWaitMs = before;
    }
    // Nothing was started: no log of a start, and the lock is still the other server's.
    expect(existsSync(join(home, 'server.log'))).toBe(false);
    expect(lockHolder(home)?.instance).toBe('other');
  });
});
