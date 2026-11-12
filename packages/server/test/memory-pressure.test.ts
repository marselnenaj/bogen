import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BogenDoc } from '@bogen/core';
import { levelOf, MemoryGauge, readMemory, type MemoryReading } from '../src/memory-pressure.ts';
import { Renderer } from '../src/render.ts';
import { startServer, until, type Harness } from './helpers.ts';

const MB = 1024 * 1024;

describe('reading memory', () => {
  it('reads MemAvailable, PSI and the cgroup headroom the way the kernel writes them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bogen-mem-'));
    writeFileSync(join(dir, 'meminfo'), 'MemTotal:        7766016 kB\nMemFree:          101244 kB\nMemAvailable:     192512 kB\n');
    writeFileSync(join(dir, 'pressure'), 'some avg10=41.20 avg60=30.01 avg300=12.00 total=1\nfull avg10=25.33 avg60=20.00 avg300=8.00 total=1\n');
    writeFileSync(join(dir, 'cgroup'), '0::/user.slice/user-1000.slice/user@1000.service/app.slice/bogen.service\n');
    const cg = join(dir, 'fs', 'user.slice/user-1000.slice/user@1000.service/app.slice/bogen.service');
    mkdirSync(cg, { recursive: true });
    writeFileSync(join(cg, 'memory.max'), String(1024 * MB));
    writeFileSync(join(cg, 'memory.current'), String(900 * MB));
    const r = readMemory({ meminfo: join(dir, 'meminfo'), pressure: join(dir, 'pressure'), selfCgroup: join(dir, 'cgroup'), cgroupRoot: join(dir, 'fs') });
    expect(r).toEqual({ available: 192512 * 1024, stallFull: 25.33, cgroupHeadroom: 124 * MB });
    // The readings of a 7.4 GiB laptop that froze: critical on every count.
    expect(levelOf(r)).toBe('critical');
    writeFileSync(join(cg, 'memory.max'), 'max');
    expect(readMemory({ meminfo: join(dir, 'missing'), pressure: join(dir, 'missing'), selfCgroup: join(dir, 'cgroup'), cgroupRoot: join(dir, 'fs') })).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });

  it('is ok without readings, low below a gigabyte, critical below half of one', () => {
    expect(levelOf({})).toBe('ok');
    expect(levelOf({ available: 3000 * MB, stallFull: 0 })).toBe('ok');
    expect(levelOf({ available: 953 * MB })).toBe('low');
    expect(levelOf({ available: 4000 * MB, stallFull: 8 })).toBe('low');
    expect(levelOf({ available: 4000 * MB, cgroupHeadroom: 150 * MB })).toBe('critical');
    expect(levelOf({ available: 188 * MB })).toBe('critical');
  });
});

describe('the browser under memory pressure', () => {
  it('refuses to start Chromium while memory is critical, before anything is allocated', async () => {
    const renderer = new Renderer(async () => null);
    const gauge = new MemoryGauge(() => ({ available: 188 * MB }));
    renderer.launchGuard = () => (gauge.level() === 'critical' ? `low on memory (${gauge.describe()})` : null);
    await expect(renderer.withBrowser(async () => 'never')).rejects.toThrow(/low on memory \(188 MB available\)/);
    expect(renderer.running).toBe(false);
  });
});

