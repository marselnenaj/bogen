import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptProposal, createProposals, listProposals, newId, rectFromStyle } from '@bogen/core';
import type { RunnerId } from './agents.ts';
import type { BogenServer } from './http/server.ts';
import type { PullDraft } from './pull-requests.ts';
import { errorMessage } from './util.ts';

/**
 * `bogen agents check --repo`: the round trip from a design change to a merged branch, once, for real, and with
 * nothing reaching the network or the person's data. A throwaway Git repository with a bare repository next to it
 * as its remote, a tiny page served on 127.0.0.1 as its dev server, and a throwaway Bogen server with its own data
 * folder on a spare port. The person's own `claude` (or `codex`) makes the change, logged in as they are; Bogen
 * gives it only the file tools of the working folder (`--mcp-config` with `--strict-mcp-config`, no built-in tools).
 *
 * Steps: link the repository, open its page as a canvas on a design branch (capture of the dev server and its
 * components), accept a proposal that turns the title red, make the pull request in a working folder of the chat,
 * push with the confirmed digest (to the bare repository; `gh` is not asked, the remote is not GitHub), merge it
 * there as a reviewer would, and see the chat close. The run's trace is kept as the transcript.
 */

export type RepoStepName = 'repository' | 'canvas' | 'proposal' | 'run' | 'commit' | 'push' | 'merge' | 'closed';
export interface RepoStep { name: RepoStepName; ok: boolean; detail: string; seconds: number }
export interface RepoCheck {
  id: string; status: 'running' | 'done' | 'failed'; runner: RunnerId; model?: string; startedAt: number; endedAt?: number;
  steps: RepoStep[]; folder: string; transcript?: string; draft?: Pick<PullDraft, 'id' | 'branch' | 'status' | 'commit' | 'files' | 'error' | 'summary'>; error?: string;
}
export interface RepoCheckOptions { runner?: RunnerId; model?: string; keep?: boolean; timeoutMs?: number; progress?: (check: RepoCheck) => void; parent?: string }

const RUN_TIMEOUT_MS = 6 * 60_000;
export const HERO_TSX = `export function Hero() {
  return (
    <section style={{ padding: '48px', background: '#ffffff' }}>
      <h1 style={{ color: '#111111', fontSize: '40px', margin: 0 }}>Plan your summer</h1>
      <p style={{ color: '#444444', fontSize: '18px' }}>Tickets from Friday.</p>
    </section>
  );
}
`;
export const INDEX_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Summer</title></head>
<body style="margin:0;font-family:sans-serif"><main><section style="padding:48px;background:#ffffff">
<h1 style="color:#111111;font-size:40px;margin:0">Plan your summer</h1>
<p style="color:#444444;font-size:18px">Tickets from Friday.</p></section></main></body></html>
`;

const QUIET = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Bogen check', '-c', 'user.email=check@localhost', '-c', 'init.defaultBranch=main'];

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile('git', [...QUIET, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }, timeout: 60_000 }, (err, stdout, stderr) => (err ? fail(new Error(`git ${args[0]}: ${stderr.trim() || err.message}`)) : done(stdout)));
  });
}

/** The repository, its bare remote, and its page on a port of 127.0.0.1. */
export async function makeCheckRepo(base: string): Promise<{ app: string; remote: string; devUrl: string; dev: Server }> {
  const app = join(base, 'app');
  const remote = join(base, 'remote.git');
  await git(base, ['init', '--quiet', '--bare', '-b', 'main', remote]);
  await mkdir(join(app, 'src'), { recursive: true });
  await writeFile(join(app, 'package.json'), '{"name":"summer-site","private":true,"dependencies":{"react":"^19","react-dom":"^19"}}\n');
  await writeFile(join(app, 'src/Hero.tsx'), HERO_TSX);
  await writeFile(join(app, 'index.html'), INDEX_HTML);
  await writeFile(join(app, 'README.md'), '# Summer site\n');
  await git(app, ['init', '--quiet', '-b', 'main']);
  await git(app, ['add', '-A']);
  await git(app, ['commit', '--quiet', '--no-verify', '-m', 'Start']);
  await git(app, ['remote', 'add', 'origin', remote]);
  await git(app, ['push', '--quiet', '--no-verify', '-u', 'origin', 'main']);
  const dev = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(INDEX_HTML);
  });
  await new Promise<void>((done) => dev.listen(0, '127.0.0.1', done));
  const port = (dev.address() as { port: number }).port;
  return { app, remote, devUrl: `http://127.0.0.1:${port}`, dev };
}

