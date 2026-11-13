import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { runPublishCheck } from '../publish-check.ts';
import { RUNNER_IDS } from '@bogen/core';
import { EFFORT_ID, MODEL_ID } from '../run-settings.ts';
import { funnelPolicyHint } from '../static-listener.ts';
import { HttpError } from '../util.ts';
import type { GuardOptions } from './security.ts';
import { fromThisDevice, type BogenServer } from './server.ts';

/**
 * Publishing and review links, for the owner on this machine. None of it answers on the tailnet or the phone
 * listener (`isLocalOnlyPath`, `phoneRefusedPath`), and every route checks `fromThisDevice` again.
 *
 * What makes something reachable from elsewhere needs the owner in the editor: sending a version to a target,
 * turning a listener or Funnel on, making a review link, accepting a client's comment into the file. Those
 * routes take only a browser's same-origin request, which neither MCP nor the CLI make. Making a version,
 * looking, unpublishing, revoking and deleting work from the CLI too.
 *
 * - `GET /api/publish[?fileId=]` → sites, versions, waiting requests, links, the client inbox, both listeners
 * - `POST /api/publish/prepare {fileId, pageId?, nodeId?, title?, fit?}` → a new version
 * - `POST /api/publish/sites/:site/publish {version, target, path?, repo?, branch?, allowForeign?, fingerprint?}` (editor)
 * - `POST /api/publish/sites/:site/github-plan {version?, repo, branch}` → what a push would do
 * - `POST /api/publish/sites/:site/unpublish {target?}` (editor for github), `DELETE /api/publish/sites/:site`
 * - `GET /api/publish/versions/:version/files` → the paths and sizes of a version's files
 * - `POST /api/publish/check {fileId, pageId?, nodeId?, versionId?, summaries?, compliance?}` → the pre-publish check, local only
 * - `DELETE /api/publish/requests/:id`
 * - `POST /api/publish/listeners/:site|review {on, public?, httpsPort?}` (editor to turn on or make public)
 * - `POST /api/shares {siteId, versionId, label, days?, maxViews?, comments}` (editor) → the link, once
 * - `DELETE /api/shares/:id` revokes
 * - `POST /api/shares/inbox/:id/accept` (editor), `DELETE /api/shares/inbox/:id`
 * - `POST /api/shares/inbox/run {ids, runner}` (editor): several client comments as one revision run
 */

const Id = z.string().regex(/^[\w-]{1,64}$/);
const Hex12 = z.string().regex(/^[a-f0-9]{12}$/);
const Version = z.string().regex(/^[a-f0-9]{32}$/);
const Prepare = z.object({ fileId: Id, pageId: Id.optional(), nodeId: z.string().regex(/^[\w/-]{1,200}$/).optional(), title: z.string().trim().min(1).max(200).optional(), fit: z.enum(['fluid', 'fixed']).optional() });
const PublishBody = z.object({
  version: Version, target: z.enum(['listener', 'folder', 'github']), path: z.string().min(1).max(1000).optional(),
  repo: z.string().max(201).optional(), branch: z.string().max(100).optional(), allowForeign: z.boolean().default(false), fingerprint: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  requestId: Hex12.optional(),
});
const CheckBody = z.object({ fileId: Id.optional(), pageId: Id.optional(), nodeId: z.string().regex(/^[\w/-]{1,200}$/).optional(), versionId: Version.optional(), summaries: z.boolean().optional(), compliance: z.boolean().optional() });
const PlanBody = z.object({ version: Version.nullable().optional(), repo: z.string().max(201), branch: z.string().max(100) });
const UnpublishBody = z.object({ target: z.enum(['listener', 'folder', 'github']).optional() });
const ListenerBody = z.object({ on: z.boolean(), public: z.boolean().optional(), httpsPort: z.number().int().min(1).max(65535).optional() });
const ShareBody = z.object({
  siteId: Hex12, versionId: Version, label: z.string().trim().max(80).default('Review link'), days: z.number().int().min(1).max(90).optional(),
  maxViews: z.number().int().min(1).max(100_000).optional(), comments: z.boolean().default(false), requestId: Hex12.optional(),
});

/**
 * The owner, in the editor on this machine: a browser's request from the editor's own origin. MCP clients and
 * the CLI send no Origin, and a page elsewhere cannot send this one (`checkRequest` refused it before).
 */
export function fromEditor(req: IncomingMessage, guard: GuardOptions): boolean {
  if (!fromThisDevice(req, guard)) return false;
  const site = req.headers['sec-fetch-site'];
  return req.headers.origin !== undefined && (site === 'same-origin' || (guard.dev === true && site === 'same-site'));
}

interface Helpers {
  json: <S extends z.ZodType>(req: IncomingMessage, schema: S) => Promise<z.output<S>>;
  send: (res: ServerResponse, status: number, body: unknown) => void;
}

const EDITOR_ONLY = 'Only the owner can do this, in the editor on this machine: it makes something reachable from elsewhere.';

