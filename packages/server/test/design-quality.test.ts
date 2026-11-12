import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProposals } from '@bogen/core';
import { Runs, type RunEnd } from '../src/agents.ts';
import { EventHub } from '../src/events.ts';
import { reviewFingerprint } from '../src/design-quality.ts';
import { call, callRaw, connectAgent, startServer, until, type Harness } from './helpers.ts';

const observations = ['priority', 'content', 'context'].map((criterion) => ({ criterion, verdict: 'pass', evidence: `The ${criterion} is supported by the visible heading and supplied message in this fixture.` }));
const rubric = ['hierarchy', 'type', 'spacing', 'colour', 'content', 'craft', 'originality', 'fit'].map((criterion) => ({ criterion, score: 3, evidence: `The single supplied heading on this fixture board, judged for ${criterion}.` }));
describe('a real scoped design verification', () => {
  let h: Harness, file: string, board: string, text: string;
  beforeAll(async () => {
    h = await startServer(); file = h.server.createFile('Review fixture').id;
    const { doc } = await h.server.rooms.get(file), page = doc.getPages()[0]!.id;
    board = doc.insert(page, { type: 'frame', tag: 'main', name: 'Poster', artboard: true, style: { width: '800px', height: '600px', display: 'flex', flexDirection: 'column', backgroundColor: '#ffffff', color: '#111111', padding: '48px' } });
    text = doc.insert(board, { type: 'text', tag: 'h1', text: 'A supplied message', name: 'Main message', style: { fontSize: '48px', color: '#eeeeee' } });
  });
  afterAll(async () => { await h.cleanup(); });
  it('finds real low contrast, keeps judgement separate and invalidates a report after edits', async () => {
    const client = await connectAgent(h.base, 'reviewer');
    const before = await call(client, 'design_verify', { file_id: file, node_id: board, discipline: 'social', observations });
    expect(before.automated.state).toBe('needs-work');
    expect(before.automated.findings.some((f: any) => f.rule === 'lint:contrast' && f.node_id === text)).toBe(true);
    expect(before.visual.state).toBe('missing');
    expect(before.automated.findings.some((f: any) => f.rule.startsWith('responsive:'))).toBe(false);
    const { doc } = await h.server.rooms.get(file);
    doc.updateStyle(text, { color: '#111111' });
    expect(reviewFingerprint(doc, board)).not.toBe(before.fingerprint);
    // Looking only at the heading cannot certify the full board.
    await call(client, 'canvas_screenshot', { file_id: file, node_id: text });
    let after = await call(client, 'design_verify', { file_id: file, node_id: board, discipline: 'social', observations });
    expect(after.automated.state).toBe('passed'); expect(after.visual.state).toBe('missing');
    await call(client, 'canvas_screenshot', { file_id: file, node_id: board });
    after = await call(client, 'design_verify', { file_id: file, node_id: board, discipline: 'social', observations });
    expect(after.visual.state).toBe('self-assessed');
    // The scored self-review is separate from the three observations, and is held against what was measured.
    expect(after.rubric.state).toBe('missing');
    expect(after.rubric.open.map((c: any) => c.id)).toEqual(rubric.map((r) => r.criterion));
    after = await call(client, 'design_verify', { file_id: file, node_id: board, discipline: 'social', observations, rubric });
    expect(after.rubric).toMatchObject({ state: 'scored', total: 24, max: 40 });
    expect(after.rubric.next).toContain('adequate, not strong');
    doc.updateFields(text, { text: 'The message changed after review' });
    const stale = await call(client, 'design_verify', { file_id: file, node_id: board, discipline: 'social', observations });
    expect(stale.visual.state).toBe('missing');
    expect((await callRaw(client, 'design_verify', { file_id: file, node_id: board, discipline: 'social', observations: [{ ...observations[0], evidence: 'looks good' }] })).isError).toBe(true);
    await client.close();
  }, 30000);
  it('exposes the catalog over HTTP and MCP without creating files', async () => {
    const before = h.server.storage.list().length, client = await connectAgent(h.base, 'reader');
    const http = await (await fetch(h.base + '/api/design-knowledge')).json();
    expect(await call(client, 'design_knowledge')).toEqual(http);
    const response = await fetch(h.base + '/api/design-knowledge?action=playbook&discipline=widgets');
    expect(response.status).toBe(200);
    const operatingGuide = await response.json() as any;
    expect(operatingGuide.playbook.id).toBe('widgets');
    expect(operatingGuide.playbook.decisions).toHaveLength(8);
    expect(await call(client, 'design_knowledge', {action:'playbook',discipline:'widgets'})).toEqual(operatingGuide);
    expect((await fetch(h.base + '/api/design-knowledge?discipline=wrong&action=rules')).status).toBe(400);
    expect(h.server.storage.list()).toHaveLength(before); await client.close();
  });
  it('downloads real Markdown while retaining the JSON skill API and rejecting invalid attachments', async () => {
    const base = h.base + '/api/design-knowledge';
    const json = await (await fetch(base + '?action=skill&discipline=widgets')).json() as { markdown: string };
    const download = await fetch(base + '?action=skill&discipline=widgets&download=1');
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="bogen-widgets-SKILL.md"');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await download.text()).toBe(json.markdown);
    for (const query of ['action=skill&discipline=unknown&download=1', 'action=catalog&download=1', 'action=skill&download=1', 'action=skill&discipline=widgets&download=yes']) {
      const invalid = await fetch(base + '?' + query);
      expect(invalid.status, query).toBe(400);
      expect(invalid.headers.get('content-disposition')).toBeNull();
    }
  });
  it('runs real responsive probes and requires a fresh review at server completion', async () => {
    const { doc } = await h.server.rooms.get(file);
    const measured = await h.server.designQuality.review(file, board, 'websites', observations as any, 'run-fixture');
    expect(measured.automated.state).not.toBe('unverified');
    const req = { runner: 'codex' as const, fileId: file, fileName: 'Fixture', prompt: 'Improve this website', nodeIds: [text] };
    expect((await h.server.designQuality.beforeFinish(req, 'run-fixture', [text])).ok).toBe(false);
    h.server.designQuality.seen(file, doc, [board], 'run-fixture');
    await h.server.designQuality.review(file, board, 'websites', observations as any, 'run-fixture');
    // Observations alone no longer finish a run: the rubric has to be scored too.
    const unscored = await h.server.designQuality.beforeFinish(req, 'run-fixture', [text]);
    expect(unscored.ok).toBe(false);
    expect(unscored.message).toContain('the self-review rubric is missing');
    await h.server.designQuality.review(file, board, 'websites', observations as any, 'run-fixture', rubric);
    expect((await h.server.designQuality.beforeFinish(req, 'run-fixture', [text])).ok).toBe(true);
    doc.updateFields(text, { text: 'Edited after a passing review' });
    expect((await h.server.designQuality.beforeFinish(req, 'run-fixture', [text])).ok).toBe(false);
    const captured = h.server.designQuality.capture(doc, [board]);
    doc.updateFields(text, { text: 'Changed while a screenshot was in flight' });
    h.server.designQuality.seen(file, doc, [board], 'run-fixture', captured);
    expect((await h.server.designQuality.review(file, board, 'websites', observations as any, 'run-fixture')).visual.state).toBe('missing');
  }, 30000);
  it('keeps an untouched redo review inside its assigned copy and does not inspect an older page for an empty new page', async () => {
    const { doc } = await h.server.rooms.get(file);
    const copy = createProposals(doc, board, { by: 'fixture' })[0]!;
    const original = h.server.designQuality.review.bind(h.server.designQuality);
    const visited: string[] = [];
    const spy = vi.spyOn(h.server.designQuality, 'review').mockImplementation(async (...args) => {
      visited.push(args[1]); return original(...args);
    });
    try {
      const req = { runner: 'codex' as const, fileId: file, fileName: 'Fixture', pageId: doc.pageOf(board)!, prompt: 'Refine the composition', nodeIds: [board] };
      const redo = await h.server.designQuality.beforeFinish({ ...req, intent: 'revise', revision: { id: 'revision-fixture', name: 'Redo', artboards: [{ original: board, copy }], reused: false } }, 'scoped-fixture', []);
      expect(visited).toEqual([copy]);
      expect(redo.ok).toBe(false); // Still needs a genuine fresh screenshot and visual evidence.
      visited.length = 0;
      expect((await h.server.designQuality.beforeFinish({ ...req, intent: 'new_page' }, 'empty-page', [])).ok).toBe(true);
      expect(visited).toEqual([]);
      expect((await h.server.designQuality.beforeFinish({ ...req, intent: 'new_page' }, 'changed-page', [board])).ok).toBe(false);
      expect(visited).toEqual([board]); // Actual visual writes remain subject to the quality gate.
    } finally { spy.mockRestore(); }
  }, 30_000);
  it('does not render an oversized scope', async () => {
    const { doc } = await h.server.rooms.get(file), page = doc.getPages()[0]!.id;
    const big = doc.insert(page, { type: 'frame', artboard: true, name: 'Oversized', style: {} });
    doc.transact(() => { for (let i = 0; i < 1601; i++) doc.insert(big, { type: 'text', tag: 'p', text: 'Item', style: {} }); });
    await expect(h.server.designQuality.review(file, big, 'social')).rejects.toThrow('limited to 1600');
  });
});

