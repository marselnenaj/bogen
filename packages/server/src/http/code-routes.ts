import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertCodeProp, type CodePropValue } from '@bogen/core';
import { z } from 'zod';
import { frameFromUrl, measureCode } from '../code-measure.ts';
import type { CodeProject } from '../code-projects.ts';
import { ghAvailable } from '../repo-git.ts';
import { EFFORT_ID, MODEL_ID } from '../run-settings.ts';
import { diffTokens, pullTokens, readRepoTokens } from '../repo-tokens.ts';
import { importStories, readStories, type StoryImportReport } from '../storybook.ts';
import { HttpError } from '../util.ts';
import type { BogenServer } from './server.ts';

/**
 * Code components over HTTP, for the editor:
 * - `GET /api/code/projects`, `POST /api/code/projects {dir, fileId?}` (this machine only), `DELETE /api/code/projects/:id` (this machine only)
 * - `GET /api/code/:project/components`, `POST /api/code/:project/measure {file, name, props}` → `{width, height}`
 * - `GET /api/code/:project/frame?file=&name=` the sandboxed page of one component
 * - `GET /api/code/:project/stories`, `POST /api/code/:project/stories/import {fileId}`: Storybook stories as code components
 * - `GET /api/code/:project/tokens?fileId=`, `POST /api/code/:project/tokens/pull {fileId, names?}`: the repository's tokens
 * - `GET|POST /api/code/pulls`, `POST /api/code/pulls/tokens`, `GET|PATCH|DELETE /api/code/pulls/:id`,
 *   `GET /api/code/pulls/:id/picture/before|after`, `POST /api/code/pulls/:id/open {digest}`: pull requests
 * - `GET|PATCH /api/code/pulls/settings {githubMerges}`, `POST /api/code/pulls/check`: merges of pushed branches
 * - `POST /api/code/canvas {fileId, url?, path?, components?}`: a repository's page as a canvas on a design branch
 * Stories, tokens and pull requests read the disk, so they are for this machine only. None of this is on the tailnet listener.
 */

const LinkBody = z.object({ dir: z.string().min(1).max(1000), fileId: z.string().regex(/^[\w-]{1,64}$/).optional() });
const MeasureBody = z.object({ file: z.string().min(1).max(500), name: z.string().min(1).max(100), props: z.record(z.string(), z.unknown()).default({}) });
const FileId = z.string().regex(/^[\w-]{1,64}$/);
const NodeId = z.string().min(1).max(400);
const Ref = z.string().regex(/^(now|[0-9a-z]{6,14}-[0-9a-f]{8})$/);
const DesignBody = z.object({
  fileId: FileId,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('proposal'), nodeId: NodeId }),
    z.object({ kind: z.literal('versions'), from: Ref, to: Ref, nodeIds: z.array(NodeId).max(50).optional() }),
    z.object({ kind: z.literal('selection'), nodeIds: z.array(NodeId).min(1).max(50), since: Ref.optional() }),
  ]),
  runner: z.enum(['claude', 'codex']),
  model: z.string().regex(MODEL_ID).max(80).optional(),
  effort: z.string().regex(EFFORT_ID).optional(),
  title: z.string().max(200).optional(),
  base: z.string().regex(/^[A-Za-z0-9][\w./-]{0,120}$/).optional(),
  docsDir: z.string().min(1).max(200).optional(),
  pictures: z.boolean().optional(),
  format: z.enum(['html', 'react-inline', 'react-tailwind']).optional(),
  /** The chat it comes from: its later changes go onto the same branch. */
  conversationId: z.string().regex(/^[\w-]{1,64}$/).optional(),
});
const PullSettingsBody = z.object({ githubMerges: z.boolean().optional() });
const CanvasBody = z.object({
  fileId: FileId, url: z.string().min(1).max(2000).optional(), path: z.string().max(500).optional(), width: z.number().int().min(320).max(2560).optional(),
  components: z.number().int().min(0).max(40).optional(), conversationId: z.string().regex(/^[\w-]{1,64}$/).optional(),
});
const TokenBody = z.object({ fileId: FileId, target: z.string().min(1).max(500).optional(), names: z.array(z.string().max(120)).max(2000).optional(), title: z.string().max(200).optional(), base: z.string().regex(/^[A-Za-z0-9][\w./-]{0,120}$/).optional(), designMd: z.boolean().optional() });
const PatchBody = z.object({ title: z.string().max(200).optional(), body: z.string().max(60_000).optional() });
const OpenBody = z.object({ digest: z.string().min(1).max(100) });
const PullBody = z.object({ fileId: FileId, names: z.array(z.string().max(120)).max(2000).optional() });

