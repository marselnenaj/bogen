import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyContent, applyPlan, labelChange } from '@bogen/core';
import { ChevronDown, ChevronRight, Eye, GitBranch, GitCompare, GitMerge, GitPullRequest, Play, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import { session } from '../doc/session.ts';
import { onServerEvent } from '../lib/events.ts';
import { designBranches } from '../lib/design-branches-api.ts';
import { history, type BranchRow, type ChangeRow, type CommitDiff, type CommitRow, type HistoryRow, type RevertPlanAnswer } from '../lib/history-api.ts';
import { editor, useEditor } from '../state/store.ts';
import { IconButton, Empty } from '../ui/controls.tsx';
import { setStageView, showCompare, useCommitFocus, useStageView } from './history-state.ts';
import { openPullRequest } from './PullRequestDialog.tsx';
import { useLinkedProject } from '../lib/code-api.ts';
import '../styles/transfer.css';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';
import { formatDate } from '../i18n/format.ts';
import { jumpToLayers } from '../ops/jump.ts';
import { locationName, visitEdit } from '../lib/recent-edits.ts';

function timeOf(at: number): string {
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 60) return t('just now');
  if (s < 3600) return t.n(Math.floor(s / 60), '{count}m ago', '{count}m ago');
  if (s < 86400) return t.n(Math.floor(s / 3600), '{count}h ago', '{count}h ago');
  return formatDate(at, { month: 'short', day: 'numeric' });
}

function kindWord(row: CommitRow): string {
  return row.kind === 'run' ? t('Agent run') : row.kind === 'restore' ? t('Restore point') : row.kind === 'auto' ? t('Automatic') : t('Commit');
}

/** A version a pull request can start from: a commit, or the file as it is now. Not a branch. */
const VERSION_REF = /^(now|[0-9a-z]{6,14}-[0-9a-f]{8})$/;

type Group =
  | { type: 'commit'; row: CommitRow }
  | { type: 'change'; row: ChangeRow }
  | { type: 'run'; run: string; actor: string; rows: ChangeRow[] };

/** Consecutive changes of one agent run read as one line, which opens. */
function groupRows(rows: HistoryRow[], showAuto: boolean): Group[] {
  const out: Group[] = [];
  for (const row of rows) {
    if (row.row === 'commit') {
      if (row.kind !== 'auto' || showAuto) out.push({ type: 'commit', row });
      continue;
    }
    const last = out.at(-1);
    if (row.run) {
      if (last?.type === 'run' && last.run === row.run) last.rows.push(row);
      else out.push({ type: 'run', run: row.run, actor: row.actor, rows: [row] });
    } else out.push({ type: 'change', row });
  }
  return out;
}

function ChangeLine({ row, onRevert, busy }: { row: ChangeRow; onRevert: (query: { ids: string[] }, what: string) => void; busy: boolean }) {
  const t = useT();
  const select = () => {
    const s = session(), known = row.layers.filter((id) => s.snap.nodes.has(id));
    const page = known[0] ? s.doc.pageOf(known[0]) : null;
    if (page) jumpToLayers(known.filter(id => s.doc.pageOf(id) === page), page);
    else if (row.locations?.[0]) visitEdit(row.locations[0]);
  };
  return (
    <div className={`hist-row${row.revertedBy ? ' is-reverted' : ''}`} data-testid="history-change" data-change-id={row.id}>
      <button type="button" className="hist-main" onClick={select} title={row.fields?.join(', ') ?? row.summary}>
        <span className="hist-title" dir="auto">{row.summary}</span>
        {row.locations?.length ? <span className="history-location" dir="auto">{row.locations.map(locationName).join(' / ')}</span> : null}
        <span className="hist-meta">{row.actor}{row.tool ? ` · ${row.tool}` : ''} · {timeOf(row.at)} · {row.deviceName}{row.revertedBy ? ` · ${t('reverted')}` : ''}</span>
      </button>
      {row.revertable
        ? <IconButton className="hist-action" icon={<Undo2 size={13} />} title={t('Revert this change')} disabled={busy} onClick={() => onRevert({ ids: [row.id] }, row.summary)} testId="history-revert" />
        : <span className="hist-gone" title={t('Too old: its details were thinned out, so it cannot be reverted any more.')}>{t('old')}</span>}
    </div>
  );
}

