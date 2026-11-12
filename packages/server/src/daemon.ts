import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bogenHome, DEFAULT_PORT, ensurePrivateHome } from './util.ts';

export interface ServerStatus {
  version: string;
  port: number;
  pid?: number;
  files: number;
  agents: { name: string; fileId: string; fileName: string; status: string; lastTool: string; at: number }[];
  peers?: { name: string; version?: string; versionMismatch?: boolean }[];
}

export interface Connection { port: number; token?: string; url: string }

export function connectionFromEnv(port?: number): Connection {
  const url = process.env.BOGEN_URL;
  const token = process.env.BOGEN_TOKEN;
  if (url) return { url: url.replace(/\/$/, ''), token, port: Number(new URL(url).port) || 0 };
  const chosen = port ?? (Number(process.env.BOGEN_PORT) || DEFAULT_PORT);
  return { url: `http://127.0.0.1:${chosen}`, token, port: chosen };
}

/**
 * What answers on the port: a Bogen server, one that took the connection and did not reply in
 * time, or nothing (refused, or another program). A machine that waits on its disk can keep a
 * running server from replying for seconds, and that is not the same as no server at all.
 */
export type ProbeResult = { state: 'running'; status: ServerStatus } | { state: 'busy' } | { state: 'down' };

export async function probeState(conn: Connection, timeoutMs = 2000): Promise<ProbeResult> {
  try {
    const res = await fetch(`${conn.url}/api/status`, {
      headers: conn.token ? { Authorization: `Bearer ${conn.token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { state: 'down' };
    const body = await res.json() as ServerStatus;
    return typeof body.version === 'string' ? { state: 'running', status: body } : { state: 'down' };
  } catch (e) {
    return (e as Error).name === 'TimeoutError' ? { state: 'busy' } : { state: 'down' };
  }
}

export async function probe(conn: Connection): Promise<ServerStatus | null> {
  const result = await probeState(conn);
  return result.state === 'running' ? result.status : null;
}

/** After a probe found the server busy: give it longer, and say so rather than start another one. */
async function waitWhileBusy(conn: Connection): Promise<ServerStatus> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await probeState(conn, 5000);
    if (result.state === 'running') return result.status;
    if (result.state === 'down') break;
  }
  throw new Error(`Bogen at ${conn.url} took the connection and did not reply in 20 s. It may wait on a busy disk; try again in a moment, or see journalctl --user -u bogen.`);
}

interface ServerFile { pid: number; port: number; host: string }

function readServerFile(home = bogenHome()): ServerFile | null {
  try {
    return JSON.parse(readFileSync(join(home, 'server.json'), 'utf8')) as ServerFile;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * `systemctl --user` finds the user manager through XDG_RUNTIME_DIR. Some MCP clients start
 * `bogen mcp` with a cut-down environment that lacks it, and then a start fails and a second
 * server outside the service takes the port, which leaves the service failing until it stops.
 */
export function userBusEnv(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.()): NodeJS.ProcessEnv {
  if (env.XDG_RUNTIME_DIR || env.DBUS_SESSION_BUS_ADDRESS || uid === undefined) return env;
  const dir = `/run/user/${uid}`;
  return existsSync(dir) ? { ...env, XDG_RUNTIME_DIR: dir } : env;
}

/** Starts `bogen serve` in the background, logging to `$BOGEN_HOME/server.log`. Resolves once it answers. */
export async function startDaemon(conn: Connection, host?: string): Promise<ServerStatus> {
  const first = await probeState(conn);
  if (first.state === 'running') return first.status;
  // Something holds the port and is slow: a second server could only fail to bind beside it.
  if (first.state === 'busy') return waitWhileBusy(conn);
  // With a service installed, a second server of ours would hold the port and leave it failing.
  let why = 'no user service is installed';
  if (!host && !process.env.BOGEN_HOME && existsSync(join(homedir(), '.config/systemd/user/bogen.service'))) {
    const started = spawnSync('systemctl', ['--user', 'start', 'bogen.service'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000, env: userBusEnv() });
    for (let i = 0; i < 40; i++) {
      const result = await probeState(conn);
      if (result.state === 'running') return result.status;
      if (result.state === 'busy') return waitWhileBusy(conn);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    // systemd started the service and it is still not answering: a server of our own outside it
    // would take its port, and the bar's Stop, which stops the service, could not stop ours.
    if (started.status === 0) throw new Error('The bogen service did not answer after starting. See journalctl --user -u bogen.');
    why = `systemctl --user start bogen.service failed: ${(started.error?.message ?? started.stderr ?? '').trim() || `exit ${started.status}`}`;
  }
  const home = bogenHome();
  ensurePrivateHome(home);
  const log = openSync(join(home, 'server.log'), 'a', 0o600);
  // Say who started this server outside the service, so a stray one can be traced.
  writeSync(log, `${new Date().toISOString()} bogen: started by pid ${process.pid} (${process.argv.slice(2).join(' ') || 'bogen'}), parent ${process.ppid}, since ${why}\n`);
  const args = [...process.execArgv, process.argv[1]!, 'serve', '--port', String(conn.port), ...(host ? ['--host', host] : [])];
  // The token travels in the environment, which other users cannot read, instead of the command line.
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ...(conn.token ? { BOGEN_TOKEN: conn.token } : {}) } });
  let exit: number | null | undefined;
  child.on('exit', (code) => {
    exit = code;
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = await probe(conn);
    if (status) return status;
    // Another process may have won a race for the port, so keep probing a moment even after an exit.
    if (exit !== undefined && Date.now() > deadline - 12_000) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`The Bogen server did not start. See ${join(home, 'server.log')}. Is port ${conn.port} taken by another program?`);
}

export async function stopDaemon(conn: Connection): Promise<'stopped' | 'not-running'> {
  const first = await probeState(conn);
  // Only a server that says which pid it is gets a signal, so a slow one gets longer to say it.
  const status = first.state === 'running' ? first.status : first.state === 'busy' ? await waitWhileBusy(conn) : null;
  const file = readServerFile();
  const pid = status?.pid ?? file?.pid;
  if (!pid || (!status && !alive(pid))) {
    rmSync(join(bogenHome(), 'server.json'), { force: true });
    return 'not-running';
  }
  if (!status) {
    // The recorded process no longer answers as Bogen, and may be an unrelated reuse of the pid.
    rmSync(join(bogenHome(), 'server.json'), { force: true });
    return 'not-running';
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && alive(pid)) await new Promise((resolve) => setTimeout(resolve, 100));
  if (alive(pid)) process.kill(pid, 'SIGKILL');
  return 'stopped';
}
