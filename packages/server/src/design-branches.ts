// Branches inside one file, on the server: the commit taken before each step that replaces the live design, the undo
// stacks that no longer apply after a switch, and the events the editor listens to. The model itself is in @bogen/core
// (design-branches.ts), shared with the editor.
//
// Agents start branches and work in them. Merging, discarding and taking a merge back are the person's: they come
// only through the editor's routes, never as agent tools.

import {
  BranchConflictError, branchContent, checkoutSeenBy, createDesignBranch, currentBranchId, describeBranch, discardDesignBranch, divertStaleEdits, docFromContent, docToContent, getDesignBranch, listDesignBranches,
  heldTarget, lostRemoteSets, MAIN_BRANCH, MAX_HELD, markBranchArchived, mergeDesignBranch, previewMerge, renameDesignBranch, restoreDesignBranch, switchDesignBranch, undoMerge, Y, type BranchResolution, type DesignBranch, type HeldUpdate,
} from '@bogen/core';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCommit } from './history-ops.ts';
import type { BogenServer } from './http/server.ts';
import type { Room } from './sync.ts';
import type { Storage } from './storage.ts';
import { atomicWriteSync, errorMessage, HttpError } from './util.ts';

export { BranchConflictError, currentBranchId, describeBranch, listDesignBranches, MAIN_BRANCH, type DesignBranch } from '@bogen/core';

export type BranchActorKind = 'person' | 'agent';

/** Pictures one held update may name; an update naming more is refused before anything changes. */
export const MAX_HELD_ASSETS = 10_000;

/** The origin branch steps are written under: never one an undo manager tracks, so that undo cannot split a switch. */
export const branchOrigin = (by: string) => `branch:${by}`;

function changed(app: BogenServer, room: Room): void {
  room.clearUndo();
  app.hub.broadcast({ t: 'history', fileId: room.id });
}

async function checkpoint(app: BogenServer, room: Room, message: string, by: string, kind: BranchActorKind): Promise<string> {
  try {
    return (await createCommit(app, room.id, { message, author: by, authorKind: kind, kind: 'restore' })).id;
  } catch (e) {
    throw new HttpError(503, `The file could not be committed first (${errorMessage(e)}), so nothing changed. Check that Bogen's data folder has free space and is writable, then try again.`);
  }
}

/**
 * Keeps a branch's content in the file's History as a named commit, which is never thinned, and notes it on the
 * branch: only then may the file let go of that branch's snapshots once it is old.
 */
async function archive(app: BogenServer, room: Room, id: string, message: string, by: string): Promise<string> {
  const info = await app.commits.commit(room.id, docFromContent(branchContent(room.doc, id)), { message, author: by, authorKind: 'person', kind: 'commit' });
  if (!info) throw new Error('Nothing was committed.');
  return info.id;
}

/** Keeps a branch's content in History for good and notes it on the branch. Returns the commit. */
export async function archiveBranch(app: BogenServer, room: Room, id: string, message: string, by: string): Promise<string> {
  const commit = await archive(app, room, id, message, by);
  markBranchArchived(room.doc, id, commit, branchOrigin(by));
  return commit;
}

/** Every branch of a file, as a person or an agent reads it, with the checked-out one marked. */
export function branchSummary(room: Room) {
  const doc = room.doc;
  const branches = listDesignBranches(doc);
  return {
    current: currentBranchId(doc),
    branches: branches.filter((b) => b.status === 'open').map((b) => describeBranch(doc, b)),
    decided: branches.filter((b) => b.status !== 'open').slice(-12).reverse().map((b) => describeBranch(doc, b)),
  };
}

export interface StartBranch {
  name: string;
  by: string;
  kind: BranchActorKind;
  from?: string;
  checkout?: boolean;
  note?: string;
  conversation?: string;
}

