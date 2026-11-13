import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { safeCssValue, type NewNode } from '@bogen/core';
import { finishCapture } from './capture.ts';
import { EXTENSION_ROUTE, isExtensionOrigin } from './extension-origin.ts';
import { recordCapture } from './capture-modes.ts';
import type { SheetScan } from './capture-sheets.ts';
import { formatCode, newPairingCode } from './phone.ts';
import { docTree, imagePalette, typeSummary, type Reference } from './references.ts';
import { RESTYLE_NOTICE } from './restyle.ts';
import { atomicWriteSync, errorMessage, HttpError } from './util.ts';
import type { BogenServer } from './http/server.ts';

/**
 * The browser extension (integrations/browser-extension): it captures the person's own tab, logged in or on this
 * computer, and sends it here. It is a foreign Origin, so it gets in only on the few routes below, only on a server
 * that listens on this computer, and only after the person approved it in the editor: then it holds a token that does
 * one thing, add a capture. It cannot read, change or delete a design, and the person can revoke it in Settings.
 */
export { EXTENSION_ROUTE, isExtensionOrigin };

/** What an extension's own routes answer to a browser: its Origin only, never `*`. */
export function extensionCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!isExtensionOrigin(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204, {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-bogen-poll',
    'Access-Control-Max-Age': '600',
    ...(req.headers['access-control-request-private-network'] === 'true' ? { 'Access-Control-Allow-Private-Network': 'true' } : {}),
  });
  res.end();
  return true;
}

export interface ExtensionPairing { id: string; name: string; origin: string; hash: string; pairedAt: number; usedAt: number | null }
interface PendingPairing { id: string; code: string; origin: string; name: string; createdAt: number; poll: string; state: 'waiting' | 'approved' | 'denied'; token?: string }

const PENDING_MS = 5 * 60_000;
const MAX_PENDING = 4;
const MAX_PAIRINGS = 20;
const USED_SAVE_MS = 60_000;

const hashOf = (secret: string) => createHash('sha256').update(secret).digest('hex');
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
const bearer = (req: IncomingMessage) => {
  const auth = req.headers.authorization;
  return auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
};

/** Paired extensions and the requests waiting for the person. Tokens are kept as hashes, in BOGEN_HOME. */
export class ExtensionPairings {
  private readonly path: string;
  private data: { pairings: ExtensionPairing[]; fileId?: string };
  private pending = new Map<string, PendingPairing>();
  private savedUse = 0;

