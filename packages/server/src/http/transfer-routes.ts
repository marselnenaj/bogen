import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { assertContent, docFromContent, docToContent, parseRecords, recordsFrom, Y, type DesignContent } from '@bogen/core';
import { exportPresets, type ExportPreset } from '../exporter.ts';
import { parseFigmaUrl, placeFigma, readFigmaFile } from '../figma.ts';
import { captureSite, MAX_SITE_LIMIT, type SiteEvent } from '../site-capture.ts';
import { fetchPublic } from '../net-guard.ts';
import { atomicWrite, errorMessage, HttpError } from '../util.ts';
import type { BogenServer } from './server.ts';
import { fromThisDevice, jsonBody, readBody, sendJson } from './server.ts';
import type { GuardOptions } from './security.ts';
import { createCommit, diffCommits, discardBranch, historyList, listBranches, mergeBranch, mirrorToGit, pickChanges, visualDiff } from '../history-ops.ts';
import { readFolder } from '../design-folder.ts';
import { folderBrand, importFolderBrand } from '../bogen-transfer.ts';
import { startBranch } from '../design-branches.ts';
import { gitCheckoutTo, gitInit, gitLog } from '../git-mirror.ts';

const FOLDER_LIMIT = 128 * 1024 * 1024;
const DATA_FETCH_LIMIT = 8 * 1024 * 1024;

const Id = z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/);

const SiteBody = z.object({
  url: z.string().url().max(2000), fileId: Id.optional(), name: z.string().min(1).max(200).optional(),
  widths: z.array(z.number().int().min(200).max(4000)).min(1).max(8).optional(),
  schemes: z.array(z.enum(['dark', 'light'])).min(1).max(2).optional(),
  height: z.number().int().min(200).max(4000).optional(),
  limit: z.number().int().min(1).max(MAX_SITE_LIMIT).optional(),
  captureFonts: z.boolean().optional(),
});

const FigmaBody = z.object({
  url: z.string().min(1).max(2000), token: z.string().min(1).max(500).optional(), saveToken: z.boolean().optional(), fileId: Id.optional(), name: z.string().min(1).max(200).optional(),
});

const PresetBody = z.object({
  fileId: Id, nodeIds: z.array(Id).max(100).default([]), pageId: Id.optional(),
  presets: z.array(z.object({
    format: z.enum(['png', 'jpg', 'webp', 'avif', 'svg', 'pdf', 'html']),
    scale: z.number().min(0.1).max(4).optional(), width: z.number().int().min(1).max(8000).optional(),
    suffix: z.string().regex(/^[\w@. -]{0,40}$/).optional(),
  })).min(1).max(30),
});

const DataBody = z.object({ url: z.string().url().max(2000), path: z.string().max(200).optional(), format: z.enum(['json', 'csv']).optional(), allowLocal: z.boolean().optional() });
const CommitBody = z.object({ message: z.string().trim().min(1).max(2000).optional(), author: z.string().trim().min(1).max(80).default('Someone'), kind: z.enum(['commit', 'restore']).default('commit') });
const RevertBody = z.object({ ids: z.array(z.string().max(120)).max(500).optional(), run: z.string().max(60).optional() });
const BranchBody = z.object({ name: z.string().trim().min(1).max(120) });
const GitBody = z.object({ action: z.enum(['init', 'commit', 'log', 'restore']), dir: z.string().max(1000).optional(), message: z.string().max(2000).optional(), author: z.string().max(80).optional(), rev: z.string().max(200).optional(), limit: z.number().int().min(1).max(1000).optional() });
const FolderBody = z.object({ name: z.string().trim().min(1).max(200), content: z.unknown(), brand: z.object({ name: z.string().trim().min(1).max(200), content: z.unknown() }).optional() });

/** A person's token first, then one from the environment, then a saved one. Only this machine can use a saved one. */
export async function figmaToken(app: BogenServer, given: string | undefined, local: boolean): Promise<string> {
  const token = given ?? process.env.FIGMA_TOKEN ?? (local ? (await app.storage.readConfig()).figmaToken : undefined);
  if (!token) throw new HttpError(400, 'A Figma personal access token is needed. Make one in Figma under Settings, Security, with the file_content:read scope.');
  return token;
}

/** Imports through the API into a new file, or a given one. */
export async function importFigma(app: BogenServer, options: { url: string; token: string; fileId?: string; name?: string }, origin: unknown = 'figma') {
  parseFigmaUrl(options.url);
  const base = app.options.figmaApiBase;
  const data = await readFigmaFile(app.storage, { url: options.url, token: options.token, apiBase: base, plainDownloads: Boolean(base) });
  const entry = options.fileId ? app.requireFile(options.fileId) : app.createFile(options.name ?? data.name);
  const room = await app.rooms.get(entry.id);
  const pages = placeFigma(room.doc, data, origin);
  return { fileId: entry.id, name: entry.name, ...data.report, pages, layers: pages.reduce((sum, p) => sum + p.layers, 0) };
}

