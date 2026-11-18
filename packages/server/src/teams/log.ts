import { b64u, canonical, KEY_TEXT, sha256, signBytes, verifyBytes, type DeviceKeys, type DevicePublic, type KeyPair } from './crypto.ts';

/**
 * The membership log of a team: signed operations with causal parents, replayed the same way on every device.
 * Validity is computed, never trusted. See docs/teams.md, "The membership log", and "Phase 1 as built".
 *
 * Replay, in short:
 * - Ops are put in one order everywhere: by depth in the causal graph, then by id.
 * - They are applied one after another to one state. An op counts when its author's device is a member device
 *   in that state and was granted in what the op's author had seen (its ancestors), and the author's role is
 *   the lower of the role in that state and the role the author had seen.
 * - Removals and role downgrades win over what the affected person did concurrently with them: those ops are
 *   left out and the replay runs again until nothing changes.
 *
 * Cost is linear in the log per round. Signatures are checked once per op and only for ops whose author could
 * count, so a flood of ops by strangers costs a hash each. Logs are capped per person and in total.
 */

export type Role = 'owner' | 'admin' | 'edit' | 'comment' | 'view';
export const ROLES: readonly Role[] = ['owner', 'admin', 'edit', 'comment', 'view'];
const RANK: Record<Role, number> = { owner: 5, admin: 4, edit: 3, comment: 2, view: 1 };
export const rank = (role: Role | undefined) => (role ? RANK[role] : 0);
export const atLeast = (role: Role | undefined, need: Role) => role !== undefined && RANK[role] >= RANK[need];
const lower = (a: Role, b: Role): Role => (RANK[a] <= RANK[b] ? a : b);

/** Most ops one person may have in a team's log, and most ops a log keeps. Beyond, ops do not count. */
/**
 * Caps on what members without admin rights can put in the log, so nobody below admin can fill it: per person, and
 * in total. Owners and admins are not capped (they run the team; a cap would one day lock them out of it).
 */
export const MAX_PERSON_OPS = 2000;
export const MAX_LOG_OPS = 10_000;

/** A person vouches for a device: signed by the person key, so devices of a person can be added without it online. */
export interface DeviceCert { person: string; device: DevicePublic; sig: string }

export type OpKind = 'genesis' | 'add' | 'remove' | 'role' | 'device-add' | 'device-revoke' | 'invite' | 'invite-revoke' | 'file-add' | 'file-remove' | 'rename';
export interface OpBody {
  genesis: { name: string; owner: { person: string; name: string; certs: DeviceCert[] } };
  add: { person: string; name: string; role: Role; certs: DeviceCert[]; invite?: string };
  remove: { person: string; now: boolean };
  role: { person: string; role: Role };
  'device-add': { cert: DeviceCert };
  'device-revoke': { person: string; device: string };
  invite: { id: string; role: Role; expires: number; uses: number };
  'invite-revoke': { id: string };
  /**
   * `legacy`: the file's Yjs state vector when it was added ([client, clock] pairs). Its history was written with
   * ids nobody can derive, so those ids (up to those clocks) belong to the person who added the file, and to nobody
   * after: every new change is written with ids derived from its author (envelope.ts, clientIdOf).
   */
  'file-add': { file: string; name: string; legacy?: [number, number][] };
  'file-remove': { file: string };
  rename: { name: string };
}
export interface Op<K extends OpKind = OpKind> {
  v: 1;
  team: string;
  id: string;
  parents: string[];
  /** The device that signed it. */
  author: string;
  /** The person the device belongs to. */
  person: string;
  kind: K;
  body: OpBody[K];
  /** The author's clock, for display and the removal grace window only. */
  time: number;
  sig: string;
}

/** Signature contexts are tagged, so a signature made for one can never be taken for another. */
const CERT_TAG = 'bogen-cert-v2|';
const OP_TAG = 'bogen-op-v2|';

