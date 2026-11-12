import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HttpError } from './util.ts';

/**
 * GitHub Pages through the owner's own `gh`. Bogen never reads, stores or passes a token: every call is
 * `gh api`, which signs it with the login the owner made there. Files go up through the Git Data API as one
 * commit on the branch the owner named, beside whatever else is on it, and only after the owner saw the plan.
 */

export interface GhCli {
  /** `gh api <path>`, with a JSON body on stdin for anything but GET. Throws a `GhError` with the HTTP status. */
  api(path: string, options?: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown }): Promise<unknown>;
}

export class GhError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The real `gh`. Its output is read; its environment and login are its own business. */
export function ghCli(command = 'gh'): GhCli {
  return {
    api: (path, options = {}) => new Promise((resolve, reject) => {
      const method = options.method ?? 'GET';
      const args = ['api', '--method', method, '-H', 'Accept: application/vnd.github+json', path, ...(method === 'GET' ? [] : ['--input', '-'])];
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => { out += c; });
      child.stderr.on('data', (c: Buffer) => { err += c; });
      child.on('error', (e) => reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new GhError(0, 'The GitHub CLI, gh, is not installed. Install it and run gh auth login.') : e));
      child.on('close', (code) => {
        if (code === 0) {
          try {
            return resolve(out.trim() ? JSON.parse(out) : null);
          } catch {
            return reject(new GhError(0, 'gh gave an answer that is not JSON.'));
          }
        }
        const status = Number(/HTTP (\d{3})/.exec(err)?.[1] ?? 0);
        reject(new GhError(status, /auth login|not logged/i.test(err) ? 'gh is not logged in. Run gh auth login.' : err.trim().split('\n')[0]?.slice(0, 300) || `gh failed (${code}).`));
      });
      child.stdin.end(method === 'GET' ? undefined : JSON.stringify(options.body ?? {}));
    }),
  };
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!\/)[A-Za-z0-9._/-]{1,100}(?<!\/)(?<!\.lock)$/;
export const MARKER = '.bogen-publish.json';

export function checkRepo(repo: string, branch: string): void {
  if (!REPO.test(repo) || repo.includes('..')) throw new HttpError(400, 'Name the repository as owner/name.');
  if (!BRANCH.test(branch)) throw new HttpError(400, 'That is not a branch name Bogen will use.');
}

/** What git calls a file's id: SHA-1 of `blob <size>\0` and the bytes. */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export interface GhPlan {
  repo: string;
  branch: string;
  /** False when the branch is made by this push. */
  exists: boolean;
  /** Files Bogen sends, with their sizes. */
  upload: { path: string; bytes: number }[];
  /** Files already there as they are. */
  unchanged: string[];
  /** Files of an earlier publish that this one no longer has. */
  remove: string[];
  /** Files on the branch that Bogen did not write. They stay. */
  foreign: string[];
  /** Files Bogen would have to overwrite but did not write. While there are any, nothing is pushed. */
  blocked: string[];
  /** The state the plan was made against. A push checks it is still the same. */
  fingerprint: string;
  pagesUrl: string;
  message: string;
}

interface Remote {
  head?: string;
  tree?: string;
  files: Map<string, string>;
  marker: Record<string, string>;
}

async function remote(gh: GhCli, repo: string, branch: string): Promise<Remote> {
  let info: { permissions?: { push?: boolean } };
  try {
    info = await gh.api(`repos/${repo}`) as typeof info;
  } catch (e) {
    if (e instanceof GhError && e.status === 404) throw new HttpError(404, `gh cannot see ${repo}. Is the name right, and is gh logged in as someone who can push there?`);
    throw new HttpError(502, e instanceof Error ? e.message : String(e));
  }
  if (info?.permissions && info.permissions.push === false) throw new HttpError(403, `Your gh login cannot push to ${repo}.`);
  let head: string;
  try {
    head = ((await gh.api(`repos/${repo}/git/ref/heads/${branch}`)) as { object: { sha: string } }).object.sha;
  } catch (e) {
    if (e instanceof GhError && e.status === 404) return { files: new Map(), marker: {} };
    throw new HttpError(502, e instanceof Error ? e.message : String(e));
  }
  const commit = await gh.api(`repos/${repo}/git/commits/${head}`) as { tree: { sha: string } };
  const tree = await gh.api(`repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`) as { truncated?: boolean; tree: { path: string; type: string; sha: string }[] };
  if (tree.truncated) throw new HttpError(409, `The branch ${branch} holds too many files for Bogen to check. Use a branch of its own for the site.`);
  const files = new Map(tree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]));
  let marker: Record<string, string> = {};
  const markerSha = files.get(MARKER);
  if (markerSha) {
    try {
      const blob = await gh.api(`repos/${repo}/git/blobs/${markerSha}`) as { content: string };
      const parsed = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8')) as { files?: Record<string, string> };
      if (parsed && typeof parsed.files === 'object') marker = Object.fromEntries(Object.entries(parsed.files).filter(([k, v]) => typeof k === 'string' && typeof v === 'string'));
    } catch {
      marker = {};
    }
  }
  return { head, tree: commit.tree.sha, files, marker };
}

