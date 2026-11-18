import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { atomicWrite } from '../util.ts';
import { fingerprint, KEY_TEXT, newDeviceKeys, type DeviceKeys, type KeyPair } from './crypto.ts';
import type { Envelope } from './envelope.ts';
import type { Op } from './log.ts';
import type { StoredTls } from './tls.ts';

/**
 * Where teams live on disk, all under `<home>/teams`, folders 0700 and secrets 0600:
 *
 * - `identity.json`: this device's keys, and the person key when this device holds it. The person key (and the
 *   recovery phrase until it is confirmed) are encrypted with a key kept in the system keyring (Secret Service
 *   on Linux, the login keychain on macOS) when there is one; without a keyring they are stored as is, mode 0600,
 *   and the Teams settings say so.
 * - `<team fingerprint>/files.json`: which of the team's files this device took into the team.
 * - `settings.json`: which connections are on, and where they listen.
 * - `<team fingerprint>/log.json`: the membership log.
 * - `<team fingerprint>/secrets.json`: invite secrets this device made (only their hashes are in the log).
 * - `<team fingerprint>/files/<file>.jsonl`: every envelope of that file, in arrival order, to pass on.
 * - `<team fingerprint>/contacts.json`: where member devices were last reached, and what Tailscale said about them.
 */

export interface Identity {
  device: DeviceKeys;
  deviceName: string;
  /** Set when this device holds the person key. */
  person?: KeyPair;
  personPub: string;
  personName: string;
  /** The owner confirmed the recovery phrase. Required before an owner invites anyone. */
  phraseConfirmed: boolean;
  /** The phrase's 16 bytes, base64url, until it is confirmed: so it can be shown again on this device. */
  pendingPhrase?: string;
  /** This device's TLS key, separate from its device keys, and when its certificate statement was made. */
  tls?: StoredTls;
}

/** On disk: the secret parts sealed with the keyring's key, or (no keyring) as they are. */
interface StoredIdentity extends Omit<Identity, 'person' | 'pendingPhrase'> {
  person?: KeyPair; pendingPhrase?: string;
  sealed?: { iv: string; ct: string; tag: string };
}

export type KeyStorage = 'keyring' | 'file' | 'locked';

/**
 * The system keyring, through its command line tool. The secret never appears on a command line (where any user
 * could read it in the process list): it goes in on stdin and comes back on stdout.
 * - Linux: `secret-tool` (libsecret, the Secret Service: GNOME Keyring, KWallet), `store` reads the secret from
 *   stdin.
 * - macOS: `security -i`, which reads its commands, secret included, from stdin; `find-generic-password -w` prints
 *   it. (`security add-generic-password -w <secret>` would put it in argv.)
 * - Windows and anything else: no keyring here; the key stays in identity.json, mode 0600, and the app says so.
 * Off in tests and with BOGEN_TEAMS_KEYRING=off; BOGEN_TEAMS_KEYRING=on turns it on in tests that bring their own
 * throwaway keyring.
 */
interface Keyring { get(): Promise<string | null>; set(secret: string): Promise<boolean> }
function run(cmd: string, args: string[], input?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout) => resolve({ ok: !error, out: String(stdout).trim() }));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}
const SECRET_TEXT = /^[A-Za-z0-9_-]{43}$/;
export function systemKeyring(account: string): Keyring | null {
  const mode = process.env.BOGEN_TEAMS_KEYRING;
  if (mode === 'off' || (process.env.VITEST && mode !== 'on')) return null;
  if (!/^[a-f0-9]{24}$/.test(account)) return null;
  if (process.platform === 'darwin') return {
    get: async () => { const r = await run('/usr/bin/security', ['find-generic-password', '-a', account, '-s', 'bogen-teams', '-w']); return r.ok && SECRET_TEXT.test(r.out) ? r.out : null; },
    set: async (secret) => {
      if (!SECRET_TEXT.test(secret)) return false;
      return (await run('/usr/bin/security', ['-i'], `add-generic-password -U -a ${account} -s bogen-teams -l "Bogen teams" -w ${secret}\n`)).ok;
    },
  };
  if (process.platform === 'linux') return {
    get: async () => { const r = await run('secret-tool', ['lookup', 'service', 'bogen-teams', 'account', account]); return r.ok && SECRET_TEXT.test(r.out) ? r.out : null; },
    set: async (secret) => SECRET_TEXT.test(secret) && (await run('secret-tool', ['store', '--label=Bogen teams', 'service', 'bogen-teams', 'account', account], secret)).ok,
  };
  return null;
}

