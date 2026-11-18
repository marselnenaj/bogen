import { Y } from '@bogen/core';
import { b64u, canonical, KEY_TEXT, sha256, signBytes, unb64u, verifyBytes, type DeviceKeys } from './crypto.ts';
import { atLeast, rank, type Replay, type Role } from './log.ts';

/**
 * A Yjs update as it travels between members: signed by the device that made it, numbered per device, and naming
 * the membership heads its author had seen. Updates are forwarded in their original envelopes, so who made a change
 * can always be checked, whoever passed it on.
 *
 * An envelope is known by its author, number and the digest of its update, so two different updates under one
 * number (an author telling peers different things) are told apart and refused.
 *
 * `vouch` is not the author's: a member device that accepted an envelope of a removed or downgraded member within
 * the grace window signs that it did, so every peer it reaches decides the same way, whenever it gets there.
 */
export interface Vouch { by: string; at: number; sig: string }
export interface Envelope { v: 1; team: string; file: string; author: string; person: string; seq: number; heads: string[]; update: string; time: number; sig: string; vouch?: Vouch;
  /** The nonces of the Yjs client ids this update writes (and, for a comment-only member, deletes) with. */
  writers?: string[] }

const ENVELOPE_TAG = 'bogen-envelope-v3|';
const CLIENT_TAG = 'bogen-yjs-client-v1|';
/** A writer's nonce: 16 random bytes, base64url. */
export const NONCE_TEXT = /^[A-Za-z0-9_-]{22}$/;
/** At most this many writers one envelope names. */
export const MAX_WRITERS = 64;

/**
 * The Yjs client id a device writes with in one session: the first 53 bits of SHA-256 over the device key and a
 * random nonce. Anyone can compute it from the envelope, so whose an id is follows from the id itself, the same on
 * every peer, whatever arrives first. To write with someone else's id a member would have to find a nonce that
 * hashes to it under their own key: about 2^53 hashes per id. (Two ids that do collide fall back to whoever's
 * envelope was accepted first, which is what every peer did before.)
 */
export function clientIdOf(author: string, nonce: string): number {
  const h = sha256(Buffer.from(`${CLIENT_TAG}${author}|${nonce}`));
  return (h[0]! & 0x1f) * 2 ** 48 + h[1]! * 2 ** 40 + h[2]! * 2 ** 32 + h[3]! * 2 ** 24 + h[4]! * 2 ** 16 + h[5]! * 2 ** 8 + h[6]!;
}
const VOUCH_TAG = 'bogen-vouch-v1|';

const signed = (e: Omit<Envelope, 'sig' | 'vouch'>) => ENVELOPE_TAG + canonical({ v: e.v, team: e.team, file: e.file, author: e.author, person: e.person, seq: e.seq, heads: [...e.heads].sort(), update: e.update, time: e.time, writers: [...(e.writers ?? [])].sort() });
export const updateDigest = (update: Uint8Array | string) => b64u(sha256(typeof update === 'string' ? unb64u(update) : update)).slice(0, 22);
/** Author and number: the slot an envelope fills. */
export const envelopeSlot = (e: Pick<Envelope, 'author' | 'seq'>) => `${e.author}:${e.seq}`;
/** Slot and content. */
export const envelopeId = (e: Pick<Envelope, 'author' | 'seq' | 'update'>) => `${e.author}:${e.seq}:${updateDigest(e.update)}`;

export function sealUpdate(device: DeviceKeys, person: string, team: string, file: string, seq: number, heads: string[], update: Uint8Array, time = Date.now(), writers: string[] = []): Envelope {
  const draft = { v: 1 as const, team, file, author: device.ed.pub, person, seq, heads: [...heads].sort(), update: b64u(update), time, writers: [...new Set(writers)].sort() };
  return { ...draft, sig: signBytes(device.ed.priv, Buffer.from(signed(draft))) };
}

