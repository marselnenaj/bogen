import { installVerifiedPackage } from './update-install.ts';
import { accessSync, constants, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSignature, sha256 } from './release-key.ts';
import { atomicWrite, errorMessage } from './util.ts';
import { VERSION } from './version.ts';

/**
 * Updates from Bogen's GitHub releases, for an npm install.
 *
 * A check is one GET of a public file, `bogen-release.json`, from the release source: by default the assets of the
 * latest GitHub release. It sends no identifier, no version and no cookie, and it can be turned off. `bogen update
 * apply` also fetches the manifest's signature, the package and the package's signature, and installs the package
 * with npm only when both signatures verify against a key built into this program and the package matches the
 * digest the signed manifest gives. docs/guide/privacy.md describes the request.
 */

export const DEFAULT_UPDATE_URL = 'https://github.com/marselnenaj/bogen/releases/latest/download';
export const MANIFEST = 'bogen-release.json';
export const PACKAGE = 'bogen-design';
const SETTINGS_FILE = 'update-settings.json';
const STATE_FILE = 'update-check.json';
const MANIFEST_LIMIT = 64 * 1024;
const SIGNATURE_LIMIT = 4096;
const PACKAGE_LIMIT = 256 * 1024 * 1024;
const CHECK_INTERVAL_MS = 24 * 3600_000;
/** A check that failed, say offline, is tried again sooner than a day later. */
const RETRY_INTERVAL_MS = 6 * 3600_000;
const FIRST_CHECK_DELAY_MS = 60_000;
const PLAIN_NAME = /^[\w.+-]{1,200}$/;

// ---------------------------------------------------------------- settings

