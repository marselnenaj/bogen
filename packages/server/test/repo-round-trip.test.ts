import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLocalRemote } from '../src/pull-requests.ts';
import { runRepoCheck, type RepoCheck } from '../src/repo-check.ts';
import type { RunTrace } from '../src/run-trace.ts';
import { makeRepoFixture, type RepoFixture } from './repo-fixture.ts';

/**
 * `bogen agents check --repo` with the stand-in CLIs of the pull request tests on PATH: the whole round trip, from a
 * repository's page as a canvas to a merged branch and a closed chat, with nothing but a local remote. The real
 * CLI runs the same code once by hand; this keeps it working without spending anyone's plan.
 */
describe('the repository round trip', () => {
  let fx: RepoFixture;
  let parent = '';
  let check: RepoCheck;
  const savedPath = process.env.PATH;

  beforeAll(async () => {
    // Only for its stand-in claude, codex and gh.
    fx = makeRepoFixture({ 'README.md': '# unused\n' });
    process.env.PATH = `${fx.bin}:${savedPath}`;
    parent = mkdtempSync(join(tmpdir(), 'bogen-rt-'));
    check = await runRepoCheck({ runner: 'claude', parent, keep: true, timeoutMs: 60_000 });
  }, 180_000);

  afterAll(() => {
    process.env.PATH = savedPath;
    fx?.cleanup();
    if (parent) rmSync(parent, { recursive: true, force: true });
  });

  it('goes through every step, from the canvas to a merged branch and a closed chat', () => {
    expect(check.error, JSON.stringify(check.steps, null, 1)).toBeUndefined();
    expect(check.steps.map((s) => [s.name, s.ok])).toEqual([
      ['repository', true], ['canvas', true], ['proposal', true], ['run', true], ['commit', true], ['push', true], ['merge', true], ['closed', true],
    ]);
    expect(check.draft?.files.map((f) => f.path)).toContain('src/Hero.tsx');
  });

  it('pushes to the local remote without asking gh, and never with force', () => {
    expect(fx.ghCalls()).toEqual([]);
    const run = fx.agentCalls().at(-1)!;
    expect(run.args).toEqual(expect.arrayContaining(['--mcp-config', '--strict-mcp-config', '--tools', '']));
    expect(run.args[run.args.indexOf('--allowedTools') + 1]).toBe('mcp__files__*');
    expect(run.refused).toMatch(/outside/);
  });

  it('keeps the run as a transcript, with file contents left out', () => {
    const trace = JSON.parse(readFileSync(check.transcript!, 'utf8')) as RunTrace;
    expect(trace.format).toBe('bogen-run-trace');
    expect(trace.source).toBe('live');
    expect(trace.prompt.request).toContain('## What changed in the design');
    expect(trace.prompt.instructions).toMatch(/working folder Bogen made/);
    const read = trace.calls.find((c) => c.tool === 'read_file')!;
    expect(read.server).toBe('files');
    expect(read.result).toMatch(/^\[file content left out: \d+ characters\]$/);
    const edit = trace.calls.find((c) => c.tool === 'edit_file')!;
    expect(JSON.stringify(edit.args)).toMatch(/file content left out/);
    // The design is Bogen's own and stays; the file as the repository has it does not.
    expect(JSON.stringify(trace)).not.toContain("padding: '48px'");
    expect(trace.prompt.request).not.toMatch(/WebkitTextFillColor/);
    expect(trace.files).toContain('src/Hero.tsx');
  });

  it('knows a folder remote from a network one', () => {
    expect(isLocalRemote(fx.remote)).toBe(true);
    expect(isLocalRemote('git@github.com:acme/app.git')).toBe(false);
    expect(isLocalRemote('https://example.com/app.git')).toBe(false);
    expect(isLocalRemote(null)).toBe(false);
  });
});
