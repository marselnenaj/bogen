import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BogenDoc, replaceLayerText, Y } from '@bogen/core';
import { BogenServer, type ServerOptions } from '../src/http/server.ts';
import { compareSync, fromTheOtherSide, SyncConflicts, type RawConflict, type SyncConflict } from '../src/sync-conflicts.ts';
import type { ChangeEntry } from '../src/timeline.ts';
import { until } from './helpers.ts';

/** Two devices with one text layer, then apart. */
function apart(start: string) {
  const base = new BogenDoc(new Y.Doc());
  base.ensureFirstPage();
  const id = base.insert(base.getPages()[0]!.id, { type: 'text', name: 'Title', text: start });
  const state = Y.encodeStateAsUpdate(base.y);
  const copy = (client: number) => {
    const y = new Y.Doc();
    y.clientID = client;
    Y.applyUpdate(y, state);
    return new BogenDoc(y);
  };
  const a = copy(1001);
  const b = copy(2002);
  /** What `to` finds when the other's catch-up arrives. */
  const compare = (to: BogenDoc, from: BogenDoc) => compareSync(Y.encodeStateAsUpdate(to.y), Y.encodeStateAsUpdate(from.y, Y.encodeStateVector(to.y)), { remoteSv: Y.encodeStateVector(from.y) });
  const merged = () => {
    const y = new Y.Doc();
    Y.applyUpdate(y, Y.encodeStateAsUpdate(a.y));
    Y.applyUpdate(y, Y.encodeStateAsUpdate(b.y));
    return new BogenDoc(y).getNode(id)!.text;
  };
  return { id, a, b, compare, merged };
}

