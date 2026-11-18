import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { HttpError } from '../util.ts';
import { ROLES, type Role } from './log.ts';
import { TeamService } from './service.ts';

/**
 * `/api/teams/*`, for the editor on this machine only: the caller checks `fromThisDevice` before this runs. Nothing
 * here is reachable from the tailnet, the phone or a token proxy.
 */

const RoleArg = z.enum(ROLES as [Role, ...Role[]]);
const Name = z.string().trim().min(1).max(100);
const Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Transport = z.object({
  lan: z.object({ on: z.boolean(), address: z.string().max(64) }),
  tailscale: z.object({ on: z.boolean() }),
  vpn: z.object({ on: z.boolean(), address: z.string().max(64) }),
  port: z.number().int(),
  listenEverywhere: z.boolean().optional(),
});

type Json = <S extends z.ZodType>(req: IncomingMessage, schema: S) => Promise<z.output<S>>;
type Send = (res: ServerResponse, status: number, body: unknown) => void;

export async function teamRoutes(teams: TeamService, req: IncomingMessage, res: ServerResponse, parts: string[], json: Json, send: Send, pairedDevices: () => Promise<number>): Promise<void> {
  const method = req.method ?? 'GET';
  const [, b, c, d, e] = parts;
  if (!b && method === 'GET') return send(res, 200, { ...teams.view(), lanAddresses: TeamService.lanAddresses() });
  if (!b && method === 'POST') {
    const body = await json(req, z.object({ name: Name, yourName: Name }));
    return send(res, 200, await teams.create(body.name, body.yourName));
  }
  if (b === 'join' && !c && method === 'POST') {
    const body = await json(req, z.object({ link: z.string().max(8000), yourName: Name }));
    return send(res, 200, await teams.join(body.link, body.yourName));
  }
  // The recovery phrase again, on this device, until it is confirmed (a failed join must not lose it).
  if (b === 'phrase' && !c && method === 'GET') return send(res, 200, { words: teams.pendingPhrase() });
  if (b === 'phrase' && !c && method === 'POST') {
    const body = await json(req, z.object({ words: z.record(z.string().regex(/^(?:[0-9]|1[01])$/), z.string().max(20)) }));
    await teams.confirmPhrase(body.words);
    return send(res, 200, { ok: true });
  }
  if (b === 'connections' && !c && method === 'PUT') {
    await teams.setTransports(await json(req, Transport));
    return send(res, 200, teams.view());
  }
  if (b === 'devices' && !c && method === 'POST') {
    return send(res, 200, { added: await pairedDevices() });
  }
  if (!b || !/^[a-z2-7]{16}$/.test(b)) throw new HttpError(404, 'No such route.');
  if (c === 'invites' && !d && method === 'POST') {
    const body = await json(req, z.object({ role: RoleArg, days: z.number().int().min(1).max(30).default(7), uses: z.number().int().min(1).max(100).default(1) }));
    return send(res, 200, await teams.invite(b, body.role, body.days, body.uses));
  }
  if (c === 'invites' && d && !e && method === 'DELETE') {
    await teams.revokeInvite(b, d);
    return send(res, 200, { ok: true });
  }
  if (c === 'files' && !d && method === 'POST') {
    const body = await json(req, z.object({ file: z.string().regex(/^[a-z0-9]{10}$/) }));
    await teams.addFile(b, body.file);
    return send(res, 200, { ok: true });
  }
  if (c === 'members' && d && Key.safeParse(d).success) {
    if (e === 'remove' && method === 'POST') {
      const body = await json(req, z.object({ now: z.boolean().default(false) }));
      await teams.remove(b, d, body.now);
      return send(res, 200, { ok: true });
    }
    if (e === 'role' && method === 'POST') {
      const body = await json(req, z.object({ role: RoleArg }));
      await teams.setRole(b, d, body.role);
      return send(res, 200, { ok: true });
    }
    if (e === 'safety' && method === 'GET') return send(res, 200, { words: teams.safety(b, d) });
  }
  throw new HttpError(404, 'No such route.');
}