/**
 * Shape and signature only: whether the envelope is what its author signed. Checked before anything else an
 * envelope can make a peer do (equivocation, remembering a refusal), so nobody can act in another device's name.
 */
export function envelopeSigned(env: Envelope, team: string): boolean {
  try {
    if (!env || typeof env !== 'object' || env.v !== 1 || env.team !== team || !KEY_TEXT.test(env.author) || !KEY_TEXT.test(env.person)) return false;
    if (!Number.isInteger(env.seq) || env.seq < 1 || typeof env.file !== 'string' || typeof env.update !== 'string' || typeof env.time !== 'number' || !Number.isFinite(env.time)) return false;
    if (!Array.isArray(env.heads) || env.heads.length > 64 || env.heads.some((h) => typeof h !== 'string')) return false;
    if (!writersOk(env.writers)) return false;
    return verifyBytes(env.author, Buffer.from(signed(env)), env.sig);
  } catch {
    return false;
  }
}

const writersOk = (w: unknown) => w === undefined || (Array.isArray(w) && w.length <= MAX_WRITERS && w.every((n) => typeof n === 'string' && NONCE_TEXT.test(n)));

const vouchBytes = (env: Envelope, at: number) => Buffer.from(`${VOUCH_TAG}${env.team}|${env.file}|${envelopeId(env)}|${at}`);
export function vouchFor(device: DeviceKeys, env: Envelope, at: number): Envelope {
  return { ...env, vouch: { by: device.ed.pub, at, sig: signBytes(device.ed.priv, vouchBytes(env, at)) } };
}

/** Seven days, decided 2026-11-16: how long a removed member's offline edits from before the removal still land. */
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export type Verdict = { ok: true; role: Role; update: Uint8Array; clients: number[]; graced: boolean } | { ok: false; reason: string; retry?: boolean; late?: boolean };

/** The largest update a comment-only member may send: comments are text. */
export const MAX_COMMENT_UPDATE = 1024 * 1024;

/** Root types a comment-only member may touch. Comments live in their own map (core doc.ts). */
const COMMENT_ROOTS = new Set(['comments']);

function rootName(doc: Y.Doc, type: Y.AbstractType<unknown>): string | null {
  let t: Y.AbstractType<unknown> = type;
  while (t._item) t = t._item.parent as Y.AbstractType<unknown>;
  for (const [name, root] of doc.share) if (root === t) return name;
  return null;
}

interface Probe { roots: Set<string>; pending: boolean }

/** Which root types applying this update to a copy of the document would change, and whether any of it waits. */
function probe(current: Y.Doc, update: Uint8Array): Probe {
  const copy = new Y.Doc({ gc: false });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(current));
  for (const name of current.share.keys()) copy.get(name);
  const roots = new Set<string>();
  copy.on('afterTransaction', (tr: Y.Transaction) => {
    for (const type of tr.changed.keys()) roots.add(rootName(copy, type as Y.AbstractType<unknown>) ?? '?');
  });
  Y.applyUpdate(copy, update);
  const store = copy.store as unknown as { pendingStructs: unknown; pendingDs: unknown };
  const pending = Boolean(store.pendingStructs || store.pendingDs);
  copy.destroy();
  return { roots, pending };
}

/** Kept for callers and tests: the roots an update changes, '?' for anything it cannot place yet. */
export function rootsTouched(current: Y.Doc, update: Uint8Array): Set<string> {
  const p = probe(current, update);
  if (p.pending) p.roots.add('?');
  return p.roots;
}

interface Decoded { clients: Set<number>; structs: { client: number; clock: number; len: number }[]; deletes: { client: number; clock: number; len: number }[] }
function decode(update: Uint8Array): Decoded {
  const { structs: list, ds } = Y.decodeUpdate(update);
  const clients = new Set<number>();
  const structs: Decoded['structs'] = [];
  for (const s of list) {
    clients.add(s.id.client);
    structs.push({ client: s.id.client, clock: s.id.clock, len: s.length });
  }
  const deletes: Decoded['deletes'] = [];
  for (const [client, items] of ds.clients) for (const item of items) deletes.push({ client, clock: item.clock, len: item.len });
  return { clients, structs, deletes };
}

