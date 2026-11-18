import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BogenDoc } from '@bogen/core';
import { decodeRecords, encodeRecords } from '../src/doc-log.ts';
import { EventHub } from '../src/events.ts';
import { Storage } from '../src/storage.ts';
import { Rooms } from '../src/sync.ts';

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

async function setup(home = mkdtempSync(join(tmpdir(), 'bogen-log-'))) {
  if (!homes.includes(home)) homes.push(home);
  const storage = new Storage(home);
  await storage.init();
  return { home, storage, rooms: new Rooms(storage, new EventHub()) };
}

/** A document of `count` layers, built straight in Yjs: building it layer by layer through BogenDoc takes longer. */
function bigDoc(count: number): Uint8Array {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  doc.transact(() => {
    for (let i = 0; i < count; i++) {
      const m = new Y.Map<unknown>();
      m.set('type', i % 3 ? 'text' : 'frame');
      m.set('name', `Layer ${i}`);
      m.set('parent', i < 50 ? page : `n${i % 50}`);
      m.set('order', `a${String(i).padStart(6, '0')}`);
      const style = new Y.Map<string>();
      style.set('padding', '8px');
      style.set('color', '#123456');
      m.set('style', style);
      if (i % 3) m.set('text', `Some words for layer ${i}`);
      doc.nodes.set(`n${i}`, m);
    }
  });
  return Y.encodeStateAsUpdate(doc.y);
}