const NAME = (n: unknown): n is string => typeof n === 'string' && n.trim().length > 0 && n.length <= 100;

const certBytes = (cert: Pick<DeviceCert, 'person' | 'device'>) => Buffer.from(CERT_TAG + canonical({ person: cert.person, device: { ed: cert.device.ed, x: cert.device.x, name: cert.device.name } }));

export function certify(person: KeyPair, device: DevicePublic): DeviceCert {
  const body = { person: person.pub, device: { ed: device.ed, x: device.x, name: device.name } };
  return { ...body, sig: signBytes(person.priv, certBytes(body)) };
}
export function certValid(cert: DeviceCert): boolean {
  try {
    return Boolean(cert && typeof cert === 'object' && KEY_TEXT.test(cert.person) && cert.device && typeof cert.device === 'object'
      && KEY_TEXT.test(cert.device.ed) && KEY_TEXT.test(cert.device.x) && NAME(cert.device.name)
      && verifyBytes(cert.person, certBytes(cert), cert.sig));
  } catch {
    return false;
  }
}

const signedPart = (op: Omit<Op, 'id' | 'sig'>) => OP_TAG + canonical({ v: op.v, team: op.team, parents: [...op.parents].sort(), author: op.author, person: op.person, kind: op.kind, body: op.body, time: op.time });
export const opId = (op: Omit<Op, 'id' | 'sig'>) => b64u(sha256(signedPart(op)));

export function makeOp<K extends OpKind>(team: string, parents: string[], device: Pick<DeviceKeys, 'ed'>, person: string, kind: K, body: OpBody[K], time = Date.now()): Op<K> {
  const draft = { v: 1 as const, team, parents: [...new Set(parents)].sort(), author: device.ed.pub, person, kind, body, time };
  return { ...draft, id: opId(draft), sig: signBytes(device.ed.priv, Buffer.from(signedPart(draft))) };
}

/** Op objects already found well shaped, so a replay does not hash the whole log again. */
const shaped = new WeakMap<object, string>();

/** Shape and id only, cheap: no signature. Anything that throws (non-finite numbers, odd shapes) is malformed. */
export function opShapeOk(op: Op, team: string): boolean {
  if (op && typeof op === 'object' && shaped.get(op) === `${team}|${op.id}|${op.sig}`) return true;
  const ok = shapeCheck(op, team);
  if (ok) shaped.set(op, `${team}|${op.id}|${op.sig}`);
  return ok;
}
function shapeCheck(op: Op, team: string): boolean {
  try {
    if (!op || typeof op !== 'object' || op.v !== 1 || op.team !== team || typeof op.id !== 'string' || op.id.length !== 43) return false;
    if (!Array.isArray(op.parents) || op.parents.length > 64 || op.parents.some((p) => typeof p !== 'string' || p.length !== 43)) return false;
    if (!KEY_TEXT.test(op.author) || !KEY_TEXT.test(op.person) || typeof op.kind !== 'string' || typeof op.sig !== 'string') return false;
    if (typeof op.time !== 'number' || !Number.isFinite(op.time) || !op.body || typeof op.body !== 'object') return false;
    return op.id === opId(op);
  } catch {
    return false;
  }
}

/** Ops whose signature checked out, by id and signature: each op is verified once per process. */
const verified = new Set<string>();
export function opSigned(op: Op): boolean {
  const key = `${op.id}|${op.sig}`;
  if (verified.has(key)) return true;
  let ok = false;
  try {
    ok = verifyBytes(op.author, Buffer.from(signedPart(op)), op.sig);
  } catch {
    ok = false;
  }
  if (ok) {
    if (verified.size > 200_000) verified.clear();
    verified.add(key);
  }
  return ok;
}

/** Shape and signature. Whether the author was allowed is the replay's question. */
export function opWellFormed(op: Op, team: string): boolean {
  return opShapeOk(op, team) && opSigned(op);
}

