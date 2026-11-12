import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BogenDoc } from '@bogen/core';
import { z } from 'zod';
import { besideArtboard, nextArtboardX } from '../mcp/kit.ts';
import { compareWithScreen, exportLive, insertImport, recordFor, listDevices, MAX_SCREEN_PNG, parseScreen, planImport, readBundle, storeScreenshot, tomaccoStatus, type AppScreen, type Comparison } from '../tomacco.ts';
import { errorMessage, HttpError } from '../util.ts';
import type { BogenServer } from './server.ts';
import { fromOwner, fromThisDevice, readBody, sendJson } from './server.ts';
import type { GuardOptions } from './security.ts';

/**
 * App screens from Tomacco, for the editor:
 * - `GET /api/tomacco/devices` → `{available, devices, notes}`, from this machine only
 * - `GET /api/tomacco/status[?fresh=1]`: whether a screen can be taken now (`missing`, `no-device` or `ready`), with
 *   the command that fixes it from `tomaccoctl doctor`; from this machine only. Bogen shows the command, never runs it
 * - `POST /api/tomacco/screen {source}` → `{screenId, summary, png}`: reads a screen once and keeps it for ten minutes,
 *   so that a preview, an import and a comparison need one capture. `source` is `{device, platform?}` or `{path}`
 *   (this machine only) or `{json, png}` with the picture as base64 (an upload, which a paired phone may send too)
 * - `POST /api/tomacco/import {fileId, pageId?, screenId | source, text?, frame?, screenshot?, name?, beside?, plan?}`: the artboard,
 *   or with `plan` only its layers and record, which the editor inserts as one step of its own undo. `beside` is a layer id:
 *   the screen goes to the right of its artboard, at the same top, on its page
 * - `POST /api/tomacco/compare {fileId, nodeId, screenId | source}` → the comparison, with the pictures as base64
 * Not on the tailnet listener: only the person, here or on a paired phone.
 */

const UPLOAD_LIMIT = Math.ceil(MAX_SCREEN_PNG * 1.4) + 8 * 1024 * 1024;
const KEEP_MS = 10 * 60_000;
const KEEP_COUNT = 6;
const Id = z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/);

const Source = z.union([
  z.object({ device: z.string().regex(/^[\w.:-]{1,200}$/), platform: z.enum(['android', 'ios']).optional() }),
  z.object({ path: z.string().min(1).max(4096) }),
  z.object({ json: z.unknown(), png: z.string().min(8) }),
]);
const ScreenBody = z.object({ source: Source });
const ImportBody = z.object({
  fileId: Id, pageId: Id.optional(), screenId: z.string().regex(/^[a-f0-9]{16}$/).optional(), source: Source.optional(),
  text: z.boolean().default(true), frame: z.boolean().default(false), screenshot: z.boolean().default(true), name: z.string().trim().min(1).max(200).optional(),
  /** Only work it out: the editor inserts it itself, so that it is one step of its own undo. */
  plan: z.boolean().default(false), x: z.number().optional(), y: z.number().optional(),
  /** Place it beside this layer's artboard instead of after the last one. */
  beside: Id.optional(),
});
const CompareBody = z.object({ fileId: Id, nodeId: Id, screenId: z.string().regex(/^[a-f0-9]{16}$/).optional(), source: Source.optional() });

const kept = new Map<string, { screen: AppScreen; at: number }>();

function keep(screen: AppScreen): string {
  const now = Date.now();
  for (const [id, entry] of kept) if (now - entry.at > KEEP_MS) kept.delete(id);
  while (kept.size >= KEEP_COUNT) kept.delete(kept.keys().next().value!);
  const id = randomBytes(8).toString('hex');
  kept.set(id, { screen, at: now });
  return id;
}

async function body<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.output<S>> {
  const raw = await readBody(req, UPLOAD_LIMIT);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not JSON.');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new HttpError(400, `Invalid request: ${result.error.issues[0]?.message ?? 'bad body'}`);
  return result.data;
}

/** A screen from where the request says. A device or a path uses this machine, so only a request from it may. */
async function readSource(source: z.output<typeof Source>, local: boolean): Promise<AppScreen> {
  try {
    if ('json' in source) {
      const raw = typeof source.json === 'string' ? JSON.parse(source.json) as unknown : source.json;
      return parseScreen(raw, new Uint8Array(Buffer.from(source.png.replace(/^data:[^,]*,/, ''), 'base64')));
    }
    if (!local) throw new HttpError(403, 'Devices and folders of this computer are read only from this computer. Upload the export instead.');
    return 'device' in source ? await exportLive(source.device, source.platform) : await readBundle(source.path);
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(400, errorMessage(e));
  }
}

async function screenFor(input: { screenId?: string; source?: z.output<typeof Source> }, local: boolean): Promise<AppScreen> {
  if (input.screenId) {
    const found = kept.get(input.screenId);
    if (!found) throw new HttpError(404, 'That screen is no longer kept. Read it again.');
    return found.screen;
  }
  if (!input.source) throw new HttpError(400, 'Give screenId or source.');
  return readSource(input.source, local);
}

export function screenSummary(screen: AppScreen): Record<string, unknown> {
  const j = screen.json;
  return {
    platform: screen.platform, device: j.device.id ?? null, model: j.device.model ?? null, os: [j.device.os_name, j.device.os_version].filter(Boolean).join(' ') || null,
    width: screen.width, height: screen.height, unit: screen.unit, scale: screen.scale, scaleGuessed: screen.scaleGuessed,
    widthPx: j.display.width_px, heightPx: j.display.height_px, elements: screen.elements.length, elementsSource: j.elements_source ?? null,
    app: j.app?.package ?? null, theme: j.theme?.mode ?? null, capturedAt: j.captured_at ?? null, warnings: screen.warnings,
  };
}

