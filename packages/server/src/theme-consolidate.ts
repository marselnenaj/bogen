// Bringing legacy duplicates of one theme together: several files that are copies of one logical theme (made before a
// theme had one project) become branches of the one the person chose, each with its whole design, its comments and
// where it came from. Nothing is deleted, renamed or moved: each other file keeps its design, comments and History,
// and gets only a record of the project it went into, so that it is a recoverable source of that project rather than a
// competing one; the person archives or deletes it once they are sure. A plan comes first and says everything that would happen; carrying it out
// needs the plan's own hash, so that what the person reviewed is what happens, and stops if anything changed since.

import { createHash } from 'node:crypto';
import { BogenDoc, branchHash, canonicalJson, commentsToContent, hasDesignBranches, createDesignBranch, designHash, docToContent, listDesignBranches, MAX_OPEN_BRANCHES, Y, type DesignContent } from '@bogen/core';
import { archiveBranch, branchOrigin } from './design-branches.ts';
import { createCommit } from './history-ops.ts';
import type { BogenServer } from './http/server.ts';
import { themeMeta } from './omarchy-themes.ts';
import { commentsFingerprint, CONSOLIDATED_KEY, consolidationMark, designWithoutMark, refreshThemeIndex } from './theme-projects.ts';
import { HttpError } from './util.ts';

/** A file someone touched this recently, or that has a person or an agent in it, is being worked on: left alone. */
export const ACTIVE_MS = 10 * 60_000;
export const MAX_SOURCES = 11;

export interface PlanFile {
  file_id: string;
  name: string;
  theme: { name: string; target: string; profile?: string; from?: string } | null;
  updatedAt: number;
  layers: number;
  tokens: number;
  comments: number;
  assets: number;
  /** Hash of its whole design, the same way branches compare. */
  hash: string;
  /** Hash of its comment threads, every message: part of what the person reviewed. */
  commentsHash: string;
  /** Someone has it open or changed it lately. */
  active: boolean;
  /** Its design is exactly the target's, or another source's: still imported, as a record of where it came from. */
  identicalTo?: string;
  /** Imported before with this very content: skipped. */
  alreadyImported?: string;
}

export interface ConsolidationPlan {
  target: PlanFile;
  /** import: a new branch; comments: the design is in its branch already, only its comment threads are newer; skip: nothing new. */
  sources: (PlanFile & { action: 'import' | 'comments' | 'skip'; branchName?: string; branchId?: string; reason?: string })[];
  problems: string[];
  ok: boolean;
  /** Pass this back to carry the plan out; it changes when any of the files changes. */
  plan_hash: string;
  note: string;
}

async function readFile(app: BogenServer, id: string): Promise<{ doc: BogenDoc; loaded: boolean; dispose: () => void }> {
  app.requireFile(id);
  const live = app.rooms.peek(id);
  if (live) return { doc: live.doc, loaded: true, dispose: () => {} };
  const state = await app.storage.readDoc(id);
  const doc = new BogenDoc(new Y.Doc());
  if (state) Y.applyUpdate(doc.y, state);
  return { doc, loaded: false, dispose: () => doc.y.destroy() };
}

/** A source's design as it is brought in, without the record of where it was brought (theme-projects.ts). */
const sourceContent = designWithoutMark;

function assetsOf(content: DesignContent): number {
  return new Set(JSON.stringify(content).match(/bogen-asset:[0-9a-f]{64}\.[a-z0-9]{1,8}/g) ?? []).size;
}

function describe(app: BogenServer, id: string, doc: BogenDoc, content: DesignContent): PlanFile {
  const entry = app.storage.get(id)!;
  const meta = themeMeta(doc);
  const room = app.rooms.peek(id);
  const active = Boolean(room && (room.conns.size > 0 || room.agents.size > 0)) || Date.now() - entry.updatedAt < ACTIVE_MS;
  return {
    file_id: id, name: entry.name, theme: meta ? { name: meta.name, target: meta.target ?? 'desktop', ...(meta.profile ? { profile: meta.profile } : {}), ...(meta.from ? { from: meta.from } : {}) } : null,
    updatedAt: entry.updatedAt, layers: content.nodes.length, tokens: content.tokens.length, comments: Object.keys(commentsToContent(doc)).length, assets: assetsOf(content),
    hash: designHash(content), commentsHash: commentsFingerprint(doc), active,
  };
}

