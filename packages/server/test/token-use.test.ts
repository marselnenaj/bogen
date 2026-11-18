/** Offline contracts: no listener, browser, CLI or provider is started. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BogenDoc, Y } from '@bogen/core';
import { z } from 'zod';
import { buildCommand, type RunRequest } from '../src/agents.ts';
import { canvasRunHeaders } from '../src/mcp/run-defaults.ts';
import { toolDefiner, type ToolContext } from '../src/mcp/kit.ts';
import { registerReadTools } from '../src/mcp/tools-read.ts';
import { registerDesignTools } from '../src/mcp/tools-design.ts';
import { registerDesignKnowledgeTools } from '../src/mcp/tools-design-knowledge.ts';
import { registerRunTools } from '../src/mcp/tools-runs.ts';
import { compactTrace, compactVerification } from '../src/mcp/compact-results.ts';
import { lintIssues, lintReport, type LintIssue } from '../src/mcp/lint.ts';
import { OUTPUT_SCHEMAS } from '../src/mcp/outputs.ts';
import { critique, critiqueBrief, pickReviewer, REVIEW_EFFORT, REVIEW_SYSTEM_PROMPT } from '../src/design-critique.ts';
import { scoreRubric, RUBRIC_IDS } from '../src/design-knowledge/rubric.ts';
import type { QualityReport } from '../src/design-quality.ts';
import type { BogenServer } from '../src/http/server.ts';
import type { RunTrace } from '../src/run-trace.ts';
import { auditRun, canonical, catalogSizes, critiqueRecords, originalSize, screenshotEstimate } from '../../../scripts/token-audit.ts';

vi.mock('../src/mcp/lint.ts', async (original) => ({ ...await original<typeof import('../src/mcp/lint.ts')>(), lintIssues: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));

const sdk = new McpServer({ name: 'offline-contracts', version: '1' });
const define = toolDefiner(sdk, {} as BogenServer, { agent: () => 'test', pageByFile: new Map() });
for (const register of [registerReadTools, registerDesignTools, registerDesignKnowledgeTools, registerRunTools]) register(define);
afterAll(() => sdk.close());
beforeEach(() => vi.clearAllMocks());
async function call(name: string, args: object, context: unknown): Promise<any> {
  const entry = define.tools.get(name)!;
  return entry.handler(z.object(entry.shape).parse(args) as never, context as ToolContext);
}
function fixture() {
  const doc = new BogenDoc();
  const page = doc.createPage('Screens');
  const board = doc.insert(page, { type: 'frame', artboard: true, name: 'Main', style: { width: '1800px', height: '2400px' } });
  const section = doc.insert(board, { type: 'frame', name: 'Content', style: { display: 'flex' } });
  const leaf = doc.insert(section, { type: 'text', name: 'Heading', text: 'A real heading', style: { fontSize: '24px' }, rules: { '::before': { content: '"x"' } } });
  const room = { id: 'file', doc };
  const screenshot = vi.fn(async (_doc: unknown, _target: unknown, opts: { format?: string }) => ({ width: 576, height: 768, scale: 768 / 2400, format: opts.format ?? 'jpg', mime: opts.format === 'png' ? 'image/png' : 'image/jpeg', bytes: Buffer.from('fixture') }));
  const seen = vi.fn();
  const ctx = { room: async () => room, page: () => page, session: { runId: 'run' }, touch: vi.fn(), write: (_room: unknown, fn: () => void) => fn(),
    app: { renderer: { screenshot, probe: vi.fn(async (_doc: unknown, _target: unknown, _fn: unknown, _arg: { ids: string[] }) => ({ issues: [], texts: [], boxes: [{ id: board, parent: null, tag: 'main', role: '', x: 0, y: 0, width: 1800, height: 2400, text: '', lines: 0, style: { 'background-color': '#fff' } }] })) }, designQuality: { capture: vi.fn(() => new Map([[board, 'before']])), seen }, brands: { forRoom: async () => null }, runs: { languageOf: () => undefined }, storage: { get: () => ({ name: 'Fixture' }) } } };
  return { doc, page, board, section, leaf, ctx, screenshot, seen };
}

describe('bounded tool responses', () => {
  it('starts with two levels, omits layout styles, preserves flags and offers a route to deeper layers', async () => {
    const f = fixture();
    const out = await call('layer_tree', { node_id: f.board }, f.ctx);
    expect(out).toContain(f.board); expect(out).toContain(f.section);
    expect(out).not.toContain(f.leaf); expect(out).not.toContain('width:');
    expect(out).toContain('artboard'); expect(out).toContain(`node_id ${f.section}`);
    const full = await call('layer_tree', { node_id: f.board, depth: 3, detail: 'full' }, f.ctx);
    expect(full).toContain('width:1800px'); expect(full).toContain(f.leaf); expect(full).toContain('rules {::before}');
    const deep = await call('layer_tree', { node_id: f.section }, f.ctx);
    expect(deep).toContain('A real heading');
    await expect(call('layer_tree', { node_id: 'missing' }, f.ctx)).rejects.toThrow('No layer');
    f.doc.y.destroy();
  });

  it('pages every visible layer exactly once, with a bounded default and a hint', async () => {
    const f = fixture();
    const ids = Array.from({ length: 100 }, (_, i) => f.doc.insert(f.section, { type: 'text', name: `Row ${i}`, text: `Item ${i}` }));
    const first = await call('layer_tree', { node_id: f.section }, f.ctx);
    expect(first).toContain('offset 80'); expect(first).not.toContain(ids[99]);
    const second = await call('layer_tree', { node_id: f.section, offset: 80 }, f.ctx);
    for (const id of [f.section, f.leaf, ...ids]) expect(Number(first.includes(id)) + Number(second.includes(id))).toBe(1);
    const beyond = await call('layer_tree', { node_id: f.section, offset: 500 }, f.ctx);
    expect(beyond).toContain('102 visible layers');
    f.doc.y.destroy();
  });

  it('uses small JPEGs plus maps and keeps explicit detail/format overrides and evidence tracking', async () => {
    const f = fixture();
    const result = await call('canvas_screenshot', { node_id: f.board }, f.ctx);
    expect(f.screenshot).toHaveBeenLastCalledWith(f.doc, { nodeIds: [f.board] }, expect.objectContaining({ format: 'jpg', quality: 75, scale: 1, maxDimension: 768 }));
    expect(result.content.find((c: any) => c.type === 'text').text).toContain('Layout map 1800x2400');
    expect(f.seen).toHaveBeenCalledWith('file', f.doc, [f.board], 'run', new Map([[f.board, 'before']]));
    await call('canvas_screenshot', { node_id: f.leaf, format: 'jpg', max_dimension: 2000, scale: 2 }, f.ctx);
    expect(f.screenshot).toHaveBeenLastCalledWith(f.doc, { nodeIds: [f.leaf] }, expect.objectContaining({ format: 'jpg', quality: 80, maxDimension: 2000, scale: 2 }));
    f.seen.mockClear(); f.screenshot.mockRejectedValueOnce(new Error('render failed'));
    await expect(call('canvas_screenshot', { node_id: f.board }, f.ctx)).rejects.toThrow('render failed');
    expect(f.seen).not.toHaveBeenCalled();
    f.doc.y.destroy();
  });

  it('offers full detail, explicit lossless images, size overrides and maps without visual attestation', async () => {
    const f = fixture();
    await call('canvas_screenshot', { node_id: f.board, detail: 'full' }, f.ctx);
    expect(f.screenshot).toHaveBeenLastCalledWith(f.doc, { nodeIds: [f.board] }, expect.objectContaining({ maxDimension: 1280 }));
    await call('canvas_screenshot', { node_id: f.board, format: 'png' }, f.ctx);
    expect(f.screenshot).toHaveBeenLastCalledWith(f.doc, { nodeIds: [f.board] }, expect.objectContaining({ format: 'png', maxDimension: 1280 }));
    await call('canvas_screenshot', { page_id: f.page, max_dimension: 1500 }, f.ctx);
    expect(f.screenshot).toHaveBeenLastCalledWith(f.doc, { pageId: f.page }, expect.objectContaining({ maxDimension: 1500 }));
    f.screenshot.mockClear(); f.seen.mockClear();
    const result = await call('canvas_screenshot', { node_id: f.board, map_only: true }, f.ctx);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Layout map') }]);
    expect(f.screenshot).not.toHaveBeenCalled(); expect(f.seen).not.toHaveBeenCalled();
    f.doc.y.destroy();
  });

  it('pages hard findings first and retains counts and fix information across every page', async () => {
    const f = fixture();
    const issues: LintIssue[] = Array.from({ length: 45 }, (_, i) => ({ nodeId: f.leaf, name: `Issue ${i}`, rule: 'grid', message: `Grid slip ${i}`, severity: i >= 30 ? 'hard' : 'advisory', fix: { safe: true, style: { padding: '4px' } } }));
    vi.mocked(lintIssues).mockResolvedValue(issues);
    const pages = [];
    for (const offset of [0, 20, 40]) pages.push(await call('design_lint', { node_id: f.board, offset }, f.ctx));
    expect(pages.map((p) => p.issues.length)).toEqual([20, 20, 5]);
    expect(pages[0]).toMatchObject({ total: 45, hard: 15, counts: { grid: 45 }, next_offset: 20 });
    expect(pages[0].issues[0].message).toBe('Grid slip 30');
    expect(pages[2].next_offset).toBeUndefined();
    expect(new Set(pages.flatMap((p) => p.issues.map((i: LintIssue) => i.message))).size).toBe(45);
    for (const p of pages) expect(OUTPUT_SCHEMAS.design_lint!.safeParse(p).success).toBe(true);
    expect(lintReport(issues, []).issues).toHaveLength(45); // Internal callers retain their existing default.
    await expect(call('design_lint', { node_id: f.board, fix: true, offset: 20 }, f.ctx)).rejects.toThrow('offset 0');
    f.doc.y.destroy();
  });

  it('still applies safe fixes beyond the first response page', async () => {
    const f = fixture();
    const ids = Array.from({ length: 35 }, () => f.doc.insert(f.section, { type: 'text', text: 'Row' }));
    const issues: LintIssue[] = ids.map((nodeId) => ({ nodeId, name: 'Row', rule: 'grid', message: 'Off grid', fix: { safe: true, style: { padding: '4px' } } }));
    vi.mocked(lintIssues).mockResolvedValueOnce(issues).mockResolvedValueOnce([]);
    const result = await call('design_lint', { node_id: f.board, fix: true }, f.ctx);
    expect(result.fixed).toHaveLength(35); expect(result.total).toBe(0);
    expect(ids.every((id) => f.doc.getNode(id)!.style.padding === '4px')).toBe(true);
    f.doc.y.destroy();
  });
});

const quality = (): QualityReport => ({ node_id: 'board', discipline: 'social', version: '1', fingerprint: 'fingerprint', checkedAt: 0,
  automated: { state: 'needs-work', total: 1, findings: [{ rule: 'lint:contrast', node_id: 'text', severity: 'error', hard: true, message: 'Unreadable ink' }] },
  visual: { state: 'self-assessed', screenshot: true, observations: [{ criterion: 'priority', verdict: 'pass', evidence: 'The large headline leads the visible screen.' }], criteria: [{ id: 'priority', question: 'What leads?' }, { id: 'context', question: 'Does it fit?' }] },
  rubric: scoreRubric(RUBRIC_IDS.map((criterion) => ({ criterion, score: 4, evidence: 'Specific evidence supplied by the maker for this criterion.' })), [{ rule: 'lint:contrast', hard: true, message: 'Unreadable ink' }, { rule: 'craft:boxes', advisory: true, why: 'No structure without boxes', message: 'Repeated boxes' }]),
  limitations: ['Self-assessment, not human acceptance.'], critique: { state: 'missing', next: 'Run critique.' },
});

describe('verification and trace summaries', () => {
  it('removes echoes but preserves measured failures, open criteria, scoring barriers and the stored full report', async () => {
    const report = quality(), before = structuredClone(report);
    const out = compactVerification(report);
    expect(out.automated).toEqual(report.automated); expect(out.critique).toEqual(report.critique);
    for (const key of ['state', 'total', 'max', 'open', 'blocking', 'capped', 'advisory', 'kept'] as const) expect(out.rubric[key]).toEqual(report.rubric[key]);
    expect(out.visual.criteria).toEqual([{ id: 'context', question: 'Does it fit?' }]);
    expect(out.rubric.scores[0]).not.toHaveProperty('evidence');
    expect(out.visual.observations[0]).not.toHaveProperty('evidence');
    expect(report).toEqual(before);
    const f = fixture();
    const review = vi.fn(async () => report);
    const ctx = { ...f.ctx, app: { ...f.ctx.app, designQuality: { review } } };
    expect(await call('design_verify', { node_id: f.board, discipline: 'social' }, ctx)).toEqual(out);
    expect(await call('design_verify', { node_id: f.board, discipline: 'social', detail: 'full' }, ctx)).toBe(report);
    f.doc.y.destroy();
  });

  it('summarizes trace calls without recursively repeating prompts and results, and keeps full detail available', async () => {
    const trace = traceFixture();
    const out = compactTrace(trace);
    expect(out.calls).toBe(3); expect(out.tools['bogen/layer_tree']).toMatchObject({ calls: 3, errors: 1 });
    expect(out).not.toHaveProperty('prompt'); expect(out.recent_errors).toHaveLength(1);
    const ctx = { app: { traces: { get: async () => trace } } };
    expect(await call('trace_get', { run_id: 'run' }, ctx)).toEqual(out);
    expect(await call('trace_get', { run_id: 'run', detail: 'full' }, ctx)).toBe(trace);
  });
});

describe('built-in run tool lists', () => {
  it('opts Claude configuration, Codex and OpenCode into grouped mode without changing external client defaults', async () => {
    expect(canvasRunHeaders('claude', 'f', 'r')).toMatchObject({ 'X-Bogen-Tools': 'grouped', 'X-Bogen-Run': 'r' });
    const req: RunRequest = { runner: 'codex', fileId: 'f', fileName: 'F', prompt: 'Draw' };
    const cmd = buildCommand('codex', req, { url: 'http://offline.invalid' }, '/tmp/config', '/tmp');
    expect(cmd.args.find((a) => a.startsWith('mcp_servers.bogen.http_headers='))).toContain('"X-Bogen-Tools"="grouped"');
    const oc = buildCommand('opencode', { ...req, runner: 'opencode' }, { url: 'http://offline.invalid' }, '/tmp/config', '/tmp', 'r');
    const config = JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.mcp.bogen_run_r.headers['X-Bogen-Tools']).toBe('grouped');
    const rows = await catalogSizes();
    expect(rows.map((r) => r.mode)).toEqual(['full', 'compact', 'grouped']);
    expect(rows[2]!.chars).toBeLessThan(rows[0]!.chars / 10);
  });
});

function traceFixture(): RunTrace {
  return { format: 'bogen-run-trace', version: 1, runId: 'run', fileId: 'file', runner: 'claude', source: 'prompt', startedAt: 0, status: 'done',
    prompt: { request: 'Draw', context: 'Earlier', instructions: 'Guide', nodeIds: [] }, events: [], layers: [], cut: { calls: 2, events: 0, layers: 0 }, redaction: 'Redacted.',
    calls: [
      { server: 'bogen', tool: 'layer_tree', t: 1, ms: 2, args: { depth: 2, node_id: 'a' }, result: 'abcd… [16 more characters]' },
      { server: 'bogen', tool: 'layer_tree', t: 2, ms: 2, args: { node_id: 'a', depth: 2 }, result: '[image]\n1280x960px' },
      { server: 'bogen', tool: 'layer_tree', t: 3, ms: 2, args: { node_id: 'missing' }, result: 'No layer', error: true },
    ] };
}

describe('audit accounting', () => {
  it('estimates image plus map costs, preserves explicit options and excludes errors and unknown dimensions', () => {
    const calls = [
      { tool: 'canvas_screenshot', args: {}, result: '[image]\n1200x1600px' },
      { tool: 'canvas_screenshot', args: { max_dimension: 2000 }, result: '[image]\n1200x1600px' },
      { tool: 'canvas_screenshot', args: { map_only: true }, result: '1200x1600px' },
      { tool: 'canvas_screenshot', args: {}, result: '[image]' },
      { tool: 'canvas_screenshot', args: {}, result: 'failed', error: true },
    ] as RunTrace['calls'];
    const before = structuredClone(calls), out = screenshotEstimate(calls);
    expect(out).toMatchObject({ calls: 4, knownDimensions: 3, unknownDimensions: 1, beforePictureTokens: 7680, afterPictureTokens: 3150 });
    expect(out.afterWithMapTokens).toEqual({ min: 3900, typical: 4650, max: 5400 });
    expect(out.typicalSavingPerCall).toBe(1010); expect(calls).toEqual(before);
    expect(() => screenshotEstimate([{ ...calls[0]!, args: null }])).not.toThrow();
  });
  it('reads snapshots and torn logs without repairing or rewriting the source files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bogen-audit-fixture-'));
    const directory = join(home, 'files'); mkdirSync(directory);
    const f = fixture(), snapshot = join(directory, 'file.ydoc'), log = join(directory, 'file.updates');
    try {
      writeFileSync(snapshot, Y.encodeStateAsUpdate(f.doc.y)); writeFileSync(log, Buffer.from([1, 2, 3]));
      const before = [readFileSync(snapshot), readFileSync(log)];
      const result = await critiqueRecords(home);
      expect(result.warnings).toEqual(['file.ydoc: torn log tail skipped, never repaired']);
      expect(readFileSync(snapshot)).toEqual(before[0]); expect(readFileSync(log)).toEqual(before[1]);
    } finally { f.doc.y.destroy(); rmSync(home, { recursive: true, force: true }); }
  });

  it('recovers cut/hidden sizes, canonicalizes arguments, reports images separately and never claims cut calls were measured', () => {
    expect(originalSize('abcd… [16 more characters]')).toBe(20);
    expect(originalSize('[file content left out: 123 characters]')).toBe(123);
    expect(canonical({ b: { y: 2, x: 1 }, a: [2, 1] })).toBe(canonical({ a: [2, 1], b: { x: 1, y: 2 } }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
    const trace = traceFixture(), before = structuredClone(trace);
    const r = auditRun(trace);
    expect(r.tools[0]).toMatchObject({ calls: 3, repeatedCalls: 1, repeatedArgumentGroups: 1, truncatedResults: 1, imageMarkers: 1 });
    expect(r.images.callShare).toBe(1 / 3); expect(r.cut.calls).toBe(2);
    expect(trace).toEqual(before);
  });
});

describe('routine critiques', () => {
  it('uses Sonnet unless it made the work, and honors every independent explicit choice', () => {
    expect(pickReviewer('auto').id).toBe('sonnet');
    for (const maker of ['opus', 'claude-fable-5-1', 'gpt-test']) expect(pickReviewer('auto', maker).id).toBe('sonnet');
    expect(pickReviewer('auto', 'claude-sonnet-4-5')).toMatchObject({ id: 'opus', note: expect.stringContaining('Sonnet made') });
    for (const maker of ['sonnet', 'opus', 'fable'] as const) for (const choice of ['auto', 'sonnet', 'opus', 'fable'] as const) expect(pickReviewer(choice, maker).id).not.toBe(maker);
    expect(pickReviewer('fable', 'opus').id).toBe('fable'); expect(pickReviewer('opus', 'fable').id).toBe('opus');
  });

  it('keeps brand rules, all screens and rechecks in the shorter brief, with a complete answer contract', () => {
    const brief = critiqueBrief({ screens: [{ id: 'a', name: 'Home', width: 390, height: 844 }], flow: true, language: 'German', ruleFindings: ['Unreadable ink'], addressed: [{ title: 'Missing label' }] });
    expect(brief.length).toBeLessThan(2900); expect(brief).toContain('bottom 34pt'); expect(brief).toContain('Every defect needs evidence');
    for (const field of ['score', 'dimensions', 'defects', 'evidence', 'quote', 'fix', 'taste', 'keep', 'rechecked']) expect(brief).toContain(`"${field}"`);
    expect(brief).toContain('claims to verify'); expect(brief).toContain('German'); expect(REVIEW_EFFORT).toBe('medium');
  });

  async function round(failModels: string[] = [], makerModel = 'opus', reviewer: 'auto' | 'fable' = 'auto', count = 1) {
    const launches: { args: string[]; input: string }[] = [];
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const proc = new EventEmitter() as any;
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = vi.fn();
      const launch = { args: args as string[], input: '' }; launches.push(launch);
      proc.stdin = { end(input: string) {
        launch.input = input;
        queueMicrotask(() => {
          const model = launch.args[launch.args.indexOf('--model') + 1]!;
          proc.stdout.end(JSON.stringify(failModels.includes(model) ? { type: 'result', is_error: true, result: 'model not available on this plan' } : { type: 'result', result: JSON.stringify({ score: 8, defects: [], taste: [], keep: [] }) }) + '\n');
        });
      } };
      return proc;
    });
    const f = fixture(), writes = vi.fn();
    const screens = [f.board];
    if (count === 2) screens.push(f.doc.insert(f.page, { type: 'frame', artboard: true, name: 'Second', style: { width: '1800px', height: '2400px' } }));
    f.ctx.app.renderer.probe.mockImplementation(async (_doc: unknown, _target: unknown, _fn: unknown, arg: { ids: string[] }) => ({ issues: [], texts: [], boxes: [{ id: arg.ids[0]!, parent: null, tag: 'main', role: '', x: 0, y: 0, width: 1800, height: 2400, text: '', lines: 0, style: { 'background-color': '#fff' } }] }));
    const result = critique({ doc: f.doc, screens, flow: false, reviewer, makerModel, language: 'English', maxRounds: 1 }, { renderer: f.ctx.app.renderer as never, lint: async () => [], write: writes });
    return { result, launches, f, writes };
  }

  it('sends one bounded JPEG per artboard in a fresh no-tool session with a short system prompt', async () => {
    const { result, launches, f } = await round();
    expect((await result).record.reviewer).toBe('Sonnet');
    expect(f.screenshot).toHaveBeenCalledWith(f.doc, { nodeIds: [f.board] }, expect.objectContaining({ format: 'jpg', quality: 75, maxDimension: 1024 }));
    expect(launches).toHaveLength(1);
    expect(launches[0]!.args).toEqual(expect.arrayContaining(['--no-session-persistence', '--strict-mcp-config', '--tools', '', '--model', 'sonnet', '--effort', 'medium', '--system-prompt', REVIEW_SYSTEM_PROMPT]));
    const content = JSON.parse(launches[0]!.input).message.content;
    expect(content.filter((c: { type: string }) => c.type === 'image')).toHaveLength(1);
    expect(content.find((c: { type: string }) => c.type === 'text').text).toContain('Layout map 1800x2400');
    f.doc.y.destroy();
  });

  it('sends every screen with its own map and one picture in matching order', async () => {
    const { result, launches, f } = await round([], 'sonnet', 'auto', 2);
    expect((await result).record.reviewer).toBe('Opus');
    const content = JSON.parse(launches[0]!.input).message.content;
    expect(content.filter((c: { type: string }) => c.type === 'image')).toHaveLength(2);
    const prompt = content.find((c: { type: string }) => c.type === 'text').text;
    expect(prompt.match(/Layout map/g)).toHaveLength(2);
    expect(prompt.indexOf('1. "Main"')).toBeLessThan(prompt.indexOf('2. "Second"'));
    expect(prompt).toContain('Every defect needs evidence');
    for (const [, , options] of f.screenshot.mock.calls) expect(options).toMatchObject({ maxDimension: 1024, quality: 75 });
    f.doc.y.destroy();
  });

  it('does not escalate failed Sonnet rounds or fall back to the maker model', async () => {
    for (const [failures, maker, reviewer, count] of [[['sonnet'], 'opus', 'auto', 1], [['claude-fable-5-1'], 'sonnet', 'fable', 1]] as const) {
      const { result, launches, f, writes } = await round([...failures], maker, reviewer);
      await expect(result).rejects.toThrow('not available'); expect(launches).toHaveLength(count); expect(writes).not.toHaveBeenCalled(); f.doc.y.destroy();
    }
    const { result, launches, f } = await round(['claude-fable-5-1'], 'opus', 'fable');
    expect((await result).record.reviewer).toBe('Sonnet'); expect(launches).toHaveLength(2); f.doc.y.destroy();
  });
});
