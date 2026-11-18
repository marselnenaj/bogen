import { z } from 'zod';
import { getCritiques } from '@bogen/core';
import { CRITIQUE_MISSING, MAX_ROUNDS, MAX_SCREENS, REVIEWERS } from '../design-critique.ts';
import type { CritiqueJob } from '../critique-run.ts';
import { fileIdArg, pageIdArg, type ToolDefiner } from './kit.ts';
import type { BogenServer } from '../http/server.ts';
import { editionLoop } from '../brand-edition.ts';

/**
 * How long one call waits for its review. A run Bogen started on Claude Code may wait long (agents.ts gives its tool
 * calls 40 minutes), so it spends no turns asking again. Anyone else gets an answer under the shortest client
 * timeout, the MCP SDK's 60 s request timeout (Codex gives 120 s), and calls again. Tests shorten it.
 */
export const CRITIQUE_CALL_WAIT = { ms: 45_000, run: 30 * 60_000 };
/** Reviews an agent was told are still going, by file: its next call waits for that one or takes its result. */
const handedOff = new WeakMap<BogenServer, Map<string, Promise<CritiqueJob>>>();

/** An independent reviewer that looks at the screens and judges them like a studio, in a fresh session each round. */
export function registerCritiqueTools(define: ToolDefiner): void {
  define('design_critique', {
    description: `Run one independent design review by default, then fix its objective defects without re-reviewing. Scores never block completion. Each round costs about $1.70 of the person's plan. Only loop when the person explicitly requested it: quote their request in loop_request when using until/max_rounds or continuing a loop with series. Bogen renders up to ${MAX_SCREENS} artboards, runs rule checks, and hands the pictures, brand rules and brief to a fresh Claude Code session, using a different model from the maker. The reviewer never sees your reasoning or earlier scores. It returns a score out of 10, per-dimension scores, objective defects with evidence and fixes, taste notes and what to keep. Each round is saved on the file. For an explicitly requested loop, fix defects then continue its series until the target and no defects, or max_rounds. Reviews queue, one at a time per server. Takes two to six minutes: a call that cannot wait returns after 45 seconds with state reviewing; call again with the same arguments to wait for that same review, including while queued. Edition runs review the whole book in one series, with its automatic studio brief and stored rounds; an explicit brand_book_design rounds setting authorizes that loop. For states of one flow keep flow true.`,
  }, {
    node_ids: z.array(z.string()).max(MAX_SCREENS).optional().describe('The artboards to review (a layer stands for its artboard). Leave out for every artboard on the page.'),
    page_id: pageIdArg,
    flow: z.boolean().optional().describe('The screens are states or steps of one flow: compare them with each other. Default: true for more than one screen.'),
    reviewer: z.enum(REVIEWERS).default('auto').describe('auto picks Sonnet; Opus only if Sonnet made the work. Fable and Opus can be requested explicitly. Never the maker\'s own model.'),
    until: z.number().min(0).max(10).optional().describe('Target score only for a person-requested loop; the editor defaults to 7.5. Requires loop_request outside edition runs.'),
    max_rounds: z.number().int().min(1).max(MAX_ROUNDS).default(1).describe('Default 1. More rounds require loop_request, or the stored rounds of an edition run.'),
    loop_request: z.string().trim().min(1).max(1200).optional().describe('Quote the person’s explicit request to loop. Required for until, max_rounds > 1 or continuing a loop, except edition runs with their stored rounds; never invent a request.'),
    series: z.string().regex(/^[0-9a-f]{12}$/).optional().describe('Continue a loop: the series an earlier round returned.'),
    purpose: z.string().max(600).optional().describe('What the screens are for, in a sentence, when the canvas does not say it.'),
    maker_model: z.string().max(80).optional().describe('The model that made the work, when you are not a run Bogen started, so the reviewer is another one.'),
    file_id: fileIdArg,
  }, async ({ node_ids, page_id, flow, reviewer, until, max_rounds, loop_request, series, purpose, maker_model, file_id }, ctx) => {
    if (ctx.dryRun) throw new Error('design_critique starts a reviewer session and takes minutes, so it does not run in a dry run.');
    const app = ctx.app;
    if (!ctx.session?.runId && (until !== undefined || max_rounds > 1) && !loop_request) throw new Error('Critique loops require the person’s explicit request quoted in loop_request. Default to one round, fix its objective defects, and do not re-review.');
    if ((await app.critiques.status()).state !== 'ready') throw new Error(`${CRITIQUE_MISSING} Until then, look at canvas_screenshot yourself and run design_lint and a11y_audit.`);
    const room = await ctx.room(file_id);
    const run = ctx.session.runId ? app.runs.list().find((r) => r.id === ctx.session.runId) : undefined;
    // A run on a designed edition of a brand book reviews the whole book in one loop (brand-edition.ts).
    const loop = run ? editionLoop(room.doc, run.startedAt) : null;
    const previous = series ? getCritiques(room.doc).filter((r) => r.series === series).sort((a, b) => a.round - b.round).at(-1) : undefined;
    if (!loop && !loop_request && (until !== undefined || max_rounds > 1 || (previous && (previous.maxRounds > 1 || previous.until !== undefined)))) {
      throw new Error('Continuing or starting a critique loop requires the person’s explicit request quoted in loop_request.');
    }
    const screens = loop ? undefined : node_ids;
    const pageId = loop ? loop.pageId : screens?.length ? undefined : ctx.page(room, page_id);
    const makerModel = (ctx.session.runId ? app.runs.modelOf(ctx.session.runId) : undefined) ?? (run?.runner === 'claude' ? 'opus' : maker_model);
    // CritiqueJobs queues reviews in arrival order, admitting one reviewer at a time.
    const start = () => app.critiques.start(room, {
      ...(screens?.length ? { screens } : {}), ...(pageId ? { pageId } : {}), ...(flow !== undefined ? { flow } : {}),
      reviewer: loop ? 'auto' : reviewer, ...(makerModel ? { makerModel } : {}),
      ...(loop ? { until: loop.until, maxRounds: loop.maxRounds, ...(loop.series ? { series: loop.series } : {}) }
        : { ...(until !== undefined ? { until } : {}), maxRounds: max_rounds, ...(series ? { series } : {}) }),
      ...(purpose ? { purpose } : {}),
    }).catch((e: Error) => {
      if (loop && /already ran its/.test(e.message)) throw new Error(`This book has had its ${loop.maxRounds === 1 ? 'review' : `${loop.maxRounds} review rounds`}. Fix what the last round found, then design_verify and report the score and what is open; no further review.`);
      throw e;
    });
    // A review an earlier call left going is the one to wait for, or to take the result of: no second review starts.
    let reviews = handedOff.get(app);
    if (!reviews) { reviews = new Map(); handedOff.set(app, reviews); }
    // Share admission as well as the running job: simultaneous retries cannot enqueue duplicate reviews.
    let pending = reviews.get(room.id);
    if (!pending) {
      pending = start();
      reviews.set(room.id, pending);
    }
    let job: CritiqueJob;
    try { job = await pending; } catch (e) {
      if (reviews.get(room.id) === pending) reviews.delete(room.id);
      throw e;
    }
    const patience = run?.runner === 'claude' ? CRITIQUE_CALL_WAIT.run : CRITIQUE_CALL_WAIT.ms;
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([app.critiques.wait(job.id)!, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), patience); })]).finally(() => clearTimeout(timer));
    if (!done) {
      const now = app.critiques.get(job.id) ?? job;
      return { state: 'reviewing', job: job.id, step: now.step ?? 'rules', ...(now.reviewer ? { reviewer: now.reviewer } : {}), screens: now.screens, rendered: now.rendered, seconds: Math.round((Date.now() - now.startedAt) / 1000), next: 'The reviewer is still looking; a review takes two to six minutes. Call design_critique again with the same arguments to wait for this one: it starts no second review. Do not change the screens meanwhile.' };
    }
    if (reviews.get(room.id) === pending) reviews.delete(room.id);
    if (done.state !== 'done' || !done.recordId) {
      if (loop && /already ran its/.test(done.error ?? '')) throw new Error(`This book has had its ${loop.maxRounds === 1 ? 'review' : `${loop.maxRounds} review rounds`}. Fix what the last round found, then design_verify and report the score and what is open; no further review.`);
      throw new Error(done.error ?? 'The review stopped.');
    }
    const record = getCritiques(room.doc).find((r) => r.id === done.recordId)!;
    return {
      id: record.id, series: record.series, round: record.round, max_rounds: record.maxRounds, ...(record.until !== undefined ? { until: record.until } : {}),
      reviewer: record.reviewer, ...(done.note ? { reviewer_note: done.note } : {}),
      score: record.score, dimensions: record.dimensions, verdict: record.verdict,
      defects: record.defects.map((d) => ({ title: d.title, kind: d.kind, screens: d.screens.map((n) => record.screens[n - 1]?.id ?? n), node_id: d.nodeId, evidence: d.evidence, fix: d.fix })),
      taste: record.taste, keep: record.keep, rule_findings_given: record.ruleFindings,
      seconds: Math.round(record.durationMs / 1000), next: done.next,
    };
  });
}
