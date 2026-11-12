import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Check, ChevronDown, ChevronRight, GitBranch, GitMerge, Plus, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { session } from '../doc/session.ts';
import { localBranch, onBranchRecords, type LocalBranch } from '../doc/branch-watch.ts';
import { onServerEvent } from '../lib/events.ts';
import { chooseAll, designBranches, hasBranches, heldLines, keepChoices, MAIN, resolvePayload, unresolved, type BranchConflict, type BranchSide, type BranchSummary, type Choices, type DesignBranchRow, type MergePreview } from '../lib/design-branches-api.ts';
import { useEditor } from '../state/store.ts';
import { IconButton, Popover } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';
import '../styles/design-branches.css';
const VersionsDialog = lazy(() => import('./VersionsDialog.tsx').then(m => ({ default: m.VersionsDialog })));


type View =
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'discard'; branch: DesignBranchRow }
  | { kind: 'merge'; branch: DesignBranchRow; preview: MergePreview | null; conflicts: BranchConflict[]; choices: Choices };

const branchName = (b: Pick<DesignBranchRow, 'id' | 'name'>) => (b.id === MAIN ? t('Main') : b.name);

function changeWord(what: BranchConflict['primary'], name: string): string {
  return what === 'removed' ? t('Removed on {name}', { name }) : what === 'added' ? t('Added on {name}', { name }) : t('Changed on {name}', { name });
}

/** One conflict and the person's answer: which side keeps it. */
function ConflictRow({ conflict, choice, branch, into, onChoose }: { conflict: BranchConflict; choice: BranchSide | undefined; branch: string; into: string; onChoose: (side: BranchSide) => void }) {
  const t = useT();
  return (
    <li className="db-conflict" data-testid="branch-conflict" data-key={conflict.key}>
      <div className="db-conflict-text">
        <span className="db-name" dir="auto">{conflict.label}</span>
        <span className="db-meta">{[changeWord(conflict.branch, branch), changeWord(conflict.primary, into)].join(' · ')}</span>
      </div>
      <div className="db-sides" role="radiogroup" aria-label={t('Which side keeps {what}', { what: conflict.label })}>
        <button type="button" role="radio" aria-checked={choice === 'branch'} className={`db-side${choice === 'branch' ? ' is-on' : ''}`} onClick={() => onChoose('branch')} data-testid="branch-conflict-branch" dir="auto">{branch}</button>
        <button type="button" role="radio" aria-checked={choice === 'primary'} className={`db-side${choice === 'primary' ? ' is-on' : ''}`} onClick={() => onChoose('primary')} data-testid="branch-conflict-primary" dir="auto">{into}</button>
      </div>
    </li>
  );
}

/**
 * The branches of the open file, next to its name: which one is checked out, switching, starting one, and the person's
 * decisions on a branch (merge after a review of what both sides changed, discard after a confirmation, restore, undo
 * a merge). Reads the branch records from the document as it syncs; asks the server only when the file opens, when
 * the records change, and while the menu is open. Never loads a branch's content: only the server swaps it in.
 */