interface Helpers {
  json: <S extends z.ZodType>(req: IncomingMessage, schema: S) => Promise<z.output<S>>;
  send: (res: ServerResponse, status: number, body: unknown) => void;
}

/** Records in a file which project its code components come from, so that the editor can offer that project's components. */
export async function linkFileToProject(app: BogenServer, fileId: string, project: { id: string; name: string }, origin: string): Promise<void> {
  app.requireFile(fileId);
  const room = await app.rooms.get(fileId);
  room.doc.transact(() => room.doc.meta.set('codeProject', { id: project.id, name: project.name }), origin);
}

/** Imports or brings up to date the stories of a project in a file. The editor, `storybook_import` and the watch all come here. */
export async function syncStories(app: BogenServer, fileId: string, project: CodeProject, transact: (fn: () => void) => void): Promise<StoryImportReport> {
  const room = await app.rooms.get(fileId);
  const modules = await readStories(app.codeProjects, project);
  const scanned = await app.codeProjects.components(project).catch(() => []);
  return importStories(room.doc, project, modules, {
    transact, scanned,
    measure: (ref) => measureCode(app.renderer, app.codeBuilder, ref).catch(() => null),
  });
}

async function handlePulls(app: BogenServer, req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], h: Helpers): Promise<void> {
  const method = req.method ?? 'GET';
  const [, , id, d, e] = parts;
  if (!id) {
    if (method === 'GET') return h.send(res, 200, { drafts: await app.pulls.list(url.searchParams.get('fileId') ?? undefined), gh: await ghAvailable() });
    if (method === 'POST') return h.send(res, 201, await app.pulls.startDesign(await h.json(req, DesignBody)));
    throw new HttpError(405, 'Method not allowed.');
  }
  if (id === 'tokens' && !d && method === 'POST') return h.send(res, 201, await app.pulls.startTokens(await h.json(req, TokenBody)));
  // Whether gh may be asked about merges on GitHub; off unless the person turns it on.
  if (id === 'settings' && !d) {
    if (method === 'GET') return h.send(res, 200, await app.pulls.settings());
    if (method === 'PATCH') return h.send(res, 200, await app.pulls.updateSettings(await h.json(req, PullSettingsBody)));
  }
  // Looks for merges now, instead of within the minute.
  if (id === 'check' && !d && method === 'POST') return h.send(res, 200, { merged: (await app.pulls.checkMerges()).map((x) => x.id) });
  if (!/^[\w-]{1,40}$/.test(id)) throw new HttpError(404, 'No such pull request draft.');
  if (!d) {
    if (method === 'GET') return h.send(res, 200, { ...(await app.pulls.get(id)), diff: await app.pulls.diff(id) });
    if (method === 'PATCH') return h.send(res, 200, await app.pulls.update(id, await h.json(req, PatchBody)));
    if (method === 'DELETE') {
      await app.pulls.discard(id);
      return h.send(res, 200, { discarded: id });
    }
  }
  if (d === 'open' && method === 'POST') return h.send(res, 200, await app.pulls.open(id, (await h.json(req, OpenBody)).digest));
  if (d === 'picture' && (e === 'before' || e === 'after') && method === 'GET') {
    const bytes = await app.pulls.picture(id, e);
    if (!bytes) throw new HttpError(404, `No ${e} picture.`);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(bytes);
    return;
  }
  throw new HttpError(404, 'Not found.');
}