export interface Transports {
  lan: { on: boolean; address: string };
  tailscale: { on: boolean };
  vpn: { on: boolean; address: string };
  port: number;
  /** Confirmed by the person: listening on every interface (0.0.0.0 or ::) is allowed. */
  listenEverywhere?: boolean;
}
export const DEFAULT_TRANSPORTS: Transports = { lan: { on: false, address: '' }, tailscale: { on: false }, vpn: { on: false, address: '' }, port: 29998 };

export interface Contact { urls: string[]; lastSeen: number; login?: string; via?: string }

export interface TeamLocal { seq: number; writers: Record<string, Record<string, string>> }

export class TeamStore {
  readonly dir: string;
  constructor(home: string) {
    this.dir = join(home, 'teams');
  }

  private async ensure(dir = this.dir): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  /** Where the person key is kept on this device. */
  keyStorage: KeyStorage = 'file';
  /** The sealed person key as read, while the keyring cannot open it: written back untouched, never dropped. */
  private lockedSealed: StoredIdentity['sealed'] | null = null;
  /** The keyring entry's account name: one per data folder, so two Bogen homes never share a key. */
  keyringAccount(): string {
    return createHash('sha256').update(this.dir).digest('hex').slice(0, 24);
  }
  private keyring(): Keyring | null {
    return systemKeyring(this.keyringAccount());
  }

  async identity(deviceName: string): Promise<Identity> {
    await this.ensure();
    const path = join(this.dir, 'identity.json');
    const found = await this.readJson<StoredIdentity>(path);
    if (found && KEY_TEXT.test(found.device?.ed?.pub ?? '') && KEY_TEXT.test(found.device?.x?.pub ?? '')) {
      const { sealed, ...rest } = found;
      const identity: Identity = { ...rest };
      // A TLS key that does not look right is made again rather than used.
      const tls = identity.tls;
      if (tls && !(KEY_TEXT.test(tls.key?.pub ?? '') && KEY_TEXT.test(tls.key?.priv ?? '') && Number.isSafeInteger(tls.issued) && tls.issued > 0)) delete identity.tls;
      if (sealed) {
        const key = await this.keyring()?.get().catch(() => null);
        const open = key ? unseal(Buffer.from(key, 'base64url'), sealed) : null;
        if (open) { if (open.person) identity.person = open.person; if (open.pendingPhrase) identity.pendingPhrase = open.pendingPhrase; this.keyStorage = 'keyring'; this.lockedSealed = null; }
        else { this.keyStorage = 'locked'; this.lockedSealed = sealed; }
      } else {
        this.keyStorage = 'file';
        // Moved into the keyring the next time it is saved, when there is one.
        if (identity.person && this.keyring()) await this.saveIdentity(identity);
      }
      return identity;
    }
    const device = newDeviceKeys();
    const fresh: Identity = { device, deviceName, personPub: '', personName: '', phraseConfirmed: false };
    await this.saveIdentity(fresh);
    return fresh;
  }
  async saveIdentity(identity: Identity): Promise<void> {
    await this.ensure();
    const { person, pendingPhrase, ...rest } = identity;
    if (this.keyStorage === 'locked' && this.lockedSealed) {
      // The person key exists, sealed, but cannot be opened now. Keep it exactly as it was; a new person key may
      // never replace it here (create and join refuse while locked).
      if (person) throw new Error('The person key is locked in the system keyring. Unlock the keyring and restart Bogen.');
      await atomicWrite(join(this.dir, 'identity.json'), `${JSON.stringify({ ...rest, sealed: this.lockedSealed }, null, 1)}\n`, 0o600);
      return;
    }
    let stored: StoredIdentity = { ...rest, ...(person ? { person } : {}), ...(pendingPhrase ? { pendingPhrase } : {}) };
    const ring = person || pendingPhrase ? this.keyring() : null;
    if (ring) {
      let key = await ring.get().catch(() => null);
      if (!key) {
        const fresh = randomBytes(32).toString('base64url');
        // Only a key the keyring gives back as it was stored counts: some tools report success either way.
        if (await ring.set(fresh).catch(() => false)) key = await ring.get().catch(() => null);
        if (key !== fresh) key = null;
      }
      if (key) {
        stored = { ...rest, sealed: seal(Buffer.from(key, 'base64url'), { person, pendingPhrase }) };
        this.keyStorage = 'keyring';
      } else this.keyStorage = 'file';
    } else if (this.keyStorage !== 'locked') this.keyStorage = 'file';
    await atomicWrite(join(this.dir, 'identity.json'), `${JSON.stringify(stored, null, 1)}\n`, 0o600);
  }

