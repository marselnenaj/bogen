import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { RUNNERS, type RunnerId } from '@bogen/core';

/**
 * What Bogen knows about one agent CLI on this machine.
 *
 * `checked` says whether the CLI itself was asked (its version, and for the newer runners the switches Bogen's
 * adapter relies on). Claude and Codex are asked on every listing, as before. The newer four are only looked up
 * on PATH, which starts nothing, until someone picks one: a Home screen or a file opening never starts four more
 * CLIs, a model catalog or a gateway.
 */
export interface RunnerInfo { id: RunnerId; available: boolean; version?: string; reason?: string; checked?: boolean; /** On PATH, for a runner Bogen does not start itself: `bogen install` connects it. */ installed?: boolean }

/** A spawned command and its outcome, so that tests can count what was started. */
export type ExecFn = (command: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv; input?: string }) => Promise<{ stdout: string; stderr: string }>;

export const execOutput: ExecFn = (command, args, { timeout, env, input }) => new Promise((resolve, reject) => {
  const child = execFile(command, args, { timeout, env, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    if (err) return reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
    resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
  // A stand-in, or a future CLI, may wait for input it will never get.
  // An old CLI can reject the options and close stdin before this metadata frame is written.
  // The process callback reports that exit; a broken pipe must not become an uncaught server error.
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
});

/**
 * Finds an executable on PATH without starting anything. On Windows the PATHEXT names count too; the Windows build
 * resolves npm shims through its own shell-free helper before spawning, so this only answers "is it there".
 */
export async function onPath(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (isAbsolute(command)) return (await executable(command)) ? command : null;
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const path = join(dir, command + ext);
      if (await executable(path)) return path;
    }
  }
  return null;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** One probe of a CLI: what it says it is, and its help text for the switches an adapter needs. */
export interface Probe { version?: string; help?: string; problem?: string }

/**
 * One help text and the switches it must name. A subcommand's help need not repeat the global options, so each
 * switch is looked for in the scope where the CLI documents it.
 */
interface HelpScope { args: string[]; needs: string[] }

interface ProbeSpec {
  /** Arguments that print the version. Grok's also keep it from checking for an update. */
  version: string[];
  /** Help texts the adapter's switches are checked against. A build without one of them is refused, never run without it. */
  help?: HelpScope[];
}

/**
 * The bounded probes per runner. Help and version print and exit: none of them starts a model, a session or a
 * daemon. Grok, Hermes and Oh My Pi are not run by Bogen (see `blocked` in the registry): only their version is asked.
 */
export const PROBES: Record<RunnerId, ProbeSpec> = {
  claude: { version: ['--version'] },
  codex: { version: ['--version'] },
  grok: { version: ['--no-auto-update', '--version'] },
  // `--pure` is a global option in OpenCode's CLI reference, `--format` one of `run`.
  opencode: { version: ['--version'], help: [{ args: ['--help'], needs: ['--pure'] }, { args: ['run', '--help'], needs: ['--format', '--agent'] }] },
  hermes: { version: ['--version'] },
  omp: { version: ['--version'] },
};

/** Whether a help text names a switch as an option, not inside another word. */
export function namesOption(help: string, flag: string): boolean {
  return new RegExp(`(?:^|[\\s,\\[(])${flag.replace(/-/g, '\\-')}(?![\\w-])`, 'm').test(help);
}

const OK_MS = 10 * 60_000;
const MISSING_MS = 60_000;
const PROBE_TIMEOUT_MS = 8000;

/** A short, single-line reason from a failed command, without anything that looks like a secret. */
export function shortProblem(error: unknown): string {
  const e = error as { code?: unknown; stderr?: unknown; message?: unknown; killed?: boolean };
  if (e?.code === 'ENOENT') return 'not found on PATH';
  if (e?.killed) return 'did not answer in time';
  const text = String(e?.stderr || e?.message || error).split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ');
  return text.replace(/(?:sk|xai|key|token)[-_][A-Za-z0-9_-]{12,}/gi, '…').slice(0, 300);
}

export class RunnerProbes {
  private cache = new Map<RunnerId, { at: number; ttl: number; value: Promise<Probe> }>();

  /** `exec` is the one way commands start here, so that a test counts them by passing its own. */
  constructor(private readonly env: () => NodeJS.ProcessEnv, private readonly exec: ExecFn = execOutput) {}

  private run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.exec(command, args, { timeout: PROBE_TIMEOUT_MS, env: this.env() });
  }

  /** Starts a command the way probes do, for a catalog of the same CLI. */
  output(command: string, args: string[], timeout = PROBE_TIMEOUT_MS): Promise<string> {
    return this.exec(command, args, { timeout, env: this.env() }).then((o) => o.stdout);
  }

  /** Asks the CLI itself, once per few minutes. A CLI that is not on PATH is not started at all. */
  probe(id: RunnerId): Promise<Probe> {
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < cached.ttl) return cached.value;
    const value = this.ask(id);
    const entry = { at: Date.now(), ttl: OK_MS, value };
    this.cache.set(id, entry);
    void value.then((p) => {
      if (p.problem) entry.ttl = MISSING_MS;
    });
    return value;
  }

  /** What was learned already, without asking. */
  async known(id: RunnerId): Promise<Probe | undefined> {
    const cached = this.cache.get(id);
    return cached && Date.now() - cached.at < cached.ttl ? cached.value : undefined;
  }

  private async ask(id: RunnerId): Promise<Probe> {
    const spec = PROBES[id];
    const { command, label } = RUNNERS[id];
    if (!(await onPath(command, this.env()))) return { problem: `${label} (${command}) was not found on PATH.` };
    let version: string;
    try {
      const out = await this.run(command, spec.version);
      version = (out.stdout.trim() || out.stderr.trim()).split('\n')[0]!.slice(0, 120);
    } catch (e) {
      return { problem: `${label} is on PATH, but \`${command} ${spec.version.join(' ')}\` failed: ${shortProblem(e)}.` };
    }
    if (!spec.help) return { version };
    const texts: string[] = [];
    const missing: string[] = [];
    for (const scope of spec.help) {
      let help: string;
      try {
        const out = await this.run(command, scope.args);
        help = `${out.stdout}\n${out.stderr}`;
      } catch (e) {
        // Some CLIs print their help and exit 1.
        const partial = `${(e as { stdout?: string }).stdout ?? ''}\n${(e as { stderr?: string }).stderr ?? ''}`;
        if (!partial.trim()) return { version, problem: `${label} ${version} did not print its options (\`${command} ${scope.args.join(' ')}\`): ${shortProblem(e)}.` };
        help = partial;
      }
      texts.push(help);
      missing.push(...scope.needs.filter((flag) => !namesOption(help, flag)));
    }
    const help = texts.join('\n');
    if (missing.length) {
      return { version, help, problem: `${label} ${version} has no ${missing.join(', ')} option, which Bogen needs to keep its runs to the Bogen tools. Update ${label}, then try again.` };
    }
    return { version, help };
  }

  /** Only for a test, or after the person installed something. */
  forget(id?: RunnerId): void {
    if (id) this.cache.delete(id);
    else this.cache.clear();
  }
}
