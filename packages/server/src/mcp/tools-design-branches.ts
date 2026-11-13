import { z } from 'zod';
import { currentBranchId, describeBranch, getDesignBranch, MAIN_BRANCH } from '@bogen/core';
import { branchSummary, mergePreview, startBranch, switchBranch } from '../design-branches.ts';
import { visualDiff } from '../history-ops.ts';
import { busyOnBranch, fileIdArg, type ToolContext, type ToolDefiner } from './kit.ts';
import type { Room } from '../sync.ts';

/** The conversation of the run this session belongs to, so that its next message continues the same branch. */
function conversationOf(ctx: ToolContext): string | undefined {
  return ctx.session.runId ? ctx.app.runs.conversationOf(ctx.session.runId) : undefined;
}

export function branchNext(room: Room): string {
  return currentBranchId(room.doc) === MAIN_BRANCH
    ? 'Main is checked out: your edits change the primary version.'
    : `The branch "${getDesignBranch(room.doc, currentBranchId(room.doc)).name}" is checked out: your edits change it alone, and main stays as it is until the person merges.`;
}

/** Starts (or returns) a branch for an agent, checked out and pinned to its session. Shared by branch_create. */
export async function createBranchFor(ctx: ToolContext, room: Room, input: { name: string; note?: string; from?: string }) {
  const live = currentBranchId(room.doc);
  if (live !== ctx.branchOf(room)) throw new Error(`This file was switched to another branch since you started (${live} is checked out now). Nothing was made. Call file_open to continue on what is checked out, or tell the person.`);
  // Starting a branch checks it out: the person and every other agent then see it, so not under someone else's work.
  const busy = busyOnBranch(room, live, ctx.session);
  if (busy.length) throw new Error(`${busy.join(' and ')} ${busy.length === 1 ? 'is' : 'are'} working on the checked-out version of this file right now, and starting a branch would switch it away from under ${busy.length === 1 ? 'them' : 'each of them'}. Nothing was made. Wait until they are done, or tell the person.`);
  room.undoManagerFor(ctx.agent);
  ctx.wrote = true;
  const conversation = conversationOf(ctx);
  const out = await startBranch(ctx.app, room, { name: input.name, by: ctx.agent, kind: 'agent', ...(input.from ? { from: input.from } : {}), checkout: true, ...(input.note ? { note: input.note } : {}), ...(conversation ? { conversation } : {}) });
  ctx.pinBranch(room, out.branch.id);
  return {
    file_id: room.id, branch: describeBranch(room.doc, out.branch), reused: out.reused, ...branchSummary(room),
    next: `Work in this file as usual (same file_id ${room.id}); every change now goes into "${out.branch.name}" alone, tokens and theme settings included. Tell the person it is ready to compare: they switch between it and main in the editor, and merge or discard it there.`,
  };
}

/**
 * Branches inside one file (design-branches.ts in @bogen/core). Agents list, start and work in them; merging,
 * discarding and restoring are the person's, in the editor, and have no tool.
 */
