import type { BogenServer } from './http/server.ts';
import { fetchPublic, isPublicUrl } from './net-guard.ts';
import { capturePage, type CaptureResult } from './capture.ts';
import { errorMessage } from './util.ts';

/**
 * Whole-site capture: one page in the file per route, one artboard per size and colour scheme. Routes
 * come from robots.txt, sitemap.xml and the links on captured pages, on the same origin only.
 */
export interface SiteOptions {
  url: string;
  fileId: string;
  widths?: number[];
  schemes?: ('dark' | 'light')[];
  height?: number;
  /** Most routes to capture. */
  limit?: number;
  /** Local dev servers. Only for a request from the person, never for agents. */
  allowLocal?: boolean;
  captureFonts?: boolean;
  origin?: unknown;
  signal?: AbortSignal;
  onProgress?: (event: SiteEvent) => void;
}

export type SiteEvent =
  | { t: 'found'; sitemap: number; sources: string[] }
  | { t: 'page'; route: string; title: string; artboards: number; layers: number; done: number; queued: number }
  | { t: 'failed'; url: string; reason: string };

export interface SiteArtboard { nodeId: string; width: number; scheme: string; layers: number; images: number; failedImages: string[] }
export interface SitePage { route: string; url: string; pageId: string; title: string; artboards: SiteArtboard[] }

export interface SiteReport {
  fileId: string;
  origin: string;
  limit: number;
  /** Routes the sitemap listed. */
  sitemapRoutes: number;
  sitemaps: string[];
  pages: SitePage[];
  /** Routes found and not captured, with the reason. */
  skipped: { url: string; reason: string }[];
  failed: { url: string; reason: string }[];
  fonts: { stored: number; families: string[]; google: string[]; failed: string[] };
  interactionRules: number;
  stopped: boolean;
}

export const DEFAULT_SITE_LIMIT = 30;
export const MAX_SITE_LIMIT = 200;
const MAX_SITEMAPS = 10;
const MAX_SITEMAP_BYTES = 8 * 1024 * 1024;
const NOT_A_PAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|gz|tar|tgz|dmg|exe|deb|rpm|apk|ipa|mp4|webm|mov|mp3|wav|ogg|woff2?|ttf|otf|css|js|mjs|map|json|xml|txt|rss|atom|csv)$/i;
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/i;

/** Pathname without trailing slash, the identity of a page. Query strings count as the same page. */
export function routeOf(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '');
  return path || '/';
}

export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs = (block: string) => [...block.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, '&'));
  if (/<sitemapindex[\s>]/i.test(xml)) return { urls: [], sitemaps: locs(xml) };
  return { urls: locs(xml), sitemaps: [] };
}

async function fetchText(url: string, allowLocal: boolean): Promise<string | null> {
  try {
    const parsed = new URL(url);
    if (allowLocal && LOOPBACK.test(parsed.hostname)) {
      const res = await fetch(parsed, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      return (await res.text()).slice(0, MAX_SITEMAP_BYTES);
    }
    const got = await fetchPublic(url, { timeoutMs: 10_000, maxBytes: MAX_SITEMAP_BYTES });
    return Buffer.from(got.bytes).toString('utf8');
  } catch {
    return null;
  }
}

/** What robots.txt and the sitemaps say about this origin. A sitemap elsewhere is not read. */
async function discover(start: URL, allowLocal: boolean): Promise<{ urls: string[]; sitemaps: string[] }> {
  const queue = [`${start.origin}/sitemap.xml`];
  const robots = await fetchText(`${start.origin}/robots.txt`, allowLocal);
  for (const m of robots?.matchAll(/^\s*sitemap:\s*(\S+)/gim) ?? []) {
    try {
      const u = new URL(m[1]!, start.origin);
      if (u.origin === start.origin && !queue.includes(u.href)) queue.unshift(u.href);
    } catch { /* Not a URL. */ }
  }
  const urls: string[] = [];
  const sitemaps: string[] = [];
  const seen = new Set<string>();
  while (queue.length && seen.size < MAX_SITEMAPS) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const xml = await fetchText(next, allowLocal);
    if (!xml || !/<(urlset|sitemapindex)[\s>]/i.test(xml)) continue;
    sitemaps.push(next);
    const parsed = parseSitemap(xml);
    urls.push(...parsed.urls);
    for (const s of parsed.sitemaps) {
      try {
        if (new URL(s).origin === start.origin) queue.push(s);
      } catch { /* Not a URL. */ }
    }
  }
  return { urls, sitemaps };
}

