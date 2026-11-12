import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { escapeAttr, type BogenDoc } from '@bogen/core';
import type { Publisher } from './publish.ts';
import { baseHeaders, refuseText, type Gate } from './static-listener.ts';
import { atomicWrite, errorMessage, HttpError } from './util.ts';

/**
 * Review links: one page or artboard, frozen as a version, for a client to open in any browser. The link is a
 * 128-bit random token in the path, which is all a client has: no cookie, no account. Only its SHA-256 is kept, so
 * the link is shown once, when the owner makes it. It expires, can be revoked, and can have a view limit.
 *
 * Clients may leave comments through a plain HTML form. They land in a quarantine inbox on this machine, not in
 * the document, as plain text with mentions taken out. The owner accepts them into the file as comments, marked as
 * a client's, or deletes them. Nothing a client sends can start an agent.
 */

const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const DAY = 86_400_000;
export const SHARE_DEFAULT_DAYS = 14;
const NAME_MAX = 80;
const TEXT_MAX = 2000;
const BODY_MAX = 8 * 1024;
const PER_LINK = { count: 20, windowMs: 60 * 60_000 };
const PER_IP = { count: 5, windowMs: 10 * 60_000 };
const INBOX_MAX = 500;
/** The width the picture of the page has in the form, in CSS pixels: where a click lands is read against it. */
export const SHOT_WIDTH = 320;

const Share = z.object({
  id: z.string().regex(/^[a-f0-9]{12}$/), siteId: z.string(), versionId: z.string(), label: z.string().max(80),
  hash: z.string(), createdAt: z.number(), expiresAt: z.number(), maxViews: z.number().int().positive().optional(),
  views: z.number().int().default(0), comments: z.boolean(), revokedAt: z.number().optional(), lastViewAt: z.number().optional(),
});
export type ShareLink = z.output<typeof Share>;

const ClientComment = z.object({
  id: z.string().regex(/^[a-f0-9]{12}$/), shareId: z.string(), siteId: z.string(), versionId: z.string(), page: z.number().int().min(0),
  name: z.string().max(NAME_MAX), text: z.string().max(TEXT_MAX), x: z.number().optional(), y: z.number().optional(), at: z.number(),
  mentionsRemoved: z.boolean().default(false),
});
export type ClientCommentItem = z.output<typeof ClientComment>;

const State = z.object({ shares: z.array(Share).default([]), inbox: z.array(ClientComment).default([]) });

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * `@claude` becomes `claude`, and so does every other mention: a client's words never ask for anyone. The full width
 * and small at signs count too. Run it on text that is already plain, or a character taken out later could join an
 * `@` to a name again.
 */
export function stripMentions(text: string): string {
  return text.replace(/(^|[^\p{L}\p{N}_.+-])[@＠﹫]+(?=[\p{L}\p{N}_-])/gu, '$1');
}

