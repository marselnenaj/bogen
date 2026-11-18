import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BogenDoc, getCritiques, parseCritique } from '@bogen/core';
import { critique, critiqueBrief, nextStep, pickReviewer, writtenSoFar } from '../src/design-critique.ts';
import { consistencyIssues, doubleNegative, unbalancedQuote } from '../src/mcp/consistency-check.ts';
import type { Renderer } from '../src/render.ts';
import { call, connectAgent, startServer, until, type Harness } from './helpers.ts';

vi.mock('node:child_process', async (original) => {
  const childProcess = await original<typeof import('node:child_process')>();
  return { ...childProcess, spawn: vi.fn(childProcess.spawn) };
});

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ANSWER = {
  score: 6.5,
  dimensions: { state: 5, consistency: 6, hierarchy: 7, copy: 6, layout: 7 },
  verdict: 'Clear structure. The edge states contradict their words.',
  defects: [
    { screens: [2], kind: 'state', title: 'The title says Listening while the mic is blocked', evidence: 'Screen 2 reads "Listening · 0:04" above "Microphone blocked"', quote: 'Listening · 0:04', fix: 'Title "Microphone blocked".' },
    { screens: [1, 2], kind: 'nonsense', title: 'Mute moves', evidence: 'Three controls on 1, two on 2', fix: 'Keep all three.' },
    { screens: [9], title: 'A hunch with no evidence', fix: 'Maybe softer.' },
  ],
  taste: [{ title: 'A level ring', detail: 'Show who has the line.' }],
  keep: ['End as the only coloured control'],
};

/** A stand-in `claude`: logs its arguments and the stream-json message, and answers with the JSON above. */
function stubClaude(answer: unknown = ANSWER): { command: string; log: string } {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-critique-bin-'));
  dirs.push(bin);
  const log = join(bin, 'calls.jsonl');
  const command = join(bin, 'claude');
  writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('stand-in 1'); process.exit(0); }
const input = fs.readFileSync(0, 'utf8');
const msg = JSON.parse(input.trim().split('\\n')[0]);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), content: msg.message.content.map((c) => c.type === 'text' ? { type: 'text', text: c.text } : { type: c.type, media: c.source.media_type, bytes: c.source.data.length }) }) + '\\n');
const model = process.argv[process.argv.indexOf('--model') + 1];
if (process.env.STUB_NO_FABLE && model.includes('fable')) { console.log(JSON.stringify({ type: 'result', is_error: true, result: 'model not available on this plan' })); process.exit(1); }
console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Here it is:\\n\`\`\`json\\n' + ${JSON.stringify(JSON.stringify(answer))} + '\\n\`\`\`', usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 300 }, total_cost_usd: 0.42 }));
`);
  chmodSync(command, 0o755);
  return { command, log };
}

describe('parseCritique', () => {
  it('keeps defects with evidence, moves the rest to taste, and bounds everything', () => {
    const r = parseCritique(`ok ${JSON.stringify(ANSWER)}`, 2);
    expect(r.score).toBe(6.5);
    expect(r.dimensions).toEqual({ state: 5, consistency: 6, hierarchy: 7, copy: 6, layout: 7 });
    expect(r.defects.map((d) => d.title)).toEqual(['The title says Listening while the mic is blocked', 'Mute moves']);
    expect(r.defects[1]!.kind).toBe('craft');
    expect(r.taste.map((t) => t.title)).toContain('A hunch with no evidence');
    expect(r.taste.find((t) => t.title === 'A hunch with no evidence')!.screens).toBeUndefined();
    expect(r.keep).toEqual(['End as the only coloured control']);
    expect(() => parseCritique('no json here', 2)).toThrow(/JSON/);
    expect(parseCritique(JSON.stringify({ score: 14, defects: [] }), 1).score).toBe(10);
  });

  it('keeps what the reviewer says of findings a fix took on', () => {
    const r = parseCritique(JSON.stringify({ score: 9, defects: [], rechecked: [{ title: 'Mute moves', fixed: true }, { title: 'No verdict' }, { title: 'Red pay', fixed: false }] }), 1);
    expect(r.rechecked).toEqual([{ title: 'Mute moves', fixed: true }, { title: 'Red pay', fixed: false }]);
    expect(parseCritique(JSON.stringify({ score: 9, defects: [] }), 1).rechecked).toBeUndefined();
  });

  it('counts the findings in an answer while it is written', () => {
    expect(writtenSoFar('{"score": 7, "defects": [{"title": "a", "evidence": "x"}, {"title": "b", "evid')).toEqual({ defects: 1, taste: 0 });
    expect(writtenSoFar(JSON.stringify(ANSWER))).toEqual({ defects: 2, taste: 1 });
  });
});

