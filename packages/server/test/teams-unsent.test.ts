import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BogenDoc, Y } from '@bogen/core';
import { TeamService } from '../src/teams/service.ts';
import { freePort } from './teams-writers.ts';
import { mergeByContent } from '../src/history-ops.ts';

/**
 * No silent loss (teams-1): a change to a team file written with a Yjs id this device never handed out cannot be
 * signed as this device's. It is kept on disk and shown, never dropped, and "Try again" writes it anew as this
 * device's, so the team gets the same design. A file branch merged into a team file is written as this device's in
 * the first place.
 */

const made: { svc: TeamService; home: string }[] = [];

async function device(name: string) {
  const home = await mkdtemp(join(tmpdir(), 'bogen-teams-'));
  const docs = new Map<string, Y.Doc>();
  const names = new Map<string, string>();
  const unsentEvents: [string, number][] = [];
  const resets: string[] = [];
  const svc: TeamService = new TeamService({
    home, deviceName: () => name,
    doc: async (file) => {
      let d = docs.get(file);
      if (!d) {
        d = new Y.Doc();
        d.on('update', (u: Uint8Array, origin: unknown) => svc.onRoomUpdate(file, u, origin));
        docs.set(file, d);
      }
      return d;
    },
    ensureFile: (file, n) => { if (!names.has(file)) names.set(file, n); },
    fileExists: (file) => names.has(file),
    fileName: (file) => names.get(file),
    onUnsent: (file, count) => void unsentEvents.push([file, count]),
    // As the server does: the loaded copy goes, the state is written, and the file loads again.
    resetFile: async (file, state) => {
      const d = new Y.Doc();
      Y.applyUpdate(d, state);
      d.on('update', (u: Uint8Array, origin: unknown) => svc.onRoomUpdate(file, u, origin));
      docs.set(file, d);
      svc.bindDoc(file, d);
      resets.push(file);
    },
  });
  await svc.start();
  made.push({ svc, home });
  await svc.setTransports({ lan: { on: true, address: '127.0.0.1' }, tailscale: { on: false }, vpn: { on: false, address: '' }, port: await freePort() });
  return { svc, docs, names, home, unsentEvents, resets };
}

afterEach(async () => {
  for (const { svc, home } of made.splice(0)) {
    await svc.stop();
    await rm(home, { recursive: true, force: true });
  }
});

const confirm = (svc: TeamService, phrase: string[]) => svc.confirmPhrase(Object.fromEntries(phrase.map((w, i) => [String(i), w])));

/** Anna shares a real design file with Jonas (edit). Returns both, the file's docs and a layer id. */
async function shared() {
  const anna = await device('Desk PC');
  const jonas = await device('MacBook');
  const { team, phrase } = await anna.svc.create('Studio Nord', 'Anna');
  await confirm(anna.svc, phrase!);
  const annaY = await anna.svc['deps'].doc('menuboards');
  anna.names.set('menuboards', 'Menu boards');
  const doc = new BogenDoc(annaY);
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  const layer = doc.insert(page, { type: 'text', name: 'Title', text: 'Today at the harbour' });
  await anna.svc.addFile(team, 'menuboards');
  await jonas.svc.join((await anna.svc.invite(team, 'edit')).link, 'Jonas');
  await jonas.svc.syncAll();
  return { anna, jonas, team, annaY, doc, layer, jonasY: () => jonas.docs.get('menuboards')!, annaNow: () => anna.docs.get('menuboards')! };
}

/** A change written with a Yjs id nobody handed out, as a merge or an old offline phone would bring in. */
function foreignChange(into: Y.Doc, edit: (d: BogenDoc) => void): Uint8Array {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(into));
  const before = Y.encodeStateVector(other);
  edit(new BogenDoc(other));
  return Y.encodeStateAsUpdate(other, before);
}

