import { applyPlan, branchContent, listDesignBranches, BogenDoc, commentsToContent, contentDelta, docFromContent, docToContent, labelChange, planRevert, Y, type RevertPlan } from '@bogen/core';
import { contentAssets, diffFolders, writeFolder, type FolderDiff } from './design-folder.ts';
import { gitCommit, type GitAuthor } from './git-mirror.ts';
import type { BogenServer } from './http/server.ts';
import type { CommitContent, CommitInfo, CommitKind } from './history.ts';
import type { ChangeEntry } from './timeline.ts';
import { HttpError, atomicWrite } from './util.ts';

/** What the History panel, the tools and the command line all do, in one place. */

export interface CommitOptions { message?: string; author: string; authorKind: 'person' | 'agent' | 'system'; kind?: CommitKind; run?: string }

/** Commits, and when the file is bound to a Git folder, mirrors the commit there. */
export async function createCommit(app: BogenServer, fileId: string, options: CommitOptions): Promise<CommitInfo & { git?: string | null }> {
  const { doc } = await app.rooms.get(fileId);
  await app.timeline.flush(fileId);
  const info = await app.commits.commit(fileId, doc, options);
  if (!info) throw new HttpError(500, 'Nothing was committed.');
  app.hub.broadcast({ t: 'history', fileId });
  const dir = options.kind === 'auto' ? undefined : await app.gitBindings.get(fileId);
  if (!dir) return info;
  const hash = await mirrorToGit(app, fileId, doc, dir, info.message ?? 'Commit', { name: options.author });
  return { ...info, git: hash };
}

export async function mirrorToGit(app: BogenServer, fileId: string, doc: BogenDoc, dir: string, message: string, author: GitAuthor): Promise<string | null> {
  const name = app.storage.get(fileId)?.name ?? 'Design';
  await writeFolder(dir, { name, content: docToContent(doc) }, async (asset) => (await app.storage.readAsset(asset))?.bytes ?? null);
  return gitCommit(dir, message, author);
}

/** A version of a file to compare or show. `now` is the live file. */
export async function contentAt(app: BogenServer, fileId: string, ref: string): Promise<CommitContent> {
  if (ref === 'now') {
    const { doc } = await app.rooms.get(fileId);
    return { ...docToContent(doc), comments: commentsToContent(doc) };
  }
  if (ref.startsWith('branch:')) {
    const branchId = ref.slice('branch:'.length);
    const room = await app.rooms.get(fileId);
    if (listDesignBranches(room.doc).some(b => b.id === branchId)) {
      return { ...branchContent(room.doc, branchId), comments: commentsToContent(room.doc) };
    }
    if (!(await readBranches(app, fileId)).some((b) => b.id === branchId)) throw new HttpError(404, 'No such branch of this file.');
    const { doc } = await app.rooms.get(branchId);
    return { ...docToContent(doc), comments: commentsToContent(doc) };
  }
  const content = await app.commits.read(fileId, ref);
  if (!content) throw new HttpError(404, `No commit ${ref}.`);
  return content;
}

export interface CommitDiff extends FolderDiff {
  from: string;
  to: string;
  comments: { added: number; removed: number; changed: number };
  /** Pages where something visible may differ, for rendering. */
  changedPages: { id: string; name: string; inFrom: boolean; inTo: boolean }[];
  counts: { added: number; removed: number; changed: number };
}

