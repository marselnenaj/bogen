import { describe, expect, it } from 'vitest';
import { Y } from '@bogen/core';
import {
  entropyFromPhrase, newDeviceKeys, newEd, newRecoveryPhrase, personKeyFromPhrase, phraseFromEntropy, safetyPhrase,
} from '../src/teams/crypto.ts';
import { checkEnvelope, GRACE_MS, sealUpdate } from '../src/teams/envelope.ts';
import { inviteId, inviteLink, joinProof, newInviteSecret, parseInvite, proofMatches } from '../src/teams/invite.ts';
import { certify, makeOp, replay, type Op, type Role } from '../src/teams/log.ts';
import { editBy, sealAs } from './teams-writers.ts';

/** A person with one device, as the tests need them. */
function person(name: string) {
  const key = newEd();
  const device = newDeviceKeys();
  const cert = certify(key, { ed: device.ed.pub, x: device.x.pub, name: `${name}'s laptop` });
  return { name, key, device, cert, pub: key.pub };
}

function team() {
  const teamKey = newEd();
  const owner = person('Anna');
  const genesis = makeOp(teamKey.pub, [], { ed: teamKey }, owner.pub, 'genesis', { name: 'Studio Nord', owner: { person: owner.pub, name: 'Anna', certs: [owner.cert] } }, 1000);
  const ops: Op[] = [genesis];
  const heads = () => replay(teamKey.pub, ops).heads;
  const by = <K extends Op['kind']>(who: ReturnType<typeof person>, kind: K, body: Op<K>['body'], time = 2000) => {
    const op = makeOp(teamKey.pub, heads(), who.device, who.pub, kind, body, time);
    ops.push(op);
    return op;
  };
  const add = (who: ReturnType<typeof person>, role: Role, by_ = owner) => by(by_, 'add', { person: who.pub, name: who.name, role, certs: [who.cert] });
  return { id: teamKey.pub, teamKey, owner, ops, by, add, state: () => replay(teamKey.pub, ops) };
}

describe('keys', () => {
  it('gives back the same person key from the recovery phrase and catches a wrong word', () => {
    const words = newRecoveryPhrase();
    expect(words).toHaveLength(12);
    expect(personKeyFromPhrase(words).pub).toBe(personKeyFromPhrase([...words]).pub);
    expect(phraseFromEntropy(entropyFromPhrase(words))).toEqual(words);
    // A swapped word passes the 4-bit checksum one time in 16, so try several: almost all must be caught.
    let caught = 0;
    for (const w of ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract'].filter((x) => x !== words[3])) {
      const wrong = [...words];
      wrong[3] = w;
      try { personKeyFromPhrase(wrong); } catch { caught++; }
    }
    expect(caught).toBeGreaterThanOrEqual(4);
    expect(() => personKeyFromPhrase(words.slice(0, 11))).toThrow(/12 words/);
  });

  it('makes the same six safety words on both sides', () => {
    const t = newEd().pub, p = newEd().pub;
    expect(safetyPhrase(t, p)).toEqual(safetyPhrase(t, p));
    expect(safetyPhrase(t, p)).toHaveLength(6);
  });
});

