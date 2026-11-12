import { useEffect, useState } from 'react';
import { conflictsFor, usePhoneSync } from '../doc/phone-link.ts';
import { agentApi } from '../lib/agent-api.ts';
import { phoneHost, phoneName } from '../lib/phone.ts';
import { canUseOther, fieldWords, useOther } from '../ops/conflicts.ts';
import { editor } from '../state/store.ts';
import { showLayer } from './board-view.ts';
import { fileSyncLine, noteWords } from './sync-words.ts';
import { useT } from '../i18n/react.ts';

/** Re-renders now and then, so that "4 min ago" stays true. */
function useMinute(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The line at the top of an open file while it is not in sync: what waits, and when it last was. */
export function PhoneSyncLine() {
  useT();
  const { live, sending, queued, syncedAt } = usePhoneSync();
  const now = useMinute();
  const line = fileSyncLine({ live, sending, queued, syncedAt, host: phoneHost() }, now);
  if (!line) return null;
  return <span data-testid="phone-sync-line" data-queued={queued}>{line}</span>;
}

/**
 * Values both sides set while apart, as the computer noted them when this phone's changes arrived, or another
 * device's. The merge kept one; the other is here, to put back with one tap, or to dismiss.
 */
export function ConflictNotes({ fileId }: { fileId: string }) {
  const t = useT();
  const conflicts = usePhoneSync(conflictsFor(fileId));
  const [open, setOpen] = useState(false);
  if (!conflicts.length) return null;
  const host = phoneHost();
  const me = phoneName();
  const drop = (id: string) => {
    usePhoneSync.getState().set({ conflicts: usePhoneSync.getState().conflicts.filter((c) => c.id !== id) });
    void agentApi.dismissConflict(fileId, id).catch(() => {});
  };
  const n = conflicts.length;
  return (
    <section className={`pf-notes${open ? ' is-open' : ''}`} data-testid="pf-conflicts" aria-label={t('Conflicts')}>
      <button type="button" className="pf-notes-head" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="pf-conflicts-toggle">
        <span>{t.n(n, 'One value was set on both sides while apart.', '{count} values were set on both sides while apart.')}</span>
        <b>{open ? t('Close') : t('Review')}</b>
      </button>
      {open ? (
        <div className="pf-notes-list">
          {conflicts.map((c) => {
            const w = noteWords(c, host, me);
            return (
              <div key={c.id} className="pf-note" data-testid="pf-conflict">
                <button type="button" className="pf-note-name" onClick={() => {
                  if (!c.nodeId) return;
                  editor().set({ selection: [c.nodeId] });
                  showLayer(c.nodeId);
                }} dir="auto">{c.name || c.nodeId || t('Token')} · {fieldWords(c.field)}</button>
                <p className={c.kept === 'ours' ? 'is-kept' : ''}>{w.here}</p>
                <p className={c.kept === 'theirs' ? 'is-kept' : ''}>{w.there}</p>
                <p className="pf-note-kept">{w.kept}</p>
                <div className="pf-note-actions">
                  {canUseOther(c) ? <button type="button" className="phone-btn is-outline" onClick={() => { useOther(c); drop(c.id); }} data-testid="pf-conflict-use">{w.otherLabel}</button> : null}
                  <button type="button" className="phone-btn is-plain-ink" onClick={() => drop(c.id)} data-testid="pf-conflict-dismiss">{t('Keep it')}</button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
