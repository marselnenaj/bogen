import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addCritique, BogenDoc, brandEditionParts, emptyBrand, writeBrandEdition, type CritiqueRecord } from '@bogen/core';
import { toolDefiner, type ToolContext } from '../src/mcp/kit.ts';
import { CRITIQUE_CALL_WAIT, registerCritiqueTools } from '../src/mcp/tools-critique.ts';
import type { BogenServer } from '../src/http/server.ts';

function fixture() {
  const doc = new BogenDoc(); doc.ensureFirstPage();
  const record: CritiqueRecord = { id: 'review', at: 0, screens: [], series: 'abcdefabcdef', round: 1, maxRounds: 3, until: 7.5, score: 7.6, reviewer: 'Fable', dimensions: {}, verdict: '', defects: [], taste: [], keep: [], ruleFindings: 0, durationMs: 1 };
  const start = vi.fn(async (_room: unknown, _options: unknown) => ({ id: 'job' }));
  const run = { id: 'maker', startedAt: 0, runner: 'claude' };
  const app = { runs: { list: () => [run], modelOf: vi.fn((): string | undefined => 'fable') }, critiques: { status: async () => ({ state: 'ready' }), start, get: () => ({ id: 'job', step: 'queued', screens: 2, rendered: 0, startedAt: Date.now() }), wait: vi.fn(async () => ({ state: 'done', recordId: record.id, next: 'Done' })) } };
  const ctx = { app, session: {}, room: async () => ({ id: 'fixture', doc }), page: () => doc.getPages()[0]!.id } as unknown as ToolContext;
  const server = new McpServer({ name: 'critique-policy', version: '1' });
  const define = toolDefiner(server, app as unknown as BogenServer, { pageByFile: new Map(), agent: () => 'test' });
  registerCritiqueTools(define);
  const entry = define.tools.get('design_critique')!;
  const call = (args: object) => entry.handler(z.object(entry.shape).parse(args) as never, ctx);
  return { doc, record, start, call, app, ctx, run };
}

describe('critique loop authorization without model calls', () => {
  it('defaults to one round without a score target', async () => {
    const f = fixture(); addCritique(f.doc, { ...f.record, maxRounds: 1, until: undefined });
    await f.call({});
    expect(f.start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxRounds: 1 }));
    expect(f.start.mock.calls[0]![1]).not.toHaveProperty('until');
  });
  it.each([{ until: 7.5 }, { max_rounds: 2 }])('rejects unrequested loop settings %j', async (args) => {
    const f = fixture();
    await expect(f.call(args)).rejects.toThrow(/explicit request quoted in loop_request/);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('requires a quote even when series inherits a loop, and allows the quoted request', async () => {
    const f = fixture(); addCritique(f.doc, f.record);
    await expect(f.call({ series: f.record.series })).rejects.toThrow(/explicit request quoted in loop_request/);
    expect(f.start).not.toHaveBeenCalled();
    await f.call({ series: f.record.series, until: 7.5, max_rounds: 3, loop_request: 'Review again until 7.5, at most three rounds.' });
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ until: 7.5, maxRounds: 3, series: f.record.series }));
  });
});


afterEach(() => vi.useRealTimers());

describe('merged critique behavior without processes or rendering', () => {
  it('returns after 45 seconds while queued and simultaneous calls share admission and the result', async () => {
    vi.useFakeTimers();
    const f = fixture(); addCritique(f.doc, f.record);
    let finish!: (job: { state: string; recordId: string; next: string }) => void;
    const waiting = new Promise<{ state: string; recordId: string; next: string }>((resolve) => { finish = resolve; });
    f.app.critiques.wait.mockReturnValue(waiting);
    const first = f.call({});
    const again = f.call({});
    await vi.advanceTimersByTimeAsync(44_999);
    expect(f.start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    const [a, b] = await Promise.all([first, again]);
    expect(a).toMatchObject({ state: 'reviewing', job: 'job', step: 'queued' });
    expect(b).toMatchObject({ state: 'reviewing', job: 'job' });
    const resumed = f.call({});
    finish({ state: 'done', recordId: f.record.id, next: 'Done' });
    expect(await resumed).toMatchObject({ score: 7.6, round: 1 });
    expect(f.start).toHaveBeenCalledOnce();
    expect(CRITIQUE_CALL_WAIT.ms).toBe(45_000);
  });

  it.each([1, 3])('uses stored edition rounds (%i) and the whole-book series without requiring another quote', async (rounds) => {
    const f = fixture(); f.ctx.session.runId = f.run.id;
    const pageId = f.doc.getPages()[0]!.id;
    writeBrandEdition(f.doc, { brandId: 'kiln00001', brandName: 'Kiln', at: 1, parts: brandEditionParts(emptyBrand()), pageId, rounds });
    addCritique(f.doc, { ...f.record, pageId, at: 1, maxRounds: rounds });
    await f.call({ node_ids: ['subset'], reviewer: 'sonnet', until: 10, max_rounds: 5, series: 'ffffffffffff', maker_model: 'sonnet' });
    const options = f.start.mock.calls[0]![1];
    expect(options).toMatchObject({ pageId, reviewer: 'auto', until: 7.5, maxRounds: rounds, series: f.record.series, makerModel: 'fable' });
    expect(options).not.toHaveProperty('screens');
  });

  it('rejects unrequested loops in ordinary maker runs too', async () => {
    const f = fixture(); f.ctx.session.runId = f.run.id;
    await expect(f.call({ until: 7.5, max_rounds: 3 })).rejects.toThrow(/explicit request quoted in loop_request/);
    expect(f.start).not.toHaveBeenCalled();
  });

  it('reports the edition cap when a queued job fails after admission', async () => {
    const f = fixture(); f.ctx.session.runId = f.run.id;
    const pageId = f.doc.getPages()[0]!.id;
    writeBrandEdition(f.doc, { brandId: 'kiln00001', brandName: 'Kiln', at: 1, parts: brandEditionParts(emptyBrand()), pageId });
    f.app.critiques.wait.mockResolvedValueOnce({ state: 'failed', recordId: '', next: '', error: 'This loop already ran its 1 rounds.' } as never);
    await expect(f.call({})).rejects.toThrow(/This book has had its review.*no further review/);
  });

  it('clears a failed admission so the next call can try again', async () => {
    const f = fixture(); addCritique(f.doc, f.record);
    f.start.mockRejectedValueOnce(new Error('Unavailable'));
    await expect(f.call({})).rejects.toThrow('Unavailable');
    await f.call({});
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it('keeps a default Claude maker off Opus even before the CLI reports its model', async () => {
    const f = fixture(); addCritique(f.doc, f.record); f.ctx.session.runId = f.run.id;
    f.app.runs.modelOf.mockReturnValue(undefined);
    await f.call({});
    expect(f.start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ makerModel: 'opus' }));
  });

});
