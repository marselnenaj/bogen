import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Y } from '@bogen/core';
import { newDeviceKeys, newEd } from '../src/teams/crypto.ts';
import { TeamService } from '../src/teams/service.ts';
import { TeamStore } from '../src/teams/store.ts';
import { editBy, freePort, mark, sealAs, writerDoc } from './teams-writers.ts';

/**
 * Regression tests for the second security review of feat/teams-1 (2026-11-16, findings N1 to N12). Each test is
 * the reviewer's proof of concept turned around and fails on the code before its fix.
 */

process.env.BOGEN_TEAMS_KEYRING = 'off';
const SEALED = { iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA', tag: 'AAAAAAAAAAAAAAAAAAAAAA' };
const homes: string[] = [];
const services: TeamService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});
async function lockedHome() {
  const home = await mkdtemp(join(tmpdir(), 'bogen-review2-'));
  homes.push(home);
  await mkdir(join(home, 'teams'), { recursive: true });
  await writeFile(join(home, 'teams', 'identity.json'), JSON.stringify({ device: newDeviceKeys(), deviceName: 'L', personPub: newEd().pub, personName: 'Anna', phraseConfirmed: true, sealed: SEALED }));
  return home;
}
const sealedOnDisk = async (home: string) => JSON.parse(await readFile(join(home, 'teams', 'identity.json'), 'utf8')).sealed;
const bare = (home: string) => new TeamService({ home, deviceName: () => 'L', doc: async () => new Y.Doc(), ensureFile: () => {}, fileExists: () => false, fileName: () => undefined });

describe('N1: a person key the keyring cannot open right now', () => {
  it('stays sealed in identity.json through start, saves and settings changes', async () => {
    const home = await lockedHome();
    const svc = bare(home);
    services.push(svc);
    await svc.start();
    expect(svc.view().me.keyStorage).toBe('locked');
    expect(await sealedOnDisk(home)).toEqual(SEALED);
    await svc.setTransports({ lan: { on: false, address: '' }, tailscale: { on: false }, vpn: { on: false, address: '' }, port: 29998 });
    expect(await sealedOnDisk(home)).toEqual(SEALED);
    const store = new TeamStore(home);
    const id = await store.identity('L');
    await store.saveIdentity(id);
    expect(await sealedOnDisk(home)).toEqual(SEALED);
  });

  it('refuses to make or join a team while locked, instead of writing a new person over the sealed one', async () => {
    const home = await lockedHome();
    const svc = bare(home);
    services.push(svc);
    await svc.start();
    await expect(svc.create('Studio', 'Anna')).rejects.toThrow(/locked/);
    await expect(svc.join('bogen://join/x#y.z', 'Anna')).rejects.toThrow(/locked/);
    expect(await sealedOnDisk(home)).toEqual(SEALED);
  });
});

// ---- A team with one owner device and a second member (Bea) who is not running -----------------------------

async function withBea() {
  const home = await mkdtemp(join(tmpdir(), 'bogen-review2-'));
  homes.push(home);
  const docs = new Map<string, Y.Doc>();
  const names = new Map<string, string>();
  const svc: TeamService = new TeamService({
    home, deviceName: () => 'A',
    doc: async (f) => { let d = docs.get(f); if (!d) { d = new Y.Doc(); d.on('update', (u: Uint8Array, o: unknown) => svc.onRoomUpdate(f, u, o)); docs.set(f, d); } return d; },
    ensureFile: (f, n) => { names.set(f, n); }, fileExists: (f) => names.has(f), fileName: (f) => names.get(f),
  });
  services.push(svc);
  await svc.start();
  const { team, phrase } = await svc.create('Studio', 'Anna');
  await svc.confirmPhrase(Object.fromEntries(phrase!.map((w, i) => [String(i), w])));
  const doc = await (svc as unknown as { deps: { doc(f: string): Promise<Y.Doc> } }).deps.doc('menuboards');
  names.set('menuboards', 'Menu');
  doc.getMap('nodes').set('t', 'x');
  await svc.addFile(team, 'menuboards');
  const s = svc as unknown as { teams: Map<string, any>; append(t: any, k: string, b: unknown): Promise<unknown>; takeEnvelopes(t: any, l: unknown): Promise<{ applied: number; refused: { reason: string }[] }>; vectors(t: any): Record<string, Record<string, unknown>> };
  const t = s.teams.get(team);
  const bea = { key: newEd(), device: newDeviceKeys() };
  const { certify } = await import('../src/teams/log.ts');
  await s.append(t, 'add', { person: bea.key.pub, name: 'Bea', role: 'edit', certs: [certify(bea.key, { ed: bea.device.ed.pub, x: bea.device.x.pub, name: 'Bea laptop' })] });
  const edit = (k: string, device: Parameters<typeof editBy>[0]) => editBy(device, doc, 'nodes', k, 1);
  return { svc, s, t, team, bea, edit, home };
}