  constructor(home: string, private readonly changed: () => void = () => {}, private readonly now: () => number = Date.now) {
    this.path = join(home, 'extension-pairings.json');
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<typeof this.data>;
      this.data = { pairings: Array.isArray(raw.pairings) ? raw.pairings : [], ...(typeof raw.fileId === 'string' ? { fileId: raw.fileId } : {}) };
    } catch {
      this.data = { pairings: [] };
    }
  }

  private save(): void {
    atomicWriteSync(this.path, `${JSON.stringify(this.data, null, 1)}\n`, { mode: 0o600 });
  }

  private sweep(): void {
    for (const [id, p] of this.pending) if (this.now() - p.createdAt > PENDING_MS) this.pending.delete(id);
  }

  /** An extension asks to pair. The person sees the same code in the editor and in the extension. */
  request(origin: string, name: string): { id: string; code: string; poll: string; expiresAt: number } {
    this.sweep();
    const waiting = [...this.pending.values()].filter((p) => p.state === 'waiting');
    if (waiting.length >= MAX_PENDING) throw new HttpError(429, 'Too many pairing requests are waiting. Answer them in the Bogen editor first.');
    // One open request per extension: asking again replaces the last one.
    for (const p of waiting) if (p.origin === origin) this.pending.delete(p.id);
    const pending: PendingPairing = { id: randomBytes(8).toString('hex'), code: formatCode(newPairingCode()), origin, name: name.trim().slice(0, 80) || 'Browser extension', createdAt: this.now(), poll: randomBytes(24).toString('base64url'), state: 'waiting' };
    this.pending.set(pending.id, pending);
    this.changed();
    return { id: pending.id, code: pending.code, poll: pending.poll, expiresAt: pending.createdAt + PENDING_MS };
  }

  /** The extension asks how its request went. The token is handed over once, to the one that asked. */
  poll(id: string, poll: string, origin: string): { state: 'waiting' | 'approved' | 'denied' | 'gone'; token?: string; pairingId?: string } {
    this.sweep();
    const p = this.pending.get(id);
    if (!p || p.origin !== origin || !sameHash(hashOf(p.poll), hashOf(poll))) return { state: 'gone' };
    if (p.state === 'waiting') return { state: 'waiting' };
    this.pending.delete(id);
    if (p.state === 'denied') return { state: 'denied' };
    return { state: 'approved', token: p.token!, pairingId: this.data.pairings.find((x) => sameHash(x.hash, hashOf(p.token!)))?.id };
  }

  cancel(id: string, poll: string, origin: string): void {
    const p = this.pending.get(id);
    if (p && p.origin === origin && sameHash(hashOf(p.poll), hashOf(poll))) {
      this.pending.delete(id);
      this.changed();
    }
  }

  /** What the editor shows: requests still waiting, without their secrets. */
  requests(): { id: string; code: string; origin: string; name: string; expiresAt: number }[] {
    this.sweep();
    return [...this.pending.values()].filter((p) => p.state === 'waiting').map((p) => ({ id: p.id, code: p.code, origin: p.origin, name: p.name, expiresAt: p.createdAt + PENDING_MS }));
  }

  decide(id: string, allow: boolean): ExtensionPairing | null {
    this.sweep();
    const p = this.pending.get(id);
    if (!p || p.state !== 'waiting') throw new HttpError(404, 'That request is no longer waiting. Pair again from the extension.');
    if (!allow) {
      p.state = 'denied';
      this.changed();
      return null;
    }
    if (this.data.pairings.length >= MAX_PAIRINGS) throw new HttpError(409, `${MAX_PAIRINGS} extensions are paired already. Revoke one in Settings, Privacy.`);
    const token = randomBytes(32).toString('base64url');
    const pairing: ExtensionPairing = { id: randomBytes(4).toString('hex'), name: p.name, origin: p.origin, hash: hashOf(token), pairedAt: this.now(), usedAt: null };
    p.state = 'approved';
    p.token = token;
    this.data.pairings.push(pairing);
    this.save();
    this.changed();
    return pairing;
  }

  list(): Omit<ExtensionPairing, 'hash'>[] {
    return this.data.pairings.map(({ hash: _hash, ...rest }) => rest);
  }

  revoke(id: string): boolean {
    const before = this.data.pairings.length;
    this.data.pairings = this.data.pairings.filter((p) => p.id !== id);
    if (before === this.data.pairings.length) return false;
    this.save();
    this.changed();
    return true;
  }

  /** The pairing a request's token belongs to, when its Origin is the one that paired (or it sends none). */
  authenticate(req: IncomingMessage): ExtensionPairing | null {
    const token = bearer(req);
    if (!token) return null;
    const hash = hashOf(token);
    const pairing = this.data.pairings.find((p) => sameHash(p.hash, hash));
    if (!pairing) return null;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== pairing.origin) return null;
    pairing.usedAt = this.now();
    if (this.now() - this.savedUse > USED_SAVE_MS) {
      this.savedUse = this.now();
      this.save();
    }
    return pairing;
  }

  /** The file captures go into, made the first time. */
  targetFile(app: BogenServer): string {
    if (this.data.fileId && app.storage.get(this.data.fileId)) return this.data.fileId;
    this.data.fileId = app.createFile('Browser captures').id;
    this.save();
    return this.data.fileId;
  }
}