export async function handlePublishRoute(app: BogenServer, req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], guard: GuardOptions, h: Helpers): Promise<void> {
  if (!fromThisDevice(req, guard)) throw new HttpError(403, 'Only from this machine.');
  const editor = () => {
    if (!fromEditor(req, guard)) throw new HttpError(403, EDITOR_ONLY);
  };
  const method = req.method ?? 'GET';
  const [a, b, c, d] = parts;

  if (a === 'shares') {
    if (!b && method === 'POST') {
      editor();
      const body = await h.json(req, ShareBody);
      const made = await app.shares.create(body, app.reviewListener.origin);
      if (body.requestId) await app.publisher.dismiss(body.requestId);
      return h.send(res, 201, { ...made, note: made.url ? 'This link is shown once. Copy it now.' : 'The review listener does not know its address yet: is Tailscale up? The link is /r/<token>/ on it.' });
    }
    // Several client comments as one revision run. Only the owner's click in the editor starts it.
    if (b === 'inbox' && c === 'run' && !d && method === 'POST') {
      editor();
      const body = await h.json(req, z.object({ ids: z.array(z.string().regex(/^[a-f0-9]{12}$/)).min(1).max(20), runner: z.enum(RUNNER_IDS), model: z.string().regex(MODEL_ID).optional(), effort: z.string().regex(EFFORT_ID).optional() }));
      return h.send(res, 201, await app.clientRuns.start(body));
    }
    if (b === 'inbox' && c && d === 'accept' && method === 'POST') {
      editor();
      return h.send(res, 200, await app.shares.accept(c));
    }
    if (b === 'inbox' && c && !d && method === 'DELETE') {
      await app.shares.discard(c);
      return h.send(res, 200, { ok: true });
    }
    if (b && b !== 'inbox' && !c && method === 'DELETE') {
      await app.shares.revoke(b);
      return h.send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'No such route.');
  }

  if (!b && method === 'GET') {
    const fileId = url.searchParams.get('fileId') ?? undefined;
    const overview = app.publisher.overview(fileId);
    const [site, review] = await Promise.all([app.siteListener.status(), app.reviewListener.status()]);
    return h.send(res, 200, { ...overview, ...app.shares.overview(new Set(overview.sites.map((s) => s.id))), listeners: { site, review }, funnelPolicy: funnelPolicyHint(app.siteListener.ownerLogin) });
  }
  if (b === 'prepare' && !c && method === 'POST') {
    const body = await h.json(req, Prepare);
    app.requireFile(body.fileId);
    return h.send(res, 201, await app.publisher.prepare({ ...body, by: 'you' }));
  }
  if (b === 'check' && !c && method === 'POST') {
    const body = await h.json(req, CheckBody);
    if (!body.versionId && !body.fileId) throw new HttpError(400, 'Name a file or a version.');
    return h.send(res, 200, await runPublishCheck(app, { fileId: body.fileId ?? '', ...(body.pageId ? { pageId: body.pageId } : {}), ...(body.nodeId ? { nodeId: body.nodeId } : {}), ...(body.versionId ? { versionId: body.versionId } : {}), ...(body.summaries !== undefined ? { summaries: body.summaries } : {}), ...(body.compliance ? { compliance: true } : {}) }));
  }
  if (b === 'versions' && c && d === 'files' && method === 'GET') {
    if (!Version.safeParse(c).success) throw new HttpError(404, 'No such version.');
    const manifest = await app.publisher.manifest(c).catch(() => {
      throw new HttpError(404, 'No such version.');
    });
    return h.send(res, 200, Object.entries(manifest.files).map(([path, f]) => ({ path, bytes: f.bytes })));
  }
  if (b === 'requests' && c && method === 'DELETE') {
    await app.publisher.dismiss(c);
    return h.send(res, 200, { ok: true });
  }
  if (b === 'listeners' && (c === 'site' || c === 'review') && method === 'POST') {
    const body = await h.json(req, ListenerBody);
    if (body.on || body.public) editor();
    const listener = c === 'site' ? app.siteListener : app.reviewListener;
    return h.send(res, 200, await listener.set(body.on, { public: body.public, httpsPort: body.httpsPort }));
  }
  if (b === 'sites' && c && /^[a-f0-9]{12}$/.test(c)) {
    if (d === 'publish' && method === 'POST') {
      editor();
      const body = await h.json(req, PublishBody);
      const out = await app.publisher.publish(c, body.version, body.target, body);
      return h.send(res, 200, out);
    }
    if (d === 'github-plan' && method === 'POST') {
      const body = await h.json(req, PlanBody);
      return h.send(res, 200, await app.publisher.planGithub(c, body.version ?? null, body.repo, body.branch));
    }
    if (d === 'unpublish' && method === 'POST') {
      const body = await h.json(req, UnpublishBody);
      // Taking a site off GitHub pushes a commit, which is the owner's to make.
      if (body.target === 'github') editor();
      return h.send(res, 200, await app.publisher.unpublish(c, body.target));
    }
    if (!d && method === 'DELETE') {
      await app.publisher.remove(c);
      return h.send(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'No such route.');
}
