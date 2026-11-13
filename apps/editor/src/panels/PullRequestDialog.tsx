import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { session } from '../doc/session.ts';
import { pullApi, useLinkedProject, type DesignSource, type PullDraft } from '../lib/code-api.ts';
import { conversationFor } from '../lib/conversation.ts';
import { onServerEvent } from '../lib/events.ts';
import { editor } from '../state/store.ts';
import { ui, useUi, type PullDialog } from '../state/ui.ts';
import { IconButton, Segmented } from '../ui/controls.tsx';
import '../styles/code.css';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

/**
 * Pull requests from a design change, and the preview of one before anything leaves this machine. The server makes
 * the branch in a working folder of its own and runs the person's agent there; this shows what it would push, and
 * pushes only with the digest of what it showed.
 */

export function openPullRequest(start: DesignSource, label: string): void {
  ui().set({ pull: { start, label } });
}

/** From the selection: the accepted proposal on it when there is one, the server says, otherwise the layers as they are. */
export function pullRequestFromSelection(): void {
  const s = session();
  const ids = editor().selection.filter((id) => s.snap.nodes.has(id));
  if (!ids.length) return editor().showToast(t('Select the layers the change is about.'));
  const names = ids.map((id) => s.snap.nodes.get(id)!.name).join(', ');
  openPullRequest(ids.length === 1 ? { kind: 'proposal', nodeId: ids[0]! } : { kind: 'selection', nodeIds: ids }, names);
}

export function PullRequestDialog() {
  const pull = useUi((s) => s.pull);
  return pull ? <Shell pull={pull} /> : null;
}

function Shell({ pull }: { pull: PullDialog }) {
  const t = useT();
  const project = useLinkedProject();
  const ref = useRef<HTMLDivElement>(null);
  const close = () => ui().set({ pull: null });
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
  return (
    <div className="dialog-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={ref} className="dialog pr-dialog" role="dialog" aria-modal="true" aria-label={t('Open a pull request')} data-testid="pr-dialog">
        <header className="dialog-head pr-head">
          <span className="pr-title">{t('Open a pull request')}</span>
          <span className="pr-project">{project?.name ?? ''}</span>
          <span className="pr-grow" />
          <IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} testId="pr-close" />
        </header>
        {!project ? <div className="pr-body"><div className="hint">{t('Link the repository in Assets first: a pull request is made in a working folder of it.')}</div></div>
          : 'start' in pull ? <Start start={pull.start} label={pull.label} /> : <Draft id={pull.draft} />}
      </div>
    </div>
  );
}

/** Whether Bogen may ask gh about merges on GitHub. Off until the person turns it on: it calls GitHub. */
function GithubMerges() {
  const t = useT();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { void fetch('/api/code/pulls/settings').then((r) => r.json()).then((s: { githubMerges: boolean }) => setOn(s.githubMerges), () => setOn(null)); }, []);
  if (on === null) return null;
  const set = (value: boolean) => void fetch('/api/code/pulls/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ githubMerges: value }) }).then((r) => r.json()).then((s: { githubMerges: boolean }) => setOn(s.githubMerges));
  return (
    <label className="pr-check" data-testid="pr-github-merges">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span>{t('Close the chat when GitHub says it was merged. Asks your gh once a minute.')}</span>
    </label>
  );
}

function sourceWords(source: DesignSource, label: string): string {
  if (source.kind === 'proposal') return t('The proposal accepted on {layers}, against how it was before.', { layers: label });
  if (source.kind === 'selection') return t('{layers}, as it is now, against the last version.', { layers: label });
  return label;
}

