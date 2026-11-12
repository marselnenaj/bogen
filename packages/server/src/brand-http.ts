import { brandBookOutline, brandBookReadiness } from '@bogen/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { bindingFields, brandBrief, brandCounts, brandLanguages, brandLinkOf, brandOriginOf, brandSummary, brandMarkdown, brandVersionHead, BRAND_NOTICE, diffBrand, markBrandFields, readWaivers, setBrandField, setWaiver, brandVersions, upsertBrandItem } from '@bogen/core';
import { applySafeFixes, checkRendered, checkStatic, layersIn, type BrandReport, type Scope } from './brand-check.ts';
import { exportTarget } from './exporter.ts';
import type { BogenServer } from './http/server.ts';
import { readBody, sendJson } from './http/server.ts';
import { FILE_ID } from './storage.ts';
import { runTemplate, templateList, TEMPLATE_IDS } from './templates/index.ts';
import { errorMessage, HttpError } from './util.ts';

const JSON_LIMIT = 1024 * 1024;

async function bodyOf<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.output<S>> {
  const raw = await readBody(req, JSON_LIMIT);
  let parsed: unknown;
  try {
    parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'The body is not valid JSON.');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return result.data;
}

const Name = z.object({ name: z.string().trim().min(1).max(200), by: z.string().trim().max(80).optional() });
const Publish = z.object({ note: z.string().max(2000).optional(), by: z.string().trim().max(80).optional() });
const Apply = z.object({ fileIds: z.array(z.string().regex(FILE_ID)).max(1000).optional(), by: z.string().trim().max(80).optional() });
const Link = z.object({ brandId: z.string().regex(FILE_ID).nullable() });
const Default = z.object({ brandId: z.string().regex(FILE_ID).nullable() });
const Check = z.object({ nodeId: z.string().optional(), pageId: z.string().optional(), mode: z.enum(['rendered', 'static']).default('rendered'), fix: z.boolean().default(false) });
const Waive = z.object({ nodeId: z.string().regex(/^[0-9a-z]{1,64}$/i), rule: z.string().min(1).max(120).regex(/^[^|]+$/), reason: z.string().trim().min(1).max(500), by: z.string().trim().min(1).max(80) });
const UseTemplate = z.object({ template: z.enum(TEMPLATE_IDS), fileId: z.string().regex(FILE_ID).optional(), only: z.array(z.string().max(40)).max(20).optional(), by: z.string().trim().max(80).optional() });
const MemoryAction = z.object({ action: z.enum(['add', 'dismiss']), by: z.string().trim().max(80).optional() });
const Drift = z.object({ by: z.string().trim().max(80).optional(), fileIds: z.array(z.string().regex(FILE_ID)).max(1000).optional() });
const Unwaive = z.object({ nodeId: z.string().regex(/^[0-9a-z]{1,64}$/i), rule: z.string().min(1).max(120).regex(/^[^|]+$/) });

function personOrigin(by: string | undefined): string {
  return `person:${by?.trim() || 'editor'}`;
}

function safeFileName(name: string): string {
  return name.replace(/[^\w .-]+/g, '_').slice(0, 80) || 'brand';
}

export function scopeOf(doc: { pages: { has: (id: string) => boolean } }, nodeId?: string, pageId?: string): Scope {
  if (nodeId) return { nodeId };
  if (pageId) {
    if (!doc.pages.has(pageId)) throw new HttpError(400, `No page with id ${pageId}.`);
    return { pageId };
  }
  return { file: true };
}

/** The brand as the panel and Home want it. */
async function fullBrand(app: BogenServer, id: string) {
  const { entry, room, data } = await app.brands.read(id);
  const versions = brandVersions(room.doc);
  const head = versions.at(-1);
  return {
    id, name: entry.name, data, counts: brandCounts(data), linkedFiles: app.brands.linkedEntries(id).map((f) => ({ id: f.id, name: f.name })),
    versions: versions.map((v) => ({ id: v.id, n: v.n, at: v.at, by: v.by, note: v.note })), draftChanges: head ? diffBrand(head.data, data).length : 0,
    duplicatedFrom: brandOriginOf(room.doc), notice: BRAND_NOTICE,
  };
}

/** The languages a brand sets, the primary first. A primary only read from its words is no setting. */
function spokenLanguages(data: Parameters<typeof brandLanguages>[0]): string[] {
  const langs = brandLanguages(data);
  return langs.inferred ? langs.additional : langs.all;
}

const systemFileJobs = new WeakMap<BogenServer, Map<string, Promise<{ file_id: string }>>>();