const NODE_TYPES = new Set(['frame', 'text', 'image', 'svg', 'video', 'embed']);
const MAX_NODES = 30_000;
const MAX_BODY = 160 * 1024 * 1024;

/**
 * A capture from a browser is data from somewhere else: only the fields the capture script writes, as strings of
 * bounded size, styles a style element can hold. What renders is checked again when it renders.
 */
export function cleanCaptureTree(input: unknown): NewNode & { key?: number } {
  let count = 0;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const visit = (raw: unknown, depth: number): (NewNode & { key?: number }) | null => {
    if (!raw || typeof raw !== 'object' || depth > 300 || ++count > MAX_NODES) return null;
    const n = raw as Record<string, unknown>;
    const type = typeof n.type === 'string' && NODE_TYPES.has(n.type) ? n.type as NewNode['type'] : 'frame';
    const out: NewNode & { key?: number } = { type, tag: /^[a-z][a-z0-9-]{0,30}$/.test(String(n.tag)) ? String(n.tag) : 'div' };
    const name = str(n.name, 200);
    if (name) out.name = name;
    if (n.style && typeof n.style === 'object') {
      const style: Record<string, string> = {};
      for (const [k, v] of Object.entries(n.style as Record<string, unknown>).slice(0, 500)) {
        if (/^-?[A-Za-z][\w-]{0,60}$/.test(k) && typeof v === 'string' && v.length <= 16 * 1024 * 1024 && safeCssValue(v)) style[k] = v;
      }
      out.style = style;
    }
    const text = str(n.text, 200_000);
    if (text !== undefined) out.text = text;
    const src = str(n.src, 16 * 1024 * 1024);
    if (src) out.src = src;
    const svg = str(n.svg, 4 * 1024 * 1024);
    if (svg) out.svg = svg;
    if (n.attrs && typeof n.attrs === 'object') {
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(n.attrs as Record<string, unknown>).slice(0, 40)) if (/^[a-z][a-z-]{0,30}$/.test(k) && typeof v === 'string') attrs[k] = v.slice(0, 4000);
      out.attrs = attrs;
    }
    if (Number.isInteger(n.key)) out.key = n.key as number;
    if (Array.isArray(n.children)) out.children = n.children.flatMap((c) => visit(c, depth + 1) ?? []);
    return out;
  };
  const root = visit(input, 0);
  if (!root) throw new HttpError(400, 'The capture has no layers.');
  return root;
}

const Rect = z.object({ x: z.number().min(-1e6).max(1e6), y: z.number().min(-1e6).max(1e6), width: z.number().min(1).max(20_000), height: z.number().min(1).max(60_000) });
const ExtensionCapture = z.object({
  url: z.string().url().max(4000).refine((u) => /^https?:/i.test(u), 'Only http and https pages.'),
  title: z.string().max(500).default(''),
  mode: z.enum(['page', 'region', 'element']).default('page'),
  /** The layout width of what was captured: the window for a page or region, the element for an element. */
  width: z.number().min(20).max(10_000),
  colorScheme: z.enum(['light', 'dark']).optional(),
  region: Rect.optional(),
  capture: z.object({
    root: z.unknown(),
    tokens: z.array(z.object({ name: z.string().max(200), value: z.string().max(4000) })).max(3000).default([]),
    title: z.string().max(500).default(''),
    links: z.array(z.string().max(4000)).max(10_000).default([]),
  }),
  scan: z.object({
    faces: z.array(z.object({ family: z.string().max(200), src: z.string().max(200_000), base: z.string().max(4000) }).catchall(z.string().max(2000).optional())).max(500).default([]),
    usedFamilies: z.array(z.string().max(200)).max(500).default([]),
    rules: z.array(z.object({ states: z.array(z.string().max(20)).max(5), selector: z.string().max(2000), declarations: z.string().max(4000), condition: z.string().max(2000).optional(), keys: z.array(z.number().int()).max(200), matches: z.number().int() })).max(2000).default([]),
  }).default({ faces: [], usedFamilies: [], rules: [] }),
  /** Font files the extension read itself, as base64 by the URL the page used. */
  fonts: z.record(z.string().max(4000), z.string()).default({}),
  /** What the tab showed, as a PNG or JPEG data URL. */
  screenshot: z.string().max(64 * 1024 * 1024).optional(),
  reference: z.boolean().default(false),
  tags: z.array(z.string().max(40)).max(12).default([]),
});