export interface Member {
  person: string; name: string; role: Role; devices: Map<string, DevicePublic>; addedBy: string; addedAt: number;
  /** The op that made each device a member device, and the op that set the current role. */
  grants: Map<string, string>; roleOp: string;
}
export interface Removal { person: string; op: string; now: boolean; time: number }
/** A role lowered: like a removal for what needed the higher role, with the same grace. */
export interface Downgrade { person: string; op: string; from: Role; to: Role; time: number }
export interface InviteState { id: string; role: Role; expires: number; uses: number; used: number; revoked: boolean; by: string }
export interface TeamState {
  team: string;
  name: string;
  members: Map<string, Member>;
  removed: Map<string, Removal>;
  /** Every lowering of each member's role since they were last added, oldest first. */
  downgrades: Map<string, Downgrade[]>;
  invites: Map<string, InviteState>;
  files: Map<string, string>;
  /** Per file: who added it and the Yjs ids (with their clocks) its history had then. */
  legacy: Map<string, { person: string; sv: Map<number, number> }>;
  /** Which member holds each device: a device belongs to one person only. */
  deviceOwner: Map<string, string>;
}

const emptyState = (team: string): TeamState => ({ team, name: '', members: new Map(), removed: new Map(), downgrades: new Map(), invites: new Map(), files: new Map(), legacy: new Map(), deviceOwner: new Map() });

/** At most this many Yjs ids a file's history may bring into a team. */
export const MAX_LEGACY_CLIENTS = 4096;
const legacyOk = (l: unknown): l is [number, number][] => Array.isArray(l) && l.length <= MAX_LEGACY_CLIENTS
  && l.every((e) => Array.isArray(e) && e.length === 2 && Number.isSafeInteger(e[0]) && e[0] >= 0 && Number.isSafeInteger(e[1]) && e[1] >= 0)
  && new Set(l.map((e) => e[0])).size === l.length;
const certsFor = (person: string, certs: DeviceCert[]) => Array.isArray(certs) && certs.length > 0 && certs.length <= 32 && certs.every((c) => c && c.person === person && certValid(c));
const owners = (s: TeamState) => {
  let n = 0;
  for (const m of s.members.values()) if (m.role === 'owner') n++;
  return n;
};
const devicesFree = (s: TeamState, person: string, certs: DeviceCert[]) => certs.every((c) => {
  const holder = s.deviceOwner.get(c.device.ed);
  return holder === undefined || holder === person;
});

function addMember(s: TeamState, op: Op, person: string, name: string, role: Role, certs: DeviceCert[]): void {
  const devices = new Map(certs.map((c) => [c.device.ed, c.device]));
  const grants = new Map(certs.map((c) => [c.device.ed, op.id]));
  for (const ed of devices.keys()) s.deviceOwner.set(ed, person);
  s.removed.delete(person);
  s.downgrades.delete(person);
  s.members.set(person, { person, name, role, devices, addedBy: op.person, addedAt: op.time, grants, roleOp: op.id });
}
function dropMember(s: TeamState, person: string): void {
  const m = s.members.get(person);
  if (!m) return;
  for (const ed of m.devices.keys()) if (s.deviceOwner.get(ed) === person) s.deviceOwner.delete(ed);
  s.members.delete(person);
}

/** The lowest role an op needs from its author, for the downgrade rule. */
function needs(op: Op): Role {
  switch (op.kind) {
    case 'remove': return (op.body as OpBody['remove']).person === op.person ? 'view' : 'admin';
    case 'device-add': return 'view';
    case 'device-revoke': return (op.body as OpBody['device-revoke']).person === op.person ? 'view' : 'admin';
    case 'add': return (op.body as OpBody['add']).invite !== undefined && (op.body as OpBody['add']).person === op.person ? 'view' : 'admin';
    default: return 'admin';
  }
}

/**
 * Applies one op to a state if its author, acting with `role`, may, and says whether it did. Changes the state
 * in place only when it says yes.
 */
