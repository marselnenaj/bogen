import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { session } from '../doc/session.ts';
import { pullApi, pullRepoTokens, repoTokens, useLinkedProject, type LinkedProject, type RepoTokensAnswer, type TokenDiffRow, type TokenDiffStatus } from '../lib/code-api.ts';
import { editor } from '../state/store.ts';
import { ui, useUi } from '../state/ui.ts';
import { IconButton } from '../ui/controls.tsx';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';
import '../styles/code.css';

/**
 * The linked repository's tokens next to the file's: pulled into the file as one undo step, or pushed into the
 * repository as a pull request, which the pull request dialog shows before anything leaves this machine.
 */

const STATUS: { value: TokenDiffStatus; label: string }[] = [
  { value: 'changed', label: msg('Changed') },
  { value: 'file', label: msg('Only in the file') },
  { value: 'repo', label: msg('Only in the repository') },
  { value: 'same', label: msg('Same') },
];

const FORMAT: Record<string, string> = { css: msg('CSS variables'), tailwind: msg('CSS variables and @theme'), tailwind3: msg('Tailwind 3 config, read only'), dtcg: 'DTCG' };

export function RepoTokensDialog() {
  const open = useUi((s) => s.repoTokensOpen);
  const project = useLinkedProject();
  return open && project ? <Body project={project} /> : null;
}

