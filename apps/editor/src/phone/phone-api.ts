import { isRunnerId, runnerLabel } from '@bogen/core';
import { phoneOrigin } from '../lib/phone.ts';
import { formatDate } from '../i18n/format.ts';
import { t } from '../i18n/store.ts';

/** What the inbox lists: see packages/server/src/inbox.ts. */
export type InboxItem =
  | { kind: 'proposal'; id: string; fileId: string; fileName: string; at: number; of: string; by: string; note?: string; name: string; ofName: string; pageId?: string; pageName?: string; directions: number }
  | { kind: 'comment'; id: string; fileId: string; fileName: string; at: number; text: string; author: string; lastAuthor: string; lastText: string; replies: number; nodeId?: string; pageId: string }
  | { kind: 'run'; id: string; fileId: string; fileName: string; at: number; runner: string; prompt: string; status: string; result?: string; error?: string; layers: number };

const INBOX_KEY = 'bogen-phone-inbox';
const HOSTS_KEY = 'bogen-phone-hosts';

/** This computer and the others it syncs with, each with the address of its own phone app if it has one on. */
export interface PhoneHosts {
  self: { name: string; url: string | null; version: string };
  others: { id: string; name: string; url: string | null; state: 'connected' | 'offline'; lastSyncAt: number | null }[];
}
const SEEN_KEY = 'bogen-phone-seen-runs';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? t('{method} {path} failed with {status}', { method: init?.method ?? 'GET', path, status: res.status }));
  return body;
}

/** The inbox, kept on the phone for when the computer is out of reach. */
export async function loadInbox(): Promise<{ items: InboxItem[]; stale: boolean }> {
  try {
    const { items } = await json<{ items: InboxItem[] }>('/api/inbox');
    if (phoneOrigin) {
      try { localStorage.setItem(INBOX_KEY, JSON.stringify(items)); } catch { /* only a convenience */ }
    }
    return { items, stale: false };
  } catch (e) {
    const kept = localStorage.getItem(INBOX_KEY);
    if (kept) return { items: JSON.parse(kept) as InboxItem[], stale: true };
    throw e;
  }
}

/** Finished runs drop out of the inbox once looked at. Proposals and comments leave when they are decided. */
export function seenRuns(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function markRunSeen(id: string): void {
  const seen = [...seenRuns(), id].slice(-200);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* fine */ }
}

export function decide(fileId: string, proposalId: string, decision: 'accept' | 'discard', who: string): Promise<{ nodeId?: string; discarded: string[] }> {
  return json(`/api/files/${fileId}/proposals/${proposalId}/${decision}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who }) });
}

const pictures = new Map<string, Promise<string>>();

/** A rendered picture of a layer, from the computer's own renderer, as an object URL. Kept for the session. */
export function layerPicture(fileId: string, nodeId: string, scale = 1): Promise<string> {
  const key = `${fileId}/${nodeId}@${scale}`;
  let found = pictures.get(key);
  if (!found) {
    found = fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeIds: [nodeId], format: 'png', scale }) })
      .then(async (res) => {
        if (!res.ok) throw new Error(t('No picture ({status})', { status: res.status }));
        return URL.createObjectURL(await res.blob());
      });
    found.catch(() => pictures.delete(key));
    pictures.set(key, found);
  }
  return found;
}

/** A picture taken again: after an agent changed the layer. */
export function forgetPicture(fileId: string, nodeId: string): void {
  for (const key of pictures.keys()) if (key.startsWith(`${fileId}/${nodeId}@`)) pictures.delete(key);
}

export function runnerName(id: string): string {
  return id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude' : isRunnerId(id) ? runnerLabel(id) : id.charAt(0).toUpperCase() + id.slice(1);
}

/** "2 min", "18 min", "1 h", "yesterday": short, for a row. */
export function shortAgo(at: number | string, now = Date.now()): string {
  const ms = typeof at === 'number' ? at : new Date(at).getTime();
  if (!Number.isFinite(ms)) return '';
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 1) return t('now');
  if (min < 60) return t.n(min, '{count} min', '{count} min');
  const hours = Math.round(min / 60);
  if (hours < 24) return t.n(hours, '{count} h', '{count} h');
  const days = Math.round(hours / 24);
  if (days === 1) return t('yesterday');
  if (days < 7) return t.n(days, '{count} d', '{count} d');
  return formatDate(ms, { month: 'short', day: 'numeric' });
}

/** The computers, kept on the phone: when this one is off, the phone still knows where the others are. */
export async function loadHosts(): Promise<{ hosts: PhoneHosts | null; stale: boolean }> {
  try {
    const hosts = await json<PhoneHosts>('/api/phone/hosts');
    try { localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts)); } catch { /* only a convenience */ }
    return { hosts, stale: false };
  } catch {
    return { hosts: keptHosts(), stale: true };
  }
}

export function keptHosts(): PhoneHosts | null {
  try {
    const kept = localStorage.getItem(HOSTS_KEY);
    return kept ? JSON.parse(kept) as PhoneHosts : null;
  } catch {
    return null;
  }
}

/** Another computer with a phone app of its own, for when this one is off. */
export function fallbackHost(hosts: PhoneHosts | null): PhoneHosts['others'][number] | null {
  return hosts?.others.find((o) => o.url) ?? null;
}