describe('the membership log', () => {
  it('starts with the owner and lets an owner add members with roles', () => {
    const t = team();
    const jonas = person('Jonas');
    t.add(jonas, 'edit');
    const s = t.state().state;
    expect(s.name).toBe('Studio Nord');
    expect(s.members.get(t.owner.pub)?.role).toBe('owner');
    expect(s.members.get(jonas.pub)?.role).toBe('edit');
  });

  it('ignores a forged op: changed body, a signature by another device, or a second genesis', () => {
    const t = team();
    const mallory = person('Mallory');
    const op = makeOp(t.id, t.state().heads, t.owner.device, t.owner.pub, 'add', { person: mallory.pub, name: 'M', role: 'view', certs: [mallory.cert] });
    const tampered = { ...op, body: { ...op.body, role: 'owner' as Role } };
    expect(replay(t.id, [...t.ops, tampered]).state.members.has(mallory.pub)).toBe(false);
    // Mallory signs an op claiming to be Anna.
    const claim = makeOp(t.id, t.state().heads, mallory.device, t.owner.pub, 'add', { person: mallory.pub, name: 'M', role: 'admin', certs: [mallory.cert] });
    expect(replay(t.id, [...t.ops, claim]).state.members.has(mallory.pub)).toBe(false);
    // A second genesis made with another key cannot take the team over.
    const other = newEd();
    const fake = makeOp(t.id, [], { ed: other }, mallory.pub, 'genesis', { name: 'Mine', owner: { person: mallory.pub, name: 'M', certs: [mallory.cert] } });
    const r = replay(t.id, [...t.ops, fake]);
    expect(r.state.members.has(mallory.pub)).toBe(false);
    expect(r.state.name).toBe('Studio Nord');
  });

  it('refuses ops beyond the author\'s role: an editor cannot add people or make themselves admin', () => {
    const t = team();
    const jonas = person('Jonas'), mira = person('Mira');
    t.add(jonas, 'edit');
    t.add(mira, 'view', jonas);
    t.by(jonas, 'role', { person: jonas.pub, role: 'admin' });
    const s = t.state().state;
    expect(s.members.has(mira.pub)).toBe(false);
    expect(s.members.get(jonas.pub)?.role).toBe('edit');
  });

  it('lets removal win over what the removed person did at the same time', () => {
    const t = team();
    const admin = person('Tomas'), friend = person('Friend');
    t.add(admin, 'admin');
    const heads = t.state().heads;
    // Concurrently: Anna removes Tomas, and Tomas adds a friend.
    const removal = makeOp(t.id, heads, t.owner.device, t.owner.pub, 'remove', { person: admin.pub, now: false }, 3000);
    const sneaky = makeOp(t.id, heads, admin.device, admin.pub, 'add', { person: friend.pub, name: 'F', role: 'edit', certs: [friend.cert] }, 3000);
    const r = replay(t.id, [...t.ops, sneaky, removal]);
    expect(r.state.members.has(admin.pub)).toBe(false);
    expect(r.state.members.has(friend.pub)).toBe(false);
    // And the same result in any order.
    expect(replay(t.id, [...t.ops, removal, sneaky]).state.members.has(friend.pub)).toBe(false);
  });

  it('keeps the last owner: an owner cannot be removed while they are the only one', () => {
    const t = team();
    t.by(t.owner, 'remove', { person: t.owner.pub, now: false });
    expect(t.state().state.members.get(t.owner.pub)?.role).toBe('owner');
  });
});

describe('invites', () => {
  it('round-trips a link and proves the secret without sending it', () => {
    const secret = newInviteSecret();
    const device = newDeviceKeys();
    const teamKey = newEd().pub;
    const link = inviteLink(secret, { team: teamKey, name: 'Studio Nord', device: { ed: device.ed.pub, x: device.x.pub }, urls: ['https://192.168.1.5:29998'], role: 'edit', by: 'Anna', expires: Date.now() + 1000 });
    expect(link.startsWith('bogen://join/')).toBe(true);
    const parsed = parseInvite(link);
    expect(parsed.id).toBe(inviteId(secret));
    const proof = joinProof(parsed.secret, 'person', 'device', 'nonce-1');
    expect(proofMatches(secret, 'person', 'device', 'nonce-1', proof)).toBe(true);
    // A captured proof is bound to its connection and keys.
    expect(proofMatches(secret, 'person', 'device', 'nonce-2', proof)).toBe(false);
    expect(proofMatches(secret, 'other', 'device', 'nonce-1', proof)).toBe(false);
    expect(() => parseInvite(link.replace('bogen://join/', 'bogen://join/aaaaaaaaaaaaaaaa').replace(/join\/[a-z2-7]{16}aaaa/, 'join/aaaaaaaaaaaaaaaa'))).toThrow();
  });

  it('counts uses in the log, so a replayed invite cannot add a second person', () => {
    const t = team();
    const secret = newInviteSecret();
    t.by(t.owner, 'invite', { id: inviteId(secret), role: 'edit', expires: 10_000_000, uses: 1 });
    const a = person('A'), b = person('B');
    t.by(t.owner, 'add', { person: a.pub, name: 'A', role: 'edit', certs: [a.cert], invite: inviteId(secret) }, 5000);
    t.by(t.owner, 'add', { person: b.pub, name: 'B', role: 'edit', certs: [b.cert], invite: inviteId(secret) }, 6000);
    const s = t.state().state;
    expect(s.members.has(a.pub)).toBe(true);
    expect(s.members.has(b.pub)).toBe(false);
    // An expired invite adds nobody.
    const late = newInviteSecret();
    t.by(t.owner, 'invite', { id: inviteId(late), role: 'view', expires: 7000, uses: 1 }, 6500);
    const c = person('C');
    t.by(t.owner, 'add', { person: c.pub, name: 'C', role: 'view', certs: [c.cert], invite: inviteId(late) }, 8000);
    expect(t.state().state.members.has(c.pub)).toBe(false);
  });
});

