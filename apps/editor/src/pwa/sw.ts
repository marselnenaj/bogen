/**
 * The service worker of the phone app. The build replaces `__BOGEN_BUILD__` with this build's id and files
 * (see `pwaPlugin` in vite.config.ts), so a new build is a new worker. It installs next to the old one,
 * takes over when the page asks or when no page uses the old one, and then deletes the old shell.
 */
import { ASSET_CACHE, noticeRoute, pushNotice, SHELL_PREFIX, staleCaches, strategy } from './sw-rules.ts';

declare const __BOGEN_BUILD__: { id: string; files: string[] };

// The editor is typed for the DOM, which the worker lib clashes with, so the few worker types are spelled out.
interface ExtendableEvent extends Event { waitUntil(work: Promise<unknown>): void }
interface FetchEvent extends ExtendableEvent { request: Request; respondWith(response: Promise<Response>): void }
interface PushEvent extends ExtendableEvent { data: { text(): string } | null }
interface NotificationEvent extends ExtendableEvent { notification: Notification }
interface WindowClient { focus(): Promise<unknown>; postMessage(message: unknown): void }
interface WorkerScope {
  location: Location;
  registration: { showNotification(title: string, options: NotificationOptions): Promise<void> };
  clients: { claim(): Promise<void>; matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClient[]>; openWindow(url: string): Promise<unknown> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', fn: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'message', fn: (event: MessageEvent) => void): void;
  addEventListener(type: 'fetch', fn: (event: FetchEvent) => void): void;
  addEventListener(type: 'push', fn: (event: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', fn: (event: NotificationEvent) => void): void;
}
const worker = self as unknown as WorkerScope;

const BUILD = __BOGEN_BUILD__;
const SHELL = `${SHELL_PREFIX}${BUILD.id}`;
const files = new Set(BUILD.files);
/** A page load waits this long for the computer before the phone shows what it has. */
const NAVIGATE_TIMEOUT_MS = 4000;

worker.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(BUILD.files)));
});

worker.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of staleCaches(await caches.keys(), SHELL)) await caches.delete(name);
    await worker.clients.claim();
  })());
});

worker.addEventListener('message', (event) => {
  if ((event.data as { t?: string } | null)?.t === 'activate') void worker.skipWaiting();
});

async function fromShell(request: Request): Promise<Response> {
  const cached = await caches.match(request, { cacheName: SHELL, ignoreSearch: true });
  return cached ?? fetch(request);
}

async function navigate(request: Request): Promise<Response> {
  // A navigation request cannot be fetched again with an abort signal, so the timeout races it instead.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), NAVIGATE_TIMEOUT_MS); });
  try {
    return await Promise.race([fetch(request), late]);
  } catch {
    const shell = await caches.match('/index.html', { cacheName: SHELL });
    return shell ?? new Response('Bogen is offline, and this phone has no copy of the app yet.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } finally {
    clearTimeout(timer);
  }
}

async function catalog(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function asset(request: Request): Promise<Response> {
  const cached = await caches.match(request, { cacheName: ASSET_CACHE });
  return cached ?? fetch(request);
}

worker.addEventListener('fetch', (event) => {
  const how = strategy(event.request, worker.location.origin, files);
  if (how === 'shell') event.respondWith(fromShell(event.request));
  else if (how === 'navigate') event.respondWith(navigate(event.request));
  else if (how === 'asset') event.respondWith(asset(event.request));
  else if (how === 'catalog') event.respondWith(catalog(event.request));
});

// Notifications from the computer: what happened and in which file, nothing more (packages/server/src/push.ts).
worker.addEventListener('push', (event) => {
  const notice = pushNotice(event.data?.text());
  event.waitUntil(worker.registration.showNotification(notice.title, { body: notice.body, tag: notice.tag, data: { url: notice.url }, icon: '/icons/icon-192.png' }));
});

worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = noticeRoute(event.notification.data);
  event.waitUntil((async () => {
    const open = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = open[0];
    if (client) {
      await client.focus();
      client.postMessage({ t: 'open', url });
      return;
    }
    await worker.clients.openWindow(`/${url}`);
  })());
});