function DiffView({ diff, onPage }: { diff: CommitDiff; onPage: (pageId: string, name: string) => void }) {
  const t = useT();
  if (diff.same) return <div className="hint hist-diff" data-testid="history-diff">{t('No differences.')}</div>;
  const short = (list: string[]) => (list.length > 8 ? t.n(list.length - 8, '{list} and {count} more', '{list} and {count} more', { list: list.slice(0, 8).join(', ') }) : list.join(', '));
  return (
    <div className="hist-diff" data-testid="history-diff">
      <div className="hist-diff-counts">{t('{added} added, {removed} removed, {changed} changed', { added: diff.counts.added, removed: diff.counts.removed, changed: diff.counts.changed })}</div>
      {diff.pages.added.length ? <div>{t('Pages added: {pages}', { pages: short(diff.pages.added) })}</div> : null}
      {diff.pages.removed.length ? <div>{t('Pages removed: {pages}', { pages: short(diff.pages.removed) })}</div> : null}
      {diff.pages.renamed.map((r) => <div key={r.to}>{t('Page renamed: {from} to {to}', { from: r.from, to: r.to })}</div>)}
      {diff.layers.map((page) => (
        <div key={page.page} className="hist-diff-page">
          <div className="hist-diff-name" dir="auto">{page.page}</div>
          {page.added.length ? <div className="hist-add">{t('Added: {layers}', { layers: short(page.added) })}</div> : null}
          {page.removed.length ? <div className="hist-del">{t('Removed: {layers}', { layers: short(page.removed) })}</div> : null}
          {page.changed.slice(0, 40).map((c) => (
            <div key={c.id} className="hist-chg" data-testid="history-diff-layer"><span className="hist-chg-name" dir="auto">{c.name || c.id}</span> {c.fields.join(', ')}</div>
          ))}
          {page.changed.length > 40 ? <div className="hint">{t.n(page.changed.length - 40, 'and {count} more', 'and {count} more')}</div> : null}
        </div>
      ))}
      {diff.tokens.added.length || diff.tokens.removed.length || diff.tokens.changed.length ? <div>{t('Tokens: {added} added, {removed} removed, {changed} changed', { added: diff.tokens.added.length, removed: diff.tokens.removed.length, changed: diff.tokens.changed.length })}</div> : null}
      {diff.comments.added || diff.comments.removed || diff.comments.changed ? <div>{t('Comments: {added} added, {removed} removed, {changed} changed', { added: diff.comments.added, removed: diff.comments.removed, changed: diff.comments.changed })}</div> : null}
      {diff.assets.added.length || diff.assets.removed.length ? <div>{t('Files: {added} added, {removed} removed', { added: diff.assets.added.length, removed: diff.assets.removed.length })}</div> : null}
      {diff.changedPages.length ? (
        <div className="hist-diff-pages">
          {diff.changedPages.map((p) => <button key={p.id} type="button" className="btn btn-quiet" onClick={() => onPage(p.id, p.name)} data-testid="history-diff-page">{t('Show {page} side by side', { page: p.name })}</button>)}
        </div>
      ) : null}
    </div>
  );
}

