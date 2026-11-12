import { proposalMark, ProposalConflictError } from '@bogen/core';
import { z } from 'zod';
import { acceptRevision, discardRevision, getRevision, listRevisions, revisionConflicts, startRevision, type Revision } from '../revisions.ts';
import { agentOrigin } from '../sync.ts';
import { fileIdArg, pageIdArg, type ToolDefiner } from './kit.ts';

const Resolve = z.union([z.enum(['proposal', 'original']), z.record(z.string(), z.enum(['proposal', 'original']))]).optional()
  .describe('Only after the person decided: for conflicts, which side wins, for all ("proposal" or "original") or per original layer id.');

/** What an agent needs of a revision: names, state, and for each original artboard its copy and the full id map. */
function describe(doc: Parameters<typeof listRevisions>[0], r: Revision, withLayers = false) {
  return {
    id: r.id, name: r.name, intent: r.intent, status: r.status, by: r.by, at: new Date(r.at).toISOString(), page_id: r.pageId,
    ...(r.checkpoint ? { checkpoint: r.checkpoint } : {}), ...(r.references?.length ? { references: r.references } : {}),
    artboards: r.targets.map((t, i) => {
      const copy = r.copies[i];
      const mark = copy ? proposalMark(doc, copy) : undefined;
      return {
        original: t, copy: copy ?? null,
        ...(withLayers && mark?.map ? { layers: Object.fromEntries(Object.entries(mark.map).map(([c, o]) => [o, c])) } : {}),
      };
    }),
  };
}

export function registerRevisionTools(define: ToolDefiner): void {
  define('revision_start', { description: `Start a revision before redoing work the person already has, instead of making a new page or editing the original. Pick the intent from what they said:

- revise ("make it again", "I don't like it", "redo the hero"): a named draft copy of the page's artboards (or the ones in node_ids) next to them. The original stays untouched; this run and later runs in the same conversation can only change the copies until the person accepts or discards it. A commit of the file is taken first, as the way back.
- alternative ("show me another direction"): the same, marked as an alternative to compare.
- new_page: only when they asked for a new page. It is made on purpose, under that name.

Returns the copy of every artboard and, per copy, which copy layer stands for which original layer (complete, however many). Change the copies with your usual tools. references are approved notes or links for this draft; later runs get them back as material, not as instructions.` }, {
    intent: z.enum(['revise', 'alternative', 'new_page']),
    name: z.string().trim().min(1).max(80).describe('What the person will read, such as "Calmer hero" or "Pricing, second pass".'),
    page_id: pageIdArg,
    node_ids: z.array(z.string()).max(200).optional().describe('Artboards to revise. Every visible artboard of the page when left out.'),
    references: z.array(z.string().max(2000)).max(12).optional().describe('Approved references and do/don\'t notes for this draft.'),
    file_id: fileIdArg,
  }, async ({ intent, name, page_id, node_ids, references, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const runIntent = ctx.runIntent();
    if (intent === 'new_page' && runIntent && runIntent !== 'new_page') throw new Error('This run was not asked for a new page, so it cannot open one through a revision either. Redo the existing artboards (intent revise), or tell the person they can ask for a new page with New page in the prompt bar.');
    // Named artboards say which page; otherwise the session's page.
    const ofNodes = !page_id && node_ids?.length ? room.doc.pageOf(node_ids[0]!) : undefined;
    const pageId = ctx.page(room, page_id ?? ofNodes);
    room.undoManagerFor(ctx.agent);
    ctx.wrote = true;
    const conversation = ctx.session.runId ? ctx.app.runs.conversationOf(ctx.session.runId) : undefined;
    const rev = await startRevision(ctx.app, room, {
      intent, name, pageId, ...(node_ids?.length ? { targets: node_ids } : {}), by: ctx.agent, ...(ctx.session.runId ? { runId: ctx.session.runId } : {}),
      ...(conversation ? { conversation } : {}), ...(references?.length ? { references } : {}), origin: agentOrigin(ctx.agent),
    });
    ctx.session.revision = { fileId: room.id, id: rev.id };
    ctx.touch(rev.copies);
    if (rev.intent === 'new_page') ctx.page(room, rev.pageId);
    return { ...describe(room.doc, rev, true), hint: rev.intent === 'new_page' ? 'The page is made. Work on it.' : 'Change the copy ids. Writes to the originals are refused while this revision is open. The person accepts or discards it on the canvas.' };
  });

  define('revision_list', { description: 'The revisions of a file: drafts, accepted and discarded ones, with their name, intent, who made them, the commit taken before each, and every original artboard with its copy. Use it to find the copy ids of the revision this conversation works in.', readOnly: true }, {
    file_id: fileIdArg,
    revision_id: z.string().optional().describe('One revision, with its full layer map.'),
  }, async ({ file_id, revision_id }, ctx) => {
    const room = await ctx.room(file_id);
    if (revision_id) {
      const rev = getRevision(room.doc, revision_id);
      return { ...describe(room.doc, rev, true), conflicts: rev.status === 'draft' ? revisionConflicts(room.doc, rev) : [] };
    }
    const current = ctx.revision(room);
    return { revisions: listRevisions(room.doc).map((r) => describe(room.doc, r)), ...(current ? { current: current.id } : {}) };
  });

  define('revision_accept', { description: 'Accept a revision: every copy goes into its original, keeping the original layers\' ids, comments and prototype links, as one undo step. Edits made to the original meanwhile are kept where the revision left those layers alone. If both sides changed a layer it answers with the conflicts and changes nothing; ask the person, then call again with resolve. Only when the person told you to accept.', destructive: true }, {
    revision_id: z.string(),
    resolve: Resolve,
    file_id: fileIdArg,
  }, async ({ revision_id, resolve, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    room.undoManagerFor(ctx.agent);
    ctx.wrote = true;
    try {
      const out = acceptRevision(room.doc, revision_id, ctx.agent, agentOrigin(ctx.agent), resolve);
      if (ctx.session.revision?.id === revision_id) delete ctx.session.revision;
      ctx.touch(out.revision.targets);
      return { accepted: out.revision.id, artboards: out.revision.targets, kept_from_original: out.kept, moved_from_proposal: out.moved };
    } catch (e) {
      if (e instanceof ProposalConflictError) return { accepted: null, conflicts: e.conflicts, hint: e.message };
      throw e;
    }
  });

  define('revision_discard', { description: 'Discard a revision: its copies go, the originals were never touched. The revision stays in revision_list with the commit taken before it, so it can still be found.', destructive: true }, {
    revision_id: z.string(),
    file_id: fileIdArg,
  }, async ({ revision_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    room.undoManagerFor(ctx.agent);
    ctx.wrote = true;
    const rev = discardRevision(room.doc, revision_id, ctx.agent, agentOrigin(ctx.agent));
    if (ctx.session.revision?.id === revision_id) delete ctx.session.revision;
    return { discarded: rev.id, checkpoint: rev.checkpoint ?? null };
  });
}
