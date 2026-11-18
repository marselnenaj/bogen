import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { BlockList, isIP, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { applyContent, BogenDoc, docToContent, Y } from '@bogen/core';
import { b64u, entropyFromPhrase, fingerprint, KEY_TEXT, newEd, newRecoveryPhrase, personKeyFromPhrase, phraseFromEntropy, safetyPhrase, unb64u } from './crypto.ts';
import { checkEnvelope, clientIdOf, envelopeId, envelopeSigned, envelopeSlot, MAX_WRITERS, sealUpdate, vouchFor, type Envelope } from './envelope.ts';
import { inviteId, inviteLink, joinProof, newInviteSecret, parseInvite, proofMatches, teamUrlOk } from './invite.ts';
import { atLeast, MAX_LEGACY_CLIENTS, MAX_PERSON_OPS, certify, certValid, makeOp, type DeviceCert, opShapeOk, replay, ROLES, type Op, type OpBody, type OpKind, type Replay, type Role } from './log.ts';
import { channelBinding, checkPeer, deviceCertificate, PEER_REASONS, SKEW_MS, tlsPost, TLS_KEY_ROTATE_MS, TLS_OPTIONS, type DeviceTls, type PeerDevice } from './tls.ts';
import { TeamStore, type Contact, type Identity, type TeamLocal, type Transports } from './store.ts';
import { randomBytes } from 'node:crypto';
import { setWriterProvider } from './writers.ts';
import { isTailnetAddress, tailscaleCommands, tailscaleIp } from '../tailnet.ts';
import { errorMessage, HttpError } from '../util.ts';

/**
 * Teams, Phase 1 (docs/teams.md): people work on the same files without accounts. Hidden behind the feature
 * `teams-1` until the commercial side is thought through; when it is off, nothing here listens, syncs or shows.
 *
 * Secure by default: no team listener runs until the person turns a connection on; every request between devices
 * is sealed to the receiving device and signed by the sender; only devices the membership log lists get anything
 * but a refusal, and only a live invite secret, proven and never sent, lets someone new in.
 */

export const FEATURE_TEAMS = 'teams-1';
export const teamsEnabled = (env: NodeJS.ProcessEnv = process.env) => (env.BOGEN_FEATURES ?? '').split(',').map((f) => f.trim()).includes(FEATURE_TEAMS);

const ROUTES = new Set(['/team/v2/join', '/team/v2/sync', '/team/v2/push']);
const MAX_BODY = 32 * 1024 * 1024;
/** A join comes from someone not in the team yet: it gets a small body and its own rate limit. */
const MAX_JOIN_BODY = 64 * 1024;
/** New ops one request may bring; the rest come with the next sync. */
const MAX_OPS_PER_REQUEST = 500;
/** Ops waiting for their parents, held in memory only. */
const MAX_PENDING_OPS = 1000;
const MAX_ACTIVE_REQUESTS = 16;
const MAX_CONNECTIONS_PER_ADDRESS = 8;
const MAX_BUDGET_KEYS = 10_000;
/** Ranges per author in a sync vector. */
const MAX_RANGES = 256;
/** A peer's ranges for one author, checked: up to MAX_RANGES [from, to] pairs (a plain number n means 1 to n). */
function heldRanges(raw: unknown): [number, number][] {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return [[1, raw]];
  if (!Array.isArray(raw)) return [];
  const out: [number, number][] = [];
  for (const r of raw.slice(0, MAX_RANGES)) {
    if (Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 1 && r[1] >= r[0]) out.push([r[0], r[1]]);
  }
  return out;
}
/** The key a rate limit counts by: the address, or for IPv6 its /64, which one machine can fill with addresses. */
export function addressKey(address: string): string {
  const a = address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  if (isIP(a) !== 6) return a;
  const [head = '', tail = ''] = a.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = a.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${full.slice(0, 4).map((h) => h.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
/** Requests one device may have in work at once. */
const MAX_ACTIVE_PER_SENDER = 4;
/** Refused envelopes remembered per file, so they are neither applied nor asked for again. */
const MAX_REFUSED_PER_FILE = 5000;
/** What one device may keep in one file's history, by role, and what one file's history may hold in all. */
const QUOTA_AUTHOR_EDIT = 256 * 1024 * 1024;
const QUOTA_AUTHOR_COMMENT = 8 * 1024 * 1024;
const QUOTA_FILE = 1024 * 1024 * 1024;
const JOIN_BUDGET = { count: 10, windowMs: 60_000 };
const BINDING = 'bogen-team-v2';
/** Addresses that listen on every interface: refused unless the person confirms it. */
/** Every spelling of "all interfaces" (0.0.0.0, ::, ::0, 0::, ::ffff:0.0.0.0 ...), by the parsed address. */
const ANY = new BlockList();
ANY.addAddress('0.0.0.0', 'ipv4');
ANY.addAddress('::', 'ipv6');
ANY.addAddress('::ffff:0.0.0.0', 'ipv6');
export function isAnyAddress(address: string): boolean {
  const v = isIP(address);
  return v === 4 ? ANY.check(address, 'ipv4') : v === 6 ? ANY.check(address, 'ipv6') : false;
}
const SYNC_MS = 30_000;
const PUSH_DELAY_MS = 300;

export interface TeamDeps {
  home: string;
  deviceName: () => string;
  /** The room of a file, loading it. */
  doc: (file: string) => Promise<Y.Doc>;
  /** A file exists here; create it under that id and name when not. */
  ensureFile: (file: string, name: string) => void;
  /** Whether a file with this id exists on this device already. */
  fileExists: (file: string) => boolean;
  fileName: (file: string) => string | undefined;
  /** Tailscale's view of who is behind an address, for the badge. */
  whois?: (address: string) => Promise<{ login: string } | null>;
  now?: () => number;
  /** A file just became a team file here: open editors ask for their writer ids again. */
  onTeamFile?: (file: string) => void;
  /** Changes to a team file that could not be signed are kept here, unsent: the editor says so. */
  onUnsent?: (file: string, count: number) => void;
  /**
   * Replaces this device's copy of a file with a whole state (the team's copy plus this device's rewritten
   * change): the loaded replica goes without saving, the state is written, and open editors load it again.
   */
  resetFile?: (file: string, state: Uint8Array) => Promise<void>;
}

interface Team { id: string; ops: Op[]; replay: Replay; envelopes: Map<string, Envelope[]>; seq: number; contacts: Record<string, Contact>;
  /** Envelopes checked and refused since start, by file and slot, so they are neither applied nor asked for again. */
  refused: Map<string, Map<string, string>>;
  /** Ops waiting for their parents, in memory only. */
  pending: Op[];
  /** Files this device took into this team (made or received here while no other file had the id). */
  accepted: Set<string>;
  /** Files of the team this device will not take: another file has the id here. */
  blocked: Set<string>;
  /** Who first wrote with each Yjs client id, per file, from accepted envelopes. */
  clients: Map<string, Map<number, string>>;
  /** Devices that sent two different updates under one number: nothing more is taken from them. */
  equivocators: Set<string>;
  /** Refused only as too late (outside the grace window): a vouched copy is looked at again. */
  late: Set<string>;
  /** Bytes of history kept, per file and author (`file|author`) and per file (`file`). */
  bytes: Map<string, number>;
  /** This device's writers per file: the Yjs id it handed out and the nonce it was derived from. */
  writers: Map<string, Map<number, string>>;
  /** Envelopes per file by slot (author:seq), so looking one up does not walk the whole history. */
  index: Map<string, Map<string, Envelope>>;
  /** Changes made here that could not be signed as this device's, per file: kept on disk, never dropped. */
  unsent: Map<string, Uint8Array[]> }

/** Admins and owners are not capped in replay, but this device stops short of what joining could still carry. */
const MAX_OWN_ADMIN_OPS = 15_000;
/** At most this much history goes out in one sync answer; the ranges let the next round continue. */
const MAX_SYNC_BYTES = 12 * 1024 * 1024;
/** Writer ids kept per file on this device; the oldest go first. */
const MAX_WRITERS_PER_FILE = 10_000;

export interface MemberView { person: string; name: string; role: Role; you: boolean; devices: { ed: string; name: string; fingerprint: string; login?: string; via?: string; lastSeen?: number }[] }
export interface TeamView {
  id: string; fingerprint: string; name: string; role: Role | null; members: MemberView[];
  invites: { id: string; role: Role; expires: number; uses: number; used: number }[];
  files: { id: string; name: string }[];
  removed: { person: string; at: number; now: boolean }[];
}

export class TeamService {
  readonly store: TeamStore;
  private identity!: Identity;
  private teams = new Map<string, Team>();
  private servers: Server[] = [];
  private tls!: DeviceTls;
  /** The newest TLS key seen per device: an older one (a key taken before a rotation) is not accepted again. */
  private tlsSeen = new Map<string, number>();
  private active = 0;
  private activeBy = new Map<string, number>();
  private joins = new Map<string, number[]>();
  private timer: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private outbox = new Map<string, Uint8Array[]>();
  private applying = false;
  private transports!: Transports;
  urls: string[] = [];

  constructor(private deps: TeamDeps) {
    this.store = new TeamStore(deps.home);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    this.identity = await this.store.identity(this.deps.deviceName());
    this.dropWriterProvider = setWriterProvider((file) => this.writerFor(file));
    await this.ensureTls();
    for (const [device, issued] of Object.entries(await this.store.tlsSeen())) this.tlsSeen.set(device, issued);
    this.transports = await this.store.transports();
    for (const id of await this.store.teams()) await this.load(id);
    await this.listen();
    this.timer = setInterval(() => void this.syncAll(), SYNC_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    await this.flushOutbox();
    this.dropWriterProvider();
    await Promise.all(this.servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    this.servers = [];
  }

  private async load(id: string): Promise<Team> {
    const stored = await this.store.log(id);
    // Only ops that can count are kept: a log full of garbage from before (or from an older build) is pruned.
    let r = replay(id, stored);
    const ops = stored.filter((o) => r.keep.has(o?.id));
    if (ops.length !== stored.length) {
      console.error(`bogen: team ${fingerprint(id)}: dropped ${stored.length - ops.length} op(s) that cannot count`);
      r = replay(id, ops);
      await this.store.saveLog(id, ops);
    }
    const files = await this.store.files(id);
    const local = await this.store.local(id);
    const team: Team = { id, ops, replay: r, envelopes: new Map(), seq: local.seq, contacts: await this.store.contacts(id), refused: new Map(), pending: [], accepted: new Set(files.accepted), blocked: new Set(), clients: new Map(), equivocators: new Set(), late: new Set(), bytes: new Map(), writers: new Map(), index: new Map(), unsent: new Map() };
    for (const file of await this.store.unsentFiles(id)) {
      const list = await this.store.unsent(id, file);
      if (list.length) team.unsent.set(file, list);
    }
    for (const [file, map] of Object.entries(local.writers)) team.writers.set(file, new Map(Object.entries(map).map(([k, v]) => [Number(k), v])));
    for (const file of team.replay.state.files.keys()) {
      const list = await this.store.envelopes(id, file);
      for (const e of list) this.countBytes(team, e);
      this.setEnvelopes(team, file, list);
      // Files received before this list existed were taken into this team then.
      if (list.length && !files.accepted.includes(file) && !this.acceptedElsewhere(file, id)) team.accepted.add(file);
      for (const e of list) if (e.author === this.identity.device.ed.pub) team.seq = Math.max(team.seq, e.seq);
    }
    this.teams.set(id, team);
    await this.store.saveFiles(id, { accepted: [...team.accepted] });
    await this.saveLocal(team);
    return team;
  }

  private setEnvelopes(t: Team, file: string, list: Envelope[]): void {
    t.envelopes.set(file, list);
    const index = new Map<string, Envelope>();
    for (const e of list) index.set(envelopeSlot(e), e);
    t.index.set(file, index);
  }
  private pushEnvelope(t: Team, file: string, env: Envelope): void {
    const list = t.envelopes.get(file) ?? [];
    list.push(env);
    t.envelopes.set(file, list);
    const index = t.index.get(file) ?? new Map<string, Envelope>();
    index.set(envelopeSlot(env), env);
    t.index.set(file, index);
  }

  private async saveLocal(t: Team): Promise<void> {
    const writers: TeamLocal['writers'] = {};
    for (const [file, map] of t.writers) writers[file] = Object.fromEntries([...map].map(([k, v]) => [String(k), v]));
    await this.store.saveLocal(t.id, { seq: t.seq, writers });
  }

  // ---- Writers: the Yjs ids local writers of a team file use -----------------------------------------------

  /**
   * A new Yjs id for a local writer of a team file (a room, an editor tab, a private copy a tool writes into),
   * derived from this device's key and a fresh nonce, so every member can tell it is this device's (N6). Null for
   * a file that is in no team here: those keep Yjs's own random ids.
   */
  writerFor(file: string): number | null {
    if (!this.identity) return null;
    const id = this.teamOf(file);
    const t = id ? this.teams.get(id) : undefined;
    if (!t || !t.accepted.has(file)) return null;
    const nonce = b64u(randomBytes(16));
    const clientId = clientIdOf(this.identity.device.ed.pub, nonce);
    const map = t.writers.get(file) ?? new Map<number, string>();
    map.set(clientId, nonce);
    while (map.size > MAX_WRITERS_PER_FILE) map.delete(map.keys().next().value as number);
    t.writers.set(file, map);
    void this.saveLocal(t).catch((e) => console.error(`bogen: could not save team writers: ${errorMessage(e)}`));
    return clientId;
  }

  /** For an editor tab: the id to write with now, and a spare for the next time it opens (or loses its id). */
  async writerIds(file: string): Promise<{ clientID: number | null; spare: number | null }> {
    const clientID = this.writerFor(file);
    return { clientID, spare: clientID === null ? null : this.writerFor(file) };
  }

  private isWriter(file: string, clientId: number): boolean {
    const id = this.teamOf(file);
    return Boolean(id && this.teams.get(id)?.writers.get(file)?.has(clientId));
  }

  private bound = new WeakSet<Y.Doc>();
  private dropWriterProvider: () => void = () => {};
  /**
   * Gives a document of a team file (the room on this device) a writer id, and a new one whenever it loses it:
   * Yjs picks a random id when a remote change advances its own (yjs Doc, "Changed the client-id"), and changes
   * made with a random id could not be signed as this device's.
   */
  bindDoc(file: string, doc: Y.Doc): void {
    if (!this.teamOf(file)) return;
    const own = this.writerFor(file);
    if (own === null) return;
    if (!this.isWriter(file, doc.clientID)) doc.clientID = own;
    if (this.bound.has(doc)) return;
    this.bound.add(doc);
    doc.on('afterTransactionCleanup', () => {
      if (!this.teamOf(file) || this.isWriter(file, doc.clientID)) return;
      const next = this.writerFor(file);
      if (next !== null) doc.clientID = next;
    });
  }

  private acceptedElsewhere(file: string, except: string): boolean {
    for (const t of this.teams.values()) if (t.id !== except && t.accepted.has(file)) return true;
    return false;
  }

  private me(): string {
    return this.identity.personPub;
  }

  // ---- What the editor sees -------------------------------------------------------------------------------

  view(): { me: { person: string; name: string; device: string; deviceX: string; holdsPersonKey: boolean; phraseConfirmed: boolean; keyStorage: string }; teams: TeamView[]; transports: Transports; urls: string[] } {
    const teams: TeamView[] = [];
    for (const t of this.teams.values()) {
      const s = t.replay.state;
      teams.push({
        id: t.id, fingerprint: fingerprint(t.id), name: s.name, role: s.members.get(this.me())?.role ?? null,
        members: [...s.members.values()].map((m) => ({
          person: m.person, name: m.name, role: m.role, you: m.person === this.me(),
          devices: [...m.devices.values()].map((d) => ({ ed: d.ed, name: d.name, fingerprint: fingerprint(d.ed), ...(t.contacts[d.ed]?.login ? { login: t.contacts[d.ed]!.login } : {}), ...(t.contacts[d.ed]?.via ? { via: t.contacts[d.ed]!.via } : {}), ...(t.contacts[d.ed]?.lastSeen ? { lastSeen: t.contacts[d.ed]!.lastSeen } : {}) })),
        })),
        invites: [...s.invites.values()].filter((i) => !i.revoked && i.used < i.uses && i.expires > this.now()).map((i) => ({ id: i.id, role: i.role, expires: i.expires, uses: i.uses, used: i.used })),
        files: [...s.files].map(([id, name]) => ({ id, name: this.deps.fileName(id) ?? name })),
        removed: [...s.removed.values()].map((r) => ({ person: r.person, at: r.time, now: r.now })),
      });
    }
    return {
      me: { person: this.identity.personPub, name: this.identity.personName, device: this.identity.device.ed.pub, deviceX: this.identity.device.x.pub, holdsPersonKey: Boolean(this.identity.person), phraseConfirmed: this.identity.phraseConfirmed, keyStorage: this.store.keyStorage },
      teams, transports: this.transports, urls: this.urls,
    };
  }

  /** The one team this device shares a file with: the team it took the file into, while the team still has it. */
  teamOf(file: string): string | null {
    for (const t of this.teams.values()) if (t.accepted.has(file) && t.replay.state.files.has(file)) return t.id;
    return null;
  }

  // ---- Making and changing teams --------------------------------------------------------------------------

  /** Makes the person key on first use and gives back the 12 words once. Owners must confirm three of them. */
  private assertUnlocked(): void {
    if (this.store.keyStorage === 'locked') throw new HttpError(409, 'Your person key is locked in the system keyring. Unlock the keyring and restart Bogen, then try again.');
  }
  private ensurePerson(name: string): string[] | null {
    this.assertUnlocked();
    if (this.identity.personPub) return this.pendingPhrase();
    const words = newRecoveryPhrase();
    this.identity.person = personKeyFromPhrase(words);
    this.identity.personPub = this.identity.person.pub;
    this.identity.personName = name;
    this.identity.phraseConfirmed = false;
    // Kept (encrypted with the person key) until confirmed, so a failed join or a closed window does not lose it.
    this.identity.pendingPhrase = b64u(entropyFromPhrase(words));
    return words;
  }

  /** The recovery phrase again, on this device only, until it is confirmed. */
  pendingPhrase(): string[] | null {
    if (this.identity.phraseConfirmed || !this.identity.pendingPhrase) return null;
    try {
      return phraseFromEntropy(unb64u(this.identity.pendingPhrase));
    } catch {
      return null;
    }
  }

  private cert() {
    if (!this.identity.person) throw new HttpError(409, 'This device does not hold your person key. Add it from the device that does.');
    return certify(this.identity.person, { ed: this.identity.device.ed.pub, x: this.identity.device.x.pub, name: this.identity.deviceName });
  }

  async create(name: string, yourName: string): Promise<{ team: string; phrase: string[] | null }> {
    const phrase = this.ensurePerson(yourName.trim() || this.identity.deviceName);
    const teamKey = newEd();
    const genesis = makeOp(teamKey.pub, [], { ed: teamKey }, this.me(), 'genesis', { name: name.trim(), owner: { person: this.me(), name: this.identity.personName, certs: [this.cert()] } }, this.now());
    // The team key signed the genesis and is not needed again: nobody, not even its maker, can sign a second one.
    await this.store.saveIdentity(this.identity);
    await this.store.saveLog(teamKey.pub, [genesis]);
    const team = await this.load(teamKey.pub);
    if (!team.replay.valid.has(genesis.id)) throw new Error('The new team did not check out.');
    return { team: teamKey.pub, phrase };
  }

  /** Three words of the phrase, by position (0 to 11), to prove they were written down. */
  async confirmPhrase(words: Record<string, string>): Promise<void> {
    if (!this.identity.person) throw new HttpError(409, 'This device does not hold your person key.');
    const entries = Object.entries(words);
    if (entries.length < 3) throw new HttpError(400, 'Give three words.');
    // The phrase is not stored; check by deriving the key from a phrase with these words is not possible without
    // all twelve, so the editor sends all twelve as typed, and three positions are what the person was asked for.
    const all = entries.length === 12 ? entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, w]) => w) : null;
    if (!all) throw new HttpError(400, 'Type the whole phrase to confirm it.');
    let derived: string;
    try {
      derived = personKeyFromPhrase(all).pub;
    } catch (e) {
      throw new HttpError(400, errorMessage(e));
    }
    if (derived !== this.identity.personPub) throw new HttpError(400, 'Those words give a different key. Check what you wrote down.');
    this.identity.phraseConfirmed = true;
    delete this.identity.pendingPhrase;
    await this.store.saveIdentity(this.identity);
  }

  private team(id: string): Team {
    const t = this.teams.get(id) ?? [...this.teams.values()].find((x) => fingerprint(x.id) === id);
    if (!t) throw new HttpError(404, 'No such team on this device.');
    return t;
  }

  private async append<K extends OpKind>(t: Team, kind: K, body: OpBody[K]): Promise<Op<K>> {
    const mine0 = t.replay.state.members.get(this.me());
    if (mine0 && atLeast(mine0.role, 'admin') && t.ops.filter((o) => o.person === this.me()).length >= MAX_OWN_ADMIN_OPS) {
      // Not a rule of the team (replay counts admins freely), a limit of this device: past it a log could grow
      // beyond what a joining device takes in one answer.
      throw new HttpError(409, 'This team has had very many membership changes from you. Before more, ask for help: the team log is close to what a joining device can take.');
    }
    const op = makeOp(t.id, t.replay.heads, this.identity.device, this.me(), kind, body, this.now());
    const next = replay(t.id, [...t.ops, op]);
    if (!next.valid.has(op.id)) {
      const mine = t.replay.state.members.get(this.me());
      const ownCount = t.ops.filter((o) => o.person === this.me() && t.replay.valid.has(o.id)).length;
      if (mine && !atLeast(mine.role, 'admin') && ownCount >= MAX_PERSON_OPS) throw new HttpError(409, 'You have made as many membership changes in this team as a member without admin rights can. Ask an admin.');
      throw new HttpError(403, 'Your role in this team does not allow that.');
    }
    // Valid can still change nothing (removing someone already gone): say so instead of claiming it happened.
    t.ops.push(op);
    t.replay = next;
    await this.store.saveLog(t.id, t.ops);
    this.schedulePush();
    return op;
  }

  async invite(teamId: string, role: Role, days = 7, uses = 1): Promise<{ link: string; id: string; expires: number }> {
    const t = this.team(teamId);
    if (!ROLES.includes(role) || role === 'owner') throw new HttpError(400, 'Invite as admin, edit, comment or view.');
    const mine = t.replay.state.members.get(this.me())?.role;
    if (mine === 'owner' && !this.identity.phraseConfirmed) throw new HttpError(409, 'Write down your recovery phrase and confirm it first. Owners need it, so the team cannot be lost with one device.');
    const urls = this.urls;
    if (!urls.length) throw new HttpError(409, 'Turn on a connection first (Settings, Connections): nothing could reach you yet.');
    const secret = newInviteSecret();
    const id = inviteId(secret);
    const expires = this.now() + Math.max(1, Math.min(30, days)) * 86_400_000;
    await this.append(t, 'invite', { id, role, expires, uses: Math.max(1, Math.min(100, Math.round(uses))) });
    const secrets = await this.store.secrets(t.id);
    secrets[id] = b64u(secret);
    await this.store.saveSecrets(t.id, secrets);
    const link = inviteLink(secret, { team: t.id, name: t.replay.state.name, device: { ed: this.identity.device.ed.pub, x: this.identity.device.x.pub }, urls, role, by: this.identity.personName, expires });
    return { link, id, expires };
  }

  async revokeInvite(teamId: string, id: string): Promise<void> {
    await this.append(this.team(teamId), 'invite-revoke', { id });
  }

  async remove(teamId: string, person: string, now: boolean): Promise<void> {
    await this.append(this.team(teamId), 'remove', { person, now });
  }

  async setRole(teamId: string, person: string, role: Role): Promise<void> {
    await this.append(this.team(teamId), 'role', { person, role });
  }

  async addFile(teamId: string, file: string): Promise<void> {
    if (this.teamOf(file) || [...this.teams.values()].some((x) => x.accepted.has(file) || x.replay.state.files.has(file))) throw new HttpError(409, 'That file is in a team already. Duplicate it to share it elsewhere.');
    const t = this.team(teamId);
    // The file's current state becomes this device's first envelope, so members get it whole. Its history was
    // written with Yjs ids nobody can derive; they go into the file-add op with their clocks (legacy), taken in the
    // same moment as the state, and belong to you up to there. Everything after is written with derived ids.
    const doc = await this.deps.doc(file);
    const full = Y.encodeStateAsUpdate(doc);
    const legacy = [...Y.decodeStateVector(Y.encodeStateVector(doc))] as [number, number][];
    if (legacy.length > MAX_LEGACY_CLIENTS) throw new HttpError(409, 'This file has been written by too many sessions to share as it is. Duplicate it and share the copy.');
    await this.append(t, 'file-add', { file, name: this.deps.fileName(file) ?? file, legacy });
    t.accepted.add(file);
    await this.store.saveFiles(t.id, { accepted: [...t.accepted] });
    this.bindDoc(file, doc);
    this.deps.onTeamFile?.(file);
    await this.signLocal(t, file, [full]);
  }

  safety(teamId: string, person: string): string[] {
    return safetyPhrase(this.team(teamId).id, person);
  }

  // ---- Your own devices ----------------------------------------------------------------------------------

  /** What this device tells your other paired devices about itself, so they can vouch for it. */
  card(): { ed: string; x: string; name: string; person: string } {
    return { ed: this.identity.device.ed.pub, x: this.identity.device.x.pub, name: this.identity.deviceName, person: this.identity.personPub };
  }

  /**
   * Today's paired devices become your devices in every team you are in: this device, holding your person key,
   * vouches for each and adds it. The device then gets the log over the existing, authenticated device link.
   */
  async addDevices(cards: { ed: string; x: string; name: string; person: string }[], adopt: (card: { ed: string }, body: unknown) => Promise<void>): Promise<number> {
    if (!this.identity.person) return 0;
    let added = 0;
    for (const t of this.teams.values()) {
      const me = t.replay.state.members.get(this.me());
      if (!me) continue;
      for (const card of cards) {
        if (!KEY_TEXT.test(card.ed) || !KEY_TEXT.test(card.x) || (card.person && card.person !== this.me())) continue;
        if (!me.devices.has(card.ed)) {
          const cert = certify(this.identity.person, { ed: card.ed, x: card.x, name: String(card.name).slice(0, 100) || 'Device' });
          await this.append(t, 'device-add', { cert });
          added++;
        }
        await adopt(card, { team: t.id, ops: t.ops, person: this.me(), personName: this.identity.personName, urls: this.urls }).catch(() => {});
      }
    }
    return added;
  }

  /** Another of your devices hands over a team this device was added to. */
  async adopt(body: unknown): Promise<void> {
    const b = body as { team?: string; ops?: Op[]; person?: string; personName?: string; urls?: string[] };
    if (!b || !KEY_TEXT.test(String(b.team)) || !Array.isArray(b.ops)) throw new HttpError(400, 'Not a team.');
    const r = replay(String(b.team), b.ops);
    const member = r.state.members.get(String(b.person));
    if (!member?.devices.has(this.identity.device.ed.pub)) throw new HttpError(403, 'This device is not in that team.');
    if (this.identity.personPub && this.identity.personPub !== b.person) throw new HttpError(409, 'This device belongs to another person.');
    if (!this.identity.personPub) {
      this.identity.personPub = String(b.person);
      this.identity.personName = String(b.personName ?? member.name).slice(0, 100);
      await this.store.saveIdentity(this.identity);
    }
    const existing = this.teams.get(String(b.team));
    if (existing) await this.takeOps(existing, b.ops);
    else {
      await this.store.saveLog(String(b.team), b.ops);
      await this.load(String(b.team));
    }
  }

  // ---- Joining --------------------------------------------------------------------------------------------

  async join(link: string, yourName: string): Promise<{ team: string; phrase: string[] | null }> {
    this.assertUnlocked();
    const invite = parseInvite(link);
    if (invite.hints.expires < this.now()) throw new HttpError(410, 'This invite has expired. Ask for a new one.');
    if (this.teams.get(invite.hints.team)?.replay.state.members.has(this.me())) throw new HttpError(409, 'You are in this team already.');
    const phrase = this.ensurePerson(yourName.trim() || this.identity.deviceName);
    await this.store.saveIdentity(this.identity);
    let lastError = 'No address in the invite answered.';
    for (const url of invite.hints.urls) {
      try {
        // The proof is bound to this TLS connection: captured, it is worth nothing on another one.
        const reply = await this.call<{ ops: Op[] }>(url, invite.hints.device.ed, '/team/v2/join', (binding) => ({
          team: invite.hints.team, invite: invite.id, person: this.me(), name: this.identity.personName, cert: this.cert(),
          proof: joinProof(invite.secret, this.me(), this.identity.device.ed.pub, binding), urls: this.urls,
        }));
        const ops = Array.isArray(reply.ops) ? reply.ops.slice(0, 20_000) : [];
        const r = replay(invite.hints.team, ops);
        if (!r.state.members.has(this.me())) throw new Error('The team did not add you.');
        await this.store.saveLog(invite.hints.team, ops.filter((o) => r.keep.has(o?.id)));
        const t = await this.load(invite.hints.team);
        t.contacts[invite.hints.device.ed] = { urls: [url], lastSeen: this.now() };
        await this.store.saveContacts(t.id, t.contacts);
        void this.syncTeam(t);
        return { team: t.id, phrase };
      } catch (e) {
        lastError = errorMessage(e);
      }
    }
    // The person key and its phrase stay: shown again until confirmed (pendingPhrase), so trying again works.
    throw new HttpError(502, lastError);
  }

  // ---- Local edits ----------------------------------------------------------------------------------------

  /** Every update of a room. Updates from members carry the origin `team:` and are not signed again. */
  onRoomUpdate(file: string, update: Uint8Array, origin: unknown): void {
    // Changes that came from a member (team:) or from another of your devices (peer:) are not this device's to
    // sign: that device signs its own, and members' changes travel in their own envelopes.
    if (this.applying || (typeof origin === 'string' && (origin.startsWith('team:') || origin.startsWith('peer:')))) return;
    const id = this.teamOf(file);
    if (!id) return;
    const role = this.teams.get(id)!.replay.state.members.get(this.me())?.role;
    if (!atLeast(role, 'comment')) return;
    const key = `${id}|${file}`;
    const list = this.outbox.get(key) ?? [];
    list.push(update);
    this.outbox.set(key, list);
    if (!this.pushTimer) {
      this.pushTimer = setTimeout(() => {
        this.pushTimer = null;
        void this.flushOutbox().then(() => this.syncAll());
      }, PUSH_DELAY_MS);
      this.pushTimer.unref();
    }
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.flushOutbox().then(() => this.syncAll());
    }, PUSH_DELAY_MS);
    this.pushTimer.unref();
  }

  async flushOutbox(): Promise<void> {
    const batches = [...this.outbox];
    this.outbox.clear();
    for (const [key, updates] of batches) {
      const [teamId, file] = key.split('|') as [string, string];
      const t = this.teams.get(teamId);
      if (!t) continue;
      // A comment-only member's updates go one by one: one that touches more than comments is refused by the
      // others, and merging it in would take the comments down with it.
      if (t.replay.state.members.get(this.me())?.role === 'comment') for (const u of updates) await this.signLocal(t, file, [u]);
      else await this.signLocal(t, file, updates);
    }
  }

  /**
   * The nonces an update needs named for members to accept it as this device's: one per Yjs id it writes with (and
   * deletes with, for a comment-only member). Null when it writes with an id that is neither one of this device's
   * writers nor history the file brought in with you: nobody would accept it, so it is not sent.
   */
  private writersOf(t: Team, file: string, update: Uint8Array): string[] | null {
    const mine = t.writers.get(file);
    const legacy = t.replay.state.legacy.get(file);
    const nonces = new Set<string>();
    let decoded: ReturnType<typeof Y.decodeUpdate>;
    try {
      decoded = Y.decodeUpdate(update);
    } catch {
      return null;
    }
    for (const st of decoded.structs) {
      const nonce = mine?.get(st.id.client);
      if (nonce) { nonces.add(nonce); continue; }
      const until = legacy && legacy.person === this.me() ? legacy.sv.get(st.id.client) : undefined;
      if (until !== undefined && st.id.clock + st.length <= until) continue;
      return null;
    }
    for (const client of decoded.ds.clients.keys()) {
      const nonce = mine?.get(client);
      if (nonce) nonces.add(nonce);
    }
    return [...nonces];
  }

  private async signLocal(t: Team, file: string, updates: Uint8Array[]): Promise<void> {
    // Batches whose writers fit one envelope; an update nobody would accept stays here and is said so.
    const batches: { updates: Uint8Array[]; writers: Set<string> }[] = [];
    const unsigned: Uint8Array[] = [];
    for (const u of updates) {
      const writers = this.writersOf(t, file, u);
      if (!writers) {
        // Never dropped: kept on disk and shown in the editor, until it can be signed or the person lets it go.
        unsigned.push(u);
        continue;
      }
      const last = batches[batches.length - 1];
      const union = last ? new Set([...last.writers, ...writers]) : null;
      if (last && union!.size <= MAX_WRITERS) { last.updates.push(u); last.writers = union!; }
      else batches.push({ updates: [u], writers: new Set(writers) });
    }
    for (const b of batches) {
      const merged = b.updates.length === 1 ? b.updates[0]! : Y.mergeUpdates(b.updates);
      t.seq += 1;
      // The number is kept before the envelope, so a crash in between skips a number instead of reusing one.
      await this.saveLocal(t);
      const env = sealUpdate(this.identity.device, this.me(), t.id, file, t.seq, t.replay.heads, merged, this.now(), [...b.writers]);
      this.claimClients(t, file, env.person, merged);
      this.pushEnvelope(t, file, env);
      this.countBytes(t, env);
      await this.store.appendEnvelopes(t.id, file, [env]);
    }
    if (unsigned.length) await this.keepUnsent(t, file, unsigned);
  }

  private async keepUnsent(t: Team, file: string, more: Uint8Array[]): Promise<void> {
    const list = [...(t.unsent.get(file) ?? []), ...more];
    // One merged update keeps the list short; merging never loses a change.
    const kept = list.length > 1 ? [Y.mergeUpdates(list)] : list;
    t.unsent.set(file, kept);
    await this.store.saveUnsent(t.id, file, kept);
    console.error(`bogen: a change to ${file} was written with a Yjs id this device did not hand out; it is kept on this device, not sent, and the editor says so`);
    this.deps.onUnsent?.(file, kept.length);
  }

  /** How many kept, unsent changes a team file has on this device (0 when none, or not a team file). */
  unsentCount(file: string): number {
    const id = this.teamOf(file);
    return id ? (this.teams.get(id)?.unsent.get(file)?.length ?? 0) : 0;
  }

  /**
   * Tries the kept changes of a file again. Those that can be signed now go out as they are; the rest are written
   * anew as this device's (rewriteUnsent), so members get the same design. Returns how many stay unsent (0 on
   * success).
   */
  async retryUnsent(file: string): Promise<number> {
    const id = this.teamOf(file);
    const t = id ? this.teams.get(id) : undefined;
    const list = t?.unsent.get(file);
    if (!t || !list?.length) return 0;
    t.unsent.delete(file);
    await this.store.saveUnsent(t.id, file, []);
    const still = list.filter((u) => !this.writersOf(t, file, u));
    const signable = list.filter((u) => this.writersOf(t, file, u));
    if (signable.length) await this.signLocal(t, file, signable);
    if (still.length) await this.rewriteUnsent(t, file, still);
    await this.flushOutbox();
    this.schedulePush();
    return this.unsentCount(file);
  }

  /** Lets kept changes go: they stay in this device's copy of the file, and the team never sees them. */
  async dropUnsent(file: string): Promise<void> {
    const id = this.teamOf(file);
    const t = id ? this.teams.get(id) : undefined;
    if (!t) return;
    t.unsent.delete(file);
    await this.store.saveUnsent(t.id, file, []);
    this.deps.onUnsent?.(file, 0);
  }

  /**
   * Writes unsigned changes anew as this device's. The team's copy of the file (every signed envelope, starting
   * with the full state the file was shared with) is rebuilt in a private document written with a fresh writer id
   * of this device; the design as this device has it is laid onto that copy value by value; what that writes is
   * signed and sent. Then this device's copy of the file is replaced by the team's copy plus that change, so the
   * unsigned items are gone here too (a later edit next to them could not reach anyone), and open editors reload.
   */
  private async rewriteUnsent(t: Team, file: string, list: Uint8Array[]): Promise<void> {
    const own = this.writerFor(file);
    if (own === null || !this.deps.resetFile) {
      await this.keepUnsent(t, file, list);
      return;
    }
    const room = await this.deps.doc(file);
    const team = new Y.Doc();
    for (const e of t.envelopes.get(file) ?? []) {
      try { Y.applyUpdate(team, unb64u(e.update)); } catch { /* not part of the team's copy */ }
    }
    team.clientID = own;
    const content = docToContent(new BogenDoc(room));
    const before = Y.encodeStateVector(team);
    applyContent(new BogenDoc(team), content, 'team-rewrite');
    const update = Y.encodeStateAsUpdate(team, before);
    await this.signLocal(t, file, [update]);
    await this.deps.resetFile(file, Y.encodeStateAsUpdate(team));
    team.destroy();
    this.deps.onUnsent?.(file, this.unsentCount(file));
  }

  /**
   * Writer ids ahead of time for every team file this device writes, one per file, for a phone (or a tab) to keep:
   * a team file opened offline later, even one never opened before, then writes with one of this device's ids.
   */
  spares(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of this.teams.values()) for (const file of t.accepted) {
      if (!t.replay.state.files.has(file)) continue;
      const id = this.writerFor(file);
      if (id !== null) out[file] = id;
    }
    return out;
  }

  // ---- Receiving ------------------------------------------------------------------------------------------

  /**
   * Takes ops from another device. Only ops that can count are kept: by a member device (or one an op in the
   * same batch adds), within the per-request and per-log caps, and passing the replay's checks. Ops waiting
   * for their parents wait in memory; everything else is dropped, never stored or passed on.
   */
  private async takeOps(t: Team, ops: unknown): Promise<void> {
    if (!Array.isArray(ops) || !ops.length) return;
    const known = new Set(t.ops.map((o) => o.id));
    const authors = new Set<string>();
    for (const m of t.replay.state.members.values()) for (const d of m.devices.keys()) authors.add(d);
    const fresh: Op[] = [];
    const seen = new Set<string>();
    // Devices named by adds and device-adds in this batch may author too (a new member's first ops).
    for (const o of ops.slice(0, 20_000) as Op[]) {
      if (!o || typeof o !== 'object' || typeof o.id !== 'string') continue;
      if (o.kind === 'add' && Array.isArray((o.body as OpBody['add'])?.certs)) for (const c of (o.body as OpBody['add']).certs) if (c?.device?.ed) authors.add(c.device.ed);
      if (o.kind === 'device-add' && (o.body as OpBody['device-add'])?.cert?.device?.ed) authors.add((o.body as OpBody['device-add']).cert.device.ed);
    }
    for (const o of ops.slice(0, 20_000) as Op[]) {
      if (fresh.length >= MAX_OPS_PER_REQUEST) break;
      if (!o || typeof o.id !== 'string' || known.has(o.id) || seen.has(o.id)) continue;
      if (!authors.has(o.author) && o.kind !== 'genesis') continue;
      if (!opShapeOk(o, t.id)) continue;
      seen.add(o.id);
      fresh.push(o);
    }
    const waiting = t.pending.filter((o) => !known.has(o.id) && !seen.has(o.id));
    if (!fresh.length) return;
    const next = replay(t.id, [...t.ops, ...waiting, ...fresh]);
    const kept = [...waiting, ...fresh].filter((o) => next.keep.has(o.id));
    t.pending = [...waiting, ...fresh].filter((o) => next.pending.includes(o.id)).slice(-MAX_PENDING_OPS);
    if (!kept.length) return;
    t.ops.push(...kept);
    t.replay = next.pending.length ? replay(t.id, t.ops) : next;
    await this.store.saveLog(t.id, t.ops);
    for (const file of t.replay.state.files.keys()) if (!t.envelopes.has(file)) { const list = await this.store.envelopes(t.id, file); for (const e of list) this.countBytes(t, e); this.setEnvelopes(t, file, list); }
  }

  /** Records who first wrote with each Yjs client id of an update, in this file. */
  private claimClients(t: Team, file: string, person: string, update: Uint8Array): void {
    const map = this.clientMap(t, file);
    try {
      for (const s of Y.decodeUpdate(update).structs) if (!map.has(s.id.client)) map.set(s.id.client, person);
    } catch {
      // A local update always decodes; a stored one that does not is ignored here.
    }
  }
  private clientMap(t: Team, file: string): Map<number, string> {
    let map = t.clients.get(file);
    if (map) return map;
    map = new Map();
    t.clients.set(file, map);
    for (const e of t.envelopes.get(file) ?? []) {
      try {
        for (const s of Y.decodeUpdate(unb64u(e.update)).structs) if (!map.has(s.id.client)) map.set(s.id.client, e.person);
      } catch {
        // Skip what does not decode.
      }
    }
    return map;
  }

  /** Checks envelopes and applies the good ones. Returns what was refused and why, for the log. */
  async takeEnvelopes(t: Team, list: unknown): Promise<{ applied: number; refused: { id: string; reason: string }[] }> {
    const out = { applied: 0, refused: [] as { id: string; reason: string }[] };
    if (!Array.isArray(list)) return out;
    for (const env of list.slice(0, 20_000) as Envelope[]) {
      if (!env || typeof env.file !== 'string' || typeof env.author !== 'string' || typeof env.update !== 'string' || !Number.isInteger(env.seq)) continue;
      const slot = envelopeSlot(env);
      if (t.equivocators.has(env.author)) {
        // Final: held as refused, so peers stop offering it on every sync.
        if (t.replay.state.deviceOwner.has(env.author)) this.refuseFinal(t, env.file, slot, envelopeId(env));
        continue;
      }
      const id = envelopeId(env);
      const same = t.index.get(env.file)?.get(slot);
      if (same && envelopeId(same) === id) continue;
      const seen = t.refused.get(env.file);
      // Refused as too late, but now with a vouch: looked at again, so a bogus vouch earlier does not stand.
      if (seen?.get(slot) === id && !(env.vouch && t.late.has(`${env.file}|${slot}`))) continue;
      // The signature first: an envelope its author did not sign can neither frame that author nor take a slot.
      if (!envelopeSigned(env, t.id)) { out.refused.push({ id: slot.slice(0, 120), reason: 'the signature does not match' }); continue; }
      if (same || (seen?.has(slot) && seen.get(slot) !== id)) {
        // Two different updates, both signed by the author, under one number: it tells peers different things.
        const other = same ?? null;
        t.equivocators.add(env.author);
        if (other) await this.store.appendEvidence(t.id, other, env).catch(() => {});
        out.refused.push({ id, reason: 'two different changes under one number; nothing more is taken from that device' });
        continue;
      }
      const fileName = t.replay.state.files.get(env.file);
      if (fileName === undefined) { out.refused.push({ id, reason: 'that file is not in the team' }); continue; }
      if (!t.accepted.has(env.file)) {
        // A file of the team that this device has not taken yet: take it only when nothing here has that id.
        if (t.blocked.has(env.file)) continue;
        if (this.deps.fileExists(env.file) || this.acceptedElsewhere(env.file, t.id)) {
          t.blocked.add(env.file);
          out.refused.push({ id, reason: 'a file with that id is already on this device and was never shared with this team; it is left alone' });
          continue;
        }
        this.deps.ensureFile(env.file, fileName);
        t.accepted.add(env.file);
        await this.store.saveFiles(t.id, { accepted: [...t.accepted] });
        this.deps.onTeamFile?.(env.file);
      }
      const doc = await this.deps.doc(env.file);
      // The room was loaded before the file was this team's: from now on it writes with this device's ids.
      this.bindDoc(env.file, doc);
      const verdict = checkEnvelope(env, t.replay, doc, this.now(), { clientOwner: this.clientMap(t, env.file) });
      if (!verdict.ok) {
        out.refused.push({ id, reason: verdict.reason });
        // Waiting on something this device has not seen is not a refusal: it comes again with the next sync.
        // Remembered only for a device the team knows, and only so many per file: strangers' keys fill nothing.
        const known = t.replay.state.deviceOwner.has(env.author) || t.replay.state.removed.has(env.person);
        if (!verdict.retry && known && (seen?.size ?? 0) < MAX_REFUSED_PER_FILE) {
          const map = seen ?? new Map<string, string>();
          map.set(slot, id);
          t.refused.set(env.file, map);
          if (verdict.late && t.late.size < MAX_REFUSED_PER_FILE) t.late.add(`${env.file}|${slot}`);
        }
        continue;
      }
      const quota = atLeast(verdict.role, 'edit') ? QUOTA_AUTHOR_EDIT : QUOTA_AUTHOR_COMMENT;
      if ((t.bytes.get(`${env.file}|${env.author}`) ?? 0) + env.update.length > quota || (t.bytes.get(env.file) ?? 0) + env.update.length > QUOTA_FILE) {
        out.refused.push({ id, reason: 'this device has sent more to this file than its history may hold' });
        this.refuseFinal(t, env.file, slot, id);
        continue;
      }
      this.applying = true;
      try {
        Y.applyUpdate(doc, verdict.update, `team:${env.person}/${env.author}`);
      } finally {
        this.applying = false;
      }
      this.claimClients(t, env.file, env.person, verdict.update);
      // Taken within a grace window: vouch for it, so every member it reaches through this device decides alike.
      const mine = t.replay.state.members.get(this.me());
      const stored = verdict.graced && !env.vouch && atLeast(mine?.role, 'edit') ? vouchFor(this.identity.device, env, this.now()) : env;
      this.pushEnvelope(t, env.file, stored);
      this.countBytes(t, stored);
      await this.store.appendEnvelopes(t.id, env.file, [stored]);
      out.applied++;
    }
    if (out.refused.length) console.error(`bogen: team ${fingerprint(t.id)} refused ${out.refused.length} change(s): ${out.refused.slice(0, 3).map((r) => r.reason).join('; ')}`);
    return out;
  }

  /** Remembers an envelope as refused for good (bounded per file), so it is neither applied nor asked for again. */
  private refuseFinal(t: Team, file: string, slot: string, id: string): void {
    const map = t.refused.get(file) ?? new Map<string, string>();
    if (map.size >= MAX_REFUSED_PER_FILE || map.has(slot)) return;
    map.set(slot, id);
    t.refused.set(file, map);
  }

  /**
   * Per file and author, the longest unbroken run of numbers this device holds (or refused for good). Anything
   * after a gap is asked for again, so an envelope that had to wait is never lost behind a later one.
   */
  private countBytes(t: Team, e: Envelope): void {
    const n = typeof e.update === 'string' ? e.update.length : 0;
    t.bytes.set(`${e.file}|${e.author}`, (t.bytes.get(`${e.file}|${e.author}`) ?? 0) + n);
    t.bytes.set(e.file, (t.bytes.get(e.file) ?? 0) + n);
  }

  /**
   * What this device holds per file and author, as ranges of numbers ([from, to], inclusive), refused ones
   * included. A peer sends only what falls outside them, so one number missing for good does not make every peer
   * resend everything after it on every sync.
   */
  private vectors(t: Team): Record<string, Record<string, [number, number][]>> {
    const out: Record<string, Record<string, [number, number][]>> = {};
    for (const [file, list] of t.envelopes) {
      const have = new Map<string, Set<number>>();
      const add = (author: string, seq: number) => {
        const set = have.get(author) ?? new Set<number>();
        set.add(seq);
        have.set(author, set);
      };
      for (const e of list) add(e.author, e.seq);
      for (const slot of t.refused.get(file)?.keys() ?? []) {
        // Refused only as too late: not held, so a vouched copy can still come (N7 over the wire).
        if (t.late.has(`${file}|${slot}`)) continue;
        const at = slot.lastIndexOf(':');
        add(slot.slice(0, at), Number(slot.slice(at + 1)));
      }
      const v: Record<string, [number, number][]> = {};
      for (const [author, set] of have) {
        const seqs = [...set].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
        const ranges: [number, number][] = [];
        for (const n of seqs) {
          const last = ranges[ranges.length - 1];
          if (last && n === last[1] + 1) last[1] = n;
          else ranges.push([n, n]);
        }
        v[author] = ranges.slice(-MAX_RANGES);
      }
      out[file] = v;
    }
    return out;
  }


  private missing(t: Team, vectors: unknown): Envelope[] {
    const theirs = (vectors && typeof vectors === 'object' ? vectors : {}) as Record<string, Record<string, unknown>>;
    const out: Envelope[] = [];
    let bytes = 0;
    for (const [file, list] of t.envelopes) {
      const v = theirs[file] && typeof theirs[file] === 'object' ? theirs[file]! : {};
      const held = new Map<string, [number, number][]>();
      for (const e of list) {
        let ranges = held.get(e.author);
        if (!ranges) { ranges = heldRanges(v[e.author]); held.set(e.author, ranges); }
        if (ranges.some(([a, b]) => e.seq >= a && e.seq <= b)) continue;
        // Bounded per answer, so a large backlog arrives over several rounds instead of never: the other side's
        // ranges say what it got, and the next sync continues from there.
        const size = e.update.length + 1024;
        if (out.length && bytes + size > MAX_SYNC_BYTES) return out;
        out.push(e);
        bytes += size;
        if (out.length >= 20_000) return out;
      }
    }
    return out;
  }


  // ---- Between devices ------------------------------------------------------------------------------------

  /** A device of a member, with its keys, or null. */
  private device(t: Team, ed: string) {
    for (const m of t.replay.state.members.values()) {
      const d = m.devices.get(ed);
      if (d) return { person: m.person, device: d, role: m.role };
    }
    return null;
  }

  /** A request to a team device over TLS 1.3, pinned to the device key it should answer with. */
  private async call<T>(url: string, to: string, path: string, payload: (binding: string) => unknown): Promise<T> {
    if (!teamUrlOk(url)) throw new Error('Not an address a team device can have.');
    const res = await tlsPost(url, this.tls, to, path, (binding) => JSON.stringify(payload(binding)), { bindingLabel: BINDING, accept: (peer) => this.freshTls(peer), now: this.now() });
    if (res.status !== 200) throw new Error(res.body.slice(0, 200) || `HTTP ${res.status}`);
    return JSON.parse(res.body) as T;
  }

  /**
   * This device's TLS key: kept across restarts, replaced when it is half through its life. Peers pin the device
   * key, so a new TLS key needs nothing from them. Running listeners take the new certificate at once.
   */
  async ensureTls(force = false): Promise<void> {
    const now = this.now();
    const stored = this.identity.tls;
    // A stored key from a little in the future (this clock was corrected backwards) stays: peers refuse a key older
    // than the newest they saw, so replacing it with one issued "now" would shut this device out until then.
    if (!force && stored && now - stored.issued < TLS_KEY_ROTATE_MS && stored.issued <= now + SKEW_MS) {
      if (!this.tls || this.tls.tlsPub !== stored.key.pub) this.tls = deviceCertificate(this.identity.device.ed, { tls: stored, now });
      return;
    }
    // A new key is never older than the one it replaces (as far as peers allow a clock to be ahead).
    const issued = stored ? Math.min(Math.max(now, stored.issued + 1), now + SKEW_MS) : now;
    this.tls = deviceCertificate(this.identity.device.ed, { now, issued });
    this.identity.tls = this.tls.stored;
    await this.store.saveIdentity(this.identity);
    for (const server of this.servers) server.setSecureContext({ key: this.tls.key, cert: this.tls.cert, ...TLS_OPTIONS });
  }

  /** A peer's TLS key, unless an older one than this device has already seen from that device. */
  private freshTls(peer: PeerDevice): boolean {
    const seen = this.tlsSeen.get(peer.device) ?? 0;
    if (peer.issued < seen) return false;
    if (peer.issued > seen) {
      this.tlsSeen.set(peer.device, peer.issued);
      // Kept across restarts, so a key from before a rotation is not taken again after one.
      void this.store.saveTlsSeen(Object.fromEntries(this.tlsSeen)).catch(() => {});
    }
    return true;
  }

  async syncAll(): Promise<void> {
    await this.ensureTls().catch((e) => console.error(`bogen: could not renew the team TLS key: ${errorMessage(e)}`));
    await this.flushOutbox();
    await Promise.all([...this.teams.values()].map((t) => this.syncTeam(t).catch(() => {})));
  }

  async syncTeam(t: Team): Promise<void> {
    const self = this.identity.device.ed.pub;
    const devices = [...t.replay.state.members.values()].flatMap((m) => [...m.devices.values()]).filter((d) => d.ed !== self);
    // A removed member's devices get nothing more.
    for (const d of devices) {
      const contact = t.contacts[d.ed];
      if (!contact?.urls?.length) continue;
      for (const url of contact.urls) {
        try {
          const reply = await this.call<{ ops: Op[]; envelopes: Envelope[]; vectors: Record<string, Record<string, [number, number][]>>; urls: string[] }>(url, d.ed, '/team/v2/sync', () => ({ team: t.id, ops: t.ops, vectors: this.vectors(t), urls: this.urls }));
          await this.takeOps(t, reply.ops);
          await this.takeEnvelopes(t, reply.envelopes);
          const theirs = this.missing(t, reply.vectors);
          if (theirs.length) await this.call(url, d.ed, '/team/v2/push', () => ({ team: t.id, ops: [], envelopes: theirs }));
          contact.lastSeen = this.now();
          if (Array.isArray(reply.urls)) contact.urls = [...new Set([url, ...reply.urls.filter(teamUrlOk)])].slice(0, 8);
          break;
        } catch {
          // Offline or unreachable at this address: try the next one, and again at the next round.
        }
      }
    }
    await this.store.saveContacts(t.id, t.contacts);
  }

  // ---- The team listener ----------------------------------------------------------------------------------

  async setTransports(next: Transports): Promise<void> {
    if (next.lan.on && !isIP(next.lan.address)) throw new HttpError(400, 'Pick the network address to listen on for the local network.');
    if (next.vpn.on && !isIP(next.vpn.address)) throw new HttpError(400, 'Give the address this device has in the VPN.');
    // Every interface at once (0.0.0.0, ::) only when the person says so: secure by default means one network.
    const anywhere = (next.lan.on && isAnyAddress(next.lan.address)) || (next.vpn.on && isAnyAddress(next.vpn.address));
    if (anywhere && next.listenEverywhere !== true) throw new HttpError(400, 'That address listens on every network of this device. Pick one network, or confirm listening everywhere.');
    if (!Number.isInteger(next.port) || next.port < 1024 || next.port > 65535) throw new HttpError(400, 'Use a port from 1024 to 65535.');
    this.transports = next;
    await this.store.saveTransports(next);
    await Promise.all(this.servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    this.servers = [];
    await this.listen();
  }

  /** The addresses this machine has on its local networks, to pick one from. */
  static lanAddresses(): string[] {
    const out: string[] = [];
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (!a.internal && a.family === 'IPv4' && !isTailnetAddress(a.address)) out.push(a.address);
    return out;
  }

  private async listen(): Promise<void> {
    const t = this.transports;
    const binds: { address: string; via: string }[] = [];
    if (t.lan.on && t.lan.address) binds.push({ address: t.lan.address, via: 'LAN' });
    if (t.vpn.on && t.vpn.address) binds.push({ address: t.vpn.address, via: 'VPN' });
    if (t.tailscale.on) {
      const ip = await tailscaleIp(tailscaleCommands()).catch(() => null);
      if (ip) binds.push({ address: ip, via: 'Tailscale' });
    }
    this.urls = [];
    for (const bind of binds) {
      const server = createServer({ key: this.tls.key, cert: this.tls.cert, requestCert: true, rejectUnauthorized: false, handshakeTimeout: 5000, ...TLS_OPTIONS }, (req, res) => void this.onRequest(req, res, bind.via));
      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;
      server.keepAliveTimeout = 5000;
      // A connection that sends nothing for 10 s is closed, whatever state it is in.
      server.timeout = 10_000;
      server.maxConnections = 64;
      // At most a few open connections per address, so one address cannot hold the listener.
      const open = new Map<string, number>();
      server.on('connection', (socket: Socket) => {
        const at = socket.remoteAddress ?? '';
        const n = (open.get(at) ?? 0) + 1;
        if (n > MAX_CONNECTIONS_PER_ADDRESS) { socket.destroy(); return; }
        open.set(at, n);
        socket.once('close', () => { const left = (open.get(at) ?? 1) - 1; if (left > 0) open.set(at, left); else open.delete(at); });
      });
      // A TLS handshake costs a key agreement and a signature: no more than a few per address and second. And a
      // connection without a certificate a device key vouches for has nothing to say here: closed at once.
      server.on('secureConnection', (socket: TLSSocket) => {
        if (!this.budget(`tls|${socket.remoteAddress ?? ''}`, { count: 120, windowMs: 60_000 })) { socket.destroy(); return; }
        // A clock far apart is told in words (the request handler answers why); anything else is closed now.
        const checked = checkPeer(socket.getPeerX509Certificate(), this.now());
        if (!('peer' in checked) && checked.reason !== 'clock' && checked.reason !== 'expired') socket.destroy();
      });
      await new Promise<void>((resolve) => {
        server.once('error', (e) => {
          console.error(`bogen: the team connection on ${bind.address}:${t.port} did not start: ${errorMessage(e)}`);
          resolve();
        });
        server.listen(t.port, bind.address, () => {
          this.servers.push(server);
          // Listening on every network: each address of this device is a way in, so invites can name them.
          const addresses = isAnyAddress(bind.address) ? TeamService.lanAddresses() : [bind.address];
          for (const a of addresses) this.urls.push(`https://${a.includes(':') ? `[${a}]` : a}:${t.port}`);
          resolve();
        });
      });
    }
  }

  /** A sliding count per key: false once `count` uses fall inside the window. */
  private budget(key: string, limit: { count: number; windowMs: number }): boolean {
    const now = this.now();
    const list = (this.joins.get(key) ?? []).filter((t) => now - t < limit.windowMs);
    // Least recently used last: a busy key moves to the end, the oldest keys go first when there are too many.
    this.joins.delete(key);
    if (list.length >= limit.count) { this.joins.set(key, list); return false; }
    list.push(now);
    this.joins.set(key, list);
    while (this.joins.size > MAX_BUDGET_KEYS) this.joins.delete(this.joins.keys().next().value!);
    return true;
  }


  private async onRequest(req: IncomingMessage, res: ServerResponse, via: string): Promise<void> {
    const deny = (status: number, text: string) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' });
      res.end(text);
    };
    // Exact paths only: no normalising, no prefixes, nothing but POSTs.
    const path = (req.url ?? '').split('?')[0]!;
    if (req.method !== 'POST' || !ROUTES.has(path) || req.url !== path) return deny(404, 'Not found.');
    if (req.headers.origin !== undefined) return deny(403, 'Not for browsers.');
    const socket = req.socket as TLSSocket;
    const checked = checkPeer(socket.getPeerX509Certificate(), this.now());
    if (!('peer' in checked)) return deny(403, PEER_REASONS[checked.reason]);
    const peer = checked.peer;
    const from = peer.device;
    const isJoin = path === '/team/v2/join';
    // Who is asking is known from the TLS handshake: anyone not in a team here is turned away before the body.
    let sender: { team: Team; member: ReturnType<TeamService['device']> } | null = null;
    if (!isJoin) {
      for (const t of this.teams.values()) {
        const d = this.device(t, from);
        if (d) { sender = { team: t, member: d }; break; }
      }
      if (!sender) return deny(403, 'Not a device of this team.');
      // Remembered only for member devices: strangers' keys are never kept.
      if (!this.freshTls(peer)) return deny(403, 'An older TLS key than this device has already seen.');
    } else if (!this.budget(`join|${addressKey(socket.remoteAddress ?? '')}`, JOIN_BUDGET)) return deny(429, 'Too many joins. Try again in a minute.');
    if ((this.activeBy.get(from) ?? 0) >= MAX_ACTIVE_PER_SENDER) return deny(503, 'Busy with this device. Try again.');
    this.activeBy.set(from, (this.activeBy.get(from) ?? 0) + 1);
    let counted = false;
    try {
      const limit = isJoin ? MAX_JOIN_BODY : MAX_BODY;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > limit) return deny(413, 'Too large.');
        chunks.push(chunk as Buffer);
      }
      // A request counts against the shared limit only once its body is in: slow senders hold no shared slot.
      if (this.active >= MAX_ACTIVE_REQUESTS) return deny(503, 'Busy. Try again.');
      this.active++;
      counted = true;
      const payload = (JSON.parse(Buffer.concat(chunks).toString('utf8')) ?? {}) as Record<string, unknown>;
      const team = this.teams.get(String(payload.team));
      if (!team) return deny(404, 'Not a team of this device.');
      let reply: unknown;
      if (isJoin) reply = await this.answerJoin(team, from, channelBinding(socket, BINDING), payload);
      else {
        if (!this.device(team, from)) return deny(403, 'Not a device of this team.');
        await this.note(team, from, socket.remoteAddress ?? '', via, payload.urls);
        await this.takeOps(team, payload.ops);
        if (Array.isArray(payload.envelopes)) await this.takeEnvelopes(team, payload.envelopes);
        reply = path === '/team/v2/sync' ? { ops: team.ops, envelopes: this.missing(team, payload.vectors), vectors: this.vectors(team), urls: this.urls } : { ok: true };
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(reply));
    } catch (e) {
      deny(e instanceof HttpError ? e.status : 400, e instanceof HttpError ? e.message : 'Refused.');
    } finally {
      if (counted) this.active--;
      const left = (this.activeBy.get(from) ?? 1) - 1;
      if (left > 0) this.activeBy.set(from, left); else this.activeBy.delete(from);
    }
  }

  private async answerJoin(t: Team, from: string, binding: string, p: Record<string, unknown>): Promise<{ ops: Op[] }> {
    const invite = String(p.invite);
    const secrets = await this.store.secrets(t.id);
    const secret = secrets[invite];
    if (!secret) throw new HttpError(403, 'Unknown invite.');
    const state = t.replay.state.invites.get(invite);
    if (!state || state.revoked || state.used >= state.uses || state.expires < this.now()) throw new HttpError(410, 'This invite is used up, revoked or expired.');
    const person = String(p.person);
    // The proof covers the joiner's keys and this very TLS connection: replayed on another, it does not match.
    if (!KEY_TEXT.test(person) || !proofMatches(Buffer.from(secret, 'base64url'), person, from, binding, String(p.proof))) throw new HttpError(403, 'The invite proof does not match.');
    const cert = p.cert as DeviceCert;
    if (!cert || cert.person !== person || cert.device?.ed !== from || !certValid(cert)) throw new HttpError(400, 'The device certificate does not match.');
    if (t.replay.state.members.has(person)) throw new HttpError(409, 'Already a member.');
    await this.append(t, 'add', { person, name: String(p.name ?? '').slice(0, 100).trim() || 'New member', role: state.role, certs: [cert], invite });
    t.contacts[from] = { urls: Array.isArray(p.urls) ? (p.urls as unknown[]).filter(teamUrlOk).slice(0, 8) : [], lastSeen: this.now() };
    await this.store.saveContacts(t.id, t.contacts);
    return { ops: t.ops };
  }

  private async note(t: Team, ed: string, address: string, via: string, urls: unknown): Promise<void> {
    const c = t.contacts[ed] ?? { urls: [], lastSeen: 0 };
    c.lastSeen = this.now();
    c.via = via;
    if (Array.isArray(urls)) c.urls = [...new Set(urls.filter(teamUrlOk))].slice(0, 8);
    const ip = address.replace(/^::ffff:/, '');
    if (via === 'Tailscale' && isTailnetAddress(ip) && this.deps.whois && !c.login) {
      const who = await this.deps.whois(ip).catch(() => null);
      if (who?.login) c.login = who.login;
    }
    t.contacts[ed] = c;
  }
}

/** `tailscale whois --json <ip>`: the login behind an address on the tailnet, for the identity badge. */
export function tailscaleWhois(address: string): Promise<{ login: string } | null> {
  return new Promise((resolve) => {
    execFile('tailscale', ['whois', '--json', address], { timeout: 5000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const parsed = JSON.parse(stdout) as { UserProfile?: { LoginName?: string } };
        resolve(parsed.UserProfile?.LoginName ? { login: parsed.UserProfile.LoginName } : null);
      } catch {
        resolve(null);
      }
    });
  });
}