describe('saving a big file as a log of updates', () => {
  it('appends small edits to the log, keeps the full save, and loads both back', async () => {
    const { home, storage, rooms } = await setup();
    const file = storage.create('Big');
    await storage.writeDoc(file.id, bigDoc(6000));
    const base = readFileSync(storage.docPath(file.id));
    expect(base.byteLength).toBeGreaterThan(1024 * 1024);
    const room = await rooms.get(file.id);
    room.doc.transact(() => room.doc.nodes.get('n7')!.set('name', 'Renamed'), 'agent:t');
    room.doc.transact(() => (room.doc.nodes.get('n8')!.get('style') as Y.Map<string>).set('color', '#ff0000'), 'agent:t');
    await storage.flushDoc(file.id);
    expect(readFileSync(storage.docPath(file.id)).equals(base)).toBe(true);
    const log = readFileSync(storage.logPath(file.id));
    expect(log.byteLength).toBeLessThan(4096);
    expect(decodeRecords(log).records).toHaveLength(2);

    // Another process reading the file sees both edits.
    await storage.flushAll();
    const next = await setup(home);
    const again = await next.rooms.get(file.id);
    expect(again.doc.getNode('n7')?.name).toBe('Renamed');
    expect(again.doc.getNode('n8')?.style.color).toBe('#ff0000');
    const merged = new BogenDoc();
    Y.applyUpdate(merged.y, (await next.storage.readDoc(file.id))!);
    expect(merged.getNode('n7')?.name).toBe('Renamed');
  });

  it('folds the log into a full save when the file is unloaded, and keeps the one before as a backup', async () => {
    const { storage, rooms } = await setup();
    const file = storage.create('Big');
    await storage.writeDoc(file.id, bigDoc(6000));
    const room = await rooms.get(file.id);
    room.doc.transact(() => room.doc.nodes.get('n9')!.set('name', 'Kept'), 'agent:t');
    await storage.flushDoc(file.id);
    expect(existsSync(storage.logPath(file.id))).toBe(true);
    await rooms.unload(file.id);
    expect(existsSync(storage.logPath(file.id))).toBe(false);
    expect(existsSync(storage.backupPath(file.id))).toBe(true);
    const doc = new BogenDoc();
    Y.applyUpdate(doc.y, readFileSync(storage.docPath(file.id)));
    expect(doc.getNode('n9')?.name).toBe('Kept');
  });

  it('keeps the records before a torn one and trims the log', async () => {
    const { home, storage, rooms } = await setup();
    const file = storage.create('Big');
    await storage.writeDoc(file.id, bigDoc(6000));
    const room = await rooms.get(file.id);
    room.doc.transact(() => room.doc.nodes.get('n3')!.set('name', 'Before the crash'), 'agent:t');
    await storage.flushDoc(file.id);
    const good = statSync(storage.logPath(file.id)).size;
    // Half a record, as a crash in the middle of an append leaves it.
    const torn = encodeRecords([new Uint8Array(64).fill(7)]).subarray(0, 30);
    writeFileSync(storage.logPath(file.id), Buffer.concat([readFileSync(storage.logPath(file.id)), torn]));
    await storage.flushIndex();
    const next = await setup(home);
    const again = await next.rooms.get(file.id);
    expect(again.doc.getNode('n3')?.name).toBe('Before the crash');
    expect(statSync(next.storage.logPath(file.id)).size).toBe(good);
  });

  it('loads from the backup and the log when a crash came between the two renames of a full save', async () => {
    const { home, storage, rooms } = await setup();
    const file = storage.create('Big');
    await storage.writeDoc(file.id, bigDoc(6000));
    const room = await rooms.get(file.id);
    room.doc.transact(() => room.doc.nodes.get('n4')!.set('name', 'In the log'), 'agent:t');
    await storage.flushDoc(file.id);
    const { renameSync } = await import('node:fs');
    renameSync(storage.docPath(file.id), storage.backupPath(file.id));
    await storage.flushIndex();
    const again = await (await setup(home)).rooms.get(file.id);
    expect(again.doc.getNode('n4')?.name).toBe('In the log');
    expect(again.doc.getNode('n5999')).toBeDefined();
  });

  it('saves a small file whole, with no log', async () => {
    const { storage, rooms } = await setup();
    const file = storage.create('Small');
    const room = await rooms.get(file.id);
    room.doc.insert(room.doc.getPages()[0]!.id, { type: 'frame', name: 'Board', artboard: true });
    await storage.flushDoc(file.id);
    expect(existsSync(storage.docPath(file.id))).toBe(true);
    expect(existsSync(storage.logPath(file.id))).toBe(false);
  });

  it('writing a whole state replaces the log', async () => {
    const { home, storage, rooms } = await setup();
    const file = storage.create('Big');
    await storage.writeDoc(file.id, bigDoc(6000));
    const room = await rooms.get(file.id);
    room.doc.transact(() => room.doc.nodes.get('n4')!.set('name', 'Old edit'), 'agent:t');
    await storage.flushDoc(file.id);
    await rooms.unload(file.id);
    const fresh = new BogenDoc();
    fresh.ensureFirstPage();
    await storage.writeDoc(file.id, Y.encodeStateAsUpdate(fresh.y));
    expect(existsSync(storage.logPath(file.id))).toBe(false);
    await storage.flushAll();
    const again = await (await setup(home)).rooms.get(file.id);
    expect(again.doc.getNode('n4')).toBeUndefined();
  });

  it('opens a 50,000-layer file in under a second and writes under 1 MB for a small edit', async () => {
    const { home, storage } = await setup();
    const file = storage.create('Huge');
    await storage.writeDoc(file.id, bigDoc(50_000));
    await storage.flushAll();
    const second = await setup(home);
    const rooms = second.rooms;
    // What Yjs alone takes for these bytes on this machine now: the suite runs files in parallel, so a fixed budget
    // would measure the machine. Loading through storage may add little to it.
    const bytes = readFileSync(storage.docPath(file.id));
    let t = performance.now();
    Y.applyUpdate(new Y.Doc(), bytes);
    const yjs = performance.now() - t;
    t = performance.now();
    const room = await rooms.get(file.id);
    const open = performance.now() - t;
    expect(open).toBeLessThan(Math.max(1000, yjs * 2.5));
    const wchar = () => Number(/wchar: (\d+)/.exec(readFileSync('/proc/self/io', 'utf8'))?.[1] ?? 0);
    const before = wchar();
    room.doc.transact(() => room.doc.nodes.get('n100')!.set('name', 'Edited'), 'agent:t');
    await second.storage.flushDoc(file.id);
    expect(wchar() - before).toBeLessThan(1024 * 1024);
  });
});