/** Merges the branch in the remote as a reviewer would: in a clone of its own, with a merge commit, then a push. */
export async function mergeInRemote(base: string, remote: string, branch: string): Promise<string> {
  const clone = join(base, `reviewer-${newId(6)}`);
  await git(base, ['clone', '--quiet', remote, clone]);
  await git(clone, ['merge', '--quiet', '--no-ff', '--no-verify', '-m', `Merge ${branch}`, `origin/${branch}`]);
  await git(clone, ['push', '--quiet', '--no-verify', 'origin', 'main']);
  return (await git(clone, ['rev-parse', 'HEAD'])).trim();
}

export async function runRepoCheck(options: RepoCheckOptions = {}): Promise<RepoCheck> {
  const runner = options.runner ?? 'claude';
  const base = await mkdtemp(join(options.parent ?? tmpdir(), 'bogen-repo-check-'));
  const check: RepoCheck = { id: newId(), status: 'running', runner, startedAt: Date.now(), steps: [], folder: base };
  const tell = () => options.progress?.(structuredClone(check));
  let at = Date.now();
  const step = (name: RepoStepName, ok: boolean, detail: string) => {
    check.steps.push({ name, ok, detail, seconds: Math.round((Date.now() - at) / 100) / 10 });
    at = Date.now();
    tell();
    if (!ok) throw new Error(`${name}: ${detail}`);
  };
  const { BogenServer } = await import('./http/server.ts');
  const home = join(base, 'home');
  const server: BogenServer = new BogenServer({ home, port: 0, exportDir: join(base, 'exports') });
  // The check asks whether the round trip works, not whether a throwaway page passes design review.
  server.runs.beforeFinish = undefined;
  let dev: Server | undefined;
  try {
    const repo = await makeCheckRepo(base);
    dev = repo.dev;
    await server.listen();
    const info = (await server.runs.runners()).find((r) => r.id === runner);
    if (!info?.available) throw new Error(`${runner} is not installed here, or not on the PATH.`);
    const choice = options.model ? { model: options.model } : await server.runSettings.resolve(runner, 'comment', {});
    if (choice.model) check.model = choice.model;
    const entry = server.storage.create('Repository check');
    const conversationId = `check${newId(8)}`;
    const project = await server.codeProjects.link(repo.app);
    const { linkFileToProject } = await import('./http/code-routes.ts');
    await linkFileToProject(server, entry.id, project, 'person:Check');
    step('repository', true, `Linked ${project.name} at ${repo.app}, remote ${repo.remote}, dev server ${repo.devUrl}.`);

    const { openRepoCanvas } = await import('./repo-canvas.ts');
    const canvas = await openRepoCanvas(server, { fileId: entry.id, url: repo.devUrl, components: 4, conversationId, by: 'Check', kind: 'person', origin: 'person:Check' });
    step('canvas', Boolean(canvas.capture) && canvas.components.placed.length > 0, canvas.capture
      ? `Branch "${canvas.branch.name}", capture ${canvas.capture.nodeId} with ${canvas.capture.layers} layers, ${canvas.components.placed.length} of ${canvas.components.total} components placed.`
      : canvas.captureError ?? 'Nothing was captured.');

    // The person's design change: a proposal of the captured page with a red title, accepted.
    const room = await server.rooms.get(entry.id);
    const { doc } = room;
    const board = canvas.capture!.nodeId;
    const { createCommit } = await import('./history-ops.ts');
    await createCommit(server, entry.id, { message: 'Before the change', author: 'Check', authorKind: 'person' });
    const [proposalId] = doc.transact(() => createProposals(doc, board, { by: 'Check', count: 1, rect: rectFromStyle(doc.getNode(board)!) }), 'person:Check');
    const heading = doc.descendants(proposalId!).find((n) => n.tag === 'h1');
    if (!heading) throw new Error('The capture has no h1 to change.');
    doc.transact(() => doc.updateStyle(heading.id, { color: '#e11d48' }), 'person:Check');
    doc.transact(() => acceptProposal(doc, proposalId!), 'person:Check');
    await server.timeline.flush(entry.id);
    step('proposal', !listProposals(doc).length, `Accepted a proposal of "${doc.getNode(board)?.name}" with the title in #e11d48.`);

    const started = await server.pulls.startDesign({ fileId: entry.id, source: { kind: 'proposal', nodeId: board }, runner, ...choice, title: 'Red hero title', conversationId });
    const deadline = Date.now() + (options.timeoutMs ?? RUN_TIMEOUT_MS);
    let draft = await server.pulls.get(started.id);
    while (draft.status === 'running') {
      if (Date.now() > deadline && draft.runId) server.runs.stop(draft.runId);
      await new Promise((r) => setTimeout(r, 500));
      draft = await server.pulls.get(started.id);
    }
    if (draft.runId) {
      const trace = await server.traces.get(draft.runId);
      if (trace) {
        check.transcript = join(options.parent ?? tmpdir(), `bogen-repo-check-${check.id}.trace.json`);
        await writeFile(check.transcript, `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
      }
    }
    check.draft = { id: draft.id, branch: draft.branch, status: draft.status, ...(draft.commit ? { commit: draft.commit } : {}), files: draft.files, ...(draft.error ? { error: draft.error } : {}), ...(draft.summary ? { summary: draft.summary } : {}) };
    const tsx = draft.status === 'ready' ? await git(join(base, 'home', 'pulls', draft.id, 'tree'), ['show', 'HEAD:src/Hero.tsx']).catch(() => '') : '';
    step('run', draft.status === 'ready', draft.status === 'ready' ? `${runner} changed ${draft.files.length} file(s): ${draft.files.map((f) => f.path).join(', ')}.` : draft.error ?? `It ended as ${draft.status}.`);
    step('commit', /#e11d48/i.test(tsx), /#e11d48/i.test(tsx) ? `Commit ${draft.commit?.slice(0, 7)} on ${draft.branch} has the red title in src/Hero.tsx.` : 'src/Hero.tsx on the branch does not have #e11d48.');

    const opened = await server.pulls.open(draft.id, draft.digest!);
    const onRemote = (await git(base, ['ls-remote', '--heads', repo.remote, draft.branch])).trim();
    step('push', opened.status === 'opened' && onRemote.startsWith(opened.commit ?? '-'), `Pushed ${draft.branch} to the local remote with the confirmed digest, ${opened.url ? `opened ${opened.url}` : 'no gh needed'}.`);

    const mergedAt = await mergeInRemote(base, repo.remote, draft.branch);
    const merged = await server.pulls.checkMerges();
    const after = await server.pulls.get(draft.id);
    step('merge', merged.some((m) => m.id === draft.id) && after.status === 'merged', `Merged in the remote as ${mergedAt.slice(0, 7)}; Bogen saw it ${after.merged?.via === 'local' ? 'in the repository' : 'nowhere'}.`);

    await new Promise((r) => setTimeout(r, 50));
    const conversation = await server.conversations.get(entry.id, conversationId);
    step('closed', conversation?.closed?.reason === 'merged', conversation?.closed ? `The chat is closed: merged ${conversation.closed.branch} into ${conversation.closed.into}.` : 'The chat is still open.');
    check.status = 'done';
  } catch (e) {
    check.status = 'failed';
    check.error = errorMessage(e);
  } finally {
    check.endedAt = Date.now();
    await server.close().catch(() => {});
    await new Promise<void>((done) => (dev ? dev.close(() => done()) : done()));
    if (!options.keep) await rm(base, { recursive: true, force: true }).catch(() => {});
  }
  tell();
  return check;
}

export function repoCheckReport(check: RepoCheck, kept = false): string {
  const lines = [`${check.runner}${check.model ? `, model ${check.model}` : ''}`];
  for (const s of check.steps) lines.push(`  ${s.ok ? 'pass' : 'FAIL'}  ${s.name.padEnd(10)} ${s.detail} (${s.seconds} s)`);
  if (check.draft?.summary) lines.push('', `What the agent said: ${check.draft.summary.replace(/\s+/g, ' ').slice(0, 400)}`);
  if (check.error) lines.push('', `The check stopped: ${check.error}`);
  if (check.transcript) lines.push('', `Transcript (the run's trace): ${check.transcript}`);
  lines.push(`Folder: ${check.folder}${kept ? '' : ' (removed; pass --keep to look at it)'}`);
  lines.push('', `${check.steps.filter((s) => s.ok).length} of 8 steps passed in ${Math.round(((check.endedAt ?? Date.now()) - check.startedAt) / 1000)} s.`);
  return lines.join('\n');
}

export async function repoCheckCommand(options: { runner?: string; model?: string; keep: boolean; json: boolean }, write: (text: string) => void): Promise<number> {
  if (options.runner && options.runner !== 'claude' && options.runner !== 'codex') {
    write(`bogen: --runner is claude or codex, not "${options.runner}".\n`);
    return 2;
  }
  if (!options.json) write(`Running your real ${options.runner ?? 'claude'} once on a throwaway repository with a local remote. This uses your plan: one small run.\n`);
  const said = new Set<string>();
  const check = await runRepoCheck({
    ...(options.runner ? { runner: options.runner as RunnerId } : {}), ...(options.model ? { model: options.model } : {}), keep: options.keep,
    progress: (now) => {
      if (options.json) return;
      for (const s of now.steps) {
        if (said.has(s.name)) continue;
        said.add(s.name);
        write(`${s.ok ? 'pass' : 'FAIL'} ${s.name} (${s.seconds} s)\n`);
      }
    },
  });
  write(options.json ? `${JSON.stringify(check, null, 2)}\n` : `\n${repoCheckReport(check, options.keep)}\n`);
  return check.status === 'done' && check.steps.length === 8 && check.steps.every((s) => s.ok) ? 0 : 1;
}