describe('N2 and N3: envelopes not signed by their author', () => {
  it('a forged envelope under a member\'s number does not make that member an equivocator', async () => {
    const { s, t, team, bea, edit } = await withBea();
    const { sealUpdate } = await import('../src/teams/envelope.ts');
    expect((await s.takeEnvelopes(t, [sealAs(bea.device, bea.key.pub, team, 'menuboards', 1, t.replay.heads, edit('a', bea.device))])).applied).toBe(1);
    const forged = { ...sealAs(bea.device, bea.key.pub, team, 'menuboards', 1, t.replay.heads, edit('b', bea.device)), sig: 'A'.repeat(86) };
    await s.takeEnvelopes(t, [forged]);
    expect(t.equivocators.has(bea.device.ed.pub)).toBe(false);
    expect((await s.takeEnvelopes(t, [sealAs(bea.device, bea.key.pub, team, 'menuboards', 2, t.replay.heads, edit('c', bea.device))])).applied).toBe(1);
  });

  it('two different envelopes both signed by the author under one number shut it out, and both are kept as proof', async () => {
    const { s, t, team, bea, edit, home } = await withBea();
    const { sealUpdate } = await import('../src/teams/envelope.ts');
    await s.takeEnvelopes(t, [sealAs(bea.device, bea.key.pub, team, 'menuboards', 1, t.replay.heads, edit('a', bea.device))]);
    await s.takeEnvelopes(t, [sealAs(bea.device, bea.key.pub, team, 'menuboards', 1, t.replay.heads, edit('b', bea.device))]);
    expect(t.equivocators.has(bea.device.ed.pub)).toBe(true);
    const { fingerprint } = await import('../src/teams/crypto.ts');
    const proof = (await readFile(join(home, 'teams', fingerprint(team), 'equivocation.jsonl'), 'utf8')).trim().split('\n');
    expect(JSON.parse(proof[0]!).envelopes).toHaveLength(2);
  });

  it('an equivocator stays shut out: its later envelopes are refused for good, not asked for again', async () => {
    const { s, t, team, bea, edit } = await withBea();
    await s.takeEnvelopes(t, [sealAs(bea.device, bea.key.pub, team, 'menuboards', 1, t.replay.heads, edit('a', bea.device))]);
    await s.takeEnvelopes(t, [sealAs(bea.device, bea.key.pub, team, 'menuboards', 1, t.replay.heads, edit('b', bea.device))]);
    expect(t.equivocators.has(bea.device.ed.pub)).toBe(true);
    const later = sealAs(bea.device, bea.key.pub, team, 'menuboards', 2, t.replay.heads, edit('c', bea.device));
    const first = await s.takeEnvelopes(t, [later]);
    expect(first.applied).toBe(0);
    // Final: the slot counts as held, so no peer resends it, and the same envelope again changes nothing.
    expect(JSON.stringify(s.vectors(t).menuboards)).toContain(bea.device.ed.pub);
    expect((await s.takeEnvelopes(t, [later])).applied).toBe(0);
    expect(t.refused.get('menuboards')?.has(`${bea.device.ed.pub}:2`)).toBe(true);
  });

  it('a forged envelope does not take a slot: the genuine one with that number still lands', async () => {
    const { s, t, team, bea, edit } = await withBea();
    const { sealUpdate } = await import('../src/teams/envelope.ts');
    const forged3 = { ...sealAs(bea.device, bea.key.pub, team, 'menuboards', 1, t.replay.heads, edit('d', bea.device)), sig: 'A'.repeat(86) };
    await s.takeEnvelopes(t, [forged3]);
    const real = await s.takeEnvelopes(t, [sealAs(bea.device, bea.key.pub, team, 'menuboards', 1, t.replay.heads, edit('e', bea.device))]);
    expect(real.applied).toBe(1);
  });

  it('junk authors leave nothing behind in memory', async () => {
    const { s, t, team } = await withBea();
    const junk = Array.from({ length: 50 }, (_, i) => ({ v: 1, team, file: 'menuboards', author: `not-a-key-${i}-${'x'.repeat(2000)}`, person: 'p', seq: i + 1, heads: [], update: 'AA', time: 1, sig: 'A'.repeat(86) }));
    await s.takeEnvelopes(t, junk);
    // And a stranger's own, validly signed envelopes are not remembered either.
    const { sealUpdate } = await import('../src/teams/envelope.ts');
    const stranger = newDeviceKeys();
    await s.takeEnvelopes(t, Array.from({ length: 20 }, (_, i) => sealAs(stranger, newEd().pub, team, 'menuboards', i + 1, t.replay.heads, new Uint8Array([0, 0]))));
    expect(t.refused.get('menuboards')?.size ?? 0).toBe(0);
  });
});

