import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { PROFILE_IDS, type ProfileId } from '../compliance/criteria.ts';
import { exportReport } from '../compliance/report.ts';
import { complianceCheck } from '../compliance/run.ts';
import { statementDraft } from '../compliance/statement.ts';
import { HttpError } from '../util.ts';
import type { BogenServer } from './server.ts';
import { jsonBody, sendJson } from './server.ts';

const Id = z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/);
const Fields = z.object({ organisation: z.string().max(200).optional(), website: z.string().max(300).optional(), contact: z.string().max(300).optional(), law: z.enum(['wzg', 'bafg', 'none']).optional() });
const Body = z.object({
  pageId: Id, nodeId: Id.optional(), profile: z.enum(PROFILE_IDS as [ProfileId, ...ProfileId[]]), legal: z.boolean().optional(),
  format: z.enum(['html', 'pdf']).optional(), language: z.enum(['de', 'en']).optional(), fields: Fields.optional(), statement: z.boolean().optional(),
});

/**
 * The editor's Accessibility and legal check: `POST /api/files/:id/compliance/run` checks a page and returns the whole
 * report, `.../statement` drafts the accessibility statement, `.../export` sends the report as HTML or PDF. A person's
 * marks are written by the editor into the file itself, so they sync and undo like any edit. True when it answered.
 */
export async function handleComplianceRoutes(app: BogenServer, req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<boolean> {
  const [a, b, c, d, e] = parts;
  if (a !== 'files' || !b || c !== 'compliance' || !d || e) return false;
  if ((req.method ?? 'GET') !== 'POST') throw new HttpError(405, 'Method not allowed.');
  if (!['run', 'statement', 'export'].includes(d)) throw new HttpError(404, `No route for compliance/${d}.`);
  app.requireFile(b);
  const body = await jsonBody(req, Body);
  const room = await app.rooms.get(b);
  if (!room.doc.getPages().some((p) => p.id === body.pageId)) throw new HttpError(404, 'No such page.');
  if (body.nodeId && room.doc.pageOf(body.nodeId) !== body.pageId) throw new HttpError(404, 'No such artboard on that page.');
  let report;
  try {
    report = await complianceCheck(room.doc, app.renderer, { pageId: body.pageId, ...(body.nodeId ? { nodeId: body.nodeId } : {}) }, body.profile, { legal: body.legal ?? false });
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  if (d === 'run') return (sendJson(res, 200, report), true);
  const statement = body.statement || d === 'statement' ? statementDraft(report, body.language ?? 'de', body.fields ?? {}) : undefined;
  if (d === 'statement') return (sendJson(res, 200, statement), true);
  const out = await exportReport(report, app.renderer, app.storage, body.format ?? 'html', statement);
  const name = `Accessibility check ${report.scope.page}`.replace(/[^\p{L}\p{N} ._-]+/gu, ' ').trim().slice(0, 80) || 'Accessibility check';
  res.writeHead(200, { 'Content-Type': out.mime, 'Content-Disposition': `attachment; filename="${name}.${out.ext}"; filename*=UTF-8''${encodeURIComponent(`${name}.${out.ext}`)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(out.bytes);
  return true;
}