function Start({ start, label }: { start: DesignSource; label: string }) {
  const t = useT();
  const [source, setSource] = useState(start);
  const [title, setTitle] = useState('');
  const [runner, setRunner] = useState<'claude' | 'codex'>('claude');
  const [base, setBase] = useState('');
  const [docsDir, setDocsDir] = useState('docs/design');
  const [gh, setGh] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileId = session().fileId;
  useEffect(() => {
    void pullApi.list(fileId).then((a) => setGh(a.gh), () => setGh(null));
  }, [fileId]);
  const layers = start.kind === 'proposal' ? [start.nodeId] : start.kind === 'selection' ? start.nodeIds : null;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const draft = await pullApi.startDesign({ fileId, source, runner, ...(title.trim() ? { title: title.trim() } : {}), ...(base.trim() ? { base: base.trim() } : {}), docsDir: docsDir.trim() || 'docs/design', conversationId: conversationFor(fileId) });
      ui().set({ pull: { draft: draft.id } });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const stop = (e: React.KeyboardEvent) => { if (e.key !== 'Escape') e.stopPropagation(); };
  return (
    <form className="pr-start" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <div className="pr-body">
        {layers ? (
          <Segmented<'proposal' | 'selection'> value={source.kind === 'proposal' ? 'proposal' : 'selection'} testId="pr-source" onChange={(k) => setSource(k === 'proposal' && layers.length === 1 ? { kind: 'proposal', nodeId: layers[0]! } : { kind: 'selection', nodeIds: layers })} options={[
            { value: 'proposal', label: t('Accepted proposal'), title: t('The proposal accepted on this layer'), disabled: layers.length !== 1 },
            { value: 'selection', label: t('Selected layers'), title: t('These layers as they are, against the last version') },
          ]} />
        ) : null}
        <div className="pr-from" data-testid="pr-from" dir="auto">{sourceWords(source, label)}</div>
        <div className="pr-grid">
          <span className="pr-label">{t('Title')}</span>
          <input className="token-input" dir="auto" value={title} placeholder={t('Named after the change')} onChange={(e) => setTitle(e.target.value)} onKeyDown={stop} data-testid="pr-title" />
          <span className="pr-label">{t('Agent')}</span>
          <Segmented<'claude' | 'codex'> value={runner} onChange={setRunner} testId="pr-runner" options={[{ value: 'claude', label: 'claude', title: t('Your Claude Code') }, { value: 'codex', label: 'codex', title: t('Your Codex') }]} />
          <span className="pr-label">{t('Into')}</span>
          <input className="token-input pr-mono" value={base} placeholder={t('the branch the repository is on')} onChange={(e) => setBase(e.target.value)} onKeyDown={stop} spellCheck={false} data-testid="pr-base" />
          <span className="pr-label">{t('Pictures in')}</span>
          <input className="token-input pr-mono" value={docsDir} onChange={(e) => setDocsDir(e.target.value)} onKeyDown={stop} spellCheck={false} data-testid="pr-docs" />
        </div>
        <div className="hint">{t('Your {agent} works in a copy of the repository on a new branch, with file tools for that folder only. Your checkout stays as it is. Nothing is pushed until you confirm the preview.', { agent: runner })}</div>
        {error ? <div className="error" data-testid="pr-error">{error}</div> : null}
      </div>
      <footer className="pr-foot">
        <span className="pr-note">{gh === false ? t('gh was not found. Bogen can prepare the branch, but opening the pull request needs gh.') : gh ? t('gh found') : ''}</span>
        <button type="button" className="btn btn-quiet" onClick={() => ui().set({ pull: null })}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={busy} data-testid="pr-start">{busy ? t('Starting') : t('Start')}</button>
      </footer>
    </form>
  );
}

