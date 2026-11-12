import type { BogenDoc } from './doc.ts';
import { acceptProposal, proposalConflicts, proposalMark, ProposalConflictError, type ConflictResolution, type ProposalConflict } from './proposals.ts';

/**
 * Revisions: a named set of proposals made together for the artboards of one page, with the commit taken before it, an
 * intent, who made it and the conversation it belongs to. Stored in the file's meta, so a reload, another device or a
 * follow-up run sees the same open draft. The parts that need no server live here, for the editor and the server alike.
 */

export type RevisionIntent = 'revise' | 'alternative' | 'new_page';
export type RevisionStatus = 'draft' | 'accepted' | 'discarded';

export interface Revision {
  id: string;
  name: string;
  intent: RevisionIntent;
  status: RevisionStatus;
  by: string;
  at: number;
  pageId: string;
  /** The original artboards it is a revision of. */
  targets: string[];
  /** Their copies, in the same order. Empty for a new page. */
  copies: string[];
  /** The commit taken before it started: where "go back" goes. */
  checkpoint?: string;
  runId?: string;
  conversation?: string;
  /** Approved references and do/don't notes for this draft: material for later runs, never instructions. */
  references?: string[];
  decidedAt?: number;
  decidedBy?: string;
}

const META = 'revisions';
const MAX_KEPT = 40;

export function listRevisions(doc: BogenDoc): Revision[] {
  const raw = doc.meta.get(META);
  if (!raw || typeof raw !== 'object') return [];
  return Object.values(raw as Record<string, Revision>).filter((r) => r && typeof r.id === 'string' && Array.isArray(r.copies) && Array.isArray(r.targets)).sort((a, b) => a.at - b.at);
}

export function getRevision(doc: BogenDoc, id: string): Revision {
  const r = listRevisions(doc).find((x) => x.id === id);
  if (!r) throw new Error(`No revision ${id}. revision_list shows them.`);
  return r;
}

export function saveRevision(doc: BogenDoc, rev: Revision): void {
  const all = Object.fromEntries(listRevisions(doc).map((r) => [r.id, r]));
  all[rev.id] = rev;
  // Decided revisions beyond the newest few are forgotten; their commits stay in the history.
  const decided = Object.values(all).filter((r) => r.status !== 'draft').sort((a, b) => b.at - a.at);
  for (const old of decided.slice(MAX_KEPT)) delete all[old.id];
  doc.meta.set(META, all);
}

/** The draft a conversation is working in, so that "a bit more contrast" continues on it after a reload or on the phone. */
export function draftFor(doc: BogenDoc, conversation: string | undefined): Revision | undefined {
  if (!conversation) return undefined;
  return listRevisions(doc).filter((r) => r.status === 'draft' && r.conversation === conversation).at(-1);
}

/** The revision a proposal copy belongs to. */
export function revisionOf(doc: BogenDoc, proposalId: string): Revision | undefined {
  const id = proposalMark(doc, proposalId)?.revision;
  return id ? listRevisions(doc).find((r) => r.id === id) : undefined;
}

/** Every layer a run in this revision may change: the copies and everything inside them. */
export function revisionScope(doc: BogenDoc, rev: Revision): Set<string> {
  const out = new Set<string>();
  for (const c of rev.copies) {
    if (!doc.nodes.has(c)) continue;
    out.add(c);
    for (const n of doc.descendants(c)) out.add(n.id);
  }
  return out;
}

/** Original layer to its copy, across the revision's copies. */
export function revisionCopyOf(doc: BogenDoc, rev: Revision): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of rev.copies) {
    const mark = proposalMark(doc, c);
    if (!mark) continue;
    out.set(mark.of, c);
    for (const [copy, orig] of Object.entries(mark.map ?? {})) out.set(orig, copy);
  }
  return out;
}

/** Conflicts across all of a revision's copies, before anything is applied. */
export function revisionConflicts(doc: BogenDoc, rev: Revision): ProposalConflict[] {
  return rev.copies.filter((c) => doc.nodes.has(c) && proposalMark(doc, c)).flatMap((c) => proposalConflicts(doc, c));
}

/** All or nothing: every copy is checked first, then all are accepted in one transaction (one undo step). */
export function acceptRevision(doc: BogenDoc, id: string, by: string, origin: unknown, resolve?: ConflictResolution): { revision: Revision; kept: string[]; moved: string[] } {
  const rev = getRevision(doc, id);
  if (rev.status !== 'draft') throw new Error(`The revision "${rev.name}" was ${rev.status} already.`);
  const conflicts = revisionConflicts(doc, rev);
  const open = conflicts.filter((c) => !(typeof resolve === 'string' ? resolve : resolve?.[c.original]));
  if (open.length) throw new ProposalConflictError(open);
  const kept: string[] = [];
  const moved: string[] = [];
  doc.transact(() => {
    for (const copy of rev.copies) {
      if (!doc.nodes.has(copy) || !proposalMark(doc, copy)) continue;
      doc.invalidate();
      const out = acceptProposal(doc, copy, origin, resolve);
      kept.push(...out.kept);
      moved.push(...out.moved);
    }
    saveRevision(doc, { ...rev, status: 'accepted', decidedAt: Date.now(), decidedBy: by });
  }, origin);
  return { revision: getRevision(doc, id), kept, moved };
}

/** Removes the copies; the record and its commit stay, so the draft can still be found and restored from history. */
export function discardRevision(doc: BogenDoc, id: string, by: string, origin: unknown): Revision {
  const rev = getRevision(doc, id);
  if (rev.status !== 'draft') throw new Error(`The revision "${rev.name}" was ${rev.status} already.`);
  doc.transact(() => {
    const gone = rev.copies.filter((c) => doc.nodes.has(c));
    if (gone.length) doc.delete(gone);
    saveRevision(doc, { ...rev, status: 'discarded', decidedAt: Date.now(), decidedBy: by });
  }, origin);
  return getRevision(doc, id);
}