export function comparisonJson(out: Comparison, screen: AppScreen): Record<string, unknown> {
  return {
    percent: out.percent, differentPixels: out.differentPixels, totalPixels: out.totalPixels, bounds: out.bounds, scale: out.scale, unit: out.unit,
    matched: out.matched, onlyInDesign: out.onlyInDesign, onlyInApp: out.onlyInApp, warnings: out.warnings,
    width: screen.width, height: screen.height,
    images: { diff: Buffer.from(out.diff).toString('base64'), design: Buffer.from(out.design).toString('base64'), app: Buffer.from(screen.png).toString('base64') },
  };
}

/** Places a screen as an artboard, as one change by `origin`. */
export async function importScreenInto(app: BogenServer, fileId: string, screen: AppScreen, options: { pageId?: string; text?: boolean; frame?: boolean; screenshot?: boolean; name?: string; beside?: string }, write: <T>(fn: () => T) => T): Promise<{ nodeId: string; pageId: string; width: number; height: number; unit: string; stats: Record<string, number>; warnings: string[] }> {
  const room = await app.rooms.get(fileId);
  const at = placement(room.doc, screen, options);
  const src = await storeScreenshot(app.storage, screen);
  const plan = await planImport(app.renderer, screen, src, { ...options, ...at });
  const pageId = at.pageId;
  const nodeId = write(() => insertImport(room.doc, pageId, screen, plan, src));
  return { nodeId, pageId, width: plan.width, height: plan.height, unit: screen.unit, stats: plan.stats, warnings: plan.warnings };
}

/** The frame adds 12 on each side, as planImport draws it. */
const FRAME = 24;

/**
 * Where an imported screen goes: beside the given layer's artboard, on its page, when there is one; otherwise after
 * the last artboard of the page.
 */
export function placement(doc: BogenDoc, screen: AppScreen, options: { pageId?: string; frame?: boolean; beside?: string }): { pageId: string; x: number; y: number } {
  if (options.beside) {
    if (!doc.getNode(options.beside)) throw new HttpError(404, `No layer with id ${options.beside} to put the screen beside.`);
    const pad = options.frame ? FRAME : 0;
    const spot = besideArtboard(doc, options.beside, screen.width + pad, screen.height + pad);
    if (spot) return spot;
  }
  const pageId = options.pageId ?? doc.getPages()[0]?.id;
  if (!pageId || !doc.pages.has(pageId)) throw new HttpError(404, 'No such page.');
  return { pageId, x: nextArtboardX(doc, pageId), y: 0 };
}

export async function handleTomacco(app: BogenServer, req: IncomingMessage, res: ServerResponse, parts: string[], guard: GuardOptions): Promise<boolean> {
  const [a, b, c] = parts;
  if (a !== 'tomacco' || c) return false;
  const method = req.method ?? 'GET';
  const local = fromThisDevice(req, guard);
  if (!fromOwner(req, guard)) throw new HttpError(403, 'App screens are read only for the person, on this computer or a phone paired with it.');
  if (b === 'devices' && method === 'GET') {
    if (!local) throw new HttpError(403, 'Only from this computer.');
    try {
      sendJson(res, 200, await listDevices());
    } catch (e) {
      sendJson(res, 200, { available: true, devices: [], notes: [errorMessage(e)] });
    }
    return true;
  }
  if (b === 'status' && method === 'GET') {
    if (!local) throw new HttpError(403, 'Only from this computer.');
    const fresh = new URL(req.url ?? '/', 'http://localhost').searchParams.get('fresh') === '1';
    sendJson(res, 200, await tomaccoStatus({ fresh }));
    return true;
  }
  if (b === 'screen' && method === 'POST') {
    const { source } = await body(req, ScreenBody);
    const screen = await readSource(source, local);
    sendJson(res, 200, { screenId: keep(screen), summary: screenSummary(screen), png: Buffer.from(screen.png).toString('base64') });
    return true;
  }
  if (b === 'import' && method === 'POST') {
    const input = await body(req, ImportBody);
    app.requireFile(input.fileId);
    const screen = await screenFor(input, local);
    const room = await app.rooms.get(input.fileId);
    if (input.plan) {
      const src = await storeScreenshot(app.storage, screen);
      const at = input.x === undefined ? placement(room.doc, screen, input) : { pageId: input.pageId ?? room.doc.getPages()[0]?.id ?? '', x: input.x, y: input.y ?? 0 };
      const plan = await planImport(app.renderer, screen, src, { ...input, x: at.x, y: at.y });
      sendJson(res, 200, { spec: plan.spec, record: recordFor(screen, src), pageId: at.pageId, x: at.x, y: at.y, width: plan.width, height: plan.height, unit: screen.unit, stats: plan.stats, warnings: plan.warnings });
      return true;
    }
    const out = await importScreenInto(app, input.fileId, screen, input, (fn) => room.doc.transact(fn, 'person:editor'));
    sendJson(res, 201, out);
    return true;
  }
  if (b === 'compare' && method === 'POST') {
    const input = await body(req, CompareBody);
    app.requireFile(input.fileId);
    const screen = await screenFor(input, local);
    const room = await app.rooms.get(input.fileId);
    try {
      sendJson(res, 200, comparisonJson(await compareWithScreen(room.doc, app.renderer, input.nodeId, screen), screen));
    } catch (e) {
      throw new HttpError(/^No layer|no size/.test(errorMessage(e)) ? 400 : 500, errorMessage(e));
    }
    return true;
  }
  throw new HttpError(405, 'Method not allowed.');
}
