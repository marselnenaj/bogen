import { isStandalone } from './phone.ts';
import { t } from '../i18n/store.ts';

/**
 * Notifications on the phone, through Web Push (packages/server/src/push.ts). On an iPhone or iPad this needs
 * iOS 16.4 or later and the app opened from the Home Screen: Safari in a tab has no push. The computer keeps a
 * key pair for this phone and sends to the address the phone's push service gives, which for Apple devices is
 * Apple's. The messages are encrypted for this phone.
 */

export type PushKinds = { run: boolean; comment: boolean; proposal: boolean };
export interface PushStatus { key: string; on: boolean; kinds: PushKinds; service: string | null; sent: number; lastSentAt: number | null; lastError?: string }

/** Why notifications cannot be turned on here, or null when they can. */
export function pushBlocker(): string | null {
  if (!('serviceWorker' in navigator)) return t('This browser cannot show notifications from Bogen.');
  if (!('PushManager' in window) || typeof Notification === 'undefined') {
    // iOS only offers push to an app on the Home Screen.
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !isStandalone()) return t('Open Bogen from your Home Screen to turn on notifications. Safari in a tab cannot get them.');
    return t('This browser cannot get notifications. On an iPhone, that needs iOS 16.4 or later.');
  }
  if (Notification.permission === 'denied') return t('Notifications are turned off for this app. Turn them on in the iPhone\'s Settings, Notifications, then come back.');
  return null;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? t('The computer answered {status}.', { status: res.status }));
  return body;
}

const post = (path: string, data: unknown) => json<PushStatus>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export function pushStatus(): Promise<PushStatus> {
  return json('/api/phone/push', { cache: 'no-store' });
}

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Asks for permission, subscribes with this phone's key from the computer, and hands the computer the address.
 * Called from a tap: iOS only asks for permission in answer to one.
 */
export async function enablePush(): Promise<PushStatus> {
  const blocked = pushBlocker();
  if (blocked) throw new Error(blocked);
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? t('Notifications are not allowed for this app. Change it in the iPhone\'s Settings, Notifications.') : t('Notifications were not allowed.'));
  const { key } = await pushStatus();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key, say before the phone was paired again, cannot be used.
  const current = sub?.options.applicationServerKey;
  if (sub && current && btoa(String.fromCharCode(...new Uint8Array(current))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== key) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  const data = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  return post('/api/phone/push', { subscription: { endpoint: data.endpoint, keys: data.keys } });
}

export async function disablePush(): Promise<PushStatus> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  } catch {
    // The computer forgets it either way.
  }
  return json('/api/phone/push', { method: 'DELETE' });
}

export function setPushKinds(kinds: Partial<PushKinds>): Promise<PushStatus> {
  return post('/api/phone/push', { kinds });
}

export function sendTestPush(): Promise<{ ok: boolean }> {
  return json('/api/phone/push/test', { method: 'POST' });
}