/** The difference of two versions: layers with the properties that changed, tokens, comments, assets. */
export async function diffCommits(app: BogenServer, fileId: string, from: string, to: string): Promise<CommitDiff> {
  const a = await contentAt(app, fileId, from);
  const b = await contentAt(app, fileId, to);
  const name = app.storage.get(fileId)?.name ?? '';
  const diff = diffFolders({ name, content: a }, { name, content: b }, contentAssets(a), contentAssets(b));
  const counts = contentDelta(a, b);
  const threadsA = a.comments ?? {};
  const threadsB = b.comments ?? {};
  const comments = {
    added: Object.keys(threadsB).filter((k) => !(k in threadsA)).length,
    removed: Object.keys(threadsA).filter((k) => !(k in threadsB)).length,
    changed: Object.keys(threadsB).filter((k) => k in threadsA && JSON.stringify(threadsA[k]) !== JSON.stringify(threadsB[k])).length,
  };
  const pagesA = new Map(a.pages.map((p) => [p.id, p]));
  const pagesB = new Map(b.pages.map((p) => [p.id, p]));
  const owner = (content: CommitContent) => {
    const map = new Map<string, string>(content.pages.map((p) => [p.id, p.id]));
    for (const n of content.nodes) map.set(n.id, map.get(n.parent) ?? n.parent);
    return map;
  };
  const ownerA = owner(a);
  const ownerB = owner(b);
  const before = new Map(a.nodes.map((n) => [n.id, JSON.stringify(n)]));
  const touched = new Set<string>();
  for (const n of b.nodes) if (before.get(n.id) !== JSON.stringify(n)) touched.add(ownerB.get(n.id) ?? '');
  const inB = new Set(b.nodes.map((n) => n.id));
  for (const n of a.nodes) if (!inB.has(n.id)) touched.add(ownerA.get(n.id) ?? '');
  if (JSON.stringify(a.tokens) !== JSON.stringify(b.tokens)) for (const p of b.pages) touched.add(p.id);
  return {
    ...diff, from, to, comments, counts,
    same: diff.same && !comments.added && !comments.removed && !comments.changed,
    changedPages: [...touched].flatMap((id) => {
      const page = pagesB.get(id) ?? pagesA.get(id);
      return page ? [{ id, name: page.name, inFrom: pagesA.has(id), inTo: pagesB.has(id) }] : [];
    }),
  };
}

/** One page of a version as a picture. An empty page has none. */
export async function renderVersion(app: BogenServer, fileId: string, ref: string, pageId: string): Promise<Uint8Array | null> {
  const doc = ref === 'now' ? (await app.rooms.get(fileId)).doc : docFromContent(await contentAt(app, fileId, ref));
  if (!doc.pages.has(pageId) || !doc.getChildren(pageId).filter((n) => !n.hidden).length) return null;
  return (await app.renderer.screenshot(doc, { pageId }, { format: 'png', scale: 1, maxDimension: 1600 })).bytes;
}

/** Before, after and the difference of one page, through the same comparison as `visual_diff`. */
export async function visualDiff(app: BogenServer, fileId: string, from: string, to: string, pageId: string): Promise<{ before: Uint8Array | null; after: Uint8Array | null; diff: Uint8Array | null; percent: number | null; bounds: unknown }> {
  const [before, after] = [await renderVersion(app, fileId, from, pageId), await renderVersion(app, fileId, to, pageId)];
  if (!before || !after) return { before, after, diff: null, percent: null, bounds: null };
  const out = await app.renderer.compareImages({ bytes: before, mime: 'image/png' }, { bytes: after, mime: 'image/png' }, { threshold: 0.05, fit: false, maxDimension: 1600, maxBytes: 8 * 1024 * 1024 });
  return { before, after, diff: out.png, percent: out.total ? Math.round((out.different / out.total) * 10000) / 100 : 0, bounds: out.bounds };
}

/** Which changes a request means. */
export async function pickChanges(app: BogenServer, fileId: string, query: { ids?: string[]; run?: string }): Promise<ChangeEntry[]> {
  const picked = await app.timeline.pick(fileId, query);
  const missing = (query.ids ?? []).filter((id) => !picked.some((e) => e.id === id));
  if (missing.length) throw new HttpError(404, `No change ${missing[0]}. Call change_list.`);
  if (query.run && !picked.length) throw new HttpError(404, `Nothing recorded for run ${query.run}.`);
  return picked;
}

export interface RevertResult extends RevertPlan { dryRun: boolean; changes: string[]; label: string }

