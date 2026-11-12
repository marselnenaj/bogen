import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { probe, type Connection } from './daemon.ts';
import { redactText, redactValue } from './redact.ts';
import type { RunRecord } from './run-history.ts';
import { installation } from './updates.ts';
import { atomicWrite, bogenHome, errorMessage } from './util.ts';
import { FULL_VERSION, VERSION } from './version.ts';

/**
 * `bogen report`: one .tar.gz for a bug report, written on this computer and sent nowhere. It holds the version,
 * the platform, `bogen doctor`, the end of the server log, recent runs that failed, and the state of paired devices
 * and phones. Everything passes through `redact.ts` first, and the home folder becomes `~`.
 */

const LOG_LIMIT = 64 * 1024;
const RUN_LIMIT = 10;
const PROMPT_LIMIT = 500;
const BAD_RUNS = new Set(['failed', 'interrupted']);

const README = `Bogen bug report

This archive was written on this computer by \`bogen report\`. Nothing was sent anywhere.

version.json   Bogen's version and build, how it was installed, Node, the system and the desktop
doctor.json    What \`bogen doctor\` checks, with the fix for each problem
status.json    The running server's status: files, agents at work, paired devices
server.log     The end of the background server's log, in the data folder
journal.log    The end of the user service's log, when there is a service
runs.json      Recent agent runs that failed or were cut off, with their errors
peers.json     Paired devices: name, address, sync state and version
phone.json     The phone listener: on or off, ports, paired phones

Tokens, keys, cookies and passwords of known shapes are masked as [redacted], Tailscale logins and
e-mail addresses as [login], the tailnet's name in MagicDNS names as [tailnet], and your home folder
is shown as ~. Masking recognises known shapes only: read the files before you share them.
`;

/** The last `limit` bytes of a file, from the first whole line. */
export function tail(path: string, limit = LOG_LIMIT): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const start = Math.max(0, size - limit);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString('utf8');
  return start > 0 && text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : text;
}

function run(command: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((done) => {
    execFile(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => done(error ? '' : String(stdout)));
  });
}

function osName(): string {
  try {
    return /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? process.platform;
  } catch {
    return process.platform;
  }
}

/** Runs that failed or were cut off, newest first, over every file's run history. */
export function failedRuns(home: string, limit = RUN_LIMIT): Partial<RunRecord>[] {
  const dir = join(home, 'runs');
  if (!existsSync(dir)) return [];
  const found: RunRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const records: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (Array.isArray(records)) for (const r of records as RunRecord[]) if (BAD_RUNS.has(r?.status)) found.push(r);
    } catch {
      // A history that cannot be read says nothing here.
    }
  }
  return found.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit).map((r) => ({
    id: r.id, fileId: r.fileId, runner: r.runner, model: r.model, actualModel: r.actualModel, effort: r.effort, source: r.source, review: r.review,
    status: r.status, startedAt: r.startedAt, durationMs: r.durationMs, error: r.error, tools: r.tools,
    prompt: r.prompt?.length > PROMPT_LIMIT ? `${r.prompt.slice(0, PROMPT_LIMIT)}…` : r.prompt,
  }));
}

async function getJson(conn: Connection, path: string): Promise<unknown> {
  try {
    const res = await fetch(`${conn.url}${path}`, { headers: conn.token ? { Authorization: `Bearer ${conn.token}` } : {}, signal: AbortSignal.timeout(4000) });
    return res.ok ? await res.json() : { error: `${path} answered ${res.status}` };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Peers from the server, else from config.json: only who and where, never the tokens kept there. */
async function peers(conn: Connection, running: boolean, home: string): Promise<unknown> {
  if (running) return getJson(conn, '/api/peers');
  const config = readJson(join(home, 'config.json'));
  return {
    fromConfig: true, tailnet: config?.tailnet === true,
    peers: (config?.peers ?? []).map((p: { id?: string; name?: string; url?: string }) => ({ id: p.id, name: p.name, url: p.url })),
  };
}

/** The phone listener's state, without the pairing code or any token hash. */
async function phone(conn: Connection, running: boolean, home: string): Promise<unknown> {
  if (running) {
    const status = await getJson(conn, '/api/phone') as Record<string, unknown>;
    const { code: _code, ...rest } = status ?? {};
    return rest;
  }
  const saved = readJson(join(home, 'phone.json'));
  if (!saved) return { on: false, saved: false };
  return {
    fromFile: true, on: saved.on === true, port: saved.port, httpsPort: saved.httpsPort, logins: saved.logins,
    devices: (saved.devices ?? []).map((d: { id?: string; name?: string; pairedAt?: number; lastSeen?: number }) => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen })),
  };
}