export interface UpdateSettings {
  /** Whether the server checks by itself, once a day. `bogen update check` asks anyway, unless forced off. */
  check: boolean;
  /** Set when `BOGEN_UPDATE_CHECK=off` turns every check off, including the ones a person asks for. */
  forcedOff: boolean;
  /** Where the release files are: a folder URL that `bogen-release.json` and the package lie in. */
  url: string;
  urlFrom: 'default' | 'settings' | 'environment';
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function updateSettings(home: string, env: NodeJS.ProcessEnv = process.env): UpdateSettings {
  const saved = readJson(join(home, SETTINGS_FILE)) ?? {};
  const forcedOff = /^(0|off|false|no)$/i.test(env.BOGEN_UPDATE_CHECK ?? '');
  const url = env.BOGEN_UPDATE_URL || (typeof saved.url === 'string' && saved.url) || DEFAULT_UPDATE_URL;
  return {
    check: !forcedOff && saved.check !== false,
    forcedOff,
    url: url.replace(/\/+$/, ''),
    urlFrom: env.BOGEN_UPDATE_URL ? 'environment' : typeof saved.url === 'string' && saved.url ? 'settings' : 'default',
  };
}

export async function saveUpdateSettings(home: string, patch: { check?: boolean; url?: string | null }): Promise<void> {
  if (patch.url) releaseSource(patch.url);
  const next: Record<string, unknown> = { ...readJson(join(home, SETTINGS_FILE)) };
  if (patch.check !== undefined) next.check = patch.check;
  if (patch.url === null) delete next.url;
  else if (patch.url !== undefined) next.url = patch.url.replace(/\/+$/, '');
  await atomicWrite(join(home, SETTINGS_FILE), `${JSON.stringify(next, null, 2)}\n`, 0o600);
}

/** https, or plain http to this machine for a local stand-in. No credentials, no query. */
export function releaseSource(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a URL.`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) throw new Error(`The release source must be an https URL: ${url}`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`The release source must be a plain folder URL, without credentials or a query: ${url}`);
  return parsed;
}

function fileUrl(base: string, name: string): string {
  if (!PLAIN_NAME.test(name)) throw new Error(`"${name}" is not a plain file name.`);
  return new URL(encodeURIComponent(name), `${releaseSource(base).href.replace(/\/*$/, '')}/`).href;
}

// ---------------------------------------------------------------- versions

function parts(version: string): { core: number[]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : null;
}

/** Semantic version order; build metadata is ignored, a pre-release comes before its release. NaN for nonsense. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return Number.NaN;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const p = x.pre.split('.');
  const q = y.pre.split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const [m, n] = [p[i]!, q[i]!];
    if (m === n) continue;
    const numeric = /^\d+$/.test(m) && /^\d+$/.test(n);
    return numeric ? Number(m) - Number(n) : /^\d+$/.test(m) ? -1 : /^\d+$/.test(n) ? 1 : m < n ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------- the manifest

export interface ReleaseManifest {
  schema: 1;
  name: typeof PACKAGE;
  version: string;
  tag: string;
  /** The npm package, which lies beside the manifest with its `.sig`. */
  package: { file: string; sha256: string; size: number };
  /** The release page with the notes. */
  notes?: string;
  date?: string;
}

export function parseManifest(bytes: Uint8Array): ReleaseManifest {
  let value: any;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('The release manifest is not JSON.');
  }
  const ok = value?.schema === 1 && value.name === PACKAGE && parts(String(value.version)) !== null
    && typeof value.package?.file === 'string' && value.package.file === `${PACKAGE}-${value.version}.tgz`
    && /^[0-9a-f]{64}$/.test(String(value.package.sha256)) && Number.isInteger(value.package.size) && value.package.size > 0;
  if (!ok) throw new Error('The release manifest does not describe a Bogen release.');
  const notes = typeof value.notes === 'string' && /^https:\/\//.test(value.notes) ? value.notes : undefined;
  return { schema: 1, name: PACKAGE, version: String(value.version), tag: String(value.tag ?? `v${value.version}`), package: { file: value.package.file, sha256: value.package.sha256, size: value.package.size }, ...(notes ? { notes } : {}), ...(typeof value.date === 'string' ? { date: value.date } : {}) };
}

// ---------------------------------------------------------------- fetching

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

class NotFound extends Error {}
class Offline extends Error {}

/**
 * One GET, following redirects (GitHub sends release assets to its storage host). Only a fixed User-Agent goes
 * with it: Node's fetch sends no cookies, and nothing names this installation.
 */
async function download(url: string, limit: number, timeoutMs: number, fetcher: Fetch = fetch): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetcher(url, { headers: { 'User-Agent': 'bogen', Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? '';
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/.test(code) || (e as Error).name === 'TimeoutError') throw new Offline(`${new URL(url).host} could not be reached (${code || 'timed out'}).`);
    throw e;
  }
  if (res.status === 404) throw new NotFound(`${url} is not there (404).`);
  if (!res.ok) throw new Error(`${url} answered ${res.status}.`);
  if (Number(res.headers.get('content-length') ?? 0) > limit) throw new Error(`${url} is larger than ${limit} bytes.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > limit) throw new Error(`${url} is larger than ${limit} bytes.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- checking

export type CheckState = 'update_available' | 'up_to_date' | 'no_release' | 'offline' | 'error';
export interface CheckResult {
  state: CheckState;
  current: string;
  latest?: string;
  notes?: string;
  message: string;
  checkedAt: number;
  url: string;
}

export function readCheck(home: string): CheckResult | null {
  const value = readJson(join(home, STATE_FILE));
  return value && typeof value.state === 'string' && typeof value.checkedAt === 'number' ? value as unknown as CheckResult : null;
}

export function checkDue(last: CheckResult | null, url: string, now = Date.now()): boolean {
  if (!last || last.url !== url) return true;
  const wait = last.state === 'offline' || last.state === 'error' ? RETRY_INTERVAL_MS : CHECK_INTERVAL_MS;
  return now - last.checkedAt >= wait;
}

/** Fetches the manifest, compares, and records the outcome in `update-check.json`. Never throws. */
export async function checkForUpdate(options: { home: string; url: string; current?: string; fetch?: Fetch; now?: number }): Promise<CheckResult> {
  const current = options.current ?? VERSION;
  const base = { current, checkedAt: options.now ?? Date.now(), url: options.url };
  let result: CheckResult;
  try {
    const manifest = parseManifest(await download(fileUrl(options.url, MANIFEST), MANIFEST_LIMIT, 15_000, options.fetch));
    const newer = compareVersions(manifest.version, current) > 0;
    result = {
      ...base, state: newer ? 'update_available' : 'up_to_date', latest: manifest.version, ...(manifest.notes ? { notes: manifest.notes } : {}),
      message: newer ? `Bogen ${manifest.version} is available. This is ${current}.` : `Bogen ${current} is up to date.`,
    };
  } catch (e) {
    result = e instanceof NotFound ? { ...base, state: 'no_release', message: `No release is published at ${options.url} yet.` }
      : e instanceof Offline ? { ...base, state: 'offline', message: errorMessage(e) }
        : { ...base, state: 'error', message: errorMessage(e) };
  }
  await atomicWrite(join(options.home, STATE_FILE), `${JSON.stringify(result, null, 2)}\n`, 0o600).catch(() => {});
  return result;
}

// ---------------------------------------------------------------- where this program lives

export type Installation =
  | { kind: 'npm'; prefix: string; dir: string }
  | { kind: 'system'; prefix: string; dir: string }
  | { kind: 'checkout'; dir: string }
  | { kind: 'other'; dir: string };

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * How this program was installed, from where its code lies: `dist/cli.js` in the bundle, `src/updates.ts` from
 * source; either way one level below the package. `npm i -g` puts the package in `<prefix>/lib/node_modules`, a
 * system package (the Arch PKGBUILD) does the same under a prefix only root can write.
 */
export function installation(from = fileURLToPath(import.meta.url)): Installation {
  const pkg = dirname(dirname(from));
  const modules = dirname(pkg);
  if (basename(pkg) === PACKAGE && basename(modules) === 'node_modules' && basename(dirname(modules)) === 'lib') {
    const prefix = dirname(dirname(modules));
    return writable(modules) ? { kind: 'npm', prefix, dir: pkg } : { kind: 'system', prefix, dir: pkg };
  }
  const repo = dirname(dirname(pkg));
  if (readJson(join(repo, 'package.json'))?.name === 'bogen-monorepo') return { kind: 'checkout', dir: repo };
  return { kind: 'other', dir: pkg };
}

/** What a person runs to update this installation. */
export function howToUpdate(install: Installation): string {
  switch (install.kind) {
    case 'npm': return 'bogen update apply';
    case 'system': return 'your package manager, the way this package was installed';
    case 'checkout': return 'git pull && npm install && npm run build, in the checkout';
    default: return 'bogen peer deploy from a device with the new build, or install it the way this one was installed';
  }
}

// ---------------------------------------------------------------- applying

export interface ApplyOptions {
  home: string;
  url: string;
  keys: Buffer[];
  install: Installation;
  current?: string;
  fetch?: Fetch;
  /** The npm program; tests point it elsewhere. */
  npm?: string;
  log?: (line: string) => void;
}

export type ApplyResult = { state: 'installed'; from: string; to: string; prefix: string } | { state: 'up_to_date'; current: string; latest: string };


/**
 * Downloads the latest release, verifies it, and prepares it with npm beside this installation, probes the CLI, and preserves the previous app before activation. Nothing is installed
 * unless the manifest's signature, the package's digest and the package's own signature all hold.
 */
export async function applyUpdate(options: ApplyOptions): Promise<ApplyResult> {
  const log = options.log ?? (() => {});
  const current = options.current ?? VERSION;
  const install = options.install;
  if (install.kind !== 'npm') {
    throw new Error(install.kind === 'system' ? `This Bogen was installed by a system package under ${install.prefix}. Update it with ${howToUpdate(install)}.`
      : install.kind === 'checkout' ? `This Bogen runs from the checkout in ${install.dir}. Update it there with: git pull && npm install && npm run build.`
        : `This Bogen was not installed with npm (${install.dir}), so bogen update cannot replace it.`);
  }
  if (!options.keys.length) throw new Error('This build of Bogen has no release key, so it cannot check an update. Install the new version by hand.');
  const refuse = (why: string) => new Error(`Refused the update: ${why}. Nothing was installed.`);

  log(`Fetching ${fileUrl(options.url, MANIFEST)}`);
  const manifestBytes = await download(fileUrl(options.url, MANIFEST), MANIFEST_LIMIT, 30_000, options.fetch);
  const manifestSig = await download(fileUrl(options.url, `${MANIFEST}.sig`), SIGNATURE_LIMIT, 30_000, options.fetch).catch((e) => {
    throw e instanceof NotFound ? refuse('the release manifest has no signature') : e;
  });
  const manifestCheck = checkSignature(options.keys, manifestBytes, manifestSig);
  if (!manifestCheck.ok) throw refuse(`the release manifest: ${manifestCheck.reason}`);
  const manifest = parseManifest(manifestBytes);
  if (!(compareVersions(manifest.version, current) > 0)) return { state: 'up_to_date', current, latest: manifest.version };

  log(`Fetching ${manifest.package.file} (${(manifest.package.size / 1048576).toFixed(1)} MB)`);
  const tarball = await download(fileUrl(options.url, manifest.package.file), Math.min(PACKAGE_LIMIT, manifest.package.size), 5 * 60_000, options.fetch);
  if (sha256(tarball) !== manifest.package.sha256) throw refuse('the package does not match the digest in the signed manifest');
  const tarballSig = await download(fileUrl(options.url, `${manifest.package.file}.sig`), SIGNATURE_LIMIT, 30_000, options.fetch).catch((e) => {
    throw e instanceof NotFound ? refuse('the package has no signature') : e;
  });
  const packageCheck = checkSignature(options.keys, tarball, tarballSig);
  if (!packageCheck.ok) throw refuse(`the package: ${packageCheck.reason}`);
  log(`Verified ${manifest.package.file}: SHA-256 ${manifest.package.sha256}, signed with the ${packageCheck.key === 0 ? 'current' : 'next'} release key`);

  // npm reads the very bytes that were checked, from a folder only this user can open.
  const dir = await mkdtemp(join(tmpdir(), 'bogen-update-'));
  try {
    const file = join(dir, manifest.package.file);
    await writeFile(file, tarball, { mode: 0o600 });
    await installVerifiedPackage(install, file, manifest.version, options.npm ?? 'npm', log);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { state: 'installed', from: current, to: manifest.version, prefix: install.prefix };
}

// ---------------------------------------------------------------- the server's own check

export interface UpdateNote { version: string; current: string; notes?: string; how: string }

/**
 * The server checks once a day when checks are on, a minute after it starts and never more often, and tells the
 * editor and the bar widget through `/api/status` when a newer release is out.
 */
export class UpdateWatch {
  private timers: NodeJS.Timeout[] = [];
  private busy = false;
  private cache: { at: number; note: UpdateNote | null } = { at: 0, note: null };

  constructor(private readonly home: string, private readonly options: { fetch?: Fetch; env?: NodeJS.ProcessEnv; firstDelayMs?: number } = {}) {}

  start(): void {
    const tick = () => void this.tick();
    this.timers.push(setTimeout(tick, this.options.firstDelayMs ?? FIRST_CHECK_DELAY_MS), setInterval(tick, 3600_000));
    for (const t of this.timers) t.unref();
  }

  async tick(): Promise<void> {
    const settings = updateSettings(this.home, this.options.env);
    if (!settings.check || this.busy || !checkDue(readCheck(this.home), settings.url)) return;
    this.busy = true;
    try {
      await checkForUpdate({ home: this.home, url: settings.url, fetch: this.options.fetch });
      this.cache.at = 0;
    } finally {
      this.busy = false;
    }
  }

  /** A newer release, as the last check found it. Nothing when checks are off. Read from disk at most every 30 s. */
  note(): UpdateNote | null {
    if (Date.now() - this.cache.at < 30_000) return this.cache.note;
    const settings = updateSettings(this.home, this.options.env);
    const last = readCheck(this.home);
    const note = settings.check && last?.state === 'update_available' && last.latest && compareVersions(last.latest, VERSION) > 0
      ? { version: last.latest, current: VERSION, ...(last.notes ? { notes: last.notes } : {}), how: howToUpdate(installation()) } : null;
    this.cache = { at: Date.now(), note };
    return note;
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
