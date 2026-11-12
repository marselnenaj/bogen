import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { isRunnerId, RUNNER_IDS, RUNNERS } from '@bogen/core';
import type { RunnerId, RunnerInfo } from './agents.ts';
import type { BogenServer } from './http/server.ts';
import { EFFORT_ID, MODEL_ID } from './run-settings.ts';
import { runImages } from './run-images.ts';
import { atomicWrite, errorMessage, HttpError } from './util.ts';

/**
 * Asking an agent on another device: the MacBook asks the PC, which has `claude` or `codex` installed and logged
 * in. The run is an ordinary run on the PC, in the PC's copy of the file, on the PC owner's plan; its changes come
 * back through device sync like any other edit, and what it says comes back here as the run's events.
 *
 * Two checks, one on each side. On the device that asks, only its owner in person may ask (`fromOwner`, as for
 * any run). On the device that runs, only a paired device its owner allowed here, at this machine, may start
 * anything: the peer token alone does not do it, since it also travels with sync. Comments that arrive from a
 * paired device still start nothing; a remote run is always an explicit request.
 */

const Id = z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/);
const RunnerSchema = z.enum(RUNNER_IDS);
export const RemoteRunBody = z.object({
  fileId: Id, pageId: Id.optional(), nodeIds: z.array(Id).max(200).default([]), prompt: z.string().min(1).max(20_000),
  runner: RunnerSchema, model: z.string().regex(MODEL_ID).optional(), effort: z.string().regex(EFFORT_ID).or(z.literal('default')).optional(),
  review: z.enum(['direct', 'proposal', 'directions', 'critique']).optional(), conversationId: Id.optional(),
  images: z.array(z.string().max(120)).max(4).optional(),
  /** The design content language for this request. An older device leaves it out; the file's own language syncs anyway. */
  language: z.object({ tag: z.string().trim().max(20).regex(/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,4}){0,2}$/).optional(), mode: z.enum(['write', 'translate', 'add']).optional() }).optional(),
});
export type RemoteRunRequest = z.output<typeof RemoteRunBody>;

export interface RemoteEvent { n: number; kind: 'text' | 'tool' | 'done' | 'error'; text?: string; tool?: string }
/** What a device offers to one that asks: whether it may, and which CLIs are there. */
export interface RemoteOffer { deviceId: string; device: string; allowed: boolean; runners: RunnerInfo[] }

const MAX_EVENTS = 600;
const KEEP_ENDED_MS = 30 * 60_000;
const POLL_MS = 600;
const GIVE_UP_MS = 90_000;
/** What other devices offer is asked again after this, or when a device connects, leaves or changes. */
const OFFER_CACHE_MS = 5000;

