import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { CRITIQUE_MISSING, MAX_ROUNDS, MAX_SCREENS, REVIEWERS } from '../design-critique.ts';
import type { CritiqueJobs } from '../critique-run.ts';
import type { Room } from '../sync.ts';
import { HttpError } from '../util.ts';

const Start = z.object({
  fileId: z.string().regex(/^[a-z0-9]{10}$/),
  screens: z.array(z.string().max(600)).max(MAX_SCREENS).optional(),
  pageId: z.string().max(64).optional(),
  flow: z.boolean().optional(),
  reviewer: z.enum(REVIEWERS).default('auto'),
  until: z.number().min(0).max(10).optional(),
  maxRounds: z.number().int().min(1).max(MAX_ROUNDS).default(1),
  series: z.string().regex(/^[0-9a-f]{12}$/).optional(),
  purpose: z.string().max(600).optional(),
  /** The language the person reads Bogen in; the reviewer writes its findings in it. */
  replyLanguage: z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/).optional(),
});
const JobId = z.string().regex(/^[0-9a-f]{16}$/);
const FileId = z.string().regex(/^[a-z0-9]{10}$/);
const NodeId = z.string().regex(/^[\w-]{1,64}$/);

function sendImage(res: ServerResponse, picture: { mime: string; data: Buffer }, cache: string): void {
  res.writeHead(200, { 'Content-Type': picture.mime, 'Content-Length': picture.data.length, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  res.end(picture.data);
}

/**
 * `/api/critique`: whether a reviewer can run (GET), a review (POST), how it goes (GET .../<job>) and stopping it
 * (DELETE .../<job>). Only the person here or on their paired phone: it runs a model session on their plan.
 * The result itself is kept on the file, where the editor reads it. `.../<job>/screens/<n>` is the picture of a screen
 * the reviewer got, and `.../shot/<file>/<layer>` a small picture of an artboard for a review whose job is gone.
 */
export async function handleCritiqueRoute(
  deps: { jobs: CritiqueJobs; room: (fileId: string) => Promise<Room>; fileExists: (id: string) => boolean },
  req: IncomingMessage, res: ServerResponse, parts: string[], owner: boolean,
  send: (res: ServerResponse, status: number, body: unknown) => void, json: (req: IncomingMessage) => Promise<unknown>,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (!owner) {
    req.resume();
    throw new HttpError(403, 'Only the person at this computer, or on their paired phone, can start a review.');
  }
  const id = parts[1];
  if (id === 'shot' && method === 'GET') {
    const fileId = FileId.safeParse(parts[2]);
    const nodeId = NodeId.safeParse(parts[3]);
    if (!fileId.success || !nodeId.success || parts.length > 4 || !deps.fileExists(fileId.data)) throw new HttpError(404, 'No such layer.');
    const picture = await deps.jobs.shot(await deps.room(fileId.data), nodeId.data).catch((e: Error) => { throw new HttpError(404, e.message); });
    return sendImage(res, picture, 'private, max-age=60');
  }
  if (!id && method === 'GET') {
    const status = await deps.jobs.status();
    return send(res, 200, { ...status, ...(status.state === 'ready' ? {} : { message: CRITIQUE_MISSING }) });
  }
  if (!id && method === 'POST') {
    const parsed = Start.safeParse(await json(req));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const body = parsed.data;
    if (!deps.fileExists(body.fileId)) throw new HttpError(404, 'No such file.');
    try {
      const job = await deps.jobs.start(await deps.room(body.fileId), {
        ...(body.screens ? { screens: body.screens } : {}), ...(body.pageId ? { pageId: body.pageId } : {}),
        ...(body.flow !== undefined ? { flow: body.flow } : {}), reviewer: body.reviewer,
        ...(body.until !== undefined ? { until: body.until } : {}), maxRounds: body.maxRounds,
        ...(body.series ? { series: body.series } : {}), ...(body.purpose ? { purpose: body.purpose } : {}),
        ...(body.replyLanguage ? { replyLanguage: body.replyLanguage } : {}),
      });
      return send(res, 202, { job });
    } catch (e) {
      const message = (e as Error).message;
      throw new HttpError(message === CRITIQUE_MISSING ? 409 : /running already/.test(message) ? 429 : 400, message);
    }
  }
  if (id) {
    if (!JobId.safeParse(id).success) throw new HttpError(404, 'No such review.');
    const job = deps.jobs.get(id);
    if (!job) throw new HttpError(404, 'That review is gone: it ended over half an hour ago, or the server restarted. Its result is kept on the file.');
    if (parts[2] === 'screens' && method === 'GET') {
      const n = Number(parts[3]);
      const picture = Number.isInteger(n) && n >= 1 && parts.length === 4 ? deps.jobs.picture(id, n) : undefined;
      if (!picture) throw new HttpError(404, 'That picture is not rendered yet.');
      return sendImage(res, picture, 'private, max-age=1800, immutable');
    }
    if (parts.length > 2) throw new HttpError(404, `No route for ${method} /api/critique.`);
    if (method === 'GET') return send(res, 200, { job });
    if (method === 'DELETE') {
      deps.jobs.cancel(id);
      return send(res, 200, { job });
    }
  }
  req.resume();
  throw new HttpError(404, `No route for ${method} /api/critique.`);
}