function Draft({ id }: { id: string }) {
  const t = useT();
  const [draft, setDraft] = useState<(PullDraft & { diff: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [gh, setGh] = useState(true);
  const fileId = session().fileId;

  useEffect(() => {
    let live = true;
    const load = () => pullApi.get(id).then((d) => {
      if (!live) return;
      setDraft(d);
      setTitle(d.title);
      setBody(d.body);
    }, (e: Error) => { if (live) setError(e.message); });
    void load();
    void pullApi.list(fileId).then((a) => { if (live) setGh(a.gh); }, () => {});
    const off = onServerEvent((e) => { if (e.t === 'pull' && e.id === id) void load(); });
    return () => {
      live = false;
      off();
    };
  }, [id, fileId]);

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
  // Saving the words changes what is confirmed: the digest comes back with them.
  const saveWords = async (): Promise<PullDraft | null> => {
    if (!draft || (title === draft.title && body === draft.body)) return draft;
    const next = await pullApi.update(id, { title, body });
    setDraft({ ...draft, ...next });
    return next;
  };
  const push = () => act(async () => {
    const shown = await saveWords();
    if (!shown?.digest) throw new Error(t('This draft is not ready to push.'));
    const opened = await pullApi.open(id, shown.digest);
    setDraft((d) => (d ? { ...d, ...opened } : d));
  });
  const discard = () => act(async () => {
    await pullApi.discard(id);
    ui().set({ pull: null });
    editor().showToast(t('Discarded. The branch and its folder are gone.'));
  });

  if (!draft) return <div className="pr-body">{error ? <div className="error">{error}</div> : <div className="hint">{t('Loading')}</div>}</div>;
  const adds = draft.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const dels = draft.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const foot = (note: ReactNode, actions: ReactNode) => <footer className="pr-foot"><span className="pr-note">{note}</span>{actions}</footer>;
  const discardButton = <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void discard()} data-testid="pr-discard">{t('Discard')}</button>;

  if (draft.status === 'running' || draft.status === 'failed') {
    return (
      <>
        <div className="pr-body" data-testid="pr-draft" data-status={draft.status}>
          <div className="pr-from">{t.rich('From {what} · version {version}', { what: <span className="pr-strong" dir="auto">{draft.what}</span>, version: draft.version.id })}</div>
          {draft.status === 'running'
            ? <div className="hint" data-testid="pr-running">{t.rich('Your {agent} is working in a copy of {project} on {branch}. You can close this: the draft waits in Assets.', { agent: draft.runner, project: draft.project.name, branch: <span className="pr-mono">{draft.branch}</span> })}</div>
            : <div className="error" data-testid="pr-failed">{draft.error ?? t('It did not work.')}</div>}
          {error ? <div className="error">{error}</div> : null}
        </div>
        {foot(t('Nothing has left this machine.'), discardButton)}
      </>
    );
  }

  if (draft.status === 'opened' || draft.status === 'merged') {
    return (
      <>
        <div className="pr-body" data-testid="pr-draft" data-status={draft.status}>
          <div className="pr-from">{draft.status === 'merged'
            ? t.rich('{branch} was merged into {base}. Its chat is closed.', { branch: <span className="pr-mono">{draft.branch}</span>, base: <span className="pr-mono">{draft.base}</span> })
            : draft.url ? t.rich('Opened {title} from {branch} into {base}.', { title: <span className="pr-strong" dir="auto">{draft.title}</span>, branch: <span className="pr-mono">{draft.branch}</span>, base: <span className="pr-mono">{draft.base}</span> })
            : t.rich('Pushed {branch} to {remote}. Merge it there; this chat closes when Bogen sees the merge.', { branch: <span className="pr-mono">{draft.branch}</span>, remote: <span className="pr-mono">{draft.remote ?? ''}</span> })}</div>
          {draft.url ? <a className="pr-link" href={draft.url} target="_blank" rel="noreferrer" data-testid="pr-url"><ExternalLink size={12} /> {draft.url}</a> : null}
          {draft.status === 'opened' && draft.url && draft.forge !== 'folder' ? <GithubMerges /> : null}
        </div>
        {foot('', <button type="button" className="btn" onClick={() => ui().set({ pull: null })}>{t('Close')}</button>)}
      </>
    );
  }

  const stop = (e: React.KeyboardEvent) => { if (e.key !== 'Escape') e.stopPropagation(); };
  // A remote that is a folder on this machine takes the push without gh.
  const pushOnly = draft.forge === 'folder' || Boolean(draft.url);
  return (
    <>
      <div className="pr-body pr-scroll" data-testid="pr-draft" data-status={draft.status}>
        <div className="pr-from">{t.rich('From {what} · version {version}', { what: <span className="pr-strong" dir="auto">{draft.what}</span>, version: draft.version.id })}</div>
        <div className="pr-grid">
          <span className="pr-label">{t('Title')}</span>
          <input className="token-input" dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void act(async () => { await saveWords(); })} onKeyDown={stop} data-testid="pr-draft-title" />
          <span className="pr-label">{t('Branch')}</span>
          <span className="pr-mono" data-testid="pr-branch">{draft.branch} → {draft.base}</span>
          <span className="pr-label">{t('Commit')}</span>
          <span className="pr-mono">{draft.commit?.slice(0, 7)}</span>
          <span className="pr-label">{t('Push to')}</span>
          <span className="pr-mono">{draft.remote ? `${draft.remote} ${draft.remoteUrl ?? ''}` : t('no remote')}</span>
        </div>
        <div className="pr-files-head"><span className="pr-strong">{t.n(draft.files.length, '{count} file', '{count} files')}</span><span className="pr-add">+{adds}</span><span className="pr-del">−{dels}</span></div>
        <div className="pr-files" data-testid="pr-files">
          {draft.files.map((f) => (
            <div key={f.path} className="pr-file" data-testid="pr-file" data-path={f.path}>
              <span className="pr-file-status">{f.status}</span>
              <span className="pr-file-path">{f.path}</span>
              {f.additions === null ? <span className="pr-file-meta">{t('binary')}</span> : <><span className="pr-add">+{f.additions}</span><span className="pr-del">−{f.deletions}</span></>}
            </div>
          ))}
        </div>
        <button type="button" className="run-link pr-diff-toggle" onClick={() => setShowDiff(!showDiff)} data-testid="pr-diff-toggle">{showDiff ? t('Hide the diff') : t('Show the diff')}</button>
        {showDiff ? <pre className="code pr-diff" data-testid="pr-diff">{draft.diff}{draft.diffTruncated ? `\n${t('…the rest is cut here')}` : ''}</pre> : null}
        {draft.pictures.before || draft.pictures.after ? (
          <div className="pr-pictures">
            {(['before', 'after'] as const).map((which) => (
              <figure key={which} className="pr-picture">
                <figcaption>{which === 'before' ? t('Before') : t('After')}</figcaption>
                {draft.pictures[which] ? <img src={pullApi.picture(id, which, draft.commit ?? '')} alt={which === 'before' ? t('before') : t('after')} data-testid={`pr-picture-${which}`} /> : <div className="pr-picture-none">{which === 'before' ? t('New') : t('Removed')}</div>}
              </figure>
            ))}
          </div>
        ) : null}
        <label className="pr-label" htmlFor="pr-body">{t('Description')}</label>
        <textarea id="pr-body" className="pr-text" dir="auto" value={body} onChange={(e) => setBody(e.target.value)} onBlur={() => void act(async () => { await saveWords(); })} onKeyDown={stop} rows={8} spellCheck={false} data-testid="pr-body" />
        {draft.error ? <div className="error">{draft.error}</div> : null}
        {error ? <div className="error" data-testid="pr-error">{error}</div> : null}
      </div>
      {foot(pushOnly ? t('Nothing has left this machine. This pushes one branch, on top of what was pushed, never with force.') : gh ? t('Nothing has left this machine. This pushes one branch and opens the pull request with your gh.') : t('gh was not found, so the pull request cannot be opened from here. The branch is ready in the repository.'),
        <>
          {discardButton}
          <button type="button" className="btn btn-primary" disabled={busy || (!gh && !pushOnly) || !draft.remote} onClick={() => void push()} data-testid="pr-push">{busy ? t('Working') : pushOnly ? t('Push') : t('Push and open')}</button>
        </>)}
    </>
  );
}