/**
 * A URL's records, through the same guard as everything else the server fetches for a document. Public addresses
 * only, unless `allowLocal`: the caller passes that only for a person at this machine who allowed it for the source.
 */
export async function fetchRecords(url: string, options: { path?: string; format?: 'json' | 'csv'; allowLocal?: boolean } = {}) {
  const got = await fetchPublic(url, { timeoutMs: 15_000, maxBytes: DATA_FETCH_LIMIT, headers: { accept: 'application/json, text/csv;q=0.9, */*;q=0.1' }, allowPrivate: options.allowLocal === true });
  const type = got.contentType.split(';')[0]!.trim().toLowerCase();
  const text = Buffer.from(got.bytes).toString('utf8');
  if (options.format === 'csv' || (!options.format && /csv/.test(type))) return parseRecords(text, { format: 'csv' });
  if (options.format === 'json' || /json/.test(type) || /^\s*[[{]/.test(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('That address did not return valid JSON.');
    }
    return recordsFrom(parsed, options.path);
  }
  throw new Error(`That address returned ${type || 'an unknown type'}, and not JSON or CSV.`);
}

/** The Git layer over design folders. Nothing here pushes. */
async function gitAction(app: BogenServer, fileId: string, body: z.output<typeof GitBody>): Promise<unknown> {
  const dir = body.dir ?? (await app.gitBindings.get(fileId));
  if (!dir) throw new HttpError(400, 'This file is not bound to a folder yet. Use `bogen git init <file> <dir>`.');
  const { doc } = await app.rooms.get(fileId);
  if (body.action === 'init') {
    const created = await gitInit(dir);
    const full = await app.gitBindings.set(fileId, dir);
    const hash = await mirrorToGit(app, fileId, doc, full, body.message ?? 'Bogen: first commit', { name: body.author ?? 'Bogen' });
    return { dir: full, created, commit: hash };
  }
  if (body.action === 'commit') {
    const message = body.message ?? `Bogen: ${new Date().toISOString()}`;
    const out = await createCommit(app, fileId, { message, author: body.author ?? 'Bogen', authorKind: 'person' });
    // A file bound to another folder than the one named gets this one too.
    const bound = await app.gitBindings.get(fileId);
    const commit = bound === dir ? out.git ?? null : await mirrorToGit(app, fileId, doc, dir, message, { name: body.author ?? 'Bogen' });
    return { dir, commit, bogenCommit: out.id };
  }
  if (body.action === 'log') return { dir, log: await gitLog(dir, body.limit ?? 50) };
  const rev = body.rev ?? 'HEAD';
  const folder = await gitCheckoutTo(dir, rev, (path) => readFolder(path));
  const saved = await createCommit(app, fileId, { message: `Before restoring Git ${rev}`, author: body.author ?? 'Bogen', authorKind: 'person', kind: 'restore' });
  const { applyContent, labelChange } = await import('@bogen/core');
  doc.transact(() => {
    applyContent(doc, folder.content);
    labelChange(doc, { label: `Restored Git ${rev}` });
  }, 'git');
  return { dir, restored: rev, savedAs: saved.id, pages: folder.content.pages.length, layers: folder.content.nodes.length };
}

/** Routes for getting work in and out. True when it answered. */
export async function handleTransfer(app: BogenServer, req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], guard: GuardOptions): Promise<boolean> {
  const [a, b, c, d, e] = parts;
  const method = req.method ?? 'GET';

  if (a === 'capture' && b === 'site' && method === 'POST') {
    const body = await jsonBody(req, SiteBody);
    const entry = body.fileId ? app.requireFile(body.fileId) : app.createFile(body.name ?? new URL(body.url).hostname);
    // One JSON object per line, so that a big site shows progress and no timeout cuts it off.
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    const send = (event: object) => res.write(`${JSON.stringify(event)}\n`);
    send({ t: 'file', fileId: entry.id, name: entry.name });
    const stop = new AbortController();
    req.on('close', () => { if (!res.writableEnded) stop.abort(); });
    try {
      const report = await captureSite(app, {
        url: body.url, fileId: entry.id, widths: body.widths, schemes: body.schemes, height: body.height, limit: body.limit, captureFonts: body.captureFonts,
        allowLocal: fromThisDevice(req, guard), signal: stop.signal,
        onProgress: (event: SiteEvent) => send(event),
      });
      send({ t: 'done', report });
    } catch (err) {
      send({ t: 'error', error: errorMessage(err) });
    }
    res.end();
    return true;
  }

  if (a === 'import' && b === 'figma' && method === 'POST') {
    const body = await jsonBody(req, FigmaBody);
    const local = fromThisDevice(req, guard);
    const token = await figmaToken(app, body.token, local);
    const out = await importFigma(app, { url: body.url, token, fileId: body.fileId, name: body.name });
    // Saved only after it has worked, and only when asked.
    if (body.saveToken && body.token && local) await app.storage.updateConfig({ figmaToken: body.token });
    sendJson(res, 201, out);
    return true;
  }
  if (a === 'config' && b === 'figma') {
    if (!fromThisDevice(req, guard)) throw new HttpError(403, 'Only from this machine.');
    if (method === 'GET') {
      sendJson(res, 200, { saved: Boolean((await app.storage.readConfig()).figmaToken), env: Boolean(process.env.FIGMA_TOKEN) });
      return true;
    }
    if (method === 'DELETE') {
      await app.storage.updateConfig({ figmaToken: undefined });
      sendJson(res, 200, { saved: false });
      return true;
    }
  }

  if (a === 'export' && b === 'presets' && method === 'POST') {
    const body = await jsonBody(req, PresetBody);
    const entry = app.requireFile(body.fileId);
    const { doc } = await app.rooms.get(body.fileId);
    const pageId = body.pageId ?? doc.getPages()[0]?.id;
    const targets = body.nodeIds.length
      ? body.nodeIds.map((id) => ({ target: { nodeIds: [id] }, name: doc.getNode(id)?.name ?? id }))
      : doc.getChildren(pageId ?? '').filter((n) => !n.hidden).map((n) => ({ target: { nodeIds: [n.id] }, name: n.name }));
    if (!targets.length) throw new HttpError(400, 'The page is empty, so there is nothing to export.');
    if (targets.length * body.presets.length > 300) throw new HttpError(400, `That is ${targets.length * body.presets.length} files. An export makes at most 300.`);
    const out = await exportPresets(doc, app.renderer, app.storage, targets, body.presets as ExportPreset[]).catch((err) => {
      throw new HttpError(/^No layer|^The page is empty|^Nothing to/.test(errorMessage(err)) ? 400 : 500, errorMessage(err));
    });
    const name = entry.name.replace(/[^\w.-]+/g, '-') || 'export';
    res.writeHead(200, {
      'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}.zip"`, 'X-Content-Type-Options': 'nosniff',
      'X-Bogen-Export-Report': encodeURIComponent(JSON.stringify(out.files.slice(0, 40).map((f) => ({ name: f.name, bytes: f.bytes })))),
    });
    res.end(out.zip);
    return true;
  }

  if (a === 'data' && b === 'fetch' && method === 'POST') {
    const body = await jsonBody(req, DataBody);
    // This computer's own network only for a request made here, by the person who ticked it for the source.
    if (body.allowLocal && !fromThisDevice(req, guard)) throw new HttpError(403, 'This computer\'s network can only be reached from this computer itself.');
    try {
      sendJson(res, 200, { records: await fetchRecords(body.url, { path: body.path, format: body.format, allowLocal: body.allowLocal === true }) });
    } catch (err) {
      throw new HttpError(400, errorMessage(err));
    }
    return true;
  }

  if (a === 'files' && b === 'import-folder' && method === 'POST') {
    const raw = await readBody(req, FOLDER_LIMIT);
    const parsed = FolderBody.safeParse(JSON.parse(raw.toString('utf8') || '{}'));
    if (!parsed.success) throw new HttpError(400, 'A design folder needs a name and its content.');
    let content = parsed.data.content as DesignContent;
    let state: Uint8Array;
    try {
      assertContent(content);
      if (parsed.data.brand) assertContent(parsed.data.brand.content);
    } catch (err) {
      throw new HttpError(400, errorMessage(err));
    }
    // The brand first, so that the design links to it under the id it has on this device.
    const brand = parsed.data.brand ? await importFolderBrand(app, content, { name: parsed.data.brand.name, content: parsed.data.brand.content as DesignContent }, 'person:editor') : null;
    if (brand) content = brand.content;
    try {
      state = Y.encodeStateAsUpdate(docFromContent(content).y);
    } catch (err) {
      throw new HttpError(400, errorMessage(err));
    }
    const { newId } = await import('@bogen/core');
    const id = newId();
    await atomicWrite(app.storage.docPath(id), state);
    const entry = app.storage.create(parsed.data.name, id);
    await app.brands.classify(id);
    app.hub.broadcast({ t: 'files' });
    sendJson(res, 201, { id: entry.id, name: entry.name, pages: content.pages.length, layers: content.nodes.length, ...(brand ? { brand: brand.brand } : {}) });
    return true;
  }

  // `?brand=0` leaves the linked brand out; otherwise it comes along as a design folder of its own.
  if (a === 'files' && b && c === 'folder' && method === 'GET') {
    const entry = app.requireFile(b);
    const { doc } = await app.rooms.get(b);
    const brand = await folderBrand(app, doc, url.searchParams.get('brand') !== '0');
    const carried = brand && 'doc' in brand ? { id: brand.id, name: brand.name, content: docToContent(brand.doc) } : null;
    sendJson(res, 200, { name: entry.name, content: docToContent(doc), ...(carried ? { brand: carried } : brand ? { brandNote: brand } : {}) });
    return true;
  }

  if (a === 'files' && b && c === 'recent-edits' && method === 'GET') {
    app.requireFile(b);
    sendJson(res, 200, app.storage.get(b)?.recentEdits ?? []);
    return true;
  }

  if (a === 'files' && b && c === 'timeline' && method === 'GET') {
    app.requireFile(b);
    const limit = Number(url.searchParams.get('limit')) || 200;
    const before = Number(url.searchParams.get('before')) || undefined;
    sendJson(res, 200, await historyList(app, b, { limit: Math.min(limit, 1000), before }));
    return true;
  }

  if (a === 'files' && b && c === 'commits') {
    app.requireFile(b);
    if (!d) {
      if (method === 'GET') {
        sendJson(res, 200, await app.commits.list(b));
        return true;
      }
      if (method === 'POST') {
        const body = await jsonBody(req, CommitBody);
        sendJson(res, 201, await createCommit(app, b, { message: body.message, author: body.author, authorKind: 'person', kind: body.kind }));
        return true;
      }
    } else if (!e && method === 'GET') {
      const content = await app.commits.read(b, d);
      if (!content) throw new HttpError(404, 'No such commit.');
      sendJson(res, 200, content);
      return true;
    }
  }

  if (a === 'files' && b && c === 'compare' && method === 'GET') {
    app.requireFile(b);
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? 'now';
    if (d === 'render') {
      const page = url.searchParams.get('page') ?? '';
      const out = await visualDiff(app, b, from, to, page);
      sendJson(res, 200, {
        percent: out.percent, bounds: out.bounds,
        before: out.before && Buffer.from(out.before).toString('base64'),
        after: out.after && Buffer.from(out.after).toString('base64'),
        diff: out.diff && Buffer.from(out.diff).toString('base64'),
      });
      return true;
    }
    sendJson(res, 200, await diffCommits(app, b, from, to));
    return true;
  }

  if (a === 'files' && b && c === 'changes' && d === 'plan' && method === 'POST') {
    app.requireFile(b);
    const body = await jsonBody(req, RevertBody);
    const { doc } = await app.rooms.get(b);
    const changes = await pickChanges(app, b, body);
    const { planRevert } = await import('@bogen/core');
    sendJson(res, 200, { ...planRevert(doc, changes), changes: changes.map((x) => x.id) });
    return true;
  }

  if (a === 'files' && b && c === 'branches') {
    app.requireFile(b);
    if (!d) {
      if (method === 'GET') {
        sendJson(res, 200, await listBranches(app, b));
        return true;
      }
      if (method === 'POST') {
        // A branch is made inside the file now, never as a file of its own (design-branches.ts). Older copy-branches
        // still list, merge and discard here.
        const room = await app.rooms.get(b);
        const out = await startBranch(app, room, { name: (await jsonBody(req, BranchBody)).name.slice(0, 80), by: 'person', kind: 'person', checkout: true });
        sendJson(res, 201, { id: out.branch.id, name: out.branch.name, at: out.branch.at, fileId: b, internal: true, reused: out.reused });
        return true;
      }
    } else if (e === 'merge' && method === 'POST') {
      const body = await jsonBody(req, z.object({ author: z.string().max(80).default('Someone') }));
      sendJson(res, 200, await mergeBranch(app, b, d, { author: body.author, authorKind: 'person' }));
      return true;
    } else if (!e && method === 'DELETE') {
      await discardBranch(app, b, d);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  if (a === 'files' && b && c === 'git') {
    // It works on this machine's disk, so it answers only here.
    if (!fromThisDevice(req, guard)) throw new HttpError(403, 'Only from this machine.');
    app.requireFile(b);
    if (method === 'POST') {
      const body = await jsonBody(req, GitBody);
      sendJson(res, 200, await gitAction(app, b, body));
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, { dir: (await app.gitBindings.get(b)) ?? null });
      return true;
    }
  }

  return false;
}