describe('N4: connections that hold the listener', () => {
  it('64 idle TLS connections without a device certificate do not keep a member out', async () => {
    const { connect } = await import('node:tls');
    const { tlsPost, deviceCertificate } = await import('../src/teams/tls.ts');
    const home = await mkdtemp(join(tmpdir(), 'bogen-review2-'));
    homes.push(home);
    const svc = bare(home);
    services.push(svc);
    await svc.start();
    const port = 35_000 + Math.floor(Math.random() * 400);
    await svc.setTransports({ lan: { on: true, address: '127.0.0.1' }, tailscale: { on: false }, vpn: { on: false, address: '' }, port });
    const { team } = await svc.create('Studio', 'A');
    const idle = Array.from({ length: 64 }, () => connect({ host: '127.0.0.1', port, rejectUnauthorized: false, minVersion: 'TLSv1.3' }).on('error', () => {}));
    await new Promise((r) => setTimeout(r, 800));
    const probe = await tlsPost(svc.urls[0]!, deviceCertificate(newEd()), svc.view().me.device, '/team/v2/join', () => JSON.stringify({ team }), { timeoutMs: 3000 }).then((r) => r.status, (e: Error) => e.message);
    expect(typeof probe).toBe('number');
    for (const s of idle) s.destroy();
  }, 20_000);

  it('one address can hold at most a few connections, others still get in', async () => {
    const { connect } = await import('node:tls');
    const { tlsPost, deviceCertificate } = await import('../src/teams/tls.ts');
    const home = await mkdtemp(join(tmpdir(), 'bogen-review2-'));
    homes.push(home);
    const svc = bare(home);
    services.push(svc);
    await svc.start();
    // A port nobody holds, so the test never meets another test's listener.
    const port = await freePort();
    await svc.setTransports({ lan: { on: true, address: '127.0.0.1' }, tailscale: { on: false }, vpn: { on: false, address: '' }, port });
    const { team } = await svc.create('Studio', 'A');
    const cert = deviceCertificate(newEd());
    // Certified but idle connections from 127.0.0.2: only the first few stay open. Waits until the server has closed the
    // rest, rather than a fixed time a busy machine may not keep.
    const idle = Array.from({ length: 30 }, () => connect({ host: '127.0.0.1', port, localAddress: '127.0.0.2', key: cert.key, cert: cert.cert, rejectUnauthorized: false, minVersion: 'TLSv1.3' } as unknown as import('node:tls').ConnectionOptions).on('error', () => {}));
    for (let i = 0; i < 60 && idle.filter((s) => !s.destroyed).length > 8; i++) await new Promise((r) => setTimeout(r, 100));
    expect(idle.filter((s) => !s.destroyed).length).toBeLessThanOrEqual(8);
    const probe = await tlsPost(svc.urls[0]!, deviceCertificate(newEd()), svc.view().me.device, '/team/v2/join', () => JSON.stringify({ team }), { timeoutMs: 3000 }).then((r) => r.status, (e: Error) => e.message);
    expect(typeof probe).toBe('number');
    for (const s of idle) s.destroy();
  }, 20_000);
});

// ---- Pure log helpers --------------------------------------------------------------------------------------

