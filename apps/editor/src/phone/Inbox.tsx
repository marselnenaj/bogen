import { useEffect, useState } from 'react';
import { api, type Status } from '../lib/api.ts';
import { onServerEvent } from '../lib/events.ts';
import { phoneHost, useReachable } from '../lib/phone.ts';
import { queueOf, useStoredFiles } from '../doc/offline.ts';
import { queueLine } from './sync-words.ts';
import { loadInbox, markRunSeen, runnerName, seenRuns, shortAgo, type InboxItem } from './phone-api.ts';
import { openCanvas } from './PhoneCanvas.tsx';
import { msg } from '../i18n/core.ts';
import { formatDate, formatList } from '../i18n/format.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

/** The small line over the headline: the day, and whether the computers are in sync. */
function syncLine(status: Status | null, reachable: boolean | null, stale: boolean): string {
  const day = formatDate(new Date(), { weekday: 'long' });
  if (reachable === false || stale) return t('{day}, offline. This is what the phone last saw.', { day });
  if (!status) return day;
  const name = (status as Status & { device?: { name: string } }).device?.name;
  const peers = status.peers ?? [];
  const up = peers.filter((p) => p.state === 'connected').map((p) => p.name);
  if (!peers.length) return name !== undefined ? t('{day}, {device} is connected', { day, device: name }) : t('{day}, the computer is connected', { day });
  if (up.length === peers.length) return t('{day}, {devices} in sync', { day, devices: formatList([name ?? t('the computer'), ...up]) });
  return t('{day}, {devices} offline', { day, devices: formatList(peers.filter((p) => p.state !== 'connected').map((p) => p.name)) });
}

function headline(n: number): string {
  if (n === 0) return t('Nothing for you.');
  return t.n(n, '{count} thing for you.', '{count} things for you.');
}

/** `label` stays English, compared as it is, and is translated where it shows. */
function describe(item: InboxItem): { label: string; text: string } {
  if (item.kind === 'proposal') {
    const who = runnerName(item.by);
    const what = item.note ? `${who}: ${item.note}` : item.ofName ? t('{agent} proposes a new {name}.', { agent: who, name: item.ofName }) : t('{agent} proposes a new layer.', { agent: who });
    return { label: msg('Proposal'), text: item.directions > 1 ? t.n(item.directions, '{text} {count} direction.', '{text} {count} directions.', { text: what }) : what };
  }
  if (item.kind === 'comment') {
    const answered = item.replies > 0 && item.lastAuthor !== item.author;
    return { label: msg('Comment'), text: answered ? t('“{text}” {agent} answered.', { text: item.text, agent: runnerName(item.lastAuthor) }) : t('“{text}” From {author}.', { text: item.text, author: item.author }) };
  }
  if (item.status === 'failed' || item.status === 'interrupted') return { label: msg('Failed'), text: item.error ?? item.prompt };
  if (item.status === 'stopped') return { label: msg('Stopped'), text: item.prompt };
  return { label: msg('Done'), text: item.result?.split(/(?<=[.!?])\s/)[0] ?? item.prompt };
}

function open(item: InboxItem): void {
  if (item.kind === 'proposal') location.hash = `#/review/${item.fileId}/${item.id}`;
  else if (item.kind === 'comment') openCanvas(item.fileId, '#/', item.id);
  else {
    markRunSeen(item.id);
    openCanvas(item.fileId, '#/');
  }
}

/** B1: what waits for the person. Proposals, open comments, and runs that finished. */
export function Inbox() {
  const t = useT();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [stale, setStale] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const reachable = useReachable();
  const stored = useStoredFiles();
  const waiting = queueLine(queueOf(stored.values()), phoneHost(), reachable);
  useEffect(() => {
    let timer = 0;
    const load = () => {
      void loadInbox().then((r) => {
        const seen = seenRuns();
        setItems(r.items.filter((i) => i.kind !== 'run' || !seen.has(i.id)));
        setStale(r.stale);
        setError('');
      }, (e: Error) => setError(e.message));
      void api.status().then(setStatus, () => setStatus(null));
    };
    load();
    // Agents send many events in a row; one reload after they settle is enough.
    const off = onServerEvent((e) => {
      if (!['files', 'run-history', 'comment-run', 'history', 'peers', 'agent'].includes(e.t)) return;
      if (e.t === 'agent' && e.kind !== 'done' && e.kind !== 'error') return;
      clearTimeout(timer);
      timer = window.setTimeout(load, 600);
    });
    return () => { off(); clearTimeout(timer); };
  }, [reachable]);

  return (
    <main className="phone-main" data-testid="phone-inbox">
      <header className="phone-head">
        <p className="phone-kicker" data-testid="phone-sync-line">{syncLine(status, reachable, stale)}{waiting ? ` ${waiting}` : ''}</p>
        <h1 className="phone-hero">{items ? headline(items.length) : ' '}</h1>
      </header>
      <div className="phone-list">
        {error && !items ? <p className="phone-empty">{error}</p> : null}
        {items?.map((item) => {
          const { label, text } = describe(item);
          return (
            <button type="button" key={`${item.kind}-${item.id}`} className="phone-row phone-inbox-row" onClick={() => open(item)} data-testid="phone-inbox-item" data-kind={item.kind}>
              <span className={`phone-mark is-${item.kind}${label === 'Failed' ? ' is-failed' : ''}`} aria-hidden="true" />
              <span className="phone-row-body">
                <span className="phone-row-meta"><span dir="auto"><b>{t(label)}</b> · {item.fileName}</span><span>{shortAgo(item.at)}</span></span>
                <span className="phone-row-text" dir="auto">{text}</span>
              </span>
            </button>
          );
        })}
        {items && !items.length ? <p className="phone-empty">{t('Proposals, comments and finished agent runs show up here.')}</p> : null}
      </div>
    </main>
  );
}
