import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as encoding from 'lib0/encoding';
import { Y } from '@bogen/core';
import { fingerprint, newDeviceKeys, newEd } from '../src/teams/crypto.ts';
import { checkEnvelope, envelopeId, GRACE_MS, sealUpdate, vouchFor } from '../src/teams/envelope.ts';
import { teamUrlOk } from '../src/teams/invite.ts';
import { certify, certValid, makeOp, MAX_PERSON_OPS, replay, type Op, type Role } from '../src/teams/log.ts';
import { TeamService } from '../src/teams/service.ts';
import { editBy, mark, sealAs, writerDoc } from './teams-writers.ts';

/**
 * Regression tests for the security review of feat/teams-1 (2026-11-16), one block per finding. Each test is the
 * reviewer's proof of concept turned around: it fails on the code before the fix.
 */

function person(name: string) {
  const key = newEd();
  const device = newDeviceKeys();
  const cert = certify(key, { ed: device.ed.pub, x: device.x.pub, name: `${name} laptop` });
  return { name, key, device, cert, pub: key.pub };
}
type P = ReturnType<typeof person>;
function team() {
  const teamKey = newEd();
  const owner = person('Anna');
  const genesis = makeOp(teamKey.pub, [], { ed: teamKey }, owner.pub, 'genesis', { name: 'Studio', owner: { person: owner.pub, name: 'Anna', certs: [owner.cert] } }, 1000);
  const ops: Op[] = [genesis];
  const heads = () => replay(teamKey.pub, ops).heads;
  const by = <K extends Op['kind']>(who: P, kind: K, body: Op<K>['body'], time = 2000, parents = heads()) => {
    const op = makeOp(teamKey.pub, parents, who.device, who.pub, kind, body, time);
    ops.push(op);
    return op;
  };
  const add = (who: P, role: Role, by_ = owner) => by(by_, 'add', { person: who.pub, name: who.name, role, certs: [who.cert] });
  return { id: teamKey.pub, owner, ops, by, add, heads, state: () => replay(teamKey.pub, ops) };
}
const FILE = 'abcdefghij';
type Dev = Parameters<typeof editBy>[0];
/** A change written by a member's device (N6: with an id derived from its key); `key` is optional. */
const editOf = (doc: Y.Doc, root: string, a: string | Dev, b?: Dev) => (typeof a === 'string' ? editBy(b!, doc, root, a) : editBy(a, doc, root));

