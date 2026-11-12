import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { driftDefaults, driftOfFile } from '../drift.ts';
import { restyleSite } from '../restyle.ts';
import { HttpError } from '../util.ts';
import type { BogenServer } from './server.ts';
import { jsonBody, sendJson } from './server.ts';

const Id = z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/);
const DriftBody = z.object({
  nodeId: Id, url: z.string().url().max(2000).optional(), width: z.number().int().min(200).max(4000).optional(),
  colorScheme: z.enum(['light', 'dark']).optional(), limit: z.number().int().min(1).max(500).optional(),
});

const RestyleBody = z.object({
  url: z.string().url().max(2000), brandId: Id.optional(), pageId: Id.optional(), width: z.number().int().min(200).max(4000).optional(),
  colorScheme: z.enum(['light', 'dark']).optional(), keepText: z.boolean().optional(), keepImages: z.boolean().optional(), name: z.string().min(1).max(200).optional(),
});

/** Who a restyle from the editor is, for its undo in the Agents tab. */
export const RESTYLE_ACTOR = 'restyle';

/**
 * Drift and restyle for the editor: `GET /api/files/:id/drift?node=` says what a check would use, `POST` runs it, and
 * `POST /api/files/:id/restyle` redraws a page in a brand. A page on this computer only for a request from this
 * computer, as with Capture. True when it answered.
 */
export async function handleDriftRoutes(app: BogenServer, req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], local: boolean): Promise<boolean> {
  const [a, b, c, d] = parts;
  if (a !== 'files' || !b || (c !== 'drift' && c !== 'restyle') || d) return false;
  app.requireFile(b);
  const method = req.method ?? 'GET';
  if (c === 'restyle') {
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const body = await jsonBody(req, RestyleBody);
    try {
      sendJson(res, 200, await restyleSite(app, { ...body, fileId: b, allowLocal: local, actor: RESTYLE_ACTOR }));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, (err as Error).message);
    }
    return true;
  }
  if (method === 'GET') {
    const node = url.searchParams.get('node');
    if (!node || !Id.safeParse(node).success) throw new HttpError(400, 'Say which layer, as ?node=.');
    const room = await app.rooms.get(b);
    if (!room.doc.getNode(node)) throw new HttpError(404, `No layer with id ${node}.`);
    sendJson(res, 200, driftDefaults(room.doc, node));
    return true;
  }
  if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const body = await jsonBody(req, DriftBody);
  const room = await app.rooms.get(b);
  if (!room.doc.getNode(body.nodeId)) throw new HttpError(404, `No layer with id ${body.nodeId}.`);
  try {
    const { report } = await driftOfFile(app, b, { ...body, allowLocal: local });
    sendJson(res, 200, report);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, (err as Error).message);
  }
  return true;
}
