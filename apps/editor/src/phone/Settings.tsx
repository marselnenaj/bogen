import { useEffect, useState } from 'react';
import { queueOf, useStoredFiles } from '../doc/offline.ts';
import { flushQueued } from '../doc/phone-link.ts';
import { phoneHost, phoneName, useReachable } from '../lib/phone.ts';
import { disablePush, enablePush, pushBlocker, pushStatus, sendTestPush, setPushKinds, type PushKinds, type PushStatus } from '../lib/push.ts';
import { keptHosts, loadHosts, type PhoneHosts } from './phone-api.ts';
import { agoWords, changes } from './sync-words.ts';
import { LanguageSelect } from '../i18n/LanguageSelect.tsx';
import { useT } from '../i18n/react.ts';
import { msg } from '../i18n/core.ts';
import { WorkspaceView } from './WorkspaceView.tsx';

const KIND_LABELS: { id: keyof PushKinds; label: string; hint: string }[] = [
  { id: 'run', label: msg('An agent finished'), hint: msg('A run you started, or one from a comment.') },
  { id: 'comment', label: msg('A comment for you'), hint: msg('An agent answered, or a client commented.') },
  { id: 'proposal', label: msg('A proposal is ready'), hint: msg('To accept or discard.') },
];

/** Notifications: one switch, and which kinds. What a message says is the kind and the file's name. */
function Notifications() {
  const t = useT();
  const reachable = useReachable();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const blocked = pushBlocker();
  useEffect(() => {
    if (reachable === false) return;
    void pushStatus().then(setStatus, () => {});
  }, [reachable]);
  const on = Boolean(status?.on);
  const act = (work: () => Promise<PushStatus | { ok: boolean }>, done?: string) => {
    setBusy(true);
    setNote('');
    void work().then((next) => {
      if ('key' in next) setStatus(next);
      if (done) setNote(done);
    }, (e: Error) => setNote(e.message)).finally(() => setBusy(false));
  };
  const away = reachable === false;
  return (
    <section className="phone-set" aria-labelledby="set-push" data-testid="set-push">
      <h2 id="set-push" className="phone-set-title">{t('Notifications')}</h2>
      <label className="phone-switch">
        <span className="phone-switch-text">
          <b>{t('Notify me on this phone')}</b>
          <span>{on ? (status?.service === 'web.push.apple.com' ? t('On. Messages come through Apple\'s push service, encrypted for this phone.') : t('On. Messages come through the browser\'s push service, encrypted for this phone.')) : t('When an agent is done, a comment is for you, or a proposal is ready.')}</span>
        </span>
        <input
          type="checkbox" role="switch" checked={on} disabled={busy || away || (!on && Boolean(blocked))}
          onChange={() => act(on ? disablePush : enablePush, on ? t('Notifications are off.') : t('Notifications are on.'))} data-testid="set-push-toggle"
        />
      </label>
      {blocked && !on ? <p className="phone-set-note" data-testid="set-push-blocked">{blocked}</p> : null}
      {on ? (
        <>
          {KIND_LABELS.map((k) => (
            <label key={k.id} className="phone-check">
              <input type="checkbox" checked={status?.kinds[k.id] ?? true} disabled={busy || away} onChange={(e) => act(() => setPushKinds({ [k.id]: e.target.checked }))} data-testid={`set-push-${k.id}`} />
              <span><b>{t(k.label)}</b><span>{t(k.hint)}</span></span>
            </label>
          ))}
          <button type="button" className="phone-btn is-outline phone-set-action" disabled={busy || away} onClick={() => act(sendTestPush, t('Sent. It should show up in a few seconds.'))} data-testid="set-push-test">{t('Send a test')}</button>
          {status?.lastError ? <p className="phone-set-note">{t('The last message did not arrive: {error}', { error: status.lastError })}</p> : null}
        </>
      ) : null}
      <p className="phone-set-note">{t('A message says what happened and the file\'s name, nothing a design or a comment says.')}</p>
      {note ? <p className="phone-set-note is-ink" role="status" data-testid="set-push-note">{note}</p> : null}
    </section>
  );
}

