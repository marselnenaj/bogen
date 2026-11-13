import type { IncomingMessage, ServerResponse } from 'node:http';
import { CLIENTS, DEFAULT_TOOL_MODE, install, type Client } from '../install.ts';
import { LABELS, survey } from '../setup.ts';
import { HttpError } from '../util.ts';

export interface ClientRouteTools {
  send: (res: ServerResponse, status: number, body: unknown) => void;
  /** True for a direct request from this machine. */
  local: (req: IncomingMessage) => boolean;
}

/** One client in Settings, Add to agent: what `bogen setup` finds, and the tool list `bogen install` would write. */
export interface ClientRow { client: Client; label: string; found: boolean; connected: boolean | null; skill: boolean | null; tools: string }

/**
 * `/api/clients`: the MCP clients on this computer and whether Bogen is in them, read from their own files, and
 * `POST /api/clients/<client>/connect`, which does what `bogen install <client>` does. Both are for this machine only
 * (`isLocalOnlyPath`, and checked again here): connecting writes another program's settings and may run its CLI.
 * Returns false for what is not its business.
 */
export async function clientRoutes(req: IncomingMessage, res: ServerResponse, parts: string[], tools: ClientRouteTools, connect: (clients: Client[]) => ReturnType<typeof install> = install): Promise<boolean> {
  const [a, b, c, d] = parts;
  if (a !== 'clients') return false;
  const method = req.method ?? 'GET';
  if (!tools.local(req)) throw new HttpError(403, 'Only from this machine.');
  if (!b && method === 'GET') {
    const rows: ClientRow[] = (await survey()).map((s) => ({ ...s, label: LABELS[s.client], tools: DEFAULT_TOOL_MODE[s.client] }));
    tools.send(res, 200, { clients: rows });
    return true;
  }
  if (b && c === 'connect' && !d && method === 'POST') {
    if (!(CLIENTS as readonly string[]).includes(b)) throw new HttpError(404, `Bogen does not know the client ${b.slice(0, 40)}.`);
    const [result] = await connect([b as Client]);
    if (!result?.ok) throw new HttpError(500, result?.how ?? 'Could not connect it.');
    const row = (await survey()).find((s) => s.client === b)!;
    tools.send(res, 200, { client: { ...row, label: LABELS[row.client], tools: DEFAULT_TOOL_MODE[row.client] }, how: result.how });
    return true;
  }
  return false;
}
