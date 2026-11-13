import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { isRunnerId, RUNNER_IDS, MAX_PARALLEL_RUNS } from '@bogen/core';
import { paletteTokens, type OmarchyTheme } from '../omarchy.ts';
import { EFFORT_ID, MODEL_ID, CLI_DEFAULT } from '../run-settings.ts';
import { omarchyThemeRoutes } from './omarchy-routes.ts';
import { HttpError } from '../util.ts';
import type { BogenServer } from './server.ts';

const Id = z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/);
const Model = z.string().regex(MODEL_ID).max(120);
const Effort = z.string().regex(EFFORT_ID);
const Runner = z.enum(RUNNER_IDS);
const SettingsBody = z.object({
  runner: Runner.optional(), scope: z.enum(['prompt', 'comment']).optional(),
  model: z.union([z.literal(CLI_DEFAULT), Model]).nullable().optional(),
  effort: z.union([z.literal(CLI_DEFAULT), Effort]).nullable().optional(),
  shareCursors: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_PARALLEL_RUNS).optional(),
});
const StepUndoBody = z.object({ fileId: Id, stepId: Id });
const LiveOpen = z.object({ url: z.string().min(1).max(2000), dir: z.string().min(1).max(4000) });
const LiveRun = z.object({
  prompt: z.string().trim().min(1).max(20_000), runner: Runner,
  model: Model.optional(), effort: Effort.optional(),
  element: z.object({
    selector: z.string().max(4000), tag: z.string().max(100).optional(), text: z.string().max(2000).optional(), html: z.string().max(20_000),
    styles: z.record(z.string().max(100), z.string().max(2000)), url: z.string().max(4000).optional(),
    source: z.object({ file: z.string().max(2000).optional(), line: z.number().optional(), column: z.number().optional(), via: z.string().max(40).optional() }).nullable().optional(),
  }).optional(),
});

export interface RouteTools {
  json: <S extends z.ZodType>(req: IncomingMessage, schema: S) => Promise<z.output<S>>;
  send: (res: ServerResponse, status: number, body: unknown) => void;
  /** True for a direct request from this machine. */
  local: (req: IncomingMessage) => boolean;
  /** True for the owner in person, here or on a paired phone. See `fromOwner`. */
  owner: (req: IncomingMessage) => boolean;
}

/**
 * What the agent loop adds to the API. Everything here is on the local-only list of `isLocalOnlyPath`, or reads
 * nothing but notes about a file. Returns false for what is not its business.
 */
