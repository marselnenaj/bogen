import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { BogenEvent } from '../events.ts';
import { HttpError } from '../util.ts';

/**
 * One window per file, across programs: `bogen open`, the Omarchy launcher and the bar ask here first, and a Bogen
 * window on this machine takes the file when it can, instead of a new window opening.
 *
 * - `POST /api/open {hash, raise}` sends `open-request` to the windows on this machine and answers `{taken, focused,
 *   visible, title}`: `taken` false means nothing took it, and the caller opens a window as before. `raise`: the caller
 *   can bring a window to the front itself (Hyprland, a Mac), so a window in view may take a file it does not show;
 *   otherwise only the window that shows the file does, since a window behind others would take it unseen.
 * - `POST /api/open/<id>/claim {priority, lastFocus}`: a window offers to take it. 2: it shows the file; 1: it is in
 *   view. A window that shows the file wins at once; otherwise, after a moment, the one in view that had focus last.
 *   The answer `{ok}` says whether this window is the one.
 * - `POST /api/open/<id>/done {focused, visible, title}`: the window took it and says whether it could come to the
 *   front. A browser often cannot raise its own window; the caller may then raise it by its title (Hyprland), or open
 *   a window, which then says that the file is open in another window.
 *
 * Windows of one browser agree among themselves who shows a file (the editor's tabs/one-window.ts); this is for
 * programs outside the browser. Only from this machine, and only to its windows: never to a phone or another device.
 */

export interface OpenResult { taken: boolean; focused?: boolean; visible?: boolean; title?: string }

interface Claim { priority: number; lastFocus: number; answer: (ok: boolean) => void }
interface Pending {
  claims: Claim[];
  decided: boolean;
  timer: NodeJS.Timeout;
  finish: (r: OpenResult) => void;
}

export interface OpenBrokerOptions {
  /** How long windows have to offer, unless one that shows the file does. */
  claimMs?: number;
  /** How long the chosen window has to say it took the file. */
  doneMs?: number;
}

export class OpenBroker {
  private pending = new Map<string, Pending>();
  private readonly claimMs: number;
  private readonly doneMs: number;

  constructor(private readonly sendLocal: (event: BogenEvent) => number, options: OpenBrokerOptions = {}) {
    this.claimMs = options.claimMs ?? 450;
    this.doneMs = options.doneMs ?? 1500;
  }

  /** Asks the windows on this machine to take an address. */
  request(hash: string, raise = false): Promise<OpenResult> {
    const id = randomBytes(9).toString('base64url');
    return new Promise<OpenResult>((resolve) => {
      let over = false;
      const finish = (r: OpenResult) => {
        if (over) return;
        over = true;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        for (const c of entry.claims) c.answer(false);
        entry.claims = [];
        resolve(r);
      };
      const entry: Pending = { claims: [], decided: false, timer: setTimeout(() => this.decide(id), this.claimMs), finish };
      this.pending.set(id, entry);
      if (this.sendLocal({ t: 'open-request', id, hash, raise }) === 0) finish({ taken: false });
    });
  }

  /** A window offers to take it; resolves with whether it is the one. */
  claim(id: string, priority: number, lastFocus: number): Promise<boolean> {
    const entry = this.pending.get(id);
    if (!entry || entry.decided) return Promise.resolve(false);
    return new Promise<boolean>((answer) => {
      entry.claims.push({ priority, lastFocus, answer });
      if (priority >= 2) this.decide(id);
    });
  }

  /** The chosen window took it. */
  done(id: string, result: Omit<OpenResult, 'taken'>): boolean {
    const entry = this.pending.get(id);
    if (!entry || !entry.decided) return false;
    entry.finish({ taken: true, ...result });
    return true;
  }

  private decide(id: string): void {
    const entry = this.pending.get(id);
    if (!entry || entry.decided) return;
    clearTimeout(entry.timer);
    const best = [...entry.claims].sort((a, b) => b.priority - a.priority || b.lastFocus - a.lastFocus)[0];
    if (!best || best.priority < 1) return entry.finish({ taken: false });
    entry.decided = true;
    for (const c of entry.claims) c.answer(c === best);
    entry.claims = [];
    // The window may be gone before it says so: then nothing took it.
    entry.timer = setTimeout(() => entry.finish({ taken: false }), this.doneMs);
  }

  close(): void {
    for (const entry of [...this.pending.values()]) entry.finish({ taken: false });
  }
}

const OpenBody = z.object({ hash: z.string().max(600).regex(/^(#\/[^\s<>"`]*)?$/), raise: z.boolean().optional() });
const ClaimBody = z.object({ priority: z.number().int().min(0).max(2), lastFocus: z.number().min(0).max(Number.MAX_SAFE_INTEGER) });
const DoneBody = z.object({ focused: z.boolean(), visible: z.boolean(), title: z.string().max(300).optional() });

export interface OpenRouteTools {
  send: (res: ServerResponse, status: number, body: unknown) => void;
  json: <T>(req: IncomingMessage, schema: z.ZodType<T>) => Promise<T>;
  /** True for a direct request from this machine. */
  local: (req: IncomingMessage) => boolean;
}

/** `/api/open`, `/api/open/<id>/claim` and `/api/open/<id>/done`. Returns false for what is not its business. */
export async function openRoutes(req: IncomingMessage, res: ServerResponse, parts: string[], broker: OpenBroker, tools: OpenRouteTools): Promise<boolean> {
  const [a, b, c, d] = parts;
  if (a !== 'open' || req.method !== 'POST') return false;
  if (!tools.local(req)) throw new HttpError(403, 'Only from this machine.');
  if (!b) {
    const body = await tools.json(req, OpenBody);
    tools.send(res, 200, await broker.request(body.hash, body.raise === true));
    return true;
  }
  if (!/^[\w-]{1,40}$/.test(b) || d) return false;
  if (c === 'claim') {
    const body = await tools.json(req, ClaimBody);
    tools.send(res, 200, { ok: await broker.claim(b, body.priority, body.lastFocus) });
    return true;
  }
  if (c === 'done') {
    const body = await tools.json(req, DoneBody);
    tools.send(res, 200, { ok: broker.done(b, body) });
    return true;
  }
  return false;
}
