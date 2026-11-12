import { acceptProposal, createProposals, discardProposal, listProposals, pairLayers, ProposalConflictError, proposalMark, rectFromStyle, type BogenDoc, type Rect } from '@bogen/core';
import { z } from 'zod';
import type { Renderer } from '../render.ts';
import type { Room } from '../sync.ts';
import { assertUnlocked, fileIdArg, type ToolDefiner } from './kit.ts';

/**
 * Sizes come from a browser when there is one, since most layers have no fixed size. Where a top-level layer sits on
 * the page comes from its style, which is the only place that says so. A layer inside a frame is copied next to that frame.
 */
export async function proposalBoxes(renderer: Renderer, room: Room, sourceId: string, pageId: string): Promise<{ rect?: Rect; others?: Rect[] }> {
  const { doc } = room;
  const top = doc.getChildren(pageId);
  try {
    const entries = await renderer.layout(doc, { pageId });
    const size = (id: string) => entries.find((x) => x.id === id);
    const placed = (id: string): Rect => {
      const rect = rectFromStyle(doc.getNode(id)!);
      const measured = size(id);
      return measured ? { ...rect, w: measured.width, h: measured.height } : rect;
    };
    const anchor = [sourceId, ...doc.ancestors(sourceId)].at(-1)!;
    const around = placed(anchor);
    const own = size(sourceId);
    const rect = anchor === sourceId || !own ? around : { x: around.x + around.w - own.width, y: around.y, w: own.width, h: own.height };
    return { rect, others: top.filter((n) => n.id !== anchor).map((n) => placed(n.id)) };
  } catch {
    return {};
  }
}

/**
 * Which layer of a copy stands for which layer of the original, child by child. An agent that read the
 * original's tree holds its ids, and without this it edits the original's children instead of the copy's.
 * Instances are left out: their insides are changed through instance_set, not by id.
 */
export function copiedIds(doc: BogenDoc, from: string, to: string): Record<string, string> {
  // The copy records its complete map when it is made; an older proposal is paired child by child. No cap either way:
  // a page of 220 layers maps all 220, or an agent ends up editing the originals it was not given copies of.
  const mark = proposalMark(doc, to);
  const map = mark?.of === from && mark.map ? mark.map : pairLayers(doc, from, to);
  return Object.fromEntries(Object.entries(map).map(([copy, original]) => [original, copy]));
}

export function registerProposalTools(define: ToolDefiner): void {
  define('proposal_create', { description: `Work on a copy instead of the real thing, so that a person can review it first. Makes a copy of a layer next to it, marked as a proposal on the canvas with Accept and Discard. Change the copy with your usual tools, using the ids this returns, and leave the original alone.

Use it when you are changing something the person already cares about, when the change is large or a matter of taste, or when they ask for options. Do not use it for new artboards, small fixes they asked for directly, or when they want it done without review.

With count 3 and a note for each you get three directions side by side, and accepting one discards the others. Make the directions really differ, in composition and hierarchy, not in colour alone. wait_for_event tells you with proposal_accepted or proposal_discarded what the person decided.` }, {
    node_id: z.string().describe('The layer to make a proposal of, usually a frame or an artboard.'),
    count: z.number().int().min(1).max(6).default(1).describe('How many copies. Three is what people usually want for directions.'),
    notes: z.array(z.string().max(140)).max(6).optional().describe('A short label per copy, shown on the canvas, such as "Bolder type".'),
    file_id: fileIdArg,
  }, async ({ node_id, count, notes, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    assertUnlocked(doc, [node_id]);
    const pageId = doc.pageOf(node_id);
    if (!pageId) throw new Error(`No layer with id ${node_id}. Call layer_tree to see what exists.`);
    const n = Math.max(count, notes?.length ?? 0);
    const measured = await proposalBoxes(ctx.app.renderer, room, node_id, pageId);
    const ids = ctx.write(room, () => createProposals(doc, node_id, { by: ctx.agent, count: n, ...(notes ? { notes } : {}), ...measured, ...(measured.rect ? {} : { rect: rectFromStyle(doc.getNode(node_id)!) }) }));
    ctx.touch(ids);
    // What the person asked for, kept with the decision once they make it.
    if (ctx.session.runId) for (const id of ids) ctx.app.memory.noteOrigin(room.id, id, { runId: ctx.session.runId });
    return {
      proposals: ids.map((id, i) => ({ id, ...(notes?.[i] ? { note: notes[i] } : {}), layers: copiedIds(doc, node_id, id) })),
      of: node_id, page_id: pageId,
      hint: 'Change these ids. layers maps each layer of the original to its copy in that proposal: use the copy ids, never the original ones. The person accepts or discards them on the canvas.',
    };
  });

  define('proposal_list', { description: 'List the open proposals in a file: which layer each would replace, who made it and its note.', readOnly: true }, {
    file_id: fileIdArg,
  }, async ({ file_id }, ctx) => {
    const room = await ctx.room(file_id);
    return { proposals: listProposals(room.doc).map((p) => ({ id: p.id, of: p.of, by: p.by, name: p.name, ...(p.note ? { note: p.note } : {}), ...(p.group ? { group: p.group } : {}), page_id: p.pageId, source_exists: p.sourceExists })) };
  });

  define('proposal_accept', { description: 'Put this proposal into the original, as one undo step. The original and its layers keep their ids, comments and prototype links; sibling directions are discarded. Edits made to the original since the proposal was made are kept where the proposal left those layers alone. If both changed a layer it answers with the conflicts and changes nothing: ask the person, then call again with resolve. Only do this when the person told you to.', destructive: true }, {
    proposal_id: z.string(),
    resolve: z.union([z.enum(['proposal', 'original']), z.record(z.string(), z.enum(['proposal', 'original']))]).optional().describe('Only after the person decided: which side wins the conflicts, for all or per original layer id.'),
    file_id: fileIdArg,
  }, async ({ proposal_id, resolve, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    ctx.app.memory.refresh(room.id);
    try {
      const result = ctx.write(room, () => acceptProposal(room.doc, proposal_id, undefined, resolve));
      ctx.touch([result.sourceId]);
      return { accepted: proposal_id, node_id: result.sourceId, discarded: result.discarded, kept_from_original: result.kept };
    } catch (e) {
      if (e instanceof ProposalConflictError) return { accepted: null, conflicts: e.conflicts, hint: e.message };
      throw e;
    }
  });

  define('proposal_discard', { description: 'Remove a proposal. The original was never touched. Pass all to also remove the other directions made with it.', destructive: true }, {
    proposal_id: z.string(),
    all: z.boolean().default(false).describe('Also discard the directions made together with this one.'),
    file_id: fileIdArg,
  }, async ({ proposal_id, all, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    ctx.app.memory.refresh(room.id);
    const ids = ctx.write(room, () => discardProposal(room.doc, proposal_id, { group: all }));
    return { discarded: ids };
  });
}
