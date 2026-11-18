import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { GenerationError, IMAGE_ASPECTS, MAX_IMAGES, MAX_PROMPT, unavailableText, type ImageJobs, type ImageGenerator, type StorePicture } from '../image-generate.ts';
import { HttpError } from '../util.ts';

const Start = z.object({
  prompt: z.string().trim().min(1).max(MAX_PROMPT),
  aspect: z.enum(IMAGE_ASPECTS).default('square'),
  count: z.number().int().min(1).max(MAX_IMAGES).default(1),
  fileId: z.string().regex(/^[a-z0-9]{10}$/).optional(),
});
const JobId = z.string().regex(/^[0-9a-f]{16}$/);

/**
 * `/api/images/generate`: whether pictures can be made (GET, `?fresh=1` asks again), a request for some (POST),
 * how one goes (GET .../<job>) and stopping it (DELETE .../<job>). Only the person here or on their paired phone:
 * it runs a program on this machine on their own plan.
 */
export async function handleImageGenerateRoute(
  deps: { generator: ImageGenerator; jobs: ImageJobs; store: StorePicture; fileExists: (id: string) => boolean },
  req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], owner: boolean,
  send: (res: ServerResponse, status: number, body: unknown) => void, json: (req: IncomingMessage) => Promise<unknown>,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (!owner) {
    req.resume();
    throw new HttpError(403, 'Only the person at this computer, or on their paired phone, can generate images.');
  }
  const id = parts[2];
  if (!id && method === 'GET') {
    const status = await deps.generator.status(url.searchParams.get('fresh') === '1');
    return send(res, 200, { ...status, ...(status.state === 'ready' ? {} : { message: unavailableText(status) }) });
  }
  if (!id && method === 'POST') {
    const parsed = Start.safeParse(await json(req));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const body = parsed.data;
    if (body.fileId && !deps.fileExists(body.fileId)) throw new HttpError(404, 'No such file.');
    const status = await deps.generator.status();
    if (status.state !== 'ready') throw new HttpError(409, unavailableText(status));
    try {
      return send(res, 202, { job: deps.jobs.start(body, deps.store) });
    } catch (e) {
      throw new HttpError(e instanceof GenerationError ? 429 : 500, (e as Error).message);
    }
  }
  if (id) {
    if (!JobId.safeParse(id).success) throw new HttpError(404, 'No such job.');
    const job = deps.jobs.get(id);
    if (!job) throw new HttpError(404, 'That request is gone: it ended over half an hour ago, or the server restarted.');
    if (method === 'GET') return send(res, 200, { job });
    if (method === 'DELETE') {
      deps.jobs.cancel(id);
      return send(res, 200, { job });
    }
  }
  req.resume();
  throw new HttpError(404, `No route for ${method} ${url.pathname}.`);
}
