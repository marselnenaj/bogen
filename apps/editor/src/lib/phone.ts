import { useSyncExternalStore } from 'react';
import { onReachableChange, serverReachable } from './events.ts';
import { t } from '../i18n/store.ts';

/**
 * The phone: where it is, and how the layout knows.
 *
 * `phoneOrigin` is about the connection: true when this page came through the phone listener, which is always
 * https on this computer's tailnet name. The desktop editor is plain http on loopback. Pairing, the service
 * worker and the offline copies only exist there.
 *
 * `usePhone` is about the screen: a narrow touch screen anywhere, and any touch screen that came through the
 * phone listener, such as an iPad. It also sets `data-phone` on <html>, so that CSS can say `:root[data-phone]`.
 * The phone layout hangs off this flag: an iPad on the phone listener gets it too, made wider, and a narrow
 * desktop window, or a touch laptop on the desktop editor, does not.
 */
export const phoneOrigin = typeof location !== 'undefined' && location.protocol === 'https:'
  && (location.hostname.endsWith('.ts.net') || metaContent('bogen-listener') === 'phone');

/** What the phone listener wrote into the app shell (packages/server/src/http/static.ts). */
function metaContent(name: string): string | null {
  return typeof document === 'undefined' ? null : document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null;
}

/**
 * The computer this app talks to, by the name it has in Bogen. Each computer is its own app on the Home Screen,
 * with its own pairing and storage, so the app always says which one it is.
 */
export function phoneHost(): string {
  return metaContent('bogen-host') || (typeof location === 'undefined' ? t('the computer') : location.hostname.split('.')[0] || t('the computer'));
}

/** A phone held either way. Pointer coarse keeps narrow desktop windows out. */
export const PHONE_QUERY = '(pointer: coarse) and (max-width: 600px), (pointer: coarse) and (max-height: 500px) and (max-width: 950px)';

const media = typeof matchMedia === 'function' ? matchMedia(PHONE_QUERY) : null;
/** A touch screen as the main pointer: an iPad as much as a phone. */
const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;

function subscribe(fn: () => void): () => void {
  media?.addEventListener('change', fn);
  coarse?.addEventListener('change', fn);
  return () => {
    media?.removeEventListener('change', fn);
    coarse?.removeEventListener('change', fn);
  };
}

export function isPhone(): boolean {
  return (media?.matches ?? false) || (phoneOrigin && (coarse?.matches ?? false));
}

export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false);
}

/** Keeps `data-phone` and `data-standalone` on <html> current. */
export function installPhoneFlag(): void {
  const root = document.documentElement;
  const apply = () => {
    if (isPhone()) root.dataset.phone = '';
    else delete root.dataset.phone;
  };
  apply();
  subscribe(apply);
  if (isStandalone()) root.dataset.standalone = '';
  // The phone app's own layout rules, such as the side panel on an iPad, hold only here.
  if (phoneOrigin) root.dataset.phoneOrigin = '';
}

/** Opened from the Home Screen, not in a Safari tab. Its storage is its own, which is why pairing happens in it. */
export function isStandalone(): boolean {
  return matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** Whether the computer answers right now, as the events socket sees it. Null until its first try ends. */
export function useReachable(): boolean | null {
  return useSyncExternalStore(onReachableChange, serverReachable, () => null);
}

export type PhonePairing = { paired: true; id: string; name: string } | { paired: false } | { offline: true };

const NAME_KEY = 'bogen-phone-name';

/** The name this phone was paired under, which is how the computer's notes name it. Kept for offline. */
export function phoneName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

/** Whether this phone is paired. Without the computer it cannot know, and assumes so, to show what it kept. */
export async function phonePairing(): Promise<PhonePairing> {
  try {
    const res = await fetch('/api/phone/me', { cache: 'no-store' });
    if (!res.ok) return { offline: true };
    const answer = (await res.json()) as PhonePairing;
    if ('paired' in answer && answer.paired) {
      try { localStorage.setItem(NAME_KEY, answer.name); } catch { /* only a convenience */ }
    }
    return answer;
  } catch {
    return { offline: true };
  }
}

export async function pairPhone(code: string, name?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/phone/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, ...(name ? { name } : {}) }) });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: body.error ?? t('The computer answered {status}.', { status: res.status }) };
  } catch {
    return { ok: false, error: t('The computer cannot be reached. Check that Tailscale is on.') };
  }
}

// The service worker

type UpdateListener = () => void;
const updateListeners = new Set<UpdateListener>();
let waiting: ServiceWorker | null = null;

export function updateWaiting(): boolean {
  return waiting !== null;
}

export function onUpdateWaiting(fn: UpdateListener): () => void {
  updateListeners.add(fn);
  return () => updateListeners.delete(fn);
}

/** Moves to the new build now. The page reloads once the new worker has taken over. */
export function applyUpdate(): void {
  if (!waiting) return location.reload();
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  waiting.postMessage({ t: 'activate' });
}

/** Only on the phone listener, and only in a build: the dev server has no worker to give. */
export function registerServiceWorker(): void {
  if (!phoneOrigin || !import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const noteWaiting = (worker: ServiceWorker | null) => {
    // The first install has nothing to replace, and simply takes over.
    if (!worker || !navigator.serviceWorker.controller) return;
    waiting = worker;
    for (const fn of updateListeners) fn();
  };
  // A tapped notification, while the app is open: the worker says where to go.
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { t?: string; url?: string } | null;
    if (data?.t === 'open' && typeof data.url === 'string' && data.url.startsWith('#/')) location.hash = data.url;
  });
  void navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
    noteWaiting(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') noteWaiting(worker);
      });
    });
    // A phone app can stay open for days. Look for a new build when it comes back to the front.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void reg.update().catch(() => {});
    });
  }).catch((e) => console.warn('bogen: no service worker:', e));
}
