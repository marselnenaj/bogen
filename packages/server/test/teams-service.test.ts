import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Y } from '@bogen/core';
import { TeamService } from '../src/teams/service.ts';
import { newEd } from '../src/teams/crypto.ts';
import { deviceCertificate, tlsPost } from '../src/teams/tls.ts';

/** Two or three devices on this machine, each with its own home, talking over 127.0.0.1 as their "LAN". */
const made: { svc: TeamService; home: string }[] = [];
let port = 31_400 + Math.floor(Math.random() * 400);

async function device(name: string) {
  const home = await mkdtemp(join(tmpdir(), 'bogen-teams-'));
  const docs = new Map<string, Y.Doc>();
  const names = new Map<string, string>();
  const svc = new TeamService({
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
  });
  await svc.start();
  made.push({ svc, home });
  const p = port++;
  await svc.setTransports({ lan: { on: true, address: '127.0.0.1' }, tailscale: { on: false }, vpn: { on: false, address: '' }, port: p });
  return { svc, docs, names, home };
}

afterEach(async () => {
  for (const { svc, home } of made.splice(0)) {
    await svc.stop();
    await rm(home, { recursive: true, force: true });
  }
});

describe('teams between devices', () => {
  it('nothing listens until a connection is turned on', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bogen-teams-'));
    const svc = new TeamService({ home, deviceName: () => 'x', doc: async () => new Y.Doc(), ensureFile: () => {}, fileExists: () => false, fileName: () => undefined });
    await svc.start();
    expect(svc.urls).toEqual([]);
    await svc.stop();
    await rm(home, { recursive: true, force: true });
  });

  it('owner must confirm the recovery phrase before inviting; then a member joins, gets the file and edits sync both ways', async () => {
    const anna = await device('Desk PC');
    const jonas = await device('MacBook');
    const { team, phrase } = await anna.svc.create('Studio Nord', 'Anna');
    expect(phrase).toHaveLength(12);
    await expect(anna.svc.invite(team, 'edit')).rejects.toThrow(/recovery phrase/);
    await expect(anna.svc.confirmPhrase(Object.fromEntries(phrase!.map((w, i) => [String(i), i === 0 ? 'wrong' : w])))).rejects.toThrow();
    await anna.svc.confirmPhrase(Object.fromEntries(phrase!.map((w, i) => [String(i), w])));
    // Identity and secrets are private to this user.
    const mode = (await import('node:fs/promises')).stat;
    expect(((await mode(join(anna.home, 'teams', 'identity.json'))).mode & 0o077)).toBe(0);

    const annaDoc = await anna.svc['deps'].doc('menuboards');
    anna.names.set('menuboards', 'Menu boards');
    annaDoc.getMap('nodes').set('title', 'Today at the harbour');
    await anna.svc.addFile(team, 'menuboards');
    const { link } = await anna.svc.invite(team, 'edit');
    await jonas.svc.join(link, 'Jonas');
    await jonas.svc.syncAll();
    const jonasDoc = jonas.docs.get('menuboards');
    expect(jonasDoc?.getMap('nodes').get('title')).toBe('Today at the harbour');

    jonasDoc!.getMap('nodes').set('hours', 'Open 7 to 17');
    await jonas.svc.syncAll();
    expect(annaDoc.getMap('nodes').get('hours')).toBe('Open 7 to 17');

    const view = anna.svc.view().teams[0]!;
    expect(view.members.map((m) => [m.name, m.role]).sort()).toEqual([['Anna', 'owner'], ['Jonas', 'edit']]);
    // Used up: the same link does not work twice.
    const mira = await device('iPhone');
    await expect(mira.svc.join(link, 'Mira')).rejects.toThrow(/used up|revoked|expired/);
  }, 30_000);

  it('a comment-only member\'s layer edit stays on their device; a removed member is cut off', async () => {
    const anna = await device('Desk PC');
    const tomas = await device('ThinkPad');
    const { team, phrase } = await anna.svc.create('Studio Nord', 'Anna');
    await anna.svc.confirmPhrase(Object.fromEntries(phrase!.map((w, i) => [String(i), w])));
    const annaDoc = await anna.svc['deps'].doc('menuboards');
    anna.names.set('menuboards', 'Menu boards');
    annaDoc.getMap('nodes').set('title', 'Today');
    await anna.svc.addFile(team, 'menuboards');
    await tomas.svc.join((await anna.svc.invite(team, 'comment')).link, 'Tomas');
    await tomas.svc.syncAll();
    const tomasDoc = tomas.docs.get('menuboards')!;
    tomasDoc.getMap('comments').set('c1', 'The bun photo is dark');
    tomasDoc.getMap('nodes').set('title', 'Hacked');
    await tomas.svc.syncAll();
    expect(annaDoc.getMap('comments').get('c1')).toBe('The bun photo is dark');
    expect(annaDoc.getMap('nodes').get('title')).toBe('Today');

    const person = tomas.svc.view().me.person;
    await anna.svc.remove(team, person, true);
    await anna.svc.syncAll();
    tomasDoc.getMap('comments').set('c2', 'after removal');
    await tomas.svc.syncAll();
    expect(annaDoc.getMap('comments').get('c2')).toBeUndefined();
  }, 30_000);

  it('refuses a join proof made on another connection, strangers, and anything but an exact POST path', async () => {
    const anna = await device('Desk PC');
    const { team, phrase } = await anna.svc.create('Studio Nord', 'Anna');
    await anna.svc.confirmPhrase(Object.fromEntries(phrase!.map((w, i) => [String(i), w])));
    const { link } = await anna.svc.invite(team, 'view', 7, 5);
    const url = anna.svc.urls[0]!;
    expect(url.startsWith('https://127.0.0.1:')).toBe(true);
    const annaKey = anna.svc.view().me.device;
    // Someone holding a device key but a proof from another connection (a captured join) is refused.
    const stranger = newEd();
    const tls = deviceCertificate(stranger);
    const { parseInvite, joinProof } = await import('../src/teams/invite.ts');
    const inv = parseInvite(link);
    const replayed = await tlsPost(url, tls, annaKey, '/team/v2/join', () => JSON.stringify({ team, invite: inv.id, person: stranger.pub, name: 'X', cert: {}, proof: joinProof(inv.secret, stranger.pub, stranger.pub, 'another-connection') }));
    expect(replayed.status).toBe(403);
    // A stranger's sync is turned away before its body is read.
    const sync = await tlsPost(url, tls, annaKey, '/team/v2/sync', () => JSON.stringify({ team, ops: [], vectors: {} }));
    expect(sync.status).toBe(403);
    expect(sync.body).toMatch(/Not a device of this team/);
    // Anything but an exact POST path is not found.
    expect((await tlsPost(url, tls, annaKey, '/team/v2//sync', () => '{}')).status).toBe(404);
    // The device answering must be the one expected: nothing is sent to another.
    await expect(tlsPost(url, tls, stranger.pub, '/team/v2/sync', () => '{}')).rejects.toThrow(/another device/);
    // And a real join still works.
    const jonas = await device('MacBook');
    await jonas.svc.join(link, 'Jonas');
    expect(anna.svc.view().teams[0]!.members.map((m) => m.name).sort()).toEqual(['Anna', 'Jonas']);
  }, 30_000);
});