async function pureTeam() {
  const { certify, makeOp, replay } = await import('../src/teams/log.ts');
  const person = (name: string) => {
    const key = newEd(); const device = newDeviceKeys();
    return { name, key, device, pub: key.pub, cert: certify(key, { ed: device.ed.pub, x: device.x.pub, name: `${name} laptop` }) };
  };
  const teamKey = newEd(); const owner = person('Anna');
  const ops: any[] = [makeOp(teamKey.pub, [], { ed: teamKey }, owner.pub, 'genesis', { name: 'Studio', owner: { person: owner.pub, name: 'Anna', certs: [owner.cert] } }, 1000)];
  const heads = () => replay(teamKey.pub, ops).heads;
  const by = (who: any, kind: any, body: any, time = 2000) => { const op = makeOp(teamKey.pub, heads(), who.device, who.pub, kind, body, time); ops.push(op); return op; };
  const add = (who: any, role: string, time = 2000) => by(owner, 'add', { person: who.pub, name: who.name, role, certs: [who.cert] }, time);
  return { id: teamKey.pub, owner, ops, by, add, heads, person, state: () => replay(teamKey.pub, ops) };
}
const FILE = 'abcdefghij';
const nodesEdit = (device: Parameters<typeof editBy>[0]) => editBy(device, new Y.Doc(), 'nodes', undefined, 1);

describe('N5: every lowering of a role holds, not only the last one', () => {
  it('a member demoted to viewer a year ago and removed today gets no edit rights back for the grace window', async () => {
    const { sealUpdate, checkEnvelope } = await import('../src/teams/envelope.ts');
    const t = await pureTeam(); const m = t.person('Mallory'); t.add(m, 'edit');
    t.by(t.owner, 'file-add', { file: FILE, name: 'f' }, 2100);
    const asEditor = t.heads();
    t.by(t.owner, 'role', { person: m.pub, role: 'view' }, 10_000);
    const removedAt = 10_000 + 400 * 86_400_000;
    t.by(t.owner, 'remove', { person: m.pub, now: false }, removedAt);
    const env = sealAs(m.device, m.pub, t.id, FILE, 1, asEditor, nodesEdit(m.device), removedAt + 1000);
    const v = checkEnvelope(env, t.state(), new Y.Doc(), removedAt + 3_600_000);
    expect(v.ok).toBe(false);
  });

  it('edit to comment long ago, comment to view today: the edit role does not come back', async () => {
    const { sealUpdate, checkEnvelope } = await import('../src/teams/envelope.ts');
    const t = await pureTeam(); const m = t.person('Mallory'); t.add(m, 'edit');
    t.by(t.owner, 'file-add', { file: FILE, name: 'f' }, 2100);
    const asEditor = t.heads();
    t.by(t.owner, 'role', { person: m.pub, role: 'comment' }, 10_000);
    const second = 10_000 + 400 * 86_400_000;
    t.by(t.owner, 'role', { person: m.pub, role: 'view' }, second);
    const env = sealAs(m.device, m.pub, t.id, FILE, 1, asEditor, nodesEdit(m.device), second + 1000);
    const v = checkEnvelope(env, t.state(), new Y.Doc(), second + 3_600_000);
    expect(v.ok).toBe(false);
  });

  it('a single recent lowering still forgives edits made before it, within the window', async () => {
    const { sealUpdate, checkEnvelope } = await import('../src/teams/envelope.ts');
    const t = await pureTeam(); const m = t.person('Mallory'); t.add(m, 'edit');
    t.by(t.owner, 'file-add', { file: FILE, name: 'f' }, 2100);
    const asEditor = t.heads();
    t.by(t.owner, 'role', { person: m.pub, role: 'view' }, 50_000);
    const env = sealAs(m.device, m.pub, t.id, FILE, 1, asEditor, nodesEdit(m.device), 40_000);
    const v = checkEnvelope(env, t.state(), new Y.Doc(), 60_000);
    expect(v.ok).toBe(true);
  });
});