describe('update envelopes', () => {
  function withFile(role: Role) {
    const t = team();
    const member = person('Member');
    t.add(member, role);
    t.by(t.owner, 'file-add', { file: 'abcdefghij', name: 'Menu boards' });
    const doc = new Y.Doc();
    doc.getMap('nodes').set('n1', 'a layer');
    doc.getMap('comments');
    return { t, member, doc };
  }
  const edit = (doc: Y.Doc, root: string, device: Parameters<typeof editBy>[0]) => editBy(device, doc, root);

  it('accepts an editor\'s change and refuses one from an unknown key or with a tampered update', () => {
    const { t, member, doc } = withFile('edit');
    const r = t.state();
    const env = sealAs(member.device, member.pub, t.id, 'abcdefghij', 1, r.heads, edit(doc, 'nodes', member.device));
    expect(checkEnvelope(env, r, doc).ok).toBe(true);
    const stranger = person('Stranger');
    const foreign = sealAs(stranger.device, stranger.pub, t.id, 'abcdefghij', 1, r.heads, edit(doc, 'nodes', stranger.device));
    expect(checkEnvelope(foreign, r, doc)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a member/) });
    const tampered = { ...env, update: sealAs(member.device, member.pub, t.id, 'abcdefghij', 1, r.heads, edit(doc, 'pages', member.device)).update };
    expect(checkEnvelope(tampered, r, doc)).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
    const claimed = { ...env, person: t.owner.pub };
    expect(checkEnvelope(claimed, r, doc).ok).toBe(false);
  });

  it('lets a comment-only member change comments and nothing else', () => {
    const { t, member, doc } = withFile('comment');
    const r = t.state();
    expect(checkEnvelope(sealAs(member.device, member.pub, t.id, 'abcdefghij', 1, r.heads, edit(doc, 'comments', member.device)), r, doc).ok).toBe(true);
    const layer = checkEnvelope(sealAs(member.device, member.pub, t.id, 'abcdefghij', 2, r.heads, edit(doc, 'nodes', member.device)), r, doc);
    expect(layer).toMatchObject({ ok: false, reason: expect.stringMatching(/comment-only member changed nodes/) });
  });

  it('refuses any change from a viewer', () => {
    const { t, member, doc } = withFile('view');
    const r = t.state();
    expect(checkEnvelope(sealAs(member.device, member.pub, t.id, 'abcdefghij', 1, r.heads, edit(doc, 'comments', member.device)), r, doc).ok).toBe(false);
  });

  it('takes a removed member\'s offline edits for 7 days, then refuses them; Remove now refuses at once', () => {
    const { t, member, doc } = withFile('edit');
    const before = t.state().heads;
    const removedAt = 1_000_000;
    t.by(t.owner, 'remove', { person: member.pub, now: false }, removedAt);
    const r = t.state();
    const offline = sealAs(member.device, member.pub, t.id, 'abcdefghij', 1, before, edit(doc, 'nodes', member.device), removedAt - 10);
    expect(checkEnvelope(offline, r, doc, removedAt + 60_000).ok).toBe(true);
    expect(checkEnvelope(offline, r, doc, removedAt + GRACE_MS + 1)).toMatchObject({ ok: false, reason: expect.stringMatching(/7 days/) });
    // After seeing the removal, nothing they send counts.
    const after = sealAs(member.device, member.pub, t.id, 'abcdefghij', 2, r.heads, edit(doc, 'nodes', member.device));
    expect(checkEnvelope(after, r, doc, removedAt + 60_000).ok).toBe(false);

    const second = withFile('edit');
    const old = second.t.state().heads;
    second.t.by(second.t.owner, 'remove', { person: second.member.pub, now: true }, removedAt);
    const hard = sealAs(second.member.device, second.member.pub, second.t.id, 'abcdefghij', 1, old, edit(second.doc, 'nodes', second.member.device));
    expect(checkEnvelope(hard, second.t.state(), second.doc, removedAt + 1)).toMatchObject({ ok: false, reason: expect.stringMatching(/Remove now/) });
  });

  it('waits on heads it has not seen instead of guessing', () => {
    const { t, member, doc } = withFile('edit');
    const env = sealAs(member.device, member.pub, t.id, 'abcdefghij', 1, ['unknown-head-id-that-nobody-made-aaaaaaaaaaa'], edit(doc, 'nodes', member.device));
    expect(checkEnvelope(env, t.state(), doc)).toMatchObject({ ok: false, retry: true });
  });
});
