import { useEffect, useId, useState } from 'react';
import type { ThemeProject } from '../lib/theme-library.ts';
import { canConfirm, canReview, consolidation, importCount, MAX_SOURCES, pickOrder, sourcesFor, startPick, statsOf, type ConsolidatedNote, type ConsolidateStep, type PlanFile } from '../lib/theme-consolidate.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';
import { formatDate } from '../i18n/format.ts';

function counts(f: PlanFile): string {
  return [t.n(f.layers, '{count} layer', '{count} layers'), t.n(f.tokens, '{count} token', '{count} tokens'), t.n(f.comments, '{count} comment', '{count} comments')].join(', ');
}

/**
 * Bringing copies of one theme together, as the person decides: pick the copy to keep (none is picked for them), review
 * the server's plan, confirm. The other copies come in as branches of the kept one; their own files are left as they
 * are, for the person to archive or delete. Cancel at every step.
 */
export function ConsolidateCopies({ copies, onDone, onClose }: { copies: ThemeProject[]; onDone: (done: ConsolidatedNote) => void; onClose: () => void }) {
  const t = useT();
  const radio = useId();
  const [state, setState] = useState<ConsolidateStep>(startPick);
  const [stats, setStats] = useState<Map<string, PlanFile>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ordered = pickOrder(copies);
  const ids = ordered.map((c) => c.file_id);
  const nameOf = (id: string) => copies.find((c) => c.file_id === id)?.file_name || stats.get(id)?.name || id;

  // The facts of each copy (layers, tokens, comments, open right now), from one read-only plan of the group.
  useEffect(() => {
    if (ids.length < 2) return;
    let live = true;
    consolidation.plan(ids[0]!, ids.slice(1, 1 + MAX_SOURCES)).then((p) => { if (live) setStats(statsOf(p)); }).catch(() => { /* the pick works without them */ });
    return () => { live = false; };
  }, [ids.join(',')]);

  const review = async (target: string) => {
    setState({ step: 'review', target, plan: null });
    setBusy(true);
    setError(null);
    try {
      const plan = await consolidation.plan(target, sourcesFor(ids, target));
      setState({ step: 'review', target, plan });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (state.step !== 'review' || !state.plan || !canConfirm(state.plan)) return;
    setBusy(true);
    setError(null);
    try {
      const out = await consolidation.run(state.target, sourcesFor(ids, state.target), state.plan.plan_hash);
      // Told above the list: the library reloads, and this group may read differently afterwards.
      onDone({ target: state.target, targetName: state.plan.target.name || nameOf(state.target), imported: out.imported.length });
      onClose();
    } catch (e) {
      // A 409: a file changed since the plan, or the plan has problems. Nothing was done; the person reviews again.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tl-merge" role="group" aria-label={t('Bring these copies together')} data-testid="theme-consolidate" data-step={state.step}>
      {state.step === 'pick' ? (
        <>
          <p className="tl-note">{t('Which copy is the theme to keep as the project? The others come in as its branches. Their own files stay as they are.')}</p>
          <div role="radiogroup" aria-label={t('The copy to keep')} className="tl-pick">
            {ordered.map((c) => {
              const f = stats.get(c.file_id);
              return (
                <label key={c.file_id} className={`tl-pick-row${state.target === c.file_id ? ' is-on' : ''}`} data-testid="theme-consolidate-pick" data-file-id={c.file_id}>
                  <input type="radio" name={radio} value={c.file_id} checked={state.target === c.file_id} onChange={() => setState({ step: 'pick', target: c.file_id })} />
                  <span className="tl-pick-text">
                    <span className="tl-name" dir="auto">{c.file_name || c.name}</span>
                    <span className="brand-facts"><code>{c.file_id}</code> · {t('Last edited {date}', { date: formatDate(c.updatedAt, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })}{f ? ` · ${counts(f)}` : ''}</span>
                  </span>
                  {f?.active ? <span className="tl-chip is-in-use" data-testid="theme-consolidate-active">{t('In use right now')}</span> : null}
                </label>
              );
            })}
          </div>
          {ids.length - 1 > MAX_SOURCES ? <p className="tl-note">{t.n(MAX_SOURCES, 'Up to {count} copy comes in at once.', 'Up to {count} copies come in at once.')}</p> : null}
          <div className="tl-choose-actions">
            <button type="button" className="btn" disabled={!canReview(ids, state.target)} onClick={() => state.target && void review(state.target)} data-testid="theme-consolidate-review">{t('Review')}</button>
            <button type="button" className="btn btn-quiet" onClick={onClose}>{t('Cancel')}</button>
          </div>
        </>
      ) : state.step === 'review' ? (
        <>
          <p className="tl-note" dir="auto">{t('Keeps {name} ({id}) as the theme.', { name: nameOf(state.target), id: state.target })}</p>
          {!state.plan ? (busy ? <p className="tl-note">{t('Comparing')}</p> : null) : (
            <>
              <ul className="tl-plan" data-testid="theme-consolidate-plan">
                {state.plan.sources.map((s) => (
                  <li key={s.file_id} className="tl-plan-row" data-action={s.action} data-file-id={s.file_id}>
                    <span className="tl-name" dir="auto">{s.name || nameOf(s.file_id)}</span>
                    <span className="brand-facts" dir="auto">
                      <code>{s.file_id}</code>{' · '}
                      {s.action === 'import' ? t('Becomes the branch "{branch}"', { branch: s.branchName ?? s.name }) : s.action === 'comments' ? t('Its design is a branch already; its newer comments come along') : s.reason ? t('Skipped: {reason}', { reason: s.reason }) : t('Skipped')}
                      {s.identicalTo ? ` · ${t('Same content as {id}', { id: s.identicalTo })}` : ''}
                      {s.active ? ` · ${t('In use right now')}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              {state.plan.problems.length ? (
                <ul className="tl-problems" role="alert" data-testid="theme-consolidate-problems">
                  {state.plan.problems.map((p, i) => <li key={i} dir="auto">{p}</li>)}
                </ul>
              ) : null}
              {state.plan.note ? <p className="tl-note" dir="auto">{state.plan.note}</p> : null}
            </>
          )}
          <div className="tl-choose-actions">
            <button type="button" className="btn btn-primary" disabled={busy || !canConfirm(state.plan)} onClick={() => void run()} data-testid="theme-consolidate-confirm">
              {t.n(state.plan ? importCount(state.plan) : 0, 'Bring {count} copy in as a branch', 'Bring {count} copies in as branches')}
            </button>
            {error ? <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void review(state.target)}>{t('Review again')}</button> : null}
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => { setError(null); setState({ step: 'pick', target: state.target }); }}>{t('Back')}</button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
          </div>
        </>
      ) : null}
      {error ? <div className="examples-error" role="alert" dir="auto" data-testid="theme-consolidate-error">{error}</div> : null}
    </div>
  );
}

/** What was brought together, told once the library has reloaded. */
export function ConsolidatedNotice({ done, onClose }: { done: ConsolidatedNote; onClose: () => void }) {
  const t = useT();
  return (
    <div className="tl-done" role="status" data-testid="theme-consolidate-done">
      <p className="tl-note" dir="auto">{t.n(done.imported, '{count} copy is now a branch of {name}. The other file keeps its design and History and now points to this theme: archive or delete it yourself when you are sure.', '{count} copies are now branches of {name}. The other files keep their design and History and now point to this theme: archive or delete them yourself when you are sure.', { name: done.targetName })}</p>
      <div className="tl-choose-actions">
        <button type="button" className="btn" onClick={() => { location.hash = `#/file/${done.target}`; }} data-testid="theme-consolidate-open">{t('Open')}</button>
        <button type="button" className="btn btn-quiet" onClick={onClose}>{t('Close')}</button>
      </div>
    </div>
  );
}
