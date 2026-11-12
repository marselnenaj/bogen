import { createHash } from 'node:crypto';
import { cleanPublishedPage, exportDocument, googleFontsHrefs, proposalMark, publishSlug, publishUrls, readCodeRef, type BogenDoc, type PublishLayer } from '@bogen/core';
import type { CodeBuilder } from './code-build.ts';
import { fetchPublic } from './net-guard.ts';
import { usedFamilies, type Renderer } from './render.ts';
import type { Storage } from './storage.ts';

/**
 * A page or an artboard as a static website: HTML, one style sheet per page, and the images, fonts and code
 * component frames it uses as files. No Bogen runtime, no address of this machine, nothing loaded from elsewhere.
 * `cleanPublishedPage` in core does the HTML; this gathers the files.
 */

export interface SiteFile {
  path: string;
  bytes: Uint8Array;
  type: string;
  /** A code component's frame: its own policy, which allows its one script and sandboxes it. */
  csp?: string;
}

export interface SitePage {
  /** The HTML file, such as `index.html`. */
  file: string;
  title: string;
  /** Kept on this machine only, to pin a client's comment to the layer it is about. Never in a file of the site. */
  rootId: string;
  pageId: string;
}

export interface BuiltSite {
  files: SiteFile[];
  pages: SitePage[];
  notes: string[];
}

export interface BuildDeps {
  storage: Storage;
  renderer: Renderer;
  codeBuilder: CodeBuilder;
  /** Reaches the internet for Google Fonts and images by address. Tests pass one that refuses. */
  fetch?: typeof fetchPublic;
}

export interface BuildTarget {
  pageId: string;
  nodeId?: string;
  title?: string;
  fit?: 'fluid' | 'fixed';
}

/** The policy of a published page. No script; frames only of the site itself, and only when there are code components. */
export function pageCsp(frames: boolean, form = false): string {
  return [
    "default-src 'none'", "style-src 'self'", "img-src 'self'", "font-src 'self'", "media-src 'self'",
    ...(frames ? ["frame-src 'self'"] : []), "base-uri 'none'", form ? "form-action 'self'" : "form-action 'none'",
  ].join('; ');
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
};

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf',
  'application/font-woff': 'woff', 'application/font-woff2': 'woff2', 'application/x-font-ttf': 'ttf', 'application/x-font-otf': 'otf',
};

