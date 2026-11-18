import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/storage.ts';
import { sweepTempFiles } from '../src/util.ts';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bogen-sweep-'));
  homes.push(dir);
  return dir;
}

function old(path: string, content = 'x'): string {
  writeFileSync(path, content);
  const then = (Date.now() - 3_600_000) / 1000;
  utimesSync(path, then, then);
  return path;
}

describe('leftover temp files', () => {
  it('go at start when old and named as atomicWrite names them; nothing else does', async () => {
    const dir = home();
    mkdirSync(join(dir, 'runs'));
    mkdirSync(join(dir, 'history', 'abc'), { recursive: true });
    const gone = [old(join(dir, 'peers-state.json.00b53b84304e.tmp')), old(join(dir, 'runs', 'r1.json.2e205384a646.tmp'))];
    const kept = [
      old(join(dir, 'notes.tmp')), old(join(dir, 'runs', 'r1.json')), old(join(dir, 'x.json.ZZZZZZZZZZZZ.tmp')),
      // Too deep: history folders hold their own files and are not swept.
      old(join(dir, 'history', 'abc', 'c.jsonl.00b53b84304e.tmp')),
    ];
    // A write in flight, just begun.
    const fresh = join(dir, 'index.json.aaaaaaaaaaaa.tmp');
    writeFileSync(fresh, 'x');
    expect(await sweepTempFiles(dir)).toBe(2);
    for (const p of gone) expect(existsSync(p), p).toBe(false);
    for (const p of [...kept, fresh]) expect(existsSync(p), p).toBe(true);
  });

  it('are swept when the storage opens, and thumbnails are written whole', async () => {
    const dir = home();
    mkdirSync(join(dir, 'files'), { recursive: true });
    const stale = old(join(dir, 'files', 'abcdefghij.ydoc.0123456789ab.tmp'));
    const storage = new Storage(dir);
    await storage.init();
    expect(existsSync(stale)).toBe(false);
    await storage.writeThumb('abcdefghij', new Uint8Array([1, 2, 3]));
    expect(existsSync(storage.thumbPath('abcdefghij'))).toBe(true);
  });
});
