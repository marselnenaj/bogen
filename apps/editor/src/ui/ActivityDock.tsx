import { useEffect, useState, useSyncExternalStore } from 'react';
import { Globe, ImageIcon, ScanEye, Square, Wrench, X } from 'lucide-react';
import { useT } from '../i18n/react.ts';
import { useUi } from '../state/ui.ts';
import { useEditor } from '../state/store.ts';
import { dropActivity, elapsed, useActivities, type Activity } from '../lib/activity.ts';
import '../styles/activity.css';

/**
 * Background work as pills in the dock at the foot of the window, in the call bar's surface and above it: what is
 * happening, how long it has run, Open and Stop. Two show; more fold into one "3 running" that opens on a click.
 * A pill whose own dialog is open steps aside. Designed in Bogen: "Bogen Brand System", page "Design critique",
 * artboard D3, "The activity dock".
 */

function useHash(): string {
  return useSyncExternalStore((fn) => { window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn); }, () => location.hash);
}

/** The pills that show now: not those whose own surface is in view. */
export function useVisibleActivities(): Activity[] {
  const items = useActivities((s) => s.items);
  // What `covered` reads: the open dialogs, the file in front, the address.
  useUi((s) => `${s.critiqueOpen}${Boolean(s.generateImage)}`);
  useEditor((s) => s.fileId);
  useHash();
  const running = items.some((a) => a.state === 'running');
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return items.filter((a) => !a.covered?.());
}

function Art({ a }: { a: Activity }) {
  if (a.kind === 'review' && a.state === 'done' && a.score !== undefined) {
    const r = 15, c = 2 * Math.PI * r;
    return (
      <span className="act-art is-score" aria-hidden="true">
        <svg viewBox="0 0 36 36"><circle className="act-ring-track" cx="18" cy="18" r={r} /><circle className="act-ring-fill" cx="18" cy="18" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - a.score / 10)} /></svg>
        <span className="act-score">{a.score}</span>
      </span>
    );
  }
  if (a.kind === 'review') {
    return (
      <span className={`act-art is-wall${a.state === 'running' ? ' is-live' : ''}`} aria-hidden="true">
        {[0, 1, 2].map((i) => (a.pictures?.[i] ? <img key={i} src={a.pictures[i]} alt="" draggable={false} /> : <i key={i} />))}
        <span className="act-light" />
      </span>
    );
  }
  if (a.kind === 'fix') return <span className={`act-art is-agent${a.state === 'running' ? ' is-live' : ''}`} aria-hidden="true"><span className="act-dot" /></span>;
  return <span className={`act-art is-icon${a.state === 'running' ? ' is-live' : ''}`} aria-hidden="true">{a.kind === 'image' ? <ImageIcon size={16} /> : <Globe size={16} />}</span>;
}

function Pill({ a }: { a: Activity }) {
  const t = useT();
  const live = a.state === 'running';
  const clock = live ? elapsed(Date.now() - a.startedAt) : '';
  return (
    <section className={`act-pill is-${a.state}`} aria-label={a.title} data-testid="activity-pill" data-kind={a.kind} data-state={a.state}>
      <Art a={a} />
      <span className="call-text">
        <span className="call-status">{a.title}{clock ? <span className="act-clock"> · {clock}</span> : null}</span>
        {a.detail ? <span className="call-quiet act-detail">{a.detail}</span> : null}
      </span>
      {a.open ? <button type="button" className={`call-btn${a.state === 'done' ? ' is-primary' : ''}`} onClick={a.open} data-testid="activity-open">{t('Open')}</button> : null}
      {live && a.stop ? <button type="button" className="call-ib" aria-label={a.stopLabel ?? t('Stop')} title={a.stopLabel ?? t('Stop')} onClick={a.stop} data-testid="activity-stop"><Square size={12} fill="currentColor" aria-hidden="true" /></button> : null}
      {!live ? <button type="button" className="call-ib" aria-label={t('Close')} title={t('Close')} onClick={() => dropActivity(a.id)} data-testid="activity-dismiss"><X size={16} aria-hidden="true" /></button> : null}
    </section>
  );
}

/** What is in a folded stack, by kind: "2 reviews, 1 image". */
function summary(items: Activity[], t: ReturnType<typeof useT>): string {
  const n = (kind: Activity['kind']) => items.filter((a) => a.kind === kind).length;
  return [
    n('review') ? t.n(n('review'), '{count} review', '{count} reviews') : '',
    n('fix') ? t.n(n('fix'), '{count} fix', '{count} fixes') : '',
    n('image') ? t.n(n('image'), '{count} image', '{count} images') : '',
    n('brand') ? t.n(n('brand'), '{count} brand', '{count} brands') : '',
  ].filter(Boolean).join(', ');
}

export function ActivityPills({ items }: { items: Activity[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ended = items.filter((a) => a.state !== 'running');
  // Said once when work ends, quietly: the pill is the notice.
  const said = ended.map((a) => a.title).join('. ');
  if (!items.length) return null;
  const fold = items.length > 2 && !open;
  const running = items.filter((a) => a.state === 'running').length;
  return (
    <>
      <span className="call-live" aria-live="polite" data-testid="activity-said">{said}</span>
      {fold ? (
        <section className="act-pill is-stack" aria-label={t('Background work')} data-testid="activity-stack">
          <span className="act-stack-art" aria-hidden="true">{items.slice(0, 3).map((a) => <span key={a.id} className="act-art is-icon">{a.kind === 'review' ? <ScanEye size={14} /> : a.kind === 'fix' ? <Wrench size={14} /> : a.kind === 'image' ? <ImageIcon size={14} /> : <Globe size={14} />}</span>)}</span>
          <span className="call-text">
            <span className="call-status">{running === items.length ? t('{count} running', { count: items.length }) : t('{running} running, {done} done', { running, done: items.length - running })}</span>
            <span className="call-quiet act-detail">{summary(items, t)}</span>
          </span>
          <button type="button" className="call-btn" aria-expanded="false" onClick={() => setOpen(true)} data-testid="activity-expand">{t('Show all')}</button>
        </section>
      ) : (
        <>
          {open && items.length > 2 ? (
            <div className="act-fold-row">
              <span>{running === items.length ? t('{count} running', { count: items.length }) : t('{running} running, {done} done', { running, done: items.length - running })}</span>
              <button type="button" className="act-fold" aria-expanded="true" onClick={() => setOpen(false)} data-testid="activity-fold">{t('Show less')}</button>
            </div>
          ) : null}
          {items.map((a) => <Pill key={a.id} a={a} />)}
        </>
      )}
    </>
  );
}
