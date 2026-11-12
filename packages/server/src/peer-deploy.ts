import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { deployScript } from './deploy.ts';
import type { PeerStatus } from './peers.ts';
import { atomicWrite, errorMessage, HttpError } from './util.ts';

/**
 * "Update the other device" in the editor's sync indicator: `bogen peer deploy <ssh-host>` from this machine,
 * which copies this build to the other device over ssh and restarts it there (integrations/omarchy/deploy.sh).
 * Only for the person at this machine. A dry run comes first and shows what would change; the real run is
 * only taken with the plan of a dry run for the same host, made a short while ago.
 */

const PLAN_TTL_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 200_000;
/** An ssh destination as `ssh` takes it, user@host or a Host alias, and nothing that ssh would read as an option. */
const SSH_HOST = /^(?!-)[A-Za-z0-9._%+-]{1,64}(@[A-Za-z0-9._:-]{1,253})?$/;

export function validSshHost(host: string): boolean {
  return SSH_HOST.test(host) && !host.includes('..');
}

/** The commit a version names: `0.1.0+abc1234`, or `0.1.0+abc1234.f00d42` for a build with changes on top. */
export function buildCommit(version: string | undefined): { commit: string; dirty: boolean } | null {
  const m = /\+([0-9a-f]{7,40})(\.[0-9a-f]+)?$/.exec(version ?? '');
  return m ? { commit: m[1]!, dirty: Boolean(m[2]) } : null;
}

export type BuildOrder = 'same' | 'newer' | 'older' | 'apart' | 'unknown';

/** Whether this build is newer than the other device's, as far as the checkout the deploy script is in can tell. */
export async function compareBuilds(local: string, remote: string | undefined, repo: string | null, git = 'git'): Promise<BuildOrder> {
  if (!remote) return 'unknown';
  if (local === remote) return 'same';
  const a = buildCommit(local);
  const b = buildCommit(remote);
  if (!a || !b || !repo) return 'unknown';
  if (a.commit === b.commit) return 'unknown';
  const ancestor = (x: string, y: string) => new Promise<boolean | null>((done) => {
    execFile(git, ['-C', repo, 'merge-base', '--is-ancestor', x, y], { timeout: 3000 }, (error) => {
      if (!error) return done(true);
      const code = (error as { code?: unknown }).code;
      done(code === 1 ? false : null);
    });
  });
  const remoteOlder = await ancestor(b.commit, a.commit);
  if (remoteOlder === null) return 'unknown';
  if (remoteOlder) return 'newer';
  const remoteNewer = await ancestor(a.commit, b.commit);
  return remoteNewer ? 'older' : remoteNewer === false ? 'apart' : 'unknown';
}

export interface DeployInfo {
  /** False when this install has no deploy script, say from npm: then the command line has to do it. */
  available: boolean;
  peer: { id: string; name: string; version: string | null; state: PeerStatus['state'] };
  version: string;
  order: BuildOrder;
  /** The ssh host used last time for this device, or a guess from its address. */
  host: string;
  hostSaved: boolean;
  /** What the command line would be. */
  command: string;
  running: boolean;
}

export interface DeployResult { code: number; output: string; dryRun: boolean; host: string; plan?: string; command: string }

const Saved = z.object({ hosts: z.record(z.string(), z.string()).default({}) });

export interface PeerDeployDeps {
  home: string;
  version: string;
  peers: () => (PeerStatus & { url?: string })[];
  /** Tests: the script to run. Otherwise the one next to this build, or in the checkout. */
  script?: string | null;
  /** Tests: extra environment for the script, such as a stand-in for ssh. */
  env?: NodeJS.ProcessEnv;
}

export class PeerDeploys {
  private plans = new Map<string, { host: string; at: number }>();
  private running: string | null = null;

  constructor(private readonly deps: PeerDeployDeps) {}

  private get path(): string {
    return join(this.deps.home, 'peer-deploy.json');
  }

  private script(): string | null {
    return this.deps.script !== undefined ? this.deps.script : deployScript();
  }

