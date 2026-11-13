import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BogenDoc, docToContent, Y } from '@bogen/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PullDraft } from '../src/pull-requests.ts';
import { describeChange } from '../src/pull-requests.ts';
import { branchSlug, githubRepo, isBranchName } from '../src/repo-git.ts';
import { call, connectAgent, startServer, until, type Harness } from './helpers.ts';
import { makeRepoFixture, type RepoFixture } from './repo-fixture.ts';

const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('pull request pieces', () => {
  it('names branches after the change, and only safe ones', () => {
    expect(branchSlug('Design: Hero, darker title!')).toBe('bogen/design-hero-darker-title');
    expect(branchSlug('')).toBe('bogen/design-change');
    expect(isBranchName('bogen/design-hero')).toBe(true);
    for (const bad of ['-x', 'a..b', 'a/', 'x.lock', 'a b', '']) expect(isBranchName(bad), bad).toBe(false);
  });

  it('knows a GitHub remote, and nothing else', () => {
    expect(githubRepo('git@github.com:acme/app.git')).toEqual({ slug: 'acme/app', web: 'https://github.com/acme/app' });
    expect(githubRepo('https://github.com/acme/app')).toEqual({ slug: 'acme/app', web: 'https://github.com/acme/app' });
    expect(githubRepo('/tmp/remote.git')).toBeNull();
    expect(githubRepo('https://gitlab.com/acme/app.git')).toBeNull();
  });

  it('says what changed, field by field, also when accepting replaced the layers', () => {
    const doc = new BogenDoc(new Y.Doc());
    const page = doc.createPage('Page');
    const board = doc.insert(page, { type: 'frame', name: 'Hero', artboard: true, style: { width: '400px' } });
    doc.insert(board, { type: 'text', tag: 'h1', name: 'Title', text: 'Hello', style: { color: '#111111' } });
    const before = docToContent(doc);
    // A new layer of the same kind and name in the same place, as accepting a proposal leaves it.
    doc.delete(doc.getChildren(board).map((n) => n.id));
    doc.insert(board, { type: 'text', tag: 'h1', name: 'Title', text: 'Hello there', style: { color: '#e11d48' } });
    const lines = describeChange(before, docToContent(doc), [board]);
    expect(lines.some((l) => l.includes('style color #111111 -> #e11d48'))).toBe(true);
    expect(lines.some((l) => l.includes('text Hello -> Hello there'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Removed'))).toBe(false);
  });
});

describe('a pull request from a design change', () => {
  let fx: RepoFixture;
  let h: Harness;
  let agent: Client;
  let fileId = '';
  let board = '';
  let footer = '';
  const savedPath = process.env.PATH;

  const draft = async (id: string) => (await (await fetch(`${h.base}/api/code/pulls/${id}`)).json()) as PullDraft & { diff: string };
  const settled = async (id: string) => {
    await until(async () => !['running'].includes((await draft(id)).status), 60_000);
    return draft(id);
  };

  beforeAll(async () => {
    fx = makeRepoFixture({
      'package.json': '{"name":"acme-app","private":true,"dependencies":{"react":"^19","tailwindcss":"^4"}}',
      'src/Hero.tsx': 'export function Hero() {\n  return <h1 style={{ color: \'#111111\' }}>Hello</h1>;\n}\n',
      'README.md': '# App\n',
    });
    // GitHub as the remote people see, where gh opens the pull request; pushes still go to the bare folder.
    fx.git(['remote', 'set-url', 'origin', 'https://github.com/acme/app.git']);
    fx.git(['remote', 'set-url', '--push', 'origin', fx.remote]);
    process.env.PATH = `${fx.bin}:${savedPath}`;
    h = await startServer();
    agent = await connectAgent(h.base, 'claude');
    fileId = (await call(agent, 'file_create', { name: 'Landing' })).id;
    await call(agent, 'code_project_link', { dir: fx.repo });
    board = (await call(agent, 'artboard_create', { name: 'Hero', width: 480 })).id;
    await call(agent, 'html_write', { target_id: board, html: '<h1 style="color:#111111;font-size:40px;margin:0;padding:24px">Hello</h1>' });
    footer = (await call(agent, 'artboard_create', { name: 'Footer', width: 480 })).id;
    await call(agent, 'html_write', { target_id: footer, html: '<p style="margin:0;padding:16px">Small print</p>' });
    await call(agent, 'commit_create', { message: 'Before the change' });
    // The person's choice: a proposal with a red title, accepted.
    const made = await call(agent, 'proposal_create', { node_id: board });
    const proposal = made.proposals[0];
    const titleCopy = Object.entries(proposal.layers as Record<string, string>).find(([orig]) => orig !== board)![1];
    await call(agent, 'layer_style', { node_ids: [titleCopy], style: { color: '#e11d48' } });
    await call(agent, 'proposal_accept', { proposal_id: proposal.id });
  }, 60_000);

  afterAll(async () => {
    process.env.PATH = savedPath;
    await agent?.close();
    await h?.cleanup();
    fx?.cleanup();
  });

  let first: PullDraft & { diff: string };

  it('runs the agent in a working folder of its own, on a branch named after the change', async () => {
    const res = await fetch(`${h.base}/api/code/pulls`, post({ fileId, source: { kind: 'proposal', nodeId: board }, runner: 'claude', title: 'Red hero title', docsDir: 'docs/shots' }));
    expect(res.status, await res.clone().text()).toBe(201);
    const started = await res.json() as PullDraft;
    expect(started.status).toBe('running');
    expect(started.branch).toBe('bogen/red-hero-title');
    first = await settled(started.id);
    expect(first.error).toBeUndefined();
    expect(first.status).toBe('ready');

    const run = fx.agentCalls().find((c) => c.runner === 'claude')!;
    // The same limits as live site mode: the file tools of that folder, no built-in tools, an empty working folder.
    expect(run.tools?.sort()).toEqual(['edit_file', 'find_files', 'list_dir', 'read_file', 'search', 'write_file']);
    expect(run.args[run.args.indexOf('--tools') + 1]).toBe('');
    expect(run.args[run.args.indexOf('--allowedTools') + 1]).toBe('mcp__files__*');
    expect(run.cwd).not.toContain(fx.repo);
    expect(run.refused).toMatch(/outside/);
    expect(existsSync(join(fx.base, 'outside.txt'))).toBe(false);
    // What it was told: the change and the design as code.
    expect(run.stdin).toContain('## What changed in the design');
    expect(run.stdin).toMatch(/#111111 -> #e11d48/);
    expect(run.stdin).toContain('react-tailwind');
    expect(run.wrote).toBe('#e11d48');

    // The person's own checkout did not move, and nothing left the machine.
    expect(fx.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    expect(fx.git(['status', '--porcelain']).trim()).toBe('');
    expect(readFileSync(join(fx.repo, 'src/Hero.tsx'), 'utf8')).toContain('#111111');
    expect(fx.git(['ls-remote', '--heads', fx.remote]).trim()).not.toContain('bogen/');
    expect(fx.ghCalls()).toEqual([]);
  }, 90_000);

  it('commits the code with before and after pictures in the docs folder', () => {
    expect(fx.git(['branch', '--list', 'bogen/red-hero-title']).trim()).toContain('bogen/red-hero-title');
    const files = fx.git(['show', '--name-only', '--format=', first.commit!]).trim().split('\n').sort();
    expect(files).toEqual(['docs/shots/red-hero-title/after.png', 'docs/shots/red-hero-title/before.png', 'src/Hero.tsx']);
    expect(fx.git(['show', `${first.commit}:src/Hero.tsx`])).toContain('#e11d48');
    const png = Buffer.from(fx.git(['show', `${first.commit}:docs/shots/red-hero-title/after.png`]), 'latin1');
    expect(png.length).toBeGreaterThan(100);
    const message = fx.git(['log', '-1', '--format=%B', first.commit!]);
    expect(message).toMatch(/^Red hero title/);
    expect(message).toContain(`version ${first.version.id}`);
    expect(fx.git(['log', '-1', '--format=%an', first.commit!]).trim()).toBe('Fixture Person');
    expect(first.files.map((f) => f.path)).toContain('src/Hero.tsx');
    expect(first.diff).toContain('+  return <h1 style={{ color: \'#e11d48\' }}>Hello</h1>;');
  });

  it('writes a description with the pictures and a link back to the Bogen version', async () => {
    expect(first.body).toContain('Changed the colour of the hero title in src/Hero.tsx.');
    expect(first.body).toContain('| Before | After |');
    expect(first.body).toContain('![Before](https://github.com/acme/app/blob/bogen/red-hero-title/docs/shots/red-hero-title/before.png?raw=true)');
    expect(first.body).toContain('![After](https://github.com/acme/app/blob/bogen/red-hero-title/docs/shots/red-hero-title/after.png?raw=true)');
    expect(first.body).toContain(`/#/file/${fileId}?version=${first.version.id}`);
    expect(first.version.id).toMatch(/^[0-9a-z]+-[0-9a-f]{8}$/);
    const commits = await call(agent, 'commit_list', { file_id: fileId });
    expect(JSON.stringify(commits)).toContain(first.version.id);
    const before = await fetch(`${h.base}/api/code/pulls/${first.id}/picture/before`);
    expect(before.headers.get('content-type')).toBe('image/png');
  });

  it('pushes nothing without the confirmation of exactly what was shown', async () => {
    const open = (digest: string) => fetch(`${h.base}/api/code/pulls/${first.id}/open`, post({ digest }));
    expect((await open('not-what-was-shown')).status).toBe(409);
    // A changed title is a different pull request: the old confirmation no longer counts.
    const old = first.digest!;
    const patched = await (await fetch(`${h.base}/api/code/pulls/${first.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Red hero title, as designed' }) })).json() as PullDraft;
    expect(patched.digest).not.toBe(old);
    expect((await open(old)).status).toBe(409);
    expect(fx.git(['ls-remote', '--heads', fx.remote]).trim()).not.toContain('bogen/');
    expect(fx.ghCalls()).toEqual([]);
    // From another machine, not even with the right one.
    const foreign = await fetch(`${h.base}/api/code/pulls/${first.id}/open`, { ...post({ digest: patched.digest }), headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.0.0.2' } });
    expect(foreign.status).toBe(403);

    const res = await open(patched.digest!);
    expect(res.status, await res.clone().text()).toBe(200);
    const opened = await res.json() as PullDraft;
    expect(opened.status).toBe('opened');
    expect(opened.url).toBe('https://github.com/acme/app/pull/42');
    expect(fx.git(['ls-remote', '--heads', fx.remote])).toContain(`${first.commit}\trefs/heads/bogen/red-hero-title`);
    const gh = fx.ghCalls();
    expect(gh).toHaveLength(1);
    expect(gh[0]!.args.slice(0, 2)).toEqual(['pr', 'create']);
    expect(gh[0]!.args).toEqual(expect.arrayContaining(['--base', 'main', '--head', 'bogen/red-hero-title', '--title', 'Red hero title, as designed', '--body-file']));
    expect(gh[0]!.body).toBe(patched.body);
    expect((await open(patched.digest!)).status).toBe(409);
  }, 30_000);

  it('runs codex the same way, fails a run that changed nothing, and discards cleanly', async () => {
    const res = await fetch(`${h.base}/api/code/pulls`, post({ fileId, source: { kind: 'selection', nodeIds: [footer] }, runner: 'codex' }));
    expect(res.status, await res.clone().text()).toBe(201);
    const started = await res.json() as PullDraft;
    expect(started.branch).toBe('bogen/design-footer');
    const done = await settled(started.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/without changing a file/);
    const run = fx.agentCalls().find((c) => c.runner === 'codex')!;
    expect(run.args).toEqual(expect.arrayContaining(['--disable', 'shell_tool', 'unified_exec', '--ignore-user-config', '--ignore-rules', 'read-only']));
    expect(run.tools).toContain('edit_file');
    expect((await fetch(`${h.base}/api/code/pulls/${started.id}/open`, post({ digest: 'x' }))).status).toBe(409);
    expect((await fetch(`${h.base}/api/code/pulls/${started.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(fx.git(['branch', '--list', 'bogen/design-footer']).trim()).toBe('');
    expect(fx.git(['worktree', 'list']).trim().split('\n')).toHaveLength(1);
    expect((await fetch(`${h.base}/api/code/pulls/${started.id}`)).status).toBe(404);
  }, 90_000);

  it('refuses what it cannot do, before anything is made', async () => {
    const bad = await fetch(`${h.base}/api/code/pulls`, post({ fileId, source: { kind: 'selection', nodeIds: [board] }, runner: 'claude', docsDir: '../outside' }));
    expect(bad.status).toBe(400);
    const none = await fetch(`${h.base}/api/code/pulls`, post({ fileId, source: { kind: 'proposal', nodeId: footer }, runner: 'claude' }));
    expect(none.status).toBe(404);
    expect(fx.git(['branch', '--list']).trim().split('\n').map((b) => b.replace('*', '').trim()).sort()).toEqual(['bogen/red-hero-title', 'main']);
  });
  it('makes one from two versions, and a gh that fails leaves it ready to try again', async () => {
    const { doc } = await h.server.rooms.get(fileId);
    const title = doc.getChildren(board).find((n) => n.type === 'text')!.id;
    const from = (await call(agent, 'commit_create', { message: 'Red title' })).id as string;
    await call(agent, 'layer_style', { node_ids: [title], style: { color: '#2b3df2' } });
    const to = (await call(agent, 'commit_create', { message: 'Blue title' })).id as string;
    const res = await fetch(`${h.base}/api/code/pulls`, post({ fileId, source: { kind: 'versions', from, to }, runner: 'claude', title: 'Blue hero title', pictures: false }));
    expect(res.status, await res.clone().text()).toBe(201);
    const d = await settled((await res.json() as PullDraft).id);
    expect(d.status, d.error).toBe('ready');
    expect(d.version.id).toBe(to);
    expect(d.what).toBe(`versions ${from} to ${to}`);
    expect(d.pictures).toEqual({});
    const run = fx.agentCalls().filter((c) => c.runner === 'claude').at(-1)!;
    // Only the frame that changed, with what changed in it.
    expect(run.stdin).toContain('#e11d48 -> #2b3df2');
    expect(run.stdin).toContain('// Hero (');
    expect(run.stdin).not.toContain('// Footer (');

    fx.ghFails(true);
    const before = fx.ghCalls().length;
    const failed = await fetch(`${h.base}/api/code/pulls/${d.id}/open`, post({ digest: d.digest }));
    expect(failed.status).toBe(400);
    expect((await failed.json() as { error: string }).error).toMatch(/gh auth login/);
    const after = await draft(d.id);
    expect(after.status).toBe('ready');
    expect(after.error).toMatch(/gh auth login/);
    expect(fx.git(['ls-remote', '--heads', fx.remote])).toContain('refs/heads/bogen/blue-hero-title');
    fx.ghFails(false);
    const opened = await (await fetch(`${h.base}/api/code/pulls/${d.id}/open`, post({ digest: d.digest }))).json() as PullDraft;
    expect(opened.status).toBe('opened');
    expect(fx.ghCalls().length).toBe(before + 2);
    // The working folder goes once it is open; the branch stays, as it is on the remote.
    expect(fx.git(['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  }, 90_000);

  it('keeps one branch and working folder per chat, pushes later commits on top, and closes the chat on merge', async () => {
    const chat = 'chat-branch-1';
    const { doc } = await h.server.rooms.get(fileId);
    const title = doc.getChildren(board).find((n) => n.type === 'text')!.id;
    const v1 = (await call(agent, 'commit_create', { message: 'Before green' })).id as string;
    await call(agent, 'layer_style', { node_ids: [title], style: { color: '#16a34a' } });
    const v2 = (await call(agent, 'commit_create', { message: 'Green title' })).id as string;
    const res = await fetch(`${h.base}/api/code/pulls`, post({ fileId, source: { kind: 'versions', from: v1, to: v2 }, runner: 'claude', title: 'Chat title colour', pictures: false, conversationId: chat }));
    expect(res.status, await res.clone().text()).toBe(201);
    const one = await settled((await res.json() as PullDraft).id);
    expect(one.status, one.error).toBe('ready');
    expect(one.commits).toBe(1);
    const ghBefore = fx.ghCalls().length;
    const opened = await (await fetch(`${h.base}/api/code/pulls/${one.id}/open`, post({ digest: one.digest }))).json() as PullDraft;
    expect(opened.status).toBe('opened');
    expect(fx.ghCalls().length).toBe(ghBefore + 1);
    // The chat keeps its working folder for the next change.
    expect(fx.git(['worktree', 'list']).trim().split('\n')).toHaveLength(2);

    // The next change in the same chat: the same draft, branch and folder, one more commit, a new digest.
    await call(agent, 'layer_style', { node_ids: [title], style: { color: '#7c3aed' } });
    const v3 = (await call(agent, 'commit_create', { message: 'Violet title' })).id as string;
    const again = await fetch(`${h.base}/api/code/pulls`, post({ fileId, source: { kind: 'versions', from: v2, to: v3 }, runner: 'claude', pictures: false, conversationId: chat }));
    expect(again.status, await again.clone().text()).toBe(201);
    const two = await settled((await again.json() as PullDraft).id);
    expect(two.id).toBe(one.id);
    expect(two.branch).toBe(one.branch);
    expect(two.status, two.error).toBe('ready');
    expect(two.commits).toBe(2);
    expect(two.commit).not.toBe(one.commit);
    expect(two.digest).not.toBe(opened.digest);
    expect(fx.agentCalls().at(-1)!.stdin).toContain('already has 1 commit from earlier changes in the same chat');
    // The old confirmation does not push the new commit.
    expect((await fetch(`${h.base}/api/code/pulls/${two.id}/open`, post({ digest: opened.digest }))).status).toBe(409);
    const pushed = await (await fetch(`${h.base}/api/code/pulls/${two.id}/open`, post({ digest: two.digest }))).json() as PullDraft;
    expect(pushed.status).toBe('opened');
    expect(pushed.url).toBe(opened.url);
    // The pull request is there already: the push updated it, gh was not asked again, and nothing was forced.
    expect(fx.ghCalls().length).toBe(ghBefore + 1);
    expect(fx.git(['ls-remote', '--heads', fx.remote])).toContain(`${two.commit}\trefs/heads/${two.branch}`);
    expect(fx.git(['rev-list', '--count', `${one.commit}..${two.commit}`]).trim()).toBe('1');

    // Not merged yet: nothing changes.
    expect(await (await fetch(`${h.base}/api/code/pulls/check`, post({}))).json()).toEqual({ merged: [] });
    // Merged into main in the repository, as after a pull: the chat closes.
    fx.git(['merge', '--quiet', '--no-ff', '-m', 'Merge the chat branch', two.branch]);
    expect(await (await fetch(`${h.base}/api/code/pulls/check`, post({}))).json()).toEqual({ merged: [two.id] });
    const merged = await draft(two.id);
    expect(merged.status).toBe('merged');
    expect(merged.merged).toMatchObject({ via: 'local', into: 'main' });
    expect(fx.git(['worktree', 'list']).trim().split('\n')).toHaveLength(1);
    const conversation = await (await fetch(`${h.base}/api/runs/conversations/${chat}?fileId=${fileId}`)).json() as { closed?: { reason: string; branch: string } };
    expect(conversation.closed).toMatchObject({ reason: 'merged', branch: two.branch, into: 'main', url: opened.url });
    // A new message in that chat starts a new branch: the merged one is done.
    expect(h.server.pulls.ofConversation(fileId, chat)).toBeUndefined();
  }, 120_000);

  it('opens the repository as a canvas on a design branch, without starting anything of it', async () => {
    const out = await call(agent, 'repo_canvas_open', { file_id: fileId, components: 0 });
    expect(out.branch.name).toBe('acme-app on main');
    expect(out.git).toMatchObject({ branch: 'main' });
    expect(out.capture).toBeUndefined();
    const { doc } = await h.server.rooms.get(fileId);
    expect(doc.getPages().some((p) => p.id === out.page_id || p.id === out.pageId)).toBe(true);
    const branches = await call(agent, 'design_branch_list', { file_id: fileId });
    expect(JSON.stringify(branches)).toContain('acme-app on main');
    const bad = await fetch(`${h.base}/api/code/canvas`, post({ fileId, url: 'javascript:alert(1)' }));
    expect(bad.status).toBe(400);
  });

  it('asks gh about merges on GitHub only when the person turned it on', async () => {
    expect(await (await fetch(`${h.base}/api/code/pulls/settings`)).json()).toEqual({ githubMerges: false });
    const patched = await (await fetch(`${h.base}/api/code/pulls/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ githubMerges: true }) })).json();
    expect(patched).toEqual({ githubMerges: true });
    await fetch(`${h.base}/api/code/pulls/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ githubMerges: false }) });
  });
});