export async function handleCodeRoute(app: BogenServer, req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], local: boolean, h: Helpers): Promise<void> {
  const method = req.method ?? 'GET';
  const [, b, c, d] = parts;
  if (b === 'pulls') {
    if (!local) throw new HttpError(403, 'Pull requests are made only from this machine.');
    return handlePulls(app, req, res, url, parts, h);
  }
  // A repository's page as a canvas, on a design branch: the capture of its dev server and its components.
  if (b === 'canvas' && !c && method === 'POST') {
    if (!local) throw new HttpError(403, 'Repositories are opened only from this machine.');
    const body = await h.json(req, CanvasBody);
    const { openRepoCanvas } = await import('../repo-canvas.ts');
    return h.send(res, 201, await openRepoCanvas(app, { ...body, by: 'editor', kind: 'person', origin: 'person:editor' }));
  }
  if (b === 'projects') {
    if (!c && method === 'GET') return h.send(res, 200, app.codeProjects.list());
    if (!local) throw new HttpError(403, 'Projects are linked only from this machine.');
    if (!c && method === 'POST') {
      const body = await h.json(req, LinkBody);
      const project = await app.codeProjects.link(body.dir);
      if (body.fileId) await linkFileToProject(app, body.fileId, project, 'person:editor');
      return h.send(res, 201, project);
    }
    if (c && method === 'DELETE') return h.send(res, 200, { removed: await app.codeProjects.unlink(c) });
    throw new HttpError(405, 'Method not allowed.');
  }
  if (!b || !/^[a-z0-9]{8,64}$/.test(b)) throw new HttpError(404, 'No such project.');
  if (c === 'frame' && (method === 'GET' || method === 'HEAD')) {
    const tag = req.headers['if-none-match'];
    const frame = await frameFromUrl(app.codeBuilder, url, typeof tag === 'string' ? tag : undefined);
    if (!frame) throw new HttpError(404, 'No such frame.');
    res.writeHead(frame.status, frame.headers);
    res.end(method === 'HEAD' ? undefined : frame.body);
    return;
  }
  const project = app.codeProjects.require(b);
  if (c === 'stories' || c === 'tokens') {
    if (!local) throw new HttpError(403, 'Only from this machine.');
    if (c === 'stories' && !d && method === 'GET') return h.send(res, 200, { project: { id: project.id, name: project.name }, modules: await readStories(app.codeProjects, project) });
    if (c === 'stories' && d === 'import' && method === 'POST') {
      const { fileId } = await h.json(req, z.object({ fileId: FileId }));
      app.requireFile(fileId);
      const room = await app.rooms.get(fileId);
      return h.send(res, 200, await syncStories(app, fileId, project, (fn) => room.doc.transact(fn, 'person:editor')));
    }
    if (c === 'tokens' && !d && method === 'GET') {
      const fileId = FileId.parse(url.searchParams.get('fileId'));
      app.requireFile(fileId);
      const repo = await readRepoTokens(app.codeProjects, project);
      const { doc } = await app.rooms.get(fileId);
      return h.send(res, 200, { project: { id: project.id, name: project.name }, sources: repo.sources, unclassified: repo.unclassified.slice(0, 200), rows: diffTokens(doc.getTokens(), repo.tokens) });
    }
    if (c === 'tokens' && d === 'pull' && method === 'POST') {
      const body = await h.json(req, PullBody);
      app.requireFile(body.fileId);
      const repo = await readRepoTokens(app.codeProjects, project);
      const { doc } = await app.rooms.get(body.fileId);
      return h.send(res, 200, { pulled: pullTokens(doc, repo.tokens, body.names, 'person:editor') });
    }
    throw new HttpError(404, 'Not found.');
  }
  if (c === 'components' && method === 'GET') return h.send(res, 200, { project: { id: project.id, name: project.name }, components: await app.codeProjects.components(project) });
  if (c === 'measure' && method === 'POST') {
    const body = await h.json(req, MeasureBody);
    for (const [k, v] of Object.entries(body.props)) assertCodeProp(k, v);
    app.codeProjects.modulePath(project, body.file);
    return h.send(res, 200, await measureCode(app.renderer, app.codeBuilder, { project: project.id, file: body.file, name: body.name, props: body.props as Record<string, CodePropValue> }));
  }
  throw new HttpError(404, 'Not found.');
}
