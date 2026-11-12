// Revisions on the server: starting one, which takes a commit of the file first. Everything else about revisions is in
// @bogen/core (revisions.ts), shared with the editor.
//
// "Make this page again, I don't like it" becomes a named draft next to the original, not another page. While a run
// works in a revision the server refuses its writes outside the revision's copies (mcp/kit.ts), so "redo it" cannot
// quietly edit the original or spill onto a new page.

import { createProposals, draftFor, getRevision, proposalMark, rectFromStyle, saveRevision, type Revision, type RevisionIntent } from '@bogen/core';
import { createCommit } from './history-ops.ts';
import type { BogenServer } from './http/server.ts';
import type { Room } from './sync.ts';
import { errorMessage, HttpError } from './util.ts';

export {
  acceptRevision, discardRevision, draftFor, getRevision, listRevisions, revisionConflicts, revisionCopyOf, revisionScope, type Revision, type RevisionIntent,
} from '@bogen/core';

export interface StartRevision {
  intent: RevisionIntent;
  name: string;
  pageId: string;
  /** Artboards to revise; every visible artboard of the page when left out. */
  targets?: string[];
  by: string;
  runId?: string;
  conversation?: string;
  references?: string[];
  origin: unknown;
}

/** A revision of a whole page copies at most this much without the person choosing artboards. */
export const MAX_PAGE_ARTBOARDS = 24;
export const MAX_PAGE_LAYERS = 4000;

const newRevisionId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function startRevision(app: BogenServer, room: Room, input: StartRevision): Promise<Revision> {
  const { doc } = room;
  if (!doc.pages.has(input.pageId)) throw new HttpError(404, `No page ${input.pageId}.`);
  const open = draftFor(doc, input.conversation);
  if (open && input.intent !== 'new_page') throw new HttpError(409, `This conversation already works in the revision "${open.name}" (${open.id}). Keep changing it, or accept or discard it first.`);
  let targets: string[] = [];
  if (input.intent !== 'new_page') {
    const tops = doc.getChildren(input.pageId).filter((n) => n.artboard && !n.hidden && !proposalMark(doc, n.id));
    targets = input.targets?.length ? input.targets : tops.map((n) => n.id);
    for (const t of targets) {
      if (!doc.getNode(t) || doc.pageOf(t) !== input.pageId) throw new HttpError(400, `${t} is not a layer on that page.`);
      if (proposalMark(doc, t)) throw new HttpError(400, `${t} is a proposal itself; revise the original.`);
    }
    if (!targets.length) throw new HttpError(400, 'That page has no artboards to revise. Use intent new_page to start a page on purpose.');
    // A whole page of a hundred screens copied at once doubles what the canvas and every render hold. Past a few
    // dozen layers' worth of artboards the person names which ones are redone.
    const layers = targets.reduce((n, t) => n + 1 + doc.descendants(t).length, 0);
    if (!input.targets?.length && (targets.length > MAX_PAGE_ARTBOARDS || layers > MAX_PAGE_LAYERS)) {
      throw new HttpError(413, `That page has ${targets.length} artboards and ${layers} layers: too many to copy at once. Select the artboards to redo (or pass node_ids), up to ${MAX_PAGE_ARTBOARDS} at a time.`);
    }
  }
  // The way back, before anything changes: a commit named after the revision. Without it there is no promise to make,
  // so a failed snapshot stops here, before any copy exists.
  let commit: { id: string };
  try {
    commit = await createCommit(app, room.id, { message: `Before revision "${input.name}"`, author: input.by, authorKind: 'agent' });
  } catch (e) {
    throw new HttpError(503, `The file could not be committed before the revision (${errorMessage(e)}), so no revision was started and nothing changed. Check that Bogen's data folder has free space and is writable, then ask again.`);
  }
  const id = newRevisionId();
  const copies: string[] = [];
  let pageId = input.pageId;
  doc.transact(() => {
    if (input.intent === 'new_page') pageId = doc.createPage(input.name);
    else {
      const others = doc.getChildren(input.pageId).map(rectFromStyle);
      for (const t of targets) copies.push(createProposals(doc, t, { by: input.by, count: 1, notes: [input.name], revision: id, others })[0]!);
    }
    saveRevision(doc, {
      id, name: input.name, intent: input.intent, status: 'draft', by: input.by, at: Date.now(), pageId, targets, copies,
      checkpoint: commit.id, ...(input.runId ? { runId: input.runId } : {}), ...(input.conversation ? { conversation: input.conversation } : {}),
      ...(input.references?.length ? { references: input.references.map((r) => r.slice(0, 2000)).slice(0, 12) } : {}),
    });
  }, input.origin);
  return getRevision(doc, id);
}