export interface CheckContext {
  /**
   * Who first wrote with each Yjs client id in this file, from accepted envelopes. Only consulted when two
   * derived ids collide (about 2^53 work to make happen on purpose): the first accepted keeps it.
   */
  clientOwner?: Map<number, string>;
}

/**
 * A vouch counts only when its signer was a member device that could edit at the very event it vouches about
 * (the removal or the lowering, so nobody who joined later), it is not the author's own, and it was made inside the
 * window after that event. A colluding editor can still vouch, but could make the same edit in their own name.
 */
function vouchValid(env: Envelope, log: Replay, sinceOp: string, since: number): Vouch | null {
  const v = env.vouch;
  if (!v || typeof v !== 'object' || !KEY_TEXT.test(v.by) || typeof v.at !== 'number' || !Number.isFinite(v.at) || v.by === env.author) return null;
  if (v.at < since || v.at - since > GRACE_MS) return null;
  const then = log.at([sinceOp]);
  if (!then) return null;
  for (const m of then.members.values()) {
    if (m.person === env.person || !m.devices.has(v.by) || !atLeast(m.role, 'edit')) continue;
    // And still one today.
    const now = log.state.members.get(m.person);
    if (!now?.devices.has(v.by) || !atLeast(now.role, 'edit')) return null;
    return verifyBytes(v.by, vouchBytes(env, v.at), v.sig) ? v : null;
  }
  return null;
}

/**
 * Whether a peer accepts an envelope: signature; author placed in the membership log at the heads it names; the
 * role it acts with (the lower of that role and today's, except within the grace window of a downgrade the author
 * had not seen); the removal rules (refused once the author's device has seen its removal; before that, accepted
 * within the grace window unless the admin chose "Remove now"); and what the update does.
 *
 * Every update, whoever sends it, may only write with Yjs client ids nobody else wrote with. A comment-only
 * member's update may only change comments, and may only delete what that member wrote, and only what is here
 * already: deleting ahead (clocks not yet seen) would wipe someone's future work. What cannot be checked yet is
 * refused with `retry`, never applied, so every peer ends with the same answer.
 */
