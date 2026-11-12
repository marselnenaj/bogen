// The entry point that keeps "redo it" from turning into a new page: every run, whatever started it, passes here before
// its CLI starts. A request that reads as a redo of existing work (or says so with intent revise) gets a revision with
// a checkpoint first, or continues the one its conversation has open; the run is then held to its copies by the
// server. New pages need intent new_page; small edits stay direct, with no copy made.

import { discardRevision, draftFor, inferIntent, layerFingerprint, listRevisions, proposalMark, type RunIntent } from '@bogen/core';
import type { RunEnd, RunRequest } from './agents.ts';
import type { BogenServer } from './http/server.ts';
import { startRevision } from './revisions.ts';
import { branchChanged, currentBranchId, discardDesignBranch, listDesignBranches, switchDesignBranch } from '@bogen/core';
import { branchOrigin, startBranch } from './design-branches.ts';
import { agentOrigin } from './sync.ts';
import { branchChangedBesidesMeta, CONTENT_LANGUAGE_KEY, setContentLanguage } from '@bogen/core';
import { languageBranchName } from './run-language.ts';

/**
 * Runs that already have their own way of protecting the original: copies of their own (race, proposal, directions),
 * comments only (critique), a project folder (live), or a rebuild into a new layer. A comment that asks for a redo is
 * not one of them: "@claude make this again" goes into a revision like the same words in the prompt bar.
 */
function exempt(req: RunRequest): boolean {
  return Boolean(req.race || req.live || req.rebuildOf || req.review === 'critique' || req.review === 'proposal' || req.review === 'directions');
}

/** A short name for the revision, from the request: what the person will see on the canvas. */
function revisionName(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  return (line.length > 48 ? `${line.slice(0, 47).replace(/\s+\S*$/, '')}…` : line) || 'Redo';
}

/**
 * After a run that opened a revision ends without success: a draft nobody changed is withdrawn, so a stopped or
 * failed run leaves no empty copies on the canvas. A draft with any change, or one someone else has touched since,
 * stays for the person to accept or discard; the record and its commit stay either way.
 */
export async function settleRunRevision(app: BogenServer, end: RunEnd): Promise<'withdrawn' | 'kept' | null> {
  if (end.branch?.opened && end.status !== 'done' && app.storage.get(end.fileId)) {
    // A theme branch the run opened and never changed goes again, and the file is back where it was.
    const { doc } = await app.rooms.get(end.fileId);
    const rec = listDesignBranches(doc).find((b) => b.id === end.branch!.id);
    if (!rec || rec.status !== 'open') return null;
    // A language version's branch has its language set from the start; that alone is no work worth keeping. It is
    // compared with the language the branch started with (main may have had one of its own), without changing it.
    const own = end.language?.mode === 'add' && doc.meta.get(CONTENT_LANGUAGE_KEY) === end.language.tag && currentBranchId(doc) === rec.id;
    const changed = own ? branchChangedBesidesMeta(doc, rec.id, CONTENT_LANGUAGE_KEY) : branchChanged(doc, rec.id);
    if (changed || listDesignBranches(doc).some((b) => b.parent === rec.id && b.status === 'open')) return 'kept';
    discardDesignBranch(doc, rec.id, 'bogen', branchOrigin('bogen'));
    return 'withdrawn';
  }
  if (!end.revision?.opened || end.status === 'done') return null;
  if (!app.storage.get(end.fileId)) return null;
  const room = await app.rooms.get(end.fileId);
  const { doc } = room;
  const rev = listRevisions(doc).find((r) => r.id === end.revision!.id);
  if (!rev || rev.status !== 'draft') return null;
  const untouched = rev.copies.every((c) => {
    const mark = proposalMark(doc, c);
    if (!mark?.map || !mark.base) return false;
    if (mark.base[c] === undefined || layerFingerprint(doc, c) !== mark.base[c]) return false;
    const kids = Object.keys(mark.map);
    // No layer added or removed in the copy, and none changed.
    return doc.descendants(c).length === kids.length && kids.every((k) => doc.nodes.has(k) && layerFingerprint(doc, k) === mark.base![mark.map![k]!]);
  });
  if (!untouched) return 'kept';
  discardRevision(doc, rev.id, 'bogen', `run-ended:${end.runId}`);
  return 'withdrawn';
}