describe('C1: garbage in the membership log', () => {
  it('drops a 20,000-op chain by a stranger in well under a second, and keeps nothing of it', () => {
    const t = team();
    t.add(person('Viewer'), 'view');
    const stranger = person('Nobody');
    const ops = [...t.ops];
    let parents = t.heads();
    for (let i = 0; i < 20_000; i++) {
      const op = makeOp(t.id, parents, stranger.device, stranger.pub, 'rename', { name: 'x' }, 5000 + i);
      ops.push(op);
      parents = [op.id];
    }
    const m0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const r = replay(t.id, ops);
    const ms = performance.now() - t0;
    const mb = (process.memoryUsage().heapUsed - m0) / 1e6;
    console.log(`C1 replay of a 20,000-op garbage chain: ${Math.round(ms)} ms, ${Math.round(mb)} MB`);
    expect(r.keep.size).toBe(t.ops.length);
    expect(ms).toBeLessThan(1500);
    expect(mb).toBeLessThan(300);
  });

  it('caps what one member can put in the log, even with ops that are each allowed', () => {
    const t = team();
    const v = person('Viewer');
    t.add(v, 'view');
    const extra = newDeviceKeys();
    const cert = certify(v.key, { ed: extra.ed.pub, x: extra.x.pub, name: 'phone' });
    let parents = t.heads();
    for (let i = 0; i < MAX_PERSON_OPS + 50; i++) {
      const kind = i % 2 === 0 ? 'device-add' : 'device-revoke';
      const body = i % 2 === 0 ? { cert } : { person: v.pub, device: extra.ed.pub };
      const op = makeOp(t.id, parents, v.device, v.pub, kind as 'device-add', body as never, 3000 + i);
      t.ops.push(op);
      parents = [op.id];
    }
    const r = replay(t.id, t.ops);
    expect([...r.valid].filter((id) => t.ops.find((o) => o.id === id)!.person === v.pub).length).toBe(MAX_PERSON_OPS);
  });

  it('a device whose stored log was poisoned prunes it on start and answers quickly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bogen-teams-sec-'));
    try {
      const t = team();
      const stranger = person('Nobody');
      const ops = [...t.ops];
      let parents = t.heads();
      for (let i = 0; i < 20_000; i++) {
        const op = makeOp(t.id, parents, stranger.device, stranger.pub, 'rename', { name: 'x' }, 5000 + i);
        ops.push(op);
        parents = [op.id];
      }
      const dir = join(home, 'teams', fingerprint(t.id));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'log.json'), JSON.stringify({ team: t.id, ops }));
      const svc = new TeamService({ home, deviceName: () => 'x', doc: async () => new Y.Doc(), ensureFile: () => {}, fileExists: () => false, fileName: () => undefined });
      const t0 = performance.now();
      await svc.start();
      console.log(`C1 start with a poisoned 20,000-op log: ${Math.round(performance.now() - t0)} ms`);
      await svc.stop();
      const after = JSON.parse(await readFile(join(dir, 'log.json'), 'utf8')) as { ops: Op[] };
      expect(after.ops).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('H1: a downgrade holds like a removal', () => {
  it('refuses an edit naming heads from before a demotion to viewer, once the grace window is over', () => {
    const t = team();
    const m = person('Mallory');
    t.add(m, 'edit');
    t.by(t.owner, 'file-add', { file: FILE, name: 'f' });
    const before = t.heads();
    const demotedAt = 1_000_000;
    t.by(t.owner, 'role', { person: m.pub, role: 'view' }, demotedAt);
    const r = t.state();
    const doc = new Y.Doc();
    doc.getMap('nodes');
    const env = sealAs(m.device, m.pub, t.id, FILE, 1, before, editOf(doc, 'nodes', m.device), demotedAt - 1);
    expect(checkEnvelope(env, r, doc, demotedAt + 365 * 86_400_000).ok).toBe(false);
    // Within the window, an edit made before the demotion still lands, like a removed member's.
    expect(checkEnvelope(env, r, doc, demotedAt + 60_000).ok).toBe(true);
    // Made after seeing the demotion: today's role.
    const after = sealAs(m.device, m.pub, t.id, FILE, 2, r.heads, editOf(doc, 'nodes', m.device));
    expect(checkEnvelope(after, r, doc, demotedAt + 60_000).ok).toBe(false);
  });

  it('leaves out what a person did with a role concurrently taken away', () => {
    const t = team();
    const a = person('Admin'), friend = person('Friend');
    t.add(a, 'admin');
    const heads = t.heads();
    const demote = makeOp(t.id, heads, t.owner.device, t.owner.pub, 'role', { person: a.pub, role: 'edit' }, 3000);
    const sneaky = makeOp(t.id, heads, a.device, a.pub, 'add', { person: friend.pub, name: 'F', role: 'edit', certs: [friend.cert] }, 3000);
    expect(replay(t.id, [...t.ops, demote, sneaky]).state.members.has(friend.pub)).toBe(false);
    expect(replay(t.id, [...t.ops, sneaky, demote]).state.members.has(friend.pub)).toBe(false);
  });
});

