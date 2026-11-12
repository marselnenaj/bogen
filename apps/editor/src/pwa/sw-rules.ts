/**
 * What the service worker does with a request, as a pure function so that it can be tested without a browser.
 * The worker serves the app shell offline and the assets the phone was told to keep. It never touches the API
 * or the sockets: those are live data, and a stale answer there would look like the truth.
 */

/** Shell caches carry the build in their name, so that a new build never mixes with an old one. */
export const SHELL_PREFIX = 'bogen-shell-';
/** Uploaded images and fonts by content hash. They never change, so one cache serves every build. */
export const ASSET_CACHE = 'bogen-assets-v1';

export type Strategy =
  /** Leave it to the network, untouched. */
  | 'network'
  /** Hashed build files and the other shell files: from the cache of this build, else the network. */
  | 'shell'
  /** A page load: the network, and the cached shell when there is none. */
  | 'navigate'
  /** A design asset: from the asset cache if the phone kept it, else the network, which does not fill the cache. */
  | 'asset'
  /**
   * A language's catalog of this build: kept in the shell cache once the phone has used it, so the language in use
   * works offline without every phone downloading all 49 catalogs with each build.
   */
  | 'catalog';

export interface RequestLike { method: string; url: string; mode?: string }

const LIVE = /^\/(api|sync|events|mcp|live-mcp|peer)(\/|$)/;
/** Catalog chunks as the build names them (vite.config.ts). */
export const CATALOG_CHUNK = /^\/static\/locale-[\w-]+-[\w-]{6,}\.js$/;

/**
 * What a new worker downloads at install: the build's files less the language catalogs, which are fetched only
 * when the page loads one and kept then (strategy 'catalog'). The build's id still hashes every file.
 */
export function precacheFiles(built: readonly string[]): string[] {
  return built.filter((name) => !CATALOG_CHUNK.test(`/${name}`));
}
const ASSET = /^\/assets\/[a-f0-9]{64}\.[a-z0-9]{2,5}$/;

export function strategy(request: RequestLike, origin: string, shell: ReadonlySet<string>): Strategy {
  if (request.method !== 'GET') return 'network';
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return 'network';
  }
  // Fonts from Google and anything else elsewhere: the browser's own cache does that job.
  if (url.origin !== origin) return 'network';
  const path = url.pathname;
  if (LIVE.test(path)) return 'network';
  if (ASSET.test(path)) return url.search ? 'network' : 'asset';
  if (path === '/sw.js') return 'network';
  if (request.mode === 'navigate') return 'navigate';
  if (shell.has(path)) return 'shell';
  if (CATALOG_CHUNK.test(path) && !url.search) return 'catalog';
  return 'network';
}

/** Shell caches of other builds, which a newly active worker deletes. */
export function staleCaches(names: readonly string[], current: string): string[] {
  return names.filter((name) => name.startsWith(SHELL_PREFIX) && name !== current);
}

/** A notification as the worker shows it. See packages/server/src/push.ts for what the computer sends. */
export interface PushNotice { title: string; body: string; url: string; tag: string }

const ROUTE = /^#\/[\w/-]{0,200}$/;

/**
 * What a push message says, checked: plain words of a sane length, a route inside the app and nothing else.
 * Something unreadable still shows a notification, since iOS takes push away from an app that shows none.
 */
export function pushNotice(text: string | null | undefined): PushNotice {
  const fallback: PushNotice = { title: 'Bogen', body: 'Something happened on your computer.', url: '#/', tag: 'bogen' };
  let data: unknown;
  try {
    data = JSON.parse(text ?? '');
  } catch {
    return fallback;
  }
  if (!data || typeof data !== 'object') return fallback;
  const d = data as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  return {
    title: str(d.title, 120) || fallback.title,
    body: str(d.body, 160),
    url: typeof d.url === 'string' && ROUTE.test(d.url) ? d.url : '#/',
    tag: typeof d.tag === 'string' && /^[\w-]{1,100}$/.test(d.tag) ? d.tag : 'bogen',
  };
}

/** Where a tapped notification opens: its route, if it is one. */
export function noticeRoute(data: unknown): string {
  const url = (data as { url?: unknown } | null)?.url;
  return typeof url === 'string' && ROUTE.test(url) ? url : '#/';
}
