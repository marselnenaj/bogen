import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { AgentCallSettings, type IncomingCalls } from '../incoming-calls.ts';
import { HttpError } from '../util.ts';

const Respond = z.object({ action: z.enum(['answer', 'decline', 'text']) });
const Id = z.string().regex(/^[0-9a-z]{1,40}$/);

function valid<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

/**
 * `/api/call/incoming`: what rings now and the person's settings (GET), the settings (PUT .../settings), and an
 * answer to a ring (POST .../<id>). Only the person here or on their paired phone: a team member or a review link
 * never sees or changes who may ring them.
 */
export async function handleIncomingRoute(calls: IncomingCalls, req: IncomingMessage, res: ServerResponse, parts: string[], owner: boolean, send: (res: ServerResponse, status: number, body: unknown) => void, json: (req: IncomingMessage) => Promise<unknown>): Promise<void> {
  const method = req.method ?? 'GET';
  if (!owner) {
    req.resume();
    throw new HttpError(403, 'Only the person at this computer, or on their paired phone, can see and answer calls from agents.');
  }
  const [, , rest] = parts;
  if (!rest && method === 'GET') return send(res, 200, calls.current);
  if (rest === 'settings' && method === 'PUT') {
    const patch = valid(AgentCallSettings.partial(), await json(req));
    try {
      return send(res, 200, { settings: await calls.setSettings(patch) });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  if (rest && method === 'POST') {
    const id = valid(Id, rest);
    const { action } = valid(Respond, await json(req));
    const call = calls.respond(id, action);
    if (!call) throw new HttpError(409, 'That call is no longer ringing.');
    return send(res, 200, { call });
  }
  req.resume();
  throw new HttpError(404, `No route for ${method} /api/call/incoming${rest ? `/${rest}` : ''}.`);
}