export async function captureSite(app: BogenServer, options: SiteOptions): Promise<SiteReport> {
  const start = new URL(options.url);
  if (start.protocol !== 'http:' && start.protocol !== 'https:') throw new Error('Only http and https sites can be captured.');
  const local = LOOPBACK.test(start.hostname);
  if (local && !options.allowLocal) throw new Error('Sites on this computer can only be captured from the command line, not by an agent.');
  if (!local && !(await isPublicUrl(start.href))) throw new Error(`${start.hostname} is a private address and is not captured.`);
  const widths = options.widths?.length ? [...new Set(options.widths)] : [1440];
  const schemes = options.schemes?.length ? [...new Set(options.schemes)] : ['dark' as const];
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_SITE_LIMIT, MAX_SITE_LIMIT));
  const allowLocal = Boolean(options.allowLocal);
  const origin = options.origin ?? 'capture';
  const report: SiteReport = {
    fileId: options.fileId, origin: start.origin, limit, sitemapRoutes: 0, sitemaps: [], pages: [], skipped: [], failed: [],
    fonts: { stored: 0, families: [], google: [], failed: [] }, interactionRules: 0, stopped: false,
  };

  const queued = new Map<string, string>();
  const offer = (raw: string, from: 'sitemap' | 'link' | 'start'): void => {
    let url: URL;
    try {
      url = new URL(raw, start);
    } catch {
      return;
    }
    if (url.origin !== start.origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      // A link to another site is an ordinary link, and only the sitemap claims to list pages here.
      if (from === 'sitemap') report.skipped.push({ url: raw, reason: 'on another origin' });
      return;
    }
    if (NOT_A_PAGE.test(url.pathname)) return;
    url.hash = '';
    url.search = '';
    const route = routeOf(url);
    if (!queued.has(route)) queued.set(route, url.href);
  };
  offer(start.href, 'start');
  const found = await discover(start, allowLocal);
  report.sitemaps = found.sitemaps;
  for (const u of found.urls) offer(u, 'sitemap');
  report.sitemapRoutes = new Set(found.urls.flatMap((u) => {
    try {
      const parsed = new URL(u);
      return parsed.origin === start.origin && !NOT_A_PAGE.test(parsed.pathname) ? [routeOf(parsed)] : [];
    } catch {
      return [];
    }
  })).size;
  options.onProgress?.({ t: 'found', sitemap: report.sitemapRoutes, sources: found.sitemaps });

  const room = await app.rooms.get(options.fileId);
  const { doc } = room;
  const families = new Set<string>();
  const google = new Set<string>();
  const fontFiles = new Set<string>();
  const done = new Set<string>();
  const combos = widths.flatMap((width) => schemes.map((scheme) => ({ width, scheme })));

  const captureOne = (url: string, width: number, scheme: 'dark' | 'light'): Promise<CaptureResult> => capturePage(app.renderer, app.storage, doc, {
    url, width, height: options.height ?? 900, colorScheme: scheme, allowLocal, captureFonts: options.captureFonts,
  });

  // Follows the order found: the start page, then the sitemap, then links as they turn up.
  const order = (): [string, string][] => [...queued.entries()].filter(([route]) => !done.has(route));
  let firstPage = true;
  for (let next = order()[0]; next; next = order()[0]) {
    const [route, url] = next;
    done.add(route);
    if (options.signal?.aborted) {
      report.stopped = true;
      break;
    }
    if (report.pages.length >= limit) {
      report.skipped.push({ url, reason: `over the limit of ${limit} routes` });
      continue;
    }
    let captures: CaptureResult[];
    try {
      // Without tokens in the file the first capture brings them. A later scheme compares against those,
      // and two captures at once would each refer to tokens with their own values.
      if (doc.getTokens().length) captures = await Promise.all(combos.map((c) => captureOne(url, c.width, c.scheme)));
      else {
        captures = [];
        for (const c of combos) {
          const capture = await captureOne(url, c.width, c.scheme);
          captures.push(capture);
          if (!doc.getTokens().length) app.adoptCaptureTokens(doc, capture, origin);
        }
      }
    } catch (e) {
      report.failed.push({ url, reason: errorMessage(e) });
      options.onProgress?.({ t: 'failed', url, reason: errorMessage(e) });
      continue;
    }
    const first = captures[0]!;
    if (first.status !== undefined && first.status >= 400) {
      report.failed.push({ url, reason: `the server answered ${first.status}` });
      options.onProgress?.({ t: 'failed', url, reason: `the server answered ${first.status}` });
      continue;
    }
    // A redirect can lead to a route that was captured already, or off the site.
    let finalRoute = route;
    try {
      const final = new URL(first.finalUrl ?? url);
      if (final.origin !== start.origin) {
        report.skipped.push({ url, reason: `redirects to ${final.origin}` });
        continue;
      }
      finalRoute = routeOf(final);
    } catch { /* Keep the route asked for. */ }
    if (finalRoute !== route && (report.pages.some((p) => p.route === finalRoute) || (queued.has(finalRoute) && !done.has(finalRoute)))) {
      report.skipped.push({ url, reason: `redirects to ${finalRoute}` });
      continue;
    }
    done.add(finalRoute);

    let pageId = doc.getPages().find((p) => p.name === finalRoute)?.id;
    if (!pageId && firstPage) {
      // A new file's empty first page is this route's page.
      const only = doc.getPages();
      if (only.length === 1 && !doc.getChildren(only[0]!.id).length) {
        pageId = only[0]!.id;
        doc.renamePage(pageId, finalRoute, origin);
      }
    }
    pageId ??= doc.createPage(finalRoute, origin);
    firstPage = false;

    const artboards: SiteArtboard[] = [];
    captures.forEach((capture, i) => {
      const { width, scheme } = combos[i]!;
      const placed = app.placeCapture(options.fileId, doc, capture, { name: `${width} ${scheme}`, pageId: pageId!, url }, origin);
      artboards.push({ nodeId: placed.nodeId, width, scheme, layers: capture.stats.layers, images: capture.stats.images, failedImages: capture.stats.failedImages });
      for (const face of capture.fontFaces) if (face.src) fontFiles.add(face.src);
      capture.fonts.families.forEach((f) => families.add(f));
      capture.fonts.google.forEach((f) => google.add(f));
      for (const f of capture.fonts.failed) if (!report.fonts.failed.includes(f)) report.fonts.failed.push(f);
      report.interactionRules += capture.rules.length;
    });
    report.pages.push({ route: finalRoute, url, pageId, title: first.title, artboards });
    for (const link of captures.flatMap((c) => c.links)) offer(link, 'link');
    options.onProgress?.({
      t: 'page', route: finalRoute, title: first.title, artboards: artboards.length, layers: artboards.reduce((sum, a) => sum + a.layers, 0),
      done: report.pages.length, queued: order().length,
    });
  }
  report.fonts.stored = fontFiles.size;
  report.fonts.families = [...families].sort();
  report.fonts.google = [...google].sort();
  return report;
}

export interface SiteJob { id: string; status: 'running' | 'done' | 'failed'; report?: SiteReport; error?: string; progress: string[]; done: Promise<void> }

/** Captures that outlive one MCP call, as a big site can take longer than a client waits for a tool. */
export class SiteJobs {
  private jobs = new Map<string, SiteJob>();
  private next = 1;

  start(run: (progress: (line: string) => void) => Promise<SiteReport>): SiteJob {
    const id = `site-${this.next++}`;
    const job: SiteJob = { id, status: 'running', progress: [], done: Promise.resolve() };
    job.done = run((line) => {
      job.progress.push(line);
      if (job.progress.length > 300) job.progress.shift();
    }).then((report) => {
      job.report = report;
      job.status = 'done';
    }, (e) => {
      job.error = errorMessage(e);
      job.status = 'failed';
    });
    this.jobs.set(id, job);
    if (this.jobs.size > 50) this.jobs.delete(this.jobs.keys().next().value!);
    return job;
  }

  get(id: string): SiteJob | undefined {
    return this.jobs.get(id);
  }
}