/** Starts a branch, or returns the open one of that name, after a commit of the file as it is. */
export async function startBranch(app: BogenServer, room: Room, input: StartBranch): Promise<{ branch: DesignBranch; reused: boolean }> {
  const doc = room.doc;
  const same = listDesignBranches(doc).find((b) => b.status === 'open' && b.id !== MAIN_BRANCH && (!input.from || b.parent === input.from) && b.name.toLowerCase() === input.name.replace(/\s+/g, ' ').trim().toLowerCase());
  const commit = same ? undefined : await checkpoint(app, room, `Before branch "${input.name.trim().slice(0, 80)}"`, input.by, input.kind);
  const before = currentBranchId(doc);
  let out: { branch: DesignBranch; reused: boolean };
  try {
    out = createDesignBranch(doc, {
      name: input.name, by: input.by, ...(input.from ? { from: input.from } : {}), checkout: input.checkout ?? true,
      ...(input.note ? { note: input.note } : {}), ...(input.conversation ? { conversation: input.conversation } : {}), ...(commit ? { checkpoint: commit } : {}),
    }, branchOrigin(input.by));
  } catch (e) {
    throw new HttpError(409, errorMessage(e));
  }
  if (currentBranchId(doc) !== before) changed(app, room);
  else app.hub.broadcast({ t: 'history', fileId: room.id });
  return out;
}

/** Checks out a branch. What was live is kept as its own branch's content; nothing is lost. */
export function switchBranch(app: BogenServer, room: Room, id: string, by: string): DesignBranch {
  const before = currentBranchId(room.doc);
  let out: DesignBranch;
  try {
    out = switchDesignBranch(room.doc, id, branchOrigin(by));
  } catch (e) {
    throw new HttpError(/^No branch/.test(errorMessage(e)) ? 404 : 409, errorMessage(e));
  }
  if (before !== id) changed(app, room);
  return out;
}

export function renameBranch(app: BogenServer, room: Room, id: string, name: string, by: string): DesignBranch {
  try {
    const out = renameDesignBranch(room.doc, id, name, branchOrigin(by));
    app.hub.broadcast({ t: 'history', fileId: room.id });
    return out;
  } catch (e) {
    throw new HttpError(400, errorMessage(e));
  }
}

export function mergePreview(room: Room, id: string) {
  try {
    const p = previewMerge(room.doc, id);
    return { branch: describeBranch(room.doc, p.branch), into: describeBranch(room.doc, p.into), conflicts: p.conflicts, parent_changed: p.parentChanged, branch_changed: p.branchChanged };
  } catch (e) {
    throw new HttpError(409, errorMessage(e));
  }
}

/** The person's merge. Conflicts come back as data and change nothing; `resolve` is their answer. */
export async function mergeBranch(app: BogenServer, room: Room, id: string, input: { by: string; resolve?: BranchResolution }): Promise<{ merged: DesignBranch; into: DesignBranch; checkpoint: string } | { merged: null; conflicts: BranchConflictError['conflicts'] }> {
  try {
    previewMerge(room.doc, id);
  } catch (e) {
    throw new HttpError(409, errorMessage(e));
  }
  const name = getDesignBranch(room.doc, id).name;
  const commit = await checkpoint(app, room, `Before merging the branch "${name}"`, input.by, 'person');
  let kept: string;
  try {
    kept = await archive(app, room, id, `Branch "${name}" as it was when merged`, input.by);
  } catch (e) {
    throw new HttpError(503, `The branch could not be kept in History first (${errorMessage(e)}), so it was not merged.`);
  }
  try {
    const out = mergeDesignBranch(room.doc, id, { by: input.by, ...(input.resolve ? { resolve: input.resolve } : {}) }, branchOrigin(input.by));
    markBranchArchived(room.doc, id, kept, branchOrigin(input.by));
    changed(app, room);
    return { merged: out.branch, into: out.into, checkpoint: commit };
  } catch (e) {
    if (e instanceof BranchConflictError) return { merged: null, conflicts: e.conflicts };
    throw new HttpError(409, errorMessage(e));
  }
}

