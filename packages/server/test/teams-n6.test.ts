import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BogenDoc, Y } from '@bogen/core';
import { newDeviceKeys, newEd } from '../src/teams/crypto.ts';
import { checkEnvelope, clientIdOf, envelopeSlot, sealUpdate } from '../src/teams/envelope.ts';
import { certify, makeOp, replay, type Op, type Role } from '../src/teams/log.ts';
import { TeamService } from '../src/teams/service.ts';
import { assignWriter, setWriterProvider } from '../src/teams/writers.ts';
import { scratchCopy } from '../src/mcp/tools-batch.ts';
import type { Room } from '../src/sync.ts';
import { editBy, mark, sealAs, writerDoc } from './teams-writers.ts';

/**
 * N6 (third security review, 2026-11-16): whose a Yjs client id is must not depend on what a peer happened to
 * receive first. Ids are derived from the author's device key and a nonce the envelope names.
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
  const ops: Op[] = [makeOp(teamKey.pub, [], { ed: teamKey }, owner.pub, 'genesis', { name: 'Studio', owner: { person: owner.pub, name: 'Anna', certs: [owner.cert] } }, 1000)];
  const heads = () => replay(teamKey.pub, ops).heads;
  const by = <K extends Op['kind']>(who: P, kind: K, body: Op<K>['body'], time = 2000) => {
    const op = makeOp(teamKey.pub, heads(), who.device, who.pub, kind, body, time);
    ops.push(op);
    return op;
  };
  const add = (who: P, role: Role) => by(owner, 'add', { person: who.pub, name: who.name, role, certs: [who.cert] });
  return { id: teamKey.pub, owner, by, add, heads, state: () => replay(teamKey.pub, ops) };
}
const FILE = 'abcdefghij';

describe('client ids derived from the author', () => {
  it('derives a 53-bit id, the same everywhere, different per device and nonce', () => {
    const a = newDeviceKeys().ed.pub, b = newDeviceKeys().ed.pub;
    const id = clientIdOf(a, 'AAAAAAAAAAAAAAAAAAAAAA');
    expect(Number.isSafeInteger(id)).toBe(true);
    expect(id).toBeLessThan(2 ** 53);
    expect(clientIdOf(a, 'AAAAAAAAAAAAAAAAAAAAAA')).toBe(id);
    expect(clientIdOf(b, 'AAAAAAAAAAAAAAAAAAAAAA')).not.toBe(id);
    expect(clientIdOf(a, 'AAAAAAAAAAAAAAAAAAAAAB')).not.toBe(id);
  });

  it('the race: a comment-only member writing with an editor\'s id first is refused on every peer, in any order', () => {
    const t = team();
    const e = person('Editor'), c = person('Commenter');
    t.add(e, 'edit');
    t.add(c, 'comment');
    t.by(t.owner, 'file-add', { file: FILE, name: 'f' });
    const r = t.state();
    const base = new Y.Doc();
    base.getMap('comments');
    // The editor's work, written with an id derived from the editor's device.
    const { doc: ed, nonce } = writerDoc(e.device);
    Y.applyUpdate(ed, Y.encodeStateAsUpdate(base));
    ed.getMap('nodes').set('layer', 'work');
    const work = mark(Y.encodeStateAsUpdate(ed, Y.encodeStateVector(base)), [nonce]);
    const editorEnv = sealAs(e.device, e.pub, t.id, FILE, 1, r.heads, work);
    // The commenter saw the id (say, on the editor's screen) and writes a comment with it, naming the editor's
    // nonce or none: under the commenter's key neither derives to that id.
    const spoof = new Y.Doc();
    spoof.clientID = ed.clientID;
    Y.applyUpdate(spoof, Y.encodeStateAsUpdate(base));
    spoof.getMap('comments').set('c', 'hello');
    const forged = Y.encodeStateAsUpdate(spoof, Y.encodeStateVector(base));
    const withTheirNonce = sealUpdate(c.device, c.pub, t.id, FILE, 1, r.heads, forged, Date.now(), [nonce]);
    const withNone = sealUpdate(c.device, c.pub, t.id, FILE, 2, r.heads, forged, Date.now(), []);
    // Three peers, three arrival orders: every one refuses the commenter and takes the editor.
    for (const order of [[withTheirNonce, withNone, editorEnv], [editorEnv, withTheirNonce, withNone], [withNone, editorEnv, withTheirNonce]]) {
      const peer = new Y.Doc();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(base));
      const owners = new Map<number, string>();
      const verdicts = new Map<string, boolean>();
      for (const env of order) {
        const v = checkEnvelope(env, r, peer, Date.now(), { clientOwner: owners });
        verdicts.set(envelopeSlot(env), v.ok);
        if (v.ok) {
          Y.applyUpdate(peer, v.update);
          for (const cl of v.clients) if (!owners.has(cl)) owners.set(cl, env.person);
        }
      }
      expect(verdicts.get(envelopeSlot(editorEnv))).toBe(true);
      expect(verdicts.get(envelopeSlot(withTheirNonce))).toBe(false);
      expect(verdicts.get(envelopeSlot(withNone))).toBe(false);
      expect(peer.getMap('nodes').get('layer')).toBe('work');
      expect(peer.getMap('comments').has('c')).toBe(false);
    }
  });

  it('a forged session: a nonce that does not derive the id written with, or a malformed one, is refused', () => {
    const t = team();
    const e = person('Editor');
    t.add(e, 'edit');
    t.by(t.owner, 'file-add', { file: FILE, name: 'f' });
    const r = t.state();
    const doc = new Y.Doc();
    const real = editBy(e.device, doc, 'nodes');
    const { nonce: other } = writerDoc(e.device);
    const wrong = sealUpdate(e.device, e.pub, t.id, FILE, 1, r.heads, real, Date.now(), [other]);
    expect(checkEnvelope(wrong, r, doc)).toMatchObject({ ok: false, reason: expect.stringMatching(/not its author/) });
    const malformed = sealUpdate(e.device, e.pub, t.id, FILE, 2, r.heads, real, Date.now(), ['not a nonce']);
    expect(checkEnvelope(malformed, r, doc).ok).toBe(false);
    expect(checkEnvelope(sealAs(e.device, e.pub, t.id, FILE, 3, r.heads, real), r, doc).ok).toBe(true);
  });

  it('legacy ids: the history a file had when added belongs to its adder, up to those clocks, and to nobody after', () => {
    const t = team();
    const e = person('Editor');
    t.add(e, 'edit');
    const old = new Y.Doc();
    old.getMap('nodes').set('from-before', 1);
    const sv = [...Y.decodeStateVector(Y.encodeStateVector(old))] as [number, number][];
    t.by(t.owner, 'file-add', { file: FILE, name: 'f', legacy: sv });
    const r = t.state();
    const full = Y.encodeStateAsUpdate(old);
    // The adder's first envelope with the old history, naming no nonce: taken.
    expect(checkEnvelope(sealUpdate(t.owner.device, t.owner.pub, t.id, FILE, 1, r.heads, full, Date.now(), []), r, new Y.Doc()).ok).toBe(true);
    // The same history sent by another member: refused.
    expect(checkEnvelope(sealUpdate(e.device, e.pub, t.id, FILE, 1, r.heads, full, Date.now(), []), r, new Y.Doc())).toMatchObject({ ok: false, reason: expect.stringMatching(/not its author/) });
    // The adder writing on with the old id, past the frozen clock: refused.
    const later = new Y.Doc();
    later.clientID = old.clientID;
    Y.applyUpdate(later, full);
    later.getMap('nodes').set('after', 2);
    const more = Y.encodeStateAsUpdate(later, Y.encodeStateVector(old));
    const atPeer = new Y.Doc();
    Y.applyUpdate(atPeer, full);
    expect(checkEnvelope(sealUpdate(t.owner.device, t.owner.pub, t.id, FILE, 2, r.heads, more, Date.now(), []), r, atPeer)).toMatchObject({ ok: false, reason: expect.stringMatching(/not its author/) });
  });

  it('a private copy a tool writes with (MCP agents, batch, scripts) gets a writer id for a team file only', () => {
    const drop = setWriterProvider((file) => (file === FILE ? 4242 : null));
    try {
      const teamRoom = { id: FILE, doc: new BogenDoc(new Y.Doc()) } as unknown as Room;
      expect(scratchCopy(teamRoom).y.clientID).toBe(4242);
      const plain = { id: 'plainfile1', doc: new BogenDoc(new Y.Doc()) } as unknown as Room;
      expect(scratchCopy(plain).y.clientID).not.toBe(4242);
      const y = new Y.Doc();
      const before = y.clientID;
      assignWriter('plainfile1', y);
      expect(y.clientID).toBe(before);
    } finally {
      drop();
    }
  });
});

// ---- On a running service ------------------------------------------------------------------------------------

const homes: string[] = [];
const services: TeamService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop().catch(() => {});
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

async function running() {
  const home = await mkdtemp(join(tmpdir(), 'bogen-n6-'));
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
  names.set('menuboards', 'Menu');
  const doc = await (svc as any).deps.doc('menuboards') as Y.Doc;
  doc.getMap('nodes').set('before', 'x');
  const legacyId = doc.clientID;
  await svc.addFile(team, 'menuboards');
  const s = svc as any;
  return { svc, s, t: s.teams.get(team), team, doc, home, legacyId };
}

describe('writers on this device', () => {
  it('the room of a team file writes with a derived id, signs its changes naming the nonce, and gets a new id when Yjs drops it', async () => {
    const { s, t, doc, legacyId } = await running();
    expect(doc.clientID).not.toBe(legacyId);
    expect(t.writers.get('menuboards').has(doc.clientID)).toBe(true);
    doc.getMap('nodes').set('after', 'y');
    await s.flushOutbox();
    const mine = t.envelopes.get('menuboards').filter((e: any) => e.author === s.identity.device.ed.pub);
    const last = mine[mine.length - 1];
    expect(last.writers).toContain(t.writers.get('menuboards').get(doc.clientID));
    // What Yjs does when a remote change advances the doc's own id: a random one. The next transaction ends with
    // one of this device's again.
    doc.clientID = 7;
    doc.transact(() => {});
    expect(t.writers.get('menuboards').has(doc.clientID)).toBe(true);
  });

  it('a change written with an id this device never handed out is not sent', async () => {
    const { s, t } = await running();
    const stray = new Y.Doc();
    stray.getMap('nodes').set('stray', 1);
    const before = t.seq;
    await s.signLocal(t, 'menuboards', [Y.encodeStateAsUpdate(stray)]);
    expect(t.seq).toBe(before);
  });

  it('every editor tab gets its own id, and a spare', async () => {
    const { svc } = await running();
    const a = await svc.writerIds('menuboards');
    const b = await svc.writerIds('menuboards');
    expect(new Set([a.clientID, a.spare, b.clientID, b.spare]).size).toBe(4);
    expect(await svc.writerIds('plainfile1')).toEqual({ clientID: null, spare: null });
  });

  it('item 7: the envelope number never goes backwards, even when the envelope files are restored from a backup', async () => {
    const { svc, s, t, team, doc, home } = await running();
    for (const k of ['a', 'b', 'c']) { doc.getMap('nodes').set(k, 1); await s.flushOutbox(); }
    const top = t.seq;
    const dir = (s.store as any).teamDir(team);
    const jsonl = join(dir, 'files', 'menuboards.jsonl');
    const lines = (await readFile(jsonl, 'utf8')).trim().split('\n');
    await writeFile(jsonl, `${lines[0]}\n`);
    await svc.stop();
    await svc.start();
    expect(s.teams.get(team).seq).toBeGreaterThanOrEqual(top);
  });
});

describe('third review', () => {
  it('item 1: a stored TLS key from a little in the future is kept, and a new key is never older than the last', async () => {
    const { svc, s } = await running();
    const stored = s.identity.tls;
    s.identity.tls = { ...stored, issued: Date.now() + 5 * 60_000 };
    await svc.ensureTls();
    expect(s.tls.tlsPub).toBe(stored.key.pub);
    s.identity.tls = { ...stored, issued: Date.now() + 60 * 60_000 };
    const was = s.identity.tls.issued;
    await svc.ensureTls();
    expect(s.tls.issued).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    expect(s.tls.issued).toBeLessThan(was);
  });

  it('item 2: a sync answer stops at a byte budget, and the next round continues', async () => {
    const { s, t } = await running();
    const big = 'A'.repeat(4 * 1024 * 1024);
    const list = Array.from({ length: 6 }, (_, i) => ({ author: 'X'.repeat(43), seq: i + 1, update: big }));
    const fake = { envelopes: new Map([['f', list]]), refused: new Map(), late: new Set() };
    const first = s.missing(fake, {});
    expect(first.length).toBeLessThan(6);
    expect(first.length).toBeGreaterThan(0);
    const next = s.missing(fake, { f: { ['X'.repeat(43)]: [[1, first.length]] } });
    expect(next[0].seq).toBe(first.length + 1);
    void t;
  });

  it('item 3: a slot refused only as too late is not advertised as held', async () => {
    const { s } = await running();
    const fake = { envelopes: new Map([['f', []]]), refused: new Map([['f', new Map([['A:1', 'x'], ['A:2', 'y']])]]), late: new Set(['f|A:2']) };
    expect(s.vectors(fake).f).toEqual({ A: [[1, 1]] });
  });

  it('item 4: listening on every network puts each address of this device into the invite urls', async () => {
    const { svc } = await running();
    const port = 37_000 + Math.floor(Math.random() * 500);
    // The machine's addresses are given, so the test means the same on a machine with no LAN at all.
    const spy = vi.spyOn(TeamService, 'lanAddresses').mockReturnValue(['192.0.2.10', '198.51.100.7']);
    try {
      await svc.setTransports({ lan: { on: true, address: '0.0.0.0' }, tailscale: { on: false }, vpn: { on: false, address: '' }, port, listenEverywhere: true });
      expect(svc.urls).toEqual(expect.arrayContaining([`https://192.0.2.10:${port}`, `https://198.51.100.7:${port}`]));
      // And so an invite can be made: before, listening everywhere left no address to hand out.
      expect(svc.urls.length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('item 5: this device\'s own envelopes count toward its quota at once', async () => {
    const { s, t, doc } = await running();
    const key = `menuboards|${s.identity.device.ed.pub}`;
    const before = t.bytes.get(key) ?? 0;
    doc.getMap('nodes').set('more', 'x'.repeat(1000));
    await s.flushOutbox();
    expect(t.bytes.get(key)).toBeGreaterThan(before);
  });

  it('item 6: an admin stops at the local limit with a message, before the replay', async () => {
    const { s, t, svc, team } = await running();
    const me = s.me();
    const fill = Array.from({ length: 15_000 }, () => ({ person: me }));
    const real = t.ops;
    t.ops = [...real, ...fill];
    await expect(svc.invite(team, 'edit')).rejects.toThrow();
    await expect(s.append(t, 'rename', { name: 'X' })).rejects.toThrow(/very many membership changes/);
    t.ops = real;
  });
});