export function typeOf(path: string): string {
  return TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const MAX_FILE = 25 * 1024 * 1024;
const MAX_FONT_BYTES = 24 * 1024 * 1024;
const MAX_FONT_FILES = 60;
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** Every layer, page and file id the document knows, which must not show up in what is published. */
export function knownIds(doc: BogenDoc, roots: string[]): string[] {
  const ids = new Set<string>();
  doc.nodes.forEach((_m, id) => ids.add(id));
  doc.pages.forEach((_m, id) => ids.add(id));
  const walk = (id: string) => {
    ids.add(id);
    for (const c of doc.getChildren(id)) walk(c.id);
  };
  roots.forEach(walk);
  return [...ids];
}

/** What the site shows: one artboard, or every top-level layer of a page that is neither hidden nor a proposal. */
export function siteRoots(doc: BogenDoc, target: BuildTarget): string[] {
  if (!doc.pages.has(target.pageId)) throw new Error('That page does not exist.');
  if (target.nodeId) {
    const node = doc.getNode(target.nodeId);
    if (!node || doc.pageOf(target.nodeId) !== target.pageId) throw new Error('That layer is not on this page.');
    if (node.hidden || proposalMark(doc, target.nodeId)) throw new Error('A hidden layer or a proposal is not published.');
    return [target.nodeId];
  }
  const roots = doc.getChildren(target.pageId).filter((n) => !n.hidden && !proposalMark(doc, n.id)).map((n) => n.id);
  if (!roots.length) throw new Error('The page is empty.');
  return roots;
}

export async function buildSite(doc: BogenDoc, target: BuildTarget, deps: BuildDeps): Promise<BuiltSite> {
  const roots = siteRoots(doc, target);
  const notes = new Set<string>();
  const files = new Map<string, SiteFile>();
  const add = (path: string, bytes: Uint8Array, csp?: string) => {
    if (!files.has(path)) files.set(path, { path, bytes, type: typeOf(path), ...(csp ? { csp } : {}) });
    return path;
  };
  const byHash = (dir: string, bytes: Uint8Array, ext: string) => add(`${dir}/${hex(bytes).slice(0, 20)}.${ext}`, bytes);

  // Addresses of images, videos and fonts, as files of the site.
  const resolved = new Map<string, string | null>();
  const resolveUrl = async (raw: string): Promise<string | null> => {
    if (resolved.has(raw)) return resolved.get(raw)!;
    let out: string | null = null;
    try {
      if (raw.startsWith('bogen-asset:')) {
        const asset = await deps.storage.readAsset(raw.slice('bogen-asset:'.length));
        const ext = asset && MIME_EXT[asset.mime.split(';')[0]!.trim()];
        if (asset && ext && asset.bytes.length <= MAX_FILE * 4) out = byHash('assets', asset.bytes, ext);
      } else if (/^data:/i.test(raw)) {
        const m = /^data:([\w.+/-]+)(;charset=[\w-]+)?(;base64)?,(.*)$/is.exec(raw);
        const ext = m && MIME_EXT[m[1]!.toLowerCase()];
        if (m && ext) out = byHash(ext === 'woff2' || ext === 'woff' || ext === 'ttf' || ext === 'otf' ? 'fonts' : 'assets', m[3] ? Buffer.from(m[4]!, 'base64') : Buffer.from(decodeURIComponent(m[4]!)), ext);
      } else if (/^https:\/\//i.test(raw) && deps.fetch) {
        const got = await deps.fetch(raw, { maxBytes: MAX_FILE, accept: (t) => Boolean(MIME_EXT[t.split(';')[0]!.trim().toLowerCase()]) });
        out = byHash('assets', got.bytes, MIME_EXT[got.contentType.split(';')[0]!.trim().toLowerCase()]!);
      }
    } catch {
      out = null;
    }
    if (!out) notes.add('An image, video or font that could not be made part of the site was left out.');
    resolved.set(raw, out);
    return out;
  };

  // Shaders as stills: there is no script on the page to run them.
  const stills = new Map<string, string>();
  const frames = new Map<string, string>();
  const visit = async (id: string) => {
    const node = doc.getNode(id);
    if (!node || node.hidden || proposalMark(doc, id)) return;
    if (node.type === 'shader') {
      try {
        const shot = await deps.renderer.screenshot(doc, { nodeIds: [id] }, { format: 'png', scale: 2, maxDimension: 2400 });
        stills.set(id, byHash('assets', shot.bytes, 'png'));
        notes.add('Shaders are shown as a still picture.');
      } catch {
        notes.add('A shader could not be drawn, and was left out.');
      }
    }
    const stored = doc.nodes.get(id);
    const ref = node.type === 'embed' && stored ? readCodeRef(stored) : undefined;
    if (ref) {
      const frame = await deps.codeBuilder.frame(ref.project, ref.file, ref.name);
      const csp = frame.headers['Content-Security-Policy'];
      if (frame.status === 200 && csp) {
        // Hosts with no headers of their own get the same policy as a meta element, less what only a header can say.
        const meta = csp.split(';').map((s) => s.trim()).filter((d) => !/^(frame-ancestors|sandbox)\b/.test(d)).join('; ');
        const body = frame.body.replace('<meta charset="utf-8">', `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${meta.replace(/"/g, '&quot;')}"><meta name="referrer" content="no-referrer">`);
        const bytes = Buffer.from(body, 'utf8');
        frames.set(id, add(`frames/${hex(bytes).slice(0, 20)}.html`, bytes, csp));
        notes.add('Code components run in sandboxed frames, with the only script of the site.');
      }
    }
    for (const c of doc.getChildren(id)) await visit(c.id);
  };
  for (const root of roots) await visit(root);

  const layer = (id: string): PublishLayer => {
    const node = doc.getNode(id);
    if (!node) return {};
    if (node.hidden || proposalMark(doc, id)) return { drop: true };
    if (stills.has(id)) return { still: stills.get(id)! };
    if (frames.has(id)) return { frame: frames.get(id)! };
    if (node.type === 'shader') return { drop: true };
    return {};
  };

  const fontCss = await googleFonts(doc, deps, (path, bytes) => add(path, bytes), notes);
  const forbidden = knownIds(doc, roots);
  const pages: { file: string; title: string; rootId: string; pageId: string }[] = [];
  const taken = new Set<string>(['index']);
  for (const [i, root] of roots.entries()) {
    const node = doc.getNode(root)!;
    const slug = i === 0 ? 'index' : publishSlug(node.name, taken);
    const title = (i === 0 && target.title) || node.name || 'Page';
    const source = exportDocument(doc, [root], { ids: true, media: 'viewport', title });
    const map = new Map<string, string | null>();
    for (const u of publishUrls(source)) map.set(u, await resolveUrl(u));
    const page = cleanPublishedPage(source, {
      title, layer, url: (u) => map.get(u) ?? null, stylesheet: `${slug}.css`, fit: target.fit ?? 'fluid',
      csp: pageCsp(frames.size > 0), forbidden,
    });
    for (const n of page.notes) notes.add(n);
    add(`${slug}.html`, Buffer.from(page.html, 'utf8'));
    add(`${slug}.css`, Buffer.from([fontCss, page.css].filter(Boolean).join('\n'), 'utf8'));
    pages.push({ file: `${slug}.html`, title, rootId: root, pageId: target.pageId });
  }
  return { files: [...files.values()], pages, notes: [...notes] };
}

/** Google Fonts the design uses, fetched once and served by the site itself, since the site loads nothing from elsewhere. */
async function googleFonts(doc: BogenDoc, deps: BuildDeps, add: (path: string, bytes: Uint8Array) => string, notes: Set<string>): Promise<string> {
  const families = usedFamilies(doc);
  if (!families.length) return '';
  if (!deps.fetch) {
    notes.add(`Fonts from Google Fonts were not fetched, so ${families.join(', ')} fall back to fonts of the reader's device.`);
    return '';
  }
  const out: string[] = [];
  let bytes = 0;
  let count = 0;
  for (const family of families) {
    try {
      let css = '';
      for (const href of googleFontsHrefs(family)) {
        const got = await deps.fetch(href, { maxBytes: 2 * 1024 * 1024, headers: { 'user-agent': CHROME_UA }, accept: (t) => /text\/css/.test(t) });
        css += `${Buffer.from(got.bytes).toString('utf8')}\n`;
      }
      const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)\s'"]+)\)/g)].map((m) => m[1]!))];
      const local = new Map<string, string>();
      for (const url of urls) {
        if (count >= MAX_FONT_FILES || bytes >= MAX_FONT_BYTES) break;
        const file = await deps.fetch(url, { maxBytes: 4 * 1024 * 1024, accept: (t) => /font|octet-stream/.test(t) });
        const ext = /\.(woff2|woff|ttf|otf)(\?|$)/.exec(url)?.[1] ?? 'woff2';
        local.set(url, add(`fonts/${hex(file.bytes).slice(0, 20)}.${ext}`, file.bytes));
        bytes += file.bytes.length;
        count++;
      }
      // Only @font-face blocks, and only with files of the site in them.
      const faces = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]).filter((face) => [...face.matchAll(/url\(([^)]+)\)/g)].every((u) => local.has(u[1]!.replace(/['"]/g, ''))))
        .map((face) => face.replace(/url\(([^)]+)\)/g, (_a, u: string) => `url("${local.get(u.replace(/['"]/g, ''))}")`));
      if (faces.length) out.push(...faces);
      else notes.add(`${family} could not be fetched from Google Fonts, so it falls back.`);
    } catch {
      notes.add(`${family} could not be fetched from Google Fonts, so it falls back.`);
    }
  }
  return out.join('\n');
}
