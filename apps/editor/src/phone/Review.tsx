import { useEffect, useRef, useState } from 'react';
import { loadUser } from '../lib/user.ts';
import { askAbout } from './ask-state.ts';
import { decide, layerPicture, loadInbox, runnerName, type InboxItem } from './phone-api.ts';
import { useT } from '../i18n/react.ts';

type Proposal = Extract<InboxItem, { kind: 'proposal' }>;

/** Before on the left of the handle, after on the right; the handle follows a finger or a mouse. */
function Split({ before, after }: { before: string; after: string }) {
  const t = useT();
  const [at, setAt] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const move = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (r && r.width) setAt(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };
  return (
    <div
      ref={box} className="phone-split" data-testid="phone-split" style={{ ['--at' as string]: `${at}%` }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); move(e.clientX); }}
      onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e.clientX); }}
      role="slider" aria-label={t('Before and after')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(at)} tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'ArrowLeft') setAt((v) => Math.max(0, v - 5)); if (e.key === 'ArrowRight') setAt((v) => Math.min(100, v + 5)); }}
    >
      <img className="phone-split-after" src={after} alt={t('After')} draggable={false} />
      <img className="phone-split-before" src={before} alt={t('Before')} draggable={false} />
      <span className="phone-split-line" aria-hidden="true"><span className="phone-split-handle">‹›</span></span>
    </div>
  );
}

/** B2: one proposal, before against after, the agent's note, and the decision. */
export function Review({ fileId, proposalId }: { fileId: string; proposalId: string }) {
  const t = useT();
  const [item, setItem] = useState<Proposal | null | undefined>(undefined);
  const [pictures, setPictures] = useState<{ before: string; after: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void loadInbox().then(({ items }) => setItem(items.find((i): i is Proposal => i.kind === 'proposal' && i.fileId === fileId && i.id === proposalId) ?? null), () => setItem(null));
  }, [fileId, proposalId]);
  useEffect(() => {
    if (!item) return;
    void Promise.all([layerPicture(fileId, item.of, 2), layerPicture(fileId, item.id, 2)]).then(([before, after]) => setPictures({ before, after }), (e: Error) => setError(e.message));
  }, [item, fileId]);

  const act = (decision: 'accept' | 'discard') => {
    if (!item) return;
    setBusy(true);
    void decide(fileId, item.id, decision, loadUser().name).then(() => { location.hash = '#/'; }, (e: Error) => { setError(e.message); setBusy(false); });
  };

  return (
    <main className="phone-main phone-review" data-testid="phone-review">
      <header className="phone-bar">
        <a href="#/" className="phone-back">{t('‹ Inbox')}</a>
        <span className="phone-bar-meta">{item ? `${item.pageName ?? item.fileName} · ${item.ofName || item.name}` : ''}</span>
      </header>
      <div className="phone-review-stage">
        {item === null ? <p className="phone-empty">{t('This proposal was decided already, or the PC cannot be reached.')}</p> : null}
        {pictures ? <Split before={pictures.before} after={pictures.after} /> : item ? <p className="phone-empty">{t('Rendering on the PC')}</p> : null}
        {pictures ? <div className="phone-split-labels"><span>{t('Before')}</span><b>{t('After')}</b></div> : null}
      </div>
      {item ? (
        <footer className="phone-review-foot">
          {item.note ? <p className="phone-note"><b>{runnerName(item.by)}:</b> <span dir="auto">{item.note}</span></p> : <p className="phone-note">{item.directions > 1 ? t.rich('{agent} made this, one of {count} directions.', { agent: <b>{runnerName(item.by)}</b>, count: item.directions }) : t.rich('{agent} made this.', { agent: <b>{runnerName(item.by)}</b> })}</p>}
          {error ? <p className="phone-error" role="alert">{error}</p> : null}
          <div className="phone-actions">
            <button type="button" className="phone-btn is-ink" disabled={busy} onClick={() => act('accept')} data-testid="phone-accept">{t('Accept')}</button>
            <button type="button" className="phone-btn is-outline" disabled={busy} onClick={() => act('discard')} data-testid="phone-discard">{t('Discard')}</button>
          </div>
          <button type="button" className="phone-link" onClick={() => { askAbout(fileId, [item.id]); location.hash = `#/ask/${fileId}`; }} data-testid="phone-ask-changes">{t('Ask for changes')}</button>
        </footer>
      ) : null}
    </main>
  );
}
