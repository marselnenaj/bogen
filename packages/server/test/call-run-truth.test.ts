import { describe, expect, it } from 'vitest';
import type { CallContext } from '@bogen/core';
import { runTruth } from '../src/speech/call.ts';

/** In a call of 17 Nov 2026 the voice said "Nothing is running right now" while a run worked on the file. */
describe('what the voice is told about the agent', () => {
  it('says it works when the server records a run, also one the call did not start', () => {
    const ctx: CallContext = { working: false };
    runTruth(ctx, [{ minutesAgo: 2, status: 'running', asked: 'Denser booking card' }]);
    expect(ctx).toMatchObject({ working: true, workingMinutes: 2 });
  });

  it('says it is idle when the editor missed the end of the run', () => {
    const ctx: CallContext = { working: true, workingMinutes: 4, activity: 'tool:html_write' };
    runTruth(ctx, [{ minutesAgo: 0, status: 'done', asked: 'Redo', result: 'Six screens rebuilt.' }]);
    expect(ctx.working).toBe(false);
    expect(ctx.activity).toBeUndefined();
  });

  it('keeps a run in a file the call moved away from', () => {
    const ctx: CallContext = { working: true, runFile: 'Sprechstunde' };
    runTruth(ctx, [{ minutesAgo: 30, status: 'done', asked: 'Logo' }]);
    expect(ctx.working).toBe(true);
  });
});
