/**
 * What the phone says about a file's sync with the computer, in plain words. Pure, for tests: the screens are
 * PhoneSync.tsx, Files.tsx and Inbox.tsx.
 */
import { t } from '../i18n/store.ts';
import { formatDate } from '../i18n/format.ts';

export function changes(n: number): string {
  return t.n(n, '{count} change', '{count} changes');
}

/** "just now", "4 min ago", "2 h ago", "yesterday", "3 Nov". */
export function agoWords(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '';
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  if (min < 1) return t('just now');
  if (min < 60) return t.n(min, '{count} min ago', '{count} min ago');
  const hours = Math.round(min / 60);
  if (hours < 24) return t.n(hours, '{count} h ago', '{count} h ago');
  if (hours < 48) return t('yesterday');
  return formatDate(at, { month: 'short', day: 'numeric' });
}

export interface SyncFacts { live: boolean; sending: boolean; queued: number; syncedAt: number | null; host: string }

/** One line for the top of an open file. Null when there is nothing to say: connected, nothing waiting. */
export function fileSyncLine(f: SyncFacts, now = Date.now()): string | null {
  const host = f.host;
  if (f.sending) return t.n(f.queued, 'Sending {count} change to {host}.', 'Sending {count} changes to {host}.', { host });
  if (f.live) return null;
  const last = f.syncedAt ? t('Last synced {ago}.', { ago: agoWords(f.syncedAt, now) }) : t('Not synced with {host} on this phone yet.', { host });
  if (f.queued) return `${t.n(f.queued, 'Offline. {count} change waits for {host}.', 'Offline. {count} changes wait for {host}.', { host })} ${last}`;
  return `${t('Offline. Edits stay on this phone until {host} is back.', { host })} ${last}`;
}

/** For a row of the file list. */
export function rowSyncWords(stored: { kept?: boolean; queued?: number; syncedAt?: number | null; notes?: number } | undefined, now = Date.now()): string {
  if (!stored) return '';
  const parts: string[] = [];
  if (stored.queued) parts.push(t.n(stored.queued, '{count} change waiting', '{count} changes waiting'));
  else if (stored.syncedAt) parts.push(t('synced {ago}', { ago: agoWords(stored.syncedAt, now) }));
  if (stored.notes) parts.push(t.n(stored.notes, '{count} conflict', '{count} conflicts'));
  return parts.join(' · ');
}

/** The queue across files, for the head of the file list and the inbox: null with nothing waiting. */
export function queueLine(queue: { changes: number; files: number }, host: string, reachable: boolean | null): string | null {
  if (!queue.changes) return null;
  const n = queue.changes;
  const files = queue.files;
  if (reachable === false) {
    return files === 1
      ? t.n(n, '{count} change in 1 file waits for {host}.', '{count} changes in 1 file wait for {host}.', { host })
      : t.n(n, '{count} change in {files} files waits for {host}.', '{count} changes in {files} files wait for {host}.', { host, files });
  }
  return files === 1
    ? t.n(n, 'Sending {count} change in 1 file to {host}.', 'Sending {count} changes in 1 file to {host}.', { host })
    : t.n(n, 'Sending {count} change in {files} files to {host}.', 'Sending {count} changes in {files} files to {host}.', { host, files });
}

/** A conflict note from the phone's side: which value is whose, and which one stayed. */
export function noteWords(note: { device: string; kept: 'ours' | 'theirs'; ours: string; theirs: string }, host: string, me: string | null): { here: string; there: string; kept: string; otherLabel: string } {
  // `ours` is the computer's value, `theirs` the device the note came from.
  const fromMe = me !== null && note.device === me;
  const there = fromMe ? t('This phone') : note.device;
  return {
    here: t('{device}: {value}', { device: host, value: note.ours }),
    there: t('{device}: {value}', { device: there, value: note.theirs }),
    kept: note.kept === 'ours' ? t('Kept the one from {device}.', { device: host }) : fromMe ? t('Kept the one from this phone.') : t('Kept the one from {device}.', { device: note.device }),
    otherLabel: note.kept === 'ours' ? (fromMe ? t('Use mine') : t("Use {device}'s", { device: note.device })) : t("Use {device}'s", { device: host }),
  };
}