describe('N7: vouching cannot reopen the grace window', () => {
  it('a vouch backdated to the removal does not let an edit made years later in', async () => {
    const { sealUpdate, checkEnvelope, vouchFor } = await import('../src/teams/envelope.ts');
    const t = await pureTeam(); const m = t.person('Member'), b = t.person('Bea'); t.add(m, 'edit'); t.add(b, 'edit');
    t.by(t.owner, 'file-add', { file: FILE, name: 'f' });
    const before = t.heads(); const removedAt = 1_000_000;
    t.by(t.owner, 'remove', { person: m.pub, now: false }, removedAt);
    const years = removedAt + 3 * 365 * 86_400_000;
    const env = sealAs(m.device, m.pub, t.id, FILE, 1, before, nodesEdit(m.device), years);
    expect(checkEnvelope(env, t.state(), new Y.Doc(), years).ok).toBe(false);
    // A vouch dated before the removal, or by someone who joined after it, counts for nothing.
    expect(checkEnvelope(vouchFor(b.device, env, removedAt - 1), t.state(), new Y.Doc(), years).ok).toBe(false);
    const late = t.person('Late'); t.add(late, 'edit', removedAt + 10);
    expect(checkEnvelope(vouchFor(late.device, env, removedAt + 5), t.state(), new Y.Doc(), years).ok).toBe(false);
    // A member who was there at the removal and vouches inside the window: accepted (they could edit anyway).
    expect(checkEnvelope(vouchFor(b.device, env, removedAt + 5), t.state(), new Y.Doc(), years).ok).toBe(true);
  });

  it('an envelope first seen with a bogus vouch is looked at again when a genuine vouch arrives', async () => {
    const { s, t, team, bea, edit } = await withBea();
    const { sealUpdate, vouchFor } = await import('../src/teams/envelope.ts');
    const heads = t.replay.heads;
    const env = sealAs(bea.device, bea.key.pub, team, 'menuboards', 1, heads, edit('x', bea.device), Date.now());
    const svcAny = s as unknown as { remove(team: string, person: string, now: boolean): Promise<void>; now(): number; identity: { device: any } };
    await (s as any).remove(team, bea.key.pub, false);
    // Make the removal 8 days old for this device's clock.
    const realNow = Date.now;
    const removal = t.replay.state.removed.get(bea.key.pub);
    const later = removal.time + 8 * 86_400_000;
    (s as any).deps.now = () => later;
    const bogus = { ...env, vouch: { by: newEd().pub, at: removal.time + 1, sig: 'A'.repeat(86) } };
    expect((await s.takeEnvelopes(t, [bogus])).applied).toBe(0);
    const genuine = vouchFor(svcAny.identity.device, env, removal.time + 1);
    // The owner device itself was a member at the removal and can edit: its own vouch counts.
    expect((await s.takeEnvelopes(t, [genuine])).applied).toBe(1);
    Date.now = realNow;
  });
});

describe('N8: the log caps cannot lock owners and admins out', () => {
  it('an owner can make more changes than the per-person cap, and viewers filling the log do not stop them', async () => {
    const { MAX_PERSON_OPS, MAX_LOG_OPS, certify, makeOp, replay } = await import('../src/teams/log.ts');
    const t = await pureTeam();
    const viewers = Array.from({ length: Math.ceil(MAX_LOG_OPS / MAX_PERSON_OPS) + 1 }, (_, i) => t.person(`V${i}`));
    for (const v of viewers) t.add(v, 'view', 2500);
    // One long chain, each op on the last: building it needs no replay per op.
    let last = t.heads();
    let time = 3000;
    const push = (who: any, kind: any, body: any) => { const op = makeOp(t.id, last, who.device, who.pub, kind, body, time++); t.ops.push(op); last = [op.id]; };
    for (let i = 0; i < MAX_PERSON_OPS + 20; i++) push(t.owner, 'rename', { name: `Studio ${i}` });
    for (const v of viewers) {
      for (let i = 0; i < MAX_PERSON_OPS / 2; i++) {
        const d = newDeviceKeys();
        push(v, 'device-add', { cert: certify(v.key, { ed: d.ed.pub, x: d.x.pub, name: 'phone' }) });
        push(v, 'device-revoke', { person: v.pub, device: d.ed.pub });
      }
    }
    push(t.owner, 'rename', { name: 'Still the owner' });
    const r = replay(t.id, t.ops);
    expect(r.state.name).toBe('Still the owner');
    // The viewers' share stops at the caps.
    const low = [...r.valid].filter((id) => viewers.some((v) => t.ops.find((o) => o.id === id)!.person === v.pub)).length;
    expect(low).toBeLessThanOrEqual(MAX_LOG_OPS + viewers.length);
  }, 120_000);
});

