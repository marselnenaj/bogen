import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { atomicWrite } from './util.ts';

/**
 * A real Git repository around a design folder. Git runs with no prompts, no hooks and no signing, and
 * nothing here pushes, ever. A file is bound to a folder only by `bogen git init` on this machine.
 */
const BASE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never'];

function git(cwd: string, args: string[], options: { input?: string } = {}): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn('git', [...BASE_CONFIG, ...args], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', GIT_PAGER: 'cat' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
    child.on('error', (e) => fail(new Error(`Could not run git: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? done(stdout) : fail(new Error(stderr.trim().split('\n').at(-1) || `git failed with ${code}`))));
    // git may exit before it reads stdin; its exit code reports that, so the pipe error must not escape.
    child.stdin!.on('error', () => {});
    child.stdin!.end(options.input ?? '');
  });
}

export async function gitInit(dir: string, options: { own?: boolean } = {}): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  // `own` makes the folder a repository of its own even inside another one, which then must not get its commits.
  const already = options.own ? await git(dir, ['rev-parse', '--show-toplevel']).then((top) => resolve(top.trim()) === resolve(dir), () => false) : await git(dir, ['rev-parse', '--is-inside-work-tree']).then(() => true, () => false);
  if (!already) await git(dir, ['init', '-q']);
  return !already;
}

export interface GitAuthor { name: string; email?: string }

/** Commits whatever differs. Null when nothing does. */
export async function gitCommit(dir: string, message: string, author: GitAuthor): Promise<string | null> {
  await git(dir, ['add', '-A', '.']);
  const status = await git(dir, ['status', '--porcelain', '--', '.']);
  if (!status.trim()) return null;
  const name = author.name.replace(/[<>\n]/g, ' ').trim() || 'Bogen';
  const email = author.email ?? 'bogen@localhost';
  await git(dir, ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-F', '-', '--author', `${name} <${email}>`], { input: message });
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

export interface GitLogEntry { hash: string; at: number; author: string; subject: string }

export async function gitLog(dir: string, limit = 50): Promise<GitLogEntry[]> {
  const hasCommits = await git(dir, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
  if (!hasCommits) return [];
  const raw = await git(dir, ['log', `-n${Math.max(1, Math.min(limit, 1000))}`, '--format=%H%x1f%ct%x1f%an%x1f%s', '--', '.']);
  return raw.split('\n').filter(Boolean).map((line) => {
    const [hash, at, author, subject] = line.split('\x1f') as [string, string, string, string];
    return { hash, at: Number(at) * 1000, author, subject };
  });
}

/** A revision of the folder, written out to a temp folder for the caller. Git does the reading. */
export async function gitCheckoutTo<T>(dir: string, rev: string, read: (folder: string) => Promise<T>): Promise<T> {
  if (!/^[\w./~^-]{1,200}$/.test(rev) || rev.startsWith('-')) throw new Error(`"${rev}" is not a revision.`);
  const prefix = (await git(dir, ['rev-parse', '--show-prefix'])).trim();
  const temp = await mkdtemp(join(tmpdir(), 'bogen-git-'));
  try {
    const index = join(temp, 'index');
    const out = join(temp, 'out');
    await mkdir(out);
    await new Promise<void>((done, fail) => {
      // A private index: nothing in the person's repository or working folder moves.
      const env = { ...process.env, GIT_INDEX_FILE: index, GIT_WORK_TREE: out, GIT_TERMINAL_PROMPT: '0' };
      const run = (args: string[], next: () => void) => {
        const child = spawn('git', [...BASE_CONFIG, ...args], { cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', fail);
        child.on('close', (code) => (code === 0 ? next() : fail(new Error(stderr.trim().split('\n').at(-1) || 'git failed'))));
      };
      run(['read-tree', `${rev}:${prefix}`], () => run(['checkout-index', '-a', '-f', `--prefix=${out}/`], done));
    });
    return await read(out);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export class GitBindings {
  constructor(private readonly home: string) {}

  private path(): string {
    return join(this.home, 'git-bindings.json');
  }

  async all(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path(), 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async get(fileId: string): Promise<string | undefined> {
    return (await this.all())[fileId];
  }

  async set(fileId: string, dir: string): Promise<string> {
    const full = isAbsolute(dir) ? dir : resolve(dir);
    await atomicWrite(this.path(), JSON.stringify({ ...(await this.all()), [fileId]: full }, null, 1), 0o600);
    return full;
  }
}