describe('server-enforced completion with fake processes, no paid model calls', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-review-cli-')), log = join(bin, 'turns.jsonl'), savedPath = process.env.PATH;
  beforeAll(() => {
    for (const name of ['codex', 'claude']) {
      writeFileSync(join(bin, name), `#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('1.0.0');process.exit(0)}\nif(process.argv.includes('--help'))process.exit(0);\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv)+'\\n');\nsetTimeout(()=>process.exit(0),100);\n`);
      chmodSync(join(bin, name), 0o755);
    }
    process.env.PATH = bin + ':' + savedPath;
  });
  afterAll(() => { process.env.PATH = savedPath; rmSync(bin, { recursive: true, force: true }); });
  async function run(check: (turn: number, fileId: string, nodes: readonly string[]) => Promise<{ ok: boolean; message: string; retryable?: boolean }>, changed = true, changedFile = 'fixture', canvasOnly = false) {
    const hub = new EventHub(), ends: RunEnd[] = [], runs = new Runs(hub, () => ({ url: 'http://127.0.0.1:1/mcp' }), (end) => ends.push(end));
    let checks = 0; runs.beforeFinish = (req, _id, nodes) => check(++checks, req.fileId, nodes);
    const id = await runs.start({ runner: 'codex', fileId: 'fixture', fileName: 'Fixture', prompt: changed ? 'Improve this design' : 'What font is this?' });
    if (changed) hub.broadcast({ t: 'activity', fileId: changedFile, agent: 'codex', tool: 'layer_style', nodeIds: ['heading'], at: Date.now(), runId: id, ...(canvasOnly ? { canvasOnly: true } : {}) });
    await until(() => ends.length === 1, 10000);
    return { end: ends[0]!, checks };
  }
  it('continues to repair measured failure, then completes only after a passing check', async () => {
    const out = await run(async (turn) => ({ ok: turn === 2, message: 'heading: contrast needs correction' }));
    expect(out.checks).toBe(2); expect(out.end.status).toBe('done');
  });
  it('stops after two repair turns and preserves an explicit unresolved result', async () => {
    const before = readFileSync(log, 'utf8').trim().split('\n').length;
    const out = await run(async () => ({ ok: false, message: 'The renderer is unavailable; review is unverified.' }));
    expect(out.checks).toBe(3); expect(out.end.status).toBe('failed'); expect(out.end.error).toContain('after 2 repair turns');
    expect(readFileSync(log, 'utf8').trim().split('\n').length - before).toBe(3);
  });
  it('does not demand an internal design repair for canvas-only placement', async () => {
    const out = await run(async () => ({ ok: false, message: 'Unchanged terminal text must not be reviewed' }), true, 'fixture', true);
    expect(out.checks).toBe(0); expect(out.end.status).toBe('done');
  });
  it('does not force a read-only question into a design repair loop', async () => {
    const out = await run(async () => ({ ok: false, message: 'should not be called' }), false);
    expect(out.checks).toBe(0); expect(out.end.status).toBe('done');
  });
  it('verifies a deliberately created file instead of overlooking it in the original empty file', async () => {
    const files: string[] = [];
    const out = await run(async (_turn, fileId) => { files.push(fileId); return { ok: true, message: '' }; }, true, 'created-from-template');
    expect(out.end.status).toBe('done'); expect(files).toEqual(['created-from-template']);
  });
  it('does not spend repair turns on an explicitly non-repairable measurement failure', async () => {
    const out = await run(async () => ({ ok: false, retryable: false, message: 'Browser sandbox could not start; needs attention.' }));
    expect(out.checks).toBe(1); expect(out.end.status).toBe('failed'); expect(out.end.error).toContain('after 0 repair turns');
  });
});