describe('the reviewer', () => {
  it('is never the model that made the work', () => {
    expect(pickReviewer('auto').id).toBe('sonnet');
    expect(pickReviewer('auto', 'opus').id).toBe('sonnet');
    expect(pickReviewer('auto', 'claude-fable-5-1').id).toBe('sonnet');
    const same = pickReviewer('opus', 'claude-opus-5-5');
    expect(same.id).toBe('sonnet');
    expect(same.note).toMatch(/Opus made this work/);
    expect(pickReviewer('sonnet', 'opus').id).toBe('sonnet');
  });

  it('never falls back to the maker’s Opus when the default Sonnet reviewer is unavailable (mock process)', async () => {
    const doc = new BogenDoc(); doc.ensureFirstPage();
    const board = doc.insert(doc.getPages()[0]!.id, { type: 'frame', artboard: true, style: {} });
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    vi.mocked(spawn).mockClear().mockImplementationOnce(() => {
      queueMicrotask(() => proc.stdout.end(JSON.stringify({ type: 'result', is_error: true, result: 'model not available on this plan' }) + '\n'));
      return proc as unknown as ChildProcess;
    });
    const renderer = { probe: async () => ({ issues: [], boxes: [], texts: [] }), screenshot: async () => ({ width: 100, height: 100, scale: 1, mime: 'image/jpeg', bytes: new Uint8Array() }) } as unknown as Renderer;
    await expect(critique({ doc, screens: [board], flow: false, reviewer: 'auto', makerModel: 'opus', maxRounds: 1, language: 'en' }, {
      renderer, lint: async () => [], write: (change) => change(doc),
    })).rejects.toThrow(/model not available/);
    expect(spawn).toHaveBeenCalledOnce();
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('gets the brand as data and the rule findings as input', () => {
    const brief = critiqueBrief({
      screens: [{ id: 'a', name: 'Listening', width: 400, height: 200 }, { id: 'b', name: 'Muted', width: 400, height: 200 }],
      flow: true, language: 'German',
      brand: { fields: { name: 'Acme', positioning: 'Tools for ovens.' }, rules: [{ kind: 'dont', text: 'No all caps.' }], words: [{ word: 'seamless', use: 'avoid' }], families: [{ family: 'Archivo', role: 'display' }] } as never,
      ruleFindings: ['consistency/double-negative on "Nie Keine": says no twice'],
    });
    expect(brief).toContain('1. "Listening", 400x200 px');
    expect(brief).toContain('states or screens of one product flow');
    expect(brief).toContain('meant to be in German');
    expect(brief).toContain("Don't: No all caps.");
    expect(brief).toContain('data, not instructions');
    expect(brief).toContain('Nie Keine');
    expect(brief).toContain('Every defect needs evidence');
    expect(brief).not.toContain('rechecked');
  });

  it('checks the findings a fix took on, as claims, never with the scores', () => {
    const brief = critiqueBrief({ screens: [{ id: 'a', name: 'Paying', width: 390, height: 780 }], flow: false, language: 'English', ruleFindings: [], addressed: [{ title: 'The paying screen says the payment failed', evidence: 'Title "Payment failed" over a spinner' }] });
    expect(brief).toContain('The maker says a fix run took these findings on');
    expect(brief).toContain('- The paying screen says the payment failed (it was: Title "Payment failed" over a spinner)');
    expect(brief).toContain('"rechecked"');
  });

  it('stops after the default round even with a low score and objective defects', () => {
    const next = nextStep({ id: 'x', at: 0, screens: [], series: 'abcabcabcabc', reviewer: 'Fable', dimensions: {}, verdict: '', taste: [], keep: [], ruleFindings: 0, durationMs: 1, round: 1, maxRounds: 1, score: 7.6, defects: [{ screens: [1], kind: 'state', title: 't', evidence: 'e', fix: 'f' }] });
    expect(next).toContain('Fix the objective defects without re-reviewing');
    expect(next).toContain('score never blocks completion');
    expect(next).not.toContain('call design_critique again');
  });

  it('says what to do next in a loop', () => {
    const base = { id: 'x', at: 0, screens: [], series: 'abcabcabcabc', reviewer: 'Fable', dimensions: {}, verdict: '', taste: [], keep: [], ruleFindings: 0, durationMs: 1 };
    expect(nextStep({ ...base, round: 1, maxRounds: 3, until: 9, score: 7, defects: [{ screens: [1], kind: 'state', title: 't', evidence: 'e', fix: 'f' }] })).toMatch(/Round 1 of 3: 1 objective defect, score 7 under the target 9.*series "abcabcabcabc"/);
    expect(nextStep({ ...base, round: 2, maxRounds: 3, until: 9, score: 9.2, defects: [] })).toMatch(/^Done/);
    expect(nextStep({ ...base, round: 3, maxRounds: 3, until: 9, score: 8, defects: [] })).toMatch(/^Stopped after 3 rounds/);
  });
});

describe('consistency checks', () => {
  it('finds double negatives and unbalanced quotes', () => {
    expect(doubleNegative('Never Do not state numbers')).toBe('Never Do not');
    expect(doubleNegative('Nie Keine erfundenen Zahlen')).toBe('Nie Keine');
    expect(doubleNegative('Never state numbers you did not measure')).toBeNull();
    expect(unbalancedQuote('„Kunden gewinnen. Abläufe')).toBe('„');
    expect(unbalancedQuote('„Kunden gewinnen.“ und mehr')).toBeNull();
    expect(unbalancedQuote('»Die Stimme')).toBe('»');
    expect(unbalancedQuote('“Quoted” and fine')).toBeNull();
    expect(unbalancedQuote('A 27" screen')).toBeNull();
  });

  it('flags the danger colour on a calm state, and one label spelled two ways', async () => {
    const h = await startServer();
    harnesses.push(h);
    const agent = await connectAgent(h.base, 'claude');
    const file = await call(agent, 'file_create', { name: 'States' });
    const a = await call(agent, 'artboard_create', { file_id: file.id, name: 'Working', width: 400 });
    await call(agent, 'html_write', { file_id: file.id, target_id: a.id, html: '<div style="--ui-danger:#f28b82"><span data-name="Working ring" style="color:var(--ui-danger)">Claude is working</span><button style="background:var(--ui-danger)">End</button><button>Hang up</button></div>' });
    const b = await call(agent, 'artboard_create', { file_id: file.id, name: 'Muted', width: 400 });
    await call(agent, 'html_write', { file_id: file.id, target_id: b.id, html: '<div><button>Hang Up</button><p>Nie Keine Zahlen</p></div>' });
    const { doc } = await h.server.rooms.get(file.id);
    const nodes = [a.id, b.id].flatMap((id) => [doc.getNode(id)!, ...doc.descendants(id)]);
    const found = consistencyIssues(doc, nodes);
    const checks = found.map((f) => f.check);
    expect(checks).toContain('danger-colour');
    expect(found.find((f) => f.check === 'danger-colour')!.name).toBe('Working ring');
    expect(found.filter((f) => f.check === 'danger-colour')).toHaveLength(1);
    expect(found.find((f) => f.check === 'naming')!.message).toMatch(/"Hang up", "Hang Up"|"Hang Up", "Hang up"/);
    expect(checks).toContain('synonym');
    expect(checks).toContain('double-negative');
    expect(found.filter((f) => f.check !== 'synonym').every((f) => f.severity === 'hard')).toBe(true);
    // design_lint reports them too.
    const lint = await call(agent, 'design_lint', { file_id: file.id, node_id: b.id });
    expect(lint.issues.some((i: { rule: string }) => i.rule === 'consistency')).toBe(true);
    await agent.close();
  }, 60_000);
});

describe('design_critique', () => {
  it('reviews the page in a fresh session, keeps the round on the file, and loops', async () => {
    const stub = stubClaude();
    const h = await startServer({ critiqueCommand: stub.command });
    harnesses.push(h);
    const agent = await connectAgent(h.base, 'claude');
    const file = await call(agent, 'file_create', { name: 'Call' });
    const a = await call(agent, 'artboard_create', { file_id: file.id, name: 'Listening', width: 400 });
    await call(agent, 'html_write', { file_id: file.id, target_id: a.id, html: '<div><h2>Listening · 2:14</h2><button>End</button></div>' });
    const b = await call(agent, 'artboard_create', { file_id: file.id, name: 'No microphone', width: 400 });
    await call(agent, 'html_write', { file_id: file.id, target_id: b.id, html: '<div><h2>Listening · 0:04</h2><p>Microphone blocked</p><button>Hang Up</button></div>' });

    const first = await call(agent, 'design_critique', { file_id: file.id, until: 7.5, max_rounds: 2, loop_request: 'Please review again until 7.5, at most two rounds.' });
    expect(first.score).toBe(6.5);
    expect(first.round).toBe(1);
    expect(first.reviewer).toBe('Sonnet');
    expect(first.defects).toHaveLength(2);
    const { doc } = await h.server.rooms.get(file.id);
    const title = doc.descendants(b.id).find((n) => n.text === 'Listening · 0:04')!;
    expect(first.defects[0].node_id).toBe(title.id);
    expect(first.next).toMatch(/Round 1 of 2/);

    const calls = readFileSync(stub.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.args).toEqual(expect.arrayContaining(['--no-session-persistence', '--strict-mcp-config', '--tools', '', '--model', 'sonnet']));
    expect(c.args).not.toContain('--resume');
    expect(c.content.filter((x: { type: string }) => x.type === 'image')).toHaveLength(2);
    expect(c.content[0].text).toContain('2. "No microphone"');
    // The rule checks went in as input: "Hang Up" next to nothing else here, but the brief lists what they found.
    expect(existsSync(c.cwd)).toBe(false);

    const second = await call(agent, 'design_critique', { file_id: file.id, series: first.series, loop_request: 'Please review again until 7.5, at most two rounds.' });
    expect(second.round).toBe(2);
    expect(second.until).toBe(7.5);
    expect(second.next).toMatch(/^Stopped after 2 rounds/);
    const later = readFileSync(stub.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(later).toHaveLength(2);
    // Each round is its own session: nothing of round one reaches round two.
    expect(later[1].content[0].text).not.toContain('6.5');
    await expect(call(agent, 'design_critique', { file_id: file.id, series: first.series, loop_request: 'Please review again until 7.5, at most two rounds.' })).rejects.toThrow(/already ran its 2 rounds/);

    const kept = getCritiques(doc);
    expect(kept.map((r) => r.round).sort()).toEqual([1, 2]);
    expect(kept[0]!.tokens).toEqual({ input: 1500, output: 800 });
    expect(kept[0]!.costUsd).toBe(0.42);
    await agent.close();
  }, 90_000);

  it('runs from the editor, and falls back to Sonnet when explicitly requested Fable is not on the plan', async () => {
    const stub = stubClaude();
    process.env.STUB_NO_FABLE = '1';
    try {
      const h = await startServer({ critiqueCommand: stub.command });
      harnesses.push(h);
      const agent = await connectAgent(h.base, 'claude');
      const file = await call(agent, 'file_create', { name: 'One' });
      const a = await call(agent, 'artboard_create', { file_id: file.id, name: 'Home', width: 400 });
      await call(agent, 'html_write', { file_id: file.id, target_id: a.id, html: '<h1>Home</h1>' });
      const status = await (await fetch(`${h.base}/api/critique`)).json();
      expect(status.state).toBe('ready');
      const res = await fetch(`${h.base}/api/critique`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: file.id, screens: [a.id], reviewer: 'fable' }) });
      expect(res.status).toBe(202);
      const { job } = await res.json();
      let seen: { state: string; reviewer?: string; note?: string } = job;
      await until(async () => { seen = (await (await fetch(`${h.base}/api/critique/${job.id}`)).json()).job; return seen.state !== 'running'; }, 30_000);
      expect(seen.state).toBe('done');
      expect(seen.reviewer).toBe('Sonnet');
      expect(seen.note).toMatch(/Fable is not on this plan/);
      const { doc } = await h.server.rooms.get(file.id);
      expect(getCritiques(doc)[0]!.reviewer).toBe('Sonnet');
      expect((await fetch(`${h.base}/api/critique`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: 'nofilexxxx' }) })).status).toBe(404);
      await agent.close();
    } finally {
      delete process.env.STUB_NO_FABLE;
    }
  }, 60_000);

  it('reports its real stages, serves the pictures it rendered, and a loop from the editor may ask for more rounds', async () => {
    const stub = stubClaude();
    const h = await startServer({ critiqueCommand: stub.command });
    harnesses.push(h);
    const agent = await connectAgent(h.base, 'claude');
    const file = await call(agent, 'file_create', { name: 'Stages' });
    const a = await call(agent, 'artboard_create', { file_id: file.id, name: 'Home', width: 400, height: 300 });
    await call(agent, 'html_write', { file_id: file.id, target_id: a.id, html: '<h1>Home</h1>' });
    const post = (body: object) => fetch(`${h.base}/api/critique`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: file.id, ...body }) });
    const { job } = await (await post({ screens: [a.id] })).json();
    expect(job.screenIds).toEqual([a.id]);
    expect(job.rendered).toBe(0);
    let seen = job;
    await until(async () => { seen = (await (await fetch(`${h.base}/api/critique/${job.id}`)).json()).job; return seen.state !== 'running'; }, 30_000);
    expect(seen.state).toBe('done');
    expect(seen.rendered).toBe(1);
    expect(Object.keys(seen.stepAt)).toEqual(['rules', 'pictures', 'reviewer']);
    expect(seen.stepAt.rules).toBeLessThanOrEqual(seen.stepAt.pictures);
    expect(seen.stepAt.pictures).toBeLessThanOrEqual(seen.stepAt.reviewer);
    const calls = readFileSync(stub.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls[0].args).toContain('--include-partial-messages');
    const picture = await fetch(`${h.base}/api/critique/${job.id}/screens/1`);
    expect(picture.status).toBe(200);
    expect(picture.headers.get('content-type')).toMatch(/^image\//);
    expect((await picture.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect((await fetch(`${h.base}/api/critique/${job.id}/screens/2`)).status).toBe(404);
    const shot = await fetch(`${h.base}/api/critique/shot/${file.id}/${a.id}`);
    expect(shot.status).toBe(200);
    expect(shot.headers.get('content-type')).toMatch(/^image\//);
    expect((await fetch(`${h.base}/api/critique/shot/${file.id}/nolayer000`)).status).toBe(404);

    // A one-round review from the editor, then "review again until 7.5": the loop gets its rounds and target.
    const { doc } = await h.server.rooms.get(file.id);
    const first = getCritiques(doc)[0]!;
    expect(first.maxRounds).toBe(1);
    const again = await post({ screens: [a.id], series: first.series, until: 7.5, maxRounds: 3 });
    expect(again.status).toBe(202);
    const next = (await again.json()).job;
    await until(async () => (await (await fetch(`${h.base}/api/critique/${next.id}`)).json()).job.state !== 'running', 30_000);
    const second = getCritiques(doc).find((r) => r.round === 2)!;
    expect(second.maxRounds).toBe(3);
    expect(second.until).toBe(7.5);
    await agent.close();
  }, 60_000);

  it('says how to get a reviewer when Claude Code is missing', async () => {
    const h = await startServer({ critiqueCommand: '/nonexistent/claude-missing' });
    harnesses.push(h);
    const status = await (await fetch(`${h.base}/api/critique`)).json();
    expect(status.state).toBe('missing');
    expect(status.message).toMatch(/Install Claude Code/);
  });
});

describe('the language of the findings', () => {
  it('asks for findings in the language the person reads Bogen in, in plain words, with quotes kept as they are', async () => {
    const { critiqueBrief: brief, replyLanguageName } = await import('../src/design-critique.ts');
    const screens = [{ id: 'a', name: 'Start', width: 390, height: 844 }];
    const de = brief({ screens, flow: false, language: 'en', replyLanguage: 'de', ruleFindings: [] } as never);
    expect(de).toContain('Write all text in German, plainly for a non-designer');
    expect(de).toContain('Quote screen text as is');
    expect(de).not.toContain('nothing else, in English');
    expect(brief({ screens, flow: false, language: 'de', ruleFindings: [] } as never)).toContain('Write all text in English');
    expect(replyLanguageName('not a tag !')).toBe('English');
  });
});