export function registerDesignBranchTools(define: ToolDefiner): void {
  define('design_branch_list', { description: 'The branches of a file: versions of the whole design kept inside the same file, never as files of their own. Each holds its own pages, layers, components, tokens and file records (an Omarchy theme\'s palette, name and displays). Says which one is checked out (the live design every tool changes), which one this session works on, and what each started from. Merging and discarding are for the person, in the editor.', readOnly: true }, {
    file_id: fileIdArg,
  }, async ({ file_id }, ctx) => {
    const room = await ctx.room(file_id);
    return { file_id: room.id, ...branchSummary(room), yours: ctx.branchOf(room), note: branchNext(room) };
  });

  define('design_branch_compare', { description: 'What merging a branch would do, before the person decides: the screens that would change in the version it merges into (added, removed or changed, with how many layers), token changes, and conflicts where both sides changed the same thing. With screen_id, also how many pixels of that screen differ and a picture with the differences in red, rendered from the parent as it is now and as it would be after the merge. Use it to tell the person what to look at in their review, and to check that a branch changed only what it should. It changes nothing; only the person merges, in the editor, where the same comparison shows side by side, as an overlay and as a swipe.', readOnly: true }, {
    branch_id: z.string().min(1).max(40).describe('A branch id from design_branch_list.'),
    screen_id: z.string().max(200).optional().describe('One screen from the list, for its pixel difference and picture.'),
    file_id: fileIdArg,
  }, async ({ branch_id, screen_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const preview = mergePreview(room, branch_id);
    const out = {
      branch: preview.branch.name, into: preview.into.name, branch_changed: preview.branch_changed, parent_changed: preview.parent_changed,
      screens: preview.screens, tokens: preview.tokens, conflicts: preview.conflicts.map((c) => ({ key: c.key, label: c.label, branch: c.branch, into: c.primary })),
      ...(preview.screens.length ? {} : { note: 'No screen changes when this branch merges.' }),
    };
    if (!screen_id) return out;
    const screen = preview.screens.find((s) => s.id === screen_id);
    if (!screen) throw new Error(`${screen_id} is not a screen this merge changes. Changing: ${preview.screens.map((s) => `${s.name} (${s.id})`).join(', ') || 'none'}.`);
    const diff = await visualDiff(ctx.app, room.id, preview.compare.from, preview.compare.to, screen.pageId, screen.id);
    const text = { ...out, screen: { ...screen, different_percent: diff.percent, bounds: diff.bounds, picture: diff.diff ? 'differences in red' : screen.change === 'added' ? 'new in this merge, nothing before' : 'gone after the merge' } };
    const picture = diff.diff ?? diff.after ?? diff.before;
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(text, null, 1) },
        ...(picture ? [{ type: 'image' as const, data: Buffer.from(picture).toString('base64'), mimeType: 'image/png' }] : []),
      ],
    };
  });

  define('design_branch_create', { description: 'Start a branch of this file for an alternative or a redo the person asked for ("another direction", "try a warmer version", "make it again"): a named version of the whole design inside the same file, with its own tokens, theme record, components and layers, checked out so that your next edits go into it and main stays as it is. No new file, no new page. Asking again for a branch of the same name returns it (reused: true) instead of making another. Small edits the person asked for go on the branch that is checked out; they need no branch. Only the person merges or discards a branch, in the editor.' }, {
    name: z.string().trim().min(1).max(80).describe('What the person will read, such as "Warmer night".'),
    note: z.string().max(500).optional().describe('What it is for, in a sentence.'),
    from: z.string().max(40).optional().describe('The branch to start from. The checked-out one when left out.'),
    file_id: fileIdArg,
  }, async ({ name, note, from, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    return createBranchFor(ctx, room, { name, ...(note ? { note } : {}), ...(from ? { from } : {}) });
  });

  define('design_branch_switch', { description: 'Check out another branch of this file, so that it becomes the live design and your next edits go into it: back to main, or to a branch you were asked to continue. What was live is kept as its own branch; nothing is lost. The person sees the switch. Refused while another agent is working on the checked-out version.' }, {
    branch_id: z.string().min(1).max(40).describe(`A branch id from design_branch_list; "${MAIN_BRANCH}" for the primary version.`),
    file_id: fileIdArg,
  }, async ({ branch_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const live = currentBranchId(room.doc);
    if (branch_id !== live) {
      const busy = busyOnBranch(room, live, ctx.session);
      if (busy.length) throw new Error(`${busy.join(' and ')} ${busy.length === 1 ? 'is' : 'are'} working on the checked-out version of this file right now. Nothing was switched. Wait until they are done, or tell the person.`);
    }
    ctx.wrote = true;
    const branch = switchBranch(ctx.app, room, branch_id, ctx.agent);
    ctx.pinBranch(room, branch.id);
    return { file_id: room.id, branch: describeBranch(room.doc, branch), ...branchSummary(room), note: branchNext(room) };
  });
}