/** A client's words as plain text: no markup, no control characters, within its limit. */
export function plainClientText(text: string, max: number): string {
  return text.normalize('NFC')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

export type ShareState = 'active' | 'expired' | 'revoked' | 'used up';

export function shareState(share: ShareLink, now = Date.now()): ShareState {
  if (share.revokedAt || !share.hash) return 'revoked';
  if (share.expiresAt <= now) return 'expired';
  if (share.maxViews !== undefined && share.views >= share.maxViews) return 'used up';
  return 'active';
}

export interface SharesDeps {
  home: string;
  publisher: Publisher;
  doc: (fileId: string) => Promise<BogenDoc>;
  changed?: () => void;
}

const REVIEW_CSS = `.bgr{position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:calc(100vw - 32px);font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d1d1c}
.bgr details{background:#fff;border:1px solid #d8d7d4;border-radius:6px;box-shadow:0 8px 30px rgba(0,0,0,.18)}
.bgr summary{cursor:pointer;padding:10px 14px;font-weight:600;list-style:none}
.bgr summary::-webkit-details-marker{display:none}
.bgr form{display:flex;flex-direction:column;gap:8px;padding:0 14px 14px;width:${SHOT_WIDTH}px;max-width:100%;box-sizing:border-box}
.bgr label{display:flex;flex-direction:column;gap:2px;font-size:13px;color:#555}
.bgr input[type=text],.bgr textarea{font:inherit;padding:6px 8px;border:1px solid #c9c8c4;border-radius:4px;color:#1d1d1c;background:#fff}
.bgr textarea{min-height:72px;resize:vertical}
.bgr p{margin:0;font-size:13px;color:#555}
.bgr .bgr-shot{display:block;width:${SHOT_WIDTH}px;max-width:100%;height:auto;border:1px solid #d8d7d4;cursor:crosshair}
.bgr button{font:inherit;font-weight:600;padding:7px 12px;border:0;border-radius:4px;background:#1d1d1c;color:#fff;cursor:pointer}
.bgr .bgr-sent{padding:0 14px 12px;color:#2b6b2b}
@media print{.bgr{display:none}}`;

export class Shares {
  private state: z.output<typeof State> = { shares: [], inbox: [] };
  private loaded = false;
  private write: Promise<void> = Promise.resolve();
  private byLink = new Map<string, number[]>();
  private byIp = new Map<string, number[]>();

  constructor(private readonly deps: SharesDeps) {}

  private get dir(): string {
    return join(this.deps.home, 'review');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.state = State.parse(JSON.parse(await readFile(join(this.dir, 'state.json'), 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`bogen: review/state.json was unreadable (${errorMessage(e)}), no review link works`);
    }
    // Long gone links are forgotten a month after they stopped working.
    const now = Date.now();
    this.state.shares = this.state.shares.filter((s) => shareState(s, now) === 'active' || now - Math.max(s.expiresAt, s.revokedAt ?? 0) < 30 * DAY);
  }

  private save(): Promise<void> {
    const body = `${JSON.stringify(this.state, null, 2)}\n`;
    this.write = this.write.catch(() => {}).then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await atomicWrite(join(this.dir, 'state.json'), body, 0o600);
    });
    this.deps.changed?.();
    return this.write;
  }

  /** Versions that a working link still shows. */
  inUse(): Set<string> {
    return new Set(this.state.shares.filter((s) => shareState(s) === 'active').map((s) => s.versionId));
  }

  /** For the editor: links without their hashes, and the inbox. */
  overview(siteIds?: Set<string>): { shares: (Omit<ShareLink, 'hash'> & { state: ShareState })[]; inbox: ClientCommentItem[] } {
    const shares = this.state.shares.filter((s) => !siteIds || siteIds.has(s.siteId)).map(({ hash: _hash, ...rest }) => ({ ...rest, state: shareState({ ...rest, hash: _hash }) }));
    return { shares, inbox: this.state.inbox.filter((c) => !siteIds || siteIds.has(c.siteId)) };
  }

  /**
   * A new link to a version. The token is made here and returned once; only its hash is kept. Only ever
   * called for the owner in the editor; the route checks that.
   */
  async create(input: { siteId: string; versionId: string; label: string; days?: number; maxViews?: number; comments: boolean }, origin: string | null): Promise<{ share: Omit<ShareLink, 'hash'>; url: string | null; token: string }> {
    const site = this.deps.publisher.site(input.siteId);
    const version = this.deps.publisher.version(input.siteId, input.versionId);
    const token = randomBytes(16).toString('base64url');
    const days = Math.min(90, Math.max(1, Math.round(input.days ?? SHARE_DEFAULT_DAYS)));
    const share = Share.parse({
      id: randomBytes(6).toString('hex'), siteId: site.id, versionId: version.id, label: input.label.trim().slice(0, 80) || 'Review link', hash: hashToken(token),
      createdAt: Date.now(), expiresAt: Date.now() + days * DAY, ...(input.maxViews ? { maxViews: input.maxViews } : {}), views: 0, comments: input.comments,
    });
    this.state.shares.push(share);
    await this.save();
    const { hash: _hash, ...rest } = share;
    return { share: rest, url: origin ? `${origin}/r/${token}/` : null, token };
  }

  async revoke(id: string): Promise<void> {
    const share = this.state.shares.find((s) => s.id === id);
    if (!share) throw new HttpError(404, 'No such link.');
    share.revokedAt = Date.now();
    share.hash = '';
    await this.save();
  }

  /** The link a token opens, if it still works. Expired, revoked, used up and unknown look the same from outside. */
  private find(token: string): ShareLink | null {
    if (!TOKEN.test(token)) return null;
    const hash = hashToken(token);
    const share = this.state.shares.find((s) => s.hash && s.hash === hash);
    return share && shareState(share) === 'active' ? share : null;
  }

  postAllowed(segments: string[]): boolean {
    return segments.length === 4 && segments[0] === 'r' && segments[2] === '_review' && segments[3] === 'comments';
  }

  /** The review listener: `/r/<token>/...`, and nothing else. */
  async handle(req: IncomingMessage, res: ServerResponse, gate: Gate): Promise<void> {
    const [r, token, ...rest] = gate.segments;
    const share = r === 'r' && token ? this.find(token) : null;
    if (!share) return refuseText(res, 404, 'This link does not work. It may have expired or been revoked.');
    const site = this.deps.publisher.sites().find((s) => s.id === share.siteId);
    const version = site?.versions.find((v) => v.id === share.versionId);
    if (!site || !version) return refuseText(res, 404, 'This link does not work. It may have expired or been revoked.');
    const base = `/r/${token}/`;
    if (!rest.length && !gate.dir) {
      res.writeHead(308, baseHeaders({ Location: base, 'Cache-Control': 'no-store' }));
      return void res.end();
    }
    const headers = { 'X-Robots-Tag': 'noindex, nofollow' };
    if (rest[0] === '_review') {
      if (rest[1] === 'style.css' && rest.length === 2 && req.method !== 'POST') {
        res.writeHead(200, baseHeaders({ ...headers, 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" }));
        return void res.end(req.method === 'HEAD' ? undefined : REVIEW_CSS);
      }
      const shot = rest[1] === 'shot' && rest.length === 3 ? /^(\d{1,3})\.png$/.exec(rest[2]!) : null;
      if (shot && share.comments && req.method !== 'POST') {
        // Made with the version, so it shows that version and nothing newer.
        const png = await readFile(join(this.deps.publisher.versionDir(version.id), 'review', `shot-${Number(shot[1])}.png`)).catch(() => null);
        if (!png) return refuseText(res, 404, 'Not found.');
        res.writeHead(200, baseHeaders({ ...headers, 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" }));
        return void res.end(req.method === 'HEAD' ? undefined : png);
      }
      if (rest[1] === 'comments' && rest.length === 2 && req.method === 'POST') return this.comment(req, res, share, version.pages.length, base, gate);
      return refuseText(res, 404, 'Not found.');
    }
    const isPage = gate.dir || !rest.length || rest.at(-1)!.endsWith('.html') || !rest.at(-1)!.includes('.');
    if (isPage) {
      share.views++;
      share.lastViewAt = Date.now();
      void this.save();
    }
    const sent = gate.url.searchParams.get('sent');
    // Under no-referrer a browser sends `Origin: null` with the form, which the origin check refuses. same-origin
    // still sends nothing to another site, and the page loads nothing from one.
    const referrer: Record<string, string> = share.comments ? { 'Referrer-Policy': 'same-origin' } : {};
    return this.deps.publisher.serveFile(req, res, version.id, { segments: rest, dir: gate.dir }, {
      cache: 'no-store', extraHeaders: { ...headers, ...referrer }, formCsp: share.comments,
      html: (text, path) => this.review(text, path, version.pages.map((p) => p.file), share.comments, base, sent),
    });
  }

  /** A page with the review form at its end. The page's own policy allows the form to post here, and nowhere else. */
  private review(html: string, path: string, pages: string[], comments: boolean, base: string, sent: string | null): string {
    let out = html.replace(/form-action 'none'/g, comments ? "form-action 'self'" : "form-action 'none'");
    out = out.replace('</head>', `<link rel="stylesheet" href="${escapeAttr(`${base}_review/style.css`)}"></head>`);
    if (!comments) return out;
    out = out.replace('<meta name="referrer" content="no-referrer">', '<meta name="referrer" content="same-origin">');
    const page = Math.max(0, pages.indexOf(path));
    const form = `<aside class="bgr" aria-label="Comments for the designer"><details${sent === '1' ? ' open' : ''}><summary>${sent === '1' ? 'Thank you. Comment again' : 'Comment on this design'}</summary>${sent === '1' ? '<p class="bgr-sent">Your comment was sent. The designer sees it next to the design.</p>' : ''}<form method="post" action="${escapeAttr(`${base}_review/comments`)}"><input type="hidden" name="page" value="${page}"><label>Your name<input type="text" name="name" maxlength="${NAME_MAX}" required autocomplete="name"></label><label>Comment<textarea name="text" maxlength="${TEXT_MAX}" required></textarea></label><p>Click the place it is about, or send it without one.</p><input class="bgr-shot" type="image" name="at" src="${escapeAttr(`${base}_review/shot/${page}.png`)}" alt="A small picture of the page: click the place your comment is about"><button type="submit">Send without a place</button><p>Plain text only. The designer reads it before it goes anywhere.</p></form></details></aside>`;
    return out.replace(/<\/body>(?![\s\S]*<\/body>)/, `${form}</body>`);
  }

  private limited(map: Map<string, number[]>, key: string, rule: { count: number; windowMs: number }, now: number): boolean {
    const times = (map.get(key) ?? []).filter((t) => now - t < rule.windowMs);
    if (times.length >= rule.count) {
      map.set(key, times);
      return true;
    }
    times.push(now);
    map.set(key, times);
    if (map.size > 10_000) map.delete(map.keys().next().value!);
    return false;
  }

  private async comment(req: IncomingMessage, res: ServerResponse, share: ShareLink, pages: number, base: string, gate: Gate): Promise<void> {
    if (!share.comments) return refuseText(res, 403, 'This link takes no comments.');
    if (!/^application\/x-www-form-urlencoded\b/i.test(String(req.headers['content-type'] ?? ''))) return refuseText(res, 415, 'Send the form.');
    const raw = await readSmallBody(req, BODY_MAX);
    if (raw === null) return refuseText(res, 413, 'That comment is too long.');
    const form = new URLSearchParams(raw);
    const rawName = form.get('name') ?? '';
    const rawText = form.get('text') ?? '';
    if (rawName.trim().length > NAME_MAX || rawText.trim().length > TEXT_MAX) return refuseText(res, 413, `That comment is too long: at most ${TEXT_MAX} characters, and ${NAME_MAX} for the name.`);
    const name = stripMentions(plainClientText(rawName, NAME_MAX));
    const plain = plainClientText(rawText, TEXT_MAX);
    const text = stripMentions(plain);
    if (!name || !text) return refuseText(res, 400, 'A comment needs a name and some words.');
    const now = Date.now();
    if (this.limited(this.byIp, gate.ip, PER_IP, now) || this.limited(this.byLink, share.id, PER_LINK, now)) return refuseText(res, 429, 'Too many comments for now. Try again in a while.');
    if (this.state.inbox.length >= INBOX_MAX) return refuseText(res, 503, 'The designer has many comments to read. Try again later.');
    const page = Math.min(Math.max(0, Number.parseInt(form.get('page') ?? '0', 10) || 0), Math.max(0, pages - 1));
    let x: number | undefined;
    let y: number | undefined;
    const ax = Number(form.get('at.x'));
    const ay = Number(form.get('at.y'));
    if (form.has('at.x') && Number.isFinite(ax) && Number.isFinite(ay) && ax >= 0 && ay >= 0 && ax <= SHOT_WIDTH * 4 && ay <= 100_000) {
      const meta = await readFile(join(this.deps.publisher.versionDir(share.versionId), 'review', `shot-${page}.json`), 'utf8').then((t) => JSON.parse(t) as { width?: number }, () => null);
      if (meta?.width) {
        const scale = meta.width / SHOT_WIDTH;
        x = Math.round(ax * scale);
        y = Math.round(ay * scale);
      }
    }
    this.state.inbox.push(ClientComment.parse({
      id: randomBytes(6).toString('hex'), shareId: share.id, siteId: share.siteId, versionId: share.versionId, page, name, text,
      ...(x !== undefined && y !== undefined ? { x, y } : {}), at: now, mentionsRemoved: text !== plain,
    }));
    await this.save();
    const file = this.deps.publisher.sites().find((s) => s.id === share.siteId)?.versions.find((v) => v.id === share.versionId)?.pages[page]?.file ?? '';
    res.writeHead(303, baseHeaders({ Location: `${base}${file === 'index.html' ? '' : file}?sent=1`, 'Cache-Control': 'no-store' }));
    res.end();
  }

  /** Puts a client's comment into the file as a thread marked as theirs. It starts nothing: no mention is left in it. */
  async accept(id: string): Promise<{ fileId: string; threadId: string }> {
    const item = this.state.inbox.find((c) => c.id === id);
    if (!item) throw new HttpError(404, 'No such comment.');
    const site = this.deps.publisher.site(item.siteId);
    const page = site.versions.find((v) => v.id === item.versionId)?.pages[item.page];
    const doc = await this.deps.doc(site.fileId);
    const pageId = page && doc.pages.has(page.pageId) ? page.pageId : doc.getPages()[0]?.id;
    if (!pageId) throw new HttpError(409, 'The file has no page to put the comment on.');
    const pinned = page && doc.getNode(page.rootId) && doc.pageOf(page.rootId) === pageId ? page.rootId : undefined;
    const author = `${stripMentions(plainClientText(item.name, NAME_MAX))} (client)`;
    const threadId = doc.addThread({ pageId, ...(pinned ? { nodeId: pinned } : {}), x: pinned ? item.x ?? 0 : 0, y: pinned ? item.y ?? 0 : 0, author, text: stripMentions(plainClientText(item.text, TEXT_MAX)), client: true }, 'person:client');
    this.state.inbox = this.state.inbox.filter((c) => c !== item);
    await this.save();
    return { fileId: site.fileId, threadId };
  }

  async discard(id: string): Promise<void> {
    const before = this.state.inbox.length;
    this.state.inbox = this.state.inbox.filter((c) => c.id !== id);
    if (this.state.inbox.length === before) throw new HttpError(404, 'No such comment.');
    await this.save();
  }
}

function readSmallBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > limit) {
      req.resume();
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (over) return;
      if (size > limit) {
        // The rest is read and thrown away, so that the answer can still be sent.
        over = true;
        chunks.length = 0;
        return resolve(null);
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => (over ? undefined : reject(e)));
  });
}