  private async saved(): Promise<Record<string, string>> {
    try {
      return Saved.parse(JSON.parse(await readFile(this.path, 'utf8'))).hosts;
    } catch {
      return {};
    }
  }

  private peer(id: string): PeerStatus & { url?: string } {
    const peer = this.deps.peers().find((p) => p.id === id);
    if (!peer) throw new HttpError(404, `No paired device "${id}".`);
    return peer;
  }

  private command(host: string, port: number | null, dryRun: boolean): string {
    return `bogen peer deploy ${host}${port && port !== 29990 ? ` --port ${port}` : ''}${dryRun ? ' --dry-run' : ''}`;
  }

  private port(peer: { url?: string }): number | null {
    try {
      const port = peer.url ? Number(new URL(peer.url).port) : 0;
      return port || null;
    } catch {
      return null;
    }
  }

  async info(id: string): Promise<DeployInfo> {
    const peer = this.peer(id);
    const saved = (await this.saved())[id];
    let guess = '';
    try {
      guess = peer.url ? new URL(peer.url).hostname : '';
    } catch { /* no address */ }
    const host = saved ?? guess;
    const script = this.script();
    const repo = script ? resolve(dirname(script), '..', '..') : null;
    return {
      available: Boolean(script), peer: { id: peer.id, name: peer.name, version: peer.version ?? null, state: peer.state }, version: this.deps.version,
      order: await compareBuilds(this.deps.version, peer.version, repo), host, hostSaved: Boolean(saved), command: this.command(host || '<ssh-host>', this.port(peer), false),
      running: this.running !== null,
    };
  }

  async run(id: string, options: { host: string; dryRun: boolean; plan?: string }): Promise<DeployResult> {
    const peer = this.peer(id);
    const host = options.host.trim();
    if (!validSshHost(host)) throw new HttpError(400, 'Give the ssh host as ssh takes it, such as laptop or me@100.64.0.12.');
    const script = this.script();
    if (!script) throw new HttpError(409, 'This install has no deploy script. Run it from a checkout: bogen peer deploy <ssh-host>');
    if (!options.dryRun) {
      const plan = options.plan ? this.plans.get(options.plan) : undefined;
      if (!plan || plan.host !== host || Date.now() - plan.at > PLAN_TTL_MS) throw new HttpError(409, 'Run the dry run first, for this host. It shows what would change.');
      this.plans.delete(options.plan!);
    }
    if (this.running) throw new HttpError(409, `An update to ${this.running} is already running.`);
    this.running = peer.name;
    const port = this.port(peer);
    try {
      const out = await this.spawn(script, host, options.dryRun, port);
      const result: DeployResult = { ...out, dryRun: options.dryRun, host, command: this.command(host, port, options.dryRun) };
      if (options.dryRun && out.code === 0) {
        const plan = randomBytes(12).toString('base64url');
        this.plans.set(plan, { host, at: Date.now() });
        result.plan = plan;
      }
      if (out.code === 0) {
        const hosts = await this.saved();
        if (hosts[id] !== host) await atomicWrite(this.path, `${JSON.stringify({ hosts: { ...hosts, [id]: host } }, null, 2)}\n`, 0o600);
      }
      return result;
    } finally {
      this.running = null;
    }
  }

  private spawn(script: string, host: string, dryRun: boolean, port: number | null): Promise<{ code: number; output: string }> {
    return new Promise((done) => {
      let output = '';
      const add = (chunk: Buffer) => {
        if (output.length < OUTPUT_LIMIT) output += chunk.toString('utf8');
      };
      // An array, never a shell line: the host goes to ssh as one argument.
      const args = [script, host, ...(dryRun ? ['--dry-run'] : []), ...(port ? ['--port', String(port)] : [])];
      const child = spawn('bash', args, { env: { ...process.env, ...this.deps.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS);
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      child.on('error', (e) => {
        clearTimeout(timer);
        done({ code: 1, output: `${output}\nCould not run the deploy script: ${errorMessage(e)}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // Colours and cursor moves read as noise in a page.
        done({ code: code ?? 1, output: output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(0, OUTPUT_LIMIT) });
      });
    });
  }
}