/** What consolidating these files into `target` would do. Reads them; changes nothing. */
export async function consolidationPlan(app: BogenServer, targetId: string, sourceIds: string[]): Promise<ConsolidationPlan> {
  const ids = [...new Set(sourceIds)].filter((id) => id !== targetId);
  if (!ids.length) throw new HttpError(400, 'Name the other copies to bring into this theme.');
  if (ids.length > MAX_SOURCES) throw new HttpError(400, `At most ${MAX_SOURCES} copies at a time.`);
  const t = await readFile(app, targetId);
  try {
    const targetContent = docToContent(t.doc);
    const target = describe(app, targetId, t.doc, targetContent);
    const problems: string[] = [];
    if (!target.theme) problems.push(`${target.name} is not a theme file.`);
    if (target.active) problems.push(`${target.name} is being worked on (open, or changed in the last ${ACTIVE_MS / 60_000} minutes). Try again once it is quiet.`);
    const seen = new Map<string, string>([[target.hash, targetId]]);
    const sources: ConsolidationPlan['sources'] = [];
    for (const id of ids) {
      const s = await readFile(app, id);
      try {
        const content = sourceContent(s.doc);
        const file = describe(app, id, s.doc, content);
        const same = seen.get(file.hash);
        if (same) file.identicalTo = same;
        else seen.set(file.hash, id);
        const before = [...listDesignBranches(t.doc)].reverse().find((b) => b.imported?.fileId === id && b.status !== 'discarded' && !b.pruned && branchHash(t.doc, b.id) === file.hash);
        if (before) file.alreadyImported = before.id;
        const mismatch = !file.theme ? 'it is not a theme file' : target.theme && (file.theme.target !== target.theme.target || (file.theme.profile ?? '') !== (target.theme.profile ?? '')) ? `it is a ${file.theme.target} theme${file.theme.profile ? ` (${file.theme.profile})` : ''}, not ${target.theme.target}` : null;
        if (mismatch) problems.push(`${file.name} (${id}) cannot be a branch of ${target.name}: ${mismatch}.`);
        // A copy with branches of its own would need its whole branch graph brought along; that is not done here.
        if (hasDesignBranches(s.doc) && listDesignBranches(s.doc).some((b) => b.parent !== null && (b.status === 'open' || (b.head && !b.pruned)))) problems.push(`${file.name} (${id}) has branches of its own. Bringing it in would keep only what is checked out, so it is left alone: merge or discard its branches first, or keep it as a separate file.`);
        const mark = consolidationMark(s.doc);
        if (mark && mark.fileId !== targetId && app.storage.get(mark.fileId)) problems.push(`${file.name} (${id}) was brought into another theme (${mark.fileId}) already.`);
        if (file.active) problems.push(`${file.name} (${id}) is being worked on (open, or changed in the last ${ACTIVE_MS / 60_000} minutes). It is left alone; try again once it is quiet.`);
        // Its design is in a branch already: nothing new, unless its comments changed since (new work of their own).
        const commentsKept = Boolean(file.alreadyImported && mark && mark.fileId === targetId && mark.commentsHash === file.commentsHash);
        if (file.alreadyImported && commentsKept) sources.push({ ...file, action: 'skip', branchId: file.alreadyImported, reason: 'brought in before with this same design and these same comments' });
        else if (file.alreadyImported) sources.push({ ...file, action: 'comments', branchId: file.alreadyImported, reason: 'its design is in its branch already; its newer comment threads come along' });
        else sources.push({ ...file, action: 'import', branchName: `${file.name.replace(/ · Omarchy (mobile )?theme$/, '')} · ${id}` });
      } finally {
        s.dispose();
      }
    }
    const open = listDesignBranches(t.doc).filter((b) => b.status === 'open' && b.parent !== null).length;
    const adding = sources.filter((s) => s.action === 'import').length;
    if (open + adding > MAX_OPEN_BRANCHES) problems.push(`${target.name} would have ${open + adding} open branches, more than ${MAX_OPEN_BRANCHES}. Bring fewer copies at a time, or merge or discard some branches first.`);
    const plan_hash = createHash('sha256').update(JSON.stringify([target.file_id, target.hash, target.commentsHash, target.updatedAt, ...sources.map((s) => [s.file_id, s.hash, s.commentsHash, s.updatedAt, s.action])])).digest('hex').slice(0, 24);
    return {
      target, sources, problems, ok: problems.length === 0, plan_hash,
      note: 'Each copy becomes a branch of this theme with its whole design (palette, records, components, layers, pictures) and its comments, and remembers the file it came from. The copies themselves keep their design, comments and History; each only gets a record that it was brought into this theme, so that it is no project of its own any more and later work goes to the branch. Archive or delete them yourself once you are sure. A commit of this theme is taken first.',
    };
  } finally {
    t.dispose();
  }
}