describe('background previews under memory pressure', () => {
  let h: Harness | undefined;
  afterEach(async () => { vi.restoreAllMocks(); await h?.cleanup(); h = undefined; });

  /** A file written straight to storage, as one from another device or from before previews: never loaded in this run. */
  const oldFile = async (name: string) => {
    const f = h!.server.storage.create(name);
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    doc.insert(doc.getPages()[0]!.id, { type: 'frame', name: 'B', artboard: true, style: { width: '100px', height: '100px' } });
    h!.server.storage.scheduleDoc(f.id, () => Y.encodeStateAsUpdate(doc.y));
    await h!.server.storage.flushDoc(f.id);
    return f.id;
  };

  const fakeShot = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/webp', width: 10, height: 10, scale: 1, format: 'webp' as const };

  it('waits while memory is short, keeps the files queued, and renders them once it is back', async () => {
    let reading: MemoryReading = { available: 400 * MB };
    h = await startServer({ thumbnails: true, thumbnailDelayMs: 10, thumbnailPauseMs: 50, thumbnailStartupMs: 0, memory: () => reading });
    const shot = vi.spyOn(h.server.renderer, 'screenshot').mockResolvedValue(fakeShot);
    const release = vi.spyOn(h.server.renderer, 'releaseIdle');
    const file = h.server.storage.create('Poster');
    const room = await h.server.rooms.get(file.id);
    room.doc.transact(() => room.doc.insert(room.doc.getPages()[0]!.id, { type: 'frame', name: 'Board', artboard: true, style: { width: '400px', height: '300px' } }));
    await until(() => h!.server.thumbnailStatus().paused, 2000);
    await new Promise((r) => setTimeout(r, 200));
    expect(shot).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
    expect(h.server.thumbnailStatus().queued).toBe(1);
    reading = { available: 3000 * MB };
    await until(() => Boolean(h!.server.storage.get(file.id)?.thumbnail), 3000);
    expect(shot).toHaveBeenCalledTimes(1);
  });

  it('leaves the backlog of old files until after start, and never loads their documents as rooms', async () => {
    h = await startServer({ thumbnails: true, thumbnailStartupMs: 400, memory: () => ({ available: 3000 * MB }) });
    const shot = vi.spyOn(h.server.renderer, 'screenshot').mockResolvedValue(fakeShot);
    const loads = vi.spyOn(h.server.rooms, 'get');
    // Files from another device or from before previews: in storage, never opened in this run.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await oldFile(`Old ${i}`));
    const listed = await fetch(`${h.base}/api/files`);
    expect(listed.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect(shot).not.toHaveBeenCalled();
    await until(() => ids.every((id) => Boolean(h!.server.storage.get(id)?.thumbnail)), 12_000);
    // Rendered from private copies: no room was loaded, so no cache warmed and nothing to unload.
    expect(loads.mock.calls.filter(([id]) => ids.includes(id))).toEqual([]);
    expect(ids.filter((id) => h!.server.rooms.peek(id))).toEqual([]);
  }, 20_000);

  it('keeps the backlog to the start-up delay even when an edited file starts the queue', async () => {
    h = await startServer({ thumbnails: true, thumbnailDelayMs: 10, thumbnailStartupMs: 1500, memory: () => ({ available: 3000 * MB }) });
    const rendered: string[] = [];
    vi.spyOn(h.server.renderer, 'screenshot').mockImplementation(async (doc) => {
      rendered.push(doc.getPages()[0]!.name);
      return fakeShot;
    });
    const old = await oldFile('Old');
    await fetch(`${h.base}/api/files`);
    const edited = h.server.storage.create('Edited');
    const room = await h.server.rooms.get(edited.id);
    room.doc.transact(() => {
      room.doc.renamePage(room.doc.getPages()[0]!.id, 'Edited page');
      room.doc.insert(room.doc.getPages()[0]!.id, { type: 'frame', name: 'B', artboard: true, style: { width: '100px', height: '100px' } });
    });
    await until(() => Boolean(h!.server.storage.get(edited.id)?.thumbnail), 3000);
    // The edited file went at once; the old one waits for the delay although the queue was running.
    expect(rendered).toEqual(['Edited page']);
    expect(h.server.storage.get(old)?.thumbnail).toBeUndefined();
    await until(() => Boolean(h!.server.storage.get(old)?.thumbnail), 6000);
    expect(rendered).toHaveLength(2);
  }, 12_000);

  it('never takes a room from someone who opens the file in the same tick as its preview, or while it loads', async () => {
    h = await startServer({ thumbnails: true, thumbnailStartupMs: 0, memory: () => ({ available: 3000 * MB }) });
    const id = await oldFile('Shared');
    let held: Awaited<ReturnType<typeof h.server.rooms.get>> | undefined;
    let loading: Promise<unknown> | undefined;
    vi.spyOn(h.server.renderer, 'screenshot').mockImplementation(async () => {
      // Synchronously, in the render's own tick: an agent starts loading the file and is still loading when it ends.
      loading = h!.server.rooms.get(id).then((room) => { held = room; });
      return fakeShot;
    });
    await fetch(`${h.base}/api/files`);
    await until(() => Boolean(h!.server.storage.get(id)?.thumbnail), 6000);
    await loading;
    // The agent's room is the loaded room, alive, and still in the cache.
    expect(held).toBeDefined();
    expect(h.server.rooms.peek(id)).toBe(held);
    expect(held!.doc.getPages().length).toBeGreaterThan(0);
    held!.doc.transact(() => held!.doc.renamePage(held!.doc.getPages()[0]!.id, 'Still works'));
    expect(h.server.rooms.peek(id)!.doc.getPages()[0]!.name).toBe('Still works');
  }, 10_000);

  it('keeps the normal room lifetime under memory pressure: open exports hold rooms without a lease', async () => {
    h = await startServer({ memory: () => ({ available: 300 * MB }) });
    const f = h.server.storage.create('Idle');
    const room = await h.server.rooms.get(f.id);
    room.lastUsed = Date.now() - 90_000;
    await (h.server.rooms as unknown as { sweep: () => Promise<void> }).sweep();
    expect(h.server.rooms.peek(f.id)).toBe(room);
  });
});