function RevertNotice({ plan, what, onClose }: { plan: RevertPlanAnswer; what: string; onClose: () => void }) {
  const t = useT();
  return (
    <div className="hist-notice" data-testid="history-notice" data-clean={plan.clean}>
      <div className="hist-notice-head">
        <span>{plan.clean ? t('Reverted: {what}', { what }) : plan.reverted ? t('Partly reverted: {what}', { what }) : t('Could not revert: {what}', { what })}</span>
        <IconButton icon={<X size={12} />} title={t('Close')} onClick={onClose} />
      </div>
      {plan.conflicts.length ? (
        <>
          <div>{t.n(plan.reverted, '{count} field went back. These stayed as they are:', '{count} fields went back. These stayed as they are:')}</div>
          {plan.conflicts.slice(0, 12).map((c, i) => (
            <div key={i} className="hist-conflict" data-testid="history-conflict">
              <span className="hist-chg-name" dir="auto">{c.what}</span>{c.field ? ` ${c.field}` : ''}: {c.reason}
              {c.now !== undefined && typeof c.now === 'string' ? <>{' '}{typeof c.wanted === 'string' ? t('Now {now}, would have been {wanted}.', { now: c.now, wanted: c.wanted }) : t('Now {now}.', { now: c.now })}</> : null}
            </div>
          ))}
          {plan.conflicts.length > 12 ? <div className="hint">{t.n(plan.conflicts.length - 12, 'and {count} more', 'and {count} more')}</div> : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Starting a branch here makes one inside this file (lib/design-branches-api.ts): the branch menu next to the file name
 * switches, merges and discards it. Branches made by earlier versions as separate files ("Older copies") are still
 * listed, compared, merged and discarded as before.
 */
function Branches({ fileId, author, onChanged }: { fileId: string; author: string; onChanged: () => void }) {
  const t = useT();
  const [list, setList] = useState<BranchRow[]>([]);
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => void history.branches(fileId).then(setList).catch(() => setList([])), [fileId]);
  useEffect(() => { if (open) load(); }, [open, load]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      load();
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const start = async () => {
    const n = name.trim();
    if (!n) return;
    if (await act(() => designBranches.create(fileId, { name: n, checkout: true }))) {
      setName('');
      setNotice(t('Started {name} inside this file and switched to it. The branch menu next to the file name switches back, merges or discards it.', { name: n }));
    }
  };
  return (
    <div className="hist-branches" data-testid="history-branches">
      <button type="button" className="hist-toggle" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="history-branches-toggle">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {t('Branches')}
      </button>
      {open ? (
        <>
          <p className="hint">{t('A branch is a version of the whole design inside this file, not a file of its own: layers, tokens, components and settings. Only you merge or discard it, after looking at what both sides changed.')}</p>
          <form className="hist-commit" onSubmit={(e) => { e.preventDefault(); void start(); }}>
            <input className="token-input" placeholder={t('Branch name')} aria-label={t('Branch name')} dir="auto" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="history-branch-name" />
            <button type="submit" className="btn" disabled={!name.trim()} data-testid="history-branch-create"><GitBranch size={13} /> {t('Branch')}</button>
          </form>
          {notice ? <div className="hint" role="status" dir="auto" data-testid="history-branch-notice">{notice}</div> : null}
          {list.length ? (
            <div className="hist-older" data-testid="history-older-copies">
              <div className="hint"><strong>{t('Older copies')}</strong> {t('Made as separate files by an earlier version of Bogen. They stay until you merge or discard them; merging goes through sync, so what both sides changed in one field ends with the later edit.')}</div>
              {list.map((b) => (
                <div key={b.id} className="hist-row" data-testid="history-branch">
                  <a className="hist-main" href={`#/file/${b.id}`}>
                    <span className="hist-title" dir="auto">{b.name}</span>
                    <span className="hist-meta">{timeOf(b.at)}{b.exists ? '' : ` · ${t('gone')}`}</span>
                  </a>
                  {b.exists ? <IconButton className="hist-action" icon={<GitCompare size={13} />} title={t('Compare with this file')} onClick={() => void act(async () => { document.dispatchEvent(new CustomEvent('bogen-history-compare', { detail: { from: 'now', to: `branch:${b.id}`, label: b.name } })); })} testId="history-branch-compare" /> : null}
                  {b.exists ? <IconButton className="hist-action" icon={<GitMerge size={13} />} title={t('Merge into this file')} onClick={() => void act(() => history.merge(fileId, b.id, author))} testId="history-branch-merge" /> : null}
                  <IconButton className="hist-action" icon={<Trash2 size={13} />} title={t('Discard this branch')} onClick={() => void act(() => history.discard(fileId, b.id))} testId="history-branch-discard" />
                </div>
              ))}
            </div>
          ) : null}
          {error ? <div className="error" role="alert" dir="auto">{error}</div> : null}
        </>
      ) : null}
    </div>
  );
}

/** Commits and changes in one list, newest first. */
export function HistoryPanel() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId);
  const pageId = useEditor((s) => s.pageId);
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ plan: RevertPlanAnswer; what: string } | null>(null);
  const [showAuto, setShowAuto] = useState(false);
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());
  const [compare, setCompare] = useState<{ from: string; to: string; fromLabel: string; toLabel: string; diff: CommitDiff | null } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusAsk = useCommitFocus();
  const stage = useStageView();
  const linked = useLinkedProject();
  const s = session();

  const load = useCallback(() => {
    if (fileId) void history.list(fileId).then(setRows).catch((e: Error) => setError(e.message));
  }, [fileId]);

  useEffect(() => {
    load();
    let timer = 0;
    const off = onServerEvent((e) => {
      if (e.t === 'history' && e.fileId === fileId) {
        // A burst of changes reads the list once.
        clearTimeout(timer);
        timer = window.setTimeout(load, 300);
      }
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [fileId, load]);

  useEffect(() => {
    if (focusAsk) inputRef.current?.focus();
  }, [focusAsk]);

  useEffect(() => () => setStageView(null), []);

  const groups = useMemo(() => groupRows(rows ?? [], showAuto), [rows, showAuto]);

  const commit = async () => {
    const text = message.trim();
    if (!fileId || !text) return;
    setBusy(true);
    setError(null);
    try {
      await history.commit(fileId, text, s.user.name);
      setMessage('');
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revert = async (query: { ids?: string[]; run?: string }, what: string) => {
    if (!fileId) return;
    setBusy(true);
    setError(null);
    try {
      const plan = await history.plan(fileId, query);
      // In this editor's own transaction, so that Ctrl+Z takes it back like anything else.
      if (plan.ops.length) {
        s.tx(() => {
          applyPlan(s.doc, plan.ops);
          labelChange(s.doc, { label: `Revert: ${what}`.slice(0, 200), revertOf: plan.changes });
        });
      }
      setNotice({ plan, what });
      setTimeout(load, 300);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (row: CommitRow) => {
    if (!fileId) return;
    setBusy(true);
    setError(null);
    try {
      const content = await history.content(fileId, row.id);
      // Whatever is here now is committed first, so nothing is lost.
      await history.commit(fileId, `Before restoring ${row.message ?? row.id}`, s.user.name, 'restore');
      s.tx(() => {
        applyContent(s.doc, content);
        labelChange(s.doc, { label: `Restored ${row.message ?? row.id}`.slice(0, 200), restoreOf: row.id });
      });
      setStageView(null);
      setTimeout(load, 300);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const preview = async (row: CommitRow) => {
    if (!fileId) return;
    try {
      setStageView({ kind: 'preview', id: row.id, label: row.message ?? `${kindWord(row)}, ${timeOf(row.at)}`, content: await history.content(fileId, row.id) });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const startCompare = useCallback(async (from: string, to: string, fromLabel: string, toLabel: string) => {
    if (!fileId) return;
    setCompare({ from, to, fromLabel, toLabel, diff: null });
    try {
      const diff = await history.diff(fileId, from, to);
      setCompare({ from, to, fromLabel, toLabel, diff });
    } catch (e) {
      setError((e as Error).message);
      setCompare(null);
    }
  }, [fileId]);

  useEffect(() => {
    const on = (e: Event) => {
      const { from, to, label } = (e as CustomEvent<{ from: string; to: string; label: string }>).detail;
      void startCompare(from, to, t('This file'), label);
    };
    document.addEventListener('bogen-history-compare', on);
    return () => document.removeEventListener('bogen-history-compare', on);
  }, [startCompare, t]);

  const showPage = async (pageId: string, pageName: string) => {
    if (!fileId || !compare) return;
    await showCompare(fileId, { from: compare.from, to: compare.to, fromLabel: compare.fromLabel, toLabel: compare.toLabel, pageId, pageName });
  };

  const toggleRun = (run: string) => {
    const next = new Set(openRuns);
    if (next.has(run)) next.delete(run);
    else next.add(run);
    setOpenRuns(next);
  };

  return (
    <div className="history" data-testid="history-panel">
      <form className="hist-commit" onSubmit={(e) => { e.preventDefault(); void commit(); }}>
        <input
          ref={inputRef}
          className="token-input"
          placeholder={t('Commit message')}
          dir="auto"
          value={message}
          data-testid="history-message"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') e.currentTarget.blur(); }}
        />
        <button type="submit" className="btn" disabled={busy || !message.trim()} title={t('Commit ({shortcut})', { shortcut: 'Ctrl+Alt+S' })} data-testid="history-commit">{t('Commit')}</button>
      </form>
      <div className="hist-tools">
        <button type="button" className="btn btn-quiet" data-testid="history-versions" onClick={() => window.dispatchEvent(new Event('bogen:versions'))}>{t('Versions')}…</button>
        <label className="hist-auto"><input type="checkbox" checked={showAuto} onChange={(e) => setShowAuto(e.target.checked)} data-testid="history-show-auto" /><span>{t('Show automatic commits')}</span></label>
        <button type="button" className="btn btn-quiet" disabled={!fileId || !pageId} onClick={() => fileId && pageId && setStageView({ kind: 'replay', fileId, pageId })} title={t('Play back how this page was built, step by step')} data-testid="history-replay"><Play size={12} /> {t('Replay')}</button>
      </div>
      {error ? <div className="error hist-pad" data-testid="history-error">{error}</div> : null}
      {notice ? <RevertNotice plan={notice.plan} what={notice.what} onClose={() => setNotice(null)} /> : null}
      {compare ? (
        <div className="hist-compare">
          <div className="hist-notice-head">
            <span>{t('{from} compared with {to}', { from: compare.fromLabel, to: compare.toLabel })}</span>
            {linked && VERSION_REF.test(compare.from) && VERSION_REF.test(compare.to) && compare.from !== compare.to ? (
              <IconButton icon={<GitPullRequest size={12} />} title={t('Open a pull request from this change')} onClick={() => openPullRequest({ kind: 'versions', from: compare.from, to: compare.to }, t('{from} compared with {to}.', { from: compare.fromLabel, to: compare.toLabel }))} testId="history-compare-pr" />
            ) : null}
            <IconButton icon={<X size={12} />} title={t('Close')} onClick={() => { setCompare(null); if (stage?.kind === 'compare') setStageView(null); }} />
          </div>
          {compare.diff ? <DiffView diff={compare.diff} onPage={(id, name) => void showPage(id, name)} /> : <div className="hint">{t('Comparing')}</div>}
        </div>
      ) : null}
      {rows && !groups.length ? <Empty title={t('Nothing yet')} hint={t('Every change to this file appears here, with who made it. Press {shortcut} to commit where things stand.', { shortcut: 'Ctrl+Alt+S' })} /> : null}
      <div className="hist-list" data-testid="history-list">
        {groups.map((group) => {
          if (group.type === 'commit') {
            const { row } = group;
            return (
              <div key={row.id} className={`hist-row is-commit${row.kind === 'auto' ? ' is-auto' : ''}`} data-testid="history-commit-row" data-commit-id={row.id}>
                <div className="hist-main">
                  <span className="hist-title" dir="auto">{row.message ?? kindWord(row)}</span>
                  <span className="hist-meta">{kindWord(row)}{row.author ? ` · ${row.author}` : ''} · {timeOf(row.at)}{row.deviceName ? ` · ${row.deviceName}` : ''}</span>
                </div>
                <IconButton className="hist-action" icon={<Eye size={13} />} title={t('Look at this version on the canvas')} onClick={() => void preview(row)} testId="history-preview" />
                <IconButton className="hist-action" icon={<GitCompare size={13} />} title={t('Compare with now')} onClick={() => void startCompare(row.id, 'now', row.message ?? kindWord(row), t('now'))} testId="history-compare" />
                <IconButton className="hist-action" icon={<RotateCcw size={13} />} title={t('Restore this version. What is here now is committed first.')} disabled={busy} onClick={() => void restore(row)} testId="history-restore" />
              </div>
            );
          }
          if (group.type === 'change') return <ChangeLine key={group.row.id} row={group.row} busy={busy} onRevert={(q, what) => void revert(q, what)} />;
          const open = openRuns.has(group.run);
          const all = group.rows;
          return (
            <div key={`${group.run}-${all[0]!.id}`} className="hist-run" data-testid="history-run">
              <div className="hist-row">
                <button type="button" className="hist-main hist-run-main" onClick={() => toggleRun(group.run)}>
                  <span className="hist-title">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {t.n(all.length, '{actor} run, {count} change', '{actor} run, {count} changes', { actor: group.actor })}</span>
                  <span className="hist-meta">{timeOf(all[0]!.at)} · {all[0]!.deviceName}</span>
                </button>
                <IconButton className="hist-action" icon={<Undo2 size={13} />} title={t('Revert everything this run did')} disabled={busy} onClick={() => void revert({ run: group.run }, `${group.actor} run`)} testId="history-revert-run" />
              </div>
              {open ? all.map((row) => <ChangeLine key={row.id} row={row} busy={busy} onRevert={(q, what) => void revert(q, what)} />) : null}
            </div>
          );
        })}
      </div>
      {fileId ? <Branches fileId={fileId} author={s.user.name} onChanged={load} /> : null}
    </div>
  );
}
