import { useEffect, useMemo, useState } from 'react';
import { queueOf, setKept, useStoredFiles } from '../doc/offline.ts';
import { api, type FileEntry } from '../lib/api.ts';
import { onServerEvent } from '../lib/events.ts';
import { phoneHost, useReachable } from '../lib/phone.ts';
import { fallbackHost, keptHosts, shortAgo } from './phone-api.ts';
import { queueLine, rowSyncWords } from './sync-words.ts';
import { openCanvas } from './PhoneCanvas.tsx';
import { phoneFiles } from './phone-files.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';
import { locationName } from '../lib/recent-edits.ts';

function when(at: number | string): string {
  const ms = typeof at === 'number' ? at : new Date(at).getTime();
  if (!Number.isFinite(ms)) return '';
  // The same steps as shortAgo, with "ago" in the sentence; yesterday and older dates are shortAgo's own.
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 1) return t('just now');
  if (min < 60) return t.n(min, '{count} min ago', '{count} min ago');
  const hours = Math.round(min / 60);
  if (hours < 24) return t.n(hours, '{count} h ago', '{count} h ago');
  const days = Math.round(hours / 24);
  if (days !== 1 && days < 7) return t.n(days, '{count} d ago', '{count} d ago');
  return shortAgo(at);
}

/** B3: the files, with what is on this phone. Offline, files that are only on the computer are dimmed. */
export function Files() {
  const t = useT();
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const stored = useStoredFiles();
  const reachable = useReachable();
  const away = reachable === false;
  useEffect(() => {
    const load = () => void api.files().then(setFiles, () => setFiles([]));
    load();
    return onServerEvent((e) => { if (e.t === 'files') load(); });
  }, [reachable]);
  // Theme projects as Home lists them; a kept copy only while this phone holds it or edits of it.
  const shown = useMemo(() => (files ? phoneFiles(files, stored) : null), [files, stored]);
  const onPhone = [...stored.values()].length;
  const host = phoneHost();
  const waiting = queueLine(queueOf(stored.values()), host, reachable);
  const other = away ? fallbackHost(keptHosts()) : null;

  return (
    <main className="phone-main" data-testid="phone-files">
      {away ? (
        <p className="phone-offline" role="status" data-testid="phone-offline">
          {t('{host} cannot be reached.', { host })} {t.n(onPhone, '{count} file is on this phone, and your edits wait here for {host}.', '{count} files are on this phone, and your edits wait here for {host}.', { host })}
          {other ? ` ${t('Is {host} off? {other} has the same files: open its Bogen app from your Home Screen.', { host, other: other.name })}` : ''}
        </p>
      ) : null}
      {waiting && !away ? <p className="phone-queue" role="status" data-testid="phone-queue">{waiting}</p> : null}
      <header className="phone-head is-compact"><h1 className="phone-title">{t('Files')}</h1></header>
      <div className="phone-list">
        {shown?.map((f) => {
          const copy = stored.get(f.id);
          const missing = away && !copy;
          return (
            <div key={f.id} className={`phone-row phone-file${missing ? ' is-missing' : ''}`} data-testid="phone-file" data-file-id={f.id}>
              <button type="button" className="phone-file-open" disabled={missing} onClick={() => openCanvas(f.id, '#/files')} aria-label={t('Open {name}', { name: f.name })}>
                <span className="phone-thumb">{f.thumbnail && !away ? <img src={f.thumbnail} alt="" /> : null}</span>
                <span className="phone-row-body">
                  <span className="phone-file-name" dir="auto">{f.name}</span>
                  {f.lastEdit ? <span className="phone-row-sub" data-testid="phone-file-recent">{f.lastEdit.locations[0] ? locationName(f.lastEdit.locations[0]) : f.lastEdit.summary}</span> : null}
                  <span className="phone-row-sub" data-testid="phone-file-sync">{missing ? t('Only on {host}', { host }) : [copy?.kept ? t('On this phone') : '', t('edited {when}', { when: when(f.updatedAt) }), rowSyncWords(copy)].filter(Boolean).join(' · ')}</span>
                </span>
              </button>
              {!missing ? (
                <button type="button" className={`phone-keep${copy?.kept ? ' is-on' : ''}`} aria-pressed={Boolean(copy?.kept)} onClick={() => void setKept(f.id, !copy?.kept, f.name)} title={t('Kept files and their images open without the PC')} data-testid="phone-keep">
                  {copy?.kept ? t('Kept') : t('Keep')}
                </button>
              ) : null}
            </div>
          );
        })}
        {shown && !shown.length ? <p className="phone-empty">{away ? t('No files on this phone yet.') : t('No files yet. Make one on the computer, or ask an agent.')}</p> : null}
      </div>
    </main>
  );
}