function apply(s: TeamState, op: Op, role: Role | null): boolean {
  if (op.kind === 'genesis') {
    const b = op.body as OpBody['genesis'];
    if (op.parents.length || s.members.size || !b?.owner || op.person !== b.owner.person || !NAME(b.name) || !NAME(b.owner.name) || !certsFor(b.owner.person, b.owner.certs)) return false;
    // The genesis is signed by the team key itself: the team's id is that key, so nobody can make a second genesis.
    if (op.author !== s.team) return false;
    s.name = b.name;
    addMember(s, op, b.owner.person, b.owner.name, 'owner', b.owner.certs);
    return true;
  }
  const me = s.members.get(op.person);
  if (!me || !me.devices.has(op.author) || !role) return false;
  switch (op.kind) {
    case 'add': {
      const b = op.body as OpBody['add'];
      if (!KEY_TEXT.test(b.person) || s.members.has(b.person) || !NAME(b.name) || !(b.role in RANK) || !certsFor(b.person, b.certs) || !devicesFree(s, b.person, b.certs)) return false;
      if (b.invite !== undefined) {
        // Joining by invite: the inviter's right was checked when the invite was made; here the invite must be live.
        const inv = s.invites.get(b.invite);
        if (!inv || inv.revoked || inv.used >= inv.uses || op.time > inv.expires || inv.role !== b.role) return false;
        if (!atLeast(role, 'admin') && op.person !== b.person) return false;
        inv.used++;
      } else {
        if (!atLeast(role, 'admin')) return false;
        // Adding someone as owner or admin directly takes an owner, as changing a role to them does.
        if ((b.role === 'owner' || b.role === 'admin') && role !== 'owner') return false;
      }
      addMember(s, op, b.person, b.name, b.role, b.certs);
      return true;
    }
    case 'remove': {
      const b = op.body as OpBody['remove'];
      const target = s.members.get(b.person);
      if (!target) return false;
      const self = b.person === op.person;
      if (!self) {
        if (!atLeast(role, 'admin')) return false;
        if ((target.role === 'owner' || target.role === 'admin') && role !== 'owner') return false;
      }
      if (target.role === 'owner' && owners(s) === 1) return false;
      dropMember(s, b.person);
      s.removed.set(b.person, { person: b.person, op: op.id, now: b.now === true, time: op.time });
      return true;
    }
    case 'role': {
      const b = op.body as OpBody['role'];
      const target = s.members.get(b.person);
      if (!target || !(b.role in RANK) || !atLeast(role, 'admin')) return false;
      if ((target.role === 'owner' || b.role === 'owner' || target.role === 'admin' || b.role === 'admin') && role !== 'owner') return false;
      if (target.role === 'owner' && b.role !== 'owner' && owners(s) === 1) return false;
      if (RANK[b.role] < RANK[target.role]) s.downgrades.set(b.person, [...(s.downgrades.get(b.person) ?? []), { person: b.person, op: op.id, from: target.role, to: b.role, time: op.time }].slice(-64));
      target.role = b.role;
      target.roleOp = op.id;
      return true;
    }
    case 'device-add': {
      const b = op.body as OpBody['device-add'];
      if (!b?.cert || b.cert.person !== op.person || !certValid(b.cert) || me.devices.size >= 32 || !devicesFree(s, op.person, [b.cert])) return false;
      me.devices.set(b.cert.device.ed, b.cert.device);
      me.grants.set(b.cert.device.ed, op.id);
      s.deviceOwner.set(b.cert.device.ed, op.person);
      return true;
    }
    case 'device-revoke': {
      const b = op.body as OpBody['device-revoke'];
      const target = s.members.get(b.person);
      if (!target || !target.devices.has(b.device)) return false;
      if (b.person !== op.person) {
        // Revoking someone else's device follows the rules of removing them.
        if (!atLeast(role, 'admin')) return false;
        if ((target.role === 'owner' || target.role === 'admin') && role !== 'owner') return false;
      }
      if (target.devices.size === 1) return false;
      target.devices.delete(b.device);
      target.grants.delete(b.device);
      s.deviceOwner.delete(b.device);
      return true;
    }
    case 'invite': {
      const b = op.body as OpBody['invite'];
      if (!atLeast(role, 'admin') || typeof b.id !== 'string' || b.id.length !== 43 || s.invites.has(b.id) || !(b.role in RANK)) return false;
      if (b.role === 'owner' || (b.role === 'admin' && role !== 'owner')) return false;
      if (!(typeof b.expires === 'number' && b.expires > op.time) || !(Number.isInteger(b.uses) && b.uses >= 1 && b.uses <= 100)) return false;
      s.invites.set(b.id, { id: b.id, role: b.role, expires: b.expires, uses: b.uses, used: 0, revoked: false, by: op.person });
      return true;
    }
    case 'invite-revoke': {
      const b = op.body as OpBody['invite-revoke'];
      const inv = s.invites.get(b.id);
      if (!inv || !atLeast(role, 'admin')) return false;
      inv.revoked = true;
      return true;
    }
    case 'file-add': {
      // Files are the admins' (docs/teams.md): an editor works in them, an admin decides what the team shares.
      const b = op.body as OpBody['file-add'];
      if (!atLeast(role, 'admin') || typeof b.file !== 'string' || !/^[a-z0-9]{10}$/.test(b.file) || !NAME(b.name) || s.files.has(b.file)) return false;
      if (b.legacy !== undefined && !legacyOk(b.legacy)) return false;
      s.files.set(b.file, b.name);
      s.legacy.set(b.file, { person: op.person, sv: new Map(b.legacy ?? []) });
      return true;
    }
    case 'file-remove': {
      const b = op.body as OpBody['file-remove'];
      if (!atLeast(role, 'admin') || !s.files.has(b.file)) return false;
      s.files.delete(b.file);
      s.legacy.delete(b.file);
      return true;
    }
    case 'rename': {
      const b = op.body as OpBody['rename'];
      if (!atLeast(role, 'admin') || !NAME(b.name)) return false;
      s.name = b.name;
      return true;
    }
    default:
      return false;
  }
}