describe('H2: a comment-only member deleting ahead', () => {
  it('refuses a delete set for clocks an editor has not used yet, and the editor\'s later work survives', () => {
    const t = team();
    const c = person('Commenter'), e = person('Editor');
    t.add(c, 'comment');
    t.add(e, 'edit');
    t.by(t.owner, 'file-add', { file: FILE, name: 'f' });
    const r = t.state();
    const recv = new Y.Doc();
    recv.getMap('nodes');
    recv.getMap('comments');
    const editor = new Y.Doc();
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(recv));
    editor.getMap('nodes').set('seed', 'v');
    const first = Y.encodeStateAsUpdate(editor, Y.encodeStateVector(recv));
    Y.applyUpdate(recv, first);
    const owners = new Map<number, string>([[editor.clientID, e.pub]]);
    const clock = Y.getState(editor.store, editor.clientID);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint(enc, editor.clientID);
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint(enc, clock);
    encoding.writeVarUint(enc, 100_000);
    const crafted = encoding.toUint8Array(enc);
    const env = sealAs(c.device, c.pub, t.id, FILE, 1, r.heads, crafted);
    const verdict = checkEnvelope(env, r, recv, Date.now(), { clientOwner: owners });
    expect(verdict.ok).toBe(false);
    editor.getMap('nodes').set('layer1', 'new work');
    Y.applyUpdate(recv, Y.encodeStateAsUpdate(editor, Y.encodeStateVector(recv)));
    expect(recv.getMap('nodes').get('layer1')).toBe('new work');
  });

  it('refuses a comment-only member deleting someone else\'s comment (L6), and accepts their own', () => {
    const t = team();
    const c = person('Commenter'), e = person('Editor');
    t.add(c, 'comment');
    t.add(e, 'edit');
    t.by(t.owner, 'file-add', { file: FILE, name: 'f' });
    const r = t.state();
    const doc = new Y.Doc();
    doc.getMap('comments').set('theirs', 'from the editor');
    const owners = new Map<number, string>([[doc.clientID, e.pub]]);
    const mine = new Y.Doc();
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(doc));
    const sv = Y.encodeStateVector(mine);
    mine.getMap('comments').delete('theirs');
    const del = Y.encodeStateAsUpdate(mine, sv);
    expect(checkEnvelope(sealAs(c.device, c.pub, t.id, FILE, 1, r.heads, del), r, doc, Date.now(), { clientOwner: owners })).toMatchObject({ ok: false, reason: expect.stringMatching(/someone else/) });
    // Their own new comment, and then deleting it again, is fine (updates as the room sends them: one transaction each).
    const { doc: honest, nonce } = writerDoc(c.device);
    Y.applyUpdate(honest, Y.encodeStateAsUpdate(doc));
    const sent: Uint8Array[] = [];
    honest.on('update', (u: Uint8Array) => sent.push(u));
    honest.getMap('comments').set('own', 'mine');
    honest.getMap('comments').delete('own');
    mark(sent[0]!, [nonce]);
    mark(sent[1]!, [nonce]);
    const add = checkEnvelope(sealAs(c.device, c.pub, t.id, FILE, 2, r.heads, sent[0]!), r, doc, Date.now(), { clientOwner: owners });
    expect(add.ok).toBe(true);
    const ownClients = new Map(owners);
    for (const cl of (add as { clients: number[] }).clients) ownClients.set(cl, c.pub);
    const after = new Y.Doc();
    Y.applyUpdate(after, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(after, sent[0]!);
    expect(checkEnvelope(sealAs(c.device, c.pub, t.id, FILE, 3, r.heads, sent[1]!), r, after, Date.now(), { clientOwner: ownClients }).ok).toBe(true);
  });

  it('refuses anyone writing with another member\'s Yjs client id', () => {
    const t = team();
    const e = person('Editor'), m = person('Mallory');
    t.add(e, 'edit');
    t.add(m, 'edit');
    t.by(t.owner, 'file-add', { file: FILE, name: 'f' });
    const r = t.state();
    const doc = new Y.Doc();
    // Written with the editor's id (and naming the editor's nonce): under Mallory's key it derives to another id.
    const update = editOf(doc, 'nodes', e.device);
    const env = sealAs(m.device, m.pub, t.id, FILE, 1, r.heads, update);
    expect(checkEnvelope(env, r, doc, Date.now())).toMatchObject({ ok: false, reason: expect.stringMatching(/not its author/) });
  });
});