/** `/api/brands/*` and `/api/files/:id/brand/*`. Reached only from this machine: see `isLocalOnlyPath`. */
export async function handleBrandRoute(app: BogenServer, req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], local: boolean): Promise<void> {
  const method = req.method ?? 'GET';
  const [a, b, c, d] = parts;
  if (a === 'files') return fileRoute(app, req, res, b!, d, method, local);

  if (!b) {
    if (method === 'GET') return sendJson(res, 200, await app.brands.list());
    if (method === 'POST') {
      const body = await bodyOf(req, Name);
      const entry = await app.brands.create(body.name, body.by ?? 'editor');
      return sendJson(res, 201, { id: entry.id, name: entry.name });
    }
    throw new HttpError(405, 'Method not allowed.');
  }
  if (b === 'default') {
    if (method === 'GET') return sendJson(res, 200, { brandId: await app.brands.defaultBrandId() });
    if (method === 'PUT') {
      const { brandId } = await bodyOf(req, Default);
      await app.brands.setDefault(brandId, 'person:editor');
      return sendJson(res, 200, { brandId });
    }
    throw new HttpError(405, 'Method not allowed.');
  }
  if (b === 'templates' && !c && method === 'GET') return sendJson(res, 200, templateList().filter((t) => !t.example));
  if (!FILE_ID.test(b)) throw new HttpError(404, 'No such brand.');
  if (!c) {
    if (method === 'GET') return sendJson(res, 200, await fullBrand(app, b));
    if (method === 'PATCH') {
      const { name, by } = await bodyOf(req, Name);
      return sendJson(res, 200, { id: b, name: await app.brands.rename(b, name, personOrigin(by)) });
    }
    if (method === 'DELETE') return sendJson(res, 200, await app.brands.delete(b));
  }
  // Read only. A person edits chapters in the brand document itself, as the editor does, and agents with brand_book_update.
  if (c === 'book') {
    const { data } = await app.brands.read(b);
    if (method === 'GET') return sendJson(res, 200, { book: data.book ?? { version: 1, chapters: [] }, outline: brandBookOutline(data.book), readiness: brandBookReadiness(data), languages: brandLanguages(data) });
    throw new HttpError(405, 'Method not allowed.');
  }
  // Open the canonical visual foundation instead of making a new file on every click.
  if (c === 'system-file' && method === 'POST') {
    app.brands.requireBrand(b);
    let jobs = systemFileJobs.get(app);
    if (!jobs) { jobs = new Map(); systemFileJobs.set(app, jobs); }
    let job = jobs.get(b);
    if (!job) {
      job = (async () => {
        const { room } = await app.brands.read(b);
        const saved = room.doc.meta.get('brandSystemFile');
        const linked = app.brands.linkedEntries(b);
        if (typeof saved === 'string' && linked.some((f) => f.id === saved)) return { file_id: saved };
        for (const entry of linked) {
          const candidate = await app.rooms.get(entry.id);
          if (candidate.doc.getPages().some((p) => p.name === 'Brand system')) {
            room.doc.transact(() => room.doc.meta.set('brandSystemFile', entry.id), 'person:editor');
            return { file_id: entry.id };
          }
        }
        const out = await runTemplate(app, { template: 'brand-system', brandId: b, actor: 'editor', origin: 'person:editor' });
        room.doc.transact(() => room.doc.meta.set('brandSystemFile', out.file_id), 'person:editor');
        return { file_id: out.file_id };
      })();
      jobs.set(b, job);
    }
    try { return sendJson(res, 200, await job); }
    finally { jobs.delete(b); }
  }
  if (c === 'duplicate' && method === 'POST') {
    const entry = await app.brands.duplicate(b, 'person:editor');
    return sendJson(res, 201, { id: entry.id, name: entry.name });
  }
  // A template laid out from this brand, in a new file unless one is named: "New brand system file" and the like.
  if (c === 'template' && method === 'POST') {
    const body = await bodyOf(req, UseTemplate);
    app.brands.requireBrand(b);
    if (body.template.startsWith('example-')) throw new HttpError(400, 'An example brings its own brand: use POST /api/examples/:id.');
    try {
      const out = await runTemplate(app, { template: body.template, brandId: b, ...(body.fileId ? { fileId: body.fileId } : {}), ...(body.only ? { options: { only: body.only } } : {}), actor: body.by || 'editor', origin: personOrigin(body.by) });
      app.hub.broadcast({ t: 'files' });
      return sendJson(res, 201, out);
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(400, errorMessage(e));
    }
  }
  if (c === 'versions') {
    // The same list brand_versions gives an agent.
    if (method === 'GET') {
      const { room } = await app.brands.read(b);
      return sendJson(res, 200, brandVersions(room.doc).map((v) => ({ id: v.id, n: v.n, at: v.at, by: v.by, note: v.note })));
    }
    if (method === 'POST') {
      const { note, by } = await bodyOf(req, Publish);
      const version = await app.brands.publish(b, { ...(note ? { note } : {}), by: by ?? 'A person' }, personOrigin(by));
      return sendJson(res, 201, { id: version.id, n: version.n, at: version.at, note: version.note });
    }
  }
  if (c === 'memory') {
    // Suggestions from what the person decided. Only the person turns one into a rule, here or on a paired phone.
    if (!d && method === 'GET') {
      const { data } = await app.brands.read(b);
      return sendJson(res, 200, await app.memory.view(b, data));
    }
    if (d && method === 'POST') {
      if (!local) throw new HttpError(403, 'Only the person adds a rule from their decisions.');
      const { action, by } = await bodyOf(req, MemoryAction);
      const { room, data } = await app.brands.read(b);
      const suggestion = (await app.memory.view(b, data)).suggestions.find((s) => s.id === d);
      if (!suggestion) throw new HttpError(404, 'That suggestion is gone: added, dismissed, or no longer what the decisions say.');
      await app.memory.dismiss(b, d);
      if (action === 'add') {
        const origin = personOrigin(by);
        room.doc.transact(() => {
          if ('rule' in suggestion.action) upsertBrandItem(room.doc, 'rules', { ...suggestion.action.rule, source: 'memory', note: suggestion.why });
          else {
            setBrandField(room.doc, 'minContrast', suggestion.action.field.minContrast);
            markBrandFields(room.doc, ['minContrast'], false);
          }
        }, origin);
      }
      app.hub.broadcast({ t: 'memory', fileId: '', brandId: b });
      return sendJson(res, 200, { [action === 'add' ? 'added' : 'dismissed']: d });
    }
  }
  if (c === 'brief' && method === 'GET') {
    const { room, data } = await app.brands.read(b);
    const head = brandVersionHead(room.doc);
    const brief = brandBrief(data, { id: b, ...(head ? { version: head.n } : {}) });
    return sendJson(res, 200, { chars: brief.length, tokens_estimate: Math.round(brief.length / 4), brief, summary: brandSummary(data, head ? { version: head.n } : {}) });
  }
  // Brand drift: every linked file checked, its worst layers, and a summary kept over time.
  if (c === 'drift' && method === 'POST') {
    const { by, fileIds } = await bodyOf(req, Drift);
    return sendJson(res, 200, await app.brands.drift(b, `person:${by || 'editor'}`, fileIds ? { fileIds } : {}));
  }
  if (c === 'scores' && method === 'GET') {
    app.brands.requireBrand(b);
    const book = await app.scores.read(b);
    const linked = app.brands.linkedEntries(b);
    return sendJson(res, 200, { summary: book.summary, files: linked.map((f) => ({ file_id: f.id, file_name: f.name, points: book.files[f.id] ?? [] })) });
  }
  if (c === 'diff' && method === 'GET') return sendJson(res, 200, await app.brands.diff(b, url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined));
  if (c === 'impact' && method === 'GET') return sendJson(res, 200, await app.brands.impact(b));
  if (c === 'apply' && method === 'POST') {
    const { fileIds, by } = await bodyOf(req, Apply);
    return sendJson(res, 200, await app.brands.apply(b, fileIds ?? null, by ?? 'A person', personOrigin(by)));
  }
  if (c === 'sheet.html' && method === 'GET') {
    const { room, data } = await app.brands.read(b);
    const { doc, rootId } = app.brands.sheetDoc(data, room.doc);
    try {
      // With everything inlined: a sandboxed frame has no origin of its own, so it could not load from this server.
      const html = await exportTarget(doc, app.renderer, app.storage, { nodeIds: [rootId] }, 'html');
      // It holds what brands say, which may come from another device. Nothing in it may run.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src data:; font-src data: https://fonts.gstatic.com; style-src 'unsafe-inline' https://fonts.googleapis.com; sandbox", 'Cache-Control': 'no-store' });
      res.end(html.bytes);
    } finally {
      doc.y.destroy();
    }
    return;
  }
  if (c === 'sheet.png' && method === 'GET') {
    const { room, data } = await app.brands.read(b);
    const { doc, rootId } = app.brands.sheetDoc(data, room.doc);
    try {
      const shot = await app.renderer.screenshot(doc, { nodeIds: [rootId] }, { format: 'png', scale: 1, maxDimension: 4000 });
      res.writeHead(200, { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      res.end(shot.bytes);
    } finally {
      doc.y.destroy();
    }
    return;
  }
  if (c === 'guide.md' && method === 'GET') {
    const { room, data, entry } = await app.brands.read(b);
    const head = brandVersionHead(room.doc);
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${safeFileName(entry.name)} brand guide.md"`, 'X-Content-Type-Options': 'nosniff' });
    res.end(brandMarkdown(data, head ? { version: head.n } : {}));
    return;
  }
  if (c === 'guide.pdf' && method === 'GET') {
    const { room, data, entry } = await app.brands.read(b);
    const { doc, rootId } = app.brands.sheetDoc(data, room.doc);
    try {
      const out = await exportTarget(doc, app.renderer, app.storage, { nodeIds: [rootId] }, 'pdf');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${safeFileName(entry.name)} brand guide.pdf"`, 'X-Content-Type-Options': 'nosniff' });
      res.end(out.bytes);
    } finally {
      doc.y.destroy();
    }
    return;
  }
  throw new HttpError(404, `No route for ${method} ${url.pathname}.`);
}

async function fileRoute(app: BogenServer, req: IncomingMessage, res: ServerResponse, fileId: string, what: string | undefined, method: string, local: boolean): Promise<void> {
  if (!FILE_ID.test(fileId)) throw new HttpError(404, 'No such file.');
  app.requireFile(fileId);
  const room = await app.rooms.get(fileId);
  const { doc } = room;

  if (!what) {
    if (method === 'GET') {
      const found = await app.brands.forRoom(room);
      const note = await app.brands.note(room);
      const head = found?.doc ? brandVersionHead(found.doc) : null;
      const linkedVersion = found?.doc ? brandVersions(found.doc).find((v) => v.id === found.link.version)?.n ?? null : null;
      return sendJson(res, 200, {
        link: brandLinkOf(doc), note, version: head?.n ?? null, linkedVersion, updateAvailable: Boolean(head && found && head.id !== found.link.version),
        waivers: readWaivers(doc), report: app.brands.lastReport(fileId) ?? null,
        // The brand's primary language where it sets one: the soft default of the file's design language.
        language: (found?.data ? bindingFields(found.data).language : '') || null,
        // All the languages it speaks, the primary first.
        languages: found?.data ? spokenLanguages(found.data) : [],
      });
    }
    if (method === 'PUT') {
      const { brandId } = await bodyOf(req, Link);
      return sendJson(res, 200, await app.brands.link(fileId, brandId, 'person:editor'));
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  if (what === 'check' && method === 'POST') {
    const body = await bodyOf(req, Check);
    const found = await app.brands.forRoom(room);
    if (!found) throw new HttpError(409, 'This file has no brand.');
    if (!found.data) throw new HttpError(409, 'The brand of this file is not on this device.');
    const scope = scopeOf(doc, body.nodeId, body.pageId);
    let report = body.mode === 'static' ? checkStatic(doc, found.data, layersIn(doc, scope), 'file' in scope) : await checkRendered(doc, found.data, app.renderer, scope);
    let fixed: { node_id: string; rule: string; what: string }[] = [];
    if (body.fix) {
      room.undoManagerFor('brand');
      fixed = applySafeFixes(doc, found.data, report.violations, 'agent:brand').fixed;
      report = body.mode === 'static' ? checkStatic(doc, found.data, layersIn(doc, scope), 'file' in scope) : await checkRendered(doc, found.data, app.renderer, scope);
    }
    if ('file' in scope && body.mode === 'rendered') await app.brands.recordCheck(room, report, 'person:editor');
    const history = found.link ? (await app.scores.read(found.link.id)).files[fileId] ?? [] : [];
    return sendJson(res, 200, { ...report, fixed, history: history.slice(-30).map((p) => ({ at: p.at, score: p.score })) } satisfies BrandReport & { fixed: unknown; history: unknown });
  }

  // A waiver is a person's decision. Only their browser or their own machine can make one, and no MCP tool can.
  if (what === 'waivers') {
    if (!local) throw new HttpError(403, 'Only a person on this device can waive a rule.');
    if (method === 'POST') {
      const body = await bodyOf(req, Waive);
      if (!doc.getNode(body.nodeId)) throw new HttpError(400, `No layer with id ${body.nodeId}.`);
      setWaiver(doc, body, `person:${body.by}`);
      return sendJson(res, 200, { waivers: readWaivers(doc) });
    }
    if (method === 'DELETE') {
      const body = await bodyOf(req, Unwaive);
      setWaiver(doc, { ...body, remove: true }, 'person:editor');
      return sendJson(res, 200, { waivers: readWaivers(doc) });
    }
  }
  throw new HttpError(404, `No route for ${method} /api/files/${fileId}/brand/${what}.`);
}