describe('N9: how much history one member can make a file keep', () => {
  it('a comment-only member cannot send a 22 MB update, and one device has a quota per file', async () => {
    const { sealUpdate, checkEnvelope, MAX_COMMENT_UPDATE } = await import('../src/teams/envelope.ts');
    const t = await pureTeam(); const c = t.person('Commenter'); t.add(c, 'comment');
    t.by(t.owner, 'file-add', { file: FILE, name: 'f' });
    const { doc: d, nonce } = writerDoc(c.device); d.getMap('comments').set('c1', 'x'.repeat(MAX_COMMENT_UPDATE + 10));
    const env = sealAs(c.device, c.pub, t.id, FILE, 1, t.heads(), mark(Y.encodeStateAsUpdate(d), [nonce]));
    const v = checkEnvelope(env, t.state(), new Y.Doc(), Date.now());
    expect(v.ok).toBe(false);
    expect(v.ok ? '' : v.reason).toMatch(/too large/);
  });

  it('an editor over its quota for one file is refused, and counted again after a restart', async () => {
    const { s, t, team, bea, edit, svc } = await withBea() as any;
    const { sealUpdate } = await import('../src/teams/envelope.ts');
    // Pretend Bea's history in this file is already at the quota.
    t.bytes.set(`menuboards|${bea.device.ed.pub}`, 256 * 1024 * 1024);
    const r = await s.takeEnvelopes(t, [sealAs(bea.device, bea.key.pub, team, 'menuboards', 1, t.replay.heads, edit('q', bea.device))]);
    expect(r.applied).toBe(0);
    expect(r.refused[0].reason).toMatch(/history may hold/);
    t.bytes.clear();
    // The refusal is final for that number (not offered again on every sync); the next one lands.
    expect((await s.takeEnvelopes(t, [sealAs(bea.device, bea.key.pub, team, 'menuboards', 2, t.replay.heads, edit('q', bea.device))])).applied).toBe(1);
    await svc.stop(); await svc.start();
    const again = (svc as any).teams.get(team);
    expect(again.bytes.get(`menuboards|${bea.device.ed.pub}`)).toBeGreaterThan(0);
  });
});

