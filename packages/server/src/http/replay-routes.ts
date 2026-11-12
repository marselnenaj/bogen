import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { reportHeader } from '../exporter.ts';
import { exportReplay, keptReplay, planForClient, planReplay } from '../replay.ts';
import { errorMessage, HttpError } from '../util.ts';
import type { BogenServer } from './server.ts';
import { jsonBody } from './server.ts';

const Id = z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/);
const Bound = z.string().trim().min(1).max(64);

/** `page` is a page's id or name, for the command line. */
const RangeBody = z.object({ pageId: Id.optional(), page: z.string().trim().min(1).max(200).optional(), from: Bound.optional(), to: Bound.optional(), run: Bound.optional() });

/** The page a request names, by id or by name. */
async function pageFor(app: BogenServer, fileId: string, body: { pageId?: string; page?: string }): Promise<string | undefined> {
  if (body.pageId || !body.page) return body.pageId;
  const { doc } = await app.rooms.get(fileId);
  const pages = doc.getPages();
  const found = pages.find((p) => p.id === body.page) ?? pages.find((p) => p.name === body.page) ?? pages.find((p) => p.name.toLowerCase() === body.page!.toLowerCase());
  if (!found) throw new HttpError(404, `No page "${body.page}" in this file. It has ${pages.map((p) => `"${p.name}"`).join(', ')}.`);
  return found.id;
}

const PlanBody = RangeBody.extend({ scale: z.number().min(0.25).max(2).optional() });

export const ReplayExportBody = RangeBody.extend({
  format: z.enum(['mp4', 'webm', 'gif']).default('mp4'),
  speed: z.number().min(0.1).max(64).optional(),
  maxIdleMs: z.number().min(40).max(60_000).optional(),
  width: z.number().int().min(160).max(3840).optional(),
  height: z.number().int().min(160).max(3840).optional(),
  fps: z.number().int().min(1).max(60).optional(),
  captions: z.boolean().optional(),
  cursors: z.boolean().optional(),
  camera: z.enum(['fit', 'grow', 'follow', 'auto']).optional(),
  fromStep: z.number().int().min(0).optional(),
  toStep: z.number().int().min(0).optional(),
  encoder: z.enum(['ffmpeg', 'webcodecs']).optional(),
});

/**
 * Replays of how a page was built. `POST .../replay` rebuilds and renders it, with progress as NDJSON, and ends
 * with the plan the editor plays; `GET .../replay/:id/shot/:i` is one of its pictures; `POST .../replay/export`
 * films it. Anyone who may open the file may watch it, as with the History panel.
 */
export async function handleReplayRoute(app: BogenServer, req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<boolean> {
  const [a, fileId, c, d, e, f] = parts;
  if (a !== 'files' || c !== 'replay' || !fileId || !Id.safeParse(fileId).success) return false;
  const method = req.method ?? 'GET';

  if (!d && method === 'POST') {
    const body = await jsonBody(req, PlanBody);
    app.requireFile(fileId);
    body.pageId = await pageFor(app, fileId, body);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    const send = (event: object) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const kept = await planReplay(app, fileId, body, { scale: body.scale ?? 1, onProgress: (done, total) => send({ t: 'progress', done, total }) });
      send({ t: 'done', replay: planForClient(kept.plan) });
    } catch (err) {
      send({ t: 'error', error: errorMessage(err) });
    }
    res.end();
    return true;
  }

  if (d && e === 'shot' && f && method === 'GET') {
    const kept = keptReplay(app, fileId, d);
    if (!kept) throw new HttpError(404, 'This replay is no longer kept. Open it again.');
    const png = kept.pictures[Number(f.replace(/\.png$/, ''))];
    if (!png) throw new HttpError(404, 'No such picture.');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=900', 'X-Content-Type-Options': 'nosniff' });
    res.end(png);
    return true;
  }

  if (d === 'export' && !e && method === 'POST') {
    const body = await jsonBody(req, ReplayExportBody);
    const entry = app.requireFile(fileId);
    body.pageId = await pageFor(app, fileId, body);
    try {
      const film = await exportReplay(app, fileId, body);
      const name = `${entry.name} replay`.replace(/[^\w.-]+/g, '-');
      const report = reportHeader({ encoder: film.report.encoder, codec: film.report.codec, frames: film.report.frames, fps: film.report.fps, width: film.report.width, height: film.report.height, notes: [`${film.report.steps} steps in ${film.report.seconds} s, camera ${film.report.camera}.`, ...(film.report.notes ?? [])] });
      res.writeHead(200, { 'Content-Type': film.mime, 'Content-Disposition': `attachment; filename="${name}.${film.ext}"`, 'X-Content-Type-Options': 'nosniff', ...(report ? { 'X-Bogen-Export-Report': report } : {}) });
      res.end(film.bytes);
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(500, errorMessage(err));
    }
    return true;
  }

  if (d === 'export' || !d) throw new HttpError(405, 'Method not allowed.');
  return false;
}