  async files(team: string): Promise<{ accepted: string[] }> {
    const found = await this.readJson<{ accepted?: unknown }>(join(this.teamDir(team), 'files.json'));
    return { accepted: Array.isArray(found?.accepted) ? found!.accepted.filter((f): f is string => typeof f === 'string' && /^[a-z0-9]{10}$/.test(f)) : [] };
  }
  async saveFiles(team: string, files: { accepted: string[] }): Promise<void> {
    await this.ensure(this.teamDir(team));
    await atomicWrite(join(this.teamDir(team), 'files.json'), `${JSON.stringify(files)}\n`, 0o600);
  }

  /**
   * This device's own bookkeeping for a team, never sent anywhere: the highest envelope number it used (so a
   * restored backup of the envelope files never makes it reuse one), and the nonce behind each Yjs id it handed to
   * a local writer, per file (so it can name them when it signs).
   */
  async local(team: string): Promise<TeamLocal> {
    const found = await this.readJson<{ seq?: unknown; writers?: unknown }>(join(this.teamDir(team), 'local.json'));
    const writers: TeamLocal['writers'] = {};
    if (found?.writers && typeof found.writers === 'object') for (const [file, map] of Object.entries(found.writers as Record<string, unknown>)) {
      if (!/^[a-z0-9]{10}$/.test(file) || !map || typeof map !== 'object') continue;
      const kept: Record<string, string> = {};
      for (const [id, nonce] of Object.entries(map as Record<string, unknown>)) if (/^\d{1,16}$/.test(id) && typeof nonce === 'string' && /^[A-Za-z0-9_-]{22}$/.test(nonce)) kept[id] = nonce;
      writers[file] = kept;
    }
    return { seq: Number.isSafeInteger(found?.seq) && (found!.seq as number) > 0 ? (found!.seq as number) : 0, writers };
  }
  async saveLocal(team: string, local: TeamLocal): Promise<void> {
    await this.ensure(this.teamDir(team));
    await atomicWrite(join(this.teamDir(team), 'local.json'), `${JSON.stringify(local)}\n`, 0o600);
  }

  async transports(): Promise<Transports> {
    const found = await this.readJson<Partial<Transports>>(join(this.dir, 'settings.json'));
    return {
      lan: { ...DEFAULT_TRANSPORTS.lan, ...(found?.lan ?? {}) },
      tailscale: { ...DEFAULT_TRANSPORTS.tailscale, ...(found?.tailscale ?? {}) },
      vpn: { ...DEFAULT_TRANSPORTS.vpn, ...(found?.vpn ?? {}) },
      port: Number.isInteger(found?.port) ? found!.port! : DEFAULT_TRANSPORTS.port,
      ...(found?.listenEverywhere === true ? { listenEverywhere: true } : {}),
    };
  }
  async saveTransports(t: Transports): Promise<void> {
    await this.ensure();
    await atomicWrite(join(this.dir, 'settings.json'), `${JSON.stringify(t, null, 1)}\n`, 0o600);
  }

  teamDir(team: string): string {
    return join(this.dir, fingerprint(team));
  }