function revertLabel(changes: ChangeEntry[], query: { run?: string }): string {
  if (query.run) return `Revert run ${query.run}`;
  return changes.length === 1 ? `Revert: ${changes[0]!.summary}`.slice(0, 200) : `Revert ${changes.length} changes`;
}

/** Plans a revert, and carries it out in one transaction unless asked only to look. */
export async function revertChanges(app: BogenServer, fileId: string, query: { ids?: string[]; run?: string }, options: { origin: unknown; dryRun?: boolean }): Promise<RevertResult> {
  const room = await app.rooms.get(fileId);
  const changes = await pickChanges(app, fileId, query);
  const plan = planRevert(room.doc, changes);
  const label = revertLabel(changes, query);
  const ids = changes.map((c) => c.id);
  if (!options.dryRun && plan.ops.length) {
    room.doc.transact(() => {
      applyPlan(room.doc, plan.ops);
      labelChange(room.doc, { label, revertOf: ids });
    }, options.origin);
    await app.timeline.flush(fileId);
    app.hub.broadcast({ t: 'history', fileId });
  }
  return { ...plan, dryRun: Boolean(options.dryRun), changes: ids, label };
}

/** Goes back to a commit as one change, committing what it replaces first, so that nothing is lost. */
export async function restoreCommit(app: BogenServer, fileId: string, commitId: string, options: { origin: unknown; author: string; authorKind: 'person' | 'agent' | 'system' }): Promise<{ restored: string; savedAs: string | null; pages: number; layers: number }> {
  const room = await app.rooms.get(fileId);
  const content = await app.commits.read(fileId, commitId);
  if (!content) throw new HttpError(404, `No commit ${commitId}. Call commit_list.`);
  const saved = await createCommit(app, fileId, { message: `Before restoring ${commitId}`, author: options.author, authorKind: options.authorKind, kind: 'restore' });
  const { applyContent } = await import('@bogen/core');
  room.doc.transact(() => {
    applyContent(room.doc, content);
    labelChange(room.doc, { label: `Restored ${commitId}`, restoreOf: commitId });
  }, options.origin);
  await app.timeline.flush(fileId);
  app.hub.broadcast({ t: 'history', fileId });
  return { restored: commitId, savedAs: saved.id, pages: content.pages.length, layers: content.nodes.length };
}

/** One list: commits and changes together, newest first. */
export async function historyList(app: BogenServer, fileId: string, options: { limit?: number; before?: number; run?: string; actor?: string; layer?: string; includeAuto?: boolean } = {}): Promise<unknown[]> {
  const changes = app.timeline.list(await app.timeline.all(fileId));
  const commits = (await app.commits.list(fileId)).filter((c) => options.includeAuto !== false || c.kind !== 'auto');
  const rows: (Record<string, unknown> & { at: number })[] = [
    ...changes
      .filter((c) => (!options.run || c.run === options.run) && (!options.actor || c.actor === options.actor) && (!options.layer || c.layers.includes(options.layer)))
      .map((c) => ({ ...c, row: 'change' })),
    ...(options.run || options.actor || options.layer ? commits.filter((c) => (!options.run || c.run === options.run) && (!options.actor || c.author === options.actor) && !options.layer) : commits).map((c) => ({ ...c, row: 'commit' })),
  ];
  const before = options.before;
  return rows.filter((r) => before === undefined || r.at < before).sort((a, b) => b.at - a.at).slice(0, options.limit ?? 200);
}

/** A named copy of a file that shares its history, so that it merges back through the CRDT. */
export interface BranchInfo { id: string; name: string; at: number; fileId: string; head?: string }

async function readBranches(app: BogenServer, fileId: string): Promise<BranchInfo[]> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  try {
    return JSON.parse(await readFile(join(app.storage.home, 'history', fileId, 'branches.json'), 'utf8')) as BranchInfo[];
  } catch {
    return [];
  }
}