export async function prepareRunIntent(app: BogenServer, req: RunRequest): Promise<RunRequest> {
  if (exempt(req)) return req;
  const language = req.contentLanguage;
  // Adding a language version keeps the original as it is, with or without a selection: the version is a branch of
  // the whole design inside this file, with the language set on it. The selection only says what to translate there.
  if (language?.mode === 'add') return addLanguageVersion(app, req);
  // A translation changes the existing layers in place, unless the person chose otherwise for this message.
  if (language?.mode === 'translate' && !req.intent) return { ...req, intent: 'edit' };
  // A comment run's prompt is the whole thread; what it was asked is the message that called it, kept as its title.
  // For a bare "@claude" under a request, the title is that request (see `thread-request.ts`).
  const asked = req.threadId ? (req.title || req.prompt) : req.prompt;
  const intent: RunIntent = req.intent ?? inferIntent(asked);
  if (intent !== 'revise') return { ...req, intent };
  const room = await app.rooms.get(req.fileId);
  const { doc } = room;
  const agent = req.agent ?? req.runner;
  // The next message in a conversation keeps working on the draft it opened.
  // A comment thread is its own conversation: the next @-mention in it continues the same draft.
  const conversation = req.conversationId ?? (req.threadId ? `thread:${req.threadId}` : undefined);
  // A theme is one file with its branches: a redo of it is a branch of the whole design (palette, records, layers),
  // never a copy of artboards that shares the palette with the original (design-branches.ts).
  if (doc.meta.get('omarchyTheme')) {
    const continued = conversation ? listDesignBranches(doc).filter((b) => b.status === 'open' && b.conversation === conversation).at(-1) : undefined;
    if (continued) {
      if (currentBranchId(doc) !== continued.id) {
        switchDesignBranch(doc, continued.id, branchOrigin(agent));
        room.clearUndo();
      }
      return { ...req, intent, branch: { id: continued.id, name: continued.name, reused: true } };
    }
    const out = await startBranch(app, room, { name: revisionName(asked), by: agent, kind: 'agent', checkout: true, ...(conversation ? { conversation } : {}) });
    return { ...req, intent, branch: { id: out.branch.id, name: out.branch.name, reused: out.reused } };
  }
  const open = draftFor(doc, conversation);
  if (open) return { ...req, intent, revision: { id: open.id, name: open.name, artboards: open.targets.map((t, i) => ({ original: t, copy: open.copies[i]! })), reused: true } };
  // Which artboards: the ones selected (or the artboards holding the selection), else every artboard of the page.
  const pageId = req.pageId && doc.pages.has(req.pageId) ? req.pageId : doc.getPages().find((p) => doc.getChildren(p.id).some((n) => n.artboard))?.id;
  if (!pageId) return { ...req, intent: 'edit' };
  const tops = new Set<string>();
  for (const id of req.nodeIds ?? []) {
    const top = [id, ...doc.ancestors(id)].at(-1);
    const n = top ? doc.getNode(top) : undefined;
    if (n?.artboard && doc.pageOf(n.id) === pageId && !proposalMark(doc, n.id)) tops.add(n.id);
  }
  const hasArtboards = doc.getChildren(pageId).some((n) => n.artboard && !n.hidden && !proposalMark(doc, n.id));
  // Nothing there yet: there is nothing to redo, so the request builds in place.
  if (!hasArtboards) return { ...req, intent: 'edit' };
  const rev = await startRevision(app, room, {
    intent: 'revise', name: revisionName(asked), pageId, ...(tops.size ? { targets: [...tops] } : {}), by: agent,
    ...(conversation ? { conversation } : {}), origin: agentOrigin(agent),
  });
  return { ...req, intent, revision: { id: rev.id, name: rev.name, artboards: rev.targets.map((t, i) => ({ original: t, copy: rev.copies[i]! })), reused: false } };
}

/**
 * A language version: a branch named after the language ("German (de)"), started from what is checked out now and
 * checked out for the run, with the file's design language set on it alone. The same language in the same file
 * continues its open branch. Main, and every other branch, keep their content and their language.
 */
async function addLanguageVersion(app: BogenServer, req: RunRequest): Promise<RunRequest> {
  const language = req.contentLanguage!;
  const room = await app.rooms.get(req.fileId);
  const { doc } = room;
  const agent = req.agent ?? req.runner;
  const conversation = req.conversationId ?? (req.threadId ? `thread:${req.threadId}` : undefined);
  const out = await startBranch(app, room, {
    name: languageBranchName(language), by: agent, kind: 'agent', checkout: true,
    note: `The ${language.name} version of this design, next to the original.`, ...(conversation ? { conversation } : {}),
  });
  if (currentBranchId(doc) !== out.branch.id) {
    switchDesignBranch(doc, out.branch.id, branchOrigin(agent));
    room.clearUndo();
  }
  if (doc.meta.get(CONTENT_LANGUAGE_KEY) !== language.tag) setContentLanguage(doc, language.tag, branchOrigin(agent));
  return { ...req, intent: 'edit', branch: { id: out.branch.id, name: out.branch.name, reused: out.reused } };
}