export function checkEnvelope(env: Envelope, log: Replay, doc: Y.Doc | null, now = Date.now(), ctx: CheckContext = {}): Verdict {
  try {
    if (!env || env.v !== 1 || env.team !== log.state.team || !KEY_TEXT.test(env.author) || !KEY_TEXT.test(env.person)) return { ok: false, reason: 'not an envelope of this team' };
    if (!Number.isInteger(env.seq) || env.seq < 1 || !Array.isArray(env.heads) || env.heads.length > 64 || env.heads.some((h) => typeof h !== 'string') || typeof env.update !== 'string' || typeof env.time !== 'number' || !Number.isFinite(env.time)) return { ok: false, reason: 'malformed' };
    if (env.update.length > 22 * 1024 * 1024) return { ok: false, reason: 'too large' };
    if (!writersOk(env.writers)) return { ok: false, reason: 'malformed' };
    if (!verifyBytes(env.author, Buffer.from(signed(env)), env.sig)) return { ok: false, reason: 'the signature does not match' };
    if (!log.state.files.has(env.file)) return { ok: false, reason: 'that file is not in the team', retry: true };
    const then = log.at(env.heads);
    if (!then) return { ok: false, reason: 'names membership the receiver has not seen yet', retry: true };
    const member = then.members.get(env.person);
    if (!member || !member.devices.has(env.author)) return { ok: false, reason: 'the author was not a member with that device' };
    const withinGrace = (since: number, sinceOp: string) => now - since <= GRACE_MS || vouchValid(env, log, sinceOp, since) !== null;
    let role: Role = member.role;
    let graced = false;
    const lowest = (a: Role, b: Role): Role => (rank(a) <= rank(b) ? a : b);
    // Lowerings of this member's role the author had not seen, oldest first. Only the latest event (the last
    // lowering, or the removal) is forgiven within the grace window; every earlier lowering holds in full.
    const unseen = (log.state.downgrades.get(env.person) ?? []).filter((dg) => !log.sees(env.heads, dg.op));
    const removal = log.state.removed.get(env.person);
    if (removal) {
      if (log.sees(env.heads, removal.op)) return { ok: false, reason: 'sent after the author saw their removal' };
      if (removal.now) return { ok: false, reason: 'the author was removed with "Remove now"' };
      if (!withinGrace(removal.time, removal.op)) return { ok: false, reason: 'the 7 days for edits from before the removal are over', late: true };
      for (const dg of unseen) role = lowest(role, dg.to);
      graced = true;
    } else {
      const current = log.state.members.get(env.person);
      if (!current?.devices.has(env.author)) return { ok: false, reason: 'that device was revoked' };
      if (rank(current.role) < rank(role)) {
        const last = unseen[unseen.length - 1];
        for (const dg of unseen.slice(0, -1)) role = lowest(role, dg.to);
        if (last && withinGrace(last.time, last.op)) graced = rank(role) > rank(last.to);
        else role = lowest(role, current.role);
      }
      // Raised since: the author acted with what they had seen.
    }
    const update = new Uint8Array(unb64u(env.update));
    if (!atLeast(role, 'comment')) return { ok: false, reason: 'viewers send no changes' };
    let decoded: Decoded;
    try {
      decoded = decode(update);
    } catch {
      return { ok: false, reason: 'the update does not decode' };
    }
    // Whose each Yjs id is follows from the id: derived from this author and a nonce the envelope names, or part
    // of the history the file had when its adder brought it in (only that person, only up to those clocks).
    const own = new Set((env.writers ?? []).map((n) => clientIdOf(env.author, n)));
    const legacy = log.state.legacy.get(env.file);
    for (const st of decoded.structs) {
      if (own.has(st.client)) continue;
      const until = legacy && legacy.person === env.person ? legacy.sv.get(st.client) : undefined;
      if (until !== undefined && st.clock + st.len <= until) continue;
      return { ok: false, reason: 'writes with a Yjs client id that is not its author\'s' };
    }
    const owner = ctx.clientOwner;
    if (owner) for (const c of decoded.clients) {
      const who = owner.get(c);
      if (who !== undefined && who !== env.person) return { ok: false, reason: 'writes as someone else (another member\'s Yjs client)' };
    }
    if (!atLeast(role, 'edit')) {
      if (update.length > MAX_COMMENT_UPDATE) return { ok: false, reason: 'too large for a comment' };
      if (!doc) return { ok: false, reason: 'cannot check a comment-only change without the file', retry: true };
      const sv = Y.decodeStateVector(Y.encodeStateVector(doc));
      for (const d of decoded.deletes) {
        // Only what this member wrote: ids derived from the author, named in this envelope.
        if (!own.has(d.client)) return { ok: false, reason: 'a comment-only member deleted what someone else wrote' };
        if (!decoded.clients.has(d.client) && (sv.get(d.client) ?? 0) < d.clock + d.len) return { ok: false, reason: 'deletes what is not here yet', retry: true };
      }
      let p: Probe;
      try {
        p = probe(doc, update);
      } catch {
        return { ok: false, reason: 'the update does not decode' };
      }
      if (p.pending) return { ok: false, reason: 'builds on what is not here yet', retry: true };
      for (const r of p.roots) if (!COMMENT_ROOTS.has(r)) return { ok: false, reason: `a comment-only member changed ${r === '?' ? 'something it cannot place' : r}` };
    }
    return { ok: true, role, update, clients: [...decoded.clients], graced };
  } catch {
    // Anything odd in an envelope (numbers that do not encode, wrong types) is a refusal, never a crash.
    return { ok: false, reason: 'malformed' };
  }
}