export interface Replay {
  state: TeamState;
  /** Ops that count. */
  valid: Set<string>;
  /**
   * Ops worth keeping: those whose author could make them (valid before the removal and downgrade rule left
   * some out). Everything else is dropped, never stored or passed on.
   */
  keep: Set<string>;
  order: string[];
  heads: string[];
  /** Ops whose parents are not all here yet. */
  pending: string[];
  /** The state as the author of something saw it, at these heads. Null when a head is unknown. */
  at(heads: readonly string[]): TeamState | null;
  /** Whether what was made at these heads had seen this op. Null when a head is unknown. */
  sees(heads: readonly string[], op: string): boolean | null;
}

const IMPORTANT = new Set<OpKind>(['genesis', 'add', 'remove', 'role', 'device-add', 'device-revoke']);

export function replay(team: string, ops: Iterable<Op>): Replay {
  const byId = new Map<string, Op>();
  for (const op of ops) if (!byId.has(op?.id) && opShapeOk(op, team)) byId.set(op.id, op);

  // Complete ops (every ancestor here) and their depth, without recursion: a long chain must not blow the stack.
  const depth = new Map<string, number>();
  const incomplete = new Set<string>();
  for (const start of byId.keys()) {
    if (depth.has(start) || incomplete.has(start)) continue;
    const stack: string[] = [start];
    const onStack = new Set<string>([start]);
    while (stack.length) {
      const id = stack[stack.length - 1]!;
      const op = byId.get(id)!;
      let next: string | null = null;
      let bad = false;
      let d = 0;
      for (const p of op.parents) {
        const pd = depth.get(p);
        if (pd !== undefined) { d = Math.max(d, pd + 1); continue; }
        if (incomplete.has(p) || !byId.has(p) || onStack.has(p)) { bad = true; break; }
        next = p;
        break;
      }
      if (!bad && next) { stack.push(next); onStack.add(next); continue; }
      stack.pop();
      onStack.delete(id);
      if (bad) incomplete.add(id);
      else depth.set(id, d);
    }
  }
  const pending = [...byId.keys()].filter((id) => !depth.has(id));
  const order = [...depth.keys()].sort((a, b) => depth.get(a)! - depth.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
  const get = (id: string) => byId.get(id)!;

  // For each op, which rights-changing ops it had seen, as a bit set. Shared when an op adds nothing new.
  const index = new Map<string, number>();
  for (const id of order) if (IMPORTANT.has(get(id).kind)) index.set(id, index.size);
  const words = Math.max(1, Math.ceil(index.size / 32));
  const seen = new Map<string, Uint32Array>();
  const EMPTY = new Uint32Array(words);
  for (const id of order) {
    const op = get(id);
    const only = op.parents.length === 1 ? op.parents[0]! : null;
    if (!op.parents.length) { seen.set(id, EMPTY); continue; }
    if (only && !index.has(only)) { seen.set(id, seen.get(only)!); continue; }
    const bits = new Uint32Array(words);
    for (const p of op.parents) {
      const pb = seen.get(p)!;
      for (let w = 0; w < words; w++) bits[w] = bits[w]! | pb[w]!;
      const pi = index.get(p);
      if (pi !== undefined) bits[pi >>> 5] = bits[pi >>> 5]! | (1 << (pi & 31));
    }
    seen.set(id, bits);
  }
  const opSees = (id: string, target: string) => {
    if (id === target) return true;
    const i = index.get(target);
    return i !== undefined && ((seen.get(id)![i >>> 5]! >>> (i & 31)) & 1) === 1;
  };

  const genesis = order.filter((id) => get(id).kind === 'genesis' && get(id).parents.length === 0 && get(id).author === team);
  const root = genesis[0];

  // Full ancestor sets, only for the few ops the removal rule asks about.
  const fullAnc = new Map<string, Set<string>>();
  const ancestorsOf = (id: string): Set<string> => {
    let out = fullAnc.get(id);
    if (out) return out;
    out = new Set<string>();
    const stack = [...get(id).parents];
    while (stack.length) {
      const p = stack.pop()!;
      if (out.has(p)) continue;
      out.add(p);
      for (const q of get(p).parents) if (!out.has(q)) stack.push(q);
    }
    fullAnc.set(id, out);
    return out;
  };

  const run = (excluded: Set<string>) => {
    const s = emptyState(team);
    const valid = new Set<string>();
    const kept = new Set<string>();
    const count = new Map<string, number>();
    // Per person, the role-setting ops applied so far, in order: to find the role an author had seen.
    const roles = new Map<string, { id: string; role: Role }[]>();
    let lowTotal = 0;
    for (const id of order) {
      const op = get(id);
      if (op.kind === 'genesis') {
        if (id !== root) continue;
        if (!opSigned(op) || !apply(s, op, null)) continue;
        valid.add(id); kept.add(id);
        roles.set(op.person, [{ id, role: 'owner' }]);
        continue;
      }
      if (!root || !opSees(id, root) || excluded.has(id)) continue;
      const me = s.members.get(op.person);
      if (!me || !me.devices.has(op.author)) continue;
      const n = count.get(op.person) ?? 0;
      const capped = !atLeast(me.role, 'admin');
      if (capped && (n >= MAX_PERSON_OPS || lowTotal >= MAX_LOG_OPS)) continue;
      // The author must have seen their own device being granted and must not act above the role they had seen.
      const grant = me.grants.get(op.author);
      if (!grant || !opSees(id, grant)) continue;
      const history = roles.get(op.person) ?? [];
      let viewRole: Role | null = null;
      for (let i = history.length - 1; i >= 0; i--) if (opSees(id, history[i]!.id)) { viewRole = history[i]!.role; break; }
      if (!viewRole) continue;
      const role = lower(me.role, viewRole);
      if (!opSigned(op)) continue;
      const before = op.kind === 'add' ? (op.body as OpBody['add']).person : op.kind === 'role' ? (op.body as OpBody['role']).person : null;
      if (!apply(s, op, role)) continue;
      count.set(op.person, n + 1);
      if (capped) lowTotal++;
      valid.add(id);
      kept.add(id);
      if (before) {
        const target = s.members.get(before);
        if (target) {
          const list = op.kind === 'add' ? [] : roles.get(before) ?? [];
          list.push({ id, role: target.role });
          roles.set(before, list);
        }
      }
    }
    return { s, valid, kept };
  };

  let excluded = new Set<string>();
  let result = run(excluded);
  const keep = new Set(result.kept);
  for (let round = 0; round < 16; round++) {
    const byPerson = new Map<string, string[]>();
    for (const id of order) if (result.valid.has(id)) {
      const p = get(id).person;
      const list = byPerson.get(p) ?? [];
      list.push(id);
      byPerson.set(p, list);
    }
    // Removals and downgrades, in id order between themselves, leave out what the person did concurrently.
    const next = new Set(excluded);
    const revocations = order.filter((id) => {
      if (!result.valid.has(id)) return false;
      const op = get(id);
      return op.kind === 'remove' || op.kind === 'role';
    }).sort();
    for (const r of revocations) {
      if (next.has(r)) continue;
      const op = get(r);
      let person: string;
      let floor: number;
      if (op.kind === 'remove') { person = (op.body as OpBody['remove']).person; floor = 0; }
      else {
        person = (op.body as OpBody['role']).person;
        // Only a lowering counts; the role the op lowered from is what the person's concurrent ops may have used.
        const after = (op.body as OpBody['role']).role;
        floor = RANK[after];
        if (!(floor < 5)) continue;
      }
      const theirs = byPerson.get(person);
      if (!theirs) continue;
      const anc = ancestorsOf(r);
      for (const id of theirs) {
        if (id === r || next.has(id)) continue;
        if (anc.has(id) || opSees(id, r)) continue;
        if (op.kind === 'role' && RANK[needs(get(id))] <= floor) continue;
        next.add(id);
      }
    }
    if (next.size === excluded.size) break;
    excluded = next;
    result = run(excluded);
  }

  const { s: state, valid } = result;
  const children = new Set<string>();
  for (const id of order) for (const p of get(id).parents) children.add(p);
  const heads = order.filter((id) => !children.has(id) && keep.has(id));

  const atCache = new Map<string, TeamState | null>();
  const headsSet = (hs: readonly string[]) => (hs.every((h) => depth.has(h)) ? hs : null);
  return {
    state, valid, keep, order, heads, pending,
    sees(hs, target) {
      if (!headsSet(hs)) return null;
      return hs.some((h) => h === target || (index.has(target) ? opSees(h, target) : ancestorsOf(h).has(target)));
    },
    at(hs) {
      if (!headsSet(hs)) return null;
      const key = [...hs].sort().join(',');
      if (atCache.has(key)) return atCache.get(key)!;
      const anc = new Set<string>(hs);
      for (const h of hs) for (const a of ancestorsOf(h)) anc.add(a);
      const s = emptyState(team);
      for (const id of order) {
        if (!anc.has(id) || !valid.has(id)) continue;
        const op = get(id);
        const me = s.members.get(op.person);
        apply(s, op, op.kind === 'genesis' ? null : me?.role ?? null);
      }
      if (atCache.size > 64) atCache.clear();
      atCache.set(key, s);
      return s;
    },
  };
}