export interface ReportContents { files: [name: string, data: string][] }

export interface ReportOptions {
  conn: Connection;
  home?: string;
  /** Run `bogen doctor`'s checks, which start the browser once. */
  doctor?: boolean;
  /** Replaced by `~` everywhere. */
  userHome?: string;
}

/** Everything a report holds, masked, as (name, text). */
export async function collectReport(options: ReportOptions): Promise<ReportContents> {
  const home = options.home ?? bogenHome();
  const userHome = options.userHome ?? homedir();
  const status = await probe(options.conn);
  const running = status !== null;
  const unit = join(userHome, '.config/systemd/user/bogen.service');

  const checks: unknown[] = [];
  if (options.doctor !== false) {
    try {
      const { runChecks } = await import('./doctor.ts');
      await runChecks(options.conn, (check) => checks.push(check));
    } catch (e) {
      checks.push({ state: 'fail', label: 'doctor', detail: errorMessage(e) });
    }
  }
  const version = {
    version: VERSION, build: FULL_VERSION, installed: installation(), node: process.version, platform: process.platform, arch: process.arch,
    os: osName(), kernel: release(), desktop: process.env.XDG_CURRENT_DESKTOP ?? '', session: process.env.XDG_SESSION_TYPE ?? '',
    omarchy: Boolean(process.env.OMARCHY_PATH) || existsSync(join(userHome, '.local/share/omarchy')), created: new Date().toISOString(),
  };
  const journal = existsSync(unit) ? await run('journalctl', ['--user', '-u', 'bogen.service', '-n', '400', '--no-pager', '-o', 'short-iso']) : '';

  const json = (value: unknown) => `${JSON.stringify(redactValue(value, userHome), null, 2)}\n`;
  const files: [string, string][] = [
    ['README.txt', README],
    ['version.json', json(version)],
    ['doctor.json', json(options.doctor === false ? { skipped: true } : checks)],
    ['status.json', json(status ?? { running: false })],
    ['server.log', redactText(tail(join(home, 'server.log')), userHome)],
    ['runs.json', json(failedRuns(home))],
    ['peers.json', json(await peers(options.conn, running, home))],
    ['phone.json', json(await phone(options.conn, running, home))],
  ];
  if (journal) files.splice(5, 0, ['journal.log', redactText(journal, userHome)]);
  return { files };
}

/** A ustar header for one regular file. Names stay below 100 bytes. */
function tarHeader(name: string, size: number, mtime: number): Buffer {
  const header = Buffer.alloc(512);
  const put = (text: string, at: number, length: number) => header.write(text, at, length, 'utf8');
  const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, '0')}\0`;
  put(name, 0, 100);
  put(octal(0o600, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(mtime, 12), 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

export function tarGz(files: [string, string | Buffer][], folder: string, mtime = Math.floor(Date.now() / 1000)): Buffer {
  const parts: Buffer[] = [];
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const path = `${folder}/${name}`;
    if (Buffer.byteLength(path) >= 100) throw new Error(`${path} is too long a name for the archive.`);
    parts.push(tarHeader(path, data.length, mtime), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const stamp = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');

/** `bogen report [--output <file>] [--no-doctor]`. Writes an owner-only archive and says where. */
export async function reportCommand(conn: Connection, options: { output?: string; doctor?: boolean; json?: boolean; userHome?: string }, out: (text: string) => void): Promise<number> {
  const home = bogenHome();
  const output = resolve(options.output ?? join(home, 'reports', `bogen-report-${stamp()}.tar.gz`));
  if (!options.json) out('Collecting the version, doctor, logs, failed runs, devices and phones. Nothing is sent anywhere.\n');
  const { files } = await collectReport({ conn, home, doctor: options.doctor, userHome: options.userHome });
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const archive = tarGz(files, 'bogen-report');
  await atomicWrite(output, archive, 0o600);
  if (options.json) out(`${JSON.stringify({ path: output, bytes: archive.length, files: files.map(([n]) => n), sent: false }, null, 2)}\n`);
  else {
    out(`Wrote ${output} (${Math.max(1, Math.round(archive.length / 1024))} KB): ${files.map(([n]) => n).join(', ')}.\n`);
    out('Secrets of known shapes are masked. Read it before you attach it to an issue: tar -xzf <file> unpacks it.\n');
  }
  return 0;
}
