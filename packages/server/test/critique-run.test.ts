import { afterEach, describe, expect, it, vi } from 'vitest';
import { BogenDoc, brandEditionParts, emptyBrand, writeBrandEdition } from '@bogen/core';
import { critique, critiqueStatus, type CritiqueOutcome, type CritiqueRequest } from '../src/design-critique.ts';
import { CritiqueJobs } from '../src/critique-run.ts';
import type { BogenServer } from '../src/http/server.ts';
import type { Room } from '../src/sync.ts';

vi.mock('../src/design-critique.ts', async (original) => ({
  ...await original<typeof import('../src/design-critique.ts')>(),
  critique: vi.fn(), critiqueStatus: vi.fn(async () => ({ state: 'ready' })),
}));
afterEach(() => vi.clearAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const doc = new BogenDoc(); doc.ensureFirstPage();
  const board = doc.insert(doc.getPages()[0]!.id, { type: 'frame', artboard: true, style: {} });
  const brand = vi.fn(async () => null);
  const app = { brands: { forRoom: brand }, renderer: {}, storage: { get: () => undefined } } as unknown as BogenServer;
  const jobs = new CritiqueJobs(app);
  return { jobs, room: { id: 'fixture', doc } as Room, board, brand };
}
const outcome = (req: CritiqueRequest): CritiqueOutcome => ({ record: {
  id: 'review', at: 0, screens: [], series: 'abcdefabcdef', round: 1, maxRounds: req.maxRounds,
  reviewer: 'Fable', score: 6.5, dimensions: {}, verdict: '', defects: [], taste: [], keep: [], ruleFindings: 0, durationMs: 1,
}, next: 'Fix without re-reviewing.' });

describe('queued critique jobs without processes or rendering', () => {
  it('queues concurrent starts, including asynchronous brand lookup, and defaults to one round', async () => {
    const { jobs, room, brand } = fixture();
    const brandReady = deferred<null>();
    brand.mockImplementationOnce(() => brandReady.promise);
    const reviewReady = deferred<CritiqueOutcome>();
    vi.mocked(critique).mockImplementationOnce(() => reviewReady.promise).mockImplementation(async (req) => outcome(req));
    const [first, second, third] = await Promise.all([jobs.start(room, {}), jobs.start(room, {}), jobs.start(room, {})]);
    expect(brand).toHaveBeenCalledTimes(1);
    expect(critique).not.toHaveBeenCalled();
    expect(jobs.get(second.id)?.step).toBe('queued');
    brandReady.resolve(null);
    await vi.waitFor(() => expect(critique).toHaveBeenCalledTimes(1));
    const req = vi.mocked(critique).mock.calls[0]![0];
    expect(req.maxRounds).toBe(1);
    expect(req.until).toBeUndefined();
    expect(brand).toHaveBeenCalledTimes(1);
    reviewReady.resolve(outcome(req));
    await jobs.wait(third.id);
    expect(critique).toHaveBeenCalledTimes(3);
    expect([first, second, third].map((j) => j.state)).toEqual(['done', 'done', 'done']);
  });

  it('cancels queued jobs without starting a reviewer and advances after a failed review', async () => {
    const { jobs, room } = fixture();
    const firstReady = deferred<CritiqueOutcome>();
    vi.mocked(critique).mockImplementationOnce(() => firstReady.promise).mockImplementation(async (req) => outcome(req));
    const [first, cancelled, last] = await Promise.all([jobs.start(room, {}), jobs.start(room, {}), jobs.start(room, {})]);
    jobs.cancel(cancelled.id);
    expect(jobs.get(cancelled.id)?.state).toBe('stopped');
    await vi.waitFor(() => expect(critique).toHaveBeenCalledTimes(1));
    firstReady.reject(new Error('Review failed'));
    await jobs.wait(last.id);
    expect(first.state).toBe('failed');
    expect(cancelled.state).toBe('stopped');
    expect(last.state).toBe('done');
    expect(critique).toHaveBeenCalledTimes(2);
  });

  it('stops active and queued reviews on cancelAll and rejects a missing reviewer', async () => {
    const { jobs, room } = fixture();
    const ready = deferred<CritiqueOutcome>();
    const cancel = vi.fn(() => ready.reject(new Error('Stopped.')));
    vi.mocked(critique).mockImplementationOnce((req, _deps, signal) => {
      req.onStep?.('reviewer');
      signal!.run = { cancel, result: Promise.resolve({ text: '', durationMs: 0 }) };
      return ready.promise;
    });
    const [first, second] = await Promise.all([jobs.start(room, {}), jobs.start(room, {})]);
    await vi.waitFor(() => expect(first.step).toBe('reviewer'));
    jobs.cancelAll();
    await jobs.wait(second.id);
    expect(cancel).toHaveBeenCalledOnce();
    expect([first.state, second.state]).toEqual(['stopped', 'stopped']);
    expect(critique).toHaveBeenCalledOnce();
    vi.mocked(critiqueStatus).mockResolvedValueOnce({ state: 'missing' });
    await expect(jobs.start(room, {})).rejects.toThrow(/Install Claude Code/);
  });

  it('automatically briefs queued edition reviews as studio guidelines and keeps the maker model', async () => {
    const { jobs, room } = fixture();
    const pageId = room.doc.getPages()[0]!.id;
    room.doc.insert(pageId, { type: 'frame', artboard: true, style: {} });
    writeBrandEdition(room.doc, { brandId: 'kiln00001', brandName: 'Kiln', at: 1, parts: brandEditionParts(emptyBrand()), pageId });
    vi.mocked(critique).mockImplementation(async (req) => outcome(req));
    const job = await jobs.start(room, { purpose: 'Twelve pages.', makerModel: 'fable' });
    await jobs.wait(job.id);
    const req = vi.mocked(critique).mock.calls[0]![0];
    expect(req.flow).toBe(false);
    expect(req.screens).toHaveLength(2);
    expect(req.makerModel).toBe('fable');
    expect(req.purpose).toMatch(/^A studio brand guidelines book for "Kiln".*Twelve pages\.$/s);
  });

});