describe('changes that could not be signed', () => {
  it('are kept on disk and reported, not dropped; Try again writes them as this device\'s and the team gets them', async () => {
    const { anna, jonas, team, annaY, layer, jonasY, annaNow } = await shared();
    const update = foreignChange(annaY, (d) => d.updateFields(layer, { name: 'Headline' }));
    Y.applyUpdate(annaY, update, 'phone');
    await anna.svc.flushOutbox();
    expect(anna.svc.unsentCount('menuboards')).toBe(1);
    expect(anna.unsentEvents.at(-1)).toEqual(['menuboards', 1]);
    await anna.svc.syncAll();
    await jonas.svc.syncAll();
    expect(new BogenDoc(jonasY()).getNode(layer)?.name).toBe('Title');

    // Kept on disk, so a restart does not lose it.
    expect(await anna.svc['store'].unsent(team, 'menuboards')).toHaveLength(1);

    expect(await anna.svc.retryUnsent('menuboards')).toBe(0);
    await anna.svc.syncAll();
    await jonas.svc.syncAll();
    expect(new BogenDoc(jonasY()).getNode(layer)?.name).toBe('Headline');
    // Both ends show the same design, text not doubled.
    expect(new BogenDoc(annaNow()).getNode(layer)?.text).toBe('Today at the harbour');
    expect(new BogenDoc(annaNow()).getNode(layer)?.name).toBe('Headline');
    expect(anna.resets).toEqual(['menuboards']);
    expect(new BogenDoc(jonasY()).getNode(layer)?.text).toBe('Today at the harbour');
  }, 40_000);

  it('a rewritten text change reaches the team once, not doubled on either side', async () => {
    const { anna, jonas, annaY, layer, jonasY, annaNow } = await shared();
    const update = foreignChange(annaY, (d) => d.updateFields(layer, { text: 'Closed on Monday' }));
    Y.applyUpdate(annaY, update, 'phone');
    await anna.svc.flushOutbox();
    expect(anna.svc.unsentCount('menuboards')).toBe(1);
    expect(await anna.svc.retryUnsent('menuboards')).toBe(0);
    await anna.svc.flushOutbox();
    await anna.svc.syncAll();
    await jonas.svc.syncAll();
    await jonas.svc.syncAll();
    await anna.svc.syncAll();
    expect(new BogenDoc(jonasY()).getNode(layer)?.text).toBe('Closed on Monday');
    expect(new BogenDoc(annaNow()).getNode(layer)?.text).toBe('Closed on Monday');
    // Editing on after the reset reaches the team: nothing refers to the unsigned items any more.
    new BogenDoc(annaNow()).updateFields(layer, { text: 'Closed on Monday and Tuesday' });
    await anna.svc.flushOutbox();
    await anna.svc.syncAll();
    await jonas.svc.syncAll();
    expect(new BogenDoc(jonasY()).getNode(layer)?.text).toBe('Closed on Monday and Tuesday');
    expect(anna.svc.unsentCount('menuboards')).toBe(0);
  }, 40_000);

  it('Keep only here lets them go: nothing is sent, the count is 0', async () => {
    const { anna, jonas, annaY, layer, jonasY } = await shared();
    Y.applyUpdate(annaY, foreignChange(annaY, (d) => d.updateFields(layer, { name: 'Private' })), 'phone');
    await anna.svc.flushOutbox();
    await anna.svc.dropUnsent('menuboards');
    expect(anna.svc.unsentCount('menuboards')).toBe(0);
    await anna.svc.syncAll();
    await jonas.svc.syncAll();
    expect(new BogenDoc(jonasY()).getNode(layer)?.name).toBe('Title');
  }, 40_000);

  it('hands out a spare writer id for every team file, for a phone to keep before it goes offline', async () => {
    const { anna } = await shared();
    const spares = anna.svc.spares();
    expect(Object.keys(spares)).toEqual(['menuboards']);
    // The spare is one of this device's ids: a change written with it is signed, not kept.
    const annaY = anna.docs.get('menuboards')!;
    const phone = new Y.Doc();
    Y.applyUpdate(phone, Y.encodeStateAsUpdate(annaY));
    phone.clientID = spares.menuboards!;
    const before = Y.encodeStateVector(phone);
    phone.getMap('meta').set('note', 'written offline');
    Y.applyUpdate(annaY, Y.encodeStateAsUpdate(phone, before), 'phone');
    await anna.svc.flushOutbox();
    expect(anna.svc.unsentCount('menuboards')).toBe(0);
  }, 40_000);

  it('a file branch merged into a team file is written as this device\'s, so the team gets it and nothing is kept back', async () => {
    const { anna, jonas, layer, jonasY, annaNow } = await shared();
    // A branch is a copy of the file with ids of its own (history-ops createBranch), edited on its own.
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(annaNow()));
    new BogenDoc(copy).updateFields(layer, { name: 'Headline', text: 'Fresh fish until noon' });
    mergeByContent(new BogenDoc(annaNow()), copy, 'merge:Lunch');
    await anna.svc.flushOutbox();
    expect(anna.svc.unsentCount('menuboards')).toBe(0);
    await anna.svc.syncAll();
    await jonas.svc.syncAll();
    expect(new BogenDoc(jonasY()).getNode(layer)?.name).toBe('Headline');
    expect(new BogenDoc(jonasY()).getNode(layer)?.text).toBe('Fresh fish until noon');
    // Nothing of the copy's own ids went into the file.
    const sv = Y.decodeStateVector(Y.encodeStateVector(annaNow()));
    expect(sv.has(copy.clientID)).toBe(false);
  }, 40_000);
});
