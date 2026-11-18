import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCommand, callLines, endReply, Runs, sessionIdOf, sessionKey, type RunEnd } from '../src/agents.ts';
import { transcript, type Turn } from '../src/conversations.ts';
import type { EventHub } from '../src/events.ts';

/**
 * A voice call keeps one Claude Code session per conversation: a change said while the agent works ends its turn the
 * way Ctrl+C does and continues that session with `--resume`, instead of starting a new run that reads everything again.
 */
describe('call sessions', () => {
  const base = { fileId: 'f1', fileName: 'F', prompt: 'brief', runner: 'claude' as const, conversationId: 'c1' };

  it('keeps the session of a call run and resumes it when asked', () => {
    const plain = buildCommand('claude', { ...base }, { url: 'http://x' }, '/tmp/c', '/tmp').args;
    expect(plain).toContain('--no-session-persistence');
    const call = buildCommand('claude', { ...base, call: { language: 'en' } }, { url: 'http://x' }, '/tmp/c', '/tmp').args;
    expect(call).not.toContain('--no-session-persistence');
    expect(call).not.toContain('--resume');
    const steer = buildCommand('claude', { ...base, call: { language: 'en', steer: true }, resumeSession: '3592cd16-daad-4fab-9b55-ffd7a44ad710' }, { url: 'http://x' }, '/tmp/c', '/tmp').args;
    expect(steer.join(' ')).toContain('--resume 3592cd16-daad-4fab-9b55-ffd7a44ad710');
  });

  it('tells a call run about the voice and the <say> block', () => {
    const args = buildCommand('claude', { ...base, call: { language: 'de' } }, { url: 'http://x' }, '/tmp/c', '/tmp').args;
    const prompt = args[args.indexOf('--append-system-prompt') + 1]!;
    expect(prompt).toContain('live voice call');
    expect(prompt).toContain('<say>');
    expect(prompt).toContain('German');
    expect(callLines('en').join(' ')).toMatch(/never ask them to paste/);
  });

  it('keeps a session only for a Claude Code run in a conversation, by file, and never for races, live sites, threads or proposals', () => {
    expect(sessionKey({ ...base })).toBe('f1|c1');
    expect(sessionKey({ ...base, fileId: 'f2' })).toBe('f2|c1');
    expect(sessionKey({ ...base, runner: 'codex' })).toBeNull();
    expect(sessionKey({ ...base, conversationId: undefined })).toBeNull();
    expect(sessionKey({ ...base, threadId: 't1' })).toBeNull();
    expect(sessionKey({ ...base, review: 'proposal' })).toBeNull();
    expect(sessionKey({ ...base, review: 'direct' })).toBe('f1|c1');
    expect(buildCommand('claude', { ...base, keepSession: true }, { url: 'http://x' }, '/tmp/c', '/tmp').args).not.toContain('--no-session-persistence');
  });

  it('keeps a review that was nudged and again changed nothing, and drops it when the change came after all', () => {
    const review = 'Top fix: the scenario screen. Also the kit check.\n<say>It looks strong; the top fix is the scenario screen.</say>';
    const after = 'You only asked for a review, so I left the design as it was.';
    expect(endReply({ reply: after, firstReply: review, nudged: true, changed: false })).toBe(`${review}\n\n${after}`);
    expect(endReply({ reply: 'Made it bigger.', firstReply: 'You are right.', nudged: true, changed: true })).toBe('Made it bigger.');
    expect(endReply({ reply: 'Plain.', nudged: false, changed: false })).toBe('Plain.');
  });

  it('gives the newest answer more room in the transcript, so "and the rest?" finds it', () => {
    const long = `Review: ${'point. '.repeat(400)}the last point is the kit check.`;
    const turns: Turn[] = [{ runId: 'r1', at: 1, runner: 'claude', message: 'review it', reply: long, layers: [], status: 'done' }];
    expect(transcript(turns)).toContain('the last point is the kit check');
    const older: Turn[] = [...turns, { runId: 'r2', at: 2, runner: 'claude', message: 'thanks', reply: 'ok', layers: [], status: 'done' }];
    expect(transcript(older)).not.toContain('the last point is the kit check');
  });

  it('reads the session id from the first line only', () => {
    expect(sessionIdOf('{"type":"system","subtype":"init","session_id":"3592cd16-daad-4fab-9b55-ffd7a44ad710"}')).toBe('3592cd16-daad-4fab-9b55-ffd7a44ad710');
    expect(sessionIdOf('{"type":"result","session_id":"3592cd16-daad-4fab-9b55-ffd7a44ad710"}')).toBeNull();
    expect(sessionIdOf('{"type":"system","subtype":"init","session_id":"../../etc"}')).toBeNull();
    expect(sessionIdOf('not json "session_id"')).toBeNull();
  });

  describe('with a stand-in claude', () => {
    let bin = '';
    let log = '';
    const savedPath = process.env.PATH;
    beforeAll(() => {
      bin = mkdtempSync(join(tmpdir(), 'bogen-call-bin-'));
      log = join(bin, 'log.jsonl');
      // Records its arguments and folder, announces a session, and on "hang" waits until it is interrupted.
      writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
let stdin = ''; process.stdin.on('data', (d) => { stdin += d; }); process.stdin.on('end', () => {
  const resume = process.argv.indexOf('--resume');
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin }) + '\\n');
  if (resume > 0 && stdin.includes('forget')) { console.error('No conversation found with session ID: ' + process.argv[resume + 1]); process.exit(1); }
  const id = resume > 0 ? process.argv[resume + 1] : '11111111-2222-3333-4444-555555555555';
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }));
  if (stdin === 'hang') {
    process.on('SIGINT', () => { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ signal: 'SIGINT' }) + '\\n'); process.exit(130); });
    setInterval(() => undefined, 1000);
    return;
  }
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok <say>Done.</say>' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));
});
`);
      chmodSync(join(bin, 'claude'), 0o755);
      process.env.PATH = `${bin}:${savedPath}`;
    });
    afterAll(() => { process.env.PATH = savedPath; rmSync(bin, { recursive: true, force: true }); });

    it('interrupts with SIGINT and continues the same session in the same folder', async () => {
      const ends: RunEnd[] = [];
      const hub = { broadcast: () => undefined, tap: () => () => undefined } as unknown as EventHub;
      const runs = new Runs(hub, () => ({ url: 'http://127.0.0.1:1/mcp' }), (end) => ends.push(end));
      const first = await runs.start({ ...base, prompt: 'hang', call: { language: 'en' } });
      await waitFor(() => runs.callSession('f1', 'c1') !== undefined);
      expect(runs.callSession('f1', 'c1')).toBe('11111111-2222-3333-4444-555555555555');
      expect(runs.stop(first, true)).toBe(true);
      await waitFor(() => ends.length === 1);
      expect(ends[0]!.status).toBe('stopped');
      await runs.start({ ...base, prompt: 'the change', call: { language: 'en', steer: true } });
      await waitFor(() => ends.length === 2);
      const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args?: string[]; cwd?: string; signal?: string; stdin?: string });
      const calls = lines.filter((l) => l.args);
      expect(lines.some((l) => l.signal === 'SIGINT')).toBe(true);
      expect(calls[1]!.args!.join(' ')).toContain('--resume 11111111-2222-3333-4444-555555555555');
      expect(calls[1]!.cwd).toBe(calls[0]!.cwd);
      expect(calls[1]!.stdin).toBe('the change');
      runs.close();
    });

    const hub = { broadcast: () => undefined, tap: () => () => undefined } as unknown as EventHub;
    const calls = (from: number) => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args?: string[]; cwd?: string; stdin?: string }).filter((l) => l.args).slice(from);
    const count = () => calls(0).length;
    const chat = { fileId: 'f2', fileName: 'F2', runner: 'claude' as const, conversationId: 'chat1' };

    it('resumes the session for a follow-up in the same file and conversation, not across files or models', async () => {
      const ends: RunEnd[] = [];
      const runs = new Runs(hub, () => ({ url: 'http://127.0.0.1:1/mcp' }), (end) => ends.push(end));
      const from = count();
      await runs.start({ ...chat, prompt: 'review the page', context: 'Earlier in this conversation: nothing' });
      await waitFor(() => ends.length === 1);
      await runs.start({ ...chat, prompt: 'and the rest?', context: 'Earlier in this conversation: the review' });
      await waitFor(() => ends.length === 2);
      // The same conversation in another file: never the other file's session.
      await runs.start({ ...chat, fileId: 'f3', prompt: 'and here?', context: 'Earlier in this conversation: f3' });
      await waitFor(() => ends.length === 3);
      // Another model in the same conversation: fresh, with the transcript.
      await runs.start({ ...chat, model: 'haiku', prompt: 'What about haiku?', context: 'Earlier in this conversation: the rest' });
      await waitFor(() => ends.length === 4);
      const [first, follow, other, model] = calls(from);
      expect(first!.args).not.toContain('--no-session-persistence');
      expect(first!.args).not.toContain('--resume');
      expect(follow!.args!.join(' ')).toContain('--resume 11111111-2222-3333-4444-555555555555');
      // The session holds the conversation, so the trimmed transcript is not sent again.
      expect(follow!.stdin).toBe('and the rest?');
      expect(follow!.cwd).toBe(first!.cwd);
      expect(other!.args).not.toContain('--resume');
      expect(other!.stdin).toContain('Earlier in this conversation: f3');
      expect(model!.args).not.toContain('--resume');
      expect(model!.stdin).toContain('Earlier in this conversation: the rest');
      runs.close();
    });

    it('starts fresh with the transcript when the session to resume is gone', async () => {
      const ends: RunEnd[] = [];
      const runs = new Runs(hub, () => ({ url: 'http://127.0.0.1:1/mcp' }), (end) => ends.push(end));
      const from = count();
      const c = { ...chat, conversationId: 'chat2' };
      await runs.start({ ...c, prompt: 'What is on the first page?' });
      await waitFor(() => ends.length === 1);
      await runs.start({ ...c, prompt: 'What did you forget?', context: 'Earlier in this conversation: first' });
      await waitFor(() => ends.length === 2);
      const [, resumed, fresh] = calls(from);
      expect(resumed!.args).toContain('--resume');
      expect(fresh!.args).not.toContain('--resume');
      expect(fresh!.stdin).toContain('Earlier in this conversation: first');
      expect(ends[1]!.status).toBe('done');
      expect(calls(from)).toHaveLength(3);
      runs.close();
    });
  });
});

async function waitFor(ok: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