function dataUrlBytes(value: string | undefined): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(value ?? '');
  return m ? { bytes: new Uint8Array(Buffer.from(m[2]!, 'base64')), mime: m[1]! } : null;
}

export interface ExtensionRouteContext {
  /** The request came from this computer, not through a proxy or another listener. */
  local: boolean;
  send: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage, limit: number) => Promise<Buffer>;
  json: <S extends z.ZodType>(req: IncomingMessage, schema: S) => Promise<z.output<S>>;
}

/** `/api/extension/...`: the extension's own routes, and the editor's to approve, list and revoke. */
export async function handleExtensionRoute(app: BogenServer, req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], ctx: ExtensionRouteContext): Promise<void> {
  const [, b, c, d] = parts;
  const method = req.method ?? 'GET';
  const store = app.extensions;
  if (!ctx.local) throw new HttpError(403, 'The browser extension pairs only with Bogen on this computer.');
  const origin = req.headers.origin;

  if (EXTENSION_ROUTE.test(url.pathname)) {
    if (b === 'pair' && !c && method === 'POST') {
      if (!isExtensionOrigin(origin)) throw new HttpError(403, 'Only a browser extension can ask to pair.');
      const { name } = await ctx.json(req, z.object({ name: z.string().max(200).default('Browser extension') }));
      return ctx.send(res, 201, store.request(origin, name));
    }
    if (b === 'pair' && c) {
      const poll = String(req.headers['x-bogen-poll'] ?? '');
      if (!isExtensionOrigin(origin)) throw new HttpError(403, 'Only the extension that asked.');
      if (method === 'GET') return ctx.send(res, 200, store.poll(c, poll, origin));
      if (method === 'DELETE') { store.cancel(c, poll, origin); return ctx.send(res, 200, { ok: true }); }
      throw new HttpError(405, 'Method not allowed.');
    }
    const pairing = store.authenticate(req);
    if (!pairing) throw new HttpError(401, 'This extension is not paired, or it was revoked. Pair it again from its popup.');
    if (b === 'status' && method === 'GET') return ctx.send(res, 200, { paired: true, id: pairing.id, name: pairing.name, notice: RESTYLE_NOTICE });
    // The extension forgets its own pairing: the one thing besides capturing that its token may do.
    if (b === 'status' && method === 'DELETE') { store.revoke(pairing.id); return ctx.send(res, 200, { revoked: pairing.id }); }
    if (b === 'capture' && method === 'POST') {
      let body: z.output<typeof ExtensionCapture>;
      try {
        body = ExtensionCapture.parse(JSON.parse((await ctx.readBody(req, MAX_BODY)).toString('utf8')));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, e instanceof z.ZodError ? e.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : 'The body is not valid JSON.');
      }
      return ctx.send(res, 201, await placeExtensionCapture(app, body, pairing));
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  // The person, in the editor or with the CLI on this computer. A browser extension's Origin never reaches these.
  if (isExtensionOrigin(origin)) throw new HttpError(403, 'Not for browser extensions.');
  if (b === 'requests' && !c && method === 'GET') return ctx.send(res, 200, store.requests());
  if (b === 'requests' && c && (d === 'approve' || d === 'deny') && method === 'POST') {
    const pairing = store.decide(c, d === 'approve');
    return ctx.send(res, 200, pairing ? { approved: true, pairing: { id: pairing.id, name: pairing.name, origin: pairing.origin } } : { approved: false });
  }
  if (b === 'pairings' && !c && method === 'GET') return ctx.send(res, 200, store.list());
  if (b === 'pairings' && c && !d && method === 'DELETE') {
    if (!store.revoke(c)) throw new HttpError(404, 'No such paired extension.');
    return ctx.send(res, 200, { revoked: c });
  }
  throw new HttpError(404, 'Not found.');
}

async function placeExtensionCapture(app: BogenServer, body: z.output<typeof ExtensionCapture>, pairing: ExtensionPairing): Promise<Record<string, unknown>> {
  const pageUrl = new URL(body.url);
  const width = Math.round(body.width);
  const fonts = new Map<string, Uint8Array>();
  for (const [u, b64] of Object.entries(body.fonts)) {
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length) fonts.set(u.split('#')[0]!, new Uint8Array(bytes));
  }
  const shot = dataUrlBytes(body.screenshot);
  const root = cleanCaptureTree(body.capture.root);
  // Only public addresses are fetched here: whatever the tab could read, the extension already sent.
  const result = await finishCapture(app.storage, {
    captured: { root, tokens: body.capture.tokens, title: body.capture.title || body.title, links: body.capture.links },
    scan: body.scan as SheetScan, resources: { fonts }, url: pageUrl, local: false, width, original: shot?.bytes ?? new Uint8Array(),
  });
  if (body.mode === 'region' && body.region) {
    const r = body.region;
    const inner = result.root;
    delete inner.artboard;
    inner.style = { ...inner.style, position: 'absolute', left: `${-Math.round(r.x)}px`, top: `${-Math.round(r.y)}px`, width: `${width}px` };
    result.root = { type: 'frame', tag: 'div', name: 'Region', artboard: true, style: { position: 'absolute', width: `${Math.round(r.width)}px`, height: `${Math.round(r.height)}px`, overflow: 'hidden', ...(inner.style.backgroundColor ? { backgroundColor: inner.style.backgroundColor } : {}) }, children: [inner] };
  }
  const origin = 'capture';
  const fileId = app.extensions.targetFile(app);
  const { doc } = await app.rooms.get(fileId);
  const host = pageUrl.hostname || 'Captures';
  const pageId = doc.getPages().find((p) => p.name === host)?.id ?? doc.createPage(host, origin);
  const label = body.mode === 'page' ? '' : body.mode === 'region' ? ', region' : ', element';
  const name = `${(body.title || body.capture.title || host).slice(0, 160)}${label}`;
  const { nodeId } = app.placeCapture(fileId, doc, result, { name, pageId, url: body.url }, origin);
  recordCapture(doc, nodeId, body.url, body.colorScheme ?? 'light', origin);
  const original = shot ? await app.storage.putAsset(shot.bytes, shot.mime) : null;
  let reference: Reference | undefined;
  let referenceError: string | undefined;
  if (body.reference) {
    try {
      const tokens = new Map(doc.getTokens().map((t) => [t.name, t.value] as [string, string]));
      reference = app.references.add({
        title: name, source: 'extension', url: body.url, fileId, nodeId, tags: body.tags,
        ...(original ? { image: original.src } : {}),
        palette: original ? await imagePalette(app.storage, app.renderer, original.src) : [],
        type: typeSummary(docTree(doc, nodeId), tokens),
      });
    } catch (e) {
      referenceError = errorMessage(e);
    }
  }
  return {
    fileId, pageId, nodeId, layers: result.stats.layers, images: result.stats.images, failedImages: result.stats.failedImages.length,
    fonts: result.fonts.families, googleFonts: result.fonts.google, open: `/#/file/${fileId}`, by: pairing.name,
    ...(original ? { original: original.url } : {}), ...(reference ? { reference: reference.id } : {}), ...(referenceError ? { referenceError } : {}),
    notice: RESTYLE_NOTICE,
  };
}