export async function undoBranchMerge(app: BogenServer, room: Room, id: string, by: string): Promise<DesignBranch> {
  await checkpoint(app, room, `Before taking back the merge of "${getDesignBranch(room.doc, id).name}"`, by, 'person');
  try {
    const out = undoMerge(room.doc, id, branchOrigin(by));
    changed(app, room);
    return out;
  } catch (e) {
    throw new HttpError(409, errorMessage(e));
  }
}

/**
 * The person's discard. The branch's content goes into the file's History as a named commit first, so it is there for
 * good even after the file lets go of its snapshot.
 */
export async function discardBranch(app: BogenServer, room: Room, id: string, by: string): Promise<{ discarded: DesignBranch; commit: string }> {
  const rec = getDesignBranch(room.doc, id);
  if (rec.status !== 'open' || id === MAIN_BRANCH) throw new HttpError(409, id === MAIN_BRANCH ? 'Main cannot be discarded.' : `The branch "${rec.name}" was ${rec.status} already.`);
  let commit: string;
  try {
    commit = await archive(app, room, id, `Discarded branch "${rec.name}"`, by);
  } catch (e) {
    throw new HttpError(503, `The branch could not be kept in History first (${errorMessage(e)}), so it was not discarded.`);
  }
  const before = currentBranchId(room.doc);
  try {
    discardDesignBranch(room.doc, id, by, branchOrigin(by));
    markBranchArchived(room.doc, id, commit, branchOrigin(by));
    const out = getDesignBranch(room.doc, id);
    if (currentBranchId(room.doc) !== before) changed(app, room);
    else app.hub.broadcast({ t: 'history', fileId: room.id });
    return { discarded: out, commit };
  } catch (e) {
    throw new HttpError(409, errorMessage(e));
  }
}

export function restoreBranch(app: BogenServer, room: Room, id: string, by: string): DesignBranch {
  try {
    const out = restoreDesignBranch(room.doc, id, branchOrigin(by));
    app.hub.broadcast({ t: 'history', fileId: room.id });
    return out;
  } catch (e) {
    throw new HttpError(409, errorMessage(e));
  }
}

/** Whether a replica with this state vector missed the latest checkout, so its edits belong to another branch. */
export function staleFor(room: Room, remoteSv: Uint8Array | Map<number, number>): boolean {
  return checkoutSeenBy(room.doc, remoteSv instanceof Map ? remoteSv : Y.decodeStateVector(remoteSv)).stale;
}

/**
 * Applies an update from another replica (a peer, the phone, an editor that was away) that comes with that replica's
 * state vector. When the replica had not seen the latest checkout, what it changed in the design was meant for the
 * branch it last saw: those edits are laid onto that branch (or one recovery branch per replica, when that branch is
 * not open any more), and the live design keeps what it had.
 *
 * Before anything changes, the update is written to disk as it came (`history/<file>/stale/`, a name of its own that
 * is never reused); when that write fails the update is refused and the document stays as it was. Whatever could not
 * be laid on (text typed against the checkout, kinds of values not read back) is kept as a content-addressed asset,
 * however large, with a small record on the branch in the document, so that it syncs and goes with a .bogen download.
 * A branch holds at most MAX_HELD such updates until the person has looked at them; one more is refused, again before
 * anything changes, with its copy on disk. Callers skip their own text repairs for a diverted update (`diverted`).
 */