  async teams(): Promise<string[]> {
    await this.ensure();
    const out: string[] = [];
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!/^[a-z2-7]{16}$/.test(name)) continue;
      const log = await this.readJson<{ team: string }>(join(this.dir, name, 'log.json'));
      if (log && KEY_TEXT.test(log.team)) out.push(log.team);
    }
    return out;
  }

  async log(team: string): Promise<Op[]> {
    return (await this.readJson<{ team: string; ops: Op[] }>(join(this.teamDir(team), 'log.json')))?.ops ?? [];
  }
  async saveLog(team: string, ops: Op[]): Promise<void> {
    await this.ensure(this.teamDir(team));
    await atomicWrite(join(this.teamDir(team), 'log.json'), `${JSON.stringify({ team, ops })}\n`, 0o600);
  }

  async secrets(team: string): Promise<Record<string, string>> {
    return (await this.readJson<Record<string, string>>(join(this.teamDir(team), 'secrets.json'))) ?? {};
  }
  async saveSecrets(team: string, secrets: Record<string, string>): Promise<void> {
    await this.ensure(this.teamDir(team));
    await atomicWrite(join(this.teamDir(team), 'secrets.json'), `${JSON.stringify(secrets)}\n`, 0o600);
  }

  async contacts(team: string): Promise<Record<string, Contact>> {
    return (await this.readJson<Record<string, Contact>>(join(this.teamDir(team), 'contacts.json'))) ?? {};
  }
  async saveContacts(team: string, contacts: Record<string, Contact>): Promise<void> {
    await this.ensure(this.teamDir(team));
    await atomicWrite(join(this.teamDir(team), 'contacts.json'), `${JSON.stringify(contacts)}\n`, 0o600);
  }

  async envelopes(team: string, file: string): Promise<Envelope[]> {
    const out: Envelope[] = [];
    // Read line by line: a big history never sits in memory as one string as well.
    const stream = createReadStream(join(this.teamDir(team), 'files', `${file}.jsonl`), { encoding: 'utf8' });
    try {
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line) as Envelope);
        } catch {
          // A torn last line from a crash: the envelopes before it stand.
        }
      }
    } catch {
      return out;
    }
    return out;
  }
  /** The newest TLS key time seen per member device. */
  async tlsSeen(): Promise<Record<string, number>> {
    const found = await this.readJson<Record<string, unknown>>(join(this.dir, 'tls-seen.json'));
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(found ?? {})) if (KEY_TEXT.test(k) && Number.isSafeInteger(v) && (v as number) > 0) out[k] = v as number;
    return out;
  }
  async saveTlsSeen(seen: Record<string, number>): Promise<void> {
    await this.ensure();
    const kept = Object.entries(seen).slice(-4096);
    await atomicWrite(join(this.dir, 'tls-seen.json'), `${JSON.stringify(Object.fromEntries(kept))}\n`, 0o600);
  }
  /** Two signed envelopes under one number: kept as proof that their author told peers different things. */
  async appendEvidence(team: string, a: Envelope, b: Envelope): Promise<void> {
    await this.ensure(this.teamDir(team));
    await appendFile(join(this.teamDir(team), 'equivocation.jsonl'), `${JSON.stringify({ at: Date.now(), envelopes: [a, b] })}\n`, { mode: 0o600 });
  }
  /**
   * Changes made on this device to a team file that could not be signed as this device's (written with a Yjs id it
   * never handed out). They stay here, never dropped and never sent, until the person tries again or lets them go.
   */
  async unsent(team: string, file: string): Promise<Uint8Array[]> {
    const found = await this.readJson<unknown>(join(this.teamDir(team), 'unsent', `${file}.json`));
    if (!Array.isArray(found)) return [];
    return found.filter((u): u is string => typeof u === 'string').map((u) => new Uint8Array(Buffer.from(u, 'base64')));
  }
  async saveUnsent(team: string, file: string, list: Uint8Array[]): Promise<void> {
    const dir = join(this.teamDir(team), 'unsent');
    const path = join(dir, `${file}.json`);
    if (!list.length) {
      await rm(path, { force: true });
      return;
    }
    await this.ensure(dir);
    await atomicWrite(path, `${JSON.stringify(list.map((u) => Buffer.from(u).toString('base64')))}\n`, 0o600);
  }
  async unsentFiles(team: string): Promise<string[]> {
    try {
      return (await readdir(join(this.teamDir(team), 'unsent'))).filter((n) => /^[a-z0-9]{10}\.json$/.test(n)).map((n) => n.slice(0, 10));
    } catch {
      return [];
    }
  }

  async appendEnvelopes(team: string, file: string, list: Envelope[]): Promise<void> {
    if (!list.length) return;
    const dir = join(this.teamDir(team), 'files');
    await this.ensure(dir);
    await appendFile(join(dir, `${file}.jsonl`), list.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  }
}

function seal(key: Buffer, secret: { person?: KeyPair; pendingPhrase?: string }): { iv: string; ct: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('bogen-teams-identity-v1'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64url'), ct: ct.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}
function unseal(key: Buffer, box: { iv: string; ct: string; tag: string }): { person?: KeyPair; pendingPhrase?: string } | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64url'));
    decipher.setAAD(Buffer.from('bogen-teams-identity-v1'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64url')), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}