export async function agentRoutes(app: BogenServer, req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], tools: RouteTools): Promise<boolean> {
  const [a, b, c, d] = parts;
  const method = req.method ?? 'GET';
  const { json, send, local, owner } = tools;

  // One runner's catalog, asked when someone picks it. The first call probes that CLI; nothing else starts.
  if (a === 'run-settings' && b === 'catalog' && c && !d && method === 'GET') {
    if (!isRunnerId(c)) throw new HttpError(404, 'Bogen does not know that agent.');
    send(res, 200, await app.runSettings.catalog(c));
    return true;
  }

  if (a === 'run-settings' && !b) {
    if (method === 'GET') {
      // Claude's and Codex's catalogs, and only those of the other runners someone already asked for.
      send(res, 200, { settings: app.runSettings.get(), catalogs: await app.runSettings.snapshot({ probe: url.searchParams.get('catalogs') !== 'loaded' }) });
      return true;
    }
    if (method === 'PATCH') {
      if (!owner(req)) throw new HttpError(403, 'Only from this machine, or a phone paired with it.');
      send(res, 200, await app.runSettings.update(await json(req, SettingsBody)));
      return true;
    }
  }

  if (a === 'runs' && method === 'GET') {
    if (b === 'recent' && !c) {
      const limit = Math.min(50, Number(url.searchParams.get('limit')) || 8);
      const files = app.storage.list().slice(0, 50);
      const records = await app.history.recent(files.map((f) => f.id), limit);
      send(res, 200, records.map((r) => ({ ...trimRecord(r), fileName: app.storage.get(r.fileId)?.name ?? '' })));
      return true;
    }
    if (!b) {
      const key = url.searchParams.get('fileId') ?? '';
      if (!/^[\w-]{1,80}$/.test(key)) throw new HttpError(400, 'Say which file.');
      send(res, 200, await app.history.list(key));
      return true;
    }
    // Paired devices that let this one ask their agents, with the CLIs they have.
    if (b === 'remote' && !c) {
      if (!owner(req)) throw new HttpError(403, 'Only from this machine, or a phone paired with it.');
      send(res, 200, (await app.remoteRuns.offers()).filter((o) => o.allowed));
      return true;
    }
    if (b === 'remote' && c === 'allow' && !d) {
      if (!local(req)) throw new HttpError(403, 'Only at this machine: it decides who may use its agents.');
      send(res, 200, app.remoteRuns.allowList());
      return true;
    }
    // What runs and what waits, over all files, for the queue in the Agents tab.
    if (b === 'queue' && !c) {
      send(res, 200, await runQueue(app));
      return true;
    }
    // The chats of a file, for the chat panel's list of earlier chats.
    if (b === 'conversations' && !c) {
      const key = url.searchParams.get('fileId') ?? '';
      if (!/^[\w-]{1,80}$/.test(key)) throw new HttpError(400, 'Say which file.');
      send(res, 200, await app.conversations.list(key));
      return true;
    }
    // The turns of one chat, for the chat panel or a phone that opens again after a reload.
    if (b === 'conversations' && c && !d) {
      const key = url.searchParams.get('fileId') ?? '';
      if (!/^[\w-]{1,80}$/.test(key) || !Id.safeParse(c).success) throw new HttpError(400, 'Say which file and which conversation.');
      const conversation = await app.conversations.get(key, c);
      send(res, 200, { id: c, turns: conversation?.turns ?? [] });
      return true;
    }
  }

  if (a === 'runs' && b === 'remote' && c === 'allow' && !d && method === 'POST') {
    if (!local(req)) throw new HttpError(403, 'Only at this machine: it decides who may use its agents.');
    const { deviceId, allow } = await json(req, z.object({ deviceId: Id, allow: z.boolean() }));
    await app.remoteRuns.setAllowed(deviceId, allow);
    send(res, 200, app.remoteRuns.allowList());
    return true;
  }

  if (a === 'runs' && b === 'queue' && (c === 'move' || c === 'cancel') && !d && method === 'POST') {
    if (!owner(req)) throw new HttpError(403, 'Only from this machine, or a phone paired with it.');
    if (c === 'move') {
      const { id, to } = await json(req, z.object({ id: Id, to: z.number().int().min(0).max(1000) }));
      if (!app.commentRuns.move(id, to)) throw new HttpError(404, 'That comment is no longer waiting.');
      send(res, 200, await runQueue(app));
      return true;
    }
    const { id, who } = await json(req, z.object({ id: z.string().regex(/^[\w-]{1,64}(\.[\w-]{1,8})?$/), who: z.string().trim().min(1).max(80).default('Someone') }));
    const [raceId, laneId] = id.split('.');
    const done = laneId ? app.races.stop(raceId!, laneId).length > 0 : await app.commentRuns.cancel(id, who);
    if (!done) throw new HttpError(404, 'That is no longer waiting.');
    app.hub.broadcast({ t: 'run-queue' });
    send(res, 200, await runQueue(app));
    return true;
  }

  // What a run changed, for its reply in the bar, a thread or the phone.
  if (a === 'runs' && b && (c === 'summary' || c === 'shot') && !d && method === 'GET') {
    const fileId = url.searchParams.get('fileId') ?? '';
    if (!/^[\w-]{1,80}$/.test(fileId) || !Id.safeParse(b).success) throw new HttpError(400, 'Say which file and which run.');
    const record = await app.history.get(fileId, b);
    // A run asked of another device: what it changed is there.
    if (!record && app.remoteRuns.get(b)) {
      if (c === 'summary') {
        send(res, 200, { ...(await app.remoteRuns.relay(b, 'summary')) as object, device: app.remoteRuns.get(b)!.device });
        return true;
      }
      const bytes = await app.remoteRuns.shot(b, url.searchParams.get('which') === 'before' ? 'before' : 'after');
      if (!bytes) throw new HttpError(404, 'There is no such picture.');
      res.writeHead(200, { 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' });
      res.end(bytes);
      return true;
    }
    if (!record) throw new HttpError(404, 'No such run in this file.');
    if (c === 'summary') {
      send(res, 200, { runId: record.id, status: record.status, ...(record.pageId ? { pageId: record.pageId } : {}), layers: record.named ?? [], ...(record.shots ? { shots: record.shots } : {}), ...(record.undone ? { undone: record.undone } : {}) });
      return true;
    }
    const which = url.searchParams.get('which') === 'before' ? 'before' : 'after';
    const bytes = record.shots?.[which] ? await app.runSummaries.shot(fileId, b, which) : null;
    if (!bytes) throw new HttpError(404, which === 'before' ? 'There is no picture from before this run.' : 'There is no picture of what this run left.');
    res.writeHead(200, { 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.end(bytes);
    return true;
  }

  if (a === 'runs' && b && c === 'undo' && !d && method === 'POST') {
    if (!owner(req)) throw new HttpError(403, 'Only from this machine, or a phone paired with it.');
    const { fileId, who } = await json(req, z.object({ fileId: z.string().regex(/^[\w-]{1,80}$/), who: z.string().trim().min(1).max(80).default('Someone') }));
    app.requireFile(fileId);
    if (!(await app.history.get(fileId, b)) && app.remoteRuns.get(b)) {
      send(res, 200, await app.remoteRuns.relay(b, 'undo', who));
      return true;
    }
    const { undoRun } = await import('../run-undo.ts');
    send(res, 200, await undoRun(app, fileId, b, who));
    return true;
  }

  if (a === 'runs' && b && c === 'rerun' && method === 'POST') {
    if (!owner(req)) throw new HttpError(403, 'Agents only start for a person on the device that runs them, or on a phone paired with it.');
    const { fileId } = await json(req, z.object({ fileId: z.string().regex(/^[\w-]{1,80}$/) }));
    const record = await app.history.get(fileId, b);
    if (!record) throw new HttpError(404, 'No such run.');
    if (record.source === 'live') throw new HttpError(400, 'Ask again from the live site. A run on a project starts from there.');
    const entry = app.requireFile(fileId);
    if (record.rebuildOf) {
      const { rebuildRun } = await import('../rebuild.ts');
      send(res, 201, await rebuildRun(app, { fileId, nodeId: record.rebuildOf, runner: record.runner, ...(record.model ? { model: record.model } : {}), ...(record.effort ? { effort: record.effort } : {}) }));
      return true;
    }
    try {
      const runId = await app.runs.start({
        fileId, fileName: entry.name, prompt: record.prompt, ...(record.title ? { title: record.title } : {}), runner: record.runner, nodeIds: record.nodeIds,
        ...(record.pageId ? { pageId: record.pageId } : {}), ...(record.model ? { model: record.model } : {}), ...(record.effort ? { effort: record.effort } : {}),
        // A lane of a race runs again on its own, in a proposal: the race and its copies are over.
        ...(record.threadId ? { threadId: record.threadId } : {}), ...(record.race ? { review: 'proposal' as const } : record.review ? { review: record.review } : {}),
        // Asked again in its chat, it is the next turn there and knows the ones before.
        ...(record.conversationId ? { conversationId: record.conversationId } : {}),
        // The language the person chose for it; a file's or brand's default is read again, as it may have changed.
        ...(record.language?.source === 'run' ? { language: { tag: record.language.tag, mode: record.language.mode } } : record.language && record.language.mode !== 'write' ? { language: { mode: record.language.mode } } : {}),
      });
      send(res, 201, { runId });
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    return true;
  }

  // The real smoke test of both CLIs, in a throwaway server. It spends the person's plan, so only they start it.
  if (a === 'agents' && b === 'check') {
    if (!owner(req)) throw new HttpError(403, 'Only from this machine, or a phone paired with it.');
    if (!c && method === 'GET') {
      send(res, 200, app.agentsCheck ?? null);
      return true;
    }
    if (c && !d && method === 'GET') {
      if (app.agentsCheck?.id !== c) throw new HttpError(404, 'That check is gone. Only the last one is kept, until the server stops.');
      send(res, 200, app.agentsCheck);
      return true;
    }
    if (!c && method === 'POST') {
      const body = await json(req, z.object({ runners: z.array(Runner).min(1).max(RUNNER_IDS.length).optional(), model: Model.optional() }));
      if (app.agentsCheck?.status === 'running') throw new HttpError(409, 'A check is already running. It takes a few minutes.');
      const { runAgentsCheck } = await import('../agents-check.ts');
      const first = await new Promise<NonNullable<BogenServer['agentsCheck']>>((resolve) => {
        let told = false;
        void runAgentsCheck({
          ...(body.runners ? { runners: body.runners } : {}), ...(body.model ? { model: body.model } : {}),
          choose: (runner) => app.runSettings.resolve(runner, 'comment', {}),
          progress: (check) => {
            app.agentsCheck = check;
            app.hub.broadcast({ t: 'agents-check', id: check.id, status: check.status });
            if (!told) {
              told = true;
              resolve(check);
            }
          },
        });
      });
      send(res, 202, first);
      return true;
    }
  }

  if (a === 'agents' && b === 'steps') {
    if (!c && method === 'GET') {
      const fileId = url.searchParams.get('fileId') ?? '';
      app.requireFile(fileId);
      send(res, 200, app.steps.list(fileId));
      return true;
    }
    if (c === 'undo' && method === 'POST') {
      const { fileId, stepId } = await json(req, StepUndoBody);
      app.requireFile(fileId);
      const room = await app.rooms.get(fileId);
      send(res, 200, { undone: app.steps.undo(room, stepId) });
      return true;
    }
    if (c && d === 'preview' && method === 'GET') {
      const fileId = url.searchParams.get('fileId') ?? '';
      const which = url.searchParams.get('which') === 'before' ? 'before' : 'after';
      app.requireFile(fileId);
      const room = await app.rooms.get(fileId);
      const step = app.steps.get(fileId, c);
      if (!step) throw new HttpError(404, 'That step is gone, since the file was closed.');
      const shot = await app.steps.preview(room, step, which, app.renderer);
      if (!shot) throw new HttpError(404, which === 'before' ? 'This layer did not exist before this step.' : 'This step left nothing to show.');
      res.writeHead(200, { 'Content-Type': shot.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      res.end(shot.bytes);
      return true;
    }
  }

  if (a === 'files' && b && c === 'away') {
    if (method === 'GET') {
      app.requireFile(b);
      send(res, 200, { away: app.away.take(b) });
      return true;
    }
  }

  if (a === 'files' && b && c === 'conflicts') {
    app.requireFile(b);
    if (method === 'GET') {
      send(res, 200, app.peers.conflicts.list(b));
      return true;
    }
    if (method === 'DELETE') {
      app.peers.conflicts.dismiss(b, d);
      send(res, 200, { ok: true });
      return true;
    }
    if (method === 'POST' && d && parts[4] === 'branch' && !parts[5]) {
      const { branchFromConflict } = await import('../history-ops.ts');
      send(res, 201, await branchFromConflict(app, b, d));
      return true;
    }
  }

  if (a === 'notifications' && method === 'GET') {
    send(res, 200, app.notifications.after(Number(url.searchParams.get('since')) || 0));
    return true;
  }

  if (a === 'omarchy' && b !== 'palette') return omarchyThemeRoutes(app, req, res, parts, tools);

  if (a === 'omarchy' && b === 'palette') {
    const theme = (await app.omarchyTheme()) as OmarchyTheme | null;
    const tokens = theme && (theme as { palette?: unknown }).palette ? paletteTokens(theme) : [];
    if (method === 'GET') {
      send(res, 200, { name: theme?.name ?? null, tokens });
      return true;
    }
    if (method === 'POST') {
      const { fileId } = await json(req, z.object({ fileId: Id }));
      app.requireFile(fileId);
      if (!tokens.length) throw new HttpError(409, 'There is no Omarchy theme here to import.');
      const room = await app.rooms.get(fileId);
      room.doc.transact(() => {
        for (const t of tokens) room.doc.setToken(t.name, t.kind, t.value);
      }, 'person:Omarchy palette');
      send(res, 200, { imported: tokens.length, name: theme?.name });
      return true;
    }
  }

  if (a === 'live') {
    if (!local(req)) throw new HttpError(403, 'Live site mode is only for a person on this machine.');
    if (b === 'sites') {
      if (!c && method === 'GET') {
        send(res, 200, { sites: app.live.list(), recent: app.live.recents() });
        return true;
      }
      if (!c && method === 'POST') {
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : app.localUrl();
        send(res, 201, await app.live.open(await json(req, LiveOpen), origin));
        return true;
      }
      if (c && !d && method === 'DELETE') {
        send(res, 200, { closed: await app.live.closeSite(c) });
        return true;
      }
      if (c && d === 'runs' && method === 'POST') {
        send(res, 201, await app.live.run(c, await json(req, LiveRun)));
        return true;
      }
    }
  }

  return false;
}

/** One row of the queue: a run going, or one that waits, with why. */
export interface QueueRow {
  kind: 'running' | 'comment' | 'race';
  id: string;
  fileId: string;
  fileName: string;
  runner: string;
  agent?: string;
  title: string;
  at: number;
  source?: string;
  threadId?: string;
  runId?: string;
  tool?: string;
  reason?: string;
  /** The paired device a run goes on, when it was asked of one, or that asked for it. */
  device?: string;
}

/** What runs and what waits, over all files. Comments wait in one queue the person can reorder; race lanes wait in their race. */
export async function runQueue(app: BogenServer): Promise<{ limit: number; running: QueueRow[]; queued: QueueRow[] }> {
  const name = (fileId: string) => app.storage.get(fileId)?.name ?? fileId;
  const running: QueueRow[] = app.runs.list().map((r) => ({
    kind: 'running', id: app.commentRuns.queueIdOf(r.id) ?? r.id, runId: r.id, fileId: r.fileId, fileName: name(r.fileId), runner: r.runner, agent: r.agent, title: r.title, at: r.startedAt, source: r.source,
    ...(r.threadId ? { threadId: r.threadId } : {}), ...(r.tool ? { tool: r.tool } : {}), ...(r.askedFrom ? { device: r.askedFrom } : {}),
  }));
  for (const r of app.remoteRuns.list()) running.push({ kind: 'running', id: r.runId, runId: r.runId, fileId: r.fileId, fileName: name(r.fileId), runner: r.runner, title: r.title, at: r.startedAt, source: 'elsewhere', device: r.device, ...(r.tool ? { tool: r.tool } : {}) });
  const comments: QueueRow[] = app.commentRuns.queued().map((q) => ({ kind: 'comment', id: q.id, fileId: q.fileId, fileName: name(q.fileId), runner: q.runner, title: q.title, at: q.at, threadId: q.threadId, reason: q.reason }));
  const lanes: QueueRow[] = app.races.all().flatMap((race) => race.lanes.filter((l) => l.status === 'queued').map((l) => ({
    kind: 'race' as const, id: `${race.id}.${l.id}`, fileId: race.fileId, fileName: name(race.fileId), runner: l.runner, agent: l.agent, title: race.prompt.replace(/\s+/g, ' ').slice(0, 200), at: race.at,
    reason: l.waiting ?? 'Waits for its turn in the race',
  })));
  return { limit: app.runs.limit, running, queued: [...comments, ...lanes] };
}

function trimRecord<T extends { prompt: string; title?: string; result?: string }>(r: T): T {
  return { ...r, prompt: (r.title || r.prompt).slice(0, 200), ...(r.result ? { result: r.result.slice(0, 400) } : {}) };
}