export function applyRemoteUpdate(env: { storage: Storage; changed?: (fileId: string) => void }, room: Room, update: Uint8Array, remoteSv: Uint8Array | Map<number, number>, from: { name: string; id: string } | string, origin: unknown): { diverted: boolean; branch?: DesignBranch; held?: number; kept?: string } {
  const doc = room.doc;
  const who = typeof from === 'string' ? { name: from, id: from } : from;
  const sv = remoteSv instanceof Map ? remoteSv : Y.decodeStateVector(remoteSv);
  const seen = checkoutSeenBy(doc, sv);
  // An empty answer (a fresh editor has nothing of its own) needs no comparison of the whole design.
  if (!seen.stale || update.length <= 2) {
    Y.applyUpdate(doc.y, update, origin);
    return { diverted: false };
  }
  // Durable first: nothing is applied unless the update as it came is on disk, and its own asset exists.
  const kept = keepStale(env.storage.home, room.id, { from: who.name, source: who.id, known: seen.known, latest: seen.latest, update, sv: remoteSv instanceof Map ? null : remoteSv });
  const target = heldTarget(doc, seen.known, who.id);
  // Every picture the update names stays reachable from its held record; an update naming more is refused whole.
  const named = [...new Set(Buffer.from(update).toString('latin1').match(/bogen-asset:[0-9a-f]{64}\.[a-z0-9]{1,8}/g) ?? [])].map((m) => m.slice('bogen-asset:'.length));
  if (named.length > MAX_HELD_ASSETS) throw new HttpError(413, `${who.name} sent edits made before it saw a checkout that name ${named.length} pictures, more than ${MAX_HELD_ASSETS} can be held. Nothing was applied; the update is kept as it came in ${kept}.`);
  if (target.held >= MAX_HELD) {
    throw new HttpError(507, `${who.name} sent edits made before it saw a checkout, and the branch they belong to already holds ${target.held} such updates that nobody has looked at. Nothing was applied; the update is kept as it came in ${kept}. Look at the held updates of that branch first.`);
  }
  const raw = env.storage.putAssetSync(new TextEncoder().encode(JSON.stringify({ format: 'bogen-held-update', from: who.name, source: who.id, known: seen.known, update: Buffer.from(update).toString('base64'), sv: remoteSv instanceof Map ? null : Buffer.from(remoteSv).toString('base64') })), 'application/json');
  const before = docToContent(doc);
  Y.applyUpdate(doc.y, update, origin);
  const lost = lostRemoteSets(doc, update);
  const needsRaw = lost.unsafe.length > 0 || lost.unread > 0;
  const heldId = kept.split('/').pop()!.replace(/\.json$/, '');
  const held: HeldUpdate | undefined = needsRaw ? { id: heldId, at: Date.now(), from: who.name, source: who.id, bytes: update.length, layers: lost.unsafe, asset: raw.src, ...(named.length ? { assets: named } : {}), path: kept } : undefined;
  const out = divertStaleEdits(doc, before, docToContent(doc), { known: seen.known, from: who.name, source: who.id, by: 'bogen', lost: lost.ops, unsafe: lost.unsafe, ...(held ? { held } : {}) }, branchOrigin('bogen'));
  if (!out) return { diverted: false, kept };
  room.clearUndo();
  const count = out.held + out.skipped + lost.unread;
  console.error(`bogen: edits from ${who.name} to ${room.id} were made before it saw a checkout; laid onto "${out.branch.name}" (${out.branch.id})${count ? `, ${count} of them held back as they came (${raw.src})` : ''}. Raw update: ${kept}.`);
  env.changed?.(room.id);
  return { diverted: true, branch: out.branch, held: count, kept };
}

/**
 * Writes a stale update as it came, synchronously and durably (fsync) before anything else happens. Named by the hash
 * of the update and its sender, written exclusively: two different updates never share a file, and the same update
 * sent again (a refused editor reconnecting) finds its file instead of filling the disk. Throws when it cannot write.
 */
function keepStale(home: string, fileId: string, record: { from: string; source: string; known: string; latest: string; update: Uint8Array; sv: Uint8Array | null }): string {
  const dir = join(home, 'history', fileId, 'stale');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${createHash('sha256').update(record.source).update('\0').update(record.update).digest('hex').slice(0, 32)}.json`;
  const path = join(dir, name);
  const rel = `history/${fileId}/stale/${name}`;
  if (existsSync(path)) return rel;
  const body = JSON.stringify({ ...record, at: new Date().toISOString(), update: Buffer.from(record.update).toString('base64'), sv: record.sv ? Buffer.from(record.sv).toString('base64') : null });
  atomicWriteSync(path, body, { exclusive: true });
  return rel;
}
