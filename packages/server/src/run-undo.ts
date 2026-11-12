import { applyPlan, labelChange, planRevert, type RevertConflict } from '@bogen/core';
import type { BogenServer } from './http/server.ts';
import { HttpError } from './util.ts';

export interface UndoRunResult { reverted: number; unchanged: number; clean: boolean; conflicts: RevertConflict[]; changes: string[]; layers: string[] }

/**
 * Takes back everything one run changed, as one change: the run's entries in the timeline, reverted together.
 * What someone changed since in the same place stays, and is listed as a conflict, as a revert in History does.
 * The conversation stays: replies and resolved threads are what was said, not what was done.
 */
export async function undoRun(app: BogenServer, fileId: string, runId: string, who: string): Promise<UndoRunResult> {
  const record = await app.history.get(fileId, runId);
  if (!record) throw new HttpError(404, 'No such run in this file.');
  if (record.status === 'running') throw new HttpError(409, 'This run is still going. Stop it first.');
  if (record.undone) throw new HttpError(409, `${record.undone.by} already took this run back.`);
  const room = await app.rooms.get(fileId);
  const picked = await app.timeline.pick(fileId, { run: runId });
  const changes = picked
    .map((e) => (e.ops ? { ...e, ops: e.ops.filter((op) => op.p[0] !== 'comments') } : e))
    .filter((e) => !e.ops || e.ops.length > 0);
  if (!changes.length) throw new HttpError(404, 'This run changed nothing that can be taken back.');
  const plan = planRevert(room.doc, changes);
  const ids = changes.map((c) => c.id);
  const title = (record.title || record.prompt).replace(/\s+/g, ' ').trim().slice(0, 120);
  if (plan.ops.length) {
    room.doc.transact(() => {
      applyPlan(room.doc, plan.ops);
      labelChange(room.doc, { label: `Undo ${record.runner} run: ${title}`.slice(0, 200), revertOf: ids });
    }, `person:${who}`);
    await app.timeline.flush(fileId);
    app.hub.broadcast({ t: 'history', fileId });
  }
  app.history.markUndone(fileId, runId, who);
  return { reverted: plan.reverted, unchanged: plan.unchanged, clean: plan.clean, conflicts: plan.conflicts, changes: ids, layers: plan.layers };
}
