import { spawn } from 'node:child_process';
import { HttpError } from './util.ts';

/**
 * Git and `gh` in a person's own repository, for pull requests made from a design change. Git runs with no
 * hooks, no prompts and no signing, as in `git-mirror.ts`: a hook in a repository is a shell, and Bogen does not
 * run one by changing a file. Only `pushBranch` and `ghCreatePr` reach the network, and only `PullRequests.open`
 * calls them, after the person confirmed what they saw.
 */

const QUIET = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false'];
const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' };
const BRANCH = /^[A-Za-z0-9][\w./-]{0,120}$/;

interface Ran { stdout: string; stderr: string; code: number | null }

function run(command: string, args: string[], cwd: string, options: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...options.env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 120_000);
    child.stdout!.on('data', (d: Buffer) => { stdout = (stdout + d.toString()).slice(-8 * 1024 * 1024); });
    child.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8000); });
    child.on('error', (e) => {
      clearTimeout(timer);
      fail(new HttpError(500, `Could not run ${command}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ stdout, stderr, code });
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(options.input ?? '');
  });
}

function lastLine(text: string): string {
  return text.trim().split('\n').filter(Boolean).at(-1) ?? '';
}

/** Git with the quiet settings. Fails with git's own last line. */
export async function git(cwd: string, args: string[], options: { input?: string; env?: Record<string, string> } = {}): Promise<string> {
  const out = await run('git', [...QUIET, ...args], cwd, { ...options, env: { ...ENV, ...options.env } });
  if (out.code !== 0) throw new HttpError(400, `git ${args[0]}: ${lastLine(out.stderr) || `exited with ${out.code}`}`);
  return out.stdout;
}

export function isBranchName(name: string): boolean {
  return BRANCH.test(name) && !name.includes('..') && !name.endsWith('.lock') && !name.endsWith('/') && !name.endsWith('.') && !name.includes('//');
}

/** A branch name from words: `bogen/` and a slug. */
export function branchSlug(words: string, prefix = 'bogen/'): string {
  const slug = words.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '');
  return `${prefix}${slug || 'design-change'}`;
}

export interface RepoInfo { top: string; branch: string; head: string; remote: string | null; remoteUrl: string | null }

/** Where the repository of a folder starts, the branch it is on, and the remote a pull request goes to. */
export async function repoInfo(dir: string): Promise<RepoInfo> {
  const top = (await git(dir, ['rev-parse', '--show-toplevel']).catch(() => {
    throw new HttpError(400, `${dir} is not in a Git repository. A pull request needs one.`);
  })).trim();
  const head = (await git(top, ['rev-parse', '--verify', 'HEAD']).catch(() => {
    throw new HttpError(400, 'The repository has no commit yet.');
  })).trim();
  const branch = (await git(top, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const remotes = (await git(top, ['remote'])).split('\n').map((r) => r.trim()).filter(Boolean);
  const upstream = branch !== 'HEAD' ? (await git(top, ['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim() : '';
  const remote = upstream && remotes.includes(upstream) ? upstream : remotes.includes('origin') ? 'origin' : remotes[0] ?? null;
  const remoteUrl = remote ? (await git(top, ['remote', 'get-url', remote]).catch(() => '')).trim() || null : null;
  return { top, branch, head, remote, remoteUrl };
}

export async function branchExists(top: string, name: string): Promise<boolean> {
  return git(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).then(() => true, () => false);
}

/** A branch name not taken yet, with -2, -3 and so on when it is. */
export async function freeBranch(top: string, wanted: string): Promise<string> {
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? wanted : `${wanted}-${i}`;
    if (!(await branchExists(top, name))) return name;
  }
  throw new HttpError(409, `Too many branches called ${wanted}.`);
}

/** A working folder of its own on a new branch, so that the person's checkout and changes stay as they are. */
export async function addWorktree(top: string, path: string, branch: string, base: string): Promise<void> {
  if (!isBranchName(branch)) throw new HttpError(400, `"${branch}" is not a branch name.`);
  await git(top, ['worktree', 'add', '--quiet', '-b', branch, path, base]);
}

export async function removeWorktree(top: string, path: string, deleteBranch?: string): Promise<void> {
  await git(top, ['worktree', 'remove', '--force', path]).catch(() => {});
  await git(top, ['worktree', 'prune']).catch(() => {});
  if (deleteBranch && isBranchName(deleteBranch)) await git(top, ['branch', '-D', deleteBranch]).catch(() => {});
}

/** Commits everything in the folder, as the person if Git knows who they are. Null when nothing changed. */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(dir, ['add', '-A', '.']);
  if (!(await git(dir, ['status', '--porcelain'])).trim()) return null;
  const known = (await git(dir, ['config', 'user.email']).catch(() => '')).trim();
  const who = known ? [] : ['-c', 'user.name=Bogen', '-c', 'user.email=bogen@localhost'];
  await git(dir, [...who, 'commit', '--quiet', '--no-verify', '-F', '-'], { input: message });
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

export interface ChangedFile { path: string; status: string; additions: number | null; deletions: number | null }

export async function changedFiles(dir: string, base: string, head: string): Promise<ChangedFile[]> {
  const status = new Map<string, string>();
  for (const line of (await git(dir, ['diff', '--name-status', '--no-renames', `${base}..${head}`])).split('\n')) {
    const [s, path] = line.split('\t');
    if (s && path) status.set(path, s[0]!);
  }
  return (await git(dir, ['diff', '--numstat', '--no-renames', `${base}..${head}`])).split('\n').filter(Boolean).map((line) => {
    const [a, d, path = ''] = line.split('\t');
    return { path, status: status.get(path) ?? 'M', additions: a === '-' ? null : Number(a), deletions: d === '-' ? null : Number(d) };
  });
}

/** The text of the change, binary files named only. Long diffs are cut, and say so. */
export async function diffText(dir: string, base: string, head: string, limit = 400_000): Promise<{ text: string; truncated: boolean }> {
  const text = await git(dir, ['diff', '--no-color', '--no-ext-diff', '--no-renames', `${base}..${head}`]);
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

/** Pushes one branch to the remote, with the person's own credentials. Never with force. */
export async function pushBranch(dir: string, remote: string, branch: string): Promise<void> {
  if (!isBranchName(branch)) throw new HttpError(400, `"${branch}" is not a branch name.`);
  if (!/^[\w.-]{1,100}$/.test(remote)) throw new HttpError(400, `"${remote}" is not a remote.`);
  await git(dir, ['push', '--no-verify', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
}

/** `owner/name` and the web address of a GitHub remote, for links to files on the branch. */
export function githubRepo(remoteUrl: string | null): { slug: string; web: string } | null {
  if (!remoteUrl) return null;
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? { slug: `${m[1]}/${m[2]}`, web: `https://github.com/${m[1]}/${m[2]}` } : null;
}

/** Opens the pull request with the person's `gh`. Returns its address. */
export async function ghCreatePr(dir: string, options: { base: string; head: string; title: string; bodyFile: string }): Promise<string> {
  const out = await run('gh', ['pr', 'create', '--base', options.base, '--head', options.head, '--title', options.title, '--body-file', options.bodyFile], dir, {
    env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 120_000,
  });
  if (out.code !== 0) throw new HttpError(400, `gh pr create: ${lastLine(out.stderr) || lastLine(out.stdout) || `exited with ${out.code}`}`);
  const url = /https?:\/\/\S+/.exec(lastLine(out.stdout))?.[0] ?? /https?:\/\/\S+\/pull\/\d+/.exec(out.stdout)?.[0];
  if (!url) throw new HttpError(500, `gh opened something but did not say where: ${lastLine(out.stdout)}`);
  return url;
}

let ghSeen: { at: number; path: string | undefined; ok: Promise<boolean> } | null = null;

/** Whether `gh` is there, for the dialog to say so before anything is prepared. Asked once a minute at most. */
export function ghAvailable(): Promise<boolean> {
  if (ghSeen && Date.now() - ghSeen.at < 60_000 && ghSeen.path === process.env.PATH) return ghSeen.ok;
  const ok = run('gh', ['--version'], process.cwd(), { timeoutMs: 8000 }).then((r) => r.code === 0, () => false);
  ghSeen = { at: Date.now(), path: process.env.PATH, ok };
  return ok;
}
