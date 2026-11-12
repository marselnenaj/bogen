import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BogenDoc, importHtml, type NewNode } from '@bogen/core';
import { agentsCheckCommand } from '../src/agents-check-cli.ts';
import { CHECK_PAGE, checkReport, findLayers, isBold, px, runAgentsCheck } from '../src/agents-check.ts';
import { writeCheckClis } from './fake-cli.ts';
import { startServer, until, type Harness } from './helpers.ts';

describe('what the check reads from a file', () => {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const board = doc.insert(doc.getPages()[0]!.id, { type: 'frame', name: 'Event', artboard: true, style: {} });
  doc.invalidate();
  doc.insertMany(board, importHtml(CHECK_PAGE).nodes as NewNode[]);
  doc.invalidate();
  doc.setToken('size-xl', 'font-size', '2.5rem');

  it('finds the three layers by what they are', () => {
    const { heading, paragraph, button } = findLayers(doc, board);
    expect(heading?.tag).toBe('h1');
    expect(paragraph?.text).toBe('Tickets ab Freitag.');
    expect(button?.tag).toBe('button');
  });

  it('reads sizes in px, rem and tokens, and weights from the layer or its spans', () => {
    expect(px('32px', doc)).toBe(32);
    expect(px('2rem', doc)).toBe(32);
    expect(px('var(--size-xl)', doc)).toBe(40);
    expect(px('clamp(1rem, 2vw, 3rem)', doc)).toBeNull();
    const p = findLayers(doc, board).paragraph!;
    expect(isBold(p)).toBe(false);
    expect(isBold(p, '700')).toBe(true);
    expect(isBold({ ...p, spans: [{ start: 0, end: p.text!.length, style: { fontWeight: 'bold' } }] })).toBe(true);
  });
});

describe('bogen agents check, with stand-in CLIs', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-check-bin-'));
  const savedPath = process.env.PATH;

  beforeAll(() => {
    // Only the stand-ins: the real CLIs on this machine must never run from a test.
    process.env.PATH = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  });

  afterAll(() => {
    process.env.PATH = savedPath;
    rmSync(bin, { recursive: true, force: true });
  });

  it('passes both runners that change what is asked, answer a question and remember the turn before', async () => {
    writeCheckClis(bin);
    const steps: string[] = [];
    const check = await runAgentsCheck({ progress: (c) => steps.push(`${c.status}:${c.runners.map((r) => r.cases.length).join(',')}`) });
    expect(check.status).toBe('done');
    expect(check.runners.map((r) => r.runner)).toEqual(['claude', 'codex']);
    for (const r of check.runners) {
      expect(r.cases.map((c) => [c.name, c.ok])).toEqual([['polite', true], ['question', true], ['memory', true]]);
      // The cheap model comments use.
      expect(r.model).toBe(r.runner === 'claude' ? 'haiku' : 'small');
    }
    const polite = check.runners[0]!.cases[0]!;
    expect(polite).toMatchObject({ changed: true, answered: true, nudged: false });
    expect(polite.detail).toMatch(/^The heading went from 32px to 44px\.$/);
    expect(check.runners[0]!.cases[1]).toMatchObject({ changed: false, answered: true, reply: 'Jetzt buchen' });
    expect(check.runners[0]!.cases[2]).toMatchObject({ remembered: true });
    expect(steps.at(-1)).toBe('done:3,3');
    const report = checkReport(check);
    expect(report).toContain('pass  polite   changed something: yes');
    expect(report).toContain('pass  question answered correctly: yes, left it alone: yes');
    expect(report).toContain('pass  memory   remembered: yes');
    expect(report).toContain('6 of 6 cases passed');
  }, 60_000);

  it('says when a runner only agreed until asked again, and when it forgot the turn before', async () => {
    writeCheckClis(bin, { claude: 'forgetful', codex: 'agreeable' });
    const check = await runAgentsCheck();
    const [claude, codex] = check.runners;
    expect(claude!.cases.find((c) => c.name === 'memory')).toMatchObject({ ok: false, remembered: false });
    // It made the heading bold, which it already was: nothing else changed, and the paragraph is not bold.
    expect(claude!.cases.find((c) => c.name === 'memory')!.detail).toBe('Turn 1 changed the paragraph to Samstag; turn 2 did not make the paragraph bold.');
    // Nudged once, then it did the work: a pass, and the report says so.
    expect(codex!.cases.find((c) => c.name === 'polite')).toMatchObject({ ok: true, nudged: true });
    expect(checkReport(check)).toContain('pass  polite   changed something: yes, nudged once');
  }, 60_000);

  it('runs from the command line with an exit code, and says when a runner is missing', async () => {
    writeCheckClis(bin);
    let out = '';
    expect(await agentsCheckCommand({ runners: ['codex'] }, (t) => { out += t; })).toBe(0);
    expect(out).toContain('codex: polite request passed');
    expect(out).toContain('3 of 3 cases passed');
    rmSync(join(bin, 'claude'));
    out = '';
    expect(await agentsCheckCommand({ runners: ['claude'], json: true }, (t) => { out += t; })).toBe(1);
    expect(JSON.parse(out).runners[0]).toMatchObject({ runner: 'claude', available: false, error: 'claude is not installed here, or not on the PATH.' });
    expect(await agentsCheckCommand({ model: 'a;b' }, () => {})).toBe(2);
  }, 60_000);

  describe('from the Agents tab', () => {
    let h: Harness;
    afterEach(async () => h?.cleanup());

    it('starts in the background, reports progress as events, and leaves the person\'s files alone', async () => {
      writeCheckClis(bin);
      h = await startServer();
      const events: string[] = [];
      h.server.hub.tap((e) => { if (e.t === 'agents-check') events.push(e.status); });
      const started = await fetch(`${h.base}/api/agents/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runners: ['claude'] }) });
      expect(started.status).toBe(202);
      const { id } = await started.json() as { id: string };
      expect((await fetch(`${h.base}/api/agents/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(409);
      await until(async () => ((await (await fetch(`${h.base}/api/agents/check/${id}`)).json()) as { status: string }).status === 'done', 30_000);
      const done = await (await fetch(`${h.base}/api/agents/check`)).json() as any;
      expect(done.runners[0].cases.every((c: any) => c.ok)).toBe(true);
      expect(events.at(-1)).toBe('done');
      // The check ran in a server of its own: nothing here, no file and no run.
      expect(h.server.storage.list()).toEqual([]);
      expect(h.server.runs.count()).toBe(0);
    }, 60_000);
  });
});