describe('M1: admins and owners', () => {
  it('an admin cannot revoke an owner\'s devices or add another admin directly', () => {
    const t = team();
    const a = person('Admin');
    t.add(a, 'admin');
    const dev2 = newDeviceKeys();
    t.by(t.owner, 'device-add', { cert: certify(t.owner.key, { ed: dev2.ed.pub, x: dev2.x.pub, name: 'owner phone' }) });
    t.by(a, 'device-revoke', { person: t.owner.pub, device: dev2.ed.pub });
    expect(t.state().state.members.get(t.owner.pub)!.devices.size).toBe(2);
    const puppet = person('Puppet');
    t.add(puppet, 'admin', a);
    expect(t.state().state.members.has(puppet.pub)).toBe(false);
  });
});

describe('M3: the grace window decides the same on every peer', () => {
  it('a member who took an edit within the window vouches for it; a late peer follows the vouch', () => {
    const t = team();
    const m = person('Member'), b = person('Bea');
    t.add(m, 'edit');
    t.add(b, 'edit');
    t.by(t.owner, 'file-add', { file: FILE, name: 'f' });
    const before = t.heads();
    const removedAt = 1_000_000;
    t.by(t.owner, 'remove', { person: m.pub, now: false }, removedAt);
    const r = t.state();
    const doc = new Y.Doc();
    const env = sealAs(m.device, m.pub, t.id, FILE, 1, before, editOf(doc, 'nodes', m.device), removedAt - 5);
    const late = removedAt + GRACE_MS + 86_400_000;
    expect(checkEnvelope(env, r, doc, late).ok).toBe(false);
    const vouched = vouchFor(b.device, env, removedAt + 60_000);
    expect(checkEnvelope(vouched, r, doc, late).ok).toBe(true);
    // A vouch by someone who is not a member with edit, or a forged one, counts for nothing.
    const stranger = person('Stranger');
    expect(checkEnvelope(vouchFor(stranger.device, env, removedAt + 60_000), r, doc, late).ok).toBe(false);
    expect(checkEnvelope({ ...vouched, vouch: { ...vouched.vouch!, at: removedAt + 1 } }, r, doc, late).ok).toBe(false);
  });
});

describe('L3, L4, L7: odd values in the log', () => {
  it('ignores a certificate with an oversized device name, and survives a non-finite number', () => {
    const t = team();
    const big = person('Big');
    const cert = certify(big.key, { ed: big.device.ed.pub, x: big.device.x.pub, name: 'x'.repeat(1_000_000) });
    expect(certValid(cert)).toBe(false);
    t.by(t.owner, 'add', { person: big.pub, name: 'Big', role: 'edit', certs: [cert] });
    expect(t.state().state.members.has(big.pub)).toBe(false);
    const bad = JSON.parse(JSON.stringify(t.ops[0]).replace(/"time":1000/, '"time":1e400')) as Op;
    expect(() => replay(t.id, [...t.ops, bad])).not.toThrow();
    const env = { ...sealAs(big.device, big.pub, t.id, FILE, 1, [], new Uint8Array([0, 0])), time: Number.POSITIVE_INFINITY };
    expect(() => checkEnvelope(env, t.state(), new Y.Doc())).not.toThrow();
  });

  it('a device belongs to one person only', () => {
    const t = team();
    const a = person('A');
    t.add(a, 'edit');
    const thief = newEd();
    const stolen = certify(thief, a.cert.device);
    t.by(t.owner, 'add', { person: thief.pub, name: 'Thief', role: 'edit', certs: [stolen] });
    expect(t.state().state.members.has(thief.pub)).toBe(false);
  });

  it('a signature made for one context does not count in another', () => {
    const t = team();
    const op = t.ops[0]!;
    // An envelope signature over the same bytes as an op would be is not an op signature, and so on: the tags differ.
    const asEnvelope = sealAs(t.owner.device, t.owner.pub, t.id, FILE, 1, [], new Uint8Array([0, 0]));
    expect(replay(t.id, [{ ...op, sig: asEnvelope.sig }]).valid.size).toBe(0);
  });
});