interface Served { peer: string; fileId: string; events: RemoteEvent[]; next: number; endedAt?: number }
interface Asked { runId: string; peerId: string; device: string; fileId: string; runner: RunnerId; title: string; startedAt: number; after: number; status: string; tool?: string; failingSince?: number; timer?: NodeJS.Timeout; endedAt?: number }

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'The body is not valid JSON.');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export class RemoteRuns {
  /** Paired devices this one runs agents for. Saved in `remote-runs.json`; only changed at this machine. */
  private allowed = new Set<string>();
  private served = new Map<string, Served>();
  private asked = new Map<string, Asked>();
  private offerCache: { at: number; list: Promise<RemoteOffer[]> } | null = null;
  private closed = false;

  constructor(private readonly app: BogenServer) {
    app.hub.tap((event) => {
      if (event.t === 'peers') this.offerCache = null;
      if (event.t !== 'agent') return;
      const served = this.served.get(event.runId);
      if (!served) return;
      served.events.push({ n: served.next++, kind: event.kind, ...(event.text ? { text: event.text.slice(0, 20_000) } : {}), ...(event.tool ? { tool: event.tool } : {}) });
      if (served.events.length > MAX_EVENTS) served.events.splice(0, served.events.length - MAX_EVENTS);
      if (event.kind === 'done' || event.kind === 'error') served.endedAt ??= Date.now();
    });
  }

  private get path(): string {
    return join(this.app.options.home, 'remote-runs.json');
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as { allow?: unknown };
      if (Array.isArray(parsed.allow)) for (const id of parsed.allow) if (typeof id === 'string') this.allowed.add(id);
    } catch {
      // Nobody allowed yet.
    }
  }

  /** Which paired devices may ask here, with their names. */
  allowList(): { deviceId: string; device: string; allowed: boolean; connected: boolean }[] {
    return this.app.peers.status().map((p) => ({ deviceId: p.id, device: p.name, allowed: this.allowed.has(p.id), connected: p.state === 'connected' }));
  }

  async setAllowed(deviceId: string, allow: boolean): Promise<void> {
    if (!this.app.peers.status().some((p) => p.id === deviceId)) throw new HttpError(404, 'No such paired device.');
    if (allow) this.allowed.add(deviceId);
    else this.allowed.delete(deviceId);
    await atomicWrite(this.path, JSON.stringify({ allow: [...this.allowed] }), 0o600);
    this.app.hub.broadcast({ t: 'peers' });
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, s] of this.served) if (s.endedAt && now - s.endedAt > KEEP_ENDED_MS) this.served.delete(id);
    for (const [id, a] of this.asked) if (a.endedAt && now - a.endedAt > KEEP_ENDED_MS) this.asked.delete(id);
  }

  // ---------------------------------------------------------------- the device that runs

  /** `/api/peer/runs/*`, from a paired device that proved its token. Whether it may ask is decided here. */
  async handlePeer(peer: { id: string; name: string }, req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
    const [a, b] = parts;
    const method = req.method ?? 'GET';
    const app = this.app;
    this.prune();
    if (a === 'offer' && !b && method === 'GET') {
      const allowed = this.allowed.has(peer.id);
      return send(res, 200, { deviceId: app.peers.deviceId, device: app.peers.deviceName, allowed, runners: allowed ? await app.runs.runners() : [] } satisfies RemoteOffer);
    }
    if (!this.allowed.has(peer.id)) throw new HttpError(403, `${app.peers.deviceName} does not let ${peer.name} ask its agents. Turn it on there, in the Agents tab under Other devices.`);
    if (!a && method === 'POST') {
      const parsed = RemoteRunBody.safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
      const body = parsed.data;
      const entry = app.storage.get(body.fileId);
      if (!entry) throw new HttpError(404, `This file has not reached ${app.peers.deviceName} yet. Wait for it to sync, then ask again.`);
      const { model: _model, effort: _effort, images: sources, ...rest } = body;
      const choice = await app.runSettings.resolve(body.runner, 'prompt', { ...(body.model ? { model: body.model } : {}), ...(body.effort ? { effort: body.effort } : {}) });
      let runId: string;
      try {
        const images = sources?.length ? await runImages(app.storage, sources) : [];
        runId = await app.runs.start({ ...rest, ...choice, fileName: entry.name, askedFrom: peer.name, ...(images.length ? { images } : {}) });
      } catch (e) {
        throw new HttpError(409, errorMessage(e));
      }
      // Events from before this line are its first, which the tap may already have missed: none can have come yet.
      this.served.set(runId, { peer: peer.id, fileId: body.fileId, events: [], next: 0 });
      return send(res, 201, { runId, device: app.peers.deviceName });
    }
    const served = b ? undefined : a ? this.served.get(a) : undefined;
    if (a && !served && !b) throw new HttpError(404, 'No such run asked from that device.');
    if (a && b) {
      const mine = this.served.get(a);
      if (!mine || mine.peer !== peer.id) throw new HttpError(404, 'No such run asked from that device.');
      if (b === 'stop' && method === 'POST') return send(res, 200, { stopped: app.runs.stop(a) });
      if (b === 'summary' && method === 'GET') {
        const record = await app.history.get(mine.fileId, a);
        if (!record) throw new HttpError(404, 'No such run.');
        return send(res, 200, { runId: a, status: record.status, ...(record.pageId ? { pageId: record.pageId } : {}), layers: record.named ?? [], ...(record.shots ? { shots: record.shots } : {}), ...(record.undone ? { undone: record.undone } : {}) });
      }
      if (b === 'shot' && method === 'GET') {
        const which = new URL(req.url ?? '/', 'http://x').searchParams.get('which') === 'before' ? 'before' : 'after';
        const bytes = await app.runSummaries.shot(mine.fileId, a, which);
        if (!bytes) throw new HttpError(404, 'No such picture.');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
        res.end(bytes);
        return;
      }
      if (b === 'undo' && method === 'POST') {
        const { who } = z.object({ who: z.string().trim().min(1).max(80).default('Someone') }).parse(await readJson(req));
        const { undoRun } = await import('./run-undo.ts');
        return send(res, 200, await undoRun(app, mine.fileId, a, `${who} on ${peer.name}`));
      }
      throw new HttpError(404, 'No such route.');
    }
    if (served && method === 'GET') {
      if (served.peer !== peer.id) throw new HttpError(404, 'No such run asked from that device.');
      const after = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('after') ?? 0) || 0;
      const active = app.runs.isActive(a!);
      const status = active ? 'running' : (await app.history.get(served.fileId, a!))?.status ?? 'done';
      return send(res, 200, { status, events: served.events.filter((e) => e.n >= after), next: served.next });
    }
    throw new HttpError(404, 'No such route.');
  }

  // ---------------------------------------------------------------- the device that asks

  /** What the connected paired devices offer this one. Only devices that allow it list runners. */
  offers(): Promise<RemoteOffer[]> {
    if (this.offerCache && Date.now() - this.offerCache.at < OFFER_CACHE_MS) return this.offerCache.list;
    const list = Promise.all(this.app.peers.status().filter((p) => p.state === 'connected').map(async (p): Promise<RemoteOffer | null> => {
      try {
        const raw = await this.app.peers.request(p.id, '/api/peer/runs/offer', { method: 'GET' }, 256 * 1024, 8000);
        const offer = JSON.parse(raw.toString('utf8')) as RemoteOffer;
        return { deviceId: p.id, device: p.name, allowed: Boolean(offer.allowed), runners: Array.isArray(offer.runners) ? offer.runners.filter((r) => r && isRunnerId(r.id) && !RUNNERS[r.id].blocked) : [] };
      } catch {
        // An older device, or one that cannot be reached: it offers nothing.
        return null;
      }
    })).then((all) => all.filter((o): o is RemoteOffer => o !== null));
    this.offerCache = { at: Date.now(), list };
    return list;
  }

  /** Asks a paired device to run an agent, and follows the run's events here as if it ran here. */
  async start(deviceId: string, body: RemoteRunRequest): Promise<{ runId: string; device: string }> {
    const device = this.app.peers.status().find((p) => p.id === deviceId);
    if (!device) throw new HttpError(404, 'No such paired device.');
    if (device.state !== 'connected') throw new HttpError(409, `${device.name} is not connected right now.`);
    let raw: Buffer;
    try {
      raw = await this.app.peers.request(deviceId, '/api/peer/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 64 * 1024, 30_000);
    } catch (e) {
      throw new HttpError(e instanceof HttpError && e.status < 500 ? 409 : 502, await this.why(deviceId, e));
    }
    const { runId } = JSON.parse(raw.toString('utf8')) as { runId: string };
    if (!/^[\w-]{1,64}$/.test(runId)) throw new HttpError(502, 'That answer did not come from a Bogen peer.');
    const asked: Asked = { runId, peerId: deviceId, device: device.name, fileId: body.fileId, runner: body.runner, title: body.prompt.replace(/\s+/g, ' ').trim().slice(0, 200), startedAt: Date.now(), after: 0, status: 'running' };
    this.asked.set(runId, asked);
    this.app.hub.broadcast({ t: 'run-queue' });
    this.poll(asked);
    return { runId, device: device.name };
  }

  /** Why a device did not start a run, in its own words when it gave them. */
  private async why(deviceId: string, e: unknown): Promise<string> {
    const name = this.app.peers.status().find((p) => p.id === deviceId)?.name ?? 'That device';
    const status = e instanceof HttpError ? e.status : 0;
    this.offerCache = null;
    if (status === 403) return `${name} does not let this device ask its agents. Turn it on there, in the Agents tab under Other devices.`;
    if (status === 404 || status === 409) return errorMessage(e);
    return `Could not ask ${name}: ${errorMessage(e)}`;
  }

  private poll(asked: Asked): void {
    if (this.closed) return;
    asked.timer = setTimeout(() => void this.pollOnce(asked), POLL_MS);
    asked.timer.unref();
  }

  private async pollOnce(asked: Asked): Promise<void> {
    if (this.closed) return;
    try {
      const raw = await this.app.peers.request(asked.peerId, `/api/peer/runs/${asked.runId}?after=${asked.after}`, { method: 'GET' }, 4 * 1024 * 1024, 15_000);
      const answer = JSON.parse(raw.toString('utf8')) as { status: string; events: RemoteEvent[]; next: number };
      delete asked.failingSince;
      for (const e of answer.events ?? []) {
        if (e.kind === 'tool' && e.tool) asked.tool = e.tool;
        this.app.hub.broadcast({ t: 'agent', runId: asked.runId, fileId: asked.fileId, kind: e.kind, ...(e.text ? { text: e.text } : {}), ...(e.tool ? { tool: e.tool } : {}) });
      }
      asked.after = Math.max(asked.after, Number(answer.next) || 0);
      asked.status = answer.status;
      if (answer.status !== 'running') {
        asked.endedAt = Date.now();
        this.app.hub.broadcast({ t: 'run-queue' });
        // What it changed is worked out there after it ends, with pictures: views here look again a few times.
        for (const ms of [1500, 4000, 10_000]) setTimeout(() => this.app.hub.broadcast({ t: 'run-history', fileId: asked.fileId }), ms).unref();
        return;
      }
    } catch (e) {
      asked.failingSince ??= Date.now();
      if (Date.now() - asked.failingSince > GIVE_UP_MS) {
        asked.status = 'failed';
        asked.endedAt = Date.now();
        this.app.hub.broadcast({ t: 'agent', runId: asked.runId, fileId: asked.fileId, kind: 'error', text: `Lost the link to ${asked.device}: ${errorMessage(e)}. The run may still be going there, and its changes arrive with sync.` });
        this.app.hub.broadcast({ t: 'run-queue' });
        return;
      }
    }
    this.poll(asked);
  }

  /** A run this device asked another for. */
  get(runId: string): Asked | undefined {
    return this.asked.get(runId);
  }

  /** Runs this device asked others for, still going, for the queue. */
  list(): Asked[] {
    return [...this.asked.values()].filter((a) => !a.endedAt);
  }

  async stop(runId: string): Promise<boolean> {
    const asked = this.asked.get(runId);
    if (!asked || asked.endedAt) return false;
    await this.app.peers.request(asked.peerId, `/api/peer/runs/${runId}/stop`, { method: 'POST' }, 4096, 15_000);
    return true;
  }

  /** The summary, a picture or an undo of a run asked from here, from the device it ran on. */
  async relay(runId: string, what: 'summary' | 'undo', who?: string): Promise<unknown> {
    const asked = this.asked.get(runId);
    if (!asked) throw new HttpError(404, 'No such run in this file.');
    const init: RequestInit = what === 'undo' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: who ?? 'Someone' }) } : { method: 'GET' };
    try {
      return JSON.parse((await this.app.peers.request(asked.peerId, `/api/peer/runs/${runId}/${what}`, init, 256 * 1024, 30_000)).toString('utf8'));
    } catch (e) {
      throw new HttpError(e instanceof HttpError && e.status === 409 ? 409 : 502, `${asked.device}: ${errorMessage(e)}`);
    }
  }

  async shot(runId: string, which: 'before' | 'after'): Promise<Buffer | null> {
    const asked = this.asked.get(runId);
    if (!asked) return null;
    return this.app.peers.request(asked.peerId, `/api/peer/runs/${runId}/shot?which=${which}`, { method: 'GET' }, 2 * 1024 * 1024, 15_000).catch(() => null);
  }

  close(): void {
    this.closed = true;
    for (const a of this.asked.values()) if (a.timer) clearTimeout(a.timer);
  }
}