async function writeBranches(app: BogenServer, fileId: string, list: BranchInfo[]): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(join(app.storage.home, 'history', fileId), { recursive: true, mode: 0o700 });
  await atomicWrite(join(app.storage.home, 'history', fileId, 'branches.json'), JSON.stringify(list, null, 1), 0o600);
}

export async function listBranches(app: BogenServer, fileId: string): Promise<(BranchInfo & { exists: boolean })[]> {
  return (await readBranches(app, fileId)).map((b) => ({ ...b, exists: Boolean(app.storage.get(b.id)) }));
}

export async function createBranch(app: BogenServer, fileId: string, name: string): Promise<BranchInfo> {
  const source = app.requireFile(fileId);
  const { newId } = await import('@bogen/core');
  const { doc } = await app.rooms.get(fileId);
  const copyId = newId();
  await atomicWrite(app.storage.docPath(copyId), Y.encodeStateAsUpdate(doc.y));
  const copy = app.storage.create(`${source.name} (branch: ${name})`, copyId);
  const branch: BranchInfo = { id: copy.id, name, at: Date.now(), fileId };
  await writeBranches(app, fileId, [...await readBranches(app, fileId), branch]);
  app.hub.broadcast({ t: 'files' });
  app.hub.broadcast({ t: 'history', fileId });
  return branch;
}

/** Everything in the copy goes into the file through the CRDT. What was changed on both sides merges by its usual rules. */
export async function mergeBranch(app: BogenServer, fileId: string, branchId: string, options: { author: string; authorKind: 'person' | 'agent' | 'system' }): Promise<{ merged: string; savedAs: string | null; delta: { added: number; removed: number; changed: number } }> {
  const branch = (await readBranches(app, fileId)).find((b) => b.id === branchId);
  if (!branch) throw new HttpError(404, 'No such branch of this file.');
  app.requireFile(branchId);
  const main = await app.rooms.get(fileId);
  const copy = await app.rooms.get(branchId);
  const saved = await createCommit(app, fileId, { message: `Before merging ${branch.name}`, author: options.author, authorKind: options.authorKind, kind: 'restore' });
  const before = docToContent(main.doc);
  Y.applyUpdate(main.doc.y, Y.encodeStateAsUpdate(copy.doc.y), `merge:${branch.name}`);
  await app.timeline.flush(fileId);
  app.hub.broadcast({ t: 'history', fileId });
  return { merged: branch.name, savedAs: saved.id, delta: contentDelta(before, docToContent(main.doc)) };
}

/**
 * Keep both as a branch, for a text both devices edited while apart: a branch of the file whose layer holds the
 * text that was not kept. The note goes; the branch merges back, or is discarded, like any other.
 */
export async function branchFromConflict(app: BogenServer, fileId: string, conflictId: string): Promise<BranchInfo> {
  const note = app.peers.conflicts.get(fileId, conflictId);
  if (!note) throw new HttpError(404, 'No such conflict note.');
  if (!note.texts || !note.nodeId) throw new HttpError(400, 'Only a text conflict can be kept as a branch.');
  const losing = note.kept === 'ours' ? note.texts.theirs : note.texts.ours;
  const from = note.kept === 'ours' ? note.device : app.peers.device().name;
  const branch = await createBranch(app, fileId, `text from ${from}`);
  const copy = await app.rooms.get(branch.id);
  if (copy.doc.getNode(note.nodeId)) copy.doc.updateFields(note.nodeId, { text: losing.text, spans: losing.spans ?? [] }, 'sync-text-conflict');
  app.peers.conflicts.dismiss(fileId, conflictId);
  return branch;
}

export async function discardBranch(app: BogenServer, fileId: string, branchId: string): Promise<void> {
  const list = await readBranches(app, fileId);
  if (!list.some((b) => b.id === branchId)) throw new HttpError(404, 'No such branch of this file.');
  await app.deleteFile(branchId);
  await writeBranches(app, fileId, list.filter((b) => b.id !== branchId));
  app.hub.broadcast({ t: 'history', fileId });
}
