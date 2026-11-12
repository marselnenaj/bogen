import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { cleanProject, PROJECT_META_KEY } from '@bogen/core';
import { HttpError } from '../util.ts';
import type { BogenServer } from './server.ts';
import { jsonBody, sendJson } from './server.ts';

/** Dashboard folders. Paths like `Clients/Acme`, kept in the index of this device. */
const FolderPath = z.string().trim().max(400).transform((p) => p.split('/').map((part) => part.trim()).filter(Boolean).join('/')).refine((p) => p.split('/').every((part) => part !== '.' && part !== '..' && part.length <= 80), 'Not a folder name.');
const Path = z.object({ path: FolderPath.refine(Boolean, 'A folder needs a name.') });
const Rename = z.object({ from: FolderPath.refine(Boolean), to: FolderPath.refine(Boolean, 'A folder needs a name.') });
const Move = z.object({ folder: FolderPath });
const Project = z.object({ type: z.string().max(40).nullable(), platforms: z.array(z.string().max(20)).max(4).optional() });

export async function handleFolders(server: BogenServer, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const { storage } = server;
  if (path === '/api/folders') {
    if (method === 'GET') {
      sendJson(res, 200, storage.listFolders());
      return true;
    }
    if (method === 'POST') {
      const body = await jsonBody(req, Path);
      storage.addFolder(body.path);
      server.hub.broadcast({ t: 'files' });
      sendJson(res, 201, { path: body.path });
      return true;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(req, Rename);
      if (body.to === body.from || body.to.startsWith(`${body.from}/`)) throw new HttpError(400, 'A folder cannot move into itself.');
      storage.renameFolder(body.from, body.to);
      server.hub.broadcast({ t: 'files' });
      sendJson(res, 200, { path: body.to });
      return true;
    }
    if (method === 'DELETE') {
      const body = await jsonBody(req, Path);
      storage.removeFolder(body.path);
      server.hub.broadcast({ t: 'files' });
      sendJson(res, 200, { ok: true });
      return true;
    }
  }
  // What a file is a design for, as a person says it. Kept in the document, so it travels and syncs with the file.
  const p = /^\/api\/files\/([0-9a-zA-Z_-]{1,64})\/project$/.exec(path);
  if (p && method === 'PATCH') {
    server.requireFile(p[1]!);
    const body = await jsonBody(req, Project);
    const clean = body.type === null ? null : cleanProject(body);
    if (body.type !== null && !clean) throw new HttpError(400, 'Not a project type.');
    const room = await server.rooms.get(p[1]!);
    room.doc.transact(() => {
      if (clean) room.doc.meta.set(PROJECT_META_KEY, clean);
      else room.doc.meta.delete(PROJECT_META_KEY);
    }, 'person:home');
    // The index follows the document's meta (BrandStore.watch); answer with what it now says.
    sendJson(res, 200, { id: p[1], project: storage.get(p[1]!)?.project ?? null });
    return true;
  }
  const m = /^\/api\/files\/([0-9a-zA-Z_-]{1,64})\/folder$/.exec(path);
  if (m && method === 'PATCH') {
    server.requireFile(m[1]!);
    const body = await jsonBody(req, Move);
    storage.moveToFolder(m[1]!, body.folder);
    server.hub.broadcast({ t: 'files' });
    sendJson(res, 200, { id: m[1], folder: body.folder });
    return true;
  }
  return false;
}