/** Which computer this app talks to, the others, and how to use one of those when this one is off. */
function Computers() {
  const t = useT();
  const reachable = useReachable();
  const [hosts, setHosts] = useState<PhoneHosts | null>(() => keptHosts());
  const [stale, setStale] = useState(false);
  const [copied, setCopied] = useState('');
  useEffect(() => {
    void loadHosts().then((r) => {
      if (r.hosts) setHosts(r.hosts);
      setStale(r.stale);
    });
  }, [reachable]);
  const host = phoneHost();
  const copy = (url: string) => {
    void navigator.clipboard?.writeText(url).then(() => setCopied(url), () => setCopied(''));
  };
  return (
    <section className="phone-set" aria-labelledby="set-hosts" data-testid="set-hosts">
      <h2 id="set-hosts" className="phone-set-title">{t('Computers')}</h2>
      <div className="phone-host is-this" data-testid="set-host-self">
        <span className={`phone-host-dot${reachable === false ? '' : ' is-on'}`} aria-hidden="true" />
        <span className="phone-host-body">
          <b>{host}</b>
          <span>{reachable === false ? t('This app. Cannot be reached right now.') : t('This app. Connected.')}{hosts?.self.version ? ` ${t('Bogen {version}.', { version: hosts.self.version })}` : ''}</span>
        </span>
      </div>
      {hosts?.others.map((o) => (
        <div key={o.id} className="phone-host" data-testid="set-host-other">
          <span className={`phone-host-dot${o.state === 'connected' && !stale ? ' is-on' : ''}`} aria-hidden="true" />
          <span className="phone-host-body">
            <b>{o.name}</b>
            <span>{stale ? t('As last seen.') : o.state === 'connected' ? t('Syncing with {host}.', { host }) : o.lastSyncAt ? t('Offline, last synced {ago}.', { ago: agoWords(o.lastSyncAt) }) : t('Offline.')}{' '}
              {o.url ? t('Has its own Bogen app for this phone.') : t('Its phone app is off. On {computer}, run {command}.', { computer: o.name, command: 'bogen phone on' })}</span>
            {o.url ? (
              <span className="phone-host-actions">
                <button type="button" className="phone-link is-left" onClick={() => copy(o.url!)} data-testid="set-host-copy">{copied === o.url ? t('Copied') : t('Copy its address')}</button>
                <a className="phone-link is-left" href={o.url} target="_blank" rel="noreferrer">{t('Open in Safari')}</a>
              </span>
            ) : null}
          </span>
        </div>
      ))}
      <p className="phone-set-note">
        {t('Each computer is its own app on your Home Screen, with its own pairing and its own copies of files on this phone. The computers sync with each other, so each shows the same designs. If {host} is off, open the other one\'s app. Changes made here while {host} was away wait in this app until {host} is back.', { host })}
      </p>
      {hosts?.others.some((o) => o.url) ? (
        <p className="phone-set-note">{t.rich('To add one: open its address in Safari, tap Share, then Add to Home Screen. On that computer run {command} for a code, also over ssh, and type it in the new app.', { command: <code>bogen phone pair</code> })}</p>
      ) : !hosts?.others.length ? <p className="phone-set-note">{t('{host} syncs with no other computer.', { host })}</p> : null}
    </section>
  );
}

/** What waits for the computer. */
function Waiting() {
  const t = useT();
  const stored = useStoredFiles();
  const reachable = useReachable();
  const [busy, setBusy] = useState(false);
  const queue = queueOf(stored.values());
  const host = phoneHost();
  return (
    <section className="phone-set" aria-labelledby="set-offline" data-testid="set-offline">
      <h2 id="set-offline" className="phone-set-title">{t('On this phone')}</h2>
      <p className="phone-set-line" data-testid="set-queue">
        {queue.changes ? (queue.changes === 1 ? t.n(queue.files, '{changes} in 1 file waits for {host}.', '{changes} in {count} files waits for {host}.', { changes: changes(queue.changes), host }) : t.n(queue.files, '{changes} in 1 file wait for {host}.', '{changes} in {count} files wait for {host}.', { changes: changes(queue.changes), host })) : t('Nothing waits for {host}.', { host })}
        {' '}{t.n(stored.size, '{count} file is stored here.', '{count} files are stored here.')}
      </p>
      {queue.changes && reachable !== false ? (
        <button type="button" className="phone-btn is-outline phone-set-action" disabled={busy} onClick={() => { setBusy(true); void flushQueued(null).finally(() => setBusy(false)); }} data-testid="set-queue-send">{t('Send them now')}</button>
      ) : null}
      <p className="phone-set-note">{phoneName() ? t('Paired as {name}.', { name: phoneName()! }) : t('Paired as this phone.')}</p>
    </section>
  );
}

/** The phone's own language: Automatic follows the phone's languages, never the computer's. */
function Language() {
  const t = useT();
  return (
    <section className="phone-set" aria-labelledby="set-language" data-testid="set-language">
      <h2 id="set-language" className="phone-set-title">{t('Language')}</h2>
      <LanguageSelect testId="set-language-select" className="phone-language" />
      <p className="phone-set-note">{t('For this phone only. Automatic follows the languages of the phone. Designs and chats keep their own words.')}</p>
    </section>
  );
}

/** The phone's settings: language, notifications, the computers, and what waits. */
export function Settings() {
  const t = useT();
  return (
    <main className="phone-main" data-testid="phone-settings">
      <header className="phone-head is-compact"><h1 className="phone-title">{t('Settings')}</h1></header>
      <div className="phone-sets">
        <section className="phone-set" aria-labelledby="set-workspace-view"><h2 id="set-workspace-view" className="phone-set-title">{t('View')}</h2><WorkspaceView /></section>
        <Language />
        <Notifications />
        <Computers />
        <Waiting />
      </div>
    </main>
  );
}
