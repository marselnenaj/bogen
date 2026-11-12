import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { describeBranch } from '@bogen/core';
import { branchSummary, discardBranch, mergeBranch, mergePreview, renameBranch, restoreBranch, startBranch, switchBranch, undoBranchMerge } from '../design-branches.ts';
import type { BogenServer } from './server.ts';
import { jsonBody, sendJson } from './server.ts';

const By = z.string().trim().min(1).max(80).default('person');
const Create = z.object({ name: z.string().trim().min(1).max(80), from: z.string().max(40).optional(), checkout: z.boolean().optional(), note: z.string().max(500).optional(), by: By });
const Side = z.enum(['branch', 'primary']);
const Merge = z.object({ resolve: z.union([Side, z.record(z.string().max(200), Side)]).optional(), by: By });
const Who = z.object({ by: By });
const Rename = z.object({ name: z.string().trim().min(1).max(80), by: By });

/**
 * `/api/files/:id/design-branches`: the editor's branches of one file. Starting, switching and renaming are open to
 * the editor like any edit; merging, discarding, restoring and taking a merge back are the person's decisions, made
 * here and never through an agent tool.
 */
export async function handleDesignBranches(app: BogenServer, req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<boolean> {
  const [a, fileId, c, branchId, action] = parts;
  if (a !== 'files' || !fileId || c !== 'design-branches') return false;
  const method = req.method ?? 'GET';
  app.requireFile(fileId);
  const room = await app.rooms.get(fileId);
  if (!branchId) {
    if (method === 'GET') {
      sendJson(res, 200, branchSummary(room));
      return true;
    }
    if (method === 'POST') {
      const body = await jsonBody(req, Create);
      const out = await startBranch(app, room, { name: body.name, by: body.by, kind: 'person', ...(body.from ? { from: body.from } : {}), checkout: body.checkout ?? true, ...(body.note ? { note: body.note } : {}) });
      sendJson(res, out.reused ? 200 : 201, { branch: describeBranch(room.doc, out.branch), reused: out.reused, ...branchSummary(room) });
      return true;
    }
    return false;
  }
  if (!action && method === 'PATCH') {
    const body = await jsonBody(req, Rename);
    sendJson(res, 200, { branch: describeBranch(room.doc, renameBranch(app, room, branchId, body.name, body.by)), ...branchSummary(room) });
    return true;
  }
  if (action === 'switch' && method === 'POST') {
    const body = await jsonBody(req, Who);
    sendJson(res, 200, { branch: describeBranch(room.doc, switchBranch(app, room, branchId, body.by)), ...branchSummary(room) });
    return true;
  }
  if (action === 'merge' && method === 'GET') {
    sendJson(res, 200, mergePreview(room, branchId));
    return true;
  }
  if (action === 'merge' && method === 'POST') {
    const body = await jsonBody(req, Merge);
    const out = await mergeBranch(app, room, branchId, { by: body.by, ...(body.resolve ? { resolve: body.resolve } : {}) });
    if (!out.merged) {
      sendJson(res, 409, { merged: null, conflicts: out.conflicts, ...branchSummary(room) });
      return true;
    }
    sendJson(res, 200, { merged: describeBranch(room.doc, out.merged), into: describeBranch(room.doc, out.into), checkpoint: out.checkpoint, ...branchSummary(room) });
    return true;
  }
  if (action === 'undo-merge' && method === 'POST') {
    const body = await jsonBody(req, Who);
    sendJson(res, 200, { branch: describeBranch(room.doc, await undoBranchMerge(app, room, branchId, body.by)), ...branchSummary(room) });
    return true;
  }
  if (action === 'discard' && method === 'POST') {
    const body = await jsonBody(req, Who);
    const out = await discardBranch(app, room, branchId, body.by);
    sendJson(res, 200, { discarded: describeBranch(room.doc, out.discarded), commit: out.commit, ...branchSummary(room) });
    return true;
  }
  if (action === 'restore' && method === 'POST') {
    const body = await jsonBody(req, Who);
    sendJson(res, 200, { branch: describeBranch(room.doc, restoreBranch(app, room, branchId, body.by)), ...branchSummary(room) });
    return true;
  }
  return false;
}
