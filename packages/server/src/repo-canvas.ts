import { type CodeRef } from '@bogen/core';
import { measureCode } from './code-measure.ts';
import type { CodeProject } from './code-projects.ts';
import { startBranch } from './design-branches.ts';
import { linkFileToProject } from './http/code-routes.ts';
import type { BogenServer } from './http/server.ts';
import { nextArtboardX } from './mcp/kit.ts';
import { repoInfo } from './repo-git.ts';
import { errorMessage, HttpError } from './util.ts';

/**
 * A repository's page as a canvas: a design branch inside the file named after the repository and its Git branch,
 * a page there with a capture of the person's own dev server, and next to it the project's components rendered by
 * its own code. Design work then happens on that branch, and a design pull request takes it back to the code. The
 * dev server is the person's: Bogen captures the address it is given and starts no program of the repository.
 */

export interface RepoCanvasRequest {
  fileId: string;
  /** The linked project; or a folder to link first. */
  projectId?: string;
  dir?: string;
  /** The dev server's address, such as http://localhost:5173. Left out, only the components are placed. */
  url?: string;
  /** The route to capture, such as /pricing. */
  path?: string;
  width?: number;
  /** How many components to place, the first ones the scan found. 0 places none. */
  components?: number;
  /** The chat this canvas belongs to, recorded on the branch. */
  conversationId?: string;
  by: string;
  kind: 'person' | 'agent';
  origin: unknown;
}

export interface RepoCanvas {
  project: { id: string; name: string; dir: string };
  git: { branch: string; head: string };
  branch: { id: string; name: string; reused: boolean };
  pageId: string;
  capture?: { nodeId: string; url: string; layers: number; title: string };
  captureError?: string;
  components: { boardId?: string; placed: { id: string; name: string; module: string }[]; total: number };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const GAP = 24;
const BOARD_WIDTH = 960;

/** The address to capture: the dev server's, with the route on it. Only http(s). */
export function captureUrl(url: string, path?: string): URL {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new HttpError(400, `"${url}" is not an address. Give the dev server's, such as http://localhost:5173.`);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new HttpError(400, 'The dev server needs an http or https address.');
  if (path) {
    const clean = path.startsWith('/') ? path : `/${path}`;
    target = new URL(clean, target.origin);
  }
  return target;
}

export async function openRepoCanvas(app: BogenServer, req: RepoCanvasRequest): Promise<RepoCanvas> {
  app.requireFile(req.fileId);
  const room = await app.rooms.get(req.fileId);
  let project: CodeProject | undefined;
  if (req.dir) {
    project = await app.codeProjects.link(req.dir);
    await linkFileToProject(app, req.fileId, project, req.origin as string);
  } else {
    const linked = room.doc.meta.get('codeProject') as { id?: unknown } | undefined;
    const id = req.projectId ?? (typeof linked?.id === 'string' ? linked.id : undefined);
    project = id ? app.codeProjects.get(id) : undefined;
    if (project && req.projectId && linked?.id !== project.id) await linkFileToProject(app, req.fileId, project, req.origin as string);
  }
  if (!project) throw new HttpError(400, 'Link the repository first, or pass its folder.');
  const info = await repoInfo(project.dir);
  const target = req.url ? captureUrl(req.url, req.path) : undefined;

  // The branch first: the page, the capture and the components all go into it, and main stays as it is.
  const name = `${project.name} on ${info.branch === 'HEAD' ? info.head.slice(0, 7) : info.branch}`.slice(0, 80);
  const { branch, reused } = await startBranch(app, room, { name, by: req.by, kind: req.kind, checkout: true, note: `The repository ${project.name}, from ${project.dir}${target ? `, captured from ${target.href}` : ''}.`, ...(req.conversationId ? { conversation: req.conversationId } : {}) });
  const { doc } = room;
  const pageName = project.name.slice(0, 80);
  const pageId = doc.getPages().find((p) => p.name === pageName)?.id ?? doc.createPage(pageName, req.origin);

  const out: RepoCanvas = {
    project: { id: project.id, name: project.name, dir: project.dir }, git: { branch: info.branch, head: info.head },
    branch: { id: branch.id, name: branch.name, reused }, pageId, components: { placed: [], total: 0 },
  };

  if (target) {
    try {
      const placed = await app.capturePageInto(req.fileId, {
        url: target.href, width: req.width ?? 1440, pageId, name: `${target.pathname === '/' ? 'Home' : target.pathname} (dev server)`,
        // A dev server is on this machine; anything else goes through the usual refusal of private addresses.
        allowLocal: LOOPBACK_HOSTS.has(target.hostname),
      }, req.origin);
      out.capture = { nodeId: placed.nodeId, url: target.href, layers: placed.layers, title: placed.title };
    } catch (e) {
      out.captureError = `The dev server at ${target.href} could not be captured: ${errorMessage(e)}. Is it running?`;
    }
  }

  const wanted = Math.max(0, Math.min(req.components ?? 12, 40));
  const all = wanted ? await app.codeProjects.components(project).catch(() => []) : [];
  out.components.total = all.length;
  if (wanted && all.length) {
    const picked = all.slice(0, wanted);
    const sizes = await Promise.all(picked.map(async (c) => {
      const ref: CodeRef = { project: project!.id, file: c.file, name: c.name, import: c.import, props: {} };
      try {
        return { ref, ...(await measureCode(app.renderer, app.codeBuilder, ref)) };
      } catch {
        return { ref, width: 320, height: 120 };
      }
    }));
    const x = nextArtboardX(doc, pageId);
    const boardId = doc.transact(() => {
      const board = doc.insert(pageId, {
        type: 'frame', tag: 'section', name: `${project!.name} components`, artboard: true,
        style: { position: 'absolute', left: `${x}px`, top: '0px', width: `${BOARD_WIDTH}px`, display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: `${GAP}px`, padding: '32px', backgroundColor: '#ffffff' },
      });
      for (const [i, s] of sizes.entries()) {
        const c = picked[i]!;
        const id = doc.insert(board, { type: 'embed', name: c.display, style: { width: `${Math.round(Math.min(s.width, BOARD_WIDTH - 64))}px`, height: `${Math.round(s.height)}px` }, code: s.ref });
        out.components.placed.push({ id, name: c.display, module: c.file });
      }
      return board;
    }, req.origin);
    out.components.boardId = boardId;
  }
  app.hub.broadcast({ t: 'files' });
  return out;
}