function Swatch({ value }: { value?: string }) {
  return value && /^(#|rgb|hsl|oklch|oklab|color)/.test(value) ? <span className="rt-swatch" style={{ background: value }} /> : null;
}

function Value({ row, side }: { row: TokenDiffRow; side: 'file' | 'repo' }) {
  const t = useT();
  const v = row[side];
  const modes = (row.modes ?? []).filter((m) => m[side] !== undefined && m.file !== m.repo);
  if (v === undefined && !modes.length) return <span className="rt-value is-none">{t('none')}</span>;
  return (
    <span className="rt-value">
      {v !== undefined ? <span className="rt-line"><Swatch value={v} /><span>{v}</span></span> : null}
      {modes.map((m) => <span key={m.mode} className="rt-line rt-mode"><Swatch value={m[side]} /><span>{m.mode}: {m[side]}</span></span>)}
    </span>
  );
}

function Body({ project }: { project: LinkedProject }) {
  const t = useT();
  const fileId = session().fileId;
  const [data, setData] = useState<RepoTokensAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TokenDiffStatus | 'all'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const close = () => ui().set({ repoTokensOpen: false });

  const load = () => repoTokens(project.id, fileId).then((d) => {
    setData(d);
    setPicked(new Set(d.rows.filter((r) => r.status !== 'same').map((r) => r.name)));
    setTarget((prev) => prev || d.sources.find((s) => s.writable)?.file || 'tokens.json');
  }, (e: Error) => setError(e.message));
  useEffect(() => { void load(); }, [project.id, fileId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => filter === 'all' || r.status === filter), [data, filter]);
  const count = (st: TokenDiffStatus) => data?.rows.filter((r) => r.status === st).length ?? 0;
  const chosen = (data?.rows ?? []).filter((r) => picked.has(r.name));
  // What each direction would carry: the repository's values in, the file's values out.
  const toPull = chosen.filter((r) => r.repo !== undefined && r.status !== 'same').map((r) => r.name);
  const toPush = chosen.filter((r) => r.file !== undefined && r.status !== 'same' && r.status !== 'repo').map((r) => r.name);
  const toggle = (name: string) => {
    const next = new Set(picked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setPicked(next);
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pull = () => act(async () => {
    const pulled = await pullRepoTokens(project.id, fileId, toPull);
    editor().showToast(t.n(pulled.length, '{count} token from {project}. Undo takes them back.', '{count} tokens from {project}. Undo takes them back.', { project: project.name }));
    await load();
  });
  const push = () => act(async () => {
    const draft = await pullApi.startTokens({ fileId, names: toPush, ...(target.trim() ? { target: target.trim() } : {}) });
    ui().set({ repoTokensOpen: false, pull: { draft: draft.id } });
  });

  return (
    <div className="dialog-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog pr-dialog" role="dialog" aria-modal="true" aria-label={t('Tokens and the repository')} data-testid="rt-dialog">
        <header className="dialog-head pr-head">
          <span className="pr-title">{t('Tokens and the repository')}</span>
          <span className="pr-project" dir="auto">{project.name}</span>
          <span className="pr-grow" />
          <IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} testId="rt-close" />
        </header>
        <div className="pr-body pr-scroll">
          {!data ? (error ? <div className="error">{error}</div> : <div className="hint">{t('Reading the repository')}</div>) : (
            <>
              <div className="pr-from">
                {data.sources.length ? t.rich('Read from {sources}', { sources: <>{data.sources.map((s, i) => <span key={s.file}>{i ? ', ' : ''}<span className="pr-mono pr-strong">{s.file}</span> {FORMAT[s.format] ? t(FORMAT[s.format]!) : null}</span>)}</> }) : t('No token file was found: no CSS variables, Tailwind theme or tokens.json.')}
              </div>
              <div className="rt-filters" role="tablist">
                {STATUS.map((st) => (
                  <button key={st.value} type="button" role="tab" aria-selected={filter === st.value} className={`rt-filter${filter === st.value ? ' is-active' : ''}`} onClick={() => setFilter(filter === st.value ? 'all' : st.value)} data-testid={`rt-filter-${st.value}`}>{t(st.label)} {count(st.value)}</button>
                ))}
              </div>
              <div className="rt-table" data-testid="rt-rows">
                <div className="rt-row rt-row-head"><span /><span>{t('Token')}</span><span>{t('In this file')}</span><span>{t('In the repository')}</span><span /></div>
                {rows.map((r) => (
                  <label key={r.name} className="rt-row" data-testid="rt-row" data-token={r.name} data-status={r.status}>
                    <input type="checkbox" checked={picked.has(r.name)} disabled={r.status === 'same'} onChange={() => toggle(r.name)} data-testid={`rt-pick-${r.name}`} />
                    <span className="pr-mono rt-name">--{r.name}</span>
                    <Value row={r} side="file" />
                    <Value row={r} side="repo" />
                    <span className="rt-status">{t(STATUS.find((st) => st.value === r.status)!.label)}</span>
                  </label>
                ))}
                {!rows.length ? <div className="hint rt-empty">{t('Nothing here.')}</div> : null}
              </div>
              {data.unclassified.length ? <div className="hint">{t.n(data.unclassified.length, '{count} variable with no kind Bogen knows, such as shadows, are left out.', '{count} variables with no kind Bogen knows, such as shadows, are left out.')}</div> : null}
              <div className="rt-target">
                <span className="pr-label">{t('Push into')}</span>
                <input className="token-input pr-mono" value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation(); }} spellCheck={false} data-testid="rt-target" />
                <span className="hint">{t('A Tailwind 3 config is code: Bogen reads it, but pushes into CSS or a tokens.json.')}</span>
              </div>
              {error ? <div className="error" data-testid="rt-error">{error}</div> : null}
            </>
          )}
        </div>
        <footer className="pr-foot">
          <span className="pr-note">{t('Pulling changes this file, as one undo step. Pushing shows the pull request first.')}</span>
          <button type="button" className="btn" disabled={busy || !toPull.length} onClick={() => void pull()} data-testid="rt-pull">{t.n(toPull.length, 'Pull {count} into the file', 'Pull {count} into the file')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !toPush.length} onClick={() => void push()} data-testid="rt-push">{t.n(toPush.length, 'Push {count} as a pull request', 'Push {count} as a pull request')}</button>
        </footer>
      </div>
    </div>
  );
}