describe('a text both devices edited while apart', () => {
  it('keeps one whole text when both typed the same words, with no note', () => {
    const { id, a, b, compare, merged } = apart('');
    a.updateFields(id, { text: 'Same words on both' });
    b.updateFields(id, { text: 'Same words on both' });
    expect(merged()).toBe('Same words on bothSame words on both');
    const atA = compare(a, b);
    expect(atA.conflicts).toEqual([]);
    expect(atA.fixes).toEqual([expect.objectContaining({ nodeId: id, text: 'Same words on both' })]);
  });

  it('notes two different edits at the same place, on both sides, and both keep the same one', () => {
    const { id, a, b, compare, merged } = apart('Title');
    a.updateFields(id, { text: 'Title cut' });
    b.updateFields(id, { text: 'Title, from the PC' });
    expect(merged()).not.toBe('Title cut');
    const atA = compare(a, b);
    const atB = compare(b, a);
    expect(atA.conflicts).toHaveLength(1);
    const note = atA.conflicts[0]!;
    expect(note).toMatchObject({ kind: 'layer', nodeId: id, field: 'text', ours: 'Title cut', theirs: 'Title, from the PC' });
    expect(note.texts).toEqual({ ours: { text: 'Title cut', spans: [] }, theirs: { text: 'Title, from the PC', spans: [] } });
    expect(atB.conflicts[0]).toMatchObject({ ours: 'Title, from the PC', theirs: 'Title cut' });
    expect(note.kept === 'ours').toBe(atB.conflicts[0]!.kept === 'theirs');
    expect(atA.fixes[0]!.text).toBe(atB.fixes[0]!.text);
    expect(atA.fixes[0]!.text).toBe(note.kept === 'ours' ? 'Title cut' : 'Title, from the PC');
  });

  it('carries ranges in the note', () => {
    const { id, a, b, compare } = apart('Hello');
    a.updateFields(id, { text: 'Hello there', spans: [{ start: 0, end: 5, style: { fontWeight: '700' } }] });
    b.updateFields(id, { text: 'Hello you' });
    const note = compare(a, b).conflicts[0]!;
    expect(note.texts!.ours.spans).toEqual([{ start: 0, end: 5, style: { fontWeight: '700' } }]);
  });

  it('merges edits in different words, one at the start and one at the end', () => {
    const { id, a, b, compare, merged } = apart('Welcome to Bogen');
    a.updateFields(id, { text: 'Hi, welcome to Bogen' });
    b.updateFields(id, { text: 'Welcome to Bogen today' });
    expect(merged()).toBe('Hi, welcome to Bogen today');
    expect(compare(a, b)).toEqual({ conflicts: [], fixes: [] });
    expect(compare(b, a)).toEqual({ conflicts: [], fixes: [] });
  });

  it('merges a word put in front of another word and a mark after it', () => {
    const { id, a, b, compare, merged } = apart('Hello world');
    a.updateFields(id, { text: 'Hello brave world' });
    b.updateFields(id, { text: 'Hello world!' });
    expect(merged()).toBe('Hello brave world!');
    expect(compare(a, b).fixes).toEqual([]);
  });

  it('notes edits to one word, even when they do not touch', () => {
    const { id, a, b, compare } = apart('Price 100 EUR');
    a.updateFields(id, { text: 'Price 105 EUR' });
    b.updateFields(id, { text: 'Price 200 EUR' });
    expect(compare(a, b).conflicts).toHaveLength(1);
    expect(compare(b, a).conflicts).toHaveLength(1);
  });

  it('says nothing when only one side changed the text, or the other only its ranges', () => {
    const one = apart('Hello world');
    one.a.updateFields(one.id, { text: 'Hello there' });
    one.b.updateFields(one.id, { name: 'Renamed' });
    expect(one.compare(one.a, one.b)).toEqual({ conflicts: [], fixes: [] });
    const looks = apart('Hello world');
    looks.a.updateFields(looks.id, { text: 'Hello there' });
    looks.b.updateFields(looks.id, { spans: [{ start: 6, end: 11, style: { color: '#f00' } }] });
    expect(looks.compare(looks.a, looks.b).fixes).toEqual([]);
  });

  it('is quiet without the check, for a catch-up while connected', () => {
    const { id, a, b } = apart('Title');
    a.updateFields(id, { text: 'Title cut' });
    b.updateFields(id, { text: 'Title, from the PC' });
    expect(compareSync(Y.encodeStateAsUpdate(a.y), Y.encodeStateAsUpdate(b.y, Y.encodeStateVector(a.y)))).toEqual({ conflicts: [], fixes: [] });
  });

  it('settles to one copy when both devices settle at once, and the other side then finds nothing new', () => {
    const { id, a, b, compare } = apart('Title');
    a.updateFields(id, { text: 'Title cut' });
    b.updateFields(id, { text: 'Title, from the PC' });
    const atA = compare(a, b);
    const atB = compare(b, a);
    const aState = Y.encodeStateAsUpdate(a.y);
    const bState = Y.encodeStateAsUpdate(b.y);
    Y.applyUpdate(a.y, bState);
    Y.applyUpdate(b.y, aState);
    const fixA = atA.fixes[0]!;
    a.transact(() => replaceLayerText(a.nodes.get(id) as Y.Map<unknown>, fixA.text, fixA.spans));
    // The other side sees the first one's fix before settling it itself.
    const later = compareSync(Y.encodeStateAsUpdate(b.y), Y.encodeStateAsUpdate(a.y, Y.encodeStateVector(b.y)), { remoteSv: Y.encodeStateVector(a.y) });
    expect(later).toEqual({ conflicts: [], fixes: [] });
    const fixB = atB.fixes[0]!;
    b.transact(() => replaceLayerText(b.nodes.get(id) as Y.Map<unknown>, fixB.text, fixB.spans));
    Y.applyUpdate(a.y, Y.encodeStateAsUpdate(b.y));
    Y.applyUpdate(b.y, Y.encodeStateAsUpdate(a.y));
    expect(a.getNode(id)!.text).toBe(fixA.text);
    expect(b.getNode(id)!.text).toBe(fixA.text);
    expect(a.nodes.get(id)!.get('text')).toBe(fixA.text);
  });
});

const homes: string[] = [];
const running = new Set<BogenServer>();

async function boot(home = mkdtempSync(join(tmpdir(), 'bogen-text-')), port = 0, options: Partial<ServerOptions> = {}): Promise<BogenServer> {
  homes.push(home);
  const server = new BogenServer({ home, port, insecureAllowAnyHost: true, peerCatchUpMs: 60_000, exportDir: join(home, 'exports'), ...options });
  await server.listen();
  running.add(server);
  return server;
}

async function stop(server: BogenServer): Promise<void> {
  running.delete(server);
  await server.close();
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of [...running]) await stop(server);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function pair(a: BogenServer, b: BogenServer): Promise<void> {
  const info = await (await post(a.localUrl(), '/api/peers/pair', { insecure: true })).json() as { url: string; token: string };
  expect((await post(b.localUrl(), '/api/peers', { url: info.url, token: info.token, insecure: true })).status).toBe(201);
  await until(() => a.peers.status().some((p) => p.state === 'connected') && b.peers.status().some((p) => p.state === 'connected'), 6000);
}