describe('L1: TLS between devices', () => {
  it('makes a certificate TLS accepts, every time', async () => {
    const { deviceCertificate } = await import('../src/teams/tls.ts');
    const { createSecureContext } = await import('node:tls');
    for (let i = 0; i < 300; i++) expect(() => createSecureContext(deviceCertificate(newEd()))).not.toThrow();
  });
});

describe('L2: where a team device may be reached', () => {
  it('only https to an IP address or a ts.net name', () => {
    expect(teamUrlOk('https://192.168.1.5:29998')).toBe(true);
    expect(teamUrlOk('https://[fd7a:115c:a1e0::1]:29998')).toBe(true);
    expect(teamUrlOk('https://desk.tail0a1b2c.ts.net:29998')).toBe(true);
    expect(teamUrlOk('http://192.168.1.5:29998')).toBe(false);
    expect(teamUrlOk('https://metadata.google.internal:80')).toBe(false);
    expect(teamUrlOk('https://example.com:443')).toBe(false);
    expect(teamUrlOk('https://192.168.1.5')).toBe(false);
  });
});

// ---- Between devices ----------------------------------------------------------------------------------------

const made: { svc: TeamService; home: string }[] = [];
let port = 32_400 + Math.floor(Math.random() * 400);
async function device(name: string, opts: { files?: Map<string, string> } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'bogen-teams-sec-'));
  const docs = new Map<string, Y.Doc>();
  const names = opts.files ?? new Map<string, string>();
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
  });
  await svc.start();
  made.push({ svc, home });
  await svc.setTransports({ lan: { on: true, address: '127.0.0.1' }, tailscale: { on: false }, vpn: { on: false, address: '' }, port: port++ });
  return { svc, docs, names, home };
}
afterEach(async () => {
  for (const { svc, home } of made.splice(0)) {
    await svc.stop();
    await rm(home, { recursive: true, force: true });
  }
});
async function owned(name: string) {
  const d = await device(name);
  const { team, phrase } = await d.svc.create('Studio', name);
  await d.svc.confirmPhrase(Object.fromEntries(phrase!.map((w, i) => [String(i), w])));
  return { ...d, team };
}