export function BranchMenu({ compact, onLabel }: { compact: boolean; /** Whether the file has branches and which one is out, for the toolbar's room and its More menu. */ onLabel?: (named: boolean, name: string) => void }) {
  const t = useT();
  const fileId = useEditor((st) => st.fileId);
  const s = session();
  const [local, setLocal] = useState<LocalBranch>(() => localBranch(s.y));
  const [summary, setSummary] = useState<BranchSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const closeVersions = useCallback(() => setVersionsOpen(false), []);
  useEffect(() => { const open = () => { setOpen(false); setVersionsOpen(true); }; window.addEventListener('bogen:versions', open); return () => window.removeEventListener('bogen:versions', open); }, []);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDecided, setShowDecided] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLButtonElement>(null);
  const watching = useRef(false);
  watching.current = open || hasBranches(summary) || local.open + local.decided > 0;

  const load = useCallback(() => {
    if (!fileId) return;
    designBranches.list(fileId).then(setSummary).catch(() => { /* an older server: the control stays quiet */ });
  }, [fileId]);

  // One request when the file opens.
  useEffect(() => {
    setSummary(null);
    load();
  }, [load]);

  // The records in this editor's copy of the document: the label follows at once, the list a moment later.
  useEffect(() => {
    setLocal(localBranch(s.y));
    let timer = 0;
    const off = onBranchRecords(s.y, () => {
      setLocal(localBranch(s.y));
      clearTimeout(timer);
      timer = window.setTimeout(load, 400);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [s, load]);

  // The server says a file's history moved; only a file with branches, or an open menu, asks again.
  useEffect(() => {
    let timer = 0;
    const off = onServerEvent((e) => {
      if (e.t !== 'history' || e.fileId !== fileId || !watching.current) return;
      clearTimeout(timer);
      timer = window.setTimeout(load, 600);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [fileId, load]);

  const known = local.open + local.decided > 0;
  const fromServer = summary?.branches.find((b) => b.current);
  const currentId = known || !fromServer ? local.current : fromServer.id;
  const currentName = currentId === MAIN ? t('Main') : known ? local.name ?? currentId : fromServer?.name ?? currentId;
  const named = Boolean(fileId) && (known || hasBranches(summary));

  // Data, not layout: the toolbar's room follows whether there are branches, never the label's measured width.
  useEffect(() => {
    onLabel?.(named, currentName);
  }, [onLabel, named, currentName]);

  if (!fileId) return null;
  const openBranches = summary?.branches ?? [];
  const decided = summary?.decided ?? [];

  const act = async (fn: () => Promise<BranchSummary | null | void>, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await fn();
      if (next) setSummary({ current: next.current, branches: next.branches, decided: next.decided });
      else load();
      if (done) setNotice(done);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = () => {
    if (!open) {
      setView({ kind: 'list' });
      setError(null);
      setNotice(null);
      load();
    }
    setOpen(!open);
  };

  const startMerge = async (branch: DesignBranchRow) => {
    setView({ kind: 'merge', branch, preview: null, conflicts: [], choices: {} });
    setError(null);
    setNotice(null);
    try {
      const preview = await designBranches.preview(fileId, branch.id);
      setView({ kind: 'merge', branch, preview, conflicts: preview.conflicts, choices: {} });
    } catch (e) {
      setError((e as Error).message);
      setView({ kind: 'list' });
    }
  };

  const merge = async (v: Extract<View, { kind: 'merge' }>) => {
    const resolve = resolvePayload(v.conflicts, v.choices);
    if (resolve === null) return;
    setBusy(true);
    setError(null);
    try {
      const out = await designBranches.merge(fileId, v.branch.id, resolve);
      setSummary({ current: out.current, branches: out.branches, decided: out.decided });
      if (out.merged) {
        setView({ kind: 'list' });
        setNotice(t('Merged {branch} into {into}. Undo merge is under Decided.', { branch: out.merged.name, into: branchName(out.into) }));
      } else {
        // Something changed meanwhile: the answers that still apply stay, the new conflicts wait for the person.
        setView({ ...v, conflicts: out.conflicts, choices: keepChoices(out.conflicts, v.choices) });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    const ok = await act(() => designBranches.create(fileId, { name: n, from: currentId, checkout: true }), t('Started {name}. You are working on it now; {from} stays as it is.', { name: n, from: currentName }));
    if (ok) {
      setName('');
      setView({ kind: 'list' });
    }
  };

  const label = compact || !named ? null : currentName;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`db-trigger${open ? ' is-active' : ''}${currentId !== MAIN ? ' is-branch' : ''}`}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('Branches, on {branch}', { branch: currentName })}
        title={t('Branches of this file: on {branch}', { branch: currentName })}
        data-testid="branch-menu"
        data-branch={currentId}
      >
        <GitBranch size={14} aria-hidden="true" />
        {label ? <span className="db-trigger-name" dir="auto">{label}</span> : null}
      </button>
      {versionsOpen ? <Suspense fallback={null}><VersionsDialog onClose={closeVersions} onMerge={branch => { setVersionsOpen(false); setOpen(true); void startMerge(branch); }} /></Suspense> : null}
      {open ? (
        <Popover anchor={ref.current} side="below" width={320} onClose={() => setOpen(false)} className="db-pop" focus>
          <div role="dialog" aria-label={t('Branches')} data-testid="branch-panel" className="db-panel">
            {view.kind === 'merge' ? (
              <MergeReview
                view={view}
                busy={busy}
                onChoose={(key, side) => setView({ ...view, choices: { ...view.choices, [key]: side } })}
                onAll={(side) => setView({ ...view, choices: chooseAll(view.conflicts, side) })}
                onMerge={() => void merge(view)}
                onBack={() => setView({ kind: 'list' })}
              />
            ) : view.kind === 'discard' ? (
              <div className="db-confirm" data-testid="branch-discard-confirm">
                <p className="db-text" dir="auto">{t('Discard {name}? The main design stays as it is, and you can restore the branch under Decided.', { name: view.branch.name })}</p>
                <div className="db-buttons">
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void act(() => designBranches.discard(fileId, view.branch.id), t('Discarded {name}.', { name: view.branch.name })).then((ok) => { if (ok) setView({ kind: 'list' }); })} data-testid="branch-discard-yes">{t('Discard')}</button>
                  <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setView({ kind: 'list' })}>{t('Cancel')}</button>
                </div>
              </div>
            ) : (
              <>
                <div className="db-head">
                  <span className="db-title">{t('Branches')}</span>
                  <button type="button" className="btn btn-quiet db-new" data-testid="versions-open" onClick={() => { setOpen(false); setVersionsOpen(true); }}>{t('Versions')}…</button>
                  {view.kind !== 'new' ? <button type="button" className="btn btn-quiet db-new" onClick={() => { setView({ kind: 'new' }); setError(null); }} disabled={busy} data-testid="branch-new"><Plus size={13} /> {t('New branch…')}</button> : null}
                </div>
                <p className="db-hint">{t('Versions of the whole design inside this file: layers, tokens, components and its settings. Only you merge or discard a branch.')}</p>
                {view.kind === 'new' ? (
                  <form className="db-form" onSubmit={(e) => { e.preventDefault(); void create(); }} data-testid="branch-new-form">
                    <input autoFocus className="token-input" placeholder={t('Branch name')} aria-label={t('Branch name')} dir="auto" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); setView({ kind: 'list' }); } }} data-testid="branch-new-name" />
                    <button type="submit" className="btn" disabled={busy || !name.trim()} data-testid="branch-new-start">{t('Start')}</button>
                    <span className="db-meta db-form-note">{t('Starts from {branch} and switches to it.', { branch: currentName })}</span>
                  </form>
                ) : null}
                <div role="list" aria-label={t('Open branches')} className="db-list" data-testid="branch-list">
                  {(openBranches.length ? openBranches : [{ id: MAIN, name: 'Main', parent: null, status: 'open', current: true, changed: false, by: '', at: null } satisfies DesignBranchRow]).map((b) => {
                    const on = b.id === currentId;
                    return (
                      <div key={b.id} role="listitem" className={`db-row${on ? ' is-current' : ''}`} data-testid="branch-row" data-branch-id={b.id}>
                        <button type="button" className="db-main" aria-current={on ? 'true' : undefined} disabled={busy || on} onClick={() => void act(() => designBranches.switchTo(fileId, b.id), t('Switched to {name}. Undo starts afresh on it.', { name: branchName(b) }))} title={on ? t('You are working on {name}', { name: branchName(b) }) : t('Switch to {name}', { name: branchName(b) })} data-testid="branch-switch">
                          <span className="db-check" aria-hidden="true">{on ? <Check size={12} /> : null}</span>
                          <span className="db-name" dir="auto">{branchName(b)}</span>
                          {b.id !== MAIN ? <span className="db-meta">{b.changed ? t('changed') : t('no changes yet')}</span> : null}
                        </button>
                        {b.id !== MAIN ? (
                          <>
                            <IconButton className="db-action" icon={<GitMerge size={13} />} title={t('Review and merge into {name}', { name: branchName(openBranches.find((p) => p.id === b.parent) ?? { id: b.parent ?? MAIN, name: b.parent ?? MAIN }) })} disabled={busy} onClick={() => void startMerge(b)} testId="branch-merge" />
                            <IconButton className="db-action" icon={<Trash2 size={13} />} title={t('Discard {name}', { name: b.name })} disabled={busy} onClick={() => { setError(null); setView({ kind: 'discard', branch: b }); }} testId="branch-discard" />
                          </>
                        ) : null}
                        {b.note ? <span className="db-note" dir="auto">{b.note}</span> : null}
                        {heldLines(b.held).map((h) => <span key={h.from} className="db-note db-held" dir="auto" data-testid="branch-held" title={t('Kept as they came, because they could not be laid on this branch safely. Nothing is needed from you now.')}>{t.n(h.count, '{count} update from {from} held back', '{count} updates from {from} held back', { from: h.from })}</span>)}
                      </div>
                    );
                  })}
                </div>
                {decided.length ? (
                  <div className="db-decided" data-testid="branch-decided">
                    <button type="button" className="db-toggle" aria-expanded={showDecided} onClick={() => setShowDecided(!showDecided)} data-testid="branch-decided-toggle">
                      {showDecided ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {t.n(decided.length, 'Decided, {count} branch', 'Decided, {count} branches')}
                    </button>
                    {showDecided ? decided.map((b) => (
                      <div key={b.id} className="db-row is-decided" data-testid="branch-decided-row" data-branch-id={b.id}>
                        <div className="db-main is-static">
                          <span className="db-check" aria-hidden="true" />
                          <span className="db-name" dir="auto">{b.name}</span>
                          <span className="db-meta">{b.status === 'merged' ? t('merged') : t('discarded')}</span>
                        </div>
                        {b.status === 'merged' ? <IconButton className="db-action" icon={<Undo2 size={13} />} title={t('Undo this merge')} disabled={busy} onClick={() => void act(() => designBranches.undoMerge(fileId, b.id), t('Took back the merge of {name}.', { name: b.name }))} testId="branch-undo-merge" /> : null}
                        {b.status === 'discarded' && b.canRestore ? <IconButton className="db-action" icon={<RotateCcw size={13} />} title={t('Restore {name}', { name: b.name })} disabled={busy} onClick={() => void act(() => designBranches.restore(fileId, b.id), t('Restored {name}.', { name: b.name }))} testId="branch-restore" /> : null}
                      </div>
                    )) : null}
                  </div>
                ) : null}
              </>
            )}
            {notice ? <div className="db-notice" role="status" dir="auto" data-testid="branch-notice">{notice}</div> : null}
            {error ? <div className="error db-error" role="alert" dir="auto" data-testid="branch-error">{error}</div> : null}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

function MergeReview({ view, busy, onChoose, onAll, onMerge, onBack }: { view: Extract<View, { kind: 'merge' }>; busy: boolean; onChoose: (key: string, side: BranchSide) => void; onAll: (side: BranchSide) => void; onMerge: () => void; onBack: () => void }) {
  const t = useT();
  const { preview, conflicts, choices } = view;
  const branch = view.branch.name;
  const into = preview ? branchName(preview.into) : branchName({ id: view.branch.parent ?? MAIN, name: view.branch.parent ?? MAIN });
  const left = unresolved(conflicts, choices).length;
  return (
    <div className="db-merge" data-testid="branch-merge-review">
      <div className="db-head"><span className="db-title" dir="auto">{t('Merge {branch} into {into}', { branch, into })}</span></div>
      {!preview ? <p className="db-hint">{t('Comparing')}</p> : (
        <>
          {!preview.branch_changed ? <p className="db-text">{t('This branch has no changes yet.')}</p> : null}
          {conflicts.length ? (
            <>
              <p className="db-text">{t.n(conflicts.length, 'One thing changed on both sides. Choose which side keeps it.', '{count} things changed on both sides. Choose which side keeps each.')}</p>
              <div className="db-buttons">
                <button type="button" className="btn btn-quiet" onClick={() => onAll('branch')} disabled={busy} data-testid="branch-all-branch" dir="auto">{t('All from {name}', { name: branch })}</button>
                <button type="button" className="btn btn-quiet" onClick={() => onAll('primary')} disabled={busy} data-testid="branch-all-primary" dir="auto">{t('All from {name}', { name: into })}</button>
              </div>
              <ul className="db-conflicts">
                {conflicts.map((c) => <ConflictRow key={c.key} conflict={c} choice={choices[c.key]} branch={branch} into={into} onChoose={(side) => onChoose(c.key, side)} />)}
              </ul>
            </>
          ) : (
            <p className="db-text">{preview.parent_changed ? t('{into} changed too, in other places. Merging keeps the changes of both.', { into }) : t('{into} has not changed since this branch started. Merging makes it what the branch is.', { into })}</p>
          )}
          <p className="db-hint">{t('A commit is made first, so the merge can be undone.')}</p>
        </>
      )}
      <div className="db-buttons">
        <button type="button" className="btn btn-primary" onClick={onMerge} disabled={busy || !preview || left > 0} data-testid="branch-merge-confirm">
          <GitMerge size={13} /> {left ? t.n(left, '{count} to choose', '{count} to choose') : t('Merge')}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onBack} disabled={busy}>{t('Back')}</button>
      </div>
    </div>
  );
}
