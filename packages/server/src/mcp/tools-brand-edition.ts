import { z } from 'zod';
import { brandLinkOf, EDITION_PART_NAMES, RUNNER_IDS, type RunnerId } from '@bogen/core';
import { EDITION_DISCIPLINE, EDITION_MAX_ROUNDS, EDITION_UNTIL } from '../brand-edition.ts';
import { fileCreateGuard } from './tools-files.ts';
import type { ToolContext, ToolDefiner } from './kit.ts';

/** The brand a call means: the one named, or the one the current file links to. */
async function brandIdOf(ctx: ToolContext, given?: string): Promise<string> {
  if (given) return given;
  const fileId = ctx.session.fileId;
  const room = fileId && ctx.app.storage.get(fileId) ? await ctx.app.rooms.get(fileId) : undefined;
  if (room && ctx.app.storage.get(room.id)?.kind === 'brand') return room.id;
  const linked = room ? brandLinkOf(room.doc)?.id : undefined;
  if (!linked) throw new Error('Which brand? The current file links to none. Call brand_list, or pass brand_id.');
  return linked;
}

/** The designed edition of a brand book: a file an agent art-directs from the brand, with independent reviews. */
export function registerBrandEditionTools(define: ToolDefiner): void {
  define('brand_book_design', {
    description: `Make an art-directed edition of a brand's guidelines: a new file "<Brand> · Brand book" that links the brand, holds the generated brand book as a locked reference page, and an empty page for the book. With start_run (the default) Bogen starts its own agent run there, on the person's plan with their chosen agent and model: it designs 10 to 14 landscape pages of 1280x800 with the ${EDITION_DISCIPLINE} skill and has them reviewed once with design_critique (target ${EDITION_UNTIL}) before it is done, or in a loop of up to ${EDITION_MAX_ROUNDS} rounds when the person asks for one with rounds; it takes half an hour or more. With start_run false you get the file and the brief and do the work yourself. action status says whether the brand has an edition and which parts of the brand changed since; action refresh starts a run that redoes the pages showing those parts. Only when the person asks for it: it spends their plan.`,
  }, {
    action: z.enum(['create', 'status', 'refresh']).default('create'),
    brand_id: z.string().optional().describe('The brand. Defaults to the current brand, or the brand the current file links to.'),
    start_run: z.boolean().default(true).describe('Start Bogen\'s own agent run in the new file. False: make the file and return the brief for you.'),
    runner: z.enum(RUNNER_IDS).optional().describe('The agent of the run, default claude. Its model and effort are the ones the person chose for chat requests.'),
    note: z.string().max(2000).optional().describe('What the person adds to the brief, in their words.'),
    rounds: z.number().int().min(1).max(EDITION_MAX_ROUNDS).optional().describe('Review rounds: 1 unless the person asked for a loop. Each is a reviewer session on their plan.'),
  }, async ({ action, brand_id, start_run, runner, note, rounds }, ctx) => {
    const app = ctx.app;
    const brandId = await brandIdOf(ctx, brand_id);
    app.brands.requireBrand(brandId);
    if (action === 'status') {
      const status = await app.brandEditions.status(brandId);
      if (!status) return { brand_id: brandId, edition: null, next: 'This brand has no designed edition. Make one with action create when the person asks.' };
      return { brand_id: brandId, edition: { ...status, changed: status.changed.map((p) => ({ part: p, name: EDITION_PART_NAMES[p] })) } };
    }
    if (ctx.dryRun) throw new Error('brand_book_design makes a file and starts an agent run, so it does not run in a dry run.');
    if (ctx.session.runId && app.runs.allowedFilesOf(ctx.session.runId)) throw new Error('This run may only change the file it was asked to work in, so it cannot make a brand book file. Say in your answer that the person can start one from the brand page.');
    const chosen: RunnerId = runner ?? 'claude';
    if (action === 'refresh') return app.brandEditions.refresh(brandId, { runner: chosen, by: ctx.agent, ...(rounds ? { rounds } : {}) });
    fileCreateGuard(ctx, undefined);
    const out = await app.brandEditions.create(brandId, { runner: chosen, by: ctx.agent, start: start_run, ...(rounds ? { rounds } : {}), ...(note ? { extra: note } : {}) });
    return {
      ...out,
      next: out.run_id
        ? `Bogen's ${chosen} run designs the book in file ${out.file_id}. The person follows it in that file's chat and the activity dock. Do not edit the file while it runs.`
        : `Open file ${out.file_id} with file_open, read design_knowledge action skill discipline ${EDITION_DISCIPLINE}, and follow the brief.`,
    };
  });
}