describe('N10: every spelling of all interfaces', () => {
  it('needs the confirmation whichever way it is written', async () => {
    const { isAnyAddress } = await import('../src/teams/service.ts');
    for (const a of ['0.0.0.0', '::', '::0', '0::', '0:0::', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0']) expect(isAnyAddress(a)).toBe(true);
    for (const a of ['127.0.0.1', '::1', '192.168.1.5', 'fd7a:115c:a1e0::1', 'not an address']) expect(isAnyAddress(a)).toBe(false);
    const home = await mkdtemp(join(tmpdir(), 'bogen-review2-'));
    homes.push(home);
    const svc = bare(home);
    services.push(svc);
    await svc.start();
    await expect(svc.setTransports({ lan: { on: false, address: '' }, tailscale: { on: false }, vpn: { on: true, address: '0::' }, port: 35_900 })).rejects.toThrow(/every network/);
  });
});

describe('N11: rate limits and remembered keys', () => {
  it('counts joins by an IPv6 /64, and many keys push out the oldest instead of wiping every budget', async () => {
    const { addressKey } = await import('../src/teams/service.ts');
    expect(addressKey('2001:db8:1:2:aaaa::1')).toBe(addressKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
    expect(addressKey('2001:db8:1:2::1')).not.toBe(addressKey('2001:db8:1:3::1'));
    expect(addressKey('::ffff:192.168.1.5')).toBe('192.168.1.5');
    const home = await mkdtemp(join(tmpdir(), 'bogen-review2-'));
    homes.push(home);
    const svc = bare(home) as any;
    services.push(svc);
    await svc.start();
    const limit = { count: 2, windowMs: 60_000 };
    expect(svc.budget('join|victim', limit)).toBe(true);
    expect(svc.budget('join|victim', limit)).toBe(true);
    expect(svc.budget('join|victim', limit)).toBe(false);
    // Twenty thousand other keys (an IPv6 sender rotating addresses): the old code wiped every budget at 10,000.
    // A key in use keeps its count; only the least recently used ones go.
    for (let i = 0; i < 20_000; i++) {
      svc.budget(`join|other-${i}`, limit);
      if (i % 500 === 0) expect(svc.budget('join|victim', limit)).toBe(false);
    }
    expect(svc.budget('join|victim', limit)).toBe(false);
    expect(svc.joins.size).toBeLessThanOrEqual(10_000);
  });

  it('a stranger TLS key is not remembered', async () => {
    const { tlsPost, deviceCertificate } = await import('../src/teams/tls.ts');
    const home = await mkdtemp(join(tmpdir(), 'bogen-review2-'));
    homes.push(home);
    const svc = bare(home) as any;
    services.push(svc);
    await svc.start();
    await svc.setTransports({ lan: { on: true, address: '127.0.0.1' }, tailscale: { on: false }, vpn: { on: false, address: '' }, port: 36_000 + Math.floor(Math.random() * 400) });
    const { team } = await svc.create('Studio', 'A');
    for (let i = 0; i < 5; i++) await tlsPost(svc.urls[0], deviceCertificate(newEd()), svc.view().me.device, '/team/v2/sync', () => JSON.stringify({ team }));
    expect(svc.tlsSeen.size).toBe(0);
  });
});

describe('N12: one number missing for good', () => {
  it('does not make a peer resend everything after it', async () => {
    const { s } = await withBea() as any;
    const svc = s as any;
    const t = { envelopes: new Map([['f', [{ author: 'A', seq: 1, update: 'x' }, { author: 'A', seq: 3, update: 'x' }, { author: 'A', seq: 4, update: 'x' }, { author: 'B', seq: 2, update: 'x' }]]]), refused: new Map(), late: new Set() };
    expect(svc.vectors(t).f).toEqual({ A: [[1, 1], [3, 4]], B: [[2, 2]] });
    // The peer holds A 1 and 3-4 (2 is gone for good): nothing of A is sent again; B 2 is.
    const sent = svc.missing(t, { f: { A: [[1, 1], [3, 4]] } });
    expect(sent.map((e: any) => `${e.author}${e.seq}`)).toEqual(['B2']);
    // Malformed ranges count for nothing; an old plain number still means 1 to n.
    expect(svc.missing(t, { f: { A: [['x', 2], [5, 1]], B: 2 } }).map((e: any) => `${e.author}${e.seq}`)).toEqual(['A1', 'A3', 'A4']);
  });
});

describe('TLS key memory and clocks', () => {
  it('a key from before a rotation stays refused after a restart', async () => {
    const { tlsPost, deviceCertificate } = await import('../src/teams/tls.ts');
    const home = await mkdtemp(join(tmpdir(), 'bogen-review2-'));
    homes.push(home);
    const svc = bare(home) as any;
    services.push(svc);
    await svc.start();
    const peer = newEd();
    svc.tlsSeen.set(peer.pub, Date.now());
    await svc.store.saveTlsSeen(Object.fromEntries(svc.tlsSeen));
    await svc.stop();
    await svc.start();
    expect(svc.tlsSeen.get(peer.pub)).toBeGreaterThan(0);
    expect(svc.freshTls({ device: peer.pub, tls: newEd().pub, issued: Date.now() - 86_400_000, expires: Date.now() + 86_400_000 })).toBe(false);
    void tlsPost; void deviceCertificate;
  });

  it('a device whose clock is far ahead is told so in words', async () => {
    const { tlsPost, deviceCertificate } = await import('../src/teams/tls.ts');
    const home = await mkdtemp(join(tmpdir(), 'bogen-review2-'));
    homes.push(home);
    const svc = bare(home) as any;
    services.push(svc);
    await svc.start();
    await svc.setTransports({ lan: { on: true, address: '127.0.0.1' }, tailscale: { on: false }, vpn: { on: false, address: '' }, port: 36_500 + Math.floor(Math.random() * 400) });
    const { team } = await svc.create('Studio', 'A');
    const ahead = deviceCertificate(newEd(), { now: Date.now() + 3_600_000 });
    const res = await tlsPost(svc.urls[0], ahead, svc.view().me.device, '/team/v2/join', () => JSON.stringify({ team }));
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/clock/);
  });
});