const notes = async (s: BogenServer, file: string) => await (await fetch(`${s.localUrl()}/api/files/${file}/conflicts`)).json() as SyncConflict[];
const textOf = async (s: BogenServer, file: string, id: string) => (await s.rooms.get(file)).doc.getNode(id)!.text ?? '';

describe('text edited on two real servers while apart', () => {
  it('keeps one whole text, notes it on both, and offers Use the other, Keep both as a branch and Dismiss', async () => {
    const homeA = mkdtempSync(join(tmpdir(), 'bogen-text-a-'));
    let a = await boot(homeA);
    const b = await boot();
    await pair(a, b);
    const file = (await (await post(a.localUrl(), '/api/files', { name: 'Words' })).json() as { id: string }).id;
    await until(() => Boolean(b.storage.get(file)), 5000);
    const room = await a.rooms.get(file);
    const page = room.doc.getPages()[0]!.id;
    const add = (name: string, text: string) => room.doc.insert(page, { type: 'text', name, text });
    const title = add('Title', 'Title');
    const same = add('Same', 'Draft');
    const price = add('Price', 'Price 100 EUR');
    const welcome = add('Welcome', 'Welcome to Bogen');
    await until(async () => Boolean((await b.rooms.get(file)).doc.getNode(welcome)), 5000);
    const path = a.storage.docPath(file);
    const port = a.port;

    // Apart: one device is off, the other edits with the link down.
    await stop(a);
    const roomB = await b.rooms.get(file);
    roomB.doc.updateFields(title, { text: 'Title, from the PC' });
    roomB.doc.updateFields(same, { text: 'Same words on both' });
    roomB.doc.updateFields(price, { text: 'Price 200 EUR' });
    roomB.doc.updateFields(welcome, { text: 'Welcome to Bogen today' });
    // The device that was off was edited too before it comes back.
    const offline = new BogenDoc(new Y.Doc());
    Y.applyUpdate(offline.y, readFileSync(path));
    offline.updateFields(title, { text: 'Title cut' });
    offline.updateFields(same, { text: 'Same words on both' });
    offline.updateFields(price, { text: 'Price 105 EUR' });
    offline.updateFields(welcome, { text: 'Hi, welcome to Bogen' });
    writeFileSync(path, Y.encodeStateAsUpdate(offline.y));
    a = await boot(homeA, port);

    const settled = async () => {
      for (const s of [a, b]) {
        if (await textOf(s, file, same) !== 'Same words on both' || await textOf(s, file, welcome) !== 'Hi, welcome to Bogen today') return false;
        if (!['Title cut', 'Title, from the PC'].includes(await textOf(s, file, title))) return false;
        if ((await notes(s, file)).length < 2) return false;
      }
      return await textOf(a, file, title) === await textOf(b, file, title) && await textOf(a, file, price) === await textOf(b, file, price);
    };
    await until(settled, 20_000).catch(() => {});
    for (const s of [a, b]) {
      expect(await textOf(s, file, same)).toBe('Same words on both');
      expect(await textOf(s, file, welcome)).toBe('Hi, welcome to Bogen today');
      // What older builds read is the same text.
      expect((await s.rooms.get(file)).doc.nodes.get(title)!.get('text')).toBe(await textOf(s, file, title));
    }
    const kept = await textOf(a, file, title);
    expect(['Title cut', 'Title, from the PC']).toContain(kept);
    expect(await textOf(b, file, title)).toBe(kept);
    expect(['Price 105 EUR', 'Price 200 EUR']).toContain(await textOf(a, file, price));

    const atA = await notes(a, file);
    const atB = await notes(b, file);
    // Two notes on each side: the title and the price. Same words and the clean merge have none.
    expect(atA.map((n) => n.nodeId).sort()).toEqual([title, price].sort());
    expect(atB.map((n) => n.nodeId).sort()).toEqual([title, price].sort());
    const noteA = atA.find((n) => n.nodeId === title)!;
    const noteB = atB.find((n) => n.nodeId === title)!;
    expect(noteA.texts).toEqual({ ours: { text: 'Title cut', spans: [] }, theirs: { text: 'Title, from the PC', spans: [] } });
    expect(noteB.texts).toEqual({ ours: { text: 'Title, from the PC', spans: [] }, theirs: { text: 'Title cut', spans: [] } });
    expect(noteA.kept).toBe(kept === 'Title cut' ? 'ours' : 'theirs');
    expect(noteB.kept).toBe(kept === 'Title cut' ? 'theirs' : 'ours');

    // Use the other: what the Sync section does, an ordinary edit, then the note goes.
    const other = noteA.kept === 'ours' ? noteA.texts!.theirs : noteA.texts!.ours;
    (await a.rooms.get(file)).doc.updateFields(title, { text: other.text, spans: other.spans ?? [] });
    expect((await fetch(`${a.localUrl()}/api/files/${file}/conflicts/${noteA.id}`, { method: 'DELETE' })).status).toBe(200);
    await until(async () => await textOf(b, file, title) === other.text, 5000);
    expect(await textOf(a, file, title)).toBe(other.text);

    // Keep both as a branch, on the other device: the file keeps its text, the branch has the one that was not kept.
    const priceB = atB.find((n) => n.nodeId === price)!;
    const shown = await textOf(b, file, price);
    const res = await post(b.localUrl(), `/api/files/${file}/conflicts/${priceB.id}/branch`, {});
    expect(res.status).toBe(201);
    const branch = await res.json() as { id: string; name: string };
    const device = priceB.kept === 'ours' ? priceB.device : b.peers.device().name;
    expect(branch.name).toBe(`text from ${device}`);
    expect(await textOf(b, file, price)).toBe(shown);
    expect(await textOf(b, branch.id, price)).toBe(shown === 'Price 105 EUR' ? 'Price 200 EUR' : 'Price 105 EUR');
    expect((await notes(b, file)).map((n) => n.nodeId)).toEqual([title]);
    // No such note.
    expect((await post(b.localUrl(), `/api/files/${file}/conflicts/nope/branch`, {})).status).toBe(404);

    // Dismiss.
    const priceA = (await notes(a, file)).find((n) => n.nodeId === price)!;
    expect((await fetch(`${a.localUrl()}/api/files/${file}/conflicts/${priceA.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await notes(a, file)).toEqual([]);

    // A delete from the other device takes the notes along, in the moment the file leaves the list there.
    expect(b.peers.conflicts.list(file)).toHaveLength(1);
    const notesAtRemove: number[] = [];
    const remove = b.storage.remove.bind(b.storage);
    vi.spyOn(b.storage, 'remove').mockImplementation(async (id) => {
      if (id === file) notesAtRemove.push(b.peers.conflicts.list(id).length);
      return remove(id);
    });
    expect((await fetch(`${a.localUrl()}/api/files/${file}`, { method: 'DELETE' })).status).toBe(200);
    await until(() => !b.storage.get(file), 10_000);
    expect(notesAtRemove).toEqual([0]);
    expect(b.peers.conflicts.list(file)).toEqual([]);
  }, 60_000);

  it('never counts typing that crosses over the live link, also when a catch-up runs right then', async () => {
    const a = await boot();
    const b = await boot();
    await pair(a, b);
    const file = (await (await post(a.localUrl(), '/api/files', { name: 'Live' })).json() as { id: string }).id;
    await until(() => Boolean(b.storage.get(file)), 5000);
    const roomA = await a.rooms.get(file);
    const id = roomA.doc.insert(roomA.doc.getPages()[0]!.id, { type: 'text', text: 'Title' });
    await until(async () => Boolean((await b.rooms.get(file)).doc.getNode(id)), 5000);
    const roomB = await b.rooms.get(file);
    // Both type at one place in the same moment, so each edit is made without the other's.
    roomA.doc.updateFields(id, { text: 'Title one' });
    roomB.doc.updateFields(id, { text: 'Title two' });
    // A sweep right now brings the other's edit by catch-up, before the live update is applied.
    (a.peers as unknown as { sweep(): void }).sweep();
    (b.peers as unknown as { sweep(): void }).sweep();
    await until(async () => await textOf(a, file, id) === await textOf(b, file, id) && (await textOf(a, file, id)).length === 'Title one two'.length, 10_000).catch(() => {});
    const merged = await textOf(a, file, id);
    expect(await textOf(b, file, id)).toBe(merged);
    // Merged per character: both edits are there.
    expect(merged.length).toBe('Title one two'.length);
    expect(merged).toContain('one');
    expect(merged).toContain('two');
    await new Promise((r) => setTimeout(r, 300));
    expect(await notes(a, file)).toEqual([]);
    expect(await notes(b, file)).toEqual([]);
  }, 30_000);
});

describe('a note a person dealt with', () => {
  it('does not come back when the other device reports the same conflict a moment later', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bogen-notes-'));
    homes.push(home);
    const notes = new SyncConflicts(home, () => {});
    const raw: RawConflict = { kind: 'layer', nodeId: 'n1', name: 'Title', field: 'text', ours: 'Title cut', theirs: 'Title, from the PC', kept: 'ours', texts: { ours: { text: 'Title cut', spans: [] }, theirs: { text: 'Title, from the PC', spans: [] } } };
    const price: RawConflict = { kind: 'layer', nodeId: 'n2', name: 'Price', field: 'text', ours: 'Price 105 EUR', theirs: 'Price 200 EUR', kept: 'theirs' };
    const [note] = notes.add('f1', 'pc', [raw, price]);
    // Dismissed here, or kept as a branch; the other device's report of the same conflict was still on its way.
    notes.dismiss('f1', note!.id);
    expect(notes.add('f1', 'pc', [fromTheOtherSide(fromTheOtherSide(raw))])).toEqual([]);
    expect(notes.list('f1').map((n) => n.name)).toEqual(['Price']);
    // Dismissing them all works the same.
    notes.dismiss('f1');
    expect(notes.add('f1', 'pc', [price, raw])).toEqual([]);
    expect(notes.list('f1')).toEqual([]);
    // A different conflict on the same layer is a new note.
    expect(notes.add('f1', 'pc', [{ ...raw, theirs: 'Title, again' }])).toHaveLength(1);
    await notes.flush();
  });
});

describe('a file deleted while a change of it is being written', () => {
  it('writes no change of a file that is gone, and brings none of its history back', async () => {
    const s = await boot();
    const file = s.createFile('Gone').id;
    const room = await s.rooms.get(file);
    room.doc.insert(room.doc.getPages()[0]!.id, { type: 'text', name: 'Title', text: 'Title' });
    // Removed as a delete from another device removes it, while the change above is still open.
    await s.storage.remove(file);
    s.rooms.drop(file);
    // And the other device's log of it arrives late.
    const late: ChangeEntry = { id: 'other-device:1', device: 'other-device', deviceName: 'Other', seq: 1, at: Date.now(), source: 'person', actor: 'Someone', summary: 'Edited', layers: [], layerCount: 0 };
    expect(await s.timeline.receive(file, 'other-device', [late])).toBe(0);
    await s.timeline.flush(file);
    expect(existsSync(join(s.storage.home, 'history', file))).toBe(false);
    await stop(s);
  });

  it('reports a change it could not write, and still closes', async () => {
    const s = await boot();
    const file = s.createFile('Blocked').id;
    const room = await s.rooms.get(file);
    room.doc.insert(room.doc.getPages()[0]!.id, { type: 'text', name: 'Title', text: 'Title' });
    // Something in the way of the change log.
    rmSync(join(s.storage.home, 'history', file), { recursive: true, force: true });
    mkdirSync(join(s.storage.home, 'history'), { recursive: true });
    writeFileSync(join(s.storage.home, 'history', file), 'not a folder');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    s.rooms.drop(file);
    await stop(s);
    expect(errors.mock.calls.some(([m]) => String(m).includes(`could not write a change of ${file}`))).toBe(true);
    errors.mockRestore();
  });
});

describe('a value both devices set while apart, when both catch up at once', () => {
  it('never notes a value as undefined once the other side has taken ours over its own', () => {
    const base = new BogenDoc(new Y.Doc());
    base.ensureFirstPage();
    const id = base.insert(base.getPages()[0]!.id, { type: 'frame', name: 'Hero', style: { color: '#000' } });
    const state = Y.encodeStateAsUpdate(base.y);
    for (const [first, second] of [[1001, 2002], [2002, 1001]] as const) {
      const copy = (client: number) => {
        const y = new Y.Doc();
        y.clientID = client;
        Y.applyUpdate(y, state);
        return new BogenDoc(y);
      };
      const here = copy(first);
      const there = copy(second);
      here.updateStyle(id, { color: '#a0a' });
      there.updateStyle(id, { color: '#b0b' });
      // There, the catch-up from here has already arrived; then here asks there for what it lacks.
      const before = Y.encodeStateAsUpdate(here.y);
      Y.applyUpdate(there.y, Y.encodeStateAsUpdate(here.y, Y.encodeStateVector(there.y)));
      const found = compareSync(before, Y.encodeStateAsUpdate(there.y, Y.encodeStateVector(here.y)), { remoteSv: Y.encodeStateVector(there.y) });
      for (const c of found.conflicts) expect([c.ours, c.theirs].sort()).toEqual(['#a0a', '#b0b']);
    }
  });
});