function pagesUrl(repo: string): string {
  const [owner, name] = repo.split('/') as [string, string];
  return name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${name.toLowerCase()}/` : `https://${owner.toLowerCase()}.github.io/${name}/`;
}

function planFrom(repo: string, branch: string, state: Remote, files: Map<string, Uint8Array>, versionId: string | null): GhPlan {
  const ours = new Map([...files].map(([path, bytes]) => [path, gitBlobSha(bytes)]));
  const upload: GhPlan['upload'] = [];
  const unchanged: string[] = [];
  const blocked: string[] = [];
  for (const [path, sha] of ours) {
    const there = state.files.get(path);
    if (there === sha) unchanged.push(path);
    else if (there === undefined || state.marker[path] === there) upload.push({ path, bytes: files.get(path)!.length });
    else blocked.push(path);
  }
  const remove = Object.entries(state.marker).filter(([path, sha]) => !ours.has(path) && state.files.get(path) === sha).map(([path]) => path);
  const foreign = [...state.files.keys()].filter((p) => p !== MARKER && !ours.has(p) && state.marker[p] !== state.files.get(p));
  const fingerprint = createHash('sha256').update(JSON.stringify({ head: state.head ?? null, ours: [...ours].sort(), remove, blocked, foreign })).digest('hex').slice(0, 32);
  return {
    repo, branch, exists: Boolean(state.head), upload, unchanged, remove, foreign, blocked, fingerprint, pagesUrl: pagesUrl(repo),
    message: versionId ? `Publish ${versionId.slice(0, 12)} from Bogen` : 'Unpublish from Bogen',
  };
}

/** What a push would do, read from the branch as it is now. Changes nothing. */
export async function planGithub(gh: GhCli, repo: string, branch: string, files: Map<string, Uint8Array>, versionId: string | null): Promise<GhPlan> {
  checkRepo(repo, branch);
  return planFrom(repo, branch, await remote(gh, repo, branch), files, versionId);
}

/**
 * The push the owner saw. Made again from the branch as it is now, and refused if that is not the plan they
 * confirmed, if it would overwrite a file Bogen did not write, or if it lands beside such files without their yes.
 */
export async function pushGithub(gh: GhCli, repo: string, branch: string, files: Map<string, Uint8Array>, versionId: string | null, confirm: { fingerprint: string; allowForeign: boolean }): Promise<GhPlan & { commit: string }> {
  checkRepo(repo, branch);
  const state = await remote(gh, repo, branch);
  const plan = planFrom(repo, branch, state, files, versionId);
  if (plan.fingerprint !== confirm.fingerprint) throw new HttpError(409, `${branch} changed since you looked at the plan. Look at it again.`);
  if (plan.blocked.length) throw new HttpError(409, `Nothing was pushed: ${plan.blocked.slice(0, 5).join(', ')} ${plan.blocked.length === 1 ? 'is' : 'are'} on ${branch} and Bogen did not write ${plan.blocked.length === 1 ? 'it' : 'them'}.`);
  if (plan.foreign.length && !confirm.allowForeign) throw new HttpError(409, `Nothing was pushed: ${branch} holds ${plan.foreign.length} files Bogen did not write. Confirm to publish beside them.`);
  if (!plan.exists && !versionId) return { ...plan, commit: '' };
  const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];
  for (const { path } of plan.upload) {
    const blob = await gh.api(`repos/${repo}/git/blobs`, { method: 'POST', body: { content: Buffer.from(files.get(path)!).toString('base64'), encoding: 'base64' } }) as { sha: string };
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const path of plan.remove) tree.push({ path, mode: '100644', type: 'blob', sha: null });
  const markerFiles = Object.fromEntries([...files].map(([path, bytes]) => [path, gitBlobSha(bytes)]));
  if (versionId) {
    const marker = Buffer.from(`${JSON.stringify({ publishedBy: 'Bogen', version: versionId, files: markerFiles }, null, 2)}\n`);
    const blob = await gh.api(`repos/${repo}/git/blobs`, { method: 'POST', body: { content: marker.toString('base64'), encoding: 'base64' } }) as { sha: string };
    tree.push({ path: MARKER, mode: '100644', type: 'blob', sha: blob.sha });
  } else if (state.files.has(MARKER)) tree.push({ path: MARKER, mode: '100644', type: 'blob', sha: null });
  const made = await gh.api(`repos/${repo}/git/trees`, { method: 'POST', body: { ...(state.tree ? { base_tree: state.tree } : {}), tree } }) as { sha: string };
  const commit = await gh.api(`repos/${repo}/git/commits`, { method: 'POST', body: { message: plan.message, tree: made.sha, parents: state.head ? [state.head] : [] } }) as { sha: string };
  if (state.head) await gh.api(`repos/${repo}/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
  else await gh.api(`repos/${repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  return { ...plan, commit: commit.sha };
}