describe('between devices', () => {
  it('H3: a team file never merges into a private file that has the same id', async () => {
    const anna = await owned('Anna');
    const doc = await anna.svc['deps'].doc('menuboards');
    anna.names.set('menuboards', 'Menu boards');
    doc.getMap('nodes').set('title', 'Team title');
    await anna.svc.addFile(anna.team, 'menuboards');
    // Jonas has a private file under the same id before joining.
    const jonas = await device('Jonas', { files: new Map([['menuboards', 'My private file']]) });
    const priv = await jonas.svc['deps'].doc('menuboards');
    priv.getMap('nodes').set('secret', 'mine only');
    await jonas.svc.join((await anna.svc.invite(anna.team, 'edit')).link, 'Jonas');
    await jonas.svc.syncAll();
    expect(priv.getMap('nodes').get('title')).toBeUndefined();
    expect(jonas.svc.teamOf('menuboards')).toBeNull();
    // And edits to the private file are not signed into the team.
    priv.getMap('nodes').set('more', 'still mine');
    await jonas.svc.syncAll();
    await anna.svc.syncAll();
    expect(doc.getMap('nodes').get('secret')).toBeUndefined();
    expect(doc.getMap('nodes').get('more')).toBeUndefined();
  }, 30_000);

  it('M2: joins are rate limited per address', async () => {
    const anna = await owned('Anna');
    const { deviceCertificate, tlsPost } = await import('../src/teams/tls.ts');
    const key = newEd();
    const tls = deviceCertificate(key);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await tlsPost(anna.svc.urls[0]!, tls, anna.svc.view().me.device, '/team/v2/join', () => JSON.stringify({ team: anna.team }))).status);
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  }, 30_000);

  it('M4: two different changes under one number are refused and the device is shut out', async () => {
    const anna = await owned('Anna');
    const doc = await anna.svc['deps'].doc('menuboards');
    anna.names.set('menuboards', 'Menu boards');
    doc.getMap('nodes').set('t', 'x');
    await anna.svc.addFile(anna.team, 'menuboards');
    const t = anna.svc['teams'].get(anna.team)!;
    const m = person('Mallory');
    await anna.svc['append'](t, 'add', { person: m.pub, name: 'Mallory', role: 'edit', certs: [m.cert] });
    const heads = t.replay.heads;
    const a = sealAs(m.device, m.pub, t.id, 'menuboards', 1, heads, editOf(doc, 'nodes', 'a', m.device));
    const b = sealAs(m.device, m.pub, t.id, 'menuboards', 1, heads, editOf(doc, 'nodes', 'b', m.device));
    expect((await anna.svc.takeEnvelopes(t, [a])).applied).toBe(1);
    const second = await anna.svc.takeEnvelopes(t, [b]);
    expect(second.applied).toBe(0);
    expect(second.refused[0]!.reason).toMatch(/two different changes/);
    const c = sealAs(m.device, m.pub, t.id, 'menuboards', 2, heads, editOf(doc, 'nodes', 'c', m.device));
    expect((await anna.svc.takeEnvelopes(t, [c])).applied).toBe(0);
    expect(envelopeId(a)).not.toBe(envelopeId(b));
  }, 30_000);

  it('M4: an envelope that had to wait is asked for again after a later one landed', async () => {
    const anna = await owned('Anna');
    const t = anna.svc['teams'].get(anna.team)!;
    t.envelopes.set('menuboards', [{ author: 'A', seq: 1 }, { author: 'A', seq: 3 }] as never);
    expect(anna.svc['vectors'](t).menuboards).toEqual({ A: [[1, 1], [3, 3]] });
  }, 30_000);

  it('M5: changes that came from another of your devices are not signed again as this device\'s', async () => {
    const anna = await owned('Anna');
    const doc = await anna.svc['deps'].doc('menuboards');
    anna.names.set('menuboards', 'Menu boards');
    await anna.svc.addFile(anna.team, 'menuboards');
    const t = anna.svc['teams'].get(anna.team)!;
    const before = t.envelopes.get('menuboards')!.length;
    const other = new Y.Doc();
    other.getMap('nodes').set('x', 'from a paired device');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), 'peer:laptop');
    await anna.svc.flushOutbox();
    expect(t.envelopes.get('menuboards')!.length).toBe(before);
  }, 30_000);

  it('M6: a failed join keeps the recovery phrase, shown again until confirmed', async () => {
    const jonas = await device('Jonas');
    const anna = await owned('Anna');
    const { link } = await anna.svc.invite(anna.team, 'edit');
    await anna.svc.stop();
    await expect(jonas.svc.join(link, 'Jonas')).rejects.toThrow();
    const words = jonas.svc.pendingPhrase();
    expect(words).toHaveLength(12);
    await jonas.svc.confirmPhrase(Object.fromEntries(words!.map((w, i) => [String(i), w])));
    expect(jonas.svc.pendingPhrase()).toBeNull();
  }, 30_000);

  it('L5: listening on every interface needs the person\'s confirmation', async () => {
    const anna = await owned('Anna');
    const base = { tailscale: { on: false }, vpn: { on: false, address: '' }, port: port++ };
    await expect(anna.svc.setTransports({ ...base, lan: { on: true, address: '0.0.0.0' } })).rejects.toThrow(/every network/);
    await expect(anna.svc.setTransports({ ...base, lan: { on: true, address: '::' } })).rejects.toThrow(/every network/);
  }, 30_000);

  it('L6: only admins put files in the team', () => {
    const t = team();
    const e = person('Editor');
    t.add(e, 'edit');
    t.by(e, 'file-add', { file: FILE, name: 'f' });
    expect(t.state().state.files.has(FILE)).toBe(false);
  });
});