/**
 * Carries a reviewed plan out: each source to import becomes a branch of the target, not checked out, with its content,
 * its comment threads (marked with the branch and the file they came from, anchors unchanged, nothing resolved) and its
 * origin. Refused, with nothing changed, unless the plan is still exactly the one reviewed and has no problems.
 */
export async function consolidate(app: BogenServer, targetId: string, sourceIds: string[], input: { planHash: string; by: string }): Promise<{ imported: { file_id: string; branch_id: string; name: string; comments: number; history: string }[]; skipped: string[]; checkpoint: string; sources_kept: true }> {
  const plan = await consolidationPlan(app, targetId, sourceIds);
  if (plan.plan_hash !== input.planHash) throw new HttpError(409, 'One of the files changed since this plan was made, so nothing was done. Look at the new plan and confirm it again.');
  if (!plan.ok) throw new HttpError(409, `Nothing was done: ${plan.problems.join(' ')}`);
  const room = await app.rooms.get(targetId);
  const checkpoint = (await createCommit(app, targetId, { message: `Before bringing ${plan.sources.filter((s) => s.action !== 'skip').length} copies in as branches`, author: input.by, authorKind: 'person', kind: 'commit' })).id;
  const out: { file_id: string; branch_id: string; name: string; comments: number; history: string }[] = [];
  for (const s of plan.sources) {
    if (s.action === 'skip') continue;
    const src = await readFile(app, s.file_id);
    try {
      const content = sourceContent(src.doc);
      if (designHash(content) !== s.hash || commentsFingerprint(src.doc) !== s.commentsHash) throw new HttpError(409, `${s.name} changed while it was being brought in; it and the ones after it were not. The ones before are branches now.`);
      let branchId = s.branchId ?? '';
      let comments = 0;
      room.doc.transact(() => {
        if (s.action === 'import') {
          const { branch } = createDesignBranch(room.doc, { name: s.branchName!, by: input.by, from: 'main', content, note: `Brought in from the file "${s.name}" (${s.file_id}), last changed ${new Date(s.updatedAt).toISOString()}. That file keeps its design and History.`, imported: { fileId: s.file_id, name: s.name, at: Date.now() } });
          branchId = branch.id;
        }
        const branch = { id: branchId };
        // Comments are a conversation, not design: they come along as threads of their own, anchored as they were.
        // A thread already here is never written over: replies, attachments or a resolution added in this theme stay.
        // A source thread that differs from the one here (new replies on the source) comes as a thread of its own.
        src.doc.comments.forEach((thread, threadId) => {
          const plain = (m: unknown) => {
            const { branch: _b, importedFrom: _i, importedAs: _a, ...rest } = ((m as { toJSON(): Record<string, unknown> }).toJSON());
            return canonicalJson(rest);
          };
          const theirs = plain(thread);
          const first = `${s.file_id}-${threadId}`.slice(0, 64);
          const here = room.doc.comments.get(first);
          let key = first;
          if (here) {
            if (plain(here) === theirs) return;
            key = `${s.file_id}-${createHash('sha256').update(threadId).update(theirs).digest('hex').slice(0, 16)}`;
            if (room.doc.comments.has(key)) return;
          }
          const copy = (thread as unknown as { clone(): typeof thread }).clone();
          copy.set('branch', branch.id);
          copy.set('importedFrom', s.file_id);
          if (key !== first) copy.set('importedAs', first);
          room.doc.comments.set(key, copy);
          comments++;
        });
      }, branchOrigin(input.by));
      // Its content is also kept in this theme's History for good, so that it can never be let go silently.
      const history = s.action === 'import' ? await archiveBranch(app, room, branchId, `Brought in "${s.name}" (${s.file_id}) as a branch`, input.by) : '';
      // The source says where it went: no project of its own any more, its later work refused for agents and shown as
      // changed for the person. Its design, comments and History stay as they were.
      const sourceRoom = await app.rooms.get(s.file_id);
      sourceRoom.doc.transact(() => sourceRoom.doc.meta.set(CONSOLIDATED_KEY, { fileId: targetId, branchId, at: Date.now(), hash: s.hash, commentsHash: s.commentsHash }), branchOrigin(input.by));
      refreshThemeIndex(app.storage, s.file_id, sourceRoom.doc);
      out.push({ file_id: s.file_id, branch_id: branchId, name: s.branchName ?? s.name, comments, history });
    } finally {
      src.dispose();
    }
  }
  refreshThemeIndex(app.storage, targetId, room.doc);
  app.hub.broadcast({ t: 'history', fileId: targetId });
  app.hub.broadcast({ t: 'files' });
  return { imported: out, skipped: plan.sources.filter((s) => s.action === 'skip').map((s) => s.file_id), checkpoint, sources_kept: true };
}
